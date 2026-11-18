import { useEffect, useMemo, useState } from 'react';
import type {
  ManagedAgentProvider,
  ManagedSessionMcp,
} from './managed-agent-provider';
import type {
  ManagedMcpManagementAction,
  ManagedMcpManagementSnapshot,
  ManagedMcpServerPin,
} from './managed-mcp-management-types';
import { managedRequestId } from './managed-session-storage';
import { isNonRetryableClientError } from './managed-request-error';
import { extractErrorDetail } from '../../utils/errorDetail';
import {
  restoreManagedMcpCommand,
  saveManagedMcpCommand,
  type ManagedMcpCommandAttempt,
  type ManagedMcpCommandTarget,
} from './managed-mcp-command-storage';

const attempts = new WeakMap<
  ManagedAgentProvider,
  Map<string, ManagedMcpCommandAttempt>
>();

interface View {
  scope: object;
  snapshot?: ManagedMcpManagementSnapshot;
  catalog?: ManagedSessionMcp;
  error?: string;
  catalogError?: string;
  busy: boolean;
  needsRetry: boolean;
}

export function useManagedMcpManagement(
  provider: ManagedAgentProvider,
  clientId: string,
  workspaceId: string | undefined,
  sessionId: string | undefined,
) {
  const scope = useMemo(() => {
    let pending = attempts.get(provider);
    if (!pending) {
      pending = new Map();
      attempts.set(provider, pending);
    }
    const key = JSON.stringify([
      provider.storageKey,
      clientId,
      workspaceId,
      sessionId,
    ]);
    const storageTarget: ManagedMcpCommandTarget | undefined =
      provider.mcpManagement?.storageScope && workspaceId && sessionId
        ? [
            provider.storageKey,
            provider.mcpManagement.storageScope,
            clientId,
            workspaceId,
            sessionId,
          ]
        : undefined;
    if (storageTarget && !pending.has(key)) {
      const stored = restoreManagedMcpCommand(storageTarget);
      if (stored) pending.set(key, stored);
    }
    return {
      key,
      storageTarget,
      active: false,
      busy: false,
      runId: 0,
      requests: new Set<AbortController>(),
      attempts: pending,
      snapshot: undefined as ManagedMcpManagementSnapshot | undefined,
    };
  }, [provider, clientId, workspaceId, sessionId]);
  const [view, setView] = useState<View>({
    scope,
    busy: false,
    needsRetry: scope.attempts.has(scope.key),
  });

  const actions = useMemo(() => {
    const api = provider.mcpManagement;
    const rememberAttempt = (attempt?: ManagedMcpCommandAttempt) => {
      if (attempt) scope.attempts.set(scope.key, attempt);
      else scope.attempts.delete(scope.key);
      if (scope.storageTarget)
        saveManagedMcpCommand(scope.storageTarget, attempt);
    };
    const update = (patch: Partial<View>) => {
      if (!scope.active) return;
      setView((current) => ({
        ...(current.scope === scope
          ? current
          : { scope, busy: false, needsRetry: false }),
        ...patch,
      }));
    };
    const request = async <T>(
      read: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      if (!scope.active) throw new Error('MCP Session changed.');
      const abort = new AbortController();
      scope.requests.add(abort);
      try {
        const result = await read(abort.signal);
        abort.signal.throwIfAborted();
        if (!scope.active) throw new Error('MCP Session changed.');
        return result;
      } finally {
        scope.requests.delete(abort);
      }
    };
    const accept = (
      response: ManagedMcpManagementSnapshot,
      operationResponse = false,
    ) => {
      const snapshot =
        operationResponse &&
        response.availableServers.length === 0 &&
        scope.snapshot
          ? { ...response, availableServers: scope.snapshot.availableServers }
          : response;
      if (snapshot.sessionId !== sessionId)
        throw new Error('MCP management Session identity mismatch.');
      scope.snapshot = snapshot;
      const operation = snapshot.operation;
      const attempt = scope.attempts.get(scope.key);
      if (
        attempt?.operationId === operation?.operationId &&
        operation &&
        ['settled', 'failed'].includes(operation.state)
      )
        rememberAttempt();
      update({
        snapshot,
        needsRetry:
          scope.attempts.has(scope.key) ||
          operation?.state === 'pending' ||
          operation?.state === 'recovery_required',
      });
    };
    const loadCatalog = async () => {
      if (!sessionId || !provider.mcp) return;
      try {
        const catalog = await request((signal) =>
          provider.mcp!.list(sessionId, { clientId, signal }),
        );
        if (catalog.session_id !== sessionId)
          throw new Error('MCP catalog Session identity mismatch.');
        update({ catalog, catalogError: undefined });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          update({ catalogError: extractErrorDetail(error) });
      }
    };
    const run = async (work: () => Promise<void>) => {
      if (!scope.active || scope.busy) return;
      scope.busy = true;
      const runId = ++scope.runId;
      update({ busy: true, error: undefined });
      try {
        await work();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          update({ error: extractErrorDetail(error) });
      } finally {
        if (runId === scope.runId) {
          scope.busy = false;
          update({ busy: false });
        }
      }
    };
    const observeAttempt = async (
      attempt: ManagedMcpCommandAttempt,
      resume = false,
    ) => {
      if (!api || !sessionId) return;
      try {
        const submitOriginal = (signal: AbortSignal) =>
          api.submit(sessionId, attempt.command, {
            clientId,
            signal,
            requestId: attempt.requestId,
            idempotencyKey: attempt.idempotencyKey,
          });
        const acceptAttempt = (snapshot: ManagedMcpManagementSnapshot) => {
          if (
            snapshot.sessionId !== sessionId ||
            !snapshot.operation ||
            snapshot.operation.action !== attempt.command.action ||
            snapshot.operation.serverId !== attempt.command.serverId ||
            snapshot.operation.revision !==
              attempt.command.expectedRevision + 1 ||
            (attempt.operationId &&
              snapshot.operation.operationId !== attempt.operationId)
          )
            throw new Error('MCP operation identity mismatch.');
          attempt.operationId = snapshot.operation.operationId;
          rememberAttempt(attempt);
          accept(snapshot, true);
        };
        const operationId = attempt.operationId;
        const snapshot = await request((signal) =>
          operationId
            ? api.operation(sessionId, operationId, { clientId, signal })
            : submitOriginal(signal),
        );
        acceptAttempt(snapshot);
        if (
          resume &&
          operationId &&
          (snapshot.operation?.state === 'pending' ||
            snapshot.operation?.state === 'recovery_required')
        )
          acceptAttempt(await request(submitOriginal));
        await loadCatalog();
      } catch (error) {
        if (
          scope.active &&
          !resume &&
          !attempt.operationId &&
          isNonRetryableClientError(error)
        ) {
          rememberAttempt();
          update({ needsRetry: false });
        }
        throw error;
      }
    };
    return {
      refresh: () =>
        run(async () => {
          if (!api || !sessionId || !workspaceId) return;
          accept(
            await request((signal) =>
              api.query(sessionId, { clientId, signal }),
            ),
          );
          await loadCatalog();
        }),
      submit: (
        action: ManagedMcpManagementAction,
        serverId: string,
        server?: ManagedMcpServerPin,
      ) =>
        run(async () => {
          const snapshot = scope.snapshot;
          if (
            !api ||
            !sessionId ||
            !workspaceId ||
            !snapshot?.supported ||
            scope.attempts.has(scope.key) ||
            snapshot.operation?.state === 'pending' ||
            snapshot.operation?.state === 'recovery_required'
          )
            return;
          const attempt: ManagedMcpCommandAttempt = {
            command: {
              action,
              serverId,
              expectedRevision: snapshot.revision,
              ...(server ? { server } : {}),
            },
            requestId: managedRequestId(),
            idempotencyKey: managedRequestId(),
          };
          rememberAttempt(attempt);
          update({ needsRetry: true });
          await observeAttempt(attempt);
        }),
      retry: () =>
        run(async () => {
          if (!api || !sessionId || !workspaceId) return;
          const attempt = scope.attempts.get(scope.key);
          if (attempt) await observeAttempt(attempt, true);
          else if (scope.snapshot?.operation) {
            const operationId = scope.snapshot.operation.operationId;
            const snapshot = await request((signal) =>
              api.operation(sessionId, operationId, { clientId, signal }),
            );
            if (snapshot.operation?.operationId !== operationId)
              throw new Error('MCP operation identity mismatch.');
            accept(snapshot, true);
            await loadCatalog();
          }
        }),
    };
  }, [provider, clientId, workspaceId, sessionId, scope]);

  useEffect(() => {
    scope.active = true;
    void actions.refresh();
    return () => {
      scope.active = false;
      scope.busy = false;
      for (const request of scope.requests) request.abort();
      scope.requests.clear();
    };
  }, [scope, actions]);

  return {
    snapshot: view.scope === scope ? view.snapshot : undefined,
    catalog: view.scope === scope ? view.catalog : undefined,
    error: view.scope === scope ? view.error : undefined,
    catalogError: view.scope === scope ? view.catalogError : undefined,
    busy: view.scope === scope && view.busy,
    needsRetry:
      view.scope === scope ? view.needsRetry : scope.attempts.has(scope.key),
    canResume: scope.attempts.has(scope.key),
    ...actions,
  };
}
