import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { DWClient, TOPIC_ROBOT, EventAck } from 'dingtalk-stream-sdk-nodejs';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import {
  ChannelBase,
  isTerminalTaskLifecycleType,
  sanitizeLogText,
  sanitizeSenderName,
} from '@qwen-code/channel-base';
import { normalizeDingTalkMarkdown, extractTitle } from './markdown.js';
import { downloadMedia } from './media.js';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  ChannelAgentBridge,
  ChannelTaskLifecycleEvent,
  SessionTarget,
} from '@qwen-code/channel-base';

/**
 * Raw DingTalk message data — the SDK's RobotMessage type only covers text,
 * but DingTalk sends richer payloads for richText, picture, file, etc.
 */

interface DingTalkRichTextPart {
  type?: string;
  text?: string;
  downloadCode?: string;
  atName?: string;
}

interface DingTalkRepliedMsg {
  msgId?: string;
  msgType?: string;
  senderId?: string;
  content?: {
    text?: string;
    richText?: DingTalkRichTextPart[];
    downloadCode?: string;
    fileName?: string;
  };
}

interface DingTalkMessageData {
  msgId?: string;
  msgtype?: string;
  conversationType?: string;
  conversationId?: string;
  sessionWebhook?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId?: string;
  isInAtList?: boolean;
  text?: {
    content?: string;
    isReplyMsg?: boolean;
    repliedMsg?: DingTalkRepliedMsg;
  };
  quoteMessage?: {
    msgId?: string;
    senderId?: string;
    text?: { content?: string };
    msgtype?: string;
  };
  content?: {
    richText?: DingTalkRichTextPart[];
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
  };
}

/** Track seen msgIds to deduplicate retried callbacks. */
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACK_REACTION_NAME = '👀';
const ACK_EMOTION_ID = '2659900';
const ACK_EMOTION_BG_ID = 'im_bg_1';
const EMOTION_API = 'https://api.dingtalk.com/v1.0/robot/emotion';
const GROUP_MSG_API = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
const GROUP_MSG_KEY = 'sampleMarkdown'; // DingTalk's built-in {title, text} markdown template key
const TOKEN_API = 'https://oapi.dingtalk.com/gettoken';
const PROACTIVE_FETCH_TIMEOUT_MS = 15_000;

interface DingTalkTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

type DingTalkClientInternals = DWClient & {
  debug: boolean;
  onDownStream(data: unknown): void;
  onSystem(message: DWClientDownStream): void;
  onEvent(message: DWClientDownStream): void;
  onCallback(message: DWClientDownStream): void;
};

