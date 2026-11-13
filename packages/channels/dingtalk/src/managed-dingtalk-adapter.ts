/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolvePrivatePolicy } from '@qwen-code/channel-base';
import type {
  ManagedChannelPolicy,
  ManagedInboundEvent,
  ManagedClaimedDelivery,
  ManagedChannelControlPlane,
} from '@qwen-code/channel-base';
import {
  MANAGED_DINGTALK_PENDING_LIMIT,
  ManagedDingtalkStateStore,
} from './managed-state.js';
import type { ManagedDingtalkState, ManagedReceipt } from './managed-state.js';

export type { ManagedReceipt } from './managed-state.js';

// H5d of #12827: the DingTalk reference adapter on the managed path. It never
// drives a model: an inbound robot message becomes one platform event the
// control plane admits (route binding + input + wake in the Session journal),
// and a reply comes back through the receipted outbox the adapter pulls.
// Every claim persists before its side effect, so a restart replays the same
// event or reports the same segment as unknown — never a second input, never
// a second send. See docs/design/2026-11-13-managed-channel-dingtalk-adapter.md.

/** What a reply needs, committed with the input and echoed by the outbox. */
export interface DingtalkReplyContext {
  conversationId: string;
  sessionWebhook: string;
  senderId: string;
  robotCode: string;
}

export interface DingtalkSettings {
  clientId: string;
  clientSecret: string;
  pollInterval: number;
}

/** A connected stream the adapter reads robot messages from. */
export interface ManagedDingtalkStreamClient {
  connect(): Promise<void>;
  disconnect(): void;
}

/** The outcome of one webhook send, classified by the deps. */
export interface DingtalkWebhookFailure extends Error {
  definitive?: boolean;
}

export interface ManagedDingtalkAdapterDeps {
  readonly createStreamClient: (
    settings: DingtalkSettings,
    onMessage: (messageId: string, data: string) => void,
  ) => ManagedDingtalkStreamClient;
  readonly sendWebhook: (webhook: string, text: string) => Promise<void>;
  readonly lock: (
    directory: string,
    onCompromised: () => void,
  ) => Promise<() => Promise<void>>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface ManagedDingtalkAdapterOptions {
  readonly name: string;
  readonly cwd: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly controlPlane: ManagedChannelControlPlane;
  readonly deps: ManagedDingtalkAdapterDeps;
  /** Off, the caller drives `tick()` itself (tests); on by default. */
  readonly pollLoop?: boolean;
}

const CLAIM_BATCH = 16;
const INSTANCE_SCOPED_REFUSALS = new Set([
  'workspace_not_found',
  'workspace_forbidden',
  'actor_scope_mismatch',
  'workspace_unavailable',
]);
const INSTANCE_REFUSAL_DROP_LIMIT = 1;
const INBOX_LIMIT = 256;
const CHANNEL_NOT_FOUND = 'channel_not_found';

interface InboxItem {
  messageId: string;
  data: string;
}

export function dingtalkSettings(
  config: Readonly<Record<string, unknown>>,
): DingtalkSettings {
  const clientId = config['clientId'];
  const clientSecret = config['clientSecret'];
  if (typeof clientId !== 'string' || !clientId.trim())
    throw new Error('DingTalk channel requires a clientId.');
  if (typeof clientSecret !== 'string' || !clientSecret.trim())
    throw new Error('DingTalk channel requires a clientSecret.');
  const pollInterval = Number(config['pollInterval'] ?? 2_000);
  return {
    clientId: clientId.trim(),
    clientSecret,
    pollInterval:
      Number.isSafeInteger(pollInterval) && pollInterval >= 250
        ? pollInterval
        : 2_000,
  };
}

export class ManagedDingtalkAdapter {
  readonly settings: DingtalkSettings;
  readonly policy: ManagedChannelPolicy;
  private readonly store: ManagedDingtalkStateStore;
  private readonly controlPlane: ManagedChannelControlPlane;
  private readonly deps: ManagedDingtalkAdapterDeps;
  private readonly log: (line: string) => void;
  private readonly pollLoop: boolean;
  private state?: ManagedDingtalkState;
  private stream?: ManagedDingtalkStreamClient;
  private releaseLock?: () => Promise<void>;
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private registeredGeneration?: number;
  private instanceStalled = false;
  private readonly inbox: InboxItem[] = [];

