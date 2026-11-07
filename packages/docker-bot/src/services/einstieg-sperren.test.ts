// ============================================================
// Zwei Sperren vor dem Einstieg
//
// Beide stammen aus demselben Vorfall. Am 05.11.2026 um 17:07 kam ein
// TC-Plan (BTCUSDT long, Phemex, Hebel 4) an, waehrend Phemex noch im
// Uebungsbetrieb lief:
//
//   17:07:58  Einstieg, Stop und 4 Ziele gehen an den Uebungsbroker
//   17:08:45  der Uebungs-Stop laeuft → Plan gilt als `completed`
//   17:08:58  Phemex wird auf echten Handel umgestellt
//   17:10:01  `setLeverage` scheitert (TE_ERR_INCONSISTENT_POS_MODE),
//             der Code machte "fahre fort"
//   17:10:03  zwei Einstiege gehen ECHT an Phemex — mit Phemex'
//             voreingestelltem Hebel 20 statt der geplanten 4, und
//             ohne TP, ohne SL, weil der Monitor den Plan fuer fertig
//             hielt
//
// Jede der beiden Sperren haette gereicht, um das zu verhindern.
// Deshalb gibt es beide.
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { TradePlanMonitor } from './trade-plan-monitor.js';

type Order = { role?: string; broker?: string; filled_quantity?: number; status?: string };

