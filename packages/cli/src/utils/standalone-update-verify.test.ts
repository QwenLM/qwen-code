import { describe, it, expect } from 'vitest';
import { verifySignature } from './standalone-update-verify.js';

describe('standalone-update-verify', () => {
  // Since we can't use the embedded key's private counterpart in tests,
  // we test the structure and error paths.

  describe('verifySignature', () => {
    it('rejects signature with wrong length', () => {
      expect(() => verifySignature('test content', 'dG9vc2hvcnQ=')).toThrow(
        'Invalid signature length',
      );
    });

    it('rejects invalid signature (correct length but wrong bytes)', () => {
      // 64 bytes of zeros, base64 encoded
      const fakeSig = Buffer.alloc(64, 0).toString('base64');
      expect(() => verifySignature('test content', fakeSig)).toThrow(
        'signature verification failed',
      );
    });

    it('rejects tampered content with valid-length signature', () => {
      // Even a random 64-byte signature should fail verification
      const randomSig = Buffer.from(
        Array.from({ length: 64 }, () => Math.floor(Math.random() * 256)),
      ).toString('base64');
      expect(() =>
        verifySignature('some SHA256SUMS content', randomSig),
      ).toThrow('signature verification failed');
    });
  });
});
