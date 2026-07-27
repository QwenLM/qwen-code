import process from 'node:process';
import { Octokit } from '@octokit/rest';
import { HttpsProxyAgent } from 'https-proxy-agent';
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
  /**
   * Thread keys (`chatId|threadId`) whose issue/PR body has already been fed as
   * a first-contact trigger. Dedupes body dispatch when a thread is re-fetched
   * with `last_read_at` still null — which happens if `markNotificationsAsRead`
   * failed to mark it read (its `updated_at` was bumped past the cutoff between
   * fetch and mark). Bounded to the most recent entries so the cursor stays small.
   */
  dispatchedBodies?: string[];
  /**
   * Comment `node_id`s (falling back to numeric `id`) already dispatched. Survives
   * a `markNotificationsAsRead` failure that leaves the cursor un-advanced and
   * causes the next poll to re-fetch the same thread.
   */
  dispatchedComments?: string[];
}

const MAX_DISPATCHED = 500;

type DispatchRoute = 'mention' | 'review' | 'assign' | 'aggregate' | 'generic';

interface GithubComment {
  id: number;
  node_id?: string;
  body?: string;
  created_at?: string | null;
  updated_at?: string | null;
  user?: { id?: number; login?: string } | null;
}

interface LaneContext {
  chatId: string;
  threadId: string;
  issueNumber: number;
  lastReadAt: string | null;
  windowSince: string;
  maxUpdatedAt: string;
  subjectTitle: string;
  reason: string;
}

export class GithubChannel extends PollingChannelBase<GithubCursor> {
  private octokit!: Octokit;
  private botUsername: string | null = null;
  private webOrigin = 'https://github.com';

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

  protected override validateCursor(parsed: unknown): GithubCursor | null {
    const base = super.validateCursor(parsed);
    if (!base || typeof base.lastProcessedAt !== 'string') return null;
    if (Number.isNaN(new Date(base.lastProcessedAt).getTime())) return null;
    delete (base as GithubCursor & { dispatchedNotifications?: unknown })
      .dispatchedNotifications;
    for (const key of ['dispatchedBodies', 'dispatchedComments'] as const) {
      const value = base[key];
      if (value !== undefined && !Array.isArray(value)) {
        (base[key] as string[]) = [];
      }
    }
    return base;
  }

