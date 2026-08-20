/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeClient, BridgeEvent } from '../client.js';
import type { DiscordRestApi } from './restApi.js';
import type { DiscordChannelStore } from './channelStore.js';
import {
  handleMessage,
  handleSlashCommand,
  handleComponent,
  type DiscordDispatchDeps,
  type NormalizedMessage,
  type NormalizedSlashCommand,
  type NormalizedComponent,
} from './dispatch.js';
import { renderPermissionRequest, type DiscordActionRow } from './render.js';
import { StreamRouter, type StreamPoster } from './streamRouter.js';
import { extractAgentText } from './streamFrame.js';
import { runHeartbeatLoop } from '../heartbeat.js';
import { heartbeatIntervalMsOf } from '../heartbeat.js';
import type { CursorStore } from '../cursorStore.js';

/**
 * The injected inbound transport. The runner only needs "start the gateway and
 * push normalized events back to me" — the concrete `DiscordGateway` (which
 * imports discord.js) implements this, so the runner's outbound/SSE logic stays
 * unit-testable without a live socket or the discord.js dependency.
 */
export interface GatewayController {
  start(signal: AbortSignal): Promise<void>;
}

/** Handlers the gateway invokes for each normalized inbound event. */
export interface GatewayHandlers {
  onMessage(m: NormalizedMessage): void;
  onSlash(c: NormalizedSlashCommand): void;
  onButton(c: NormalizedComponent): void;
}

export interface DiscordBridgeConfig {
  client: BridgeClient;
  rest: DiscordRestApi;
  channels: DiscordChannelStore;
  /** Builds the inbound gateway given the handlers (so the runner injects them). */
  makeGateway: (handlers: GatewayHandlers) => GatewayController;
  /** User-facing gateway URL for deeplinks (QWEN_DAEMON_URL). */
  baseUrl: string;
  /**
   * Durable cursor store for SSE resume positions. When provided, the bridge
   * persists `lastEventId` per session so cursors survive restarts.
   */
  cursors?: CursorStore;
  /**
   * The bridge's own token id (used as the cursor-store partition key). Required
   * when `cursors` is set.
   */
  tokenId?: string;
  /** Logger for boot/error lines (default no-op). */
  log?: (msg: string) => void;
  /** Injectable backoff sleep (tests). Resolves early on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable idle-flush timer for the stream router (tests). */
  setTimer?: (ms: number, fn: () => void) => () => void;
}

/** SSE reconnect backoff per the spec: initial 1s, max 30s, jitter ±20%. */
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Where a rendered permission_request landed, so it can be edited on resolve. */
interface SentRequest {
  channelId: string;
  messageId: string;
  content: string;
  components: DiscordActionRow[];
}

/**
 * The Discord bridge runner (`add-discord-bridge`): the inbound gateway loop
 * (discord.js, injected) feeds dispatch; an outbound SSE echo loop per bound
 * session renders permission_request frames into channel messages (edited to
 * disable the buttons when resolved) AND streams session_update prose into the
 * channel via the {@link StreamRouter} (buffered, ≤2000-char safe-split, with
 * threads on long turns). It holds NO gateway internals — every
 * daemon interaction goes through the injected {@link BridgeClient} over the
 * loopback HTTP+SSE contract, so the whole bridge moves to a separate process by
 * changing only config. Local ban cache mirrors gateway 403s.
 *
 * VERIFICATION CEILING: the outbound paths (deliverEvent render→send→edit) and
 * subscription reconciliation ARE unit-tested with fakes. The live discord.js
 * gateway connection (heartbeat, IDENTIFY, RESUME, INTERACTION_CREATE delivery)
 * is delegated to discord.js and is NOT exercised here — there is no real Discord
 * to test against in this environment.
 */
/** This bridge's stable id (registration + invite-redeem route path). */
const DISCORD_BRIDGE_ID = 'discord';

