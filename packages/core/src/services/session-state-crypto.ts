/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { isRecord } from '../utils/markdownUtils.js';
import { normalizePath } from '../utils/paths.js';

export const SESSION_STATE_ALGORITHM = 'aes-256-gcm';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * Fixed AES-256 master key for session state encryption.
 *
 * Session state does NOT contain highly sensitive secrets — it stores token
 * usage counters and workspace metadata.  A fixed key keeps the implementation
 * dead-simple (no keychain, no key-file, no external dependency) while still
 * preventing casual inspection.
 *
 * To offline-decrypt a user's state.json you only need this key and the
 * projectRoot that was active when the state was written.
 */
// prettier-ignore
export const SESSION_STATE_MASTER_KEY = Buffer.from([
  0x2c, 0x06, 0x60, 0x9f, 0x43, 0x89, 0xac, 0x86,
  0x98, 0x34, 0x9d, 0xf8, 0x0f, 0xdb, 0x31, 0x72,
  0xe1, 0x11, 0xc3, 0x25, 0x47, 0x97, 0x91, 0x5f,
  0xd6, 0xe2, 0x09, 0xa9, 0xfa, 0x60, 0x7d, 0xe8,
]);

export interface SessionStateKeyProvider {
  getMasterKey(): Promise<Buffer>;
}

export interface SessionStateEncryptionContext {
  sessionId: string;
  projectRoot: string;
  segmentKey?: string;
}

export interface SessionStateAad {
  sessionId: string;
  projectHash: string;
  segmentKey?: string;
}

export interface SessionStateSealedRecord {
  c: string;
  u: string;
  n: string;
  p: string;
  t: string;
}

export class SessionStateCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateCryptoError';
  }
}

export class SessionStateDecryptionError extends SessionStateCryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateDecryptionError';
  }
}

/**
 * Returns the built-in fixed master key. No keychain, no file I/O.
 */
export class FixedSessionStateKeyProvider implements SessionStateKeyProvider {
  async getMasterKey(): Promise<Buffer> {
    return SESSION_STATE_MASTER_KEY;
  }
}

export class SessionStateCrypto {
  constructor(private readonly keyProvider: SessionStateKeyProvider) {}

  async encrypt(
    plaintext: string,
    context: SessionStateEncryptionContext,
    options: { createdAt?: string; updatedAt?: string } = {},
  ): Promise<SessionStateSealedRecord> {
    const masterKey = await this.keyProvider.getMasterKey();
    validateMasterKey(masterKey);

    const nonce = crypto.randomBytes(NONCE_BYTES);
    const aad = buildSessionStateAad(context);
    const aadBuffer = Buffer.from(stableStringifyAad(aad), 'utf8');
    const cipher = crypto.createCipheriv(
      SESSION_STATE_ALGORITHM,
      masterKey,
      nonce,
    );
    cipher.setAAD(aadBuffer);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const now = options.updatedAt ?? new Date().toISOString();

    return {
      c: options.createdAt ?? now,
      u: now,
      n: nonce.toString('base64'),
      p: ciphertext.toString('base64'),
      t: tag.toString('base64'),
    };
  }

  async decrypt(
    envelope: SessionStateSealedRecord,
    context: SessionStateEncryptionContext,
  ): Promise<string> {
    validateEnvelope(envelope);

    const expectedAad = buildSessionStateAad(context);
    const masterKey = await this.keyProvider.getMasterKey();
    validateMasterKey(masterKey);

    const decipher = crypto.createDecipheriv(
      SESSION_STATE_ALGORITHM,
      masterKey,
      Buffer.from(envelope.n, 'base64'),
    );
    decipher.setAAD(Buffer.from(stableStringifyAad(expectedAad), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.t, 'base64'));
    const chunks = [decipher.update(Buffer.from(envelope.p, 'base64'))];

    try {
      chunks.push(decipher.final());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SessionStateDecryptionError(
        `Failed to read session state record: ${message}`,
      );
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

export function buildSessionStateAad(
  context: SessionStateEncryptionContext,
): SessionStateAad {
  return {
    sessionId: context.sessionId,
    projectHash: crypto
      .createHash('sha256')
      .update(normalizePath(context.projectRoot), 'utf8')
      .digest('hex'),
    ...(context.segmentKey ? { segmentKey: context.segmentKey } : {}),
  };
}

function stableStringifyAad(aad: SessionStateAad): string {
  return JSON.stringify({
    sessionId: aad.sessionId,
    projectHash: aad.projectHash,
    ...(aad.segmentKey ? { segmentKey: aad.segmentKey } : {}),
  });
}

function validateMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new SessionStateCryptoError(
      `Session state master key must be ${KEY_BYTES} bytes.`,
    );
  }
}

function validateEnvelope(envelope: SessionStateSealedRecord): void {
  if (
    !isRecord(envelope) ||
    typeof envelope.c !== 'string' ||
    typeof envelope.u !== 'string' ||
    typeof envelope.n !== 'string' ||
    typeof envelope.p !== 'string' ||
    typeof envelope.t !== 'string'
  ) {
    throw new SessionStateCryptoError(
      'Session state record uses an unsupported format.',
    );
  }
}
