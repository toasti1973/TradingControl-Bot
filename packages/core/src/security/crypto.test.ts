import { describe, it, expect } from 'vitest';
import { CryptoUtils } from './crypto.js';

describe('CryptoUtils', () => {
  describe('encrypt / decrypt', () => {
    it('should round-trip encrypt and decrypt', async () => {
      const { key } = await CryptoUtils.deriveKey('test-password');
      const plaintext = 'Hello, World! This is secret data.';

      const encrypted = CryptoUtils.encrypt(plaintext, key);
      const decrypted = CryptoUtils.decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for same input (random IV)', async () => {
      const { key } = await CryptoUtils.deriveKey('test-password');
      const plaintext = 'same data';

      const a = CryptoUtils.encrypt(plaintext, key);
      const b = CryptoUtils.encrypt(plaintext, key);

      expect(a.equals(b)).toBe(false);
    });

    it('should fail to decrypt with wrong key', async () => {
      const { key: key1 } = await CryptoUtils.deriveKey('password1');
      const { key: key2 } = await CryptoUtils.deriveKey('password2');

      const encrypted = CryptoUtils.encrypt('secret', key1);

      expect(() => CryptoUtils.decrypt(encrypted, key2)).toThrow();
    });

    it('should fail to decrypt tampered data', async () => {
      const { key } = await CryptoUtils.deriveKey('test-password');
      const encrypted = CryptoUtils.encrypt('secret', key);

      // Tamper with the encrypted data
      encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1]! + 1) % 256;

      expect(() => CryptoUtils.decrypt(encrypted, key)).toThrow();
    });
  });

  describe('deriveKey', () => {
    it('should derive consistent keys with same salt', async () => {
      const { key: key1, salt } = await CryptoUtils.deriveKey('password');
      const { key: key2 } = await CryptoUtils.deriveKey('password', salt);

      expect(key1.equals(key2)).toBe(true);
    });

    it('should derive different keys for different passwords', async () => {
      const { key: key1, salt } = await CryptoUtils.deriveKey('password1');
      const { key: key2 } = await CryptoUtils.deriveKey('password2', salt);

      expect(key1.equals(key2)).toBe(false);
    });

    it('should generate random salt when not provided', async () => {
      const { salt: salt1 } = await CryptoUtils.deriveKey('password');
      const { salt: salt2 } = await CryptoUtils.deriveKey('password');

      expect(salt1.equals(salt2)).toBe(false);
    });
  });

  describe('hmacSha256', () => {
    it('should produce consistent HMAC', () => {
      const result1 = CryptoUtils.hmacSha256('data', 'secret');
      const result2 = CryptoUtils.hmacSha256('data', 'secret');

      expect(result1).toBe(result2);
      expect(result1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different HMAC for different data', () => {
      const result1 = CryptoUtils.hmacSha256('data1', 'secret');
      const result2 = CryptoUtils.hmacSha256('data2', 'secret');

      expect(result1).not.toBe(result2);
    });
  });
});
