import { readFile, writeFile, access, chmod } from 'node:fs/promises';
import { CryptoUtils } from './crypto.js';

/**
 * Verschluesselt abgelegte Geheimnisse.
 *
 * Die Zugangsdaten der Boersen liegen unter `exchange.<id>.apiKey`,
 * `.apiSecret` und `.password`. Feste Felder je Boerse gingen nicht:
 * Welche Boersen eingerichtet werden, entscheidet sich zur Laufzeit.
 */
interface StoredKeys {
  tcApiKey?: string;
  telegramBotToken?: string;
  claudeApiKey?: string;
  [key: string]: string | undefined;
}

interface EncryptedFile {
  version: number;
  salt: string; // hex
  data: string; // hex
}

export class KeyStore {
  private cachedKey: Buffer | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Initialisiert den KeyStore mit dem Web-UI-Passwort */
  async unlock(password: string): Promise<void> {
    const salt = await this.loadSalt();
    const { key } = await CryptoUtils.deriveKey(password, salt ?? undefined);
    this.cachedKey = key;
  }

  lock(): void {
    this.cachedKey = null;
  }

  isUnlocked(): boolean {
    return this.cachedKey !== null;
  }

  async getKeys(): Promise<StoredKeys> {
    this.ensureUnlocked();
    const exists = await this.fileExists();
    if (!exists) return {};

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const file: EncryptedFile = JSON.parse(raw);
      const decrypted = CryptoUtils.decrypt(Buffer.from(file.data, 'hex'), this.cachedKey!);
      return JSON.parse(decrypted) as StoredKeys;
    } catch (err) {
      throw new Error(`KeyStore corrupted or wrong password: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async setKeys(keys: StoredKeys): Promise<void> {
    this.ensureUnlocked();
    const existing = await this.getKeys().catch(() => ({}));
    const merged = { ...existing, ...keys };

    const plaintext = JSON.stringify(merged);
    const encrypted = CryptoUtils.encrypt(plaintext, this.cachedKey!);

    const salt = await this.loadSalt();
    const file: EncryptedFile = {
      version: 1,
      salt: (salt ?? Buffer.alloc(0)).toString('hex'),
      data: encrypted.toString('hex'),
    };

    await this.writeSecure(JSON.stringify(file, null, 2));
  }

  async getKey(name: string): Promise<string | undefined> {
    const keys = await this.getKeys();
    return keys[name];
  }

  async setKey(name: string, value: string): Promise<void> {
    await this.setKeys({ [name]: value });
  }

  async deleteKey(name: string): Promise<void> {
    const keys = await this.getKeys();
    delete keys[name];
    const plaintext = JSON.stringify(keys);
    const encrypted = CryptoUtils.encrypt(plaintext, this.cachedKey!);

    const salt = await this.loadSalt();
    const file: EncryptedFile = {
      version: 1,
      salt: (salt ?? Buffer.alloc(0)).toString('hex'),
      data: encrypted.toString('hex'),
    };

    await this.writeSecure(JSON.stringify(file, null, 2));
  }

  /** Erstellt einen neuen KeyStore mit Passwort */
  async initialize(password: string): Promise<void> {
    const { key, salt } = await CryptoUtils.deriveKey(password);
    this.cachedKey = key;

    const plaintext = JSON.stringify({});
    const encrypted = CryptoUtils.encrypt(plaintext, key);

    const file: EncryptedFile = {
      version: 1,
      salt: salt.toString('hex'),
      data: encrypted.toString('hex'),
    };

    await this.writeSecure(JSON.stringify(file, null, 2));
  }

  private ensureUnlocked(): void {
    if (!this.cachedKey) {
      throw new Error('KeyStore is locked. Call unlock() first.');
    }
  }

  private async loadSalt(): Promise<Buffer | null> {
    const exists = await this.fileExists();
    if (!exists) return null;

    const raw = await readFile(this.filePath, 'utf8');
    const file: EncryptedFile = JSON.parse(raw);
    return Buffer.from(file.salt, 'hex');
  }

  private async writeSecure(content: string): Promise<void> {
    await writeFile(this.filePath, content, { encoding: 'utf8', mode: 0o600 });
    // Sicherstellen, dass Permissions auch bei bestehender Datei korrekt sind
    try { await chmod(this.filePath, 0o600); } catch { /* Windows ignoriert chmod */ }
  }

  private async fileExists(): Promise<boolean> {
    try {
      await access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }
}
