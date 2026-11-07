// ============================================================
// Jede Boerse entscheidet fuer sich — und die Vorgabe traegt
//
// Bis zum 03.11.2026 entschied ein einziger Schalter ueber echten
// Handel: NUR_UEBUNGSBETRIEB. Er war der Riegel, auf den man sich
// verlassen konnte — stand er, verliess kein Auftrag den Bot, gleich
// welche Boerse ein Plan nannte.
//
// Jetzt entscheidet jede Boerse fuer sich. Damit ist dieser eine
// Hebel entfallen, und an seine Stelle tritt die Vorgabe:
//
//   **Was nicht ausdruecklich und vollstaendig auf echten Handel
//   gestellt ist, uebt.**
//
// Diese Tests pruefen genau das — und zwar vorrangig die Faelle, in
// denen die Einrichtung unvollstaendig, falsch oder gar nicht
// vorhanden ist. Ein Fehler darf dort nie dazu fuehren, dass echtes
// Geld bewegt wird.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';

describe('boerseUebt — die Vorgabe traegt', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'hplatz-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('uebt, wenn die Boerse gar nicht eingetragen ist', () => {
    // Der haeufigste Fall: Ein Plan nennt eine Boerse, die niemand
    // eingerichtet hat. Frueher fing das der globale Riegel ab.
    expect(store.boerseUebt('phemex')).toBe(true);
    expect(store.boerseUebt('bybit')).toBe(true);
    expect(store.boerseUebt('gibt-es-nicht')).toBe(true);
  });

  it('uebt bei leerem oder unsinnigem Namen', () => {
    expect(store.boerseUebt('')).toBe(true);
    expect(store.boerseUebt('   ')).toBe(true);
    expect(store.boerseUebt(undefined as unknown as string)).toBe(true);
  });

  it('uebt fuer "paper" immer', () => {
    expect(store.boerseUebt('paper')).toBe(true);
    expect(store.boerseUebt('PAPER')).toBe(true);
  });

  it('laesst den Uebungsbroker nicht auf echten Handel stellen', () => {
    expect(() => store.setzeBoersenEinstellung({
      exchange: 'paper', uebungsbetrieb: false,
    })).toThrow();
    expect(store.boerseUebt('paper')).toBe(true);
  });

  it('gibt echten Handel erst nach ausdruecklicher Einstellung frei', () => {
    expect(store.boerseUebt('phemex')).toBe(true);

    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: false });
    expect(store.boerseUebt('phemex')).toBe(false);
  });

  it('nimmt echten Handel beim Zurueckstellen sofort wieder zurueck', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: false });
    expect(store.boerseUebt('phemex')).toBe(false);

    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: true });
    expect(store.boerseUebt('phemex')).toBe(true);
  });

  it('uebt wieder, sobald der Eintrag geloescht ist', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: false });
    expect(store.boerseUebt('phemex')).toBe(false);

    store.loescheBoersenEinstellung('phemex');
    // Loeschen geht damit immer in die sichere Richtung.
    expect(store.boerseUebt('phemex')).toBe(true);
  });

  it('unterscheidet Boersen voneinander', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: false });
    store.setzeBoersenEinstellung({ exchange: 'bybit', uebungsbetrieb: true });

    expect(store.boerseUebt('phemex')).toBe(false);
    expect(store.boerseUebt('bybit')).toBe(true);
    expect(store.boerseUebt('okx')).toBe(true);     // nie eingetragen
  });

  it('nimmt Gross- und Kleinschreibung gleich', () => {
    store.setzeBoersenEinstellung({ exchange: 'PHEMEX', uebungsbetrieb: false });
    expect(store.boerseUebt('phemex')).toBe(false);
    expect(store.boerseUebt('Phemex')).toBe(false);
  });

  // Von Hand in die Datenbank geschrieben — der Fall, den niemand
  // plant und der trotzdem vorkommt.
  it('laesst das Feld gar nicht erst leer werden', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: false });
    const db = (store as unknown as {
      db: { prepare(s: string): { run(...a: unknown[]): void } };
    }).db;

    // NOT NULL faengt es schon in der Datenbank ab — eine Ebene
    // tiefer als `boerseUebt()`. Besser so: Ein Wert, den es nicht
    // geben kann, muss nicht ausgewertet werden.
    expect(() => db.prepare(
      'UPDATE boersen_einstellung SET uebungsbetrieb = NULL WHERE exchange = ?',
    ).run('phemex')).toThrow(/NOT NULL/i);

    expect(store.boerseUebt('phemex')).toBe(false);
  });

  it('wertet jeden Wert ausser der glatten 0 als "uebt"', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: false });
    const db = (store as unknown as {
      db: { prepare(s: string): { run(...a: unknown[]): void } };
    }).db;

    // Nur eine ausdrueckliche 0 gibt frei. Alles andere — ein
    // verrutschter Wert, ein Text, eine 2 — faellt auf die sichere
    // Seite.
    for (const unsinn of [2, -1, 'ja', '']) {
      db.prepare('UPDATE boersen_einstellung SET uebungsbetrieb = ? WHERE exchange = ?')
        .run(unsinn, 'phemex');
      expect(store.boerseUebt('phemex'), `Wert ${JSON.stringify(unsinn)}`).toBe(true);
    }
  });

  it('uebt, wenn die Datenbank nicht lesbar ist', () => {
    store.close();
    // Lieber eine Uebungsorder zuviel als eine echte zuwenig.
    expect(store.boerseUebt('phemex')).toBe(true);
    // Fuer afterEach wieder oeffnen.
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });
});

