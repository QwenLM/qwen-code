/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Append-only JSONL audit log with daily rotation and prevHash chain.
 *
 * Spec: openspec/changes/add-remote-control/specs/pairing-auth/spec.md
 *   "Requirement: Audit log integrity"
 *     - Every line carries `v: 1` and `prevHash`: lowercase hex SHA-256 of
 *       the preceding line's exact bytes (excluding the trailing `\n`). The
 *       first line of each file hashes the literal string `genesis:<filename>`
 *       (e.g. `genesis:audit-2026-07-06.log`). Each file's chain is
 *       independent - daily rotation starts a fresh chain.
 *     - Files are created mode 0600 inside a 0700 directory.
 *     - `AuditLog.verifyChain(dir)` walks ALL retained `audit-*.log` files
 *       and reports the FIRST broken link per failing file.
 *     - Crash recovery: a trailing unterminated partial line is truncated
 *       before the fd is opened for append, so the chain stays valid.
 *
 * Design notes:
 *   - `record()` is async and fire-and-forget safe (never throws).
 *   - Writes are serialised via a promise chain to prevent interleaving.
 *   - Daily rotation is keyed on a `nowDate` injection seam (UTC YYYY-MM-DD),
 *     making rotation testable deterministically without real clock delays.
 *   - The constructor signature `(filePath, nowFn?, opts?)` is preserved from
 *     the previous implementation so existing callers need no changes.
 *     `filePath` drives `dir = dirname(filePath)`; actual files are named
 *     `audit-YYYY-MM-DD.log` inside that directory.
 *   - Synchronous fs is used for the write path; the public API is async.
 *   - The constructor attempts dir creation but swallows errors (e.g. when
 *     `dir` is actually a file) - the write failure is caught in doRecord().
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type AuditAction =
  | 'pairing_redeemed'
  | 'token_minted'
  | 'token_revoked'
  | 'auth_failed'
  | 'scope_denied'
  | 'token_expired_max_age'
  | 'session_created'
  | 'session_attached'
  | 'session_detached'
  | 'permission_voted'
  | 'prompt_sent'
  | 'push_subscribed'
  | 'push_unsubscribed'
  | 'push_sent'
  | 'push_send_failed'
  | 'push_subscription_expired'
  | 'policy_decision'
  | 'policy_reloaded'
  | 'policy_reload_failed'
  | 'push_suppressed'
  | 'push_rate_limited'
  | 'routing_snoozed'
  | 'routing_unsnoozed'
  | 'routing_reloaded'
  | 'routing_reload_failed'
  | 'push_prefs_updated'
  | 'share_created'
  | 'share_revoked'
  | 'share_redeemed'
  | 'share_exhausted'
  | 'search_performed'
  | 'command_collision_workspace_wins'
  | 'slash_command_invoked'
  | 'slash_command_parse_failed'
  | 'slash_command_arg_missing'
  | 'session_forked'
  | 'session_lineage_read'
  | 'session_list_read'
  | 'idle_suggested'
  | 'idle_suggest_rate_limited'
  | 'idle_config_parse_failed'
  | 'idle_toggle_set'
  | 'bridge_registered'
  | 'bridge_registration_rejected'
  | 'bridge_deregistered'
  | 'sub_actor_rate_limited'
  | 'sub_actor_banned'
  | 'sub_actor_unbanned'
  | 'bridge_invite_minted'
  | 'bridge_invite_redeemed'
  | 'bridge_invite_redeem_failed'
  | 'bridge_heartbeat_unknown'
  | 'bridge_stale_deregistered'
  | 'rate_table_parse_failed'
  | 'rate_table_miss'
  | 'apns_registered'
  | 'apns_subscription_removed'
  | 'push_routed'
  | 'session_ended'
  | 'agent_spawned'
  | 'agent_message_sent'
  | 'agent_cancelled'
  | 'hook_ingest_rejected'
  | 'workflow_started'
  | 'workflow_cancelled'
  | 'session_rewound'
  | 'review_started'
  | 'review_cancelled'
  | 'session_approval_mode_set'
  | 'policy_explained'
  | 'session_resumed'
  | 'cors_denied'
  | 'cors_origin_admitted'
  | 'cors_origin_removed';

