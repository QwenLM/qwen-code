import { DWClient, TOPIC_ROBOT, EventAck } from 'dingtalk-stream-sdk-nodejs';
import type {
  DWClientDownStream,
  RobotMessage,
} from 'dingtalk-stream-sdk-nodejs';
import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
} from '@qwen-code/channel-base';

/** Track seen msgIds to deduplicate retried callbacks. */
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACK_REACTION_NAME = '👀';
const ACK_EMOTION_ID = '2659900';
const ACK_EMOTION_BG_ID = 'im_bg_1';
const EMOTION_API = 'https://api.dingtalk.com/v1.0/robot/emotion';

export class DingtalkChannel extends ChannelBase {
  private client: DWClient;
  private seenMessages: Map<string, number> = new Map();
  private dedupTimer?: ReturnType<typeof setInterval>;
  /** Map conversationId → latest sessionWebhook URL for sending replies. */
  private webhooks: Map<string, string> = new Map();

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

  async sendMessage(chatId: string, text: string): Promise<void> {
    // chatId is a conversationId — resolve to the latest sessionWebhook
    const webhook = this.webhooks.get(chatId);
    if (!webhook) {
      process.stderr.write(
        `[DingTalk:${this.name}] No webhook for chatId ${chatId}, cannot send.\n`,
      );
      return;
    }

    const body = {
      msgtype: 'markdown',
      markdown: {
        title: 'Reply',
        text,
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

  private getAccessToken(): string | undefined {
    return this.client.getConfig().access_token;
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
    this.client.disconnect();
    process.stderr.write(`[DingTalk:${this.name}] Disconnected.\n`);
  }

  private onMessage(downstream: DWClientDownStream): void {
    try {
      const data: RobotMessage =
        typeof downstream.data === 'string'
          ? JSON.parse(downstream.data)
          : (downstream.data as unknown as RobotMessage);
      const msgId = data.msgId || downstream.headers.messageId;

      // Dedup: DingTalk retries unACKed messages
      if (msgId && this.seenMessages.has(msgId)) {
        return;
      }
      if (msgId) {
        this.seenMessages.set(msgId, Date.now());
      }

      const isGroup = data.conversationType === '2';
      const text = data.text?.content?.trim() || '';
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

      // In group chats, check isInAtList from the raw data
      const rawData =
        typeof downstream.data === 'string'
          ? JSON.parse(downstream.data)
          : downstream.data;
      const isMentioned = Boolean(rawData.isInAtList);

      // Strip @bot mention from text
      let cleanText = text;
      if (isMentioned) {
        cleanText = text.replace(/@\S+/g, '').trim();
      }

      const chatId = conversationId || sessionWebhook;

      const envelope: Envelope = {
        channelName: this.name,
        senderId: data.senderId || data.senderStaffId,
        senderName: data.senderNick || 'Unknown',
        chatId,
        text: cleanText || text,
        isGroup,
        isMentioned,
        isReplyToBot: false,
      };

      // Attach 👀 reaction, process message, then recall reaction
      const reactionMsgId = msgId;
      const reactionConvId = conversationId;

      const processMessage = async () => {
        if (reactionMsgId && reactionConvId) {
          this.attachReaction(reactionMsgId, reactionConvId).catch(() => {});
        }
        try {
          await this.handleInbound(envelope);
        } finally {
          if (reactionMsgId && reactionConvId) {
            this.recallReaction(reactionMsgId, reactionConvId).catch(() => {});
          }
        }
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
