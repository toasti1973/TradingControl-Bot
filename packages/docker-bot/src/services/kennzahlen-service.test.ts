// ============================================================
// Die Kennzahlen zur Signalqualitaet
//
// Eine falsche Zahl hier fuehrt zur falschen Entscheidung ueber einen
// Signalgeber — und das ist der Zweck des ganzen Uebungsbetriebs.
// Besonderes Augenmerk liegt auf drei Dingen:
//
//   - dem R-Vielfachen, das ungleiche Trades vergleichbar macht
//   - dem Profit Factor, der ueber "traegt" oder "traegt nicht"
//     entscheidet
//   - dem Drawdown, der aus der KURVE kommen muss und nicht aus
//     Tagessummen
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import {
  KennzahlenService, ausschlaegeErmitteln, type TradeInR,
} from './kennzahlen-service.js';

describe('KennzahlenService — Trades in R', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: KennzahlenService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'kennzahlen-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    dienst = new KennzahlenService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /**
   * Ein abgeschlossener Signal-Trade.
   *
   * `risiko` landet als `scaled_risk` in der Herkunft — genau dort,
   * wo der Bot es beim Anlegen hinterlegt.
   */
  function trade(opt: {
    id: string; symbol?: string; richtung?: 'long' | 'short';
    menge: number; einstieg: number; ausstieg: number;
    risiko?: number | null; stop?: number | null;
    rolle?: 'take_profit' | 'stop_loss';
    strategie?: string;
    von?: string; bis?: string;
  }): void {
    const richtung = opt.richtung ?? 'long';
    const herkunft = opt.risiko != null
      ? JSON.stringify({
          strategy: opt.strategie ?? 'MBCMA-f23',
          signal_id: `sig-${opt.id}`,
          scaled_risk: opt.risiko,
        })
      : JSON.stringify({ strategy: opt.strategie ?? 'MBCMA-f23', signal_id: `sig-${opt.id}` });

    store.upsertBotTradePlan({
      id: opt.id, source: 'signal', symbol: opt.symbol ?? 'BTCUSDT',
      market_type: 'futures', direction: richtung, leverage: 10,
      total_size: opt.menge, entry_strategy: 'equal',
      entry_orders: '[]', take_profits: '[]', activation_conditions: '[]',
      executed_orders: '[]', execution_mode: 'all_limit',
      status: 'completed', bot_enabled: true,
      stop_loss_price: opt.stop ?? null,
      signal_origin: herkunft,
    });

    const einSeite = richtung === 'long' ? 'buy' : 'sell';
    const ausSeite = richtung === 'long' ? 'sell' : 'buy';

    store.insertPlanOrder({
      id: `${opt.id}-e`, trade_plan_id: opt.id, side: einSeite,
      order_type: 'limit', role: 'entry', symbol: opt.symbol ?? 'BTCUSDT',
      price: opt.einstieg, quantity: opt.menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(`${opt.id}-e`, {
      filled_quantity: opt.menge, avg_fill_price: opt.einstieg,
    });

    store.insertPlanOrder({
      id: `${opt.id}-a`, trade_plan_id: opt.id, side: ausSeite,
      order_type: 'market', role: opt.rolle ?? 'take_profit',
      symbol: opt.symbol ?? 'BTCUSDT',
      price: opt.ausstieg, quantity: opt.menge, status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(`${opt.id}-a`, {
      filled_quantity: opt.menge, avg_fill_price: opt.ausstieg,
    });
  }

  it('rechnet das R-Vielfache aus dem Signal-Risiko', () => {
    // 1 BTC von 100 auf 110: +10 Gewinn. Risiko war 5 → +2 R.
    trade({ id: 'p1', menge: 1, einstieg: 100, ausstieg: 110, risiko: 5 });

    const t = dienst.trades()[0]!;
    expect(t.ergebnis).toBeCloseTo(10, 6);
    expect(t.risiko).toBeCloseTo(5, 6);
    expect(t.rVielfaches).toBeCloseTo(2, 3);
  });

  it('macht ungleiche Trades vergleichbar', () => {
    // Zwei Trades auf voellig verschiedenen Skalen, beide +2 R.
    trade({ id: 'gross', symbol: 'BTCUSDT', menge: 0.5, einstieg: 80_000, ausstieg: 80_400, risiko: 100 });
    trade({ id: 'klein', symbol: 'XRPUSDT', menge: 1000, einstieg: 1.20, ausstieg: 1.30, risiko: 50 });

    const trades = dienst.trades();
    const r = trades.map(t => t.rVielfaches!);

    // In USDT: 200 gegen 100. In R: beide 2.
    expect(r.every(x => Math.abs(x - 2) < 0.001)).toBe(true);
  });

  it('faellt auf den Stop-Abstand zurueck, wenn das Signal kein Risiko nennt', () => {
    // Kein scaled_risk, aber ein Stop bei 95: Risiko = 1 × |100−95| = 5
    trade({ id: 'p2', menge: 1, einstieg: 100, ausstieg: 110, risiko: null, stop: 95 });

    const t = dienst.trades()[0]!;
    expect(t.risiko).toBeCloseTo(5, 6);
    expect(t.rVielfaches).toBeCloseTo(2, 3);
  });

  it('laesst R offen, wenn es weder Risiko noch Stop gibt', () => {
    // Eine 0 waere hier die schlechteste Antwort — sie liesse jedes
    // Ergebnis als unendliches R erscheinen.
    trade({ id: 'p3', menge: 1, einstieg: 100, ausstieg: 110, risiko: null, stop: null });

    const t = dienst.trades()[0]!;
    expect(t.risiko).toBeNull();
    expect(t.rVielfaches).toBeNull();
  });

  it('rechnet den Short gegenlaeufig', () => {
    // Short von 100 auf 90: +10 Gewinn bei Risiko 5 → +2 R.
    trade({ id: 's1', richtung: 'short', menge: 1, einstieg: 100, ausstieg: 90, risiko: 5 });

    const t = dienst.trades()[0]!;
    expect(t.ergebnis).toBeCloseTo(10, 6);
    expect(t.rVielfaches).toBeCloseTo(2, 3);
  });

  it('uebergeht laufende und nie eingestiegene Plaene', () => {
    // Eingestiegen, aber nichts geschlossen: noch kein Ergebnis.
    store.upsertBotTradePlan({
      id: 'laeuft', source: 'signal', symbol: 'BTCUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 1, entry_strategy: 'equal',
      entry_orders: '[]', take_profits: '[]', activation_conditions: '[]',
      executed_orders: '[]', execution_mode: 'all_limit',
      status: 'active', bot_enabled: true,
    });
    store.insertPlanOrder({
      id: 'l-e', trade_plan_id: 'laeuft', side: 'buy', order_type: 'limit',
      role: 'entry', symbol: 'BTCUSDT', price: 100, quantity: 1,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder('l-e', { filled_quantity: 1, avg_fill_price: 100 });

    expect(dienst.trades()).toHaveLength(0);
  });
});

describe('KennzahlenService — die Kennzahlen', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: KennzahlenService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'kz2-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    dienst = new KennzahlenService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Ein Trade, beschrieben allein durch sein Ergebnis in R. */
  function inR(r: number, risiko = 100): TradeInR {
    return {
      planId: `p-${r}-${Math.random()}`, symbol: 'BTCUSDT', richtung: 'long',
      strategie: 'test', signalId: 's', boerse: 'paper', quelle: 'signal', uebung: true,
      begonnen: null, beendet: null,
      dauerMinuten: null, menge: 1, einstiegsPreis: 100,
      risiko, ergebnis: r * risiko, rVielfaches: r,
      tpsErreicht: r > 0 ? 1 : 0, slGetroffen: r < 0,
    };
  }

  it('rechnet den Profit Factor', () => {
    // Gewinne 300, Verluste 100 → 3,0
    const k = dienst.kennzahlen([inR(2), inR(1), inR(-1)]);

    expect(k.bruttoGewinn).toBeCloseTo(300, 2);
    expect(k.bruttoVerlust).toBeCloseTo(100, 2);
    expect(k.profitFactor).toBeCloseTo(3, 3);
  });

  it('laesst den Profit Factor offen, wenn es keine Verluste gibt', () => {
    // Unendlich ist keine Aussage.
    expect(dienst.kennzahlen([inR(2), inR(1)]).profitFactor).toBeNull();
  });

  it('rechnet den Erwartungswert in R', () => {
    // (+2 −1 −1 +3) / 4 = +0,75 R je Trade
    const k = dienst.kennzahlen([inR(2), inR(-1), inR(-1), inR(3)]);

    expect(k.erwartungswertR).toBeCloseTo(0.75, 3);
    expect(k.summeR).toBeCloseTo(3, 3);
  });

  it('zeigt eine Strategie mit niedriger Trefferquote als tragfaehig', () => {
    // Nur 2 von 6 treffen — aber sie bringen genug. Genau dafuer ist
    // der Erwartungswert da: Die Trefferquote allein taeuscht.
    const k = dienst.kennzahlen([
      inR(5), inR(4), inR(-1), inR(-1), inR(-1), inR(-1),
    ]);

    expect(k.trefferquote).toBeCloseTo(33.33, 1);
    expect(k.erwartungswertR).toBeGreaterThan(0);
    expect(k.profitFactor).toBeGreaterThan(1);
  });

  it('zeigt eine Strategie mit hoher Trefferquote als untragfaehig', () => {
    // 5 von 6 treffen — und trotzdem steht unterm Strich ein Minus.
    const k = dienst.kennzahlen([
      inR(0.2), inR(0.2), inR(0.2), inR(0.2), inR(0.2), inR(-3),
    ]);

    expect(k.trefferquote).toBeCloseTo(83.33, 1);
    expect(k.erwartungswertR).toBeLessThan(0);
    expect(k.profitFactor).toBeLessThan(1);
  });

  it('rechnet das Payoff-Verhaeltnis', () => {
    // ø Gewinn 3 R, ø Verlust −1 R → 3,0
    const k = dienst.kennzahlen([inR(2), inR(4), inR(-1), inR(-1)]);

    expect(k.schnittGewinnR).toBeCloseTo(3, 3);
    expect(k.schnittVerlustR).toBeCloseTo(-1, 3);
    expect(k.payoffRatio).toBeCloseTo(3, 3);
  });

  it('nennt das beste und das schlechteste Ergebnis', () => {
    const k = dienst.kennzahlen([inR(2), inR(-1.5), inR(4.2)]);

    expect(k.bestesR).toBeCloseTo(4.2, 3);
    expect(k.schlechtestesR).toBeCloseTo(-1.5, 3);
  });

  it('laesst Trades ohne Risiko aus den R-Kennzahlen heraus', () => {
    const ohneR: TradeInR = { ...inR(0), risiko: null, rVielfaches: null, ergebnis: 500 };
    const k = dienst.kennzahlen([inR(2), ohneR]);

    // Das Geld-Ergebnis zaehlt beide ...
    expect(k.trades).toBe(2);
    expect(k.ergebnis).toBeCloseTo(700, 2);
    // ... die R-Rechnung nur den einen.
    expect(k.mitRisiko).toBe(1);
    expect(k.erwartungswertR).toBeCloseTo(2, 3);
  });

  it('gibt bei keinen Trades nichts Erfundenes zurueck', () => {
    const k = dienst.kennzahlen([]);

    expect(k.trades).toBe(0);
    expect(k.profitFactor).toBeNull();
    expect(k.erwartungswertR).toBeNull();
  });
});

describe('KennzahlenService — Kontoverlauf und Drawdown', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: KennzahlenService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'kz3-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    dienst = new KennzahlenService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function buchung(art: string, betrag: number, nr: number): void {
    store.schreibePaperBuchung(
      {
        art, betrag, waehrung: 'USDT', symbol: 'BTCUSDT',
        menge: null, preis: null, notiz: null,
        zeitpunkt: new Date(Date.UTC(2026, 9, 26, 0, nr)).toISOString(),
      },
      {
        waehrung: 'USDT', startkapital: 10_000, realisiert: 0, gebuehren: 0,
        trades: 0, gewinne: 0, verluste: 0, taker_satz: 0.0006, maker_satz: 0.0001,
      },
      [],
    );
  }

  it('zeichnet den Verlauf aus dem Kontoblatt', () => {
    buchung('gewinn', 200, 1);
    buchung('verlust', -50, 2);

    const v = dienst.equityVerlauf(10_000, []);

    expect(v.punkte).toHaveLength(2);
    expect(v.punkte[0]!.stand).toBeCloseTo(10_200, 2);
    expect(v.punkte[1]!.stand).toBeCloseTo(10_150, 2);
    expect(v.endstand).toBeCloseTo(10_150, 2);
  });

  it('misst den Drawdown vom Hoechststand, nicht vom Start', () => {
    // Erst auf 11.000 hoch, dann auf 10.500 zurueck. Gegenueber dem
    // Start waere das ein PLUS — der Rueckgang betraegt trotzdem
    // 500 von 11.000, also 4,55 %.
    buchung('gewinn', 1_000, 1);
    buchung('verlust', -500, 2);

    const v = dienst.equityVerlauf(10_000, []);

    expect(v.maxDrawdown).toBeCloseTo(500, 2);
    expect(v.maxDrawdownPct).toBeCloseTo(4.55, 1);
    expect(v.drawdownVon).toBeCloseTo(11_000, 2);
    expect(v.drawdownBis).toBeCloseTo(10_500, 2);
  });

  it('findet den groessten Rueckgang, nicht den letzten', () => {
    buchung('verlust', -100, 1);     // 9.900
    buchung('gewinn', 1_100, 2);     // 11.000
    buchung('verlust', -800, 3);     // 10.200  ← groesster Rueckgang
    buchung('gewinn', 500, 4);       // 10.700
    buchung('verlust', -200, 5);     // 10.500

    const v = dienst.equityVerlauf(10_000, []);

    expect(v.maxDrawdown).toBeCloseTo(800, 2);
    expect(v.drawdownVon).toBeCloseTo(11_000, 2);
  });

  it('laesst eine Einzahlung nicht als Erholung erscheinen', () => {
    buchung('verlust', -1_000, 1);   // 9.000, Rueckgang 1.000
    buchung('einzahlung', 2_000, 2); // 11.000 — aber kein Handelserfolg

    const v = dienst.equityVerlauf(10_000, []);

    // Der Rueckgang bleibt stehen; die Einzahlung hebt auch die
    // Messlatte, sonst saehe sie wie eine Erholung aus.
    expect(v.maxDrawdown).toBeCloseTo(1_000, 2);
  });

  it('beginnt nach einer Zuruecksetzung von vorn', () => {
    buchung('verlust', -2_000, 1);
    buchung('zuruecksetzung', 10_000, 2);
    buchung('gewinn', 100, 3);

    const v = dienst.equityVerlauf(10_000, []);

    // Der Verlauf davor gehoert zu einem anderen Konto.
    expect(v.punkte).toHaveLength(1);
    expect(v.endstand).toBeCloseTo(10_100, 2);
    expect(v.maxDrawdown).toBeCloseTo(0, 2);
  });

  it('zaehlt die laengste Verlustserie', () => {
    const t = (r: number, bis: string): TradeInR => ({
      planId: bis, symbol: 'BTCUSDT', richtung: 'long', strategie: 't',
      signalId: 's', boerse: 'paper', quelle: 'signal', uebung: true,
      begonnen: null, beendet: bis, dauerMinuten: null,
      menge: 1, einstiegsPreis: 100, risiko: 100,
      ergebnis: r * 100, rVielfaches: r, tpsErreicht: 0, slGetroffen: r < 0,
    });

    const v = dienst.equityVerlauf(10_000, [
      t(1, '2026-10-26T01:00:00Z'),
      t(-1, '2026-10-26T02:00:00Z'),
      t(-1, '2026-10-26T03:00:00Z'),
      t(-1, '2026-10-26T04:00:00Z'),
      t(1, '2026-10-26T05:00:00Z'),
      t(1, '2026-10-26T06:00:00Z'),
    ]);

    expect(v.laengsteVerlustserie).toBe(3);
    expect(v.laengsteGewinnserie).toBe(2);
  });
});

// ============================================================
// MAE und MFE
//
// Sie beantworten, was aus dem Ergebnis allein nicht hervorgeht:
// Sass der Stop zu eng, sassen die Ziele zu nah?
// ============================================================

describe('MAE und MFE', () => {
  /** Ein Trade, wie ihn der Dienst liefert. */
  function trade(opt: Partial<TradeInR> = {}): TradeInR {
    return {
      planId: 'p1', symbol: 'BTCUSDT', richtung: 'long', strategie: 't',
      signalId: 's', boerse: 'paper', quelle: 'signal', uebung: true,
      begonnen: '2026-10-26T10:00:00Z', beendet: '2026-10-26T11:00:00Z',
      dauerMinuten: 60, menge: 1, einstiegsPreis: 100,
      risiko: 5, ergebnis: 10, rVielfaches: 2,
      tpsErreicht: 1, slGetroffen: false,
      ...opt,
    };
  }

  /** Kerzen, die den Zeitraum abdecken. */
  function kerzen(werte: Array<{ h: number; l: number }>) {
    const start = Date.parse('2026-10-26T10:00:00Z');
    return async () => werte.map((w, i) => ({
      timestamp: start + i * 60_000, high: w.h, low: w.l,
    }));
  }

  const boerse = () => ({ boerse: 'paper', marktart: 'futures' as const });
  const keinEinstieg = () => null;

  it('misst beim Long das Tief als MAE und das Hoch als MFE', async () => {
    // Einstieg 100, Risiko 5 auf 1 Stueck → 1 R = 5 Kurspunkte.
    // Tief 97 = −3 Punkte = −0,6 R. Hoch 115 = +15 = +3 R.
    const a = await ausschlaegeErmitteln(
      [trade()],
      kerzen([{ h: 102, l: 99 }, { h: 115, l: 97 }, { h: 110, l: 108 }]),
      boerse, keinEinstieg,
    );

    expect(a.trades[0]!.maeR).toBeCloseTo(-0.6, 2);
    expect(a.trades[0]!.mfeR).toBeCloseTo(3, 2);
  });

  it('dreht die Messung beim Short um', async () => {
    // Short bei 100: Das HOCH laeuft gegen uns.
    const a = await ausschlaegeErmitteln(
      [trade({ richtung: 'short' })],
      kerzen([{ h: 103, l: 99 }, { h: 106, l: 92 }]),
      boerse, keinEinstieg,
    );

    // Hoch 106 = 6 Punkte gegen uns = −1,2 R
    expect(a.trades[0]!.maeR).toBeCloseTo(-1.2, 2);
    // Tief 92 = 8 Punkte fuer uns = +1,6 R
    expect(a.trades[0]!.mfeR).toBeCloseTo(1.6, 2);
  });

  it('erkennt knapp gestoppte Verlierer', async () => {
    // Der Tiefpunkt lag bei −1,04 R: Der Stop riss knapp.
    const a = await ausschlaegeErmitteln(
      [trade({ ergebnis: -5, rVielfaches: -1, slGetroffen: true })],
      kerzen([{ h: 101, l: 94.8 }]),
      boerse, keinEinstieg,
    );

    expect(a.trades[0]!.maeR).toBeCloseTo(-1.04, 2);
    expect(a.knappGestoppt).toBe(1);
  });

  it('zaehlt einen klar gestoppten Verlierer nicht als knapp', async () => {
    // Weit unter dem Stop — hier half kein weiterer Stop.
    const a = await ausschlaegeErmitteln(
      [trade({ ergebnis: -5, rVielfaches: -1, slGetroffen: true })],
      kerzen([{ h: 101, l: 88 }]),
      boerse, keinEinstieg,
    );

    expect(a.trades[0]!.maeR).toBeCloseTo(-2.4, 2);
    expect(a.knappGestoppt).toBe(0);
  });

  it('erkennt zu frueh geschlossene Gewinner', async () => {
    // Mitgenommen bei +1 R, gelaufen waere er bis +4 R.
    const a = await ausschlaegeErmitteln(
      [trade({ ergebnis: 5, rVielfaches: 1 })],
      kerzen([{ h: 120, l: 100 }]),
      boerse, keinEinstieg,
    );

    expect(a.trades[0]!.mfeR).toBeCloseTo(4, 2);
    expect(a.zuFruehGeschlossen).toBe(1);
  });

  it('laesst Trades ohne Risiko unbewertet', async () => {
    const a = await ausschlaegeErmitteln(
      [trade({ risiko: null })],
      kerzen([{ h: 110, l: 90 }]),
      boerse, keinEinstieg,
    );

    expect(a.trades[0]!.maeR).toBeNull();
    expect(a.ohneDaten).toBe(1);
    expect(a.ausgewertet).toBe(0);
  });

  it('laesst Trades ohne Kerzen unbewertet, statt zu raten', async () => {
    const a = await ausschlaegeErmitteln(
      [trade()],
      async () => [],
      boerse, keinEinstieg,
    );

    expect(a.trades[0]!.maeR).toBeNull();
    expect(a.ohneDaten).toBe(1);
  });

  it('uebersteht eine Boerse, die nicht antwortet', async () => {
    const a = await ausschlaegeErmitteln(
      [trade()],
      async () => { throw new Error('Boerse weg'); },
      boerse, keinEinstieg,
    );

    // Kein Absturz, nur keine Aussage.
    expect(a.trades).toHaveLength(1);
    expect(a.trades[0]!.maeR).toBeNull();
  });

  it('mittelt die Ausschlaege getrennt nach Gewinnern und Verlierern', async () => {
    const a = await ausschlaegeErmitteln(
      [
        trade({ planId: 'g1', ergebnis: 10, rVielfaches: 2 }),
        trade({ planId: 'v1', ergebnis: -5, rVielfaches: -1, slGetroffen: true }),
      ],
      kerzen([{ h: 110, l: 97.5 }]),
      boerse, keinEinstieg,
    );

    // Beide sehen dieselben Kerzen: MAE −0,5 R, MFE +2 R
    expect(a.schnittMaeGewinner).toBeCloseTo(-0.5, 2);
    expect(a.schnittMaeVerlierer).toBeCloseTo(-0.5, 2);
    expect(a.schnittMfeGewinner).toBeCloseTo(2, 2);
    expect(a.ausgewertet).toBe(2);
  });
});

// ============================================================
// Leistung je Börse und Signalquelle
//
// Die Frage, die sich mit mehreren Börsen zuerst stellt: Welche
// laufen gut? Aus den Gesamtzahlen ist das nicht zu lesen — eine
// gute und eine schlechte Quelle ergeben zusammen eine
// mittelmäßige.
// ============================================================

describe('gruppiert — Kennzahlen je Herkunft', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: KennzahlenService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'gruppen-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    dienst = new KennzahlenService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function t(opt: Partial<TradeInR>): TradeInR {
    return {
      planId: `p${Math.random()}`, symbol: 'BTCUSDT', richtung: 'long',
      strategie: 'A', signalId: 's', boerse: 'phemex', quelle: 'signal',
      uebung: true, begonnen: null, beendet: '2026-11-01T10:00:00Z',
      dauerMinuten: 60, menge: 1, einstiegsPreis: 100,
      risiko: 100, ergebnis: 0, rVielfaches: 0,
      tpsErreicht: 0, slGetroffen: false,
      ...opt,
    };
  }

  it('teilt nach Börse auf und rechnet je Gruppe', () => {
    const g = dienst.gruppiert([
      t({ boerse: 'phemex', ergebnis: 100, rVielfaches: 1 }),
      t({ boerse: 'phemex', ergebnis: 50, rVielfaches: 0.5 }),
      t({ boerse: 'bybit', ergebnis: -30, rVielfaches: -0.3 }),
    ], 'boerse');

    expect(g).toHaveLength(2);
    // Sortiert nach Ergebnis — die Frage ist "was läuft am besten?".
    expect(g[0]!.name).toBe('phemex');
    expect(g[0]!.kennzahlen.trades).toBe(2);
    expect(g[0]!.kennzahlen.ergebnis).toBeCloseTo(150, 2);
    expect(g[1]!.name).toBe('bybit');
    expect(g[1]!.kennzahlen.ergebnis).toBeCloseTo(-30, 2);
  });

  it('teilt nach Strategie auf', () => {
    const g = dienst.gruppiert([
      t({ strategie: 'Synaptrix', ergebnis: 80 }),
      t({ strategie: 'TradingView', ergebnis: -20 }),
      t({ strategie: 'Synaptrix', ergebnis: 40 }),
    ], 'strategie');

    expect(g.map(x => x.name)).toEqual(['Synaptrix', 'TradingView']);
    expect(g[0]!.kennzahlen.trades).toBe(2);
  });

  // Übung und Echthandel sind nicht dasselbe. Eine Gruppe gilt nur
  // dann als Übung, wenn ALLE ihre Trades übten.
  it('kennzeichnet reine Übungsgruppen', () => {
    const g = dienst.gruppiert([
      t({ boerse: 'paper', uebung: true }),
      t({ boerse: 'paper', uebung: true }),
      t({ boerse: 'phemex', uebung: false }),
    ], 'boerse');

    expect(g.find(x => x.name === 'paper')!.uebung).toBe(true);
    expect(g.find(x => x.name === 'phemex')!.uebung).toBe(false);
  });

  it('gilt eine gemischte Gruppe nicht als Übung', () => {
    // Kommt vor, wenn eine Börse zwischendurch umgestellt wurde.
    const g = dienst.gruppiert([
      t({ boerse: 'phemex', uebung: true }),
      t({ boerse: 'phemex', uebung: false }),
    ], 'boerse');

    expect(g[0]!.uebung).toBe(false);
  });

  it('rechnet je Gruppe dasselbe wie fürs Ganze', () => {
    const trades = [
      t({ boerse: 'phemex', ergebnis: 100, rVielfaches: 1 }),
      t({ boerse: 'phemex', ergebnis: -50, rVielfaches: -0.5 }),
    ];

    const gruppe = dienst.gruppiert(trades, 'boerse')[0]!.kennzahlen;
    const ganz = dienst.kennzahlen(trades);

    // Es gibt keine zweite Rechnung, die auseinanderlaufen könnte.
    expect(gruppe).toEqual(ganz);
  });

  it('kommt mit einer leeren Liste zurecht', () => {
    expect(dienst.gruppiert([], 'boerse')).toEqual([]);
  });
});