/** Runtime list of valid actions (for validating query params). */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'pairing_redeemed',
  'token_minted',
  'token_revoked',
  'auth_failed',
  'scope_denied',
  'token_expired_max_age',
  'session_attached',
  'session_detached',
  'permission_voted',
  'prompt_sent',
  'push_subscribed',
  'push_unsubscribed',
  'push_sent',
  'push_send_failed',
  'push_subscription_expired',
  'policy_decision',
  'policy_reloaded',
  'policy_reload_failed',
  'push_suppressed',
  'push_rate_limited',
  'routing_snoozed',
  'routing_unsnoozed',
  'routing_reloaded',
  'routing_reload_failed',
  'push_prefs_updated',
  'share_created',
  'share_revoked',
  'share_redeemed',
  'share_exhausted',
  'search_performed',
  'command_collision_workspace_wins',
  'slash_command_invoked',
  'slash_command_parse_failed',
  'slash_command_arg_missing',
  'session_forked',
  'session_lineage_read',
  'session_list_read',
  'idle_suggested',
  'idle_suggest_rate_limited',
  'idle_config_parse_failed',
  'idle_toggle_set',
  'bridge_registered',
  'bridge_registration_rejected',
  'bridge_deregistered',
  'sub_actor_rate_limited',
  'sub_actor_banned',
  'sub_actor_unbanned',
  'bridge_invite_minted',
  'bridge_invite_redeemed',
  'bridge_invite_redeem_failed',
  'bridge_heartbeat_unknown',
  'bridge_stale_deregistered',
  'rate_table_parse_failed',
  'rate_table_miss',
  'apns_registered',
  'apns_subscription_removed',
  'push_routed',
  'session_ended',
  'agent_spawned',
  'agent_message_sent',
  'agent_cancelled',
  'hook_ingest_rejected',
  'workflow_started',
  'workflow_cancelled',
  'session_rewound',
  'review_started',
  'review_cancelled',
  'session_approval_mode_set',
  'policy_explained',
  'session_resumed',
  'cors_denied',
  'cors_origin_admitted',
  'cors_origin_removed',
];

export interface AuditEntry {
  action: AuditAction;
  /** Resolved caller token id, when known. Never a raw token or hash. */
  actorTokenId?: string;
  /** Affected resource: a token id or a session id. */
  target?: string;
  /**
   * The share token id this action was taken under (a token id; never secret).
   * Set on share-lifecycle rows and on actions a guest takes via a share.
   */
  shareId?: string;
  /** The operator-chosen share label, denormalized so it survives token expiry. */
  shareLabel?: string;
  /**
   * The underlying human a BRIDGE token acted on behalf of (e.g. `telegram:alice`),
   * asserted via `X-RC-SubActor` and resolved only for bridge tokens. Lets the
   * audit answer "who actually pressed the button", not just "which bridge".
   * Flows onto the `/rc/events` SSE frame automatically (the frame serializes the
   * whole record).
   */
  subActor?: string;
  /** Small extras (granted scopes, required scope, request path). No secrets. */
  detail?: Record<string, unknown>;
}

/** A persisted entry: an AuditEntry plus stamped fields. */
export type AuditRecord = AuditEntry & {
  ts: number;
  /** Schema version. Always 1. */
  v: 1;
  /** SHA-256 of the previous line's bytes (no trailing newline), or genesis hash. */
  prevHash: string;
};

export interface AuditQuery {
  /** Max rows returned. Default 100, capped at 1000. */
  limit?: number;
  /** Include only entries with ts >= since (epoch ms). */
  since?: number;
  /** Exact action match. */
  action?: AuditAction;
  /** Exact actorTokenId match. */
  actor?: string;
  /**
   * Collect a share's whole lifecycle: matches a row whose top-level `shareId`,
   * `actorTokenId` (a guest's actor id IS the share id), or `detail.shareId`
   * (historical owner-side create/revoke rows) equals this id.
   */
  shareId?: string;
}

/** Write side. */
export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
}

/** Read side. */
export interface AuditReader {
  query(q: AuditQuery): Promise<AuditRecord[]>;
}

/** Result of {@link AuditLog.verifyChain} over a directory of audit files. */
export interface VerifyChainResult {
  ok: boolean;
  /** FIRST broken chain link per failing file (absolute path, 1-based line). */
  failures: Array<{ file: string; line: number }>;
}

/** Result of {@link AuditLog.recover} over a single audit file. */
export interface RecoverResult {
  /** Whether any bytes were truncated (i.e. a torn final line was found). */
  truncated: boolean;
  /** Number of bytes removed from the tail of the file. */
  removedBytes: number;
  /** Path that was inspected. */
  filePath: string;
}

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n < 1) return 100;
  return Math.min(Math.trunc(n), 1000);
}

