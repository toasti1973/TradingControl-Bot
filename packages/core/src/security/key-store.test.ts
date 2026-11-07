// ============================================================
// Der KeyStore muss einen Neustart ueberleben
//
// Hier lag ein Fehler, der still blieb und alles betraf, was an
// Geheimnissen hinterlegt war: den TC-API-Schluessel ebenso wie die
// Zugangsdaten jeder Boerse.
//
// `unlock()` liess sich von `deriveKey` einen Schluessel geben:
//
//     const { key } = await CryptoUtils.deriveKey(password, salt ?? undefined)
//
// Fehlt die Datei, erzeugt `deriveKey` einen zufaelligen Salt und
// gibt ihn mit zurueck — nur nahm ihn niemand entgegen. `setKeys`
// holte den Salt daraufhin aus der Datei, die es noch nicht gab, und
// schrieb `Buffer.alloc(0)`: einen leeren.
//
// Beim naechsten Start wurde der Schluessel aus eben diesem leeren
// Salt abgeleitet und passte nicht mehr zum Inhalt:
//
//     KeyStore corrupted or wrong password:
//     Unsupported state or unable to authenticate data
//
// Am 03.11.2026 fiel das auf, weil ein hinterlegter TC-API-Schluessel
// nach jedem Neustart verschwunden war — der Bot meldete
// "TC_API_KEY nicht gesetzt" und holte keine Plaene aus dem Journal.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from './key-store.js';

const PASSWORT = 'ein-hinreichend-langes-passwort';

describe('KeyStore — ueber einen Neustart hinweg', () => {
  let verzeichnis: string;
  let pfad: string;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'keystore-'));
    pfad = join(verzeichnis, 'keys.enc');
  });

  afterEach(() => {
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  // Der Fall, der den Fehler ausloeste: Es gibt noch keine Datei.
  it('liest zurueck, was ohne vorhandene Datei gespeichert wurde', async () => {
    expect(existsSync(pfad)).toBe(false);

    const ersterLauf = new KeyStore(pfad);
    await ersterLauf.unlock(PASSWORT);
    await ersterLauf.setKeys({ tcApiKey: 'tc_bot_geheim' });

    // --- Neustart: neue Instanz, dieselbe Datei, dasselbe Passwort ---
    const zweiterLauf = new KeyStore(pfad);
    await zweiterLauf.unlock(PASSWORT);

    const keys = await zweiterLauf.getKeys();
    expect(keys.tcApiKey).toBe('tc_bot_geheim');
  });

  it('schreibt einen nicht leeren Salt in die Datei', async () => {
    const store = new KeyStore(pfad);
    await store.unlock(PASSWORT);
    await store.setKeys({ tcApiKey: 'tc_bot_geheim' });

    const datei = JSON.parse(readFileSync(pfad, 'utf-8')) as { salt: string };
    // Genau hier stand frueher ein leerer String.
    expect(datei.salt).toBeTruthy();
    expect(datei.salt.length).toBeGreaterThan(16);
  });

  it('ueberlebt auch mehrere Neustarts hintereinander', async () => {
    const erster = new KeyStore(pfad);
    await erster.unlock(PASSWORT);
    await erster.setKeys({ a: '1' });

    for (let i = 2; i <= 4; i++) {
      const weiterer = new KeyStore(pfad);
      await weiterer.unlock(PASSWORT);
      await weiterer.setKeys({ [`k${i}`]: String(i) });
    }

    const letzter = new KeyStore(pfad);
    await letzter.unlock(PASSWORT);
    const keys = await letzter.getKeys();

    expect(keys.a).toBe('1');
    expect(keys.k4).toBe('4');
  });

  it('haelt auch nach initialize() zusammen', async () => {
    const erster = new KeyStore(pfad);
    await erster.initialize(PASSWORT);
    await erster.setKeys({ tcApiKey: 'tc_bot_geheim' });

    const zweiter = new KeyStore(pfad);
    await zweiter.unlock(PASSWORT);
    expect((await zweiter.getKeys()).tcApiKey).toBe('tc_bot_geheim');
  });

  it('ueberlebt ein Loeschen einzelner Schluessel', async () => {
    const erster = new KeyStore(pfad);
    await erster.unlock(PASSWORT);
    await erster.setKeys({ a: '1', b: '2' });
    await erster.deleteKey('a');

    const zweiter = new KeyStore(pfad);
    await zweiter.unlock(PASSWORT);
    const keys = await zweiter.getKeys();

    expect(keys.a).toBeUndefined();
    expect(keys.b).toBe('2');
  });

  it('weist ein falsches Passwort ab', async () => {
    const erster = new KeyStore(pfad);
    await erster.unlock(PASSWORT);
    await erster.setKeys({ tcApiKey: 'tc_bot_geheim' });

    const zweiter = new KeyStore(pfad);
    await zweiter.unlock('ein-anderes-passwort');

    // Keine stille leere Antwort: Wer das falsche Passwort hat, soll
    // es erfahren — sonst sieht ein unlesbarer Speicher aus wie ein
    // leerer, und der Bot laeuft ohne Zugangsdaten weiter.
    await expect(zweiter.getKeys()).rejects.toThrow(/corrupted or wrong password/i);
  });

  it('schreibt lieber nichts als eine Datei, die nicht mehr aufgeht', async () => {
    const store = new KeyStore(pfad);
    // Entsperrt, aber der Salt wurde entfernt — der Zustand, der
    // frueher zu einer unlesbaren Datei fuehrte.
    await store.unlock(PASSWORT);
    (store as unknown as { cachedSalt: Buffer | null }).cachedSalt = null;

    await expect(store.setKeys({ a: '1' })).rejects.toThrow(/Salt/i);
  });

  it('gibt einen leeren Satz zurueck, solange nichts gespeichert ist', async () => {
    const store = new KeyStore(pfad);
    await store.unlock(PASSWORT);
    expect(await store.getKeys()).toEqual({});
  });
});
