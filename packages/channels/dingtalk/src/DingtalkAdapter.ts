import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DWClient,
  TOPIC_ROBOT,
  TOPIC_CARD,
  EventAck,
} from 'dingtalk-stream-sdk-nodejs';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import { ChannelBase } from '@qwen-code/channel-base';
import { normalizeDingTalkMarkdown, extractTitle } from './markdown.js';
import { downloadMedia } from './media.js';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
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

/** Track per-session interactive card state. */
interface CardSessionState {
  outTrackId: string;
  created: boolean;
  creating: boolean; // lock to prevent duplicate createCard calls
  stopped: boolean; // user clicked stop — ignore further chunks
  accumulatedText: string;
  lastUpdateAt: number;
  pendingUpdateTimer?: ReturnType<typeof setTimeout>;
}

/** Track seen msgIds to deduplicate retried callbacks. */
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACK_REACTION_NAME = '👀';
const ACK_EMOTION_ID = '2659900';
const ACK_EMOTION_BG_ID = 'im_bg_1';
const EMOTION_API = 'https://api.dingtalk.com/v1.0/robot/emotion';

/** Minimum interval between card updates (ms) to avoid API rate limiting. */
const CARD_UPDATE_INTERVAL_MS = 1500;

/** Default AI streaming card template (official DingTalk template, not robot-specific). */
const DEFAULT_AI_CARD_TEMPLATE = '17b30ffb-26c6-4ace-a2cb-49ed03c6d1f2.schema';

export class DingtalkChannel extends ChannelBase {
  private client: DWClient;
  private seenMessages: Map<string, number> = new Map();
  private dedupTimer?: ReturnType<typeof setInterval>;
  /** Map conversationId → latest sessionWebhook URL for sending replies. */
  private webhooks: Map<string, string> = new Map();
  private cardSessions: Map<string, CardSessionState> = new Map();
  /** Map chatId → sender display name for the current request. */
  private senderNames: Map<string, string> = new Map();
  /** Reverse map outTrackId → chatId for card callback routing. */
  private outTrackIdToChatId: Map<string, string> = new Map();
  /** Map chatId → sessionId for cancel routing. */
  private chatIdToSessionId: Map<string, string> = new Map();
  private tokenExpiry = 0;
  private cachedToken?: string;

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridge,
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

