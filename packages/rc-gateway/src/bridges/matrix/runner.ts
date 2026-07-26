/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeClient, BridgeEvent } from '../client.js';
import type { MatrixRoomStore } from './roomStore.js';
import { runHeartbeatLoop, heartbeatIntervalMsOf } from '../heartbeat.js';
import type { CursorStore } from '../cursorStore.js';
import { extractAgentText } from '../sessionUpdateText.js';
import { markdownToHtml } from './markdownHtml.js';
import { MatrixStreamRouter, type MatrixStreamPoster } from './streamRouter.js';
import {
  handleMessage,
  handleReaction,
  ENCRYPTED_ROOM_NOTICE,
  type MatrixDispatchDeps,
  type MatrixResponder,
  type NormalizedMatrixReaction,
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
import type { MatrixHealthState } from './health.js';
import { SubActorRateLimiter } from '../subActorRateLimiter.js';

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
  /**
   * Optional inbound transport that SUBSUMES the fetch `/sync` loop. When the
   * Matrix E2EE crypto adapter is active it owns the single `/sync` (a second
   * sync on the same device would race it for the to-device megolm keys), so it
   * is wired here and `start()` runs it instead of {@link syncLoop}. When absent
   * (the default, E2EE off), the tested fetch loop runs unchanged.
   */
  runInbound?: (signal: AbortSignal) => Promise<void>;
  /** Injectable backoff sleep (tests). Resolves early on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable idle-flush timer for the stream router (tests). */
  setTimer?: (ms: number, fn: () => void) => () => void;
  /**
   * Optional liveness state the runner updates for the `/healthz` endpoint:
   * `registeredId`/`daemonReachable` on a successful register, `homeserverReachable`
   * on sync success/failure. On the E2EE adapter path the SDK owns `/sync`, so
   * `homeserverReachable` is set by the caller at adapter start (not live here).
   */
  health?: MatrixHealthState;
  log?: (msg: string) => void;
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
}

/** SSE reconnect backoff per the spec: initial 1s, max 30s, jitter ±20%. */
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Cap on room-invite auto-joins the bot will accept within the rolling window
 * (reuses {@link SubActorRateLimiter}'s default 60 s window). Anyone can invite
 * the bot to arbitrary rooms with no allowlist gate, so an unbounded auto-join
 * is a DoS/probing surface (the bot joining — and thus syncing state for —
 * unboundedly many rooms). Binding a session still requires an operator-minted
 * token posted IN the room, so this bounds probing/DoS, not session
 * compromise. Declining an invite is always safe (fail-safe): a legitimate
 * operator can just re-invite once the window rolls over.
 *
 * ACCEPTED TRADEOFF: the bucket is GLOBAL (one bot-wide counter, see
 * {@link MATRIX_INVITE_AUTOJOIN_KEY}), not per-inviter — `invite_state` does
 * not expose a trustworthy inviter identity to key on. A sustained attacker
 * who spends the full cap every window can therefore starve a legitimate
 * operator's invite for as long as the flood continues (re-invite-on-cooldown
 * only helps once the flood stops). 20/60s is chosen to comfortably clear any
 * plausible legitimate invite burst (operators bind sessions one room at a
 * time) while still being a real ceiling against a flood; it is not a
 * fairness mechanism between a flooder and a legitimate inviter racing the
 * same window.
 */
export const MATRIX_INVITE_AUTOJOIN_CAP = 20;
/**
 * Single global bucket key for the invite auto-join limiter: `invite_state`
 * exposes the bot's own membership event, not a reliable per-inviter identity,
 * so the bound is bot-wide (total auto-joins per window), not per-sender.
 */
const MATRIX_INVITE_AUTOJOIN_KEY = '__matrix_invite_autojoin__';

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
/** This bridge's stable id (registration + invite-redeem route path). */
const MATRIX_BRIDGE_ID = 'matrix';

export class MatrixBridge {
  private readonly cfg: MatrixBridgeConfig;
  private readonly commandPrefix: string;
  private readonly bans = new Set<string>();
  private readonly encryptedRooms = new Set<string>();
  private readonly subscribed = new Set<string>();
  /** sessionId → highest SSE frame id seen (resume cursor on reconnect). */
  private readonly lastEventId = new Map<string, number>();
  /** eventId → tracked permission_request (reaction → vote lookup). */
  private readonly tracked = new Map<string, TrackedEvent>();
  /** requestId → the sent messages that rendered it (for the resolve edit). */
  private readonly sent = new Map<string, SentRequest[]>();
  /** requestIds for which the deeplink-guidance reply has already been sent. */
  private readonly deeplinkGuidanceSent = new Set<string>();
  /** Streams agent prose into rooms (buffer + m.thread on long streams). */
  private readonly stream: MatrixStreamRouter;
  /** Bounds room-invite auto-joins per rolling window (DoS/probing guard). */
  private readonly inviteLimiter = new SubActorRateLimiter();
  private readonly ctx: RoomStateCtx;
  private readonly log: (msg: string) => void;
  /** The run signal, stored so decrypted-path dispatch can reconcile subscriptions. */
  private signal?: AbortSignal;

