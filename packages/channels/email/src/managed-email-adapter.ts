import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ImapFlow } from 'imapflow';
import type { ParsedMail, simpleParser } from 'mailparser';
import type { Transporter } from 'nodemailer';
import { resolvePrivatePolicy } from '@qwen-code/channel-base';
import { addressList, emailSettings } from './config.js';
import type { EmailSettings } from './config.js';
import {
  acceptedHeaderSender,
  boundedText,
  noReplyAddress,
  replyRoute,
} from './message.js';
import {
  MANAGED_PENDING_LIMIT,
  ManagedEmailStateStore,
  digest,
} from './managed-state.js';
import type { ManagedEmailState, ManagedReceipt } from './managed-state.js';

export type { ManagedReceipt } from './managed-state.js';

// H5b/H5c of #12827: the email reference adapter on the managed path. It
// never drives a model: an inbound message becomes one platform event the
// control plane admits (route binding + input + wake in the Session
// journal), and a reply comes back through the receipted outbox the
// adapter pulls. Every claim persists before its side effect, so a
// restart replays the same event or reports the same segment as unknown —
// never a second input, never a second send. See
// docs/design/2026-10-07-managed-channel-runtime.md.

/** The route policy pinned with the first binding of each route. */
export interface ManagedChannelPolicy {
  adapter: 'email';
  senderPolicy: 'allowlist' | 'open' | 'disabled';
  allowedSenders: string[];
  dispatchMode: 'followup' | 'steer';
}

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
  replyContext: EmailReplyContext;
}

/** What a reply needs, committed with the input and echoed by the outbox. */
export interface EmailReplyContext {
  to: string;
  threadId: string;
  parent: string;
  references: string[];
  subject: string;
}

export interface ManagedClaimedDelivery {
  deliveryId: string;
  replyContext: unknown;
  segments: Array<{ ordinal: number; segmentId: string; text: string }>;
}

