/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { argon2id } from '@noble/hashes/argon2';
import type { RcScope } from './scopes.js';
import type { CorsOriginRecord } from './types.js';

// ---------------------------------------------------------------------------
// Argon2id parameters (RFC 9106 "second recommended" interactive-ish profile,
// matching donor remoteControl/tokenStore.ts). Deliberately trimmed so unit
// tests stay fast while remaining a real argon2id cost.
// ---------------------------------------------------------------------------

const ARGON2_PARAMS = {
  /** memory cost in KiB */
  m: 19456,
  /** time cost (iterations) */
  t: 2,
  /** parallelism (lanes) */
  p: 1,
  /** derived key length in bytes */
  dkLen: 32,
  /** algorithm version (0x13 == 19) */
  v: 19,
} as const;

const SALT_BYTES = 16;

/** Default maximum token age in days, measured from issuedAt. */
const DEFAULT_MAX_TOKEN_AGE_DAYS = 180;
const DAY_MS = 86_400_000;

/** Token prefix on every issued token (spec: "qwk_<base64url(32 bytes)>"). */
export const TOKEN_PREFIX = 'qwk_';

// ---------------------------------------------------------------------------
// Argon2id encode / verify helpers
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Encode a secret as a self-describing argon2id string with a fresh salt.
 * Format: argon2id$v=19$m=<kb>,t=<iters>,p=<lanes>$<saltB64url>$<hashB64url>
 */
function argon2idEncode(plaintext: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = argon2id(plaintext, salt, {
    t: ARGON2_PARAMS.t,
    m: ARGON2_PARAMS.m,
    p: ARGON2_PARAMS.p,
    dkLen: ARGON2_PARAMS.dkLen,
  });
  const params = `m=${ARGON2_PARAMS.m},t=${ARGON2_PARAMS.t},p=${ARGON2_PARAMS.p}`;
  return `argon2id$v=${ARGON2_PARAMS.v}$${params}$${b64url(salt)}$${b64url(hash)}`;
}