  async connect(): Promise<void> {
    const cfg = this.config as GithubConfig;
    const baseUrl = cfg.baseUrl || 'https://api.github.com';
    this.webOrigin = baseUrl
      .replace(/\/api\/v3\/?$/, '')
      .replace(/^https:\/\/api\.github\.com/, 'https://github.com');
    this.octokit = new Octokit({
      auth: cfg.token,
      baseUrl,
      ...(this.proxy
        ? { request: { agent: new HttpsProxyAgent(this.proxy) } }
        : {}),
    });
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      this.botUsername = data.login;
    } catch (err) {
      throw new Error(
        `[Channel:${this.name}] failed to resolve bot identity: ${err}`,
      );
    }
    // GitHub logins are case-insensitive; normalize both sides so the
    // allowlist gate and ChannelBase's shared-session authorization match
    // regardless of how the operator typed the config entry.
    const allowed = (this.config.allowedUsers ?? []).map((u) =>
      u.toLowerCase(),
    );
    this.config.allowedUsers = allowed;
    this.gate.replaceAllowedUsers(allowed);
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
      throw new Error(
        `[Channel:${this.name}] invalid threadId format: ${threadId}`,
      );
    }
    const issueNumber = Number(match[1]);
    await this.githubApi(
      () =>
        this.octokit.rest.issues.createComment({
          owner: chatId.split('/')[0],
          repo: chatId.split('/')[1],
          issue_number: issueNumber,
          body: text,
        }),
      `createComment(${threadId})`,
    );
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

    // Comment window lower bound: the cursor BEFORE this poll advances it.
    // Comments with updated_at <= windowSince were already eligible for
    // processing in a previous poll — skip them to prevent duplicates when
    // PUT /notifications' async mark fails to mark the thread read.
    const windowSince = this.cursor.lastProcessedAt;

    await this.markNotificationsAsRead(maxUpdatedAt);

    if (maxUpdatedAt > this.cursor.lastProcessedAt) {
      this.cursor.lastProcessedAt = maxUpdatedAt;
    }

    for (const notification of notifications) {
      if (!notification.subject.url) continue;
      const extracted = this.extractFromSubjectUrl(notification.subject.url);
      if (!extracted) {
        continue;
      }

      const { chatId, threadId, issueNumber } = extracted;
      const lastReadAt = notification.last_read_at;
      const route = this.routeByReason(notification.reason, threadId);

      const ctx: LaneContext = {
        chatId,
        threadId,
        issueNumber,
        lastReadAt,
        windowSince,
        maxUpdatedAt,
        subjectTitle: notification.subject.title || '',
        reason: notification.reason,
      };

      try {
        await this.processByRoute(route, ctx);
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] API error processing ${threadId} (${notification.reason}), skipping: ${err}\n`,
        );
        continue;
      }
    }
  }

  private routeByReason(reason: string, threadId: string): DispatchRoute {
    switch (reason) {
      case 'mention':
        return 'mention';
      case 'review_requested':
        return threadId.startsWith('pr:') ? 'review' : 'generic';
      case 'assign':
        return 'assign';
      case 'author':
      case 'comment':
        return 'aggregate';
      default:
        return 'generic';
    }
  }

  private async processByRoute(
    route: DispatchRoute,
    ctx: LaneContext,
  ): Promise<void> {
    switch (route) {
      case 'mention':
        return this.processPerCommentLane(
          ctx,
          true,
          'Trigger: mention. You were @mentioned in this thread.',
        );
      case 'generic':
        return this.processPerCommentLane(
          ctx,
          false,
          `Trigger: ${ctx.reason}.`,
        );
      case 'review':
        return this.processMetaLane(
          ctx,
          'pull',
          'Trigger: review_requested. You were asked to review this pull request.',
        );
      case 'assign': {
        const isPr = ctx.threadId.startsWith('pr:');
        return this.processMetaLane(
          ctx,
          isPr ? 'pull' : 'issue',
          isPr
            ? 'Trigger: assign. You were assigned to this pull request.'
            : 'Trigger: assign. You were assigned to this issue.',
        );
      }
      case 'aggregate':
        return this.processAggregateLane(ctx);
      default:
        return;
    }
  }

  private async processPerCommentLane(
    ctx: LaneContext,
    onlyMentioned: boolean,
    framing: string,
  ): Promise<void> {
    const {
      chatId,
      threadId,
      issueNumber,
      lastReadAt,
      windowSince,
      maxUpdatedAt,
      subjectTitle,
    } = ctx;
    const comments = await this.fetchNewComments(
      chatId,
      threadId,
      issueNumber,
      windowSince,
      maxUpdatedAt,
    );
    let dispatchedMention = false;
    for (const comment of comments) {
      const dedupKey = this.commentDedupKey(comment);
      if (this.isDispatched(this.cursor.dispatchedComments, dedupKey)) continue;
      const body = comment.body || '';
      const isMentioned = this.botUsername
        ? testBotMention(body, this.botUsername)
        : false;
      if (onlyMentioned && !isMentioned) continue;
      const text = this.botUsername
        ? stripBotMention(body, this.botUsername)
        : body;
      const envelope: Envelope = {
        channelName: this.name,
        senderId: (comment.user?.login || 'unknown').toLowerCase(),
        senderName: comment.user?.login || 'unknown',
        chatId,
        threadId,
        messageId: String(comment.id),
        text,
        isGroup: true,
        isMentioned,
        isReplyToBot: false,
        metadata: this.appendFraming(
          this.buildMetadata(chatId, threadId, subjectTitle),
          framing,
        ),
      };
      try {
        await this.handleInbound(envelope);
        this.recordDispatched('dispatchedComments', dedupKey);
        if (isMentioned && this.gate.isAllowed(envelope.senderId))
          dispatchedMention = true;
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] handleInbound failed for comment ${comment.id}: ${err}\n`,
        );
        await this.postErrorComment(chatId, issueNumber);
        this.recordDispatched('dispatchedComments', dedupKey);
        dispatchedMention = true;
        break;
      }
    }
    if (!dispatchedMention && !lastReadAt) {
      await this.tryFirstContactBody(ctx, framing);
    }
  }

  private async processMetaLane(
    ctx: LaneContext,
    kind: 'pull' | 'issue',
    framing: string,
  ): Promise<void> {
    const {
      chatId,
      threadId,
      issueNumber,
      windowSince,
      maxUpdatedAt,
      subjectTitle,
    } = ctx;
    const meta =
      kind === 'pull'
        ? await this.fetchPrMeta(chatId, threadId, issueNumber)
        : await this.fetchIssueMeta(chatId, threadId, issueNumber);
    if (meta.user?.login === this.botUsername) return;
    const comments = await this.fetchNewComments(
      chatId,
      threadId,
      issueNumber,
      windowSince,
      maxUpdatedAt,
    );
    const rawBody = meta.body || '';
    let text = this.botUsername
      ? stripBotMention(rawBody, this.botUsername)
      : rawBody;
    let summaryComments = comments;
    if (!text.trim() && comments.length > 0) {
      const firstComment = comments[0]!;
      const firstBody = firstComment.body || '';
      text = this.botUsername
        ? stripBotMention(firstBody, this.botUsername)
        : firstBody;
      summaryComments = comments.slice(1);
    }
    if (!text.trim())
      text =
        kind === 'pull'
          ? 'Please review this pull request.'
          : 'Please triage this issue.';
    const detail = this.buildMetaDetail(kind, meta);
    const summary = this.buildCommentsSummary(summaryComments);
    const metadata = this.appendFraming(
      this.buildMetadata(chatId, threadId, subjectTitle),
      framing,
      detail,
      summary,
    );
    const envelope: Envelope = {
      channelName: this.name,
      senderId: (meta.user?.login || 'unknown').toLowerCase(),
      senderName: meta.user?.login || 'unknown',
      chatId,
      threadId,
      messageId: `${kind}-body-${issueNumber}`,
      text,
      isGroup: true,
      // review_requested / assign are explicit, directed triggers (the bot was
      // asked to review or assigned) — equivalent to a mention, so the default
      // requireMention group gate must let them through instead of dropping.
      isMentioned: true,
      isReplyToBot: false,
      metadata,
    };
    try {
      await this.handleInbound(envelope);
      this.recordDispatched('dispatchedBodies', `${chatId}|${threadId}`);
      for (const comment of comments) {
        this.recordDispatched(
          'dispatchedComments',
          this.commentDedupKey(comment),
        );
      }
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] handleInbound failed for ${kind} ${issueNumber}: ${err}\n`,
      );
      await this.postErrorComment(chatId, issueNumber);
    }
  }

  private async processAggregateLane(ctx: LaneContext): Promise<void> {
    const {
      chatId,
      threadId,
      issueNumber,
      windowSince,
      maxUpdatedAt,
      subjectTitle,
    } = ctx;
    const comments = await this.fetchNewComments(
      chatId,
      threadId,
      issueNumber,
      windowSince,
      maxUpdatedAt,
    );
    const newComments = comments.filter((c) => {
      const senderId = (c.user?.login || 'unknown').toLowerCase();
      return (
        this.gate.isAllowed(senderId) &&
        !this.isDispatched(
          this.cursor.dispatchedComments,
          this.commentDedupKey(c),
        )
      );
    });
    if (newComments.length === 0) return;
    const first = newComments[0]!;
    const framing =
      'Trigger: new comments on a thread you follow. Review the comments below and respond only if a response is needed.';
    const summary = this.buildCommentsSummary(newComments);
    const metadata = this.appendFraming(
      this.buildMetadata(chatId, threadId, subjectTitle),
      framing,
      summary,
    );
    const envelope: Envelope = {
      channelName: this.name,
      senderId: (first.user?.login || 'unknown').toLowerCase(),
      senderName: first.user?.login || 'unknown',
      chatId,
      threadId,
      messageId: String(first.id),
      text: 'New comments were added to this thread. See the comment list below.',
      isGroup: true,
      isMentioned: true,
      isReplyToBot: false,
      metadata,
    };
    try {
      await this.handleInbound(envelope);
      for (const c of newComments)
        this.recordDispatched('dispatchedComments', this.commentDedupKey(c));
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] handleInbound failed for aggregated comments on ${threadId}: ${err}\n`,
      );
      await this.postErrorComment(chatId, issueNumber);
      for (const c of newComments)
        this.recordDispatched('dispatchedComments', this.commentDedupKey(c));
    }
  }

  private async tryFirstContactBody(
    ctx: LaneContext,
    framing: string,
  ): Promise<void> {
    // First contact is gated by `last_read_at` in the caller, but a thread can
    // be re-fetched with `last_read_at` still null if marking it read failed
    // (its updated_at was bumped past the cutoff). Dedup on an explicit record
    // of which bodies we have already fed, so that re-fetch never feeds the body
    // twice. Unlike a `created_at <= cursor` guard, this also feeds bodies whose
    // notification arrived late — after the cursor had advanced past created_at.
    const { chatId, threadId, issueNumber, subjectTitle } = ctx;
    const bodyKey = `${chatId}|${threadId}`;
    if (this.isDispatched(this.cursor.dispatchedBodies, bodyKey)) return;
    try {
      const issue = await this.fetchIssueMeta(chatId, threadId, issueNumber);
      const body = issue.body || '';
      if (issue.user?.login === this.botUsername) return;
      const isMentioned = this.botUsername
        ? testBotMention(body, this.botUsername)
        : false;
      const text = this.botUsername
        ? stripBotMention(body, this.botUsername)
        : body;
      const envelope: Envelope = {
        channelName: this.name,
        senderId: (issue.user?.login || 'unknown').toLowerCase(),
        senderName: issue.user?.login || 'unknown',
        chatId,
        threadId,
        messageId: `issue-body-${issueNumber}`,
        text,
        isGroup: true,
        isMentioned,
        isReplyToBot: false,
        metadata: this.appendFraming(
          this.buildMetadata(chatId, threadId, subjectTitle),
          framing,
        ),
      };
      try {
        await this.handleInbound(envelope);
        this.recordDispatched('dispatchedBodies', bodyKey);
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] handleInbound failed for issue body ${issueNumber}: ${err}\n`,
        );
        await this.postErrorComment(chatId, issueNumber);
        this.recordDispatched('dispatchedBodies', bodyKey);
      }
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] failed to fetch issue for first contact: ${err}\n`,
      );
    }
  }

  private async fetchNewComments(
    chatId: string,
    threadId: string,
    issueNumber: number,
    windowSince: string,
    maxUpdatedAt: string,
  ): Promise<GithubComment[]> {
    const [owner, repo] = chatId.split('/');
    const comments = await this.githubApi(
      () =>
        this.octokit.paginate(this.octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number: issueNumber,
          since: windowSince,
          per_page: 100,
        }),
      `listComments(${threadId})`,
    );
    comments.sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || ''),
    );
    return comments.filter((c) => {
      if (c.user?.login === this.botUsername) return false;
      if (c.created_at && c.created_at > maxUpdatedAt) return false;
      if (c.created_at && c.created_at <= windowSince) return false;
      return true;
    }) as GithubComment[];
  }

  private async fetchIssueMeta(
    chatId: string,
    threadId: string,
    issueNumber: number,
  ): Promise<{
    body?: string | null;
    state?: string;
    user?: { login?: string } | null;
  }> {
    const { data: issue } = await this.githubApi(
      () =>
        this.octokit.rest.issues.get({
          owner: chatId.split('/')[0],
          repo: chatId.split('/')[1],
          issue_number: issueNumber,
        }),
      `issues.get(${threadId})`,
    );
    return issue;
  }

  private async fetchPrMeta(
    chatId: string,
    threadId: string,
    issueNumber: number,
  ): Promise<{
    title?: string;
    body?: string | null;
    state?: string;
    draft?: boolean;
    user?: { login?: string } | null;
    head?: { ref?: string } | null;
    base?: { ref?: string } | null;
  }> {
    const { data: pr } = await this.githubApi(
      () =>
        this.octokit.rest.pulls.get({
          owner: chatId.split('/')[0],
          repo: chatId.split('/')[1],
          pull_number: issueNumber,
        }),
      `pulls.get(${threadId})`,
    );
    return pr;
  }

  private buildMetaDetail(
    kind: 'pull' | 'issue',
    meta: {
      state?: string;
      draft?: boolean;
      user?: { login?: string } | null;
      head?: { ref?: string } | null;
      base?: { ref?: string } | null;
    },
  ): string {
    const author = meta.user?.login || 'unknown';
    const state = meta.state || 'unknown';
    if (kind === 'pull') {
      const draft = meta.draft ? 'true' : 'false';
      const headRef = meta.head?.ref || 'unknown';
      const baseRef = meta.base?.ref || 'unknown';
      return `Author: ${author} | State: ${state} | Draft: ${draft} | branch: ${headRef} → ${baseRef}`;
    }
    return `Author: ${author} | State: ${state}`;
  }

  private buildCommentsSummary(comments: GithubComment[]): string {
    if (comments.length === 0) return '';
    const lines = comments.map((c) => {
      const who = c.user?.login || 'unknown';
      const body = (c.body || '').trim();
      return `- @${who}: ${body}`;
    });
    return `New comments (${comments.length}):\n${lines.join('\n')}`;
  }

  private appendFraming(base: string, ...parts: string[]): string {
    return [base, ...parts.filter((p) => p && p.trim())].join('\n');
  }

  private commentDedupKey(comment: GithubComment): string {
    return comment.node_id || String(comment.id);
  }

  private isDispatched(list: string[] | undefined, key: string): boolean {
    return list?.includes(key) ?? false;
  }

  private recordDispatched(
    field: 'dispatchedBodies' | 'dispatchedComments',
    key: string,
  ): void {
    const list = this.cursor[field] ?? [];
    list.push(key);
    this.cursor[field] = list.slice(-MAX_DISPATCHED);
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
    subjectTitle: string,
  ): string {
    const type = threadId.startsWith('pr:') ? 'Pull Request' : 'Issue';
    const url = `${this.webOrigin}/${chatId}/${threadId.startsWith('pr:') ? 'pull' : 'issues'}/${threadId.split(':')[1]}`;
    return `Type: ${type} | Title: ${subjectTitle} | URL: ${url}`;
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
          const retryAfter = Number(headers['retry-after']);
          cooldown = Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : 1000 * 2 ** (attempt - 1);
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
        await this.abortableSleep(cooldown);
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
      await this.githubApi(
        () =>
          this.octokit.rest.issues.createComment({
            owner: chatId.split('/')[0],
            repo: chatId.split('/')[1],
            issue_number: issueNumber,
            body: '⚠️ Failed to process this request. Please re-mention the bot to retry.',
          }),
        `postErrorComment(${chatId}#${issueNumber})`,
      );
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] postErrorComment also failed for ${chatId}#${issueNumber}, user must re-mention manually: ${err}\n`,
      );
    }
  }
}