    this.client.registerCallbackListener(
      TOPIC_CARD,
      (msg: DWClientDownStream) => {
        this.client.send(msg.headers.messageId, {
          status: EventAck.SUCCESS,
          message: 'ok',
        });
        this.onCardCallback(msg);
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

    process.stderr.write(
      `[DingTalk:${this.name}] Connected via stream. cardTemplateId=${this.cardTemplateId}\n`,
    );
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
        msgtype: 'actionCard',
        actionCard: {
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

  private getAccessToken(): string | undefined {
    return this.client.getConfig().access_token;
  }

  // ----- Interactive Card API -----

  private async getCardAccessToken(): Promise<string | undefined> {
    if (this.cachedToken && Date.now() < this.tokenExpiry) {
      return this.cachedToken;
    }

    try {
      const resp = await fetch(
        'https://api.dingtalk.com/v1.0/oauth2/accessToken',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appKey: this.config.clientId,
            appSecret: this.config.clientSecret,
          }),
        },
      );

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        process.stderr.write(
          `[DingTalk:${this.name}] getCardAccessToken failed: HTTP ${resp.status} ${detail}\n`,
        );
        return undefined;
      }

      const data = (await resp.json()) as {
        accessToken: string;
        expireIn: number;
      };
      this.cachedToken = data.accessToken;
      this.tokenExpiry = Date.now() + (data.expireIn - 300) * 1000;
      return this.cachedToken;
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] getCardAccessToken error: ${err}\n`,
      );
      return undefined;
    }
  }

  private async createCard(
    chatId: string,
    _title: string,
    text: string,
  ): Promise<{ outTrackId: string; success: boolean }> {
    const cardTemplateId = this.cardTemplateId;
    if (!cardTemplateId) return { outTrackId: '', success: false };

    const token = await this.getCardAccessToken();
    if (!token) return { outTrackId: '', success: false };

    const outTrackId = `ding-${this.name}-${chatId}-${randomUUID()}`;

    // AI card uses flowStatus to indicate card state:
    // 1=PROCESSING, 2=INPUTING, 3=FINISHED, 4=EXECUTING, 5=FAILED
    const body = {
      cardTemplateId,
      outTrackId,
      callbackType: 'STREAM',
      openSpaceId: `dtv1.card//IM_GROUP.${chatId}`,
      imGroupOpenSpaceModel: {
        supportForward: true,
      },
      imGroupOpenDeliverModel: {
        robotCode: this.config.clientId,
      },
      cardData: {
        cardParamMap: {
          content: text,
          flowStatus: '2', // INPUTING
        },
      },
    };

    try {
      const resp = await fetch(
        'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver',
        {
          method: 'POST',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        process.stderr.write(
          `[DingTalk:${this.name}] createCard failed: HTTP ${resp.status} ${detail}\n`,
        );
        return { outTrackId: '', success: false };
      }

      this.outTrackIdToChatId.set(outTrackId, chatId);
      return { outTrackId, success: true };
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] createCard error: ${err}\n`,
      );
      return { outTrackId: '', success: false };
    }
  }

  /**
   * Stream update to an AI card via the streaming API.
   * Uses PUT /v1.0/card/streaming with key/content/isFinalize/isError.
   */
  private async streamingCard(
    outTrackId: string,
    text: string,
    finished = false,
    failed = false,
  ): Promise<boolean> {
    const token = await this.getCardAccessToken();
    if (!token) return false;

    const body = {
      outTrackId,
      guid: randomUUID(),
      key: 'content',
      content: text,
      isFull: true,
      isFinalize: finished,
      isError: failed,
    };

    try {
      const resp = await fetch('https://api.dingtalk.com/v1.0/card/streaming', {
        method: 'PUT',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        process.stderr.write(
          `[DingTalk:${this.name}] streamingCard failed: HTTP ${resp.status} ${detail}\n`,
        );
        return false;
      }

      return true;
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] streamingCard error: ${err}\n`,
      );
      return false;
    }
  }

  private get cardTemplateId(): string {
    return (
      ((this.config as unknown as Record<string, unknown>)[
        'cardTemplateId'
      ] as string) || DEFAULT_AI_CARD_TEMPLATE
    );
  }

  private get hasCardTemplate(): boolean {
    return !!this.cardTemplateId;
  }

  /**
   * Override to enable interactive card streaming when cardTemplateId is configured.
   * Creates a card on first chunk immediately, then throttles updates.
   */
  protected override onResponseChunk(
    chatId: string,
    chunk: string,
    _sessionId: string,
  ): void {
    if (!this.hasCardTemplate) return;

    let cardState = this.cardSessions.get(chatId);
    if (!cardState) {
      const senderName = this.senderNames.get(chatId) || '';
      const prefix = senderName ? `你好，${senderName}\n\n` : '';
      cardState = {
        outTrackId: '',
        created: false,
        creating: false,
        stopped: false,
        accumulatedText: prefix,
        lastUpdateAt: 0,
      };
      this.cardSessions.set(chatId, cardState);
    }

    // If user clicked stop, ignore further chunks
    if (cardState.stopped) return;

    cardState.accumulatedText += chunk;

    // First chunk: create card immediately (use `creating` lock to prevent duplicates)
    if (!cardState.created && !cardState.creating) {
      cardState.creating = true;
      const cs = cardState;
      setTimeout(async () => {
        try {
          const title = extractTitle(cs.accumulatedText);
          const result = await this.createCard(
            chatId,
            title,
            cs.accumulatedText,
          );
          if (result.success) {
            cs.outTrackId = result.outTrackId;
            cs.created = true;
            cs.lastUpdateAt = Date.now();
            process.stderr.write(
              `[DingTalk:${this.name}] Card created: ${result.outTrackId}\n`,
            );
          } else {
            process.stderr.write(
              `[DingTalk:${this.name}] Card creation failed, will fallback\n`,
            );
          }
        } catch (err) {
          process.stderr.write(
            `[DingTalk:${this.name}] card create error: ${err}\n`,
          );
        }
        cs.creating = false;
      }, 0);
      return;
    }

    // Subsequent chunks: throttle updates (not debounce)
    if (cardState.created && !cardState.pendingUpdateTimer) {
      const cs = cardState;
      const elapsed = Date.now() - cardState.lastUpdateAt;
      const delay = Math.max(0, CARD_UPDATE_INTERVAL_MS - elapsed);

      cardState.pendingUpdateTimer = setTimeout(async () => {
        cs.pendingUpdateTimer = undefined;
        if (cs.stopped) return; // card already finalized by stop button
        cs.lastUpdateAt = Date.now();
        try {
          await this.streamingCard(cs.outTrackId, cs.accumulatedText);
        } catch (err) {
          process.stderr.write(
            `[DingTalk:${this.name}] card stream error: ${err}\n`,
          );
        }
      }, delay);
    }
  }

  protected override async onResponseComplete(
    chatId: string,
    fullText: string,
    _sessionId: string,
  ): Promise<void> {
    const cardState = this.cardSessions.get(chatId);

    // If user already clicked stop, card is finalized — skip
    if (cardState?.stopped) {
      this.cleanupCard(chatId);
      return;
    }

    const senderName = this.senderNames.get(chatId) || '';
    const prefix = senderName ? `你好，${senderName}\n\n` : '';
    const prefixedText = prefix + fullText;

    if (cardState?.pendingUpdateTimer) {
      clearTimeout(cardState.pendingUpdateTimer);
    }

    // Wait for in-flight card creation to finish before deciding what to do
    if (cardState?.creating) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!cardState.creating) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
    }

    if (cardState?.created) {
      // Final streaming update with isFinalize=true to mark card as completed
      process.stderr.write(
        `[DingTalk:${this.name}] Sending via interactive card (outTrackId=${cardState.outTrackId})\n`,
      );
      try {
        await this.streamingCard(cardState.outTrackId, prefixedText, true);
      } catch {
        // ignore
      }
      this.cleanupCard(chatId);
      return;
    }

    // Card not yet created (response finished before debounce timer fired).
    // Create the card, then immediately finalize it via streaming API.
    if (this.hasCardTemplate) {
      const title = extractTitle(prefixedText);
      const result = await this.createCard(chatId, title, prefixedText);
      if (result.success) {
        // Finalize the card so it transitions from PROCESSING to FINISHED
        await this.streamingCard(result.outTrackId, prefixedText, true);
        process.stderr.write(
          `[DingTalk:${this.name}] Sending via interactive card (created at complete, outTrackId=${result.outTrackId})\n`,
        );
        this.cleanupCard(chatId);
        return;
      }
      process.stderr.write(
        `[DingTalk:${this.name}] Card creation failed at complete, falling back to actionCard\n`,
      );
    }

    // Fall back to actionCard webhook
    process.stderr.write(
      `[DingTalk:${this.name}] Sending via actionCard webhook fallback\n`,
    );
    this.cleanupCard(chatId);
    await this.sendMessage(chatId, prefixedText);
  }

  private async emotionApi(
    endpoint: 'reply' | 'recall',
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    const token = this.getAccessToken();
    if (!token) return;

    const robotCode = this.config.clientId;
    if (!robotCode || !msgId || !conversationId) return;

    try {
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
    for (const state of this.cardSessions.values()) {
      if (state.pendingUpdateTimer) {
        clearTimeout(state.pendingUpdateTimer);
      }
    }
    this.cardSessions.clear();
    this.client.disconnect();
    process.stderr.write(`[DingTalk:${this.name}] Disconnected.\n`);
  }

  /**
   * The chatId passed to onPromptStart/onPromptEnd is `conversationId ||
   * sessionWebhook` (see message handler below). Reactions require a real
   * conversation ID — skip the webhook-URL fallback case.
   */
  private isConversationId(chatId: string): boolean {
    return !!chatId && !chatId.startsWith('http');
  }

  protected override onPromptStart(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.chatIdToSessionId.set(chatId, sessionId);
    if (!messageId || !this.isConversationId(chatId)) return;
    this.attachReaction(messageId, chatId).catch(() => {});
  }

  protected override onPromptEnd(
    chatId: string,
    _sessionId: string,
    messageId?: string,
  ): void {
    if (!messageId || !this.isConversationId(chatId)) return;
    this.recallReaction(messageId, chatId).catch(() => {});
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

  /** Clean up all card-related state for a chatId. */
  private cleanupCard(chatId: string): void {
    const cardState = this.cardSessions.get(chatId);
    if (cardState) {
      if (cardState.pendingUpdateTimer) {
        clearTimeout(cardState.pendingUpdateTimer);
      }
      this.outTrackIdToChatId.delete(cardState.outTrackId);
      this.cardSessions.delete(chatId);
    }
    this.senderNames.delete(chatId);
  }

  /**
   * Handle card callback events (e.g., stop button click from AI card template).
   * Cancels the active prompt and finalizes the card with accumulated text.
   */
  private onCardCallback(downstream: DWClientDownStream): void {
    try {
      const data =
        typeof downstream.data === 'string'
          ? JSON.parse(downstream.data)
          : downstream.data;

      process.stderr.write(
        `[DingTalk:${this.name}] Card callback received: ${JSON.stringify(data)}\n`,
      );

      const outTrackId = data.outTrackId as string | undefined;
      if (!outTrackId) return;

      const chatId = this.outTrackIdToChatId.get(outTrackId);
      if (!chatId) {
        process.stderr.write(
          `[DingTalk:${this.name}] Card stop: no chatId for outTrackId=${outTrackId} (card already finalized?)\n`,
        );
        return;
      }

      const cardState = this.cardSessions.get(chatId);
      if (!cardState?.created) {
        process.stderr.write(
          `[DingTalk:${this.name}] Card stop: no active card session for chatId=${chatId} (created=${cardState?.created}, creating=${cardState?.creating})\n`,
        );
        return;
      }

      process.stderr.write(
        `[DingTalk:${this.name}] Card stop button clicked (outTrackId=${outTrackId})\n`,
      );

      // Mark as stopped immediately to block further chunk updates
      cardState.stopped = true;
      if (cardState.pendingUpdateTimer) {
        clearTimeout(cardState.pendingUpdateTimer);
        cardState.pendingUpdateTimer = undefined;
      }

      // Find the sessionId for this chatId via the router
      const sessionId = this.findSessionForChat(chatId);

      const handleStop = async () => {
        // Cancel the active prompt (does not destroy the session)
        if (sessionId) {
          const cancelled = await this.cancelCurrentPrompt(sessionId);
          process.stderr.write(
            `[DingTalk:${this.name}] cancelCurrentPrompt(${sessionId}) => ${cancelled}\n`,
          );
        } else {
          process.stderr.write(
            `[DingTalk:${this.name}] No sessionId found for chatId=${chatId}\n`,
          );
        }

        // Finalize the card with whatever text has been accumulated so far
        process.stderr.write(
          `[DingTalk:${this.name}] Finalizing card with ${cardState.accumulatedText.length} chars\n`,
        );
        try {
          const ok = await this.streamingCard(
            outTrackId,
            cardState.accumulatedText,
            true,
          );
          process.stderr.write(
            `[DingTalk:${this.name}] streamingCard finalize => ${ok}\n`,
          );
        } catch (err) {
          process.stderr.write(
            `[DingTalk:${this.name}] streamingCard finalize error: ${err}\n`,
          );
        }

        this.cleanupCard(chatId);
        process.stderr.write(`[DingTalk:${this.name}] Card stop completed\n`);
      };

      handleStop().catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] card stop error: ${err}\n`,
        );
      });
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] Failed to parse card callback: ${err}\n`,
      );
    }
  }

  private findSessionForChat(chatId: string): string | undefined {
    return this.chatIdToSessionId.get(chatId);
  }

  private onMessage(downstream: DWClientDownStream): void {
    try {
      const data: DingTalkMessageData =
        typeof downstream.data === 'string'
          ? JSON.parse(downstream.data)
          : (downstream.data as DingTalkMessageData);
      const msgId = data.msgId || downstream.headers.messageId;

      // Dedup: DingTalk retries unACKed messages
      if (msgId && this.seenMessages.has(msgId)) {
        return;
      }
      if (msgId) {
        this.seenMessages.set(msgId, Date.now());
      }

      const isGroup = data.conversationType === '2';
      const sessionWebhook = data.sessionWebhook;
      const conversationId = data.conversationId;

      if (!sessionWebhook) {
        process.stderr.write(
          `[DingTalk:${this.name}] No sessionWebhook in message, skipping.\n`,
        );
        return;
      }

      // Cache webhook by conversationId so sendMessage can look it up
      if (conversationId) {
        this.webhooks.set(conversationId, sessionWebhook);
      }

      const isMentioned = Boolean(data.isInAtList);

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

      // Remember sender name for response prefix
      if (data.senderNick) {
        this.senderNames.set(chatId, data.senderNick);
      }

      // After stripping the bot @mention, cleanText may legitimately be empty
      // (user pinged the bot with no other text). Don't fall back to the
      // original text in that case — it would re-introduce the @mention.
      const envelopeText = isMentioned ? cleanText : cleanText || content.text;

      const envelope: Envelope = {
        channelName: this.name,
        senderId: data.senderStaffId || data.senderId || '',
        senderName: data.senderNick || 'Unknown',
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
