// ============================================================
// Zusammenspiel: vom eingehenden Signal bis zum fertigen Plan
//
// Die Einzelteile sind in packages/signals geprueft. Hier geht es um
// die Verdrahtung — dass der Plan wirklich in bot_trade_plans landet,
// dass die Wiederholung eines Signals keinen zweiten erzeugt und dass
// die Bestaende getrennt bleiben.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite-store.js';
import { SignalService, STANDARD_SIGNAL_CONFIG } from './signal-service.js';
import type { CapitalService } from './capital-service.js';
import type { TradePlanMonitor } from './trade-plan-monitor.js';
import type { Logger } from './log-service.js';

const GEHEIMNIS = 'ein-hinreichend-langes-geheimnis-fuer-tests';

const stilleAusgabe = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
} as unknown as Logger;

/** Kontostand und Marktgrenzen nach Mass. */
function kapitalDienst(equity: number, free = equity, grenzen?: Record<string, number>) {
  return {
    hole: async () => ({
      equity, free, quoteCurrency: 'USDT', source: 'exchange' as const,
      at: new Date().toISOString(),
    }),
    holeMarktgrenzen: async () => grenzen,
    getConfig: () => ({ fallbackEquity: 0, allowFallback: false, cacheTtlMs: 0 }),
    setConfig: () => {},
    entwerte: () => {},
  } as unknown as CapitalService;
}

/** Monitor, der sich nur merkt, was angemeldet wurde. */
function monitorAttrappe() {
  const angemeldet: string[] = [];
  return {
    angemeldet,
    dienst: {
      registerPlan: (p: { id: string }) => { angemeldet.push(p.id); },
      unregisterPlan: () => {},
      getState: () => undefined,
    } as unknown as TradePlanMonitor,
  };
}

function signalRumpf(aenderungen: Record<string, unknown> = {}): string {
  return JSON.stringify({
    signal_id: `sig-${Math.round(Math.random() * 1e9)}`,
    strategy: 'MeinIndikator',
    emitted_at: new Date().toISOString(),
    action: 'open',
    reference_capital: 10_000,
    exchange: 'paper',
    symbol: 'BTCUSDT',
    market_type: 'futures',
    direction: 'long',
    leverage: 10,
    total_size: 0.1,
    total_margin: 500,
    entry_orders: [{ price: 50_000, size: 0.1 }],
    take_profits: [{ price: 52_000, percentage: 100 }],
    stop_loss_price: 48_000,
    ...aenderungen,
  });
}

