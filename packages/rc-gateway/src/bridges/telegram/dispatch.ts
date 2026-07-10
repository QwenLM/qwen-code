/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WriteResult } from '../client.js';
import type { TgApiResult } from './botApi.js';
import type { TelegramUpdate } from './botApi.js';
import type { TelegramChatStore } from './chatStore.js';
import { subActorOf, parseCallbackData, outcomeFor } from './render.js';

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

/** The Telegram-send surface the dispatcher needs (subset → easy to mock). */
export interface ChatSender {
  sendMessage(
    chatId: number,
    text: string,
    opts?: { inlineKeyboard?: unknown[][] },
  ): Promise<TgApiResult>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { inlineKeyboard?: unknown[][] },
  ): Promise<TgApiResult>;
  answerCallbackQuery(id: string, text?: string): Promise<TgApiResult>;
}

/** A permission_request message that was sent to a chat (for later editing). */
export interface SentPermissionMessage {
  chatId: number;
  messageId: number;
  text: string;
}

export interface DispatchDeps {
  bridge: PromptVoter;
  tg: ChatSender;
  chats: TelegramChatStore;
  /** This bridge's stable id (for the invite-redeem route path). */
  bridgeId: string;
  /** Local ban cache (sub-actor ids) — mirrors gateway 403s to avoid re-hitting. */
  bans: Set<string>;
  /**
   * Map of requestId → sent messages (for editing on permission_resolved).
   * When provided, `handleCallback` records the sent message id from the
   * callback's `message.message_id` so the runner can edit it on resolve.
   */
  sentRequests?: Map<string, SentPermissionMessage[]>;
  /**
   * Set of requestIds that have already been resolved. A late tap on an
   * already-resolved request is acked with "Already resolved" without hitting
   * the daemon (which would 404/conflict).
   */
  resolvedRequests?: Set<string>;
}

/**
 * Handle one Telegram update (`add-telegram-bridge`). Self-catching: one bad
 * update must never kill the poll loop. A `/start <token>` REDEEMS an
 * operator-issued invite to bind the chat (the SOLE bind path — a chat user
 * never names a session id directly); a plain message becomes a prompt
 * (per-sender sub-actor, local ban check, 429 → "slow down", 403 → cache the
 * ban + drop); a button tap becomes a vote.
 */
export async function handleUpdate(
  update: TelegramUpdate,
  deps: DispatchDeps,
): Promise<void> {
  try {
    if (update.message?.text !== undefined) {
      await handleMessage(update.message, deps);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query, deps);
    }
  } catch {
    // Swallow — the poll loop continues with the next update.
  }
}

async function handleMessage(
  msg: NonNullable<TelegramUpdate['message']>,
  deps: DispatchDeps,
): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();

  if (text.startsWith('/start')) {
    const token = text.slice('/start'.length).trim();
    if (!token) {
      await deps.tg.sendMessage(chatId, 'Usage: /start <invite token>');
      return;
    }
    // Redeem the operator's one-time invite. On failure, relay the gateway's
    // error text and persist NOTHING — a chat user can't bind by guessing.
    const redeemed = await deps.bridge.redeemInvite(deps.bridgeId, token);
    if (!redeemed.ok || !redeemed.sessionId) {
      await deps.tg.sendMessage(chatId, inviteError(redeemed));
      return;
    }
    // DEFERRED: the spec persists `(chatId, sessionId, primarySubActor)`; our
    // store keeps only `(chatId, sessionId)` — the per-message sub-actor is
    // resolved at send time, so the redeemer's identity isn't needed at bind.
    await deps.chats.bind(chatId, redeemed.sessionId);
    await deps.tg.sendMessage(
      chatId,
      `Bound chat to session ${redeemed.sessionId}. Messages here are sent as prompts.`,
    );
    return;
  }

  const sessionId = deps.chats.sessionFor(chatId);
  if (!sessionId) {
    await deps.tg.sendMessage(
      chatId,
      'This chat is not bound to a session. Use an operator-issued invite: /start <token>.',
    );
    return;
  }
  const from = msg.from?.id;
  if (from === undefined) return; // can't attribute a sub-actor → drop
  const subActor = subActorOf(from);
  if (deps.bans.has(subActor)) return; // locally banned → silent drop

  const r = await deps.bridge.sendPrompt(sessionId, text, subActor);
  if (r.status === 403) {
    deps.bans.add(subActor); // gateway banned this sub-actor → cache + drop
    return;
  }
  if (r.status === 429) {
    const secs = r.retryAfterSec ?? 'a few';
    await deps.tg.sendMessage(
      chatId,
      `Slow down — try again in ${secs} seconds.`,
    );
  }
  // Success is silent here; the agent's reply arrives via the SSE echo loop.
}

async function handleCallback(
  cbq: NonNullable<TelegramUpdate['callback_query']>,
  deps: DispatchDeps,
): Promise<void> {
  const parsed = parseCallbackData(cbq.data);
  if (!parsed) {
    await deps.tg.answerCallbackQuery(cbq.id);
    return;
  }
  // Late tap on an already-resolved request → inform the user without hitting
  // the daemon (the vote would 404/conflict). No ban check needed (it's benign).
  if (deps.resolvedRequests?.has(parsed.requestId)) {
    await deps.tg.answerCallbackQuery(cbq.id, 'Already resolved');
    return;
  }
  const chatId = cbq.message?.chat.id;
  const sessionId =
    chatId !== undefined ? deps.chats.sessionFor(chatId) : undefined;
  if (!sessionId) {
    await deps.tg.answerCallbackQuery(cbq.id, 'This chat is not bound.');
    return;
  }
  const subActor = subActorOf(cbq.from.id);
  if (deps.bans.has(subActor)) {
    await deps.tg.answerCallbackQuery(cbq.id, 'You are blocked.');
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
    await deps.tg.answerCallbackQuery(cbq.id, 'You are blocked.');
    return;
  }
  await deps.tg.answerCallbackQuery(
    cbq.id,
    parsed.action === 'approve' ? 'Approved' : 'Denied',
  );
}

/** The gateway's `error` text for a failed redeem, or a safe default. */
function inviteError(r: { body?: unknown }): string {
  const err = (r.body as { error?: unknown })?.error;
  return typeof err === 'string' ? err : 'Invalid or expired invite token';
}