  constructor(options: ManagedDingtalkAdapterOptions) {
    this.settings = dingtalkSettings(options.config);
    const senderPolicy = resolvePrivatePolicy(options.config);
    const allowed = options.config['allowedUsers'];
    this.policy = {
      adapter: 'dingtalk',
      senderPolicy:
        senderPolicy === 'disabled' || senderPolicy === 'open'
          ? senderPolicy
          : 'allowlist',
      allowedSenders: Array.isArray(allowed)
        ? allowed.filter((entry): entry is string => typeof entry === 'string')
        : [],
      dispatchMode:
        options.config['dispatchMode'] === 'steer' ? 'steer' : 'followup',
    };
    this.store = new ManagedDingtalkStateStore(
      options.name,
      options.cwd,
      this.settings.clientId,
    );
    this.controlPlane = options.controlPlane;
    this.deps = options.deps;
    this.log =
      options.deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.pollLoop = options.pollLoop ?? true;
  }

  get stateFile(): string {
    return this.store.file;
  }

  get generation(): number | undefined {
    return this.state?.generation;
  }

  async connect(): Promise<void> {
    if (this.running || this.releaseLock)
      throw new Error('Managed DingTalk adapter is already connected.');
    try {
      this.releaseLock = await this.deps.lock(this.store.directory, () => {
        this.log(
          'Managed DingTalk state ownership was lost to another process; adapter stopped.',
        );
        this.stop();
      });
    } catch {
      throw new Error(
        'DingTalk state is owned by another process; managed adapter not started.',
      );
    }
    try {
      this.state = this.store.load() ?? {
        version: 1,
        generation: 1,
        pending: [],
        outbound: [],
        recent: [],
        webhooks: {},
      };
      if (this.state.pending.some((entry) => entry.held)) {
        this.instanceStalled = true;
        this.state.instanceRefusals = Math.max(
          this.state.instanceRefusals ?? 0,
          INSTANCE_REFUSAL_DROP_LIMIT + 1,
        );
      }
      this.persist();
      this.abort = new AbortController();
      this.running = true;
      this.registeredGeneration = undefined;
      this.stream = this.deps.createStreamClient(
        this.settings,
        (messageId, data) => this.onMessage(messageId, data),
      );
      await this.stream.connect();
      if (!this.running)
        throw new Error('Managed DingTalk adapter stopped during connection.');
      await this.ensureRegistered(this.state);
      await this.reportOrphanedOutbound();
      if (this.pollLoop) this.loop = this.runLoop();
    } catch (error) {
      this.stop();
      await this.release();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.loop;
    await this.controlPlane.disconnect().catch(() => undefined);
    await this.release();
  }

  /** One admission drain and one outbound pull, for callers that drive it. */
  async tick(): Promise<void> {
    await this.ensureRegistered(this.state!);
    await this.resubmitPending();
    await this.drainInbox();
    await this.reportOrphanedOutbound();
    await this.pullOutbox();
  }

  private onMessage(messageId: string, data: string): void {
    if (!this.running) return;
    if (this.inbox.length >= INBOX_LIMIT) {
      this.log(
        `Managed DingTalk inbox is full; message ${messageId} is dropped.`,
      );
      return;
    }
    this.inbox.push({ messageId, data });
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.running) {
        try {
          await this.tick();
        } catch (error) {
          this.log(`Managed DingTalk tick failed: ${String(error)}`);
        }
        if (this.running)
          await delay(this.settings.pollInterval, undefined, {
            signal: this.abort!.signal,
          }).catch(() => {});
      }
    } finally {
      this.stop();
    }
  }

  private async drainInbox(): Promise<void> {
    const state = this.state;
    if (!state) return;
    while (this.running && this.inbox.length > 0) {
      if (
        state.pending.length >= MANAGED_DINGTALK_PENDING_LIMIT ||
        this.instanceStalled
      )
        return;
      const item = this.inbox.shift()!;
      await this.admit(item);
      if (this.registeredGeneration === 0 || this.instanceStalled) return;
    }
  }

  private senderAllowed(sender: string): boolean {
    switch (this.policy.senderPolicy) {
      case 'disabled':
        return false;
      case 'open':
        return true;
      default:
        return this.policy.allowedSenders.includes(sender);
    }
  }