describe('SignalService — vom Signal zum Plan', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let monitor: ReturnType<typeof monitorAttrappe>;

  const baue = (
    equity = 2_500,
    config: Partial<typeof STANDARD_SIGNAL_CONFIG> = {},
    grenzen?: Record<string, number>,
  ) => new SignalService(store, monitor.dienst, kapitalDienst(equity, equity, grenzen), stilleAusgabe, {
    ...STANDARD_SIGNAL_CONFIG,
    webhookSecret: GEHEIMNIS,
    defaultExchange: 'paper',
    autoStart: true,
    risikoprofil: {
      ...STANDARD_SIGNAL_CONFIG.risikoprofil,
      maxRiskPerTradePct: 0,
      maxMarginPerTradePct: 0,
      usableFreeMarginPct: 1,
    },
    ...config,
  });

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'signaltest-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    monitor = monitorAttrappe();
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('legt aus einem Signal einen Plan mit umgerechneter Groesse an', async () => {
    const dienst = baue(2_500);
    const rumpf = signalRumpf();

    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf,
      payload: JSON.parse(rumpf),
      geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.status).toBe('accepted');
    expect(ergebnis.planId).toBeDefined();
    expect(ergebnis.scaling!.factor).toBeCloseTo(0.25, 10);

    const plan = store.getBotTradePlan(ergebnis.planId!)!;
    expect(plan.source).toBe('signal');
    expect(plan.symbol).toBe('BTCUSDT');
    expect(plan.total_size).toBeCloseTo(0.025, 10);
    expect(plan.total_margin).toBeCloseTo(125, 6);

    // Was unveraendert bleiben muss
    expect(plan.leverage).toBe(10);
    expect(plan.stop_loss_price).toBe(48_000);
    expect(JSON.parse(plan.take_profits as string)[0].price).toBe(52_000);
    expect(JSON.parse(plan.take_profits as string)[0].percentage).toBe(100);
    expect(JSON.parse(plan.entry_orders as string)[0].price).toBe(50_000);

    expect(monitor.angemeldet).toContain(ergebnis.planId);
  });

  it('haelt den Herkunftsnachweis am Plan fest', async () => {
    const dienst = baue(2_500);
    const rumpf = signalRumpf();
    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    const plan = store.getBotTradePlan(ergebnis.planId!)!;
    const herkunft = JSON.parse(plan.signal_origin as string);

    expect(herkunft.strategy).toBe('MeinIndikator');
    expect(herkunft.factor).toBeCloseTo(0.25, 10);
    expect(herkunft.reference_capital).toBe(10_000);
    expect(herkunft.capital_equity).toBe(2_500);
    expect(herkunft.reference_margin).toBeCloseTo(500, 6);
    expect(herkunft.scaled_margin).toBeCloseTo(125, 6);

    // Die Notiz erklaert die Groesse in Worten
    expect(plan.notes as string).toContain('Faktor 0,2500');
    expect(plan.notes as string).toContain('unveraendert');
  });

  it('erzeugt aus derselben Kennung keinen zweiten Plan', async () => {
    const dienst = baue(2_500);
    const rumpf = signalRumpf({ signal_id: 'immer-dieselbe' });
    const payload = JSON.parse(rumpf);

    const erste = await dienst.nimmAn({ roherRumpf: rumpf, payload, geheimnisAusPfad: GEHEIMNIS });
    const zweite = await dienst.nimmAn({ roherRumpf: rumpf, payload, geheimnisAusPfad: GEHEIMNIS });

    expect(erste.status).toBe('accepted');
    expect(zweite.status).toBe('duplicate');
    expect(store.getBotTradePlans({ source: 'signal' })).toHaveLength(1);
  });

  it('erkennt die Wiederholung auch nach einem Neustart', async () => {
    const rumpf = signalRumpf({ signal_id: 'ueberlebt-neustart' });
    const payload = JSON.parse(rumpf);

    const vorher = baue(2_500);
    await vorher.nimmAn({ roherRumpf: rumpf, payload, geheimnisAusPfad: GEHEIMNIS });

    // Neuer Dienst auf derselben Datenbank — wie nach einem Neustart
    const nachher = baue(2_500);
    const zweite = await nachher.nimmAn({ roherRumpf: rumpf, payload, geheimnisAusPfad: GEHEIMNIS });

    expect(zweite.status).toBe('duplicate');
    expect(store.getBotTradePlans({ source: 'signal' })).toHaveLength(1);
  });

  it('weist ein Signal mit falschem Geheimnis ab, ohne es aufzuzeichnen', async () => {
    const dienst = baue(2_500);
    const rumpf = signalRumpf();

    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: 'falsch',
    });

    expect(ergebnis.status).toBe('rejected_auth');
    expect(ergebnis.httpStatus).toBe(401);
    expect(store.getSignals()).toHaveLength(0);
    expect(store.getBotTradePlans({})).toHaveLength(0);
  });

  it('zeichnet ein inhaltlich fehlerhaftes Signal auf, legt aber keinen Plan an', async () => {
    const dienst = baue(2_500);
    // Long mit Stop ueber dem Einstieg
    const rumpf = signalRumpf({ stop_loss_price: 51_000 });

    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.status).toBe('rejected_schema');
    expect(store.getBotTradePlans({})).toHaveLength(0);

    const aufgezeichnet = store.getSignals();
    expect(aufgezeichnet).toHaveLength(1);
    expect(aufgezeichnet[0]!.status).toBe('rejected_schema');
    expect(aufgezeichnet[0]!.reason as string).toContain('Stop-Loss');
  });

  it('zeichnet auch die Ablehnung durch die Umrechnung samt Rechnung auf', async () => {
    // Kapital zu klein fuer die Mindestmenge der Boerse
    const dienst = baue(50, {}, { minAmount: 0.001 });
    const rumpf = signalRumpf();

    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.status).toBe('rejected_scaling');
    expect(store.getBotTradePlans({})).toHaveLength(0);

    const eintrag = store.getSignals()[0]!;
    expect(eintrag.status).toBe('rejected_scaling');
    // Die Rechnung ist festgehalten, obwohl nichts gehandelt wurde
    const rechnung = JSON.parse(eintrag.scaling_json as string);
    expect(rechnung.accepted).toBe(false);
    expect(rechnung.capital.equity).toBe(50);
  });

  it('legt den Plan ohne autoStart an, meldet ihn aber nicht zur Ausfuehrung an', async () => {
    const dienst = baue(2_500, { autoStart: false });
    const rumpf = signalRumpf();

    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.status).toBe('accepted');
    const plan = store.getBotTradePlan(ergebnis.planId!)!;
    expect(plan.status).toBe('planned');
    expect(plan.bot_enabled).toBe(0);
    expect(monitor.angemeldet).toHaveLength(0);
  });

  it('haelt die Risikogrenze gegen ein uebergrosses Signal', async () => {
    const dienst = baue(10_000, {
      risikoprofil: {
        ...STANDARD_SIGNAL_CONFIG.risikoprofil,
        maxRiskPerTradePct: 0.01,     // Signal riskiert 2 %
        maxMarginPerTradePct: 0,
        usableFreeMarginPct: 1,
      },
    });
    const rumpf = signalRumpf();

    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.scaling!.limitedBy).toBe('risk_per_trade');
    expect(ergebnis.scaling!.factor).toBeCloseTo(0.5, 10);

    const plan = store.getBotTradePlan(ergebnis.planId!)!;
    expect(plan.total_size).toBeCloseTo(0.05, 10);
    expect(plan.stop_loss_price).toBe(48_000);   // trotzdem unveraendert
    expect(plan.leverage).toBe(10);
  });
});

