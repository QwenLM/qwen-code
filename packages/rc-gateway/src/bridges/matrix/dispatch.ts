/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WriteResult } from '../client.js';
import type { MatrixRestResult } from './restApi.js';
import type { MatrixRoomStore } from './roomStore.js';
import { subActorOf, voteForReaction, outcomeFor } from './render.js';

/**
 * Pure inbound dispatch for the Matrix bridge (`add-matrix-bridge`): given a
 * NORMALIZED Matrix event (a room message, or a reaction — the shapes the sync
 * loop produces), drive the gateway over the loopback contract. No SDK, no live
 * sync — handlers take injected deps so prompt/vote/command/ban/power-level logic
 * is unit-testable without an access token.
 *
 * Sub-actor is always the fully-qualified MXID (`matrix:@user:server`).
 *
 * Binding: `<prefix> attach <token>` REDEEMS an operator-issued one-time invite
 * via `POST /rc/bridges/:id/invite/redeem` (the spec's bind path) — the SOLE way
 * a room binds, and still power-gated (≥50) + refused in encrypted rooms. A room
 * member never names a session id directly; the operator decides every binding.
 *
 * Encrypted rooms (E2EE) are NOT supported in this build: the bridge can't read
 * ciphertext over the plain fetch transport, so it REFUSES to bind an encrypted
 * room and says so — rather than silently failing (which is what would happen if
 * encryption-handling were deferred along with E2EE itself).
 */

/** Minimum power level to bind/unbind a room (spec D5: Moderator). */
export const ATTACH_MIN_POWER_LEVEL = 50;

/** Posted when the bridge is asked to operate in an encrypted room. */
export const ENCRYPTED_ROOM_NOTICE =
  '🔒 This room is end-to-end encrypted, which this bridge build does not ' +
  'support. Use an unencrypted room to bind a qwen session.';

/** The bridge-client surface the dispatcher needs (subset → easy to mock). */
export interface PromptVoter {
  redeemInvite(
    bridgeId: string,
    token: string,
  ): Promise<WriteResult & { sessionId?: string }>;
  sendPrompt(
    sessionId: string,
    prompt: string,
    subActor: string,
  ): Promise<WriteResult>;
  vote(
    sessionId: string,
    requestId: string,
    outcome: 'allow_once' | 'cancelled',
    subActor: string,
  ): Promise<WriteResult>;
}

/** The Matrix send surface the dispatcher needs (subset → easy to mock). */
export interface MatrixResponder {
  sendMessage(
    roomId: string,
    content: unknown,
  ): Promise<MatrixRestResult & { eventId?: string }>;
}

/** A permission_request the bridge is tracking, keyed by its sent event id. */
export interface TrackedEvent {
  requestId: string;
  sessionId: string;
  /**
   * The rendering surface for this request:
   *  - `'inline'`  → reaction-votable (👍/👎 cast a vote).
   *  - `'deeplink'`→ NOT reaction-votable; a reaction triggers a one-time
   *    guidance reply ("This decision requires the web client …").
   */
  surface: 'inline' | 'deeplink';
}

export interface MatrixDispatchDeps {
  bridge: PromptVoter;
  rest: MatrixResponder;
  rooms: MatrixRoomStore;
  /** This bridge's stable id (for the invite-redeem route path). */
  bridgeId: string;
  /** Local ban cache (sub-actor ids) — mirrors gateway 403s. */
  bans: Set<string>;
  /** Rooms detected as E2EE → attach refused, messages can't be read. */
  encryptedRooms: Set<string>;
  /** eventId → tracked permission_request (for reaction → vote resolution). */
  tracked: Map<string, TrackedEvent>;
  /**
   * requestIds for which the deeplink-guidance reply has already been sent
   * (once per requestId, to avoid repeating the notice on every reaction). The
   * runner owns this set and passes it in; pure-dispatch tests may omit it
   * (defaults to an empty set, meaning guidance is always eligible to send).
   */
  deeplinkGuidanceSent?: Set<string>;
  /** Command prefix (default `!qwen`). */
  commandPrefix: string;
  /**
   * Called when a new inbound prompt is accepted for a session — a turn boundary
   * (spec: "the next inbound user prompt") so the stream router ends the prior
   * turn (its m.thread isn't reused). Optional (pure-dispatch tests omit it).
   */
  onTurnBoundary?: (sessionId: string) => void;
}

/** A non-bot `m.room.message` (m.text) in a room, with the sender's power level. */
export interface NormalizedMatrixMessage {
  roomId: string;
  /** Fully-qualified MXID. */
  sender: string;
  isBot: boolean;
  body: string;
  /** The sender's power level in the room (users[sender] ?? users_default ?? 0). */
  powerLevel: number;
}

/** An `m.reaction` annotation on some event. */
export interface NormalizedMatrixReaction {
  roomId: string;
  sender: string;
  /** The event this reaction annotates (`m.relates_to.event_id`). */
  targetEventId: string;
  /** The reaction key (e.g. `👍`); may carry a variation selector / skin tone. */
  key: string;
}

/**
 * The sender's power level: `users[sender]`, else `users_default`, else 0. The
 * level-0 default is what the non-moderator reject scenario relies on.
 */
export function senderPowerLevel(
  powerLevels:
    | { users?: Record<string, number>; users_default?: number }
    | undefined,
  sender: string,
): number {
  const explicit = powerLevels?.users?.[sender];
  if (typeof explicit === 'number') return explicit;
  if (typeof powerLevels?.users_default === 'number')
    return powerLevels.users_default;
  return 0;
}

/**
 * A non-bot room message: a `<prefix> …` command (control plane, power-gated) or
 * a plain prompt. Bot's own messages never relay (no echo loop).
 */
