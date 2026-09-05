/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink `/mcp` dialog
 * (ui/components/mcp/MCPManagementDialog.tsx): the server-list → detail →
 * tool/resource step navigation stack, per-step headers and footers, the
 * source-grouped server list with status icons and approval/auth states,
 * the tool and resource lists with their scroll hints. Server actions and
 * mutations are reported to the backend via callbacks.
 */

import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { MCPServerStatus } from '@qwen-code/qwen-code-core/tools/mcp-status.js';
import { ICON } from '../constants.js';
import { toOriginalKey } from './key-map.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { DialogFrame, FooterHint } from './dialogs-shared.js';

export const MCP_MANAGEMENT_STEPS = {
  SERVER_LIST: 'server-list',
  SERVER_DETAIL: 'server-detail',
  TOOL_LIST: 'tool-list',
  TOOL_DETAIL: 'tool-detail',
  RESOURCE_LIST: 'resource-list',
  RESOURCE_DETAIL: 'resource-detail',
  AUTHENTICATE: 'authenticate',
} as const;

export type McpManagementStep =
  (typeof MCP_MANAGEMENT_STEPS)[keyof typeof MCP_MANAGEMENT_STEPS];

export type McpServerSource =
  | 'user'
  | 'project'
  | 'workspace'
  | 'system'
  | 'extension';

export const MCP_SOURCE_ORDER: readonly McpServerSource[] = [
  'user',
  'project',
  'workspace',
  'system',
  'extension',
];

export interface McpServerInfo {
  name: string;
  status: MCPServerStatus;
  source: McpServerSource;
  configPath?: string;
  toolCount: number;
  invalidToolCount: number;
  promptCount: number;
  resourceCount: number;
  isDisabled: boolean;
  hasOAuthTokens: boolean;
  requiresAuth: boolean;
  approvalState?: 'pending' | 'rejected';
  command?: string;
  workingDirectory?: string;
  error?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  isValid: boolean;
  invalidReason?: string;
  annotations?: {
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  title?: string;
}

/** Parity of getStatusIcon in mcp/utils.ts. */
export function mcpStatusIcon(status: string): string {
  switch (status) {
    case 'connected':
      return '✓';
    case 'connecting':
      return '…';
    case 'disconnected':
      return '✗';
    default:
      return '?';
  }
}

/** Parity of getStatusColor in mcp/utils.ts. */
export function mcpStatusColor(
  status: string,
): 'green' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'connected':
      return 'green';
    case 'connecting':
      return 'yellow';
    case 'disconnected':
      return 'red';
    default:
      return 'gray';
  }
}

/** Parity of getSourceDisplayName in mcp/utils.ts. */
export function mcpSourceDisplayName(source: string): string {
  switch (source) {
    case 'user':
      return t('User MCPs');
    case 'project':
      return t('Project MCPs');
    case 'workspace':
      return t('Workspace Settings');
    case 'system':
      return t('System Settings');
    case 'extension':
      return t('Extension MCPs');
    default:
      return source;
  }
}

export interface McpServerGroup {
  source: McpServerSource;
  displayName: string;
  servers: McpServerInfo[];
}

/** Parity of groupServersBySource: SOURCE_ORDER grouping. */
export function groupMcpServersBySource(
  servers: readonly McpServerInfo[],
): McpServerGroup[] {
  const groups = new Map<McpServerSource, McpServerInfo[]>();
  for (const server of servers) {
    const existing = groups.get(server.source);
    if (existing) existing.push(server);
    else groups.set(server.source, [server]);
  }
  const result: McpServerGroup[] = [];
  for (const source of MCP_SOURCE_ORDER) {
    const groupServers = groups.get(source);
    if (groupServers && groupServers.length > 0) {
      result.push({
        source,
        displayName: mcpSourceDisplayName(source),
        servers: groupServers,
      });
    }
  }
  return result;
}

/** Parity of the server-row status text (approval/auth overrides first). */
export function mcpServerStatusText(server: McpServerInfo): string {
  const awaitingApproval = !server.isDisabled && !!server.approvalState;
  const needsAuth =
    !server.isDisabled &&
    !awaitingApproval &&
    !!server.requiresAuth &&
    server.status !== MCPServerStatus.CONNECTED;
  if (server.isDisabled) return t('disabled');
  if (awaitingApproval) {
    return server.approvalState === 'rejected'
      ? t('rejected — edit config to re-approve')
      : t('needs approval');
  }
  if (needsAuth) return t('needs authentication');
  return t(server.status);
}