describe('SignalService — Freigabe wartender Plaene (Weg A)', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let monitor: ReturnType<typeof monitorAttrappe>;
  let dienst: SignalService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'signaltest-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    monitor = monitorAttrappe();
    dienst = new SignalService(store, monitor.dienst, kapitalDienst(10_000), stilleAusgabe, {
      ...STANDARD_SIGNAL_CONFIG,
      webhookSecret: GEHEIMNIS,
      defaultExchange: 'paper',
    });

    store.upsertBotTradePlan({
      id: 'plan-wartend', source: 'local', symbol: 'BTCUSDT', market_type: 'futures',
      direction: 'long', leverage: 5, total_size: 0.2, entry_strategy: 'single',
      entry_orders: '[]', take_profits: '[]', activation_conditions: '[]',
      executed_orders: '[]', execution_mode: 'all_limit', status: 'active', bot_enabled: true,
      signal_trigger: JSON.stringify({ strategy: 'MeinIndikator', tag: 'ausbruch' }),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  const triggerSignal = (aenderungen: Record<string, unknown> = {}) => JSON.stringify({
    signal_id: `trig-${Math.round(Math.random() * 1e9)}`,
    strategy: 'MeinIndikator',
    emitted_at: new Date().toISOString(),
    action: 'trigger',
    symbol: 'BTCUSDT',
    tag: 'ausbruch',
    ...aenderungen,
  });

  it('merkt die Freigabe vor und findet den wartenden Plan', async () => {
    const rumpf = triggerSignal();
    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.status).toBe('accepted');
    expect(ergebnis.matchedPlanIds).toEqual(['plan-wartend']);

    // Im Eingangsbuch steht sie als offener Trigger bereit
    const offene = store.getOffeneTriggerSignale({
      strategy: 'MeinIndikator', symbol: 'BTCUSDT', tag: 'ausbruch', nichtAelterAlsMs: 300_000,
    });
    expect(offene).toHaveLength(1);
  });

  it('legt bei einem Trigger-Signal keinen Plan an', async () => {
    const rumpf = triggerSignal();
    await dienst.nimmAn({ roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS });

    expect(store.getBotTradePlans({ source: 'signal' })).toHaveLength(0);
    expect(monitor.angemeldet).toHaveLength(0);
  });

  it('findet keinen Plan, wenn die Marke nicht passt', async () => {
    const rumpf = triggerSignal({ tag: 'andere-marke' });
    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.status).toBe('no_match');
    expect(ergebnis.matchedPlanIds).toEqual([]);
  });

  it('findet keinen Plan bei fremdem Symbol', async () => {
    const rumpf = triggerSignal({ symbol: 'ETHUSDT' });
    const ergebnis = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });

    expect(ergebnis.status).toBe('no_match');
  });

  it('vergibt eine Freigabe nur einmal', () => {
    store.insertSignal({
      id: 'trigger-eintrag', signal_id: 'trig-x', strategy: 'MeinIndikator',
      action: 'trigger', symbol: 'BTCUSDT',
      raw_payload: JSON.stringify({ tag: 'ausbruch' }), status: 'accepted',
    });

    expect(store.verbraucheTrigger('trigger-eintrag')).toBe(true);
    expect(store.verbraucheTrigger('trigger-eintrag')).toBe(false);

    // Verbrauchte Trigger tauchen nicht mehr als offen auf
    expect(store.getOffeneTriggerSignale({
      strategy: 'MeinIndikator', symbol: 'BTCUSDT', nichtAelterAlsMs: 300_000,
    })).toHaveLength(0);
  });
});

