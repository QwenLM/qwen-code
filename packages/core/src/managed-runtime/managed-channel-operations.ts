/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  CHANNEL_DELIVERY_MAX_SEGMENTS,
  CHANNEL_ROUTE_SCOPE_KINDS,
  type ChannelDelivery,
  type ChannelDeliveryReceipt,
  type ChannelRoute,
  type ChannelRouteScope,
} from './managed-channel-record.js';
import type { ExtensionRun } from './managed-extension-record.js';
import {
  ManagedSessionRecordError,
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// H5b/H5c of #12827: the pure construction side of the channel runtime —
// the ingress identities the control plane and the Harness derive alike,
// the input envelope and reply resources, the route policy pin, and every
// revision body the channel funnel commits. Writers go through the verb
// funnel (packages/cli/src/serve/hosted-channel-session.ts), which
// serializes these builders onto `commitExtensionRecord`. See
// docs/design/2026-10-07-managed-channel-runtime.md.

/** The inbound and outbound bounds of the first channel runtime slice. */
export const MANAGED_CHANNEL_LIMITS = Object.freeze({
  maxTextChars: 32_000,
  /** The inline resource bound of the hosted Session store. */
  maxEnvelopeBytes: 64 * 1024,
  maxAttachments: 16,
  maxInlineAttachmentBytes: 64 * 1024,
  maxReplyContextBytes: 8 * 1024,
  maxSegmentBytes: 48 * 1024,
  maxSegments: CHANNEL_DELIVERY_MAX_SEGMENTS,
  maxSubjectChars: 200,
} as const);

/** The `source` of every channel input, as the wake scheduler admits it. */
export const CHANNEL_INPUT_SOURCE = 'channel';

export const CHANNEL_RESOURCE_KINDS = Object.freeze({
  policy: 'managed-channel-policy',
  input: 'managed-input',
  attachment: 'managed-channel-attachment',
  reply: 'managed-channel-reply',
  segment: 'managed-channel-segment',
} as const);

const SEPARATOR = '\u0000';

function sha256(parts: ReadonlyArray<string | number>): string {
  return createHash('sha256')
    .update(parts.map(String).join(SEPARATOR), 'utf8')
    .digest('hex');
}

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function assertNoSeparator(value: string, label: string): string {
  if (value.length === 0 || value.includes(SEPARATOR)) {
    fail(`${label} must be non-empty and hold no NUL.`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive integer.`);
  }
  return value;
}

/** The four-part ingress identity of one platform event (H5 decision 2). */
export interface ChannelIngressIdentity {
  readonly tenantId: string;
  readonly channelInstanceId: string;
  readonly accountGeneration: number;
  readonly platformEventId: string;
  readonly semanticRevision: number;
}

/**
 * The V47 `route_key`: sha256 over the tenant, the instance, the account
 * generation, the platform event and the semantic revision, NUL-joined —
 * the exact derivation of `ChannelRouteRepository.routeKey` in Java.
 */
export function channelIngressKey(identity: ChannelIngressIdentity): string {
  return sha256([
    assertNoSeparator(identity.tenantId, 'tenantId'),
    assertNoSeparator(identity.channelInstanceId, 'channelInstanceId'),
    positive(identity.accountGeneration, 'accountGeneration'),
    assertNoSeparator(identity.platformEventId, 'platformEventId'),
    positive(identity.semanticRevision, 'semanticRevision'),
  ]);
}

/** A provider redelivery derives the same input id; two events never do. */
export function channelInputId(identity: ChannelIngressIdentity): string {
  return `chin-${channelIngressKey(identity)}`;
}

/** The route chain identity: the scope, never the generation (decision 3). */
export function channelRouteId(params: {
  readonly channelInstanceId: string;
  readonly accountId: string;
  readonly scope: ChannelRouteScope;
}): string {
  return `chrt-${sha256([
    assertNoSeparator(params.channelInstanceId, 'channelInstanceId'),
    assertNoSeparator(params.accountId, 'accountId'),
    params.scope.kind,
    params.scope.senderId ?? '',
    params.scope.chatId ?? '',
    params.scope.threadId ?? '',
  ])}`;
}

/** The idempotency key of the route's Session creation (decision 4). */
export function channelSessionCreationKey(params: {
  readonly tenantId: string;
  readonly channelInstanceId: string;
  readonly routeId: string;
}): string {
  return `chcr-${sha256([
    assertNoSeparator(params.tenantId, 'tenantId'),
    assertNoSeparator(params.channelInstanceId, 'channelInstanceId'),
    assertNoSeparator(params.routeId, 'routeId'),
  ])}`;
}

/** One reply per input turn; a resend opens its own chain beside it. */
export function channelDeliveryId(inputId: string): string {
  return `${inputId}:reply`;
}

export function channelResendDeliveryId(
  deliveryId: string,
  attempt: number,
): string {
  return `${deliveryId}:r${positive(attempt, 'attempt')}`;
}

export const CHANNEL_SENDER_POLICIES = [
  'allowlist',
  'open',
  'disabled',
] as const;
export const CHANNEL_DISPATCH_MODES = ['followup', 'steer'] as const;

/** The `policyRef` content: the admission configuration pinned per route. */
export interface ChannelPolicy {
  readonly adapter: string;
  readonly senderPolicy: (typeof CHANNEL_SENDER_POLICIES)[number];
  readonly allowedSenders: readonly string[];
  readonly dispatchMode: (typeof CHANNEL_DISPATCH_MODES)[number];
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const present = Object.keys(record).sort();
  if (present.join(',') !== [...keys].sort().join(',')) {
    fail(`${label} must have exactly the keys ${keys.join(', ')}.`);
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} must be JSON.`);
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    fail(`${label} must be text of at most ${max} characters.`);
  }
  return value;
}

function nullableText(
  value: unknown,
  label: string,
  max: number,
): string | null {
  return value === null ? null : text(value, label, max);
}

export function encodeChannelPolicy(policy: ChannelPolicy): Buffer {
  return Buffer.from(JSON.stringify(decodeChannelPolicyValue(policy)), 'utf8');
}

export function decodeChannelPolicy(bytes: Buffer): ChannelPolicy {
  return decodeChannelPolicyValue(parseJson(bytes, 'Channel policy'));
}

/** A policy as a request carries it, before it is pinned as a resource. */
export function assertChannelPolicy(value: unknown): ChannelPolicy {
  return decodeChannelPolicyValue(value);
}

function decodeChannelPolicyValue(value: unknown): ChannelPolicy {
  const record = plainObject(value, 'Channel policy');
  exactKeys(
    record,
    ['adapter', 'senderPolicy', 'allowedSenders', 'dispatchMode'],
    'Channel policy',
  );
  const adapter = text(record['adapter'], 'Channel policy adapter', 64);
  if (!/^[a-z][a-z0-9-]*$/.test(adapter)) {
    fail('Channel policy adapter must be a lowercase identifier.');
  }
  const senderPolicy = record['senderPolicy'];
  if (!(CHANNEL_SENDER_POLICIES as readonly unknown[]).includes(senderPolicy)) {
    fail('Channel policy senderPolicy must be allowlist, open or disabled.');
  }
  const dispatchMode = record['dispatchMode'];
  if (!(CHANNEL_DISPATCH_MODES as readonly unknown[]).includes(dispatchMode)) {
    fail('Channel policy dispatchMode must be followup or steer.');
  }
  const senders = record['allowedSenders'];
  if (
    !Array.isArray(senders) ||
    senders.length > 1024 ||
    !senders.every((sender) => typeof sender === 'string' && sender.length > 0)
  ) {
    fail('Channel policy allowedSenders must list sender identities.');
  }
  return Object.freeze({
    adapter,
    senderPolicy: senderPolicy as ChannelPolicy['senderPolicy'],
    allowedSenders: Object.freeze([...(senders as string[])]),
    dispatchMode: dispatchMode as ChannelPolicy['dispatchMode'],
  });
}

export interface ChannelAttachmentStaged {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly ref: ManagedSessionDurableRef;
}

/** An attachment beyond the inline bound: listed, never silently dropped. */
export interface ChannelAttachmentOmitted {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly omitted: 'too_large';
}

export type ChannelAttachment =
  | ChannelAttachmentStaged
  | ChannelAttachmentOmitted;

/**
 * The `contentRef` content of a channel input: everything the turn and the
 * reply need, committed with the input and immutable afterwards. The route
 * pin names the binding revision the reply must go back through.
 */
export interface ChannelInputEnvelope {
  readonly channelInstanceId: string;
  readonly accountId: string;
  readonly accountGeneration: number;
  readonly platformEventId: string;
  readonly semanticRevision: number;
  readonly routeId: string;
  readonly routeRevision: number;
  readonly senderId: string;
  readonly chatId: string | null;
  readonly threadId: string | null;
  /** Untrusted presentation metadata (a subject line); never authority. */
  readonly subject: string | null;
  readonly text: string;
  readonly attachments: readonly ChannelAttachment[];
  /** Adapter-opaque reply addressing, bounded JSON; echoed into the reply. */
  readonly replyContext: unknown;
}

const ENVELOPE_KEYS = [
  'channelInstanceId',
  'accountId',
  'accountGeneration',
  'platformEventId',
  'semanticRevision',
  'routeId',
  'routeRevision',
  'senderId',
  'chatId',
  'threadId',
  'subject',
  'text',
  'attachments',
  'replyContext',
] as const;

const DIGEST = /^[a-f0-9]{64}$/;

function parseAttachment(value: unknown, index: number): ChannelAttachment {
  const label = `attachments[${index}]`;
  const record = plainObject(value, label);
  const common = {
    fileName: text(record['fileName'], `${label}.fileName`, 128),
    mimeType: text(record['mimeType'], `${label}.mimeType`, 128),
    byteLength: record['byteLength'],
    digest: record['digest'],
  };
  if (
    !Number.isSafeInteger(common.byteLength) ||
    (common.byteLength as number) < 0 ||
    typeof common.digest !== 'string' ||
    !DIGEST.test(common.digest)
  ) {
    fail(`${label} must carry a byte length and a sha256 digest.`);
  }
  if ('omitted' in record) {
    exactKeys(
      record,
      ['fileName', 'mimeType', 'byteLength', 'digest', 'omitted'],
      label,
    );
    if (record['omitted'] !== 'too_large') {
      fail(`${label}.omitted must be too_large.`);
    }
    return Object.freeze({
      ...(common as Omit<ChannelAttachmentOmitted, 'omitted'>),
      omitted: 'too_large',
    });
  }
  exactKeys(
    record,
    ['fileName', 'mimeType', 'byteLength', 'digest', 'ref'],
    label,
  );
  const ref = assertManagedSessionDurableRef(
    record['ref'] as ManagedSessionJsonValue,
    `${label}.ref`,
  );
  if (ref.digest !== common.digest || ref.byteLength !== common.byteLength) {
    fail(`${label} must describe the bytes its reference names.`);
  }
  return Object.freeze({
    ...(common as Omit<ChannelAttachmentStaged, 'ref'>),
    ref: Object.freeze(ref),
  });
}

function decodeEnvelopeValue(value: unknown): ChannelInputEnvelope {
  const record = plainObject(value, 'Channel input envelope');
  exactKeys(record, ENVELOPE_KEYS, 'Channel input envelope');
  const attachments = record['attachments'];
  if (
    !Array.isArray(attachments) ||
    attachments.length > MANAGED_CHANNEL_LIMITS.maxAttachments
  ) {
    fail(
      `Channel input attachments must number at most ${MANAGED_CHANNEL_LIMITS.maxAttachments}.`,
    );
  }
  const replyContext = record['replyContext'];
  if (
    Buffer.byteLength(JSON.stringify(replyContext ?? null), 'utf8') >
    MANAGED_CHANNEL_LIMITS.maxReplyContextBytes
  ) {
    fail(
      `Channel reply context exceeds ${MANAGED_CHANNEL_LIMITS.maxReplyContextBytes} bytes (byte_limit).`,
    );
  }
  const envelope: ChannelInputEnvelope = {
    channelInstanceId: assertNoSeparator(
      text(record['channelInstanceId'], 'channelInstanceId', 128),
      'channelInstanceId',
    ),
    accountId: assertNoSeparator(
      text(record['accountId'], 'accountId', 512),
      'accountId',
    ),
    accountGeneration: positive(
      record['accountGeneration'] as number,
      'accountGeneration',
    ),
    platformEventId: assertNoSeparator(
      text(record['platformEventId'], 'platformEventId', 512),
      'platformEventId',
    ),
    semanticRevision: positive(
      record['semanticRevision'] as number,
      'semanticRevision',
    ),
    routeId: text(record['routeId'], 'routeId', 512),
    routeRevision: positive(record['routeRevision'] as number, 'routeRevision'),
    senderId: text(record['senderId'], 'senderId', 512),
    chatId: nullableText(record['chatId'], 'chatId', 512),
    threadId: nullableText(record['threadId'], 'threadId', 512),
    subject: nullableText(
      record['subject'],
      'subject',
      MANAGED_CHANNEL_LIMITS.maxSubjectChars,
    ),
    text: text(record['text'], 'text', MANAGED_CHANNEL_LIMITS.maxTextChars),
    attachments: Object.freeze(
      (attachments as unknown[]).map((entry, index) =>
        parseAttachment(entry, index),
      ),
    ),
    replyContext: replyContext === undefined ? null : replyContext,
  };
  return Object.freeze(envelope);
}

export function encodeChannelInputEnvelope(
  envelope: ChannelInputEnvelope,
): Buffer {
  const bytes = Buffer.from(
    JSON.stringify(decodeEnvelopeValue(envelope)),
    'utf8',
  );
  if (bytes.byteLength > MANAGED_CHANNEL_LIMITS.maxEnvelopeBytes) {
    fail(
      `Channel input envelope exceeds ${MANAGED_CHANNEL_LIMITS.maxEnvelopeBytes} bytes (byte_limit).`,
    );
  }
  return bytes;
}

export function decodeChannelInputEnvelope(
  bytes: Buffer,
): ChannelInputEnvelope {
  return decodeEnvelopeValue(parseJson(bytes, 'Channel input envelope'));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The model-facing text of one channel input. The subject and the sender
 * are untrusted presentation; the route decided the authority already.
 */
export function channelInputText(envelope: ChannelInputEnvelope): string {
  const lines = [
    '<channel-message>',
    `<channel>${escapeXml(envelope.channelInstanceId)}</channel>`,
    `<sender>${escapeXml(envelope.senderId)}</sender>`,
    `<platform-event-id>${escapeXml(envelope.platformEventId)}</platform-event-id>`,
  ];
  if (envelope.subject !== null) {
    lines.push(
      `<subject untrusted="true">${escapeXml(envelope.subject)}</subject>`,
    );
  }
  if (envelope.attachments.length > 0) {
    lines.push('<attachments>');
    for (const attachment of envelope.attachments) {
      const status =
        'omitted' in attachment
          ? ' omitted="too_large"'
          : ` resource="${escapeXml(attachment.ref.resourceId)}"`;
      lines.push(
        `<attachment name="${escapeXml(attachment.fileName)}" type="${escapeXml(attachment.mimeType)}" bytes="${attachment.byteLength}" sha256="${attachment.digest}"${status}/>`,
      );
    }
    lines.push('</attachments>');
  }
  lines.push(`<text>${escapeXml(envelope.text)}</text>`, '</channel-message>');
  return lines.join('\n');
}

/** The `contentRef` content of a delivery: the formal reply. */
export interface ChannelReply {
  readonly text: string;
  readonly replyContext: unknown;
}

export function encodeChannelReply(reply: ChannelReply): Buffer {
  return Buffer.from(
    JSON.stringify({ text: reply.text, replyContext: reply.replyContext }),
    'utf8',
  );
}

export function decodeChannelReply(bytes: Buffer): ChannelReply {
  const record = plainObject(
    parseJson(bytes, 'Channel reply'),
    'Channel reply',
  );
  exactKeys(record, ['text', 'replyContext'], 'Channel reply');
  if (typeof record['text'] !== 'string')
    fail('Channel reply text is missing.');
  return Object.freeze({
    text: record['text'],
    replyContext: record['replyContext'],
  });
}

const TRUNCATION_NOTICE =
  '\n\n[Reply truncated because it exceeded the channel segment size limit.]';

/**
 * The email plan: one segment, bounded. A provider with cards or threads
 * supplies its own plan against the same segment contract.
 */
export function planChannelSegments(text: string): readonly string[] {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= MANAGED_CHANNEL_LIMITS.maxSegmentBytes) {
    return Object.freeze([text]);
  }
  const limit =
    MANAGED_CHANNEL_LIMITS.maxSegmentBytes -
    Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
  // Cut on a UTF-8 boundary, so the segment stays valid text.
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return Object.freeze([
    bytes.subarray(0, end).toString('utf8') + TRUNCATION_NOTICE,
  ]);
}

function routeRun(routeId: string): ExtensionRun {
  return Object.freeze({
    state: 'admitted',
    reason: null,
    definition: null,
    executionCallId: null,
    effectId: routeId,
    dispatchId: null,
    deliveryId: null,
    execution: null,
    runtime: null,
    delivery: null,
  });
}

export function assertChannelRouteScope(value: unknown): ChannelRouteScope {
  const record = plainObject(value, 'Channel route scope');
  exactKeys(record, ['kind', 'senderId', 'chatId', 'threadId'], 'scope');
  if (
    !(CHANNEL_ROUTE_SCOPE_KINDS as readonly unknown[]).includes(record['kind'])
  ) {
    fail(
      'Channel route scope kind must be user, chat_thread, thread or single.',
    );
  }
  return Object.freeze({
    kind: record['kind'] as ChannelRouteScope['kind'],
    senderId: nullableText(record['senderId'], 'scope.senderId', 512),
    chatId: nullableText(record['chatId'], 'scope.chatId', 512),
    threadId: nullableText(record['threadId'], 'scope.threadId', 512),
  });
}

/** Revision 1 of a route: the binding opened with its first input. */
export function channelRouteOpenBody(params: {
  readonly routeId: string;
  readonly channelInstanceId: string;
  readonly accountId: string;
  readonly accountGeneration: number;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly scope: ChannelRouteScope;
  readonly policyRef: ManagedSessionDurableRef;
}): ChannelRoute {
  return Object.freeze({
    routeId: params.routeId,
    channelInstanceId: params.channelInstanceId,
    accountId: params.accountId,
    accountGeneration: positive(params.accountGeneration, 'accountGeneration'),
    routeRevision: 1,
    rootSessionId: params.rootSessionId,
    sessionId: params.sessionId,
    scope: params.scope,
    policyRef: params.policyRef,
    run: routeRun(params.routeId),
  });
}

/**
 * A provider re-key: the next binding revision pins the newer generation.
 * An older generation is refused here, before anything is published.
 */
export function channelRouteRolloverBody(
  previous: ChannelRoute,
  params: {
    readonly accountGeneration: number;
    readonly policyRef?: ManagedSessionDurableRef;
  },
): ChannelRoute {
  if (
    positive(params.accountGeneration, 'accountGeneration') <=
    previous.accountGeneration
  ) {
    fail(
      `Channel route ${previous.routeId} cannot roll its generation back to ${params.accountGeneration} (channel_generation_stale).`,
    );
  }
  return Object.freeze({
    ...previous,
    accountGeneration: params.accountGeneration,
    routeRevision: previous.routeRevision + 1,
    policyRef: params.policyRef ?? previous.policyRef,
  });
}

function deliveryRun(
  deliveryId: string,
  state: ExtensionRun['state'],
  line: NonNullable<ExtensionRun['delivery']>['state'],
): ExtensionRun {
  return Object.freeze({
    state,
    reason: null,
    definition: null,
    executionCallId: null,
    effectId: deliveryId,
    dispatchId: null,
    deliveryId,
    execution: null,
    runtime: null,
    delivery: Object.freeze({ target: 'channel' as const, state: line }),
  });
}

/** Revision 1 of a delivery: the plan, before any send. */
export function channelDeliveryPlanBody(params: {
  readonly deliveryId: string;
  readonly routeId: string;
  readonly routeRevision: number;
  readonly sourceTurnId: string;
  readonly contentRef: ManagedSessionDurableRef;
  readonly segments: ReadonlyArray<{
    readonly segmentId: string;
    readonly contentRef: ManagedSessionDurableRef;
  }>;
}): ChannelDelivery {
  if (
    params.segments.length < 1 ||
    params.segments.length > MANAGED_CHANNEL_LIMITS.maxSegments
  ) {
    fail(
      `Channel delivery plans 1 to ${MANAGED_CHANNEL_LIMITS.maxSegments} segments.`,
    );
  }
  return Object.freeze({
    deliveryId: params.deliveryId,
    routeId: params.routeId,
    routeRevision: positive(params.routeRevision, 'routeRevision'),
    sourceTurnId: params.sourceTurnId,
    contentRef: params.contentRef,
    segments: Object.freeze(
      params.segments.map((segment, ordinal) =>
        Object.freeze({
          segmentId: segment.segmentId,
          ordinal,
          contentRef: segment.contentRef,
          receipt: null,
        }),
      ),
    ),
    cancelRequested: false,
    run: deliveryRun(params.deliveryId, 'admitted', 'planned'),
  });
}

function withRun(
  previous: ChannelDelivery,
  state: ExtensionRun['state'],
  line: NonNullable<ExtensionRun['delivery']>['state'],
  changes: Partial<Pick<ChannelDelivery, 'segments' | 'cancelRequested'>> = {},
): ChannelDelivery {
  return Object.freeze({
    ...previous,
    ...changes,
    run: deliveryRun(previous.deliveryId, state, line),
  });
}

/** The dispatcher claimed the delivery (or resumed a partial one). */
export function channelDeliverySendingBody(
  previous: ChannelDelivery,
): ChannelDelivery {
  return withRun(previous, 'running', 'sending');
}

export function channelDeliveryProvenSegments(
  delivery: ChannelDelivery,
): number {
  return delivery.segments.filter((segment) => segment.receipt !== null).length;
}

/**
 * The provider accepted one segment. The last receipt settles the run as
 * delivered; an earlier one leaves the rest outstanding as partial.
 */
export function channelDeliveryReceiptBody(
  previous: ChannelDelivery,
  ordinal: number,
  receipt: ChannelDeliveryReceipt,
): ChannelDelivery {
  const segment = previous.segments[ordinal];
  if (segment === undefined) {
    fail(`Channel delivery ${previous.deliveryId} has no segment ${ordinal}.`);
  }
  if (segment.receipt !== null) {
    fail(
      `Channel delivery segment ${segment.segmentId} already has a receipt.`,
    );
  }
  const segments = previous.segments.map((entry, index) =>
    index === ordinal ? Object.freeze({ ...entry, receipt }) : entry,
  );
  const settled = segments.filter((entry) => entry.receipt !== null).length;
  const complete = settled === segments.length;
  return withRun(
    previous,
    complete
      ? 'settled'
      : previous.run.state === 'waiting'
        ? 'waiting'
        : 'running',
    complete ? 'delivered' : 'partial',
    { segments: Object.freeze(segments) },
  );
}

/** A send whose outcome cannot be proven: the provider may hold it. */
export function channelDeliveryUnknownBody(
  previous: ChannelDelivery,
): ChannelDelivery {
  return withRun(previous, 'waiting', 'unknown');
}

/** A definitive provider refusal of the outstanding segments. */
export function channelDeliveryRejectedBody(
  previous: ChannelDelivery,
): ChannelDelivery {
  return withRun(previous, 'failed', 'rejected');
}

/** A cancel was requested; set once, never cleared. */
export function channelDeliveryCancelRequestedBody(
  previous: ChannelDelivery,
): ChannelDelivery {
  return Object.freeze({ ...previous, cancelRequested: true });
}

/** A planned delivery that never dispatched settles cancelled. */
export function channelDeliveryCancelledBody(
  previous: ChannelDelivery,
): ChannelDelivery {
  if (previous.run.delivery?.state !== 'planned') {
    fail(
      `Channel delivery ${previous.deliveryId} is ${previous.run.delivery?.state} and can no longer be cancelled.`,
    );
  }
  return withRun(previous, 'cancelled', 'cancelled', { cancelRequested: true });
}

/** The delivery states an explicit resend may be opened from. */
export function channelDeliveryResendable(delivery: ChannelDelivery): boolean {
  const state = delivery.run.delivery?.state;
  return (
    (state === 'unknown' || state === 'rejected') &&
    channelDeliveryProvenSegments(delivery) < delivery.segments.length
  );
}

/**
 * An explicit resend: a new chain carrying only the segments the provider
 * never provably accepted, renumbered densely, identities kept. The
 * original record stays as it is (decision 11).
 */
export function channelDeliveryResendBody(
  previous: ChannelDelivery,
  deliveryId: string,
): ChannelDelivery {
  if (!channelDeliveryResendable(previous)) {
    fail(
      `Channel delivery ${previous.deliveryId} is ${previous.run.delivery?.state} and cannot be resent.`,
    );
  }
  return channelDeliveryPlanBody({
    deliveryId,
    routeId: previous.routeId,
    routeRevision: previous.routeRevision,
    sourceTurnId: previous.sourceTurnId,
    contentRef: previous.contentRef,
    segments: previous.segments
      .filter((segment) => segment.receipt === null)
      .map((segment) => ({
        segmentId: segment.segmentId,
        contentRef: segment.contentRef,
      })),
  });
}