/** Parity of the server-row status color rules. */
export function mcpServerRowColor(
  server: McpServerInfo,
): 'green' | 'yellow' | 'red' | 'gray' {
  const awaitingApproval = !server.isDisabled && !!server.approvalState;
  const needsAuth =
    !server.isDisabled &&
    !awaitingApproval &&
    !!server.requiresAuth &&
    server.status !== MCPServerStatus.CONNECTED;
  if (server.isDisabled || awaitingApproval || needsAuth) return 'yellow';
  return mcpStatusColor(server.status);
}

export type McpServerAction =
  | 'view-tools'
  | 'view-resources'
  | 'reconnect'
  | 'approve'
  | 'toggle-disable'
  | 'authenticate'
  | 'clear-auth';

/** Parity of ServerDetailStep's conditional action list. */
export function buildMcpServerActions(
  server: McpServerInfo,
  options: { resourcesSupported?: boolean; approveSupported?: boolean } = {},
): Array<{ key: string; label: string; action: McpServerAction }> {
  const result: Array<{ key: string; label: string; action: McpServerAction }> =
    [];
  const awaitingApproval = !server.isDisabled && !!server.approvalState;

  if (!server.isDisabled && server.toolCount > 0) {
    result.push({
      key: 'view-tools',
      label: t('View tools'),
      action: 'view-tools',
    });
  }
  if (
    options.resourcesSupported &&
    !server.isDisabled &&
    server.resourceCount > 0
  ) {
    result.push({
      key: 'view-resources',
      label: t('View resources'),
      action: 'view-resources',
    });
  }
  if (
    !server.isDisabled &&
    !awaitingApproval &&
    server.status === 'disconnected'
  ) {
    result.push({
      key: 'reconnect',
      label: t('Reconnect'),
      action: 'reconnect',
    });
  }
  if (awaitingApproval && options.approveSupported) {
    result.push({ key: 'approve', label: t('Approve'), action: 'approve' });
  }
  result.push({
    key: 'toggle-disable',
    label: server.isDisabled ? t('Enable') : t('Disable'),
    action: 'toggle-disable',
  });
  if (!server.isDisabled && !awaitingApproval) {
    result.push({
      key: 'authenticate',
      label: server.hasOAuthTokens ? t('Re-authenticate') : t('Authenticate'),
      action: 'authenticate',
    });
  }
  if (!server.isDisabled && server.hasOAuthTokens) {
    result.push({
      key: 'clear-auth',
      label: t('Clear Authentication'),
      action: 'clear-auth',
    });
  }
  return result;
}

/** Parity of the per-step footer hints in MCPManagementDialog. */
export function mcpStepFooter(
  step: McpManagementStep,
  serverCount: number,
): string {
  switch (step) {
    case MCP_MANAGEMENT_STEPS.SERVER_LIST:
      return serverCount === 0
        ? t('Esc to close')
        : t('↑↓ to navigate · Enter to select · Esc to close');
    case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
    case MCP_MANAGEMENT_STEPS.TOOL_LIST:
    case MCP_MANAGEMENT_STEPS.RESOURCE_LIST:
      return t('↑↓ to navigate · Enter to select · Esc to back');
    case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
    case MCP_MANAGEMENT_STEPS.RESOURCE_DETAIL:
      return t('Esc to back');
    case MCP_MANAGEMENT_STEPS.AUTHENTICATE:
      return t('Esc to go back');
    default:
      return t('Esc to close');
  }
}

/** Clamp-style navigation — MCP lists do NOT wrap (unlike the radio lists). */
export function clampNavIndex(
  current: number,
  count: number,
  direction: 'up' | 'down',
): number {
  return direction === 'down'
    ? Math.min(count - 1, current + 1)
    : Math.max(0, current - 1);
}

export interface OpenTuiMcpDialogProps {
  servers: readonly McpServerInfo[];
  /** Backend feeds the selected server's tools/resources on demand. */
  getServerTools?: (server: McpServerInfo) => readonly McpToolInfo[];
  getServerResources?: (server: McpServerInfo) => readonly McpResourceInfo[];
  onClose: () => void;
  onServerAction?: (server: McpServerInfo, action: McpServerAction) => void;
}