/** Constant-time verify of a plaintext against an encoded argon2id string. */
function argon2idVerify(plaintext: string, encoded: string): boolean {
  const parts = encoded.split('$');
  // ['argon2id', 'v=19', 'm=..,t=..,p=..', '<salt>', '<hash>']
  if (parts.length !== 5 || parts[0] !== 'argon2id') return false;
  const paramStr = parts[2];
  const saltStr = parts[3];
  const hashStr = parts[4];
  if (paramStr === undefined || saltStr === undefined || hashStr === undefined)
    return false;

  const params: Record<string, number> = {};
  for (const kv of paramStr.split(',')) {
    const [k, v] = kv.split('=');
    if (k === undefined || v === undefined) return false;
    const n = Number(v);
    if (!Number.isFinite(n)) return false;
    params[k] = n;
  }
  const m = params['m'];
  const t = params['t'];
  const p = params['p'];
  if (m === undefined || t === undefined || p === undefined) return false;

  const salt = fromB64url(saltStr);
  const expected = fromB64url(hashStr);
  const actual = Buffer.from(
    argon2id(plaintext, salt, { t, m, p, dkLen: expected.length }),
  );
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Non-secret SHA-256 lookup index (Base64URL) for O(1) candidate fetch.
 * Because tokens are 32-byte random secrets, the SHA-256 index leaks nothing
 * exploitable while keeping lookups cheap (argon2id is deliberately slow).
 */
function lookupHash(plaintext: string): string {
  return b64url(createHash('sha256').update(plaintext, 'utf8').digest());
}

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

interface TokenRecord {
  id: string;
  /** Self-describing argon2id hash. The raw token is never stored. */
  tokenHash: string;
  /** SHA-256(token) in Base64URL for O(1) candidate lookup. */
  lookupHash: string;
  scopes: RcScope[];
  label: string;
  createdAt: number;
  /**
   * Epoch ms at original mint; never advanced by sliding renewal. Anchors the
   * absolute max-age ceiling (spec: "Absolute max age wins over sliding renewal").
   */
  issuedAt: number;
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
  /**
   * Epoch ms at revocation, or undefined = not revoked. Set by revoke() and
   * revokeAll(); never cleared. resolve() rejects revoked records.
   */
  revokedAt?: number;
}

/** Public metadata about an issued token. Never includes secret material. */
export interface TokenInfo {
  id: string;
  scopes: RcScope[];
  label: string;
  createdAt: number;
  issuedAt: number;
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
  issuedAt: number;
  /** Computed at read time: `expiresAt !== undefined && now >= expiresAt`. */
  expired: boolean;
  /** Max redemptions allowed; undefined = unlimited. */
  maxUses?: number;
  /** Redemptions consumed so far (normalized: a missing field reads as 0). */
  uses: number;
  /** `maxUses === undefined ? null : maxUses - uses`. */
  usesRemaining: number | null;
}

/** Outcome of `removeOrigin`. */
export type RemoveOriginResult =
  | { removed: true }
  | { notFound: true }
  | { conflict: 'config' };

interface CorsOriginRow {
  origin: string;
  admittedByTokenId: string | null;
  admittedAt: string | null;
}

interface PersistShape {
  tokens: TokenRecord[];
  corsOrigins?: CorsOriginRow[];
}

/** Parse `Authorization: Bearer <token>` → credential, or null. */
function parseBearer(header: string): string | null {
  const sp = header.indexOf(' ');
  if (sp <= 0) return null;
  if (header.slice(0, sp).toLowerCase() !== 'bearer') return null;
  const cred = header.slice(sp + 1).trim();
  return cred.length > 0 ? cred : null;
}

// ---------------------------------------------------------------------------
// verifyTokenDetailed result type
// ---------------------------------------------------------------------------

export type VerifyTokenFailureReason =
  | 'not_found'
  | 'revoked'
  | 'token_expired_max_age';

export type VerifyTokenResult =
  | {
      ok: true;
      id: string;
      scopes: RcScope[];
      sessionLockId?: string;
      shareLabel?: string;
    }
  | { ok: false; reason: VerifyTokenFailureReason };

export interface TokenAgeOptions {
  /** Override now (epoch ms). Defaults to Date.now(). */
  nowMs?: number;
  /** Override max token age ceiling in days. Defaults to 180. */
  maxTokenAgeDays?: number;
}

// ---------------------------------------------------------------------------
// TokenStore
// ---------------------------------------------------------------------------

export class TokenStore {
  private constructor(
    private readonly filePath: string,
    private records: TokenRecord[],
    private corsRows: CorsOriginRow[],
    private nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<TokenStore> {
    let records: TokenRecord[] = [];
    let corsRows: CorsOriginRow[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.tokens)) records = parsed.tokens;
      if (Array.isArray(parsed.corsOrigins)) corsRows = parsed.corsOrigins;
    } catch {
      // Missing/corrupt file → start empty. First issue() persists it.
    }
    return new TokenStore(filePath, records, corsRows, nowFn);
  }

  async issue(
    scopes: RcScope[],
    label: string,
  ): Promise<{ id: string; token: string }> {
    const id = randomBytes(8).toString('hex');
    const body = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}${body}`;
    const now = this.nowFn();
    this.records.push({
      id,
      tokenHash: argon2idEncode(token),
      lookupHash: lookupHash(token),
      scopes: [...scopes],
      label,
      createdAt: now,
      issuedAt: now,
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
    const body = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}${body}`;
    const now = this.nowFn();
    const expiresAt = now + opts.ttlSec * 1000;
    this.records.push({
      id,
      tokenHash: argon2idEncode(token),
      lookupHash: lookupHash(token),
      scopes: [...opts.scopes],
      label: opts.label,
      createdAt: now,
      issuedAt: now,
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
   * Auth-path lookup with a distinguishable outcome. Enforces, in order:
   * existence + argon2id match, revocation, the absolute max-age ceiling
   * (`nowMs > issuedAt + maxTokenAgeDays` → `token_expired_max_age` even when
   * `expiresAt` is still in the future), then ordinary TTL expiry (share tokens
   * only). Returns a discriminated union.
   *
   * LOOKUP STRATEGY: SHA-256(token) → O(1) candidate set → argon2id verify on
   * candidates only. Because tokens are 32-byte random secrets, the SHA-256
   * index leaks nothing exploitable.
   */
  verifyTokenDetailed(
    plaintext: string,
    opts: TokenAgeOptions = {},
  ): VerifyTokenResult {
    const nowMs = opts.nowMs ?? this.nowFn();
    const maxAgeDays = opts.maxTokenAgeDays ?? DEFAULT_MAX_TOKEN_AGE_DAYS;

    const lh = lookupHash(plaintext);
    const candidates = this.records.filter((r) => r.lookupHash === lh);

    for (const rec of candidates) {
      if (!argon2idVerify(plaintext, rec.tokenHash)) continue;

      if (rec.revokedAt !== undefined) {
        return { ok: false, reason: 'revoked' };
      }

      // Absolute max-age check (wins over sliding renewal / expiresAt).
      const maxAgeCeilingMs = rec.issuedAt + maxAgeDays * DAY_MS;
      if (nowMs > maxAgeCeilingMs) {
        return { ok: false, reason: 'token_expired_max_age' };
      }

      // TTL expiry (share tokens only; owner/normal tokens have no expiresAt).
      if (rec.expiresAt !== undefined && nowMs >= rec.expiresAt) {
        // Expired share → treated as not found (no distinct 'expired' reason
        // exposed through resolve(); consistent with existing behaviour).
        continue;
      }

      return {
        ok: true,
        id: rec.id,
        scopes: [...rec.scopes],
        sessionLockId: rec.sessionLockId,
        shareLabel: rec.sessionLockId !== undefined ? rec.label : undefined,
      };
    }
    return { ok: false, reason: 'not_found' };
  }

  /**
   * Resolve a raw `Authorization` header value to identity + scopes. An expired
   * share token (`expiresAt !== undefined && now >= expiresAt`) is treated as no
   * match (→ null → 401). On match, the record's `sessionLockId` is returned so
   * `enforceSessionLock` can confine a share token to its one session, and —
   * for a share token only — its `label` as `shareLabel` so callers can stamp
   * audit rows with the human-readable share name at action time.
   */
  resolve(authHeader: string): {
    id: string;
    scopes: RcScope[];
    sessionLockId?: string;
    shareLabel?: string;
  } | null {
    const cred = parseBearer(authHeader);
    if (!cred) return null;
    const result = this.verifyTokenDetailed(cred);
    if (!result.ok) return null;
    return {
      id: result.id,
      scopes: result.scopes,
      sessionLockId: result.sessionLockId,
      shareLabel: result.shareLabel,
    };
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
    if (rec.revokedAt !== undefined) return undefined;
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

  /** List issued tokens as metadata only (no hash, no raw token). Excludes revoked. */
  list(): TokenInfo[] {
    return this.records
      .filter((r) => r.revokedAt === undefined)
      .map((r) => ({
        id: r.id,
        scopes: [...r.scopes],
        label: r.label,
        createdAt: r.createdAt,
        issuedAt: r.issuedAt,
      }));
  }

  /**
   * List share tokens (records carrying a `sessionLockId`) as metadata only.
   * `expired` is computed at read time; no secret material is exposed.
   * Excludes revoked records.
   */
  listShares(): ShareInfo[] {
    const now = this.nowFn();
    return this.records
      .filter((r) => r.sessionLockId !== undefined && r.revokedAt === undefined)
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
          issuedAt: r.issuedAt,
          expired: r.expiresAt !== undefined && now >= r.expiresAt,
          maxUses: r.maxUses,
          uses,
          usesRemaining: r.maxUses === undefined ? null : r.maxUses - uses,
        };
      });
  }

  /**
   * Revoke a token by id. Stamps `revokedAt` so `verifyTokenDetailed` returns
   * `{ ok: false, reason: 'revoked' }` and the credential is permanently
   * rejected. `list()` and `listShares()` exclude revoked records. Awaits
   * persist so revocation is durable before the caller responds — a crash
   * must never resurrect a revoked token on reopen.
   *
   * Returns true if a record was revoked, false if the id was unknown or was
   * already revoked.
   */
  async revoke(id: string): Promise<boolean> {
    const rec = this.records.find(
      (r) => r.id === id && r.revokedAt === undefined,
    );
    if (!rec) return false;
    rec.revokedAt = this.nowFn();
    await this.persist();
    return true;
  }

  /**
   * Batch revocation (spec: "Batch revocation" — `POST /rc/tokens/revoke-all`):
   * stamp `revokedAt` on every non-revoked token, except the caller's own token
   * when `exceptTokenId` is given (`{ "except": "self" }`). Already-revoked
   * records are untouched and never appear in `revokedIds`.
   * Returns the revoked ids so the routes layer can write one `token_revoked`
   * audit entry per id — the store is deliberately not coupled to audit.
   * Persists atomically (single persist call after all stamps).
   */
  async revokeAll(
    opts: { exceptTokenId?: string } = {},
  ): Promise<{ revokedIds: string[] }> {
    const revokedIds: string[] = [];
    const now = this.nowFn();
    for (const rec of this.records) {
      if (rec.revokedAt !== undefined) continue; // already revoked
      if (opts.exceptTokenId !== undefined && rec.id === opts.exceptTokenId)
        continue;
      rec.revokedAt = now;
      revokedIds.push(rec.id);
    }
    if (revokedIds.length > 0) await this.persist();
    return { revokedIds };
  }

  // ---------------------------------------------------------------------------
  // CORS origin persistence (wire-protocol: "Browser CORS allowlist derived
  // from pairing").  Origins are stored independently of tokens — revoking the
  // admitting token does NOT remove the origin.
  // ---------------------------------------------------------------------------

  /**
   * Record (or re-record) an admitted browser origin.  Upserts on the origin
   * key so re-admission refreshes the admitting token id and timestamp.
   * Callers are responsible for gating admission via `evaluateAdmission`
   * (cors.ts) and for writing the `cors_origin_admitted` audit event.
   */
  async admitOrigin(
    origin: string,
    byTokenId: string,
    admittedAt: string = new Date().toISOString(),
  ): Promise<CorsOriginRecord> {
    const existing = this.corsRows.findIndex((r) => r.origin === origin);
    const row: CorsOriginRow = {
      origin,
      admittedByTokenId: byTokenId,
      admittedAt,
    };
    if (existing >= 0) {
      this.corsRows[existing] = row;
    } else {
      this.corsRows.push(row);
    }
    await this.persist();
    return { origin, admittedByTokenId: byTokenId, admittedAt, source: 'db' };
  }

  /**
   * List admitted origins: persisted rows (`source: 'db'`) merged with the
   * caller-supplied config origins (`source: 'config'`, never stored,
   * `admittedByTokenId`/`admittedAt` null).  An origin present in BOTH is
   * listed once as the read-only `config` entry (config origins are read-only).
   */
  listOrigins(configOrigins: readonly string[] = []): CorsOriginRecord[] {
    const config = new Set(configOrigins);
    const fromDb: CorsOriginRecord[] = this.corsRows
      .filter((r) => !config.has(r.origin))
      .map((r) => ({
        origin: r.origin,
        admittedByTokenId: r.admittedByTokenId,
        admittedAt: r.admittedAt,
        source: 'db' as const,
      }));
    const fromConfig: CorsOriginRecord[] = [...config].map((origin) => ({
      origin,
      admittedByTokenId: null,
      admittedAt: null,
      source: 'config' as const,
    }));
    return [...fromDb, ...fromConfig];
  }

  /**
   * Remove an admitted origin.  Config-sourced origins are read-only:
   * targeting one returns `{ conflict: 'config' }` (HTTP 409 directing the
   * operator to edit config instead).  Removal works regardless of surviving
   * tokens paired from that origin; the caller writes the `cors_origin_removed`
   * audit event on `{ removed: true }`.
   */
  async removeOrigin(
    origin: string,
    configOrigins: readonly string[] = [],
  ): Promise<RemoveOriginResult> {
    if (configOrigins.includes(origin)) return { conflict: 'config' };
    const idx = this.corsRows.findIndex((r) => r.origin === origin);
    if (idx < 0) return { notFound: true };
    this.corsRows.splice(idx, 1);
    await this.persist();
    return { removed: true };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = {
      tokens: this.records,
      corsOrigins: this.corsRows,
    };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
