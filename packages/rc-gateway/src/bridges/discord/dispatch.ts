/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WriteResult } from '../client.js';
import type { DiscordRestResult } from './restApi.js';
import type { DiscordChannelStore } from './channelStore.js';
import { subActorOf, parseCustomId, outcomeFor } from './render.js';

/**
 * Pure inbound dispatch for the Discord bridge (`add-discord-bridge`): given a
 * NORMALIZED Discord event (a chat message, a slash command, or a button click —
 * the shapes the future gateway WebSocket loop will produce), drive the gateway
 * over the loopback contract. No discord.js, no live socket — the handlers take
 * injected deps so the full prompt/vote/ban/back-pressure logic is unit-testable
 * without a bot token.
 *
 * Sub-actor is always `discord:<author-or-member-snowflake>` (a STRING). Ban
 * cache mirrors the gateway's 403 so a banned user is dropped without re-hitting.
 *
 * Binding: `/qwen attach <token>` REDEEMS an operator-issued one-time invite via
 * `POST /rc/bridges/:id/invite/redeem` (the spec's bind path) — the SOLE way a
 * channel binds. A guild member never names a session id directly; the operator
 * decides every channel→session binding.
 */

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

/** The Discord REST surface the dispatcher needs (subset → easy to mock). */
export interface DiscordResponder {
  createMessage(channelId: string, content: string): Promise<DiscordRestResult>;
  replyEphemeral(
    interactionId: string,
    interactionToken: string,
    content: string,
  ): Promise<DiscordRestResult>;
  deferInteraction(
    interactionId: string,
    interactionToken: string,
  ): Promise<DiscordRestResult>;
  editInteractionReply(
    interactionToken: string,
    content: string,
  ): Promise<DiscordRestResult>;
}

export interface DiscordDispatchDeps {
  bridge: PromptVoter;
  rest: DiscordResponder;
  channels: DiscordChannelStore;
  /** This bridge's stable id (for the invite-redeem route path). */
  bridgeId: string;
  /** Local ban cache (sub-actor ids) — mirrors gateway 403s. */
  bans: Set<string>;
  /**
   * Called when a NEW inbound prompt is accepted for a session — a turn boundary
   * (spec: "the next inbound user prompt"). The runner uses it to end the prior
   * turn so its stream thread isn't reused. Optional (pure-dispatch tests omit).
   */
  onTurnBoundary?: (sessionId: string) => void;
}

/** A non-bot chat message in a (possibly bound) channel. */
export interface NormalizedMessage {
  channelId: string;
  /** Author snowflake (string). */
  authorId: string;
  isBot: boolean;
  content: string;
}

/** A `/qwen <name>` slash-command interaction. */
export interface NormalizedSlashCommand {
  interactionId: string;
  interactionToken: string;
  channelId: string;
  guildId: string;
  /** Invoking member's user snowflake (string). */
  userId: string;
  name: 'attach' | 'detach' | 'status';
  /** The string arg for `/qwen attach` — an operator-issued invite token. */
  arg?: string;
}

/** A button (MESSAGE_COMPONENT) interaction. */
export interface NormalizedComponent {
  interactionId: string;
  interactionToken: string;
  channelId: string;
  /** Clicking member's user snowflake (string). */
  userId: string;
  customId: string;
}

/**
 * A non-bot chat message in a bound channel becomes a prompt (per-author
 * sub-actor, local ban check, 429 → a channel "slow down" notice, 403 → cache
 * the ban + drop). The bot's own messages are never relayed (no echo loop).
 */
export async function handleMessage(
  msg: NormalizedMessage,
  deps: DiscordDispatchDeps,
): Promise<void> {
  if (msg.isBot) return; // never relay our own (or another bot's) output
  const sessionId = deps.channels.sessionFor(msg.channelId);
  if (!sessionId) return; // unbound channel → ignore
  const content = msg.content.trim();
  if (!content) return;

  const subActor = subActorOf(msg.authorId);
  if (deps.bans.has(subActor)) return; // locally banned → silent drop

  const r = await deps.bridge.sendPrompt(sessionId, content, subActor);
  if (r.status === 403) {
    deps.bans.add(subActor); // gateway banned this sub-actor → cache + drop
    return;
  }
  if (r.ok) deps.onTurnBoundary?.(sessionId); // a new prompt starts a new turn
  if (r.status === 429) {
    const secs = r.retryAfterSec ?? 'a few';
    // A MESSAGE_CREATE has no interaction token, so an ephemeral reply is not
    // possible — post a plain channel notice instead (Discord ephemeral requires
    // an interaction; this is the honest implementable behavior).
    await deps.rest.createMessage(
      msg.channelId,
      `Slow down — try again in ${secs} seconds.`,
    );
  }
  // Success is silent; the agent's reply arrives via the SSE echo loop.
}