/** Lowercase hex SHA-256. */
function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** UTC `YYYY-MM-DD` for a given Date. */
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Append-only, best-effort audit log with daily rotation and prevHash chain.
 *
 * Constructor: `new AuditLog(filePath, nowFn?, opts?)` - preserves the
 * existing interface. `filePath` supplies the base directory via
 * `dirname(filePath)`; the actual log files are named `audit-YYYY-MM-DD.log`
 * inside that directory.
 *
 * `record()` is async and fire-and-forget safe (never throws).
 * `query()` reads all `audit-*.log` files in the directory.
 */
export class AuditLog implements AuditRecorder, AuditReader {
  /** Base directory where `audit-YYYY-MM-DD.log` files are written. */
  private readonly dir: string;

  /**
   * Returns the current timestamp in epoch ms. Used for the `ts` field.
   * When `opts.nowDate` is absent the Date for rotation is derived from the
   * same value (avoids double-advance of a monotonic test counter).
   */
  private readonly nowMs: () => number;

  /**
   * Optional injected Date clock for daily rotation (test seam).
   * When absent, `doRecord` derives the Date from the already-computed `ts`.
   */
  private readonly nowDateOverride: (() => Date) | undefined;

  /** Optional live sink, invoked once per durably-appended record. */
  private readonly onRecord: ((record: AuditRecord) => void) | undefined;

  /** Serializes writes so concurrent record() calls do not interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  /** Currently open fd and the date key it was opened for (lazy). */
  private fd: number | null = null;
  private openDateKey: string | null = null;

  /**
   * `prevHash` for the NEXT line appended to the currently open file.
   * Seeded from the file's last surviving line on open/rotation, or the
   * genesis string when the file is new/empty.
   */
  private chainPrevHash = '';

