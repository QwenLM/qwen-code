import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { managedRequestId } from './managed-session-storage';
import {
  isManagedSideQueryActive,
  type ManagedSideQuery,
  type ManagedSideQueryContext,
  type ManagedSideQueryCreate,
  type ManagedSideQueryKind,
} from './managed-side-query-types';

const AWAY_MILLIS = 5 * 60_000;
type Intent =
  | { request: ManagedSideQueryCreate; idempotencyKey: string }
  | { queryId: string };

interface State {
  identity: object;
  context?: ManagedSideQueryContext;
  queries: ManagedSideQuery[];
  pending: ManagedSideQueryKind[];
  automatic: boolean;
  open?: ManagedSideQueryKind;
  error?: string;
  nextCursor?: string | null;
}

function readIntent(key: string): Intent | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null',
    ) as Intent | null;
    if (!value) return undefined;
    if ('queryId' in value && typeof value.queryId === 'string') return value;
    if (
      'request' in value &&
      typeof value.idempotencyKey === 'string' &&
      ['btw', 'recap'].includes(value.request?.kind)
    )
      return value;
  } catch {
    // A malformed browser record is never sent to the server.
  }
  return undefined;
}

function saveIntent(key: string, intent?: Intent): boolean {
  try {
    if (intent) sessionStorage.setItem(key, JSON.stringify(intent));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 1_000);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export function useManagedSideQueries(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  options: {
    idle: boolean;
    interactive: boolean;
    btw: boolean;
    recap: boolean;
  },
) {
  const [epoch, setEpoch] = useState(0);
  const identity = useMemo(
    () => ({ provider, clientId, sessionId, epoch }),
    [provider, clientId, sessionId, epoch],
  );
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<State>({
    identity,
    queries: [],
    pending: [],
    automatic: false,
  });
  const controller = useRef<
    | {
        identity: object;
        create: (request: ManagedSideQueryCreate) => Promise<boolean>;
        confirm: (kind: ManagedSideQueryKind) => Promise<void>;
        cancel: (query: ManagedSideQuery) => Promise<void>;
        setAutomatic: (enabled: boolean) => void;
        tick: () => void;
        mainInputAccepted: () => void;
        refresh: () => Promise<void>;
        show: (kind: ManagedSideQueryKind) => void;
        close: () => void;
        loadMore: () => Promise<void>;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    const api = provider.sideQueries;
    if (!api || !sessionId || !(options.btw || options.recap)) {
      controller.current = undefined;
      return;
    }
    const abort = new AbortController();
    const requestOptions = { clientId, signal: abort.signal };
    let actor: string | undefined;
    let context: ManagedSideQueryContext | undefined;
    let automatic = false;
    let restored = false;
    let settingEpoch = 0;
    let awayAt: number | undefined;
    let candidate: { epoch: number; boundary: number } | undefined;
    let autoBusy = false;
    let refreshBusy = false;
    let nextCursor: string | null | undefined;
    let manualKind: ManagedSideQueryKind | undefined;
    const queries = new Map<string, ManagedSideQuery>();
    const intents = new Map<ManagedSideQueryKind, Intent>();
    const submitting = new Set<ManagedSideQueryKind>();
    const following = new Set<string>();
    const explicit = new Set<string>();
    const automaticDisplay = new Set<string>();
    const autoTokens = new Map<
      string,
      { epoch: number; version: string; boundary: number }
    >();
    const alive = () => !abort.signal.aborted;
    const key = (kind: ManagedSideQueryKind) =>
      `managed-side-query:${JSON.stringify([provider.storageKey, actor, sessionId, kind])}`;
    const preferenceKey = () =>
      `managed-auto-recap:${JSON.stringify([provider.storageKey, actor])}`;
    const update = (patch: Partial<State> = {}) => {
      if (!alive()) return;
      setState((old) => ({
        ...old,
        identity,
        context,
        automatic,
        queries: [...queries.values()]
          .filter(
            (query) =>
              query.trigger !== 'automatic' ||
              explicit.has(query.queryId) ||
              automaticDisplay.has(query.queryId),
          )
          .sort((a, b) => a.createdAt - b.createdAt),
        pending: [...intents.keys()],
        nextCursor,
        ...patch,
      }));
    };
    const clearIntent = (kind: ManagedSideQueryKind) => {
      intents.delete(kind);
      saveIntent(key(kind));
    };
    const revoke = (error: unknown): boolean => {
      if (!alive()) return true;
      if (
        !(error instanceof JavaManagedAgentHttpError) ||
        ![401, 403, 404].includes(error.status)
      )
        return false;
      abort.abort();
      setState({ identity, queries: [], pending: [], automatic: false });
      return true;
    };
    const apply = (query: ManagedSideQuery) => {
      if (!alive() || query.sessionId !== sessionId) return;
      const previous = queries.get(query.queryId);
      const retained =
        previous && previous.resultRevision >= query.resultRevision
          ? previous
          : query;
      if (manualKind === query.kind) explicit.add(query.queryId);
      queries.set(query.queryId, retained);
      if (!isManagedSideQueryActive(retained)) {
        const intent = intents.get(query.kind);
        if (intent && 'queryId' in intent && intent.queryId === query.queryId)
          clearIntent(query.kind);
      }
      update();
    };
    const readContext = async () => {
      const value = await api.context(sessionId, requestOptions);
      if (!alive()) return undefined;
      if (actor && value.actorScopeKey !== actor) {
        abort.abort();
        setState({ identity, queries: [], pending: [], automatic: false });
        setEpoch((value) => value + 1);
        return undefined;
      }
      actor = value.actorScopeKey;
      context = value;
      if (candidate && candidate.boundary !== value.mainInputBoundary)
        candidate = undefined;
      for (const [id, token] of autoTokens) {
        if (
          token.boundary !== value.mainInputBoundary ||
          token.version !== value.contentVersion
        ) {
          autoTokens.delete(id);
          automaticDisplay.delete(id);
        }
      }
      update();
      return value;
    };
    const displayAutomatic = async (query: ManagedSideQuery) => {
      const token = autoTokens.get(query.queryId);
      if (
        !token ||
        query.status !== 'completed' ||
        query.outcome !== 'success' ||
        !query.text?.trim()
      )
        return;
      let fresh: ManagedSideQueryContext | undefined;
      try {
        fresh = await readContext();
      } catch (error) {
        revoke(error);
        return;
      }
      if (
        alive() &&
        fresh &&
        automatic &&
        settingEpoch === token.epoch &&
        latest.current.idle &&
        latest.current.interactive &&
        !document.hidden &&
        query.source.contentVersion === token.version &&
        query.source.mainInputBoundary === token.boundary &&
        fresh.contentVersion === token.version &&
        fresh.mainInputBoundary === token.boundary
      ) {
        automaticDisplay.add(query.queryId);
        update({ open: 'recap' });
      }
    };
    const follow = async (query: ManagedSideQuery) => {
      if (following.has(query.queryId) || !isManagedSideQueryActive(query))
        return;
      following.add(query.queryId);
      try {
        while (
          alive() &&
          isManagedSideQueryActive(queries.get(query.queryId) ?? query)
        ) {
          try {
            for await (const snapshot of api.stream(sessionId, query.queryId, {
              ...requestOptions,
              afterRevision: queries.get(query.queryId)?.resultRevision,
            })) {
              apply(snapshot);
              if (!isManagedSideQueryActive(snapshot)) break;
            }
            if (alive())
              apply(await api.get(sessionId, query.queryId, requestOptions));
          } catch (error) {
            if (revoke(error)) return;
          }
          if (
            alive() &&
            isManagedSideQueryActive(queries.get(query.queryId) ?? query)
          )
            await pause(abort.signal);
        }
        const settled = queries.get(query.queryId);
        if (alive() && settled) await displayAutomatic(settled);
      } finally {
        following.delete(query.queryId);
      }
    };
    const run = async (
      kind: ManagedSideQueryKind,
      manual: boolean,
    ): Promise<ManagedSideQuery | undefined> => {
      const intent = intents.get(kind);
      if (!intent || submitting.has(kind)) return undefined;
      submitting.add(kind);
      try {
        const query =
          'queryId' in intent
            ? await api.get(sessionId, intent.queryId, requestOptions)
            : await api.create(sessionId, intent.request, {
                ...requestOptions,
                idempotencyKey: intent.idempotencyKey,
              });
        if (!alive()) return undefined;
        if (manual) explicit.add(query.queryId);
        const admitted = { queryId: query.queryId };
        intents.set(kind, admitted);
        saveIntent(key(kind), admitted);
        apply(query);
        update({ error: undefined });
        void follow(query);
        return query;
      } catch (error) {
        if (!alive()) return undefined;
        if (revoke(error)) return undefined;
        if (
          error instanceof JavaManagedAgentHttpError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![401, 408, 429].includes(error.status)
        )
          clearIntent(kind);
        if (manual)
          update({
            error: error instanceof Error ? error.message : String(error),
          });
        return undefined;
      } finally {
        submitting.delete(kind);
        update();
      }
    };
    const create = async (
      request: ManagedSideQueryCreate,
    ): Promise<ManagedSideQuery | undefined> => {
      const manual = request.trigger !== 'automatic';
      if (
        !alive() ||
        !actor ||
        !context?.generationAvailable ||
        !latest.current.interactive
      )
        return undefined;
      if (manual) {
        manualKind = request.kind;
        update({ open: request.kind, error: undefined });
      }
      if (intents.has(request.kind)) return undefined;
      const intent = { request, idempotencyKey: managedRequestId() };
      if (!saveIntent(key(request.kind), intent)) {
        if (manual) update({ error: 'storage_unavailable' });
        return undefined;
      }
      intents.set(request.kind, intent);
      update();
      const admitted = await run(request.kind, manual);
      return admitted;
    };
    const attemptAutomatic = async () => {
      if (
        !candidate ||
        autoBusy ||
        !automatic ||
        !latest.current.idle ||
        !latest.current.interactive ||
        document.hidden ||
        !latest.current.recap
      )
        return;
      autoBusy = true;
      const captured = candidate;
      candidate = undefined;
      try {
        const fresh = await readContext();
        if (
          !alive() ||
          !fresh?.contentVersion ||
          !automatic ||
          captured.epoch !== settingEpoch ||
          captured.boundary !== fresh.mainInputBoundary ||
          !latest.current.idle ||
          document.hidden ||
          !fresh.automaticEligible ||
          !fresh.generationAvailable
        )
          return;
        const query = await create({
          kind: 'recap',
          trigger: 'automatic',
          expectedContentVersion: fresh.contentVersion,
          expectedMainInputBoundary: fresh.mainInputBoundary,
        });
        if (!query || !alive()) return;
        autoTokens.set(query.queryId, {
          epoch: captured.epoch,
          version: fresh.contentVersion,
          boundary: fresh.mainInputBoundary,
        });
        const settled = queries.get(query.queryId) ?? query;
        if (!isManagedSideQueryActive(settled)) await displayAutomatic(settled);
      } catch (error) {
        revoke(error);
      } finally {
        autoBusy = false;
      }
    };
    // One-shot restore of the automatic preference and persisted intents. It
    // must run as soon as the actor is first known, not only after the first
    // refresh: a failed initial refresh leaves actor undefined, and the effect
    // never re-runs, so a later successful refresh has to pick it up.
    const restore = () => {
      if (restored || !alive() || !actor) return;
      restored = true;
      try {
        automatic = localStorage.getItem(preferenceKey()) === 'true';
      } catch {
        automatic = false;
      }
      for (const kind of ['btw', 'recap'] as const) {
        const intent = readIntent(key(kind));
        if (intent) {
          intents.set(kind, intent);
          void run(
            kind,
            'request' in intent ? intent.request.trigger !== 'automatic' : true,
          );
        }
      }
      update();
    };
    const refresh = async () => {
      if (refreshBusy || !alive()) return;
      refreshBusy = true;
      try {
        if (!(await readContext())) return;
        restore();
        const page = await api.list(sessionId, {
          ...requestOptions,
          limit: 50,
        });
        if (!alive()) return;
        if (nextCursor === undefined) nextCursor = page.nextCursor;
        for (const query of page.items) {
          apply(query);
          void follow(query);
        }
      } catch (error) {
        revoke(error);
        // A reconnect reads persisted state again without creating another query.
      } finally {
        refreshBusy = false;
      }
    };
    const setAutomatic = (enabled: boolean) => {
      if (!actor) return;
      try {
        localStorage.setItem(preferenceKey(), enabled ? 'true' : 'false');
      } catch {
        update({ error: 'storage_unavailable' });
        return;
      }
      automatic = enabled;
      settingEpoch++;
      awayAt = undefined;
      candidate = undefined;
      autoTokens.clear();
      automaticDisplay.clear();
      update();
    };
    const returned = async () => {
      if (document.hidden) return;
      const began = awayAt;
      const returnEpoch = settingEpoch;
      awayAt = undefined;
      await refresh();
      if (
        alive() &&
        automatic &&
        returnEpoch === settingEpoch &&
        began !== undefined &&
        Date.now() - began >= AWAY_MILLIS &&
        context
      ) {
        candidate = {
          epoch: settingEpoch,
          boundary: context.mainInputBoundary,
        };
        void attemptAutomatic();
      }
    };
    const visibility = () => {
      if (document.hidden) {
        if (automatic && awayAt === undefined) awayAt = Date.now();
      } else void returned();
    };
    const blur = () => {
      if (automatic && awayAt === undefined) awayAt = Date.now();
    };
    const storage = (event: StorageEvent) => {
      if (actor && event.key === preferenceKey())
        setAutomatic(event.newValue === 'true');
    };
    controller.current = {
      identity,
      create: async (request) => Boolean(await create(request)),
      refresh,
      setAutomatic,
      show: (kind) => {
        manualKind = kind;
        for (const query of queries.values())
          if (query.kind === kind) explicit.add(query.queryId);
        update({ open: kind, error: undefined });
        void refresh();
      },
      close: () => {
        manualKind = undefined;
        update({ open: undefined });
      },
      loadMore: async () => {
        if (!alive() || !nextCursor) return;
        try {
          const page = await api.list(sessionId, {
            ...requestOptions,
            cursor: nextCursor,
            limit: 50,
          });
          if (!alive()) return;
          nextCursor = page.nextCursor;
          for (const query of page.items) apply(query);
          update();
        } catch (error) {
          if (revoke(error)) return;
          if (alive())
            update({
              error: error instanceof Error ? error.message : String(error),
            });
        }
      },
      confirm: async (kind) => {
        await run(kind, true);
      },
      cancel: async (query) => {
        try {
          apply(await api.cancel(sessionId, query.queryId, requestOptions));
        } catch (error) {
          if (revoke(error)) return;
          if (alive())
            update({
              error: error instanceof Error ? error.message : String(error),
            });
        }
      },
      tick: () => {
        void attemptAutomatic();
      },
      mainInputAccepted: () => {
        candidate = undefined;
        autoTokens.clear();
        automaticDisplay.clear();
        update();
      },
    };
    setState({ identity, queries: [], pending: [], automatic: false });
    void (async () => {
      await refresh();
      restore();
    })();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', returned);
    window.addEventListener('storage', storage);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', returned);
      window.removeEventListener('storage', storage);
    };
  }, [
    provider,
    clientId,
    sessionId,
    identity,
    epoch,
    options.btw,
    options.recap,
  ]);

  useEffect(
    () => controller.current?.tick(),
    [options.idle, options.interactive],
  );
  const visible: State =
    state.identity === identity
      ? state
      : {
          identity,
          queries: [],
          pending: [],
          automatic: false,
        };
  const available = (kind: ManagedSideQueryKind) =>
    Boolean(
      provider.sideQueries &&
        sessionId &&
        options[kind] &&
        visible.context?.generationAvailable,
    );
  const ownedController = () =>
    controller.current?.identity === identity ? controller.current : undefined;
  return {
    ...visible,
    available,
    show: (kind: ManagedSideQueryKind) => ownedController()?.show(kind),
    close: () => ownedController()?.close(),
    loadMore: () => ownedController()?.loadMore(),
    create: (request: ManagedSideQueryCreate) => {
      const owner = ownedController();
      return available(request.kind) && owner
        ? owner.create(request)
        : Promise.resolve(false);
    },
    confirm: (kind: ManagedSideQueryKind) => ownedController()?.confirm(kind),
    cancel: (query: ManagedSideQuery) => ownedController()?.cancel(query),
    setAutomatic: (enabled: boolean) =>
      ownedController()?.setAutomatic(enabled),
    mainInputAccepted: () => ownedController()?.mainInputAccepted(),
  };
}
