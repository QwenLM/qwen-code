/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-side owner of cross-session messaging.
 *
 * Binds the local socket, runs each arriving message through the inbound
 * gate, and hands accepted ones to the TUI's message queue. Nothing here
 * decides policy — that is {@link InboundGate}'s job — and nothing here
 * renders; the UI subscribes.
 *
 * The submit function arrives late (AppContainer wires it once the queue
 * exists), so messages accepted before then are buffered rather than
 * dropped: a peer that messaged during startup should not have to guess
 * that it needed to wait.
 */

import { randomBytes } from 'node:crypto';
import {
  clearInheritedPeerMessagingEnv,
  MESSAGING_SOCKET_ENV,
  MESSAGING_TOKEN_ENV,
} from './env.js';
import {
  type ApprovalMode,
  canonicalizeMsgId,
  createDebugLogger,
  formatPeerDisplay,
  formatPeerEnvelope,
  InboundGate,
  MAX_HELD_MESSAGES,
  type HeldMessage,
  type InboundPolicy,
  type PeerDeliveryStatus,
  type PeerFrame,
  type PeerInbox,
  type PeerUserFrame,
  sendDeliveryStatus,
  type SettledPeerReceipt,
  settleSentPeerMessage,
  startPeerInbox,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('PEER_MESSAGING');

/** Identity needed to re-check a queued frame's recipient at drain time. */
export interface PeerQueuedDelivery {
  msgId: string;
  from?: string;
  replyToken?: string;
  toSessionId?: string;
}

export {
  clearInheritedPeerMessagingEnv,
  MESSAGING_SOCKET_ENV,
  MESSAGING_TOKEN_ENV,
} from './env.js';

/**
 * Submit an already-formatted message into the session's input queue.
 * Returns false when the queue is too full to take it — the frame is then
 * refused with an honest receipt instead of accumulating unboundedly.
 */
export type PeerSubmitFn = (
  modelText: string,
  displayText: string,
  delivery?: PeerQueuedDelivery,
) => boolean;

/**
 * Cap on accepted messages waiting to be consumed.
 *
 * Symmetric with the held cap: accepted frames drain at one per model
 * turn while arriving at socket speed, so without a ceiling a chatty
 * peer grows the input queue without bound during a long busy turn —
 * the same leak the hold buffer's ceiling exists to prevent.
 */
export const MAX_ACCEPTED_BACKLOG = MAX_HELD_MESSAGES;

/**
 * A delivery receipt for a message this session sent, as surfaced to
 * the UI: which address it went to and what became of it there.
 */
export interface PeerReceipt {
  status: PeerDeliveryStatus;
  address: string;
  origMsgId: string;
  /** The state the message was in before this receipt. */
  previous: PeerDeliveryStatus | 'pending';
}

export interface PeerMessagingOptions {
  getApprovalMode: () => ApprovalMode | null;
  getPolicySetting: () => InboundPolicy | undefined;
  /**
   * How long a held message waits, in milliseconds, or null for "until
   * the session ends". Omitted in tests, which take the default.
   */
  getHeldExpiryMs?: () => number | null;
  updateSessionRegistryIpcPath: (
    ipcPath: string | undefined,
    ipcToken?: string,
  ) => Promise<void>;
  /**
   * Apply a receipt to the send it answers, returning the send only when
   * the receipt moved it to a new state. Defaults to the send-side
   * ledger; injectable so the wiring can be tested without a real send.
   */
  settleSentMessage?: (
    msgId: string,
    status: PeerDeliveryStatus,
  ) => SettledPeerReceipt | undefined;
  /**
   * Re-assert this session's registry record. Called when a frame arrives
   * pinned to a session id this process does not hold, because the record
   * — not only the sender's directory — may be the stale side.
   */
  reassertSessionRecord?: () => Promise<void>;
  /**
   * This session's current id. A getter, not a value: /clear and /resume
   * swap the id under a running process, and a frame pinned to the id a
   * sender read from the registry must be judged against the id this
   * session holds now. Absent means frames are never checked against it.
   */
  getSessionId?: () => string;
  socketPath?: string;
  /**
   * Overrides the generated inbox token. A test seam like `socketPath`:
   * a frame staged before `start` resolves must already authenticate,
   * and the generated token is not observable until after.
   */
  ipcToken?: string;
  /** Overrides the generated child token. Same seam, same reason. */
  childToken?: string;
}

/** An accepted message waiting for the TUI's submit function. */
interface BufferedDelivery {
  frame: PeerUserFrame;
  selfSent: boolean;
}

export class PeerMessaging {
  private inbox: PeerInbox | null = null;
  private gate: InboundGate | null = null;
  private updateSessionRegistryIpcPath: (
    ipcPath: string | undefined,
    ipcToken?: string,
  ) => Promise<void> = async () => {};
  private getSessionId: (() => string) | null = null;
  private settleSentMessage: (
    msgId: string,
    status: PeerDeliveryStatus,
  ) => SettledPeerReceipt | undefined = settleSentPeerMessage;
  private reassertSessionRecord: (() => Promise<void>) | null = null;
  private readonly receiptListeners = new Set<(receipt: PeerReceipt) => void>();
  private submitFn: PeerSubmitFn | null = null;
  private readonly buffered: BufferedDelivery[] = [];
  /**
   * Accepted frames whose 'delivered' receipt has not been earned yet:
   * still buffered here or still queued in the session's input queue.
   * Settled with a corrective receipt at close.
   */
  private readonly outstanding: PeerUserFrame[] = [];
  private queuedPeerCount: (() => number) | null = null;
  private readonly heldListeners = new Set<
    (held: readonly HeldMessage[]) => void
  >();
  private listedHeld: ReadonlyArray<{ id: string; heldAt: number }> | null =
    null;
  private closed = false;

  // Options are consumed by `start`, which wires them into the gate and the
  // inbox; the instance itself holds none of them.
  private constructor() {}

  /**
   * Bind the socket and start accepting messages.
   *
   * Returns null when the inbox could not be bound. Callers treat that as
   * "this session is not reachable" and carry on — it is never fatal.
   */
  static async start(
    options: PeerMessagingOptions,
  ): Promise<PeerMessaging | null> {
    const messaging = new PeerMessaging();

    const gate = new InboundGate({
      getApprovalMode: options.getApprovalMode,
      getPolicySetting: options.getPolicySetting,
      ...(options.getHeldExpiryMs !== undefined
        ? { getHeldExpiryMs: options.getHeldExpiryMs }
        : {}),
      getSessionId: options.getSessionId,
      deliver: (frame, origin) => messaging.deliver(frame, origin.selfSent),
      reportStatus: (frame, status) => {
        if (!frame.from) return;
        return sendDeliveryStatus(
          frame.from,
          {
            status,
            origMsgId: frame.msgId,
            from: messaging.inbox?.socketPath,
          },
          frame.replyToken,
        );
      },
      onHeldChange: (held) => messaging.emitHeldChange(held),
    });

    // Wire the gate before the socket binds: startPeerInbox resolves only
    // after its post-listen chmod, and frames arriving in that window are
    // already dispatched. A frame that reaches a null gate is dropped
    // without a receipt, and the sender has no way to tell.
    messaging.gate = gate;
    // Same reason for these: a frame in that window is judged against the
    // session id and the send ledger this process holds, not against the
    // nulls a later assignment would leave in place.
    messaging.getSessionId = options.getSessionId ?? null;
    messaging.settleSentMessage =
      options.settleSentMessage ?? settleSentPeerMessage;
    messaging.reassertSessionRecord = options.reassertSessionRecord ?? null;

    // Any pair still in the environment at this point was inherited from an
    // ancestor session, and every exit below this line other than a bound
    // inbox must leave nothing for children to pick up. Dropped before the
    // bind rather than on each failure branch so a future early return
    // cannot reintroduce the leak; the success path re-exports this
    // session's own pair once the socket is accepting.
    clearInheritedPeerMessagingEnv();

    // Two tokens for two audiences. The first is published in the registry
    // record for peers; the second exists only in this process's
    // environment, so presenting it proves descent from this session.
    const ipcToken = options.ipcToken ?? randomBytes(32).toString('hex');
    const childToken = options.childToken ?? randomBytes(32).toString('hex');
    const inbox = await startPeerInbox({
      ...(options.socketPath !== undefined
        ? { socketPath: options.socketPath }
        : {}),
      requiredToken: ipcToken,
      childToken,
      onFrame: (frame, auth) => messaging.onFrame(frame, auth === 'child'),
    });
    if (!inbox) return null;

    messaging.inbox = inbox;
    messaging.updateSessionRegistryIpcPath =
      options.updateSessionRegistryIpcPath;

    // Advertise the address only once the socket is actually accepting.
    // Publishing it earlier would hand peers an address that refuses
    // connections, which reads to them as "the session just exited".
    // The token travels in the same record: discovering the address and
    // being able to authenticate to it are one capability.
    await messaging.updateSessionRegistryIpcPath(inbox.socketPath, ipcToken);

    // Exported even if the registry publish above failed: children inherit
    // the environment, not the record, and the inbox is accepting either
    // way. Children get the child token, never the published one: what
    // makes a child's message recognizable as the session's own is that
    // nothing else ever holds this value.
    process.env[MESSAGING_SOCKET_ENV] = inbox.socketPath;
    process.env[MESSAGING_TOKEN_ENV] = childToken;

    return messaging;
  }

  get socketPath(): string | undefined {
    return this.inbox?.socketPath;
  }

  /**
   * Register the TUI's submit function and flush anything accepted before
   * the queue existed.
   */
  setSubmitFn(fn: PeerSubmitFn): void {
    if (this.closed) return;
    this.submitFn = fn;
    // A refused frame means the queue is full; leave it and the rest
    // buffered — `deliver` retries them, in order, on the next arrival.
    while (this.buffered.length > 0) {
      const head = this.buffered[0];
      if (!head || !this.submit(head.frame, head.selfSent)) break;
      this.buffered.shift();
    }
  }

  /**
   * Register a counter for the peer entries still waiting in the
   * session's input queue. At close, that many of the most recently
   * submitted frames are settled alongside the buffered ones: the queue
   * drains in order, so the unconsumed tail is exactly the queue's
   * current depth.
   */
  setQueuedPeerCount(fn: () => number): void {
    this.queuedPeerCount = fn;
  }

  getHeld(): readonly HeldMessage[] {
    return this.gate?.getHeld() ?? [];
  }

  /**
   * How long a held message has to live, in milliseconds, or null when
   * holds do not expire. Used by `/peers` to show what is left.
   */
  getHeldExpiryMs(): number | null {
    return this.gate?.getHeldExpiryMs() ?? null;
  }

  /**
   * Remember the held entries the `/peers` listing just showed the user.
   *
   * Accept/deny decisions are bound to this snapshot: the held set moves
   * between listing and decision (arrivals, evictions, releases), and a
   * handle that uniquely named the message the user reviewed must not
   * resolve to a different one by decide time. The snapshot pins each
   * entry's `heldAt` as well as its id: once an id's eviction tombstone
   * is pruned from the gate's bounded settled-memory, a peer can re-send
   * it with a swapped body, and only the fresh hold timestamp tells the
   * re-admitted entry apart from the one the user reviewed.
   */
  recordHeldListing(heldEntries: readonly HeldMessage[]): void {
    this.listedHeld = heldEntries.map((entry) => ({
      id: entry.frame.msgId,
      heldAt: entry.heldAt,
    }));
  }

  /**
   * True when the held set no longer matches the last recorded listing.
   *
   * Entries *leaving* the set are not a change. The expiry timer removes
   * them with no peer or user activity -- a fourth mover the rationale
   * above does not name -- and a shrinking set can never make a printed
   * handle resolve to a different message: `resolveHeld` prefix-matches
   * over the current set, so removing entries only narrows it. Bouncing
   * those refuses a decision that would have been correct, and tells the
   * user the list changed when what they can still uniquely name is
   * exactly what they reviewed.
   *
   * Dropping an expired entry is safe because the gate tombstones it
   * before it leaves the set, so a re-admitted id arrives with a fresh
   * `heldAt` and still mismatches the pin below.
   *
   * What must still bounce: an arrival, and a re-sent id whose body may
   * have been swapped, which the `heldAt` pin is what catches.
   */
  heldSetChangedSinceListing(): boolean {
    const listed = this.listedHeld;
    if (listed === null) return true;
    const pinned = new Map(listed.map((entry) => [entry.id, entry.heldAt]));
    const current = this.getHeld();
    if (current.some((entry) => pinned.get(entry.frame.msgId) !== entry.heldAt))
      return true;

    // A departure is normally harmless -- `resolveHeld` prefix-matches
    // over the current set, so a smaller set only narrows what a printed
    // handle can mean. The exception is an id that *extends* the departed
    // one: `msgId` is peer-chosen and only shape-checked, so a peer can
    // park `abc` beside `abc12345`. While both are held the handles are
    // distinct, and `resolveHeld`'s exact-match tier gives `abc` to the
    // shorter. Once `abc` expires, that same handle falls through to
    // prefix-matching and silently decides `abc12345` -- a different
    // message than the one the user reviewed, released under the reviewed
    // one's handle.
    //
    // Canonicalized the way `resolveHeld` canonicalizes, or the check
    // would miss the dashed forms it matches on.
    const liveIds = current.map((entry) =>
      canonicalizeMsgId(entry.frame.msgId),
    );
    const liveSet = new Set(liveIds);
    for (const id of pinned.keys()) {
      const departed = canonicalizeMsgId(id);
      if (liveSet.has(departed)) continue;
      if (liveIds.some((live) => live.startsWith(departed))) return true;
    }
    return false;
  }

  decide(
    msgId: string,
    decision: 'approve' | 'deny',
  ): 'done' | 'failed' | 'gone' {
    return this.gate?.decide(msgId, decision) ?? 'gone';
  }

  /** Release everything the gate now considers acceptable. */
  reevaluate(reason: string): number {
    return this.gate?.reevaluate(reason) ?? 0;
  }

  onHeldChange(listener: (held: readonly HeldMessage[]) => void): () => void {
    this.heldListeners.add(listener);
    // Replay the current state: start() binds the socket before it
    // returns, so messages can be held before the first listener
    // subscribes, and the gate only emits on change — without a replay
    // those holds would never be announced.
    try {
      listener(this.getHeld());
    } catch (error) {
      debugLogger.debug(
        `held-change listener threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return () => this.heldListeners.delete(listener);
  }

  /** Subscribe to receipts for messages this session sent. */
  onReceipt(listener: (receipt: PeerReceipt) => void): () => void {
    this.receiptListeners.add(listener);
    return () => this.receiptListeners.delete(listener);
  }

  private emitReceipt(receipt: PeerReceipt): void {
    for (const listener of this.receiptListeners) {
      try {
        listener(receipt);
      } catch (error) {
        debugLogger.debug(
          `receipt listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Settle held messages before the socket goes away: the expiry
    // receipts have to travel over it, and the process exits once close
    // resolves — a receipt still in flight then is one the sender never
    // receives.
    await this.gate?.shutdown();
    await this.settleUnconsumed();
    await this.inbox?.close();
    // Same pair, same removal as the startup scrub — one writer for it.
    clearInheritedPeerMessagingEnv();
    await this.updateSessionRegistryIpcPath(undefined);
  }

  /**
   * Correct the 'delivered' receipts of accepted messages the session
   * never consumed. Without this, a sender told "delivered" about a
   * message that dies in the buffer or the input queue at exit cannot
   * tell that from "delivered and read" — the distinction the receipts
   * exist to carry.
   */
  private async settleUnconsumed(): Promise<void> {
    const queued = this.queuedPeerCount?.() ?? 0;
    const dropped = this.outstanding.slice(
      Math.max(0, this.outstanding.length - this.buffered.length - queued),
    );
    const receipts = dropped
      .filter((frame) => frame.from !== undefined)
      .map((frame) =>
        sendDeliveryStatus(
          frame.from!,
          {
            status: 'expired',
            origMsgId: frame.msgId,
            from: this.inbox?.socketPath,
          },
          frame.replyToken,
        ),
      );
    await Promise.allSettled(receipts);
  }

  /**
   * `selfSent` is the transport's finding that the connection presented
   * the child token; it is never read off the frame.
   */
  private onFrame(frame: PeerFrame, selfSent: boolean): void {
    if (frame.type === 'control') {
      // A receipt for a message this session sent. Any process that can
      // reach the socket can write one for any id, so only ids the
      // send-side ledger knows are surfaced; the rest are logged and
      // dropped.
      const settled = this.settleSentMessage(frame.origMsgId, frame.status);
      if (!settled) {
        debugLogger.debug(
          `ignoring delivery status ${frame.status} for ${frame.origMsgId}: unknown message or repeated receipt`,
        );
        return;
      }
      debugLogger.debug(
        `delivery status from ${settled.address}: ${settled.previous} -> ${frame.status} for ${frame.origMsgId}`,
      );
      this.emitReceipt({
        status: frame.status,
        address: settled.address,
        origMsgId: frame.origMsgId,
        previous: settled.previous,
      });
      return;
    }
    // The socket address is keyed by PID and PIDs get reused, so a frame
    // can arrive here that was written for whoever held this address when
    // the sender last looked. One pinned to a different session id is not
    // ours to act on — refuse it with a receipt that says exactly that, so
    // the sender learns its directory is stale instead of reading silence
    // as delivery or a refusal as a human's decision. The registry record
    // may be the stale side (a skipped /clear patch), so it is re-asserted
    // too; otherwise every later send here would be refused the same way.
    const ownSessionId = this.getSessionId?.();
    if (
      frame.toSessionId !== undefined &&
      ownSessionId !== undefined &&
      frame.toSessionId !== ownSessionId
    ) {
      debugLogger.debug(
        `refusing peer message ${frame.msgId}: addressed to session ${frame.toSessionId}, this is ${ownSessionId}`,
      );
      if (frame.from) {
        void sendDeliveryStatus(
          frame.from,
          {
            status: 'misaddressed',
            origMsgId: frame.msgId,
            from: this.inbox?.socketPath,
          },
          frame.replyToken,
        );
      }
      void this.reassertSessionRecord?.().catch((error) => {
        debugLogger.debug(
          `re-asserting the session record failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return;
    }
    this.gate?.admit(frame, { selfSent });
  }

  private deliver(frame: PeerUserFrame, selfSent: boolean): void {
    if (!this.submitFn) {
      if (this.buffered.length >= MAX_ACCEPTED_BACKLOG) {
        throw new Error('accepted-message backlog is full');
      }
      this.buffered.push({ frame, selfSent });
      this.trackOutstanding(frame);
      return;
    }
    while (this.buffered.length > 0) {
      const head = this.buffered[0];
      if (!head || !this.submit(head.frame, head.selfSent)) {
        throw new Error('accepted-message backlog is full');
      }
      this.buffered.shift();
    }
    if (!this.submit(frame, selfSent)) {
      throw new Error('accepted-message backlog is full');
    }
    this.trackOutstanding(frame);
  }

  private trackOutstanding(frame: PeerUserFrame): void {
    this.outstanding.push(frame);
    // Only the unconsumed tail can ever matter, and it is bounded: at
    // most MAX_ACCEPTED_BACKLOG frames wait here and another
    // MAX_ACCEPTED_BACKLOG in the session's input queue. Anything older
    // was necessarily consumed.
    while (this.outstanding.length > 2 * MAX_ACCEPTED_BACKLOG) {
      this.outstanding.shift();
    }
  }

  private submit(frame: PeerUserFrame, selfSent: boolean): boolean {
    // A script injecting into its own session rarely listens for a reply,
    // so it usually has no address to give; say what it is instead.
    const from = frame.from ?? (selfSent ? 'own process' : 'unknown session');
    return (
      this.submitFn?.(
        formatPeerEnvelope({
          from,
          ...(frame.fromName !== undefined ? { fromName: frame.fromName } : {}),
          content: frame.message.content,
          selfSent,
        }),
        formatPeerDisplay({
          from,
          ...(frame.fromName !== undefined ? { fromName: frame.fromName } : {}),
          content: frame.message.content,
          selfSent,
        }),
        {
          msgId: frame.msgId,
          ...(frame.from !== undefined ? { from: frame.from } : {}),
          ...(frame.replyToken !== undefined
            ? { replyToken: frame.replyToken }
            : {}),
          ...(frame.toSessionId !== undefined
            ? { toSessionId: frame.toSessionId }
            : {}),
        },
      ) ?? false
    );
  }

  /** Drop a queued frame if an in-process session swap invalidated its pin. */
  drainQueuedFrame(delivery: PeerQueuedDelivery | undefined): boolean {
    const ownSessionId = this.getSessionId?.();
    if (
      delivery?.toSessionId === undefined ||
      ownSessionId === undefined ||
      delivery.toSessionId === ownSessionId
    ) {
      return true;
    }
    debugLogger.debug(
      `dropping queued peer message ${delivery.msgId}: addressed to session ${delivery.toSessionId}, this is ${ownSessionId}`,
    );
    if (delivery.from) {
      void sendDeliveryStatus(
        delivery.from,
        {
          status: 'misaddressed',
          origMsgId: delivery.msgId,
          from: this.inbox?.socketPath,
        },
        delivery.replyToken,
      );
    }
    return false;
  }

  private emitHeldChange(held: readonly HeldMessage[]): void {
    for (const listener of this.heldListeners) {
      try {
        listener(held);
      } catch (error) {
        debugLogger.debug(
          `held-change listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
