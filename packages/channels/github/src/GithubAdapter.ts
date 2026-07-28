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
  metaFloor?: string;
  /**
   * Thread keys (`chatId|threadId`) whose issue/PR body has already been fed as
   * a first-contact trigger. Dedupes body dispatch when a thread is re-fetched
   * with `last_read_at` still null — which happens if `markNotificationsAsRead`
   * failed to mark it read (its `updated_at` was bumped past the cutoff between
   * fetch and mark). Bounded to the most recent entries so the cursor stays small.
   */
  dispatchedBodies?: string[];
  /** Comment node IDs already accepted by the channel. */
  dispatchedComments?: string[];
  /** Direct-action event node IDs already accepted by the channel. */
  dispatchedEvents?: string[];
}

const MAX_DISPATCHED = 500;
const MAX_AGGREGATE_COMMENTS = 20;
const MAX_AGGREGATE_COMMENT_CHARS = 400;

interface GithubComment {
  id: number;
  node_id?: string;
  body?: string;
  created_at?: string | null;
  user?: { login?: string } | null;
}

interface GithubIssueEvent {
  id: number;
  node_id?: string;
  event?: string;
  created_at?: string | null;
  actor?: { login?: string } | null;
  assigner?: { login?: string } | null;
  assignee?: { login?: string } | null;
  review_requester?: { login?: string } | null;
  requested_reviewer?: { login?: string } | null;
}

interface GithubMeta {
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  user?: { login?: string } | null;
  head?: { ref?: string } | null;
  base?: { ref?: string } | null;
}

