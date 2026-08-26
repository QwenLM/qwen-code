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

import {
  type ApprovalMode,
  createDebugLogger,
  formatPeerDisplay,
  formatPeerEnvelope,
  InboundGate,
  MAX_HELD_MESSAGES,
  type HeldMessage,
  type InboundPolicy,
  lookupSentPeerMessage,
  type PeerDeliveryStatus,
  type PeerFrame,
  type PeerInbox,
  type PeerUserFrame,
  sendDeliveryStatus,
  type SentPeerMessage,
  startPeerInbox,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('PEER_MESSAGING');

/**
 * Submit an already-formatted message into the session's input queue.
 * Returns false when the queue is too full to take it — the frame is then
 * refused with an honest receipt instead of accumulating unboundedly.
 */
export type PeerSubmitFn = (modelText: string, displayText: string) => boolean;

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
}

export interface PeerMessagingOptions {
  getApprovalMode: () => ApprovalMode | null;
  getPolicySetting: () => InboundPolicy | undefined;
  updateSessionRegistryIpcPath: (ipcPath: string | undefined) => Promise<void>;
  /**
   * Resolve a receipt's message id to the send it answers. Defaults to
   * the send-side ledger; injectable so the wiring can be tested without
   * a real send.
   */
  lookupSentMessage?: (msgId: string) => SentPeerMessage | undefined;
  /**
   * This session's current id. A getter, not a value: /clear and /resume
   * swap the id under a running process, and a frame pinned to the id a
   * sender read from the registry must be judged against the id this
   * session holds now. Absent means frames are never checked against it.
   */
  getSessionId?: () => string;
  socketPath?: string;
}

export class PeerMessaging {
  private inbox: PeerInbox | null = null;
  private gate: InboundGate | null = null;
  private updateSessionRegistryIpcPath: (
    ipcPath: string | undefined,
  ) => Promise<void> = async () => {};
  private getSessionId: (() => string) | null = null;
  private lookupSentMessage: (msgId: string) => SentPeerMessage | undefined =
    lookupSentPeerMessage;
  private readonly receiptListeners = new Set<(receipt: PeerReceipt) => void>();
  private submitFn: PeerSubmitFn | null = null;
  private readonly buffered: PeerUserFrame[] = [];
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
      deliver: (frame) => messaging.deliver(frame),
      reportStatus: (frame, status) => {
        if (!frame.from) return;
        return sendDeliveryStatus(frame.from, {
          status,
          origMsgId: frame.msgId,
          from: messaging.inbox?.socketPath,
        });
      },
      onHeldChange: (held) => messaging.emitHeldChange(held),
    });

    // Wire the gate before the socket binds: startPeerInbox resolves only
    // after its post-listen chmod, and frames arriving in that window are
    // already dispatched. A frame that reaches a null gate is dropped
    // without a receipt, and the sender has no way to tell.
    messaging.gate = gate;

    const inbox = await startPeerInbox({
      ...(options.socketPath !== undefined
        ? { socketPath: options.socketPath }
        : {}),
      onFrame: (frame) => messaging.onFrame(frame),
    });
    if (!inbox) return null;

    messaging.inbox = inbox;
    messaging.updateSessionRegistryIpcPath =
      options.updateSessionRegistryIpcPath;
    messaging.getSessionId = options.getSessionId ?? null;
    messaging.lookupSentMessage =
      options.lookupSentMessage ?? lookupSentPeerMessage;

    // Advertise the address only once the socket is actually accepting.
    // Publishing it earlier would hand peers an address that refuses
    // connections, which reads to them as "the session just exited".
    await messaging.updateSessionRegistryIpcPath(inbox.socketPath);

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
      if (!head || !this.submit(head)) break;
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

  /** True when the held set no longer matches the last recorded listing. */
  heldSetChangedSinceListing(): boolean {
    const listed = this.listedHeld;
    if (listed === null) return true;
    const held = this.getHeld();
    return (
      held.length !== listed.length ||
      held.some((entry, index) => {
        const snapshot = listed[index];
        return (
          entry.frame.msgId !== snapshot.id || entry.heldAt !== snapshot.heldAt
        );
      })
    );
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
        sendDeliveryStatus(frame.from!, {
          status: 'expired',
          origMsgId: frame.msgId,
          from: this.inbox?.socketPath,
        }),
      );
    await Promise.allSettled(receipts);
  }

  private onFrame(frame: PeerFrame): void {
    if (frame.type === 'control') {
      // A receipt for a message this session sent. Any process that can
      // reach the socket can write one for any id, so only ids the
      // send-side ledger knows are surfaced; the rest are logged and
      // dropped.
      const sent = this.lookupSentMessage(frame.origMsgId);
      if (!sent) {
        debugLogger.debug(
          `ignoring delivery status ${frame.status} for unknown message ${frame.origMsgId}`,
        );
        return;
      }
      debugLogger.debug(
        `delivery status from ${sent.address}: ${frame.status} for ${frame.origMsgId}`,
      );
      this.emitReceipt({
        status: frame.status,
        address: sent.address,
        origMsgId: frame.origMsgId,
      });
      return;
    }
    // The socket address is keyed by PID and PIDs get reused, so a frame
    // can arrive here that was written for whoever held this address when
    // the sender last looked. One pinned to a different session id is not
    // ours to act on — refuse it with a receipt, so the sender learns its
    // directory is stale instead of reading silence as delivery.
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
        void sendDeliveryStatus(frame.from, {
          status: 'denied',
          origMsgId: frame.msgId,
          from: this.inbox?.socketPath,
        });
      }
      return;
    }
    this.gate?.admit(frame);
  }

  private deliver(frame: PeerUserFrame): void {
    if (!this.submitFn) {
      if (this.buffered.length >= MAX_ACCEPTED_BACKLOG) {
        throw new Error('accepted-message backlog is full');
      }
      this.buffered.push(frame);
      this.trackOutstanding(frame);
      return;
    }
    while (this.buffered.length > 0) {
      const head = this.buffered[0];
      if (!head || !this.submit(head)) {
        throw new Error('accepted-message backlog is full');
      }
      this.buffered.shift();
    }
    if (!this.submit(frame)) {
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

  private submit(frame: PeerUserFrame): boolean {
    const from = frame.from ?? 'unknown session';
    return (
      this.submitFn?.(
        formatPeerEnvelope({
          from,
          ...(frame.fromName !== undefined ? { fromName: frame.fromName } : {}),
          content: frame.message.content,
        }),
        formatPeerDisplay({
          from,
          ...(frame.fromName !== undefined ? { fromName: frame.fromName } : {}),
          content: frame.message.content,
        }),
      ) ?? false
    );
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