// ============================================================
// Kalender — Ergebnis je Tag
// ============================================================

describe('jeTag — Kalenderdaten', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: KennzahlenService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'kalender-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    dienst = new KennzahlenService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  function t(beendet: string | null, ergebnis: number, risiko = 100): TradeInR {
    return {
      planId: `p${Math.random()}`, symbol: 'BTCUSDT', richtung: 'long',
      strategie: 'A', signalId: 's', boerse: 'paper', quelle: 'signal',
      uebung: true, begonnen: null, beendet, dauerMinuten: 60,
      menge: 1, einstiegsPreis: 100, risiko,
      ergebnis, rVielfaches: risiko > 0 ? ergebnis / risiko : null,
      tpsErreicht: ergebnis > 0 ? 1 : 0, slGetroffen: ergebnis < 0,
    };
  }

  it('fasst nach dem Tag des Schließens zusammen', () => {
    const tage = dienst.jeTag([
      t('2026-11-01T08:00:00Z', 50),
      t('2026-11-01T18:00:00Z', -20),
      t('2026-11-03T12:00:00Z', 30),
    ]);

    expect(tage).toHaveLength(2);
    expect(tage[0]!.tag).toBe('2026-11-01');
    expect(tage[0]!.trades).toBe(2);
    expect(tage[0]!.gewinner).toBe(1);
    expect(tage[0]!.ergebnis).toBeCloseTo(30, 2);
    expect(tage[1]!.tag).toBe('2026-11-03');
  });

  it('gibt die Tage aufsteigend zurück', () => {
    const tage = dienst.jeTag([
      t('2026-11-05T10:00:00Z', 10),
      t('2026-11-01T10:00:00Z', 20),
      t('2026-11-03T10:00:00Z', 30),
    ]);
    expect(tage.map(x => x.tag)).toEqual(['2026-11-01', '2026-11-03', '2026-11-05']);
  });

  it('rechnet den ROI auf das eingegangene Risiko', () => {
    // 50 Gewinn auf 200 Risiko = 25 %.
    const tage = dienst.jeTag([t('2026-11-01T10:00:00Z', 50, 200)]);
    expect(tage[0]!.roiPct).toBeCloseTo(25, 2);
  });

  // Ohne bekanntes Risiko keine Prozentangabe — eine erfundene
  // Bezugsgröße wäre schlechter als gar keine.
  it('lässt den ROI weg, wenn kein Risiko bekannt ist', () => {
    const ohne = t('2026-11-01T10:00:00Z', 50);
    ohne.risiko = null;
    expect(dienst.jeTag([ohne])[0]!.roiPct).toBeNull();
  });

  it('übergeht Trades ohne Schlusszeitpunkt', () => {
    // Ein laufender Trade hat noch kein Tagesergebnis.
    expect(dienst.jeTag([t(null, 50)])).toEqual([]);
  });

  it('summiert die R-Vielfachen des Tages', () => {
    const tage = dienst.jeTag([
      t('2026-11-01T08:00:00Z', 100, 100),   // +1 R
      t('2026-11-01T09:00:00Z', -50, 100),   // −0,5 R
    ]);
    expect(tage[0]!.summeR).toBeCloseTo(0.5, 4);
  });

  it('kennzeichnet reine Übungstage', () => {
    const echt = t('2026-11-02T10:00:00Z', 10);
    echt.uebung = false;

    const tage = dienst.jeTag([t('2026-11-01T10:00:00Z', 10), echt]);
    expect(tage[0]!.uebung).toBe(true);
    expect(tage[1]!.uebung).toBe(false);
  });
});