  constructor(cfg: MatrixBridgeConfig) {
    this.cfg = cfg;
    this.commandPrefix = cfg.commandPrefix ?? '!qwen';
    this.log = cfg.log ?? (() => {});
    this.ctx = {
      botUserId: cfg.botUserId,
      powerLevels: new Map<string, PowerLevelsContent>(),
    };
    const poster: MatrixStreamPoster = {
      sendStream: async (roomId, opts) => {
        const content: Record<string, unknown> = {
          msgtype: 'm.text',
          body: opts.text,
          format: 'org.matrix.custom.html',
          formatted_body: markdownToHtml(opts.text),
        };
        if (opts.threadRootEventId) {
          content['m.relates_to'] = {
            rel_type: 'm.thread',
            event_id: opts.threadRootEventId,
          };
        }
        const r = await this.cfg.rest.sendMessage(roomId, content);
        return r.ok && r.eventId ? r.eventId : null;
      },
    };
    this.stream = new MatrixStreamRouter({
      poster,
      roomsFor: (sessionId) => this.cfg.rooms.roomsFor(sessionId),
      ...(cfg.setTimer ? { setTimer: cfg.setTimer } : {}),
    });
  }

  private dispatchDeps(): MatrixDispatchDeps {
    return {
      bridge: this.cfg.client,
      rest: this.cfg.rest,
      rooms: this.cfg.rooms,
      bridgeId: MATRIX_BRIDGE_ID,
      bans: this.bans,
      encryptedRooms: this.encryptedRooms,
      tracked: this.tracked,
      deeplinkGuidanceSent: this.deeplinkGuidanceSent,
      commandPrefix: this.commandPrefix,
      onTurnBoundary: (sessionId) => this.stream.bumpTurn(sessionId),
    };
  }

  /**
   * Route a crypto-adapter-decrypted message through the SAME dispatch as the
   * plain `/sync` path (add-matrix-bridge E2EE). This is the routing seam the
   * crypto adapter feeds: normalize `{roomId, sender, body}` (computing `isBot`
   * from the bot's MXID) and hand it to the shared {@link handleMessage}, so a
   * decrypted prompt reaches a bound session exactly like a cleartext one.
   *
   * `powerLevel` defaults to 0 — sufficient for plain prompts (un-gated); command
   * power-gating (`!qwen attach`) needs the room's `m.room.power_levels`, which the
   * adapter resolves and passes. `startBridge` wires a STARTED adapter's `onMessage`
   * to this method and lets the SDK client SUBSUME the fetch `/sync` (one sync owner
   * — see startBridge); this seam is also unit-tested directly.
   */
  async dispatchDecryptedMessage(
    m: { roomId: string; sender: string; body: string },
    powerLevel = 0,
  ): Promise<void> {
    await handleMessage(
      {
        roomId: m.roomId,
        sender: m.sender,
        isBot: m.sender === this.cfg.botUserId,
        body: m.body,
        powerLevel,
      },
      this.dispatchDeps(),
    );
    // A `!qwen attach` this message may have bound a new session. The crypto
    // path has no per-batch reconcile (the fetch syncLoop is subsumed by the
    // SDK client), so reconcile here — mirroring syncLoop — or the freshly bound
    // session never gets its outbound SSE echo loop. Idempotent (subscribed set).
    if (this.signal) this.reconcileSubscriptions(this.signal);
  }

  /**
   * Route a crypto-adapter-decrypted REACTION through the same vote path as the
   * plain `/sync` reactions (add-matrix-bridge E2EE). The adapter normalizes an
   * `m.reaction` timeline event into {@link NormalizedMatrixReaction}; this hands
   * it to the shared {@link handleReaction}, so a 👍/👎 on a tracked
   * permission_request casts a vote exactly like a cleartext reaction.
   */
  async dispatchReaction(reaction: NormalizedMatrixReaction): Promise<void> {
    await handleReaction(reaction, this.dispatchDeps());
  }

  /** Register (or re-register) this bridge's capabilities with the gateway. */
  private registerSelf(): Promise<import('../client.js').WriteResult> {
    return this.cfg.client.register({
      id: MATRIX_BRIDGE_ID,
      displayName: 'Matrix',
      supportsActions: false, // reactions, not buttons
      supportsMarkdown: 'full', // streamed prose sent as formatted_body (HTML)
      supportsThreads: true, // m.thread relation on long streams
      supportsEdits: true, // m.replace edit on resolve
      maxMessageBytes: 65536,
    });
  }

