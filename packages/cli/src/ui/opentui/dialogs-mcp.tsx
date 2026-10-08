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

import { useEffect, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { MCPServerStatus } from '@qwen-code/qwen-code-core/tools/mcp-status.js';
import { ICON } from '../constants.js';
import { toOriginalKey } from './key-map.js';
import { useBatchSafeCursor } from './batch-cursor.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import {
  DialogFrame,
  FooterHint,
  dialogContentWidth,
} from './dialogs-shared.js';
import {
  findNextEnabledIndex,
  followScrollOffset,
  wrappedRows,
} from './dialogs-core.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import {
  clipToWidth,
  getCachedStringWidth,
  sanitizeTerminalLine,
  truncateToWidth,
} from '../utils/textUtils.js';

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

/** ink's VISIBLE_TOOLS_COUNT / VISIBLE_RESOURCES_COUNT. */
const MCP_LIST_MAX_ROWS = 10;
/** ink's ResourceListStep floors the URI column at thirty columns. */
const MCP_RESOURCE_URI_MIN_COLUMNS = 30;

/**
 * Clamp-style navigation — ink's server/tool/resource steps clamp here; the
 * server-detail action list is a radio list and wraps instead.
 */
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
  /** The popup region's row budget; the tool and resource lists window from it. */
  availableTerminalHeight?: number;
}

/**
 * The window a committed frame slices with: the state offset clamped into
 * range, then re-anchored to the cursor when the cursor sits outside it. The
 * state the effect maintains lags one render behind a cursor or budget
 * change, and a list that changed identity (another server's tools, a
 * re-entered step) resets the cursor while the state still holds the previous
 * list's window — an un-anchored return would paint that window with the
 * cursor's row absent while Enter keeps committing it. followScrollOffset
 * leaves an in-window cursor's offset untouched, so a hover still cannot
 * shift the window under the pointer; a zero-row window has no anchor to
 * follow to, so the offset only clamps.
 */
export function resolveFollowScrollOffset(
  offset: number,
  cursor: number,
  itemCount: number,
  windowRows: number,
): number {
  const clamped = Math.max(
    0,
    Math.min(offset, Math.max(0, itemCount - windowRows)),
  );
  if (windowRows < 1) return clamped;
  return followScrollOffset(cursor, clamped, itemCount, windowRows);
}

/**
 * BaseSelectionList's scroll-follow for the tool/resource lists: the window
 * lives in state and only moves when the cursor's row would leave it, so a
 * hover — which sets the cursor to a painted row — can never shift the window
 * under the pointer. Deriving the offset from the cursor on every render pins
 * the cursor to the window's bottom edge instead, and a click then opens a
 * different row than the one it landed on.
 */
