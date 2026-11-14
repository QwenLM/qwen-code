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
    onMessage: (messageId: string, data: string) => boolean,
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
// The wire's text bound (the control plane's Jakarta @Size) and the Harness
// envelope's byte line, mirrored locally to keep this package free of core
// imports; the overhead allowance covers the event's JSON metadata around the
// text. Both match the email reference adapter's clamp.
const MAX_WIRE_TEXT_CHARS = 32_000;
const ENVELOPE_BYTE_LIMIT = 64 * 1024;
const TEXT_ENVELOPE_OVERHEAD_BYTES = 4096;

interface InboxItem {
  messageId: string;
  data: string;
}

export function dingtalkSettings(
  config: Readonly<Record<string, unknown>>,
): DingtalkSettings {
  const clientId = config['clientId'];
  const clientSecret = config['clientSecret'];
  if (!validCredential(clientId))
    throw new Error('DingTalk channel requires a clientId.');
  if (!validCredential(clientSecret))
    throw new Error('DingTalk channel requires a clientSecret.');
  const pollInterval = Number(config['pollInterval'] ?? 2_000);
  return {
    clientId: (clientId as string).trim(),
    clientSecret: (clientSecret as string).trim(),
    pollInterval:
      Number.isSafeInteger(pollInterval) &&
      pollInterval >= 250 &&
      pollInterval <= 2_147_483_647
        ? pollInterval
        : 2_000,
  };
}

