/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setTimeout as delay } from 'node:timers/promises';
import {
  MANAGED_OUTBOUND_LIMIT,
  resolvePrivatePolicy,
  sanitizePromptText,
} from '@qwen-code/channel-base';
import type {
  ManagedChannelPolicy,
  ManagedInboundEvent,
  ManagedClaimedDelivery,
  ManagedChannelControlPlane,
} from '@qwen-code/channel-base';
import {
  DISPATCHED_COMMENTS_LIMIT,
  MANAGED_GITHUB_PENDING_LIMIT,
  MANAGED_GITHUB_PR_TRANSITIONS,
  MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT,
  MANAGED_GITHUB_PR_WATCH_FIRED_LIMIT,
  MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT,
  ManagedGithubStateStore,
} from './managed-state.js';
import type {
  ManagedGithubCiAggregate,
  ManagedGithubPrTransition,
  ManagedGithubPrWatchEntry,
  ManagedGithubState,
  ManagedReceipt,
} from './managed-state.js';
import {
  isDefinitiveGithubReadFailure,
  isRateLimitAnswer,
} from './managed-github-deps.js';
import { testBotMention } from './mention.js';

export type { ManagedReceipt } from './managed-state.js';

// H5f of #12827: the GitHub reference adapter on the managed path. It never
// drives a model: an @mention comment becomes one platform event the control
// plane admits (route binding + input + wake in the Session journal), and a
// reply comes back through the receipted outbox the adapter pulls. Every
// claim persists before its side effect, so a restart replays the same event
// or reports the same segment as unknown — never a second input, never a
// second send. See docs/design/2026-11-16-managed-channel-github-adapter.md.

/** What a reply needs, committed with the input and echoed by the outbox. */
export interface GithubReplyContext {
  owner: string;
  repo: string;
  issueNumber: number;
  /**
   * The admitted inbound sender, carried so send() can re-check the current
   * sender policy before posting (the DingTalk/email send-time re-check).
   */
  senderId: string;
}

export interface GithubSettings {
  token: string;
  baseUrl: string;
  pollInterval: number;
  /**
   * True when a configured pollInterval was rejected and the default used.
   * Reported by githubSettings itself so the constructor's diagnostic never
   * re-derives the clamp decision.
   */
  pollIntervalRewritten?: boolean;
  /** Lowercased owner/repo allowlist; absent means every repo. */
  repoFilter?: string[];
}

/** One notification thread as the adapter reads it. */
export interface GithubNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title?: string; url?: string; type?: string };
}

/** One conversation comment as the adapter reads it. */
export interface GithubComment {
  id: number;
  node_id?: string;
  body?: string;
  created_at: string;
  user?: { login?: string } | null;
}

/** The outcome of one comment send, classified by the deps. */
export interface GithubSendFailure extends Error {
  definitive?: boolean;
}

/** One PR observation as the watch reads it (the pulls.get fields it needs). */
export interface GithubPullObservation {
  headSha?: string;
  /** null while GitHub computes mergeability; never overwrites the baseline. */
  mergeable: boolean | null;
  /** undefined while mergeable is null (the daemon's UNKNOWN mapping). */
  mergeableState?: string;
  state: string;
}

/** One CI rollup observation, the daemon's aggregateChecks vocabulary. */
export interface GithubCiObservation {
  aggregate: ManagedGithubCiAggregate;
  /** Names of failed checks (capped), for the event's evidence line. */
  failedChecks: string[];
  /** True when the failed-check list is partial (early page stop / name cap). */
  namesIncomplete?: boolean;
}

/** One PR-watch binding as the control plane lists it (pr-watch:list). */
export interface GithubPrWatchBinding {
  owner: string;
  repo: string;
  prNumber: number;
  sessionId: string;
  /** The enabled transition set; unknown/deferred members are ignored. */
  events: string[];
}

/**
 * The PR-watch control-plane surface (pr-watch:list / pr-watch:inject /
 * pr-watch:retire). Kept github-local and deps-injected so the shared
 * ManagedChannelControlPlane contract stays untouched; the HTTP implementation
 * is wired separately. Injection is private-only: the route submits a pr_event
 * input + wake to the binding's Session, and the watch never posts a public
 * comment.
 */