export class DiscordBridge {
  private readonly cfg: DiscordBridgeConfig;
  private readonly bans = new Set<string>();
  private readonly subscribed = new Set<string>();
  /** sessionId → highest SSE frame id seen (resume cursor on reconnect). */
  private readonly lastEventId = new Map<string, number>();
  /** requestId → every channel message that rendered it (edited on resolve). */
  private readonly sent = new Map<string, SentRequest[]>();
  /** Streams agent prose into channels with buffering + threads-on-long-stream. */
  private readonly stream: StreamRouter;
  private readonly log: (msg: string) => void;

  constructor(cfg: DiscordBridgeConfig) {
    this.cfg = cfg;
    this.log = cfg.log ?? (() => {});
    const poster: StreamPoster = {
      postMessage: async (dest, content) => {
        const r = await this.cfg.rest.createMessage(dest, content);
        return r.ok && typeof (r.body as { id?: unknown })?.id === 'string'
          ? (r.body as { id: string }).id
          : null;
      },
      createThread: async (channelId, messageId, name) => {
        const r = await this.cfg.rest.createThread(channelId, messageId, name);
        return r.ok && typeof (r.body as { id?: unknown })?.id === 'string'
          ? (r.body as { id: string }).id
          : null;
      },
    };
    this.stream = new StreamRouter({
      poster,
      channelsFor: (sessionId) => this.cfg.channels.channelsFor(sessionId),
      ...(cfg.setTimer ? { setTimer: cfg.setTimer } : {}),
    });
  }

  private dispatchDeps(): DiscordDispatchDeps {
    return {
      bridge: this.cfg.client,
      rest: this.cfg.rest,
      channels: this.cfg.channels,
      bridgeId: DISCORD_BRIDGE_ID,
      bans: this.bans,
      onTurnBoundary: (sessionId) => this.stream.bumpTurn(sessionId),
    };
  }

  /** Register (or re-register) this bridge's capabilities with the gateway. */
  private registerSelf(): Promise<import('../client.js').WriteResult> {
    return this.cfg.client.register({
      id: DISCORD_BRIDGE_ID,
      displayName: 'Discord',
      supportsActions: true, // Approve/Deny buttons
      supportsMarkdown: 'limited', // Discord renders a limited markdown subset
      supportsThreads: true, // threads on long streams
      supportsEdits: true, // edits the message on resolve
      maxMessageChars: 2000,
    });
  }

  /**
   * Register the bridge, start the heartbeat loop, subscribe to already-bound
   * sessions, then start the inbound gateway. Resolves when the gateway loop ends.
   */
  async start(signal: AbortSignal): Promise<void> {
    // Load durable cursors so SSE subscriptions resume from where they left off.
    if (this.cfg.cursors && this.cfg.tokenId) {
      for (const sessionId of this.cfg.channels.boundSessions()) {
        const entry = this.cfg.cursors.get(this.cfg.tokenId, sessionId);
        if (entry) this.lastEventId.set(sessionId, entry.lastEventId);
      }
    }
    const reg = await this.registerSelf();
    this.log(
      reg.ok
        ? 'discord bridge: registered with the gateway'
        : `discord bridge: registration returned ${reg.status} (continuing)`,
    );
    // The heartbeat loop uses its OWN (abort-aware) timer, not cfg.sleep — keeping
    // it independent of the SSE reconnect-backoff sleep.
    void runHeartbeatLoop({
      heartbeat: (id) => this.cfg.client.heartbeat(id),
      reRegister: () => this.registerSelf(),
      bridgeId: DISCORD_BRIDGE_ID,
      intervalMs: heartbeatIntervalMsOf(reg.body),
      signal,
      log: this.log,
    });
    this.reconcileSubscriptions(signal);

    const gateway = this.cfg.makeGateway({
      onMessage: (m) => {
        void handleMessage(m, this.dispatchDeps());
      },
      onSlash: (c) => {
        // A successful /qwen attach binds a new session → subscribe to it.
        void handleSlashCommand(c, this.dispatchDeps()).finally(() =>
          this.reconcileSubscriptions(signal),
        );
      },
      onButton: (c) => {
        void handleComponent(c, this.dispatchDeps());
      },
    });
    await gateway.start(signal);
  }