  constructor(
    filePath: string,
    nowFn: () => number = Date.now,
    opts: {
      /** Override the Date clock for daily rotation (test seam). */
      nowDate?: () => Date;
      onRecord?: (record: AuditRecord) => void;
      /** @deprecated - no longer used; daily rotation replaces size rotation. */
      maxBytes?: number;
      /** @deprecated - no longer used; daily rotation replaces size rotation. */
      maxFiles?: number;
    } = {},
  ) {
    this.dir = dirname(filePath);
    this.nowMs = nowFn;
    this.nowDateOverride = opts.nowDate;
    this.onRecord = opts.onRecord;
    // Best-effort: create the audit dir (mode 0700 per spec). Swallow errors
    // so callers whose dir path is a file (the "never throws" test case)
    // do not see a constructor throw. The actual write failure is caught in
    // doRecord(), which never propagates.
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      // swallow - doRecord() will catch the write failure gracefully
    }
  }

  async record(entry: AuditEntry): Promise<void> {
    // Serialize writes: concurrent fire-and-forget calls must not interleave.
    // doRecord never rejects, so the chain never rejects.
    this.writeChain = this.writeChain.then(() => this.doRecord(entry));
    return this.writeChain;
  }

  private async doRecord(entry: AuditEntry): Promise<void> {
    try {
      // Call nowMs() exactly ONCE per record. Derive the Date from the same
      // value so a monotonic test counter (e.g. `() => ++t`) advances by 1,
      // not 2 (which would happen if nowDateFn also called nowMs()).
      const ts = this.nowMs();
      const when = this.nowDateOverride ? this.nowDateOverride() : new Date(ts);
      const key = dateKey(when);
      // Ensure the fd is open for today's file (rotates if day changed).
      const fd = this.fdFor(key);
      // Build the full record with v:1, ts, and prevHash.
      const record: AuditRecord = {
        ...entry,
        v: 1,
        ts,
        prevHash: this.chainPrevHash,
      };
      const line = JSON.stringify(record) + '\n';
      const buf = Buffer.from(line, 'utf8');
      // Single synchronous write of the whole line. With O_APPEND each write
      // positions itself at EOF - closest to atomic for a local fs.
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written, null);
      }
      // Advance the chain: hash covers the line bytes minus the trailing newline.
      this.chainPrevHash = sha256Hex(buf.subarray(0, buf.length - 1));
      // Broadcast ONLY after a successful append.
      if (this.onRecord) {
        try {
          this.onRecord(record);
        } catch {
          // A sink failure is non-fatal to the audit write.
        }
      }
    } catch (err) {
      // Best-effort: audit failure must not affect the request path.
      // eslint-disable-next-line no-console
      console.warn('audit record failed:', err);
    }
  }

  /**
   * Ensure an fd is open for `key`s file. Closes the previous fd when the
   * day key changes (rotation). Auto-recovers a torn tail before seeding the
   * hash chain so the chain stays valid without external intervention.
   */
  private fdFor(key: string): number {
    if (this.fd !== null && this.openDateKey === key) {
      return this.fd;
    }
    // Close the previous fd (day boundary rotation).
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // best-effort
      }
      this.fd = null;
      this.openDateKey = null;
    }
    const fileName = 'audit-' + key + '.log';
    const filePath = join(this.dir, fileName);
    // Auto-recover: truncate any trailing partial line before seeding the chain.
    if (existsSync(filePath)) {
      const size = statSync(filePath).size;
      if (size > 0) {
        const cutAt = truncateToLastCompleteLine(filePath, size);
        if (cutAt < size) {
          truncateSync(filePath, cutAt);
        }
      }
    }
    // Seed the hash chain from the file's surviving last complete line, or the
    // genesis string when the file is new/empty.
    const lastLine = lastCompleteLineBytes(filePath);
    this.chainPrevHash =
      lastLine === null
        ? sha256Hex('genesis:' + fileName)
        : sha256Hex(lastLine);
    // O_APPEND: each write is positioned at the current end of file.
    // Mode 0600 per spec.
    this.fd = openSync(filePath, 'a', 0o600);
    this.openDateKey = key;
    return this.fd;
  }

  async query(q: AuditQuery = {}): Promise<AuditRecord[]> {
    // Collect all audit-*.log files in the dir, sorted lexicographically
    // (date order). Read all, accumulate rows, then filter/sort/slice.
    let fileNames: string[] = [];
    try {
      fileNames = readdirSync(this.dir)
        .filter((f) => /^audit-.*\.log$/.test(f))
        .sort();
    } catch {
      // dir does not exist yet (or is a file - the "never throws" scenario)
    }
    const rows: AuditRecord[] = [];
    for (const name of fileNames) {
      const filePath = join(this.dir, name);
      let text: string;
      try {
        text = await readFile(filePath, 'utf8');
      } catch {
        continue; // missing/unreadable file - skip
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as AuditRecord;
          if (obj && typeof obj.ts === 'number') rows.push(obj);
        } catch {
          // skip corrupt line
        }
      }
    }
    let out = rows;
    if (q.since !== undefined) out = out.filter((r) => r.ts >= q.since!);
    if (q.action !== undefined) out = out.filter((r) => r.action === q.action);
    if (q.actor !== undefined)
      out = out.filter((r) => r.actorTokenId === q.actor);
    if (q.shareId !== undefined)
      out = out.filter(
        (r) =>
          r.shareId === q.shareId ||
          r.actorTokenId === q.shareId ||
          (typeof r.detail?.shareId === 'string' &&
            r.detail.shareId === q.shareId),
      );
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, clampLimit(q.limit));
  }

  /**
   * Crash-recovery pass over a single audit file. Detects a trailing
   * unterminated partial line and truncates the file back to the end of the
   * last complete, valid line.
   *
   * Note: `record()` calls this automatically on every file open (via `fdFor`).
   * This public static method exists so callers can detect whether truncation
   * occurred and emit `wal_truncated_audit` notifications.
   */
  static recover(filePath: string): RecoverResult {
    const base: RecoverResult = {
      truncated: false,
      removedBytes: 0,
      filePath,
    };
    if (!existsSync(filePath)) {
      return base;
    }
    const size = statSync(filePath).size;
    if (size === 0) {
      return base;
    }
    const cutAt = truncateToLastCompleteLine(filePath, size);
    if (cutAt === size) {
      return base;
    }
    truncateSync(filePath, cutAt);
    return { truncated: true, removedBytes: size - cutAt, filePath };
  }

  /**
   * Verify the per-file prevHash chains of ALL retained `audit-*.log` files
   * in `dir`. Each file's chain is independent: line 1 must carry
   * `prevHash == sha256("genesis:<filename>")` and every subsequent line must
   * hash the previous line's exact bytes (excluding the trailing newline).
   *
   * Reports the FIRST broken link per failing file as
   * `{ file: <absolute path>, line: <1-based> }`.
   *
   * A trailing unterminated partial line is silently ignored (recovery domain).
   * Unknown extra fields on a line are tolerated (schema v1 forward compat).
   *
   * This is the library behind the `qwen rc audit verify` CLI.
   */
  static verifyChain(dir: string): VerifyChainResult {
    const failures: Array<{ file: string; line: number }> = [];
    if (!existsSync(dir)) {
      return { ok: true, failures };
    }
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((f) => /^audit-.*\.log$/.test(f))
        .sort();
    } catch {
      return { ok: true, failures };
    }
    for (const name of names) {
      const filePath = join(dir, name);
      let bytes: Buffer;
      try {
        bytes = readFileSync(filePath);
      } catch {
        continue;
      }
      let expected = sha256Hex('genesis:' + name);
      let lineNo = 0;
      let start = 0;
      while (start < bytes.length) {
        const nl = bytes.indexOf(0x0a, start);
        if (nl === -1) {
          // Trailing partial line (no newline): recovery domain, not ours.
          break;
        }
        lineNo += 1;
        const lineBytes = bytes.subarray(start, nl);
        start = nl + 1;
        let prevHash: unknown;
        try {
          const parsed = JSON.parse(lineBytes.toString('utf8')) as {
            prevHash?: unknown;
          };
          prevHash = parsed.prevHash;
        } catch {
          failures.push({ file: filePath, line: lineNo });
          break;
        }
        if (prevHash !== expected) {
          failures.push({ file: filePath, line: lineNo });
          break;
        }
        expected = sha256Hex(lineBytes);
      }
    }
    return { ok: failures.length === 0, failures };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine the byte offset at which `filePath` should be truncated so it
 * ends at the last complete, valid (JSON-parseable) newline-terminated line.
 * Returns the current `size` unchanged when the file is already clean.
 */
