import { useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedLifecycleAction,
  ManagedLifecycleKind,
} from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { managedRequestId } from './managed-session-storage';

interface LifecycleIntent {
  sessionId: string;
  workspaceId?: string;
  action: ManagedLifecycleAction;
  kind: ManagedLifecycleKind | 'unarchive';
  idempotencyKey?: string;
  archiveKey?: string;
  operationId?: string;
  failed?: boolean;
}
export interface ManagedLifecycleState {
  action: ManagedLifecycleAction;
  status: string;
  busy: boolean;
  canConfirm?: boolean;
  kind?: LifecycleIntent['kind'];
  code?: string;
}

const actions = ['close', 'archive', 'delete', 'unarchive', 'close_archive'];
function read(key: string): Record<string, LifecycleIntent> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([id, raw]) => {
        if (!raw || typeof raw !== 'object') return false;
        const item = raw as Record<string, unknown>;
        return (
          item['sessionId'] === id &&
          actions.includes(String(item['action'])) &&
          ['close', 'archive', 'delete', 'unarchive'].includes(
            String(item['kind']),
          ) &&
          (item['action'] === item['kind'] ||
            (item['action'] === 'close_archive' &&
              ['close', 'archive'].includes(String(item['kind'])) &&
              typeof item['archiveKey'] === 'string')) &&
          ((typeof item['idempotencyKey'] === 'string' &&
            !!item['idempotencyKey']) ||
            (typeof item['operationId'] === 'string' &&
              !!item['operationId'])) &&
          (item['operationId'] === undefined ||
            typeof item['operationId'] === 'string') &&
          (item['failed'] === undefined ||
            typeof item['failed'] === 'boolean') &&
          (item['workspaceId'] === undefined ||
            typeof item['workspaceId'] === 'string')
        );
      }),
    ) as Record<string, LifecycleIntent>;
  } catch {
    return {};
  }
}
function save(key: string, intents: Record<string, LifecycleIntent>): boolean {
  try {
    if (Object.keys(intents).length)
      sessionStorage.setItem(key, JSON.stringify(intents));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
function pause(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export function useManagedSessionLifecycle(
  provider: ManagedAgentProvider,
  clientId: string,
  summaries: readonly ManagedAgentSessionSummary[],
  onChange: (
    sessionId: string,
    action?: ManagedLifecycleAction,
    workspaceId?: string,
  ) => void,
) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const scope = useMemo(() => {
    const key = `qwen-managed-lifecycle:${JSON.stringify([provider.storageKey, clientId])}`;
    return {
      key,
      intents: read(key),
      states: {} as Record<string, ManagedLifecycleState>,
      runs: new Map<string, AbortController>(),
      settled: new Set<string>(),
      alive: false,
    };
  }, [provider, clientId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const changed = useRef(onChange);
  changed.current = onChange;
  const current = () => scope.alive && currentScope.current === scope;
  const update = (id: string, state: ManagedLifecycleState) => {
    if (!current()) return;
    scope.states[id] = {
      ...state,
      canConfirm: Boolean(scope.intents[id]),
      kind: scope.intents[id]?.kind,
    };
    render();
  };

  async function run(original: LifecycleIntent) {
    const api = provider.lifecycle;
    const id = original.sessionId;
    if (!api || !current() || scope.runs.has(id)) return;
    const abort = new AbortController();
    scope.runs.set(id, abort);
    const owns = () => current() && scope.runs.get(id) === abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let intent = original;
    let accepted = Boolean(intent.operationId);
    let stage = 'submitting';
    update(id, { action: intent.action, status: stage, busy: true });
    const persist = () => {
      scope.intents[id] = intent;
      if (!save(scope.key, scope.intents))
        throw new Error('storage_unavailable');
    };
    try {
      while (owns()) {
        abort.signal.throwIfAborted();
        clearTimeout(timer);
        timer = setTimeout(() => abort.abort(), 30_000);
        const options = { clientId, signal: abort.signal };
        if (intent.kind === 'unarchive') {
          if (!intent.idempotencyKey) throw new Error('Missing lifecycle key');
          const session = await api.unarchive(id, {
            ...options,
            idempotencyKey: intent.idempotencyKey,
          });
          if (!owns()) return;
          if (session.sessionId !== id)
            throw new Error('Unexpected restored Session identity');
          break;
        }
        const operation = intent.operationId
          ? await api.query(id, intent.operationId, options)
          : await api.submit(intent.kind, id, {
              ...options,
              idempotencyKey: intent.idempotencyKey!,
            });
        if (!owns()) return;
        if (
          operation.sessionId !== id ||
          operation.type !== intent.kind ||
          !operation.operationId ||
          (intent.operationId && operation.operationId !== intent.operationId)
        )
          throw new Error('Lifecycle operation identity mismatch');
        clearTimeout(timer);
        accepted = true;
        intent = { ...intent, operationId: operation.operationId };
        persist();
        stage = operation.status;
        if (stage === 'failed') {
          intent = { ...intent, failed: true };
          persist();
          update(id, {
            action: intent.action,
            status: stage,
            busy: false,
            code: operation.failureCode ?? undefined,
          });
          changed.current(id);
          return;
        }
        if (stage === 'completed') {
          scope.settled.add(operation.operationId);
          if (intent.action === 'close_archive' && intent.kind === 'close') {
            changed.current(id);
            intent = {
              ...intent,
              kind: 'archive',
              idempotencyKey: intent.archiveKey,
              operationId: undefined,
            };
            accepted = false;
            persist();
            continue;
          }
          break;
        }
        if (!['pending', 'running', 'recovery_blocked'].includes(stage))
          throw new Error('Unknown lifecycle operation status');
        update(id, {
          action: intent.action,
          status: stage,
          busy: true,
          code: operation.failureCode ?? undefined,
        });
        await pause(abort.signal, stage === 'recovery_blocked' ? 3_000 : 1_000);
      }
      if (!owns()) return;
      abort.signal.throwIfAborted();
      delete scope.intents[id];
      delete scope.states[id];
      save(scope.key, scope.intents);
      render();
      changed.current(id, intent.action, intent.workspaceId);
    } catch (error) {
      if (!owns()) return;
      const definitive =
        !accepted &&
        error instanceof JavaManagedAgentHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 403, 404, 408, 429].includes(error.status);
      if (definitive) {
        // A failed archive after close still retains its composite intent.
        if (intent.action === 'close_archive' && intent.kind === 'archive') {
          intent = { ...intent, failed: true };
          scope.intents[id] = intent;
          save(scope.key, scope.intents);
        } else {
          delete scope.intents[id];
          save(scope.key, scope.intents);
        }
      }
      update(id, {
        action: intent.action,
        status: definitive
          ? 'failed'
          : stage === 'recovery_blocked'
            ? stage
            : 'unconfirmed',
        busy: false,
        code:
          error instanceof JavaManagedAgentHttpError
            ? error.code
            : error instanceof Error && error.message === 'storage_unavailable'
              ? error.message
              : undefined,
      });
      changed.current(id);
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (scope.runs.get(id) === abort) scope.runs.delete(id);
    }
  }

  useEffect(() => {
    scope.alive = true;
    for (const intent of Object.values(scope.intents)) {
      if (intent.failed && !intent.operationId)
        update(intent.sessionId, {
          action: intent.action,
          status: 'failed',
          busy: false,
        });
      else void run(intent);
    }
    return () => {
      scope.alive = false;
      for (const abort of scope.runs.values()) abort.abort();
      scope.runs.clear();
    };
    // Each scope owns its requests; render-only callbacks use refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (!current() || !provider.lifecycle) return;
    for (const session of summaries) {
      const op = session.lifecycleOperation;
      if (
        !op ||
        op.status === 'completed' ||
        scope.settled.has(op.operationId) ||
        scope.intents[session.sessionId]
      )
        continue;
      if (!['close', 'archive', 'delete'].includes(op.type)) continue;
      const intent: LifecycleIntent = {
        sessionId: session.sessionId,
        workspaceId: session.workspace?.workspaceId,
        action: op.type,
        kind: op.type,
        operationId: op.operationId,
      };
      scope.intents[session.sessionId] = intent;
      save(scope.key, scope.intents);
      void run(intent);
    }
    // Observations recover requests whose original tab is no longer present.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries, scope, provider]);

  return {
    states: scope.states,
    blocked: (id?: string) => Boolean(id && scope.intents[id]),
    start(session: ManagedAgentSessionSummary, action: ManagedLifecycleAction) {
      if (!current() || !provider.lifecycle || scope.intents[session.sessionId])
        return;
      const intent: LifecycleIntent = {
        sessionId: session.sessionId,
        workspaceId: session.workspace?.workspaceId,
        action,
        kind: action === 'close_archive' ? 'close' : action,
        idempotencyKey: managedRequestId(),
        ...(action === 'close_archive'
          ? { archiveKey: managedRequestId() }
          : {}),
      };
      scope.intents[session.sessionId] = intent;
      if (!save(scope.key, scope.intents)) {
        delete scope.intents[session.sessionId];
        update(session.sessionId, {
          action,
          status: 'failed',
          busy: false,
          code: 'storage_unavailable',
        });
        return;
      }
      void run(intent);
    },
    confirm(id: string) {
      const intent = scope.intents[id];
      if (!intent || scope.runs.has(id)) return;
      if (intent.failed) {
        const next = {
          ...intent,
          failed: false,
          idempotencyKey: managedRequestId(),
          operationId: undefined,
        };
        if (!save(scope.key, { ...scope.intents, [id]: next })) {
          update(id, {
            action: intent.action,
            status: 'failed',
            busy: false,
            code: 'storage_unavailable',
          });
          return;
        }
        scope.intents[id] = next;
        void run(next);
      } else void run(intent);
    },
  };
}
