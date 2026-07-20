import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  DatabaseIcon,
  EllipsisVerticalIcon,
  InfoIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import type {
  DaemonWorkspaceActions,
  DaemonWorkspaceMcpResourceStatus,
  DaemonWorkspaceMcpResourcesStatus,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpToolStatus,
  DaemonWorkspaceMcpToolsStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useMcp, useSettings } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import styles from './McpManagerPage.module.css';
import type { SerializedMcpStatusMessage } from '../messages/McpStatusMessage';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';
import { Button } from '../ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Spinner } from '../ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { Textarea } from '../ui/textarea';
import type { EmbeddedManagerPage } from '../plugins/manager-page';

type McpStatus = Awaited<ReturnType<DaemonWorkspaceActions['loadMcpStatus']>>;
type T = ReturnType<typeof useI18n>['t'];
type SourceFilter = 'all' | 'user' | 'workspace' | 'extension';
type McpSettingsScope = 'user' | 'workspace';
const DEFAULT_MCP_SERVER_CONFIG = '{\n  "command": "",\n  "args": []\n}';
type McpServerAction = {
  id:
    | 'edit'
    | 'approve'
    | 'reconnect'
    | 'enable'
    | 'disable'
    | 'authenticate'
    | 'clear-auth'
    | 'remove';
  label: string;
};

interface McpManagerPageProps {
  message: SerializedMcpStatusMessage;
  onClose: () => void;
  embedded?: EmbeddedManagerPage;
}

function configOriginValue(
  server: DaemonWorkspaceMcpServerStatus,
): DaemonWorkspaceMcpServerStatus['configOrigin'] {
  if (server.configOrigin) return server.configOrigin;
  if (server.extensionName || server.source === 'extension') return 'extension';
  const legacySource = (server as { source?: string }).source;
  if (legacySource === 'project' && server.removable === false) {
    return 'project_mcp_json';
  }
  if (legacySource === 'workspace' || legacySource === 'project') {
    return 'workspace_settings';
  }
  return server.removable ? 'user_settings' : undefined;
}

function sourceValue(server: DaemonWorkspaceMcpServerStatus): SourceFilter {
  const origin = configOriginValue(server);
  if (origin === 'workspace_settings') return 'workspace';
  if (origin === 'extension') return 'extension';
  return 'user';
}

function isManagedServerVisible(
  server: DaemonWorkspaceMcpServerStatus,
): boolean {
  const origin = configOriginValue(server);
  return (
    origin === 'extension' ||
    origin === 'workspace_settings' ||
    origin === 'user_settings'
  );
}

function sourceLabel(server: DaemonWorkspaceMcpServerStatus, t: T): string {
  const source = sourceValue(server);
  return source === 'workspace'
    ? t('mcp.source.workspace')
    : source === 'extension'
      ? t('mcp.source.extension')
      : t('mcp.source.user');
}

