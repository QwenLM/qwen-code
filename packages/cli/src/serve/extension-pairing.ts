/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60_000;
const PAIRING_CODE_BYTES = 16;
const PAIRING_NONCE_BYTES = 16;
const CREDENTIAL_ID_BYTES = 8;
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_ATTEMPT_WINDOW_MS = 60_000;
const PAIRING_DOMAIN = 'qwen-extension-pairing';
const VERIFICATION_DOMAIN = 'qwen-extension-daemon';
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ExtensionPairingStatus =
  | { paired: true }
  | { paired: false; expiresAt: number; pairingNonce: string };

export type ExtensionPairingConfirmRequest = {
  pairingNonce: string;
  challenge: string;
  clientProof: string;
};

export type ExtensionPairingConfirmResult =
  | { ok: true; credentialId: string; proof: string }
  | {
      ok: false;
      error:
        | 'invalid_proof'
        | 'expired_code'
        | 'too_many_attempts'
        | 'already_paired';
    };

type ExtensionPairingManagerOptions = {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  ttlMs?: number;
  onCodeRotated?: (code: string, expiresAt: number) => void;
};

export type ExtensionPairingManager = {
  getStatus(): ExtensionPairingStatus;
  getDisplayCode(): string;
  confirm(
    request: ExtensionPairingConfirmRequest,
  ): ExtensionPairingConfirmResult;
  verifyCredential(credential: string | undefined): boolean;
  createVerificationProof(
    credentialId: string | undefined,
    challenge: string | undefined,
  ): string | undefined;
};

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function hmac(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

function parseCredential(
  credential: string | undefined,
): { id: string; secret: string } | undefined {
  if (!credential) return undefined;
  const separator = credential.indexOf('.');
  if (separator <= 0 || separator === credential.length - 1) return undefined;
  return {
    id: credential.slice(0, separator),
    secret: credential.slice(separator + 1),
  };
}

function verificationProof(key: Buffer, challenge: string): string {
  return hmac(key, `${VERIFICATION_DOMAIN}:${challenge}`).toString('base64url');
}

function formatCode(bytes: Buffer): string {
  return bytes.toString('hex').match(/.{4}/g)!.join('-');
}

function decodeProof(value: string): Buffer | undefined {
  if (!BASE64URL_256_PATTERN.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 ? decoded : undefined;
}

export function createExtensionPairingManager(
  options: ExtensionPairingManagerOptions = {},
): ExtensionPairingManager {
  const now = options.now ?? Date.now;
  const rand = options.randomBytes ?? randomBytes;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let expiresAt = now() + ttlMs;
  let code = formatCode(rand(PAIRING_CODE_BYTES));
  let pairingNonce = rand(PAIRING_NONCE_BYTES).toString('base64url');
  const credentialHashes = new Map<string, Buffer>();
  let failedAttempts = 0;
  let failedAttemptWindowStartedAt = now();

  const rotateCode = (): void => {
    code = formatCode(rand(PAIRING_CODE_BYTES));
    pairingNonce = rand(PAIRING_NONCE_BYTES).toString('base64url');
    expiresAt = now() + ttlMs;
    failedAttempts = 0;
    failedAttemptWindowStartedAt = now();
    options.onCodeRotated?.(code, expiresAt);
  };

  return {
    getStatus(): ExtensionPairingStatus {
      if (credentialHashes.size > 0) return { paired: true };
      if (now() > expiresAt) rotateCode();
      return { paired: false, expiresAt, pairingNonce };
    },

    getDisplayCode(): string {
      if (credentialHashes.size === 0 && now() > expiresAt) rotateCode();
      return code;
    },

    confirm(
      request: ExtensionPairingConfirmRequest,
    ): ExtensionPairingConfirmResult {
      if (credentialHashes.size > 0) {
        return { ok: false, error: 'already_paired' };
      }

      const currentTime = now();
      if (currentTime > expiresAt) {
        rotateCode();
        return { ok: false, error: 'expired_code' };
      }
      if (
        currentTime - failedAttemptWindowStartedAt >=
        FAILED_ATTEMPT_WINDOW_MS
      ) {
        failedAttempts = 0;
        failedAttemptWindowStartedAt = currentTime;
      }
      if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
        return { ok: false, error: 'too_many_attempts' };
      }

      const submittedProof = decodeProof(request.clientProof);
      const codeKey = hash(code);
      const expectedProof = hmac(
        codeKey,
        `${PAIRING_DOMAIN}:client:${pairingNonce}:${request.challenge}`,
      );
      if (
        request.pairingNonce !== pairingNonce ||
        !BASE64URL_256_PATTERN.test(request.challenge) ||
        !submittedProof ||
        !timingSafeEqual(expectedProof, submittedProof)
      ) {
        failedAttempts += 1;
        return { ok: false, error: 'invalid_proof' };
      }

      const credentialId = rand(CREDENTIAL_ID_BYTES).toString('base64url');
      const credentialSecret = hmac(
        codeKey,
        `${PAIRING_DOMAIN}:credential:${pairingNonce}:${request.challenge}:${credentialId}`,
      ).toString('base64url');
      credentialHashes.set(credentialId, hash(credentialSecret));
      const proof = hmac(
        codeKey,
        `${PAIRING_DOMAIN}:server:${pairingNonce}:${request.challenge}:${credentialId}`,
      ).toString('base64url');
      return { ok: true, credentialId, proof };
    },

    verifyCredential(credential: string | undefined): boolean {
      const parsed = parseCredential(credential);
      if (!parsed) return false;
      const expected = credentialHashes.get(parsed.id);
      if (!expected) return false;
      const actual = hash(parsed.secret);
      return timingSafeEqual(expected, actual);
    },

    createVerificationProof(
      credentialId: string | undefined,
      challenge: string | undefined,
    ): string | undefined {
      if (
        !credentialId ||
        !challenge ||
        !BASE64URL_256_PATTERN.test(challenge)
      ) {
        return undefined;
      }
      const key = credentialHashes.get(credentialId);
      return key ? verificationProof(key, challenge) : undefined;
    },
  };
}
