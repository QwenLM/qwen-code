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
// See docs/design/2026-11-13-managed-channel-dingtalk-adapter.md and
// docs/design/2026-11-16-managed-channel-wecom-adapter.md.

/** The adapters the managed path enables. */
export type ManagedChannelAdapter = 'email' | 'dingtalk' | 'github' | 'wecom';

/**
 * What a managed adapter can render beyond plain text segments (H5e of
 * #12827). An adapter that declares `cards` renders one delivery as a single
 * provider-native card and edits it per segment; an adapter that declares
 * nothing keeps the text path. The declaration is a gate the adapter's own
 * send path consumes, not a field the control plane reads.
 */
export interface ManagedChannelCapabilities {
  cards: boolean;
}

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

/**
 * The outbound segment ledger cap, shared by every managed provider so the
 * state validator's bound and the adapter's `.slice(-N)` cannot drift apart
 * (#17173 R1-12).
 */
export const MANAGED_OUTBOUND_LIMIT = 64;

/**
 * Validate one persisted segment receipt. Shared beside the ManagedReceipt
 * type so the providers cannot drift (#17173 R1-29): an absent receipt is
 * valid (the segment is still unanswered), `unknown`/`rejected` carry only
 * the outcome, and `accepted` must carry a well-formed ordinal, provider
 * message id and timestamp.
 */
export function validManagedReceipt(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<ManagedReceipt>;
  if (receipt.outcome === 'unknown' || receipt.outcome === 'rejected')
    return Object.keys(receipt).length === 1;
  return (
    receipt.outcome === 'accepted' &&
    Number.isSafeInteger(receipt.ordinal) &&
    (receipt.ordinal as number) >= 0 &&
    typeof receipt.providerMessageId === 'string' &&
    receipt.providerMessageId.length > 0 &&
    receipt.providerMessageId.length <= 512 &&
    Number.isSafeInteger(receipt.acceptedAt) &&
    (receipt.acceptedAt as number) >= 0
  );
}

/** The trusted control-plane surface the adapter talks to. */
export interface ManagedChannelControlPlane {
  /**
   * A stable key of the registration this client talks to — the control-plane
   * base URL, tenant, channel, and the owning actor, workspace and cwd-relative.
   * A persisting adapter that needs cross-registration isolation keys its ledger
   * by it (the WeCom adapter does), so a ledger staged for one registration is
   * never replayed into another when the same configured entry is restarted
   * against a different destination or owner. Binding only the tenant/channel is
   * not enough: a new actor/workspace of the same tenant/channel must not inherit
   * the prior owner's pending. This is a capability a persisting adapter opts
   * into, not an invariant every sibling already satisfies — the DingTalk store
   * still keys by name+account only and does not yet bind the registration
   * identity (a follow-up). Optional so test doubles that do not persist may
   * omit it.
   */
  readonly destinationKey?: string;
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
