/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// H5d of #12827: the shared contract of a managed channel adapter. Lifted out
// of the email package so a second provider (DingTalk) and the CLI's HTTP
// client share it without one provider package depending on another. The
// control plane is provider-agnostic: the adapter name is a pattern on the
// Java side, the reply context is adapter-opaque JSON echoed back on claim,
// and the segment ledger / claim budget / receipt discipline are unchanged.
// See docs/design/2026-11-13-managed-channel-dingtalk-adapter.md.

/** The adapters the managed path enables. */
export type ManagedChannelAdapter = 'email' | 'dingtalk';

/** The route policy pinned with the first binding of each route. */
export interface ManagedChannelPolicy {
  adapter: ManagedChannelAdapter;
  senderPolicy: 'allowlist' | 'open' | 'disabled';
  allowedSenders: string[];
  dispatchMode: 'followup' | 'steer';
}

/**
 * One inbound platform event the control plane admits. The reply context is
 * adapter-opaque: each provider defines its own shape, committed with the
 * input and echoed back by the outbox on claim.
 */
export interface ManagedInboundEvent {
  accountGeneration: number;
  platformEventId: string;
  semanticRevision: 1;
  scope: {
    kind: 'chat_thread';
    senderId: null;
    chatId: string;
    threadId: string;
  };
  senderId: string;
  chatId: string;
  threadId: string;
  subject: string | null;
  text: string;
  attachments: Array<{
    fileName: string;
    mimeType: string;
    bytesBase64: string;
  }>;
  replyContext: unknown;
}

/** A claimed delivery: the reply context plus the outstanding segments. */
export interface ManagedClaimedDelivery {
  deliveryId: string;
  replyContext: unknown;
  segments: Array<{ ordinal: number; segmentId: string; text: string }>;
}

/** The outcome one segment's send proved, persisted before its receipt. */
export type ManagedReceipt =
  | {
      outcome: 'accepted';
      ordinal: number;
      providerMessageId: string;
      acceptedAt: number;
    }
  | { outcome: 'unknown' | 'rejected' };

/** The trusted control-plane surface the adapter talks to. */
export interface ManagedChannelControlPlane {
  register(request: {
    platform: ManagedChannelAdapter;
    accountId: string;
    accountGeneration: number;
    policy: ManagedChannelPolicy;
  }): Promise<void>;
  disconnect(): Promise<void>;
  submitInbound(
    event: ManagedInboundEvent,
  ): Promise<{ inputId: string; sessionId: string; replayed: boolean }>;
  claimDeliveries(limit: number): Promise<ManagedClaimedDelivery[]>;
  receipt(deliveryId: string, receipt: ManagedReceipt): Promise<void>;
}
