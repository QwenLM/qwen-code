/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RcScope } from './scopes.js';

interface TokenRecord {
  id: string;
  /** Hex-encoded sha256 of the raw token. The raw token is never stored. */
  tokenHash: string;
  scopes: RcScope[];
  label: string;
  createdAt: number;
}

/** Public metadata about an issued token. Never includes secret material. */
export interface TokenInfo {
  id: string;
  scopes: RcScope[];
  label: string;
  createdAt: number;
}

interface PersistShape {
  tokens: TokenRecord[];
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Parse `Authorization: Bearer <token>` → credential, or null. */
function parseBearer(header: string): string | null {
  const sp = header.indexOf(' ');
  if (sp <= 0) return null;
  if (header.slice(0, sp).toLowerCase() !== 'bearer') return null;
  const cred = header.slice(sp + 1).trim();
  return cred.length > 0 ? cred : null;
}

export class TokenStore {
  private constructor(
    private readonly filePath: string,
    private records: TokenRecord[],
    private nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<TokenStore> {
    let records: TokenRecord[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.tokens)) records = parsed.tokens;
    } catch {
      // Missing/corrupt file → start empty. First issue() persists it.
    }
    return new TokenStore(filePath, records, nowFn);
  }

  async issue(
    scopes: RcScope[],
    label: string,
  ): Promise<{ id: string; token: string }> {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('base64url');
    this.records.push({
      id,
      tokenHash: sha256Hex(token),
      scopes: [...scopes],
      label,
      createdAt: this.nowFn(),
    });
    await this.persist();
    return { id, token };
  }

  /** Resolve a raw `Authorization` header value to identity + scopes. */
  resolve(authHeader: string): { id: string; scopes: RcScope[] } | null {
    const cred = parseBearer(authHeader);
    if (!cred) return null;
    const candidate = Buffer.from(sha256Hex(cred), 'hex');
    for (const rec of this.records) {
      const stored = Buffer.from(rec.tokenHash, 'hex');
      if (
        stored.length === candidate.length &&
        timingSafeEqual(stored, candidate)
      ) {
        return { id: rec.id, scopes: [...rec.scopes] };
      }
    }
    return null;
  }

  /** List issued tokens as metadata only (no hash, no raw token). */
  list(): TokenInfo[] {
    return this.records.map((r) => ({
      id: r.id,
      scopes: [...r.scopes],
      label: r.label,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Remove a token by id. Returns true if a record was removed. Awaits the
   * persist so a revoked credential is durable before the caller responds —
   * a crash must never resurrect a revoked token on reopen.
   */
  async revoke(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { tokens: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
