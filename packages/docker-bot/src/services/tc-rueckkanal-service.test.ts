// ============================================================
// Rueckkanal an TC-Synaptrix
// ============================================================
//
// Geprueft wird vor allem, was NICHT verloren gehen darf: Ein Ereignis,
// das waehrend einer Stoerung des Empfaengers anfaellt, ist von einem nie
// entstandenen nicht zu unterscheiden — und genau deshalb liegt die
// Warteschlange auf der Platte und nicht im Arbeitsspeicher.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zahlAlsText, TcRueckkanalService } from './tc-rueckkanal-service.js';
import { SqliteStore } from '../store/sqlite-store.js';
import type { TradePlanMonitor } from './trade-plan-monitor.js';
import type { Logger } from './log-service.js';

describe('zahlAlsText', () => {
  it('schreibt kleine Mengen ohne Exponent', () => {
    // 0.00000001.toString() liefert "1e-8". Der Empfaenger weist das als
    // "keine Zahl" ab — sein Muster erlaubt nur Ziffern und einen Punkt.
    // Bei Mengen mit acht Nachkommastellen ist das kein Randfall.
    expect(zahlAlsText(0.00000001)).toBe('0.00000001');
    expect(zahlAlsText(0.00000001)).not.toContain('e');
  });

  it('haelt grosse Preise genau', () => {
    expect(zahlAlsText(80659.4)).toBe('80659.4');
    expect(zahlAlsText(80659)).toBe('80659');
  });

  it('gibt null fuer das, was keine Zahl ist', () => {
    // NaN und Infinity sind in JavaScript vom Typ number und wuerden
    // sonst als Preis in der Zieldatenbank landen — aus einer
    // fehlgeschlagenen Division wuerde eine Ausfuehrung.
    expect(zahlAlsText(NaN)).toBeNull();
    expect(zahlAlsText(Infinity)).toBeNull();
    expect(zahlAlsText(null)).toBeNull();
    expect(zahlAlsText(undefined)).toBeNull();
  });

  it('gibt die echte Null als "0" aus, nicht als null', () => {
    // Eine echte Null ist ein Ergebnis, kein fehlender Wert. Sie zu
    // verschlucken hiesse, eine Gebuehr von 0 wie eine unbekannte zu
    // behandeln.
    expect(zahlAlsText(0)).toBe('0');
  });
});

describe('TcRueckkanalService.istEingerichtet', () => {
  it('verlangt beide Haelften', () => {
    // Eine Adresse ohne Token wiese die Gegenstelle mit 401 ab, und die
    // Warteschlange fuellte sich, ohne je geleert zu werden: eine
    // Einrichtung, die eingerichtet aussieht und nichts uebergibt.
    expect(TcRueckkanalService.istEingerichtet('http://x/api/bot/ereignisse', 'geheim')).toBe(true);
    expect(TcRueckkanalService.istEingerichtet('http://x/api/bot/ereignisse', '')).toBe(false);
    expect(TcRueckkanalService.istEingerichtet('', 'geheim')).toBe(false);
    expect(TcRueckkanalService.istEingerichtet(undefined, undefined)).toBe(false);
  });

  it('wertet Leerzeichen als nicht gesetzt', () => {
    expect(TcRueckkanalService.istEingerichtet('   ', 'geheim')).toBe(false);
    expect(TcRueckkanalService.istEingerichtet('http://x', '   ')).toBe(false);
  });
});

// ============================================================
// Der Positionsstand
//
// Ohne ihn kennt TC-Synaptrix den tatsaechlichen Einstand nicht. Es
// weiss, welche Einstiege es GEPLANT hat, aber nicht, welche davon
// gefuellt wurden; der Kanal meldet je Order einen Fuellpreis, nie
// den gewichteten Durchschnitt.
//
// Wer daraus einen Break-Even-Stop rechnet, rechnet ihn auf die
// geplante Staffel — und verfehlt ihn, sobald nur ein Teil gefuellt
// hat. Genau das kostete den BNBUSDT-Plan am 26.10.2026 6,21 USDT,
// obwohl TP1 gegriffen hatte.
// ============================================================

