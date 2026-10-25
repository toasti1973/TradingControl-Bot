import { join } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions, type BinaryLike } from 'node:crypto';
import { KeyStore, listExchanges } from '@tradingcontrol/core';
import { BotConfig, loadConfig } from '../config.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { Logger } from './log-service.js';

function scryptAsync(password: BinaryLike, salt: BinaryLike, keylen: number, options?: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, derivedKey: Buffer) => {
      if (err) reject(err);
      else resolve(derivedKey);
    };
    if (options) scrypt(password, salt, keylen, options, cb);
    else scrypt(password, salt, keylen, cb);
  });
}

const SENSITIVE_KEYS = ['tcApiKey', 'telegramBotToken', 'claudeApiKey'] as const;
type SensitiveKey = (typeof SENSITIVE_KEYS)[number];

/**
 * Zugangsdaten einer Boerse liegen im KeyStore unter
 * `exchange.<id>.apiKey`, `.apiSecret` und `.password`. Ein fester
 * Schluesselsatz je Boerse ginge nicht: Welche Boersen der Nutzer
 * einrichtet, steht erst zur Laufzeit fest.
 */
const EXCHANGE_SECRET_PREFIX = 'exchange.';
const EXCHANGE_SECRET_FIELDS = ['apiKey', 'apiSecret', 'password'] as const;

function isExchangeSecretKey(key: string): boolean {
  if (!key.startsWith(EXCHANGE_SECRET_PREFIX)) return false;
  const teile = key.split('.');
  return teile.length === 3
    && teile[1]!.length > 0
    && (EXCHANGE_SECRET_FIELDS as readonly string[]).includes(teile[2]!);
}

/**
 * Boersen, die neben Schluessel und Geheimnis eine Passphrase verlangen.
 * Ohne sie weist die Schnittstelle jede Anfrage ab — die Oberflaeche soll
 * das Feld deshalb von vornherein anbieten.
 */
const BOERSEN_MIT_PASSWORT = ['okx', 'kucoin', 'cryptocom', 'bitpanda'];

/** Nicht geheime Boersen-Einstellungen: `exchange.<id>.testnet|marketType`. */
function isExchangeSettingKey(key: string): boolean {
  if (!key.startsWith(EXCHANGE_SECRET_PREFIX)) return false;
  const teile = key.split('.');
  return teile.length === 3
    && teile[1]!.length > 0
    && (teile[2] === 'testnet' || teile[2] === 'marketType');
}

const SETTING_KEYS = [
  'tcApiUrl', 'defaultExchange', 'nurMicaBoersen',
  'planPollInterval', 'pricePollInterval', 'orderCheckInterval', 'logLevel',
  'telegramChatId', 'telegramEnabled',
  'telegramNotify_order_placed', 'telegramNotify_order_filled',
  'telegramNotify_plan_activated', 'telegramNotify_plan_completed',
  'telegramNotify_plan_error', 'telegramNotify_engine_error',
  'riskMaxDailyLossPct', 'riskMaxWeeklyLossPct', 'riskMaxDrawdownPct',
  'riskSlCooldownMin', 'riskMaxConcurrentPlans',
  'ctEnabled', 'ctClaudeModel', 'ctPortfolioSize',
  'ctMinCombinedScore', 'ctMinConvictionScore',
] as const;

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 32;
const SCRYPT_COST = 2 ** 15; // N=32768
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MB

export class SettingsService {
  private keyStore: KeyStore;
  private envConfig: BotConfig;
  private currentPassword: string;

  constructor(
    private readonly store: SqliteStore,
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.envConfig = loadConfig();
    this.keyStore = new KeyStore(join(dataDir, 'keys.enc'));
    this.currentPassword = this.envConfig.webUiPassword;
  }

