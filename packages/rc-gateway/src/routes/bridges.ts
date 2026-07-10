/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { OWNER } from '../scopes.js';
import type {
  BridgeRegistry,
  BridgeRegistration,
  BridgeMarkdownSupport,
} from '../bridges/registry.js';
import type { SubActorBanStore } from '../bridges/subActorBans.js';
import type { InviteStore } from '../bridges/inviteStore.js';
import { parseSubActor } from '../auth.js';

/** Recognized bridge kinds an invite may target (advisory metadata, see below). */
const INVITE_KINDS = new Set(['telegram', 'discord', 'matrix']);
/** A session id is an opaque daemon handle; bound + control-char-free for audit. */
const SESSION_ID_MAX = 256;
/** Spec error text returned verbatim on a bad/expired token (bridges relay it). */
const INVALID_INVITE_MESSAGE = 'Invalid or expired invite token';

/** How often a bridge SHOULD heartbeat (spec default), returned at registration. */
export const HEARTBEAT_INTERVAL_SEC = 60;
/** A bridge is reaped after ~3 missed heartbeats with no register/heartbeat. */
export const BRIDGE_STALE_MS = 3 * HEARTBEAT_INTERVAL_SEC * 1000;

/** Stable bridge id: alphanumeric-led, safe id charset, bounded (audit-safe). */
const BRIDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]*$/;
const BRIDGE_ID_MAX = 128;
const DISPLAY_NAME_MAX = 200;
const MAX_MESSAGE_BYTES_CAP = 100_000_000;
const MAX_MESSAGE_CHARS_CAP = 100_000_000;

/** Reject control characters that could corrupt a JSONL audit line / UI. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** The markdown-support values the registration accepts (anything else → none). */
const MARKDOWN_SUPPORT = new Set<BridgeMarkdownSupport>([
  'full',
  'limited',
  'none',
]);

interface ParsedRegistration {
  id: string;
  displayName: string;
  supportsActions: boolean;
  supportsMarkdown: BridgeMarkdownSupport;
  supportsThreads: boolean;
  supportsEdits: boolean;
  maxMessageBytes: number;
  maxMessageChars: number;
}

/** Validate a registration body. Returns the parsed shape or an error code. */
function parseRegistration(
  body: unknown,
): { ok: true; value: ParsedRegistration } | { ok: false; code: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  const id = typeof b['id'] === 'string' ? b['id'].trim() : '';
  if (!id || id.length > BRIDGE_ID_MAX || !BRIDGE_ID_RE.test(id)) {
    return { ok: false, code: 'invalid_bridge_id' };
  }
  const displayName =
    typeof b['displayName'] === 'string' ? b['displayName'].trim() : '';
  if (
    !displayName ||
    displayName.length > DISPLAY_NAME_MAX ||
    CONTROL_RE.test(displayName)
  ) {
    return { ok: false, code: 'invalid_display_name' };
  }
  // Capability flags default conservatively (the safest assumption is "this chat
  // service can't render actions/threads/edits, and shows plain text" until the
  // bridge says otherwise). supportsMarkdown is an enum; an unrecognized value
  // (incl. a stale boolean from an old client) falls back to 'none'.
  const supportsActions = b['supportsActions'] === true;
  const supportsThreads = b['supportsThreads'] === true;
  const supportsEdits = b['supportsEdits'] === true;
  const md = b['supportsMarkdown'];
  const supportsMarkdown: BridgeMarkdownSupport = MARKDOWN_SUPPORT.has(
    md as BridgeMarkdownSupport,
  )
    ? (md as BridgeMarkdownSupport)
    : 'none';
  // maxMessageBytes: optional non-negative integer, clamped; 0 = unknown.
  let maxMessageBytes = 0;
  if (b['maxMessageBytes'] !== undefined) {
    const n = b['maxMessageBytes'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return { ok: false, code: 'invalid_max_message_bytes' };
    }
    maxMessageBytes = Math.min(MAX_MESSAGE_BYTES_CAP, Math.trunc(n));
  }
  // maxMessageChars: optional non-negative integer, clamped; 0 = unknown.
  let maxMessageChars = 0;
  if (b['maxMessageChars'] !== undefined) {
    const n = b['maxMessageChars'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return { ok: false, code: 'invalid_max_message_chars' };
    }
    maxMessageChars = Math.min(MAX_MESSAGE_CHARS_CAP, Math.trunc(n));
  }
  // At least one message-size limit must be provided (spec: capabilities_invalid).
  if (maxMessageBytes === 0 && maxMessageChars === 0) {
    return { ok: false, code: 'capabilities_invalid' };
  }
  return {
    ok: true,
    value: {
      id,
      displayName,
      supportsActions,
      supportsMarkdown,
      supportsThreads,
      supportsEdits,
      maxMessageBytes,
      maxMessageChars,
    },
  };
}