// ============================================================
// Welche Boerse gilt fuer welches Signal?
// ============================================================

describe('boerseFuerSignal — Zuordnung je Signalgeber', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'hquelle-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('ordnet nach genauem Strategienamen zu', () => {
    store.setzeSignalquelle({
      id: 'q1', name: 'Synaptrix', art: 'strategie',
      erkennung: 'MBCMA-f23', exchange: 'phemex',
    });

    expect(store.boerseFuerSignal({ strategie: 'MBCMA-f23' }))
      .toEqual({ exchange: 'phemex', quelle: 'Synaptrix' });
  });

  it('kennt das Sternchen als Praefix', () => {
    store.setzeSignalquelle({
      id: 'q1', name: 'Synaptrix', art: 'strategie',
      erkennung: 'MBCMA*', exchange: 'phemex',
    });

    expect(store.boerseFuerSignal({ strategie: 'MBCMA-f23' })?.exchange).toBe('phemex');
    expect(store.boerseFuerSignal({ strategie: 'MBCMA-xyz' })?.exchange).toBe('phemex');
    expect(store.boerseFuerSignal({ strategie: 'ANDERE' })).toBeNull();
  });

  it('trennt Synaptrix von TradingView — der eigentliche Zweck', () => {
    store.setzeSignalquelle({
      id: 'q1', name: 'Synaptrix', art: 'strategie',
      erkennung: 'MBCMA*', exchange: 'phemex', rang: 10,
    });
    store.setzeSignalquelle({
      id: 'q2', name: 'TradingView', art: 'strategie',
      erkennung: '*', exchange: 'bybit', rang: 90,
    });

    expect(store.boerseFuerSignal({ strategie: 'MBCMA-f23' })?.exchange).toBe('phemex');
    expect(store.boerseFuerSignal({ strategie: 'BTC-Long 5m' })?.exchange).toBe('bybit');
  });

  it('laesst den kleineren Rang gewinnen', () => {
    // Reihenfolge der Eintraege absichtlich verdreht.
    store.setzeSignalquelle({
      id: 'allgemein', name: 'Alles', art: 'strategie',
      erkennung: '*', exchange: 'bybit', rang: 90,
    });
    store.setzeSignalquelle({
      id: 'genau', name: 'Genau', art: 'strategie',
      erkennung: 'MBCMA-f23', exchange: 'phemex', rang: 10,
    });

    expect(store.boerseFuerSignal({ strategie: 'MBCMA-f23' })?.quelle).toBe('Genau');
  });

  it('uebergeht abgeschaltete Regeln', () => {
    store.setzeSignalquelle({
      id: 'q1', name: 'Aus', art: 'strategie',
      erkennung: 'MBCMA*', exchange: 'phemex', aktiv: false,
    });
    expect(store.boerseFuerSignal({ strategie: 'MBCMA-f23' })).toBeNull();
  });

  it('ordnet auch nach Webhook-Pfad und Herkunft zu', () => {
    store.setzeSignalquelle({
      id: 'p', name: 'Pfad-Regel', art: 'pfad',
      erkennung: '/webhook/tv', exchange: 'bybit',
    });
    store.setzeSignalquelle({
      id: 'h', name: 'Journal', art: 'quelle',
      erkennung: 'tc', exchange: 'okx',
    });

    expect(store.boerseFuerSignal({ pfad: '/webhook/tv' })?.exchange).toBe('bybit');
    expect(store.boerseFuerSignal({ quelle: 'tc' })?.exchange).toBe('okx');
  });

  it('gibt null zurueck, wenn nichts passt', () => {
    expect(store.boerseFuerSignal({ strategie: 'unbekannt' })).toBeNull();
    expect(store.boerseFuerSignal({})).toBeNull();
  });

  it('uebergeht eine Regel mit leerem Muster', () => {
    // Sonst traefe sie auf alles und zoege jeden Plan an sich.
    store.setzeSignalquelle({
      id: 'leer', name: 'Leer', art: 'strategie',
      erkennung: '   ', exchange: 'phemex',
    });
    expect(store.boerseFuerSignal({ strategie: 'irgendwas' })).toBeNull();
  });

  // Eine zugeordnete Boerse heisst nicht, dass dort echt gehandelt
  // wird. Die beiden Fragen sind getrennt — und die zweite hat
  // weiterhin ihre eigene Vorgabe.
  it('trifft keine Aussage ueber echten Handel', () => {
    store.setzeSignalquelle({
      id: 'q1', name: 'Synaptrix', art: 'strategie',
      erkennung: 'MBCMA*', exchange: 'phemex',
    });

    const treffer = store.boerseFuerSignal({ strategie: 'MBCMA-f23' })!;
    expect(treffer.exchange).toBe('phemex');
    expect(store.boerseUebt(treffer.exchange)).toBe(true);
  });
});

