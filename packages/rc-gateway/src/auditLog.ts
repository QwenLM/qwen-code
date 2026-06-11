/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export type AuditAction =
  | 'pairing_redeemed'
  | 'token_minted'
  | 'token_revoked'
  | 'auth_failed'
  | 'scope_denied'
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
  | 'session_lineage_read';

/** Runtime list of valid actions (for validating query params). */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'pairing_redeemed',
  'token_minted',
  'token_revoked',
  'auth_failed',
  'scope_denied',
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
  /** Small extras (granted scopes, required scope, request path). No secrets. */
  detail?: Record<string, unknown>;
}

/** A persisted entry: an AuditEntry plus the stamped timestamp. */
export type AuditRecord = AuditEntry & { ts: number };

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

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n < 1) return 100;
  return Math.min(Math.trunc(n), 1000);
}

/**
 * Append-only, best-effort audit log with size-based rotation. record() never
 * throws; query() reads the live file plus rotated archives, newest-first.
 */
export class AuditLog implements AuditRecorder, AuditReader {
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  /** Serializes writes so concurrent records can't interleave through rotation. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly nowFn: () => number = Date.now,
    opts: { maxBytes?: number; maxFiles?: number } = {},
  ) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  }

  async record(entry: AuditEntry): Promise<void> {
    // Serialize writes: concurrent fire-and-forget record() calls must not
    // interleave through rotation's archive-shift (which would clobber an
    // archive and lose history). doRecord never rejects, so the chain never
    // rejects — the never-throw contract is preserved.
    this.writeChain = this.writeChain.then(() => this.doRecord(entry));
    return this.writeChain;
  }

  private async doRecord(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.rotateIfNeeded();
      const line = JSON.stringify({ ts: this.nowFn(), ...entry }) + '\n';
      await appendFile(this.filePath, line, { mode: 0o600 });
    } catch (err) {
      // Best-effort: audit failure must not affect the request path.
      // eslint-disable-next-line no-console
      console.warn('audit record failed:', err);
    }
  }

  async query(q: AuditQuery = {}): Promise<AuditRecord[]> {
    const files = [this.filePath];
    for (let i = 1; i <= this.maxFiles; i++) {
      files.push(`${this.filePath}.${i}`);
    }
    const rows: AuditRecord[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue; // missing file → skip
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

  /** Rotate when the live file is at/over maxBytes. Best-effort; never throws. */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const s = await stat(this.filePath);
      if (s.size < this.maxBytes) return;
    } catch {
      return; // no live file yet
    }
    try {
      await unlink(`${this.filePath}.${this.maxFiles}`).catch(() => {});
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        await rename(
          `${this.filePath}.${i}`,
          `${this.filePath}.${i + 1}`,
        ).catch(() => {});
      }
      await rename(this.filePath, `${this.filePath}.1`).catch(() => {});
    } catch {
      // swallow — keep writing to the current file
    }
  }
}