describe('SignalService — Probelauf', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'signaltest-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('rechnet durch, ohne etwas anzulegen oder vorzumerken', async () => {
    const monitor = monitorAttrappe();
    const dienst = new SignalService(store, monitor.dienst, kapitalDienst(2_500), stilleAusgabe, {
      ...STANDARD_SIGNAL_CONFIG,
      webhookSecret: GEHEIMNIS,
      defaultExchange: 'paper',
      risikoprofil: {
        ...STANDARD_SIGNAL_CONFIG.risikoprofil,
        maxRiskPerTradePct: 0, maxMarginPerTradePct: 0, usableFreeMarginPct: 1,
      },
    });

    const payload = JSON.parse(signalRumpf({ signal_id: 'probe-1' }));
    const ergebnis = await dienst.probe(payload);

    expect(ergebnis.valid).toBe(true);
    expect(ergebnis.decision!.factor).toBeCloseTo(0.25, 10);
    expect(ergebnis.plan!.total_size).toBeCloseTo(0.025, 10);

    // Nichts angelegt, nichts aufgezeichnet
    expect(store.getBotTradePlans({})).toHaveLength(0);
    expect(store.getSignals()).toHaveLength(0);

    // Und das Signal gilt danach noch als ungesehen
    const rumpf = signalRumpf({ signal_id: 'probe-1' });
    const echt = await dienst.nimmAn({
      roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS,
    });
    expect(echt.status).toBe('accepted');
  });
});

describe('SignalService — Trennung der Bestaende', () => {
  let verzeichnis: string;
  let store: SqliteStore;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'signaltest-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  it('haelt Signal-Plaene von Journal- und lokalen Plaenen getrennt', async () => {
    const monitor = monitorAttrappe();
    const dienst = new SignalService(store, monitor.dienst, kapitalDienst(10_000), stilleAusgabe, {
      ...STANDARD_SIGNAL_CONFIG, webhookSecret: GEHEIMNIS, defaultExchange: 'paper', autoStart: true,
      risikoprofil: {
        ...STANDARD_SIGNAL_CONFIG.risikoprofil,
        maxRiskPerTradePct: 0, maxMarginPerTradePct: 0, usableFreeMarginPct: 1,
      },
    });

    const grunddaten = {
      market_type: 'futures', direction: 'long', leverage: 1, total_size: 1,
      entry_strategy: 'single', entry_orders: '[]', take_profits: '[]',
      activation_conditions: '[]', executed_orders: '[]', execution_mode: 'all_limit',
      status: 'active', bot_enabled: true,
    } as const;

    store.upsertBotTradePlan({ id: 'p-tc', source: 'tc', symbol: 'BTCUSDT', ...grunddaten });
    store.upsertBotTradePlan({ id: 'p-local', source: 'local', symbol: 'BTCUSDT', ...grunddaten });

    const rumpf = signalRumpf();
    await dienst.nimmAn({ roherRumpf: rumpf, payload: JSON.parse(rumpf), geheimnisAusPfad: GEHEIMNIS });

    expect(store.getBotTradePlans({ source: 'tc' })).toHaveLength(1);
    expect(store.getBotTradePlans({ source: 'local' })).toHaveLength(1);
    expect(store.getBotTradePlans({ source: 'signal' })).toHaveLength(1);
    expect(store.getBotTradePlans({})).toHaveLength(3);

    // Jeder Plan traegt genau eine Herkunft
    const alle = store.getBotTradePlans({});
    expect(new Set(alle.map(p => p.id)).size).toBe(3);
  });
});

