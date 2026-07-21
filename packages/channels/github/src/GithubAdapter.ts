import { Octokit } from '@octokit/rest';
import {
  ChannelBase,
  parseChatId,
  parseIssueThreadId,
  extractFromSubjectUrl,
  extractCommentIdFromUrl,
  loadPollCursor,
  savePollCursor,
  stripMentions,
  abortableSleep,
} from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

const MENTION_REASONS = new Set(['mention', 'team_mention']);

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class GithubChannel extends ChannelBase {
  private octokit: Octokit;
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
    this.lastProcessedAt = cursor.timestamp;
    this.processedIdsAtCursor = cursor.processedIds;
    this.octokit = new Octokit({
      auth: this.config.token,
      baseUrl: (config['baseUrl'] as string) || undefined,
    });
    this.pollIntervalMs =
      typeof config['pollInterval'] === 'number'
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
      const { data: user } = await this.octokit.rest.users.getAuthenticated();
      this.botUsername = user.login ?? null;
    } catch {
      // bot username unavailable — isReplyToBot will be conservative
    }
    const gen = ++this.pollGeneration;
    this.runPollLoop(signal, gen).catch((err) => {
      if (!signal.aborted && gen === this.pollGeneration) {
        process.stderr.write(
          `[GitHub:${this.name}] poll loop error: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    });
  }

  override sendMessage(_chatId: string, _text: string): Promise<void> {
    throw new Error(
      `GitHub channel does not support sendMessage. Use sendThreadMessage instead.`,
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
        `[GitHub:${this.name}] unrecognized chatId: ${chatId}\n`,
      );
      return;
    }
    if (!threadId) {
      const { data: issue } = await this.octokit.rest.issues.create({
        owner: chat.owner,
        repo: chat.repo,
        title: text.split('\n')[0]!.trim().slice(0, 250) || 'New issue',
        body: text,
      });
      process.stderr.write(
        `[GitHub:${this.name}] created issue #${issue.number} in ${chat.owner}/${chat.repo}\n`,
      );
      return;
    }
    const thread = parseIssueThreadId(threadId);
    if (!thread) {
      process.stderr.write(
        `[GitHub:${this.name}] unrecognized threadId: ${threadId}\n`,
      );
      return;
    }
    await this.octokit.rest.issues.createComment({
      owner: chat.owner,
      repo: chat.repo,
      issue_number: thread.number,
      body: text,
    });
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
          `[GitHub:${this.name}] poll error (${consecutiveErrors}): ${err instanceof Error ? err.message : err}\n`,
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
    const notifications = await this.octokit.paginate(
      this.octokit.rest.activity.listNotificationsForAuthenticatedUser,
      {
        per_page: 100,
        ...(this.lastProcessedAt ? { since: this.lastProcessedAt } : {}),
      },
    );
    notifications.sort((a, b) =>
      (a.updated_at ?? '').localeCompare(b.updated_at ?? ''),
    );
    for (const notification of notifications) {
      const nid = notification.id;
      const updatedAt = notification.updated_at;
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
          `[GitHub:${this.name}] error building envelope for ${nid}: ${err instanceof Error ? err.message : err}\n`,
        );
        this.advanceCursor(updatedAt, nid);
        try {
          await this.octokit.rest.activity.markThreadAsRead({
            thread_id: Number(nid),
          });
        } catch {
          /* best effort */
        }
        continue;
      }
      try {
        await this.handleInbound(envelope);
      } catch (err) {
        process.stderr.write(
          `[GitHub:${this.name}] error processing notification ${nid}: ${err instanceof Error ? err.message : err}\n`,
        );
      }
      this.advanceCursor(updatedAt, nid);
      try {
        await this.octokit.rest.activity.markThreadAsRead({
          thread_id: Number(nid),
        });
      } catch (err) {
        process.stderr.write(
          `[GitHub:${this.name}] failed to mark notification ${nid} as read: ${err instanceof Error ? err.message : err}\n`,
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

  private async buildEnvelope(notification: {
    id: string;
    reason: string;
    subject: {
      title: string;
      url: string | null;
      latest_comment_url: string | null;
      type: string;
    };
    repository: { full_name: string; html_url: string };
    updated_at: string;
  }): Promise<Envelope> {
    const extracted = extractFromSubjectUrl(notification.subject.url);
    const repoName = notification.repository.full_name;
    const [repoOwner, repoNamePart] = repoName.split('/');

    let prBranch: string | undefined;
    let body = '';
    let prSender: string | undefined;
    if (
      notification.subject.type === 'PullRequest' &&
      extracted?.type === 'pr'
    ) {
      try {
        const { data: pr } = await this.octokit.rest.pulls.get({
          owner: extracted.owner,
          repo: extracted.repo,
          pull_number: extracted.number,
        });
        prBranch = pr.head?.ref;
        body = pr.body ?? '';
        prSender = pr.user?.login;
      } catch {
        // branch info unavailable
      }
    }

    let senderLogin: string = prSender ?? repoName;
    let commentSenderResolved = false;
    const commentId = extractCommentIdFromUrl(
      notification.subject.latest_comment_url,
    );
    if (commentId && repoOwner && repoNamePart) {
      let commentResolved = false;
      try {
        const { data: comment } = await this.octokit.rest.issues.getComment({
          owner: repoOwner,
          repo: repoNamePart,
          comment_id: commentId,
        });
        senderLogin = comment.user?.login ?? 'ghost';
        body = comment.body ?? '';
        commentResolved = true;
        commentSenderResolved = true;
      } catch {
        // not an issue comment — try PR review comment
      }
      if (!commentResolved) {
        try {
          const { data: reviewComment } =
            await this.octokit.rest.pulls.getReviewComment({
              owner: repoOwner,
              repo: repoNamePart,
              comment_id: commentId,
            });
          senderLogin = reviewComment.user?.login ?? 'ghost';
          body = reviewComment.body ?? '';
          commentSenderResolved = true;
        } catch {
          // fall through to issue fallback
        }
      }
    }
    if (!commentSenderResolved && senderLogin === repoName && extracted) {
      try {
        const { data: issue } = await this.octokit.rest.issues.get({
          owner: extracted.owner,
          repo: extracted.repo,
          issue_number: extracted.number,
        });
        senderLogin = issue.user?.login ?? repoName;
        if (!body) body = issue.body ?? '';
      } catch {
        // fallback to repo name
      }
    }
    if (senderLogin === repoName) {
      process.stderr.write(
        `[GitHub:${this.name}] could not resolve sender for ${repoName}, using repo name as fallback\n`,
      );
    }

    const metadata = [
      `Type: ${notification.subject.type}`,
      `Title: ${notification.subject.title}`,
      `Reason: ${notification.reason}`,
      ...(extracted
        ? [
            `URL: https://${new URL(notification.repository.html_url).host}/${extracted.owner}/${extracted.repo}/${extracted.type === 'pr' ? 'pull' : 'issues'}/${extracted.number}`,
            ...(prBranch ? [`Branch: ${prBranch}`] : []),
          ]
        : []),
    ].join('\n');
    const content = body ? stripMentions(body) : '';

    return {
      channelName: this.name,
      senderId: senderLogin,
      senderName: senderLogin,
      chatId: repoName,
      threadId: extracted ? `${extracted.type}:${extracted.number}` : undefined,
      messageId: notification.id,
      text: content ? `${content}\n\n${metadata}` : metadata,
      isGroup: true,
      isMentioned: MENTION_REASONS.has(notification.reason),
      isReplyToBot:
        this.botUsername !== null && notification.reason === 'author',
    };
  }
}
