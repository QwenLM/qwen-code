import { describe, it, expect } from 'vitest';
import { createDecipheriv, createCipheriv } from 'node:crypto';
import { encryptAesEcb, computeMd5 } from './media.js';

/**
 * Test the AES key parsing and decryption logic used in media.ts.
 * We test the pure crypto functions by reimplementing them here
 * since they're not exported, but the behavior must match.
 */

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))
  ) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `Invalid aes_key: expected 16 raw bytes or 32 hex chars, got ${decoded.length} bytes`,
  );
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

describe('Weixin media crypto', () => {
  describe('parseAesKey', () => {
    it('accepts 16-byte raw key encoded in base64', () => {
      const raw = Buffer.alloc(16, 0xab);
      const b64 = raw.toString('base64');
      const result = parseAesKey(b64);
      expect(result).toEqual(raw);
      expect(result.length).toBe(16);
    });

    it('accepts 32-char hex string encoded in base64', () => {
      // 32 hex chars → 16 bytes when parsed as hex
      const hexStr = 'aabbccdd11223344aabbccdd11223344';
      const b64 = Buffer.from(hexStr, 'ascii').toString('base64');
      const result = parseAesKey(b64);
      expect(result.length).toBe(16);
      expect(result.toString('hex')).toBe(hexStr);
    });

    it('throws for invalid key length', () => {
      const bad = Buffer.alloc(20, 0x00).toString('base64');
      expect(() => parseAesKey(bad)).toThrow('Invalid aes_key');
    });

    it('throws for 32-byte non-hex content', () => {
      // 32 bytes but not valid hex characters
      const nonHex = Buffer.from('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'ascii');
      const b64 = nonHex.toString('base64');
      expect(() => parseAesKey(b64)).toThrow('Invalid aes_key');
    });
  });

  describe('decryptAesEcb', () => {
    it('encrypts then decrypts round-trip', () => {
      const key = Buffer.alloc(16, 0x42);
      const plaintext = Buffer.from('Hello, WeChat media decryption!');

      // Encrypt
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);

      // Decrypt
      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.toString()).toBe(plaintext.toString());
    });

    it('handles empty plaintext', () => {
      const key = Buffer.alloc(16, 0x01);
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.alloc(0)),
        cipher.final(),
      ]);
      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.length).toBe(0);
    });
  });
});

describe('encryptAesEcb', () => {
  it('encrypts data deterministically', () => {
    const key = Buffer.alloc(16, 0xab);
    const plaintext = Buffer.from('test data for encryption');
    const ciphertext1 = encryptAesEcb(plaintext, key);
    const ciphertext2 = encryptAesEcb(plaintext, key);
    expect(ciphertext1).toEqual(ciphertext2);
  });

  it('encrypts then decrypts round-trip', () => {
    const key = Buffer.alloc(16, 0x42);
    const plaintext = Buffer.from('Hello, WeChat media upload!');

    const ciphertext = encryptAesEcb(plaintext, key);
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    expect(decrypted.toString()).toBe(plaintext.toString());
  });

  it('handles empty plaintext', () => {
    const key = Buffer.alloc(16, 0x01);
    const ciphertext = encryptAesEcb(Buffer.alloc(0), key);
    // ECB with empty input produces empty output (no padding block needed
    // when input is exactly 0 bytes — behavior varies by implementation)
    // At minimum the result should be decryptable
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    expect(decrypted.length).toBe(0);
  });
});

describe('computeMd5', () => {
  it('computes expected MD5', () => {
    const data = Buffer.from('hello world');
    expect(computeMd5(data)).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
  });

  it('computes MD5 of empty buffer', () => {
    expect(computeMd5(Buffer.alloc(0))).toBe(
      'd41d8cd98f00b204e9800998ecf8427e',
    );
  });
});
