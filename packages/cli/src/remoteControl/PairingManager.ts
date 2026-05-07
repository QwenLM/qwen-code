/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { DEFAULT_PAIRING_TOKEN_TTL_MS } from './protocol.js';

interface TokenRecord {
  hash: Buffer;
  expiresAt: number;
}

export class PairingManager {
  private pairingToken: TokenRecord | null = null;
  private readonly clientTokens = new Map<string, TokenRecord>();

  createPairingToken(ttlMs: number = DEFAULT_PAIRING_TOKEN_TTL_MS): {
    token: string;
    expiresAt: string;
  } {
    const token = randomBytes(24).toString('base64url');
    this.pairingToken = {
      hash: this.hash(token),
      expiresAt: Date.now() + ttlMs,
    };
    return {
      token,
      expiresAt: new Date(this.pairingToken.expiresAt).toISOString(),
    };
  }

  verifyPairingToken(token: string): boolean {
    if (!this.pairingToken || this.isExpired(this.pairingToken)) {
      return false;
    }
    const valid = this.safeEquals(this.pairingToken.hash, this.hash(token));
    if (valid) {
      this.pairingToken = null;
    }
    return valid;
  }

  issueClientToken(ttlMs: number = 24 * 60 * 60 * 1000): {
    token: string;
    expiresAt: string;
  } {
    const token = randomBytes(32).toString('base64url');
    const key = this.hash(token).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    this.clientTokens.set(key, {
      hash: this.hash(token),
      expiresAt,
    });
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  verifyClientToken(token: string): boolean {
    this.pruneExpiredClientTokens();
    const hash = this.hash(token);
    const record = this.clientTokens.get(hash.toString('hex'));
    if (!record || this.isExpired(record)) {
      return false;
    }
    return this.safeEquals(record.hash, hash);
  }

  private pruneExpiredClientTokens(): void {
    for (const [key, record] of this.clientTokens.entries()) {
      if (this.isExpired(record)) {
        this.clientTokens.delete(key);
      }
    }
  }

  private isExpired(record: TokenRecord): boolean {
    return Date.now() > record.expiresAt;
  }

  private hash(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }

  private safeEquals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
