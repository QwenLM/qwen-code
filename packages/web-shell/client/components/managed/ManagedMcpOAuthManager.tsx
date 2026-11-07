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
  isManagedExtensionApplyRejected,
  isManagedExtensionConfigurationPending,
  queryManagedExtensionApplyReview,
} from './managed-extension-install';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';

interface PendingBinding {
  key: string;
  selection: ManagedExtensionSelection;
  applySubmitted?: boolean;
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
  const [configuration, setConfiguration] = useState(snapshot);
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
  useEffect(() => setConfiguration(snapshot), [snapshot]);
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
            Object.keys(value).some(
              (key) => !['key', 'selection', 'applySubmitted'].includes(key),
            ) ||
            (value.applySubmitted !== undefined &&
              typeof value.applySubmitted !== 'boolean') ||
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
          else
            setPending({
              ...value,
              applySubmitted: value.applySubmitted ?? true,
            });
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
    let applying = false;
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
      let result: ManagedExtensionSnapshot;
      if (current?.operation) {
        result = ['active', 'failed'].includes(current.operation.state)
          ? current
          : await api.resume(
              sessionId,
              current.operation.operationId,
              false,
              options,
            );
      } else {
        applying = true;
        save({ ...input, applySubmitted: true });
        result = await api.apply(sessionId, input.selection, {
          ...options,
          idempotencyKey: input.key,
        });
      }
      if (abort.signal.aborted) return;
      if (
        result.operation?.state === 'active' &&
        result.operation.mode === 'apply'
      )
        save(undefined);
      else {
        if (result.operation && !isManagedExtensionConfigurationPending(result))
          save({ ...input, applySubmitted: false });
        setFailed(true);
      }
      onChanged();
    } catch (cause) {
      if (!abort.signal.aborted && mounted.current) {
        if (applying && isManagedExtensionApplyRejected(cause))
          save({ ...input, applySubmitted: false });
        setFailed(true);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const bind = (binding: ManagedMcpAuthBinding) => {
    if (pending || !configuration.selfService?.canApply) return;
    void apply({
      key: managedRequestId(),
      applySubmitted: false,
      selection: {
        selectionVersion: 2,
        expectedConfigRevision: configuration.revision,
        extensions: configuration.extensions,
        mcpAuthBindings: [
          ...(configuration.mcpAuthBindings ?? []).filter(
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
        <>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void apply(pending)}
          >
            {t('managed.extensions.retry')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              const abort = new AbortController();
              request.current?.abort();
              request.current = abort;
              setBusy(true);
              void queryManagedExtensionApplyReview(
                api,
                sessionId,
                pending.key,
                pending.applySubmitted ?? true,
                {
                  clientId,
                  signal: abort.signal,
                },
              )
                .then((current) => {
                  if (abort.signal.aborted || !mounted.current) return;
                  setConfiguration(current);
                  save(undefined);
                  setFailed(false);
                  onChanged();
                })
                .catch(() => {
                  if (!abort.signal.aborted && mounted.current) setFailed(true);
                })
                .finally(() => {
                  if (!abort.signal.aborted && mounted.current) setBusy(false);
                });
            }}
          >
            {t('managed.install.reviewAgain')}
          </Button>
        </>
      ) : (
        <>
          <ManagedMcpOAuthPanel
            provider={provider}
            sessionId={sessionId}
            extensions={configuration.extensions}
            onAuthorized={bind}
            onRevoked={onChanged}
          />
          {(configuration.mcpAuthBindings ?? []).map((binding) => (
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
                disabled={busy || !configuration.selfService?.canApply}
                onClick={() =>
                  void apply({
                    key: managedRequestId(),
                    applySubmitted: false,
                    selection: {
                      selectionVersion: 2,
                      expectedConfigRevision: configuration.revision,
                      extensions: configuration.extensions,
                      mcpAuthBindings: (
                        configuration.mcpAuthBindings ?? []
                      ).filter((entry) => entry.serverId !== binding.serverId),
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