// ============================================================
// TC-Pläne bringen ihre Börse mit
//
// Das Journal weiß, auf welchem Börsen-Konto ein Plan gedacht war.
// Diese Angabe gilt — aber nur, wenn die Börse im Bot auch
// eingerichtet und aktiv ist.
//
// Sonst zeigte ein Plan auf eine Börse, zu der es hier keinen Zugang
// gibt, und bräche bei jedem Durchlauf mit einem Fehler ab, statt
// sichtbar zu ruhen.
// ============================================================

describe('TC-Pläne — Börse aus dem Plan', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: { boerseFuerTcPlan(genannt: string | null | undefined, planId: string): string };

  beforeEach(async () => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'tcboerse-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));

    const { TcPlanSyncService } = await import('./tc-plan-sync-service.js');
    const stillerLogger = {
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
      trace: () => {}, fatal: () => {},
    };
    dienst = new TcPlanSyncService(
      {} as never, store, { registerPlan: () => {}, unregisterPlan: () => {} } as never,
      stillerLogger as never,
    ) as unknown as typeof dienst;
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('übernimmt die Börse, wenn sie eingerichtet ist', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: true });
    expect(dienst.boerseFuerTcPlan('phemex', 'p1')).toBe('phemex');
  });

  it('leitet auf Übung um, wenn die Börse im Bot fehlt', () => {
    // Das Journal führt Börsen, die der Bot nicht bedient.
    expect(dienst.boerseFuerTcPlan('kraken', 'p1')).toBe('paper');
  });

  it('leitet auf Übung um, wenn die Börse abgeschaltet ist', () => {
    store.setzeBoersenEinstellung({ exchange: 'bybit', uebungsbetrieb: false, aktiv: false });
    expect(dienst.boerseFuerTcPlan('bybit', 'p1')).toBe('paper');
  });

  it('kommt mit "unknown" und leeren Angaben zurecht', () => {
    // 'unknown' liefert die Schnittstelle ohne zugeordnetes Konto.
    for (const wert of ['unknown', '', '   ', null, undefined]) {
      expect(dienst.boerseFuerTcPlan(wert, 'p1')).toBe('paper');
    }
  });

  it('nimmt Gross- und Kleinschreibung gleich', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: true });
    expect(dienst.boerseFuerTcPlan('PHEMEX', 'p1')).toBe('phemex');
  });

  // Die Zuordnung sagt nur, WELCHE Börse gemeint ist. Ob dort echt
  // gehandelt wird, bleibt die getrennte Frage aus Regel 5a.
  it('trifft keine Aussage über echten Handel', () => {
    store.setzeBoersenEinstellung({ exchange: 'phemex', uebungsbetrieb: true });
    expect(dienst.boerseFuerTcPlan('phemex', 'p1')).toBe('phemex');
    expect(store.boerseUebt('phemex')).toBe(true);
  });
});
