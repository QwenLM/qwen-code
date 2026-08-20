/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeClient, BridgeEvent } from '../client.js';
import type { TelegramBotApi } from './botApi.js';
import type { TelegramChatStore } from './chatStore.js';
import {
  handleUpdate,
  type DispatchDeps,
  type SentPermissionMessage,
} from './dispatch.js';
import { renderPermissionRequest } from './render.js';
import { runHeartbeatLoop, heartbeatIntervalMsOf } from '../heartbeat.js';
import type { CursorStore } from '../cursorStore.js';

/**
 * Live reachability state backing the bridge's `GET /healthz` report
 * (health.ts). The bridge owns the two booleans; health.ts only formats them
 * into a report.
 */
export interface TelegramHealthState {
  daemonReachable: boolean;
  telegramReachable: boolean;
}

export interface TelegramBridgeConfig {
  botApi: TelegramBotApi;
  client: BridgeClient;
  chats: TelegramChatStore;
  /**
   * Durable cursor store for SSE resume positions. When provided, the bridge
   * persists `lastEventId` per session so cursors survive restarts.
   */
  cursors?: CursorStore;
  /**
   * The bridge's own token id (used as the cursor-store partition key so
   * multiple bridge instances don't collide). Required when `cursors` is set.
   */
  tokenId?: string;
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
/** This bridge's stable id (registration + invite-redeem route path). */
const TELEGRAM_BRIDGE_ID = 'telegram';

export class TelegramBridge {
  private readonly cfg: TelegramBridgeConfig;
  private readonly bans = new Set<string>();
  private readonly subscribed = new Set<string>();
  /**
   * sessionId → highest SSE frame id seen (in-memory mirror of the durable
   * cursor store). Populated from the cursor store on start; updated on each
   * frame and flushed to the store when `cursors` is configured.
   */
  private readonly lastEventId = new Map<string, number>();
  /**
   * requestId → list of sent messages (chatId + messageId + original text) so
   * that `permission_resolved` events can edit the messages in place.
   */
  private readonly sentRequests = new Map<string, SentPermissionMessage[]>();
  /**
   * Set of requestIds that have been resolved — used by dispatch to short-circuit
   * late callback_query taps without hitting the daemon.
   */
  private readonly resolvedRequests = new Set<string>();
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
      bridgeId: TELEGRAM_BRIDGE_ID,
      bans: this.bans,
      sentRequests: this.sentRequests,
      resolvedRequests: this.resolvedRequests,
    };
  }

  /** Register (or re-register) this bridge's capabilities with the gateway. */
  private registerSelf(): Promise<import('../client.js').WriteResult> {
    return this.cfg.client.register({
      id: TELEGRAM_BRIDGE_ID,
      displayName: 'Telegram',
      supportsActions: true, // inline keyboard buttons
      supportsMarkdown: 'limited', // MarkdownV2 (constrained, escaped)
      supportsThreads: false, // no thread support
      supportsEdits: true, // editMessageText clears keyboard on resolve
      maxMessageChars: 4096,
    });
  }

  /**
   * Register, start the heartbeat loop, then run the poll loop (which also
   * reconciles SSE subscriptions each tick) until `signal` aborts.
   */
  async start(signal: AbortSignal): Promise<void> {
    // Load durable cursors so SSE subscriptions resume from where they left off.
    if (this.cfg.cursors && this.cfg.tokenId) {
      for (const sessionId of this.cfg.chats.boundSessions()) {
        const entry = this.cfg.cursors.get(this.cfg.tokenId, sessionId);
        if (entry) this.lastEventId.set(sessionId, entry.lastEventId);
      }
    }
    const reg = await this.registerSelf();
    this.log(
      reg.ok
        ? 'telegram bridge: registered with the gateway'
        : `telegram bridge: registration returned ${reg.status} (continuing)`,
    );
    void runHeartbeatLoop({
      heartbeat: (id) => this.cfg.client.heartbeat(id),
      reRegister: () => this.registerSelf(),
      bridgeId: TELEGRAM_BRIDGE_ID,
      intervalMs: heartbeatIntervalMsOf(reg.body),
      signal,
      log: this.log,
    });
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
          (ev) => {
            if (typeof ev.id === 'number') {
              this.lastEventId.set(sessionId, ev.id);
              // Persist the cursor so restarts resume from here.
              if (this.cfg.cursors && this.cfg.tokenId) {
                void this.cfg.cursors.setLastEventId(
                  this.cfg.tokenId,
                  sessionId,
                  ev.id,
                );
              }
            }
            this.deliverEvent(sessionId, ev);
          },
          signal,
          this.lastEventId.get(sessionId),
        )
        .finally(() => this.subscribed.delete(sessionId));
    }
  }

  /**
   * Outbound: turn a session event into a Telegram message. Only
   * `permission_request` and `permission_resolved` are acted on; other frames
   * are ignored to keep chat quiet. Fire-and-forget sends (a failed send must
   * not break the SSE loop). Exposed for unit testing the render→send path.
   */
  deliverEvent(sessionId: string, ev: BridgeEvent): void {
    if (ev.type === 'permission_request') {
      void this.deliverPermissionRequest(sessionId, ev.data);
    } else if (ev.type === 'permission_resolved') {
      void this.deliverPermissionResolved(ev.data);
    }
  }

  private async deliverPermissionRequest(
    sessionId: string,
    data: unknown,
  ): Promise<void> {
    const msg = renderPermissionRequest(data, { baseUrl: this.cfg.baseUrl });
    const d = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
    for (const chatId of this.cfg.chats.chatsFor(sessionId)) {
      const result = await this.cfg.botApi.sendMessage(chatId, msg.text, {
        inlineKeyboard: msg.inlineKeyboard,
      });
      // Record the sent message so permission_resolved can edit it in place.
      if (requestId && result.ok) {
        const msgId =
          typeof (result.result as Record<string, unknown> | undefined)?.[
            'message_id'
          ] === 'number'
            ? ((result.result as Record<string, unknown>)[
                'message_id'
              ] as number)
            : 0;
        if (msgId) {
          const existing = this.sentRequests.get(requestId) ?? [];
          existing.push({ chatId, messageId: msgId, text: msg.text });
          this.sentRequests.set(requestId, existing);
        }
      }
    }
  }

  private async deliverPermissionResolved(data: unknown): Promise<void> {
    const d = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
    const outcome =
      typeof d['outcome'] === 'string' ? d['outcome'] : 'resolved';
    if (requestId) this.resolvedRequests.add(requestId);
    const targets = requestId ? this.sentRequests.get(requestId) : undefined;
    if (!targets) return;
    this.sentRequests.delete(requestId);
    for (const t of targets) {
      await this.cfg.botApi.editMessageText(
        t.chatId,
        t.messageId,
        `${t.text}\n\nResolved: ${outcome}`,
        { inlineKeyboard: [] },
      );
    }
  }
}
