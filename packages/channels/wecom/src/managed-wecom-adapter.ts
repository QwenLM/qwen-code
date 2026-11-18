/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MANAGED_OUTBOUND_LIMIT,
  resolvePrivatePolicy,
} from '@qwen-code/channel-base';
import type {
  ManagedChannelPolicy,
  ManagedInboundEvent,
  ManagedClaimedDelivery,
  ManagedChannelControlPlane,
} from '@qwen-code/channel-base';
import {
  MANAGED_WECOM_PENDING_LIMIT,
  ManagedWecomStateStore,
  RECENT_LIMIT,
} from './managed-state.js';
import type { ManagedWecomState, ManagedReceipt } from './managed-state.js';

export type { ManagedReceipt } from './managed-state.js';

// The managed WeCom adapter, mirroring the DingTalk reference discipline: it
// never drives a model — an inbound bot message becomes one platform event
// the control plane admits (route binding + input + wake in the Session
// journal), and a reply comes back through the receipted outbox the adapter
// pulls. Every claim persists before its side effect, so a restart replays
// the same event or reports the same segment as unknown — never a second
// input, never a second send. Two provider mechanics diverge from DingTalk:
// the SDK pushes each message once with no ack and no redelivery (a frame
// that cannot be durably staged is lost and logged as lost), and a reply
// travels over the live authenticated WebSocket keyed only by chatid (no
// session webhook to cache, snapshot or evict). See
// docs/design/2026-11-16-managed-channel-wecom-adapter.md.

/** What a reply needs, committed with the input and echoed by the outbox. */
export interface WecomReplyContext {
  chatId: string;
  senderId: string;
  botId: string;
}

export interface WecomSettings {
  botId: string;
  secret: string;
  wsUrl?: string;
  pollInterval: number;
  /**
   * True when a configured pollInterval was rejected and the default used.
   * Reported by wecomSettings itself so the constructor's diagnostic never
   * re-derives the clamp decision.
   */
  pollIntervalRewritten?: boolean;
}

/** A connected stream the adapter reads bot messages from. */
export interface ManagedWecomStreamClient {
  connect(): Promise<void>;
  disconnect(): void;
}

