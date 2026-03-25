/**
 * Long-polling loop: getUpdates -> callback.
 * Platform-agnostic: the onMessage callback handles delivery.
 */

import { getUpdates } from './api.js';
import { MessageType, MessageItemType } from './types.js';
import type { WeixinMessage } from './types.js';
import { getStateDir } from './accounts.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** In-memory context token cache: userId -> contextToken */
const contextTokens = new Map<string, string>();

export function getContextToken(userId: string): string | undefined {
  return contextTokens.get(userId);
}

function cursorPath(): string {
  return join(getStateDir(), 'cursor.txt');
}

function loadCursor(): string {
  const p = cursorPath();
  if (existsSync(p)) return readFileSync(p, 'utf-8').trim();
  return '';
}

function saveCursor(cursor: string): void {
  writeFileSync(cursorPath(), cursor, 'utf-8');
}

export interface ParsedMessage {
  fromUserId: string;
  messageId: string;
  text: string;
}

export type OnMessageCallback = (msg: ParsedMessage) => Promise<void>;

export async function startPollLoop(params: {
  baseUrl: string;
  token: string;
  onMessage: OnMessageCallback;
  abortSignal: AbortSignal;
}): Promise<void> {
  const { baseUrl, token, onMessage, abortSignal } = params;

  let cursor = loadCursor();
  let consecutiveErrors = 0;
  let pollTimeoutMs = 40000;

  process.stderr.write('[weixin] Starting message poll loop...\n');

  while (!abortSignal.aborted) {
    try {
      const resp = await getUpdates(
        baseUrl,
        token,
        cursor,
        pollTimeoutMs,
        abortSignal,
      );

      if (resp.errcode === -14) {
        process.stderr.write(
          '[weixin] Session expired (errcode -14). Pausing 30s...\n',
        );
        await new Promise((r) => setTimeout(r, 30000));
        continue;
      }

      if (resp.ret !== 0 && resp.ret !== undefined) {
        throw new Error(
          `getUpdates error: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg}`,
        );
      }

      consecutiveErrors = 0;

      if (resp.get_updates_buf) {
        cursor = resp.get_updates_buf;
        saveCursor(cursor);
      }

      // Respect server-suggested poll timeout
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        pollTimeoutMs = resp.longpolling_timeout_ms + 5000; // add buffer for network
      }

      if (resp.msgs && resp.msgs.length > 0) {
        for (const msg of resp.msgs) {
          await processMessage(msg, onMessage);
        }
      }
    } catch (err: unknown) {
      if (abortSignal.aborted) break;

      consecutiveErrors++;
      process.stderr.write(
        `[weixin] Poll error (${consecutiveErrors}): ${err instanceof Error ? err.message : err}\n`,
      );

      if (consecutiveErrors >= 3) {
        process.stderr.write(
          '[weixin] Too many consecutive errors, backing off 30s...\n',
        );
        await new Promise((r) => setTimeout(r, 30000));
        consecutiveErrors = 0;
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  process.stderr.write('[weixin] Poll loop stopped.\n');
}

async function processMessage(
  msg: WeixinMessage,
  onMessage: OnMessageCallback,
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;

  const fromUserId = msg.from_user_id;
  if (!fromUserId) return;

  // Cache context token (required for replies)
  if (msg.context_token) {
    contextTokens.set(fromUserId, msg.context_token);
  }

  // Extract text content
  let textContent = '';
  if (msg.item_list) {
    for (const item of msg.item_list) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        textContent += (textContent ? '\n' : '') + item.text_item.text;
      }
      // MVP: skip media items, text only
    }
  }

  if (!textContent) return;

  await onMessage({
    fromUserId,
    messageId: String(msg.message_id || ''),
    text: textContent,
  });
}