/**
 * POST /rc/bridges — register or heartbeat a bridge (`add-bridge-protocol`,
 * BRIDGE scope). Idempotent on the bridge's stable `id`: a re-POST updates the
 * capability advertisement and refreshes `registeredAt` (so POST subsumes the
 * spec's separate PATCH — a full idempotent upsert leaves nothing for a partial
 * update to add). A different token claiming an `id` already held by another
 * token is rejected 409 (no cross-bridge clobber/impersonation of presence).
 * Synchronous; no async-throw surface.
 */
export function createRegisterBridgeRoute(
  registry: BridgeRegistry,
  audit?: AuditRecorder,
  now: () => number = Date.now,
): RequestHandler {
  return (req, res) => {
    const parsed = parseRegistration(req.body);
    if (!parsed.ok) {
      void audit?.record({
        action: 'bridge_registration_rejected',
        actorTokenId: req.rcClient?.id,
        detail: { code: parsed.code },
      });
      res
        .status(400)
        .json({ error: 'Invalid bridge registration', code: parsed.code });
      return;
    }
    const tokenId = req.rcClient?.id ?? '';
    const existing = registry.ownerTokenOf(parsed.value.id);
    if (existing !== undefined && existing !== tokenId) {
      res.status(409).json({
        error: 'Bridge id already registered by another token',
        code: 'bridge_id_taken',
      });
      return;
    }
    const reg: BridgeRegistration = {
      ...parsed.value,
      tokenId,
      registeredAt: now(),
    };
    registry.register(reg);
    // Audit the display name + capability flags (no secrets — tokenId is an id).
    void audit?.record({
      action: 'bridge_registered',
      actorTokenId: tokenId,
      target: reg.id,
      detail: {
        displayName: reg.displayName,
        supportsActions: reg.supportsActions,
        supportsMarkdown: reg.supportsMarkdown,
        supportsThreads: reg.supportsThreads,
        supportsEdits: reg.supportsEdits,
        maxMessageBytes: reg.maxMessageBytes,
        maxMessageChars: reg.maxMessageChars,
      },
    });
    // Spec response carries heartbeatIntervalSec; we return the full reg too
    // (superset) so the owner sees the recorded capabilities in one round-trip.
    res
      .status(200)
      .json({ ...reg, heartbeatIntervalSec: HEARTBEAT_INTERVAL_SEC });
  };
}

/**
 * POST /rc/bridges/:id/heartbeat — a registered bridge refreshes its liveness so
 * the staleness reaper doesn't drop it. Owner-or-self (same authz as deregister).
 * 404 when the id is unknown (e.g. it was already reaped) so the bridge knows to
 * re-register — re-registration needs no re-pairing. Returns the refreshed
 * `{ id, registeredAt, heartbeatIntervalSec }`.
 */
