/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProjectMcpConfigValidator } from '../../config/mcp/projectMcpJson.js';
import type React from 'react';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { colorize } from '../../ink/colorize.js';
import { theme } from '../semantic-colors.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { useI18nService } from '../i18n/index.js';
import { Colors } from '../colors.js';
import { figures } from '../utils/figures.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type {
  AnyDeclarativeTool,
  Config,
  MCPServerConfig,
  McpConfigurationError,
} from '@qwen-code/core';
import {
  MCPServerStatus,
  DiscoveredMCPTool,
  expandMcpEnvVars,
  CONFIG_DIR,
  getUserConfigDisplayPath,
  shortenPath,
  mcpServerRequiresOAuth,
  isMcpAuthToolName,
  BRAND_CLI_BIN,
  MCP_POLICY_BLOCKED_MESSAGE,
  coreEvents,
  CoreEvent,
} from '@qwen-code/core';
import type { CommandSettings } from '../../config/createCliSettingsService.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  findMcpServerScopes,
  getScopeSettingsPath,
  getProjectSourcePaths,
  persistentEnableMcpServer,
  persistentDisableMcpServer,
  removeMcpServer,
  type McpScope,
} from '../../config/localSettings.js';
import {
  McpServerEnablementManager,
  normalizeServerId,
} from '../../config/mcp/mcpServerEnablement.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from './shared/SettingsListPanel.js';
import { BaseTabDialog, type TabItem } from './shared/BaseTabDialog.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { Command } from '../key/keyMatchers.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import type { Key } from '../hooks/useKeypress.js';
import {
  clearMcpAuthSession,
  getMcpAuthSession,
  getMcpCredentialState,
  getPreservedDetailServer,
  isOAuthCapable,
  setPreservedDetailServer,
  startMcpAuth,
  subscribeMcpAuthSession,
  type CredentialState,
  type McpAuthSessionState,
} from './mcpAuthSession.js';
import { McpToolListView } from './McpToolListView.js';
import { McpToolDetailView } from './McpToolDetailView.js';
import { InputField } from './shared/InputField.js';
import { useTextBuffer } from './shared/text-buffer.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type ServerOrigin =
  | 'user'
  | 'local'
  | 'project'
  | 'plugin'
  | 'flag'
  | 'dynamic';

interface McpServerDisplayInfo {
  name: string;
  config: MCPServerConfig;
  origin: ServerOrigin;
  /** Scopes (in localSettings.ts terms) where this server is persisted. */
  scopes: McpScope[];
  sourcePaths: string[];
  enabled: boolean;
  hostPolicyBlocked: boolean;
  hostPolicyMessage: string;
  configurationError?: McpConfigurationError;
  status: MCPServerStatus;
  connection?: 'gateway' | 'direct';
  connectionLabel?: string;
  tools: AnyDeclarativeTool[];
}

export interface McpBrowserProps {
  config: Config;
  settings: LoadedSettings;
  onCreateMcpServer?: (prompt: string) => void;
  onExit: () => void;
}

// ─── View Mode ───────────────────────────────────────────────────────────────

type ViewMode = 'list' | 'detail' | 'tools' | 'toolDetail';

const MAX_ITEMS_TO_SHOW = 8;

// Bottom detail bar: 1 blank separator row + 1 line carrying either a transient
// status message or the focused server's description/endpoint.
const LIST_FOOTER_HEIGHT = 2;

const ORIGIN_LABELS: Record<ServerOrigin, string> = {
  user: 'User',
  local: 'Local',
  project: 'Project',
  plugin: 'Plugin',
  flag: 'Flag',
  dynamic: 'Dynamic',
};

const MCP_CONFIG_COMMAND = '/mcp-config';
const CREATE_MCP_KEY = '__create_new_mcp__';

/** Tabs where the user can persist a new MCP server via this dialog. */
type CreatableOrigin = 'user' | 'local' | 'project';

function isCreatableOrigin(origin: ServerOrigin): origin is CreatableOrigin {
  return origin === 'user' || origin === 'local' || origin === 'project';
}

const CREATE_SCOPE_META: Record<
  CreatableOrigin,
  { label: string; displayLabel: string; hint: string; path: string }
> = {
  local: {
    label: 'local',
    displayLabel: 'Local MCP Server',
    hint: '(this project, not committed)',
    path: `${CONFIG_DIR}/settings.local.json`,
  },
  project: {
    label: 'project',
    displayLabel: 'Project MCP Server',
    hint: '(this project only)',
    path: `${CONFIG_DIR}/settings.json`,
  },
  user: {
    label: 'user',
    displayLabel: 'User MCP Server',
    hint: '(all projects on this machine)',
    path: getUserConfigDisplayPath('settings.json'),
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse `--strict-mcp-config` and `--mcp-config` from process.argv.
 * Returns null when strict mode is not active.
 */
function getStrictMcpConfigPaths(): string[] | null {
  const argv = process.argv;
  let isStrict = false;
  const mcpConfigPaths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--strict-mcp-config') {
      isStrict = true;
    } else if (argv[i] === '--mcp-config' && i + 1 < argv.length) {
      mcpConfigPaths.push(argv[i + 1]);
      i++; // skip value
    }
  }
  return isStrict ? mcpConfigPaths : null;
}

