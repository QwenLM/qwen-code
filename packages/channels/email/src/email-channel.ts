import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ImapFlow } from 'imapflow';
import type { ParsedMail, simpleParser } from 'mailparser';
import type { Transporter } from 'nodemailer';
import {
  ChannelBase,
  ChannelProactiveDeliveryError,
} from '@qwen-code/channel-base';
import type {
  Attachment,
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
  SessionTarget,
} from '@qwen-code/channel-base';
import { addressList, emailSettings, normalizeAddress } from './config.js';
import type { EmailSettings } from './config.js';
import {
  acceptedHeaderSender,
  boundedText,
  noReplyAddress,
  replyRoute,
} from './message.js';
import { digest, EmailStateStore } from './state.js';
import type { EmailState, ReplyRoute } from './state.js';

export class EmailChannel extends ChannelBase {
  private readonly settings: EmailSettings;
  private readonly store: EmailStateStore;
  private state?: EmailState;
  private imap?: ImapFlow;
  private smtp?: Transporter;
  private parse?: typeof simpleParser;
  private releaseLock?: () => Promise<void>;
  private running = false;
  private poisoned = false;
  private abort = new AbortController();
  private loop?: Promise<void>;
  private readonly activeRoutes = new Map<string, ReplyRoute>();
  private readonly replyContext = new AsyncLocalStorage<ReplyRoute>();

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    const settings = emailSettings(config);
    super(
      name,
      {
        ...config,
        allowedUsers: addressList(config.allowedUsers, 'allowedUsers'),
        operators: addressList(config.operators, 'operators'),
        dispatchMode: config.dispatchMode ?? 'followup',
      },
      bridge,
      options,
    );
    this.settings = settings;
    this.store = new EmailStateStore(name, config.cwd, settings);
  }

  async connect(): Promise<void> {
    if (this.running || this.releaseLock)
      throw new Error('Email channel is already connected.');
    const [
      { default: lockfile },
      { default: nodemailer },
      { default: parser },
    ] = await Promise.all([
      import('proper-lockfile'),
      import('nodemailer'),
      import('mailparser'),
    ]);
    mkdirSync(this.store.directory, { recursive: true, mode: 0o700 });
    try {
      this.releaseLock = await lockfile.lock(this.store.directory, {
        retries: 0,
        onCompromised: () =>
          this.fail('Email state ownership was lost; channel stopped.'),
      });
    } catch {
      throw new Error(
        'Email state is owned by another process; channel not started.',
      );
    }
    try {
      this.state = this.store.load();
      if (
        this.state &&
        (this.state.pending.length || this.state.outboundPending.length)
      ) {
        throw new Error(
          `Email has uncertain in-flight UIDs (${this.state.pending.join(', ')}) or outbound messages (${this.state.outboundPending.join(', ')}). Inspect task/mail side effects, then acknowledge pending / outboundPending entries in ${this.store.file} before restarting.`,
        );
      }
      rmSync(join(this.store.directory, 'attachments'), {
        recursive: true,
        force: true,
      });
      this.parse = parser.simpleParser;
      this.smtp = nodemailer.createTransport({
        host: this.settings.smtpHost,
        port: this.settings.smtpPort,
        secure: this.settings.smtpSecure,
        requireTLS: true,
        tls: { rejectUnauthorized: true },
        auth: {
          user: this.settings.smtpUser,
          pass: this.settings.smtpPassword,
        },
        logger: false,
        debug: false,
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 60_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      this.poisoned = false;
      this.abort = new AbortController();
      this.running = true;
      try {
        await this.openMailbox();
      } catch {
        if (this.poisoned)
          throw new Error(
            'Email state could not be saved; channel not started.',
          );
        throw new Error(
          'Email IMAP connection failed; check server, TLS and credentials.',
        );
      }
      if (!this.running)
        throw new Error('Email channel stopped during connection.');
      this.loop = this.runLoop();
    } catch (error) {
      this.stop();
      await this.release();
      throw error;
    }
  }

  private async openMailbox(): Promise<void> {
    const { default: imapflow } = await import('imapflow');
    const { ImapFlow: Client } = imapflow;
    const client = new Client({
      host: this.settings.imapHost,
      port: this.settings.imapPort,
      secure: this.settings.imapSecure,
      ...(this.settings.imapSecure ? {} : { doSTARTTLS: true }),
      tls: { rejectUnauthorized: true },
      auth: { user: this.settings.imapUser, pass: this.settings.imapPassword },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    });
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
    if (!this.state || this.state.uidValidity !== uidValidity) {
      if (
        this.state &&
        (this.state.pending.length || this.state.outboundPending.length)
      ) {
        this.fail(
          'Email mailbox epoch changed while tasks were running; reconcile pending UIDs before restart.',
        );
        return;
      }
      this.state = {
        version: 1,
        uidValidity,
        lastUid: mailbox.uidNext - 1,
        pending: [],
        outboundPending: [],
        recent: [],
        routes: [],
      };
      this.persist();
    }
  }

  private persist(): void {
    if (!this.state) throw new Error('Email state is unavailable.');
    try {
      this.store.save(this.state);
    } catch {
      this.fail('Email state could not be saved; admission stopped.');
      throw new Error('Email state persistence failed.');
    }
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.running) {
        try {
          if (!this.imap?.usable) await this.openMailbox();
          if (this.running) await this.poll();
        } catch {
          if (this.running) {
            process.stderr.write(
              'Email IMAP polling failed; reconnecting without advancing unhandled mail.\n',
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
      await this.release();
    }
  }

  private async poll(): Promise<void> {
    const client = this.imap;
    const state = this.state;
    if (!client || !state) return;
    // NOOP/EXISTS does not guarantee a refreshed UIDNEXT. STATUS asks for it.
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
    const upper = mailbox.uidNext - 1;
    if (upper <= state.lastUid || state.pending.length >= 33) return;
    // UID gaps can be arbitrarily large (expunges or shared server allocation).
    // Bound fetched messages rather than walking empty numeric UID windows.
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
      if (!this.running || state.pending.length >= 33) return;
      if (message.uid <= state.lastUid || message.uid > upper) continue;
      await this.admit(message.uid, message.size);
    }
    if (this.running) {
      state.lastUid = batchEnd;
      this.persist();
    }
  }

  private async parsed(source: Buffer): Promise<ParsedMail> {
    // MailParser supports keepDeliveryStatus; @types/mailparser omits it.
    const options = {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: this.settings.maxMessageBytes,
      keepDeliveryStatus: true,
    };
    const mail = await this.parse!(source, options);
    // Multipart HTML with only file attachments can omit MailParser's text fallback.
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
    if (!sender || !this.gate.isAllowed(sender)) {
      skip();
      return;
    }
    const identity = mail.messageId
      ? digest(`${sender}\0${mail.messageId}`)
      : undefined;
    if (identity && state.recent.includes(identity)) {
      skip();
      return;
    }
    const route = replyRoute(
      mail,
      sender,
      `${state.uidValidity}:${uid}`,
      state.routes,
      this.store.directory,
    );
    const envelope: Envelope = {
      channelName: this.name,
      senderId: sender,
      senderName: sender,
      chatId: sender,
      threadId: route.threadId,
      messageId: `${state.uidValidity}:${uid}`,
      text: '',
      isGroup: false,
      isMentioned: false,
      isReplyToBot: false,
    };
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
    // Recheck the source headers as well as the preflight header fetch.
    if (
      acceptedHeaderSender(mail, this.settings.address) !== sender ||
      mail.attachments.some((attachment) =>
        /^(message\/|text\/calendar)/i.test(attachment.contentType),
      )
    ) {
      skip();
      return;
    }
    envelope.text = boundedText(mail.text ?? '', this.settings.maxTextLength);
    envelope.metadata = `Email subject (untrusted): ${route.subject}`;
    if (!(await this.preflightInbound(envelope)) || !this.running) {
      skip();
      return;
    }
    const directory = join(
      this.store.directory,
      'attachments',
      `${state.uidValidity}-${uid}`,
    );
    try {
      envelope.attachments = this.attachments(mail, directory);
      if (!envelope.text && !envelope.attachments.length) {
        skip();
        return;
      }
      state.routes = [
        ...state.routes.filter(
          (entry) =>
            entry.threadId !== route.threadId || entry.sender !== sender,
        ),
        route,
      ].slice(-256);
      if (identity) state.recent = [...state.recent, identity].slice(-1024);
      state.pending.push(uid);
      state.lastUid = uid;
      this.persist(); // The durable claim precedes any agent or SMTP side effect.
      this.activeRoutes.set(envelope.messageId!, route);
      void this.replyContext.run(route, async () => {
        try {
          // Reserve one slot for control replies even when 32 ordinary turns wait.
          const control =
            /^\/(help|status|approve|deny|cancel|clear|who)(?:\s|$)/i.test(
              envelope.text,
            );
          if (state.pending.length > 32 && !control) {
            await this.sendThreadMessage(
              sender,
              route.threadId,
              'Email channel is at capacity. Please resend this task after an active task finishes.',
            );
          } else {
            await this.handleInbound(envelope);
          }
          if (this.running && !this.poisoned) {
            state.pending = state.pending.filter((entry) => entry !== uid);
            this.persist();
          }
        } catch {
          this.fail(
            'Email task could not finish; reconcile pending UIDs before restarting.',
          );
        } finally {
          this.activeRoutes.delete(envelope.messageId!);
          try {
            rmSync(directory, { recursive: true, force: true });
          } catch {
            process.stderr.write(
              'Email temporary attachment cleanup failed.\n',
            );
          }
        }
      });
    } catch {
      rmSync(directory, { recursive: true, force: true });
      this.fail(
        'Email admission failed; check state storage before restarting.',
      );
    }
  }

  private attachments(mail: ParsedMail, directory: string): Attachment[] {
    const attachments: Attachment[] = [];
    for (const part of mail.attachments.slice(0, 16)) {
      if (part.size > this.settings.maxAttachmentBytes) continue;
      const fileName = (part.filename ?? 'attachment')
        .replace(/[\r\n\0]/g, '')
        .slice(0, 128);
      if (/^image\/(png|jpeg|gif|webp)$/.test(part.contentType)) {
        attachments.push({
          type: 'image',
          data: part.content.toString('base64'),
          mimeType: part.contentType,
          fileName,
        });
      } else {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const extension =
          part.contentType === 'application/pdf'
            ? '.pdf'
            : extname(fileName).toLowerCase();
        const suffix = /^\.[a-z0-9]{1,16}$/.test(extension)
          ? extension
          : '.attachment';
        const filePath = join(directory, `${attachments.length}${suffix}`);
        writeFileSync(filePath, part.content, { mode: 0o600, flag: 'wx' });
        attachments.push({
          type: 'file',
          filePath,
          mimeType: part.contentType,
          fileName,
        });
      }
    }
    return attachments;
  }

  private route(
    chatId: string,
    threadId: string | undefined,
  ): ReplyRoute | undefined {
    if (!threadId) return undefined;
    const contextual = this.replyContext.getStore();
    if (contextual?.sender === chatId && contextual.threadId === threadId)
      return contextual;
    return this.state?.routes.find(
      (entry) => entry.sender === chatId && entry.threadId === threadId,
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.pushProactive(
      { channelName: this.name, chatId, senderId: chatId },
      text,
    );
  }

  protected override async sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    const route = this.route(chatId, threadId);
    if (!route || !this.gate.isAllowed(route.sender))
      throw new Error('Email reply target is unknown or no longer allowed.');
    await this.deliver(
      route.sender,
      this.formatAttributedText(text, sourceLabel),
      route,
    );
  }

  protected override async sendResponseMessage(
    chatId: string,
    text: string,
    sessionId: string,
    sourceLabel?: string,
  ): Promise<void> {
    const messageId = this.getResponseMessageId(sessionId);
    const route = messageId ? this.activeRoutes.get(messageId) : undefined;
    if (!route || route.sender !== chatId || !this.gate.isAllowed(route.sender))
      throw new Error('Email response has no accepted message context.');
    await this.deliver(
      route.sender,
      this.formatAttributedText(
        text,
        sourceLabel ?? this.getResponseSourceLabel(sessionId),
      ),
      route,
    );
  }

  protected override async deliverBackgroundReply(
    chatId: string,
    text: string,
    sessionId: string,
    sourceLabel?: string,
  ): Promise<void> {
    const target = this.router.getTarget(sessionId);
    if (!target || target.channelName !== this.name || target.chatId !== chatId)
      throw new Error('Email background response has no accepted thread.');
    await this.sendThreadMessage(chatId, target.threadId, text, sourceLabel);
  }

  protected override canStartInboundTurn(): boolean {
    return this.running && !this.poisoned;
  }

  override supportsProactiveSend(): boolean {
    return this.settings.proactiveRecipients.length > 0;
  }

  protected override supportsProactiveTarget(target: SessionTarget): boolean {
    return (
      target.channelName === this.name &&
      !target.isGroup &&
      normalizeAddress(target.chatId) === target.chatId &&
      this.settings.proactiveRecipients.includes(target.chatId) &&
      !noReplyAddress(target.chatId) &&
      (!target.threadId ||
        (this.gate.isAllowed(target.chatId) &&
          !!this.route(target.chatId, target.threadId)))
    );
  }

  protected override async pushProactive(
    target: SessionTarget,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    if (!this.supportsProactiveTarget(target))
      throw new Error(
        'Email proactive target is not configured or its thread is unknown.',
      );
    await this.deliver(
      target.chatId,
      this.formatAttributedText(text, sourceLabel),
      this.route(target.chatId, target.threadId),
    );
  }

  protected override async pushProactiveDelivery(
    target: SessionTarget,
    text: string,
  ): Promise<void> {
    try {
      await this.pushProactive(target, text);
    } catch {
      // A lost SMTP acknowledgment must not become a scheduler retry.
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'Email delivery failed or is uncertain; inspect channel state before retrying.',
      );
    }
  }

  private async deliver(
    recipient: string,
    text: string,
    route?: ReplyRoute,
  ): Promise<void> {
    if (!this.running || this.poisoned || !this.smtp)
      throw new Error('Email channel is not available for delivery.');
    if (noReplyAddress(recipient)) return;
    if (!this.state || this.state.outboundPending.length >= 64)
      throw new Error('Email outbound capacity reached.');
    const messageId = `<${randomUUID()}@${this.settings.address.split('@')[1]}>`;
    if (route) {
      const saved = this.state?.routes.find(
        (entry) =>
          entry.sender === route.sender && entry.threadId === route.threadId,
      );
      for (const target of new Set([route, ...(saved ? [saved] : [])])) {
        target.ids = [
          target.ids[0],
          ...[...target.ids.slice(1), messageId].slice(-63),
        ];
      }
    }
    this.state.outboundPending.push(messageId);
    this.persist();
    try {
      await this.smtp.sendMail({
        from: {
          name: `Qwen Code Agent (${this.identity.displayName})`,
          address: this.settings.address,
        },
        to: recipient,
        envelope: { from: this.settings.address, to: [recipient] },
        subject: route
          ? `Re: ${route.subject.replace(/^Re:\s*/i, '')}`
          : 'Qwen Code Agent update',
        text,
        messageId,
        ...(route
          ? { inReplyTo: route.parent, references: route.references }
          : {}),
        headers: {
          'Auto-Submitted': 'auto-replied',
          'X-Qwen-Code-Agent': 'email-channel',
          'X-Auto-Response-Suppress': 'All',
        },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (this.running && !this.poisoned) {
        this.state.outboundPending = this.state.outboundPending.filter(
          (id) => id !== messageId,
        );
        this.persist();
      }
    } catch {
      this.fail(
        'Email SMTP delivery failed or is uncertain; no automatic retry. Inspect pending / outboundPending state before restarting.',
      );
      throw new Error('Email SMTP delivery failed or is uncertain.');
    }
  }

  private fail(message: string): void {
    this.poisoned = true;
    process.stderr.write(`${message}\n`);
    this.stop();
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
  async disconnect(): Promise<void> {
    this.stop();
    await this.loop;
    await this.release();
  }
  override async waitForDisconnect(): Promise<void> {
    await this.loop;
  }
}