export function createHeartbeatRoute(
  registry: BridgeRegistry,
  audit?: AuditRecorder,
  now: () => number = Date.now,
): RequestHandler {
  return (req, res) => {
    const id = req.params.id;
    const ownerToken = registry.ownerTokenOf(id);
    if (ownerToken === undefined) {
      void audit?.record({
        action: 'bridge_heartbeat_unknown',
        actorTokenId: req.rcClient?.id,
        target: id,
      });
      res
        .status(404)
        .json({ error: 'No such bridge', code: 'bridge_not_found' });
      return;
    }
    const scopes = req.rcClient?.scopes ?? [];
    const isOwner = scopes.includes(OWNER);
    const isSelf = ownerToken === req.rcClient?.id;
    if (!isOwner && !isSelf) {
      res
        .status(403)
        .json({ error: 'Not your bridge', code: 'not_bridge_owner' });
      return;
    }
    const at = now();
    registry.touch(id, at);
    res.status(200).json({
      id,
      registeredAt: at,
      heartbeatIntervalSec: HEARTBEAT_INTERVAL_SEC,
    });
  };
}

/**
 * Remove bridges that missed ~3 heartbeats and audit each one
 * (`bridge_stale_deregistered`). Called on an interval by the gateway host (cli),
 * with an injectable clock. Returns the removed ids.
 */
export function pruneStaleBridges(
  registry: BridgeRegistry,
  now: number,
  audit?: AuditRecorder,
  staleMs: number = BRIDGE_STALE_MS,
): string[] {
  const removed = registry.pruneStale(now, staleMs);
  for (const id of removed) {
    void audit?.record({ action: 'bridge_stale_deregistered', target: id });
  }
  return removed;
}

/** GET /rc/bridges — owner lists registered bridges. */
export function createListBridgesRoute(
  registry: BridgeRegistry,
): RequestHandler {
  return (_req, res) => {
    res.status(200).json({ bridges: registry.list() });
  };
}

/**
 * DELETE /rc/bridges/:id — deregister a bridge. Allowed for an OWNER token OR the
 * registering bridge itself (self). A token that is neither → 403 (so one bridge
 * can't deregister another). 404 when the id is unknown. Mounted with a low scope
 * gate; the real authz is the owner-or-self check here.
 */
export function createDeregisterBridgeRoute(
  registry: BridgeRegistry,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res) => {
    const id = req.params.id;
    const ownerToken = registry.ownerTokenOf(id);
    if (ownerToken === undefined) {
      res
        .status(404)
        .json({ error: 'No such bridge', code: 'bridge_not_found' });
      return;
    }
    const scopes = req.rcClient?.scopes ?? [];
    const isOwner = scopes.includes(OWNER);
    const isSelf = ownerToken === req.rcClient?.id;
    if (!isOwner && !isSelf) {
      res
        .status(403)
        .json({ error: 'Not your bridge', code: 'not_bridge_owner' });
      return;
    }
    registry.remove(id);
    void audit?.record({
      action: 'bridge_deregistered',
      actorTokenId: req.rcClient?.id,
      target: id,
    });
    res.status(204).end();
  };
}

/**
 * POST /rc/bridges/:id/ban { subActor } — owner bans one chat user from a bridge
 * WITHOUT revoking the bridge's token (every other user keeps working). The
 * banned sub-actor's subsequent writes are rejected by `enforceSubActorBan`. The
 * bridge `:id` is audit context; the ban is keyed by the (service-namespaced)
 * sub-actor id. 400 on a malformed sub-actor. Idempotent.
 */
export function createBanSubActorRoute(
  bans: SubActorBanStore,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res) => {
    const body = (req.body ?? {}) as { subActor?: unknown };
    const sub = parseSubActor(
      typeof body.subActor === 'string' ? body.subActor : undefined,
    );
    if (!sub) {
      res
        .status(400)
        .json({ error: 'Invalid subActor', code: 'invalid_sub_actor' });
      return;
    }
    bans.ban(sub);
    void audit?.record({
      action: 'sub_actor_banned',
      actorTokenId: req.rcClient?.id,
      subActor: sub,
      target: req.params.id,
    });
    res
      .status(200)
      .json({ bridgeId: req.params.id, subActor: sub, banned: true });
  };
}

/**
 * DELETE /rc/bridges/:id/ban/:subActor — owner lifts a ban. 404 when the
 * sub-actor wasn't banned. The `:id` is audit context (the ban is keyed by
 * sub-actor). The `:subActor` path segment is validated to the same charset.
 */