interface NotificationContext {
  chatId: string;
  threadId: string;
  issueNumber: number;
  lastReadAt: string | null;
  windowSince: string;
  metaFloor: string;
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
    if (
      base.metaFloor !== undefined &&
      (typeof base.metaFloor !== 'string' ||
        Number.isNaN(new Date(base.metaFloor).getTime()))
    ) {
      delete base.metaFloor;
    }
    for (const field of [
      'dispatchedBodies',
      'dispatchedComments',
      'dispatchedEvents',
    ] as const) {
      if (base[field] !== undefined && !Array.isArray(base[field])) {
        base[field] = [];
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
    this.cursor.metaFloor ??= this.cursor.lastProcessedAt;
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
      const ctx: NotificationContext = {
        chatId,
        threadId,
        issueNumber,
        lastReadAt,
        windowSince,
        metaFloor: this.cursor.metaFloor,
        maxUpdatedAt,
        subjectTitle: notification.subject.title || '',
        reason: notification.reason,
      };

      try {
        switch (notification.reason) {
          case 'mention':
            await this.processCommentLane(ctx, true);
            break;
          case 'review_requested':
            if (threadId.startsWith('pr:')) {
              await this.processDirectLane(ctx, 'review_requested');
              await this.processCommentLane(ctx, true);
            } else {
              await this.processCommentLane(ctx, false);
            }
            break;
          case 'assign':
            await this.processDirectLane(ctx, 'assign');
            await this.processCommentLane(ctx, true);
            break;
          case 'author':
          case 'comment':
            await this.processAggregateLane(ctx);
            break;
          default:
            await this.processCommentLane(ctx, false);
        }
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] API error processing ${threadId}, skipping: ${err}\n`,
        );
        continue;
      }
    }
  }

  private async processCommentLane(
    ctx: NotificationContext,
    onlyMentioned: boolean,
    directed = false,
  ): Promise<void> {
    const comments = await this.fetchNewComments(ctx);
    let dispatched = false;

    for (const comment of comments) {
      const key = comment.node_id || String(comment.id);
      if (this.cursor.dispatchedComments?.includes(key)) continue;

      const body = comment.body || '';
      const hasMention = this.botUsername
        ? testBotMention(body, this.botUsername)
        : false;
      if (onlyMentioned && !hasMention) continue;

      const senderId = (comment.user?.login || 'unknown').toLowerCase();
      const allowed = this.gate.isAllowed(senderId);
      const envelope: Envelope = {
        channelName: this.name,
        senderId,
        senderName: comment.user?.login || 'unknown',
        chatId: ctx.chatId,
        threadId: ctx.threadId,
        messageId: String(comment.id),
        text: this.botUsername ? stripBotMention(body, this.botUsername) : body,
        isGroup: true,
        isMentioned: hasMention || (directed && allowed),
        isReplyToBot: false,
        metadata: this.buildRouteMetadata(ctx),
      };

      if (!(await this.dispatchEnvelope(envelope, ctx.issueNumber))) {
        dispatched = true;
        continue;
      }
      if (allowed) {
        this.recordDispatchedComment(key);
        if (hasMention) dispatched = true;
      }
    }

    if (!dispatched && !ctx.lastReadAt) {
      await this.tryFirstContactBody(ctx, onlyMentioned);
    }
  }

  private async processDirectLane(
    ctx: NotificationContext,
    reason: 'review_requested' | 'assign',
  ): Promise<void> {
    const trigger = await this.findDirectTrigger(ctx, reason);
    if (!trigger) return;

    const meta =
      reason === 'review_requested'
        ? await this.fetchPrMeta(ctx)
        : await this.fetchIssueMeta(ctx);
    const title = meta.title || ctx.subjectTitle;
    const details =
      reason === 'review_requested'
        ? `Author: ${meta.user?.login || 'unknown'} | State: ${meta.state || 'unknown'} | Draft: ${meta.draft ? 'true' : 'false'} | Branch: ${meta.head?.ref || 'unknown'} → ${meta.base?.ref || 'unknown'}`
        : `Author: ${meta.user?.login || 'unknown'} | State: ${meta.state || 'unknown'}`;
    const envelope: Envelope = {
      channelName: this.name,
      senderId: trigger.actor,
      senderName: trigger.actor,
      chatId: ctx.chatId,
      threadId: ctx.threadId,
      messageId: String(trigger.id),
      text:
        reason === 'review_requested'
          ? 'Review this pull request and report any actionable findings.'
          : 'Triage this issue and respond with the next action.',
      isGroup: true,
      isMentioned: true,
      isReplyToBot: false,
      metadata: `${this.buildMetadata(ctx.chatId, ctx.threadId, title)}\nTrigger: ${reason}.\n${details}`,
    };
    await this.dispatchEnvelope(envelope, ctx.issueNumber);
    this.recordDispatched('dispatchedEvents', trigger.key);
  }

  private async processAggregateLane(ctx: NotificationContext): Promise<void> {
    if (this.config.senderPolicy === 'pairing') {
      await this.processCommentLane(ctx, false, true);
      return;
    }
    const allComments = (await this.fetchNewComments(ctx)).filter((comment) => {
      const key = comment.node_id || String(comment.id);
      const sender = (comment.user?.login || 'unknown').toLowerCase();
      return (
        !this.cursor.dispatchedComments?.includes(key) &&
        this.gate.isAllowed(sender)
      );
    });
    const comments = allComments.slice(-MAX_AGGREGATE_COMMENTS);
    if (comments.length === 0) return;

    for (const comment of allComments) {
      this.recordDispatchedComment(comment.node_id || String(comment.id));
    }

    const first = comments[0]!;
    const summary = comments
      .map(
        (comment) =>
          `- @${comment.user?.login || 'unknown'}: ${(comment.body || '').trim().slice(0, MAX_AGGREGATE_COMMENT_CHARS)}`,
      )
      .join('\n');
    const envelope: Envelope = {
      channelName: this.name,
      senderId: (first.user?.login || 'unknown').toLowerCase(),
      senderName: first.user?.login || 'unknown',
      chatId: ctx.chatId,
      threadId: ctx.threadId,
      messageId: String(first.id),
      text: `Review these new comments and respond if needed:\n${summary}`,
      isGroup: true,
      isMentioned: true,
      isReplyToBot: false,
      metadata: this.buildRouteMetadata(ctx),
    };

    await this.dispatchEnvelope(envelope, ctx.issueNumber);
  }

  private async findDirectTrigger(
    ctx: NotificationContext,
    reason: 'review_requested' | 'assign',
  ): Promise<{ actor: string; id: number; key: string } | null> {
    const [owner, repo] = ctx.chatId.split('/');
    const events = (await this.githubApi(
      () =>
        this.octokit.paginate(this.octokit.rest.issues.listEvents, {
          owner,
          repo,
          issue_number: ctx.issueNumber,
          per_page: 100,
        }),
      `listEvents(${ctx.threadId})`,
    )) as GithubIssueEvent[];
    events.sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || ''),
    );
    const bot = this.botUsername?.toLowerCase();
    const event = events.findLast((candidate) => {
      if (
        !candidate.created_at ||
        candidate.created_at <= ctx.metaFloor ||
        candidate.created_at > ctx.maxUpdatedAt
      ) {
        return false;
      }
      return reason === 'assign'
        ? (candidate.event === 'assigned' ||
            candidate.event === 'unassigned') &&
            candidate.assignee?.login?.toLowerCase() === bot
        : (candidate.event === 'review_requested' ||
            candidate.event === 'review_request_removed') &&
            candidate.requested_reviewer?.login?.toLowerCase() === bot;
    });
    if (
      !event ||
      (reason === 'assign'
        ? event.event !== 'assigned'
        : event.event !== 'review_requested')
    ) {
      return null;
    }
    const key = event.node_id || String(event.id);
    if (this.cursor.dispatchedEvents?.includes(key)) return null;
    const actor =
      reason === 'assign'
        ? event.assigner?.login || event.actor?.login
        : event.review_requester?.login || event.actor?.login;
    return actor ? { actor: actor.toLowerCase(), id: event.id, key } : null;
  }

  private async fetchNewComments(
    ctx: NotificationContext,
  ): Promise<GithubComment[]> {
    const [owner, repo] = ctx.chatId.split('/');
    const comments = (await this.githubApi(
      () =>
        this.octokit.paginate(this.octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number: ctx.issueNumber,
          since: ctx.windowSince,
          per_page: 100,
        }),
      `listComments(${ctx.threadId})`,
    )) as GithubComment[];
    comments.sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || ''),
    );
    return comments.filter(
      (comment) =>
        comment.user?.login !== this.botUsername &&
        (!comment.created_at ||
          (comment.created_at > ctx.windowSince &&
            comment.created_at <= ctx.maxUpdatedAt)),
    );
  }

  private async fetchIssueMeta(ctx: NotificationContext): Promise<GithubMeta> {
    const { data } = await this.githubApi(
      () =>
        this.octokit.rest.issues.get({
          owner: ctx.chatId.split('/')[0],
          repo: ctx.chatId.split('/')[1],
          issue_number: ctx.issueNumber,
        }),
      `issues.get(${ctx.threadId})`,
    );
    return data;
  }

  private async fetchPrMeta(ctx: NotificationContext): Promise<GithubMeta> {
    const { data } = await this.githubApi(
      () =>
        this.octokit.rest.pulls.get({
          owner: ctx.chatId.split('/')[0],
          repo: ctx.chatId.split('/')[1],
          pull_number: ctx.issueNumber,
        }),
      `pulls.get(${ctx.threadId})`,
    );
    return data;
  }

  private async tryFirstContactBody(
    ctx: NotificationContext,
    requireMention = false,
  ): Promise<void> {
    // First contact is gated by `last_read_at` in the caller, but a thread can
    // be re-fetched with `last_read_at` still null if marking it read failed
    // (its updated_at was bumped past the cutoff). Dedup on an explicit record
    // of which bodies we have already fed, so that re-fetch never feeds the body
    // twice. Unlike a `created_at <= cursor` guard, this also feeds bodies whose
    // notification arrived late — after the cursor had advanced past created_at.
    const { chatId, threadId, issueNumber } = ctx;
    const bodyKey = `${chatId}|${threadId}`;
    if (this.cursor.dispatchedBodies?.includes(bodyKey)) return;
    try {
      const issue = await this.fetchIssueMeta(ctx);
      const body = issue.body || '';

      if (issue.user?.login === this.botUsername) return;

      const isMentioned = this.botUsername
        ? testBotMention(body, this.botUsername)
        : false;
      if (requireMention && !isMentioned) return;

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
        metadata: this.buildRouteMetadata(ctx),
      };

      await this.dispatchEnvelope(envelope, issueNumber);
      this.recordDispatchedBody(bodyKey);
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] failed to fetch issue for first contact: ${err}\n`,
      );
    }
  }

  private recordDispatchedBody(key: string): void {
    this.recordDispatched('dispatchedBodies', key);
  }

  private recordDispatchedComment(key: string): void {
    this.recordDispatched('dispatchedComments', key);
  }

  private recordDispatched(
    field: 'dispatchedBodies' | 'dispatchedComments' | 'dispatchedEvents',
    key: string,
  ): void {
    const list = this.cursor[field] ?? [];
    if (!list.includes(key)) list.push(key);
    this.cursor[field] = list.slice(-MAX_DISPATCHED);
  }

  private async dispatchEnvelope(
    envelope: Envelope,
    issueNumber: number,
  ): Promise<boolean> {
    try {
      await this.handleInbound(envelope);
      return true;
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] handleInbound failed for ${envelope.messageId}: ${err}\n`,
      );
      await this.postErrorComment(envelope.chatId, issueNumber);
      return false;
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
    title: string,
  ): string {
    const type = threadId.startsWith('pr:') ? 'Pull Request' : 'Issue';
    const url = `${this.webOrigin}/${chatId}/${threadId.startsWith('pr:') ? 'pull' : 'issues'}/${threadId.split(':')[1]}`;
    return `Type: ${type} | Title: ${title} | URL: ${url}`;
  }

  private buildRouteMetadata(ctx: NotificationContext): string {
    return `${this.buildMetadata(ctx.chatId, ctx.threadId, ctx.subjectTitle)}\nTrigger: ${ctx.reason}.`;
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
