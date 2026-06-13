/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeClient, BridgeEvent } from '../client.js';
import type { MatrixRoomStore } from './roomStore.js';
import {
  handleMessage,
  handleReaction,
  ENCRYPTED_ROOM_NOTICE,
  type MatrixDispatchDeps,
  type MatrixResponder,
  type TrackedEvent,
} from './dispatch.js';
import {
  extractSync,
  type RoomStateCtx,
  type PowerLevelsContent,
} from './normalize.js';
import {
  renderPermissionRequest,
  renderResolveEdit,
  tracksReactions,
} from './render.js';

/** The inbound Matrix surface the runner needs (subset of MatrixRestApi). */
export interface MatrixInbound extends MatrixResponder {
  joinRoom(roomId: string): Promise<{ ok: boolean; status: number }>;
}

/** A single `/sync` long-poll (injected so the runner is testable offline). */
export type SyncOnce = (
  since: string | undefined,
  signal: AbortSignal,
) => Promise<unknown>;

export interface MatrixBridgeConfig {
  client: BridgeClient;
  rest: MatrixInbound;
  rooms: MatrixRoomStore;
  /** The bot's own MXID (already whoami-validated by the caller). */
  botUserId: string;
  /** User-facing gateway URL for deeplinks (QWEN_DAEMON_URL). */
  baseUrl: string;
  /** Command prefix (default `!qwen`). */
  commandPrefix?: string;
  syncOnce: SyncOnce;
  /** Injectable backoff sleep (tests). Resolves early on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}

/** SSE reconnect backoff per the spec: initial 1s, max 30s, jitter ±20%. */
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Where a rendered permission_request landed (for the resolve edit). */
interface SentRequest {
  roomId: string;
  eventId: string;
  body: string;
}

/**
 * The Matrix bridge runner (`add-matrix-bridge`): a `/sync` long-poll loop feeds
 * dispatch (messages → prompts/commands, reactions → votes, invites → auto-join,
 * encrypted rooms → a one-time refusal notice), while an outbound SSE echo loop
 * per bound session renders permission_request frames into room messages and
 * edits them (via `m.replace`) on resolve. It holds NO gateway internals — every
 * daemon interaction goes through the injected {@link BridgeClient} over the
 * loopback contract, so the bridge is sidecar-extractable by config.
 *
 * VERIFICATION CEILING: the outbound (deliverEvent), the sync EXTRACTION, and the
 * dispatch are unit-tested; the live `/sync` long-poll against a homeserver is not
 * CI-exercised. E2EE rooms are detect-and-refused, not decrypted (no crypto).
 */
export class MatrixBridge {
  private readonly cfg: MatrixBridgeConfig;
  private readonly commandPrefix: string;
  private readonly bans = new Set<string>();
  private readonly encryptedRooms = new Set<string>();
  private readonly subscribed = new Set<string>();
  /** eventId → tracked permission_request (reaction → vote lookup). */
  private readonly tracked = new Map<string, TrackedEvent>();
  /** requestId → the sent messages that rendered it (for the resolve edit). */
  private readonly sent = new Map<string, SentRequest[]>();
  private readonly ctx: RoomStateCtx;
  private readonly log: (msg: string) => void;

  constructor(cfg: MatrixBridgeConfig) {
    this.cfg = cfg;
    this.commandPrefix = cfg.commandPrefix ?? '!qwen';
    this.log = cfg.log ?? (() => {});
    this.ctx = {
      botUserId: cfg.botUserId,
      powerLevels: new Map<string, PowerLevelsContent>(),
    };
  }

  private dispatchDeps(): MatrixDispatchDeps {
    return {
      bridge: this.cfg.client,
      rest: this.cfg.rest,
      rooms: this.cfg.rooms,
      bans: this.bans,
      encryptedRooms: this.encryptedRooms,
      tracked: this.tracked,
      commandPrefix: this.commandPrefix,
    };
  }

