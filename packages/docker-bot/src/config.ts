import 'dotenv/config';
import { listExchanges, type BrokerMarketType } from '@tradingcontrol/core';

/** Zugangsdaten fuer eine Boerse. */
export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  /** Manche Boersen verlangen zusaetzlich eine Passphrase (OKX, KuCoin, Crypto.com). */
  password?: string;
  testnet?: boolean;
  /** Feste Marktart; ohne Angabe entscheidet die Boerse. */
  marketType?: BrokerMarketType;
}

export interface BotConfig {
  tcApiUrl: string;
  tcApiKey: string;
  /**
   * Boerse fuer Plaene, die keine eigene nennen — und fuer den
   * Uebungsbetrieb der Wert 'paper'.
   */
  defaultExchange: string;
  /** Zugangsdaten je Boerse, Schluessel wie im Boersen-Verzeichnis. */
  exchanges: Record<string, ExchangeCredentials>;
  /**
   * Rueckkanal an TC-Synaptrix: wohin Planereignisse gemeldet werden.
   *
   * Leer = der Kanal ist zu, der Bot meldet nichts und verhaelt sich wie
   * bisher. **Gegenueber dem Journal aendert das nichts** — dorthin
   * meldet der Bot weiterhin nicht zurueck, weil das Journal seine
   * Buchhaltung ueber den Boersen-Import fuehrt und eine zweite Quelle
   * genau den Abgleichkonflikt erzeugte, den es zu vermeiden gilt.
   *
   * Ganz oder gar nicht: Eine Adresse ohne Token kann sich nicht
   * ausweisen und wuerde bei jedem Takt mit 401 abgewiesen — eine
   * Einrichtung, die eingerichtet aussieht und nichts uebergibt.
   */
  tcRueckkanalUrl: string;
  tcRueckkanalToken: string;
  webUiPassword: string;
  webPort: number;
  planPollInterval: number;
  pricePollInterval: number;
  orderCheckInterval: number;
  logLevel: string;
  dataDir: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramEnabled: boolean;
  /**
   * Nur Boersen mit EWR-Zulassung zulassen. Voreingestellt an: Wer
   * bewusst anderswo handeln will, schaltet es ausdruecklich ab.
   */
  nurMicaBoersen: boolean;

  /**
   * Ausschliesslich im Uebungsbetrieb handeln — kein Auftrag verlaesst
   * den Bot, gleich welche Boerse ein Plan nennt.
   *
   * Der Riegel sitzt in `createBroker`, also an der einzigen Stelle, an
   * der ein Boersenzugang entsteht. Das ist Absicht: Darauf zu bauen,
   * dass keine Zugangsdaten hinterlegt sind, waere zu wenig. Ein Plan
   * nennt seine Boerse selbst, und ein Handelssignal von aussen bringt
   * das Feld `exchange` mit — liegt zu dieser Boerse ein Schluessel vor,
   * ginge die Order echt heraus.
   *
   * Voreingestellt aus. Wer ihn einschaltet, tut es bewusst und sieht
   * es beim Start im Protokoll.
   */
  nurUebungsbetrieb: boolean;

  /** Startkapital des Uebungskontos. */
  uebungsKapital: number;
  /** Waehrung, in der das Uebungskapital gefuehrt wird. */
  uebungsWaehrung: string;

  /** Eingang fuer externe Handelssignale (TradingView u. ae.). */
  signale: SignalConfig;
}

/**
 * Einstellungen des Signal-Eingangs.
 *
 * Die Vorgaben sind durchweg die vorsichtigen: kein Geheimnis (also kein
 * Eingang), kein sofortiges Handeln, kein geratener Kontostand. Wer
 * Signale handeln will, muss das ausdruecklich einrichten.
 */
export interface SignalConfig {
  /** Gemeinsames Geheimnis. Leer = der Webhook nimmt nichts an. */
  webhookSecret: string;
  /** HMAC-Signatur verlangen statt blossem Geheimnis. */
  requireSignature: boolean;
  /** Kapital, auf das sich Signale ohne eigene Angabe beziehen. */
  referenceCapital: number;
  /** Hoechstalter eines Signals in Sekunden. */
  maxAgeSeconds: number;
  /** Duerfen Plaene aus Signalen sofort handeln? Voreingestellt nein. */
  autoStart: boolean;
  /** Wie lange eine Freigabe (Weg A) gueltig bleibt, in Sekunden. */
  triggerTtlSeconds: number;

  // --- Risikoprofil ---
  /** Anteil des Kontostands, der fuer Signal-Handel bereitsteht. */
  capitalFraction: number;
  /** Verstaerkung oder Daempfung gegenueber dem Signalgeber. */
  multiplier: number;
  /** Hoechstverlust je Trade als Anteil des Kontostands. */
  maxRiskPerTradePct: number;
  /** Hoechste Margin je Trade als Anteil des Kontostands. */
  maxMarginPerTradePct: number;
  /** Anteil der freien Margin, der gebunden werden darf. */
  usableFreeMarginPct: number;
  /** Verhalten bei Teil-Orders unter der Mindestgroesse. */
  belowMinimum: 'drop' | 'reject';
  /** Mindestanteil der geplanten Groesse, der uebrig bleiben muss. */
  minRemainingFraction: number;

  // --- Kapitalermittlung ---
  /** Ersatzwert, wenn die Boerse keinen Kontostand nennt. */
  fallbackEquity: number;
  /** Darf der Ersatzwert einspringen? Voreingestellt nein. */
  allowFallback: boolean;
}

function envZahl(name: string, vorgabe: number): number {
  const roh = process.env[name];
  if (roh === undefined || roh.trim() === '') return vorgabe;
  const zahl = Number(roh);
  return Number.isFinite(zahl) ? zahl : vorgabe;
}

