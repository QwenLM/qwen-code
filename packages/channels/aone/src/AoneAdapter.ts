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
  sanitizeLogText,
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
  /**
   * Per-repo instant (ISO) of the last poll. Optional for backward compat
   * with cursors written before it existed. Discriminates the two cursor-0
   * states: an empty-window baseline polled recently (the window fills
   * normally, no aging) vs a stale empty baseline older than the window
   * start (genuine aging loss). Kept separate from `repos` (a number record)
   * so adding it does not invalidate existing cursors.
   */
  lastPoll?: Record<string, string>;
}

const cursorSchema = z.object({
  // An unparseable floor would silently freeze dispatch (NaN comparisons);
  // reject it so the channel re-baselines instead.
  baselineAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  repos: z.record(z.string(), z.number()),
  lastPoll: z.record(z.string(), z.string()).optional(),
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
 * a1 caps --page at 100; a full page 100 is beyond the addressable window.
 * The walk pages to the tail (or the cursor) so the oldest slice never
 * crosses an unfetched gap; only this hard stop throws.
 */
const PLATFORM_MAX_PAGES = 100;
/**
 * Each repo's slice in a poll dispatches at most this many (oldest) events;
 * the remainder drains on later polls. A poll's worst case is therefore
 * repos.length × DISPATCH_BUDGET dispatches (and up to repos.length ×
 * PLATFORM_MAX_PAGES fetches while backlogs drain). Universal, not
 * overflow-only: a 101–999 event backlog must not dispatch unbounded agent
 * turns in one poll while a 1001 backlog caps at 100 (monotonic protection).
 */
const DISPATCH_BUDGET = PAGE_SIZE;

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
  // Dedupes the cursor_aged_out journal record per aging episode within this
  // process's lifetime: a chronically backlogged repo re-enters the aging
  // branch every poll with a constant stale lastPoll, so one record per
  // distinct stale instant. In-memory only — a restart re-records an episode
  // the journal already holds (the dedupe is per process, not per repo
  // lifetime); persisting it would require another optional cursor field.
  private agedOutJournal = new Map<string, string>();

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
    // Prune cursor keys for repos no longer watched: a stale key would skip
    // the first-observation baseline when the repo is re-added later and
    // replay its whole 3-day window as "new".
    let pruned = false;
    for (const key of Object.keys(this.cursor.repos)) {
      if (!this.repos.includes(key)) {
        delete this.cursor.repos[key];
        pruned = true;
      }
    }
    if (pruned) this.saveCursor();
    this.prefixes = normalizeTriggerPrefixes(cfg.triggerPrefixes, this.name);
    if (cfg.promptTemplate !== undefined) {
      if (typeof cfg.promptTemplate !== 'string') {
        throw new Error(
          `[Channel:${this.name}] promptTemplate must be a string.`,
        );
      }
      // The descriptor documents "leave empty for the default template";
      // an empty string must not silently strip the CR context header.
      this.promptTemplate = cfg.promptTemplate.trim()
        ? cfg.promptTemplate
        : DEFAULT_PROMPT_TEMPLATE;
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
    // Aone is configured by hand in settings.json: it is not in the Web
    // Shell's SUPPORTED_CHANNEL_TYPES, so the channel editor cannot create
    // or edit it and the descriptor's groupPolicy default (open) never
    // seeds an editor draft. An absent groupPolicy in a hand-written config
    // resolves to disabled (warned above). The diagnostics below therefore
    // describe the hand-written posture, not a UI-seeded one.
    //
    // One posture-resolution pass per watched repo, reproducing the base
    // gate order: GroupGate.check (allowlist membership) runs BEFORE the
    // sender gate, so a repo the group gate rejects is dead regardless of
    // its senders. groupConfigFor mirrors ChannelBase.groupConfigFor
    // (private): exact key, then normalized-match; the allowedUsers chain
    // mirrors groupAllowedUsersFor (repo -> "*" -> empty, and an empty
    // allowlist denies everyone — it does not fall through to open).
    const groups = this.config.groups ?? {};
    const groupConfigFor = (key: string) => {
      if (Object.hasOwn(groups, key)) return groups[key];
      const normalized = this.normalizeGroupId(key);
      for (const [groupId, group] of Object.entries(groups)) {
        if (this.normalizeGroupId(groupId) === normalized) return group;
      }
      return undefined;
    };
    const hasGroupsEntry = (repo: string) => groupConfigFor(repo) !== undefined;
    const resolvedAllowedUsers = (repo: string) =>
      groupConfigFor(repo)?.allowedUsers ??
      groupConfigFor('*')?.allowedUsers ??
      [];
    const policy = cfg.groupPolicy;
    // Whether the group gate admits the repo now. Pairing needs a one-time
    // approval that connect cannot assume, so it is not immediately
    // reachable (its open-senders note below is conditioned on approval).
    const groupReachable = (repo: string) =>
      policy === 'open' || (policy === 'allowlist' && hasGroupsEntry(repo));
    const sendersFor = (repo: string) => this.groupSendersFor({ chatId: repo });

    const allowlistDeadRepos =
      policy === 'allowlist'
        ? this.repos.filter((repo) => !hasGroupsEntry(repo))
        : [];
    const openRepos = this.repos.filter(
      (repo) => groupReachable(repo) && sendersFor(repo) === 'open',
    );
    const senderDeadRepos = this.repos.filter(
      (repo) =>
        groupReachable(repo) &&
        sendersFor(repo) === 'allowlist' &&
        resolvedAllowedUsers(repo).length === 0,
    );
    const pairingOpenRepos =
      policy === 'pairing'
        ? this.repos.filter((repo) => sendersFor(repo) === 'open')
        : [];
    // Pairing + sender-dead: groupReachable is false under pairing (approval
    // pending), so the reachable-only senderDeadRepos filter above misses it;
    // after approval the empty allowlist still denies every sender.
    const pairingSenderDeadRepos =
      policy === 'pairing'
        ? this.repos.filter(
            (repo) =>
              sendersFor(repo) === 'allowlist' &&
              resolvedAllowedUsers(repo).length === 0,
          )
        : [];
    const deadAllowlist =
      policy === 'allowlist' && allowlistDeadRepos.length === this.repos.length;
    if (deadAllowlist) {
      // Every watched repo is dead: nothing dispatches at all.
      process.stderr.write(
        `[Channel:${this.name}] warning: groupPolicy "allowlist" but no watched repository has a groups entry — every event will be rejected as not_allowlisted (the "*" entry is a default, not a wildcard, under allowlist)\n`,
      );
    } else if (allowlistDeadRepos.length > 0) {
      // Mixed: some repos reachable, some dead. Name the dead ones — their
      // triggers silently drop, and the permissive warning below must not
      // claim they are open.
      process.stderr.write(
        `[Channel:${this.name}] warning: no groups entry for ${allowlistDeadRepos.join(', ')} under groupPolicy "allowlist" — events on those repositories will be rejected as not_allowlisted (the "*" entry is a default, not a wildcard, under allowlist)\n`,
      );
    }
    if (senderDeadRepos.length > 0) {
      // Sender-layer dead: the group gate admits these repos but their
      // effective senders policy is allowlist with an empty resolved list,
      // so every event dies group_sender_denied while the poll journals ok.
      process.stderr.write(
        `[Channel:${this.name}] warning: senders "allowlist" with no allowedUsers on ${senderDeadRepos.join(', ')} — every event will be rejected as group_sender_denied; set groups["<repo>"].allowedUsers (or groups["*"].allowedUsers) to admit specific commenters\n`,
      );
    }
    if ((policy === 'open' || policy === 'allowlist') && openRepos.length > 0) {
      // Permissive posture: open senders on a reachable watched repo.
      // openRepos excludes group-dead repos, so the all-dead posture never
      // reaches here (nothing dispatches there).
      process.stderr.write(
        `[Channel:${this.name}] warning: open group senders on ${openRepos.join(', ')} — any commenter on those repositories can drive the agent as the a1-login account; set groups["<repo>"].senders to "allowlist" with allowedUsers to restrict (see the design doc sample)\n`,
      );
    }
    if (pairingOpenRepos.length > 0) {
      // Pairing: not immediately reachable (group approval pending), so do
      // not claim current reachability — warn about the post-approval
      // posture instead.
      process.stderr.write(
        `[Channel:${this.name}] warning: groupPolicy "pairing" with open group senders on ${pairingOpenRepos.join(', ')} — once a group is approved, any commenter on those repositories can drive the agent; set groups["<repo>"].senders to "allowlist" with allowedUsers to restrict\n`,
      );
    }
    if (pairingSenderDeadRepos.length > 0) {
      // Pairing + sender-dead: post-approval framing (the group still needs
      // approval), and exclusive from pairing-open (allowlist vs open senders).
      process.stderr.write(
        `[Channel:${this.name}] warning: groupPolicy "pairing" with senders "allowlist" and no allowedUsers on ${pairingSenderDeadRepos.join(', ')} — once a group is approved, every event on those repositories will be rejected as group_sender_denied; set groups["<repo>"].allowedUsers (or groups["*"].allowedUsers) to admit specific commenters\n`,
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
    const failures: unknown[] = [];
    for (const repo of this.repos) {
      try {
        await this.pollRepo(repo);
      } catch (err) {
        // Per-repo isolation: a broken repo must not starve the repos after
        // it in the watch list (the base loop restarts from repos[0] on a
        // failed poll, so an uncaught throw skips every later repo forever).
        failures.push(err);
        // Sanitize once for both sinks: the cause is a1-derived text, so a
        // newline-bearing message must not forge a second stderr log line
        // and a long one must stay bounded. The journal write path caps too,
        // but stderr is the adapter's own responsibility.
        const message = sanitizeLogText(
          err instanceof Error ? err.message : String(err),
          200,
        );
        // Durable trace: a partial failure resolves the round, so the base
        // loop journals it ok — without this record the broken repo would
        // leave no trace the status page can show while its comments age out.
        this.recordChannelEvent({
          type: 'poll',
          outcome: 'repo_failed',
          repository: repo,
          error: message,
        });
        process.stderr.write(
          `[Channel:${this.name}] poll failed for ${repo}: ${message}\n`,
        );
      }
    }
    // Rethrow ONLY when every repo failed: the base loop's failure path
    // skips the pollInterval sleep (backoff ladder only), so rethrowing on
    // a PARTIAL failure would poll the healthy repos at the backoff cadence
    // (~30s) instead of the configured interval — 2× the a1 calls at 60s,
    // 120× at a one-hour interval. A partial failure is logged per repo
    // above and the round completes normally; a total failure backs off.
    if (failures.length === this.repos.length) throw failures[0];
  }

  private async pollRepo(repo: string): Promise<void> {
    // The window is computed ONCE per poll, not per page: a walk crossing
    // local midnight would otherwise shift --since/--until between pages,
    // drop the oldest day (where the not-yet-reached events sit), break on
    // the short page, and save the cursor above the unfetched events —
    // permanent silent loss. Calendar-day subtraction, not ms: a fixed 72h
    // offset shifts a day across DST boundaries.
    const until = new Date();
    const since = new Date(
      until.getFullYear(),
      until.getMonth(),
      until.getDate() - EVENTS_WINDOW_DAYS,
    );
    const sinceStr = localDate(since);
    const untilStr = localDate(until);

    // Capture the PREVIOUS successful poll instant: it discriminates genuine
    // aging (the repo was not successfully polled within the window, so
    // events since the last observation aged out) from a quiet repo that was
    // polled continuously and simply received no comments (nothing lost).
    // Unknown (a cursor written before lastPoll existed) is treated as stale
    // — the safe base behavior. The instant is stamped only at the SUCCESS
    // exits below, never here: a poll whose fetch throws must not count as an
    // observation, or a long a1 outage would keep refreshing it and silence
    // the aging diagnostic on recovery.
    const prevPollIso = this.cursor.lastPoll?.[repo];
    const prevPollMs = prevPollIso ? Date.parse(prevPollIso) : NaN;

    const cursorId = this.cursor.repos[repo];
    if (cursorId === undefined) {
      // First observation: baseline to the newest event id, dispatch nothing
      // (GitLab first-poll drain precedent). Page 1 is newest-first.
      const page = await this.fetchEventsPage(repo, 1, sinceStr, untilStr);
      this.cursor.repos[repo] = page.reduce((m, e) => Math.max(m, e.id), 0);
      (this.cursor.lastPoll ??= {})[repo] = until.toISOString();
      this.saveCursor();
      return;
    }

    const fresh: AoneCommentEvent[] = [];
    // Offset pagination over a newest-first list can repeat a boundary event
    // when a comment lands between two page fetches and shifts every offset;
    // dedupe by id so one comment is never dispatched twice in one poll.
    const seen = new Set<number>();
    let reachedCursor = false;
    for (let page = 1; ; page++) {
      const events = await this.fetchEventsPage(repo, page, sinceStr, untilStr);
      for (const event of events) {
        if (event.id <= cursorId) reachedCursor = true;
        else if (!seen.has(event.id)) {
          seen.add(event.id);
          fresh.push(event);
        }
      }
      if (reachedCursor || events.length < PAGE_SIZE) break;
      if (page === PLATFORM_MAX_PAGES) {
        // Beyond the platform's addressable window (100 pages); the cursor
        // stays put and the error is visible. Defensive: the window cannot
        // legitimately hold more than this.
        throw new AoneCommandError(
          `comment events backlog for ${repo} exceeds the platform window (${PLATFORM_MAX_PAGES * PAGE_SIZE} events); cursor unchanged`,
        );
      }
    }

    // The cursor event itself aged out of the 3-day window. Fire only when
    // the walk missed the cursor, there is something to resume to, AND the
    // previous fully-drained poll predates the window start (agedOut): that
    // is genuine loss — events since the last complete observation fell
    // outside the window. This covers both an outage (no successful poll) and
    // a drain slower than arrival: a capped poll does not refresh lastPoll
    // (see the success exit), so a chronically backlogged repo keeps its last
    // fully-drained instant until it precedes the window and the loss is
    // diagnosed. A repo polled continuously within the window (fresh
    // lastPoll) lost nothing even if its cursor event aged out (a quiet gap),
    // and a recent empty-window baseline (cursor 0) fills normally — neither
    // is aging. Keying on the last fully-drained poll, not the cursor value or
    // the channel baseline, also keeps a repo added to a mature channel (fresh
    // baseline) from false-positiving. A dormant repo (empty fresh) skips
    // nothing. The loss is permanent, so leave a durable journal record
    // beside the stderr line (the poll itself resolves ok).
    const agedOut = Number.isNaN(prevPollMs) || prevPollMs < since.getTime();
    if (!reachedCursor && fresh.length > 0 && agedOut) {
      const resumedFrom = fresh.reduce(
        (m, e) => Math.min(m, e.id),
        fresh[0]!.id,
      );
      // A chronically backlogged repo (drain slower than arrival) re-enters
      // this branch every poll with the same stale lastPoll; journal once per
      // distinct stale instant, not once per poll.
      const episode = prevPollIso ?? '';
      if (this.agedOutJournal.get(repo) !== episode) {
        this.recordChannelEvent({
          type: 'poll',
          outcome: 'cursor_aged_out',
          repository: repo,
          detail: { cursor: cursorId, resumedFrom },
        });
        this.agedOutJournal.set(repo, episode);
      }
      process.stderr.write(
        `[Channel:${this.name}] cursor for ${repo} aged out of the events window; events older than the window were lost to aging; resuming from the oldest fetched event\n`,
      );
    }

    fresh.sort((a, b) => a.id - b.id);
    // Within the window, `fresh` is complete down to the cursor when the
    // walk met it; the oldest slice never crosses an unfetched gap WITHIN
    // the window. When the cursor aged out (diagnosed above), older events
    // are already lost to the window, not to this slice. The budget is
    // per repo and monotonic; the remainder drains on later polls.
    const slice = fresh.slice(0, DISPATCH_BUDGET);
    if (fresh.length > slice.length) {
      process.stderr.write(
        `[Channel:${this.name}] backlog for ${repo}: dispatching oldest ${slice.length} of ${fresh.length} events; remainder next poll\n`,
      );
    }
    for (const event of slice) {
      // Events before channel creation never dispatch (empty-window baseline
      // floor). An unparseable createdAt is skipped fail-closed but MUST be
      // visible: a payload drift would otherwise mute the channel silently
      // while the cursor advances past every event.
      const createdMs = Date.parse(event.createdAt ?? '');
      if (Number.isNaN(createdMs)) {
        process.stderr.write(
          `[Channel:${this.name}] unparseable createdAt on event ${event.id} (${sanitizeLogText(String(event.createdAt), 200)}); skipping\n`,
        );
      } else if (createdMs >= this.baselineMs) {
        try {
          await this.dispatchEvent(repo, event);
        } catch (err) {
          process.stderr.write(
            `[Channel:${this.name}] error processing event ${event.id}: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 200)}\n`,
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
    // Success exit: stamp the last-poll instant only when this poll is a
    // complete observation that actually covers the gap. A capped poll (drain
    // slower than arrival, fresh > slice) is not complete. An EMPTY window is
    // complete only when it is not itself aged out: a quiet repo's dormant
    // poll (agedOut false) stamps and stays silent, but an outage's recovery
    // poll whose window is already empty (agedOut true) observed nothing of
    // the gap, so it must keep the instant stale — otherwise the next
    // non-empty poll would see a fresh lastPoll and swallow the outage's
    // permanent loss. A poll that threw above never reaches here either.
    if (fresh.length <= slice.length && (fresh.length > 0 || !agedOut)) {
      (this.cursor.lastPoll ??= {})[repo] = until.toISOString();
    }
    this.saveCursor();
  }

  private async fetchEventsPage(
    repo: string,
    page: number,
    since: string,
    until: string,
  ): Promise<AoneCommentEvent[]> {
    // The window strings come from pollRepo (computed once per poll — a
    // midnight-crossing walk must not shift them between pages). The 3-day
    // window is the continuity bound; outages beyond it lose events (v1
    // limit, no digest).
    const raw = await runA1Json<unknown>([
      'events',
      'repo',
      repo,
      '--type',
      'comments',
      '--since',
      since,
      '--until',
      until,
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
    // Drift-prone fields fail LOUD and CLOSED (same rule as createdAt): a
    // payload rename OR type drift would otherwise throw out of here into
    // the per-event catch, which posts a public error comment on the MR for
    // every drifted event. Type-guard before use; the self-comment skip
    // stays silent — it is normal traffic, not drift.
    const rawAuthor =
      typeof event.author === 'string' ? event.author : event.user?.username;
    if (typeof rawAuthor !== 'string' || rawAuthor.length === 0) {
      process.stderr.write(
        `[Channel:${this.name}] event ${event.id} has no author; skipping\n`,
      );
      return;
    }
    const author = rawAuthor.toLowerCase();
    if (author === this.botAccount) return;
    // Non-MR notes (issue comments) are a legitimate silent skip.
    if (event.note?.noteable_type !== 'MergeRequest') return;
    const mrId = event.mergeRequest?.id;
    if (typeof mrId !== 'number') return;
    const body = event.note?.note;
    if (typeof body !== 'string') {
      process.stderr.write(
        `[Channel:${this.name}] event ${event.id} has no note body; skipping\n`,
      );
      return;
    }
    const trigger = matchTrigger(body, this.prefixes);
    if (!trigger || !trigger.text) return;

    const rawChatId = event.projectDetail?.path_with_namespace;
    const chatId =
      typeof rawChatId === 'string' && rawChatId.length > 0 ? rawChatId : repo;
    const rawName = event.user?.name;
    const senderName =
      typeof rawName === 'string' && rawName.length > 0
        ? rawName
        : typeof event.author === 'string' && event.author.length > 0
          ? event.author
          : author;
    const envelope: Envelope = {
      channelName: this.name,
      senderId: author,
      senderName,
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
          `[Channel:${this.name}] fetchView failed (metadata only): ${sanitizeLogText(err instanceof Error ? err.message : String(err), 200)}\n`,
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
    let view: { title: string; url: string };
    try {
      const raw = await runA1Json<{
        mergeRequest?: { title?: unknown; detailUrl?: unknown };
      }>(['repo', 'mr', 'view', String(mrId), '--repo', repo]);
      const mr = raw?.mergeRequest;
      // detailUrl is the ONLY sanctioned Aone CR URL source — never assembled.
      view = {
        title: typeof mr?.title === 'string' ? mr.title : '',
        url: typeof mr?.detailUrl === 'string' ? mr.detailUrl : '',
      };
    } catch (err) {
      // Negative cache: a failing view costs ONE call per MR per poll, not
      // one per event (N events × the 20s timeout could outlast the poll
      // interval). The entry lives in the same per-poll cache pollOnce
      // clears, so it cannot leak across polls.
      this.viewCache.set(key, { title: '', url: '' });
      throw err;
    }
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
