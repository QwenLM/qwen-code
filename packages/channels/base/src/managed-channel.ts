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

/**
 * The notice the inbound clamp appends when it shortens a message, so the
 * agent and operator can tell the input was clipped rather than receiving a
 * bare prefix whose tail — often the operative constraints — is silently gone.
 * Inbound-specific: the outbound CHANNEL_TRUNCATION_NOTICE lives in core and
 * speaks of a reply, and channel-base does not import core.
 */
export const CHANNEL_INBOUND_TRUNCATION_NOTICE =
  '\n\n[Message truncated because it exceeded the channel input size limit.]';

// The wire's text bound (the control plane's Jakarta @Size) and the Harness
// envelope's byte line; the overhead allowance covers the event's JSON
// metadata around the text. Shared so the providers cannot drift.
const MAX_WIRE_TEXT_CHARS = 32_000;
const ENVELOPE_BYTE_LIMIT = 64 * 1024;
const TEXT_ENVELOPE_OVERHEAD_BYTES = 4096;

/**
 * Clamp an over-long inbound message to both server bounds so it is admitted
 * truncated instead of meeting a deterministic refusal and being dropped
 * whole, and mark the truncation. The char cap counts UTF-16 units (the
 * server's maxTextChars does too); a UTF-16 slice can land inside a surrogate
 * pair, so back off a trailing high surrogate. The byte bound is enforced on
 * the JSON-serialized envelope, where a control character costs six bytes and
 * a quote/backslash two — not on the raw UTF-8 length — so budget the escaped
 * length and cut by code points. The notice's characters and escaped bytes are
 * reserved inside both budgets so the marked result still fits; a frame that
 * fits unchanged carries no notice.
 */
export function fitInboundText(text: string): string {
  const encodedBytes = (s: string): number =>
    Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;
  const byteLimit = ENVELOPE_BYTE_LIMIT - TEXT_ENVELOPE_OVERHEAD_BYTES;
  const notice = CHANNEL_INBOUND_TRUNCATION_NOTICE;
  // A frame that fits both bounds unchanged is admitted as-is, no notice.
  let bounded = text.slice(0, MAX_WIRE_TEXT_CHARS);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  if (bounded === text && encodedBytes(bounded) <= byteLimit) return text;
  // Truncation: reserve room for the notice in both budgets, cut the core to
  // fit, then append the notice. Escaping is per-character, so the marked
  // result's escaped length is the core's plus the notice's, within the budget.
  const coreCharLimit = Math.max(0, MAX_WIRE_TEXT_CHARS - notice.length);
  const coreByteLimit = Math.max(0, byteLimit - encodedBytes(notice));
  let core = text.slice(0, coreCharLimit);
  if (/[\uD800-\uDBFF]$/.test(core)) core = core.slice(0, -1);
  if (encodedBytes(core) > coreByteLimit) {
    const chars = Array.from(core);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (encodedBytes(chars.slice(0, mid).join('')) <= coreByteLimit) lo = mid;
      else hi = mid - 1;
    }
    core = chars.slice(0, lo).join('');
  }
  return core + notice;
}

/** The trusted control-plane surface the adapter talks to. */
export interface ManagedChannelControlPlane {
  /**
   * A stable key of the registration this client talks to — the control-plane
   * base URL, tenant, channel, and the owning actor, workspace and cwd-relative.
   * A persisting adapter that needs cross-registration isolation keys its ledger
   * by it (the WeCom and DingTalk adapters do), so a ledger staged for one
   * registration is never replayed into another when the same configured entry
   * is restarted against a different destination or owner. Binding only the
   * tenant/channel is not enough: a new actor/workspace of the same tenant/channel
   * must not inherit the prior owner's pending. This is a capability a persisting
   * adapter opts into, not an invariant every sibling already satisfies — the
   * GitHub store keys by name+endpoint only and email is a separate variant, so
   * each is its own follow-up. Optional so test doubles that do not persist may
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
