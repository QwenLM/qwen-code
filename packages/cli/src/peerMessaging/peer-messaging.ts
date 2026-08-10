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
  approvalModeClass,
  createDebugLogger,
  formatPeerDisplay,
  formatPeerEnvelope,
  InboundGate,
  type HeldMessage,
  MAX_HELD_MESSAGES,
  type InboundPolicy,
  type PeerFrame,
  type PeerInbox,
  type PeerUserFrame,
  patchSessionRecord,
  sendDeliveryStatus,
  startPeerInbox,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('PEER_MESSAGING');

/** Submit an already-formatted message into the session's input queue. */
export type PeerSubmitFn = (
  modelText: string,
  displayText: string,
  /**
   * Fired when the queue evicts this submission under its peer cap
   * instead of ever handing it to the model. The receipt has to say so:
   * the sender was told 'delivered', and silence about the eviction
   * would read as "delivered and ignored".
   */
  onEvicted?: () => void,
) => void;

/** How long `close()` waits for outstanding receipts to land. */
const CLOSE_RECEIPT_WAIT_MS = 1_000;

export interface PeerMessagingOptions {
  getApprovalMode: () => ApprovalMode | null;
  getPolicySetting: () => InboundPolicy | undefined;
  /** Display name of this session, sent to peers as `fromName`. */
  selfName?: string;
  socketPath?: string;
}

export class PeerMessaging {
  private inbox: PeerInbox | null = null;
  private gate: InboundGate | null = null;
  private submitFn: PeerSubmitFn | null = null;
  private readonly buffered: PeerUserFrame[] = [];
  private readonly heldListeners = new Set<
    (held: readonly HeldMessage[], added?: HeldMessage) => void
  >();
  private readonly inflightReceipts = new Set<Promise<void>>();
  private closed = false;

  private constructor(private readonly options: PeerMessagingOptions) {}

  /**
   * Bind the socket and start accepting messages.
   *
   * Returns null when the inbox could not be bound. Callers treat that as
   * "this session is not reachable" and carry on — it is never fatal.
   */
  static async start(
    options: PeerMessagingOptions,
  ): Promise<PeerMessaging | null> {
    const messaging = new PeerMessaging(options);

    const gate = new InboundGate({
      getApprovalMode: options.getApprovalMode,
      getPolicySetting: options.getPolicySetting,
      deliver: (frame) => messaging.deliver(frame),
      reportStatus: (frame, status) => {
        if (!frame.from) return;
        messaging.trackReceipt(
          sendDeliveryStatus(frame.from, {
            status,
            origMsgId: frame.msgId,
            from: messaging.inbox?.socketPath,
          }),
        );
      },
      onHeldChange: (held, added) => messaging.emitHeldChange(held, added),
    });

    const inbox = await startPeerInbox({
      ...(options.socketPath !== undefined
        ? { socketPath: options.socketPath }
        : {}),
      onFrame: (frame) => messaging.onFrame(frame),
    });
    if (!inbox) return null;

    messaging.inbox = inbox;
    messaging.gate = gate;

    // Advertise the address only once the socket is actually accepting.
    // Publishing it earlier would hand peers an address that refuses
    // connections, which reads to them as "the session just exited".
    await patchSessionRecord({ ipcPath: inbox.socketPath });

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
    this.submitFn = fn;
    const pending = this.buffered.splice(0, this.buffered.length);
    for (const frame of pending) this.submit(frame);
  }

  getHeld(): readonly HeldMessage[] {
    return this.gate?.getHeld() ?? [];
  }

  decide(msgId: string, decision: 'approve' | 'deny'): 'done' | 'gone' {
    return this.gate?.decide(msgId, decision) ?? 'gone';
  }

  /** Release everything the gate now considers acceptable. */
  reevaluate(reason: string): number {
    return this.gate?.reevaluate(reason) ?? 0;
  }

  onHeldChange(
    listener: (held: readonly HeldMessage[], added?: HeldMessage) => void,
  ): () => void {
    this.heldListeners.add(listener);
    return () => this.heldListeners.delete(listener);
  }

  /** Mode class this session advertises to peers when it sends. */
  selfModeClass(): 'bypass' | 'prompting' | undefined {
    const mode = this.options.getApprovalMode();
    return mode === null ? undefined : approvalModeClass(mode);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Settle held messages before the socket goes away: the expiry
    // receipts have to travel over it.
    this.gate?.shutdown();
    // What was accepted but never submitted will never be now: the session
    // is going away. Settle it as expired rather than leaving the sender
    // believing a 'delivered' message was read.
    const stranded = this.buffered.splice(0, this.buffered.length);
    for (const frame of stranded) this.expireFrame(frame);
    // Stop new frames before waiting on receipts, so the set waited on is
    // the final one.
    await this.inbox?.close();
    await Promise.race([
      Promise.allSettled([...this.inflightReceipts]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_RECEIPT_WAIT_MS);
        timer.unref();
      }),
    ]);
    await patchSessionRecord({ ipcPath: undefined });
  }

  private onFrame(frame: PeerFrame): void {
    if (frame.type === 'control') {
      // Receipts about messages *we* sent. Nothing consumes them until
      // the sender lands, so log and move on rather than inventing a
      // half-used delivery-tracking table now.
      debugLogger.debug(
        `delivery status from peer: ${frame.status} for ${frame.origMsgId}`,
      );
      return;
    }
    this.gate?.admit(frame);
  }

  private deliver(frame: PeerUserFrame): void {
    if (!this.submitFn) {
      if (this.buffered.length >= MAX_HELD_MESSAGES) {
        const evicted = this.buffered.shift();
        if (evicted) this.expireFrame(evicted);
      }
      this.buffered.push(frame);
      return;
    }
    this.submit(frame);
  }

  /**
   * Tell the sender a message that was accepted is not going to be read:
   * evicted by a cap, or stranded by shutdown. The 'delivered' receipt it
   * already got makes the follow-up owed.
   */
  private expireFrame(frame: PeerUserFrame): void {
    if (!frame.from) return;
    this.trackReceipt(
      sendDeliveryStatus(frame.from, {
        status: 'expired',
        origMsgId: frame.msgId,
        from: this.inbox?.socketPath,
      }),
    );
  }

  private trackReceipt(task: Promise<void>): void {
    this.inflightReceipts.add(task);
    void task.finally(() => this.inflightReceipts.delete(task));
  }

  private submit(frame: PeerUserFrame): void {
    const from = frame.from ?? 'unknown session';
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
      () => this.expireFrame(frame),
    );
  }

  private emitHeldChange(
    held: readonly HeldMessage[],
    added?: HeldMessage,
  ): void {
    for (const listener of this.heldListeners) {
      try {
        listener(held, added);
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
