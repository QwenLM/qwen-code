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
  type PeerFrame,
  type PeerInbox,
  type PeerUserFrame,
  sendDeliveryStatus,
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

export interface PeerMessagingOptions {
  getApprovalMode: () => ApprovalMode | null;
  getPolicySetting: () => InboundPolicy | undefined;
  updateSessionRegistryIpcPath: (ipcPath: string | undefined) => Promise<void>;
  socketPath?: string;
}

export class PeerMessaging {
  private inbox: PeerInbox | null = null;
  private gate: InboundGate | null = null;
  private updateSessionRegistryIpcPath: (
    ipcPath: string | undefined,
  ) => Promise<void> = async () => {};
  private submitFn: PeerSubmitFn | null = null;
  private readonly buffered: PeerUserFrame[] = [];
  private readonly heldListeners = new Set<
    (held: readonly HeldMessage[]) => void
  >();
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
        void sendDeliveryStatus(frame.from, {
          status,
          origMsgId: frame.msgId,
          from: messaging.inbox?.socketPath,
        });
      },
      onHeldChange: (held) => messaging.emitHeldChange(held),
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
    messaging.updateSessionRegistryIpcPath =
      options.updateSessionRegistryIpcPath;

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
    this.submitFn = fn;
    // A refused frame means the queue is full; leave it and the rest
    // buffered — `deliver` retries them, in order, on the next arrival.
    while (this.buffered.length > 0) {
      const head = this.buffered[0];
      if (!head || !this.submit(head)) break;
      this.buffered.shift();
    }
  }

  getHeld(): readonly HeldMessage[] {
    return this.gate?.getHeld() ?? [];
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Settle held messages before the socket goes away: the expiry
    // receipts have to travel over it.
    this.gate?.shutdown();
    await this.inbox?.close();
    await this.updateSessionRegistryIpcPath(undefined);
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
      if (this.buffered.length >= MAX_ACCEPTED_BACKLOG) {
        throw new Error('accepted-message backlog is full');
      }
      this.buffered.push(frame);
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
