/**
 * Aone Code channel adapter — polls each configured repository's comment
 * event stream (`a1 events repo --type comments`) and dispatches comments
 * that start with a configured trigger prefix. Aone has no notification
 * inbox API (probed 2026-11-16; see
 * docs/design/2026-11-16-aone-channel-plugin.md), so the watch list is
 * explicit and the event id is the cursor. Replies post as MR comments
 * through `a1 repo mr comment create` (write-once).
 */

import process from 'node:process';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import {
  lowercaseGroupAllowedUsers,
  PollingChannelBase,
} from '@qwen-code/channel-base';
import { z } from 'zod';
import { AoneCommandError, aoneWhoamiAccount, runA1Json } from './a1-client.js';
import { matchTrigger, normalizeTriggerPrefixes } from './trigger.js';

interface AoneConfig extends ChannelConfig {
  repos?: unknown;
  triggerPrefixes?: unknown;
  promptTemplate?: unknown;
}

interface AoneCursor {
  /**
   * Channel creation time (ISO). Events created before it never dispatch:
   * a repo whose first poll sees an EMPTY window baselines to id 0, and
   * without this floor the next poll would dispatch the whole 3-day
   * window as "new" — a historical backlog the design forbids.
   */
  baselineAt: string;
  /** Per-repo last processed event id. Aone has no server-side mark-read. */
  repos: Record<string, number>;
}

const cursorSchema = z.object({
  // An unparseable floor would silently freeze dispatch (NaN comparisons);
  // reject it so the channel re-baselines instead.
  baselineAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  repos: z.record(z.string(), z.number()),
});

/** One `a1 events repo --type comments` entry (the fields we read). */
interface AoneCommentEvent {
  id: number;
  createdAt?: string;
  author?: string;
  user?: { name?: string; username?: string };
  note?: { id?: number; note?: string; noteable_type?: string };
  mergeRequest?: { id?: number; iid?: number };
  projectDetail?: { path_with_namespace?: string };
}

const PAGE_SIZE = 100;
/**
 * Overflow bound: a full page 10 whose events are all newer than the cursor
 * means the backlog exceeds one poll's budget. Dispatching the newest slice
 * would advance the cursor past the older gap and lose it silently, so the
 * poll throws instead (base backoff, cursor untouched, visible error).
 */
const MAX_PAGES = 10;

const DEFAULT_PROMPT_TEMPLATE =
  'Aone CR %repo% !%mr_id% (iid %mr_iid%) | author: %author% | comment: %comment_id%';

/**
 * The events window the adapter passes explicitly: today − 3 days → today,
 * matching the documented default. a1 0.2.51 REJECTS omitted dates
 * ("--since and --until are required and must be used together") even
 * though the FAQ describes auto-completion — probed 2026-11-16. Dates are
 * local-calendar (the platform's examples use local `date +%Y-%m-%d`), not
 * UTC slices, which shift a day near midnight in non-UTC timezones.
 */
const EVENTS_WINDOW_DAYS = 3;

function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Aone repo paths may carry nested groups (group/subgroup/project). */
const REPO_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

export function normalizeRepos(raw: unknown, channelName: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `repos for channel ${channelName} must be a non-empty array of Aone repository paths (e.g. ["middleware/tddl5"]).`,
    );
  }
  const repos = raw.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(
        `repos entries for channel ${channelName} must be strings.`,
      );
    }
    const repo = entry.trim().toLowerCase();
    if (!REPO_PATH_RE.test(repo)) {
      throw new Error(
        `repos entries for channel ${channelName} must be group/project repository paths: ${entry}`,
      );
    }
    return repo;
  });
  return [...new Set(repos)];
}

/**
 * Shared validation for the management descriptor and connect(): one
 * source of truth so the UI and the runtime cannot drift (GitHub
 * validateRepoFilterConfig pattern).
 */
