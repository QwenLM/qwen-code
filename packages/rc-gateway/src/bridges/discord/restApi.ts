/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DiscordActionRow } from './render.js';

/**
 * Thin Discord REST client over `fetch` — NO SDK dependency (the REST API is
 * plain HTTPS JSON), so no new supply-chain surface enters the gateway process
 * (the same hybrid tradeoff the Telegram bridge made for the Bot API). This
 * covers only the OUTBOUND calls the bridge needs: post a channel message with
 * components, edit a message (to disable buttons on resolve), and the two-step
 * interaction reply (defer → edit) used for ephemeral vote feedback.
 *
 * This is the testable half of Discord transport. The INBOUND half — the gateway
 * WebSocket that delivers INTERACTION_CREATE / MESSAGE_CREATE — is a separate,
 * stateful protocol and is NOT built here.
 *
 * Snowflakes (channel/message/interaction/application ids) are STRINGS throughout
 * — never coerced to numbers.
 */

/** Discord interaction-response callback types (the subset the bridge uses). */
export const INTERACTION_CALLBACK = {
  /** Immediate ephemeral message. */
  channelMessage: 4,
  /** Acknowledge now, edit the reply later (used for vote feedback + ban ACK). */
  deferredEphemeral: 5,
} as const;

/** Discord message flag: ephemeral (visible only to the interacting user). */
export const EPHEMERAL_FLAG = 64;

/** Result of an outbound REST call (surfaces Discord's 429 retry_after). */
export interface DiscordRestResult {
  ok: boolean;
  status: number;
  /** Discord's `retry_after` (seconds) on a 429. */
  retryAfterSec?: number;
  /** Parsed JSON body when present (e.g. a created message's `id`). */
  body?: unknown;
}

export interface DiscordRestConfig {
  botToken: string;
  applicationId: string;
  fetchImpl?: typeof fetch;
  /** Defaults to https://discord.com/api/v10. */
  apiBase?: string;
}

export class DiscordRestApi {
  private readonly botToken: string;
  private readonly applicationId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(cfg: DiscordRestConfig) {
    this.botToken = cfg.botToken;
    this.applicationId = cfg.applicationId;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.apiBase = (cfg.apiBase ?? 'https://discord.com/api/v10').replace(
      /\/+$/,
      '',
    );
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<DiscordRestResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          // Bot auth (NOT a bearer); never logged.
          Authorization: `Bot ${this.botToken}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 0 }; // network error → caller backs off
    }
    const json = (await res.json().catch(() => undefined)) as
      | { retry_after?: number }
      | undefined;
    const out: DiscordRestResult = { ok: res.ok, status: res.status };
    if (res.status === 429 && typeof json?.retry_after === 'number') {
      out.retryAfterSec = json.retry_after;
    }
    if (json !== undefined) out.body = json;
    return out;
  }

  /** Post a message to a channel (optionally with component rows). */
  async createMessage(
    channelId: string,
    content: string,
    components: DiscordActionRow[] = [],
  ): Promise<DiscordRestResult> {
    // Discord parses @everyone/@here/role mentions by DEFAULT when
    // `allowed_mentions` is absent, so relayed agent output (a streamed
    // reply, a tool call's argsSummaryShort) containing "@everyone" would
    // ping the whole server using the bot's permissions. Suppress ALL
    // mention parsing — this is a relay of untrusted content, not a
    // deliberate human ping.
    const body: Record<string, unknown> = {
      content,
      allowed_mentions: { parse: [] },
    };
    if (components.length > 0) body['components'] = components;
    return this.call(
      'POST',
      `/channels/${encodeURIComponent(channelId)}/messages`,
      body,
    );
  }

  /**
   * Edit an existing channel message — used on `permission_resolved` to disable
   * the vote buttons and append the outcome. Pass the already-disabled component
   * rows (the renderer owns producing them).
   */
  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
    components: DiscordActionRow[] = [],
  ): Promise<DiscordRestResult> {
    return this.call(
      'PATCH',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { content, components, allowed_mentions: { parse: [] } },
    );
  }

  /**
   * Open a PUBLIC thread off an existing message (`add-discord-bridge`: "Threads
   * on long streams"). Discord: POST `/channels/<id>/messages/<msgId>/threads`.
   * `name` is the thread title; the created thread is itself a channel, so
   * subsequent stream flushes post to its id via {@link createMessage}.
   */
  async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<DiscordRestResult> {
    return this.call(
      'POST',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
      { name },
    );
  }

  /**
   * Acknowledge an interaction with a DEFERRED ephemeral reply. Discord requires
   * an interaction be acknowledged within 3 seconds; deferring buys time to POST
   * the vote to the daemon, after which {@link editInteractionReply} fills in the
   * user-visible text. Also used to silently ACK a banned user's click.
   */
  async deferInteraction(
    interactionId: string,
    interactionToken: string,
  ): Promise<DiscordRestResult> {
    return this.call(
      'POST',
      `/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
      {
        type: INTERACTION_CALLBACK.deferredEphemeral,
        data: { flags: EPHEMERAL_FLAG },
      },
    );
  }

  /**
   * Reply to an interaction immediately with an ephemeral message (used by the
   * slash-command handlers, which reply ephemerally per the spec).
   */
  async replyEphemeral(
    interactionId: string,
    interactionToken: string,
    content: string,
  ): Promise<DiscordRestResult> {
    return this.call(
      'POST',
      `/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
      {
        type: INTERACTION_CALLBACK.channelMessage,
        data: { content, flags: EPHEMERAL_FLAG },
      },
    );
  }

  /**
   * Edit the (deferred) original interaction reply — sets the "You voted approve"
   * text after the vote round-trips. Targets the application webhook's @original
   * message, which is how a deferred interaction reply is later populated.
   */
  async editInteractionReply(
    interactionToken: string,
    content: string,
  ): Promise<DiscordRestResult> {
    return this.call(
      'PATCH',
      `/webhooks/${encodeURIComponent(this.applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
      { content },
    );
  }
}