// Mirror the email credential rule: a copy-paste trailing newline or an
// embedded CR/LF/NUL must be rejected, not passed through to the token
// exchange where it surfaces as an auth error pointing at the credential.
function validCredential(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !/[\r\n\0]/.test(value);
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
    if (senderPolicy === 'pairing') {
      // The managed policy shape has no pairing arm; silently coercing it to
      // an empty allowlist would skip every message while reporting running.
      throw new Error(
        'The managed DingTalk path does not support privatePolicy "pairing"; use allowedUsers, open, or disabled.',
      );
    }
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
      // Frames acked between stream.connect() and a failed registration are
      // already durable on the provider side; persist them as claims so a
      // restart re-drives them instead of losing them.
      await this.drainInboxOnShutdown().catch(() => undefined);
      await this.release();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.loop;
    try {
      await this.drainInboxOnShutdown();
    } finally {
      await this.controlPlane.disconnect().catch(() => undefined);
      await this.release();
    }
  }

  // The stream acked these messages and will never redeliver them; persist them
  // as claims before releasing the lock so a graceful restart re-drives them
  // instead of losing them. They are not submitted here — the next process owns
  // the admission. Bound the drain by the pending cap so it never evicts an
  // already-persisted claim (the provider acked that one too and will not
  // redeliver it).
  private async drainInboxOnShutdown(): Promise<void> {
    const state = this.state;
    if (!state) return;
    while (
      this.inbox.length > 0 &&
      state.pending.length < MANAGED_DINGTALK_PENDING_LIMIT
    ) {
      const item = this.inbox[0]!;
      await this.admit(item, false);
      this.inbox.shift();
    }
    if (this.inbox.length > 0) {
      this.log(
        `Managed DingTalk could not persist ${this.inbox.length} acked message(s): the pending claim table is full.`,
      );
      this.inbox.length = 0;
    }
  }

  /** One admission drain and one outbound pull, for callers that drive it. */
  async tick(): Promise<void> {
    await this.ensureRegistered(this.state!);
    await this.resubmitPending();
    await this.drainInbox();
    await this.reportOrphanedOutbound();
    await this.pullOutbox();
  }

  // Returns whether the frame was queued. Acceptance is the commit point: the
  // caller acks SUCCESS only on true, so an overflow leaves the frame unacked
  // and the provider's own redelivery is the backstop instead of a silent drop.
  // Acceptance must mean "a durable claim will be persisted", not merely inbox
  // room. While the claim table is full there is no slot, so a frame acked here
  // would live only in memory and be lost on a hard restart. While admission is
  // stalled a new frame is left unacked for provider redelivery rather than
  // parked as a claim waiting on the operator; drainInbox makes the pre-stall
  // backlog durable. Couple the gate to both conditions.
  private onMessage(messageId: string, data: string): boolean {
    if (!this.running) return false;
    if (
      this.instanceStalled ||
      this.inbox.length >= INBOX_LIMIT ||
      (this.state?.pending.length ?? 0) + this.inbox.length >=
        MANAGED_DINGTALK_PENDING_LIMIT
    ) {
      this.log(
        `Managed DingTalk has no durable claim slot; message ${messageId} is left unacked for redelivery.`,
      );
      return false;
    }
    this.inbox.push({ messageId, data });
    return true;
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
      if (state.pending.length >= MANAGED_DINGTALK_PENDING_LIMIT) return;
      // Peek, then shift only after the claim is durable: a failed store.save()
      // must leave the frame in the inbox for the next tick, not drop it.
      const item = this.inbox[0]!;
      // A frame acked before the stall armed must still become durable: persist
      // its claim without submitting while admission is stalled, so a hard
      // restart re-drives it instead of losing it. The gate refuses new frames
      // during the stall, so this only ever drains the pre-stall backlog; the
      // stall-lift re-drives pending and the backlog flows once the binding
      // answers again.
      await this.admit(item, !this.instanceStalled);
      this.inbox.shift();
      if (this.registeredGeneration === 0) return;
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

  private async admit(item: InboxItem, driveSubmit = true): Promise<void> {
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
    const conversationType = str(parsed['conversationType']);
    const rawText = extractText(parsed);
    const text = rawText ? fitInboundText(rawText) : rawText;
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
    // The managed path serves private chats under the private-chat policy.
    // A group frame would be answered into the group webhook for every member
    // to read, so drop it until an explicit group policy exists (Legacy's
    // GroupGate defaults to disabled for the same reason).
    if (conversationType === '2') {
      this.log(
        `Managed DingTalk group message ${item.messageId} is skipped; the managed path serves private chats only.`,
      );
      skip();
      return;
    }
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
    if (driveSubmit) await this.submit(eventId, event);
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
      } else {
        this.liftStallWhenNothingHeld();
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
            // Log only on the transition: a stalled adapter re-probes the held
            // claim every tick, and re-emitting the line would drown the log.
            if (!this.instanceStalled) {
              this.instanceStalled = true;
              this.log(
                `Managed DingTalk stopped admitting: every message is refused with ${status} ${String(code)}; check the instance's --workspace and --actor flags.`,
              );
            }
            return;
          }
        }
        this.log(
          `Managed DingTalk admission of ${eventId} was refused (${status}); the message is skipped.`,
        );
        state.pending = state.pending.filter((p) => p.eventId !== eventId);
        state.recent = [...state.recent, eventId].slice(-256);
        this.liftStallWhenNothingHeld();
        this.persist();
        return;
      }
      // A lost answer or a transient refusal: the claim, with its persisted
      // event, stays in pending so the next tick re-drives the identical
      // event, never a rebuilt one.
    }
  }

  /**
   * The stall exists to be lifted by the held claim's probe: when the last
   * held claim leaves without proving the binding — dropped on a per-message
   * verdict or settled by a replayed answer — no probe remains, and a flag
   * kept armed would gate every later tick. The refusal streak is NOT reset
   * here: only the held claim's fresh admission proves the binding, so the
   * next instance-scoped refusal re-holds without a new first-occurrence drop.
   */
  private liftStallWhenNothingHeld(): void {
    if (
      this.instanceStalled &&
      !this.state!.pending.some((entry) => entry.held === true)
    ) {
      this.instanceStalled = false;
      this.log(
        'Managed DingTalk admission resumed; no claim remains held, and the refusal streak still stands for the next instance-scoped refusal.',
      );
    }
  }

  private async resubmitPending(): Promise<void> {
    const state = this.state;
    if (!state) return;
    // Probe held claims first: the stall lifts only on a held claim's fresh
    // admission, and push order lets an earlier claim whose answer never
    // comes shadow the one probe per tick — wedging admission across
    // restarts. The sort is stable: unheld claims keep their push order.
    const ordered = [...state.pending].sort(
      (a, b) => Number(b.held === true) - Number(a.held === true),
    );
    for (const entry of ordered) {
      if (!this.running) return;
      if (!this.senderAllowed(entry.event.senderId)) {
        // The policy moved on since the claim: the persisted event drops
        // visibly rather than drive a Session the current policy forbids.
        this.log(
          `Managed DingTalk event ${entry.eventId} is refused by the current sender policy; its claim drops.`,
        );
        state.pending = state.pending.filter(
          (p) => p.eventId !== entry.eventId,
        );
        this.liftStallWhenNothingHeld();
        this.persist();
        continue;
      }
      await this.submit(entry.eventId, entry.event);
      if (this.registeredGeneration === 0 || this.instanceStalled) return;
    }
  }

  private isRegistrationRefusal(error: unknown): boolean {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return (
      (status === 404 && String(code) === CHANNEL_NOT_FOUND) ||
      (status === 409 &&
        (code === 'channel_generation_unregistered' ||
          code === 'channel_disconnected'))
    );
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
      // One delivery's unreportable rejection receipt must never abort the
      // claimed batch: the deliveries behind it were already moved to sending
      // server-side and would settle unknown (lost) if the tick escaped here.
      // The rejection itself stays unreported — the control plane's lease
      // reconciliation settles that one delivery — while the rest of the batch
      // still sends.
      try {
        await this.controlPlane.receipt(delivery.deliveryId, {
          outcome: 'rejected',
        });
      } catch (error) {
        if (this.isRegistrationRefusal(error)) {
          this.registeredGeneration = 0;
          return;
        }
        this.log(
          `Managed DingTalk rejection receipt for ${delivery.deliveryId} could not be reported (${String(error)}); the rest of the batch still sends.`,
        );
      }
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

/**
 * The wire admits at most MAX_WIRE_TEXT_CHARS characters and the Harness
 * envelope at most ENVELOPE_BYTE_LIMIT bytes of event JSON. Clamp to both so
 * an over-long message is admitted truncated instead of meeting a
 * deterministic 400 and being dropped whole — the same choice the email
 * reference makes. A CJK message can sit under the character line yet
 * overflow the byte envelope, so the byte cut lands on a code-point boundary.
 */
function fitInboundText(text: string): string {
  // The cap counts UTF-16 units (the server's maxTextChars does too), so a
  // code-point cap could overshoot it; but a UTF-16 slice can land inside a
  // surrogate pair, so back off a trailing high surrogate to keep the text
  // well-formed.
  let bounded = text.slice(0, MAX_WIRE_TEXT_CHARS);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  const byteLimit = ENVELOPE_BYTE_LIMIT - TEXT_ENVELOPE_OVERHEAD_BYTES;
  // The bound is enforced on the JSON-serialized envelope, where a control
  // character costs six bytes and a quote/backslash two — not on the raw UTF-8
  // length. Budget the escaped length and cut by code points until it fits, so
  // escape-heavy text is admitted truncated instead of refused whole.
  const encodedBytes = (s: string): number =>
    Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;
  if (encodedBytes(bounded) <= byteLimit) return bounded;
  const chars = Array.from(bounded);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodedBytes(chars.slice(0, mid).join('')) <= byteLimit) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('');
}