export interface GithubPrWatchControlPlane {
  listPrWatchBindings(): Promise<GithubPrWatchBinding[]>;
  injectPrEvent(event: {
    owner: string;
    repo: string;
    prNumber: number;
    transition: ManagedGithubPrTransition;
    headSha: string;
    evidence: string;
    /** Durable per-PR occurrence number; part of the idempotent input id. */
    episode: number;
  }): Promise<void>;
  /**
   * Retire this channel's binding for a PR so it stops consuming an
   * observation slot and the PR can be bound to another Session. Idempotent:
   * retiring an already-gone binding is a tolerated no-op.
   */
  retirePrWatchBinding(pr: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<void>;
}

/** The GitHub API surface the adapter reads and writes through. */
export interface ManagedGithubClient {
  /** The authenticated bot login. */
  resolveIdentity(): Promise<string>;
  listNotifications(since: string): Promise<GithubNotification[]>;
  listComments(
    owner: string,
    repo: string,
    issueNumber: number,
    since: string,
  ): Promise<GithubComment[]>;
  markThreadRead(threadId: string): Promise<void>;
  postComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number }>;
  /** The PR-watch baseline read: head, mergeability and state. */
  getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GithubPullObservation>;
  /** The PR-watch CI read: checks + combined status for one head SHA. */
  getCiStatus(
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<GithubCiObservation>;
  /** The poll floor GitHub's answers ask for (X-Poll-Interval, rate limits). */
  pollIntervalFloorMs(): number;
  disconnect(): void;
}

export interface ManagedGithubAdapterDeps {
  readonly createClient: (
    settings: GithubSettings,
  ) => Promise<ManagedGithubClient>;
  readonly lock: (
    directory: string,
    onCompromised: () => void,
  ) => Promise<() => Promise<void>>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Absent leaves the PR-watch pass inert (no bindings, no injection). */
  readonly prWatchControlPlane?: GithubPrWatchControlPlane;
}

export interface ManagedGithubAdapterOptions {
  readonly name: string;
  readonly cwd: string;
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * The pre-parse channel entry. `config` is the parseChannelConfig result,
   * which always injects privatePolicy/senderPolicy/groupPolicy defaults; the
   * adapter judges an explicit policy choice on this raw entry instead. When
   * absent (unit tests hand a raw shape as `config`), `config` is used.
   */
  readonly rawConfig?: Readonly<Record<string, unknown>>;
  readonly controlPlane: ManagedChannelControlPlane;
  readonly deps: ManagedGithubAdapterDeps;
  /** Off, the caller drives `tick()` itself (tests); on by default. */
  readonly pollLoop?: boolean;
}

const CLAIM_BATCH = 16;
// The retired channel watch's per-pass cap (prWatchLimit default) and the
// daemon's per-sweep view cap: both bound the pulls.get fan-out at 30.
const PR_WATCH_LIMIT = 30;
const DEFAULT_POLL_INTERVAL = 60_000;
const MIN_POLL_INTERVAL = 1_000;
const MAX_POLL_INTERVAL = 86_400_000;
const GITHUB_EVENT_PREFIX = 'github:';
const INSTANCE_SCOPED_REFUSALS = new Set([
  'workspace_not_found',
  'workspace_forbidden',
  'actor_scope_mismatch',
  'workspace_unavailable',
]);
const INSTANCE_REFUSAL_DROP_LIMIT = 1;
const CHANNEL_NOT_FOUND = 'channel_not_found';
// The wire's text bound (the control plane's Jakarta @Size) and the Harness
// envelope's byte line, mirrored locally to keep this package free of core
// imports. Both match the DingTalk reference adapter's clamp.
const MAX_WIRE_TEXT_CHARS = 32_000;
const ENVELOPE_BYTE_LIMIT = 64 * 1024;
const TEXT_ENVELOPE_OVERHEAD_BYTES = 4096;
// The wire's subject bound (InboundEventRequest.subject @Size(max = 200)).
const MAX_SUBJECT_CHARS = 200;

export function githubSettings(
  config: Readonly<Record<string, unknown>>,
): GithubSettings {
  if (config['useLocalGh'] === true) {
    // The gh CLI login is a machine-level identity; a tenant-scoped managed
    // deployment authenticates with its own token.
    throw new Error(
      'The managed GitHub path does not support useLocalGh; configure a token.',
    );
  }
  const token = config['token'];
  if (!validCredential(token))
    throw new Error('GitHub channel requires a token.');
  const rawBaseUrl = config['baseUrl'];
  const baseUrlRaw =
    typeof rawBaseUrl === 'string' && rawBaseUrl.trim()
      ? rawBaseUrl.trim()
      : 'https://api.github.com';
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrlRaw);
  } catch {
    throw new Error('GitHub channel baseUrl is not a valid URL.');
  }
  // WHATWG parses a scheme-less "host:port/path" with an empty hostname and a
  // bogus protocol; it would fail identity resolution as "unknown scheme"
  // behind the token-pointing message. Require an absolute http(s) URL.
  if (!/^https?:$/.test(parsedBase.protocol) || !parsedBase.hostname) {
    throw new Error(
      'GitHub channel baseUrl must be an absolute http(s) URL with a host.',
    );
  }
  // Normalize before the state-directory hash: trailing slash and host case
  // are the same endpoint and must key one state directory, not two owners.
  const baseUrl = `${parsedBase.origin}${parsedBase.pathname.replace(/\/+$/, '')}`;
  const rawInterval = config['pollInterval'];
  const pollInterval = Number(rawInterval ?? DEFAULT_POLL_INTERVAL);
  const intervalAccepted =
    Number.isSafeInteger(pollInterval) &&
    pollInterval >= MIN_POLL_INTERVAL &&
    pollInterval <= MAX_POLL_INTERVAL;
  const rawRepoFilter = config['repoFilter'];
  const repoFilterMode = config['repoFilterMode'];
  let repoFilter: string[] | undefined;
  // The plugin descriptor defaults repoFilterMode to 'off' and the Web Shell
  // editor seeds 'off' on save, so 'off' — and a blocklist with no list — must
  // start as "no repository filtering", not be refused. Only the invertible
  // and fail-open shapes are refused.
  if (repoFilterMode === 'blocklist' && rawRepoFilter !== undefined) {
    // A blocklist excludes the listed repos; reading it as an allowlist would
    // answer only in the repos the operator blocked. The managed path cannot
    // carry a blocklist, so refuse the invertible shape rather than guess.
    throw new Error(
      "The managed GitHub path supports repoFilter only as an allowlist; a blocklist with a repoFilter list would invert the operator's intent.",
    );
  }
  if (rawRepoFilter !== undefined && repoFilterMode === undefined) {
    // Legacy reads a list with no mode as "filter off"; promoting it to an
    // active allowlist would answer only inside the parked repos. Require the
    // explicit managed spelling instead of guessing.
    throw new Error(
      'GitHub channel repoFilter requires repoFilterMode "allowlist" on the managed path.',
    );
  }
  if (repoFilterMode === 'allowlist') {
    if (rawRepoFilter === undefined) {
      // Declaring an allowlist without a list must not fail open to every repo.
      throw new Error(
        'GitHub channel repoFilterMode "allowlist" requires a non-empty repoFilter array.',
      );
    }
    if (
      !Array.isArray(rawRepoFilter) ||
      rawRepoFilter.length === 0 ||
      !rawRepoFilter.every(
        (entry) =>
          typeof entry === 'string' &&
          REPOSITORY_FULL_NAME_RE.test(entry.trim()),
      )
    ) {
      // An empty or malformed allowlist would silently drop every event
      // while the adapter reports running (the Legacy validator refuses both
      // for the same reason).
      throw new Error(
        'GitHub channel repoFilter must be a non-empty array of owner/repo strings.',
      );
    }
    repoFilter = rawRepoFilter.map((entry) =>
      (entry as string).trim().toLowerCase(),
    );
  }
  // 'off' (the plugin/editor default) and a blocklist without a list leave
  // repoFilter undefined — no repository filtering, nothing to invert.
  return {
    token: (token as string).trim(),
    baseUrl,
    pollInterval: intervalAccepted ? pollInterval : DEFAULT_POLL_INTERVAL,
    pollIntervalRewritten: rawInterval !== undefined && !intervalAccepted,
    repoFilter,
  };
}

// Mirror the email/DingTalk credential rule: a copy-paste trailing newline or
// an embedded CR/LF/NUL must be rejected, not passed through to the API where
// it surfaces as an auth error pointing at the credential.
function validCredential(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !/[\r\n\0]/.test(value);
}

// The Legacy repository full-name shape (GithubAdapter.ts
// REPOSITORY_FULL_NAME_RE): owner/repo, no whitespace or path separators.
const REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface SubjectTarget {
  chatId: string;
  threadId: string;
  owner: string;
  repo: string;
  issueNumber: number;
}

// The Legacy adapter's subject-URL mechanics: one repo + issue/PR number is
// one chat_thread route. chatId is lowercased like the Legacy group id.
function extractSubjectUrl(url: string): SubjectTarget | null {
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)/);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  const kind = match[3] === 'pulls' ? 'pr' : 'issue';
  const issueNumber = Number(match[4]);
  return {
    chatId: `${owner}/${repo}`.toLowerCase(),
    threadId: `${kind}:${issueNumber}`,
    owner,
    repo,
    issueNumber,
  };
}

export class ManagedGithubAdapter {
  readonly settings: GithubSettings;
  readonly policy: ManagedChannelPolicy;
  private readonly store: ManagedGithubStateStore;
  private readonly controlPlane: ManagedChannelControlPlane;
  private readonly deps: ManagedGithubAdapterDeps;
  private readonly log: (line: string) => void;
  private readonly pollLoop: boolean;
  private state?: ManagedGithubState;
  private client?: ManagedGithubClient;
  private accountId?: string;
  private startedAt?: string;
  private releaseLock?: () => Promise<void>;
  private running = false;
  private ownershipLost = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private registeredGeneration?: number;
  private instanceStalled = false;
  private loggedNoClaimSlot = false;
  private loggedSettleFailure = false;

