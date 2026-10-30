import { useEffect, useMemo, useReducer, useRef } from 'react';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { managedRequestId } from './managed-session-storage';
import { isManagedTaskTerminal } from './use-managed-tasks';
import type {
  ManagedAgentProvider,
  ManagedTask,
  ManagedTaskCancelOperation,
} from './managed-agent-provider';

interface CancelIntent {
  sessionId: string;
  taskId: string;
  idempotencyKey: string;
  operationId?: string;
  accepted?: boolean;
}
export interface ManagedTaskCancelState {
  status: 'submitting' | 'stopping' | 'unconfirmed' | 'failed';
  busy: boolean;
  code?: string;
}

function readIntents(
  key: string,
  sessionId?: string,
): Record<string, CancelIntent> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([taskId, item]) => {
        if (!item || typeof item !== 'object') return false;
        const intent = item as Record<string, unknown>;
        return (
          intent['sessionId'] === sessionId &&
          intent['taskId'] === taskId &&
          typeof intent['idempotencyKey'] === 'string' &&
          !!intent['idempotencyKey'] &&
          (intent['operationId'] === undefined ||
            typeof intent['operationId'] === 'string') &&
          (intent['accepted'] === undefined ||
            typeof intent['accepted'] === 'boolean') &&
          (intent['accepted'] !== true || !!intent['operationId'])
        );
      }),
    ) as Record<string, CancelIntent>;
  } catch {
    return {};
  }
}