/** The trusted control-plane surface the adapter talks to. */
export interface ManagedChannelControlPlane {
  register(request: {
    platform: 'email';
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

export interface ManagedEmailAdapterDeps {
  readonly createImap: (settings: EmailSettings) => Promise<ImapFlow>;
  readonly createSmtp: (settings: EmailSettings) => Promise<Transporter>;
  readonly parse: () => Promise<typeof simpleParser>;
  readonly lock: (
    directory: string,
    onCompromised: () => void,
  ) => Promise<() => Promise<void>>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface ManagedEmailAdapterOptions {
  readonly name: string;
  readonly cwd: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly controlPlane: ManagedChannelControlPlane;
  readonly deps: ManagedEmailAdapterDeps;
  /** Off, the caller drives `tick()` itself (tests); on by default. */
  readonly pollLoop?: boolean;
}

const CLAIM_BATCH = 16;
const SUBMIT_RETRY_MS = 5_000;

// The control plane's verdict for a missing channel-instance row — the
// only 404 that is a poll-level registration claim. Its other 404s (a
// route session or workspace gone under a live instance) are
// per-message refusals, so the predicate keys on the code, never the
// bare status.
const CHANNEL_NOT_FOUND = 'channel_not_found';

// The instance-scoped refusals the workspace registry answers
// submitInbound with from the channel instance row alone: the bound
// workspace gone (404 workspace_not_found) or no longer ACTIVE (409
// workspace_unavailable), the actor's scope invalid (403
// actor_scope_mismatch) or demoted past create (403 workspace_forbidden).
// Every determinant of each comes from the instance row, not the message,
// so every inbound meets the verdict identically and no retry heals it:
// consecutive drops indict the instance's binding rather than the mail,
// and submit() bounds them with a poll stall (R5-1, R6-1).
const INSTANCE_SCOPED_REFUSALS = new Set([
  'workspace_not_found',
  'workspace_forbidden',
  'actor_scope_mismatch',
  'workspace_unavailable',
]);

// One drop is the poison message the verdict may be about (R3-1); a
// second consecutive one proves the instance's binding itself is broken.
const INSTANCE_REFUSAL_DROP_LIMIT = 1;

/**
 * The control plane carries an attachment as one base64 string bounded at
 * 2,000,000 characters — 1,500,000 decoded bytes — so an upload beyond
 * that can never be admitted and meets a deterministic 400. The upload
 * bound is clamped to what the wire can carry, and the funnel lists
 * anything over the inline staging bound as `omitted: 'too_large'`.
 */
const MAX_UPLOAD_ATTACHMENT_BYTES = 1_500_000;

/**
 * The wire's text bound (the Jakarta `@Size` and `maxTextChars` agree).
 * The adapter's own `maxTextLength` truncates first but never widens past
 * the wire: a configured 40,000 meets the same deterministic 400 a
 * 32,001 does, so the clamp caps at what the wire admits.
 */
const MAX_WIRE_TEXT_CHARS = 32_000;
// The envelope's byte line at the Harness, mirrored locally to keep this
// package free of core imports (managed-channel-operations.ts:36).
const ENVELOPE_BYTE_LIMIT = 64 * 1024;
// Allowance of the envelope's JSON metadata around the text — identity,
// reply context, subject and attachment listings, plus escaping headroom (F2).
const TEXT_ENVELOPE_OVERHEAD_BYTES = 4096;

export class ManagedEmailAdapter {
  readonly settings: EmailSettings;
  readonly policy: ManagedChannelPolicy;
  private readonly store: ManagedEmailStateStore;
  private readonly controlPlane: ManagedChannelControlPlane;
  private readonly deps: ManagedEmailAdapterDeps;
  private readonly log: (line: string) => void;
  private readonly pollLoop: boolean;
  private state?: ManagedEmailState;
  private imap?: ImapFlow;
  private smtp?: Transporter;
  private parse?: typeof simpleParser;
  private releaseLock?: () => Promise<void>;
  private running = false;
  private abort = new AbortController();
  private loop?: Promise<void>;
  /**
   * The account generation the control plane last acknowledged. An event
   * whose generation is not registered there is a poll-level registration
   * claim — re-register, then re-drive — never a per-message drop.
   */
  private registeredGeneration?: number;
  /**
   * Set when the persisted refusal streak passes the limit; gates the
   * search in poll(). In-memory only: a restart re-derives it from a
   * persisted held claim, so an epoch change that emptied pending
   * starts the new generation clean. True only while a held claim is
   * still pending: the claim can also leave without proving the
   * binding — dropped on a per-message verdict, settled by a replayed
   * answer, or un-rebuildable after a restart — and a stall that
   * outlived it would have no probe left to lift it.
   */
  private instanceStalled = false;

  constructor(options: ManagedEmailAdapterOptions) {
    this.settings = emailSettings(options.config);
    const senderPolicy = resolvePrivatePolicy(options.config);
    this.policy = {
      adapter: 'email',
      senderPolicy:
        senderPolicy === 'disabled' || senderPolicy === 'open'
          ? senderPolicy
          : 'allowlist',
      allowedSenders: addressList(
        options.config['allowedUsers'],
        'allowedUsers',
      ),
      dispatchMode:
        options.config['dispatchMode'] === 'steer' ? 'steer' : 'followup',
    };
    this.store = new ManagedEmailStateStore(
      options.name,
      options.cwd,
      this.settings,
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

  /** The current account generation, once connected. */
  get generation(): number | undefined {
    return this.state?.generation;
  }

  async connect(): Promise<void> {
    if (this.running || this.releaseLock)
      throw new Error('Managed email adapter is already connected.');
    try {
      this.releaseLock = await this.deps.lock(this.store.directory, () => {
        // A reaped stale lock means a second owner won the mailbox: stop
        // rather than keep polling as its silent twin.
        this.log(
          'Managed email state ownership was lost to another process; adapter stopped.',
        );
        this.stop();
      });
    } catch {
      throw new Error(
        'Email state is owned by another process; managed adapter not started.',
      );
    }
    try {
      this.state = this.store.load();
      // The stall flag is in-memory, so a restart zeroes it: derive the
      // stall from a persisted held claim, or the search re-opens behind
      // it and the mail the stall promised to keep is admitted to its
      // destruction. Keyed on a claim still pending, never a persisted
      // flag, so an epoch change that emptied pending starts the new
      // generation's stall clean.
      if (this.state?.pending.some((entry) => entry.held)) {
        this.instanceStalled = true;
        // A state file written before the streak persisted can hold a
        // claim with no count behind it: floor the streak past the
        // limit so the next verdict re-holds instead of dropping a
        // fresh message as a first occurrence.
        this.state.instanceRefusals = Math.max(
          this.state.instanceRefusals ?? 0,
          INSTANCE_REFUSAL_DROP_LIMIT + 1,
        );
        this.log(
          `Managed email stopped admitting for ${this.settings.address}: the instance's workspace binding is broken. Held mail is kept; check the instance's --workspace and --actor flags.`,
        );
      }
      this.parse = await this.deps.parse();
      this.smtp = await this.deps.createSmtp(this.settings);
      this.abort = new AbortController();
      this.running = true;
      this.registeredGeneration = undefined;
      await this.openMailbox();
      if (!this.running)
        throw new Error('Managed email adapter stopped during connection.');
      await this.ensureRegistered(this.state!);
      // Segments sent before a crash took their receipt: the provider may
      // hold them, so each is reported unknown — never sent again.
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
    // The remote close completes while this process still holds the
    // mailbox lock: freeing the lock first would let a replacement
    // register, and our delayed unfenced disconnect would then revoke
    // the fresh registration (R8 P1).
    await this.controlPlane.disconnect().catch(() => undefined);
    await this.release();
  }

  /** One inbound poll and one outbound pull, for callers that drive the adapter. */
  async tick(): Promise<void> {
    if (!this.imap?.usable) await this.openMailbox();
    await this.poll();
    // A receipt whose HTTP answer died is re-driven from the persisted
    // outcome on every poll, not only at restart, so the window where
    // the ledger says unknown about a proven send stays far below the
    // claim lease.
    await this.reportOrphanedOutbound();
    await this.pullOutbox();
  }

  private async openMailbox(): Promise<void> {
    const client = await this.deps.createImap(this.settings);
    this.imap = client;
    client.on('error', () => client.close());
    await client.connect();
    const mailbox = await client.mailboxOpen(this.settings.folder, {
      readOnly: true,
    });
    if (!this.running) {
      client.close();
      return;
    }
    const uidValidity = String(mailbox.uidValidity);
    if (!this.state) {
      this.state = {
        version: 1,
        uidValidity,
        generation: 1,
        lastUid: mailbox.uidNext - 1,
        pending: [],
        outbound: [],
        recent: [],
        routes: [],
      };
      this.persist();
      return;
    }
    if (this.state.uidValidity !== uidValidity) {
      // A mailbox epoch change is an account re-key: the old generation's
      // in-flight events cannot be re-fetched (their UIDs are gone), so
      // they are dropped visibly, and the next generation starts clean.
      if (this.state.pending.length) {
        this.log(
          `Managed email mailbox epoch changed with ${this.state.pending.length} in-flight event(s) of generation ${this.state.generation}; they admit nothing further.`,
        );
      }
      this.state = {
        ...this.state,
        uidValidity,
        generation: this.state.generation + 1,
        lastUid: mailbox.uidNext - 1,
        instanceRefusals: 0,
        pending: [],
        recent: [],
      };
      this.persist();
      // The epoch change dropped every claim the stall held, so a stall
      // that kept gating the new epoch's search would wedge the mailbox
      // with nothing left to re-probe it: the streak starts clean.
      this.instanceStalled = false;
      await this.ensureRegistered(this.state);
    }
  }

  private async ensureRegistered(state: ManagedEmailState): Promise<void> {
    if (this.registeredGeneration === state.generation) return;
    try {
      await this.controlPlane.register({
        platform: 'email',
        accountId: this.settings.address,
        accountGeneration: state.generation,
        policy: this.policy,
      });
      this.registeredGeneration = state.generation;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      // A 4xx verdict is a refusal, not an unanswered answer: say so
      // before throwing, or the log claims the exact opposite of a
      // deterministic 409.
      this.log(
        typeof status === 'number' && status >= 400 && status < 500
          ? `Managed email register of generation ${state.generation} was refused (${status}): ${String(error)}`
          : `Managed email register of generation ${state.generation} did not answer; the next poll re-drives it: ${String(error)}`,
      );
      throw error;
    }
  }

  private persist(): void {
    if (!this.state) throw new Error('Managed email state is unavailable.');
    this.store.save(this.state);
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.running) {
        try {
          await this.tick();
        } catch (error) {
          if (this.running) {
            this.log(
              `Managed email polling failed; reconnecting without advancing unhandled mail: ${String(error)}`,
            );
            this.imap?.close();
          }
        }
        if (this.running)
          await delay(this.settings.pollInterval, undefined, {
            signal: this.abort.signal,
          }).catch(() => {});
      }
    } finally {
      // Ownership is never the run loop's to hand back: disconnect()
      // completes the remote close while this process still holds it, and
      // releases only after — otherwise a replacement can register while
      // the old owner's unfenced disconnect is still on the wire (R10).
      this.stop();
    }
  }

  private async poll(): Promise<void> {
    const client = this.imap;
    const state = this.state;
    if (!client || !state) return;
    const mailbox = await client.status(this.settings.folder, {
      uidNext: true,
      uidValidity: true,
      messages: true,
    });
    if (
      !mailbox ||
      !Number.isSafeInteger(mailbox.uidNext) ||
      !mailbox.uidNext ||
      !mailbox.uidValidity
    )
      throw new Error('Email mailbox status is unavailable.');
    if (String(mailbox.uidValidity) !== state.uidValidity) {
      client.close();
      await this.openMailbox();
      return;
    }
    // Registration first: an event whose generation the control plane
    // never admitted is re-driven only once the server knows the account.
    await this.ensureRegistered(state);
    // In-flight events first: an admission whose answer was lost is
    // re-driven before any new mail, so the journal sees them in order.
    await this.resubmitPending();
    const upper = mailbox.uidNext - 1;
    // A stalled instance binding leaves the search at lastUid while it
    // holds a claim: the mail above it is re-searched once the held
    // claim's re-drive proves the binding answers again, never admitted
    // to its destruction meanwhile. The flag is true only while a held
    // claim is still pending — liftStallWhenNothingHeld clears it the
    // moment the claim leaves without proving the binding — and the
    // streak, still above the limit, re-holds the next instance-scoped
    // refusal without an extra drop.
    if (
      upper <= state.lastUid ||
      state.pending.length >= MANAGED_PENDING_LIMIT ||
      this.instanceStalled
    )
      return;
    const found = await client.search(
      { uid: `${state.lastUid + 1}:${upper}` },
      { uid: true },
    );
    if (!found) throw new Error('Email UID search failed.');
    const uids = found
      .filter((uid) => uid > state.lastUid && uid <= upper)
      .sort((a, b) => a - b)
      .slice(0, 100);
    const batchEnd = uids.length === 100 ? uids[uids.length - 1] : upper;
    const messages = uids.length
      ? await client.fetchAll(uids, { uid: true, size: true }, { uid: true })
      : [];
    for (const message of messages.sort((a, b) => a.uid - b.uid)) {
      if (!this.running || state.pending.length >= MANAGED_PENDING_LIMIT)
        return;
      if (message.uid <= state.lastUid || message.uid > upper) continue;
      await this.admit(message.uid, message.size);
      // A registration refusal reset the generation, or the instance
      // stall engaged: no further submit converges this tick. Return —
      // never break: lastUid must stay at the last admitted message so
      // the next poll re-searches the rest.
      if (this.registeredGeneration === 0 || this.instanceStalled) return;
    }
    if (this.running) {
      state.lastUid = batchEnd;
      this.persist();
    }
  }

  private async parsed(source: Buffer): Promise<ParsedMail> {
    const options = {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: this.settings.maxMessageBytes,
      keepDeliveryStatus: true,
    };
    const mail = await this.parse!(source, options);
    if (!mail.text && mail.html) {
      const { convert } = await import('html-to-text');
      mail.text = convert(mail.html.slice(0, this.settings.maxMessageBytes), {
        wordwrap: false,
        limits: {
          maxInputLength: this.settings.maxMessageBytes,
          maxDepth: 64,
          maxChildNodes: 10000,
        },
      });
    }
    return mail;
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

  private async admit(uid: number, size: number | undefined): Promise<void> {
    const state = this.state!;
    const skip = () => {
      if (this.running) {
        state.lastUid = uid;
        this.persist();
      }
    };
    if (!size || size > this.settings.maxMessageBytes) {
      skip();
      return;
    }
    const header = await this.imap!.fetchOne(
      uid,
      { headers: true },
      { uid: true },
    );
    if (!this.running) return;
    if (
      !header ||
      !header.headers ||
      header.uid !== uid ||
      header.headers.length > 64 * 1024
    ) {
      skip();
      return;
    }
    let mail: ParsedMail;
    try {
      mail = await this.parsed(header.headers);
    } catch {
      skip();
      return;
    }
    const sender = acceptedHeaderSender(mail, this.settings.address);
    if (!sender || !this.senderAllowed(sender)) {
      skip();
      return;
    }
    // The Legacy dedupe window: one (sender, Message-ID) is one message
    // even when the store delivers it under two UIDs.
    const identity = mail.messageId
      ? digest(`${sender}\0${mail.messageId}`)
      : undefined;
    if (identity && state.recent.includes(identity)) {
      skip();
      return;
    }
    const source = await this.imap!.fetchOne(
      uid,
      { source: { start: 0, maxLength: this.settings.maxMessageBytes + 1 } },
      { uid: true },
    );
    if (!this.running) return;
    if (
      !source ||
      source.uid !== uid ||
      !source.source ||
      source.source.length > this.settings.maxMessageBytes
    ) {
      skip();
      return;
    }
    try {
      mail = await this.parsed(source.source);
    } catch {
      skip();
      return;
    }
    if (
      acceptedHeaderSender(mail, this.settings.address) !== sender ||
      mail.attachments.some((attachment) =>
        /^(message\/|text\/calendar)/i.test(attachment.contentType),
      )
    ) {
      skip();
      return;
    }
    const eventId = `${state.uidValidity}:${uid}`;
    const route = replyRoute(
      mail,
      sender,
      eventId,
      state.routes,
      this.store.directory,
    );
    const text = this.fitInboundText(mail.text ?? '');
    const attachments = mail.attachments
      .slice(0, 16)
      .filter(
        (part) =>
          part.size <=
          Math.min(
            this.settings.maxAttachmentBytes,
            MAX_UPLOAD_ATTACHMENT_BYTES,
          ),
      )
      .map((part) => ({
        fileName: (part.filename ?? 'attachment')
          .replace(/[\r\n\0]/g, '')
          .slice(0, 128),
        mimeType: part.contentType,
        bytesBase64: part.content.toString('base64'),
      }));
    if (!text && !attachments.length) {
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
        chatId: sender,
        threadId: route.threadId,
      },
      senderId: sender,
      chatId: sender,
      threadId: route.threadId,
      subject: route.subject,
      text,
      attachments,
      replyContext: {
        to: sender,
        threadId: route.threadId,
        parent: route.parent,
        references: route.references,
        subject: route.subject,
      },
    };
    // The durable claim precedes the admission: a crash from here on
    // re-drives the same event, which the control plane answers by its
    // identity.
    state.routes = [
      ...state.routes.filter(
        (entry) => entry.threadId !== route.threadId || entry.sender !== sender,
      ),
      route,
    ].slice(-256);
    if (identity) state.recent = [...state.recent, identity].slice(-1024);
    state.pending.push({ uid, eventId });
    state.lastUid = uid;
    this.persist();
    await this.submit(uid, event);
  }

  private isRegistrationRefusal(error: unknown): boolean {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return (
      (status === 404 && code === CHANNEL_NOT_FOUND) ||
      (status === 409 &&
        (code === 'channel_generation_unregistered' ||
          code === 'channel_disconnected'))
    );
  }

  private async submit(uid: number, event: ManagedInboundEvent): Promise<void> {
    const state = this.state!;
    try {
      const admitted = await this.controlPlane.submitInbound(event);
      // The marker of the settling claim, captured before it leaves
      // pending: the held claim's fresh admission is the one proof the
      // instance's workspace binding answers again, so only it resets
      // the drop streak and lifts the stall, and the next poll's search
      // resumes above lastUid. Any other fresh admission resolves its
      // workspace through an existing binding row, which the broken
      // binding never decided, and a replayed answer is the idempotent
      // echo of an earlier admission: neither proves the binding, so
      // neither re-grants the episode's sacrifice (R10-1). A replay can
      // still settle the held claim itself — the admission whose own
      // answer was lost — and with nothing held the stall lifts, while
      // the streak stands.
      const wasHeld = state.pending.some(
        (entry) => entry.uid === uid && entry.held === true,
      );
      state.pending = state.pending.filter((entry) => entry.uid !== uid);
      if (!admitted.replayed && wasHeld) {
        state.instanceRefusals = 0;
        if (this.instanceStalled) {
          this.instanceStalled = false;
          this.log(
            `Managed email admission for ${this.settings.address} resumed; the instance's workspace answers again.`,
          );
        }
      } else {
        this.liftStallWhenNothingHeld();
      }
      this.persist();
      if (admitted.replayed) {
        this.log(
          `Managed email event ${event.platformEventId} was already admitted as ${admitted.inputId}.`,
        );
      }
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      if (this.isRegistrationRefusal(error)) {
        // The server lost our registration (a restart, a wipe) or an
        // unfenced disconnect flipped the instance under this adapter: a
        // fresh register is the only heal of `connected`, so that is a
        // poll-level claim — re-register before the next drive, never a
        // per-message drop. It is a refusal, not an unanswered answer:
        // say so, and keep the event so the re-drive never rebuilds it.
        this.registeredGeneration = 0;
        this.log(
          `Managed email admission of ${event.platformEventId} was refused as not registered (${String(status)} ${String(code)}); the next poll re-registers and re-drives it.`,
        );
        this.pendingEvents.set(uid, event);
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
          const entry = state.pending.find((pending) => pending.uid === uid);
          if (
            entry?.held ||
            state.instanceRefusals > INSTANCE_REFUSAL_DROP_LIMIT
          ) {
            // Instance-scoped, so every message meets the verdict
            // identically and no retry heals it: the claim is held and
            // the poll stalls — the mail above lastUid stays
            // re-searchable — instead of dropping every inbound message
            // behind one routine log line while the channel reports
            // connected. The held claim's re-drive is the probe that
            // lifts the stall once the binding answers again.
            this.pendingEvents.set(uid, event);
            if (!entry?.held) {
              // Persist the hold with the claim: the marker re-arms the
              // in-memory stall flag after a restart, and the claim
              // itself never drops while it is set — the mail the stall
              // promised to keep.
              state.pending = state.pending.map((pendingEntry) =>
                pendingEntry.uid === uid
                  ? { ...pendingEntry, held: true }
                  : pendingEntry,
              );
              this.persist();
            }
            if (!this.instanceStalled) {
              this.instanceStalled = true;
              this.log(
                `Managed email stopped admitting for ${this.settings.address}: every message is refused with ${status} ${String(code)}, so the workspace this channel instance binds to is gone, drained, or unreadable by its actor; check the instance's --workspace and --actor flags. Held mail is kept and admission resumes once the workspace answers.`,
              );
            }
            return;
          }
        }
        // A deterministic refusal (a failing body, a closed actor scope, a
        // dead route or generation, a route session or workspace gone
        // under a live instance): re-driving the identical event can
        // never converge, and a claim that outlives the pending limit
        // would stall the whole mailbox, so the event is dropped visibly
        // instead. A 404 drops only on a classified code: the
        // instance-gone one is the registration claim above, and an
        // unrecognized one says nothing about the mail, so it falls
        // through to the re-drive like a lost answer or a reset
        // listener.
        this.log(
          `Managed email admission of ${event.platformEventId} was refused (${status}); the message is skipped.`,
        );
        state.pending = state.pending.filter((entry) => entry.uid !== uid);
        this.pendingEvents.delete(uid);
        this.liftStallWhenNothingHeld();
        this.persist();
        return;
      }
      // The claim stays pending with its event; the next poll re-drives it.
      this.log(
        `Managed email admission of ${event.platformEventId} did not answer; it will be re-driven: ${String(error)}`,
      );
      this.pendingEvents.set(uid, event);
    }
  }

  private readonly pendingEvents = new Map<number, ManagedInboundEvent>();

  /**
   * The stall exists to be lifted by the held claim's probe: when the
   * last held claim leaves without proving the binding — dropped on a
   * per-message verdict, settled by a replayed answer, or un-rebuildable
   * after a restart — no probe remains, and a flag kept armed would gate
   * every later poll to a single admit and pin settled events in the
   * cache behind resubmitPending's stall return. The refusal streak is
   * NOT reset here: only the held claim's fresh admission proves the
   * binding (R10-1), so the next instance-scoped refusal re-holds
   * without paying a new first-occurrence drop (R7-1).
   */
  private liftStallWhenNothingHeld(): void {
    if (
      this.instanceStalled &&
      !this.state!.pending.some((entry) => entry.held === true)
    ) {
      this.instanceStalled = false;
      this.log(
        `Managed email admission for ${this.settings.address} resumed; no claim remains held, and the refusal streak still stands for the next instance-scoped refusal.`,
      );
    }
  }

  private async resubmitPending(): Promise<void> {
    const state = this.state!;
    // Probe held claims first: the stall lifts only on a held claim's
    // fresh admission, and the held entry is always the last push (the
    // admit that armed the stall), so push order lets an earlier claim
    // whose answer never comes shadow the one probe per poll — wedging
    // the mailbox across restarts (R9-1). The sort is stable: unheld
    // claims keep their uid order.
    for (const entry of [...state.pending].sort(
      (a, b) => Number(b.held === true) - Number(a.held === true),
    )) {
      if (!this.running) return;
      let event = this.pendingEvents.get(entry.uid);
      if (event === undefined) {
        // A restart: re-fetch the immutable platform copy and rebuild the
        // same event; a message gone from the store leaves a visible gap.
        event = await this.rebuildEvent(entry.uid);
        if (event === undefined) {
          this.log(
            `Managed email event ${entry.eventId} can no longer be rebuilt from the platform copy; its claim drops.`,
          );
          state.pending = state.pending.filter(
            (pending) => pending.uid !== entry.uid,
          );
          this.liftStallWhenNothingHeld();
          this.persist();
          continue;
        }
      }
      await this.submit(entry.uid, event);
      // A registration refusal reset the generation, or the instance
      // stall engaged: no further submit converges this tick — the next
      // poll re-registers or re-probes, then re-drives. The stall also
      // skips the retry delay: one probe per poll is what lifts it.
      if (this.registeredGeneration === 0 || this.instanceStalled) return;
      if (state.pending.some((pending) => pending.uid === entry.uid)) {
        await delay(SUBMIT_RETRY_MS, undefined, {
          signal: this.abort.signal,
        }).catch(() => {});
      } else {
        this.pendingEvents.delete(entry.uid);
      }
    }
  }

  private async rebuildEvent(
    uid: number,
  ): Promise<ManagedInboundEvent | undefined> {
    const state = this.state!;
    const source = await this.imap!.fetchOne(
      uid,
      { source: { start: 0, maxLength: this.settings.maxMessageBytes + 1 } },
      { uid: true },
    );
    if (
      !source ||
      source.uid !== uid ||
      !source.source ||
      source.source.length > this.settings.maxMessageBytes
    )
      return undefined;
    const mail = await this.parsed(source.source);
    const sender = acceptedHeaderSender(mail, this.settings.address);
    if (!sender) return undefined;
    const eventId = `${state.uidValidity}:${uid}`;
    if (!this.senderAllowed(sender)) {
      // The policy moved on since the claim: the pending event drops
      // visibly rather than drive a Session the current policy forbids.
      this.log(
        `Managed email event ${eventId} is refused by the current sender policy; its claim drops.`,
      );
      return undefined;
    }
    if (
      mail.attachments.some((attachment) =>
        /^(message\/|text\/calendar)/i.test(attachment.contentType),
      )
    ) {
      return undefined;
    }
    const route = replyRoute(
      mail,
      sender,
      eventId,
      state.routes,
      this.store.directory,
    );
    return {
      accountGeneration: state.generation,
      platformEventId: eventId,
      semanticRevision: 1,
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: sender,
        threadId: route.threadId,
      },
      senderId: sender,
      chatId: sender,
      threadId: route.threadId,
      subject: route.subject,
      text: this.fitInboundText(mail.text ?? ''),
      attachments: mail.attachments
        .slice(0, 16)
        .filter(
          (part) =>
            part.size <=
            Math.min(
              this.settings.maxAttachmentBytes,
              MAX_UPLOAD_ATTACHMENT_BYTES,
            ),
        )
        .map((part) => ({
          fileName: (part.filename ?? 'attachment')
            .replace(/[\r\n\0]/g, '')
            .slice(0, 128),
          mimeType: part.contentType,
          bytesBase64: part.content.toString('base64'),
        })),
      replyContext: {
        to: sender,
        threadId: route.threadId,
        parent: route.parent,
        references: route.references,
        subject: route.subject,
      },
    };
  }

  /**
   * F2: a multibyte input can sit under the character line yet overflow
   * the Harness's 64 KiB *byte* envelope at submit. Clamp by bytes with a
   * code-point cut, mirroring the character cap's own silent slice — so an
   * in-bound email is admitted truncated instead of refused deterministically.
   */
  private fitInboundText(text: string): string {
    const bounded = boundedText(
      text,
      Math.min(this.settings.maxTextLength, MAX_WIRE_TEXT_CHARS),
    );
    const byteLimit = ENVELOPE_BYTE_LIMIT - TEXT_ENVELOPE_OVERHEAD_BYTES;
    if (Buffer.byteLength(bounded, 'utf8') <= byteLimit) return bounded;
    const bytes = Buffer.from(bounded, 'utf8');
    let end = byteLimit;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end).toString('utf8');
  }

  private async reportOrphanedOutbound(): Promise<void> {
    const state = this.state!;
    for (const entry of [...state.outbound]) {
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
        // The instance row is gone — the same poll-level registration
        // claim the submit and claim routes arm. Keep the entry and reset
        // the generation: the next poll re-registers first, the re-driven
        // receipt then settles or meets the deterministic drop below, and
        // this tick's pull still runs.
        if (this.isRegistrationRefusal(error)) {
          this.registeredGeneration = 0;
          this.log(
            `Managed email receipt for ${entry.deliveryId} was refused as not registered (${String(status)} ${String(code)}); it re-drives after the next poll re-registers.`,
          );
          return;
        }
        // A deterministic refusal (the route Session closed, the delivery
        // is unknown to the control plane) never converges on re-drive, and
        // a held entry runs before every outbox pull: it would stall every
        // later delivery and fail the next connect. Drop it visibly; the
        // lease reconciler records the delivery unknown.
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
          `Managed email receipt for ${entry.deliveryId} was refused (${String(status)}); it is dropped.`,
        );
      }
      state.outbound = state.outbound.filter(
        (candidate) => candidate !== entry,
      );
      this.persist();
    }
  }

