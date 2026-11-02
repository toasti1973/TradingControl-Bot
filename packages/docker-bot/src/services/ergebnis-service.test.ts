// ============================================================
// Was hat ein Plan eingebracht?
//
// Eine falsche Zahl hier ist schlimmer als gar keine: Wer glaubt, ein
// Trade sei im Gewinn, laesst ihn laufen. Besonderes Augenmerk liegt
// deshalb auf dem Vorzeichen beim Short und auf der Trennung von
// realisiert und nicht realisiert.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { ErgebnisService } from './ergebnis-service.js';

describe('ErgebnisService', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let ergebnis: ErgebnisService;

  const PLAN = 'plan-1';

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'ergebnis-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    ergebnis = new ErgebnisService(store);

    store.upsertBotTradePlan({
      id: PLAN, source: 'signal', symbol: 'BTCUSDT', market_type: 'futures',
      direction: 'long', leverage: 10, total_size: 0.2, entry_strategy: 'equal',
      entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]',
      execution_mode: 'all_limit', status: 'active', bot_enabled: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  /** Eine abgeschickte und gefuellte Order. */
  function order(
    rolle: 'entry' | 'take_profit' | 'stop_loss',
    seite: 'buy' | 'sell',
    menge: number,
    preis: number,
    extra: { gefuellt?: number; gebuehr?: number } = {},
  ) {
    const id = `${rolle}-${seite}-${menge}-${preis}`;
    store.insertPlanOrder({
      id, trade_plan_id: PLAN, side: seite, order_type: 'limit', role: rolle,
      symbol: 'BTCUSDT', price: preis, quantity: menge,
      status: 'filled', broker: 'paper',
    });
    store.updatePlanOrder(id, {
      filled_quantity: extra.gefuellt ?? menge,
      avg_fill_price: preis,
      fees: extra.gebuehr,
      fee_currency: extra.gebuehr ? 'USDT' : undefined,
    });
  }

  it('meldet nichts, solange kein Einstieg gefuellt wurde', () => {
    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

    expect(e.eingestiegen).toBe(0);
    expect(e.realisiert).toBe(0);
    expect(e.unrealisiert).toBeNull();
    expect(e.einstiegsPreis).toBeNull();
  });

  it('rechnet einen Long mit vollstaendigem Ausstieg', () => {
    order('entry', 'buy', 0.2, 50_000);
    order('take_profit', 'sell', 0.2, 52_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 52_000);

    // 0.2 * (52000 - 50000) = 400
    expect(e.realisiertBrutto).toBe(400);
    expect(e.realisiert).toBe(400);
    expect(e.offen).toBe(0);
    expect(e.unrealisiert).toBeNull();
    // Einsatz: 0.2 * 50000 / 10 = 1000 → 40 %
    expect(e.einsatz).toBe(1000);
    expect(e.renditePct).toBe(40);
  });

  it('dreht das Vorzeichen beim Short', () => {
    // Short: Einstieg ist der Verkauf, der Rueckkauf tiefer ist Gewinn.
    order('entry', 'sell', 0.2, 50_000);
    order('take_profit', 'buy', 0.2, 48_000);

    const e = ergebnis.fuerPlan(PLAN, 'short', 10, 48_000);

    expect(e.realisiert).toBe(400);
    expect(e.renditePct).toBe(40);
  });

  it('weist einen Verlust als solchen aus', () => {
    order('entry', 'buy', 0.2, 50_000);
    order('stop_loss', 'sell', 0.2, 49_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 49_000);

    expect(e.realisiert).toBe(-200);
    expect(e.renditePct).toBe(-20);
  });

  it('trennt realisiert und nicht realisiert bei einer Teilschliessung', () => {
    order('entry', 'buy', 0.2, 50_000);
    order('take_profit', 'sell', 0.1, 52_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 51_000);

    // Realisiert: 0.1 * (52000 - 50000) = 200
    expect(e.realisiert).toBe(200);
    // Offen: 0.1 zum Kurs 51000 → 0.1 * (51000 - 50000) = 100
    expect(e.offen).toBeCloseTo(0.1, 10);
    expect(e.unrealisiert).toBe(100);
    expect(e.gesamt).toBe(300);
  });

  it('mittelt mehrere Einstiege zu unterschiedlichen Preisen', () => {
    order('entry', 'buy', 0.1, 50_000);
    order('entry', 'buy', 0.1, 48_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 49_000);

    expect(e.einstiegsPreis).toBe(49_000);
    // Zum Durchschnitt selbst ist nichts gewonnen.
    expect(e.unrealisiert).toBe(0);
  });

  it('zieht die Gebuehren vom Ergebnis ab und weist sie getrennt aus', () => {
    order('entry', 'buy', 0.2, 50_000, { gebuehr: 6 });
    order('take_profit', 'sell', 0.2, 52_000, { gebuehr: 6.24 });

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 52_000);

    expect(e.realisiertBrutto).toBe(400);
    expect(e.gebuehren).toBe(12.24);
    expect(e.realisiert).toBe(387.76);
  });

  it('laesst das nicht realisierte Ergebnis offen, wenn kein Kurs vorliegt', () => {
    order('entry', 'buy', 0.2, 50_000);

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, null);

    // Lieber eine Luecke als eine erfundene Zahl.
    expect(e.unrealisiert).toBeNull();
    expect(e.kurs).toBeNull();
    expect(e.offen).toBeCloseTo(0.2, 10);
  });

  it('uebergeht Orders ohne Fuellpreis, statt den Durchschnitt zu verfaelschen', () => {
    order('entry', 'buy', 0.1, 50_000);

    // Platziert, aber nie gefuellt: keine Menge, kein Preis.
    store.insertPlanOrder({
      id: 'offen-1', trade_plan_id: PLAN, side: 'buy', order_type: 'limit',
      role: 'entry', symbol: 'BTCUSDT', price: 48_000, quantity: 0.1,
      status: 'placed', broker: 'paper',
    });

    const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

    expect(e.eingestiegen).toBeCloseTo(0.1, 10);
    expect(e.einstiegsPreis).toBe(50_000);
  });

  // ============================================================
  // Wieviele Teil-Einstiege sind ausgefuehrt?
  //
  // Die Menge allein beantwortet das nicht, und die Antwort ist die,
  // auf die es in der Einstiegsphase ankommt: Ein Plan mit vier
  // gestaffelten Limits, von dem erst eines gefuellt ist, steht mit
  // einem Viertel im Markt — nicht mit dem ganzen Plan.
  // ============================================================

  describe('Zahl der Einstiege', () => {
    it('zaehlt abgeschickte und gefuellte Einstiege getrennt', () => {
      order('entry', 'buy', 0.05, 50_000);
      order('entry', 'buy', 0.05, 49_000);

      // Zwei weitere liegen im Markt, ungefuellt.
      store.insertPlanOrder({
        id: 'offen-a', trade_plan_id: PLAN, side: 'buy', order_type: 'limit',
        role: 'entry', symbol: 'BTCUSDT', price: 48_000, quantity: 0.05,
        status: 'placed', broker: 'paper',
      });
      store.insertPlanOrder({
        id: 'offen-b', trade_plan_id: PLAN, side: 'buy', order_type: 'limit',
        role: 'entry', symbol: 'BTCUSDT', price: 47_000, quantity: 0.05,
        status: 'placed', broker: 'paper',
      });

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

      expect(e.einstiegeAbgeschickt).toBe(4);
      expect(e.einstiegeGefuellt).toBe(2);
    });

    it('zaehlt Ausstiege nicht mit', () => {
      order('entry', 'buy', 0.1, 50_000);
      order('take_profit', 'sell', 0.05, 52_000);
      order('stop_loss', 'sell', 0.05, 49_000);

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

      expect(e.einstiegeAbgeschickt).toBe(1);
      expect(e.einstiegeGefuellt).toBe(1);
    });

    it('zaehlt einen teilgefuellten Einstieg als gefuellt', () => {
      // Teilfuellung: 0,03 von 0,1. Die Stufe ist angebrochen — sie als
      // offen auszuweisen hiesse, einen bestehenden Einstieg zu
      // verschweigen.
      order('entry', 'buy', 0.1, 50_000, { gefuellt: 0.03 });

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

      expect(e.einstiegeGefuellt).toBe(1);
      expect(e.eingestiegen).toBeCloseTo(0.03, 10);
    });

    it('zaehlt einen zurueckgenommenen Einstieg weiter als abgeschickt', () => {
      // Nach dem ersten Take-Profit nimmt der Bot offene Kauf-Limits
      // zurueck. Sie verschwinden damit nicht aus der Geschichte —
      // sonst sieht ein Plan, bei dem zwei von vier Stufen storniert
      // wurden, aus wie einer, der nur zwei vorsah.
      order('entry', 'buy', 0.05, 50_000);
      store.insertPlanOrder({
        id: 'storniert-1', trade_plan_id: PLAN, side: 'buy', order_type: 'limit',
        role: 'entry', symbol: 'BTCUSDT', price: 48_000, quantity: 0.05,
        status: 'cancelled', broker: 'paper',
      });

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

      expect(e.einstiegeAbgeschickt).toBe(2);
      expect(e.einstiegeGefuellt).toBe(1);
    });

    it('bleibt bei null, solange nichts abgeschickt wurde', () => {
      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

      expect(e.einstiegeAbgeschickt).toBe(0);
      expect(e.einstiegeGefuellt).toBe(0);
    });
  });

  // ============================================================
  // Eingesetzt gegen gebunden
  //
  // Zwei verschiedene Zahlen, die beide "Margin" heissen. Die
  // Detailansicht zeigte bis zum 26.10. stattdessen die GEPLANTE —
  // bei drei von vier gefuellten Einstiegen ein Drittel zuviel.
  // ============================================================

  describe('einsatz und einsatzOffen', () => {
    it('nennt den Einsatz der gefuellten Einstiege, nicht den geplanten', () => {
      // Drei von vier Stufen zu je 0,05 — der Plan sah 0,2 vor.
      order('entry', 'buy', 0.05, 50_000);
      order('entry', 'buy', 0.05, 49_000);
      order('entry', 'buy', 0.05, 48_000);

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 48_500);

      // (0,05*50000 + 0,05*49000 + 0,05*48000) / 10 = 735
      expect(e.einsatz).toBeCloseTo(735, 2);
      // Und eben NICHT die geplanten 0,2 * ~49.250 / 10 = 985.
      expect(e.einsatz!).toBeLessThan(800);
    });

    it('bindet nichts, solange kein Einstieg gefuellt ist', () => {
      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);
      expect(e.einsatzOffen).toBeNull();
    });

    it('haelt eingesetzt und gebunden gleich, solange nichts geschlossen ist', () => {
      order('entry', 'buy', 0.2, 50_000);

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

      expect(e.einsatz).toBe(1000);
      expect(e.einsatzOffen).toBe(1000);
    });

    it('gibt nach einem Take-Profit einen Teil wieder frei', () => {
      order('entry', 'buy', 0.2, 50_000);
      order('take_profit', 'sell', 0.1, 52_000);

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 51_000);

      // Eingesetzt war und bleibt die volle Margin — darauf bezieht
      // sich die Rendite.
      expect(e.einsatz).toBe(1000);
      // Gebunden ist nur noch die Haelfte.
      expect(e.einsatzOffen).toBe(500);
    });

    it('bindet nichts mehr, wenn die Position ganz geschlossen ist', () => {
      order('entry', 'buy', 0.2, 50_000);
      order('take_profit', 'sell', 0.2, 52_000);

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 52_000);

      expect(e.einsatz).toBe(1000);
      expect(e.einsatzOffen).toBeNull();
      // Die Rendite bezieht sich weiter auf den Einsatz — sonst waere
      // sie nach dem letzten Take-Profit nicht mehr berechenbar.
      expect(e.renditePct).toBe(40);
    });

    it('rechnet den gebundenen Einsatz zum Einstiegspreis, nicht zum Kurs', () => {
      // Die Margin wird beim Einstieg gestellt und wandert nicht mit.
      order('entry', 'buy', 0.2, 50_000);

      const beiGewinn = ergebnis.fuerPlan(PLAN, 'long', 10, 60_000).einsatzOffen;
      const beiVerlust = ergebnis.fuerPlan(PLAN, 'long', 10, 40_000).einsatzOffen;

      expect(beiGewinn).toBe(1000);
      expect(beiVerlust).toBe(1000);
    });
  });

  // ============================================================
  // Sind die Gebuehren vollstaendig?
  //
  // Die Spalte steht auf DEFAULT 0, und der Monitor schreibt sie nur,
  // wenn die Boerse sie zurueckgibt. Eine nicht gemeldete Gebuehr
  // sieht damit aus wie eine Gebuehr von null — und wird vom
  // realisierten Ergebnis abgezogen, also gar nicht.
  // ============================================================

  describe('Vollstaendigkeit der Gebuehren', () => {
    it('zaehlt nur gefuellte Orders als Fuellung', () => {
      order('entry', 'buy', 0.1, 50_000, { gebuehr: 2.5 });
      store.insertPlanOrder({
        id: 'liegt-im-markt', trade_plan_id: PLAN, side: 'buy', order_type: 'limit',
        role: 'entry', symbol: 'BTCUSDT', price: 48_000, quantity: 0.1,
        status: 'placed', broker: 'paper',
      });

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 50_000);

      // Die ungefuellte Order ist keine Luecke — auf sie faellt
      // schlicht noch keine Gebuehr an.
      expect(e.fuellungen).toBe(1);
      expect(e.fuellungenMitGebuehr).toBe(1);
    });

    it('macht eine Luecke sichtbar, wenn nur ein Teil der Fuellungen gemeldet ist', () => {
      order('entry', 'buy', 0.1, 50_000, { gebuehr: 2.5 });
      order('entry', 'buy', 0.1, 49_000);                  // ohne Gebuehrenangabe
      order('take_profit', 'sell', 0.1, 52_000);           // ebenfalls ohne

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 51_000);

      expect(e.fuellungen).toBe(3);
      expect(e.fuellungenMitGebuehr).toBe(1);
      // Die Summe ist rechnerisch richtig und trotzdem unvollstaendig —
      // genau das muss die Oberflaeche sagen koennen.
      expect(e.gebuehren).toBe(2.5);
    });

    it('meldet Vollstaendigkeit, wenn jede Fuellung eine Gebuehr traegt', () => {
      order('entry', 'buy', 0.2, 50_000, { gebuehr: 5 });
      order('take_profit', 'sell', 0.2, 52_000, { gebuehr: 5.2 });

      const e = ergebnis.fuerPlan(PLAN, 'long', 10, 52_000);

      expect(e.fuellungen).toBe(2);
      expect(e.fuellungenMitGebuehr).toBe(2);
      expect(e.gebuehren).toBe(10.2);
      expect(e.realisiert).toBeCloseTo(400 - 10.2, 6);
    });
  });
});
