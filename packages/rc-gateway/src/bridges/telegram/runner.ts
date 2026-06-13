/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeClient, BridgeEvent } from '../client.js';
import type { TelegramBotApi } from './botApi.js';
import type { TelegramChatStore } from './chatStore.js';
import { handleUpdate, type DispatchDeps } from './dispatch.js';
import { renderPermissionRequest } from './render.js';

export interface TelegramBridgeConfig {
  botApi: TelegramBotApi;
  client: BridgeClient;
  chats: TelegramChatStore;
  /** User-facing gateway URL for deeplinks (QWEN_DAEMON_URL). */
  baseUrl: string;
  /** getUpdates long-poll seconds (default 25; short in tests). */
  pollTimeoutSec?: number;
  /** Logger for boot/error lines (default no-op). */
  log?: (msg: string) => void;
}

/**
 * The Telegram bridge runner (`add-telegram-bridge`): two cooperating loops over
 * the loopback contract — a Telegram long-poll loop (inbound: /start, prompts,
 * button votes) and a per-session SSE echo loop (outbound: render
 * permission_request → chat). It holds NO gateway internals; every gateway
 * interaction goes through the injected {@link BridgeClient} (bearer token over
 * HTTP+SSE), so this whole module moves to a separate process by changing only
 * its config. Local ban cache mirrors gateway 403s.
 *
 * NOTE: the live loops (real `getUpdates` against api.telegram.org) are not
 * CI-exercised — `deliverEvent` and a single poll tick ARE unit-tested; the
 * long-poll orchestration is code-reviewed/structurally verified only.
 */
export class TelegramBridge {
  private readonly cfg: TelegramBridgeConfig;
  private readonly bans = new Set<string>();
  private readonly subscribed = new Set<string>();
  private readonly log: (msg: string) => void;

  constructor(cfg: TelegramBridgeConfig) {
    this.cfg = cfg;
    this.log = cfg.log ?? (() => {});
  }

  private dispatchDeps(): DispatchDeps {
    return {
      bridge: this.cfg.client,
      tg: this.cfg.botApi,
      chats: this.cfg.chats,
      bans: this.bans,
    };
  }

  /**
   * Register the bridge, then run the poll loop (which also reconciles SSE
   * subscriptions each tick) until `signal` aborts. Resolves when the loop ends.
   */
  async start(signal: AbortSignal): Promise<void> {
    const reg = await this.cfg.client.register({
      id: 'telegram',
      displayName: 'Telegram',
      supportsActions: true,
      supportsMarkdown: true,
      maxMessageBytes: 4096,
    });
    this.log(
      reg.ok
        ? 'telegram bridge: registered with the gateway'
        : `telegram bridge: registration returned ${reg.status} (continuing)`,
    );
    // Subscribe to any sessions already bound from a previous run.
    this.reconcileSubscriptions(signal);
    await this.pollLoop(signal);
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let offset = 0;
    const timeout = this.cfg.pollTimeoutSec ?? 25;
    while (!signal.aborted) {
      const updates = await this.cfg.botApi.getUpdates(offset, timeout, signal);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handleUpdate(u, this.dispatchDeps());
      }
      // A /start in this batch may have bound a new session → pick it up.
      this.reconcileSubscriptions(signal);
    }
  }

  /** Open an SSE echo subscription for every bound session not already watched. */
  private reconcileSubscriptions(signal: AbortSignal): void {
    for (const sessionId of this.cfg.chats.boundSessions()) {
      if (this.subscribed.has(sessionId)) continue;
      this.subscribed.add(sessionId);
      void this.cfg.client
        .subscribeEvents(
          sessionId,
          (ev) => this.deliverEvent(sessionId, ev),
          signal,
        )
        .finally(() => this.subscribed.delete(sessionId));
    }
  }

  /**
   * Outbound: turn a session event into a Telegram message. Only
   * permission_request is rendered (the actionable surface); other frames are
   * ignored to keep chat quiet. Fire-and-forget sends (a failed send must not
   * break the SSE loop). Exposed for unit testing the render→send path.
   */
  deliverEvent(sessionId: string, ev: BridgeEvent): void {
    if (ev.type !== 'permission_request') return;
    const msg = renderPermissionRequest(ev.data, { baseUrl: this.cfg.baseUrl });
    for (const chatId of this.cfg.chats.chatsFor(sessionId)) {
      void this.cfg.botApi.sendMessage(chatId, msg.text, {
        inlineKeyboard: msg.inlineKeyboard,
      });
    }
  }
}
