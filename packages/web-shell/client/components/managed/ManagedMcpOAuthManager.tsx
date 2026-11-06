import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedExtensionSelection,
  ManagedExtensionSnapshot,
  ManagedMcpAuthBinding,
} from './managed-extension-types';
import {
  isManagedExtensionPins,
  isManagedMcpAuthBindings,
} from './managed-extension-types';
import { ManagedMcpOAuthPanel } from './ManagedMcpOAuthPanel';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';

interface PendingBinding {
  key: string;
  selection: ManagedExtensionSelection;
}

export function ManagedMcpOAuthManager({
  provider,
  workspaceId,
  sessionId,
  snapshot,
  onChanged,
}: {
  provider: ManagedAgentProvider;
  workspaceId: string;
  sessionId: string;
  snapshot: ManagedExtensionSnapshot;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const api = provider.extensions;
  const clientId = getManagedClientId(api?.storageScope ?? provider.storageKey);
  const storageKey = api?.storageScope
    ? `managed-mcp-oauth-binding:${api.storageScope}:${workspaceId}:${sessionId}`
    : undefined;
  const [pending, setPending] = useState<PendingBinding>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const save = (value: PendingBinding | undefined) => {
    if (!mounted.current) return;
    setPending(value);
    if (storageKey)
      try {
        if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
        else sessionStorage.removeItem(storageKey);
      } catch {
        /* Storage is optional. */
      }
  };
  useEffect(() => {
    mounted.current = true;
    setPending(undefined);
    setFailed(false);
    setBusy(false);
    if (storageKey)
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) {
          const value = JSON.parse(raw) as PendingBinding;
          if (
            Object.keys(value).sort().join(',') !== 'key,selection' ||
            typeof value.key !== 'string' ||
            !/^[\w:-]{1,512}$/.test(value.key) ||
            !('selectionVersion' in value.selection) ||
            value.selection.selectionVersion !== 2 ||
            Object.keys(value.selection).sort().join(',') !==
              'expectedConfigRevision,extensions,mcpAuthBindings,selectionVersion' ||
            !Number.isSafeInteger(value.selection.expectedConfigRevision) ||
            value.selection.expectedConfigRevision < 0 ||
            !isManagedExtensionPins(value.selection.extensions) ||
            !isManagedMcpAuthBindings(value.selection.mcpAuthBindings)
          )
            sessionStorage.removeItem(storageKey);
          else setPending(value);
        }
      } catch {
        /* Storage is optional. */
      }
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [storageKey, provider, workspaceId, sessionId]);
  const apply = async (input: PendingBinding) => {
    if (!api?.lookupApplyOperation || busy) return;
    const abort = new AbortController();
    request.current?.abort();
    request.current = abort;
    setBusy(true);
    setFailed(false);
    save(input);
    const options = { clientId, signal: abort.signal };
    try {
      let current: ManagedExtensionSnapshot | undefined;
      try {
        current = await api.lookupApplyOperation(sessionId, input.key, options);
      } catch (cause) {
        if (
          !(cause instanceof JavaManagedAgentHttpError && cause.status === 404)
        )
          throw cause;
      }
      abort.signal.throwIfAborted();
      const result = current?.operation
        ? ['active', 'failed'].includes(current.operation.state)
          ? current
          : await api.resume(
              sessionId,
              current.operation.operationId,
              false,
              options,
            )
        : await api.apply(sessionId, input.selection, {
            ...options,
            idempotencyKey: input.key,
          });
      if (abort.signal.aborted) return;
      if (result.operation?.state === 'active') save(undefined);
      else setFailed(true);
      onChanged();
    } catch {
      if (!abort.signal.aborted && mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const bind = (binding: ManagedMcpAuthBinding) => {
    if (pending || !snapshot.selfService?.canApply) return;
    void apply({
      key: managedRequestId(),
      selection: {
        selectionVersion: 2,
        expectedConfigRevision: snapshot.revision,
        extensions: snapshot.extensions,
        mcpAuthBindings: [
          ...(snapshot.mcpAuthBindings ?? []).filter(
            (entry) => entry.serverId !== binding.serverId,
          ),
          binding,
        ],
      },
    });
  };
  if (!provider.mcpOAuth || !api?.lookupApplyOperation) return null;
  return (
    <div className="grid gap-3">
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>
            {t('managed.oauth.bindingPending')}
          </AlertDescription>
        </Alert>
      )}
      {pending ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void apply(pending)}
        >
          {t('managed.extensions.retry')}
        </Button>
      ) : (
        <>
          <ManagedMcpOAuthPanel
            provider={provider}
            sessionId={sessionId}
            extensions={snapshot.extensions}
            onAuthorized={bind}
            onRevoked={onChanged}
          />
          {(snapshot.mcpAuthBindings ?? []).map((binding) => (
            <div
              key={binding.serverId}
              className="grid gap-2 rounded-md border p-3 text-sm"
            >
              <strong>{binding.serverId}</strong>
              <p className="text-muted-foreground">
                {t('managed.oauth.removeHelp')}
              </p>
              <Button
                variant="outline"
                disabled={busy || !snapshot.selfService?.canApply}
                onClick={() =>
                  void apply({
                    key: managedRequestId(),
                    selection: {
                      selectionVersion: 2,
                      expectedConfigRevision: snapshot.revision,
                      extensions: snapshot.extensions,
                      mcpAuthBindings: (snapshot.mcpAuthBindings ?? []).filter(
                        (entry) => entry.serverId !== binding.serverId,
                      ),
                    },
                  })
                }
              >
                {t('managed.oauth.removeBinding')}
              </Button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