function getServerOrigin(
  name: string,
  serverConfig: MCPServerConfig,
  cwd: string,
  strictMcpConfigPaths: string[] | null,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): { origin: ServerOrigin; scopes: McpScope[]; sourcePaths: string[] } {
  // Runtime-injected servers (ACP session/new, mcp_set_servers) carry an
  // explicit scope marker. Honour it before any disk classification so
  // they always render under the Dynamic tab regardless of strict mode.
  if (serverConfig.scope === 'dynamic') {
    return { origin: 'dynamic', scopes: [], sourcePaths: [] };
  }
  if (serverConfig.plugin?.name) {
    return { origin: 'plugin', scopes: [], sourcePaths: [] };
  }

  // In strict mode, skip disk scanning — only show the --mcp-config paths
  // as the source, since those are the only files the server was loaded from.
  if (strictMcpConfigPaths !== null) {
    return {
      origin: 'flag',
      scopes: [],
      sourcePaths: strictMcpConfigPaths,
    };
  }

  const scopes = findMcpServerScopes(name, cwd, settings, validator);
  const sourcePaths: string[] = [];

  if (scopes.includes('user')) {
    sourcePaths.push(getScopeSettingsPath('user', cwd, settings));
  }
  if (scopes.includes('project')) {
    // project scope may span .mcp.json and/or legacy project settings.json;
    // show the actual file(s) where this server is defined.
    sourcePaths.push(...getProjectSourcePaths(name, cwd, settings, validator));
  }
  if (scopes.includes('local')) {
    sourcePaths.push(getScopeSettingsPath('local', cwd, settings));
  }

  // The effective config carries the scope it was loaded from. A name can be
  // present in several files (and be shadowed by a higher-precedence source),
  // so file scanning answers "where is it also defined", not "which definition
  // is active". Prefer the explicit scope; fall back to scanning only for
  // legacy configs without a scope tag.
  if (serverConfig.scope === 'flag') {
    return { origin: 'flag', scopes: [], sourcePaths: [] };
  }
  if (serverConfig.scope === 'local') {
    return { origin: 'local', scopes, sourcePaths };
  }
  if (serverConfig.scope === 'project') {
    return { origin: 'project', scopes, sourcePaths };
  }
  if (serverConfig.scope === 'user') {
    return { origin: 'user', scopes, sourcePaths };
  }

  if (scopes.includes('local')) {
    return { origin: 'local', scopes, sourcePaths };
  }
  if (scopes.includes('project')) {
    return { origin: 'project', scopes, sourcePaths };
  }
  if (scopes.includes('user')) {
    return { origin: 'user', scopes, sourcePaths };
  }
  // Fallback: configured but not found in any known scope
  // (e.g. injected via CLI --mcp-server flag). Treat as flag for display.
  return { origin: 'flag', scopes: [], sourcePaths: [] };
}

function expandUrl(url: string): string {
  return expandMcpEnvVars(url, process.env as Record<string, string>);
}

function formatServerEndpoint(server: MCPServerConfig): string {
  if (server.command) {
    const args = server.args?.join(' ') ?? '';
    return `${server.command}${args ? ' ' + args : ''}`;
  }
  if (server.httpUrl) return expandUrl(server.httpUrl);
  if (server.url) return expandUrl(server.url);
  if (server.tcp) return server.tcp;
  return '(no endpoint)';
}

function loadServerDisplayInfo(
  config: Config,
  cwd: string,
  settings: CommandSettings,
): McpServerDisplayInfo[] {
  const manager = config.getMcpClientManager();
  if (!manager) return [];
  const servers = manager.getMcpServers();
  // Browse the discovered catalog independently of model schema registration
  // and lazy loading, which can leave tools out of the model's registry.
  const discoveredTools = manager
    .getAllDiscoveredMcpTools()
    .map((entry) => entry.tool)
    .filter(
      (tool): tool is DiscoveredMCPTool =>
        tool instanceof DiscoveredMCPTool && !isMcpAuthToolName(tool.name),
    );
  const allTools =
    config.getToolRegistry()?.getVisibleMcpTools(discoveredTools) ?? [];

  // The dialog's "enabled" badge tracks effective state — both the
  // settings.json `disabled` field and any in-memory session disable.
  const enablementManager = McpServerEnablementManager.getInstance();
  const displayStates = enablementManager.getAllDisplayStates(
    Object.keys(servers),
    config.getLoadedSettings(),
  );

  const strictMcpConfigPaths = getStrictMcpConfigPaths();

  return Object.entries(servers).map(([name, serverConfig]) => {
    const { origin, scopes, sourcePaths } = getServerOrigin(
      name,
      serverConfig,
      cwd,
      strictMcpConfigPaths,
      settings,
      config.getProcessMcpManager(),
    );
    const status = manager.getServerStatus(name);
    const displayState = displayStates[normalizeServerId(name)];
    // Dynamic-source servers don't participate in the on-disk disable
    // list — they are host-owned. Only the session-disable flag applies.
    const enabled =
      origin === 'dynamic'
        ? !enablementManager.isSessionDisabled(name)
        : (displayState?.enabled ?? true);
    const tools = allTools.filter((tool) => tool.serverName === name);
    // The gate records why a server was blocked; the wording belongs to the
    // host policy that produced it, not to this UI.
    const hostPolicyBlocked = manager.isMcpServerBlockedByHostPolicy(name);
    const hostPolicyMessage =
      manager.getMcpServerDenyMessage(name) ?? MCP_POLICY_BLOCKED_MESSAGE;
    const client = manager.getClientByName(name);
    const clientConfig = client?.getServerConfig();
    const brokered =
      clientConfig !== undefined &&
      manager.getMcpServerPresentation?.(clientConfig) !== undefined;
    const connection =
      enabled &&
      !hostPolicyBlocked &&
      client?.getStatus() === MCPServerStatus.CONNECTED
        ? brokered
          ? 'gateway'
          : 'direct'
        : undefined;
    const connectionLabel =
      brokered && clientConfig !== undefined
        ? manager.getMcpServerPresentation?.(clientConfig)?.connectionLabel
        : undefined;
    return {
      name,
      config: serverConfig,
      origin,
      scopes,
      sourcePaths,
      enabled,
      hostPolicyBlocked,
      hostPolicyMessage,
      configurationError: manager.getMcpServerConfigurationError(name),
      status,
      connection,
      connectionLabel,
      tools,
    };
  });
}

function serverNeedsAuthentication(server: McpServerDisplayInfo): boolean {
  return (
    server.enabled &&
    !server.hostPolicyBlocked &&
    !server.configurationError &&
    (server.status === MCPServerStatus.AUTH_REQUIRED ||
      (server.status === MCPServerStatus.DISCONNECTED &&
        mcpServerRequiresOAuth.has(server.name)))
  );
}

// ─── Auth row formatting ────────────────────────────────────────────────────

