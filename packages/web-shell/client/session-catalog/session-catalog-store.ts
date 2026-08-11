import type {
  DaemonClient,
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
  resolve: (page: DaemonSessionListPage) => void;
  reject: (error: Error) => void;
}

interface QueueJob {
  entry: CatalogEntry;
  priority: number;
  background: boolean;
  sequence: number;
}

interface CatalogEntry {
  key: string;
  query: SessionCatalogQuery;
  snapshot: SessionCatalogSnapshot;
  subscribers: Set<Subscriber>;
  desiredRevision: number;
  acceptedRevision: number;
  runningRevision?: number;
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
    this.updateVisibilityListener();
    this.resetPollSchedule(entry);

    const retainedPageExpired =
      subscriber.autoLoad &&
      options.maxAgeMs !== undefined &&
      entry.snapshot.page !== undefined &&
      (entry.snapshot.updatedAt === undefined ||
        Date.now() - entry.snapshot.updatedAt >= options.maxAgeMs);

    if (
      entry.invalidated ||
      (subscriber.autoLoad &&
        (entry.snapshot.page === undefined || entry.snapshot.stale)) ||
      retainedPageExpired
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

  async refresh(query: SessionCatalogQuery): Promise<DaemonSessionListPage> {
    return this.requestFresh(this.getOrCreateEntry(query));
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
      entry.runningRevision !== undefined && entry.snapshot.loading;
    if (options.fresh !== true && (reusableRunningRequest || entry.queuedJob)) {
      request = this.createWaiter(entry, entry.desiredRevision);
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
    options: { background?: boolean } = {},
  ): void {
    const background = options.background === true;
    const hidden = this.isHidden();
    for (const entry of this.entries.values()) {
      if (entry.query.workspaceCwd !== workspaceCwd) continue;
      entry.desiredRevision += 1;
      entry.invalidated = true;
      entry.retryAt = undefined;
      this.setSnapshot(entry, { ...entry.snapshot, stale: true });
      if (background && hidden) entry.nextPollAt = Date.now();
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
    for (const entry of this.entries.values()) {
      this.clearPollTimer(entry);
      if (entry.cleanupTimer !== undefined) clearTimeout(entry.cleanupTimer);
      const error = new Error('Session catalog store disposed');
      for (const waiter of entry.waiters) waiter.reject(error);
      entry.waiters = [];
    }
    for (const timer of this.trailingRefreshTimers.values())
      clearTimeout(timer);
    this.trailingRefreshTimers.clear();
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

  private requestFresh(entry: CatalogEntry): Promise<DaemonSessionListPage> {
    entry.desiredRevision += 1;
    const revision = entry.desiredRevision;
    this.setSnapshot(entry, { ...entry.snapshot, stale: true });
    const promise = this.createWaiter(entry, revision);
    this.ensureScheduled(entry, PRIORITY.interactive, false);
    return promise;
  }

  private createWaiter(
    entry: CatalogEntry,
    revision: number,
  ): Promise<DaemonSessionListPage> {
    return new Promise<DaemonSessionListPage>((resolve, reject) => {
      entry.waiters.push({ revision, resolve, reject });
    });
  }

  private requestBackground(
    entry: CatalogEntry,
    priority: 'initial' | 'poll',
  ): void {
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
    const revision = entry.desiredRevision;
    entry.runningRevision = revision;
    this.activeRequests += 1;
    if (job.background) this.activeBackgroundRequests += 1;

    void this.fetchPage(entry.query)
      .then((page) => {
        if (entry.desiredRevision === revision) {
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
      })
      .catch((error: unknown) => {
        if (entry.desiredRevision !== revision) return;
        const normalized = normalizeError(error);
        entry.retryAt = Date.now() + SESSION_CATALOG_ERROR_RETRY_MS;
        this.setSnapshot(entry, {
          ...entry.snapshot,
          loading: false,
          stale: true,
          error: normalized,
        });
        this.rejectWaiters(entry, revision, normalized);
      })
      .finally(() => {
        entry.runningRevision = undefined;
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