const stilleAusgabe = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
} as unknown as Logger;

interface ServiceIntern {
  positionsStand(planId: string): {
    einstand: string | null;
    eingestiegen: string;
    offen: string;
    einstiege_gefuellt: number;
    einstiege_gesamt: number;
  } | null;
}

describe('TcRueckkanalService — Positionsstand', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: ServiceIntern;

  const PLAN = 'plan-bnb';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'rkpos-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));

    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BNBUSDT', market_type: 'futures',
      direction: 'long', leverage: 16, total_size: 21.823851,
      entry_strategy: 'equal', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });

    // Der Monitor wird nur als Ereignisquelle gebraucht.
    const monitor = new EventEmitter() as unknown as TradePlanMonitor;
    dienst = new TcRueckkanalService(store, monitor, stilleAusgabe, {
      url: 'http://beispiel/api/bot/ereignisse', token: 'geheim', boerse: 'phemex',
    }) as unknown as ServiceIntern;
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function order(
    rolle: string, seite: string, menge: number, preis: number, gefuellt = menge,
  ): void {
    const id = `o-${rolle}-${menge}-${preis}`;
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'limit', role: rolle,
      symbol: 'BNBUSDT', price: preis, quantity: menge, status: 'filled', broker: 'paper',
    });
    if (gefuellt > 0) {
      store.updatePlanOrder(id, { filled_quantity: gefuellt, avg_fill_price: preis });
    }
  }

  it('meldet den echten Einstand, nicht den geplanten Durchschnitt', () => {
    // Vier Einstiege gelegt, nur der erste gefuellt — der Fall vom 26.10.
    order('entry', 'buy', 5.45596275, 739.96);
    order('entry', 'buy', 5.45596275, 738.39, 0);
    order('entry', 'buy', 5.45596275, 736.83, 0);
    order('entry', 'buy', 5.45596275, 735.26, 0);

    const stand = dienst.positionsStand(PLAN)!;

    expect(stand).not.toBeNull();
    expect(Number(stand.einstand)).toBeCloseTo(739.96, 4);
    // Und eben NICHT 737,61 — der Durchschnitt aller vier.
    expect(Number(stand.einstand)).not.toBeCloseTo(737.61, 2);
    expect(stand.einstiege_gefuellt).toBe(1);
    expect(stand.einstiege_gesamt).toBe(4);
  });

  it('gewichtet mehrere Fuellungen nach Menge', () => {
    order('entry', 'buy', 10, 700);
    order('entry', 'buy', 30, 800);

    const stand = dienst.positionsStand(PLAN)!;

    // (10*700 + 30*800) / 40 = 775 — nicht 750, der ungewichtete Schnitt.
    expect(Number(stand.einstand)).toBeCloseTo(775, 6);
    expect(Number(stand.eingestiegen)).toBeCloseTo(40, 6);
  });

  it('zieht geschlossene Mengen von der offenen ab', () => {
    order('entry', 'buy', 5.45596275, 739.96);
    order('take_profit', 'sell', 1.36399069, 743.86);

    const stand = dienst.positionsStand(PLAN)!;

    expect(Number(stand.offen)).toBeCloseTo(4.09197206, 6);
    // Der Einstand bleibt, was er war — ein Take-Profit aendert ihn nicht.
    expect(Number(stand.einstand)).toBeCloseTo(739.96, 4);
  });

  it('meldet eine geschlossene Position mit offen = 0', () => {
    order('entry', 'buy', 5.45596275, 739.96);
    order('take_profit', 'sell', 1.36399069, 743.86);
    order('stop_loss', 'sell', 4.09197206, 737.61);

    const stand = dienst.positionsStand(PLAN)!;
    expect(Number(stand.offen)).toBe(0);
    expect(Number(stand.eingestiegen)).toBeCloseTo(5.45596275, 6);
  });

  it('meldet keinen Einstand, solange nichts gefuellt ist', () => {
    order('entry', 'buy', 5.45596275, 739.96, 0);

    const stand = dienst.positionsStand(PLAN)!;
    expect(stand.einstand).toBeNull();
    expect(Number(stand.eingestiegen)).toBe(0);
    expect(stand.einstiege_gefuellt).toBe(0);
    expect(stand.einstiege_gesamt).toBe(1);
  });

  it('gibt null zurueck, wenn der Plan keine Einstiege kennt', () => {
    expect(dienst.positionsStand(PLAN)).toBeNull();
    expect(dienst.positionsStand('gibt-es-nicht')).toBeNull();
  });

  it('schreibt die Zahlen als Zeichenkette', () => {
    order('entry', 'buy', 5.45596275, 739.96);

    const stand = dienst.positionsStand(PLAN)!;

    // JSON kennt nur IEEE-754. Acht Nachkommastellen ueberleben das
    // nicht unbeschadet — und der Verlust faellt nicht auf.
    expect(typeof stand.einstand).toBe('string');
    expect(typeof stand.eingestiegen).toBe('string');
    expect(typeof stand.offen).toBe('string');
    expect(stand.eingestiegen).toBe('5.45596275');
  });
});

