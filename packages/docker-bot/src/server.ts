import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './services/log-service.js';
import { SqliteStore } from './store/sqlite-store.js';
import { BotService } from './services/bot-service.js';
import { SettingsService } from './services/settings-service.js';
import { createAuthMiddleware } from './web/middleware/auth.js';
import { createDashboardRouter } from './web/routes/dashboard.js';
import { createPlansRouter } from './web/routes/plans.js';
import { createTradesRouter } from './web/routes/trades.js';
import { createSettingsRouter } from './web/routes/settings.js';
import { createLogsRouter } from './web/routes/logs.js';
import { createLocalPlansRouter } from './web/routes/local-plans.js';
import { setupWebSocket } from './web/websocket.js';
import { TelegramService } from './services/telegram-service.js';
import { copytradingRoutes } from './web/routes/copytrading.js';
import { CopyTradingService } from './services/copytrading-service.js';
import { TradePlanMonitor } from './services/trade-plan-monitor.js';
import { TcPlanSyncService } from './services/tc-plan-sync-service.js';
import { createTradePlansRouter } from './web/routes/trade-plans.js';
import { BrokerRegistry } from './services/broker-factory.js';
import { TcApiClient } from '@tradingcontrol/core';
import { CapitalService } from './services/capital-service.js';
import { PaperAccountService } from './services/paper-account-service.js';
import { SignalService } from './services/signal-service.js';
import { createSignalWebhookRouter } from './web/routes/signal-webhook.js';
import { createSignalsRouter } from './web/routes/signals.js';
import { createUebungskontoRouter } from './web/routes/uebungskonto.js';
import { KerzenService } from './services/kerzen-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const envConfig = loadConfig();
  const logger = createLogger(envConfig.logLevel);

  logger.info('TradingControl Bot starting...');

  // SQLite Store
  const store = new SqliteStore(join(envConfig.dataDir, 'bot.db'));

  // Settings Service — verwaltet Config-Hierarchie + KeyStore
  const settingsService = new SettingsService(store, envConfig.dataDir, logger);
  await settingsService.initialize(envConfig.webUiPassword);

  // Effektive Config (env + gespeicherte Overrides + KeyStore Secrets)
  const effectiveConfig = await settingsService.getEffectiveConfig();

  // Bot Service
  const botService = new BotService(effectiveConfig, store, logger);

  // Telegram Notifications
  const telegramService = new TelegramService(settingsService, logger);
  botService.onEvent(telegramService.createEventListener());

  // CopyTrading Service
  const ctService = new CopyTradingService(store, logger);
  ctService.startAutoScan(24);

  // CopyTrading Monitoring starten wenn aktiviert
  const ctEnabled = store.getBotState('setting:ctEnabled') === 'true';
  const claudeApiKey = await (async () => {
    try {
      const keys = await settingsService.getEffectiveConfig();
      return (keys as unknown as Record<string, unknown>).claudeApiKey as string | undefined;
    } catch { return undefined; }
  })();
  if (ctEnabled && claudeApiKey) {
    const ctModel = store.getBotState('setting:ctClaudeModel') || 'claude-sonnet-4-20250514';
    const ctPortfolio = parseFloat(store.getBotState('setting:ctPortfolioSize') || '1000');
    const ctMinCombined = parseInt(store.getBotState('setting:ctMinCombinedScore') || '40');
    const ctMinConviction = parseInt(store.getBotState('setting:ctMinConvictionScore') || '25');

    try {
      await ctService.startMonitoring({
        claudeApiKey,
        claudeModel: ctModel,
        portfolioSize: ctPortfolio,
        minCombinedScore: ctMinCombined,
        minConvictionScore: ctMinConviction,
      });
    } catch (err) {
      logger.error({ err }, 'CopyTrading: Monitoring Auto-Start fehlgeschlagen');
    }
  } else if (ctEnabled && !claudeApiKey) {
    logger.warn('CopyTrading aktiviert, aber kein Claude API-Key konfiguriert');
  }

  // ============================================================
  // TradePlan Monitor + TC-Sync
  // ============================================================
  // Die Broker-Werkstatt baut je Boerse einen Zugang auf, sobald der
  // erste Plan ihn braucht. Ein Plan traegt seine Boerse mit sich —
  // gehandelt wird dort, nicht auf einer global eingestellten.
  // Das Uebungskonto wird fortgefuehrt — Startkapital, realisierte
  // Ergebnisse und Gebuehren ueberleben den Neustart. Auf genau diesen
  // Stand rechnet der Bot die Groesse jedes Signals um.
  const uebungskonto = new PaperAccountService(
    store, logger, effectiveConfig.uebungsKapital, effectiveConfig.uebungsWaehrung,
  );

  const brokers = new BrokerRegistry(effectiveConfig, uebungskonto.getKonto());

  // Kerzen fuer die Chart-Ansicht — oeffentliche Marktdaten, ohne Zugangsdaten.
  const kerzenDienst = new KerzenService(logger);

  const planMonitor = new TradePlanMonitor(brokers, store, logger, {
    nurMicaBoersen: effectiveConfig.nurMicaBoersen,
    defaultExchange: effectiveConfig.defaultExchange,
    nurUebungsbetrieb: effectiveConfig.nurUebungsbetrieb,
  });
  planMonitor.start();

  const eingerichteteBoersen = Object.keys(effectiveConfig.exchanges);

  if (effectiveConfig.nurUebungsbetrieb) {
    // Auffaellig, und zwar auch dann — gerade dann —, wenn Zugangsdaten
    // hinterlegt sind: Der Nutzer soll beim Blick ins Protokoll ohne
    // Nachdenken erkennen, dass nichts an eine Boerse geht.
    logger.warn({
      uebungskapital: `${effectiveConfig.uebungsKapital} ${effectiveConfig.uebungsWaehrung}`,
      hinterlegteBoersen: eingerichteteBoersen,
    }, '*** NUR UEBUNGSBETRIEB *** Kein Auftrag verlaesst den Bot. ' +
       'Jede Boerse wird auf den Uebungsbroker umgeleitet, auch solche mit hinterlegten Zugangsdaten.');
  } else {
    logger.info({
      boersen: eingerichteteBoersen,
      voreinstellung: effectiveConfig.defaultExchange,
      nurMica: effectiveConfig.nurMicaBoersen,
    }, eingerichteteBoersen.length > 0
      ? 'ECHTHANDEL — Boersen-Zugaenge eingerichtet'
      : 'Keine Boersen-Zugangsdaten hinterlegt — es wird im Uebungsbetrieb gehandelt');
  }

  // TC-Plan-Sync nur wenn API-Key konfiguriert. Ohne Journal laeuft der
  // Bot mit seinen eigenen Plaenen unveraendert weiter.
  let tcPlanSync: TcPlanSyncService | null = null;
  if (effectiveConfig.tcApiKey) {
    const tcClient = new TcApiClient({
      baseUrl: effectiveConfig.tcApiUrl,
      apiKey: effectiveConfig.tcApiKey,
    });
    tcPlanSync = new TcPlanSyncService(tcClient, store, planMonitor, logger);
    tcPlanSync.start();
  } else {
    logger.warn('TC_API_KEY nicht gesetzt — kein Abgleich mit dem Journal, nur eigene Plaene');
    // Der Dienst bleibt bestehen, damit die Routen fuer den Abgleich von
    // Hand antworten koennen — sie melden dann den fehlenden Schluessel.
    tcPlanSync = new TcPlanSyncService(
      new TcApiClient({ baseUrl: effectiveConfig.tcApiUrl, apiKey: 'dummy' }),
      store, planMonitor, logger,
    );
  }

  // ============================================================
  // Eingang fuer externe Handelssignale
  // ============================================================
  // Entsteht immer, nimmt aber nur etwas an, wenn ein Geheimnis
  // hinterlegt ist. So lassen sich die Einstellungen ueber die
  // Weboberflaeche vornehmen, ohne den Bot neu zu starten.
  const kapitalDienst = new CapitalService(brokers, logger, {
    fallbackEquity: Number(store.getBotState('setting:signalFallbackEquity') ?? effectiveConfig.signale.fallbackEquity),
    allowFallback: (store.getBotState('setting:signalAllowFallback') ?? String(effectiveConfig.signale.allowFallback)) === 'true',
    cacheTtlMs: 60_000,
  });

  // Gespeicherte Einstellungen gehen vor denen aus der Umgebung: Was der
  // Nutzer in der Oberflaeche gesetzt hat, soll einen Neustart ueberleben.
  const gespeichertesProfil = (() => {
    const roh = store.getBotState('setting:signalRisikoprofil');
    if (!roh) return null;
    try {
      return JSON.parse(roh) as Record<string, number | string>;
    } catch {
      logger.warn('Gespeichertes Risikoprofil ist unlesbar — es gelten die Werte aus der Umgebung');
      return null;
    }
  })();

  const signalDienst = new SignalService(store, planMonitor, kapitalDienst, logger, {
    webhookSecret: store.getBotState('setting:signalWebhookSecret') ?? effectiveConfig.signale.webhookSecret,
    requireSignature: (store.getBotState('setting:signalRequireSignature')
      ?? String(effectiveConfig.signale.requireSignature)) === 'true',
    defaultReferenceCapital: Number(store.getBotState('setting:signalReferenceCapital')
      ?? effectiveConfig.signale.referenceCapital),
    defaultExchange: effectiveConfig.defaultExchange,
    maxAgeSeconds: Number(store.getBotState('setting:signalMaxAge') ?? effectiveConfig.signale.maxAgeSeconds),
    autoStart: (store.getBotState('setting:signalAutoStart')
      ?? String(effectiveConfig.signale.autoStart)) === 'true',
    triggerGueltigkeitMs: Number(store.getBotState('setting:signalTriggerTtl')
      ?? effectiveConfig.signale.triggerTtlSeconds) * 1000,
    risikoprofil: {
      capitalFraction: effectiveConfig.signale.capitalFraction,
      multiplier: effectiveConfig.signale.multiplier,
      maxRiskPerTradePct: effectiveConfig.signale.maxRiskPerTradePct,
      maxMarginPerTradePct: effectiveConfig.signale.maxMarginPerTradePct,
      usableFreeMarginPct: effectiveConfig.signale.usableFreeMarginPct,
      belowMinimum: effectiveConfig.signale.belowMinimum,
      minRemainingFraction: effectiveConfig.signale.minRemainingFraction,
      ...(gespeichertesProfil ?? {}),
    },
  });

  if (signalDienst.istEingerichtet()) {
    logger.info({
      sofortHandeln: signalDienst.getConfig().autoStart,
      referenzkapital: signalDienst.getConfig().defaultReferenceCapital,
      signaturVerlangt: signalDienst.getConfig().requireSignature,
    }, 'Signal-Eingang bereit unter POST /webhook/signal/<geheimnis>');
  } else {
    logger.info(
      'Signal-Eingang nicht eingerichtet — kein Geheimnis hinterlegt. ' +
      'Ueber SIGNAL_WEBHOOK_SECRET oder die Weboberflaeche setzen.',
    );
  }

  // Express App
  const app = express();

  // Der Signal-Webhook steht VOR express.json() — mit Absicht.
  //
  // Eine HMAC-Signatur gilt fuer genau die Zeichen, die der Absender
  // signiert hat. Haette express.json() den Rumpf schon gelesen und in
  // ein Objekt verwandelt, waere der Datenstrom verbraucht und nur noch
  // eine neu zusammengesetzte Fassung verfuegbar — mit womoeglich anderer
  // Feldreihenfolge und damit anderer Pruefsumme.
  //
  // Die Route traegt kein /api-Praefix und laeuft deshalb auch nicht
  // durch die Passwortabfrage weiter unten. Ihre Absicherung besteht aus
  // dem Geheimnis im Pfad, der Signatur und der Drossel je Adresse.
  app.use(createSignalWebhookRouter(signalDienst, logger));

  app.use(express.json({ limit: '100kb' }));

  // Security Headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:");
    next();
  });

  // Debug: Auth-Test ohne Rate-Limit
  app.get('/api/auth-test', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) { res.json({ error: 'no auth header' }); return; }
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    const pass = colonIdx >= 0 ? decoded.substring(colonIdx + 1) : decoded;
    const valid = await settingsService.validatePassword(pass);
    res.json({ decoded_user: decoded.substring(0, colonIdx), pass_length: pass.length, valid });
  });

  // Auth — async Passwort-Validierung via SettingsService
  app.use('/api', createAuthMiddleware((password) => settingsService.validatePassword(password)));

  // Statische Dateien
  const publicDir = join(__dirname, 'ui', 'public');
  app.use(express.static(publicDir, { maxAge: 0, etag: false }));

  // API Routen
  app.use(createDashboardRouter(botService, store, settingsService, planMonitor));
  app.use(createPlansRouter(botService, store, planMonitor));
  app.use(createTradesRouter(store));
  app.use(createSettingsRouter(settingsService, botService, logger, telegramService));
  app.use(createLogsRouter());
  app.use(createLocalPlansRouter(store, botService));
  app.use(copytradingRoutes(store, ctService, settingsService));
  app.use(createTradePlansRouter(store, planMonitor, tcPlanSync, kerzenDienst));
  app.use(createSignalsRouter(signalDienst, kapitalDienst, store, settingsService, logger));
  app.use(createUebungskontoRouter(
    uebungskonto, kapitalDienst, logger, effectiveConfig.nurUebungsbetrieb,
  ));

  // SPA Fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(publicDir, 'index.html'));
    }
  });

  // HTTP Server + WebSocket (mit Auth)
  const server = createServer(app);
  setupWebSocket(server, botService, settingsService, logger);

  server.listen(effectiveConfig.webPort, () => {
    logger.info({ port: effectiveConfig.webPort }, `Web UI available at http://localhost:${effectiveConfig.webPort}`);
  });

  // Letzten Zustand wiederherstellen. Beim allerersten Start laeuft der Bot
  // an — er braucht das Journal nicht, um die eigenen Plaene zu ueberwachen.
  // Frueher hing der Start am Journal-Schluessel; ohne ihn tat der Bot nichts.
  const lastState = store.getBotState('bot:running');
  const shouldStart = lastState !== 'false';
  if (shouldStart) {
    try {
      await botService.start();
      store.setBotState('bot:running', 'true');
    } catch (err) {
      logger.error({ err }, 'Selbsttaetiger Start fehlgeschlagen — ueber die Weboberflaeche starten');
    }
  }

  // Graceful Shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    tcPlanSync?.stop();
    planMonitor.stop();
    ctService.stopAutoScan();
    await botService.stop();
    await brokers.disconnectAll();
    store.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