  /** Register, heartbeat, subscribe to bound sessions, then run the sync loop. */
  async start(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    // Load durable cursors so SSE subscriptions resume from where they left off.
    if (this.cfg.cursors && this.cfg.tokenId) {
      for (const sessionId of this.cfg.rooms.boundSessions()) {
        const entry = this.cfg.cursors.get(this.cfg.tokenId, sessionId);
        if (entry) this.lastEventId.set(sessionId, entry.lastEventId);
      }
    }
    const reg = await this.registerSelf();
    if (reg.ok && this.cfg.health) {
      this.cfg.health.registeredId = MATRIX_BRIDGE_ID;
      this.cfg.health.daemonReachable = true;
    }
    this.log(
      reg.ok
        ? 'matrix bridge: registered with the gateway'
        : `matrix bridge: registration returned ${reg.status} (continuing)`,
    );
    // The heartbeat loop uses its OWN (abort-aware) timer, not cfg.sleep — keeping
    // it independent of the /sync reconnect-backoff sleep.
    void runHeartbeatLoop({
      heartbeat: (id) => this.cfg.client.heartbeat(id),
      reRegister: () => this.registerSelf(),
      bridgeId: MATRIX_BRIDGE_ID,
      intervalMs: heartbeatIntervalMsOf(reg.body),
      signal,
      log: this.log,
    });
    this.reconcileSubscriptions(signal);
    // E2EE: the crypto adapter owns /sync (subsumes the fetch loop). Otherwise
    // the tested fetch sync loop runs unchanged.
    await (this.cfg.runInbound ?? ((s) => this.syncLoop(s)))(signal);
  }

  private async syncLoop(signal: AbortSignal): Promise<void> {
    let since: string | undefined;
    let backoff = RECONNECT_INITIAL_MS;
    while (!signal.aborted) {
      let sync: unknown;
      try {
        sync = await this.cfg.syncOnce(since, signal);
      } catch {
        if (this.cfg.health) this.cfg.health.homeserverReachable = false;
        if (signal.aborted) break;
        await this.backoff(signal, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        continue;
      }
      const initial = since === undefined; // first sync: load state, skip history
      const ex = extractSync(sync, this.ctx);
      // A `/sync` that doesn't advance (no next_batch) is a failure — `syncOnce`
      // resolves (not rejects) on 401/429/network via the REST client, so without
      // this guard the loop would busy-spin and hammer the homeserver on exactly
      // the normal operational failures. Back off; a healthy sync resets it.
      if (!ex.nextBatch) {
        if (this.cfg.health) this.cfg.health.homeserverReachable = false;
        if (signal.aborted) break;
        await this.backoff(signal, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        continue;
      }
      since = ex.nextBatch;
      backoff = RECONNECT_INITIAL_MS;
      if (this.cfg.health) this.cfg.health.homeserverReachable = true;

      for (const roomId of ex.invites) {
        const { allowed } = this.inviteLimiter.tryConsume(
          MATRIX_INVITE_AUTOJOIN_KEY,
          MATRIX_INVITE_AUTOJOIN_CAP,
          Date.now(),
        );
        if (!allowed) {
          this.log(
            `matrix bridge: declined invite to ${roomId} (auto-join rate limit exceeded)`,
          );
          continue;
        }
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
        // Resume from the last frame id seen so a reconnect catches frames that
        // arrived during the blip (the daemon replays only id > cursor).
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
   * Outbound: permission_request → room message (edited via m.replace on
   * resolve); permission_resolved → the edit AND a turn boundary so the next
   * stream chunk starts a fresh turn; session_update → stream the agent's prose
   * (Markdown→HTML, m.thread on long turns). Fire-and-forget. Exposed for testing.
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
    const content = renderPermissionRequest(data, {
      baseUrl: this.cfg.baseUrl,
    });
    // `tracksReactions` is false for deeplink (sensitive) surface. We still
    // track deeplink events with surface:'deeplink' so handleReaction can send
    // a one-time guidance reply when a user reacts on them.
    const isDeeplink = !tracksReactions(data);
    for (const roomId of this.cfg.rooms.roomsFor(sessionId)) {
      const r = await this.cfg.rest.sendMessage(roomId, content);
      if (!r.ok || !r.eventId) continue;
      if (requestId) {
        const list = this.sent.get(requestId) ?? [];
        list.push({ roomId, eventId: r.eventId, body: content.body });
        this.sent.set(requestId, list);
        this.tracked.set(r.eventId, {
          requestId,
          sessionId,
          surface: isDeeplink ? 'deeplink' : 'inline',
        });
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
