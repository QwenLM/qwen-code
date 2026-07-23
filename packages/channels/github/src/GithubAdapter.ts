import { Octokit } from '@octokit/rest';
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

interface NotificationComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
}

export class GithubChannel extends ChannelBase {
  private octokit: Octokit;
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
    this.octokit = new Octokit({
      auth: this.config.token,
      baseUrl: (config['baseUrl'] as string) || undefined,
    });
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
      const { data: user } = await this.octokit.rest.users.getAuthenticated();
      this.botUsername = user.login ?? null;
    } catch {
      // bot username unavailable — isMentioned will be conservative
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
      process.stderr.write(
        `[GitHub:${this.name}] no threadId for ${chatId}, cannot send reply\n`,
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
    let apiSince: string | undefined;
    if (this.lastProcessedAt) {
      const parsed = new Date(this.lastProcessedAt).getTime();
      if (Number.isNaN(parsed)) {
        this.lastProcessedAt = '';
      } else {
        apiSince = new Date(parsed - 1000).toISOString();
      }
    }
    const notifications = await this.octokit.paginate(
      this.octokit.rest.activity.listNotificationsForAuthenticatedUser,
      {
        per_page: 100,
        ...(apiSince ? { since: apiSince } : {}),
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

      const lastReadAt = notification.last_read_at ?? '';
      const extracted = extractFromSubjectUrl(notification.subject.url);
      const repoName = notification.repository.full_name;
      const [repoOwner, repoNamePart] = repoName.split('/');

      try {
        if (lastReadAt && extracted && repoOwner && repoNamePart) {
          // Existing notification — enumerate comments since last_read_at
          const comments = await this.enumerateComments(
            extracted,
            repoOwner,
            repoNamePart,
            notification.subject.type,
            lastReadAt,
          );

          if (comments.length === 0) {
            // No new comments (push/label/etc.) — skip
            this.advanceCursor(updatedAt);
            continue;
          }

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
                `[GitHub:${this.name}] error processing comment ${comment.id} in ${nid}: ${err instanceof Error ? err.message : err}\n`,
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
          // First encounter (no last_read_at) — feed PR/issue body
          const envelope = await this.buildEnvelopeFromBody(
            notification,
            extracted,
            repoName,
          );
          try {
            await this.handleInbound(envelope);
          } catch (err) {
            process.stderr.write(
              `[GitHub:${this.name}] error processing notification ${nid}: ${err instanceof Error ? err.message : err}\n`,
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
        this.advanceCursor(updatedAt);
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
  }

  private async enumerateComments(
    extracted: { type: string; owner: string; repo: string; number: number },
    repoOwner: string,
    repoNamePart: string,
    subjectType: string,
    since: string,
  ): Promise<NotificationComment[]> {
    const comments: NotificationComment[] = [];

    // Issue / PR regular comments
    try {
      await this.octokit.paginate(
        this.octokit.rest.issues.listComments,
        {
          owner: repoOwner,
          repo: repoNamePart,
          issue_number: extracted.number,
          since,
          per_page: 100,
        },
        (response, done) => {
          const items = response.data.map((c) => ({
            id: c.id,
            user: c.user ? { login: c.user.login ?? 'ghost' } : null,
            body: c.body ?? '',
            created_at: c.created_at ?? '',
          }));
          comments.push(...items);
          if (response.data.length < 100) done();
          return items;
        },
      );
    } catch {
      // comments unavailable
    }

    // PR review comments (diff-line comments)
    if (subjectType === 'PullRequest') {
      try {
        await this.octokit.paginate(
          this.octokit.rest.pulls.listReviewComments,
          {
            owner: repoOwner,
            repo: repoNamePart,
            pull_number: extracted.number,
            per_page: 100,
          },
          (response, done) => {
            const items = response.data
              .filter((c) => (c.updated_at ?? c.created_at ?? '') > since)
              .map((c) => ({
                id: c.id,
                user: c.user ? { login: c.user.login ?? 'ghost' } : null,
                body: c.body ?? '',
                created_at: c.created_at ?? '',
              }));
            comments.push(...items);
            if (response.data.length < 100) done();
            return items;
          },
        );
      } catch {
        // review comments unavailable
      }
    }

    comments.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return comments;
  }

  private buildEnvelopeFromComment(
    comment: NotificationComment,
    notification: {
      id: string;
      reason: string;
      subject: { title: string; url: string | null; type: string };
      repository: { full_name: string; html_url: string };
    },
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
      `Type: ${notification.subject.type}`,
      `Title: ${notification.subject.title}`,
      `Reason: ${notification.reason}`,
      ...(extracted
        ? [
            `URL: https://${new URL(notification.repository.html_url).host}/${extracted.owner}/${extracted.repo}/${extracted.type === 'pr' ? 'pull' : 'issues'}/${extracted.number}`,
          ]
        : []),
    ].join('\n');

    return {
      channelName: this.name,
      senderId: comment.user?.login ?? 'ghost',
      senderName: comment.user?.login ?? 'ghost',
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
    notification: {
      id: string;
      reason: string;
      subject: { title: string; url: string | null; type: string };
      repository: { full_name: string; html_url: string };
      updated_at: string;
    },
    extracted: {
      type: string;
      owner: string;
      repo: string;
      number: number;
    } | null,
    repoName: string,
  ): Promise<Envelope> {
    let body = '';
    let senderLogin = repoName;
    let prBranch: string | undefined;

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
        senderLogin = pr.user?.login ?? repoName;
      } catch {
        // unavailable
      }
    } else if (extracted) {
      try {
        const { data: issue } = await this.octokit.rest.issues.get({
          owner: extracted.owner,
          repo: extracted.repo,
          issue_number: extracted.number,
        });
        body = issue.body ?? '';
        senderLogin = issue.user?.login ?? repoName;
      } catch {
        // unavailable
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

    const content =
      body && this.botUsername
        ? stripBotMention(body, this.botUsername)
        : (body ?? '');

    return {
      channelName: this.name,
      senderId: senderLogin,
      senderName: senderLogin,
      chatId: repoName,
      threadId: extracted ? `${extracted.type}:${extracted.number}` : undefined,
      messageId: notification.id,
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