export class DingtalkChannel extends ChannelBase {
  private client: DWClient;
  private seenMessages: Map<string, number> = new Map();
  private dedupTimer?: ReturnType<typeof setInterval>;
  /** Map conversationId → latest sessionWebhook URL for sending replies. */
  private webhooks: Map<string, string> = new Map();
  private activeReactionKeys = new Set<string>();
  /** sessionId → reaction keys, so a dead session's reactions can be recalled. */
  private sessionReactionKeys = new Map<
    string,
    Map<string, { messageId: string; chatId: string }>
  >();
  /**
   * Real inbound message ids (insertion-ordered, size-capped). Unlike the
   * TTL-swept seenMessages dedup map, entries survive long queue waits, so a
   * turn that starts minutes after its message arrived still gets a reaction.
   */
  private inboundMessageIds = new Set<string>();
  /**
   * Token cache for proactive sends. The stream SDK only refreshes its token
   * on (re)connect, so a long-lived socket serves a stale one after ~2h.
   */
  private proactiveToken?: { token: string; expiresAt: number };

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);

    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        `Channel "${name}" requires clientId and clientSecret for DingTalk.`,
      );
    }

    this.client = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    this.installStructuredDownstreamHandler();
  }

  private installStructuredDownstreamHandler(): void {
    const client = this.client as DingTalkClientInternals;
    client.debug = false;
    // Keep raw SDK downstream frames off stdout; this switch mirrors the SDK
    // dispatch table and should be checked when upgrading the DingTalk SDK.
    client.onDownStream = (raw: unknown) => {
      this.onDownStream(raw, client);
    };
  }

  private onDownStream(raw: unknown, client: DingTalkClientInternals): void {
    const decoded = this.decodeDownStream(raw);
    let msg: DWClientDownStream;
    try {
      const parsed = JSON.parse(decoded.text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        process.stderr.write(
          `[DingTalk:${this.name}] downstream parsed to non-object, ignoring.\n`,
        );
        return;
      }
      msg = parsed as DWClientDownStream;
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] Failed to parse downstream: ${sanitizeLogText(
          String(err),
          200,
        )}\n`,
      );
      return;
    }
    const headers: Record<string, unknown> =
      msg.headers && typeof msg.headers === 'object' ? msg.headers : {};
    const type = typeof msg.type === 'string' ? msg.type : '';
    const topic = typeof headers['topic'] === 'string' ? headers['topic'] : '';
    const messageId =
      typeof headers['messageId'] === 'string' ? headers['messageId'] : '';

    process.stderr.write(
      `[DingTalk:${this.name}] downstream type=${sanitizeLogText(type, 40)} topic=${sanitizeLogText(
        topic,
        80,
      )} messageId=${sanitizeLogText(messageId, 80)} bytes=${decoded.bytes}\n`,
    );

    if ((type === 'CALLBACK' || type === 'EVENT') && (!topic || !messageId)) {
      process.stderr.write(
        `[DingTalk:${this.name}] Ignoring downstream with invalid routing headers.\n`,
      );
      return;
    }

    const normalizedMsg = {
      ...msg,
      headers: { ...headers, topic, messageId },
    } as DWClientDownStream;

    switch (type) {
      case 'SYSTEM':
        this.callDownStreamHandler(client, 'onSystem', normalizedMsg);
        break;
      case 'EVENT':
        this.callDownStreamHandler(client, 'onEvent', normalizedMsg);
        break;
      case 'CALLBACK':
        this.callDownStreamHandler(client, 'onCallback', normalizedMsg);
        break;
      default:
        process.stderr.write(
          `[DingTalk:${this.name}] Ignoring downstream type ${sanitizeLogText(
            type || 'unknown',
            40,
          )}.\n`,
        );
    }
  }

  private callDownStreamHandler(
    client: DingTalkClientInternals,
    method: 'onSystem' | 'onEvent' | 'onCallback',
    msg: DWClientDownStream,
  ): void {
    try {
      client[method](msg);
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] ${method} failed: ${sanitizeLogText(
          String(err),
          200,
        )}\n`,
      );
    }
  }

  private decodeDownStream(raw: unknown): { text: string; bytes: number } {
    if (typeof raw === 'string') {
      return { text: raw, bytes: Buffer.byteLength(raw) };
    }
    if (Buffer.isBuffer(raw)) {
      return { text: raw.toString('utf8'), bytes: raw.length };
    }
    if (raw instanceof Uint8Array) {
      return { text: Buffer.from(raw).toString('utf8'), bytes: raw.byteLength };
    }
    if (raw instanceof ArrayBuffer) {
      return {
        text: Buffer.from(raw).toString('utf8'),
        bytes: raw.byteLength,
      };
    }
    return { text: String(raw), bytes: Buffer.byteLength(String(raw)) };
  }

  async connect(): Promise<void> {
    this.client.registerCallbackListener(
      TOPIC_ROBOT,
      (msg: DWClientDownStream) => {
        // ACK immediately so DingTalk doesn't retry
        this.client.send(msg.headers.messageId, {
          status: EventAck.SUCCESS,
          message: 'ok',
        });
        this.onMessage(msg);
      },
    );

    await this.client.connect();

    // Periodically clean up dedup map
    this.dedupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.seenMessages) {
        if (now - ts > DEDUP_TTL_MS) {
          this.seenMessages.delete(id);
        }
      }
    }, 60_000);

    process.stderr.write(`[DingTalk:${this.name}] Connected via stream.\n`);
  }

  /**
   * A group message with no conversationId can't be routed to a stable shared
   * session (chatId would fall back to the expiring sessionWebhook), so it is
   * dropped on ingestion. Exposed for testing the drop rule.
   */
  static isUnroutableGroupMessage(
    isGroup: boolean,
    conversationId: string | undefined,
  ): boolean {
    return isGroup && !conversationId;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // chatId is a conversationId — resolve to the latest sessionWebhook
    const webhook = this.webhooks.get(chatId);
    if (!webhook) {
      process.stderr.write(
        `[DingTalk:${this.name}] No webhook for chatId ${chatId}, cannot send.\n`,
      );
      return;
    }

    const chunks = normalizeDingTalkMarkdown(text);
    const title = extractTitle(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const body = {
        msgtype: 'markdown',
        markdown: {
          title: i === 0 ? title : `${title} (cont.)`,
          text: chunk,
        },
      };

      const resp = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        process.stderr.write(
          `[DingTalk:${this.name}] sendMessage failed: HTTP ${resp.status} ${detail}\n`,
        );
      }
    }
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  /**
   * The group-message API needs a real openConversationId — reject DMs
   * (a different API) and webhook-URL fallback chatIds.
   */
  protected override supportsProactiveTarget(target: SessionTarget): boolean {
    return (
      target.isGroup === true &&
      target.threadId === undefined &&
      this.isConversationId(target.chatId)
    );
  }

  /**
   * Single-shot cold send: a failed chunk aborts the remainder (already-sent
   * chunks are not recalled) and the error surfaces in the loop's lastError.
   */
  protected override async pushProactive(
    target: SessionTarget,
    text: string,
  ): Promise<void> {
    if (!text.trim()) return;

    const chunks = normalizeDingTalkMarkdown(text);
    const title = extractTitle(text);

    for (let i = 0; i < chunks.length; i++) {
      await this.sendProactiveChunk(
        target.chatId,
        i === 0 ? title : `${title} (cont.)`,
        chunks[i]!,
        `chunk ${i + 1}/${chunks.length}`,
      );
    }
  }

  private async getProactiveToken(): Promise<string> {
    const cached = this.proactiveToken;
    if (cached && Date.now() < cached.expiresAt) return cached.token;

    const url = `${TOKEN_API}?appkey=${encodeURIComponent(
      this.config.clientId!,
    )}&appsecret=${encodeURIComponent(this.config.clientSecret!)}`;
    let data: DingTalkTokenResponse;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
      });
      data = (await resp.json()) as DingTalkTokenResponse;
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] proactive send failed: token fetch error ${err}\n`,
      );
      throw new Error(
        'DingTalk proactive send failed: could not fetch access token',
      );
    }
    if (!data.access_token) {
      const errmsg = sanitizeLogText(String(data.errmsg ?? ''), 200);
      process.stderr.write(
        `[DingTalk:${this.name}] proactive send failed: gettoken errcode=${data.errcode} ${errmsg}\n`,
      );
      throw new Error(
        `DingTalk proactive send failed: gettoken errcode=${data.errcode}${errmsg ? ` ${errmsg}` : ''}`,
      );
    }
    this.proactiveToken = {
      token: data.access_token,
      // Refresh a minute early so a fire mid-expiry doesn't race the TTL.
      expiresAt:
        Date.now() + Math.max(60, (data.expires_in ?? 7200) - 60) * 1000,
    };
    return data.access_token;
  }

  private async sendProactiveChunk(
    conversationId: string,
    title: string,
    text: string,
    chunkLabel: string,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getProactiveToken();
      let resp: Response;
      try {
        resp = await fetch(GROUP_MSG_API, {
          method: 'POST',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            robotCode: this.config.clientId!,
            openConversationId: conversationId,
            msgKey: GROUP_MSG_KEY,
            msgParam: JSON.stringify({ title, text }),
          }),
          signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause;
        process.stderr.write(
          `[DingTalk:${this.name}] proactive send error (${chunkLabel}): ${err}${cause ? ` (${cause})` : ''}\n`,
        );
        throw new Error(
          `DingTalk proactive send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (resp.status === 401 && attempt === 0) {
        // Stale or revoked token — refresh once and retry this chunk.
        this.proactiveToken = undefined;
        await resp.body?.cancel();
        continue;
      }
      if (!resp.ok) {
        const detail = sanitizeLogText(await resp.text().catch(() => ''), 300);
        process.stderr.write(
          `[DingTalk:${this.name}] proactive send failed (${chunkLabel}): HTTP ${resp.status} ${detail}\n`,
        );
        throw new Error(
          `DingTalk proactive send failed: HTTP ${resp.status}${detail ? ` ${detail}` : ''}`,
        );
      }
      await resp.body?.cancel();
      return;
    }
  }

  private getAccessToken(): string | undefined {
    return this.client.getConfig().access_token;
  }

  private async emotionApi(
    endpoint: 'reply' | 'recall',
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    const robotCode = this.config.clientId;
    if (!robotCode || !this.config.clientSecret || !msgId || !conversationId) {
      if (!this.config.clientSecret) {
        process.stderr.write(
          `[DingTalk:${this.name}] emotion/${endpoint} skipped: clientSecret not configured\n`,
        );
      }
      return;
    }

    try {
      const token = await this.getProactiveToken();
      const resp = await fetch(`${EMOTION_API}/${endpoint}`, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          robotCode,
          openMsgId: msgId,
          openConversationId: conversationId,
          emotionType: 2,
          emotionName: ACK_REACTION_NAME,
          textEmotion: {
            emotionId: ACK_EMOTION_ID,
            emotionName: ACK_REACTION_NAME,
            text: ACK_REACTION_NAME,
            backgroundId: ACK_EMOTION_BG_ID,
          },
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        process.stderr.write(
          `[DingTalk:${this.name}] emotion/${endpoint} failed: ${resp.status} ${detail}\n`,
        );
      }
    } catch {
      // best-effort, don't break message flow
    }
  }

  private async attachReaction(
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    await this.emotionApi('reply', msgId, conversationId);
  }

  private async recallReaction(
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    await this.emotionApi('recall', msgId, conversationId);
  }

  disconnect(): void {
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
    }
    this.activeReactionKeys.clear();
    this.sessionReactionKeys.clear();
    this.client.disconnect();
    process.stderr.write(`[DingTalk:${this.name}] Disconnected.\n`);
  }

  /**
   * The chatId passed to onPromptStart/onPromptEnd is `conversationId ||
   * sessionWebhook` (see message handler below). Reactions and proactive
   * sends require a real conversation ID — skip the webhook-URL fallback case.
   */
  private isConversationId(chatId: string): boolean {
    return !!chatId && !/^https?:\/\//i.test(chatId);
  }

  private reactionKey(messageId: string, conversationId: string): string {
    return `${conversationId}:${messageId}`;
  }

  private rememberInboundMessageId(msgId: string): void {
    this.inboundMessageIds.delete(msgId);
    this.inboundMessageIds.add(msgId);
    if (this.inboundMessageIds.size > 1000) {
      const oldest = this.inboundMessageIds.values().next().value;
      if (oldest !== undefined) this.inboundMessageIds.delete(oldest);
    }
  }

  private logReactionFailure(action: string, err: unknown): void {
    process.stderr.write(
      `[DingTalk:${this.name}] ${action} failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }

  private startReaction(
    chatId: string,
    messageId?: string,
    sessionId?: string,
  ): void {
    if (!messageId || !this.isConversationId(chatId)) return;
    // Loop lifecycle events carry the internal job id as messageId; the
    // emotion API only accepts ids of real inbound messages, so skip anything
    // we never saw arrive.
    if (!this.inboundMessageIds.has(messageId)) return;
    const key = this.reactionKey(messageId, chatId);
    if (this.activeReactionKeys.has(key)) return;
    this.activeReactionKeys.add(key);
    if (sessionId) {
      let keys = this.sessionReactionKeys.get(sessionId);
      if (!keys) {
        keys = new Map();
        this.sessionReactionKeys.set(sessionId, keys);
      }
      keys.set(key, { messageId, chatId });
    }
    this.attachReaction(messageId, chatId)
      .then(() => {
        if (!this.activeReactionKeys.has(key)) {
          void this.recallReaction(messageId, chatId).catch((err) => {
            this.logReactionFailure('late reaction recall', err);
          });
        }
      })
      .catch((err) => {
        this.activeReactionKeys.delete(key);
        this.logReactionFailure('reaction attach', err);
      });
  }

  private stopReaction(
    chatId: string,
    messageId?: string,
    sessionId?: string,
  ): void {
    if (!messageId || !this.isConversationId(chatId)) return;
    const key = this.reactionKey(messageId, chatId);
    if (sessionId) {
      const keys = this.sessionReactionKeys.get(sessionId);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) this.sessionReactionKeys.delete(sessionId);
      }
    }
    if (!this.activeReactionKeys.delete(key)) return;
    this.recallReaction(messageId, chatId).catch((err) => {
      this.logReactionFailure('reaction recall', err);
    });
  }

  /** Recall reactions left behind when a session dies without terminal lifecycle events. */
  override onSessionDied(sessionId: string): void {
    const keys = this.sessionReactionKeys.get(sessionId);
    if (keys) {
      this.sessionReactionKeys.delete(sessionId);
      for (const [key, { messageId, chatId }] of keys) {
        if (this.activeReactionKeys.delete(key)) {
          void this.recallReaction(messageId, chatId).catch((err) => {
            this.logReactionFailure('session-death reaction recall', err);
          });
        }
      }
    }
    super.onSessionDied(sessionId);
  }

  protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
    if (event.type === 'started') {
      this.startReaction(event.chatId, event.messageId, event.sessionId);
      return;
    }
    if (isTerminalTaskLifecycleType(event.type)) {
      this.stopReaction(event.chatId, event.messageId, event.sessionId);
    }
  }

  protected override onPromptStart(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.startReaction(chatId, messageId, sessionId);
  }

  protected override onPromptEnd(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.stopReaction(chatId, messageId, sessionId);
  }

  /**
   * Extract quoted/referenced message context from a reply.
   * DingTalk provides this via text.repliedMsg (newer) or quoteMessage (legacy).
   */
  private extractQuotedContext(data: DingTalkMessageData): {
    referencedText?: string;
    isReplyToBot: boolean;
  } {
    // Newer format: text.repliedMsg
    if (data.text?.isReplyMsg && data.text.repliedMsg) {
      const replied = data.text.repliedMsg;
      const isReplyToBot =
        !!data.chatbotUserId && replied.senderId === data.chatbotUserId;

      // Note: DingTalk doesn't include content for interactiveCard replies
      // (bot responses sent via webhook). Only user message quotes have text.
      const text = this.summarizeRepliedContent(replied);
      return { referencedText: text || undefined, isReplyToBot };
    }

    // Legacy format: quoteMessage
    if (data.quoteMessage) {
      const quote = data.quoteMessage;
      const isReplyToBot =
        !!data.chatbotUserId && quote.senderId === data.chatbotUserId;
      const text = quote.text?.content?.trim();
      return { referencedText: text || undefined, isReplyToBot };
    }

    return { isReplyToBot: false };
  }

  /**
   * Build a text summary from a repliedMsg, handling text, richText, and
   * media message types with placeholders.
   */
  private summarizeRepliedContent(replied: DingTalkRepliedMsg): string {
    const msgType = replied.msgType;
    const content = replied.content;

    // Direct text content
    if (content?.text?.trim()) {
      return content.text.trim();
    }

    // RichText: concatenate text parts, placeholder for images
    if (content?.richText && Array.isArray(content.richText)) {
      const parts: string[] = [];
      for (const part of content.richText) {
        const partType = part.type || 'text';
        if (partType === 'text' && part.text) {
          parts.push(part.text);
        } else if (partType === 'picture') {
          parts.push('[image]');
        } else if (partType === 'at' && part.atName) {
          parts.push(`@${part.atName}`);
        }
      }
      const summary = parts.join('').trim();
      if (summary) return summary;
    }

    // Media type placeholders
    switch (msgType) {
      case 'picture':
        return '[image]';
      case 'file':
        return `[file: ${content?.fileName || 'file'}]`;
      case 'audio':
        return '[audio]';
      case 'video':
        return '[video]';
      default:
        break;
    }

    return '';
  }

  /**
   * Extract text and media download codes from an incoming DingTalk message.
   * Handles text, richText, picture, file, audio, and video message types.
   */
  private extractContent(data: DingTalkMessageData): {
    text: string;
    downloadCodes: string[];
    mediaType?: 'image' | 'file' | 'audio' | 'video';
    fileName?: string;
  } {
    const msgtype = data.msgtype || 'text';

    if (msgtype === 'richText') {
      const richText = data.content?.richText;
      if (!Array.isArray(richText)) {
        return { text: '', downloadCodes: [] };
      }
      let text = '';
      const codes: string[] = [];
      for (const part of richText) {
        const partType = part.type || 'text';
        if (partType === 'text' && part.text) {
          text += part.text;
        } else if (partType === 'picture' && part.downloadCode) {
          codes.push(part.downloadCode);
        }
      }
      return {
        text: text.trim() || (codes.length > 0 ? '(image)' : ''),
        downloadCodes: codes,
        mediaType: codes.length > 0 ? 'image' : undefined,
      };
    }

    if (msgtype === 'picture') {
      const code = data.content?.downloadCode;
      return {
        text: '(image)',
        downloadCodes: code ? [code] : [],
        mediaType: 'image',
      };
    }

    if (msgtype === 'file') {
      const code = data.content?.downloadCode;
      const fileName = data.content?.fileName || undefined;
      return {
        text: `(file: ${fileName || 'file'})`,
        downloadCodes: code ? [code] : [],
        mediaType: 'file',
        fileName,
      };
    }

    if (msgtype === 'audio') {
      const code = data.content?.downloadCode;
      const recognition = data.content?.recognition;
      return {
        text: recognition || '(audio)',
        downloadCodes: code ? [code] : [],
        mediaType: 'audio',
      };
    }

    if (msgtype === 'video') {
      const code = data.content?.downloadCode;
      return {
        text: '(video)',
        downloadCodes: code ? [code] : [],
        mediaType: 'video',
      };
    }

    // Default: text message
    return { text: data.text?.content?.trim() || '', downloadCodes: [] };
  }

  /**
   * Download a media file and attach it to the envelope.
   * Images → base64 in envelope; files → saved to temp dir with path in text.
   */
  private async attachMedia(
    envelope: Envelope,
    downloadCode: string,
    mediaType: 'image' | 'file' | 'audio' | 'video',
    fileName?: string,
  ): Promise<void> {
    const token = this.getAccessToken();
    const robotCode = this.config.clientId;
    if (!token || !robotCode) {
      process.stderr.write(
        `[DingTalk:${this.name}] Cannot download media: missing token or robotCode.\n`,
      );
      return;
    }

    const media = await downloadMedia(downloadCode, robotCode, token);
    if (!media) return;

    if (mediaType === 'image') {
      const mimeType = media.mimeType.startsWith('image/')
        ? media.mimeType
        : 'image/jpeg';
      envelope.attachments = [
        ...(envelope.attachments || []),
        {
          type: 'image',
          data: media.buffer.toString('base64'),
          mimeType,
        },
      ];
    } else {
      // Save non-image files to temp dir so the agent can read them
      const dir = join(tmpdir(), 'channel-files', randomUUID());
      mkdirSync(dir, { recursive: true });
      const safeName =
        basename(fileName || '') || `dingtalk_${mediaType}_${Date.now()}`;
      const filePath = join(dir, safeName);
      writeFileSync(filePath, media.buffer);

      // Clean up placeholder text like "(audio)", "(video)", "(file: name)"
      if (
        envelope.text === `(file: ${fileName || 'file'})` ||
        envelope.text === '(audio)' ||
        envelope.text === '(video)'
      ) {
        envelope.text = '';
      }

      envelope.attachments = [
        ...(envelope.attachments || []),
        {
          type: mediaType,
          filePath,
          mimeType: media.mimeType,
          fileName: safeName,
        },
      ];
    }
  }

  private onMessage(downstream: DWClientDownStream): void {
    try {
      const data: DingTalkMessageData =
        typeof downstream.data === 'string'
          ? JSON.parse(downstream.data)
          : (downstream.data as DingTalkMessageData);
      const dataMsgId = typeof data.msgId === 'string' ? data.msgId : undefined;
      const headerMsgId =
        typeof downstream.headers.messageId === 'string'
          ? downstream.headers.messageId
          : undefined;
      const msgId = dataMsgId || headerMsgId;

      // Dedup: DingTalk retries unACKed messages
      if (msgId && this.seenMessages.has(msgId)) {
        return;
      }
      if (msgId) {
        this.seenMessages.set(msgId, Date.now());
        this.rememberInboundMessageId(msgId);
      }

      const isGroup = data.conversationType === '2';
      const sessionWebhook =
        typeof data.sessionWebhook === 'string'
          ? data.sessionWebhook
          : undefined;
      const conversationId =
        typeof data.conversationId === 'string'
          ? data.conversationId
          : undefined;
      const isMentioned = Boolean(data.isInAtList);
      const senderNick =
        typeof data.senderNick === 'string' ? data.senderNick : undefined;
      const senderStaffId =
        typeof data.senderStaffId === 'string' ? data.senderStaffId : undefined;
      const senderIdValue =
        typeof data.senderId === 'string' ? data.senderId : undefined;

      if (!sessionWebhook) {
        process.stderr.write(
          `[DingTalk:${this.name}] No sessionWebhook in message, skipping.\n`,
        );
        return;
      }

      // A group message with no conversationId can't be routed to a stable
      // session — chatId would fall back to the expiring sessionWebhook and the
      // shared-session key would churn. Drop it rather than fragment the group.
      if (DingtalkChannel.isUnroutableGroupMessage(isGroup, conversationId)) {
        // Include identifying context so an operator can tell whether one sender
        // or every group message is affected if DingTalk starts omitting
        // conversationId (API regression / edge-case message type).
        process.stderr.write(
          `[DingTalk:${this.name}] Group message has no conversationId, skipping (msgId=${
            msgId || 'unknown'
          }, sender=${sanitizeSenderName(
            senderNick || senderStaffId || 'unknown',
          )})\n`,
        );
        return;
      }

      // Cache webhook by conversationId so sendMessage can look it up
      if (conversationId) {
        this.webhooks.set(conversationId, sessionWebhook);
      }

      process.stderr.write(
        `[DingTalk:${this.name}] message msgId=${sanitizeLogText(
          msgId || 'unknown',
          80,
        )} conversationId=${sanitizeLogText(
          conversationId || '',
          120,
        )} isGroup=${isGroup} isMentioned=${isMentioned} senderNick=${sanitizeLogText(
          senderNick || '',
          80,
        )} senderStaffId=${sanitizeLogText(
          senderStaffId || '',
          80,
        )} senderId=${sanitizeLogText(senderIdValue || '', 80)}\n`,
      );

      // Extract text and media info from message
      const content = this.extractContent(data);
      let cleanText = content.text;

      // Strip first @mention (the bot) from text, keep other @mentions intact
      if (isMentioned) {
        cleanText = cleanText.replace(/@\S+/, '').trim();
      }

      // Extract quoted message context
      const quoted = this.extractQuotedContext(data);

      const chatId = conversationId || sessionWebhook;

      // After stripping the bot @mention, cleanText may legitimately be empty
      // (user pinged the bot with no other text). Don't fall back to the
      // original text in that case — it would re-introduce the @mention.
      const envelopeText = isMentioned ? cleanText : cleanText || content.text;
      const senderId = senderStaffId || senderIdValue || '';
      const senderName = senderNick || senderId || 'Unknown';

      const envelope: Envelope = {
        channelName: this.name,
        senderId,
        senderName,
        chatId,
        text: envelopeText,
        isGroup,
        isMentioned,
        isReplyToBot: quoted.isReplyToBot,
        referencedText: quoted.referencedText,
      };

      // Reactions are resolved later via the chatId passed to
      // onPromptStart/onPromptEnd — no extra bookkeeping needed.
      envelope.messageId = msgId;

      const processMessage = async () => {
        // Download media if present (first downloadCode only for images)
        if (content.downloadCodes.length > 0 && content.mediaType) {
          await this.attachMedia(
            envelope,
            content.downloadCodes[0]!,
            content.mediaType,
            content.fileName,
          );
        }
        await this.handleInbound(envelope);
      };

      // Don't await — stream callback should return quickly
      processMessage().catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] Error handling message: ${err}\n`,
        );
        this.sendMessage(
          chatId,
          'Sorry, something went wrong processing your message.',
        ).catch(() => {});
      });
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] Failed to parse message: ${err}\n`,
      );
    }
  }
}