export function createLiftBanRoute(
  bans: SubActorBanStore,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res) => {
    const sub = parseSubActor(req.params.subActor);
    if (!sub || !bans.lift(sub)) {
      res.status(404).json({ error: 'No such ban', code: 'ban_not_found' });
      return;
    }
    void audit?.record({
      action: 'sub_actor_unbanned',
      actorTokenId: req.rcClient?.id,
      subActor: sub,
      target: req.params.id,
    });
    res.status(204).end();
  };
}

/** GET /rc/bridges/bans — owner lists currently-banned sub-actors. */
export function createListBansRoute(bans: SubActorBanStore): RequestHandler {
  return (_req, res) => {
    res.status(200).json({ banned: bans.list() });
  };
}

/**
 * POST /rc/bridges/invites { kind, sessionId } — OWNER mints a one-time invite
 * token (the gateway analog of the spec's `qwen rc bridges invite --kind <kind>
 * --session <id>` CLI). A bridge later redeems it to learn which session to bind,
 * so a chat user NEVER names a session id directly — the operator decides every
 * chat→session binding. Returns `{ token, expiresAt, kind, sessionId }`.
 *
 * `kind` is recorded for audit but is NOT enforced at redeem (a deliberate
 * non-gate — see {@link InviteStore.redeem}); it is still validated here so a
 * typo'd invite fails fast at mint rather than confusing the operator later.
 */
export function createMintInviteRoute(
  invites: InviteStore,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof b['kind'] === 'string' ? b['kind'].trim() : '';
    if (!INVITE_KINDS.has(kind)) {
      res
        .status(400)
        .json({ error: 'Invalid bridge kind', code: 'invalid_kind' });
      return;
    }
    const sessionId =
      typeof b['sessionId'] === 'string' ? b['sessionId'].trim() : '';
    if (
      !sessionId ||
      sessionId.length > SESSION_ID_MAX ||
      CONTROL_RE.test(sessionId)
    ) {
      res
        .status(400)
        .json({ error: 'Invalid sessionId', code: 'invalid_session_id' });
      return;
    }
    const { token, expiresAt } = invites.mint(kind, sessionId);
    // Audit the kind + target session (no secret — the token itself is NEVER
    // logged; it is the one-time secret handed back only in the response body).
    void audit?.record({
      action: 'bridge_invite_minted',
      actorTokenId: req.rcClient?.id,
      target: sessionId,
      detail: { kind },
    });
    res.status(200).json({ token, expiresAt, kind, sessionId });
  };
}

/**
 * POST /rc/bridges/:id/invite/redeem { token } — BRIDGE scope. A bridge redeems
 * a one-time invite, learning the `sessionId` to bind. Returns `200 { sessionId,
 * kind }` on success or `400 { error: "Invalid or expired invite token" }` which
 * the bridge relays verbatim to the chat. Single-use: a redeem always burns the
 * token.
 *
 * `:id` is the bridge's stable id, carried for AUDIT CONTEXT ONLY — it is NOT
 * validated against the registry (that would couple redeem to register-ordering
 * and the in-memory registry drops on restart). The bridge-scope token + the
 * one-time invite are the real controls.
 */
export function createRedeemInviteRoute(
  invites: InviteStore,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res) => {
    const b = (req.body ?? {}) as { token?: unknown };
    const token = typeof b.token === 'string' ? b.token : '';
    const redeemed = token ? invites.redeem(token) : null;
    if (!redeemed) {
      void audit?.record({
        action: 'bridge_invite_redeem_failed',
        actorTokenId: req.rcClient?.id,
        target: req.params.id,
      });
      res
        .status(400)
        .json({ error: INVALID_INVITE_MESSAGE, code: 'invalid_invite' });
      return;
    }
    void audit?.record({
      action: 'bridge_invite_redeemed',
      actorTokenId: req.rcClient?.id,
      target: redeemed.sessionId,
      detail: { kind: redeemed.kind, bridgeId: req.params.id },
    });
    res
      .status(200)
      .json({ sessionId: redeemed.sessionId, kind: redeemed.kind });
  };
}
