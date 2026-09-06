import type {
  DaemonClient,
  DaemonSessionLiveState,
  DaemonSessionListPage,
  DaemonSessionListPageOptions,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';

export type SessionCatalogRouteKind = 'legacy' | 'qualified';

export interface SessionCatalogQuery {
  routeKind: SessionCatalogRouteKind;
  workspaceCwd: string;
  options: DaemonSessionListPageOptions;
}

export interface SessionCatalogSnapshot {
  page?: DaemonSessionListPage;
  loading: boolean;
  stale: boolean;
  error?: Error;
  updatedAt?: number;
}

export interface SessionCatalogSubscriptionOptions {
  autoLoad?: boolean;
  maxAgeMs?: number;
  pollIntervalMs?: number;
}

type RequestPriority = 'interactive' | 'initial' | 'poll';

interface Subscriber {
  listener: () => void;
  autoLoad: boolean;
  pollIntervalMs?: number;
}

interface Waiter {
  revision: number;
  liveStateCoordinated: boolean;
  resolve: (page: DaemonSessionListPage) => void;
  reject: (error: Error) => void;
}

interface QueueJob {
  entry: CatalogEntry;
  priority: number;
  background: boolean;
  sequence: number;
  staged?: {
    revision: number;
    resolve: (page: DaemonSessionListPage) => void;
    reject: (error: Error) => void;
  };
}

interface CatalogEntry {
  key: string;
  query: SessionCatalogQuery;
  snapshot: SessionCatalogSnapshot;
  subscribers: Set<Subscriber>;
  desiredRevision: number;
  acceptedRevision: number;
  runningRevision?: number;
  runningPromise?: Promise<void>;
  runningStaged?: boolean;
  queuedJob?: QueueJob;
  trailingPriority?: number;
  trailingBackground?: boolean;
  waiters: Waiter[];
  retryAt?: number;
  invalidated: boolean;
  pollTimer?: ReturnType<typeof setTimeout>;
  nextPollAt?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface StagedCatalogPage {
  key: string;
  revision: number;
  page: DaemonSessionListPage;
}

export interface StagedWorkspaceSessionCatalog {
  workspaceCwd: string;
  pages: StagedCatalogPage[];
  complete: boolean;
}

const PRIORITY: Record<RequestPriority, number> = {
  interactive: 0,
  initial: 1,
  poll: 2,
};

export const SESSION_CATALOG_ERROR_RETRY_MS = 30_000;
export const SESSION_CATALOG_RETENTION_MS = 30_000;
export const SESSION_CATALOG_TRAILING_REFRESH_MS = 2_000;

const EMPTY_SNAPSHOT: SessionCatalogSnapshot = {
  loading: false,
  stale: true,
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function getSessionCatalogQueryKey(query: SessionCatalogQuery): string {
  const options = query.options;
  return JSON.stringify([
    query.routeKind,
    query.workspaceCwd,
    options?.pageSize ?? null,
    options?.cursor ?? null,
    options?.archiveState ?? null,
    options?.view ?? null,
    options?.group ?? null,
    options?.parentSessionId ?? null,
    options?.sourceType ?? null,
    options?.sourceId ?? null,
  ]);
}

function hasAutoLoadSubscriber(entry: CatalogEntry): boolean {
  return Array.from(entry.subscribers).some(
    (subscriber) => subscriber.autoLoad,
  );
}

// Mirrors the server's getSummaryActivityTime: activity is updatedAt with a
// createdAt lower bound fallback, and an unparsable stamp sorts last.
function getSessionActivityTime(session: DaemonSessionSummary): number {
  const time = Date.parse(session.updatedAt ?? session.createdAt ?? '');
  return Number.isFinite(time) ? time : 0;
}

function compareSessionsByActivity(
  organized: boolean,
  a: DaemonSessionSummary,
  b: DaemonSessionSummary,
): number {
  if (organized) {
    const byPinned = Number(b.isPinned === true) - Number(a.isPinned === true);
    if (byPinned !== 0) return byPinned;
  }
  const byTime = getSessionActivityTime(b) - getSessionActivityTime(a);
  if (byTime !== 0) return byTime;
  return a.sessionId.localeCompare(b.sessionId);
}

// Only cursor-less, non-archived pages own an activity reorder: an archived
// page never accepts a live activity stamp, and a cursored page's rows are
// fenced by the cursor boundary, so a fresher row belongs to an earlier page.
function ownsActivityReorder(entry: CatalogEntry): boolean {
  return (
    entry.query.options.archiveState !== 'archived' &&
    entry.query.options.cursor === undefined
  );
}

function liveSessionSnapshotsEqual(
  previous: ReadonlyMap<string, DaemonSessionLiveState>,
  next: ReadonlyMap<string, DaemonSessionLiveState>,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [sessionId, session] of next) {
    const prior = previous.get(sessionId);
    if (
      !prior ||
      prior.clientCount !== session.clientCount ||
      prior.hasActivePrompt !== session.hasActivePrompt ||
      prior.isWaitingForPermission !== session.isWaitingForPermission ||
      prior.isWaitingForUserQuestion !== session.isWaitingForUserQuestion ||
      prior.updatedAt !== session.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

function getPollInterval(entry: CatalogEntry): number | undefined {
  let interval: number | undefined;
  for (const subscriber of entry.subscribers) {
    const candidate = subscriber.pollIntervalMs;
    if (candidate === undefined || candidate <= 0) continue;
    interval =
      interval === undefined ? candidate : Math.min(interval, candidate);
  }
  return interval;
}

export class SessionCatalogStore {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly queue: QueueJob[] = [];
  private readonly trailingRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly liveStateWorkspaceUsers = new Map<string, number>();
  private readonly liveStateWorkspaceRefreshRequests = new Map<
    string,
    'interactive' | 'invalidated'
  >();
  private readonly liveStateWakeHandlers = new Set<
    (workspaceCwd: string, bypassRetry?: boolean) => void
  >();
  private liveStateActivitySequence = 0;
  private readonly liveStatePendingActivity = new Map<
    string,
    Map<string, number>
  >();
  private readonly liveStateFailureStreaks = new Map<string, number>();
  private liveSessionRevision = 0;
  private readonly liveSessionRevisions = new Map<string, number>();
  private readonly liveSessionsByWorkspace = new Map<
    string,
    ReadonlyMap<string, DaemonSessionLiveState>
  >();
  private readonly liveSessionListeners = new Map<string, Set<() => void>>();
  private readonly liveSessionObservationListeners = new Map<
    string,
    Set<() => void>
  >();
  private activeRequests = 0;
  private activeBackgroundRequests = 0;
  private queueSequence = 0;
  private visibilityListening = false;

  constructor(private readonly client: DaemonClient) {}

  getSnapshot(query: SessionCatalogQuery): SessionCatalogSnapshot {
    return this.getOrCreateEntry(query).snapshot;
  }

  getEmptySnapshot(): SessionCatalogSnapshot {
    return EMPTY_SNAPSHOT;
  }

  retainWorkspaceLiveState(workspaceCwd: string): () => void {
    this.liveStateWorkspaceUsers.set(
      workspaceCwd,
      (this.liveStateWorkspaceUsers.get(workspaceCwd) ?? 0) + 1,
    );
    return () => {
      const remaining =
        (this.liveStateWorkspaceUsers.get(workspaceCwd) ?? 1) - 1;
      if (remaining > 0)
        this.liveStateWorkspaceUsers.set(workspaceCwd, remaining);
      else {
        this.liveStateWorkspaceUsers.delete(workspaceCwd);
        // React releases the old view before retaining its same-commit
        // replacement. Let that handoff keep the authoritative snapshot.
        queueMicrotask(() => {
          if (this.liveStateWorkspaceUsers.has(workspaceCwd)) return;
          this.liveStateWorkspaceRefreshRequests.delete(workspaceCwd);
          this.liveStatePendingActivity.delete(workspaceCwd);
          this.liveStateFailureStreaks.delete(workspaceCwd);
          this.clearLiveSessions(workspaceCwd);
          for (const entry of this.entries.values()) {
            if (entry.query.workspaceCwd !== workspaceCwd) continue;
            this.resetPollSchedule(entry);
            if (entry.waiters.length > 0) {
              entry.desiredRevision += 1;
              if (entry.queuedJob?.staged) this.removeQueuedJob(entry);
              this.ensureScheduled(entry, PRIORITY.interactive, false);
            } else if (
              entry.subscribers.size > 0 &&
              (entry.invalidated ||
                (hasAutoLoadSubscriber(entry) &&
                  (entry.snapshot.page === undefined || entry.snapshot.stale)))
            ) {
              this.requestBackground(entry, 'initial');
            }
          }
        });
      }
    };
  }

  isWorkspaceLiveStateEnabled(workspaceCwd: string): boolean {
    return this.liveStateWorkspaceUsers.has(workspaceCwd);
  }

  consumeWorkspaceLiveStateRefreshRequest(
    workspaceCwd: string,
  ): 'interactive' | 'invalidated' | undefined {
    const kind = this.liveStateWorkspaceRefreshRequests.get(workspaceCwd);
    if (kind !== undefined) {
      this.liveStateWorkspaceRefreshRequests.delete(workspaceCwd);
    }
    return kind;
  }

  onLiveStateWake(
    handler: (workspaceCwd: string, bypassRetry?: boolean) => void,
  ): () => void {
    this.liveStateWakeHandlers.add(handler);
    return () => {
      this.liveStateWakeHandlers.delete(handler);
    };
  }

  requestWorkspaceLiveStateRefresh(workspaceCwd: string): void {
    if (!this.isWorkspaceLiveStateEnabled(workspaceCwd)) return;
    this.requestLiveStateRefresh(workspaceCwd, 'interactive');
  }

  recordSessionActivity(workspaceCwd: string, sessionId: string): void {
    if (!this.isWorkspaceLiveStateEnabled(workspaceCwd)) return;
    let pending = this.liveStatePendingActivity.get(workspaceCwd);
    if (!pending) {
      pending = new Map();
      this.liveStatePendingActivity.set(workspaceCwd, pending);
    }
    pending.set(sessionId, ++this.liveStateActivitySequence);
    for (const handler of this.liveStateWakeHandlers) handler(workspaceCwd);
  }

  snapshotSessionActivity(
    workspaceCwd: string,
  ): ReadonlyMap<string, number> | undefined {
    const pending = this.liveStatePendingActivity.get(workspaceCwd);
    if (!pending || pending.size === 0) return undefined;
    return new Map(pending);
  }

  resolveSessionActivity(
    workspaceCwd: string,
    sessionId: string,
    sequence: number,
  ): void {
    const pending = this.liveStatePendingActivity.get(workspaceCwd);
    // A completion recorded while the settling request was in flight bumps
    // the sequence; that newer pending entry must survive this settle.
    if (pending?.get(sessionId) !== sequence) return;
    pending.delete(sessionId);
    if (pending.size === 0) this.liveStatePendingActivity.delete(workspaceCwd);
  }

  private requestLiveStateRefresh(
    workspaceCwd: string,
    kind: 'interactive' | 'invalidated',
    bypassRetry = false,
  ): void {
    if (
      kind !== 'interactive' &&
      this.liveStateWorkspaceRefreshRequests.get(workspaceCwd) === 'interactive'
    ) {
      return;
    }
    this.liveStateWorkspaceRefreshRequests.set(workspaceCwd, kind);
    if (kind === 'interactive') {
      for (const handler of this.liveStateWakeHandlers) {
        handler(workspaceCwd, bypassRetry);
      }
    }
  }

  subscribe(
    query: SessionCatalogQuery,
    listener: () => void,
    options: SessionCatalogSubscriptionOptions = {},
  ): () => void {
    const entry = this.getOrCreateEntry(query);
    if (entry.cleanupTimer !== undefined) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = undefined;
    }
    const subscriber: Subscriber = {
      listener,
      autoLoad: options.autoLoad === true,
      ...(options.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.pollIntervalMs }
        : {}),
    };
    entry.subscribers.add(subscriber);
    const liveStateEnabled = this.isWorkspaceLiveStateEnabled(
      query.workspaceCwd,
    );
    const retainedPageExpired =
      subscriber.autoLoad &&
      options.maxAgeMs !== undefined &&
      entry.snapshot.page !== undefined &&
      (entry.snapshot.updatedAt === undefined ||
        Date.now() - entry.snapshot.updatedAt >= options.maxAgeMs);
    if (
      liveStateEnabled &&
      (entry.snapshot.page === undefined ||
        entry.snapshot.stale ||
        retainedPageExpired)
    ) {
      this.requestLiveStateRefresh(query.workspaceCwd, 'interactive');
    }
    this.updateVisibilityListener();
    this.resetPollSchedule(entry);

    if (
      !liveStateEnabled &&
      (entry.invalidated ||
        (subscriber.autoLoad &&
          (entry.snapshot.page === undefined || entry.snapshot.stale)) ||
        retainedPageExpired)
    ) {
      this.requestBackground(entry, 'initial');
    }

    return () => {
      entry.subscribers.delete(subscriber);
      if (entry.subscribers.size === 0) {
        this.clearPollTimer(entry);
        if (entry.queuedJob?.background && entry.waiters.length === 0) {
          this.removeQueuedJob(entry);
          this.setSnapshot(entry, {
            ...entry.snapshot,
            loading: entry.runningRevision !== undefined,
          });
        }
        this.scheduleCleanup(entry);
      } else {
        this.resetPollSchedule(entry);
      }
      this.updateVisibilityListener();
    };
  }

  async refresh(
    query: SessionCatalogQuery,
    options: { interactive?: boolean } = {},
  ): Promise<DaemonSessionListPage> {
    return this.requestFresh(
      this.getOrCreateEntry(query),
      options.interactive === true,
    );
  }

  async loadOnce(
    query: SessionCatalogQuery,
    options: { fresh?: boolean } = {},
  ): Promise<DaemonSessionListPage> {
    const entry = this.getOrCreateEntry(query);
    if (
      options.fresh !== true &&
      entry.snapshot.page &&
      !entry.snapshot.stale
    ) {
      return entry.snapshot.page;
    }
    let request: Promise<DaemonSessionListPage>;
    const reusableRunningRequest =
      entry.runningRevision !== undefined &&
      entry.snapshot.loading &&
      !entry.runningStaged;
    const reusableQueuedRequest = entry.queuedJob && !entry.queuedJob.staged;
    if (
      options.fresh !== true &&
      (reusableRunningRequest || reusableQueuedRequest)
    ) {
      request = this.createWaiter(entry, entry.desiredRevision, false);
      if (entry.queuedJob || entry.runningRevision !== entry.desiredRevision) {
        this.ensureScheduled(entry, PRIORITY.interactive, false);
      }
    } else {
      request = this.requestFresh(entry);
    }
    try {
      return await request;
    } finally {
      if (entry.subscribers.size === 0) this.scheduleCleanup(entry);
    }
  }

  invalidateWorkspace(
    workspaceCwd: string,
    options: { background?: boolean; interactive?: boolean } = {},
  ): void {
    const background = options.background === true;
    const hidden = this.isHidden();
    const liveStateEnabled = this.isWorkspaceLiveStateEnabled(workspaceCwd);
    if (liveStateEnabled) {
      this.requestLiveStateRefresh(
        workspaceCwd,
        options.interactive === true ? 'interactive' : 'invalidated',
        options.interactive === true,
      );
    }
    for (const entry of this.entries.values()) {
      if (entry.query.workspaceCwd !== workspaceCwd) continue;
      entry.desiredRevision += 1;
      entry.invalidated = true;
      entry.retryAt = undefined;
      this.setSnapshot(entry, { ...entry.snapshot, stale: true });
      if (background && hidden) entry.nextPollAt = Date.now();
      if (liveStateEnabled) {
        if (entry.queuedJob?.background) {
          this.removeQueuedJob(entry);
          this.setSnapshot(entry, {
            ...entry.snapshot,
            loading: entry.runningRevision !== undefined,
          });
        }
        // Non-coordinated waiters (e.g. a pre-live `loadOnce` still in
        // flight) can never be resolved by the live-state reconcile path,
        // and their presence blocks `stageWorkspaceRefresh` for the whole
        // workspace — schedule a real job so they settle.
        if (entry.waiters.some((waiter) => !waiter.liveStateCoordinated)) {
          this.ensureScheduled(entry, PRIORITY.interactive, false);
        }
        continue;
      }
      if (entry.waiters.length > 0) {
        this.ensureScheduled(entry, PRIORITY.interactive, false);
      } else if (entry.subscribers.size > 0 && (!background || !hidden)) {
        this.ensureScheduled(
          entry,
          background ? PRIORITY.initial : PRIORITY.interactive,
          background,
        );
      }
    }
  }

  patchSession(
    workspaceCwd: string,
    sessionId: string,
    patch: Partial<Omit<DaemonSessionSummary, 'sessionId' | 'workspaceCwd'>>,
  ): void {
    for (const entry of this.entries.values()) {
      if (entry.query.workspaceCwd !== workspaceCwd || !entry.snapshot.page) {
        continue;
      }
      let changed = false;
      const sessions = entry.snapshot.page.sessions.map((session) => {
        if (
          session.workspaceCwd !== workspaceCwd ||
          session.sessionId !== sessionId
        ) {
          return session;
        }
        changed = true;
        return { ...session, ...patch };
      });
      if (!changed) continue;
      this.setSnapshot(entry, {
        ...entry.snapshot,
        page: { ...entry.snapshot.page, sessions },
      });
    }
  }

  /**
   * Apply a pin toggle optimistically to every loaded page of the workspace,
   * so the store owns the optimistic state's lifetime (the R5-1 fix
   * direction). Pinned-view pages gain or lose the row; every other page
   * patches it in place. Because the toggle lands in the page data itself,
   * later local writes (`patchSession`, `applyLiveState`) churn around it
   * without dropping it, and only an authoritative refetch replaces it.
   * Rolling back is the same operation with the opposite target.
   */
  applySessionPinToggle(
    workspaceCwd: string,
    session: DaemonSessionSummary,
    toggle: { pinned: boolean; pinnedAt?: string },
  ): void {
    for (const entry of this.entries.values()) {
      if (entry.query.workspaceCwd !== workspaceCwd || !entry.snapshot.page) {
        continue;
      }
      const page = entry.snapshot.page;
      const carriesRow = (candidate: DaemonSessionSummary): boolean =>
        candidate.workspaceCwd === workspaceCwd &&
        candidate.sessionId === session.sessionId;
      if (entry.query.options.group === 'pinned') {
        if (toggle.pinned) {
          const pinnedSession: DaemonSessionSummary = {
            ...session,
            workspaceCwd,
            isPinned: true,
            ...(toggle.pinnedAt !== undefined
              ? { pinnedAt: toggle.pinnedAt }
              : {}),
          };
          const exists = page.sessions.some(carriesRow);
          this.setSnapshot(entry, {
            ...entry.snapshot,
            page: {
              ...page,
              sessions: exists
                ? page.sessions.map((candidate) =>
                    carriesRow(candidate) ? pinnedSession : candidate,
                  )
                : [...page.sessions, pinnedSession],
            },
          });
        } else if (page.sessions.some(carriesRow)) {
          this.setSnapshot(entry, {
            ...entry.snapshot,
            page: {
              ...page,
              sessions: page.sessions.filter(
                (candidate) => !carriesRow(candidate),
              ),
            },
          });
        }
        continue;
      }
      if (!page.sessions.some(carriesRow)) continue;
      this.setSnapshot(entry, {
        ...entry.snapshot,
        page: {
          ...page,
          sessions: page.sessions.map((candidate) => {
            if (!carriesRow(candidate)) return candidate;
            const next: DaemonSessionSummary = {
              ...candidate,
              isPinned: toggle.pinned,
            };
            if (toggle.pinned) {
              if (toggle.pinnedAt !== undefined) {
                next.pinnedAt = toggle.pinnedAt;
              }
            } else {
              delete next.pinnedAt;
            }
            return next;
          }),
        },
      });
    }
  }

  getLiveSession(
    workspaceCwd: string,
    sessionId: string,
  ): DaemonSessionLiveState | undefined {
    return this.liveSessionsByWorkspace.get(workspaceCwd)?.get(sessionId);
  }

  hasLiveSessions(workspaceCwd: string): boolean {
    return this.liveSessionsByWorkspace.has(workspaceCwd);
  }

  getLiveSessionRevision(workspaceCwd: string): number | undefined {
    return this.liveSessionRevisions.get(workspaceCwd);
  }

  /**
   * Drop the retained live-state snapshot after its channel has failed for
   * long enough that the snapshot can no longer be called current. Readers
   * then report the answer as unknown rather than serving a last-known value
   * indefinitely — a daemon that dies mid-turn must not leave a pane believing
   * the turn is still running for the life of the tab (#9487).
   */
  markWorkspaceLiveStateUnavailable(workspaceCwd: string): void {
    this.clearLiveSessions(workspaceCwd);
  }

  recordLiveStateFailure(workspaceCwd: string): number {
    const streak = (this.liveStateFailureStreaks.get(workspaceCwd) ?? 0) + 1;
    this.liveStateFailureStreaks.set(workspaceCwd, streak);
    return streak;
  }

  subscribeLiveSessions(
    workspaceCwd: string,
    listener: () => void,
  ): () => void {
    const existing = this.liveSessionListeners.get(workspaceCwd);
    const listeners = existing ?? new Set<() => void>();
    if (!existing) this.liveSessionListeners.set(workspaceCwd, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.liveSessionListeners.delete(workspaceCwd);
      }
    };
  }

  subscribeLiveSessionObservations(
    workspaceCwd: string,
    listener: () => void,
  ): () => void {
    const existing = this.liveSessionObservationListeners.get(workspaceCwd);
    const listeners = existing ?? new Set<() => void>();
    if (!existing) {
      this.liveSessionObservationListeners.set(workspaceCwd, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.liveSessionObservationListeners.delete(workspaceCwd);
      }
    };
  }

  applyLiveState(
    workspaceCwd: string,
    liveSessions: readonly DaemonSessionLiveState[],
  ): ReadonlySet<string> {
    this.recordLiveSessions(workspaceCwd, liveSessions);
    const liveById = new Map(
      liveSessions.map((session) => [session.sessionId, session]),
    );
    // Session ids whose live activity watermark was usable on a loaded,
    // reorder-owning page (stamped or already at least as fresh). The settle
    // loop consumes this instead of re-deriving the index and acceptance
    // rules, so the two sites cannot drift apart.
    const absorbed = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.query.workspaceCwd !== workspaceCwd || !entry.snapshot.page) {
        continue;
      }
      const acceptsActivity = ownsActivityReorder(entry);
      let changed = false;
      let activityAdvanced = false;
      const sessions = entry.snapshot.page.sessions.map((session) => {
        // A page can hold sessions from another workspace (the daemon merges
        // live runtime state); a workspace-scoped live-state response cannot
        // list them, so applying it would zero their volatile state.
        if (session.workspaceCwd && session.workspaceCwd !== workspaceCwd) {
          return session;
        }
        const live = liveById.get(session.sessionId);
        const clientCount = live?.clientCount ?? 0;
        const hasActivePrompt = live?.hasActivePrompt ?? false;
        const isWaitingForPermission = live?.isWaitingForPermission ?? false;
        const isWaitingForUserQuestion =
          live?.isWaitingForUserQuestion ?? false;
        // The daemon watermark only ever advances recency; an equal or older
        // stamp (e.g. a staged page committed fresher data mid-flight) must
        // not regress the row.
        const liveUpdatedAt =
          acceptsActivity && session.isArchived !== true
            ? live?.updatedAt
            : undefined;
        const liveActivityTime =
          liveUpdatedAt !== undefined ? Date.parse(liveUpdatedAt) : Number.NaN;
        if (Number.isFinite(liveActivityTime)) absorbed.add(session.sessionId);
        const updatedAt =
          liveUpdatedAt !== undefined &&
          Number.isFinite(liveActivityTime) &&
          liveActivityTime > getSessionActivityTime(session)
            ? liveUpdatedAt
            : session.updatedAt;
        if (
          session.clientCount === clientCount &&
          session.hasActivePrompt === hasActivePrompt &&
          session.isWaitingForPermission === isWaitingForPermission &&
          session.isWaitingForUserQuestion === isWaitingForUserQuestion &&
          session.updatedAt === updatedAt
        ) {
          return session;
        }
        changed = true;
        if (session.updatedAt !== updatedAt) activityAdvanced = true;
        return {
          ...session,
          clientCount,
          hasActivePrompt,
          isWaitingForPermission,
          isWaitingForUserQuestion,
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        };
      });
      if (!changed) continue;
      if (activityAdvanced) {
        sessions.sort((a, b) =>
          compareSessionsByActivity(
            entry.query.options.view === 'organized',
            a,
            b,
          ),
        );
      }
      this.setSnapshot(entry, {
        ...entry.snapshot,
        page: { ...entry.snapshot.page, sessions },
      });
    }
    return absorbed;
  }

  // The live-state response lists every live session regardless of catalog
  // paging; keep it so a per-session lookup never depends on the connected
  // session happening to sit inside a loaded page (#9487).
  private recordLiveSessions(
    workspaceCwd: string,
    liveSessions: readonly DaemonSessionLiveState[],
  ): void {
    this.liveStateFailureStreaks.delete(workspaceCwd);
    const next = new Map<string, DaemonSessionLiveState>();
    for (const session of liveSessions) {
      next.set(session.sessionId, session);
    }
    const previous = this.liveSessionsByWorkspace.get(workspaceCwd);
    const changed = !previous || !liveSessionSnapshotsEqual(previous, next);
    if (changed) this.liveSessionsByWorkspace.set(workspaceCwd, next);
    this.liveSessionRevisions.set(workspaceCwd, ++this.liveSessionRevision);
    const observationListeners =
      this.liveSessionObservationListeners.get(workspaceCwd);
    if (observationListeners) {
      for (const listener of [...observationListeners]) listener();
    }
    if (!changed) return;
    const listeners = this.liveSessionListeners.get(workspaceCwd);
    if (listeners) {
      for (const listener of [...listeners]) listener();
    }
  }

  private clearLiveSessions(workspaceCwd: string): void {
    if (!this.liveSessionsByWorkspace.delete(workspaceCwd)) return;
    this.liveSessionRevisions.delete(workspaceCwd);
    const observationListeners =
      this.liveSessionObservationListeners.get(workspaceCwd);
    if (observationListeners) {
      for (const listener of [...observationListeners]) listener();
    }
    const listeners = this.liveSessionListeners.get(workspaceCwd);
    if (listeners) {
      for (const listener of [...listeners]) listener();
    }
  }

  async stageWorkspaceRefresh(
    workspaceCwd: string,
  ): Promise<StagedWorkspaceSessionCatalog> {
    const workspaceEntries = [...this.entries.values()].filter(
      (entry) => entry.query.workspaceCwd === workspaceCwd,
    );
    if (
      workspaceEntries.some((entry) =>
        entry.waiters.some((waiter) => !waiter.liveStateCoordinated),
      )
    ) {
      return { workspaceCwd, pages: [], complete: false };
    }
    const targets: Array<{ entry: CatalogEntry; revision: number }> = [];
    for (const entry of workspaceEntries) {
      if (
        entry.subscribers.size > 0 ||
        entry.snapshot.loading ||
        entry.waiters.length > 0
      ) {
        this.clearPollTimer(entry);
        this.removeQueuedJob(entry);
        entry.trailingPriority = undefined;
        entry.trailingBackground = undefined;
        entry.desiredRevision += 1;
        entry.invalidated = true;
        entry.retryAt = undefined;
        this.setSnapshot(entry, {
          ...entry.snapshot,
          loading: true,
          stale: true,
        });
        targets.push({ entry, revision: entry.desiredRevision });
        continue;
      }
      entry.desiredRevision += 1;
      entry.invalidated = true;
      entry.retryAt = undefined;
      this.setSnapshot(entry, { ...entry.snapshot, stale: true });
    }
    const results = await Promise.all(
      targets.map(
        async ({
          entry,
          revision,
        }): Promise<
          | {
              entry: CatalogEntry;
              revision: number;
              page: DaemonSessionListPage;
            }
          | { entry: CatalogEntry; revision: number; superseded: true }
          | { entry: CatalogEntry; revision: number; error: Error }
        > => {
          if (entry.runningPromise) await entry.runningPromise;
          if (entry.desiredRevision !== revision) {
            return { entry, revision, superseded: true };
          }
          try {
            return {
              entry,
              revision,
              page: await this.fetchStagedPage(entry, revision),
            };
          } catch (error) {
            return { entry, revision, error: normalizeError(error) };
          }
        },
      ),
    );
    const pages: StagedCatalogPage[] = [];
    let complete = true;
    let firstFailure: Error | undefined;
    for (const result of results) {
      if ('page' in result) {
        pages.push({
          key: result.entry.key,
          revision: result.revision,
          page: result.page,
        });
        continue;
      }
      complete = false;
      if ('superseded' in result) continue;
      firstFailure ??= result.error;
      if (result.entry.desiredRevision !== result.revision) continue;
      // Scope the failure to the entry whose own fetch rejected; entries
      // that already staged successfully keep their old page and commit on
      // the next reconcile.
      this.setSnapshot(result.entry, {
        ...result.entry.snapshot,
        loading: false,
        stale: true,
        error: result.error,
      });
      this.rejectWaiters(result.entry, result.revision, result.error);
    }
    if (firstFailure) {
      for (const result of results) {
        if ('page' in result && result.entry.snapshot.loading) {
          this.setSnapshot(result.entry, {
            ...result.entry.snapshot,
            loading: false,
          });
        }
      }
      throw firstFailure;
    }
    return { workspaceCwd, pages, complete };
  }

  commitWorkspaceRefresh(staged: StagedWorkspaceSessionCatalog): boolean {
    if (!staged.complete) return false;
    const entries: Array<{
      entry: CatalogEntry;
      stagedPage: StagedCatalogPage;
    }> = [];
    for (const stagedPage of staged.pages) {
      const entry = this.entries.get(stagedPage.key);
      if (
        !entry ||
        entry.query.workspaceCwd !== staged.workspaceCwd ||
        entry.desiredRevision !== stagedPage.revision
      ) {
        return false;
      }
      entries.push({ entry, stagedPage });
    }
    for (const { entry, stagedPage } of entries) {
      entry.acceptedRevision = stagedPage.revision;
      entry.invalidated = false;
      entry.retryAt = undefined;
      entry.snapshot = {
        page: stagedPage.page,
        loading: false,
        stale: false,
        updatedAt: Date.now(),
      };
    }
    for (const { entry, stagedPage } of entries) {
      for (const subscriber of entry.subscribers) subscriber.listener();
      this.resolveWaiters(entry, stagedPage.page);
    }
    return true;
  }

  scheduleWorkspaceRefresh(
    workspaceCwd: string,
    delayMs = SESSION_CATALOG_TRAILING_REFRESH_MS,
  ): void {
    const current = this.trailingRefreshTimers.get(workspaceCwd);
    if (current !== undefined) clearTimeout(current);
    const timer = setTimeout(() => {
      this.trailingRefreshTimers.delete(workspaceCwd);
      this.invalidateWorkspace(workspaceCwd, { background: true });
    }, delayMs);
    this.trailingRefreshTimers.set(workspaceCwd, timer);
  }

  dispose(): void {
    const error = new Error('Session catalog store disposed');
    for (const entry of this.entries.values()) {
      this.clearPollTimer(entry);
      if (entry.cleanupTimer !== undefined) clearTimeout(entry.cleanupTimer);
      for (const waiter of entry.waiters) waiter.reject(error);
      entry.waiters = [];
    }
    for (const job of this.queue) job.staged?.reject(error);
    for (const timer of this.trailingRefreshTimers.values())
      clearTimeout(timer);
    this.trailingRefreshTimers.clear();
    this.liveStateWorkspaceUsers.clear();
    this.liveStateWorkspaceRefreshRequests.clear();
    this.liveStatePendingActivity.clear();
    this.liveStateFailureStreaks.clear();
    this.liveSessionRevisions.clear();
    this.liveSessionsByWorkspace.clear();
    this.liveSessionListeners.clear();
    this.liveSessionObservationListeners.clear();
    this.entries.clear();
    this.queue.length = 0;
    this.removeVisibilityListener();
  }

  private getOrCreateEntry(query: SessionCatalogQuery): CatalogEntry {
    const key = getSessionCatalogQueryKey(query);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: CatalogEntry = {
      key,
      query: {
        ...query,
        options: { ...query.options },
      },
      snapshot: EMPTY_SNAPSHOT,
      subscribers: new Set(),
      desiredRevision: 0,
      acceptedRevision: 0,
      invalidated: false,
      waiters: [],
    };
    this.entries.set(key, entry);
    this.scheduleCleanup(entry);
    return entry;
  }

  private requestFresh(
    entry: CatalogEntry,
    bypassRetry = false,
  ): Promise<DaemonSessionListPage> {
    entry.desiredRevision += 1;
    const revision = entry.desiredRevision;
    this.setSnapshot(entry, { ...entry.snapshot, stale: true });
    const liveStateCoordinated = this.isWorkspaceLiveStateEnabled(
      entry.query.workspaceCwd,
    );
    const promise = this.createWaiter(entry, revision, liveStateCoordinated);
    if (liveStateCoordinated) {
      this.requestLiveStateRefresh(
        entry.query.workspaceCwd,
        'interactive',
        bypassRetry,
      );
      if (entry.waiters.some((waiter) => !waiter.liveStateCoordinated)) {
        this.ensureScheduled(entry, PRIORITY.interactive, false);
      }
      return promise;
    }
    this.ensureScheduled(entry, PRIORITY.interactive, false);
    return promise;
  }

  private createWaiter(
    entry: CatalogEntry,
    revision: number,
    liveStateCoordinated: boolean,
  ): Promise<DaemonSessionListPage> {
    return new Promise<DaemonSessionListPage>((resolve, reject) => {
      entry.waiters.push({
        revision,
        liveStateCoordinated,
        resolve,
        reject,
      });
    });
  }

  private requestBackground(
    entry: CatalogEntry,
    priority: 'initial' | 'poll',
  ): void {
    if (this.isWorkspaceLiveStateEnabled(entry.query.workspaceCwd)) return;
    if (this.isHidden()) {
      entry.nextPollAt = Date.now();
      this.setSnapshot(entry, { ...entry.snapshot, stale: true });
      return;
    }
    const now = Date.now();
    if (entry.retryAt !== undefined && now < entry.retryAt) {
      this.scheduleEntryTimer(entry, entry.retryAt - now);
      return;
    }
    if (
      priority === 'poll' &&
      (entry.runningRevision !== undefined || entry.queuedJob)
    ) {
      this.schedulePollFromNow(entry);
      return;
    }
    if (entry.queuedJob) {
      this.ensureScheduled(entry, PRIORITY[priority], true);
      return;
    }
    if (entry.runningRevision !== undefined) {
      if (entry.runningRevision < entry.desiredRevision) {
        this.ensureScheduled(entry, PRIORITY[priority], true);
      }
      return;
    }
    entry.desiredRevision += 1;
    this.setSnapshot(entry, { ...entry.snapshot, stale: true });
    this.ensureScheduled(entry, PRIORITY[priority], true);
  }

  private ensureScheduled(
    entry: CatalogEntry,
    priority: number,
    background: boolean,
  ): void {
    if (entry.runningRevision !== undefined) {
      entry.trailingPriority = Math.min(
        entry.trailingPriority ?? priority,
        priority,
      );
      entry.trailingBackground =
        (entry.trailingBackground ?? true) && background;
      return;
    }
    if (entry.queuedJob) {
      if (
        entry.queuedJob.staged &&
        entry.desiredRevision > entry.queuedJob.staged.revision
      ) {
        entry.trailingPriority = Math.min(
          entry.trailingPriority ?? priority,
          priority,
        );
        entry.trailingBackground =
          (entry.trailingBackground ?? true) && background;
        return;
      }
      entry.queuedJob.priority = Math.min(entry.queuedJob.priority, priority);
      entry.queuedJob.background = entry.queuedJob.background && background;
      this.sortQueue();
      this.drainQueue();
      return;
    }
    const job: QueueJob = {
      entry,
      priority,
      background,
      sequence: this.queueSequence++,
    };
    entry.queuedJob = job;
    this.queue.push(job);
    this.setSnapshot(entry, { ...entry.snapshot, loading: true });
    this.sortQueue();
    this.drainQueue();
  }

  private sortQueue(): void {
    this.queue.sort(
      (left, right) =>
        left.priority - right.priority || left.sequence - right.sequence,
    );
  }

  private drainQueue(): void {
    while (this.activeRequests < 2) {
      const index = this.queue.findIndex(
        (job) => !job.background || this.activeBackgroundRequests < 1,
      );
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (!job) return;
      job.entry.queuedJob = undefined;
      this.startJob(job);
    }
  }

  private startJob(job: QueueJob): void {
    const entry = job.entry;
    const revision = job.staged?.revision ?? entry.desiredRevision;
    entry.runningRevision = revision;
    entry.runningStaged = job.staged !== undefined;
    this.activeRequests += 1;
    if (job.background) this.activeBackgroundRequests += 1;

    const request = this.fetchPage(entry.query);
    let completion: Promise<void>;
    if (job.staged) {
      const staged = job.staged;
      let result: DaemonSessionListPage | undefined;
      let failure: Error | undefined;
      completion = request
        .then(
          (page) => {
            result = page;
          },
          (error: unknown) => {
            failure = normalizeError(error);
          },
        )
        .finally(() => this.finishJob(entry, job, revision))
        .then(() => {
          if (failure) staged.reject(failure);
          else staged.resolve(result!);
        });
    } else {
      // A staged job at the same revision owns it: a trailing non-staged
      // job materialized by finishJob for a staged-owned revision must not
      // publish a page or settle waiters ahead of (or against) the staged
      // commit.
      const stagedOwnsRevision = (): boolean =>
        entry.queuedJob?.staged?.revision === revision ||
        (entry.runningStaged === true && entry.runningRevision === revision);
      completion = request
        .then(
          (page) => {
            if (entry.desiredRevision === revision) {
              if (stagedOwnsRevision()) return;
              entry.acceptedRevision = revision;
              entry.invalidated = false;
              entry.retryAt = undefined;
              this.setSnapshot(entry, {
                page,
                loading: false,
                stale: false,
                updatedAt: Date.now(),
              });
              this.resolveWaiters(entry, page);
            }
          },
          (error: unknown) => {
            if (entry.desiredRevision !== revision) return;
            if (stagedOwnsRevision()) return;
            const normalized = normalizeError(error);
            entry.retryAt = Date.now() + SESSION_CATALOG_ERROR_RETRY_MS;
            this.setSnapshot(entry, {
              ...entry.snapshot,
              loading: false,
              stale: true,
              error: normalized,
            });
            this.rejectWaiters(entry, revision, normalized);
          },
        )
        .finally(() => this.finishJob(entry, job, revision));
    }
    entry.runningPromise = completion;
    void completion;
  }

  private finishJob(
    entry: CatalogEntry,
    job: QueueJob,
    revision: number,
  ): void {
    entry.runningRevision = undefined;
    entry.runningPromise = undefined;
    entry.runningStaged = undefined;
    this.activeRequests -= 1;
    if (job.background) this.activeBackgroundRequests -= 1;
    if (
      entry.desiredRevision > revision &&
      entry.trailingPriority !== undefined
    ) {
      const priority = entry.trailingPriority;
      const background = entry.trailingBackground ?? true;
      entry.trailingPriority = undefined;
      entry.trailingBackground = undefined;
      if (!background || (!this.isHidden() && entry.subscribers.size > 0)) {
        this.ensureScheduled(entry, priority, background);
      } else {
        if (entry.snapshot.loading) {
          this.setSnapshot(entry, { ...entry.snapshot, loading: false });
        }
        this.schedulePollFromNow(entry);
        if (entry.subscribers.size === 0) this.scheduleCleanup(entry);
      }
    } else {
      entry.trailingPriority = undefined;
      entry.trailingBackground = undefined;
      if (entry.snapshot.loading) {
        this.setSnapshot(entry, { ...entry.snapshot, loading: false });
      }
      this.schedulePollFromNow(entry);
      if (entry.subscribers.size === 0) this.scheduleCleanup(entry);
    }
    this.drainQueue();
  }

  private fetchStagedPage(
    entry: CatalogEntry,
    revision: number,
  ): Promise<DaemonSessionListPage> {
    return new Promise((resolve, reject) => {
      // A staged fetch supersedes a pending non-staged job for the same
      // entry — its waiters settle via the fenced commit instead.
      if (entry.queuedJob && !entry.queuedJob.staged) {
        this.removeQueuedJob(entry);
      }
      const job: QueueJob = {
        entry,
        priority: PRIORITY.interactive,
        background: false,
        sequence: this.queueSequence++,
        staged: { revision, resolve, reject },
      };
      entry.queuedJob = job;
      this.queue.push(job);
      this.setSnapshot(entry, { ...entry.snapshot, loading: true });
      this.sortQueue();
      this.drainQueue();
    });
  }

  private async fetchPage(
    query: SessionCatalogQuery,
  ): Promise<DaemonSessionListPage> {
    const page = await (query.routeKind === 'qualified'
      ? this.client
          .workspaceByCwd(query.workspaceCwd)
          .listWorkspaceSessionsPage(query.options)
      : this.client.listWorkspaceSessionsPage(
          query.workspaceCwd,
          query.options,
        ));
    return {
      ...page,
      sessions: page.sessions.map((session) =>
        session.workspaceCwd
          ? session
          : { ...session, workspaceCwd: query.workspaceCwd },
      ),
    };
  }

  private resolveWaiters(
    entry: CatalogEntry,
    page: DaemonSessionListPage,
  ): void {
    const pending: Waiter[] = [];
    for (const waiter of entry.waiters) {
      if (waiter.revision <= entry.acceptedRevision) waiter.resolve(page);
      else pending.push(waiter);
    }
    entry.waiters = pending;
  }

  private rejectWaiters(
    entry: CatalogEntry,
    revision: number,
    error: Error,
  ): void {
    const pending: Waiter[] = [];
    for (const waiter of entry.waiters) {
      if (waiter.revision <= revision) waiter.reject(error);
      else pending.push(waiter);
    }
    entry.waiters = pending;
  }

  private setSnapshot(
    entry: CatalogEntry,
    snapshot: SessionCatalogSnapshot,
  ): void {
    if (entry.snapshot === snapshot) return;
    entry.snapshot = snapshot;
    for (const subscriber of entry.subscribers) subscriber.listener();
  }

  private resetPollSchedule(entry: CatalogEntry): void {
    this.schedulePollFromNow(entry);
  }

  private schedulePollFromNow(entry: CatalogEntry): void {
    this.clearPollTimer(entry);
    const now = Date.now();
    if (this.isHidden() && entry.invalidated) {
      entry.nextPollAt = Math.min(entry.nextPollAt ?? now, now);
      return;
    }
    const interval = getPollInterval(entry);
    if (
      interval === undefined &&
      (entry.retryAt === undefined || !hasAutoLoadSubscriber(entry))
    ) {
      entry.nextPollAt = undefined;
      return;
    }
    const delay = Math.max(
      0,
      entry.retryAt !== undefined && entry.retryAt > now
        ? entry.retryAt - now
        : (interval ?? SESSION_CATALOG_ERROR_RETRY_MS),
    );
    entry.nextPollAt = now + delay;
    if (!this.isHidden()) this.scheduleEntryTimer(entry, delay);
  }

  private scheduleEntryTimer(entry: CatalogEntry, delay: number): void {
    this.clearPollTimer(entry);
    entry.pollTimer = setTimeout(
      () => {
        entry.pollTimer = undefined;
        const interval = getPollInterval(entry);
        if (entry.retryAt !== undefined && Date.now() >= entry.retryAt) {
          this.requestBackground(entry, 'initial');
        } else if (interval !== undefined) {
          this.requestBackground(entry, 'poll');
        } else if (
          hasAutoLoadSubscriber(entry) &&
          (entry.snapshot.page === undefined || entry.snapshot.stale)
        ) {
          this.requestBackground(entry, 'initial');
        }
      },
      Math.max(0, delay),
    );
  }

  private clearPollTimer(entry: CatalogEntry): void {
    if (entry.pollTimer !== undefined) clearTimeout(entry.pollTimer);
    entry.pollTimer = undefined;
  }

  private removeQueuedJob(entry: CatalogEntry): void {
    const job = entry.queuedJob;
    if (!job) return;
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    entry.queuedJob = undefined;
    job.staged?.reject(new Error('Staged session catalog request superseded'));
  }

  private scheduleCleanup(entry: CatalogEntry): void {
    if (entry.cleanupTimer !== undefined) clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = setTimeout(() => {
      entry.cleanupTimer = undefined;
      if (
        entry.subscribers.size > 0 ||
        entry.runningRevision !== undefined ||
        entry.queuedJob ||
        entry.waiters.length > 0
      ) {
        this.scheduleCleanup(entry);
        return;
      }
      this.entries.delete(entry.key);
    }, SESSION_CATALOG_RETENTION_MS);
  }

  private isHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden;
  }

  private updateVisibilityListener(): void {
    const needsListener = Array.from(this.entries.values()).some(
      (entry) => entry.subscribers.size > 0,
    );
    if (
      needsListener &&
      !this.visibilityListening &&
      typeof document !== 'undefined'
    ) {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      this.visibilityListening = true;
    } else if (!needsListener) {
      this.removeVisibilityListener();
    }
  }

  private removeVisibilityListener(): void {
    if (!this.visibilityListening || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.visibilityListening = false;
  }

  private readonly onVisibilityChange = (): void => {
    if (this.isHidden()) {
      for (const entry of this.entries.values()) {
        this.clearPollTimer(entry);
        if (entry.queuedJob?.background && entry.waiters.length === 0) {
          entry.nextPollAt = Date.now();
          this.removeQueuedJob(entry);
          this.setSnapshot(entry, {
            ...entry.snapshot,
            loading: entry.runningRevision !== undefined,
          });
        }
      }
      return;
    }
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.subscribers.size === 0) continue;
      if (
        entry.snapshot.stale &&
        entry.nextPollAt !== undefined &&
        entry.nextPollAt <= now
      ) {
        entry.nextPollAt = undefined;
        this.requestBackground(entry, 'initial');
        continue;
      }
      if (
        hasAutoLoadSubscriber(entry) &&
        (entry.snapshot.page === undefined || entry.snapshot.stale)
      ) {
        this.requestBackground(entry, 'initial');
        continue;
      }
      const interval = getPollInterval(entry);
      if (interval === undefined) continue;
      if (entry.nextPollAt !== undefined && entry.nextPollAt <= now) {
        this.requestBackground(entry, 'poll');
      } else {
        this.scheduleEntryTimer(
          entry,
          Math.max(0, (entry.nextPollAt ?? now + interval) - now),
        );
      }
    }
  };
}

const stores = new WeakMap<DaemonClient, SessionCatalogStore>();

export function getSessionCatalogStore(
  client: DaemonClient,
): SessionCatalogStore {
  let store = stores.get(client);
  if (!store) {
    store = new SessionCatalogStore(client);
    stores.set(client, store);
  }
  return store;
}

export function loadSessionCatalogOnce(
  client: DaemonClient,
  query: SessionCatalogQuery,
  options?: { fresh?: boolean },
): Promise<DaemonSessionListPage> {
  return getSessionCatalogStore(client).loadOnce(query, options);
}
