import { Router } from 'express';
import { TcApiClient, getExchange } from '@tradingcontrol/core';
import { SettingsService } from '../../services/settings-service.js';
import { BotService } from '../../services/bot-service.js';
import { TelegramService } from '../../services/telegram-service.js';
import { Logger } from '../../services/log-service.js';

export function createSettingsRouter(
  settingsService: SettingsService,
  botService: BotService,
  logger: Logger,
  telegramService: TelegramService,
): Router {
  const router = Router();

  // GET — Sanitized Settings für UI
  router.get('/api/settings', async (_req, res) => {
    try {
      const settings = await settingsService.getSettingsForUI();
      res.json(settings);
    } catch (err) {
      logger.error({ err }, 'Failed to get settings');
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  // PUT — Settings speichern + Bot neu starten
  router.put('/api/settings', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Ungueltiger Request Body' });
        return;
      }

      // Nur erlaubte Keys durchlassen
      const ALLOWED_KEYS = new Set([
        'tcApiUrl', 'tcApiKey', 'defaultExchange', 'nurMicaBoersen',
        'planPollInterval', 'pricePollInterval', 'orderCheckInterval', 'logLevel',
        'telegramBotToken', 'telegramChatId', 'telegramEnabled',
        'telegramNotify_order_placed', 'telegramNotify_order_filled',
        'telegramNotify_plan_activated', 'telegramNotify_plan_completed',
        'telegramNotify_plan_error', 'telegramNotify_engine_error',
        'riskMaxDailyLossPct', 'riskMaxWeeklyLossPct', 'riskMaxDrawdownPct',
        'riskSlCooldownMin', 'riskMaxConcurrentPlans',
        'claudeApiKey', 'ctEnabled', 'ctClaudeModel', 'ctPortfolioSize',
        'ctMinCombinedScore', 'ctMinConvictionScore',
      ]);

      /**
       * Zugangsdaten der Boersen heissen `exchange.<id>.<feld>`. Sie
       * einzeln aufzulisten ginge nicht — welche Boersen eingerichtet
       * werden, entscheidet der Nutzer. Geprueft wird deshalb die Form:
       * bekannte Boerse, bekanntes Feld.
       */
      const ERLAUBTE_BOERSEN_FELDER = ['apiKey', 'apiSecret', 'password', 'testnet', 'marketType'];
      const istBoersenSchluessel = (key: string): boolean => {
        const teile = key.split('.');
        return teile.length === 3
          && teile[0] === 'exchange'
          && getExchange(teile[1]!) !== undefined
          && ERLAUBTE_BOERSEN_FELDER.includes(teile[2]!);
      };

      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (ALLOWED_KEYS.has(key) || istBoersenSchluessel(key)) updates[key] = value;
      }

      // Validierung
      if (updates.defaultExchange !== undefined) {
        const gewaehlt = String(updates.defaultExchange);
        if (gewaehlt !== 'paper' && !getExchange(gewaehlt)) {
          res.status(400).json({ error: `Boerse "${gewaehlt}" ist dem Bot nicht bekannt` });
          return;
        }
      }
      for (const [key, value] of Object.entries(updates)) {
        if (!key.endsWith('.marketType')) continue;
        if (!['spot', 'futures'].includes(String(value))) {
          res.status(400).json({ error: 'Marktart muss spot oder futures sein' });
          return;
        }
      }
      if (updates.logLevel !== undefined && !['trace', 'debug', 'info', 'warn', 'error'].includes(String(updates.logLevel))) {
        res.status(400).json({ error: 'Ungueltiges Log-Level' });
        return;
      }
      if (updates.tcApiUrl !== undefined) {
        const urlStr = String(updates.tcApiUrl);
        try {
          const parsed = new URL(urlStr);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            res.status(400).json({ error: 'TC API URL muss http(s) sein' });
            return;
          }
        } catch {
          res.status(400).json({ error: 'Ungueltige TC API URL' });
          return;
        }
      }
      if (updates.planPollInterval !== undefined && (typeof updates.planPollInterval !== 'number' || updates.planPollInterval < 5000)) {
        res.status(400).json({ error: 'Plan-Polling muss >= 5000ms sein' });
        return;
      }
      if (updates.pricePollInterval !== undefined && (typeof updates.pricePollInterval !== 'number' || updates.pricePollInterval < 500)) {
        res.status(400).json({ error: 'Preis-Polling muss >= 500ms sein' });
        return;
      }
      if (updates.orderCheckInterval !== undefined && (typeof updates.orderCheckInterval !== 'number' || updates.orderCheckInterval < 1000)) {
        res.status(400).json({ error: 'Order-Check muss >= 1000ms sein' });
        return;
      }
      if (updates.telegramChatId !== undefined) {
        const chatIdStr = String(updates.telegramChatId).trim();
        if (chatIdStr && !/^-?\d+$/.test(chatIdStr)) {
          res.status(400).json({ error: 'Ungueltige Telegram Chat-ID (muss numerisch sein)' });
          return;
        }
      }

      await settingsService.saveSettings(updates as Partial<import('../../config.js').BotConfig>);

      // Neue effektive Config laden und Bot restarten
      const newConfig = await settingsService.getEffectiveConfig();
      try {
        await botService.restart(newConfig);
        res.json({ success: true, message: 'Einstellungen gespeichert. Bot neu gestartet.' });
      } catch (restartErr) {
        const msg = restartErr instanceof Error ? restartErr.message : String(restartErr);
        logger.warn({ err: restartErr }, 'Settings saved but bot restart failed');
        res.json({ success: true, message: 'Einstellungen gespeichert. Bot-Neustart fehlgeschlagen: ' + msg });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to save settings');
      res.status(500).json({ error: 'Speichern fehlgeschlagen' });
    }
  });

  // POST — TC API Verbindung testen
  router.post('/api/settings/test-connection', async (_req, res) => {
    try {
      const config = await settingsService.getEffectiveConfig();

      if (!config.tcApiUrl || !config.tcApiKey) {
        res.json({ success: false, error: 'TC API URL und Key muessen konfiguriert sein' });
        return;
      }

      const client = new TcApiClient({
        baseUrl: config.tcApiUrl,
        apiKey: config.tcApiKey,
        timeout: 10_000,
        maxRetries: 0,
      });

      const result = await client.heartbeat();
      res.json({
        success: true,
        message: `Verbunden. Status: ${result.status}`,
      });
    } catch (err) {
      res.json({
        success: false,
        error: err instanceof Error ? err.message : 'Verbindung fehlgeschlagen',
      });
    }
  });

  // POST — Telegram Testnachricht senden
  router.post('/api/settings/test-telegram', async (_req, res) => {
    try {
      const result = await telegramService.sendTestMessage();
      res.json(result);
    } catch (err) {
      res.json({
        success: false,
        error: err instanceof Error ? err.message : 'Telegram-Test fehlgeschlagen',
      });
    }
  });

  // POST — Passwort ändern
  router.post('/api/settings/change-password', async (req, res) => {
    try {
      const { oldPassword, newPassword } = req.body;

      if (!oldPassword || !newPassword) {
        res.status(400).json({ error: 'Altes und neues Passwort erforderlich' });
        return;
      }

      await settingsService.changePassword(oldPassword, newPassword);

      res.json({ success: true, message: 'Passwort geaendert. Bitte neu anmelden.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Passwort-Aenderung fehlgeschlagen' });
    }
  });

  return router;
}
