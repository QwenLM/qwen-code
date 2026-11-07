import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Alert, AlertDescription } from '../ui/alert';
import {
  McpResourceDetail,
  McpServerCard,
  McpToolDetail,
} from '../mcp/McpDetails';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedMcpManagementAction,
  ManagedMcpManagementSnapshot,
  ManagedMcpServerPin,
} from './managed-mcp-management-types';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';
import { useManagedMcpManagement } from './use-managed-mcp-management';
import { ManagedExtensionInstaller } from './ManagedExtensionInstaller';
import { ManagedMcpOAuthManager } from './ManagedMcpOAuthManager';
import type {
  ManagedExtensionCatalog,
  ManagedExtensionInspection,
  ManagedExtensionSnapshot,
} from './managed-extension-types';

export interface ManagedMcpManagerPageProps {
  provider: ManagedAgentProvider;
  sessionId?: string;
  workspaceId?: string;
  onClose?: () => void;
  onOpenExtensions?: () => void;
}

function pinKey(pin: ManagedMcpServerPin) {
  return JSON.stringify([
    pin.serverId,
    pin.serverRevision,
    pin.definitionDigest,
  ]);
}

function PublishedServerDialog({
  action,
  serverId,
  snapshot,
  onClose,
  onSave,
}: {
  action: 'add' | 'edit';
  serverId?: string;
  snapshot: ManagedMcpManagementSnapshot;
  onClose: () => void;
  onSave: (pin: ManagedMcpServerPin) => void;
}) {
  const { t } = useI18n();
  const available = snapshot.availableServers.filter((pin) =>
    action === 'edit'
      ? pin.serverId === serverId
      : !snapshot.servers.some(
          (server) =>
            server.serverId === pin.serverId && server.state !== 'removed',
        ),
  );
  const [selected, setSelected] = useState(() =>
    available[0] ? pinKey(available[0]) : '',
  );
  const pin = available.find((entry) => pinKey(entry) === selected);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`managed.mcp.action.${action}`)}</DialogTitle>
          <DialogDescription>
            {t('managed.mcp.publishedOnly')}
          </DialogDescription>
        </DialogHeader>
        {available.length ? (
          <div className="grid min-w-0 gap-3">
            <label
              className="text-sm font-medium"
              htmlFor="managed-mcp-definition"
            >
              {t('managed.mcp.definition')}
            </label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger
                id="managed-mcp-definition"
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {available.map((entry) => (
                  <SelectItem key={pinKey(entry)} value={pinKey(entry)}>
                    {entry.serverId} · v{entry.serverRevision} ·{' '}
                    {entry.transport}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {pin && (
              <code className="break-all text-xs text-muted-foreground">
                {pin.definitionDigest}
              </code>
            )}
          </div>
        ) : (
          <p role="status">{t('managed.mcp.noPublished')}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!pin}
            onClick={() => {
              if (pin)
                onSave({
                  serverId: pin.serverId,
                  serverRevision: pin.serverRevision,
                  definitionDigest: pin.definitionDigest,
                });
            }}
          >
            {t('managed.mcp.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ManagedMcpManagerPage(props: ManagedMcpManagerPageProps) {
  const clientId = useMemo(
    () => getManagedClientId(props.provider.storageKey),
    [props.provider],
  );
  const scope = useMemo(
    () =>
      JSON.stringify([
        props.provider.storageKey,
        clientId,
        props.workspaceId,
        props.sessionId,
        managedRequestId(),
      ]),
    [props.provider, clientId, props.workspaceId, props.sessionId],
  );
  return (
    <ManagedMcpManagerContent key={scope} {...props} clientId={clientId} />
  );
}

function ManagedMcpManagerContent({
  provider,
  clientId,
  sessionId,
  workspaceId,
  onClose,
  onOpenExtensions,
}: ManagedMcpManagerPageProps & { clientId: string }) {
  const { t } = useI18n();
  const management = useManagedMcpManagement(
    provider,
    clientId,
    workspaceId,
    sessionId,
  );
  const [selectedServer, setSelectedServer] = useState<string>();
  const [editor, setEditor] = useState<{
    action: 'add' | 'edit';
    serverId?: string;
  }>();
  const [packages, setPackages] = useState<{
    catalog: ManagedExtensionCatalog;
    snapshot: ManagedExtensionSnapshot;
  }>();
  const [showInstaller, setShowInstaller] = useState(false);
  const [packageEditor, setPackageEditor] = useState<{
    extensionId: string;
    inspection: ManagedExtensionInspection;
  }>();
  const [packageError, setPackageError] = useState(false);
  const loadPackages = useCallback(
    async (signal?: AbortSignal) => {
      if (!provider.extensions || !workspaceId || !sessionId) return;
      const [catalog, snapshot] = await Promise.all([
        provider.extensions.list(workspaceId, { clientId, signal }),
        provider.extensions.query(sessionId, { clientId, signal }),
      ]);
      if (!signal?.aborted) setPackages({ catalog, snapshot });
    },
    [provider, workspaceId, sessionId, clientId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void loadPackages(abort.signal).catch(() => {
      if (!abort.signal.aborted) setPackageError(true);
    });
    return () => abort.abort();
  }, [loadPackages]);
  const snapshot = management.snapshot;
  const server = snapshot?.servers.find(
    (entry) => entry.serverId === selectedServer,
  );
  const catalog = management.catalog?.servers.find(
    (entry) => entry.server_id === selectedServer,
  );
  const owned =
    server &&
    packages?.snapshot.extensions.find((pin) =>
      server.serverId.startsWith(`${pin.extensionId}:`),
    );
  const openPackage = async (extensionId: string) => {
    if (!provider.extensions?.inspect || !workspaceId) return;
    const pin =
      packages?.snapshot.extensions.find(
        (entry) => entry.extensionId === extensionId,
      ) ??
      packages?.catalog.extensions.find(
        (entry) => entry.pin.extensionId === extensionId,
      )?.pin;
    if (!pin) return;
    setPackageError(false);
    try {
      const inspection = await provider.extensions.inspect(workspaceId, pin, {
        clientId,
      });
      if (
        inspection.mcpServers.length !== 1 ||
        inspection.manifest.components.some(
          (component) => !['mcp', 'settings'].includes(component),
        )
      ) {
        if (onOpenExtensions) onOpenExtensions();
        else setPackageError(true);
        return;
      }
      setPackageEditor({ extensionId, inspection });
      setShowInstaller(true);
    } catch {
      setPackageError(true);
    }
  };
  const disabled =
    management.busy || management.needsRetry || !snapshot?.supported;
  const operation = snapshot?.operation;
  const run = (action: ManagedMcpManagementAction, serverId: string) => {
    void management.submit(action, serverId);
  };
  const serverState = (entry: NonNullable<typeof server>) => {
    if (
      operation?.serverId === entry.serverId &&
      operation.revision === snapshot?.revision
    ) {
      if (
        operation.state === 'pending' ||
        operation.state === 'recovery_required'
      )
        return t(`managed.mcp.operation.${operation.state}`);
      if (
        operation.state === 'settled' &&
        (operation.action === 'disable' || operation.action === 'remove')
      )
        return t('managed.mcp.drained');
    }
    return t(`managed.mcp.state.${entry.state}`);
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 pb-6" data-managed-mcp-manager>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {(onClose || server) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('common.back')}
              onClick={() =>
                server ? setSelectedServer(undefined) : onClose?.()
              }
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <h2 className="text-lg font-semibold">{t('managed.mcp.manage')}</h2>
        </div>
        {sessionId && workspaceId && provider.mcpManagement && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={management.busy}
              onClick={() => void management.refresh()}
            >
              {management.busy ? <Spinner /> : <RefreshCwIcon />}
              {t('common.refresh')}
            </Button>
            {snapshot?.supported && (
              <Button
                disabled={disabled}
                onClick={() => setEditor({ action: 'add' })}
              >
                <PlusIcon />
                {t('managed.mcp.action.add')}
              </Button>
            )}
          </div>
        )}
      </div>
      {packages?.catalog.selfService?.canPublish &&
        packages.snapshot.selfService?.canApply &&
        workspaceId &&
        sessionId && (
          <div className="grid gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setPackageEditor(undefined);
                setShowInstaller((old) => !old);
              }}
            >
              {t('managed.install.createMcp')}
            </Button>
            {showInstaller && (
              <ManagedExtensionInstaller
                key={packageEditor?.extensionId ?? 'new'}
                provider={provider}
                workspaceId={workspaceId}
                sessionId={sessionId}
                catalog={packages.catalog}
                snapshot={packages.snapshot}
                initialKind="mcp"
                editing={packageEditor}
                onExitEdit={() => setPackageEditor(undefined)}
                onChanged={() => {
                  void loadPackages().catch(() => setPackageError(true));
                  void management.refresh();
                }}
              />
            )}
            {packages.catalog.extensions
              .filter((entry) => entry.manifest.components.includes('mcp'))
              .map((entry) => (
                <div
                  key={entry.pin.extensionId}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
                >
                  <span>{entry.manifest.name}</span>
                  <Badge variant="outline">
                    {t('managed.install.packageSource')}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void openPackage(entry.pin.extensionId)}
                  >
                    {t('managed.install.editMcp')}
                  </Button>
                </div>
              ))}
          </div>
        )}
      {packageError && (
        <Alert variant="destructive">
          <AlertDescription>
            {t('managed.install.packageEditUnavailable')}
            {onOpenExtensions && (
              <Button variant="outline" onClick={onOpenExtensions}>
                {t('managed.extensions.title')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {packages &&
        workspaceId &&
        sessionId &&
        (packages.snapshot.selectionVersion === 2 ||
          packages.catalog.extensions.some(
            (entry) =>
              entry.manifest.compilerVersion === 2 &&
              packages.snapshot.extensions.some(
                (pin) => pin.extensionId === entry.pin.extensionId,
              ),
          )) && (
          <ManagedMcpOAuthManager
            key={`oauth:${provider.storageKey}:${workspaceId}:${sessionId}`}
            provider={provider}
            workspaceId={workspaceId}
            sessionId={sessionId}
            snapshot={packages.snapshot}
            onChanged={() => {
              void loadPackages().catch(() => setPackageError(true));
              void management.refresh();
            }}
          />
        )}
      {!sessionId ? (
        <p role="status">{t('managed.mcp.selectSession')}</p>
      ) : !workspaceId ? (
        <p role="status">{t('managed.mcp.workspaceUnavailable')}</p>
      ) : !provider.mcpManagement || snapshot?.supported === false ? (
        <p role="status">{t('managed.mcp.unsupported')}</p>
      ) : (
        <>
          <p className="break-all text-sm text-muted-foreground">
            {t('managed.mcp.sessionRevision', {
              sessionId,
              revision: snapshot?.revision ?? '…',
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('managed.mcp.sessionSettings')}
          </p>
        </>
      )}
      {management.error && (
        <Alert variant="destructive">
          <AlertDescription>{management.error}</AlertDescription>
        </Alert>
      )}
      {operation && (
        <Alert
          variant={
            operation.state === 'failed' ||
            operation.state === 'recovery_required'
              ? 'destructive'
              : operation.state === 'settled' && !management.needsRetry
                ? 'success'
                : 'default'
          }
        >
          <AlertDescription>
            <p>
              {operation.serverId}:{' '}
              {t(`managed.mcp.action.${operation.action}`)} ·{' '}
              {t(`managed.mcp.operation.${operation.state}`)}
            </p>
            {operation.error && <p>{operation.error.code}</p>}
          </AlertDescription>
        </Alert>
      )}
      {management.needsRetry && (
        <Alert>
          <AlertDescription>
            <p>{t('managed.mcp.unconfirmed')}</p>
            <Button
              variant="outline"
              className="mt-2"
              disabled={management.busy}
              onClick={() => void management.retry()}
            >
              {t(
                management.canResume
                  ? 'managed.mcp.retryCommand'
                  : 'managed.mcp.checkOperation',
              )}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {snapshot?.supported &&
        (server ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="break-all">{server.serverId}</CardTitle>
              </CardHeader>
              <CardContent className="grid min-w-0 gap-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{serverState(server)}</Badge>
                  <Badge variant="outline">v{server.serverRevision}</Badge>
                </div>
                <code className="break-all text-xs text-muted-foreground">
                  {server.definitionDigest}
                </code>
                {owned && (
                  <div className="grid gap-2">
                    <p className="text-sm text-muted-foreground">
                      {t('managed.install.ownedMcp')}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => void openPackage(owned.extensionId)}
                    >
                      {t('managed.install.editMcp')}
                    </Button>
                  </div>
                )}
                {server.state !== 'removed' && !owned && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        setEditor({ action: 'edit', serverId: server.serverId })
                      }
                    >
                      {t('managed.mcp.action.edit')}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        run(
                          server.state === 'enabled' ? 'disable' : 'enable',
                          server.serverId,
                        )
                      }
                    >
                      {t(
                        `managed.mcp.action.${server.state === 'enabled' ? 'disable' : 'enable'}`,
                      )}
                    </Button>
                    {server.state === 'enabled' && (
                      <>
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() => run('reload', server.serverId)}
                        >
                          {t('managed.mcp.action.reload')}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() => run('restart', server.serverId)}
                        >
                          {t('managed.mcp.action.restart')}
                        </Button>
                      </>
                    )}
                    <Button
                      variant="destructive"
                      disabled={disabled}
                      onClick={() => run('remove', server.serverId)}
                    >
                      {t('managed.mcp.action.remove')}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
            <p className="text-sm text-muted-foreground">
              {t('managed.mcp.metadataOnly')}
            </p>
            {management.catalogError && (
              <p role="alert">{management.catalogError}</p>
            )}
            {!catalog ? (
              <p role="status">{t('managed.mcp.noCatalog')}</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('managed.mcp.catalog', {
                    tools: catalog.tools.length,
                    toolsState: t(
                      `managed.mcp.discovery.${catalog.discovery.tools}`,
                    ),
                    resources: catalog.resources.length,
                    resourcesState: t(
                      `managed.mcp.discovery.${catalog.discovery.resources}`,
                    ),
                    prompts: catalog.prompts.length,
                    promptsState: t(
                      `managed.mcp.discovery.${catalog.discovery.prompts}`,
                    ),
                  })}
                </p>
                <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                  {catalog.tools.map((tool) => (
                    <Card key={tool.name} className="min-w-0">
                      <CardHeader>
                        <CardTitle className="break-all">{tool.name}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <McpToolDetail
                          tool={{
                            description: tool.description,
                            schema: tool.input_schema,
                          }}
                        />
                      </CardContent>
                    </Card>
                  ))}
                  {catalog.resources.map((resource) => (
                    <Card key={resource.uri} className="min-w-0">
                      <CardHeader>
                        <CardTitle className="break-all">
                          {resource.name}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <McpResourceDetail
                          resource={{
                            ...resource,
                            mimeType: resource.mime_type,
                          }}
                        />
                      </CardContent>
                    </Card>
                  ))}
                  {catalog.prompts.map((prompt) => (
                    <Card key={prompt.name} className="min-w-0">
                      <CardHeader>
                        <CardTitle className="break-all">
                          /{prompt.name}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="grid gap-2">
                        <p className="break-words text-sm">
                          {prompt.description || t('mcp.noDescription')}
                        </p>
                        {prompt.arguments?.map((argument) => (
                          <p
                            key={argument.name}
                            className="break-words text-sm"
                          >
                            {argument.name}
                            {argument.required ? ' *' : ''}:{' '}
                            {argument.description}
                          </p>
                        ))}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </>
            )}
          </>
        ) : snapshot.servers.length ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {snapshot.servers.map((entry) => (
              <McpServerCard
                key={entry.serverId}
                name={entry.serverId}
                description={`v${entry.serverRevision}`}
                status={<Badge variant="secondary">{serverState(entry)}</Badge>}
                onOpen={() => setSelectedServer(entry.serverId)}
              />
            ))}
          </div>
        ) : (
          <p role="status">{t('managed.mcp.empty')}</p>
        ))}
      {editor && snapshot && (
        <PublishedServerDialog
          action={editor.action}
          serverId={editor.serverId}
          snapshot={snapshot}
          onClose={() => setEditor(undefined)}
          onSave={(pin) => {
            setEditor(undefined);
            void management.submit(editor.action, pin.serverId, pin);
          }}
        />
      )}
    </div>
  );
}
