import { giteaApi } from 'gitea-js';
import type { NotificationThread } from 'gitea-js';
import {
  ChannelBase,
  parseChatId,
  parseIssueThreadId,
  extractFromSubjectUrl,
  extractCommentIdFromUrl,
  loadPollCursor,
  savePollCursor,
  stripBotMention,
  escapeRegex,
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
  private processedIdsAtCursor: Set<string> = new Set();
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
    this.processedIdsAtCursor = cursor.processedIds;
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
      // bot username unavailable — isReplyToBot will be conservative
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
    const notifications: NotificationThread[] = [];
    let page = 1;
    while (true) {
      let apiSince: string | undefined;
      if (this.lastProcessedAt) {
        const parsed = new Date(this.lastProcessedAt).getTime();
        if (Number.isNaN(parsed)) {
          this.lastProcessedAt = '';
        } else {
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
    notifications.sort((a, b) =>
      (a.updated_at ?? '').localeCompare(b.updated_at ?? ''),
    );
    for (const notification of notifications) {
      const nid = String(notification.id);
      const updatedAt = notification.updated_at ?? '';
      if (!updatedAt) continue;
      if (updatedAt < this.lastProcessedAt) continue;
      if (
        updatedAt === this.lastProcessedAt &&
        this.processedIdsAtCursor.has(nid)
      )
        continue;
      let envelope: Envelope | undefined;
      try {
        envelope = await this.buildEnvelope(notification);
      } catch (err) {
        process.stderr.write(
          `[Gitea:${this.name}] error building envelope for ${nid}: ${err instanceof Error ? err.message : err}\n`,
        );
        this.advanceCursor(updatedAt, nid);
        try {
          await this.client.notifications.notifyReadThread(nid);
        } catch {
          /* best effort */
        }
        continue;
      }
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
      this.advanceCursor(updatedAt, nid);
      try {
        await this.client.notifications.notifyReadThread(nid);
      } catch (err) {
        process.stderr.write(
          `[Gitea:${this.name}] failed to mark notification ${nid} as read: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
  }

  private advanceCursor(timestamp: string, id: string): void {
    if (!timestamp) return;
    if (timestamp > this.lastProcessedAt) {
      this.lastProcessedAt = timestamp;
      this.processedIdsAtCursor = new Set([id]);
    } else {
      this.processedIdsAtCursor.add(id);
    }
    savePollCursor(this.name, this.lastProcessedAt, this.processedIdsAtCursor);
  }

  private async buildEnvelope(
    notification: NotificationThread,
  ): Promise<Envelope> {
    const repoName = notification.repository?.full_name ?? 'unknown';
    const rawSubjectType = notification.subject?.type ?? 'unknown';
    const subjectType = rawSubjectType.toLowerCase();
    const subjectTitle = notification.subject?.title ?? '';
    const subjectUrl = notification.subject?.url;

    const extracted = extractFromSubjectUrl(subjectUrl);

    let prBranch: string | undefined;
    let body = '';
    let prSender: string | undefined;
    if (subjectType === 'pull' && extracted?.type === 'pr') {
      try {
        const { data: pr } = await this.client.repos.repoGetPullRequest(
          extracted.owner,
          extracted.repo,
          extracted.number,
        );
        prBranch = pr.head?.ref;
        body = pr.body ?? '';
        prSender = pr.user?.login;
      } catch {
        // branch info unavailable
      }
    }

    let senderUsername = prSender ?? repoName;
    let commentSenderResolved = false;
    const commentId = extractCommentIdFromUrl(
      notification.subject?.latest_comment_url,
    );
    if (commentId && extracted) {
      try {
        const { data: comment } = await this.client.repos.issueGetComment(
          extracted.owner,
          extracted.repo,
          commentId,
        );
        senderUsername = comment.user?.login ?? repoName;
        body = comment.body ?? '';
        commentSenderResolved = true;
      } catch {
        // fall through to issue fallback
      }
    }
    if (!commentSenderResolved && senderUsername === repoName && extracted) {
      try {
        const { data: issue } = await this.client.repos.issueGetIssue(
          extracted.owner,
          extracted.repo,
          extracted.number,
        );
        senderUsername = issue.user?.login ?? repoName;
        if (!body) body = issue.body ?? '';
      } catch {
        // fallback to repo name
      }
    }
    if (senderUsername === repoName) {
      process.stderr.write(
        `[Gitea:${this.name}] could not resolve sender for ${repoName}, using repo name as fallback\n`,
      );
    }

    const metadata = [
      `Type: ${subjectType === 'pull' ? 'PullRequest' : subjectType === 'issue' ? 'Issue' : subjectType}`,
      `Title: ${subjectTitle}`,
      ...(notification.subject?.html_url
        ? [`URL: ${notification.subject.html_url}`]
        : []),
      ...(prBranch ? [`Branch: ${prBranch}`] : []),
    ].join('\n');
    const content =
      body && this.botUsername
        ? stripBotMention(body, this.botUsername)
        : (body ?? '');
    const isMentioned = this.botUsername
      ? new RegExp(
          `(?<=\\s|^|[([{"<])@${escapeRegex(this.botUsername)}(?=[^a-zA-Z0-9_/-]|$)`,
        ).test(body)
      : false;

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
      isMentioned,
      isReplyToBot: false,
    };
  }
}