  /** Beim Startup aufrufen — KeyStore entsperren oder erstellen */
  async initialize(password: string): Promise<void> {
    this.currentPassword = password;

    const savedHash = this.store.getBotState('setting:passwordHash');
    if (!savedHash) {
      // Erster Start: scrypt-Hash des .env-Passworts speichern
      const hash = await this.hashPassword(password);
      this.store.setBotState('setting:passwordHash', hash);
    }

    try {
      await this.keyStore.unlock(password);
      this.logger.info('KeyStore unlocked');
    } catch {
      // Erster Start oder KeyStore existiert nicht
      await this.keyStore.initialize(password);
      this.logger.info('KeyStore initialized');
    }
  }

  /** Effektive Config: env < SQLite < KeyStore */
  async getEffectiveConfig(): Promise<BotConfig> {
    // Flache Kopie reicht nicht: `exchanges` wird unten ergaenzt und wuerde
    // sonst die aus der Umgebung gelesene Fassung mitveraendern.
    const config: BotConfig = {
      ...this.envConfig,
      exchanges: { ...this.envConfig.exchanges },
    };

    // SQLite Overrides
    for (const key of SETTING_KEYS) {
      const saved = this.store.getBotState(`setting:${key}`);
      if (saved !== undefined) {
        (config as unknown as Record<string, unknown>)[key] = this.coerceValue(key, saved);
      }
    }

    // KeyStore Secrets
    if (this.keyStore.isUnlocked()) {
      try {
        const keys = await this.keyStore.getKeys();
        for (const key of SENSITIVE_KEYS) {
          if (keys[key]) {
            (config as unknown as Record<string, unknown>)[key] = keys[key];
          }
        }
        this.mergeExchangeCredentials(config, keys);
      } catch (err) {
        this.logger.warn({ err }, 'Failed to read KeyStore');
      }
    }

    return config;
  }

  /**
   * Fuegt die im KeyStore hinterlegten Boersen-Zugaenge zur Konfiguration.
   *
   * Erst wenn Schluessel UND Geheimnis vorliegen, gilt eine Boerse als
   * eingerichtet — ein halber Satz wuerde beim ersten Handel scheitern,
   * und zwar erst dann.
   */
  private mergeExchangeCredentials(config: BotConfig, keys: Record<string, string | undefined>): void {
    const gesammelt = new Map<string, { apiKey?: string; apiSecret?: string; password?: string }>();

    for (const [key, value] of Object.entries(keys)) {
      if (!value || !isExchangeSecretKey(key)) continue;
      const [, exchangeId, feld] = key.split('.') as [string, string, string];
      const eintrag = gesammelt.get(exchangeId) ?? {};
      (eintrag as Record<string, string>)[feld] = value;
      gesammelt.set(exchangeId, eintrag);
    }

    for (const [exchangeId, daten] of gesammelt) {
      if (!daten.apiKey || !daten.apiSecret) {
        this.logger.warn({ exchange: exchangeId }, 'Unvollstaendige Zugangsdaten — Boerse wird uebersprungen');
        continue;
      }

      const testnet = this.store.getBotState(`setting:exchange.${exchangeId}.testnet`) === 'true';
      const marktart = this.store.getBotState(`setting:exchange.${exchangeId}.marketType`);

      config.exchanges[exchangeId] = {
        apiKey: daten.apiKey,
        apiSecret: daten.apiSecret,
        password: daten.password,
        testnet,
        marketType: marktart === 'spot' || marktart === 'futures' ? marktart : undefined,
      };
    }
  }

  /** Settings speichern: Sensible → KeyStore, Rest → SQLite */
  async saveSettings(updates: Partial<BotConfig>): Promise<void> {
    const sensitiveUpdates: Record<string, string> = {};

    const keysToDelete: string[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === null) continue;

      // Leerer String = Key loeschen
      if (value === '' || value === '__DELETE__') {
        if (SENSITIVE_KEYS.includes(key as SensitiveKey)) {
          keysToDelete.push(key);
        }
        continue;
      }

      if (SENSITIVE_KEYS.includes(key as SensitiveKey) || isExchangeSecretKey(key)) {
        sensitiveUpdates[key] = String(value);
      } else if ((SETTING_KEYS as readonly string[]).includes(key) || isExchangeSettingKey(key)) {
        this.store.setBotState(`setting:${key}`, String(value));
      }
    }