export interface ManagedWecomAdapterDeps {
  readonly createStreamClient: (
    settings: WecomSettings,
    onMessage: (messageId: string, data: string) => void,
    onStopped: (reason: string) => void,
  ) => ManagedWecomStreamClient;
  readonly sendMessage: (chatId: string, text: string) => Promise<void>;
  readonly lock: (
    directory: string,
    onCompromised: () => void,
  ) => Promise<() => Promise<void>>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface ManagedWecomAdapterOptions {
  readonly name: string;
  readonly cwd: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly controlPlane: ManagedChannelControlPlane;
  readonly deps: ManagedWecomAdapterDeps;
  /** Off, the caller drives `tick()` itself (tests); on by default. */
  readonly pollLoop?: boolean;
}

const CLAIM_BATCH = 16;
const DEFAULT_POLL_INTERVAL = 2_000;
// Shared by the clamp and the operator-facing diagnostic so a bound change
// cannot leave the message stating a range the code no longer enforces.
const MIN_POLL_INTERVAL = 250;
const MAX_POLL_INTERVAL = 2_147_483_647;
const INSTANCE_SCOPED_REFUSALS = new Set([
  'workspace_not_found',
  'workspace_forbidden',
  'actor_scope_mismatch',
  'workspace_unavailable',
]);
const INSTANCE_REFUSAL_DROP_LIMIT = 1;
const CHANNEL_NOT_FOUND = 'channel_not_found';
// The wire's text bound (the control plane's Jakarta @Size) and the Harness
// envelope's byte line, mirrored locally to keep this package free of core
// imports; the overhead allowance covers the event's JSON metadata around the
// text. Both match the DingTalk reference adapter's clamp.
const MAX_WIRE_TEXT_CHARS = 32_000;
const ENVELOPE_BYTE_LIMIT = 64 * 1024;
const TEXT_ENVELOPE_OVERHEAD_BYTES = 4096;

export function wecomSettings(
  config: Readonly<Record<string, unknown>>,
): WecomSettings {
  const botId = config['botId'];
  const secret = config['secret'];
  if (!validCredential(botId))
    throw new Error('WeCom channel requires a botId.');
  if (!validCredential(secret))
    throw new Error('WeCom channel requires a secret.');
  const rawWsUrl = config['wsUrl'];
  let wsUrl: string | undefined;
  // A blank or null optional wsUrl is absent, like the Legacy parser and the
  // sibling pollInterval key — not a refusal of the whole channel. A real
  // value still must be a wss:// URL, and a non-string is refused.
  if (rawWsUrl !== undefined && rawWsUrl !== null) {
    if (typeof rawWsUrl !== 'string')
      throw new Error('WeCom channel requires wsUrl to use wss://.');
    const trimmed = rawWsUrl.trim();
    if (trimmed) {
      if (!isSecureWebSocketUrl(trimmed))
        throw new Error('WeCom channel requires wsUrl to use wss://.');
      wsUrl = trimmed;
    }
  }
  const rawInterval = config['pollInterval'];
  const pollInterval = Number(rawInterval ?? DEFAULT_POLL_INTERVAL);
  const intervalAccepted =
    Number.isSafeInteger(pollInterval) &&
    pollInterval >= MIN_POLL_INTERVAL &&
    pollInterval <= MAX_POLL_INTERVAL;
  return {
    botId: (botId as string).trim(),
    secret: (secret as string).trim(),
    ...(wsUrl ? { wsUrl } : {}),
    pollInterval: intervalAccepted ? pollInterval : DEFAULT_POLL_INTERVAL,
    pollIntervalRewritten: rawInterval !== undefined && !intervalAccepted,
  };
}

// Mirror the email credential rule: a copy-paste trailing newline or an
// embedded CR/LF/NUL must be rejected, not passed through to the SDK auth
// frame where it surfaces as an auth error pointing at the credential.
function validCredential(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !/[\r\n\0]/.test(value);
}

function isSecureWebSocketUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'wss:';
  } catch {
    return false;
  }
}

export class ManagedWecomAdapter {
  readonly settings: WecomSettings;
  readonly policy: ManagedChannelPolicy;
  private readonly store: ManagedWecomStateStore;
  private readonly controlPlane: ManagedChannelControlPlane;
  private readonly deps: ManagedWecomAdapterDeps;
  private readonly log: (line: string) => void;
  private readonly pollLoop: boolean;
  private state?: ManagedWecomState;
  private stream?: ManagedWecomStreamClient;
  private releaseLock?: () => Promise<void>;
  private running = false;
  private ownershipLost = false;
  private displaced = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private registeredGeneration?: number;
  private instanceStalled = false;
  private loggedNoClaimSlot = false;
  private lastDropCause?: string;
  private loggedAcceptFailure = false;
  private loggedRegistrationFailure = false;

