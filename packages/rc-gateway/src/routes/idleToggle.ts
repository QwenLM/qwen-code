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
 * Runtime snapshot the idle toggle/status routes need from the boot wiring
 * (cli.ts owns the live config + rate-limiter). `globalEnabled` is the idle.yaml
 * master switch (read live); `remainingThisHour` is the session's unconsumed
 * rolling-hour budget. Returns `undefined` when idle suggestions aren't wired at
 * all (no model creds) → the routes report `available:false`.
 */
export type IdleStatusResolver = (sessionId: string) =>
  | {
      globalEnabled: boolean;
      maxSuggestionsPerHour: number;
      remainingThisHour: number;
    }
  | undefined;

/** The single response shape for both the POST and GET toggle endpoints. */
interface IdleStatusBody {
  sessionId: string;
  available: boolean;
  /** EFFECTIVE state: `globalEnabled && override !== false`. */
  enabled: boolean;
  /**
   * The idle.yaml master switch, independent of the per-session override — lets a
   * client show WHY a session is off ("disabled globally, edit idle.yaml" vs "you
   * turned this session off"). Present only when `available`.
   */
  globalEnabled?: boolean;
  maxSuggestionsPerHour?: number;
  remainingThisHour?: number;
}

/**
 * Build the EFFECTIVE idle-state body for a session. POST and GET return the
 * SAME shape so a client that toggles then re-reads sees a coherent answer — in
 * particular, POST `{enabled:true}` under a global-off reports `enabled:false`
 * (the toggle stores the intent but can only NARROW; it never widens past the
 * global egress gate). `available:false` when idle isn't wired (no creds).
 */
function buildIdleStatusBody(
  id: string,
  toggles: IdleSessionToggles,
  resolveStatus: IdleStatusResolver,
): IdleStatusBody {
  const snapshot = resolveStatus(id);
  if (!snapshot) return { sessionId: id, available: false, enabled: false };
  const override = toggles.get(id);
  return {
    sessionId: id,
    available: true,
    enabled: snapshot.globalEnabled && override !== false,
    globalEnabled: snapshot.globalEnabled,
    maxSuggestionsPerHour: snapshot.maxSuggestionsPerHour,
    remainingThisHour: snapshot.remainingThisHour,
  };
}

/**
 * POST /session/:id/idle-suggest-toggle — set a session's idle-suggestion
 * override (`add-idle-suggestions` spec: "Per-session toggle", write scope). Body
 * `{ enabled: boolean }`. `false` disables idle suggestions for this session;
 * `true` reverts it to the global default (it can NARROW but never widen past the
 * global egress gate — see {@link IdleSessionToggles}). The override lives for the
 * session lifetime (in-memory).
 *
 * The store keeps the raw INTENT (so `/suggest on` can undo a prior `/suggest
 * off`, and a session lights up if the operator later flips the global switch),
 * but the RESPONSE reports EFFECTIVE state — identical to the GET status body —
 * so a client never sees `{enabled:true}` while no suggestions can actually fire.
 *
 * Synchronous (no IO) — no async-throw surface, so no self-catch wrapper needed.
 */
export function createIdleToggleRoute(
  toggles: IdleSessionToggles,
  resolveStatus: IdleStatusResolver,
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
    // Count/flag only — never transcript content. Records the stored INTENT.
    void audit?.record({
      action: 'idle_toggle_set',
      actorTokenId: req.rcClient?.id,
      target: id,
      detail: { enabled: body.enabled },
    });
    res.status(200).json(buildIdleStatusBody(id, toggles, resolveStatus));
  };
}

/**
 * GET /session/:id/idle-suggest-toggle — report a session's EFFECTIVE idle
 * state (`add-idle-suggestions` spec: "`/suggest status` reports state"). Returns
 * the same body as the POST route. (The spec's `idleAfterSec` is omitted by
 * design — this fork detects idle via the pump's active-prompt edge, not a
 * timer.) Read-only, synchronous.
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
    res.status(200).json(buildIdleStatusBody(id, toggles, resolveStatus));
  };
}