  private async pullOutbox(): Promise<void> {
    if (!this.running || !this.state) return;
    let claimed: ManagedClaimedDelivery[];
    try {
      claimed = await this.controlPlane.claimDeliveries(CLAIM_BATCH);
    } catch (error) {
      // The claim answers with the same poll-level refusal shape as an
      // inbound submit: an unfenced disconnect flips the instance under
      // this adapter, and only a fresh register heals `connected`. Skip
      // this pull — the next poll's ensureRegistered re-registers and the
      // claim resumes with it; the claim lease keeps this tick alive
      // either way (R3-3's outbound half).
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      if (this.isRegistrationRefusal(error)) {
        this.registeredGeneration = 0;
        this.log(
          `Managed email outbox claim was refused (${String(status)} ${String(code)}); the next poll re-registers first.`,
        );
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
    const context = delivery.replyContext as Partial<EmailReplyContext> | null;
    const recipient = context?.to;
    if (
      !recipient ||
      !this.senderAllowed(recipient) ||
      noReplyAddress(recipient) ||
      typeof context.parent !== 'string' ||
      !Array.isArray(context.references)
    ) {
      // The committed target is the only target: anything else is a
      // definitive refusal, never a guess at a recipient.
      await this.controlPlane.receipt(delivery.deliveryId, {
        outcome: 'rejected',
      });
      return;
    }
    for (const segment of delivery.segments) {
      if (!this.running || !this.smtp) return;
      const messageId = `<${randomUUID()}@${this.settings.address.split('@')[1]}>`;
      // The thread route learns our Message-ID before the send, so a reply
      // referencing it maps back to the same thread.
      for (const route of state.routes) {
        if (
          route.sender === recipient &&
          (typeof context.threadId === 'string'
            ? route.threadId === context.threadId
            : route.parent === context.parent)
        ) {
          route.ids = [
            route.ids[0],
            ...[...route.ids.slice(1), messageId].slice(-63),
          ];
        }
      }
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
        await this.smtp.sendMail({
          from: {
            name: 'Qwen Code Agent',
            address: this.settings.address,
          },
          to: recipient,
          envelope: { from: this.settings.address, to: [recipient] },
          subject: `Re: ${String(context.subject ?? '').replace(/^Re:\s*/i, '')}`,
          text: segment.text,
          messageId,
          inReplyTo: context.parent,
          references: context.references,
          headers: {
            'Auto-Submitted': 'auto-replied',
            'X-Qwen-Code-Agent': 'email-channel',
            'X-Auto-Response-Suppress': 'All',
          },
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        outcome = {
          outcome: 'accepted',
          ordinal: segment.ordinal,
          providerMessageId: messageId,
          acceptedAt: (this.deps.now ?? Date.now)(),
        };
      } catch (error) {
        // A definitive SMTP refusal (5xx) rejects; anything else — a
        // timeout, a dropped connection — leaves the provider's state
        // unknown, and nothing retries it.
        const code = (error as { responseCode?: unknown }).responseCode;
        outcome =
          typeof code === 'number' && code >= 500 && code < 600
            ? { outcome: 'rejected' }
            : { outcome: 'unknown' };
      }
      // The receipt is persisted before it crosses the wire: a crash in
      // the delivery's answer replays this outcome on restart instead of
      // settling a delivered delivery unknown.
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
        // SMTP send — and the remaining claimed deliveries still send
        // (R8 P1). Its remaining segments wait behind the settled one,
        // the same ordering the !accepted arm already owns.
        this.log(
          `Managed email receipt for ${delivery.deliveryId} could not be reported (${String(error)}); it re-drives on the next tick.`,
        );
        return;
      }
      state.outbound = state.outbound.filter(
        (entry) =>
          !(
            entry.deliveryId === delivery.deliveryId &&
            entry.ordinal === segment.ordinal
          ),
      );
      this.persist();
      if (outcome.outcome !== 'accepted') return;
    }
  }

  private stop(): void {
    this.running = false;
    this.abort.abort();
    this.imap?.close();
    this.smtp?.close();
  }

  private async release(): Promise<void> {
    this.stop();
    const release = this.releaseLock;
    this.releaseLock = undefined;
    await release?.();
  }
}
