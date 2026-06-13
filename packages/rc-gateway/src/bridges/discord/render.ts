/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeHints } from '../hints.js';

/**
 * Pure Discord translation (`add-discord-bridge`): daemon `permission_request`
 * frames → a Discord message with message components (an ActionRow of buttons),
 * and button clicks ↔ gateway votes. No I/O, no SDK — just the wire shapes Discord
 * expects on `POST /channels/:id/messages` and the `custom_id` round-trip. Kept
 * pure so the rendering contract is unit-testable without a bot token or a live
 * gateway connection.
 *
 * Discord differs from Telegram in three ways that matter here, all reflected
 * below: ids are SNOWFLAKES (64-bit, carried as STRINGS — never `Number()`, which
 * rounds past 2^53 for the 17–19 digit ids Discord uses); the actionable surface
 * is message components (ActionRow → Buttons), not an inline keyboard; and the
 * per-component `custom_id` is capped at 100 CHARACTERS (not Telegram's 64 bytes).
 */

/** Discord component type discriminators (only the two the bridge emits). */
export const COMPONENT_TYPE = { actionRow: 1, button: 2 } as const;

/**
 * Discord button styles (the subset the bridge uses): Success (green) for
 * Approve, Danger (red) for Deny, Link (opens a URL) for the deeplink surface.
 */
export const BUTTON_STYLE = { success: 3, danger: 4, link: 5 } as const;

/** A Discord button component (interactive custom_id OR a link url, not both). */
export interface DiscordButton {
  type: typeof COMPONENT_TYPE.button;
  style: number;
  label: string;
  /** Present for interactive (Approve/Deny) buttons. */
  custom_id?: string;
  /** Present for Link-style buttons (the deeplink surface). */
  url?: string;
  /** Set true when re-rendering a resolved request (greys the button out). */
  disabled?: boolean;
}

/** A Discord ActionRow holding up to five buttons (we use at most two). */
export interface DiscordActionRow {
  type: typeof COMPONENT_TYPE.actionRow;
  components: DiscordButton[];
}

/** A rendered Discord message: text content + component rows. */
export interface RenderedMessage {
  content: string;
  components: DiscordActionRow[];
}

/** Discord caps a component `custom_id` at 100 characters. */
const CUSTOM_ID_MAX = 100;

/**
 * The per-sender sub-actor id for a Discord user snowflake. Snowflakes are
 * immutable and globally unique (usernames are mutable, discriminators
 * deprecated) — carried verbatim as a STRING, never coerced to a number.
 */
export function subActorOf(snowflake: string): string {
  return `discord:${snowflake}`;
}

/** Build the Approve/Deny custom_id (`vote:approve:<id>` / `vote:deny:<id>`). */
export function buildCustomId(
  action: 'approve' | 'deny',
  requestId: string,
): string {
  return `vote:${action}:${requestId}`;
}

/** The gateway vote outcome for a Discord button action. */
export function outcomeFor(
  action: 'approve' | 'deny',
): 'allow_once' | 'cancelled' {
  return action === 'approve' ? 'allow_once' : 'cancelled';
}

/** Parse `vote:<action>:<requestId>` custom_id, or null if not ours/invalid. */
export function parseCustomId(
  data: string | undefined,
): { action: 'approve' | 'deny'; requestId: string } | null {
  if (typeof data !== 'string') return null;
  const m = /^vote:(approve|deny):(.+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] as 'approve' | 'deny', requestId: m[2] };
}

/**
 * Render a `permission_request` frame's `data` into a Discord message per
 * `bridgeHints.recommendedSurface`:
 *  - `inline`  → argsSummaryShort + an ActionRow with Approve (Success) / Deny
 *    (Danger) buttons whose custom_id carries the vote.
 *  - `deeplink`→ argsSummaryShort + a single Link button "Open in web client";
 *    NEVER includes argsSummaryFull (so a sensitive/large call isn't dumped to
 *    the channel — the user opens the web client to see full args and approve).
 * `baseUrl` is the gateway URL the deeplink points at.
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
  const content = `🔐 Permission requested\n${short}`;

  if (hints.recommendedSurface === 'deeplink') {
    const base = opts.baseUrl.replace(/\/+$/, '');
    return {
      content,
      components: [
        {
          type: COMPONENT_TYPE.actionRow,
          components: [
            {
              type: COMPONENT_TYPE.button,
              style: BUTTON_STYLE.link,
              label: 'Open in web client',
              url: `${base}/ui/permission/${encodeURIComponent(requestId)}`,
            },
          ],
        },
      ],
    };
  }

  // inline (default): Approve/Deny. custom_id is bounded at 100 chars — request
  // ids are short in practice; an over-long id is clamped to inert (a production
  // bridge would map it to a short token).
  return {
    content,
    components: [
      {
        type: COMPONENT_TYPE.actionRow,
        components: [
          {
            type: COMPONENT_TYPE.button,
            style: BUTTON_STYLE.success,
            label: 'Approve',
            custom_id: clampCustomId(buildCustomId('approve', requestId)),
          },
          {
            type: COMPONENT_TYPE.button,
            style: BUTTON_STYLE.danger,
            label: 'Deny',
            custom_id: clampCustomId(buildCustomId('deny', requestId)),
          },
        ],
      },
    ],
  };
}

/** Discord rejects a custom_id > 100 chars; surface that as an empty (inert) id. */
function clampCustomId(data: string): string {
  return data.length <= CUSTOM_ID_MAX ? data : '';
}
