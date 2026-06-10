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
  /** Epoch ms after which this token no longer resolves. Share tokens only. */
  expiresAt?: number;
  /** The one session id a share token may touch. Share tokens only. */
  sessionLockId?: string;
  /** The owner token id that minted this share. Share tokens only. */
  parentId?: string;
  /** Max redemptions allowed; undefined = unlimited. Share tokens only. */
  maxUses?: number;
  /** Redemptions consumed so far. Absent on pre-cycle-26 records → read as 0. */
  uses?: number;
}

/** Public metadata about an issued token. Never includes secret material. */
export interface TokenInfo {
  id: string;
  scopes: RcScope[];
  label: string;
  createdAt: number;
}

/** Public metadata about a share token. Never includes secret material. */
export interface ShareInfo {
  id: string;
  label: string;
  scopes: RcScope[];
  sessionLockId: string;
  expiresAt?: number;
  parentId?: string;
  createdAt: number;
  /** Computed at read time: `expiresAt !== undefined && now >= expiresAt`. */
  expired: boolean;
  /** Max redemptions allowed; undefined = unlimited. */
  maxUses?: number;
  /** Redemptions consumed so far (normalized: a missing field reads as 0). */
  uses: number;
  /** `maxUses === undefined ? null : maxUses - uses`. */
  usesRemaining: number | null;
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

  /**
   * Issue a session-locked, TTL-bounded share token. Like `issue`, but stamps
   * `expiresAt = nowFn() + ttlSec*1000`, the session lock, and the parent id.
   */
  async issueShare(opts: {
    scopes: RcScope[];
    label: string;
    sessionLockId: string;
    ttlSec: number;
    parentId: string;
    /** Max redemptions; undefined = unlimited. */
    maxUses?: number;
  }): Promise<{ id: string; token: string; expiresAt: number }> {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.nowFn() + opts.ttlSec * 1000;
    this.records.push({
      id,
      tokenHash: sha256Hex(token),
      scopes: [...opts.scopes],
      label: opts.label,
      createdAt: this.nowFn(),
      expiresAt,
      sessionLockId: opts.sessionLockId,
      parentId: opts.parentId,
      maxUses: opts.maxUses,
      uses: 0,
    });
    await this.persist();
    return { id, token, expiresAt };
  }

  /**
   * Consume one redemption of a share token. Atomic at the JS level: the
   * `uses < maxUses` guard and the in-memory increment run synchronously with no
   * `await` between them, so the single-threaded event loop cannot interleave a
   * second concurrent `consumeUse` between check and bump (the equivalent of the
   * design's atomic SQL `UPDATE ... WHERE uses < max_uses`). `persist()` is the
   * only await and happens after the bump; a persist failure rejects but the
   * in-memory count already moved — the caller (whoami) catches that and 500s.
   *
   * Returns `usesRemaining` post-bump (`null` when unlimited). An unlimited
   * (`maxUses === undefined`) share always succeeds. `uses` is read with `?? 0`
   * so a record persisted before this field existed never reads as `NaN`.
   */
  async consumeUse(
    id: string,
  ): Promise<
    | { ok: true; usesRemaining: number | null }
    | { ok: false; reason: 'exhausted' | 'not_found' }
  > {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return { ok: false, reason: 'not_found' };
    const used = rec.uses ?? 0;
    if (rec.maxUses !== undefined && used >= rec.maxUses) {
      return { ok: false, reason: 'exhausted' };
    }
    rec.uses = used + 1;
    await this.persist();
    return {
      ok: true,
      usesRemaining: rec.maxUses === undefined ? null : rec.maxUses - rec.uses,
    };
  }

  /**
   * Resolve a raw `Authorization` header value to identity + scopes. An expired
   * share token (`expiresAt !== undefined && now >= expiresAt`) is treated as no
   * match (→ null → 401). On match, the record's `sessionLockId` is returned so
   * `enforceSessionLock` can confine a share token to its one session.
   */
  resolve(
    authHeader: string,
  ): { id: string; scopes: RcScope[]; sessionLockId?: string } | null {
    const cred = parseBearer(authHeader);
    if (!cred) return null;
    const candidate = Buffer.from(sha256Hex(cred), 'hex');
    for (const rec of this.records) {
      const stored = Buffer.from(rec.tokenHash, 'hex');
      if (
        stored.length === candidate.length &&
        timingSafeEqual(stored, candidate)
      ) {
        // Expired share token: strict >= means at exactly expiresAt it is dead.
        if (rec.expiresAt !== undefined && this.nowFn() >= rec.expiresAt) {
          continue;
        }
        return {
          id: rec.id,
          scopes: [...rec.scopes],
          sessionLockId: rec.sessionLockId,
        };
      }
    }
    return null;
  }

  /**
   * Resolve a token id to a copy of its scopes (pure read, no I/O). Used by the
   * push notifier to scope-gate fan-out. Returns undefined for an unknown id OR
   * an expired token — an expired share token must grant no push delivery, just
   * as `resolve()` rejects it for requests.
   */
  scopesFor(id: string): RcScope[] | undefined {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return undefined;
    if (rec.expiresAt !== undefined && this.nowFn() >= rec.expiresAt) {
      return undefined;
    }
    return [...rec.scopes];
  }

  /**
   * The session a token is locked to, or undefined if it is not session-locked
   * (normal tokens) or the id is unknown. Used by the push notifier to keep a
   * session-locked share token from receiving another session's notification
   * metadata via the push fan-out.
   */
  sessionLockFor(id: string): string | undefined {
    return this.records.find((r) => r.id === id)?.sessionLockId;
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
   * List share tokens (records carrying a `sessionLockId`) as metadata only.
   * `expired` is computed at read time; no secret material is exposed.
   */
  listShares(): ShareInfo[] {
    const now = this.nowFn();
    return this.records
      .filter((r) => r.sessionLockId !== undefined)
      .map((r) => {
        const uses = r.uses ?? 0;
        return {
          id: r.id,
          label: r.label,
          scopes: [...r.scopes],
          sessionLockId: r.sessionLockId!,
          expiresAt: r.expiresAt,
          parentId: r.parentId,
          createdAt: r.createdAt,
          expired: r.expiresAt !== undefined && now >= r.expiresAt,
          maxUses: r.maxUses,
          uses,
          usesRemaining: r.maxUses === undefined ? null : r.maxUses - uses,
        };
      });
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
