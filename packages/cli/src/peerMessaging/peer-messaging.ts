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
export type PeerSubmitFn = (modelText: string, displayText: string) => void;

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
    (held: readonly HeldMessage[]) => void
  >();
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
        void sendDeliveryStatus(frame.from, {
          status,
          origMsgId: frame.msgId,
          from: messaging.inbox?.socketPath,
        });
      },
      onHeldChange: (held) => messaging.emitHeldChange(held),
    });

    // Wire the gate before binding, not after. The socket accepts from
    // `listen()` onward while `startPeerInbox` is still awaiting its chmod,
    // so a frame arriving in that window would reach `onFrame` with a null
    // gate and be dropped with no receipt at all — neither delivered nor
    // held. `reportStatus` already tolerates a not-yet-assigned inbox (it
    // reads `messaging.inbox?.socketPath`), so the gate is safe to install
    // this early.
    messaging.gate = gate;

    const inbox = await startPeerInbox({
      ...(options.socketPath !== undefined
        ? { socketPath: options.socketPath }
        : {}),
      onFrame: (frame) => messaging.onFrame(frame),
    });
    if (!inbox) return null;

    messaging.inbox = inbox;

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

  onHeldChange(listener: (held: readonly HeldMessage[]) => void): () => void {
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
    await this.inbox?.close();
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
      this.buffered.push(frame);
      return;
    }
    this.submit(frame);
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
