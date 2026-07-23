import process from 'node:process';
import { Octokit } from 'octokit';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import { PollingChannelBase } from '@qwen-code/channel-base';
import { testBotMention, stripBotMention } from './mention.js';

const MIN_POLL_INTERVAL = 60_000;
const DEFAULT_POLL_INTERVAL = 60_000;

interface GithubConfig extends ChannelConfig {
  pollInterval?: number;
  baseUrl?: string;
  requireMention?: boolean;
}

interface GithubCursor {
  lastProcessedAt: string;
}

export class GithubChannel extends PollingChannelBase<GithubCursor> {
  private octokit!: Octokit;
  private botUsername: string | null = null;
  private recentlyProcessed = new Set<string>();

  constructor(
    name: string,
    config: GithubConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, { ...config, sessionScope: 'chat_thread' }, bridge, options);
  }

  protected createInitialCursor(): GithubCursor {
    return { lastProcessedAt: new Date().toISOString() };
  }

  protected override get pollInterval(): number {
    const configured = (this.config as GithubConfig).pollInterval;
    if (configured && configured >= MIN_POLL_INTERVAL) return configured;
    return DEFAULT_POLL_INTERVAL;
  }

  private get requireMention(): boolean {
    return (this.config as GithubConfig).requireMention !== false;
  }

  async connect(): Promise<void> {
    const cfg = this.config as GithubConfig;
    this.octokit = new Octokit({
      auth: cfg.token,
      baseUrl: cfg.baseUrl || 'https://api.github.com',
    });
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      this.botUsername = data.login;
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] failed to resolve bot identity: ${err}\n`,
      );
      this.botUsername = null;
    }
    this.startPollLoop();
  }

  disconnect(): void {
    this.stopPollLoop();
  }

  async sendMessage(_chatId: string, _text: string): Promise<void> {
    throw new Error(
      `[Channel:${this.name}] sendMessage requires a threadId; use sendThreadMessage`,
    );
  }

  protected override async sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
  ): Promise<void> {
    if (!threadId) {
      process.stderr.write(
        `[Channel:${this.name}] cannot deliver response: no threadId\n`,
      );
      return;
    }
    const match = threadId.match(/^(?:issue|pr):(\d+)$/);
    if (!match) {
      process.stderr.write(
        `[Channel:${this.name}] invalid threadId format: ${threadId}\n`,
      );
      return;
    }
    const issueNumber = Number(match[1]);
    await this.octokit.rest.issues.createComment({
      owner: chatId.split('/')[0],
      repo: chatId.split('/')[1],
      issue_number: issueNumber,
      body: text,
    });
  }

  protected async pollOnce(): Promise<void> {
    const since = new Date(
      new Date(this.cursor.lastProcessedAt).getTime() - 1000,
    ).toISOString();

    const notifications = await this.octokit.paginate(
      this.octokit.rest.activity.listNotificationsForAuthenticatedUser,
      { since, per_page: 100 },
    );

    let maxUpdatedAt = this.cursor.lastProcessedAt;

    for (const notification of notifications) {
      const updatedAt = notification.updated_at;
      if (updatedAt > maxUpdatedAt) maxUpdatedAt = updatedAt;

      const extracted = this.extractFromSubjectUrl(notification.subject.url);
      if (!extracted) {
        await this.markThreadAsRead(notification.id);
        continue;
      }

      const { chatId, threadId, issueNumber } = extracted;
      const lastReadAt = notification.last_read_at;
      const windowSince = lastReadAt || since;

      try {
        const comments = await this.octokit.paginate(
          this.octokit.rest.issues.listComments,
          {
            owner: chatId.split('/')[0],
            repo: chatId.split('/')[1],
            issue_number: issueNumber,
            since: windowSince,
            per_page: 100,
          },
        );

        const newComments = comments.filter((c) => {
          if (
            c.user?.login &&
            this.botUsername &&
            c.user.login.toLowerCase() === this.botUsername.toLowerCase()
          ) {
            return false;
          }
          if (this.recentlyProcessed.has(String(c.id))) return false;
          return true;
        });

        for (const comment of newComments) {
          const body = comment.body || '';
          const isMentioned = this.botUsername
            ? testBotMention(body, this.botUsername)
            : false;

          if (this.requireMention && !isMentioned) continue;

          const text = this.botUsername
            ? stripBotMention(body, this.botUsername)
            : body;

          const envelope: Envelope = {
            channelName: this.name,
            senderId: comment.user?.login || 'unknown',
            senderName: comment.user?.login || 'unknown',
            chatId,
            threadId,
            messageId: String(comment.id),
            text,
            isGroup: true,
            isMentioned,
            isReplyToBot: false,
            metadata: this.buildMetadata(chatId, threadId, notification),
          };

          try {
            await this.handleInbound(envelope);
          } catch (err) {
            process.stderr.write(
              `[Channel:${this.name}] handleInbound failed for comment ${comment.id}: ${err}\n`,
            );
            await this.postErrorComment(chatId, issueNumber);
          }
          this.recentlyProcessed.add(String(comment.id));
        }

        if (newComments.length === 0 && !lastReadAt) {
          await this.tryFirstContactBody(
            chatId,
            threadId,
            issueNumber,
            notification,
          );
        }
      } finally {
        await this.markThreadAsRead(notification.id);
      }
    }

    if (maxUpdatedAt > this.cursor.lastProcessedAt) {
      this.cursor.lastProcessedAt = maxUpdatedAt;
    }
  }

  private async tryFirstContactBody(
    chatId: string,
    threadId: string,
    issueNumber: number,
    notification: { subject: { title?: string } },
  ): Promise<void> {
    try {
      const { data: issue } = await this.octokit.rest.issues.get({
        owner: chatId.split('/')[0],
        repo: chatId.split('/')[1],
        issue_number: issueNumber,
      });

      const body = issue.body || '';
      const createdAt = issue.created_at;
      if (createdAt <= this.cursor.lastProcessedAt) return;

      const isMentioned = this.botUsername
        ? testBotMention(body, this.botUsername)
        : false;
      if (this.requireMention && !isMentioned) return;

      const text = this.botUsername
        ? stripBotMention(body, this.botUsername)
        : body;

      const envelope: Envelope = {
        channelName: this.name,
        senderId: issue.user?.login || 'unknown',
        senderName: issue.user?.login || 'unknown',
        chatId,
        threadId,
        messageId: `issue-body-${issueNumber}`,
        text,
        isGroup: true,
        isMentioned,
        isReplyToBot: false,
        metadata: this.buildMetadata(chatId, threadId, {
          subject: { title: notification.subject.title },
        }),
      };

      try {
        await this.handleInbound(envelope);
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] handleInbound failed for issue body ${issueNumber}: ${err}\n`,
        );
        await this.postErrorComment(chatId, issueNumber);
      }
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] failed to fetch issue for first contact: ${err}\n`,
      );
    }
  }

  private extractFromSubjectUrl(
    url: string,
  ): { chatId: string; threadId: string; issueNumber: number } | null {
    const match = url.match(/\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    if (!match) return null;
    const chatId = match[1];
    const issueNumber = Number(match[2]);
    const threadId = `issue:${issueNumber}`;
    return { chatId, threadId, issueNumber };
  }

  private buildMetadata(
    chatId: string,
    threadId: string,
    notification: { subject: { title?: string } },
  ): string {
    const type = threadId.startsWith('pr:') ? 'Pull Request' : 'Issue';
    const title = notification.subject.title || '';
    const url = `https://github.com/${chatId}/${threadId.startsWith('pr:') ? 'pull' : 'issues'}/${threadId.split(':')[1]}`;
    return `Type: ${type} | Title: ${title} | URL: ${url}`;
  }

  private async markThreadAsRead(threadId: string): Promise<void> {
    try {
      await this.octokit.rest.activity.markThreadAsRead({
        thread_id: Number(threadId),
      });
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] markThreadAsRead failed for thread ${threadId}: ${err}\n`,
      );
    }
  }

  private async postErrorComment(
    chatId: string,
    issueNumber: number,
  ): Promise<void> {
    try {
      await this.octokit.rest.issues.createComment({
        owner: chatId.split('/')[0],
        repo: chatId.split('/')[1],
        issue_number: issueNumber,
        body: '⚠️ Failed to process this request. Please re-mention the bot to retry.',
      });
    } catch {
      // best-effort
    }
  }
}