function renderAuthRowValue(
  credentialState: CredentialState,
  session: McpAuthSessionState,
): string {
  if (session.state === 'running') {
    return '⏳ Authenticating in browser…';
  }
  if (session.state === 'success') {
    return '✓ Just authenticated';
  }
  if (session.state === 'error') {
    return `✗ Failed · ⏎ ${SHORTCUT_HINTS.ENTER_AUTHENTICATE}`;
  }
  // No live session — show stored credential state.
  switch (credentialState) {
    case 'authenticated':
      return '✓ Authenticated';
    case 'expired':
      return `⚠ Token expired · ⏎ ${SHORTCUT_HINTS.ENTER_AUTHENTICATE}`;
    case 'unauthenticated':
      return `⏎ ${SHORTCUT_HINTS.ENTER_AUTHENTICATE}`;
    case 'not-configured':
    default:
      return '(OAuth not configured)';
  }
}

// ─── Detail Field Row ────────────────────────────────────────────────────────

interface DetailRowProps {
  label: string;
  value: string;
  isActive?: boolean;
  isAction?: boolean;
  disabled?: boolean;
}

const DetailRow = ({
  label,
  value,
  isActive,
  isAction,
  disabled,
}: DetailRowProps): React.JSX.Element => {
  const labelColor = disabled
    ? Colors.Gray
    : isActive
      ? theme.ui.focus
      : Colors.Foreground;
  const valueColor = disabled
    ? Colors.Gray
    : isAction
      ? isActive
        ? theme.status.error
        : Colors.Gray
      : isActive
        ? theme.ui.focus
        : theme.text.secondary;
  const prefix = isActive ? `${figures.pointer} ` : '  ';
  return (
    <Box flexDirection="row">
      <Text color={labelColor}>{prefix}</Text>
      <Box width={18}>
        <Text color={labelColor} bold={isActive}>
          {label}
        </Text>
      </Box>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
};

// ─── Main Component ──────────────────────────────────────────────────────────

export function McpBrowser({
  config,
  settings,
  onCreateMcpServer,
  onExit,
}: McpBrowserProps): React.JSX.Element {
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const { columns: terminalWidth } = useTerminalSize();
  const keyMatchers = useKeyMatchers();
  const cwd = config.getSessionArtifactProjectRoot();

  // Create-server input mode (mirrors HooksBrowser / SkillBrowser).
  const [isCreateMode, setIsCreateMode] = useState(false);
  const createQueryBuffer = useTextBuffer({
    initialText: '',
    initialCursorOffset: 0,
    viewport: { width: Math.max(20, terminalWidth - 12), height: 5 },
  });

  // Global state
  const [servers, setServers] = useState<McpServerDisplayInfo[]>([]);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Restore detail-view state if we were unmounted by a consent prompt
  // mid-flow and are now remounting. See `mcpAuthSession.ts` for context.
  const initialDetailServer = getPreservedDetailServer();
  const [viewMode, setViewMode] = useState<ViewMode>(
    initialDetailServer ? 'detail' : 'list',
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Detail mode state
  const [detailServerName, setDetailServerName] = useState<string | null>(
    initialDetailServer,
  );
  const [detailFieldIndex, setDetailFieldIndex] = useState(0);

  // Tool navigation state
  const [selectedTool, setSelectedTool] = useState<AnyDeclarativeTool | null>(
    null,
  );

  // OAuth credential state for the current detail server (async lookup).
  const [credentialState, setCredentialState] =
    useState<CredentialState>('not-configured');

  // Subscribe to the module-level OAuth session store so we re-render when
  // the in-flight session emits new progress messages or finishes.
  const [authSessionNonce, setAuthSessionNonce] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribeMcpAuthSession(() => {
      setAuthSessionNonce((n) => n + 1);
    });
    return unsubscribe;
  }, []);

  // Source tab state
  const [activeOriginTab, setActiveOriginTab] = useState<ServerOrigin>('local');

  // Load servers
  useEffect(() => {
    setServers(loadServerDisplayInfo(config, cwd, settings));
    setServersLoaded(true);
  }, [config, cwd, refreshNonce, settings]);

  // Debounced refresh to avoid rapid-fire loadServerDisplayInfo calls when
  // multiple MCP servers emit status changes in quick succession.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      setRefreshNonce((n) => n + 1);
    }, 300);
  }, []);

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  // Policy reconciliation can change the effective MCP state without a
  // transport status transition (for example, a disconnected server becomes
  // enterprise-blocked). Listen to the manager-level update as well so an
  // already-open browser reflects polling changes immediately.
  useEffect(() => {
    coreEvents.on(CoreEvent.McpClientUpdate, debouncedRefresh);
    return () => {
      coreEvents.off(CoreEvent.McpClientUpdate, debouncedRefresh);
    };
  }, [debouncedRefresh]);

  // Subscribe to session enablement changes (e.g. structuredIOMcpControl
  // toggling a server, or `/mcp enable --session` from another code path).
  useEffect(() => {
    const manager = McpServerEnablementManager.getInstance();
    return manager.subscribe(debouncedRefresh);
  }, [debouncedRefresh]);

  const originTabs: TabItem[] = useMemo(() => {
    const counts: Record<ServerOrigin, number> = {
      user: 0,
      local: 0,
      project: 0,
      plugin: 0,
      flag: 0,
      dynamic: 0,
    };
    const authOrigins = new Set<ServerOrigin>();
    for (const server of servers) {
      counts[server.origin]++;
      if (serverNeedsAuthentication(server)) {
        authOrigins.add(server.origin);
      }
    }
    const labelFor = (origin: ServerOrigin) => {
      const authMarker = authOrigins.has(origin)
        ? colorize(' !', theme.status.warning, 'foreground')
        : '';
      return `${ORIGIN_LABELS[origin]} (${counts[origin]})${authMarker}`;
    };
    const tabs: TabItem[] = [
      { key: 'local', label: labelFor('local') },
      { key: 'project', label: labelFor('project') },
      { key: 'user', label: labelFor('user') },
      { key: 'plugin', label: labelFor('plugin') },
    ];
    if (counts.flag > 0) {
      tabs.unshift({ key: 'flag', label: labelFor('flag') });
    }
    if (counts.dynamic > 0) {
      tabs.unshift({ key: 'dynamic', label: labelFor('dynamic') });
    }
    return tabs;
  }, [servers]);

  // If the active tab disappears (e.g. the only flag server was removed,
  // or the tab was never present to begin with) fall back to the first
  // available tab so the BaseTabDialog's active indicator never dangles.
  useEffect(() => {
    if (originTabs.length === 0) return;
    if (!originTabs.some((t) => t.key === activeOriginTab)) {
      setActiveOriginTab(originTabs[0].key as ServerOrigin);
    }
  }, [originTabs, activeOriginTab]);

  const handleOriginTabChange = useCallback((key: string) => {
    if (
      key === 'user' ||
      key === 'local' ||
      key === 'project' ||
      key === 'plugin' ||
      key === 'flag' ||
      key === 'dynamic'
    ) {
      setActiveOriginTab(key);
      setStatusMessage(null);
    }
  }, []);

  // Filter by tab (search filtering is handled internally by SLP)
  const filteredServers = useMemo(
    () => servers.filter((s) => s.origin === activeOriginTab),
    [servers, activeOriginTab],
  );

  // Stable cross-tab item slot count for layout height stabilization.
  const maxServerItemsAcrossTabs = useMemo(() => {
    let userCount = 0;
    let localCount = 0;
    let projectCount = 0;
    let pluginCount = 0;
    let flagCount = 0;
    let dynamicCount = 0;
    for (const s of servers) {
      if (s.origin === 'user') userCount++;
      else if (s.origin === 'local') localCount++;
      else if (s.origin === 'project') projectCount++;
      else if (s.origin === 'flag') flagCount++;
      else if (s.origin === 'dynamic') dynamicCount++;
      else pluginCount++;
    }
    // Creatable tabs prepend a synthetic "New MCP Server" item.
    return Math.max(
      userCount + 1,
      localCount + 1,
      projectCount + 1,
      pluginCount,
      flagCount,
      dynamicCount,
    );
  }, [servers]);

  // ─── Hot reload of mcp client manager ──────────────────────────────────────

  const reloadMcp = useCallback(async () => {
    const manager = config.getMcpClientManager();
    if (manager) {
      try {
        await manager.restart();
      } catch {
        // ignore — UI will still show new persisted state
      }
    }
    try {
      await config.refreshMcpContext();
    } catch {
      // ignore
    }
    setRefreshNonce((n) => n + 1);
  }, [config]);

  // ─── List Operations ────────────────────────────────────────────────────────

  const openDetail = useCallback(
    (serverName: string) => {
      const server = filteredServers.find((s) => s.name === serverName);
      if (!server) return;
      setPreservedDetailServer(server.name);
      setDetailServerName(server.name);
      setDetailFieldIndex(0);
      setStatusMessage(null);
      setViewMode('detail');
    },
    [filteredServers],
  );

  const closeDetail = useCallback(() => {
    setPreservedDetailServer(null);
    setViewMode('list');
    setDetailServerName(null);
    setDetailFieldIndex(0);
  }, []);

  const handleDetailTabChange = useCallback(
    (key: string) => {
      if (
        key === 'user' ||
        key === 'local' ||
        key === 'project' ||
        key === 'plugin' ||
        key === 'flag'
      ) {
        setActiveOriginTab(key);
      }
      closeDetail();
    },
    [closeDetail],
  );

  // Wrap onExit so we drop preserved detail state when the whole dialog
  // closes — otherwise re-opening /mcp would jump straight back to detail.
  const handleExit = useCallback(() => {
    setPreservedDetailServer(null);
    onExit();
  }, [onExit]);

  // Custom key handler for list view: Enter opens detail or create mode
  const handleListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        if (currentItem.key === CREATE_MCP_KEY) {
          if (isCreatableOrigin(activeOriginTab)) {
            setStatusMessage(null);
            setIsCreateMode(true);
          }
          return true;
        }
        openDetail(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, openDetail, activeOriginTab],
  );

  const exitCreateMode = useCallback(() => {
    setIsCreateMode(false);
    createQueryBuffer.setText('');
  }, [createQueryBuffer]);

  // Convert filtered servers to dialog items
  const serverItems: SettingsDialogItem[] = useMemo(() => {
    const items: SettingsDialogItem[] = filteredServers.map((server) => {
      let statusStr: string;
      if (server.hostPolicyBlocked) {
        statusStr = `${figures.circle} blocked by policy`;
      } else if (server.configurationError) {
        statusStr = colorize(
          `${figures.cross} ${getUiText('mcp.configuration.failed')}`,
          theme.status.error,
          'foreground',
        );
      } else if (!server.enabled) {
        statusStr = `${figures.circle} disabled`;
      } else {
        switch (server.status) {
          case MCPServerStatus.CONNECTED:
            statusStr = `${figures.bullet} ready`;
            break;
          case MCPServerStatus.CONNECTING:
            statusStr = '◐ starting';
            break;
          case MCPServerStatus.DISCONNECTED:
          default:
            statusStr = serverNeedsAuthentication(server)
              ? `${figures.circle} needs authentication`
              : `${figures.circle} disconnected`;
            break;
        }
      }
      const toolStr =
        server.tools.length > 0
          ? ` · ${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`
          : '';
      return {
        key: server.name,
        label: server.name,
        description: server.configurationError
          ? server.configurationError.expectedAddress
            ? getUiText('mcp.configuration.addressMismatch')
            : server.configurationError.message
          : server.config.description || formatServerEndpoint(server.config),
        type: 'boolean' as const,
        displayValue: `${statusStr}${toolStr}`,
        isGreyedOut: !server.enabled || server.hostPolicyBlocked,
        rawValue: server.enabled,
      };
    });

    if (isCreatableOrigin(activeOriginTab)) {
      const { displayLabel, hint, path } = CREATE_SCOPE_META[activeOriginTab];
      items.unshift({
        key: CREATE_MCP_KEY,
        label: `[+] New ${displayLabel} ${hint}`,
        description: `Add a new MCP server · saved to ${shortenPath(path, 50)}`,
        type: 'boolean' as const,
        displayValue: '',
        isGreyedOut: false,
        rawValue: false,
      });
    }

    return items;
  }, [filteredServers, activeOriginTab, getUiText]);

  // ─── Detail Operations ─────────────────────────────────────────────────────

  const detailServer = useMemo(() => {
    if (!detailServerName) return null;
    return servers.find((s) => s.name === detailServerName) ?? null;
  }, [servers, detailServerName]);

  // OAuth capability + live session state for the current detail server.
  const oauthCapable = useMemo(
    () =>
      detailServer && !detailServer.configurationError
        ? isOAuthCapable(
            detailServer.name,
            detailServer.config,
            config.getMcpClientManager(),
          )
        : false,
    [detailServer, config],
  );

  // `authSessionNonce` is read so this re-evaluates when the singleton fires.
  const authSession: McpAuthSessionState = useMemo(
    () =>
      detailServer ? getMcpAuthSession(detailServer.name) : { state: 'idle' },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nonce is the trigger
    [detailServer, authSessionNonce],
  );

  // Async credential lookup, refreshed when the server changes, when an
  // auth session finishes, or when the user toggles the server.
  useEffect(() => {
    if (!detailServer) {
      setCredentialState('not-configured');
      return;
    }
    // Reset to a neutral value while the async lookup is in flight so the
    // auth row doesn't briefly show the *previous* server's indicator when
    // the user navigates between detail views quickly.
    setCredentialState('not-configured');
    let cancelled = false;
    void getMcpCredentialState(
      detailServer.name,
      detailServer.config,
      config.getMcpClientManager(),
    ).then((state) => {
      if (!cancelled) setCredentialState(state);
    });
    return () => {
      cancelled = true;
    };
    // Re-run on auth session changes so the indicator updates after success.
  }, [detailServer, refreshNonce, authSessionNonce, config]);

  // After OAuth succeeds, `startMcpAuth` already restarted the server and
  // refreshed MCP context, so core's status map now reports CONNECTED.
  // But our cached `servers` snapshot only re-reads via `refreshNonce`,
  // so without this bump the list view would keep showing the pre-auth
  // 'disconnected' badge until the user reopens /mcp. Piggyback on the
  // detail-view auth session; errors also bump so a retry path picks up
  // any partial status change.
  useEffect(() => {
    if (authSession.state === 'success' || authSession.state === 'error') {
      setRefreshNonce((n) => n + 1);
    }
  }, [authSession.state]);

  const detailServerTools = useMemo(
    () => detailServer?.tools ?? [],
    [detailServer],
  );

  // Detail field definitions: built dynamically based on server.
  // First field is always the toggle. If the server supports OAuth, the
  // next field is an "Authenticate" action. Last is delete.
  type DetailField =
    | { kind: 'toggle' }
    | { kind: 'auth' }
    | { kind: 'tools' }
    | { kind: 'info'; label: string; value: string }
    | { kind: 'delete' };

  const detailFields: DetailField[] = useMemo(() => {
    if (!detailServer) return [];
    const fields: DetailField[] = [{ kind: 'toggle' }];
    if (oauthCapable) {
      fields.push({ kind: 'auth' });
    }
    // Browse tools only makes sense when the server can serve them.
    if (detailServerTools.length > 0) {
      fields.push({ kind: 'tools' });
    }
    const cfg = detailServer.config;
    const presentation = config
      .getMcpClientManager()
      ?.getMcpServerPresentation?.(cfg);
    if (cfg.command) {
      fields.push({ kind: 'info', label: 'Command', value: cfg.command });
      if (cfg.args && cfg.args.length > 0) {
        fields.push({ kind: 'info', label: 'Args', value: cfg.args.join(' ') });
      }
    }
    if (cfg.url)
      fields.push({ kind: 'info', label: 'URL', value: expandUrl(cfg.url) });
    if (cfg.httpUrl)
      fields.push({
        kind: 'info',
        label: 'HTTP URL',
        value: expandUrl(cfg.httpUrl),
      });
    for (const field of presentation?.detailFields ?? []) {
      fields.push({ kind: 'info', label: field.label, value: field.value });
    }
    if (cfg.tcp) fields.push({ kind: 'info', label: 'TCP', value: cfg.tcp });
    if (cfg.type) fields.push({ kind: 'info', label: 'Type', value: cfg.type });
    if (detailServer.connection) {
      fields.push({
        kind: 'info',
        label: 'Connection',
        value:
          detailServer.connection === 'gateway'
            ? (detailServer.connectionLabel ?? 'MCP Server')
            : 'Direct MCP Server',
      });
    }
    if (cfg.cwd) fields.push({ kind: 'info', label: 'CWD', value: cfg.cwd });
    if (cfg.timeout !== undefined)
      fields.push({
        kind: 'info',
        label: 'Timeout',
        value: `${cfg.timeout}ms`,
      });
    if (cfg.trust !== undefined)
      fields.push({
        kind: 'info',
        label: 'Trust',
        value: cfg.trust ? 'true' : 'false',
      });
    if (cfg.env && Object.keys(cfg.env).length > 0) {
      fields.push({
        kind: 'info',
        label: 'Env',
        value: Object.keys(cfg.env).join(', '),
      });
    }
    if (cfg.headers && Object.keys(cfg.headers).length > 0) {
      fields.push({
        kind: 'info',
        label: 'Headers',
        value: Object.keys(cfg.headers).join(', '),
      });
    }
    if (cfg.includeTools && cfg.includeTools.length > 0) {
      fields.push({
        kind: 'info',
        label: 'Include',
        value: cfg.includeTools.join(', '),
      });
    }
    if (cfg.excludeTools && cfg.excludeTools.length > 0) {
      fields.push({
        kind: 'info',
        label: 'Exclude',
        value: cfg.excludeTools.join(', '),
      });
    }
    if (cfg.alwaysAllow && cfg.alwaysAllow.length > 0) {
      fields.push({
        kind: 'info',
        label: 'Always Allow',
        value: cfg.alwaysAllow.join(', '),
      });
    }
    fields.push({
      kind: 'info',
      label: 'Origin',
      value: ORIGIN_LABELS[detailServer.origin],
    });
    if (detailServer.sourcePaths.length > 0) {
      fields.push({
        kind: 'info',
        label: detailServer.sourcePaths.length > 1 ? 'Sources' : 'Source',
        value: detailServer.sourcePaths.join(' | '),
      });
    }
    fields.push({ kind: 'delete' });
    return fields;
  }, [detailServer, oauthCapable, detailServerTools.length, config]);

  const handleDetailToggle = useCallback(async () => {
    if (!detailServer) return;
    if (
      detailServer.origin === 'plugin' ||
      detailServer.origin === 'flag' ||
      detailServer.origin === 'dynamic'
    ) {
      if (detailServer.origin === 'flag') {
        setStatusMessage('Flag servers cannot be toggled from this dialog.');
      } else if (detailServer.origin === 'plugin') {
        setStatusMessage(
          'Plugin-provided servers cannot be toggled from this dialog.',
        );
      } else {
        setStatusMessage(
          'Dynamic servers are managed by the host and cannot be toggled from /mcp. Use the host UI or the mcp_toggle control.',
        );
      }
      return;
    }
    try {
      if (detailServer.enabled) {
        await persistentDisableMcpServer(
          detailServer.name,
          cwd,
          settings,
          config.getProcessMcpManager(),
        );
        setStatusMessage(`Disabled '${detailServer.name}'.`);
      } else {
        await persistentEnableMcpServer(
          detailServer.name,
          cwd,
          settings,
          config.getProcessMcpManager(),
        );
        setStatusMessage(`Enabled '${detailServer.name}'.`);
      }
    } catch (err) {
      setStatusMessage(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Re-sync after a partial failure (write succeeded, refresh failed).
      await reloadMcp();
      return;
    }
    await reloadMcp();
  }, [detailServer, reloadMcp, cwd, settings, config]);

  // Re-auth is only meaningful when there is no live session AND the stored
  // credentials aren't already good. Keeps Enter a no-op (rather than silently
  // re-launching the browser) on servers the user has just signed into.
  const canAuthenticate =
    oauthCapable &&
    authSession.state !== 'running' &&
    authSession.state !== 'success' &&
    !(authSession.state === 'idle' && credentialState === 'authenticated');

  const handleAuthenticate = useCallback(async () => {
    if (!detailServer) return;
    if (!oauthCapable) {
      setStatusMessage('This server does not advertise OAuth.');
      return;
    }
    if (!canAuthenticate) return;
    setStatusMessage(null);
    // Fire and forget — the session store will notify us as it progresses.
    void startMcpAuth(detailServer.name, detailServer.config, config);
  }, [detailServer, oauthCapable, canAuthenticate, config]);

  const openTools = useCallback(() => {
    if (!detailServer) return;
    if (detailServerTools.length === 0) {
      setStatusMessage(`No tools available on '${detailServer.name}'.`);
      return;
    }
    setStatusMessage(null);
    setViewMode('tools');
  }, [detailServer, detailServerTools.length]);

  const closeTools = useCallback(() => {
    setViewMode('detail');
  }, []);

  const openToolDetail = useCallback((tool: AnyDeclarativeTool) => {
    setSelectedTool(tool);
    setViewMode('toolDetail');
  }, []);

  const closeToolDetail = useCallback(() => {
    setSelectedTool(null);
    setViewMode('tools');
  }, []);

  const handleDeleteServer = useCallback(async () => {
    if (!detailServer) return;
    if (
      detailServer.origin === 'plugin' ||
      detailServer.origin === 'flag' ||
      detailServer.origin === 'dynamic'
    ) {
      if (detailServer.origin === 'flag') {
        setStatusMessage('Flag servers cannot be deleted here.');
      } else if (detailServer.origin === 'plugin') {
        setStatusMessage('Plugin-provided servers cannot be deleted here.');
      } else {
        setStatusMessage(
          'Dynamic servers are managed by the host and cannot be deleted from /mcp.',
        );
      }
      return;
    }
    if (detailServer.scopes.length === 0) {
      setStatusMessage(
        `'${detailServer.name}' is not stored in any settings.json — nothing to remove.`,
      );
      return;
    }
    try {
      for (const scope of detailServer.scopes) {
        removeMcpServer(detailServer.name, scope, cwd, settings);
      }
      // Sync Config's in-memory disk bucket with the on-disk state so the
      // subsequent manager.restart() sees the server as gone and purges it
      // from allServerConfigs. Without this, the ghost entry survives and
      // its origin falls through to the "Plugin" tab (since findMcpServerScopes
      // now returns []). Dynamic entries are owned by the host and untouched.
      const current = config.getDiskMcpServers() ?? {};
      if (detailServer.name in current) {
        const { [detailServer.name]: _removed, ...rest } = current;
        config.setDiskMcpServers(rest);
      }
      setStatusMessage(`Removed '${detailServer.name}'.`);
    } catch (err) {
      setStatusMessage(
        `Failed to remove: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    await reloadMcp();
    closeDetail();
  }, [detailServer, cwd, config, reloadMcp, closeDetail, settings]);

  // ─── Detail Keyboard Handler ───────────────────────────────────────────────

  const isDetailActive = viewMode === 'detail';

  const detailActionHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:escape': () => {
        closeDetail();
        return true;
      },
      'dialog:navigate:up': () => {
        setDetailFieldIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        setDetailFieldIndex((i) => Math.min(detailFields.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        const field = detailFields[detailFieldIndex];
        if (!field) return true;
        if (field.kind === 'toggle') {
          handleDetailToggle().catch(() => {});
        } else if (field.kind === 'auth') {
          handleAuthenticate().catch(() => {});
        } else if (field.kind === 'tools') {
          openTools();
        } else if (field.kind === 'delete') {
          handleDeleteServer().catch(() => {});
        }
        return true;
      },
    }),
    [
      closeDetail,
      detailFields,
      detailFieldIndex,
      handleDetailToggle,
      handleAuthenticate,
      handleDeleteServer,
      openTools,
    ],
  );

  useRegisterActionHandlers('Dialog', detailActionHandlers, isDetailActive);

  const detailFallbackHandler = useCallback(
    (key: { name?: string; sequence?: string }): boolean | void => {
      // Space to toggle
      if (key.name === 'space' || key.sequence === ' ') {
        const field = detailFields[detailFieldIndex];
        if (field?.kind === 'toggle') {
          handleDetailToggle().catch(() => {});
          return true;
        }
      }
      // Backspace on auth row to dismiss session
      if (key.name === 'backspace' || key.name === 'delete') {
        const field = detailFields[detailFieldIndex];
        if (
          field?.kind === 'auth' &&
          (authSession.state === 'success' || authSession.state === 'error')
        ) {
          if (detailServer) clearMcpAuthSession(detailServer.name);
          return true;
        }
      }
      // 'q' to close
      if (key.sequence === 'q') {
        closeDetail();
        return true;
      }
      return false;
    },
    [
      closeDetail,
      detailFields,
      detailFieldIndex,
      handleDetailToggle,
      authSession.state,
      detailServer,
    ],
  );

  useRegisterFallbackHandler('Dialog', detailFallbackHandler, isDetailActive);

  // Hints from the old behavior packs, now merged into extraHints for detail view
  const detailBehaviorHints = useMemo(
    (): ShortcutHint[] => [{ label: SHORTCUT_HINTS.GO_BACK, order: 100 }],
    [],
  );

  // ─── Render ─────────────────────────────────────────────────────────────────

  // Extra hints for SettingsListPanel capabilities
  const mcpListExtraHints = useMemo(
    (): ShortcutHint[] => [{ label: SHORTCUT_HINTS.ENTER_DETAILS, order: 30 }],
    [],
  );

  // ─── Create Mode (input MCP description) ───────────────────────────────────
  if (isCreateMode && isCreatableOrigin(activeOriginTab)) {
    const {
      label,
      displayLabel,
      path: scopePath,
    } = CREATE_SCOPE_META[activeOriginTab];

    return (
      <BaseTabDialog
        title={`MCP > New ${displayLabel}`}
        onClose={exitCreateMode}
        extraHints={[{ label: SHORTCUT_HINTS.SUBMIT, order: 10 }]}
      >
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={theme.status.success} bold>
              Describe the MCP server you want to add:
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.text.secondary}>
              Scope: {label} ({scopePath})
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={Colors.Gray}>
              Tip: paste a JSON config snippet, or describe the server (name,
              command/url, env, etc.).
            </Text>
          </Box>
          <Box height={7} flexDirection="column">
            <InputField
              buffer={createQueryBuffer}
              onSubmit={(value: string) => {
                if (!value.trim()) return;
                const prompt = `${MCP_CONFIG_COMMAND} Add a new ${label}-scope MCP server (write to ${scopePath}).\n\nUser requirement: ${value.trim()}`;
                onCreateMcpServer?.(prompt);
              }}
              onCancel={exitCreateMode}
              placeholder='e.g. {"mcpServers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}'
            />
          </Box>
        </Box>
      </BaseTabDialog>
    );
  }

  if (
    serversLoaded &&
    servers.length === 0 &&
    !isCreatableOrigin(activeOriginTab)
  ) {
    return (
      <BaseTabDialog
        title="MCP Servers"
        tabs={originTabs}
        activeKey={activeOriginTab}
        onTabChange={handleOriginTabChange}
        onClose={handleExit}
      >
        <Text color={Colors.Gray}>
          No MCP servers from this source. Switch to Local/Project/User to add
          one, or run \`{BRAND_CLI_BIN} mcp add\` from the shell.
        </Text>
      </BaseTabDialog>
    );
  }

  // ─── Tool Detail View ───────────────────────────────────────────────────────
  if (viewMode === 'toolDetail' && detailServer && selectedTool) {
    return (
      <McpToolDetailView
        serverName={detailServer.name}
        tool={selectedTool}
        onBack={closeToolDetail}
        isActive={true}
      />
    );
  }

  // ─── Tool List View ─────────────────────────────────────────────────────────
  if (viewMode === 'tools' && detailServer) {
    return (
      <McpToolListView
        serverName={detailServer.name}
        tools={detailServerTools}
        onSelectTool={openToolDetail}
        onBack={closeTools}
        isActive={true}
      />
    );
  }

  // ─── Detail View ────────────────────────────────────────────────────────────
  if (viewMode === 'detail' && detailServer) {
    const detailTitle = `MCP > ${ORIGIN_LABELS[detailServer.origin]} > ${detailServer.name}`;
    const isNonEditable =
      detailServer.origin === 'plugin' ||
      detailServer.origin === 'flag' ||
      detailServer.origin === 'dynamic';
    const customHints: string[] = [
      SHORTCUT_HINTS.SPACE_TOGGLE_MCP,
      SHORTCUT_HINTS.ENTER_DELETE_ITEM,
    ];
    if (oauthCapable && canAuthenticate) {
      customHints.push(SHORTCUT_HINTS.ENTER_AUTHENTICATE);
    }
    if (detailServerTools.length > 0) {
      customHints.push(SHORTCUT_HINTS.ENTER_VIEW_TOOLS);
    }
    return (
      <BaseTabDialog
        title={detailTitle}
        tabs={originTabs}
        activeKey={detailServer.origin}
        onTabChange={handleDetailTabChange}
        extraHints={[
          ...detailBehaviorHints,
          { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
        ]}
        onClose={closeDetail}
      >
        {/* Description */}
        {detailServer.config.description ? (
          <Box marginBottom={1}>
            <Text color={theme.text.secondary}>
              {detailServer.config.description}
            </Text>
          </Box>
        ) : null}

        {/* Status line */}
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>
            Status:{' '}
            {detailServer.hostPolicyBlocked
              ? 'blocked by policy'
              : detailServer.configurationError
                ? i18n.get('mcp.configuration.failed')
                : !detailServer.enabled
                  ? 'disabled'
                  : detailServer.status === MCPServerStatus.CONNECTED
                    ? 'ready'
                    : detailServer.status === MCPServerStatus.CONNECTING
                      ? 'starting'
                      : mcpServerRequiresOAuth.has(detailServer.name)
                        ? 'needs authentication'
                        : 'disconnected'}
            {detailServerTools.length > 0
              ? ` · ${detailServerTools.length} ${detailServerTools.length === 1 ? 'tool' : 'tools'}`
              : ''}
          </Text>
        </Box>

        {detailServer.hostPolicyBlocked && (
          <Box marginBottom={1}>
            <Text color={theme.status.warning}>
              {detailServer.hostPolicyMessage}
            </Text>
          </Box>
        )}

        {detailServer.configurationError && !detailServer.hostPolicyBlocked && (
          <Box marginBottom={1}>
            <Text color={theme.status.error} wrap="truncate-end">
              {detailServer.configurationError.configuredAddress
                ? i18n.get('mcp.configuration.addressMismatchDetails', {
                    address: detailServer.configurationError.configuredAddress,
                  })
                : detailServer.configurationError.message}
            </Text>
          </Box>
        )}

        {/* Fields */}
        <Box flexDirection="column">
          {detailFields.map((field, idx) => {
            const isActive = idx === detailFieldIndex;
            if (field.kind === 'toggle') {
              return (
                <DetailRow
                  key="enabled"
                  label="Enabled"
                  value={detailServer.enabled ? '✓ Yes' : '✗ No'}
                  isActive={isActive}
                  disabled={isNonEditable}
                />
              );
            }
            if (field.kind === 'auth') {
              return (
                <DetailRow
                  key="auth"
                  label="Authenticate"
                  value={renderAuthRowValue(credentialState, authSession)}
                  isActive={isActive}
                  isAction={canAuthenticate}
                />
              );
            }
            if (field.kind === 'tools') {
              const count = detailServerTools.length;
              return (
                <DetailRow
                  key="tools"
                  label="View tools"
                  value={`⏎ ${count} ${count === 1 ? 'tool' : 'tools'}`}
                  isActive={isActive}
                  isAction
                />
              );
            }
            if (field.kind === 'delete') {
              return (
                <Box key="delete" flexDirection="column">
                  <Box marginTop={1}>
                    <Text color={Colors.Gray}>
                      {'─'.repeat(Math.min(50, terminalWidth - 4))}
                    </Text>
                  </Box>
                  <DetailRow
                    label="Delete server"
                    value={
                      isNonEditable
                        ? detailServer.origin === 'flag'
                          ? '(Flag server, cannot delete)'
                          : detailServer.origin === 'dynamic'
                            ? '(Dynamic server, managed by host)'
                            : '(plugin server, cannot delete)'
                        : `⏎ ${SHORTCUT_HINTS.ENTER_DELETE_ITEM}`
                    }
                    isActive={isActive}
                    isAction
                    disabled={isNonEditable}
                  />
                </Box>
              );
            }
            return (
              <DetailRow
                key={`${field.label}-${idx}`}
                label={field.label}
                value={field.value}
                isActive={isActive}
              />
            );
          })}
        </Box>

        {/* Auth progress / result panel */}
        {oauthCapable && authSession.state !== 'idle' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={Colors.Gray}>
              {'─'.repeat(Math.min(50, terminalWidth - 4))}
            </Text>
            {authSession.state === 'running' && (
              <>
                <Text color={theme.status.warning}>
                  🔐 Authenticating… (waiting for browser callback)
                </Text>
                {authSession.messages.map((msg, i) => (
                  <Box key={i} marginTop={i === 0 ? 1 : 0}>
                    <Text color={theme.text.secondary}>{msg}</Text>
                  </Box>
                ))}
              </>
            )}
            {authSession.state === 'success' && (
              <Text color={theme.status.success}>
                ✓ Successfully authenticated. Press ⌫ to dismiss.
              </Text>
            )}
            {authSession.state === 'error' && (
              <>
                <Text color={theme.status.error}>
                  ✗ Authentication failed: {authSession.error}
                </Text>
                <Text color={theme.text.secondary} dimColor>
                  Press ⏎ to retry · ⌫ to dismiss
                </Text>
              </>
            )}
          </Box>
        )}

        {statusMessage && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{statusMessage}</Text>
          </Box>
        )}
      </BaseTabDialog>
    );
  }

  // ─── List View ──────────────────────────────────────────────────────────────
  return (
    <BaseTabDialog
      title="MCP Servers"
      tabs={originTabs}
      activeKey={activeOriginTab}
      onTabChange={handleOriginTabChange}
      isActive={viewMode === 'list'}
      showSeparator={true}
      showContent={true}
      onClose={handleExit}
      extraHints={mcpListExtraHints}
    >
      <SettingsListPanel
        searchEnabled={true}
        searchPlaceholder={
          activeOriginTab === 'project'
            ? 'Search project servers'
            : activeOriginTab === 'local'
              ? 'Search local servers'
              : activeOriginTab === 'user'
                ? 'Search user servers'
                : 'Search servers'
        }
        items={serverItems}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        minItemSlots={maxServerItemsAcrossTabs}
        itemHeight={1}
        valueAlign="left"
        onItemToggle={() => {}}
        onEditCommit={() => {}}
        onItemClear={() => {}}
        onClose={handleExit}
        onKeyPress={handleListKeyPress}
        reservedFooterHeight={LIST_FOOTER_HEIGHT}
        footer={{
          height: LIST_FOOTER_HEIGHT,
          content: (currentItem) => (
            <Box marginTop={1}>
              <Text color={theme.text.secondary} wrap="truncate-end">
                {statusMessage ?? currentItem?.description ?? ''}
              </Text>
            </Box>
          ),
        }}
      />
    </BaseTabDialog>
  );
}