function envSchalter(name: string, vorgabe: boolean): boolean {
  const roh = process.env[name];
  if (roh === undefined || roh.trim() === '') return vorgabe;
  return roh.toLowerCase() === 'true';
}

function loadSignalConfig(): SignalConfig {
  const belowMinimum = process.env['SIGNAL_BELOW_MINIMUM'];
  return {
    webhookSecret: process.env['SIGNAL_WEBHOOK_SECRET'] ?? '',
    requireSignature: envSchalter('SIGNAL_REQUIRE_SIGNATURE', false),
    referenceCapital: envZahl('SIGNAL_REFERENCE_CAPITAL', 10_000),
    maxAgeSeconds: envZahl('SIGNAL_MAX_AGE_SECONDS', 300),
    autoStart: envSchalter('SIGNAL_AUTO_START', false),
    triggerTtlSeconds: envZahl('SIGNAL_TRIGGER_TTL_SECONDS', 300),

    capitalFraction: envZahl('SIGNAL_CAPITAL_FRACTION', 1),
    multiplier: envZahl('SIGNAL_MULTIPLIER', 1),
    maxRiskPerTradePct: envZahl('SIGNAL_MAX_RISK_PER_TRADE_PCT', 0.02),
    maxMarginPerTradePct: envZahl('SIGNAL_MAX_MARGIN_PER_TRADE_PCT', 0.2),
    usableFreeMarginPct: envZahl('SIGNAL_USABLE_FREE_MARGIN_PCT', 0.9),
    belowMinimum: belowMinimum === 'reject' ? 'reject' : 'drop',
    minRemainingFraction: envZahl('SIGNAL_MIN_REMAINING_FRACTION', 0.5),

    fallbackEquity: envZahl('SIGNAL_FALLBACK_EQUITY', 0),
    allowFallback: envSchalter('SIGNAL_ALLOW_FALLBACK', false),
  };
}

function requiredEnv(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Liest die Zugangsdaten aller Boersen aus der Umgebung.
 *
 * Namensschema je Boerse aus dem Verzeichnis, in Grossbuchstaben:
 *   KRAKEN_API_KEY / KRAKEN_API_SECRET / KRAKEN_PASSWORD / KRAKEN_TESTNET
 *   OKX_API_KEY    / OKX_API_SECRET    / OKX_PASSWORD    / OKX_MARKET_TYPE
 *
 * Boersen ohne hinterlegten Schluessel tauchen gar nicht erst auf — so
 * unterscheidet sich "nicht eingerichtet" von "falsch eingerichtet".
 */
function loadExchangeCredentials(): Record<string, ExchangeCredentials> {
  const result: Record<string, ExchangeCredentials> = {};

  for (const definition of listExchanges()) {
    const prefix = definition.id.toUpperCase();
    const apiKey = process.env[`${prefix}_API_KEY`];
    const apiSecret = process.env[`${prefix}_API_SECRET`];
    if (!apiKey || !apiSecret) continue;

    const marketType = process.env[`${prefix}_MARKET_TYPE`];
    result[definition.id] = {
      apiKey,
      apiSecret,
      password: process.env[`${prefix}_PASSWORD`] || undefined,
      testnet: process.env[`${prefix}_TESTNET`] === 'true',
      marketType: marketType === 'spot' || marketType === 'futures' ? marketType : undefined,
    };
  }

  return result;
}

export function loadConfig(): BotConfig {
  const exchanges = loadExchangeCredentials();

  // BROKER_TYPE ist die alte Bezeichnung aus der Zeit, als es nur Phemex
  // und den Uebungsbetrieb gab. Sie wird weiter gelesen, damit bestehende
  // Installationen nach dem Update nicht stillschweigend auf Uebung
  // umschalten.
  const legacyBrokerType = process.env['BROKER_TYPE'];
  const defaultExchange = process.env['DEFAULT_EXCHANGE']
    ?? (legacyBrokerType && legacyBrokerType !== 'paper' ? legacyBrokerType : 'paper');

  return {
    tcApiUrl: requiredEnv('TC_API_URL', 'http://localhost:8080'),
    tcApiKey: requiredEnv('TC_API_KEY', ''),
    defaultExchange,
    exchanges,
    tcRueckkanalUrl: (process.env['TC_RUECKKANAL_URL'] ?? '').trim(),
    tcRueckkanalToken: (process.env['TC_RUECKKANAL_TOKEN'] ?? '').trim(),
    webUiPassword: requiredEnv('WEB_UI_PASSWORD', 'admin'),
    webPort: parseInt(process.env['WEB_PORT'] ?? '3300', 10),
    planPollInterval: parseInt(process.env['PLAN_POLL_INTERVAL'] ?? '30000', 10),
    pricePollInterval: parseInt(process.env['PRICE_POLL_INTERVAL'] ?? '2000', 10),
    orderCheckInterval: parseInt(process.env['ORDER_CHECK_INTERVAL'] ?? '3000', 10),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    dataDir: process.env['DATA_DIR'] ?? './data',
    telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
    telegramChatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
    telegramEnabled: process.env['TELEGRAM_ENABLED'] === 'true',
    nurMicaBoersen: process.env['NUR_MICA_BOERSEN'] !== 'false',
    nurUebungsbetrieb: envSchalter('NUR_UEBUNGSBETRIEB', false),
    uebungsKapital: envZahl('UEBUNGS_KAPITAL', 10_000),
    uebungsWaehrung: (process.env['UEBUNGS_WAEHRUNG'] ?? 'USDT').toUpperCase(),
    signale: loadSignalConfig(),
  };
}