/**
 * Slash commands are the control plane (all reply ephemerally):
 *  - `/qwen attach <token>` REDEEMS an operator invite to bind this channel.
 *  - `/qwen detach` unbinds it.
 *  - `/qwen status` reports the current binding + a usage tip.
 */
export async function handleSlashCommand(
  cmd: NormalizedSlashCommand,
  deps: DiscordDispatchDeps,
): Promise<void> {
  if (cmd.name === 'attach') {
    const token = (cmd.arg ?? '').trim();
    if (!token) {
      await reply(deps, cmd, 'Usage: /qwen attach <invite token>');
      return;
    }
    // Redeem the operator's one-time invite. On failure, relay the gateway's
    // error text and persist NOTHING — a member can't bind by guessing.
    const redeemed = await deps.bridge.redeemInvite(deps.bridgeId, token);
    if (!redeemed.ok || !redeemed.sessionId) {
      await reply(deps, cmd, inviteError(redeemed));
      return;
    }
    await deps.channels.bind(cmd.channelId, cmd.guildId, redeemed.sessionId);
    await reply(
      deps,
      cmd,
      `Channel bound to session \`${redeemed.sessionId}\`.`,
    );
    return;
  }
  if (cmd.name === 'detach') {
    const had = await deps.channels.unbind(cmd.channelId);
    await reply(
      deps,
      cmd,
      had ? 'Channel unbound.' : 'This channel was not bound.',
    );
    return;
  }
  // status
  const sessionId = deps.channels.sessionFor(cmd.channelId);
  await reply(
    deps,
    cmd,
    sessionId
      ? `Bound to session \`${sessionId}\`. Type in chat to send prompts; use the Approve/Deny buttons on tool calls.`
      : 'Not bound. Run /qwen attach <invite token> to bind this channel.',
  );
}

/**
 * A button click becomes a vote. Discord requires the interaction be
 * acknowledged within 3 seconds, so we DEFER first (always), then: a banned
 * clicker is dropped without relaying (the ack already satisfies Discord); a
 * foreign custom_id is ignored; otherwise the vote is POSTed and the deferred
 * reply edited with the outcome (or the daemon error). A 403 caches the ban.
 *
 * Discord interaction tokens expire after 15 minutes. If `editInteractionReply`
 * fails (4xx — the token is expired), we fall back to posting a regular channel
 * message via the bot token mentioning the voter, so the acknowledgement is
 * never silently lost.
 */
export async function handleComponent(
  comp: NormalizedComponent,
  deps: DiscordDispatchDeps,
): Promise<void> {
  // ACK within Discord's 3s window before any daemon round-trip.
  await deps.rest.deferInteraction(comp.interactionId, comp.interactionToken);

  const subActor = subActorOf(comp.userId);
  if (deps.bans.has(subActor)) return; // banned → acked but not relayed

  const parsed = parseCustomId(comp.customId);
  if (!parsed) return; // not one of our vote buttons

  const sessionId = deps.channels.sessionFor(comp.channelId);
  if (!sessionId) {
    await replyOrFallback(deps, comp, 'This channel is not bound.');
    return;
  }

  const r = await deps.bridge.vote(
    sessionId,
    parsed.requestId,
    outcomeFor(parsed.action),
    subActor,
  );
  if (r.status === 403) {
    deps.bans.add(subActor);
    await replyOrFallback(deps, comp, 'You are blocked.');
    return;
  }
  if (!r.ok) {
    await replyOrFallback(
      deps,
      comp,
      'Vote failed — try again from the web client.',
    );
    return;
  }
  await replyOrFallback(deps, comp, `You voted ${parsed.action}.`);
}

/**
 * Edit the deferred interaction reply with `content`. If that fails (4xx —
 * the interaction token is expired, which happens when >15 minutes have passed
 * since the permission_request was rendered), fall back to a regular channel
 * message via the bot token, mentioning the voter by snowflake so they still
 * see the outcome.
 */
async function replyOrFallback(
  deps: DiscordDispatchDeps,
  comp: NormalizedComponent,
  content: string,
): Promise<void> {
  const r = await deps.rest.editInteractionReply(
    comp.interactionToken,
    content,
  );
  if (!r.ok) {
    // Interaction token is expired (or otherwise unusable) — fall back to a
    // plain channel message mentioning the voter so the outcome is not lost.
    await deps.rest.createMessage(
      comp.channelId,
      `<@${comp.userId}> ${content}`,
    );
  }
}

/** Ephemeral reply helper for the slash-command handlers. */
function reply(
  deps: DiscordDispatchDeps,
  cmd: NormalizedSlashCommand,
  content: string,
): Promise<DiscordRestResult> {
  return deps.rest.replyEphemeral(
    cmd.interactionId,
    cmd.interactionToken,
    content,
  );
}

/** The gateway's `error` text for a failed redeem, or a safe default. */
function inviteError(r: { body?: unknown }): string {
  const err = (r.body as { error?: unknown })?.error;
  return typeof err === 'string' ? err : 'Invalid or expired invite token';
}
