/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TgButton } from './render.js';

/**
 * Thin Telegram Bot API client over `fetch` — NO SDK dependency (the Bot API is
 * plain HTTPS JSON), so no new supply-chain surface enters the gateway process
 * (the hybrid tradeoff: the chat dep stays a stdlib `fetch`, not a package). Only
 * the three methods the bridge needs: long-poll `getUpdates`, `sendMessage`,
 * `answerCallbackQuery`. `apiBase`/`fetchImpl` are injectable for tests.
 */

/** A minimal slice of a Telegram update (only the fields the bridge reads). */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

/** Result of an outbound Bot API call (surfaces Telegram's 429 retry_after). */
export interface TgApiResult {
  ok: boolean;
  status: number;
  /** Telegram's `parameters.retry_after` (seconds) on a 429. */
  retryAfterSec?: number;
  result?: unknown;
}

export interface TelegramBotApiConfig {
  botToken: string;
  fetchImpl?: typeof fetch;
  /** Defaults to https://api.telegram.org. */
  apiBase?: string;
}

export class TelegramBotApi {
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(cfg: TelegramBotApiConfig) {
    this.botToken = cfg.botToken;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.apiBase = (cfg.apiBase ?? 'https://api.telegram.org').replace(
      /\/+$/,
      '',
    );
  }

  private async call(
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<TgApiResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.apiBase}/bot${this.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch {
      return { ok: false, status: 0 }; // network error / abort → caller backs off
    }
    const json = (await res.json().catch(() => undefined)) as
      | {
          ok?: boolean;
          result?: unknown;
          parameters?: { retry_after?: number };
        }
      | undefined;
    const out: TgApiResult = {
      ok: res.ok && json?.ok === true,
      status: res.status,
    };
    if (res.status === 429) {
      const ra = json?.parameters?.retry_after;
      if (typeof ra === 'number' && ra > 0) out.retryAfterSec = ra;
    }
    if (json?.result !== undefined) out.result = json.result;
    return out;
  }

  /** Send a chat message (plain text), optionally with an inline keyboard. */
  async sendMessage(
    chatId: number,
    text: string,
    opts: { inlineKeyboard?: TgButton[][] } = {},
  ): Promise<TgApiResult> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.inlineKeyboard && opts.inlineKeyboard.length > 0) {
      body['reply_markup'] = { inline_keyboard: opts.inlineKeyboard };
    }
    return this.call('sendMessage', body);
  }

  /**
   * Edit an existing message in place — used to clear the inline keyboard and
   * append the outcome when a `permission_resolved` event arrives.
   */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { inlineKeyboard?: TgButton[][] } = {},
  ): Promise<TgApiResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (opts.inlineKeyboard !== undefined) {
      body['reply_markup'] = { inline_keyboard: opts.inlineKeyboard };
    }
    return this.call('editMessageText', body);
  }

  /** Acknowledge a button tap (clears the client-side spinner). */
  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<TgApiResult> {
    const body: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (text) body['text'] = text;
    return this.call('answerCallbackQuery', body);
  }

  /**
   * Long-poll for updates from `offset` (the last seen update_id + 1), blocking
   * up to `timeoutSec` server-side. Returns the parsed updates ([] on error or
   * timeout). Restricts allowed_updates to the two kinds the bridge handles.
   */
  async getUpdates(
    offset: number,
    timeoutSec = 25,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const res = await this.call(
      'getUpdates',
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
    );
    return res.ok && Array.isArray(res.result)
      ? (res.result as TelegramUpdate[])
      : [];
  }
}