function mcpServersForScope(
  settings: Awaited<ReturnType<DaemonWorkspaceActions['loadSettingsStatus']>>,
  scope: McpSettingsScope,
): Record<string, unknown> {
  const value = settings.settings.find(
    (setting) => setting.key === 'mcpServers',
  )?.values[scope];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function statusLabel(server: DaemonWorkspaceMcpServerStatus, t: T): string {
  if (server.disabled) return t('mcp.status.disabled');
  if (server.approvalState === 'pending') {
    return t('mcp.status.needsApproval');
  }
  if (server.approvalState === 'rejected') {
    return t('mcp.status.rejected');
  }
  if (server.authenticationState === 'pending') {
    return t('mcp.status.authenticating');
  }
  if (server.mcpStatus === 'connected') return t('mcp.status.connected');
  if (server.mcpStatus === 'connecting') return t('mcp.status.connecting');
  return t('mcp.status.disconnectedTitle');
}

function statusBadgeClass(server: DaemonWorkspaceMcpServerStatus): string {
  return !server.disabled &&
    !server.approvalState &&
    server.mcpStatus === 'connected'
    ? styles.connectedBadge
    : '';
}

function formatServerCommand(
  server: DaemonWorkspaceMcpServerStatus,
  t: T,
): string {
  const config = server.config;
  if (config?.httpUrl) return `${config.httpUrl} (http)`;
  if (config?.url) return `${config.url} (sse)`;
  if (config?.command) {
    return `${config.command} ${config.args?.join(' ') ?? ''} (stdio)`.trim();
  }
  return server.transport ? `(${server.transport})` : t('mcp.status.unknown');
}

function serverActions(
  server: DaemonWorkspaceMcpServerStatus,
  t: T,
): McpServerAction[] {
  const actions: McpServerAction[] = [];
  const awaitingApproval = Boolean(server.approvalState);
  const origin = configOriginValue(server);
  if (origin === 'user_settings' || origin === 'workspace_settings') {
    actions.push({ id: 'edit', label: t('mcp.action.edit') });
  }
  if (
    !server.disabled &&
    !awaitingApproval &&
    !server.requiresAuth &&
    server.mcpStatus === 'disconnected'
  ) {
    actions.push({ id: 'reconnect', label: t('mcp.action.reconnect') });
  }
  if (!server.disabled && awaitingApproval) {
    actions.push({ id: 'approve', label: t('mcp.action.approve') });
  }
  if (origin !== 'extension' || server.disabled) {
    actions.push({
      id: server.disabled ? 'enable' : 'disable',
      label: server.disabled ? t('mcp.action.enable') : t('mcp.action.disable'),
    });
  }
  if (
    !server.disabled &&
    !awaitingApproval &&
    (server.mcpStatus !== 'disconnected' || server.requiresAuth)
  ) {
    actions.push({
      id: 'authenticate',
      label: server.hasOAuthTokens
        ? t('mcp.action.reauth')
        : t('mcp.action.auth'),
    });
    if (server.hasOAuthTokens) {
      actions.push({ id: 'clear-auth', label: t('mcp.action.clearAuth') });
    }
  }
  if ((server as { removable?: boolean }).removable) {
    actions.push({ id: 'remove', label: t('mcp.action.remove') });
  }
  return actions;
}

function oauthMessage(serverName: string, t: T, detail?: string): string {
  return [
    `${t('mcp.oauth.server')}: ${serverName}`,
    t('mcp.oauth.starting', { name: serverName }),
    detail,
  ]
    .filter(Boolean)
    .join('\n');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function toolAnnotationText(tool: DaemonWorkspaceMcpToolStatus, t: T): string {
  const annotations = tool.annotations ?? {};
  const labels: string[] = [];
  if (annotations['destructiveHint']) {
    labels.push(t('mcp.annotation.destructive'));
  }
  if (annotations['readOnlyHint']) labels.push(t('mcp.annotation.readOnly'));
  if (annotations['openWorldHint']) labels.push(t('mcp.annotation.openWorld'));
  if (annotations['idempotentHint']) {
    labels.push(t('mcp.annotation.idempotent'));
  }
  return labels.join(', ');
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="break-words text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

function ToolDetail({ tool, t }: { tool: DaemonWorkspaceMcpToolStatus; t: T }) {
  const annotations = toolAnnotationText(tool, t);
  const schema = tool.schema as
    | { parametersJsonSchema?: unknown; parameters?: unknown }
    | undefined;
  const schemaContent =
    schema?.parametersJsonSchema ?? schema?.parameters ?? schema;

  return (
    <div className="flex flex-col gap-5">
      {!tool.isValid ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t('mcp.invalidToolWarning')}</AlertTitle>
          <AlertDescription>
            {tool.invalidReason || t('mcp.status.unknown')}
            <span className="mt-1 block">{t('mcp.invalidToolHelp')}</span>
          </AlertDescription>
        </Alert>
      ) : null}
      <DetailField
        label={t('mcp.description')}
        value={tool.description?.trim() || t('mcp.noDescription')}
      />
      {annotations ? (
        <DetailField label={t('mcp.annotations')} value={annotations} />
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">{t('mcp.inputSchema')}</div>
        {schemaContent ? (
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
            {JSON.stringify(schemaContent, null, 2)}
          </pre>
        ) : (
          <div className="text-sm text-muted-foreground">
            {t('mcp.noSchema')}
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceDetail({
  resource,
  t,
}: {
  resource: DaemonWorkspaceMcpResourceStatus;
  t: T;
}) {
  const friendlyName = resource.title || resource.name || '';
  return (
    <div className="flex flex-col gap-5">
      <DetailField label={t('mcp.resource.uriLabel')} value={resource.uri} />
      {friendlyName && friendlyName !== resource.uri ? (
        <DetailField label={t('mcp.resource.nameLabel')} value={friendlyName} />
      ) : null}
      {resource.mimeType ? (
        <DetailField
          label={t('mcp.resource.mimeTypeLabel')}
          value={resource.mimeType}
        />
      ) : null}
      {typeof resource.size === 'number' ? (
        <DetailField
          label={t('mcp.resource.sizeLabel')}
          value={t('mcp.resource.bytes', { count: resource.size })}
        />
      ) : null}
      {resource.description ? (
        <DetailField
          label={t('mcp.description')}
          value={resource.description.trim()}
        />
      ) : null}
    </div>
  );
}

export function McpManagerPage({
  message,
  onClose,
  embedded,
}: McpManagerPageProps) {
  const { t } = useI18n();
  const mcp = useMcp({ autoLoad: false });
  const settings = useSettings({ autoLoad: false });
  const [status, setStatus] = useState<McpStatus>(message.status);
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, DaemonWorkspaceMcpToolsStatus>
  >(message.toolsByServer);
  const [resourcesByServer, setResourcesByServer] = useState<
    Record<string, DaemonWorkspaceMcpResourcesStatus>
  >(message.resourcesByServer ?? {});
  const [selectedServerName, setSelectedServerName] = useState<string | null>(
    null,
  );
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);
  const [selectedResourceUri, setSelectedResourceUri] = useState<string | null>(
    null,
  );
  const [selectedServerTab, setSelectedServerTab] = useState('overview');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingServer, setEditingServer] =
    useState<DaemonWorkspaceMcpServerStatus | null>(null);
  const [serverName, setServerName] = useState('');
  const [serverDescription, setServerDescription] = useState('');
  const [serverScope, setServerScope] = useState<McpSettingsScope>('workspace');
  const [serverConfig, setServerConfig] = useState(DEFAULT_MCP_SERVER_CONFIG);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [serverToRemove, setServerToRemove] =
    useState<DaemonWorkspaceMcpServerStatus | null>(null);
  const [notice, setNotice] = useState<{
    serverName?: string;
    text: string;
    error?: boolean;
    authUrl?: string;
  } | null>(null);
  const [loadErrorsByServer, setLoadErrorsByServer] = useState<
    Record<string, { tools?: string; resources?: string }>
  >({});
  const hasInitializedDiscovery = useRef(
    message.status.discoveryState === 'completed',
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const waitForPoll = useCallback(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    return mountedRef.current;
  }, []);

  const startDiscovery = useCallback(
    async (
      operation: 'initialize' | 'reload',
      showProgress = true,
      deferStatus = false,
    ): Promise<boolean> => {
      await (operation === 'initialize'
        ? mcp.initialize()
        : mcp.reloadConfig());
      if (!mountedRef.current) return false;

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!(await waitForPoll())) return false;
        const nextStatus = await mcp.reload();
        if (!mountedRef.current) return false;
        if (!nextStatus) continue;
        if (!deferStatus || nextStatus.discoveryState === 'completed') {
          setStatus((current) =>
            showProgress &&
            nextStatus.servers.length === 0 &&
            current.servers.length > 0
              ? { ...nextStatus, servers: current.servers }
              : nextStatus,
          );
        }
        if (nextStatus.errors?.length) {
          if (showProgress) {
            setNotice({
              text: nextStatus.errors
                .map((error) => error.error || error.hint || error.kind)
                .join('\n'),
              error: true,
            });
          }
          return false;
        }
        if (nextStatus.discoveryState === 'completed') {
          if (showProgress) setNotice(null);
          return true;
        }
        if (
          nextStatus.initialized &&
          nextStatus.discoveryState === 'not_started' &&
          nextStatus.servers.length === 0
        ) {
          if (deferStatus) setStatus(nextStatus);
          if (showProgress) setNotice({ text: t('mcp.discovery.empty') });
          return true;
        }
      }
      if (showProgress) {
        setNotice({ text: t('mcp.discovery.timeout'), error: true });
      }
      return false;
    },
    [mcp, t, waitForPoll],
  );

  useEffect(() => {
    if (hasInitializedDiscovery.current) return;
    hasInitializedDiscovery.current = true;
    setInitializing(true);
    void startDiscovery('initialize')
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setNotice({ text: extractErrorDetail(error), error: true });
        }
      })
      .finally(() => {
        if (mountedRef.current) setInitializing(false);
      });
  }, [startDiscovery]);

  const servers = useMemo(
    () => (status.servers ?? []).filter(isManagedServerVisible),
    [status.servers],
  );
  const selectedServer =
    servers.find((server) => server.name === selectedServerName) ?? null;
  const selectedTools = selectedServer
    ? (toolsByServer[selectedServer.name]?.tools ?? [])
    : [];
  const selectedResources = selectedServer
    ? (resourcesByServer[selectedServer.name]?.resources ?? [])
    : [];
  const selectedTool =
    selectedTools.find((tool) => tool.name === selectedToolName) ?? null;
  const selectedResource =
    selectedResources.find(
      (resource) => resource.uri === selectedResourceUri,
    ) ?? null;

  useEffect(() => {
    embedded?.onDetailChange(Boolean(selectedServer));
  }, [embedded, selectedServer]);

  const filteredServers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return servers.filter((server) => {
      const matchesSource =
        sourceFilter === 'all' || sourceValue(server) === sourceFilter;
      const matchesQuery =
        !normalized ||
        server.name.toLowerCase().includes(normalized) ||
        server.description?.toLowerCase().includes(normalized) ||
        server.extensionName?.toLowerCase().includes(normalized);
      return matchesSource && Boolean(matchesQuery);
    });
  }, [query, servers, sourceFilter]);

  const loadServerData = useCallback(
    async (server: DaemonWorkspaceMcpServerStatus) => {
      const failures: unknown[] = [];
      const [toolsResult, resourcesResult] = await Promise.allSettled([
        mcp.loadTools(server.name),
        server.resourceCount
          ? mcp.loadResources(server.name)
          : Promise.resolve(null),
      ]);
      if (toolsResult.status === 'fulfilled') {
        setToolsByServer((current) => ({
          ...current,
          [server.name]: toolsResult.value,
        }));
        setLoadErrorsByServer((current) => ({
          ...current,
          [server.name]: { ...current[server.name], tools: undefined },
        }));
      } else {
        failures.push(toolsResult.reason);
        const error = extractErrorDetail(toolsResult.reason);
        setLoadErrorsByServer((current) => ({
          ...current,
          [server.name]: { ...current[server.name], tools: error },
        }));
      }
      if (
        resourcesResult.status === 'fulfilled' &&
        resourcesResult.value !== null
      ) {
        const resources = resourcesResult.value;
        setResourcesByServer((current) => ({
          ...current,
          [server.name]: resources,
        }));
        setLoadErrorsByServer((current) => ({
          ...current,
          [server.name]: { ...current[server.name], resources: undefined },
        }));
      } else if (resourcesResult.status === 'rejected') {
        failures.push(resourcesResult.reason);
        const error = extractErrorDetail(resourcesResult.reason);
        setLoadErrorsByServer((current) => ({
          ...current,
          [server.name]: { ...current[server.name], resources: error },
        }));
      } else {
        setResourcesByServer((current) => {
          if (!(server.name in current)) return current;
          const next = { ...current };
          delete next[server.name];
          return next;
        });
        setLoadErrorsByServer((current) => ({
          ...current,
          [server.name]: { ...current[server.name], resources: undefined },
        }));
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${server.name}: ${failures.map(extractErrorDetail).join('; ')}`,
        );
      }
    },
    [mcp],
  );

  const refreshAll = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setNotice(null);
    try {
      const nextStatus = await mcp.reload();
      if (!nextStatus) return;
      setStatus(nextStatus);
    } catch (error) {
      setNotice({ text: extractErrorDetail(error), error: true });
    } finally {
      setRefreshing(false);
    }
  }, [mcp, refreshing]);

  const addServer = useCallback(async () => {
    const name = serverName.trim();
    const editing = editingServer !== null;
    if (!name) {
      setAddError(t('mcp.add.nameRequired'));
      return;
    }
    let config: Parameters<typeof mcp.addServer>[0]['config'];
    try {
      const parsed: unknown = JSON.parse(serverConfig);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(t('mcp.add.configInvalid'));
      }
      const description = serverDescription.trim();
      config = {
        ...(parsed as Parameters<typeof mcp.addServer>[0]['config']),
        ...(description ? { description } : {}),
      };
    } catch (error) {
      setAddError(extractErrorDetail(error));
      return;
    }
    setAddError(null);
    setAdding(true);
    let persisted = false;
    try {
      await settings.setValue(serverScope, 'mcpServers', config, {
        mcpServerMutation: { operation: 'set', name },
      });
      persisted = true;
      setNotice(null);
      const runtimeUpdated = await startDiscovery('reload', false).catch(
        () => false,
      );
      setNotice({
        ...(editing ? { serverName: name } : {}),
        text: runtimeUpdated
          ? t(editing ? 'mcp.edit.done' : 'mcp.add.done', { name })
          : t('mcp.runtime.notUpdated'),
        error: !runtimeUpdated,
      });
      setAddDialogOpen(false);
      setEditingServer(null);
      setServerName('');
      setServerDescription('');
      setServerConfig(DEFAULT_MCP_SERVER_CONFIG);
    } catch (error) {
      if (persisted) {
        setNotice({
          ...(editing ? { serverName: name } : {}),
          text: t('mcp.runtime.notUpdated'),
          error: true,
        });
        setAddDialogOpen(false);
        setEditingServer(null);
        setServerName('');
        setServerDescription('');
        setServerConfig(DEFAULT_MCP_SERVER_CONFIG);
      } else {
        setAddError(extractErrorDetail(error));
      }
    } finally {
      setAdding(false);
    }
  }, [
    mcp,
    editingServer,
    serverConfig,
    serverDescription,
    serverName,
    serverScope,
    settings,
    startDiscovery,
    t,
  ]);

  const removeServer = useCallback(async () => {
    if (!serverToRemove) return;
    setBusyServer(serverToRemove.name);
    let persisted = false;
    try {
      const currentSettings = await settings.reload();
      if (!currentSettings) {
        setNotice({
          serverName: serverToRemove.name,
          text: t('mcp.add.settingsUnavailable'),
          error: true,
        });
        return;
      }
      const scope: McpSettingsScope =
        sourceValue(serverToRemove) === 'workspace' ? 'workspace' : 'user';
      const servers = mcpServersForScope(currentSettings, scope);
      if (!(serverToRemove.name in servers)) {
        setNotice({
          serverName: serverToRemove.name,
          text: t('mcp.remove.notWorkspace'),
          error: true,
        });
        return;
      }
      await settings.setValue(
        scope,
        'mcpServers',
        {},
        {
          mcpServerMutation: {
            operation: 'remove',
            name: serverToRemove.name,
          },
        },
      );
      persisted = true;
      setServerToRemove(null);
      setNotice({
        serverName: serverToRemove.name,
        text: t('mcp.action.running', { action: t('mcp.action.remove') }),
      });
      const runtimeUpdated = await startDiscovery('reload', false, true).catch(
        () => false,
      );
      if (runtimeUpdated) {
        setSelectedServerName(null);
        setSelectedToolName(null);
        setSelectedResourceUri(null);
        setNotice(null);
      } else {
        setNotice({
          serverName: serverToRemove.name,
          text: t('mcp.runtime.removeNotUpdated'),
          error: true,
        });
      }
    } catch (error) {
      setNotice({
        serverName: serverToRemove.name,
        text: persisted
          ? t('mcp.runtime.removeNotUpdated')
          : t('mcp.action.failed', { error: extractErrorDetail(error) }),
        error: true,
      });
    } finally {
      setBusyServer(null);
    }
  }, [serverToRemove, settings, startDiscovery, t]);

  const openEditServer = useCallback(
    async (server: DaemonWorkspaceMcpServerStatus) => {
      if (busyServer) return;
      const origin = configOriginValue(server);
      if (origin !== 'user_settings' && origin !== 'workspace_settings') {
        return;
      }
      const scope: McpSettingsScope =
        origin === 'workspace_settings' ? 'workspace' : 'user';
      setBusyServer(server.name);
      setNotice(null);
      try {
        const currentSettings = await settings.reload();
        if (!currentSettings) {
          throw new Error(t('mcp.add.settingsUnavailable'));
        }
        const storedConfig = mcpServersForScope(currentSettings, scope)[
          server.name
        ];
        if (
          !storedConfig ||
          typeof storedConfig !== 'object' ||
          Array.isArray(storedConfig)
        ) {
          throw new Error(t('mcp.edit.notFound'));
        }
        const editableConfig = {
          ...(storedConfig as Record<string, unknown>),
        };
        const description = editableConfig['description'];
        delete editableConfig['description'];
        setEditingServer(server);
        setServerName(server.name);
        setServerScope(scope);
        setServerDescription(
          typeof description === 'string' ? description : '',
        );
        setServerConfig(JSON.stringify(editableConfig, null, 2));
        setAddError(null);
        setAddDialogOpen(true);
      } catch (error) {
        setNotice({
          serverName: server.name,
          text: t('mcp.action.failed', { error: extractErrorDetail(error) }),
          error: true,
        });
      } finally {
        setBusyServer(null);
      }
    },
    [busyServer, settings, t],
  );

  const runAction = useCallback(
    async (server: DaemonWorkspaceMcpServerStatus, action: McpServerAction) => {
      if (busyServer) return;
      if (action.id === 'remove') {
        setServerToRemove(server);
        return;
      }
      if (action.id === 'edit') {
        await openEditServer(server);
        return;
      }
      setBusyServer(server.name);
      setNotice({
        serverName: server.name,
        text:
          action.id === 'authenticate'
            ? oauthMessage(server.name, t)
            : t('mcp.action.running', { action: action.label }),
      });
      try {
        let detail = '';
        let authUrl: string | undefined;
        let pendingAuthentication = false;
        if (action.id === 'reconnect') {
          const result = await mcp.restartServer(server.name);
          if (!mountedRef.current) return;
          if ('restarted' in result && !result.restarted) {
            if (result.reason === 'authentication_required') {
              throw new Error(t('mcp.reconnect.authenticationRequired'));
            }
            throw new Error(
              t('mcp.reconnect.skipped', { reason: result.reason }),
            );
          }
          if (
            'entries' in result &&
            (result.entries.length === 0 ||
              result.entries.every((entry) => !entry.restarted))
          ) {
            throw new Error(
              t('mcp.reconnect.skipped', {
                reason:
                  result.entries
                    .map((entry) => entry.reason)
                    .filter(Boolean)
                    .join(', ') || 'not connected',
              }),
            );
          }
        } else {
          const result = await mcp.manageServer(server.name, action.id);
          if (!mountedRef.current) return;
          authUrl = result.authUrl;
          detail = [...(result.messages ?? [])].join('\n');
          pendingAuthentication =
            action.id === 'authenticate' && result.pending === true;
          if (pendingAuthentication) {
            setNotice({
              serverName: server.name,
              text: oauthMessage(server.name, t, detail),
              ...(authUrl ? { authUrl } : {}),
            });
          }
        }
        let nextStatus: McpStatus | undefined;
        if (pendingAuthentication) {
          for (let attempt = 0; attempt < 400; attempt += 1) {
            if (!(await waitForPoll())) return;
            const candidate = await mcp.reload();
            if (!mountedRef.current) return;
            if (!candidate) continue;
            setStatus(candidate);
            const statusError = candidate.errors?.[0];
            if (statusError) {
              throw new Error(
                statusError.error ||
                  statusError.hint ||
                  t('mcp.oauth.statusFailed'),
              );
            }
            const candidateServer = candidate.servers?.find(
              (item) => item.name === server.name,
            );
            if (!candidateServer) {
              throw new Error(t('mcp.oauth.serverRemoved'));
            }
            if (candidateServer.authenticationState === 'failed') {
              throw new Error(
                candidateServer.authenticationError ||
                  t('mcp.oauth.authenticationFailed'),
              );
            }
            if (
              candidateServer.authenticationState === 'succeeded' ||
              (candidateServer.authenticationState === undefined &&
                candidateServer.mcpStatus === 'connected')
            ) {
              nextStatus = candidate;
              break;
            }
          }
          if (!nextStatus) throw new Error(t('mcp.oauth.timeout'));
        } else {
          nextStatus = await mcp.reload();
          if (!mountedRef.current) return;
          for (
            let attempt = 0;
            nextStatus?.discoveryState !== undefined &&
            nextStatus.discoveryState !== 'completed' &&
            !nextStatus.errors?.length &&
            attempt < 40;
            attempt += 1
          ) {
            if (!(await waitForPoll())) return;
            const candidate = await mcp.reload();
            if (!mountedRef.current) return;
            if (!candidate) continue;
            nextStatus = candidate;
            setStatus(candidate);
          }
        }
        if (nextStatus) {
          setStatus(nextStatus);
          const nextServer = nextStatus.servers?.find(
            (candidate) => candidate.name === server.name,
          );
          if (
            nextServer &&
            (nextStatus.discoveryState === undefined ||
              nextStatus.discoveryState === 'completed')
          ) {
            try {
              await loadServerData(nextServer);
            } catch {
              // Tool and resource refresh errors are recorded by loadServerData.
            }
            if (!mountedRef.current) return;
          }
        }
        setNotice({
          serverName: server.name,
          text: pendingAuthentication
            ? t('mcp.action.done', { action: action.label })
            : action.id === 'authenticate' && detail
              ? oauthMessage(server.name, t, detail)
              : detail || t('mcp.action.done', { action: action.label }),
          ...(!pendingAuthentication && authUrl ? { authUrl } : {}),
        });
      } catch (error) {
        if (mountedRef.current) {
          setNotice({
            serverName: server.name,
            text: t('mcp.action.failed', {
              error: extractErrorDetail(error),
            }),
            error: true,
          });
        }
      } finally {
        if (mountedRef.current) setBusyServer(null);
      }
    },
    [busyServer, loadServerData, mcp, openEditServer, t, waitForPoll],
  );

  const openServer = (server: DaemonWorkspaceMcpServerStatus) => {
    setSelectedServerName(server.name);
    setSelectedServerTab('overview');
    setSelectedToolName(null);
    setSelectedResourceUri(null);
    setNotice(null);
    if (server.approvalState) return;
    void loadServerData(server).catch((error: unknown) => {
      setNotice({
        serverName: server.name,
        text: t('mcp.action.failed', { error: extractErrorDetail(error) }),
        error: true,
      });
    });
  };

  const showServerList = () => {
    if (busyServer !== null) return;
    setSelectedServerName(null);
    setSelectedToolName(null);
    setSelectedResourceUri(null);
    setRefreshing(true);
    void mcp
      .reload()
      .then((nextStatus) => {
        if (nextStatus) setStatus(nextStatus);
      })
      .catch((error: unknown) => {
        setNotice({ text: extractErrorDetail(error), error: true });
      })
      .finally(() => setRefreshing(false));
  };

  const showSelectedServer = () => {
    setSelectedToolName(null);
    setSelectedResourceUri(null);
  };

  const standaloneNavigation = (
    <Breadcrumb className="sticky -top-4 z-10 -mx-5 -mt-4 border-b bg-background px-5 py-3">
      <BreadcrumbList className="text-base">
        <BreadcrumbItem>
          <Button
            variant="ghost"
            size="icon"
            disabled={busyServer !== null}
            onClick={onClose}
            aria-label={t('common.back')}
          >
            <ArrowLeftIcon />
          </Button>
        </BreadcrumbItem>
        <BreadcrumbItem>
          {selectedServer ? (
            <BreadcrumbLink asChild>
              <button
                type="button"
                disabled={busyServer !== null}
                onClick={showServerList}
              >
                {t('mcp.title')}
              </button>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{t('mcp.title')}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {selectedServer ? <BreadcrumbSeparator /> : null}
        {selectedServer ? (
          <BreadcrumbItem>
            {selectedTool || selectedResource ? (
              <BreadcrumbLink asChild>
                <button type="button" onClick={showSelectedServer}>
                  {selectedServer.name}
                </button>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{selectedServer.name}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
        ) : null}
        {selectedTool || selectedResource ? <BreadcrumbSeparator /> : null}
        {selectedTool ? (
          <BreadcrumbItem>
            <BreadcrumbPage>{selectedTool.name}</BreadcrumbPage>
          </BreadcrumbItem>
        ) : null}
        {selectedResource ? (
          <BreadcrumbItem>
            <BreadcrumbPage>
              {selectedResource.title ||
                selectedResource.name ||
                selectedResource.uri}
            </BreadcrumbPage>
          </BreadcrumbItem>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
  const detailLabel = selectedTool
    ? selectedTool.name
    : selectedResource
      ? selectedResource.title || selectedResource.name || selectedResource.uri
      : selectedServer?.name;
  const navigation = embedded ? (
    selectedServer ? (
      <Breadcrumb className="sticky -top-4 z-10 -mx-5 -mt-4 border-b bg-background px-5 py-3">
        <BreadcrumbList className="h-8 text-sm">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button
                type="button"
                disabled={busyServer !== null}
                onClick={showServerList}
              >
                {t('mcp.title')}
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {selectedTool || selectedResource ? (
              <BreadcrumbLink asChild>
                <button type="button" onClick={showSelectedServer}>
                  {selectedServer.name}
                </button>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{selectedServer.name}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {selectedTool || selectedResource ? <BreadcrumbSeparator /> : null}
          {selectedTool || selectedResource ? (
            <BreadcrumbItem>
              <BreadcrumbPage>{detailLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
    ) : null
  ) : (
    standaloneNavigation
  );
  const removeDialog = (
    <Dialog
      open={serverToRemove !== null}
      onOpenChange={(open) => !open && setServerToRemove(null)}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('mcp.remove.title')}</DialogTitle>
          <DialogDescription>
            {t(
              serverToRemove && sourceValue(serverToRemove) === 'workspace'
                ? 'mcp.remove.description'
                : 'mcp.remove.description.global',
              {
                name: serverToRemove?.name ?? '',
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setServerToRemove(null)}
            disabled={busyServer !== null}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void removeServer()}
            disabled={busyServer !== null}
          >
            {busyServer ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Trash2Icon data-icon="inline-start" />
            )}
            {t('mcp.action.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  const editorDialog = (
    <Dialog
      open={addDialogOpen}
      onOpenChange={(open) => {
        if (!adding) {
          setAddDialogOpen(open);
          if (!open) setEditingServer(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(editingServer ? 'mcp.edit.title' : 'mcp.add.title')}
          </DialogTitle>
          <DialogDescription>
            {t(editingServer ? 'mcp.edit.description' : 'mcp.add.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {addError ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{addError}</AlertDescription>
            </Alert>
          ) : null}
          <label className="grid gap-2 text-sm font-medium">
            {t('mcp.add.name')}
            <Input
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
              placeholder="my-mcp-server"
              disabled={adding || editingServer !== null}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            {t('mcp.add.serverDescription')}
            <Input
              value={serverDescription}
              onChange={(event) => setServerDescription(event.target.value)}
              placeholder={t('mcp.add.serverDescriptionPlaceholder')}
              disabled={adding}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            {t('mcp.add.scope')}
            <Select
              value={serverScope}
              onValueChange={(value) =>
                setServerScope(value as McpSettingsScope)
              }
              disabled={adding || editingServer !== null}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">
                  {t('settings.scope.workspace')}
                </SelectItem>
                <SelectItem value="user">
                  {t('mcp.add.scope.global')}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-2 text-sm font-medium">
            {t('mcp.add.config')}
            <Textarea
              className="min-h-44 font-mono text-xs"
              value={serverConfig}
              onChange={(event) => setServerConfig(event.target.value)}
              disabled={adding}
            />
          </label>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setAddDialogOpen(false);
              setEditingServer(null);
            }}
            disabled={adding}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void addServer()} disabled={adding}>
            {adding ? <Spinner data-icon="inline-start" /> : null}
            {adding
              ? t(editingServer ? 'mcp.edit.saving' : 'mcp.add.adding')
              : t(editingServer ? 'mcp.edit.save' : 'mcp.add.button')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (selectedTool && selectedServer) {
    return (
      <>
        <div className="flex w-full flex-col gap-6 pb-8">
          {navigation}
          <div className="flex w-full flex-col gap-6">
            <div className="flex items-center gap-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted">
                <WrenchIcon />
              </div>
              <div className="min-w-0">
                <h1 className="break-words text-2xl font-semibold">
                  {selectedTool.name}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {selectedTool.serverToolName || selectedServer.name}
                </p>
              </div>
            </div>
            <Card>
              <CardContent>
                <ToolDetail tool={selectedTool} t={t} />
              </CardContent>
            </Card>
          </div>
        </div>
        {editorDialog}
      </>
    );
  }

  if (selectedResource && selectedServer) {
    return (
      <>
        <div className="flex w-full flex-col gap-6 pb-8">
          {navigation}
          <div className="flex w-full flex-col gap-6">
            <div className="flex items-center gap-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted">
                <DatabaseIcon />
              </div>
              <h1 className="min-w-0 break-words text-2xl font-semibold">
                {selectedResource.title ||
                  selectedResource.name ||
                  selectedResource.uri}
              </h1>
            </div>
            <Card>
              <CardContent>
                <ResourceDetail resource={selectedResource} t={t} />
              </CardContent>
            </Card>
          </div>
        </div>
        {editorDialog}
      </>
    );
  }

  if (selectedServer) {
    const tools = selectedTools;
    const resources = selectedResources;
    const loadErrors = loadErrorsByServer[selectedServer.name];
    const actions = serverActions(selectedServer, t);
    return (
      <>
        <div className="flex w-full flex-col gap-6 pb-8">
          {navigation}
          <div className="flex w-full flex-col gap-6">
            <div className="flex items-center gap-4">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
                <ServerIcon />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="break-words text-2xl font-semibold">
                    {selectedServer.name}
                  </h1>
                  <Badge
                    variant="secondary"
                    className={statusBadgeClass(selectedServer)}
                  >
                    {statusLabel(selectedServer, t)}
                  </Badge>
                  <Badge variant="outline">
                    {sourceLabel(selectedServer, t)}
                  </Badge>
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busyServer !== null}
                    aria-label={t('mcp.actions')}
                    data-testid="mcp-server-actions"
                  >
                    {busyServer === selectedServer.name ? (
                      <Spinner />
                    ) : (
                      <EllipsisVerticalIcon />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenuGroup>
                    {actions.map((action) => (
                      <DropdownMenuItem
                        key={action.id}
                        data-testid={`mcp-server-action-${action.id}`}
                        variant={
                          action.id === 'remove' ? 'destructive' : 'default'
                        }
                        disabled={busyServer !== null}
                        onSelect={() => void runAction(selectedServer, action)}
                      >
                        {action.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {notice?.serverName === selectedServer.name ? (
              <Alert variant={notice.error ? 'destructive' : 'default'}>
                {notice.error ? <AlertCircleIcon /> : <InfoIcon />}
                <AlertDescription className="whitespace-pre-wrap break-words">
                  <p>{notice.text}</p>
                  {notice.authUrl && isHttpUrl(notice.authUrl) ? (
                    <a
                      className="mt-2 inline-block underline underline-offset-3"
                      href={notice.authUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('mcp.oauth.open')}
                    </a>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <Tabs
              value={selectedServerTab}
              onValueChange={setSelectedServerTab}
            >
              <TabsList>
                <TabsTrigger value="overview">{t('mcp.basicInfo')}</TabsTrigger>
                <TabsTrigger value="tools">
                  {t('mcp.tools')} {tools.length}
                </TabsTrigger>
                <TabsTrigger value="resources">
                  {t('mcp.resources')}{' '}
                  {selectedServer.resourceCount ?? resources.length}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="pt-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">
                      {t('mcp.descriptionTitle')}
                    </CardTitle>
                    <CardDescription>
                      {selectedServer.description?.trim() || '-'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-6 sm:grid-cols-2">
                    <DetailField
                      label={t('mcp.source')}
                      value={sourceLabel(selectedServer, t)}
                    />
                    <DetailField
                      label={t('mcp.transport')}
                      value={selectedServer.transport}
                    />
                    <DetailField
                      label={t('mcp.command')}
                      value={formatServerCommand(selectedServer, t)}
                    />
                    <DetailField
                      label={t('mcp.workingDirectory')}
                      value={selectedServer.config?.cwd || status.workspaceCwd}
                    />
                    {selectedServer.error ? (
                      <DetailField
                        label={t('mcp.invalidReasonLabel')}
                        value={selectedServer.error}
                      />
                    ) : null}
                    {selectedServer.hint ? (
                      <DetailField
                        label={t('mcp.description')}
                        value={selectedServer.hint}
                      />
                    ) : null}
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="tools" className="pt-4">
                {loadErrors?.tools ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>{t('mcp.loadingTools')}</AlertTitle>
                    <AlertDescription>{loadErrors.tools}</AlertDescription>
                  </Alert>
                ) : tools.length ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {tools.map((tool) => (
                      <Card
                        key={tool.name}
                        size="sm"
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer transition-colors hover:bg-accent/50"
                        onClick={() => setSelectedToolName(tool.name)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedToolName(tool.name);
                          }
                        }}
                      >
                        <CardHeader>
                          <CardTitle className="break-words">
                            {tool.name}
                          </CardTitle>
                          <CardDescription className="line-clamp-2 text-xs">
                            {tool.description || t('mcp.noDescription')}
                          </CardDescription>
                          {!tool.isValid ? (
                            <CardAction>
                              <Badge variant="destructive">
                                {t('mcp.status.blocked')}
                              </Badge>
                            </CardAction>
                          ) : null}
                        </CardHeader>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Empty className="rounded-xl border border-dashed">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <WrenchIcon />
                      </EmptyMedia>
                      <EmptyTitle>{t('mcp.emptyTools')}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
              </TabsContent>
              <TabsContent value="resources" className="pt-4">
                {loadErrors?.resources ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>{t('mcp.resourcesUnavailable')}</AlertTitle>
                    <AlertDescription>{loadErrors.resources}</AlertDescription>
                  </Alert>
                ) : resources.length ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {resources.map((resource) => (
                      <Card
                        key={resource.uri}
                        size="sm"
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer transition-colors hover:bg-accent/50"
                        onClick={() => setSelectedResourceUri(resource.uri)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedResourceUri(resource.uri);
                          }
                        }}
                      >
                        <CardHeader>
                          <CardTitle className="break-words">
                            {resource.title || resource.name || resource.uri}
                          </CardTitle>
                          <CardDescription className="break-all">
                            {resource.uri}
                          </CardDescription>
                        </CardHeader>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Empty className="rounded-xl border border-dashed">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <DatabaseIcon />
                      </EmptyMedia>
                      <EmptyTitle>{t('mcp.noResources')}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </div>
        {removeDialog}
        {editorDialog}
      </>
    );
  }

  const connectingCount = servers.filter(
    (server) => !server.disabled && server.mcpStatus === 'connecting',
  ).length;
  const sourceOptions: Array<{ value: SourceFilter; label: string }> = [
    { value: 'all', label: t('mcp.source.all') },
    { value: 'user', label: t('mcp.source.user') },
    { value: 'workspace', label: t('mcp.source.workspace') },
    { value: 'extension', label: t('mcp.source.extension') },
  ];

  return (
    <div className="flex w-full flex-col gap-6 pb-8">
      {navigation}
      <div className="flex w-full flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-balance">
              {t('mcp.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              {t('mcp.servers', { count: servers.length })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void refreshAll()}
              disabled={refreshing}
            >
              {refreshing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              {t('common.refresh')}
            </Button>
            <Button
              onClick={() => {
                setEditingServer(null);
                setServerName('');
                setServerDescription('');
                setServerScope('workspace');
                setServerConfig(DEFAULT_MCP_SERVER_CONFIG);
                setAddError(null);
                setAddDialogOpen(true);
              }}
              disabled={adding}
            >
              <PlusIcon data-icon="inline-start" />
              {t('mcp.add.button')}
            </Button>
          </div>
        </div>

        {initializing && connectingCount === 0 ? (
          <Alert>
            <RefreshCwIcon className="animate-spin" />
            <AlertTitle>{t('mcp.discovery.initializing')}</AlertTitle>
            <AlertDescription>{t('mcp.startingNote')}</AlertDescription>
          </Alert>
        ) : connectingCount > 0 ? (
          <Alert>
            <RefreshCwIcon />
            <AlertTitle>
              {t('mcp.starting', { count: connectingCount })}
            </AlertTitle>
            <AlertDescription>{t('mcp.startingNote')}</AlertDescription>
          </Alert>
        ) : null}
        {notice && !notice.serverName ? (
          <Alert variant={notice.error ? 'destructive' : 'default'}>
            <AlertCircleIcon />
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        ) : null}
        {(status.errors ?? []).map((error, index) => (
          <Alert key={`${error.kind}-${index}`} variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>{error.kind}</AlertTitle>
            <AlertDescription>
              {error.error || error.hint || t('mcp.status.unknown')}
            </AlertDescription>
          </Alert>
        ))}
        {status.budgetMode && status.budgetMode !== 'off' ? (
          <Alert>
            <AlertCircleIcon />
            <AlertDescription>
              {t('mcp.clientBudget', {
                count: status.clientCount ?? 0,
                budget: status.clientBudget ?? '∞',
              })}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`${t('common.search')} MCP…`}
          />
        </div>
        <ToggleGroup
          type="single"
          value={sourceFilter}
          onValueChange={(value) => {
            if (value) setSourceFilter(value as SourceFilter);
          }}
          variant="outline"
          size="sm"
          aria-label={t('mcp.source')}
        >
          {sourceOptions.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {filteredServers.length ? (
          <div
            className={styles.serverGrid}
            data-column-count={Math.min(filteredServers.length, 4)}
          >
            {filteredServers.map((server) => (
              <Card
                key={server.name}
                size="sm"
                role="button"
                tabIndex={0}
                aria-label={server.name}
                className="cursor-pointer transition-colors hover:bg-accent/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => openServer(server)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openServer(server);
                  }
                }}
              >
                <CardHeader className="block">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <ServerIcon className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <CardTitle className="min-w-0 flex-1 truncate">
                          {server.name}
                        </CardTitle>
                        <Badge
                          variant="secondary"
                          className={`${statusBadgeClass(server)} shrink-0 text-[10px]`}
                        >
                          {statusLabel(server, t)}
                        </Badge>
                      </div>
                      <CardDescription className="mt-1 truncate text-xs">
                        {server.description?.trim() || '-'}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query || sourceFilter !== 'all' ? (
                  <SearchIcon />
                ) : (
                  <ServerIcon />
                )}
              </EmptyMedia>
              <EmptyTitle>
                {query || sourceFilter !== 'all'
                  ? t('mcp.noMatches')
                  : t('mcp.empty')}
              </EmptyTitle>
              {!query && sourceFilter === 'all' ? (
                <EmptyDescription>{t('mcp.emptyDescription')}</EmptyDescription>
              ) : null}
            </EmptyHeader>
          </Empty>
        )}
      </div>
      {editorDialog}
    </div>
  );
}