// ============================================================
// Wiederaufnahme aufgegebener Ereignisse
//
// Am 26.10.2026 scheiterten 29 Ereignisse an einem fehlenden
// Stammdatensatz beim Empfaenger (HTTP 500, Fremdschluessel auf
// `boerse`). Nach dessen Eintragen waeren alle durchgegangen — aber
// nichts holte sie zurueck. Ohne diese Regel kostet ein behobener
// Fehler die Messdaten endgueltig.
// ============================================================

describe('rueckkanalWiederaufnehmen', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'rkwdr-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function aufgegeben(id: string, fehler: string): void {
    store.rueckkanalEinreihen({ ereignis_id: id, art: 'ausgefuehrt' });
    store.rueckkanalFehlschlag(
      store.rueckkanalOffene(10, 999).map((o) => o.id),
      fehler,
      true,
    );
  }

  it('holt zurueck, was am Empfaenger scheiterte', () => {
    aufgegeben('e-500', 'HTTP 500: plan_ereignisse_boerse_fkey verletzt');

    expect(store.rueckkanalOffene(10, 20)).toHaveLength(0);
    expect(store.rueckkanalWiederaufnehmen(20)).toBe(1);
    expect(store.rueckkanalOffene(10, 20)).toHaveLength(1);
  });

  it('holt auch Timeouts zurueck', () => {
    // Die 16 Timeouts vom 26.10. entstanden waehrend eines Neustarts
    // des Empfaengers — ein Zustand, der vorbeigeht.
    aufgegeben('e-timeout', 'The operation was aborted due to timeout');

    expect(store.rueckkanalWiederaufnehmen(20)).toBe(1);
    expect(store.rueckkanalOffene(10, 20)).toHaveLength(1);
  });

  it('laesst 4xx liegen — die scheitern beim naechsten Mal genauso', () => {
    // Sonst entstuende eine Endlosschleife: Ein fehlerhafter Aufbau
    // wird beim einundzwanzigsten Versuch nicht richtiger.
    aufgegeben('e-400', 'HTTP 400: Feld "ereignisse" fehlt');
    aufgegeben('e-401', 'HTTP 401: Token fehlt oder stimmt nicht.');

    expect(store.rueckkanalWiederaufnehmen(20)).toBe(0);
    expect(store.rueckkanalOffene(10, 20)).toHaveLength(0);
  });

  it('ruehrt Gesendetes nicht an', () => {
    store.rueckkanalEinreihen({ ereignis_id: 'e-ok', art: 'ausgefuehrt' });
    store.rueckkanalErledigen(store.rueckkanalOffene(10, 999).map((o) => o.id));

    expect(store.rueckkanalWiederaufnehmen(20)).toBe(0);
    expect(store.rueckkanalZustand(20).offen).toBe(0);
  });
});
