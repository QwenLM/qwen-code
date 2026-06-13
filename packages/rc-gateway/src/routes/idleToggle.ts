/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import type { IdleSessionToggles } from '../idle/sessionToggles.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * POST /rc/session/:id/idle-suggest-toggle — set a session's idle-suggestion
 * override (`add-idle-suggestions` spec: "Per-session toggle", write scope). Body
 * `{ enabled: boolean }`. `false` disables idle suggestions for this session;
 * `true` reverts it to the global default (it can NARROW but never widen past the
 * global egress gate — see {@link IdleSessionToggles}). The override lives for the
 * session lifetime (in-memory).
 *
 * Synchronous (no IO) — no async-throw surface, so no self-catch wrapper needed.
 */
export function createIdleToggleRoute(
  toggles: IdleSessionToggles,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res) => {
    const id = req.params.id;
    if (!isValidSessionId(id)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      res
        .status(400)
        .json({ error: '`enabled` must be a boolean', code: 'invalid_toggle' });
      return;
    }
    toggles.set(id, body.enabled);
    // Count/flag only — never transcript content.
    void audit?.record({
      action: 'idle_toggle_set',
      actorTokenId: req.rcClient?.id,
      target: id,
      detail: { enabled: body.enabled },
    });
    res.status(200).json({ sessionId: id, enabled: body.enabled });
  };
}

/**
 * Runtime snapshot the idle `/suggest status` route needs from the boot wiring
 * (cli.ts owns the live config + rate-limiter). `globalEnabled` is the idle.yaml
 * master switch (read live); `remainingThisHour` is the session's unconsumed
 * rolling-hour budget. Returns `undefined` when idle suggestions aren't wired at
 * all (no model creds) → the route reports `available:false`.
 */
export type IdleStatusResolver = (sessionId: string) =>
  | {
      globalEnabled: boolean;
      maxSuggestionsPerHour: number;
      remainingThisHour: number;
    }
  | undefined;

/**
 * GET /rc/session/:id/idle-suggest-toggle — report a session's EFFECTIVE idle
 * state (`add-idle-suggestions` spec: "`/suggest status` reports state"). The
 * effective `enabled` combines the global egress gate with the per-session
 * override: `globalEnabled && override !== false` (a `true` override can't widen
 * past a global-off — see {@link IdleSessionToggles}). Also reports
 * `maxSuggestionsPerHour` and `remainingThisHour`. (The spec's `idleAfterSec` is
 * omitted by design — this fork detects idle via the pump's active-prompt edge,
 * not a timer.) Read-only, synchronous.
 */
export function createIdleStatusRoute(
  toggles: IdleSessionToggles,
  resolveStatus: IdleStatusResolver,
): RequestHandler {
  return (req, res) => {
    const id = req.params.id;
    if (!isValidSessionId(id)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const snapshot = resolveStatus(id);
    if (!snapshot) {
      // Idle suggestions are not wired on this gateway (no model creds).
      res.status(200).json({ sessionId: id, enabled: false, available: false });
      return;
    }
    const override = toggles.get(id);
    res.status(200).json({
      sessionId: id,
      available: true,
      enabled: snapshot.globalEnabled && override !== false,
      maxSuggestionsPerHour: snapshot.maxSuggestionsPerHour,
      remainingThisHour: snapshot.remainingThisHour,
    });
  };
}