  private async admit(item: InboxItem): Promise<void> {
    const state = this.state!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(item.data) as Record<string, unknown>;
    } catch {
      this.log(
        `Managed DingTalk message ${item.messageId} is not JSON; skipped.`,
      );
      return;
    }
    const conversationId = str(parsed['conversationId']);
    const sessionWebhook = str(parsed['sessionWebhook']);
    const senderId =
      str(parsed['senderStaffId']) ?? str(parsed['senderId']) ?? '';
    const msgId = str(parsed['msgId']) ?? item.messageId;
    const text = extractText(parsed);
    // Remember the newest webhook for the conversation before anything else:
    // the reply may arrive after this webhook's own message is long gone.
    if (conversationId && sessionWebhook) {
      state.webhooks[conversationId] = sessionWebhook;
      const keys = Object.keys(state.webhooks);
      if (keys.length > 256) delete state.webhooks[keys[0]!];
      this.persist();
    }
    const eventId = `dingtalk:${msgId}`;
    const skip = () => {
      state.recent = [...state.recent, eventId].slice(-256);
      this.persist();
    };
    if (!conversationId || !senderId || !text) {
      skip();
      return;
    }
    if (state.recent.includes(eventId)) {
      return;
    }
    if (!this.senderAllowed(senderId)) {
      this.log(
        `Managed DingTalk sender ${senderId} is not allowed; message skipped.`,
      );
      skip();
      return;
    }
    const event: ManagedInboundEvent = {
      accountGeneration: state.generation,
      platformEventId: eventId,
      semanticRevision: 1,
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: conversationId,
        threadId: conversationId,
      },
      senderId,
      chatId: conversationId,
      threadId: conversationId,
      subject: null,
      text,
      attachments: [],
      replyContext: {
        conversationId,
        sessionWebhook: sessionWebhook ?? '',
        senderId,
        robotCode: this.settings.clientId,
      } satisfies DingtalkReplyContext,
    };
    state.pending = [...state.pending, { eventId, event }].slice(
      -MANAGED_DINGTALK_PENDING_LIMIT,
    );
    this.persist();
    await this.submit(eventId, event);
  }

  private async submit(
    eventId: string,
    event: ManagedInboundEvent,
  ): Promise<void> {
    const state = this.state!;
    try {
      const admitted = await this.controlPlane.submitInbound(event);
      const wasHeld = state.pending.some(
        (entry) => entry.eventId === eventId && entry.held === true,
      );
      state.pending = state.pending.filter(
        (entry) => entry.eventId !== eventId,
      );
      state.recent = [...state.recent, eventId].slice(-256);
      if (!admitted.replayed && wasHeld) {
        state.instanceRefusals = 0;
        this.instanceStalled = false;
      }
      this.persist();
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      if (this.isRegistrationRefusal(error)) {
        this.registeredGeneration = 0;
        return;
      }
      if (
        typeof status === 'number' &&
        (status === 400 ||
          status === 403 ||
          status === 409 ||
          (status === 404 && INSTANCE_SCOPED_REFUSALS.has(String(code))))
      ) {
        if (INSTANCE_SCOPED_REFUSALS.has(String(code))) {
          state.instanceRefusals = (state.instanceRefusals ?? 0) + 1;
          const entry = state.pending.find((p) => p.eventId === eventId);
          if (
            entry?.held ||
            state.instanceRefusals > INSTANCE_REFUSAL_DROP_LIMIT
          ) {
            if (!entry?.held) {
              state.pending = state.pending.map((p) =>
                p.eventId === eventId ? { ...p, held: true } : p,
              );
              this.persist();
            }
            this.instanceStalled = true;
            this.log(
              `Managed DingTalk stopped admitting: every message is refused with ${status} ${String(code)}; check the instance's --workspace and --actor flags.`,
            );
            return;
          }
        }
        this.log(
          `Managed DingTalk admission of ${eventId} was refused (${status}); the message is skipped.`,
        );
        state.pending = state.pending.filter((p) => p.eventId !== eventId);
        state.recent = [...state.recent, eventId].slice(-256);
        this.persist();
        return;
      }
      // A lost answer or a transient refusal: the claim, with its persisted
      // event, stays in pending so the next tick re-drives the identical
      // event, never a rebuilt one.
    }
  }

  private async resubmitPending(): Promise<void> {
    const state = this.state;
    if (!state) return;
    for (const entry of [...state.pending]) {
      if (!this.running) return;
      await this.submit(entry.eventId, entry.event);
      if (this.registeredGeneration === 0 || this.instanceStalled) return;
    }
  }

  private isRegistrationRefusal(error: unknown): boolean {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return status === 404 && String(code) === CHANNEL_NOT_FOUND;
  }

  private async ensureRegistered(state: ManagedDingtalkState): Promise<void> {
    if (this.registeredGeneration === state.generation) return;
    try {
      await this.controlPlane.register({
        platform: 'dingtalk',
        accountId: this.settings.clientId,
        accountGeneration: state.generation,
        policy: this.policy,
      });
      this.registeredGeneration = state.generation;
    } catch (error) {
      this.registeredGeneration = 0;
      throw error;
    }
  }

  private async pullOutbox(): Promise<void> {
    let claimed: ManagedClaimedDelivery[];
    try {
      claimed = await this.controlPlane.claimDeliveries(CLAIM_BATCH);
    } catch (error) {
      if (this.isRegistrationRefusal(error)) {
        this.registeredGeneration = 0;
        return;
      }
      throw error;
    }
    for (const delivery of claimed) {
      if (!this.running) return;
      await this.send(delivery);
    }
  }

  private async send(delivery: ManagedClaimedDelivery): Promise<void> {
    const state = this.state!;
    const context =
      delivery.replyContext as Partial<DingtalkReplyContext> | null;
    const conversationId = context?.conversationId;
    const webhook =
      (conversationId ? state.webhooks[conversationId] : undefined) ??
      context?.sessionWebhook;
    if (
      !conversationId ||
      !webhook ||
      !this.senderAllowed(context?.senderId ?? '')
    ) {
      await this.controlPlane.receipt(delivery.deliveryId, {
        outcome: 'rejected',
      });
      return;
    }
    for (const segment of delivery.segments) {
      if (!this.running) return;
      const messageId = randomUUID();
      state.outbound = [
        ...state.outbound,
        {
          deliveryId: delivery.deliveryId,
          ordinal: segment.ordinal,
          messageId,
        },
      ].slice(-64);
      this.persist();
      let outcome: ManagedReceipt;
      try {
        await this.deps.sendWebhook(webhook, segment.text);
        outcome = {
          outcome: 'accepted',
          ordinal: segment.ordinal,
          providerMessageId: messageId,
          acceptedAt: (this.deps.now ?? Date.now)(),
        };
      } catch (error) {
        outcome = (error as DingtalkWebhookFailure).definitive
          ? { outcome: 'rejected' }
          : { outcome: 'unknown' };
      }
      const entry = state.outbound.find(
        (candidate) =>
          candidate.deliveryId === delivery.deliveryId &&
          candidate.ordinal === segment.ordinal,
      );
      if (entry) entry.receipt = outcome;
      this.persist();
      try {
        await this.controlPlane.receipt(delivery.deliveryId, outcome);
      } catch (error) {
        // One delivery's unreportable receipt never aborts the claimed
        // batch: the entry stays outbound with the outcome persisted, so
        // every later tick re-drives exactly this receipt — never the
        // webhook send. Its remaining segments wait behind the settled
        // one, the same ordering the !accepted arm already owns.
        this.log(
          `Managed DingTalk receipt for ${delivery.deliveryId} could not be reported (${String(error)}); it re-drives on the next tick.`,
        );
        return;
      }
      state.outbound = state.outbound.filter(
        (candidate) =>
          !(
            candidate.deliveryId === delivery.deliveryId &&
            candidate.ordinal === segment.ordinal
          ),
      );
      this.persist();
      if (outcome.outcome !== 'accepted') return;
    }
  }

  private async reportOrphanedOutbound(): Promise<void> {
    const state = this.state;
    if (!state) return;
    for (const entry of [...state.outbound]) {
      if (!this.running) return;
      // A segment whose send produced a persisted receipt replays that
      // receipt — the control plane may already hold it (its answer was
      // lost) and settles idempotently. Only a segment whose send never
      // produced an outcome settles unknown.
      try {
        await this.controlPlane.receipt(
          entry.deliveryId,
          entry.receipt ?? { outcome: 'unknown' },
        );
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const code = (error as { code?: unknown }).code;
        // The instance row is gone — keep the entry and reset the
        // generation: the next tick re-registers first, then the re-driven
        // receipt settles or meets the deterministic drop below.
        if (this.isRegistrationRefusal(error)) {
          this.registeredGeneration = 0;
          this.log(
            `Managed DingTalk receipt for ${entry.deliveryId} was refused as not registered (${String(status)} ${String(code)}); it re-drives after the next tick re-registers.`,
          );
          return;
        }
        // A deterministic refusal never converges on re-drive, and a held
        // entry runs before every outbox pull: it would stall every later
        // delivery. Drop it visibly; the lease reconciler records the
        // delivery unknown.
        if (
          !(
            status === 400 ||
            status === 403 ||
            status === 409 ||
            (status === 404 && code === 'delivery_not_found')
          )
        ) {
          throw error;
        }
        this.log(
          `Managed DingTalk receipt for ${entry.deliveryId} was refused (${String(status)}); it is dropped.`,
        );
      }
      state.outbound = state.outbound.filter(
        (candidate) => candidate !== entry,
      );
      this.persist();
    }
  }

  private persist(): void {
    if (this.state) this.store.save(this.state);
  }

  private stop(): void {
    this.running = false;
    this.abort?.abort();
    try {
      this.stream?.disconnect();
    } catch {
      // The stream may already be closed; stopping is best-effort.
    }
  }

  private async release(): Promise<void> {
    const releaseLock = this.releaseLock;
    this.releaseLock = undefined;
    if (releaseLock) await releaseLock().catch(() => undefined);
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractText(parsed: Record<string, unknown>): string | undefined {
  const msgtype = str(parsed['msgtype']);
  if (msgtype && msgtype !== 'text') return undefined;
  const text = parsed['text'];
  if (text && typeof text === 'object') {
    const content = (text as Record<string, unknown>)['content'];
    if (typeof content === 'string' && content.trim()) return content.trim();
  }
  return undefined;
}