describe('Einstieg: Sperren vor der Order', () => {
  let monitor: TradePlanMonitor;
  let orders: Order[];
  let platziert: unknown[];
  let hebelVersuche: number[];
  let hebelWirft: boolean;
  let protokoll: { stufe: string; text: string }[];
  let abgelehnt: string[];

  const plan = {
    id: 'a4cecc1e-297d-48de-948c-0a5b35e12500',
    symbol: 'BTCUSDT', direction: 'long', leverage: 4,
    market_type: 'futures', exchange: 'phemex',
    entry_orders: [{ id: 'e1', price: 76216.32, size: 0.05221401 }],
  };
  const entry = { id: 'e1', price: 76216.32, size: 0.05221401 };

  beforeEach(() => {
    orders = [];
    platziert = [];
    hebelVersuche = [];
    hebelWirft = false;
    protokoll = [];
    abgelehnt = [];

    monitor = Object.create(TradePlanMonitor.prototype) as TradePlanMonitor;
    const m = monitor as unknown as Record<string, unknown>;

    m['logger'] = {
      info: (_o: unknown, t?: string) => protokoll.push({ stufe: 'info', text: t ?? '' }),
      warn: (_o: unknown, t?: string) => protokoll.push({ stufe: 'warn', text: t ?? '' }),
      error: (_o: unknown, t?: string) => protokoll.push({ stufe: 'error', text: t ?? '' }),
      debug: () => {},
    };
    m['store'] = {
      getPlanOrders: () => orders,
      insertPlanOrder: () => {},
      updateBotTradePlan: () => {},
    };
    m['pruefeBoerse'] = () => ({ ok: true });
    m['auditReject'] = (_p: unknown, _e: unknown, grund: string) => abgelehnt.push(grund);
    m['merkeFuellung'] = () => {};
    m['persistMonitor'] = () => {};
    m['brokerFor'] = async () => ({
      name: 'phemex-futures',
      setLeverage: async (_s: string, hebel: number) => {
        hebelVersuche.push(hebel);
        if (hebelWirft) {
          throw new Error('phemex {"code":20004,"msg":"TE_ERR_INCONSISTENT_POS_MODE","data":null}');
        }
      },
      placeOrder: async (p: unknown) => {
        platziert.push(p);
        return {
          orderId: 'neu-1', status: 'open', filledQuantity: 0,
          symbol: 'BTCUSDT', side: 'buy', type: 'limit',
        };
      },
    });
  });

  const einstieg = () => (monitor as unknown as {
    executeEntryOrder: (s: unknown, e: unknown, k: number) => Promise<void>;
  }).executeEntryOrder(
    { plan, triggeredEntries: new Set(), orderIds: new Map() },
    entry, 76216.32,
  );

  describe('Sperre 1 — ohne bestaetigten Hebel kein Einstieg', () => {
    it('schickt keine Order, wenn setLeverage scheitert', async () => {
      hebelWirft = true;

      await einstieg();

      // Das ist der Kern: Vorher ging die Order trotzdem hinaus, und
      // Phemex nahm seine Voreinstellung 20x statt der geplanten 4x.
      expect(platziert).toHaveLength(0);
      expect(hebelVersuche).toEqual([4]);
    });

    it('begruendet die Ablehnung mit dem Hebel', async () => {
      hebelWirft = true;

      await einstieg();

      // Ein stiller Abbruch sahe aus wie ein Plan, der auf seinen
      // Kurs wartet.
      expect(abgelehnt[0]).toMatch(/Hebel 4x/);
      expect(protokoll.some((p) => p.stufe === 'error' && /Hebel nicht gesetzt/.test(p.text))).toBe(true);
    });

    it('schickt die Order, wenn der Hebel sitzt', async () => {
      await einstieg();

      expect(hebelVersuche).toEqual([4]);
      expect(platziert).toHaveLength(1);
    });

    // Der naechste Durchlauf versucht es erneut — die Sperre ist keine
    // endgueltige Absage, nur eine fuer diesen Augenblick.
    it('laesst den Plan am Leben', async () => {
      hebelWirft = true;
      await einstieg();

      hebelWirft = false;
      await einstieg();

      expect(platziert).toHaveLength(1);
    });
  });

  describe('Sperre 2 — kein Wechsel des Kontos mitten im Plan', () => {
    it('schickt keine Order, wenn der Plan schon auf paper lief', async () => {
      orders = [
        { role: 'entry', broker: 'paper', filled_quantity: 0.05221401, status: 'filled' },
        { role: 'stop_loss', broker: 'paper', filled_quantity: 0.05221401, status: 'filled' },
      ];

      await einstieg();

      expect(platziert).toHaveLength(0);
      expect(abgelehnt[0]).toMatch(/paper/);
      expect(abgelehnt[0]).toMatch(/mischen/);
    });

    // Der Hebel wird dann gar nicht erst gesetzt: Die Sperre greift
    // vorher, damit der Bot auf einem fremden Konto nichts anfasst.
    it('setzt nicht einmal den Hebel', async () => {
      orders = [{ role: 'entry', broker: 'paper', filled_quantity: 0.05, status: 'filled' }];

      await einstieg();

      expect(hebelVersuche).toHaveLength(0);
    });

    it('laesst Orders desselben Brokers durch', async () => {
      orders = [
        { role: 'entry', broker: 'phemex-futures', filled_quantity: 0.02, status: 'filled' },
      ];

      await einstieg();

      expect(platziert).toHaveLength(1);
    });

    // Eine Order ohne Broker-Vermerk ist eine Altlast, kein fremdes
    // Konto. Sie zu einem Grund zu machen, liesse bestehende Plaene
    // nach dem Update nicht mehr handeln.
    it('stolpert nicht ueber Orders ohne Broker-Vermerk', async () => {
      orders = [
        { role: 'entry', broker: '', filled_quantity: 0.02, status: 'filled' },
        { role: 'entry', filled_quantity: 0.01, status: 'filled' },
      ];

      await einstieg();

      expect(platziert).toHaveLength(1);
    });
  });

  describe('Die offene Position rechnet je Konto', () => {
    const offen = (planId: string, broker?: string) => (monitor as unknown as {
      offenePositionVon: (p: string, b?: string) => number;
    }).offenePositionVon(planId, broker);

    // Genau die Lage vom 05.11.2026: Der Uebungs-Einstieg und der
    // Uebungs-Stop heben sich auf, zwei echte Kauf-Limits liegen
    // daneben. Ohne Trennung meldete der Plan "nichts offen".
    it('zaehlt nur Orders des genannten Brokers', () => {
      orders = [
        { role: 'entry', broker: 'paper', filled_quantity: 0.05221401 },
        { role: 'stop_loss', broker: 'paper', filled_quantity: 0.05221401 },
        { role: 'entry', broker: 'phemex-futures', filled_quantity: 0.03 },
      ];

      expect(offen('p1', 'paper')).toBe(0);
      expect(offen('p1', 'phemex-futures')).toBe(0.03);
    });

    it('zaehlt ohne Angabe alles zusammen', () => {
      orders = [
        { role: 'entry', broker: 'paper', filled_quantity: 0.02 },
        { role: 'entry', broker: 'phemex-futures', filled_quantity: 0.03 },
      ];

      // Fuer das Aufraeumen von Altlasten gebraucht: Dort will man
      // wissen, ob irgendwo noch etwas offen ist.
      expect(offen('p1')).toBe(0.05);
    });
  });
});
