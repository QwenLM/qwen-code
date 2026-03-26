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

export class DingtalkChannel extends ChannelBase {
  private client: DWClient;
  private seenMessages: Map<string, number> = new Map();
  private dedupTimer?: ReturnType<typeof setInterval>;

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
    // chatId is the sessionWebhook URL for DingTalk
    const body = {
      msgtype: 'markdown',
      markdown: {
        title: 'Reply',
        text,
      },
    };

    const resp = await fetch(chatId, {
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

      if (!sessionWebhook) {
        process.stderr.write(
          `[DingTalk:${this.name}] No sessionWebhook in message, skipping.\n`,
        );
        return;
      }

      // In group chats, check isInAtList from the raw data
      const rawData = JSON.parse(downstream.data);
      const isMentioned = Boolean(rawData.isInAtList);

      // Strip @bot mention from text
      let cleanText = text;
      if (isMentioned && data.senderNick) {
        // DingTalk prepends the @mention text; remove it
        cleanText = text.replace(/@\S+/g, '').trim();
      }

      const envelope: Envelope = {
        channelName: this.name,
        senderId: data.senderId || data.senderStaffId,
        senderName: data.senderNick || 'Unknown',
        chatId: sessionWebhook, // Use webhook URL as chatId for sendMessage
        text: cleanText || text,
        isGroup,
        isMentioned,
        isReplyToBot: false,
      };

      // Don't await — stream callback should return quickly
      this.handleInbound(envelope).catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] Error handling message: ${err}\n`,
        );
        // Try to send error reply
        this.sendMessage(
          sessionWebhook,
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