export function OpenTuiMcpDialog(props: OpenTuiMcpDialogProps) {
  const {
    servers,
    getServerTools,
    getServerResources,
    onClose,
    onServerAction,
  } = props;

  const [navigationStack, setNavigationStack] = useState<string[]>([
    MCP_MANAGEMENT_STEPS.SERVER_LIST,
  ]);
  // ink derives the selected server from the live list (useMemo on
  // [servers, selectedServerIndex]) so a reload after an action refreshes
  // the detail view; keying by name survives the host rebuilding the array.
  const [selectedServerName, setSelectedServerName] = useState<string | null>(
    null,
  );
  const selectedServer = selectedServerName
    ? (servers.find((server) => server.name === selectedServerName) ?? null)
    : null;
  const [selectedTool, setSelectedTool] = useState<McpToolInfo | null>(null);
  const [selectedResource, setSelectedResource] =
    useState<McpResourceInfo | null>(null);
  const [serverCursor, setServerCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [toolCursor, setToolCursor] = useState(0);
  const [resourceCursor, setResourceCursor] = useState(0);

  const currentStep = (navigationStack[navigationStack.length - 1] ??
    MCP_MANAGEMENT_STEPS.SERVER_LIST) as McpManagementStep;

  const navigateToStep = (step: string) =>
    setNavigationStack((prev) => [...prev, step]);
  const navigateBack = () =>
    setNavigationStack((prev) => (prev.length <= 1 ? prev : prev.slice(0, -1)));

  const groupedServers = groupMcpServersBySource(servers);
  // Derive the flat navigation list from the grouped render order, not the
  // raw prop order: groupMcpServersBySource reorders by source (user first),
  // so indexing the raw prop would open a different server than highlighted.
  const flatServers = groupedServers.flatMap((group) => group.servers);
  const serverTools = selectedServer
    ? (getServerTools?.(selectedServer) ?? [])
    : [];
  const serverResources = selectedServer
    ? (getServerResources?.(selectedServer) ?? [])
    : [];
  const detailActions = selectedServer
    ? buildMcpServerActions(selectedServer, {
        resourcesSupported: !!getServerResources,
        approveSupported: !!onServerAction,
      })
    : [];

  useKeyboard((key) => {
    const original = toOriginalKey(key);
    const { name } = original;

    if (currentStep === MCP_MANAGEMENT_STEPS.SERVER_LIST) {
      if (name === 'escape') {
        onClose();
        return;
      }
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setServerCursor((prev) =>
          clampNavIndex(prev, flatServers.length, 'up'),
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setServerCursor((prev) =>
          clampNavIndex(prev, flatServers.length, 'down'),
        );
      } else if (name === 'return') {
        const server = flatServers[serverCursor];
        if (server) {
          setSelectedServerName(server.name);
          setActionCursor(0);
          navigateToStep(MCP_MANAGEMENT_STEPS.SERVER_DETAIL);
        }
      }
      return;
    }

    if (name === 'escape') {
      navigateBack();
      return;
    }

    if (currentStep === MCP_MANAGEMENT_STEPS.SERVER_DETAIL) {
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setActionCursor((prev) =>
          clampNavIndex(prev, detailActions.length, 'up'),
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setActionCursor((prev) =>
          clampNavIndex(prev, detailActions.length, 'down'),
        );
      } else if (name === 'return') {
        const action = detailActions[actionCursor];
        if (!action || !selectedServer) return;
        switch (action.action) {
          case 'view-tools':
            setToolCursor(0);
            navigateToStep(MCP_MANAGEMENT_STEPS.TOOL_LIST);
            break;
          case 'view-resources':
            setResourceCursor(0);
            navigateToStep(MCP_MANAGEMENT_STEPS.RESOURCE_LIST);
            break;
          default:
            onServerAction?.(selectedServer, action.action);
        }
      }
      return;
    }

    if (currentStep === MCP_MANAGEMENT_STEPS.TOOL_LIST) {
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setToolCursor((prev) => clampNavIndex(prev, serverTools.length, 'up'));
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setToolCursor((prev) =>
          clampNavIndex(prev, serverTools.length, 'down'),
        );
      } else if (name === 'return') {
        const tool = serverTools[toolCursor];
        if (tool) {
          setSelectedTool(tool);
          navigateToStep(MCP_MANAGEMENT_STEPS.TOOL_DETAIL);
        }
      }
      return;
    }

    if (currentStep === MCP_MANAGEMENT_STEPS.RESOURCE_LIST) {
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setResourceCursor((prev) =>
          clampNavIndex(prev, serverResources.length, 'up'),
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setResourceCursor((prev) =>
          clampNavIndex(prev, serverResources.length, 'down'),
        );
      } else if (name === 'return') {
        const resource = serverResources[resourceCursor];
        if (resource) {
          setSelectedResource(resource);
          navigateToStep(MCP_MANAGEMENT_STEPS.RESOURCE_DETAIL);
        }
      }
    }
  });

  const statusTextColor = (color: 'green' | 'yellow' | 'red' | 'gray') =>
    color === 'green'
      ? C.green
      : color === 'yellow'
        ? C.yellow
        : color === 'red'
          ? C.red
          : C.dim;

  // --- Header ---
  const header = (() => {
    switch (currentStep) {
      case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
        return (
          <text fg={C.accent} attributes={1}>
            {selectedServer?.name || t('Server Detail')}
          </text>
        );
      case MCP_MANAGEMENT_STEPS.TOOL_LIST:
        return (
          <box flexDirection="column">
            <text fg={C.accent} attributes={1}>
              {t('Tools for {{serverName}}', {
                serverName: selectedServer?.name || 'Server',
              })}
            </text>
            <text fg={C.dim}>
              ({serverTools.length}{' '}
              {serverTools.length === 1 ? t('tool') : t('tools')})
            </text>
          </box>
        );
      case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
        return (
          <box flexDirection="column">
            <box flexDirection="row">
              <text fg={C.accent} attributes={1}>
                {selectedTool?.name || t('Tool Detail')}
              </text>
              {selectedTool?.annotations?.destructiveHint && (
                <text fg={C.red}> [{t('destructive')}]</text>
              )}
              {selectedTool?.annotations?.idempotentHint && (
                <text fg={C.yellow}> [{t('idempotent')}]</text>
              )}
              {selectedTool?.annotations?.readOnlyHint && (
                <text fg={C.green}> [{t('read-only')}]</text>
              )}
              {selectedTool?.annotations?.openWorldHint && (
                <text fg={C.text}> [{t('open-world')}]</text>
              )}
            </box>
            <text fg={C.dim}>{t('Server')}</text>
          </box>
        );
      case MCP_MANAGEMENT_STEPS.RESOURCE_LIST:
        return (
          <box flexDirection="column">
            <text fg={C.accent} attributes={1}>
              {t('Resources for {{serverName}}', {
                serverName: selectedServer?.name || 'Server',
              })}
            </text>
            <text fg={C.dim}>
              ({serverResources.length}{' '}
              {serverResources.length === 1 ? t('resource') : t('resources')})
            </text>
          </box>
        );
      case MCP_MANAGEMENT_STEPS.RESOURCE_DETAIL:
        return (
          <box flexDirection="column">
            <text fg={C.accent} attributes={1}>
              {selectedResource?.uri || t('Resource Detail')}
            </text>
            <text fg={C.dim}>{t('Server')}</text>
          </box>
        );
      case MCP_MANAGEMENT_STEPS.AUTHENTICATE:
        return (
          <text fg={C.accent} attributes={1}>
            {t('OAuth Authentication')}
          </text>
        );
      default:
        return (
          <box flexDirection="column">
            <text fg={C.accent} attributes={1}>
              {t('Manage MCP servers')}
            </text>
            <text fg={C.dim}>
              {servers.length}{' '}
              {servers.length === 1 ? t('server') : t('servers')}
            </text>
          </box>
        );
    }
  })();

  // --- Content ---
  const renderServerList = () => {
    if (servers.length === 0) {
      return (
        <box flexDirection="column">
          <text fg={C.dim}>{t('No MCP servers configured.')}</text>
          <text fg={C.dim}>
            {t('Add MCP servers to your settings to get started.')}
          </text>
        </box>
      );
    }
    let flatIndex = 0;
    return (
      <box flexDirection="column">
        {groupedServers.map((group, groupIndex) => {
          const startIndex = flatIndex;
          flatIndex += group.servers.length;
          return (
            <box
              key={group.source}
              flexDirection="column"
              marginBottom={groupIndex === groupedServers.length - 1 ? 0 : 1}
            >
              <text fg={C.text} attributes={1}>
                {`  ${group.displayName}`}
                {group.servers[0]?.configPath ? (
                  <text fg={C.dim}> ({group.servers[0].configPath})</text>
                ) : null}
              </text>
              {group.servers.map((server, itemIndex) => {
                const globalIndex = startIndex + itemIndex;
                const isSelected = globalIndex === serverCursor;
                const color = mcpServerRowColor(server);
                return (
                  <box
                    key={server.name}
                    flexDirection="row"
                    onMouseOver={() => setServerCursor(globalIndex)}
                    onMouseUp={() => {
                      setServerCursor(globalIndex);
                      setSelectedServerName(server.name);
                      setActionCursor(0);
                      navigateToStep(MCP_MANAGEMENT_STEPS.SERVER_DETAIL);
                    }}
                  >
                    <box width={2} flexShrink={0}>
                      <text fg={isSelected ? C.accent : C.text}>
                        {isSelected ? '❯' : ' '}
                      </text>
                    </box>
                    <box width={30} flexShrink={0}>
                      <text fg={isSelected ? C.accent : C.text}>
                        {server.name}
                      </text>
                    </box>
                    <text fg={C.dim}> · </text>
                    <text fg={statusTextColor(color)}>
                      {mcpStatusIcon(server.status)}{' '}
                      {mcpServerStatusText(server)}
                    </text>
                    {server.invalidToolCount > 0 && (
                      <text fg={C.yellow}>
                        {' '}
                        {t('{{count}} invalid tools', {
                          count: String(server.invalidToolCount),
                        })}
                      </text>
                    )}
                  </box>
                );
              })}
            </box>
          );
        })}
        {servers.some(
          (s) =>
            s.status === 'disconnected' && !s.isDisabled && !s.approvalState,
        ) && (
          <box marginTop={1}>
            <text fg={C.yellow}>
              {ICON.REFERENCE} {t('Run qwen --debug to see error logs')}
            </text>
          </box>
        )}
      </box>
    );
  };

  const renderServerDetail = () => {
    if (!selectedServer) {
      return <text fg={C.red}>{t('No server selected')}</text>;
    }
    const rows: Array<{ label: string; value: string }> = [
      { label: t('Status:'), value: mcpServerStatusText(selectedServer) },
      {
        label: t('Source:'),
        value: mcpSourceDisplayName(selectedServer.source),
      },
      {
        label: t('Tools:'),
        value: `${selectedServer.toolCount} ${selectedServer.toolCount === 1 ? t('tool') : t('tools')}`,
      },
      {
        label: t('Prompts:'),
        value: String(selectedServer.promptCount),
      },
      {
        label: t('Resources:'),
        value: String(selectedServer.resourceCount),
      },
    ];
    if (selectedServer.command) {
      rows.splice(2, 0, {
        label: t('Command:'),
        value: selectedServer.command,
      });
    }
    return (
      <box flexDirection="column">
        {rows.map((row) => (
          <box key={row.label} flexDirection="row">
            <box width={20} flexShrink={0}>
              <text fg={C.text}>{row.label}</text>
            </box>
            <text fg={C.text}>{row.value}</text>
          </box>
        ))}
        {selectedServer.error && (
          <box flexDirection="row">
            <box width={20} flexShrink={0}>
              <text fg={C.red}>{t('Error:')}</text>
            </box>
            <text fg={C.red}>{selectedServer.error}</text>
          </box>
        )}
        <box height={1} />
        {detailActions.map((action, index) => {
          const isSelected = index === actionCursor;
          return (
            <box
              key={action.key}
              flexDirection="row"
              onMouseOver={() => setActionCursor(index)}
              onMouseUp={() => {
                setActionCursor(index);
                if (!selectedServer) return;
                switch (action.action) {
                  case 'view-tools':
                    setToolCursor(0);
                    navigateToStep(MCP_MANAGEMENT_STEPS.TOOL_LIST);
                    break;
                  case 'view-resources':
                    setResourceCursor(0);
                    navigateToStep(MCP_MANAGEMENT_STEPS.RESOURCE_LIST);
                    break;
                  default:
                    onServerAction?.(selectedServer, action.action);
                }
              }}
            >
              <box width={2} flexShrink={0}>
                <text fg={isSelected ? C.green : C.text}>
                  {isSelected ? '›' : ' '}
                </text>
              </box>
              <text fg={isSelected ? C.green : C.text}>{action.label}</text>
            </box>
          );
        })}
      </box>
    );
  };

  const renderToolList = () => {
    if (serverTools.length === 0) {
      return <text fg={C.dim}>{t('No tools available for this server.')}</text>;
    }
    return (
      <box flexDirection="column">
        {serverTools.map((tool, index) => {
          const isSelected = index === toolCursor;
          const hints: string[] = [];
          if (tool.annotations?.destructiveHint) hints.push(t('destructive'));
          if (tool.annotations?.readOnlyHint) hints.push(t('read-only'));
          if (tool.annotations?.openWorldHint) hints.push(t('open-world'));
          if (tool.annotations?.idempotentHint) hints.push(t('idempotent'));
          return (
            <box
              key={tool.name}
              flexDirection="row"
              onMouseOver={() => setToolCursor(index)}
              onMouseUp={() => {
                setToolCursor(index);
                setSelectedTool(tool);
                navigateToStep(MCP_MANAGEMENT_STEPS.TOOL_DETAIL);
              }}
            >
              <box width={2} flexShrink={0}>
                <text fg={isSelected ? C.accent : C.text}>
                  {isSelected ? '❯' : ' '}
                </text>
              </box>
              <box width={40} flexShrink={0}>
                <text fg={isSelected ? C.accent : C.text}>{tool.name}</text>
              </box>
              {!tool.isValid ? (
                <text fg={C.yellow}>
                  {t('invalid: {{reason}}', {
                    reason: tool.invalidReason || t('unknown'),
                  })}
                </text>
              ) : hints.length > 0 ? (
                <text fg={C.dim}>{hints.join(', ')}</text>
              ) : null}
            </box>
          );
        })}
      </box>
    );
  };

  const renderToolDetail = () => (
    <box flexDirection="column">
      {selectedTool?.description ? (
        <text fg={C.text}>{selectedTool.description}</text>
      ) : (
        <text fg={C.dim}>{t('(no description)')}</text>
      )}
    </box>
  );

  const renderResourceList = () => {
    if (serverResources.length === 0) {
      return (
        <text fg={C.dim}>{t('No resources available for this server.')}</text>
      );
    }
    return (
      <box flexDirection="column">
        {serverResources.map((resource, index) => {
          const isSelected = index === resourceCursor;
          const friendly =
            resource.title && resource.title !== resource.uri
              ? resource.title
              : resource.name && resource.name !== resource.uri
                ? resource.name
                : '';
          return (
            <box
              key={resource.uri}
              flexDirection="row"
              onMouseOver={() => setResourceCursor(index)}
              onMouseUp={() => {
                setResourceCursor(index);
                setSelectedResource(resource);
                navigateToStep(MCP_MANAGEMENT_STEPS.RESOURCE_DETAIL);
              }}
            >
              <box width={2} flexShrink={0}>
                <text fg={isSelected ? C.accent : C.text}>
                  {isSelected ? '❯' : ' '}
                </text>
              </box>
              <text fg={isSelected ? C.accent : C.text}>{resource.uri}</text>
              {friendly ? <text fg={C.dim}> {friendly}</text> : null}
            </box>
          );
        })}
      </box>
    );
  };

  const renderResourceDetail = () => (
    <box flexDirection="column">
      <text fg={C.text}>{selectedResource?.uri}</text>
      {selectedResource?.name ? (
        <text fg={C.dim}>{selectedResource.name}</text>
      ) : null}
    </box>
  );

  return (
    <DialogFrame>
      {header}
      <box marginTop={1}>
        {currentStep === MCP_MANAGEMENT_STEPS.SERVER_LIST && renderServerList()}
        {currentStep === MCP_MANAGEMENT_STEPS.SERVER_DETAIL &&
          renderServerDetail()}
        {currentStep === MCP_MANAGEMENT_STEPS.TOOL_LIST && renderToolList()}
        {currentStep === MCP_MANAGEMENT_STEPS.TOOL_DETAIL && renderToolDetail()}
        {currentStep === MCP_MANAGEMENT_STEPS.RESOURCE_LIST &&
          renderResourceList()}
        {currentStep === MCP_MANAGEMENT_STEPS.RESOURCE_DETAIL &&
          renderResourceDetail()}
        {currentStep === MCP_MANAGEMENT_STEPS.AUTHENTICATE && (
          <text fg={C.dim}>{t('Loading...')}</text>
        )}
      </box>
      <FooterHint text={mcpStepFooter(currentStep, servers.length)} />
    </DialogFrame>
  );
}
