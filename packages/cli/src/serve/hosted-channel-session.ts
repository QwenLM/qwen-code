/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type {
  ChannelDelivery,
  ChannelDeliveryReceipt,
  ChannelRoute,
  ChannelRouteScope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-record.js';
import {
  parseChannelDelivery,
  parseChannelRoute,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-record.js';
import {
  CHANNEL_INPUT_SOURCE,
  CHANNEL_RESOURCE_KINDS,
  MANAGED_CHANNEL_LIMITS,
  channelDeliveryCancelRequestedBody,
  channelDeliveryCancelledBody,
  channelDeliveryId,
  channelDeliveryPlanBody,
  channelDeliveryReceiptBody,
  channelDeliveryRejectedBody,
  channelDeliveryResendBody,
  channelDeliveryResendable,
  channelDeliverySendingBody,
  channelDeliveryUnknownBody,
  channelInputText,
  channelResendDeliveryId,
  channelRouteId,
  channelRouteOpenBody,
  channelRouteRolloverBody,
  decodeChannelInputEnvelope,
  decodeChannelReply,
  encodeChannelInputEnvelope,
  encodeChannelPolicy,
  encodeChannelReply,
  planChannelSegments,
  type ChannelAttachment,
  type ChannelInputEnvelope,
  type ChannelPolicy,
  type ChannelReply,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import type {
  ManagedSessionActor,
  ManagedSessionCommand,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type {
  ManagedSessionDomain,
  ManagedSessionDurableRef,
  ManagedSessionEvent,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

// H5b/H5c of #12827: the hosted funnel of a Session's channel routes and
// deliveries. The control plane's adapter surface drives it through one
// operation route; every verb commits a record revision (or the input and
// its wake) as facts arrive, replays by its derived command id, and reads
// the committed chain before acting — never its own memory. See
// docs/design/2026-10-07-managed-channel-runtime.md.

/** The narrow Session slice a HostedChannelSession commits through. */
export interface HostedChannelStore {
  readonly authority: {
    readonly committedSequence: number;
    eventsInSequenceRange(
      from: number,
      to: number,
    ): readonly ManagedSessionEvent[];
    extensionRecord(
      domain: ManagedSessionDomain,
      recordId: string,
    ): { readonly record: unknown; readonly revision: number } | undefined;
    extensionRecordsInDomain(
      domain: ManagedSessionDomain,
    ): ReadonlyArray<{ readonly record: unknown }>;
    commitExtensionRecord(
      command: ManagedSessionCommand,
      request: {
        readonly domain: ManagedSessionDomain;
        readonly record: unknown;
        readonly input?: ManagedSessionInputRequest;
      },
      actor: ManagedSessionActor,
    ): Promise<unknown>;
    submitInput(
      command: ManagedSessionCommand,
      input: ManagedSessionInputRequest,
    ): Promise<unknown>;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
  readonly sink: {
    project(): Promise<ChatRecord[]>;
  };
}

export interface ChannelInboundAttachment {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export interface ChannelSubmitInputParams {
  readonly inputId: string;
  readonly channelInstanceId: string;
  readonly accountId: string;
  readonly accountGeneration: number;
  readonly platformEventId: string;
  readonly semanticRevision: number;
  readonly scope: ChannelRouteScope;
  readonly policy: ChannelPolicy;
  readonly senderId: string;
  readonly chatId: string | null;
  readonly threadId: string | null;
  readonly subject: string | null;
  readonly text: string;
  readonly attachments: readonly ChannelInboundAttachment[];
  readonly replyContext: unknown;
}

export interface ChannelSubmitInputResult {
  readonly inputId: string;
  readonly turnId: string;
  readonly routeId: string;
  readonly routeRevision: number;
  readonly replayed: boolean;
  readonly attachments: readonly ChannelAttachment[];
}

/** What the adapter needs to send: the outstanding segments' text. */
export interface ChannelClaimResult {
  readonly delivery: ChannelDelivery;
  readonly reply: ChannelReply;
  readonly segments: ReadonlyArray<{
    readonly ordinal: number;
    readonly segmentId: string;
    readonly text: string;
  }>;
}

/** An older account generation admits nothing new (H5 decision 6). */
export class ChannelGenerationStaleError extends Error {
  constructor(routeId: string, committed: number, offered: number) {
    super(
      `Channel route ${routeId} is at account generation ${committed}; generation ${offered} admits nothing new (channel_generation_stale).`,
    );
  }
}

const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class HostedChannelSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedChannelStore,
    private readonly key: ManagedSessionKey,
  ) {}

  route(routeId: string): ChannelRoute | undefined {
    const existing = this.store.authority.extensionRecord(
      'channel_route',
      routeId,
    );
    return existing ? parseChannelRoute(existing.record) : undefined;
  }

  delivery(deliveryId: string): ChannelDelivery | undefined {
    const existing = this.store.authority.extensionRecord(
      'channel_delivery',
      deliveryId,
    );
    return existing ? parseChannelDelivery(existing.record) : undefined;
  }

  /** The committed admission of one input, or undefined. */
  acceptedInput(inputId: string): ManagedSessionEvent | undefined {
    const authority = this.store.authority;
    return authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['inputId'] === inputId &&
          event.payload['source'] === CHANNEL_INPUT_SOURCE,
      );
  }

  async envelopeOf(inputId: string): Promise<ChannelInputEnvelope | undefined> {
    const accepted = this.acceptedInput(inputId);
    if (accepted === undefined) return undefined;
    const ref = assertManagedSessionDurableRef(
      accepted.payload['contentRef'],
      'channel input contentRef',
    );
    return decodeChannelInputEnvelope(await this.store.resources.read(ref));
  }

  /**
   * `submitChannelInput`: stages the attachments, publishes the envelope,
   * and commits — in one transaction — the route revision the event owes
   * (its opening or its generation rollover) together with the input and
   * its wake; an event on a committed route at the same generation commits
   * the input alone. A redelivery answers the committed admission.
   */
  submitInput(
    params: ChannelSubmitInputParams,
  ): Promise<ChannelSubmitInputResult> {
    return this.serial(async () => {
      const replayed = await this.envelopeOf(params.inputId);
      if (replayed !== undefined) {
        return {
          inputId: params.inputId,
          turnId: params.inputId,
          routeId: replayed.routeId,
          routeRevision: replayed.routeRevision,
          replayed: true,
          attachments: replayed.attachments,
        };
      }
      const routeId = channelRouteId({
        channelInstanceId: params.channelInstanceId,
        accountId: params.accountId,
        scope: params.scope,
      });
      const existing = this.route(routeId);
      if (
        existing !== undefined &&
        existing.accountGeneration > params.accountGeneration
      ) {
        throw new ChannelGenerationStaleError(
          routeId,
          existing.accountGeneration,
          params.accountGeneration,
        );
      }
      const attachments = await this.stageAttachments(params.attachments);
      const routeRevision =
        existing === undefined
          ? 1
          : existing.accountGeneration === params.accountGeneration
            ? existing.routeRevision
            : existing.routeRevision + 1;
      const envelope: ChannelInputEnvelope = {
        channelInstanceId: params.channelInstanceId,
        accountId: params.accountId,
        accountGeneration: params.accountGeneration,
        platformEventId: params.platformEventId,
        semanticRevision: params.semanticRevision,
        routeId,
        routeRevision,
        senderId: params.senderId,
        chatId: params.chatId,
        threadId: params.threadId,
        subject: params.subject,
        text: params.text,
        attachments,
        replyContext: params.replyContext,
      };
      const bytes = encodeChannelInputEnvelope(envelope);
      const input: ManagedSessionInputRequest = {
        inputId: params.inputId,
        turnId: params.inputId,
        source: CHANNEL_INPUT_SOURCE,
        contentRef: await this.store.resources.publish(
          CHANNEL_RESOURCE_KINDS.input,
          bytes,
        ),
        deadline: null,
        admissionRef: await this.store.resources.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        wakeReason: 'input',
      };
      if (existing !== undefined && routeRevision === existing.routeRevision) {
        await this.store.authority.submitInput(
          {
            operation: 'submitChannelInput',
            commandId: params.inputId,
            sessionKey: this.key,
            contentDigest: sha256(bytes),
          },
          input,
        );
      } else {
        const policyRef = await this.store.resources.publish(
          CHANNEL_RESOURCE_KINDS.policy,
          encodeChannelPolicy(params.policy),
        );
        const record =
          existing === undefined
            ? channelRouteOpenBody({
                routeId,
                channelInstanceId: params.channelInstanceId,
                accountId: params.accountId,
                accountGeneration: params.accountGeneration,
                rootSessionId: this.key.sessionId,
                sessionId: this.key.sessionId,
                scope: params.scope,
                policyRef,
              })
            : channelRouteRolloverBody(existing, {
                accountGeneration: params.accountGeneration,
                policyRef,
              });
        await this.store.authority.commitExtensionRecord(
          {
            operation: 'bindChannelRoute',
            commandId: `${routeId}:${routeRevision}`,
            sessionKey: this.key,
            contentDigest: digest(record),
          },
          { domain: 'channel_route', record, input },
          TRUSTED,
        );
      }
      return {
        inputId: params.inputId,
        turnId: params.inputId,
        routeId,
        routeRevision,
        replayed: false,
        attachments,
      };
    });
  }

  /** The text the wake turn runs for one channel input. */
  async turnText(inputId: string): Promise<string | undefined> {
    const envelope = await this.envelopeOf(inputId);
    return envelope === undefined ? undefined : channelInputText(envelope);
  }

  /**
   * `planChannelDelivery` for the reply of one settled channel turn: one
   * delivery per input, derived from the turn's own settled result, so a
   * crash between settle and plan re-plans the same chain on open. A turn
   * that settled without a completed answer plans nothing.
   */
  planReply(turnId: string): Promise<ChannelDelivery | undefined> {
    return this.serial(() => this.planReplyUnserialized(turnId));
  }

  private async planReplyUnserialized(
    turnId: string,
  ): Promise<ChannelDelivery | undefined> {
    const deliveryId = channelDeliveryId(turnId);
    const existing = this.delivery(deliveryId);
    if (existing !== undefined) return existing;
    const envelope = await this.envelopeOf(turnId);
    if (envelope === undefined) return undefined;
    const projected = await this.store.sink.project();
    const result = projected.findLast(
      (entry) =>
        entry.type === 'system' &&
        entry.subtype === 'turn_result' &&
        (entry.systemPayload as { promptId?: unknown } | undefined)
          ?.promptId === turnId,
    );
    const state = (result?.systemPayload as { state?: unknown } | undefined)
      ?.state;
    if (state !== 'completed') return undefined;
    const text = projected
      .filter(
        (entry) =>
          entry.type === 'assistant' && entry.daemonPromptId === turnId,
      )
      .flatMap((entry) =>
        (entry.message?.parts ?? []).map((part) =>
          typeof part.text === 'string' ? part.text : '',
        ),
      )
      .join('')
      .trim();
    if (text.length === 0) return undefined;
    const reply: ChannelReply = { text, replyContext: envelope.replyContext };
    const contentRef = await this.store.resources.publish(
      CHANNEL_RESOURCE_KINDS.reply,
      encodeChannelReply(reply),
    );
    const segments = [];
    for (const [ordinal, part] of planChannelSegments(text).entries()) {
      segments.push({
        segmentId: `${deliveryId}:${ordinal}`,
        contentRef: await this.store.resources.publish(
          CHANNEL_RESOURCE_KINDS.segment,
          Buffer.from(part, 'utf8'),
        ),
      });
    }
    const record = channelDeliveryPlanBody({
      deliveryId,
      routeId: envelope.routeId,
      routeRevision: envelope.routeRevision,
      sourceTurnId: turnId,
      contentRef,
      segments,
    });
    await this.commitDelivery(record, 1, 'planChannelDelivery');
    return record;
  }

  /**
   * Every settled channel turn without its delivery gets one: the open
   * path's reconciliation of the settle → plan crash window.
   */
  async reconcileReplies(): Promise<string[]> {
    const authority = this.store.authority;
    const planned: string[] = [];
    for (const event of authority.eventsInSequenceRange(
      1,
      authority.committedSequence,
    )) {
      if (
        event.kind !== 'input.accepted' ||
        event.payload['source'] !== CHANNEL_INPUT_SOURCE
      )
        continue;
      const turnId = event.payload['turnId'];
      if (typeof turnId !== 'string') continue;
      if (this.delivery(channelDeliveryId(turnId)) !== undefined) continue;
      if ((await this.planReply(turnId)) !== undefined) planned.push(turnId);
    }
    return planned;
  }

  /** The deliveries still owed to a dispatcher: planned, or partial. */
  pendingDeliveries(): ChannelDelivery[] {
    return this.store.authority
      .extensionRecordsInDomain('channel_delivery')
      .map((entry) => parseChannelDelivery(entry.record))
      .filter((delivery) => {
        const state = delivery.run.delivery?.state;
        return state === 'planned' || state === 'partial';
      });
  }

  /**
   * `dispatchChannelDelivery`: the dispatcher claimed the delivery (or
   * resumed a partial one). Answers the outstanding segments' text.
   */
  claim(deliveryId: string): Promise<ChannelClaimResult> {
    return this.serial(async () => {
      let delivery = this.mustDelivery(deliveryId);
      const state = delivery.run.delivery?.state;
      if (state === 'planned' || state === 'partial') {
        delivery = await this.revise(
          delivery,
          channelDeliverySendingBody(delivery),
          'dispatchChannelDelivery',
        );
      } else if (state !== 'sending') {
        throw new Error(
          `Channel delivery ${deliveryId} is ${state} and cannot be claimed.`,
        );
      }
      return this.claimResult(delivery);
    });
  }

  private async claimResult(
    delivery: ChannelDelivery,
  ): Promise<ChannelClaimResult> {
    const reply = decodeChannelReply(
      await this.store.resources.read(delivery.contentRef),
    );
    const segments = [];
    for (const segment of delivery.segments) {
      if (segment.receipt !== null) continue;
      segments.push({
        ordinal: segment.ordinal,
        segmentId: segment.segmentId,
        text: (await this.store.resources.read(segment.contentRef)).toString(
          'utf8',
        ),
      });
    }
    return { delivery, reply, segments };
  }

  /**
   * `acceptChannelReceipt` for one segment: partial while segments remain,
   * delivered with the last. A receipt that arrives while the line is
   * partial resumes it first — one allowed step per revision.
   */
  receipt(
    deliveryId: string,
    ordinal: number,
    receipt: ChannelDeliveryReceipt,
  ): Promise<ChannelDelivery> {
    return this.serial(async () => {
      let delivery = this.mustDelivery(deliveryId);
      const segment = delivery.segments[ordinal];
      if (segment?.receipt !== null && segment?.receipt !== undefined) {
        if (segment.receipt.providerMessageId === receipt.providerMessageId)
          return delivery;
        throw new Error(
          `Channel delivery segment ${segment.segmentId} already has a receipt.`,
        );
      }
      if (delivery.run.delivery?.state === 'partial') {
        delivery = await this.revise(
          delivery,
          channelDeliverySendingBody(delivery),
          'dispatchChannelDelivery',
        );
      }
      return this.revise(
        delivery,
        channelDeliveryReceiptBody(delivery, ordinal, receipt),
        'acceptChannelReceipt',
      );
    });
  }

  /** The outcome the adapter or the lease reconciler proved short of a receipt. */
  settle(
    deliveryId: string,
    outcome: 'unknown' | 'rejected',
  ): Promise<ChannelDelivery> {
    return this.serial(async () => {
      const delivery = this.mustDelivery(deliveryId);
      const state = delivery.run.delivery?.state;
      if (state === outcome) return delivery;
      return this.revise(
        delivery,
        outcome === 'unknown'
          ? channelDeliveryUnknownBody(delivery)
          : channelDeliveryRejectedBody(delivery),
        'acceptChannelReceipt',
      );
    });
  }

  /** `cancelChannelDelivery`: a planned one settles; a sending one records the request. */
  cancel(deliveryId: string): Promise<ChannelDelivery> {
    return this.serial(async () => {
      const delivery = this.mustDelivery(deliveryId);
      const state = delivery.run.delivery?.state;
      if (state === 'cancelled') return delivery;
      if (state === 'planned') {
        return this.revise(
          delivery,
          channelDeliveryCancelledBody(delivery),
          'cancelChannelDelivery',
        );
      }
      if (delivery.cancelRequested) return delivery;
      return this.revise(
        delivery,
        channelDeliveryCancelRequestedBody(delivery),
        'cancelChannelDelivery',
      );
    });
  }

  /**
   * An explicit resend: a new chain beside the unknown or rejected one,
   * carrying only the segments proven unsent (decision 11).
   */
  resend(deliveryId: string): Promise<ChannelDelivery> {
    return this.serial(async () => {
      const original = this.mustDelivery(deliveryId);
      if (!channelDeliveryResendable(original)) {
        throw new Error(
          `Channel delivery ${deliveryId} is ${original.run.delivery?.state} and cannot be resent.`,
        );
      }
      let attempt = 1;
      while (
        this.delivery(channelResendDeliveryId(deliveryId, attempt)) !==
        undefined
      ) {
        attempt += 1;
      }
      const record = channelDeliveryResendBody(
        original,
        channelResendDeliveryId(deliveryId, attempt),
      );
      await this.commitDelivery(record, 1, 'planChannelDelivery');
      return record;
    });
  }

  private async stageAttachments(
    attachments: readonly ChannelInboundAttachment[],
  ): Promise<ChannelAttachment[]> {
    if (attachments.length > MANAGED_CHANNEL_LIMITS.maxAttachments) {
      throw new Error(
        `Channel input carries more than ${MANAGED_CHANNEL_LIMITS.maxAttachments} attachments (byte_limit).`,
      );
    }
    const staged: ChannelAttachment[] = [];
    for (const attachment of attachments) {
      const common = {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        byteLength: attachment.bytes.byteLength,
        digest: sha256(attachment.bytes),
      };
      if (
        attachment.bytes.byteLength >
        MANAGED_CHANNEL_LIMITS.maxInlineAttachmentBytes
      ) {
        staged.push({ ...common, omitted: 'too_large' });
        continue;
      }
      staged.push({
        ...common,
        ref: await this.store.resources.publish(
          CHANNEL_RESOURCE_KINDS.attachment,
          attachment.bytes,
        ),
      });
    }
    return staged;
  }

  private mustDelivery(deliveryId: string): ChannelDelivery {
    const delivery = this.delivery(deliveryId);
    if (delivery === undefined) {
      throw new Error(`Channel delivery ${deliveryId} has no record.`);
    }
    return delivery;
  }

  private async revise(
    previous: ChannelDelivery,
    next: ChannelDelivery,
    operation: string,
  ): Promise<ChannelDelivery> {
    const existing = this.store.authority.extensionRecord(
      'channel_delivery',
      previous.deliveryId,
    );
    await this.commitDelivery(next, (existing?.revision ?? 0) + 1, operation);
    return next;
  }

  private async commitDelivery(
    record: ChannelDelivery,
    revision: number,
    operation: string,
  ): Promise<void> {
    await this.store.authority.commitExtensionRecord(
      {
        operation,
        commandId: `${record.deliveryId}:${revision}`,
        sessionKey: this.key,
        contentDigest: digest(record),
      },
      { domain: 'channel_delivery', record },
      TRUSTED,
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
