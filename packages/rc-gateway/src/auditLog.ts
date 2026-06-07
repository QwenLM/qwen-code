/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type AuditAction =
  | 'pairing_redeemed'
  | 'token_minted'
  | 'token_revoked'
  | 'auth_failed'
  | 'scope_denied'
  | 'session_attached'
  | 'session_detached';

export interface AuditEntry {
  action: AuditAction;
  /** Resolved caller token id, when known. Never a raw token or hash. */
  actorTokenId?: string;
  /** Affected resource: a token id or a session id. */
  target?: string;
  /** Small extras (granted scopes, required scope, request path). No secrets. */
  detail?: Record<string, unknown>;
}

/** Narrow dependency the middlewares/routes depend on (easy to fake in tests). */
export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * Append-only, best-effort audit log. Each record() appends one JSON line via
 * O_APPEND (atomic per line). Never throws — a failed audit write must never
 * delay or break a request.
 */
export class AuditLog implements AuditRecorder {
  constructor(
    private readonly filePath: string,
    private readonly nowFn: () => number = Date.now,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({ ts: this.nowFn(), ...entry }) + '\n';
      await appendFile(this.filePath, line, { mode: 0o600 });
    } catch (err) {
      // Best-effort: audit failure must not affect the request path.
      // eslint-disable-next-line no-console
      console.warn('audit record failed:', err);
    }
  }
}