export async function handleMessage(
  msg: NormalizedMatrixMessage,
  deps: MatrixDispatchDeps,
): Promise<void> {
  if (msg.isBot) return;
  const body = msg.body.trim();
  if (!body) return;

  if (
    body === deps.commandPrefix ||
    body.startsWith(`${deps.commandPrefix} `)
  ) {
    await handleCommand(
      msg,
      body.slice(deps.commandPrefix.length).trim(),
      deps,
    );
    return;
  }

  // Plain prompt — requires a bound room.
  const sessionId = deps.rooms.sessionFor(msg.roomId);
  if (!sessionId) return;
  const subActor = subActorOf(msg.sender);
  if (deps.bans.has(subActor)) return;

  const r = await deps.bridge.sendPrompt(sessionId, body, subActor);
  if (r.status === 403) {
    deps.bans.add(subActor);
    return;
  }
  if (r.ok) deps.onTurnBoundary?.(sessionId); // a new prompt starts a new turn
  if (r.status === 429) {
    const secs = r.retryAfterSec ?? 'a few';
    await deps.rest.sendMessage(msg.roomId, {
      msgtype: 'm.text',
      body: `Slow down — try again in ${secs} seconds.`,
    });
  }
}

async function handleCommand(
  msg: NormalizedMatrixMessage,
  rest: string,
  deps: MatrixDispatchDeps,
): Promise<void> {
  const [name, ...argParts] = rest.split(/\s+/);
  const arg = argParts.join(' ').trim();

  const reply = (body: string) =>
    deps.rest.sendMessage(msg.roomId, { msgtype: 'm.text', body });

  if (name === 'attach') {
    if (msg.powerLevel < ATTACH_MIN_POWER_LEVEL) {
      await reply('Permission denied: attach requires power level ≥ 50');
      return;
    }
    if (deps.encryptedRooms.has(msg.roomId)) {
      await reply(ENCRYPTED_ROOM_NOTICE);
      return;
    }
    if (!arg) {
      await reply(`Usage: ${deps.commandPrefix} attach <invite token>`);
      return;
    }
    // Redeem the operator's one-time invite. On failure, relay the gateway's
    // error text and persist NOTHING — a member can't bind by guessing.
    const redeemed = await deps.bridge.redeemInvite(deps.bridgeId, arg);
    if (!redeemed.ok || !redeemed.sessionId) {
      await reply(inviteError(redeemed));
      return;
    }
    await deps.rooms.bind(msg.roomId, redeemed.sessionId);
    await reply(
      `Room bound to session \`${redeemed.sessionId}\`. React 👍/👎 on tool-call messages to vote.`,
    );
    return;
  }

  if (name === 'detach') {
    if (msg.powerLevel < ATTACH_MIN_POWER_LEVEL) {
      await reply('Permission denied: detach requires power level ≥ 50');
      return;
    }
    const had = await deps.rooms.unbind(msg.roomId);
    await reply(had ? 'Room unbound.' : 'This room was not bound.');
    return;
  }

  // status (and unknown verbs fall through to it).
  const sessionId = deps.rooms.sessionFor(msg.roomId);
  await reply(
    sessionId
      ? `Bound to session \`${sessionId}\`. Type in chat to send prompts; react 👍/👎 on tool calls to vote.`
      : `Not bound. A moderator can run \`${deps.commandPrefix} attach <invite token>\`.`,
  );
}

/** The gateway's `error` text for a failed redeem, or a safe default. */
function inviteError(r: { body?: unknown }): string {
  const err = (r.body as { error?: unknown })?.error;
  return typeof err === 'string' ? err : 'Invalid or expired invite token';
}

/** Guidance text sent once per requestId when a user reacts on a deeplink message. */
export const DEEPLINK_REACTION_GUIDANCE =
  'This decision requires the web client — use the link above.';

/**
 * A reaction becomes a vote when it annotates a tracked permission_request event
 * with 👍/👎 (normalized for variation selector / skin tone). Banned reactors and
 * untracked / non-thumb reactions are dropped without a daemon call. The bridge
 * does NOT tally — it POSTs per valid reaction and lets the daemon dedupe
 * (first-responder-wins).
 *
 * Deeplink-surface messages are NOT reaction-votable. A 👍/👎 on such a message
 * triggers a ONE-TIME threaded guidance reply ("This decision requires the web
 * client …") so the user knows to open the URL. Subsequent reactions on the same
 * requestId are silently dropped.
 */
export async function handleReaction(
  reaction: NormalizedMatrixReaction,
  deps: MatrixDispatchDeps,
): Promise<void> {
  const subActor = subActorOf(reaction.sender);
  if (deps.bans.has(subActor)) return; // banned → never relayed (not redacted)

  const tracked = deps.tracked.get(reaction.targetEventId);
  if (!tracked) return; // not one of our permission-request messages

  const vote = voteForReaction(reaction.key);
  if (!vote) return; // not 👍/👎

  // Deeplink-surface messages are NOT reaction-votable. Send guidance once per
  // requestId so the user knows to open the web-client link.
  if (tracked.surface === 'deeplink') {
    const guidanceSent = deps.deeplinkGuidanceSent ?? new Set<string>();
    if (!guidanceSent.has(tracked.requestId)) {
      guidanceSent.add(tracked.requestId);
      await deps.rest.sendMessage(reaction.roomId, {
        msgtype: 'm.text',
        body: DEEPLINK_REACTION_GUIDANCE,
      });
    }
    return;
  }

  const r = await deps.bridge.vote(
    tracked.sessionId,
    tracked.requestId,
    outcomeFor(vote),
    subActor,
  );
  if (r.status === 403) deps.bans.add(subActor);
}
