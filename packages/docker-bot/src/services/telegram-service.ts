import { SettingsService } from './settings-service.js';
import { Logger } from './log-service.js';

const TELEGRAM_EVENTS = [
  'order:placed',
  'order:filled',
  'plan:activated',
  'plan:completed',
  'plan:error',
  'engine:error',
] as const;

type TelegramEvent = (typeof TELEGRAM_EVENTS)[number];

interface ActiveAlert {
  message: string;
  sentAt: number;
}

const ERROR_EVENTS = new Set<string>(['plan:error', 'engine:error']);
const RESOLVE_EVENTS = new Set<string>(['plan:activated', 'plan:completed', 'order:placed', 'order:filled']);

export class TelegramService {
  // Key = event type (+ planId for plan-scoped errors), Value = last sent alert
  private activeAlerts = new Map<string, ActiveAlert>();

  constructor(
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
  ) {}

  /** Listener fuer botService.onEvent() — fire-and-forget */
  createEventListener(): (event: string, data: unknown) => void {
    return (event: string, data: unknown) => {
      if (!this.isTelegramEvent(event)) return;
      this.handleEvent(event, data).catch((err) => {
        this.logger.warn({ err, event }, 'Telegram notification failed (suppressed)');
      });
    };
  }

  /** Testnachricht senden */
  async sendTestMessage(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.settingsService.getEffectiveConfig();

      if (!config.telegramBotToken || !config.telegramChatId) {
        return { success: false, error: 'Bot-Token und Chat-ID muessen konfiguriert sein' };
      }

      const text = [
        '\u2705 <b>TradingControl Bot</b>',
        '',
        'Testnachricht erfolgreich!',
        'Telegram-Benachrichtigungen sind aktiv.',
      ].join('\n');

      await this.sendMessage(config.telegramBotToken, config.telegramChatId, text);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err }, 'Telegram test message failed');
      return { success: false, error: msg };
    }
  }

  private async handleEvent(event: TelegramEvent, data: unknown): Promise<void> {
    const config = await this.settingsService.getEffectiveConfig();

    if (!config.telegramEnabled || !config.telegramBotToken || !config.telegramChatId) return;

    // Per-Event Toggle pruefen
    const toggleKey = 'telegramNotify_' + event.replace(':', '_');
    const toggleValue = (config as unknown as Record<string, unknown>)[toggleKey];
    if (toggleValue === false) return;

    const d = data as Record<string, unknown>;

    // Erfolgs-Events loesen aktive Alerts auf
    if (RESOLVE_EVENTS.has(event)) {
      await this.resolveAlerts(event, d, config.telegramBotToken, config.telegramChatId);
    }

    // Fehler-Events deduplizieren
    if (ERROR_EVENTS.has(event)) {
      const alertKey = this.getAlertKey(event, d);
      const errorMsg = String(d.error ?? d.message ?? 'Unbekannt');
      const existing = this.activeAlerts.get(alertKey);

      if (existing && existing.message === errorMsg) {
        // Gleicher Fehler bereits gesendet — nicht erneut senden
        this.logger.debug({ event, alertKey }, 'Telegram notification suppressed (duplicate)');
        return;
      }

      // Neuer oder anderer Fehler — senden und merken
      this.activeAlerts.set(alertKey, { message: errorMsg, sentAt: Date.now() });
    }

    const text = this.formatMessage(event, data);
    if (!text) return;

    try {
      await this.sendMessage(config.telegramBotToken, config.telegramChatId, text);
      this.logger.debug({ event }, 'Telegram notification sent');
    } catch (err) {
      this.logger.warn({ err, event }, 'Failed to send Telegram notification');
    }
  }

  private async resolveAlerts(_event: string, data: Record<string, unknown>, token: string, chatId: string): Promise<void> {
    // engine:error wird durch jedes Erfolgs-Event aufgeloest
    const engineAlert = this.activeAlerts.get('engine:error');
    if (engineAlert) {
      this.activeAlerts.delete('engine:error');
      const text = `\u2705 <b>Engine-Fehler behoben</b>\nUrsprung: ${engineAlert.message}`;
      await this.sendMessage(token, chatId, text).catch(() => {});
      this.logger.info('Telegram: engine:error resolved');
    }

    // plan:error wird durch plan-spezifische Erfolgs-Events aufgeloest
    const planId = data.planId as string | undefined;
    if (planId) {
      const planAlertKey = `plan:error:${planId}`;
      const planAlert = this.activeAlerts.get(planAlertKey);
      if (planAlert) {
        this.activeAlerts.delete(planAlertKey);
        const text = `\u2705 <b>Plan-Fehler behoben</b>\nPlan: <code>${planId.slice(0, 8)}</code>`;
        await this.sendMessage(token, chatId, text).catch(() => {});
        this.logger.info({ planId }, 'Telegram: plan:error resolved');
      }
    }
  }

  private getAlertKey(event: string, data: Record<string, unknown>): string {
    if (event === 'plan:error' && data.planId) {
      return `plan:error:${data.planId}`;
    }
    return event;
  }

  private formatMessage(event: TelegramEvent, data: unknown): string | null {
    const d = data as Record<string, unknown>;

    switch (event) {
      case 'order:placed': {
        const typeLabel = this.orderTypeLabel(String(d.type ?? ''));
        const price = Number(d.price ?? 0).toFixed(2);
        return [
          `\ud83d\udccb <b>Order platziert</b>`,
          `${typeLabel} #${d.index}`,
          `Preis: ${price}`,
          `Menge: ${d.quantity}`,
          `Plan: <code>${String(d.planId ?? '').slice(0, 8)}</code>`,
        ].join('\n');
      }
      case 'order:filled': {
        const typeLabel = this.orderTypeLabel(String(d.type ?? ''));
        const avgPrice = Number(d.avgFillPrice ?? 0).toFixed(2);
        return [
          `\u2705 <b>Order gefuellt</b>`,
          `${typeLabel} #${d.index}`,
          `Avg. Preis: ${avgPrice}`,
          `Menge: ${d.filledQuantity}`,
          `Plan: <code>${String(d.planId ?? '').slice(0, 8)}</code>`,
        ].join('\n');
      }
      case 'plan:activated':
        return `\ud83d\ude80 <b>Plan aktiviert</b>\nPlan: <code>${String(d.planId ?? '').slice(0, 8)}</code>`;
      case 'plan:completed':
        return `\ud83c\udfc1 <b>Plan abgeschlossen</b>\nPlan: <code>${String(d.planId ?? '').slice(0, 8)}</code>`;
      case 'plan:error':
        return `\u26a0\ufe0f <b>Plan-Fehler</b>\nPlan: <code>${String(d.planId ?? '').slice(0, 8)}</code>\nFehler: ${d.error ?? 'Unbekannt'}`;
      case 'engine:error':
        return `\ud83d\udd34 <b>Engine-Fehler</b>\n${d.error ?? 'Unbekannt'}`;
      default:
        return null;
    }
  }

  private orderTypeLabel(type: string): string {
    switch (type) {
      case 'entry': return 'Entry';
      case 'take_profit': return 'Take-Profit';
      case 'stop_loss': return 'Stop-Loss';
      default: return type;
    }
  }

  private isTelegramEvent(event: string): event is TelegramEvent {
    return (TELEGRAM_EVENTS as readonly string[]).includes(event);
  }

  private async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram API ${res.status}: ${body}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
