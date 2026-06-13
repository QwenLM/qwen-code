/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeHints } from '../hints.js';

/**
 * Pure Matrix translation (`add-matrix-bridge`): daemon `permission_request`
 * frames → an `m.room.message` body, 👍/👎 reactions ↔ gateway votes, and the
 * `m.replace` edit content used on resolve. No I/O, no SDK — just the wire shapes,
 * kept pure so the rendering + reaction contract is unit-testable without an
 * access token or a live homeserver.
 *
 * Matrix differs from Telegram/Discord in three ways reflected here: there is NO
 * inline-button surface, so the vote affordance is a 👍/👎 REACTION on the message
 * (`supportsActions: false`); ids are fully-qualified MXIDs carried verbatim
 * (`@user:home.example.com`, never stripped to a localpart — federation makes
 * `@a:x` and `@a:y` different users); and an edit is a NEW event carrying
 * `m.new_content` + an `m.replace` relation, not an in-place patch.
 */

/** Base thumbs emoji (no variation selector / skin tone). */
const THUMBS_UP = '\u{1F44D}'; // 👍
const THUMBS_DOWN = '\u{1F44E}'; // 👎

/** A Matrix `m.room.message` content (the subset the bridge sends). */
export interface MatrixMessageContent {
  msgtype: 'm.text';
  body: string;
}

/** An `m.replace` edit event's content (a NEW event, not an in-place patch). */
export interface MatrixReplaceContent {
  msgtype: 'm.text';
  /** Fallback body for clients that don't render edits (conventionally `* …`). */
  body: string;
  'm.new_content': { msgtype: 'm.text'; body: string };
  'm.relates_to': { rel_type: 'm.replace'; event_id: string };
}

/** The per-sender sub-actor id for a Matrix MXID (fully-qualified, never stripped). */
export function subActorOf(mxid: string): string {
  return `matrix:${mxid}`;
}

/**
 * Normalize a reaction key before matching: strip the emoji variation selector
 * (U+FE0F) and any skin-tone modifier (U+1F3FB–U+1F3FF), since clients send
 * `👍`, `👍️`, and `👍🏽` interchangeably. Matching the raw key would miss
 * the common variation-selector form — a bug a literal fixture hides.
 */
export function normalizeReactionKey(key: string): string {
  return key.replace(/️/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

/** Map a reaction key to a vote, or null if it isn't 👍/👎. */
export function voteForReaction(key: string): 'approve' | 'deny' | null {
  const k = normalizeReactionKey(key);
  if (k === THUMBS_UP) return 'approve';
  if (k === THUMBS_DOWN) return 'deny';
  return null;
}

/** The gateway vote outcome for a reaction vote. */
export function outcomeFor(
  vote: 'approve' | 'deny',
): 'allow_once' | 'cancelled' {
  return vote === 'approve' ? 'allow_once' : 'cancelled';
}

/**
 * Render a `permission_request` frame's `data` into an `m.room.message` body per
 * `bridgeHints.recommendedSurface`:
 *  - `inline`  → argsSummaryShort + the literal "React 👍 to approve, 👎 to deny."
 *  - `deeplink`→ argsSummaryShort + an "Open in web client" URL; NO reaction
 *    prompt (the caller must NOT track reactions on this message) and NEVER
 *    argsSummaryFull (so a sensitive/large call isn't dumped to the room).
 * `baseUrl` is the gateway URL the deeplink points at.
 */
export function renderPermissionRequest(
  data: unknown,
  opts: { baseUrl: string },
): MatrixMessageContent {
  const d = (data ?? {}) as Record<string, unknown>;
  const hints = (d['bridgeHints'] ?? {}) as Partial<BridgeHints>;
  const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
  const short =
    typeof hints.argsSummaryShort === 'string' && hints.argsSummaryShort
      ? hints.argsSummaryShort
      : 'A tool wants to run.';

  if (hints.recommendedSurface === 'deeplink') {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const url = `${base}/ui/permission/${encodeURIComponent(requestId)}`;
    return {
      msgtype: 'm.text',
      body: `⚠️ Sensitive tool call: ${short}\nOpen in web client: ${url}`,
    };
  }

  return {
    msgtype: 'm.text',
    body: `⚠️ Tool call: ${short}\nReact 👍 to approve, 👎 to deny.`,
  };
}

/**
 * Whether a rendered permission_request message should have its reactions
 * tracked. Deeplink (sensitive) messages are NOT tracked — those require
 * explicit web-client review, not a room reaction.
 */
export function tracksReactions(data: unknown): boolean {
  const hints = ((data ?? {}) as Record<string, unknown>)['bridgeHints'] as
    | Partial<BridgeHints>
    | undefined;
  return hints?.recommendedSurface !== 'deeplink';
}

/**
 * Build the `m.replace` edit content for a resolved request: preserve the
 * original body and append the outcome.
 *
 * DEVIATION (documented): the spec scenario wants "Resolved: <vote> by
 * <subActor>", but the daemon's `permission_resolved` frame carries only
 * `{requestId, outcome}` with NO voter (first-responder-wins is resolved
 * daemon-side), so the bridge can't know which reactor won. We render the
 * available `outcome` and omit the voter rather than fabricate one — the same
 * deviation carried by the Discord bridge.
 */
export function renderResolveEdit(
  originalBody: string,
  originalEventId: string,
  outcome: string,
): MatrixReplaceContent {
  const newBody = `${originalBody}\n\nResolved: ${outcome}`;
  return {
    msgtype: 'm.text',
    body: `* ${newBody}`,
    'm.new_content': { msgtype: 'm.text', body: newBody },
    'm.relates_to': { rel_type: 'm.replace', event_id: originalEventId },
  };
}
