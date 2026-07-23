import { giteaApi } from 'gitea-js';
import type { Comment, NotificationThread } from 'gitea-js';
import {
  ChannelBase,
  parseChatId,
  parseIssueThreadId,
  extractFromSubjectUrl,
  loadPollCursor,
  savePollCursor,
  stripBotMention,
  abortableSleep,
} from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class GiteaChannel extends ChannelBase {
  private client: ReturnType<typeof giteaApi>;
  private abortController: AbortController | null = null;
  private pollGeneration = 0;
  private lastProcessedAt: string;
  private readonly pollIntervalMs: number;
  private botUsername: string | null = null;

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    const cursor = loadPollCursor(name);
    this.lastProcessedAt = cursor.timestamp || new Date().toISOString();
    const baseUrl = (config['baseUrl'] as string) || 'https://gitea.com';
    this.client = giteaApi(baseUrl, { token: this.config.token });
    this.pollIntervalMs =
      typeof config['pollInterval'] === 'number' &&
      config['pollInterval'] >= 5_000
        ? config['pollInterval']
        : DEFAULT_POLL_INTERVAL_MS;
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  override supportsProactiveTarget(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    try {
      const { data: user } = await this.client.user.userGetCurrent();
      this.botUsername = user.login ?? null;
    } catch {
      // bot username unavailable — isMentioned will be conservative
    }
    const gen = ++this.pollGeneration;
    this.runPollLoop(signal, gen).catch((err) => {
      if (!signal.aborted && gen === this.pollGeneration) {
        process.stderr.write(
          `[Gitea:${this.name}] poll loop error: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    });
  }

  override sendMessage(_chatId: string, _text: string): Promise<void> {
    throw new Error(
      `Gitea channel does not support sendMessage. Use sendThreadMessage instead.`,
    );
  }

  override async sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
  ): Promise<void> {
    const chat = parseChatId(chatId);
    if (!chat) {
      process.stderr.write(
        `[Gitea:${this.name}] unrecognized chatId: ${chatId}\n`,
      );
      return;
    }
    if (!threadId) {
      process.stderr.write(
        `[Gitea:${this.name}] no threadId for ${chatId}, cannot send reply\n`,
      );
      return;
    }
    const thread = parseIssueThreadId(threadId);
    if (!thread) {
      process.stderr.write(
        `[Gitea:${this.name}] unrecognized threadId: ${threadId}\n`,
      );
      return;
    }
    await this.client.repos.issueCreateComment(
      chat.owner,
      chat.repo,
      thread.number,
      { body: text },
    );
  }

  disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async runPollLoop(signal: AbortSignal, gen: number): Promise<void> {
    let consecutiveErrors = 0;
    while (!signal.aborted && gen === this.pollGeneration) {
      try {
        await this.pollNotifications();
        consecutiveErrors = 0;
      } catch (err) {
        if (signal.aborted) break;
        consecutiveErrors++;
        process.stderr.write(
          `[Gitea:${this.name}] poll error (${consecutiveErrors}): ${err instanceof Error ? err.message : err}\n`,
        );
        if (consecutiveErrors >= 3) {
          await abortableSleep(30_000, signal);
        } else {
          await abortableSleep(2_000, signal);
        }
        continue;
      }
      await abortableSleep(this.pollIntervalMs, signal);
    }
  }

  private async pollNotifications(): Promise<void> {
    const oldCursor = this.lastProcessedAt;

    // Fetch all notifications since cursor
    const notifications: NotificationThread[] = [];
    let page = 1;
    while (true) {
      let apiSince: string | undefined;
      if (oldCursor) {
        const parsed = new Date(oldCursor).getTime();
        if (!Number.isNaN(parsed)) {
          apiSince = new Date(parsed - 1000).toISOString();
        }
      }
      const params = apiSince
        ? { since: apiSince, limit: 100, page }
        : { limit: 100, page };
      const { data: batch } =
        await this.client.notifications.notifyGetList(params);
      notifications.push(...batch);
      if (batch.length === 0) break;
      page++;
    }

    if (notifications.length === 0) return;

    notifications.sort((a, b) =>
      (a.updated_at ?? '').localeCompare(b.updated_at ?? ''),
    );

    // Pass 1: find max_updated_at across all notifications
    let maxUpdatedAt = '';
    for (const n of notifications) {
      const ua = n.updated_at ?? '';
      if (ua > maxUpdatedAt) maxUpdatedAt = ua;
    }

    // Pass 2: for each notification, enumerate comments in (oldCursor, maxUpdatedAt]
    for (const notification of notifications) {
      const nid = String(notification.id);
      const updatedAt = notification.updated_at ?? '';
      if (!updatedAt) continue;
      if (updatedAt < oldCursor) continue;

      const extracted = extractFromSubjectUrl(notification.subject?.url);
      const repoName = notification.repository?.full_name ?? 'unknown';

      try {
        if (oldCursor && extracted) {
          // Existing cursor — enumerate comments since oldCursor
          const [repoOwner, repoNamePart] = repoName.split('/');
          if (!repoOwner || !repoNamePart) continue;

          const comments = await this.enumerateComments(
            repoOwner,
            repoNamePart,
            extracted.number,
            oldCursor,
            maxUpdatedAt,
          );

          if (comments.length === 0) continue;

          for (const comment of comments) {
            const envelope = this.buildEnvelopeFromComment(
              comment,
              notification,
              extracted,
              repoName,
            );
            try {
              await this.handleInbound(envelope);
            } catch (err) {
              process.stderr.write(
                `[Gitea:${this.name}] error processing comment ${comment.id} in ${nid}: ${err instanceof Error ? err.message : err}\n`,
              );
              try {
                await this.sendThreadMessage(
                  envelope.chatId,
                  envelope.threadId,
                  'Sorry, something went wrong processing your message.',
                );
              } catch {
                // best effort
              }
            }
          }
        } else {
          // First encounter (no cursor) — feed issue/PR body
          const envelope = await this.buildEnvelopeFromBody(
            notification,
            extracted,
            repoName,
          );
          try {
            await this.handleInbound(envelope);
          } catch (err) {
            process.stderr.write(
              `[Gitea:${this.name}] error processing notification ${nid}: ${err instanceof Error ? err.message : err}\n`,
            );
            try {
              await this.sendThreadMessage(
                envelope.chatId,
                envelope.threadId,
                'Sorry, something went wrong processing your message.',
              );
            } catch {
              // best effort
            }
          }
        }
      } finally {
        try {
          await this.client.notifications.notifyReadThread(nid);
        } catch (err) {
          process.stderr.write(
            `[Gitea:${this.name}] failed to mark notification ${nid} as read: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }
    }

    // Advance cursor to max_updated_at
    this.advanceCursor(maxUpdatedAt);
  }

  private async enumerateComments(
    owner: string,
    repo: string,
    issueNumber: number,
    since: string,
    maxUpdatedAt: string,
  ): Promise<Comment[]> {
    const comments: Comment[] = [];
    try {
      const { data } = await this.client.repos.issueGetComments(
        owner,
        repo,
        issueNumber,
        { since },
      );
      // Filter: old_cursor < created_at <= max_updated_at
      for (const c of data) {
        const createdAt = c.created_at ?? '';
        if (createdAt > since && createdAt <= maxUpdatedAt) {
          comments.push(c);
        }
      }
    } catch {
      // comments unavailable
    }
    comments.sort((a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    );
    return comments;
  }

  private buildEnvelopeFromComment(
    comment: Comment,
    notification: NotificationThread,
    extracted: {
      type: string;
      owner: string;
      repo: string;
      number: number;
    } | null,
    repoName: string,
  ): Envelope {
    const body = comment.body ?? '';
    const content =
      body && this.botUsername ? stripBotMention(body, this.botUsername) : body;

    const metadata = [
      `Type: ${notification.subject?.type ?? 'unknown'}`,
      `Title: ${notification.subject?.title ?? ''}`,
      ...(notification.subject?.html_url
        ? [`URL: ${notification.subject.html_url}`]
        : []),
    ].join('\n');

    return {
      channelName: this.name,
      senderId: comment.user?.login ?? 'unknown',
      senderName: comment.user?.login ?? 'unknown',
      chatId: repoName,
      threadId: extracted ? `${extracted.type}:${extracted.number}` : undefined,
      messageId: String(comment.id),
      text: content,
      metadata,
      isGroup: true,
      isMentioned: content !== body,
      isReplyToBot: false,
    };
  }

  private async buildEnvelopeFromBody(
    notification: NotificationThread,
    extracted: {
      type: string;
      owner: string;
      repo: string;
      number: number;
    } | null,
    repoName: string,
  ): Promise<Envelope> {
    let body = '';
    let senderUsername = repoName;
    let prBranch: string | undefined;
    const subjectType = (notification.subject?.type ?? '').toLowerCase();

    if (subjectType === 'pull' && extracted?.type === 'pr') {
      try {
        const { data: pr } = await this.client.repos.repoGetPullRequest(
          extracted.owner,
          extracted.repo,
          extracted.number,
        );
        prBranch = pr.head?.ref;
        body = pr.body ?? '';
        senderUsername = pr.user?.login ?? repoName;
      } catch {
        // unavailable
      }
    } else if (extracted) {
      try {
        const { data: issue } = await this.client.repos.issueGetIssue(
          extracted.owner,
          extracted.repo,
          extracted.number,
        );
        body = issue.body ?? '';
        senderUsername = issue.user?.login ?? repoName;
      } catch {
        // unavailable
      }
    }

    if (senderUsername === repoName) {
      process.stderr.write(
        `[Gitea:${this.name}] could not resolve sender for ${repoName}, using repo name as fallback\n`,
      );
    }

    const metadata = [
      `Type: ${subjectType === 'pull' ? 'PullRequest' : subjectType === 'issue' ? 'Issue' : subjectType}`,
      `Title: ${notification.subject?.title ?? ''}`,
      ...(notification.subject?.html_url
        ? [`URL: ${notification.subject.html_url}`]
        : []),
      ...(prBranch ? [`Branch: ${prBranch}`] : []),
    ].join('\n');

    const content =
      body && this.botUsername
        ? stripBotMention(body, this.botUsername)
        : (body ?? '');

    return {
      channelName: this.name,
      senderId: senderUsername,
      senderName: senderUsername,
      chatId: repoName,
      threadId: extracted ? `${extracted.type}:${extracted.number}` : undefined,
      messageId: String(notification.id),
      text: content,
      metadata,
      isGroup: true,
      isMentioned: content !== body,
      isReplyToBot: false,
    };
  }

  private advanceCursor(timestamp: string): void {
    if (!timestamp) return;
    if (timestamp > this.lastProcessedAt) {
      this.lastProcessedAt = timestamp;
    }
    savePollCursor(this.name, this.lastProcessedAt);
  }
}