  /** Register, subscribe to bound sessions, then run the sync loop until abort. */
  async start(signal: AbortSignal): Promise<void> {
    const reg = await this.cfg.client.register({
      id: 'matrix',
      displayName: 'Matrix',
      supportsActions: false, // reactions, not buttons
      supportsMarkdown: true,
      maxMessageBytes: 65536,
    });
    this.log(
      reg.ok
        ? 'matrix bridge: registered with the gateway'
        : `matrix bridge: registration returned ${reg.status} (continuing)`,
    );
    this.reconcileSubscriptions(signal);
    await this.syncLoop(signal);
  }

  private async syncLoop(signal: AbortSignal): Promise<void> {
    let since: string | undefined;
    while (!signal.aborted) {
      let sync: unknown;
      try {
        sync = await this.cfg.syncOnce(since, signal);
      } catch {
        if (signal.aborted) break;
        await this.backoff(signal);
        continue;
      }
      const initial = since === undefined; // first sync: load state, skip history
      const ex = extractSync(sync, this.ctx);
      if (ex.nextBatch) since = ex.nextBatch;

      for (const roomId of ex.invites) {
        await this.cfg.rest.joinRoom(roomId);
        this.log(`matrix bridge: joined room ${roomId}`);
      }
      for (const roomId of ex.encryptedRooms) {
        if (this.encryptedRooms.has(roomId)) continue;
        this.encryptedRooms.add(roomId);
        await this.cfg.rest.sendMessage(roomId, {
          msgtype: 'm.text',
          body: ENCRYPTED_ROOM_NOTICE,
        });
      }

      // Skip replaying timeline history on the initial full sync — state
      // (power levels, encryption, invites) is applied above regardless.
      if (!initial) {
        for (const msg of ex.messages)
          await handleMessage(msg, this.dispatchDeps());
        for (const reaction of ex.reactions)
          await handleReaction(reaction, this.dispatchDeps());
      }
      // A !qwen attach this batch may have bound a new session → pick it up.
      this.reconcileSubscriptions(signal);
    }
  }

  /** Self-healing SSE echo loop per bound session (backoff reconnect to abort). */
  private reconcileSubscriptions(signal: AbortSignal): void {
    for (const sessionId of this.cfg.rooms.boundSessions()) {
      if (this.subscribed.has(sessionId)) continue;
      this.subscribed.add(sessionId);
      void this.subscriptionLoop(sessionId, signal);
    }
  }

  private async subscriptionLoop(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let backoff = RECONNECT_INITIAL_MS;
    try {
      while (!signal.aborted) {
        await this.cfg.client.subscribeEvents(
          sessionId,
          (ev) => this.deliverEvent(sessionId, ev),
          signal,
        );
        if (signal.aborted) break;
        await this.backoff(signal, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    } finally {
      this.subscribed.delete(sessionId);
    }
  }

  private backoff(
    signal: AbortSignal,
    base = RECONNECT_INITIAL_MS,
  ): Promise<void> {
    const sleep = this.cfg.sleep ?? defaultSleep;
    const ms = Math.round(base * (0.8 + Math.random() * 0.4));
    return sleep(ms, signal);
  }

  /**
   * Outbound: render permission_request frames to every bound room and edit them
   * (via m.replace) on resolve. Other frames are ignored to keep rooms quiet.
   * Fire-and-forget. Exposed for unit testing.
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
    const d = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
    const content = renderPermissionRequest(data, {
      baseUrl: this.cfg.baseUrl,
    });
    const track = tracksReactions(data); // deeplink (sensitive) → not reaction-votable
    for (const roomId of this.cfg.rooms.roomsFor(sessionId)) {
      const r = await this.cfg.rest.sendMessage(roomId, content);
      if (!r.ok || !r.eventId) continue;
      if (requestId) {
        const list = this.sent.get(requestId) ?? [];
        list.push({ roomId, eventId: r.eventId, body: content.body });
        this.sent.set(requestId, list);
        if (track) {
          this.tracked.set(r.eventId, { requestId, sessionId });
        }
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
      this.tracked.delete(t.eventId); // stop accepting reactions on a resolved req
      await this.cfg.rest.sendMessage(
        t.roomId,
        renderResolveEdit(t.body, t.eventId, outcome),
      );
    }
  }
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
