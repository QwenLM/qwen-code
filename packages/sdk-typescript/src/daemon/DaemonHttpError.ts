/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thrown for any non-2xx daemon response. `status` and `body` are surfaced
 * so callers can branch on the standard daemon HTTP semantics (404 missing
 * session, 401 bad token, 400 malformed body, 500 agent failure).
 *
 * Extracted to its own module so that transports (e.g. `RestSseTransport`)
 * can import it without pulling in the entire `DaemonClient` module,
 * keeping the browser bundle under budget.
 */
export class DaemonHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'DaemonHttpError';
    this.status = status;
    this.body = body;
  }
}

// Kept local (instead of reusing `isRecord` from `acpTransportUtils.ts` or
// `ui/utils.ts`) so this leaf module stays dependency-free: those modules
// pull the ACP route table / UI helpers into the budgeted browser bundles.
function getErrorBodyRecord(
  body: unknown,
): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * Type guard for the daemon's `GET /session/:id/subagents/:toolCallId` 404
 * contract: `{ code: 'session_not_found', sessionId, toolCallId? }`. Pass
 * `toolCallId` to require the body to identify that specific missing agent
 * (a session-level 404 carries no identifying `toolCallId`); omit it to
 * accept both.
 */
export function isSubagentSessionNotFound(
  error: unknown,
  toolCallId?: string,
): boolean {
  if (!(error instanceof DaemonHttpError) || error.status !== 404) {
    return false;
  }
  const body = getErrorBodyRecord(error.body);
  if (body?.['code'] !== 'session_not_found') return false;
  return toolCallId === undefined || body['toolCallId'] === toolCallId;
}

/**
 * Type guard for the session-level variant of that same 404 contract: the
 * daemon could not find the parent session itself, so the body carries
 * `code: 'session_not_found'` with no identifying `toolCallId` (an
 * explicitly `null` id is treated the same as an absent one).
 *
 * A missing parent session is not the only producer: a multi-workspace
 * daemon answers this same shape while the owning workspace entry is
 * merely not active (for example draining before removal, or transitioning
 * to a replacement runtime), which the daemon treats as reversible. Treat
 * this error as recoverable, not as proof the session is permanently gone.
 */
export function isSessionLevelNotFound(error: unknown): boolean {
  if (!(error instanceof DaemonHttpError) || error.status !== 404) {
    return false;
  }
  const body = getErrorBodyRecord(error.body);
  if (body?.['code'] !== 'session_not_found') return false;
  const toolCallId = body['toolCallId'];
  return toolCallId === undefined || toolCallId === null;
}