function truncateToLastCompleteLine(filePath: string, size: number): number {
  // Read a bounded tail window large enough to contain the final line(s).
  // Grow the window until we find a newline boundary or reach start of file.
  let windowSize = Math.min(size, 64 * 1024);
  let buf: Buffer;
  let windowStart: number;
  for (;;) {
    windowStart = size - windowSize;
    buf = readTailBytes(filePath, windowStart, windowSize);
    const hasInteriorNewline = buf.lastIndexOf(0x0a, buf.length - 2) !== -1;
    if (hasInteriorNewline || windowStart === 0) {
      break;
    }
    windowSize = Math.min(size, windowSize * 2);
  }

  const lastNewlineInWindow = buf.lastIndexOf(0x0a);

  if (lastNewlineInWindow === buf.length - 1) {
    // File ends with a newline: the final line is terminated. Validate it.
    const prevNewline = buf.lastIndexOf(0x0a, buf.length - 2);
    const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
    const lineBytes = buf.subarray(lineStart, buf.length - 1);
    if (isValidJsonLine(lineBytes)) {
      // Clean tail; no truncation needed.
      return size;
    }
    // Final terminated line is corrupt: cut back to end of previous line.
    return prevNewline === -1 ? 0 : windowStart + prevNewline + 1;
  }

  // File does NOT end with a newline: trailing partial line.
  if (lastNewlineInWindow === -1 && windowStart === 0) {
    return 0;
  }
  return windowStart + lastNewlineInWindow + 1;
}

/**
 * Bytes of the last complete (newline-terminated) line in `filePath`,
 * excluding the trailing newline, or `null` when the file is missing/empty or
 * contains no terminated line. A trailing unterminated partial line is skipped.
 */
function lastCompleteLineBytes(filePath: string): Buffer | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const size = statSync(filePath).size;
  if (size === 0) {
    return null;
  }
  let windowSize = Math.min(size, 64 * 1024);
  for (;;) {
    const windowStart = size - windowSize;
    const buf = readTailBytes(filePath, windowStart, windowSize);
    const endsWithNewline = buf[buf.length - 1] === 0x0a;
    const contentEnd = endsWithNewline ? buf.length - 1 : buf.lastIndexOf(0x0a);
    if (contentEnd === -1) {
      if (windowStart === 0) {
        // Whole file is a single unterminated partial line.
        return null;
      }
      windowSize = Math.min(size, windowSize * 2);
      continue;
    }
    const prevNewline =
      contentEnd === 0 ? -1 : buf.lastIndexOf(0x0a, contentEnd - 1);
    if (prevNewline === -1 && windowStart > 0) {
      windowSize = Math.min(size, windowSize * 2);
      continue;
    }
    const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
    return Buffer.from(buf.subarray(lineStart, contentEnd));
  }
}

/** Read `length` bytes starting at `start` from `filePath`. */
function readTailBytes(
  filePath: string,
  start: number,
  length: number,
): Buffer {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** True iff `bytes` (a single line content, no trailing newline) is valid JSON. */
function isValidJsonLine(bytes: Buffer): boolean {
  const text = bytes.toString('utf8').trim();
  if (text.length === 0) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
