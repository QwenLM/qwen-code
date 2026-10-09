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
        pending: [],
        recent: [],
      };
      this.persist();
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
    if (upper <= state.lastUid || state.pending.length >= MANAGED_PENDING_LIMIT)
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

  private async submit(uid: number, event: ManagedInboundEvent): Promise<void> {
    const state = this.state!;
    try {
      const admitted = await this.controlPlane.submitInbound(event);
      state.pending = state.pending.filter((entry) => entry.uid !== uid);
      this.persist();
      if (admitted.replayed) {
        this.log(
          `Managed email event ${event.platformEventId} was already admitted as ${admitted.inputId}.`,
        );
      }
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      if (
        status === 404 ||
        (status === 409 && code === 'channel_generation_unregistered')
      ) {
        // The server lost our registration (a restart, a wipe): that is a
        // poll-level claim — re-register before the next drive, never a
        // per-message drop.
        this.registeredGeneration = 0;
      } else if (
        typeof status === 'number' &&
        (status === 400 || status === 403 || status === 409)
      ) {
        // A deterministic refusal (a failing body, a closed actor scope, a
        // dead route or generation): re-driving the identical event can
        // never converge, and a claim that outlives the pending limit
        // would stall the whole mailbox, so the event is dropped visibly
        // instead. Everything else — a lost answer, a reset listener — is
        // re-driven.
        this.log(
          `Managed email admission of ${event.platformEventId} was refused (${status}); the message is skipped.`,
        );
        state.pending = state.pending.filter((entry) => entry.uid !== uid);
        this.pendingEvents.delete(uid);
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

  private async resubmitPending(): Promise<void> {
    const state = this.state!;
    for (const entry of [...state.pending]) {
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
          this.persist();
          continue;
        }
      }
      await this.submit(entry.uid, event);
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
    const claimed = await this.controlPlane.claimDeliveries(CLAIM_BATCH);
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