function useFollowScrollOffset(
  cursor: number,
  itemCount: number,
  windowRows: number,
): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (windowRows < 1) return;
    const next = followScrollOffset(cursor, offset, itemCount, windowRows);
    if (next !== offset) setOffset(next);
  }, [cursor, offset, itemCount, windowRows]);
  return resolveFollowScrollOffset(offset, cursor, itemCount, windowRows);
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
  const {
    cursor: serverCursor,
    cursorRef: serverCursorRef,
    setCursor: setServerCursor,
  } = useBatchSafeCursor();
  const {
    cursor: actionCursor,
    cursorRef: actionCursorRef,
    setCursor: setActionCursor,
  } = useBatchSafeCursor();
  const {
    cursor: toolCursor,
    cursorRef: toolCursorRef,
    setCursor: setToolCursor,
  } = useBatchSafeCursor();
  const {
    cursor: resourceCursor,
    cursorRef: resourceCursorRef,
    setCursor: setResourceCursor,
  } = useBatchSafeCursor();

  // The frame (4), the two-row step header, the body's margin row (1) and
  // the footer hint (2) come off the region first; all four cursor-driven
  // bodies — the server list, the detail's action column, and the tool and
  // resource lists — window from what is left instead of mapping every row
  // into the clipped frame, where the cursor kept walking rows nothing
  // painted and Enter opened them. A zero-row window refuses the arrows and
  // Enter the way the shared list hook does.
  const regionHeight = clampDialogHeight(props.availableTerminalHeight);
  const listWindowRows =
    regionHeight === undefined
      ? MCP_LIST_MAX_ROWS
      : Math.max(0, Math.min(MCP_LIST_MAX_ROWS, regionHeight - 9));
  // ink windows only the tool and resource lists (VISIBLE_*_COUNT); the
  // server list and the detail column are unwindowed there, so they pay out
  // of the full region budget instead of the ten-row cap — a tall region
  // paints every row it can pay for.
  const bodyWindowRows =
    regionHeight === undefined ? undefined : Math.max(0, regionHeight - 9);
  const { width } = useTerminalDimensions();
  const contentWidth = dialogContentWidth(width);

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

  // The server list's rows are not 1:1 with the servers: each group paints a
  // header row, and groups after the first pay the group box's marginBottom.
  // The window charges those rows by windowing over the flat row list, with
  // the cursor's position mapped to its row.
  type ServerRow =
    | { kind: 'gap'; key: string }
    | { kind: 'hint'; key: string }
    | { kind: 'header'; key: string; displayName: string; configPath?: string }
    | {
        kind: 'server';
        key: string;
        server: McpServerInfo;
        flatIndex: number;
      };
  const serverRows: ServerRow[] = [];
  {
    let flatIndex = 0;
    groupedServers.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        serverRows.push({ kind: 'gap', key: `gap-${group.source}` });
      }
      serverRows.push({
        kind: 'header',
        key: `header-${group.source}`,
        displayName: group.displayName,
        configPath: group.servers[0]?.configPath,
      });
      for (const server of group.servers) {
        serverRows.push({
          kind: 'server',
          key: server.name,
          server,
          flatIndex,
        });
        flatIndex += 1;
      }
    });
    // The debug hint's margin and text rows window with the list.
    if (
      serverRows.length > 0 &&
      servers.some(
        (s) => s.status === 'disconnected' && !s.isDisabled && !s.approvalState,
      )
    ) {
      serverRows.push({ kind: 'gap', key: 'debug-gap' });
      serverRows.push({ kind: 'hint', key: 'debug-hint' });
    }
  }
  const serverCursorRow = Math.max(
    0,
    serverRows.findIndex(
      (row) => row.kind === 'server' && row.flatIndex === serverCursor,
    ),
  );
  const serverWindowRows = bodyWindowRows ?? serverRows.length;
  const serverListOffset = useFollowScrollOffset(
    serverCursorRow,
    serverRows.length,
    serverWindowRows,
  );

  // The detail step is one flat column — the info rows, the spacer, then the
  // action rows — and the window follows the action cursor in physical rows,
  // so Enter always commits a painted action even when a wrapped info value
  // costs more rows than one.
  const detailInfoRows: Array<{ label: string; value: string; red?: boolean }> =
    selectedServer
      ? [
          {
            label: t('Status:'),
            value: mcpServerStatusText(selectedServer),
          },
          {
            label: t('Source:'),
            value: mcpSourceDisplayName(selectedServer.source),
          },
          ...(selectedServer.command
            ? [{ label: t('Command:'), value: selectedServer.command }]
            : []),
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
          ...(selectedServer.error
            ? [{ label: t('Error:'), value: selectedServer.error, red: true }]
            : []),
        ]
      : [];
  // The info values paint as many rows as they wrap into — the Error row is
  // the only diagnostic the dialog carries — so each is charged those rows
  // at its column; the spacer and the action rows are one row each. The
  // window follows the action cursor in physical rows, so Enter always
  // commits a painted action even when a wrapped value costs more rows than
  // one.
  const detailValueWidth = Math.max(1, contentWidth - 20);
  const naturalDetailRows: number[] =
    detailInfoRows.length === 0
      ? []
      : [
          ...detailInfoRows.map((row) =>
            wrappedRows(sanitizeTerminalLine(row.value), detailValueWidth),
          ),
          1,
          ...detailActions.map(() => 1),
        ];
  // An info value taller than the whole window (a parse error out of a bad
  // handshake) would make the whole-entry paint predicate below
  // unsatisfiable — the Error row, the only diagnostics the dialog carries,
  // would never paint while Enter still commits the action rows below it.
  // Only that case caps: the entry charges the window minus the rows the
  // entries below it pay, and the paint clips to the same rows, so the
  // value's leading rows and the actions can paint together.
  const detailWindowCap =
    bodyWindowRows === undefined ? undefined : Math.max(1, bodyWindowRows);
  const detailEntryRows: number[] = new Array(naturalDetailRows.length);
  {
    let rowsBelow = 0;
    for (let i = naturalDetailRows.length - 1; i >= 0; i--) {
      const natural = naturalDetailRows[i]!;
      detailEntryRows[i] =
        detailWindowCap !== undefined && natural > detailWindowCap
          ? Math.max(1, detailWindowCap - rowsBelow)
          : natural;
      rowsBelow += detailEntryRows[i]!;
    }
  }
  const detailRowStarts: number[] = [];
  let detailRowCount = 0;
  for (const rows of detailEntryRows) {
    detailRowStarts.push(detailRowCount);
    detailRowCount += rows;
  }
  const detailCursorRow =
    detailRowStarts[
      Math.min(
        detailInfoRows.length + 1 + actionCursor,
        Math.max(0, detailEntryRows.length - 1),
      )
    ] ?? 0;
  const detailWindowRows = bodyWindowRows ?? detailRowCount;
  const detailOffset = useFollowScrollOffset(
    detailCursorRow,
    detailRowCount,
    detailWindowRows,
  );

  const toolScrollOffset = useFollowScrollOffset(
    toolCursor,
    serverTools.length,
    listWindowRows,
  );
  const resourceScrollOffset = useFollowScrollOffset(
    resourceCursor,
    serverResources.length,
    listWindowRows,
  );

  useKeyboard((key) => {
    const original = toOriginalKey(key);
    const { name } = original;

    if (currentStep === MCP_MANAGEMENT_STEPS.SERVER_LIST) {
      if (name === 'escape') {
        onClose();
        return;
      }

      // The same zero-row refusal the tool and resource lists have: with no
      // row painted, the arrows would walk an invisible cursor and Enter
      // would open a server the user never saw highlighted. Escape stays live
      // above — it addresses the dialog, not a row.
      if (serverWindowRows < 1) return;
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setServerCursor(
          clampNavIndex(serverCursorRef.current, flatServers.length, 'up'),
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setServerCursor(
          clampNavIndex(serverCursorRef.current, flatServers.length, 'down'),
        );
      } else if (name === 'return') {
        const server = flatServers[serverCursorRef.current];
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
      if (detailWindowRows < 1) return;
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setActionCursor(
          findNextEnabledIndex(detailActions, actionCursorRef.current, 'up'),
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setActionCursor(
          findNextEnabledIndex(detailActions, actionCursorRef.current, 'down'),
        );
      } else if (name === 'return') {
        const action = detailActions[actionCursorRef.current];
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
      if (listWindowRows < 1) return;
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setToolCursor(
          clampNavIndex(toolCursorRef.current, serverTools.length, 'up'),
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setToolCursor(
          clampNavIndex(toolCursorRef.current, serverTools.length, 'down'),
        );
      } else if (name === 'return') {
        const tool = serverTools[toolCursorRef.current];
        if (tool) {
          setSelectedTool(tool);
          navigateToStep(MCP_MANAGEMENT_STEPS.TOOL_DETAIL);
        }
      }
      return;
    }

    if (currentStep === MCP_MANAGEMENT_STEPS.RESOURCE_LIST) {
      if (listWindowRows < 1) return;
      if (keyMatchers[Command.SELECTION_UP](original)) {
        setResourceCursor(
          clampNavIndex(
            resourceCursorRef.current,
            serverResources.length,
            'up',
          ),
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](original)) {
        setResourceCursor(
          clampNavIndex(
            resourceCursorRef.current,
            serverResources.length,
            'down',
          ),
        );
      } else if (name === 'return') {
        const resource = serverResources[resourceCursorRef.current];
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
    const visibleRows = serverRows.slice(
      serverListOffset,
      serverListOffset + serverWindowRows,
    );
    return (
      <box flexDirection="column">
        {visibleRows.map((row) => {
          if (row.kind === 'gap') {
            return <box key={row.key} height={1} />;
          }
          if (row.kind === 'hint') {
            return (
              <box key={row.key} flexDirection="row">
                <text fg={C.yellow}>
                  {clipToWidth(
                    `${ICON.REFERENCE} ${t('Run qwen --debug to see error logs')}`,
                    contentWidth,
                  )}
                </text>
              </box>
            );
          }
          if (row.kind === 'header') {
            // Every row the window paints is charged one physical row, so
            // the config path — a real filesystem path — clips to what the
            // group name leaves instead of wrapping onto a second row.
            const nameRun = `  ${row.displayName}`;
            return (
              <box key={row.key} flexDirection="row">
                <text fg={C.text} attributes={1}>
                  {clipToWidth(sanitizeTerminalLine(nameRun), contentWidth)}
                </text>
                {row.configPath ? (
                  <text fg={C.dim}>
                    {clipToWidth(
                      sanitizeTerminalLine(` (${row.configPath})`),
                      Math.max(0, contentWidth - getCachedStringWidth(nameRun)),
                    )}
                  </text>
                ) : null}
              </box>
            );
          }
          const server = row.server;
          const isSelected = row.flatIndex === serverCursor;
          const color = mcpServerRowColor(server);
          // The row is charged one physical row: the marker (2), the name
          // column (30) and the ' · ' separator come off first, and the
          // status run and the invalid-tools run split what is left, in
          // that order.
          const statusRun = clipToWidth(
            sanitizeTerminalLine(
              `${mcpStatusIcon(server.status)} ${mcpServerStatusText(server)}`,
            ),
            Math.max(0, contentWidth - 35),
          );
          const invalidRunBudget = Math.max(
            0,
            contentWidth - 35 - getCachedStringWidth(statusRun),
          );
          return (
            <box
              key={row.key}
              flexDirection="row"
              onMouseOver={() => setServerCursor(row.flatIndex)}
              onMouseUp={() => {
                setServerCursor(row.flatIndex);
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
                  {truncateToWidth(sanitizeTerminalLine(server.name), 30)}
                </text>
              </box>
              <text fg={C.dim}> · </text>
              <text fg={statusTextColor(color)}>{statusRun}</text>
              {server.invalidToolCount > 0 && (
                <text fg={C.yellow}>
                  {clipToWidth(
                    sanitizeTerminalLine(
                      ` ${t('{{count}} invalid tools', {
                        count: String(server.invalidToolCount),
                      })}`,
                    ),
                    invalidRunBudget,
                  )}
                </text>
              )}
            </box>
          );
        })}
      </box>
    );
  };

  const renderServerDetail = () => {
    if (!selectedServer) {
      return <text fg={C.red}>{t('No server selected')}</text>;
    }
    // One flat column, windowed from the region's budget: each info value
    // wraps at its column and is charged the rows it wraps into (the command
    // comes from the settings file and can be far longer than the width),
    // and the window follows the action cursor so Enter always commits a
    // painted action.
    const flatRows: Array<
      | {
          kind: 'info';
          key: string;
          label: string;
          value: string;
          red: boolean;
        }
      | { kind: 'spacer'; key: string }
      | {
          kind: 'action';
          key: string;
          action: (typeof detailActions)[number];
          index: number;
        }
    > = [
      ...detailInfoRows.map((row) => ({
        kind: 'info' as const,
        key: row.label,
        label: row.label,
        value: row.value,
        red: row.red ?? false,
      })),
      { kind: 'spacer' as const, key: 'spacer' },
      ...detailActions.map((action, index) => ({
        kind: 'action' as const,
        key: action.key,
        action,
        index,
      })),
    ];
    // Entries paint whole and only when they fit inside the window: an info
    // row's charge is capped at the window above, so the predicate below is
    // always satisfiable, and the cursor's one-row action always fits the
    // window the follow rule pins it into.
    const visibleRows = flatRows
      .map((row, index) => ({
        row,
        start: detailRowStarts[index] ?? 0,
        chargedRows: detailEntryRows[index] ?? 1,
      }))
      .filter(
        ({ start, chargedRows }) =>
          start >= detailOffset &&
          start + chargedRows <= detailOffset + detailWindowRows,
      );
    return (
      <box flexDirection="column">
        {visibleRows.map(({ row, chargedRows }) => {
          if (row.kind === 'spacer') {
            return <box key={row.key} height={1} />;
          }
          if (row.kind === 'info') {
            return (
              <box key={row.key} flexDirection="row">
                <box width={20} flexShrink={0}>
                  <text fg={row.red ? C.red : C.text}>{row.label}</text>
                </box>
                <text fg={row.red ? C.red : C.text}>
                  {clipToWidth(
                    sanitizeTerminalLine(row.value),
                    detailValueWidth * chargedRows,
                  )}
                </text>
              </box>
            );
          }
          const action = row.action;
          const isSelected = row.index === actionCursor;
          return (
            <box
              key={row.key}
              flexDirection="row"
              onMouseOver={() => setActionCursor(row.index)}
              onMouseUp={() => {
                setActionCursor(row.index);
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
              <text fg={isSelected ? C.green : C.text}>
                {clipToWidth(
                  sanitizeTerminalLine(action.label),
                  Math.max(0, contentWidth - 2),
                )}
              </text>
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
    // ink ToolListStep's following window: the cursor's row is always painted.
    const offset = toolScrollOffset;
    const visibleTools = serverTools.slice(offset, offset + listWindowRows);
    return (
      <box flexDirection="column">
        {visibleTools.map((tool, visibleIndex) => {
          const index = offset + visibleIndex;
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
                <text fg={isSelected ? C.accent : C.text}>
                  {truncateToWidth(sanitizeTerminalLine(tool.name), 40)}
                </text>
              </box>
              {!tool.isValid ? (
                <text fg={C.yellow}>
                  {clipToWidth(
                    sanitizeTerminalLine(
                      t('invalid: {{reason}}', {
                        reason: tool.invalidReason || t('unknown'),
                      }),
                    ),
                    Math.max(0, contentWidth - 42),
                  )}
                </text>
              ) : hints.length > 0 ? (
                <text fg={C.dim}>
                  {clipToWidth(
                    sanitizeTerminalLine(hints.join(', ')),
                    Math.max(0, contentWidth - 42),
                  )}
                </text>
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
    const offset = resourceScrollOffset;
    const visibleResources = serverResources.slice(
      offset,
      offset + listWindowRows,
    );
    return (
      <box flexDirection="column">
        {visibleResources.map((resource, visibleIndex) => {
          const index = offset + visibleIndex;
          const isSelected = index === resourceCursor;
          const friendly = sanitizeTerminalLine(
            resource.title && resource.title !== resource.uri
              ? resource.title
              : resource.name && resource.name !== resource.uri
                ? resource.name
                : '',
          );
          const friendlyRun = friendly ? ` ${friendly}` : '';
          const friendlyWidth = getCachedStringWidth(friendlyRun);
          const uriRun = truncateToWidth(
            sanitizeTerminalLine(resource.uri),
            Math.min(
              Math.max(
                contentWidth - 2 - friendlyWidth,
                MCP_RESOURCE_URI_MIN_COLUMNS,
              ),
              Math.max(0, contentWidth - 2),
            ),
          );
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
              <text fg={isSelected ? C.accent : C.text}>{uriRun}</text>
              {friendlyRun ? (
                <text fg={C.dim}>
                  {clipToWidth(
                    friendlyRun,
                    Math.max(
                      0,
                      contentWidth - 2 - getCachedStringWidth(uriRun),
                    ),
                  )}
                </text>
              ) : null}
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