// ============================================================
// Das Geheimnis im Datensatz
//
// Der empfohlene Weg ist der Pfad: `/webhook/signal/<geheimnis>`.
// Bei TradingView ist es aber verbreitet, es im Datensatz
// mitzuschicken — die Webhook-Adresse steht offen in der
// Alarm-Verwaltung und wandert beim Weitergeben eines Alarms mit.
//
// Gelesen wurde bisher allein das Feld `secret`. Wer sein Feld
// `geheimnis` nannte — naheliegend bei einer durchweg deutschen
// Oberflaeche —, bekam eine Abweisung ohne erkennbaren Grund: Das
// Geheimnis stand da, nur unter einem Namen, nach dem niemand sah.
//
// Am 02.11.2026 waren so 18 TradingView-Alarme eingerichtet, von
// denen keiner durchkam.
// ============================================================

describe('SignalService — Geheimnis im Datensatz', () => {
  let verzeichnis: string;
  let store: SqliteStore;
  let dienst: SignalService;

  beforeEach(() => {
    verzeichnis = mkdtempSync(join(tmpdir(), 'sigsec-'));
    store = new SqliteStore(join(verzeichnis, 'bot.db'));
    dienst = new SignalService(
      store, monitorAttrappe().dienst, kapitalDienst(10_000), stilleAusgabe,
      { ...STANDARD_SIGNAL_CONFIG, webhookSecret: GEHEIMNIS, defaultExchange: 'paper' },
    );
  });

  afterEach(() => {
    store.close();
    rmSync(verzeichnis, { recursive: true, force: true });
  });

  async function schicke(aenderungen: Record<string, unknown>) {
    const rumpf = signalRumpf(aenderungen);
    return dienst.nimmAn({
      roherRumpf: rumpf,
      payload: JSON.parse(rumpf) as Record<string, unknown>,
      herkunftsAdresse: '1.2.3.4',
    });
  }

  it('nimmt das Feld `geheimnis` an — der Fall aus TradingView', async () => {
    const ergebnis = await schicke({ geheimnis: GEHEIMNIS });
    expect(ergebnis.status).not.toBe('rejected_auth');
  });

  it('nimmt weiterhin `secret` an', async () => {
    const ergebnis = await schicke({ secret: GEHEIMNIS });
    expect(ergebnis.status).not.toBe('rejected_auth');
  });

  it('kennt auch passphrase, token und key', async () => {
    for (const feld of ['passphrase', 'token', 'key']) {
      const ergebnis = await schicke({ [feld]: GEHEIMNIS });
      expect(ergebnis.status, `Feld "${feld}"`).not.toBe('rejected_auth');
    }
  });

  it('weist ein falsches Geheimnis ab', async () => {
    expect((await schicke({ geheimnis: 'falsch' })).status).toBe('rejected_auth');
  });

  it('weist einen Datensatz ohne Geheimnis ab', async () => {
    expect((await schicke({})).status).toBe('rejected_auth');
  });

  // Ohne diese Pruefung traefe ein leeres Feld gegen ein leeres
  // konfiguriertes Geheimnis.
  it('wertet ein leeres Feld nicht als Angabe', async () => {
    expect((await schicke({ geheimnis: '' })).status).toBe('rejected_auth');
  });

  it('macht das Geheimnis vor dem Speichern unkenntlich', async () => {
    await schicke({ geheimnis: GEHEIMNIS });

    const roh = String(store.getSignals({ limit: 1 })[0]?.raw_payload ?? '');
    expect(roh, 'Geheimnis im Klartext in der Datenbank').not.toContain(GEHEIMNIS);
    expect(roh).toContain('***');
    // Der Rest bleibt erhalten — er ist der Beleg.
    expect(roh).toContain('BTCUSDT');
  });

  it('maskiert jedes der bekannten Felder', async () => {
    for (const feld of ['secret', 'geheimnis', 'passphrase', 'token', 'key']) {
      await schicke({ [feld]: GEHEIMNIS });
    }
    for (const eintrag of store.getSignals({ limit: 20 })) {
      expect(String(eintrag.raw_payload ?? ''), 'unmaskiert').not.toContain(GEHEIMNIS);
    }
  });

  it('kommt mit Leerzeichen und Zeilenumbruechen zurecht', async () => {
    // So schickt TradingView es: eingerueckt, mit Umbruechen.
    const rumpf = `{\n  "geheimnis" : "${GEHEIMNIS}",\n` +
      signalRumpf().slice(1);

    await dienst.nimmAn({
      roherRumpf: rumpf,
      payload: JSON.parse(rumpf) as Record<string, unknown>,
      herkunftsAdresse: '1.2.3.4',
    });

    expect(String(store.getSignals({ limit: 1 })[0]?.raw_payload ?? ''))
      .not.toContain(GEHEIMNIS);
  });
});