    // Sensitive Keys loeschen — leer setzen im KeyStore
    if (keysToDelete.length > 0 && this.keyStore.isUnlocked()) {
      const deleteUpdates: Record<string, string> = {};
      for (const key of keysToDelete) {
        deleteUpdates[key] = '';
      }
      await this.keyStore.setKeys(deleteUpdates);
      this.logger.info({ deleted: keysToDelete }, 'Sensitive keys cleared from KeyStore');
    }

    if (Object.keys(sensitiveUpdates).length > 0) {
      await this.keyStore.setKeys(sensitiveUpdates);
      this.logger.info('Sensitive settings saved to KeyStore');
    }

    this.logger.info({ keys: Object.keys(updates) }, 'Settings saved');
  }

  /** Sanitized Settings für die UI (keine echten Secret-Werte) */
  async getSettingsForUI(): Promise<Record<string, unknown>> {
    const config = await this.getEffectiveConfig();
    return {
      tcApiUrl: config.tcApiUrl,
      tcApiKeyConfigured: !!config.tcApiKey,
      defaultExchange: config.defaultExchange,
      nurMicaBoersen: config.nurMicaBoersen,
      // Alle bekannten Boersen mit ihrem Zulassungsvermerk und dem Stand
      // der Einrichtung. Die Geheimnisse selbst verlassen den Bot nicht —
      // die Oberflaeche erfaehrt nur, ob welche hinterlegt sind.
      exchanges: listExchanges().map(definition => {
        const credentials = config.exchanges[definition.id];
        return {
          id: definition.id,
          label: definition.label,
          mica: definition.mica,
          micaAufsicht: definition.micaAufsicht ?? null,
          supportsSpot: definition.supportsSpot,
          supportsFutures: definition.supportsFutures,
          supportsSandbox: definition.supportsSandbox,
          benoetigtPasswort: BOERSEN_MIT_PASSWORT.includes(definition.id),
          hinweis: definition.hinweis ?? null,
          eingerichtet: !!credentials?.apiKey && !!credentials?.apiSecret,
          testnet: credentials?.testnet ?? false,
          marketType: credentials?.marketType
            ?? (definition.supportsFutures ? 'futures' : 'spot'),
        };
      }),
      planPollInterval: config.planPollInterval,
      pricePollInterval: config.pricePollInterval,
      orderCheckInterval: config.orderCheckInterval,
      logLevel: config.logLevel,
      telegramBotTokenConfigured: !!config.telegramBotToken,
      telegramChatId: config.telegramChatId,
      telegramEnabled: config.telegramEnabled,
      telegramNotify_order_placed: this.getTelegramToggle('telegramNotify_order_placed'),
      telegramNotify_order_filled: this.getTelegramToggle('telegramNotify_order_filled'),
      telegramNotify_plan_activated: this.getTelegramToggle('telegramNotify_plan_activated'),
      telegramNotify_plan_completed: this.getTelegramToggle('telegramNotify_plan_completed'),
      telegramNotify_plan_error: this.getTelegramToggle('telegramNotify_plan_error'),
      telegramNotify_engine_error: this.getTelegramToggle('telegramNotify_engine_error'),
      riskMaxDailyLossPct: this.getNumericSetting('riskMaxDailyLossPct', 5),
      riskMaxWeeklyLossPct: this.getNumericSetting('riskMaxWeeklyLossPct', 10),
      riskMaxDrawdownPct: this.getNumericSetting('riskMaxDrawdownPct', 20),
      riskSlCooldownMin: this.getNumericSetting('riskSlCooldownMin', 120),
      riskMaxConcurrentPlans: this.getNumericSetting('riskMaxConcurrentPlans', 5),
      // CopyTrading
      claudeApiKeyConfigured: !!(config as unknown as Record<string, unknown>).claudeApiKey,
      ctEnabled: this.store.getBotState('setting:ctEnabled') === 'true',
      ctClaudeModel: this.store.getBotState('setting:ctClaudeModel') || 'claude-sonnet-4-20250514',
      ctPortfolioSize: this.getNumericSetting('ctPortfolioSize', 1000),
      ctMinCombinedScore: this.getNumericSetting('ctMinCombinedScore', 40),
      ctMinConvictionScore: this.getNumericSetting('ctMinConvictionScore', 25),
    };
  }

  private getNumericSetting(key: string, defaultVal: number): number {
    const saved = this.store.getBotState(`setting:${key}`);
    if (saved !== undefined) return parseFloat(saved);
    return defaultVal;
  }

  private getTelegramToggle(key: string): boolean {
    const saved = this.store.getBotState(`setting:${key}`);
    return saved === undefined ? true : saved === 'true';
  }

  /** Passwort ändern: altes validieren, KeyStore re-encrypten, neuen Hash speichern */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    // Altes Passwort validieren
    if (!(await this.validatePassword(oldPassword))) {
      throw new Error('Aktuelles Passwort ist falsch');
    }

    if (newPassword.length < 4) {
      throw new Error('Neues Passwort muss mindestens 4 Zeichen lang sein');
    }

    // Keys aus dem alten KeyStore lesen
    let existingKeys: Record<string, string | undefined> = {};
    if (this.keyStore.isUnlocked()) {
      try {
        existingKeys = await this.keyStore.getKeys();
      } catch {
        // Leer, wenn KeyStore noch keine Keys hat
      }
    }

    // KeyStore mit neuem Passwort neu erstellen
    this.keyStore.lock();
    await this.keyStore.initialize(newPassword);

    // Keys zurückschreiben
    if (Object.keys(existingKeys).length > 0) {
      const validKeys: Record<string, string> = {};
      for (const [k, v] of Object.entries(existingKeys)) {
        if (v) validKeys[k] = v;
      }
      if (Object.keys(validKeys).length > 0) {
        await this.keyStore.setKeys(validKeys);
      }
    }

    // Neuen Passwort-Hash speichern
    this.store.setBotState('setting:passwordHash', await this.hashPassword(newPassword));
    this.currentPassword = newPassword;

    this.logger.info('Password changed successfully');
  }

  /** Passwort prüfen (gegen Hash oder .env-Fallback) */
  async validatePassword(password: string): Promise<boolean> {
    const savedHash = this.store.getBotState('setting:passwordHash');
    if (savedHash) {
      return this.verifyPassword(password, savedHash);
    }
    // Fallback: .env-Passwort (timing-safe)
    const a = Buffer.from(password);
    const b = Buffer.from(this.envConfig.webUiPassword);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Aktuelles gültiges Passwort für Auth-Middleware */
  getCurrentPassword(): string {
    return this.currentPassword;
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SCRYPT_SALT_LENGTH);
    const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION, maxmem: SCRYPT_MAXMEM,
    }) as Buffer;
    return salt.toString('hex') + ':' + derived.toString('hex');
  }

  private async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION, maxmem: SCRYPT_MAXMEM,
    }) as Buffer;
    return timingSafeEqual(derived, expected);
  }

  private coerceValue(key: string, value: string): unknown {
    if (['planPollInterval', 'pricePollInterval', 'orderCheckInterval', 'riskSlCooldownMin', 'riskMaxConcurrentPlans'].includes(key)) {
      return parseInt(value, 10);
    }
    if (['riskMaxDailyLossPct', 'riskMaxWeeklyLossPct', 'riskMaxDrawdownPct'].includes(key)) {
      return parseFloat(value);
    }
    if (key === 'nurMicaBoersen' || key === 'telegramEnabled' || key.startsWith('telegramNotify_')) {
      return value === 'true';
    }
    return value;
  }
}