function save(key: string, intents: Record<string, CancelIntent>): boolean {
  try {
    if (Object.keys(intents).length)
      sessionStorage.setItem(key, JSON.stringify(intents));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function wait(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function useManagedTaskCancel(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  snapshots: readonly ManagedTask[],
  refreshTasks: () => void,
  applySnapshot: (task: ManagedTask) => void,
) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const scope = useMemo(() => {
    const key = `qwen-managed-task-cancel:${JSON.stringify([provider.storageKey, sessionId])}`;
    return {
      key,
      intents: readIntents(key, sessionId),
      states: {} as Record<string, ManagedTaskCancelState>,
      runs: new Map<string, AbortController>(),
      alive: false,
    };
  }, [provider, sessionId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const refreshRef = useRef(refreshTasks);
  refreshRef.current = refreshTasks;
  const applyRef = useRef(applySnapshot);
  applyRef.current = applySnapshot;
  const current = () => scope.alive && currentScope.current === scope;
  function update(taskId: string, state: ManagedTaskCancelState) {
    if (!current()) return;
    scope.states[taskId] = state;
    render();
  }
  function clear(taskId: string) {
    scope.runs.get(taskId)?.abort();
    scope.runs.delete(taskId);
    delete scope.intents[taskId];
    delete scope.states[taskId];
    save(scope.key, scope.intents);
    render();
  }

  async function run(
    original: CancelIntent,
    replay: boolean,
    freshRequest = false,
  ) {
    const api = provider.tasks?.cancel;
    if (!current() || !api || scope.runs.has(original.taskId)) return;
    const abort = new AbortController();
    scope.runs.set(original.taskId, abort);
    const owns = () => current() && scope.runs.get(original.taskId) === abort;
    const timer = setTimeout(() => abort.abort(), 30_000);
    let intent = original;
    let accepted = original.accepted === true;
    let received = false;
    update(intent.taskId, {
      status: accepted ? 'stopping' : 'submitting',
      busy: true,
    });
    try {
      const request = { clientId, signal: abort.signal };
      let operation: ManagedTaskCancelOperation = replay
        ? await api.submit(intent.sessionId, intent.taskId, {
            ...request,
            idempotencyKey: intent.idempotencyKey,
          })
        : await api.query(
            intent.sessionId,
            intent.taskId,
            intent.operationId!,
            request,
          );
      received = true;
      let delay = 1_000;
      while (owns()) {
        abort.signal.throwIfAborted();
        if (
          operation.type !== 'task_cancel' ||
          operation.sessionId !== intent.sessionId ||
          operation.taskId !== intent.taskId ||
          !operation.operationId ||
          (intent.operationId && operation.operationId !== intent.operationId)
        )
          throw new Error('Task cancel operation identity mismatch');
        if (accepted && operation.status !== 'completed')
          throw new Error('Task cancel operation status regressed');
        intent = {
          ...intent,
          operationId: operation.operationId,
          ...(operation.status === 'completed' ? { accepted: true } : {}),
        };
        scope.intents[intent.taskId] = intent;
        const stored = save(scope.key, scope.intents);
        if (operation.status === 'failed') {
          clear(intent.taskId);
          update(intent.taskId, {
            status: 'failed',
            busy: false,
            code: operation.failureCode ?? 'unknown_failure',
          });
          refreshRef.current();
          return;
        }
        if (operation.status === 'completed') {
          if (!accepted) refreshRef.current();
          accepted = true;
          update(intent.taskId, {
            status: 'stopping',
            busy: true,
            code: stored ? undefined : 'storage_unavailable',
          });
          const task = await provider.tasks!.get(
            intent.sessionId,
            intent.taskId,
            request,
          );
          if (!owns()) return;
          if (
            task.sessionId !== intent.sessionId ||
            task.taskId !== intent.taskId
          )
            throw new Error('Task identity mismatch');
          applyRef.current(task);
          if (isManagedTaskTerminal(task)) {
            clear(intent.taskId);
            refreshRef.current();
            return;
          }
        } else if (operation.status === 'recovery_blocked') {
          update(intent.taskId, {
            status: 'unconfirmed',
            busy: false,
            code: operation.failureCode,
          });
          return;
        } else if (
          operation.status !== 'pending' &&
          operation.status !== 'running'
        ) {
          throw new Error('Invalid task cancel operation status');
        }
        await wait(abort.signal, delay);
        abort.signal.throwIfAborted();
        delay = Math.min(delay + 1_000, 3_000);
        if (!accepted)
          operation = await api.query(
            intent.sessionId,
            intent.taskId,
            intent.operationId!,
            request,
          );
      }
    } catch (error) {
      if (!owns()) return;
      const code =
        error instanceof JavaManagedAgentHttpError ? error.code : undefined;
      // A first POST rejection proves no admission. A replay rejection cannot
      // disprove the operation whose reply was lost, including revoked access.
      if (
        freshRequest &&
        !received &&
        error instanceof JavaManagedAgentHttpError &&
        [400, 403, 404, 409].includes(error.status)
      ) {
        clear(original.taskId);
        update(original.taskId, { status: 'failed', busy: false, code });
        refreshRef.current();
      } else
        update(original.taskId, {
          status: accepted ? 'stopping' : 'unconfirmed',
          busy: false,
          code,
        });
    } finally {
      clearTimeout(timer);
      if (owns()) {
        scope.runs.delete(original.taskId);
        const state = scope.states[original.taskId];
        if (state) update(original.taskId, { ...state, busy: false });
      }
    }
  }
  useEffect(() => {
    scope.alive = true;
    for (const intent of Object.values(scope.intents)) {
      if (intent.operationId) void run(intent, false);
    }
    return () => {
      scope.alive = false;
      for (const abort of scope.runs.values()) abort.abort();
      scope.runs.clear();
    };
    // The scope owns recovery for one provider identity and Session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    for (const task of snapshots) {
      if (
        task.sessionId === sessionId &&
        isManagedTaskTerminal(task) &&
        (scope.states[task.taskId]?.status === 'stopping' ||
          (!scope.intents[task.taskId] &&
            scope.states[task.taskId]?.status === 'failed' &&
            [
              'session_operation_active',
              'task_action_unavailable',
              'task_already_settled',
            ].includes(scope.states[task.taskId].code ?? '')))
      )
        clear(task.taskId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, snapshots, sessionId]);

  return {
    states: {
      ...Object.fromEntries(
        Object.keys(scope.intents).map((taskId) => [
          taskId,
          {
            status: 'unconfirmed',
            busy: false,
          } satisfies ManagedTaskCancelState,
        ]),
      ),
      ...scope.states,
    } as Record<string, ManagedTaskCancelState>,
    pendingTaskIds: Object.keys(scope.intents),
    async submit(task: ManagedTask) {
      if (
        !sessionId ||
        !current() ||
        !provider.tasks?.cancel ||
        task.sessionId !== sessionId ||
        !task.actionCapabilities.includes('cancel') ||
        scope.intents[task.taskId]
      )
        return;
      const intent: CancelIntent = {
        sessionId,
        taskId: task.taskId,
        idempotencyKey: managedRequestId(),
      };
      const intents = { ...scope.intents, [task.taskId]: intent };
      if (!save(scope.key, intents)) {
        update(task.taskId, {
          status: 'failed',
          busy: false,
          code: 'storage_unavailable',
        });
        return;
      }
      scope.intents = intents;
      await run(intent, true, true);
    },
    resume(taskId: string) {
      const intent = scope.intents[taskId];
      if (intent) return run(intent, !intent.operationId);
      return Promise.resolve();
    },
  };
}
