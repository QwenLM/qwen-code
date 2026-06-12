/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { selectAllowOnceOptionId } from '../permissionOptions.js';
import type { DigestSummary } from './digest.js';

/**
 * Metadata-only push payload. Deliberately carries NO tool args, file paths,
 * or prompt text — only enough to render a notification and deep-link back to
 * the session. `url` carries no token; `summary` is capped at 140 chars.
 */
export interface PushPayload {
  v: 1;
  kind: string;
  sessionId: string;
  sessionName?: string;
  summary: string; // <=140
  url: string; // '/ui/?session=<id>'
  requestId?: string; // present for permission.required
  approveOptionId?: string; // opaque option id for inline approve; not sensitive
}

const MAX_SUMMARY = 140;

/** Truncate to <=140 chars, ending with a single-char ellipsis if cut. */
function truncate(s: string): string {
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + '…' : s;
}

/** Build the deep link for a session. No token, no secrets. */
function sessionUrl(sessionId: string): string {
  return '/ui/?session=' + encodeURIComponent(sessionId);
}

/**
 * Map a daemon event to a metadata-only push payload, or null if the event is
 * not notifiable this cycle. `data` is read defensively with optional chaining;
 * only whitelisted, non-sensitive fields ever reach the payload.
 */
export function buildPayload(
  event: { type: string; data: unknown },
  ctx: { sessionId: string; sessionName?: string },
): PushPayload | null {
  const data = (event.data ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case 'permission_request': {
      const toolCall = data.toolCall as
        | { name?: unknown; title?: unknown }
        | undefined;
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 ? v : undefined;
      const toolName: string =
        str(toolCall?.name) ||
        str(toolCall?.title) ||
        str(data.toolName) ||
        'a tool call';
      const requestId = str(data.requestId);
      // The one-time-approve option (kind 'allow_once'), NOT options[0] (which is
      // usually 'allow_always' and would persist a standing grant). Absent → the
      // SW falls back to opening the app instead of casting an inline vote.
      const approveOptionId = selectAllowOnceOptionId(data.options);
      return {
        v: 1,
        kind: 'permission.required',
        sessionId: ctx.sessionId,
        ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
        summary: truncate('Permission needed: ' + toolName),
        url: sessionUrl(ctx.sessionId),
        ...(requestId ? { requestId } : {}),
        ...(approveOptionId ? { approveOptionId } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Build the end-of-quiet-window "while you were away" digest payload (webpush
 * D4) from accumulated suppressed-while-quiet counts. Metadata-only: it carries
 * ONLY the total + per-kind counts (kind enum names), never session content, and
 * `sessionId:''` because a digest is not tied to a single session. `sw.js`
 * renders any `v:1` push generically (no action buttons for an unknown kind).
 */
export function buildDigestPayload(summary: DigestSummary): PushPayload {
  const n = summary.total;
  return {
    v: 1,
    kind: 'digest',
    sessionId: '',
    summary: truncate(
      `${n} notification${n === 1 ? '' : 's'} while you were away`,
    ),
    url: '/ui/',
  };
}
