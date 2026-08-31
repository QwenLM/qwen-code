/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers shared by every BackendAdaptor: wire-shape munging that both the
 * qwen serve adaptor and the ACP adaptor need — permission-option
 * classification, tool-call title text, and clamped summaries. Extracted
 * from qwen-code-adaptor.ts verbatim; keep both adaptors importing from
 * here rather than re-deriving the rules.
 */

import type { PermissionOption } from './types.js';

export type PermissionOptionKind = PermissionOption['kind'];

export const MAX_SUMMARY_CHARS = 4_000;
export const MAX_DETAIL_CHARS = 48_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map one wire permission option to the adaptor's kind + escalation.
 *
 * Both qwen serve and ACP stamp every option with the structured `kind`
 * (`allow_once` | `allow_always` | `reject_once` | `reject_always` — see
 * `toPermissionOptions` in packages/cli acp-integration/permissionUtils.ts);
 * that is authoritative when present. An unknown structured kind fails
 * closed to 'other'. The word heuristics run only when the backend omitted
 * the field entirely.
 */
export function classifyOption(
  optionId: string,
  name: string | undefined,
  wireKind: string | undefined,
): { kind: PermissionOptionKind; escalation?: 'once' | 'always' } {
  switch (wireKind) {
    case 'allow_once':
      return { kind: 'proceed', escalation: 'once' };
    case 'allow_always':
      return { kind: 'proceed', escalation: 'always' };
    case 'reject_once':
      return { kind: 'reject', escalation: 'once' };
    case 'reject_always':
      return { kind: 'reject', escalation: 'always' };
    default:
      break;
  }
  // Fail closed: a structured kind we do not understand must not be votable
  // through a bare "allow"/"deny".
  if (wireKind !== undefined) return { kind: 'other' };
  // Fallback for backends that omit the structured kind. Snake/kebab ids
  // ("proceed_once") must split into words — `\b` treats an underscore as a
  // word character and would never match inside them.
  const haystack = `${optionId} ${name ?? ''}`
    .toLowerCase()
    .replace(/[_-]/g, ' ');
  const escalation = /\balways\b/.test(haystack)
    ? ('always' as const)
    : /\bonce\b/.test(haystack)
      ? ('once' as const)
      : undefined;
  // Word boundaries matter: a bare /no/ would match inside "notify" and
  // misroute an allow vote to a reject option.
  if (/\b(allow|proceed|approve|yes|accept)\b/.test(haystack)) {
    return { kind: 'proceed', ...(escalation ? { escalation } : {}) };
  }
  if (/\b(deny|reject|refuse|no|cancel)\b/.test(haystack)) {
    return { kind: 'reject', ...(escalation ? { escalation } : {}) };
  }
  return { kind: 'other' };
}

/**
 * The narrowest option of the wanted kind. A bare voice "allow" must take
 * the one-shot grant, never persist an always-allow rule (serve offers
 * [proceed_always_project, proceed_always_user, proceed_once, cancel] —
 * first-match would pick the project-wide rule).
 */
export function pickLeastEscalating(
  options: readonly PermissionOption[],
  wanted: PermissionOptionKind,
): PermissionOption | undefined {
  const rank = (option: PermissionOption): number =>
    option.escalation === 'once' ? 0 : option.escalation === undefined ? 1 : 2;
  let best: PermissionOption | undefined;
  for (const candidate of options) {
    if (candidate.kind !== wanted) continue;
    if (best === undefined || rank(candidate) < rank(best)) best = candidate;
  }
  return best;
}

export function describeToolCall(toolCall: unknown): string {
  if (!isRecord(toolCall)) return 'a tool call';
  const name = typeof toolCall['name'] === 'string' ? toolCall['name'] : '';
  const command =
    typeof toolCall['command'] === 'string' ? toolCall['command'] : '';
  const title = typeof toolCall['title'] === 'string' ? toolCall['title'] : '';
  const detail = command || title;
  if (name && detail) return `${name}: ${detail}`;
  return name || detail || 'a tool call';
}

/**
 * Slice the last `max` UTF-16 units, snapping the cut off a split surrogate
 * pair: a cut landing between the halves would lead with a lone low
 * surrogate that renders/speaks as U+FFFD.
 */
export function tailSlice(text: string, max: number): string {
  let start = text.length - max;
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return text.slice(start);
}

export function clampTail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${tailSlice(trimmed, max)}`;
}

/**
 * One clean line for a tool-call title: first line only, terminal control
 * sequences stripped. Minimal inline of core's stripTerminalControlSequences
 * (packages/core utils/terminalSafe.ts) — the monolith's voice consumer
 * applied the same guard before titles reached the realtime model
 * (live-session-coordinator.ts), and neither acp-bridge nor the daemon
 * sanitizes upstream.
 */
export function sanitizeTitleLine(title: string): string {
  const firstLine = title.split(/\r?\n/, 1)[0] ?? '';
  return (
    firstLine
      // OSC: ESC ] ... (BEL | ST)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ params intermediates final
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // SS2/SS3/DCS leaders
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[NOP]/g, '')
      // Remaining C0 controls + DEL + C1 controls
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
      .trim()
  );
}