  constructor(options: ManagedGithubAdapterOptions) {
    this.settings = githubSettings(options.config);
    const config = options.config;
    // parseChannelConfig always injects privatePolicy/senderPolicy/groupPolicy
    // defaults into `config`, so an operator's explicit policy choice must be
    // judged on the raw pre-parse entry, not the fully-defaulted parse result.
    const raw = options.rawConfig ?? config;
    const groupPolicy = raw['groupPolicy'];
    if (groupPolicy === 'pairing') {
      // Same "skip every comment while reporting running" hazard as
      // privatePolicy pairing: the managed policy shape has no pairing arm.
      throw new Error(
        'The managed GitHub path does not support groupPolicy "pairing"; use allowedUsers or groupPolicy "open"/"disabled".',
      );
    }
    const groups = config['groups'];
    if (
      groups &&
      typeof groups === 'object' &&
      Object.keys(groups).length > 0
    ) {
      // Per-repo sender lists cannot be represented by the flat managed
      // policy; silently dropping them would admit senders the operator
      // excluded (or drop ones they allowed).
      throw new Error(
        'The managed GitHub path does not support per-repo "groups"; configure allowedUsers instead.',
      );
    }
    let senderPolicy = resolvePrivatePolicy(config);
    if (senderPolicy === 'pairing') {
      // The managed policy shape has no pairing arm; silently coercing it to
      // an empty allowlist would skip every comment while reporting running.
      throw new Error(
        'The managed GitHub path does not support privatePolicy "pairing"; use allowedUsers, open, or disabled.',
      );
    }
    // The plugin's own schema documents groupPolicy as the GitHub admission
    // gate. Honor an active groupPolicy when the operator did not explicitly
    // choose a managed policy in the RAW entry: a channel configured
    // groupPolicy "open" must not resolve to an empty allowlist and silently
    // consume every mention. Absence is judged on `raw`, not `config` —
    // parseChannelConfig injects privatePolicy/senderPolicy into config for
    // every channel, so a config-based guard would be dead on the production
    // path. groupPolicy "disabled" (the parse default when absent) stays inert
    // — keep the managed resolvePrivatePolicy result — rather than clobber an
    // allowedUsers allowlist into admit-nothing.
    if (
      raw['privatePolicy'] === undefined &&
      raw['senderPolicy'] === undefined &&
      groupPolicy !== undefined
    ) {
      if (groupPolicy === 'open' || groupPolicy === 'allowlist') {
        senderPolicy = groupPolicy;
      } else if (groupPolicy !== 'disabled') {
        throw new Error(
          'GitHub channel groupPolicy must be one of: allowlist, open, disabled.',
        );
      }
    }
    const allowed = config['allowedUsers'];
    this.policy = {
      adapter: 'github',
      senderPolicy:
        senderPolicy === 'disabled' || senderPolicy === 'open'
          ? senderPolicy
          : 'allowlist',
      allowedSenders: Array.isArray(allowed)
        ? allowed
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim().toLowerCase())
        : [],
      dispatchMode: config['dispatchMode'] === 'steer' ? 'steer' : 'followup',
    };
    this.store = new ManagedGithubStateStore(
      options.name,
      options.cwd,
      this.settings.baseUrl,
    );
    this.controlPlane = options.controlPlane;
    this.deps = options.deps;
    this.log =
      options.deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    if (this.settings.pollIntervalRewritten) {
      this.log(
        `Managed GitHub pollInterval ${String(options.config['pollInterval'])} is not an integer in [${MIN_POLL_INTERVAL}, ${MAX_POLL_INTERVAL}]; using ${this.settings.pollInterval} ms.`,
      );
    }
    this.pollLoop = options.pollLoop ?? true;
  }

  get stateFile(): string {
    return this.store.file;
  }

  get generation(): number | undefined {
    return this.state?.generation;
  }

  async connect(): Promise<void> {
    if (this.running || this.releaseLock)
      throw new Error('Managed GitHub adapter is already connected.');
    try {
      this.releaseLock = await this.deps.lock(this.store.directory, () => {
        // A reaped stale lock means a second owner won the state directory.
        // Stop, and stop persisting: an in-flight tick or the shutdown drain
        // must not rewrite the file the new owner now holds.
        this.ownershipLost = true;
        this.log(
          'Managed GitHub state ownership was lost to another process; adapter stopped.',
        );
        this.stop();
      });
    } catch {
      throw new Error(
        'GitHub state is owned by another process; managed adapter not started.',
      );
    }
    try {
      this.state = this.store.load() ?? {
        version: 1,
        generation: 1,
        cursor: { lastProcessedAt: null, dispatchedComments: [] },
        pending: [],
        outbound: [],
      };
      if (this.state.pending.some((entry) => entry.held)) {
        this.instanceStalled = true;
        this.state.instanceRefusals = Math.max(
          this.state.instanceRefusals ?? 0,
          INSTANCE_REFUSAL_DROP_LIMIT + 1,
        );
      }
      this.persist();
      this.abort = new AbortController();
      this.running = true;
      this.loggedNoClaimSlot = false;
      this.registeredGeneration = undefined;
      this.client = await this.deps.createClient(this.settings);
      // The first identity failure must surface: a bad token creates no
      // usable client, and swallowing it would report a healthy start that
      // is permanently deaf. The deps redact the credential from the error.
      this.accountId = await this.client.resolveIdentity();
      if (!this.running)
        throw new Error('Managed GitHub adapter stopped during connection.');
      await this.ensureRegistered(this.state);
      await this.reportOrphanedOutbound();
      // A lock compromise can land during the awaits above. Re-check so
      // connect() rejects rather than resolving a healthy-looking start for
      // a stopped, deaf adapter the CLI would then park on.
      if (!this.running || this.ownershipLost)
        throw new Error('Managed GitHub adapter stopped during connection.');
      // The first window starts at connect time: no historical backlog.
      this.startedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
      if (this.pollLoop) this.loop = this.runLoop();
    } catch (error) {
      this.stop();
      await this.release();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.loop;
    await this.controlPlane.disconnect().catch(() => undefined);
    await this.release();
  }

  /** One admission re-drive, one inbound poll, one outbox pull, one PR watch. */
  async tick(): Promise<void> {
    await this.ensureRegistered(this.state!);
    await this.resubmitPending();
    await this.pollInbound();
    // The user-visible reply lane runs before the watch pass: the watch is not
    // admission-critical and can spend dozens of sequential GitHub round-trips,
    // which must not delay claiming deliveries and posting comment replies.
    await this.reportOrphanedOutbound();
    await this.pullOutbox();
    await this.watchPrs();
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.running) {
        try {
          await this.tick();
        } catch (error) {
          this.log(`Managed GitHub tick failed: ${String(error)}`);
        }
        if (this.running) {
          const floor = this.client?.pollIntervalFloorMs() ?? 0;
          await delay(Math.max(this.settings.pollInterval, floor), undefined, {
            signal: this.abort!.signal,
          }).catch(() => {});
        }
      }
    } finally {
      this.stop();
    }
  }

  private senderAllowed(sender: string): boolean {
    switch (this.policy.senderPolicy) {
      case 'disabled':
        return false;
      case 'open':
        return true;
      default:
        return this.policy.allowedSenders.includes(sender);
    }
  }

  private repoAllowed(chatId: string): boolean {
    return (
      !this.settings.repoFilter || this.settings.repoFilter.includes(chatId)
    );
  }

  private async pollInbound(): Promise<void> {
    const state = this.state!;
    if (!this.running || this.instanceStalled || !this.client) return;
    if (state.pending.length >= MANAGED_GITHUB_PENDING_LIMIT) {
      if (!this.loggedNoClaimSlot) {
        this.loggedNoClaimSlot = true;
        this.log(
          'Managed GitHub has no durable claim slot; the inbound poll waits for pending admissions to settle.',
        );
      }
      return;
    }
    this.loggedNoClaimSlot = false;
    // The watermark steps back one second because GitHub timestamps are
    // second-granular; the overlap is absorbed by the dispatched ring and,
    // ultimately, by the control plane's platformEventId idempotency.
    const since = state.cursor.lastProcessedAt
      ? new Date(Date.parse(state.cursor.lastProcessedAt) - 1000).toISOString()
      : this.startedAt!;
    let notifications: GithubNotification[];
    try {
      notifications = await this.client.listNotifications(since);
    } catch (error) {
      // A failed read holds the window; the next poll re-lists it.
      this.log(`Managed GitHub notification poll failed: ${String(error)}`);
      return;
    }
    const kept = notifications.filter((notification) => {
      if (notification.reason !== 'mention') return false;
      const type = notification.subject.type;
      if (type !== 'Issue' && type !== 'PullRequest') return false;
      const target = extractSubjectUrl(notification.subject.url ?? '');
      return !!target && this.repoAllowed(target.chatId);
    });
    // A thread whose comments cannot be read, whose collection was cut short
    // by the claim cap, or whose mark-read fails freezes the whole window:
    // the watermark advances only on a complete pass, and a thread is marked
    // read only when every comment it produced was fully collected.
    let windowComplete = true;
    const processedThreads = new Set<string>();
    const droppedThreads = new Set<string>();
    for (const notification of kept) {
      if (!this.running) return;
      if (state.pending.length >= MANAGED_GITHUB_PENDING_LIMIT) break;
      const target = extractSubjectUrl(notification.subject.url ?? '')!;
      let comments: GithubComment[];
      try {
        comments = await this.client.listComments(
          target.owner,
          target.repo,
          target.issueNumber,
          since,
        );
      } catch (error) {
        if (isDefinitiveGithubReadFailure(error)) {
          // Poison escape: a deleted or inaccessible thread answers the same
          // refusal forever; without this it freezes the watermark for the
          // life of the channel. Drop it visibly — its mentions are
          // unrecoverable — and skip its mark-read (which would also fail).
          droppedThreads.add(notification.id);
          this.log(
            `Managed GitHub drops unreadable thread ${target.chatId}#${target.issueNumber}: ${String(error)}`,
          );
          continue;
        }
        windowComplete = false;
        this.log(
          `Managed GitHub could not read comments for ${target.chatId}#${target.issueNumber}: ${String(error)}`,
        );
        continue;
      }
      let capped = false;
      for (const comment of comments) {
        if (state.pending.length >= MANAGED_GITHUB_PENDING_LIMIT) {
          capped = true;
          break;
        }
        const login = comment.user?.login;
        const body = comment.body;
        if (!login || !body || !body.trim()) continue;
        if (login.toLowerCase() === this.accountId!.toLowerCase()) continue;
        if (!testBotMention(body, this.accountId!)) continue;
        // node_id is globally unique; the numeric id fallback is only unique
        // per repo, so scope it by thread — two repos' comment #555 must stay
        // two platform events, not one replayed away.
        const key =
          comment.node_id ??
          `${target.chatId}/${target.threadId}/${comment.id}`;
        const eventId = `${GITHUB_EVENT_PREFIX}${key}`;
        if (
          state.cursor.dispatchedComments.includes(key) ||
          state.pending.some((entry) => entry.eventId === eventId)
        ) {
          continue;
        }
        const senderId = login.toLowerCase();
        if (!this.senderAllowed(senderId)) {
          this.log(
            `Managed GitHub sender ${senderId} is not allowed; comment ${key} skipped.`,
          );
          this.recordDispatched(key);
          try {
            this.persist();
          } catch (error) {
            // The skip is already applied in memory; disk keeps no claim, so a
            // restart re-lists the comment and skips it again. Never abort the
            // poll over the failed write.
            this.log(
              `Managed GitHub could not persist the sender skip of ${key}: ${persistErrorText(error)}; a restart re-lists and skips it again.`,
            );
          }
          continue;
        }
        const event: ManagedInboundEvent = {
          accountGeneration: state.generation,
          platformEventId: eventId,
          semanticRevision: 1,
          scope: {
            kind: 'chat_thread',
            senderId: null,
            chatId: target.chatId,
            threadId: target.threadId,
          },
          senderId,
          chatId: target.chatId,
          threadId: target.threadId,
          subject: fitSubject(notification.subject.title),
          text: fitInboundText(body),
          attachments: [],
          replyContext: {
            owner: target.owner,
            repo: target.repo,
            issueNumber: target.issueNumber,
            senderId,
          } satisfies GithubReplyContext,
        };
        const previousPending = state.pending;
        state.pending = [
          ...state.pending,
          { eventId, event, notificationThreadId: notification.id },
        ].slice(-MANAGED_GITHUB_PENDING_LIMIT);
        try {
          this.persist();
        } catch (error) {
          // A failed save must not leave the claim in memory: the dedupe arm
          // would then skip a re-listed comment for a claim the store never
          // accepted. Roll back so the next poll re-stages it.
          state.pending = previousPending;
          throw error;
        }
      }
      // A capped collection leaves comments uncollected: marking this thread
      // read would consume notifications whose mentions were never staged.
      if (!capped) processedThreads.add(notification.id);
    }
    await this.resubmitPending();
    // Mark a thread read only after every event it produced has left pending
    // (admitted, replayed or visibly dropped). A thread still holding a claim
    // keeps the window frozen so the next poll re-drives it.
    const heldThreads = new Set(
      state.pending.map((entry) => entry.notificationThreadId),
    );
    for (const notification of kept) {
      if (!this.running) return;
      if (droppedThreads.has(notification.id)) continue;
      if (!processedThreads.has(notification.id)) {
        windowComplete = false;
        continue;
      }
      if (heldThreads.has(notification.id)) {
        windowComplete = false;
        continue;
      }
      try {
        await this.client.markThreadRead(notification.id);
      } catch (error) {
        windowComplete = false;
        this.log(
          `Managed GitHub could not mark notification ${notification.id} read: ${String(error)}; the window holds.`,
        );
      }
    }
    if (windowComplete && notifications.length > 0) {
      let watermark = state.cursor.lastProcessedAt;
      // The outer windowComplete was already evaluated to enter this block;
      // a local flag is what actually gates the persist below.
      let unparseable = false;
      for (const notification of notifications) {
        const updated = Date.parse(notification.updated_at);
        if (Number.isNaN(updated)) {
          // Persisting an unparseable watermark would throw RangeError on
          // every later tick's since computation and fail load() on restart.
          // Hold the window instead; outbound keeps moving.
          unparseable = true;
          this.log(
            `Managed GitHub notification ${notification.id} has an unparseable updated_at; the window holds.`,
          );
          continue;
        }
        if (!watermark || updated > Date.parse(watermark)) {
          watermark = notification.updated_at;
        }
      }
      if (
        !unparseable &&
        watermark &&
        watermark !== state.cursor.lastProcessedAt
      ) {
        state.cursor.lastProcessedAt = watermark;
        this.persist();
      }
    }
  }

  /**
   * PR-watch pass (D3 of the bound-session design): observe the bound PRs,
   * derive transitions with the daemon's semantics, and inject them privately
   * into the binding's Session through the control plane. Never posts
   * publicly. Every failure is contained here so the outbound lane keeps
   * moving. See docs/design/2026-11-17-managed-github-pr-watch-bound-session.md.
   */
  private async watchPrs(): Promise<void> {
    const state = this.state;
    const plane = this.deps.prWatchControlPlane;
    if (
      !this.running ||
      this.instanceStalled ||
      !state ||
      !this.client ||
      !plane
    )
      return;
    const watch = (state.watch ??= { prs: {} });
    // Durable pending re-drives before new detection: a restart replays the
    // same events into the control plane's idempotent injection.
    await this.drainPrWatchPending();
    if (!this.running) return;
    let bindings: GithubPrWatchBinding[];
    try {
      bindings = await plane.listPrWatchBindings();
    } catch (error) {
      if (this.isRegistrationRefusal(error)) {
        this.registeredGeneration = 0;
        return;
      }
      this.log(`Managed GitHub PR watch binding list failed: ${String(error)}`);
      return;
    }
    const byKey = new Map<string, GithubPrWatchBinding>();
    for (const binding of bindings) {
      if (
        typeof binding.owner !== 'string' ||
        !binding.owner ||
        typeof binding.repo !== 'string' ||
        !binding.repo ||
        !Number.isSafeInteger(binding.prNumber) ||
        binding.prNumber < 1 ||
        !Array.isArray(binding.events)
      )
        continue;
      const events = binding.events.filter(
        (event): event is ManagedGithubPrTransition =>
          (MANAGED_GITHUB_PR_TRANSITIONS as readonly string[]).includes(event),
      );
      // A binding with no recognized event costs no observation (the retired
      // watch skipped pulls.get for a comment-only channel for the same reason).
      if (events.length === 0) continue;
      const key = prWatchKey(binding.owner, binding.repo, binding.prNumber);
      // One baseline per PR however the list spells it; the binding contract
      // uniquifies (owner, repo, prNumber), so a duplicate is defensive only.
      if (!byKey.has(key)) byKey.set(key, { ...binding, events });
    }
    // Prune unbound entries only once their pending drained: an in-flight
    // transition keeps its baseline so a rebind does not re-fire it.
    let pruned = false;
    for (const key of Object.keys(watch.prs)) {
      if (!byKey.has(key) && !watch.prs[key]!.pending?.length) {
        delete watch.prs[key];
        pruned = true;
      }
    }
    if (pruned) {
      try {
        this.persist();
      } catch (error) {
        this.log(
          `Managed GitHub could not persist the PR watch prune: ${persistErrorText(error)}; it retries on the next tick.`,
        );
      }
    }
    // Rotate the observation window across the stably-ordered binding list:
    // each tick observes a capped window starting at the durable sweep offset
    // and advances it, so every binding is observed across successive ticks
    // rather than only the first cap (the daemon watch's sweepStart). A plain
    // break would starve every binding past the cap for the life of the list.
    const entries = [...byKey.entries()];
    const start =
      entries.length > 0 ? (watch.sweepStart ?? 0) % entries.length : 0;
    let observed = 0;
    for (let i = 0; i < entries.length && observed < PR_WATCH_LIMIT; i++) {
      if (!this.running) return;
      const [key, binding] = entries[(start + i) % entries.length]!;
      observed += 1;
      try {
        await this.observePr(key, binding);
      } catch (error) {
        if (this.isRegistrationRefusal(error)) {
          this.registeredGeneration = 0;
          return;
        }
        if (isWatchPassAbort(error)) {
          // A shared credential/rate-limit failure condemns the whole pass:
          // walking the rest would issue one doomed request per watched PR.
          this.log(
            `Managed GitHub PR watch pass aborted at ${key} (credential/rate limit): ${String(error)}`,
          );
          break;
        }
        if (isDefinitiveGithubReadFailure(error)) {
          // Per-PR permanent failure: a deleted or inaccessible PR answers
          // the same refusal forever; isolate it, keep watching the rest.
          this.log(
            `Managed GitHub PR watch skips unreadable PR ${key}: ${String(error)}`,
          );
          continue;
        }
        this.log(`Managed GitHub PR watch failed for ${key}: ${String(error)}`);
      }
    }
    if (entries.length > PR_WATCH_LIMIT) {
      this.log(
        `Managed GitHub PR watch cap: observed ${observed}/${entries.length} bound PRs this tick; the window rotates so the rest are observed on later ticks.`,
      );
    }
    const nextSweepStart =
      entries.length > 0 ? (start + observed) % entries.length : 0;
    if (watch.sweepStart !== nextSweepStart) {
      watch.sweepStart = nextSweepStart;
      try {
        this.persist();
      } catch (error) {
        this.log(
          `Managed GitHub could not persist the PR watch sweep offset: ${persistErrorText(error)}; it retries on the next tick.`,
        );
      }
    }
    await this.drainPrWatchPending();
  }

  /**
   * One PR observation: compare against the persisted baseline, queue the
   * detected transitions, and commit baseline + pending in one write BEFORE
   * any injection side effect (the retired watch's atomicity discipline).
   */
  private async observePr(
    key: string,
    binding: GithubPrWatchBinding,
  ): Promise<void> {
    const watch = this.state!.watch!;
    const client = this.client!;
    const previous = watch.prs[key];
    const pr = await client.getPullRequest(
      binding.owner,
      binding.repo,
      binding.prNumber,
    );
    const firstObservation = previous === undefined;
    // A missing head never overwrites the last known one (the daemon's
    // UNKNOWN no-overwrite rule).
    const headSha = pr.headSha ?? previous?.headSha;
    const headChanged =
      pr.headSha !== undefined &&
      previous?.headSha !== undefined &&
      pr.headSha !== previous.headSha;
    // A merged/closed PR is terminal (the daemon's "merged is terminal" rule):
    // it must not drive a CI-failure turn for a check that concludes after the
    // merge, and its binding is retired below so it stops consuming a slot.
    const terminal = pr.state === 'closed';
    const detected: Array<{
      transition: ManagedGithubPrTransition;
      evidence: string;
    }> = [];
    if (
      !firstObservation &&
      !terminal &&
      headChanged &&
      binding.events.includes('head_change')
    ) {
      detected.push({
        transition: 'head_change',
        evidence: `New commits pushed: head moved from ${previous!.headSha} to ${pr.headSha}.`,
      });
    }
    // The CI read is gated on the ci_failure subscription and skipped once
    // this head already fired: no ci_failure can result, so the request would
    // be pure budget. A head change resets the pin and re-checks.
    let ci: GithubCiObservation | undefined;
    if (
      !terminal &&
      pr.headSha &&
      binding.events.includes('ci_failure') &&
      previous?.ciFiredSha !== pr.headSha
    ) {
      try {
        ci = await client.getCiStatus(binding.owner, binding.repo, pr.headSha);
      } catch (error) {
        if (isWatchPassAbort(error)) throw error;
        // CI is a refinement of the pulls.get baseline, not a dependency: a
        // persistent Checks-endpoint failure must not suppress head_change /
        // merge_conflict, whose data already arrived. Keep the stored ci.
        this.log(
          `Managed GitHub CI read failed for ${key}; continuing without CI this tick: ${String(error)}`,
        );
      }
    }
    const prevCiForThisHead = headChanged ? undefined : previous?.ci;
    if (
      !firstObservation &&
      ci?.aggregate === 'failing' &&
      prevCiForThisHead !== 'failing' &&
      binding.events.includes('ci_failure')
    ) {
      const names =
        ci.failedChecks.length > 0
          ? ` Failed checks: ${ci.failedChecks.join(', ')}.`
          : '';
      const incomplete = ci.namesIncomplete
        ? ' The failed-check list may be incomplete.'
        : '';
      detected.push({
        transition: 'ci_failure',
        evidence: `CI failed on head ${pr.headSha}.${names}${incomplete}`,
      });
    }
    if (
      !firstObservation &&
      !terminal &&
      pr.mergeableState === 'dirty' &&
      previous?.mergeableState !== 'dirty' &&
      binding.events.includes('merge_conflict')
    ) {
      detected.push({
        transition: 'merge_conflict',
        evidence: 'Merge conflicts detected (mergeable_state: dirty).',
      });
    }
    const next: ManagedGithubPrWatchEntry = {
      ...(headSha !== undefined ? { headSha } : {}),
      ...(ci !== undefined
        ? { ci: ci.aggregate }
        : headChanged
          ? {}
          : previous?.ci !== undefined
            ? { ci: previous.ci }
            : {}),
      ...(pr.mergeableState !== undefined
        ? { mergeableState: pr.mergeableState }
        : previous?.mergeableState !== undefined
          ? { mergeableState: previous.mergeableState }
          : {}),
      ...(previous?.seq !== undefined ? { seq: previous.seq } : {}),
      ...(previous?.episode !== undefined ? { episode: previous.episode } : {}),
      ...(previous?.fired !== undefined ? { fired: previous.fired } : {}),
      // Copy the queue: the rollback below must restore an untouched array.
      ...(previous?.pending !== undefined
        ? { pending: [...previous.pending] }
        : {}),
      // The pin drops on a head change: the new head's ci_failure is fresh.
      ...(!headChanged && previous?.ciFiredSha !== undefined
        ? { ciFiredSha: previous.ciFiredSha }
        : {}),
    };
    const detectedAt = (this.deps.now ?? Date.now)();
    const prId = `${binding.owner}/${binding.repo}#${binding.prNumber}`;
    // The occurrence watermark is durable per PR and outlives prune/rebind:
    // the admission ledger is permanent and keyed without a binding
    // discriminant, so a rebind must resume the counter, not restart it and
    // re-derive an already-admitted input id. Seed from the watermark (which
    // survives the baseline prune), falling back to the entry for old state.
    let episode = watch.episodes?.[key] ?? previous?.episode ?? 0;
    for (const event of detected) {
      // The inject identity needs a head; an observation without one cannot
      // produce a deliverable event.
      if (headSha === undefined) continue;
      let dedupeKey: string;
      if (event.transition === 'ci_failure') {
        dedupeKey = `prw:ci_failure:${prId}:${headSha}:${detectedAt}`;
      } else {
        next.seq = (next.seq ?? 0) + 1;
        dedupeKey = `prw:${event.transition}:${prId}:${next.seq}:${detectedAt}`;
      }
      // ci_failure matches by PR+SHA prefix: once per head across flaps and
      // pending episodes; the other transitions match their exact episode key.
      const ciPrefix =
        event.transition === 'ci_failure'
          ? `prw:ci_failure:${prId}:${headSha}:`
          : undefined;
      const recorded = (k: string): boolean =>
        ciPrefix !== undefined ? k.startsWith(ciPrefix) : k === dedupeKey;
      // The carried pin from a prior tick: this head already fired ci_failure.
      if (event.transition === 'ci_failure' && next.ciFiredSha === headSha)
        continue;
      // Pin any failing head we evaluated even when the ring/pending suppress
      // the event (a force-push back to a fired head), so the CI read gate
      // stops re-issuing checks on a head that can never fire again.
      if (event.transition === 'ci_failure') next.ciFiredSha = headSha;
      if (next.fired?.some(recorded)) continue;
      if (next.pending?.some((p) => recorded(p.key))) continue;
      // A new occurrence gets a fresh durable episode; it is persisted with the
      // pending entry so a crash-replay derives the same control-plane input id.
      episode += 1;
      next.episode = episode;
      (watch.episodes ??= {})[key] = episode;
      (next.pending ??= []).push({
        key: dedupeKey,
        episode,
        owner: binding.owner,
        repo: binding.repo,
        prNumber: binding.prNumber,
        transition: event.transition,
        headSha,
        evidence: sanitizePromptText(event.evidence),
        detectedAt: new Date(detectedAt).toISOString(),
      });
      if (next.pending.length > MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT) {
        const dropped = next.pending.shift()!;
        this.log(
          `Managed GitHub PR watch pending overflow for ${key}: dropped ${dropped.key} undelivered (cap ${MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT}).`,
        );
      }
    }
    // Bound the watermark map separately from the prunable baselines; evict the
    // oldest watermarks past the cap (a rebind of an evicted PR restarts its
    // counter, the bounded-state tradeoff for a permanent admission ledger).
    const episodes = watch.episodes;
    if (episodes) {
      const keys = Object.keys(episodes);
      for (
        let i = 0;
        i < keys.length - MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT;
        i++
      ) {
        delete episodes[keys[i]!];
      }
    }
    // Persist only when the observation actually changed the entry: an
    // all-quiet tick must not pay one full-state write + fsync per binding.
    const entryChanged =
      previous === undefined ||
      JSON.stringify(next) !== JSON.stringify(previous);
    watch.prs[key] = next;
    if (entryChanged) {
      try {
        this.persist();
      } catch (error) {
        // A failed save must not leave the detection in memory: roll back so
        // the next tick re-observes and re-derives it (the pollInbound discipline).
        if (previous === undefined) delete watch.prs[key];
        else watch.prs[key] = previous;
        throw error;
      }
    }
    // A terminal (merged/closed) PR's binding is retired so it stops consuming
    // an observation slot and the PR can be bound to another Session.
    // Best-effort and idempotent: while the PR stays terminal the next tick
    // re-drives the retire; the episode watermark survives the later prune.
    if (terminal) {
      // Same post-await side-effect discipline as the rest of the pass: a
      // process that lost the state-file lock or was stopped must not delete
      // a binding another owner now serves.
      if (!this.running || this.ownershipLost) return;
      const plane = this.deps.prWatchControlPlane;
      if (plane) {
        try {
          await plane.retirePrWatchBinding({
            owner: binding.owner,
            repo: binding.repo,
            prNumber: binding.prNumber,
          });
        } catch (error) {
          if (this.isRegistrationRefusal(error)) {
            this.registeredGeneration = 0;
            return;
          }
          this.log(
            `Managed GitHub could not retire the terminal PR binding ${key}: ${String(error)}; it retries on the next tick.`,
          );
        }
      }
    }
  }

  /**
   * Drain the durable pending queue oldest-first. Injection is the only side
   * effect: success records the fired key and removes the entry in one write;
   * a transient failure keeps the entry for the next tick; a deterministic
   * refusal drops it visibly. Never posts a public comment.
   */
  private async drainPrWatchPending(): Promise<void> {
    const watch = this.state!.watch;
    const plane = this.deps.prWatchControlPlane;
    if (!watch || !plane) return;
    for (const entry of Object.values(watch.prs)) {
      while (entry.pending && entry.pending.length > 0) {
        if (!this.running) return;
        const pending = entry.pending[0]!;
        try {
          await plane.injectPrEvent({
            owner: pending.owner,
            repo: pending.repo,
            prNumber: pending.prNumber,
            transition: pending.transition,
            headSha: pending.headSha,
            evidence: pending.evidence,
            episode: pending.episode,
          });
        } catch (error) {
          if (this.isRegistrationRefusal(error)) {
            this.registeredGeneration = 0;
            return;
          }
          const status = (error as { status?: unknown }).status;
          if (
            status === 400 ||
            status === 403 ||
            status === 404 ||
            status === 409
          ) {
            // A deterministic refusal never converges on re-drive (the
            // binding or its Session is gone, or the request is refused):
            // drop visibly, the submit() refusal discipline.
            this.log(
              `Managed GitHub PR event ${pending.key} injection was refused (${status}); the event drops.`,
            );
            // A pump-less bound Session can never run a pr_event turn: retire
            // the binding rather than leave it listed to drop every future
            // transition (the Harness refusal itself stays — R1-4).
            if (
              (error as { code?: unknown }).code === 'pr_event_wake_unavailable'
            ) {
              if (!this.running || this.ownershipLost) return;
              try {
                await plane.retirePrWatchBinding({
                  owner: pending.owner,
                  repo: pending.repo,
                  prNumber: pending.prNumber,
                });
              } catch (retireError) {
                if (this.isRegistrationRefusal(retireError)) {
                  this.registeredGeneration = 0;
                  return;
                }
                this.log(
                  `Managed GitHub could not retire the pump-less PR binding ${pending.key}: ${String(retireError)}.`,
                );
              }
            }
            entry.pending = entry.pending.slice(1);
            try {
              this.persist();
            } catch (persistError) {
              this.log(
                `Managed GitHub could not persist the refused PR event drop of ${pending.key}: ${persistErrorText(persistError)}; a restart re-drives it into the same refusal.`,
              );
            }
            continue;
          }
          // A lost answer or transient refusal: the entry stays pending so
          // the next tick re-drives the identical event into the control
          // plane's derived-id idempotency. Isolate the failure to this PR's
          // queue (break) and keep draining the other bindings — a single
          // unhealthy Session (e.g. history maintenance answering 503) must
          // not starve every other bound PR in the channel.
          this.log(
            `Managed GitHub PR event ${pending.key} injection failed (${String(error)}); it stays pending for the next tick.`,
          );
          break;
        }
        // Success: record fired and remove pending in one durable write. A
        // failed write rolls both back so the next tick re-drives the same
        // event into the idempotent replay — never a half-settled memory.
        const previousPending = entry.pending;
        const previousFired = entry.fired;
        entry.pending = entry.pending.slice(1);
        entry.fired = [...(entry.fired ?? []), pending.key].slice(
          -MANAGED_GITHUB_PR_WATCH_FIRED_LIMIT,
        );
        try {
          this.persist();
        } catch (error) {
          entry.pending = previousPending;
          entry.fired = previousFired;
          this.log(
            `Managed GitHub could not persist the fired PR event ${pending.key}: ${persistErrorText(error)}; it re-drives on the next tick.`,
          );
          return;
        }
      }
    }
  }

  private recordDispatched(key: string): void {
    const state = this.state!;
    if (!state.cursor.dispatchedComments.includes(key)) {
      state.cursor.dispatchedComments = [
        ...state.cursor.dispatchedComments,
        key,
      ].slice(-DISPATCHED_COMMENTS_LIMIT);
    }
  }

  private async submit(
    eventId: string,
    event: ManagedInboundEvent,
  ): Promise<void> {
    const state = this.state!;
    try {
      const admitted = await this.controlPlane.submitInbound(event);
      const wasHeld = state.pending.some(
        (entry) => entry.eventId === eventId && entry.held === true,
      );
      const previousPending = state.pending;
      const previousDispatched = state.cursor.dispatchedComments;
      const previousRefusals = state.instanceRefusals;
      const previousStalled = this.instanceStalled;
      state.pending = state.pending.filter(
        (entry) => entry.eventId !== eventId,
      );
      this.recordDispatched(eventId.slice(GITHUB_EVENT_PREFIX.length));
      if (!admitted.replayed && wasHeld) {
        state.instanceRefusals = 0;
        this.instanceStalled = false;
      } else {
        this.liftStallWhenNothingHeld();
      }
      try {
        this.persist();
        this.loggedSettleFailure = false;
      } catch (error) {
        // The admission answer arrived but the settle never reached disk.
        // Roll back everything the settle touched so the next tick re-drives
        // the identical event into the idempotent replayed answer; a
        // half-settled memory state would drop the claim from this process's
        // re-drive while disk still holds it (the DingTalk discipline).
        state.pending = previousPending;
        state.cursor.dispatchedComments = previousDispatched;
        state.instanceRefusals = previousRefusals;
        this.instanceStalled = previousStalled;
        // Latched: the rollback keeps the claim pending, so every tick
        // re-drives it and an unlatched line would re-log per claim per tick.
        if (!this.loggedSettleFailure) {
          this.loggedSettleFailure = true;
          this.log(
            `Managed GitHub could not persist the admission of ${eventId}: ${persistErrorText(error)}; it re-drives on the next tick.`,
          );
        }
        return;
      }
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      if (this.isRegistrationRefusal(error)) {
        this.registeredGeneration = 0;
        return;
      }
      if (
        typeof status === 'number' &&
        (status === 400 ||
          status === 403 ||
          status === 409 ||
          (status === 404 && INSTANCE_SCOPED_REFUSALS.has(String(code))))
      ) {
        if (INSTANCE_SCOPED_REFUSALS.has(String(code))) {
          state.instanceRefusals = (state.instanceRefusals ?? 0) + 1;
          const entry = state.pending.find((p) => p.eventId === eventId);
          if (
            entry?.held ||
            state.instanceRefusals > INSTANCE_REFUSAL_DROP_LIMIT
          ) {
            if (!entry?.held) {
              state.pending = state.pending.map((p) =>
                p.eventId === eventId ? { ...p, held: true } : p,
              );
              try {
                this.persist();
              } catch (error) {
                // The hold stays armed in memory for this process; a restart
                // before the write lands re-arms it after one refusal, which
                // is the bounded first-occurrence tradeoff, never a loss.
                this.log(
                  `Managed GitHub could not persist the held claim ${eventId}: ${persistErrorText(error)}; the stall stays armed in memory.`,
                );
              }
            }
            if (!this.instanceStalled) {
              this.instanceStalled = true;
              this.log(
                `Managed GitHub stopped admitting: every comment is refused with ${status} ${String(code)}; check the instance's --workspace and --actor flags.`,
              );
            }
            return;
          }
        }
        this.log(
          `Managed GitHub admission of ${eventId} was refused (${status}); the comment is skipped.`,
        );
        state.pending = state.pending.filter((p) => p.eventId !== eventId);
        this.recordDispatched(eventId.slice(GITHUB_EVENT_PREFIX.length));
        this.liftStallWhenNothingHeld();
        try {
          this.persist();
        } catch (error) {
          // The drop is already applied in memory; disk keeps the claim, so a
          // restart re-drives it into the same deterministic refusal and drops
          // it again. Never abort the batch over the failed write.
          this.log(
            `Managed GitHub could not persist the refused admission of ${eventId}: ${persistErrorText(error)}; a restart re-drives it into the same refusal.`,
          );
        }
        return;
      }
      // A lost answer or a transient refusal: the claim, with its persisted
      // event, stays in pending so the next tick re-drives the identical
      // event, never a rebuilt one.
    }
  }

  /**
   * The stall exists to be lifted by the held claim's probe: when the last
   * held claim leaves without proving the binding, no probe remains, and a
   * flag kept armed would gate every later tick. The refusal streak is NOT
   * reset here: only the held claim's fresh admission proves the binding.
   */
  private liftStallWhenNothingHeld(): void {
    if (
      this.instanceStalled &&
      !this.state!.pending.some((entry) => entry.held === true)
    ) {
      this.instanceStalled = false;
      this.log(
        'Managed GitHub admission resumed; no claim remains held, and the refusal streak still stands for the next instance-scoped refusal.',
      );
    }
  }

  private async resubmitPending(): Promise<void> {
    const state = this.state;
    if (!state) return;
    // Probe held claims first: the stall lifts only on a held claim's fresh
    // admission, and push order lets an earlier claim whose answer never
    // comes shadow the one probe per tick. The sort is stable.
    const ordered = [...state.pending].sort(
      (a, b) => Number(b.held === true) - Number(a.held === true),
    );
    for (const entry of ordered) {
      if (!this.running) return;
      if (
        !this.senderAllowed(entry.event.senderId) ||
        !this.repoAllowed(entry.event.chatId)
      ) {
        // The policy moved on since the claim: the persisted event drops
        // visibly rather than drive a Session the current policy forbids.
        // The repo allowlist gets the same re-check as the sender policy —
        // a claim staged under a wider filter must not post into a repo the
        // operator has since excluded.
        this.log(
          `Managed GitHub event ${entry.eventId} is refused by the current sender policy or repo allowlist; its claim drops.`,
        );
        state.pending = state.pending.filter(
          (p) => p.eventId !== entry.eventId,
        );
        this.recordDispatched(entry.eventId.slice(GITHUB_EVENT_PREFIX.length));
        this.liftStallWhenNothingHeld();
        try {
          this.persist();
        } catch (error) {
          // Same shape as the refusal drop: memory applied, disk keeps the
          // claim, a restart re-drives it into the same policy refusal.
          this.log(
            `Managed GitHub could not persist the policy drop of ${entry.eventId}: ${persistErrorText(error)}; a restart re-drives it into the same refusal.`,
          );
        }
        continue;
      }
      await this.submit(entry.eventId, entry.event);
      if (this.registeredGeneration === 0 || this.instanceStalled) return;
    }
  }

  private isRegistrationRefusal(error: unknown): boolean {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return (
      (status === 404 && String(code) === CHANNEL_NOT_FOUND) ||
      (status === 409 &&
        (code === 'channel_generation_unregistered' ||
          code === 'channel_disconnected'))
    );
  }

  private async ensureRegistered(state: ManagedGithubState): Promise<void> {
    if (this.registeredGeneration === state.generation) return;
    try {
      await this.controlPlane.register({
        platform: 'github',
        accountId: this.accountId!,
        accountGeneration: state.generation,
        policy: this.policy,
      });
      this.registeredGeneration = state.generation;
    } catch (error) {
      this.registeredGeneration = 0;
      throw error;
    }
  }

  private async pullOutbox(): Promise<void> {
    // Guard before the claim, not in the per-delivery loop: the claim itself
    // moves up to CLAIM_BATCH deliveries to sending server-side, so a stop
    // that lands mid-tick must not claim a batch it would then abandon.
    if (!this.running || !this.state) return;
    let claimed: ManagedClaimedDelivery[];
    try {
      claimed = await this.controlPlane.claimDeliveries(CLAIM_BATCH);
    } catch (error) {
      if (this.isRegistrationRefusal(error)) {
        this.registeredGeneration = 0;
        return;
      }
      throw error;
    }
    for (const delivery of claimed) {
      if (!this.running) return;
      await this.send(delivery);
    }
  }

  private async send(delivery: ManagedClaimedDelivery): Promise<void> {
    const state = this.state!;
    const context = delivery.replyContext as Partial<GithubReplyContext> | null;
    const owner = context?.owner;
    const repo = context?.repo;
    const issueNumber = context?.issueNumber;
    const chatId =
      typeof owner === 'string' && typeof repo === 'string'
        ? `${owner}/${repo}`.toLowerCase()
        : '';
    if (
      typeof owner !== 'string' ||
      !owner ||
      typeof repo !== 'string' ||
      !repo ||
      !Number.isSafeInteger(issueNumber) ||
      (issueNumber as number) < 1 ||
      // Re-check the current policy before posting, mirroring the DingTalk /
      // email send-time re-check: a sender or repo the operator has since
      // excluded must not receive the reply even though it was admitted.
      !this.senderAllowed(context?.senderId ?? '') ||
      !this.repoAllowed(chatId)
    ) {
      // One delivery's unreportable rejection receipt must never abort the
      // claimed batch: the deliveries behind it were already moved to sending
      // server-side and would settle unknown (lost) if the tick escaped here.
      try {
        await this.controlPlane.receipt(delivery.deliveryId, {
          outcome: 'rejected',
        });
      } catch (error) {
        if (this.isRegistrationRefusal(error)) {
          this.registeredGeneration = 0;
          return;
        }
        this.log(
          `Managed GitHub rejection receipt for ${delivery.deliveryId} could not be reported (${String(error)}); the rest of the batch still sends.`,
        );
      }
      return;
    }
    for (const segment of delivery.segments) {
      if (!this.running) return;
      const previousOutbound = state.outbound;
      state.outbound = [
        ...state.outbound,
        { deliveryId: delivery.deliveryId, ordinal: segment.ordinal },
      ].slice(-MANAGED_OUTBOUND_LIMIT);
      try {
        this.persist();
      } catch (error) {
        // The ledger entry is the double-send guard: without it on disk, a
        // crash after the comment post would re-send on restart. Roll back
        // and abandon this delivery before the side effect; the lease
        // reconciler settles it unknown (the DingTalk discipline).
        state.outbound = previousOutbound;
        this.log(
          `Managed GitHub could not persist the outbound ledger for ${delivery.deliveryId}: ${persistErrorText(error)}; the send is abandoned and the lease reconciler settles it.`,
        );
        return;
      }
      let outcome: ManagedReceipt;
      try {
        // One ledger segment is one comment: the producer's 48 KiB UTF-8
        // segment cap is below GitHub's 65,536-character body cap, so no
        // provider-side chunking exists here.
        const posted = await this.client!.postComment(
          owner,
          repo,
          issueNumber as number,
          segment.text,
        );
        outcome = {
          outcome: 'accepted',
          ordinal: segment.ordinal,
          providerMessageId: String(posted.id),
          acceptedAt: (this.deps.now ?? Date.now)(),
        };
      } catch (error) {
        const definitive = (error as GithubSendFailure).definitive;
        outcome = definitive ? { outcome: 'rejected' } : { outcome: 'unknown' };
      }
      const entry = state.outbound.find(
        (candidate) =>
          candidate.deliveryId === delivery.deliveryId &&
          candidate.ordinal === segment.ordinal,
      );
      if (entry) entry.receipt = outcome;
      try {
        this.persist();
      } catch (error) {
        // The send already happened: report the outcome to the control plane
        // even if the local write failed — the server-side settle is the
        // durable record, and the orphan re-drive replays the in-memory
        // receipt until the local write lands (the DingTalk discipline).
        this.log(
          `Managed GitHub could not persist the receipt for ${delivery.deliveryId}: ${persistErrorText(error)}; it is still reported and re-driven locally.`,
        );
      }
      try {
        await this.controlPlane.receipt(delivery.deliveryId, outcome);
      } catch (error) {
        // One delivery's unreportable receipt never aborts the claimed
        // batch: the entry stays outbound with the outcome persisted, so
        // every later tick re-drives exactly this receipt — never the send.
        this.log(
          `Managed GitHub receipt for ${delivery.deliveryId} could not be reported (${String(error)}); it re-drives on the next tick.`,
        );
        return;
      }
      state.outbound = state.outbound.filter(
        (candidate) =>
          !(
            candidate.deliveryId === delivery.deliveryId &&
            candidate.ordinal === segment.ordinal
          ),
      );
      try {
        this.persist();
      } catch (error) {
        // The receipt is already reported; disk keeps the entry, so the next
        // tick's orphan re-drive replays the receipt and removes it again.
        this.log(
          `Managed GitHub could not persist the settled segment of ${delivery.deliveryId}: ${persistErrorText(error)}; the orphan re-drive removes it on the next tick.`,
        );
      }
      if (outcome.outcome !== 'accepted') return;
    }
  }

  private async reportOrphanedOutbound(): Promise<void> {
    const state = this.state;
    if (!state) return;
    for (const entry of [...state.outbound]) {
      if (!this.running) return;
      // A segment whose send produced a persisted receipt replays that
      // receipt — the control plane may already hold it (its answer was
      // lost) and settles idempotently. Only a segment whose send never
      // produced an outcome settles unknown.
      try {
        await this.controlPlane.receipt(
          entry.deliveryId,
          entry.receipt ?? { outcome: 'unknown' },
        );
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const code = (error as { code?: unknown }).code;
        if (this.isRegistrationRefusal(error)) {
          this.registeredGeneration = 0;
          this.log(
            `Managed GitHub receipt for ${entry.deliveryId} was refused as not registered (${String(status)} ${String(code)}); it re-drives after the next tick re-registers.`,
          );
          return;
        }
        // A deterministic refusal never converges on re-drive, and a held
        // entry runs before every outbox pull: it would stall every later
        // delivery. Drop it visibly; the lease reconciler records the
        // delivery unknown.
        if (
          !(
            status === 400 ||
            status === 403 ||
            status === 409 ||
            (status === 404 && code === 'delivery_not_found')
          )
        ) {
          throw error;
        }
        this.log(
          `Managed GitHub receipt for ${entry.deliveryId} was refused (${String(status)}); it is dropped.`,
        );
      }
      state.outbound = state.outbound.filter(
        (candidate) => candidate !== entry,
      );
      try {
        this.persist();
      } catch (error) {
        // Disk keeps the entry; the next tick replays the same idempotent
        // receipt and retries the removal. Never abort the remaining orphans.
        this.log(
          `Managed GitHub could not persist the orphan removal of ${entry.deliveryId}: ${persistErrorText(error)}; it re-drives on the next tick.`,
        );
      }
    }
  }

  private persist(): void {
    // Once the lock is compromised the state file belongs to another process;
    // never rewrite it, even from an in-flight tick's post-await persist.
    if (this.ownershipLost) return;
    if (this.state) this.store.save(this.state);
  }

  private stop(): void {
    this.running = false;
    this.abort?.abort();
    try {
      this.client?.disconnect();
    } catch {
      // The client may already be closed; stopping is best-effort.
    }
  }

  private async release(): Promise<void> {
    const releaseLock = this.releaseLock;
    this.releaseLock = undefined;
    if (releaseLock) await releaseLock().catch(() => undefined);
  }
}

