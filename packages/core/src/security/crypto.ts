import { randomBytes, createCipheriv, createDecipheriv, createHmac, scrypt, type ScryptOptions, type BinaryLike } from 'node:crypto';

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

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

export class CryptoUtils {
  /**
   * Leitet einen 256-Bit Schlüssel aus einem Passwort ab (scrypt).
   * Hinweis: Argon2id wäre ideal, benötigt aber native Dependency.
   * scrypt ist in Node.js built-in und ebenfalls sicher.
   */
  static async deriveKey(password: string, salt?: Buffer): Promise<{ key: Buffer; salt: Buffer }> {
    const usedSalt = salt ?? randomBytes(SALT_LENGTH);
    const key = await scryptAsync(password, usedSalt, KEY_LENGTH, {
      N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    }) as Buffer;
    return { key, salt: usedSalt };
  }

  /** AES-256-GCM Verschlüsselung */
  static encrypt(data: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Format: [iv (12)] [tag (16)] [encrypted data]
    return Buffer.concat([iv, tag, encrypted]);
  }

  /** AES-256-GCM Entschlüsselung */
  static decrypt(encryptedData: Buffer, key: Buffer): string {
    const iv = encryptedData.subarray(0, IV_LENGTH);
    const tag = encryptedData.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = encryptedData.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return decipher.update(data) + decipher.final('utf8');
  }

  /** HMAC-SHA256 (für API-Signierung) */
  static hmacSha256(data: string, secret: string): string {
    return createHmac('sha256', secret).update(data).digest('hex');
  }

  /** Sichere Zufallsbytes */
  static randomBytes(length: number): Buffer {
    return randomBytes(length);
  }
}
