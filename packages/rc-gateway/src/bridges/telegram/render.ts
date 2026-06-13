/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeHints } from '../hints.js';

/**
 * Pure Telegram translation (`add-telegram-bridge`): daemon `permission_request`
 * frames → Telegram message + inline keyboard, and button taps ↔ gateway votes.
 * No I/O, no SDK — just the wire shapes. Kept pure so the rendering contract is
 * unit-testable without a bot token or live Telegram.
 */

/** A Telegram inline-keyboard button (callback OR url, not both). */
export interface TgButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/** A rendered Telegram message: plain-text body + inline keyboard rows. */
export interface RenderedMessage {
  text: string;
  inlineKeyboard: TgButton[][];
}

/** Telegram callback_data is capped at 64 bytes. */
const CALLBACK_MAX = 64;

/** The per-sender sub-actor id for a Telegram numeric user id. */
export function subActorOf(senderId: number | string): string {
  return `telegram:${senderId}`;
}

/** Build the Approve/Deny callback_data (`vote:approve:<id>` / `vote:deny:<id>`). */
export function buildCallbackData(
  action: 'approve' | 'deny',
  requestId: string,
): string {
  return `vote:${action}:${requestId}`;
}

/** The gateway vote outcome for a Telegram button action. */
export function outcomeFor(
  action: 'approve' | 'deny',
): 'allow_once' | 'cancelled' {
  return action === 'approve' ? 'allow_once' : 'cancelled';
}

/** Parse `vote:<action>:<requestId>` callback_data, or null if not ours/invalid. */
export function parseCallbackData(
  data: string | undefined,
): { action: 'approve' | 'deny'; requestId: string } | null {
  if (typeof data !== 'string') return null;
  const m = /^vote:(approve|deny):(.+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] as 'approve' | 'deny', requestId: m[2] };
}

/**
 * Escape text for Telegram MarkdownV2 (the bridge declares
 * `supportsMarkdown: "limited"`). Every reserved char gets a preceding
 * backslash. Used by the runner for markdown-rendered echoes; permission
 * messages are sent as PLAIN text so the args summary appears verbatim.
 */
export function escapeMarkdownV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Render a `permission_request` frame's `data` into a Telegram message per
 * `bridgeHints.recommendedSurface`:
 *  - `inline`  → argsSummaryShort + Approve/Deny buttons (callback votes).
 *  - `deeplink`→ argsSummaryShort + a single "Open in web client" url button;
 *    NEVER includes argsSummaryFull (so a sensitive/large call isn't dumped to
 *    chat — the user opens the web client to see full args and approve).
 * Plain text (no parse_mode) so the summary appears verbatim. `baseUrl` is the
 * gateway URL the deeplink points at.
 */
export function renderPermissionRequest(
  data: unknown,
  opts: { baseUrl: string },
): RenderedMessage {
  const d = (data ?? {}) as Record<string, unknown>;
  const hints = (d['bridgeHints'] ?? {}) as Partial<BridgeHints>;
  const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
  const short =
    typeof hints.argsSummaryShort === 'string' && hints.argsSummaryShort
      ? hints.argsSummaryShort
      : 'A tool wants to run.';
  const text = `🔐 Permission requested\n${short}`;

  if (hints.recommendedSurface === 'deeplink') {
    const base = opts.baseUrl.replace(/\/+$/, '');
    return {
      text,
      inlineKeyboard: [
        [
          {
            text: 'Open in web client',
            url: `${base}/ui/permission/${encodeURIComponent(requestId)}`,
          },
        ],
      ],
    };
  }

  // inline (default): Approve/Deny. callback_data is bounded at 64 bytes —
  // request ids are short in practice; an over-long id would be rejected by
  // Telegram (a production bridge would map it to a short token).
  const approve = buildCallbackData('approve', requestId);
  const deny = buildCallbackData('deny', requestId);
  return {
    text,
    inlineKeyboard: [
      [
        { text: 'Approve', callback_data: clampCallback(approve) },
        { text: 'Deny', callback_data: clampCallback(deny) },
      ],
    ],
  };
}

/** Telegram rejects callback_data > 64 bytes; surface that as an empty (inert) cb. */
function clampCallback(data: string): string {
  return Buffer.byteLength(data, 'utf8') <= CALLBACK_MAX ? data : '';
}
