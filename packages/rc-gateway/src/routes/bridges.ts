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
} from '../bridges/registry.js';

/** Stable bridge id: alphanumeric-led, safe id charset, bounded (audit-safe). */
const BRIDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]*$/;
const BRIDGE_ID_MAX = 128;
const DISPLAY_NAME_MAX = 200;
const MAX_MESSAGE_BYTES_CAP = 100_000_000;

/** Reject control characters that could corrupt a JSONL audit line / UI. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

interface ParsedRegistration {
  id: string;
  displayName: string;
  supportsActions: boolean;
  supportsMarkdown: boolean;
  maxMessageBytes: number;
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
  // Capability flags default to false (conservative — the safest assumption is
  // "this chat service can't render actions/markdown" until the bridge says so).
  const supportsActions = b['supportsActions'] === true;
  const supportsMarkdown = b['supportsMarkdown'] === true;
  // maxMessageBytes: optional non-negative integer, clamped; 0 = unknown.
  let maxMessageBytes = 0;
  if (b['maxMessageBytes'] !== undefined) {
    const n = b['maxMessageBytes'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return { ok: false, code: 'invalid_max_message_bytes' };
    }
    maxMessageBytes = Math.min(MAX_MESSAGE_BYTES_CAP, Math.trunc(n));
  }
  return {
    ok: true,
    value: {
      id,
      displayName,
      supportsActions,
      supportsMarkdown,
      maxMessageBytes,
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
        maxMessageBytes: reg.maxMessageBytes,
      },
    });
    res.status(200).json(reg);
  };
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
