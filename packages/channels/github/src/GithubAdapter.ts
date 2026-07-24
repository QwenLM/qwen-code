import process from 'node:process';
import { Octokit } from '@octokit/rest';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import { PollingChannelBase } from '@qwen-code/channel-base';
import { testBotMention, stripBotMention } from './mention.js';

interface GithubConfig extends ChannelConfig {
  baseUrl?: string;
}

interface GithubCursor {
  lastProcessedAt: string;
}

export class GithubChannel extends PollingChannelBase<GithubCursor> {
  private octokit!: Octokit;
  private botUsername: string | null = null;

  constructor(
    name: string,
    config: GithubConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
  }

  protected createInitialCursor(): GithubCursor {
    return { lastProcessedAt: new Date().toISOString() };
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
      throw new Error(
        `[Channel:${this.name}] failed to resolve bot identity: ${err}`,
      );
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
      return super.sendThreadMessage(chatId, threadId, text);
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

    const notifications = await this.githubApi(
      () =>
        this.octokit.paginate(
          this.octokit.rest.activity.listNotificationsForAuthenticatedUser,
          { since, per_page: 100 },
        ),
      'listNotifications',
    );

    notifications.sort((a, b) => a.updated_at.localeCompare(b.updated_at));

    const maxUpdatedAt =
      notifications.length > 0
        ? notifications[notifications.length - 1].updated_at
        : this.cursor.lastProcessedAt;

    for (const notification of notifications) {
      const extracted = this.extractFromSubjectUrl(notification.subject.url);
      if (!extracted) {
        continue;
      }

      const { chatId, threadId, issueNumber } = extracted;
      const lastReadAt = notification.last_read_at;
      const windowSince = lastReadAt || since;

      try {
        const comments = await this.githubApi(
          () =>
            this.octokit.paginate(this.octokit.rest.issues.listComments, {
              owner: chatId.split('/')[0],
              repo: chatId.split('/')[1],
              issue_number: issueNumber,
              since: windowSince,
              per_page: 100,
            }),
          `listComments(${threadId})`,
        );

        comments.sort((a, b) =>
          (a.created_at || '').localeCompare(b.created_at || ''),
        );

        const newComments = comments.filter((c) => {
          if (
            c.user?.login &&
            this.botUsername &&
            c.user.login.toLowerCase() === this.botUsername.toLowerCase()
          ) {
            return false;
          }
          return true;
        });

        let dispatchedMention = false;

        for (const comment of newComments) {
          const body = comment.body || '';
          const isMentioned = this.botUsername
            ? testBotMention(body, this.botUsername)
            : false;

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
            if (isMentioned) dispatchedMention = true;
          } catch (err) {
            process.stderr.write(
              `[Channel:${this.name}] handleInbound failed for comment ${comment.id}: ${err}\n`,
            );
            await this.postErrorComment(chatId, issueNumber);
          }
        }

        if (!dispatchedMention && !lastReadAt) {
          await this.tryFirstContactBody(
            chatId,
            threadId,
            issueNumber,
            notification,
          );
        }
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] API error processing ${threadId}, stopping batch: ${err}\n`,
        );
        break;
      }
    }

    if (maxUpdatedAt > this.cursor.lastProcessedAt) {
      await this.markNotificationsAsRead(maxUpdatedAt);
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
    const match = url.match(/\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)/);
    if (!match) return null;
    const chatId = match[1];
    const kind = match[2] === 'pulls' ? 'pr' : 'issue';
    const issueNumber = Number(match[3]);
    const threadId = `${kind}:${issueNumber}`;
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

  private async githubApi<T>(
    fn: () => Promise<T>,
    label: string,
    retries = 3,
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        if (attempt === retries) throw err;
        // Octokit RequestError: { status, response?: { headers } }
        const e = err as {
          status?: number;
          response?: { headers?: Record<string, string | number> };
          message?: string;
        };
        const headers = e.response?.headers ?? {};

        let cooldown: number;
        if (headers['retry-after']) {
          cooldown = Number(headers['retry-after']) * 1000;
        } else if (
          (e.status === 403 || e.status === 429) &&
          Number(headers['x-ratelimit-remaining']) === 0 &&
          Number(headers['x-ratelimit-reset']) > 0
        ) {
          cooldown =
            Math.max(
              0,
              Number(headers['x-ratelimit-reset']) * 1000 - Date.now(),
            ) + 1000;
        } else {
          cooldown = 1000 * 2 ** (attempt - 1);
        }

        process.stderr.write(
          `[Channel:${this.name}] ${label} failed (attempt ${attempt}/${retries}, status=${e.status}), retrying in ${cooldown}ms: ${e.message}\n`,
        );
        await new Promise((r) => setTimeout(r, cooldown));
      }
    }
    throw new Error('unreachable');
  }

  private async markNotificationsAsRead(lastReadAt: string): Promise<void> {
    await this.githubApi(
      () =>
        this.octokit.rest.activity.markNotificationsAsRead({
          last_read_at: lastReadAt,
          read: true,
        }),
      'markNotificationsAsRead',
    );
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