export function validateAoneConfig(
  config: Readonly<Record<string, unknown>>,
  channelName: string,
): string | undefined {
  try {
    normalizeRepos(config['repos'], channelName);
    normalizeTriggerPrefixes(config['triggerPrefixes'], channelName);
    if (
      config['promptTemplate'] !== undefined &&
      typeof config['promptTemplate'] !== 'string'
    ) {
      throw new Error(
        `promptTemplate for channel ${channelName} must be a string.`,
      );
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return undefined;
}

export class AoneChannel extends PollingChannelBase<AoneCursor> {
  private repos: string[] = [];
  private prefixes: string[] = [];
  private promptTemplate = DEFAULT_PROMPT_TEMPLATE;
  private botAccount = '';
  private baselineMs = NaN;
  private viewCache = new Map<string, { title: string; url: string }>();

  constructor(
    name: string,
    config: AoneConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
  }

  protected createInitialCursor(): AoneCursor {
    return { baselineAt: new Date().toISOString(), repos: {} };
  }

  protected override validateCursor(parsed: unknown): AoneCursor | null {
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  /** Aone routing matches repo paths case-insensitively (GitLab pattern). */
  protected override normalizeGroupId(groupId: string): string {
    return groupId.toLowerCase();
  }

  async connect(): Promise<void> {
    const cfg = this.config as AoneConfig;
    this.repos = normalizeRepos(cfg.repos, this.name);
    this.prefixes = normalizeTriggerPrefixes(cfg.triggerPrefixes, this.name);
    if (cfg.promptTemplate !== undefined) {
      if (typeof cfg.promptTemplate !== 'string') {
        throw new Error(
          `[Channel:${this.name}] promptTemplate must be a string.`,
        );
      }
      this.promptTemplate = cfg.promptTemplate;
    }

    if (
      cfg.groupPolicy !== 'open' &&
      cfg.groupPolicy !== 'allowlist' &&
      cfg.groupPolicy !== 'pairing'
    ) {
      process.stderr.write(
        `[Channel:${this.name}] warning: groupPolicy is "${cfg.groupPolicy ?? 'disabled'}"; must be "open", "allowlist" (with the repository listed), or "pairing" (after one-time group approval) for comments to be dispatched\n`,
      );
    }

    this.botAccount = (await aoneWhoamiAccount()).toLowerCase();
    this.baselineMs = Date.parse(this.cursor.baselineAt);

    const allowed = (this.config.allowedUsers ?? []).map((u) =>
      u.toLowerCase(),
    );
    this.config.allowedUsers = allowed;
    this.gate.replaceAllowedUsers(allowed);
    lowercaseGroupAllowedUsers(this.config.groups);
    if (this.config.operators) {
      this.config.operators = this.config.operators.map((u) => u.toLowerCase());
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
    sourceLabel?: string,
  ): Promise<void> {
    const match = threadId?.match(/^mr:(\d+)$/);
    if (!match) {
      throw new Error(
        `[Channel:${this.name}] sendThreadMessage requires a threadId like "mr:30825167" (got ${threadId ?? 'none'})`,
      );
    }
    // Write-once: runA1Json never retries; a retried create could double-post.
    await runA1Json([
      'repo',
      'mr',
      'comment',
      'create',
      '--repo',
      chatId,
      '--mr',
      match[1]!,
      '-m',
      this.formatMarkdownAttributedText(text, sourceLabel),
    ]);
  }

  protected async pollOnce(): Promise<void> {
    this.viewCache.clear();
    for (const repo of this.repos) {
      await this.pollRepo(repo);
    }
  }

  private async pollRepo(repo: string): Promise<void> {
    const cursorId = this.cursor.repos[repo];
    if (cursorId === undefined) {
      // First observation: baseline to the newest event id, dispatch nothing
      // (GitLab first-poll drain precedent). Page 1 is newest-first.
      const page = await this.fetchEventsPage(repo, 1);
      this.cursor.repos[repo] = page.reduce((m, e) => Math.max(m, e.id), 0);
      this.saveCursor();
      return;
    }

    const fresh: AoneCommentEvent[] = [];
    let reachedCursor = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const events = await this.fetchEventsPage(repo, page);
      for (const event of events) {
        if (event.id <= cursorId) reachedCursor = true;
        else fresh.push(event);
      }
      if (reachedCursor || events.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) {
        throw new AoneCommandError(
          `comment events backlog for ${repo} exceeds ${MAX_PAGES * PAGE_SIZE} events in one poll; not dispatching a partial window (cursor unchanged)`,
        );
      }
    }

    fresh.sort((a, b) => a.id - b.id);
    for (const event of fresh) {
      // Events before channel creation never dispatch (empty-window baseline
      // floor). An unparseable createdAt compares NaN → skipped, fail-closed.
      if (Date.parse(event.createdAt ?? '') >= this.baselineMs) {
        try {
          await this.dispatchEvent(repo, event);
        } catch (err) {
          process.stderr.write(
            `[Channel:${this.name}] error processing event ${event.id}: ${err}\n`,
          );
          await this.postErrorComment(repo, event).catch(() => {});
        }
      }
      // Aone has no server-side mark-read: the persisted cursor is the only
      // dedupe state. Save after EACH event to minimize the crash window;
      // a crash between dispatch and save still re-dispatches that one event
      // (at-least-once — the same trade-off as GitLab's todo-done ordering).
      this.cursor.repos[repo] = event.id;
      this.saveCursor();
    }
  }

  private async fetchEventsPage(
    repo: string,
    page: number,
  ): Promise<AoneCommentEvent[]> {
    // The 3-day window is the continuity bound; outages beyond it lose
    // events (v1 limit, no digest). Calendar-day subtraction, not ms: a
    // fixed 72h offset shifts a day across DST boundaries.
    const until = new Date();
    const since = new Date(
      until.getFullYear(),
      until.getMonth(),
      until.getDate() - EVENTS_WINDOW_DAYS,
    );
    const raw = await runA1Json<unknown>([
      'events',
      'repo',
      repo,
      '--type',
      'comments',
      '--since',
      localDate(since),
      '--until',
      localDate(until),
      '--per-page',
      String(PAGE_SIZE),
      '--page',
      String(page),
    ]);
    if (!Array.isArray(raw)) {
      throw new AoneCommandError('unexpected a1 events output');
    }
    return raw.map((entry) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { id?: unknown }).id !== 'number'
      ) {
        throw new AoneCommandError('unexpected a1 events entry shape');
      }
      return entry as AoneCommentEvent;
    });
  }

  private async dispatchEvent(
    repo: string,
    event: AoneCommentEvent,
  ): Promise<void> {
    const author = (event.author ?? event.user?.username ?? '').toLowerCase();
    // Loop prevention: never answer our own comments; an event without an
    // author cannot pass sender gating meaningfully either.
    if (!author || author === this.botAccount) return;
    if (event.note?.noteable_type !== 'MergeRequest') return;
    const mrId = event.mergeRequest?.id;
    if (typeof mrId !== 'number') return;
    const body = event.note?.note;
    if (typeof body !== 'string') return;
    const trigger = matchTrigger(body, this.prefixes);
    if (!trigger || !trigger.text) return;

    const chatId = event.projectDetail?.path_with_namespace ?? repo;
    const envelope: Envelope = {
      channelName: this.name,
      senderId: author,
      senderName: event.user?.name || event.author || author,
      chatId,
      threadId: `mr:${mrId}`,
      messageId: String(event.note.id ?? event.id),
      text: trigger.text,
      isGroup: true,
      isMentioned: true,
      isReplyToBot: false,
      metadata: await this.renderMetadata(chatId, mrId, event, author),
    };
    await this.handleInbound(envelope);
  }

  private async renderMetadata(
    repo: string,
    mrId: number,
    event: AoneCommentEvent,
    author: string,
  ): Promise<string> {
    const vars: Record<string, string> = {
      repo,
      mr_id: String(mrId),
      mr_iid: String(event.mergeRequest?.iid ?? ''),
      author,
      comment_id: String(event.note?.id ?? event.id),
    };
    if (
      this.promptTemplate.includes('%title%') ||
      this.promptTemplate.includes('%url%')
    ) {
      try {
        const view = await this.fetchView(repo, mrId);
        vars['title'] = view.title;
        vars['url'] = view.url;
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] fetchView failed (metadata only): ${err}\n`,
        );
        vars['title'] = '';
        vars['url'] = '';
      }
    }
    return this.promptTemplate.replace(/%%|%(\w+)%/g, (match, key: string) => {
      if (match === '%%') return '%';
      return vars[key] ?? match;
    });
  }

  private async fetchView(
    repo: string,
    mrId: number,
  ): Promise<{ title: string; url: string }> {
    const key = `${repo}#${mrId}`;
    const cached = this.viewCache.get(key);
    if (cached) return cached;
    const raw = await runA1Json<{
      mergeRequest?: { title?: unknown; detailUrl?: unknown };
    }>(['repo', 'mr', 'view', String(mrId), '--repo', repo]);
    const mr = raw?.mergeRequest;
    // detailUrl is the ONLY sanctioned Aone CR URL source — never assembled.
    const view = {
      title: typeof mr?.title === 'string' ? mr.title : '',
      url: typeof mr?.detailUrl === 'string' ? mr.detailUrl : '',
    };
    this.viewCache.set(key, view);
    return view;
  }

  private async postErrorComment(
    repo: string,
    event: AoneCommentEvent,
  ): Promise<void> {
    const mrId = event.mergeRequest?.id;
    if (typeof mrId !== 'number') return;
    const chatId = event.projectDetail?.path_with_namespace ?? repo;
    await runA1Json([
      'repo',
      'mr',
      'comment',
      'create',
      '--repo',
      chatId,
      '--mr',
      String(mrId),
      '-m',
      '⚠️ Failed to process this request. Please re-trigger with a prefixed comment to retry.',
    ]);
  }
}