  constructor(options: ManagedWecomAdapterOptions) {
    this.settings = wecomSettings(options.config);
    const senderPolicy = resolvePrivatePolicy(options.config);
    if (senderPolicy === 'pairing') {
      // The managed policy shape has no pairing arm; silently coercing it to
      // an empty allowlist would skip every message while reporting running.
      throw new Error(
        'The managed WeCom path does not support privatePolicy "pairing"; use allowedUsers, open, or disabled.',
      );
    }
    const allowed = options.config['allowedUsers'];
    this.policy = {
      adapter: 'wecom',
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
    this.store = new ManagedWecomStateStore(
      options.name,
      options.cwd,
      this.settings.botId,
    );
    this.controlPlane = options.controlPlane;
    this.deps = options.deps;
    this.log =
      options.deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    // The clamp in wecomSettings is silent; say so when it reports a rewrite,
    // or an operator tuning the poll rate sees no effect and no explanation.
    // The decision and the bounds come from the settings clamp itself, never
    // re-derived here.
    if (this.settings.pollIntervalRewritten) {
      this.log(
        `Managed WeCom pollInterval ${String(options.config['pollInterval'])} is not an integer in [${MIN_POLL_INTERVAL}, ${MAX_POLL_INTERVAL}]; using ${this.settings.pollInterval} ms.`,
      );
    }
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
      throw new Error('Managed WeCom adapter is already connected.');
    try {
      this.releaseLock = await this.deps.lock(this.store.directory, () => {
        // A reaped stale lock means a second owner won the state directory.
        // Stop, and stop persisting: an in-flight tick or the shutdown drain
        // must not rewrite the file the new owner now holds.
        this.ownershipLost = true;
        this.log(
          'Managed WeCom state ownership was lost to another process; adapter stopped.',
        );
        this.stop();
      });
    } catch {
      throw new Error(
        'WeCom state is owned by another process; managed adapter not started.',
      );
    }
    try {
      this.state = this.store.load() ?? {
        version: 1,
        generation: 1,
        pending: [],
        outbound: [],
        recent: [],
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
      this.displaced = false;
      this.loggedNoClaimSlot = false;
      this.lastDropCause = undefined;
      this.loggedAcceptFailure = false;
      this.loggedRegistrationFailure = false;
      this.registeredGeneration = undefined;
      this.stream = this.deps.createStreamClient(
        this.settings,
        (messageId, data) => this.onMessage(messageId, data),
        (reason) => {
          // A server kick displaced this connection; reconnecting would
          // displace the new owner in turn. Stop instead of reporting a
          // healthy start that is permanently deaf.
          this.log(`Managed WeCom stream stopped: ${reason}; adapter stopped.`);
          this.displaced = true;
          this.stop();
          // The kick displaced the WS connection, not the state-file lock
          // (still ours): release it now so a restart of this entry can
          // acquire it, instead of holding it until SIGTERM while this
          // process will never work again. Distinct from ownershipLost,
          // where the lock belongs to another process and is NOT released.
          void this.release();
        },
      );
      await this.stream.connect();
      if (!this.running)
        throw new Error('Managed WeCom adapter stopped during connection.');
      await this.ensureRegistered(this.state);
      // Orphan-receipt replay contains its own transient refusals (it keeps
      // the entry and lets the outbox pull run), so a stale row cannot keep a
      // healthy stream from starting nor wedge outbound after it.
      await this.reportOrphanedOutbound();
      // A lock compromise or a kick can land during the awaits above. Re-check
      // so connect() rejects rather than resolving a healthy-looking start for
      // a stopped, deaf adapter the CLI would then park on.
      if (!this.running || this.ownershipLost)
        throw new Error('Managed WeCom adapter stopped during connection.');
      if (this.pollLoop) this.loop = this.runLoop();
    } catch (error) {
      this.stop();
      // Frames staged between stream.connect() and a failed registration were
      // already persisted as claims by onMessage, so a restart re-drives them;
      // there is no in-memory inbox to drain.
      await this.release();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.loop;
    // Accepted frames are already durable claims (onMessage persists before
    // returning), so shutdown has no inbox to drain. Neither a displaced nor a
    // lock-compromised adapter still owns the shared channel row: disconnecting
    // it would deregister the new owner (the server's disconnect has no
    // generation guard), which then drops inbound frames WeCom never
    // redelivers. Skip the row disconnect on both "no longer the owner" paths.
    // The lock difference stays: a kick released our lock above, but on
    // compromise the lock belongs to another process and release() is a no-op.
    if (!this.displaced && !this.ownershipLost) {
      await this.controlPlane.disconnect().catch(() => undefined);
    }
    await this.release();
  }

  /** One admission re-drive and one outbound pull, for callers that drive it. */
  async tick(): Promise<void> {
    await this.ensureRegistered(this.state!);
    await this.resubmitPending();
    await this.reportOrphanedOutbound();
    await this.pullOutbox();
  }

  // The SDK pushes each frame once and never redelivers it, so there is no
  // ack to withhold: acceptance is the durable staging itself. A full claim
  // table or a stall leaves the frame dropped (logged, latched); a store.save()
  // failure also drops it — unlike DingTalk's LATER arm, there is no provider
  // redelivery to leave it for, and the loss must be visible instead of silent.
  private onMessage(messageId: string, data: string): void {
    if (!this.running || this.ownershipLost) return;
    const tableFull =
      (this.state?.pending.length ?? 0) >= MANAGED_WECOM_PENDING_LIMIT;
    if (this.instanceStalled || this.registeredGeneration === 0 || tableFull) {
      // Name the actual cause: a stall or a registration outage drops frames
      // with slots free, so a claim-slot line would blame the wrong thing.
      // Latched per cause transition: one outage yields one line, and a cause
      // change mid-outage is still announced. The next accepted frame re-arms.
      const cause = this.instanceStalled
        ? 'admission is stalled (instance-scoped refusal)'
        : this.registeredGeneration === 0
          ? 'the channel is re-registering'
          : 'no durable claim slot';
      if (!this.loggedNoClaimSlot || this.lastDropCause !== cause) {
        this.loggedNoClaimSlot = true;
        this.lastDropCause = cause;
        this.log(
          `Managed WeCom dropped message ${messageId}: ${cause} (the provider does not redeliver).`,
        );
      }
      return;
    }
    try {
      // Only a staged claim is an acceptance: a skipped frame also returns
      // normally, and must not re-arm the outage latches.
      if (this.stageInbound({ messageId, data })) {
        this.loggedNoClaimSlot = false;
        this.lastDropCause = undefined;
        this.loggedAcceptFailure = false;
      }
    } catch (error) {
      // A failed save loses the frame: the provider never redelivers it. Say
      // why, or a disk outage reads as silent message loss. Latched like the
      // no-slot line: a persistent store failure drops every frame, and a
      // line per frame would drown the log.
      if (!this.loggedAcceptFailure) {
        this.loggedAcceptFailure = true;
        this.log(
          `Managed WeCom could not durably accept message ${messageId}: ${String(error)}; it is lost (the provider does not redeliver).`,
        );
      }
    }
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.running) {
        try {
          await this.tick();
        } catch (error) {
          // A persistent registration failure rethrows every tick; latch it
          // like the other outage diagnostics so the most important failure
          // does not flood one raw line per poll interval.
          if (
            (error as { registrationFailure?: boolean }).registrationFailure
          ) {
            if (!this.loggedRegistrationFailure) {
              this.loggedRegistrationFailure = true;
              this.log(
                `Managed WeCom registration is failing (${String(error)}); inbound is dropped until it recovers.`,
              );
            }
          } else {
            this.log(`Managed WeCom tick failed: ${String(error)}`);
          }
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

  // Synchronously stage the frame as a durable claim. The SDK event handler
  // calls this before returning, so the claim is on disk before the frame is
  // gone for good — the provider never redelivers it. The async submit() is
  // left to the tick (resubmitPending). A store.save() failure throws and
  // onMessage logs the loss. Returns whether a claim was staged: a skipped
  // frame is not an acceptance.
  private stageInbound(item: { messageId: string; data: string }): boolean {
    const state = this.state!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(item.data) as Record<string, unknown>;
    } catch {
      this.log(`Managed WeCom message ${item.messageId} is not JSON; skipped.`);
      return false;
    }
    // `null`, arrays and primitives parse successfully but are not frames;
    // reject them here so indexing below cannot throw into onMessage's catch
    // and poison the durable-store loss latch with a malformed-frame error.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.log(
        `Managed WeCom message ${item.messageId} is not a JSON object; skipped.`,
      );
      return false;
    }
    const senderId = str(getRecord(parsed, 'from')?.['userid']) ?? '';
    // Single-chat frames may carry no chatid; the SDK's send contract and the
    // Legacy channel both address a single chat by the sender userid.
    const chatId = str(parsed['chatid']) ?? senderId;
    const chattype = str(parsed['chattype']);
    const rawText = extractText(parsed);
    const text = rawText ? fitInboundText(rawText) : rawText;
    const eventId = `wecom:${item.messageId}`;
    const skip = () => {
      state.recent = [...state.recent, eventId].slice(-RECENT_LIMIT);
      // A skipped frame was never a durable claim, so a store failure here
      // loses nothing — contain it separately so it cannot poison the
      // durable-loss latch (loggedAcceptFailure) reserved for real staging
      // failures, which would then silence a genuinely lost text frame.
      try {
        this.persist();
      } catch (error) {
        this.log(
          `Managed WeCom could not record skipped message ${eventId}: ${String(error)}; nothing was lost.`,
        );
      }
    };
    // The managed path serves private chats under the private-chat policy.
    // A group frame would be answered into the group for every member to
    // read, so drop it until an explicit group policy exists (the DingTalk
    // slice made the same decision).
    if (chattype === 'group') {
      this.log(
        `Managed WeCom group message ${item.messageId} is skipped; the managed path serves private chats only.`,
      );
      skip();
      return false;
    }
    if (!senderId || !chatId || !text) {
      // A non-text or unroutable frame is dropped; leave a line so the drop is
      // visible instead of silent. Name the actual cause: a non-text frame
      // carrying both ids is the common trigger and must not read as a
      // malformed frame. Only the messageId and the field/msgtype are logged —
      // never the text.
      const msgtype = str(parsed['msgtype']);
      const missing = [
        !senderId ? 'senderId' : undefined,
        !chatId ? 'chatId' : undefined,
        !text ? 'text' : undefined,
      ].filter((field): field is string => field !== undefined);
      const reason =
        missing.length === 1 &&
        missing[0] === 'text' &&
        msgtype &&
        msgtype !== 'text'
          ? `is not a text frame (msgtype ${msgtype})`
          : `is missing ${missing.join(', ')}`;
      this.log(`Managed WeCom message ${item.messageId} ${reason}; skipped.`);
      skip();
      return false;
    }
    if (!this.senderAllowed(senderId)) {
      this.log(
        `Managed WeCom sender ${senderId} is not allowed; message skipped.`,
      );
      skip();
      return false;
    }
    // Dedupe against both the settled window and the in-flight claims: a frame
    // redelivered by the SDK while its claim is still pending (its admission
    // answer was lost) must not be staged a second time before recent is
    // updated.
    if (
      state.recent.includes(eventId) ||
      state.pending.some((entry) => entry.eventId === eventId)
    ) {
      return false;
    }
    const event: ManagedInboundEvent = {
      accountGeneration: state.generation,
      platformEventId: eventId,
      semanticRevision: 1,
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId,
        threadId: chatId,
      },
      senderId,
      chatId,
      threadId: chatId,
      subject: null,
      text,
      attachments: [],
      replyContext: {
        chatId,
        senderId,
        botId: this.settings.botId,
      } satisfies WecomReplyContext,
    };
    const previousPending = state.pending;
    state.pending = [...state.pending, { eventId, event }].slice(
      -MANAGED_WECOM_PENDING_LIMIT,
    );
    try {
      this.persist();
    } catch (error) {
      // A failed save must not leave the claim in memory: the dedupe arm would
      // then drop a later copy of a claim the store never accepted. Roll back
      // so the loss is exactly one frame; onMessage logs it.
      state.pending = previousPending;
      throw error;
    }
    return true;
  }

  private async submit(
    eventId: string,
    event: ManagedInboundEvent,
  ): Promise<void> {
    const state = this.state!;
    let admitted: { inputId: string; sessionId: string; replayed: boolean };
    try {
      admitted = await this.controlPlane.submitInbound(event);
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
                `Managed WeCom stopped admitting: every message is refused with ${status} ${String(code)}; check the instance's --workspace and --actor flags.`,
              );
            }
            return;
          }
        }
        this.log(
          `Managed WeCom admission of ${eventId} was refused (${status}); the message is skipped.`,
        );
        state.pending = state.pending.filter((p) => p.eventId !== eventId);
        state.recent = [...state.recent, eventId].slice(-RECENT_LIMIT);
        this.liftStallWhenNothingHeld();
        this.persist();
        return;
      }
      // A lost answer or a transient refusal: the claim, with its persisted
      // event, stays in pending so the next tick re-drives the identical
      // event, never a rebuilt one.
      return;
    }
    // Success path — outside the control-plane classifier so a store failure
    // here is handled as a store failure, never swallowed as a transient
    // refusal that leaves memory settled while disk still holds the claim.
    const wasHeld = state.pending.some(
      (entry) => entry.eventId === eventId && entry.held === true,
    );
    state.pending = state.pending.filter((entry) => entry.eventId !== eventId);
    state.recent = [...state.recent, eventId].slice(-RECENT_LIMIT);
    if (!admitted.replayed && wasHeld) {
      state.instanceRefusals = 0;
    }
    // Lift (and log) the stall when the last held claim leaves — including a
    // fresh held admission, so recovery is visible, not silent.
    this.liftStallWhenNothingHeld();
    try {
      this.persist();
    } catch (error) {
      this.log(
        `Managed WeCom could not persist settled claim ${eventId}: ${String(error)}`,
      );
      throw error;
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
        'Managed WeCom admission resumed; no claim remains held, and the refusal streak still stands for the next instance-scoped refusal.',
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
          `Managed WeCom event ${entry.eventId} is refused by the current sender policy; its claim drops.`,
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

  private async ensureRegistered(state: ManagedWecomState): Promise<void> {
    if (this.registeredGeneration === state.generation) return;
    try {
      await this.controlPlane.register({
        platform: 'wecom',
        accountId: this.settings.botId,
        accountGeneration: state.generation,
        policy: this.policy,
      });
      this.registeredGeneration = state.generation;
      this.loggedRegistrationFailure = false;
    } catch (error) {
      this.registeredGeneration = 0;
      // Mark the failure so runLoop latches its diagnostic instead of logging
      // one raw line per poll interval for as long as registration is broken.
      if (error && typeof error === 'object') {
        (error as { registrationFailure?: boolean }).registrationFailure = true;
      }
      throw error;
    }
  }

  private async pullOutbox(): Promise<void> {
    // Guard before the claim, not in the per-delivery loop: the claim itself
    // moves up to CLAIM_BATCH deliveries to sending server-side, so a stop that
    // lands mid-tick must not claim a batch it would then abandon to settle
    // unknown. The DingTalk reference guards the phase the same way.
    if (!this.running || !this.state) return;
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
    const context = delivery.replyContext as Partial<WecomReplyContext> | null;
    const chatId = context?.chatId;
    if (!chatId || !this.senderAllowed(context?.senderId ?? '')) {
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
          `Managed WeCom rejection receipt for ${delivery.deliveryId} could not be reported (${String(error)}); the rest of the batch still sends.`,
        );
      }
      return;
    }
    for (const segment of delivery.segments) {
      if (!this.running) return;
      const messageId = randomUUID();
      const previousOutbound = state.outbound;
      state.outbound = [
        ...state.outbound,
        {
          deliveryId: delivery.deliveryId,
          ordinal: segment.ordinal,
          messageId,
        },
      ].slice(-MANAGED_OUTBOUND_LIMIT);
      try {
        this.persist();
      } catch (error) {
        // The ledger entry is the double-send guard: without it on disk, a
        // crash after the send would re-send on restart. Roll back and abandon
        // this delivery before the side effect; the lease reconciler settles
        // it unknown. The rest of the claimed batch is still attempted.
        state.outbound = previousOutbound;
        this.log(
          `Managed WeCom could not persist the outbound ledger for ${delivery.deliveryId}: ${String(error)}; the send is abandoned and the lease reconciler settles it.`,
        );
        return;
      }
      let outcome: ManagedReceipt;
      try {
        await this.deps.sendMessage(chatId, segment.text);
        outcome = {
          outcome: 'accepted',
          ordinal: segment.ordinal,
          providerMessageId: messageId,
          acceptedAt: (this.deps.now ?? Date.now)(),
        };
      } catch {
        // The aibot send path has no verified errcode retryability table, so
        // every send failure — socket failure, ack timeout, queue overflow or
        // a non-zero-errcode receipt frame — classifies as unknown: re-drivable,
        // never a claimed definitive refusal that could settle a rate-limited
        // segment's whole delivery rejected. A verified errcode table is a
        // follow-up (design decision 4).
        outcome = { outcome: 'unknown' };
      }
      const entry = state.outbound.find(
        (candidate) =>
          candidate.deliveryId === delivery.deliveryId &&
          candidate.ordinal === segment.ordinal,
      );
      if (entry) entry.receipt = outcome;
      try {
        this.persist();
      } catch (error) {
        // The send already happened: report the outcome to the control plane
        // even if the local write failed — the server-side settle is the
        // durable record, and the orphan re-drive replays the in-memory
        // receipt until the local write lands.
        this.log(
          `Managed WeCom could not persist the receipt for ${delivery.deliveryId}: ${String(error)}; it is still reported and re-driven locally.`,
        );
      }
      try {
        await this.controlPlane.receipt(delivery.deliveryId, outcome);
      } catch (error) {
        // One delivery's unreportable receipt never aborts the claimed
        // batch: the entry stays outbound with the outcome persisted, so
        // every later tick re-drives exactly this receipt — never the send.
        // Its remaining segments wait behind the settled one, the same
        // ordering the !accepted arm already owns.
        this.log(
          `Managed WeCom receipt for ${delivery.deliveryId} could not be reported (${String(error)}); it re-drives on the next tick.`,
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
      try {
        this.persist();
      } catch (error) {
        // The receipt is already reported; disk keeps the entry, so the next
        // tick's orphan re-drive replays the receipt and removes it again.
        this.log(
          `Managed WeCom could not persist the settled segment of ${delivery.deliveryId}: ${String(error)}; the orphan re-drive removes it on the next tick.`,
        );
      }
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
            `Managed WeCom receipt for ${entry.deliveryId} was refused as not registered (${String(status)} ${String(code)}); it re-drives after the next tick re-registers.`,
          );
          return;
        }
        // A transient (or status-less) refusal on ONE entry must not wedge
        // every later delivery: reportOrphanedOutbound runs before pullOutbox,
        // so rethrowing here would abort the tick before any reply is sent for
        // as long as the fault lasts. Contain it PER ENTRY — keep this entry
        // for re-drive and carry on to the next, so a fault scoped to one row
        // never starves the receipts behind it. (Unlike the registration arm's
        // `return`: while unregistered every later receipt would be refused
        // identically, so stopping there is right; a transient row fault is not.)
        if (
          !(
            status === 400 ||
            status === 403 ||
            status === 409 ||
            (status === 404 && code === 'delivery_not_found')
          )
        ) {
          this.log(
            `Managed WeCom receipt for ${entry.deliveryId} could not be reported (${String(error)}); it re-drives on the next tick.`,
          );
          continue;
        }
        // A deterministic refusal never converges on re-drive, and a held
        // entry runs before every outbox pull: it would stall every later
        // delivery. Drop it visibly; the lease reconciler records the
        // delivery unknown.
        this.log(
          `Managed WeCom receipt for ${entry.deliveryId} was refused (${String(status)}); it is dropped.`,
        );
      }
      state.outbound = state.outbound.filter(
        (candidate) => candidate !== entry,
      );
      try {
        this.persist();
      } catch (error) {
        // Disk keeps the entry; the next tick replays the same idempotent
        // receipt and retries the removal. Never abort the remaining orphans.
        this.log(
          `Managed WeCom could not persist the orphan removal of ${entry.deliveryId}: ${String(error)}; it re-drives on the next tick.`,
        );
      }
    }
  }

  private persist(): void {
    // Once the lock is compromised the state file belongs to another process;
    // never rewrite it, even from an in-flight tick's post-await persist. A
    // displaced adapter has likewise released its lock on the kick, so it must
    // not write either — a restart of the entry may already own the file.
    if (this.ownershipLost || this.displaced) return;
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

function getRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const entry = value[key];
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : undefined;
}

function extractText(parsed: Record<string, unknown>): string | undefined {
  const msgtype = str(parsed['msgtype']);
  if (msgtype && msgtype !== 'text') return undefined;
  const text = getRecord(parsed, 'text');
  const content = text ? str(text['content']) : undefined;
  return content;
}

/**
 * The wire admits at most MAX_WIRE_TEXT_CHARS characters and the Harness
 * envelope at most ENVELOPE_BYTE_LIMIT bytes of event JSON. Clamp to both so
 * an over-long message is admitted truncated instead of meeting a
 * deterministic 400 and being dropped whole — the same choice the DingTalk
 * reference makes (a local copy; lifting it into channel-base would touch the
 * published package and the DingTalk adapter for no behavior gain). A CJK
 * message can sit under the character line yet overflow the byte envelope, so
 * the byte cut lands on a code-point boundary.
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