  /**
   * Start a self-healing SSE echo loop for every bound session not already
   * watched. Unlike Telegram (whose poll loop re-reconciles every tick so a
   * dropped stream self-heals), Discord's inbound is push — so each session needs
   * its OWN reconnect loop, or the approval echo silently dies on the first SSE
   * disconnect (network blip, gateway restart, token eviction). The loop
   * re-subscribes with exponential backoff (1s→30s, jitter ±20%) until `signal`
   * aborts.
   */
  private reconcileSubscriptions(signal: AbortSignal): void {
    for (const sessionId of this.cfg.channels.boundSessions()) {
      if (this.subscribed.has(sessionId)) continue;
      this.subscribed.add(sessionId);
      void this.subscriptionLoop(sessionId, signal);
    }
  }

  private async subscriptionLoop(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const sleep = this.cfg.sleep ?? defaultSleep;
    let backoff = RECONNECT_INITIAL_MS;
    try {
      while (!signal.aborted) {
        // subscribeEvents resolves when the stream ends (or never opened); the
        // caller owns reconnection — that's this loop. Resume from the last frame
        // id seen so a reconnect catches frames that arrived during the blip.
        await this.cfg.client.subscribeEvents(
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
        );
        if (signal.aborted) break;
        await sleep(jitter(backoff), signal);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    } finally {
      this.subscribed.delete(sessionId); // allow a later reconcile to re-arm it
    }
  }

  /**
   * Outbound SSE echo. permission_request → channel message with vote buttons;
   * permission_resolved → edit (disable buttons + outcome) AND mark the turn
   * boundary so the next stream chunk starts a fresh turn; session_update →
   * stream the agent's prose through the buffer/thread router. Other frames are
   * ignored to keep channels quiet. Fire-and-forget (a failed send must not break
   * the SSE loop). Exposed for unit testing.
   */
  deliverEvent(sessionId: string, ev: BridgeEvent): void {
    if (ev.type === 'permission_request') {
      void this.deliverPermissionRequest(sessionId, ev.data);
    } else if (ev.type === 'permission_resolved') {
      this.stream.notePermissionResolved(sessionId); // next chunk = new turn
      void this.deliverPermissionResolved(ev.data);
    } else if (ev.type === 'session_update') {
      const text = extractAgentText(ev.data);
      if (text) this.stream.onChunk(sessionId, text);
    }
  }

  private async deliverPermissionRequest(
    sessionId: string,
    data: unknown,
  ): Promise<void> {
    const d = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
    const msg = renderPermissionRequest(data, { baseUrl: this.cfg.baseUrl });
    for (const channelId of this.cfg.channels.channelsFor(sessionId)) {
      const r = await this.cfg.rest.createMessage(
        channelId,
        msg.content,
        msg.components,
      );
      const messageId =
        r.ok && typeof (r.body as { id?: unknown })?.id === 'string'
          ? (r.body as { id: string }).id
          : undefined;
      if (requestId && messageId) {
        const list = this.sent.get(requestId) ?? [];
        list.push({
          channelId,
          messageId,
          content: msg.content,
          components: msg.components,
        });
        this.sent.set(requestId, list);
      }
    }
  }

  private async deliverPermissionResolved(data: unknown): Promise<void> {
    const d = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
    const targets = this.sent.get(requestId);
    if (!targets) return;
    this.sent.delete(requestId);
    const outcome =
      typeof d['outcome'] === 'string' ? (d['outcome'] as string) : 'resolved';
    for (const t of targets) {
      await this.cfg.rest.editMessage(
        t.channelId,
        t.messageId,
        `${t.content}\n\nResolved: ${outcome}`,
        disableRows(t.components),
      );
    }
  }
}

/** Clone component rows with every button disabled (for the resolve edit). */
function disableRows(rows: DiscordActionRow[]): DiscordActionRow[] {
  return rows.map((row) => ({
    type: row.type,
    components: row.components.map((b) => ({ ...b, disabled: true })),
  }));
}

/** Apply ±20% jitter to a backoff delay (spreads herd reconnects). */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** Sleep `ms`, resolving early if `signal` aborts (so shutdown is prompt). */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