// The store rethrows a fixed sentence (the state file may hold platform data)
// but preserves the fs error on `cause`. Log the cause so ENOSPC, EACCES and a
// read-only directory are diagnosable instead of hidden behind the sentence.
// Mirrors the DingTalk adapter's persistErrorText.
function persistErrorText(error: unknown): string {
  return String((error as Error).cause ?? error);
}

// One baseline per PR, lowercased like the Legacy group id so two spellings
// of one repository share one watch.
function prWatchKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`.toLowerCase();
}

// Fail-fast statuses that condemn the WHOLE watch pass, not just one PR: a
// bad credential or an exhausted rate budget is shared by every watched PR
// (the retired watch's isWatchPassAbortError). A bare permission 403 stays
// per-PR so it cannot starve the other watched PRs.
function isWatchPassAbort(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  return (
    status === 401 ||
    status === 429 ||
    (status === 403 && isRateLimitAnswer(error))
  );
}

function fitSubject(title: string | undefined): string | null {
  if (!title) return null;
  let bounded = title.slice(0, MAX_SUBJECT_CHARS);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  return bounded;
}

/**
 * The wire admits at most MAX_WIRE_TEXT_CHARS characters and the Harness
 * envelope at most ENVELOPE_BYTE_LIMIT bytes of event JSON. Clamp to both so
 * an over-long comment is admitted truncated instead of meeting a
 * deterministic 400 and being dropped whole. Copied from the DingTalk
 * adapter's clamp (managed-dingtalk-adapter.ts), not email's raw-UTF-8
 * budget: a CJK comment can sit under the character line yet overflow the
 * byte envelope, and escape-heavy text inflates the JSON-serialized length.
 */
function fitInboundText(text: string): string {
  // The cap counts UTF-16 units (the server's maxTextChars does too), so a
  // code-point cap could overshoot it; but a UTF-16 slice can land inside a
  // surrogate pair, so back off a trailing high surrogate to keep the text
  // well-formed.
  let bounded = text.slice(0, MAX_WIRE_TEXT_CHARS);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  const byteLimit = ENVELOPE_BYTE_LIMIT - TEXT_ENVELOPE_OVERHEAD_BYTES;
  // The bound is enforced on the JSON-serialized envelope, where a control
  // character costs six bytes and a quote/backslash two — not on the raw
  // UTF-8 length. Budget the escaped length and cut by code points until it
  // fits.
  const encodedBytes = (s: string): number =>
    Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;
  if (encodedBytes(bounded) <= byteLimit) return bounded;
  const chars = Array.from(bounded);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodedBytes(chars.slice(0, mid).join('')) <= byteLimit) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('');
}
