// ============================================================
// Der Abgleich mit dem Journal darf den lokalen Ausfuehrungsstand nicht
// verlieren.
//
// Seit der Bot nichts mehr zurueckmeldet, liefert das Journal im Feld
// `executed_orders` immer eine leere Liste. Wuerde der Abgleich diese
// Liste uebernehmen, gaelte jeder bereits platzierte Einstieg wieder als
// offen — und der Bot kaufte beim naechsten Durchlauf ein zweites Mal.
// Genau das pruefen diese Tests.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TradePlan } from '@tradingcontrol/core';
import { TcPlanSyncService } from './tc-plan-sync-service.js';

function makePlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    id: 'plan-001',
    symbol: 'BTCUSDT',
    exchange: 'kraken',
    direction: 'long',
    market_type: 'futures',
    leverage: 5,
    entry_strategy: 'single',
    entry_orders: [{ id: 'entry-a', price: 50000, size: 0.1 }],
    take_profits: [],
    stop_loss_price: 48000,
    stop_loss_type: 'fixed',
    trailing_stop_pct: null,
    trailing_stop_activation: null,
    total_size: 0.1,
    activation_conditions: [],
    executed_orders: [],
    status: 'active',
    bot_enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const stiller_logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
};

describe('TcPlanSyncService — Ausfuehrungsstand', () => {
  let store: {
    getBotTradePlan: ReturnType<typeof vi.fn>;
    getBotTradePlans: ReturnType<typeof vi.fn>;
    upsertBotTradePlan: ReturnType<typeof vi.fn>;
    updateBotTradePlanStatus: ReturnType<typeof vi.fn>;
    getPlanOrders: ReturnType<typeof vi.fn>;
    getMonitor: ReturnType<typeof vi.fn>;
  };
  let monitor: {
    getState: ReturnType<typeof vi.fn>;
    registerPlan: ReturnType<typeof vi.fn>;
    updatePlan: ReturnType<typeof vi.fn>;
    unregisterPlan: ReturnType<typeof vi.fn>;
    beendePlan: ReturnType<typeof vi.fn>;
  };
  let client: { getPlans: ReturnType<typeof vi.fn>; getIndicatorsCatalog: ReturnType<typeof vi.fn> };

  function makeService() {
    return new TcPlanSyncService(
      client as never, store as never, monitor as never, stiller_logger as never,
    );
  }

  beforeEach(() => {
    store = {
      getBotTradePlan: vi.fn().mockReturnValue(undefined),
      getBotTradePlans: vi.fn().mockReturnValue([]),
      upsertBotTradePlan: vi.fn(),
      updateBotTradePlanStatus: vi.fn(),
      getPlanOrders: vi.fn().mockReturnValue([]),
      getMonitor: vi.fn().mockReturnValue(undefined),
    };
    monitor = {
      getState: vi.fn().mockReturnValue(undefined),
      registerPlan: vi.fn(),
      updatePlan: vi.fn().mockResolvedValue(undefined),
      unregisterPlan: vi.fn(),
    beendePlan: vi.fn().mockResolvedValue({
      geschlosseneMenge: 0, stornierteOrders: 1, status: 'cancelled',
    }),
    };
    client = { getPlans: vi.fn().mockResolvedValue([]), getIndicatorsCatalog: vi.fn() };
  });

  it('behaelt den lokal gespeicherten Stand, wenn das Journal eine leere Liste liefert', async () => {
    store.getBotTradePlan.mockReturnValue({
      id: 'plan-001',
      updated_at: '2026-01-01T00:00:00Z',
      executed_orders: JSON.stringify(['entry-a']),
    });
    client.getPlans.mockResolvedValue([makePlan({ executed_orders: [] })]);

    await makeService().syncPlans();

    const gespeichert = store.upsertBotTradePlan.mock.calls[0]![0];
    expect(JSON.parse(gespeichert.executed_orders)).toEqual(['entry-a']);
  });

  it('leitet den Stand aus den abgeschickten Orders ab, wenn das Feld fehlt', async () => {
    // Faellt der Bot zwischen Order und Speichern des Plans aus, ist das
    // Feld leer — die Order liegt aber an der Boerse.
    store.getBotTradePlan.mockReturnValue({ id: 'plan-001', updated_at: '2026-01-01T00:00:00Z' });
    store.getPlanOrders.mockReturnValue([
      { role: 'entry', status: 'placed', entry_order_id: 'entry-a' },
    ]);
    client.getPlans.mockResolvedValue([makePlan()]);

    await makeService().syncPlans();

    const gespeichert = store.upsertBotTradePlan.mock.calls[0]![0];
    expect(JSON.parse(gespeichert.executed_orders)).toEqual(['entry-a']);
  });

  it('zaehlt stornierte und abgelehnte Orders nicht als ausgefuehrt', async () => {
    // Eine stornierte Order liegt nicht mehr an der Boerse — der Einstieg
    // darf wieder platziert werden.
    store.getPlanOrders.mockReturnValue([
      { role: 'entry', status: 'cancelled', entry_order_id: 'entry-a' },
      { role: 'entry', status: 'rejected', entry_order_id: 'entry-b' },
    ]);
    client.getPlans.mockResolvedValue([makePlan()]);

    await makeService().syncPlans();

    const gespeichert = store.upsertBotTradePlan.mock.calls[0]![0];
    expect(JSON.parse(gespeichert.executed_orders)).toEqual([]);
  });

  it('uebergibt dem Monitor den lokalen Stand, nicht den des Journals', async () => {
    store.getPlanOrders.mockReturnValue([
      { role: 'entry', status: 'filled', entry_order_id: 'entry-a' },
    ]);
    client.getPlans.mockResolvedValue([makePlan({ executed_orders: [] })]);

    await makeService().syncPlans();

    expect(monitor.registerPlan).toHaveBeenCalledTimes(1);
    const uebergeben = monitor.registerPlan.mock.calls[0]![0] as TradePlan;
    expect(uebergeben.executed_orders).toEqual(['entry-a']);
    expect(uebergeben.source).toBe('tc');
  });

  it('behaelt Felder, die die Journal-Schnittstelle nicht mitliefert', async () => {
    // /api/v1/bot/plans gibt weder entry_strategy noch notes zurueck.
    store.getBotTradePlan.mockReturnValue({
      id: 'plan-001',
      updated_at: '2026-01-01T00:00:00Z',
      entry_strategy: 'ascending',
      notes: 'Aufbau ueber drei Stufen',
      execution_mode: 'first_market_rest_limit',
    });
    const ohneFelder = makePlan();
    delete (ohneFelder as Partial<TradePlan>).entry_strategy;
    delete (ohneFelder as Partial<TradePlan>).notes;
    client.getPlans.mockResolvedValue([ohneFelder]);

    await makeService().syncPlans();

    const gespeichert = store.upsertBotTradePlan.mock.calls[0]![0];
    expect(gespeichert.entry_strategy).toBe('ascending');
    expect(gespeichert.notes).toBe('Aufbau ueber drei Stufen');
    expect(gespeichert.execution_mode).toBe('first_market_rest_limit');
  });

  it('raeumt einen Plan auf, sobald das Journal ihn nicht mehr fuehrt', async () => {
    store.getBotTradePlans.mockReturnValue([{ id: 'plan-alt' }]);
    client.getPlans.mockResolvedValue([]);

    const ergebnis = await makeService().syncPlans();

    // Ueber `beendePlan`, damit liegende Orders mitgenommen werden.
    expect(monitor.beendePlan).toHaveBeenCalledWith('plan-alt', 'benutzer_abbruch');
    expect(ergebnis.removed).toBe(1);
  });

  // Liegende Kauf-Limits ohne Fuellung sind KEIN Grund, die Aufsicht
  // zu behalten — sie sind Absicht, keine Position.
  //
  // Frueher galten sie als "noch offen". Damit blieb der Plan auf
  // ewig stehen: Das Abmelden war gesperrt, und das Zuruecknehmen der
  // Orders geschah nur beim Abmelden. Ein Kreis ohne Ausgang, in dem
  // am 05.11.2026 ein geloeschter Testplan haengenblieb.
  it('raeumt einen verschwundenen Plan auf, der nur liegende Orders hat', async () => {
    store.getBotTradePlans.mockReturnValue([{ id: 'plan-nur-limits' }]);
    store.getPlanOrders.mockReturnValue([
      // Platziert, aber nichts gefuellt.
      { role: 'entry', status: 'placed', filled_quantity: 0, entry_order_id: 'entry-a' },
    ]);
    client.getPlans.mockResolvedValue([]);

    const ergebnis = await makeService().syncPlans();

    // `beendePlan` nimmt die Orders an der Boerse zurueck — ein blosses
    // Abmelden liesse sie liegen.
    expect(monitor.beendePlan).toHaveBeenCalledWith('plan-nur-limits', 'benutzer_abbruch');
    expect(ergebnis.removed).toBe(1);
  });

  // DAS ist der Fall, der die Aufsicht rechtfertigt: Es steht wirklich
  // etwas im Markt, und daran haengt ein Stop.
  it('behaelt die Aufsicht bei offener Position', async () => {
    store.getBotTradePlans.mockReturnValue([{ id: 'plan-laufend' }]);
    store.getPlanOrders.mockReturnValue([
      { role: 'entry', status: 'filled', filled_quantity: 0.05, entry_order_id: 'entry-a' },
    ]);
    store.getMonitor.mockReturnValue({ status: 'monitoring', remaining_size: 0.05 });
    client.getPlans.mockResolvedValue([]);

    const ergebnis = await makeService().syncPlans();

    expect(monitor.beendePlan).not.toHaveBeenCalled();
    expect(monitor.unregisterPlan).not.toHaveBeenCalled();
    expect(ergebnis.removed).toBe(0);
  });

  it('meldet ab, wenn die Position vollstaendig geschlossen ist', async () => {
    store.getBotTradePlans.mockReturnValue([{ id: 'plan-fertig' }]);
    store.getPlanOrders.mockReturnValue([
      { role: 'entry', status: 'filled', filled_quantity: 0.05, entry_order_id: 'entry-a' },
      { role: 'take_profit', status: 'filled', filled_quantity: 0.05 },
    ]);
    store.getMonitor.mockReturnValue({ status: 'monitoring', remaining_size: 0 });
    client.getPlans.mockResolvedValue([]);

    const ergebnis = await makeService().syncPlans();

    expect(monitor.beendePlan).toHaveBeenCalledWith('plan-fertig', 'benutzer_abbruch');
    expect(ergebnis.removed).toBe(1);
  });

  it('bietet keinen Weg, Daten an das Journal zu senden', async () => {
    // Die Ausfuehrungsdaten holt sich das Journal bei der Boerse. Wer hier
    // eine Sende-Methode ergaenzt, faellt auf.
    const service = makeService() as unknown as Record<string, unknown>;
    for (const name of ['sendReports', 'reportExecution', 'pushReports']) {
      expect(service[name]).toBeUndefined();
    }
  });
});
