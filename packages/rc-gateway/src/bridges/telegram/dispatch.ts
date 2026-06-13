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
  sendMessage(chatId: number, text: string): Promise<TgApiResult>;
  answerCallbackQuery(id: string, text?: string): Promise<TgApiResult>;
}

export interface DispatchDeps {
  bridge: PromptVoter;
  tg: ChatSender;
  chats: TelegramChatStore;
  /** Local ban cache (sub-actor ids) — mirrors gateway 403s to avoid re-hitting. */
  bans: Set<string>;
}

/**
 * Handle one Telegram update (`add-telegram-bridge`). Self-catching: one bad
 * update must never kill the poll loop. A `/start <sessionId>` binds the chat; a
 * plain message becomes a prompt (per-sender sub-actor, local ban check, 429 →
 * "slow down", 403 → cache the ban + drop); a button tap becomes a vote.
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
    const sessionId = text.slice('/start'.length).trim();
    if (!sessionId) {
      await deps.tg.sendMessage(chatId, 'Usage: /start <sessionId>');
      return;
    }
    await deps.chats.bind(chatId, sessionId);
    await deps.tg.sendMessage(
      chatId,
      `Bound to session ${sessionId}. Messages here are sent as prompts.`,
    );
    return;
  }

  const sessionId = deps.chats.sessionFor(chatId);
  if (!sessionId) {
    await deps.tg.sendMessage(
      chatId,
      'This chat is not bound to a session. Send /start <sessionId> first.',
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
