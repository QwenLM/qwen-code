/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDisplayString, type Config } from '@qwen-code/core';
import type { UIState } from '../contexts/UIStateContext.js';
import type { PendingHistoryValue } from '../contexts/PendingHistoryContext.js';
import { getBackgroundTaskStatusCount } from './backgroundTaskStatus.js';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';

const MAX_SNAPSHOT_CHARS = 512 * 1024;
const MAX_HISTORY_ITEMS = 30;
const MAX_PENDING_ITEMS = 20;
const MAX_MESSAGE_QUEUE_ITEMS = 10;
const MAX_TEXT_CHARS = 1200;
const MAX_TOOL_ITEMS = 12;

export interface BuildTuiTextSnapshotParams {
  /** Invoking session; model display names come from its model snapshot. */
  config: Config;
  uiState: UIState;
  /** Streaming pending items; they no longer live on UIState. */
  pendingHistory?: PendingHistoryValue;
  now?: Date;
}

export async function buildTuiTextSnapshot({
  config,
  uiState,
  pendingHistory,
  now = new Date(),
}: BuildTuiTextSnapshotParams): Promise<string> {
  const lines: string[] = [];

  lines.push('TUI Text Snapshot');
  lines.push('=================');
  lines.push('');

  addSection(lines, 'Capture');
  addField(lines, 'captured_at', now.toISOString());
  addField(
    lines,
    'terminal',
    `${uiState.terminalWidth}x${uiState.terminalHeight}`,
  );
  addField(lines, 'snapshot_scope', 'structured TUI state, not visible screen');
  addField(lines, 'branch', uiState.branchName);
  addField(
    lines,
    'model_display_name',
    await getModelDisplayName(config, uiState.currentModel),
  );
  addField(lines, 'reasoning_effort', uiState.currentReasoningEffort);
  addField(lines, 'context_window', uiState.currentContextWindow);
  addField(lines, 'permission_mode', uiState.showPermissionModeIndicator);
  addField(lines, 'streaming_state', uiState.streamingState);
  addField(lines, 'input_active', formatBoolean(uiState.isInputActive));
  addField(lines, 'is_resuming', formatBoolean(uiState.isResuming));
  addField(
    lines,
    'config_initialized',
    formatBoolean(uiState.isConfigInitialized),
  );
  addField(
    lines,
    'trusted_folder',
    formatBooleanOrUnknown(uiState.isTrustedFolder),
  );
  addField(lines, 'errors_seen', uiState.errorCount);
  const projectedBackgroundTaskCount = getBackgroundTaskStatusCount({
    tasks: uiState.unifiedTasks ?? [],
  });
  addField(
    lines,
    'background_tasks',
    projectedBackgroundTaskCount || uiState.unifiedRunningCount,
  );
  addField(lines, 'active_shell_id', uiState.activeShellId);
  addField(lines, 'dialogs_visible', formatBoolean(uiState.dialogsVisible));
  addField(lines, 'active_dialogs', formatList(getActiveDialogs(uiState)));
  if (uiState.transientMessage) {
    addField(
      lines,
      'transient_message',
      `${uiState.transientMessage.type}: ${truncateText(
        uiState.transientMessage.text,
      )}`,
    );
  }
  lines.push('');

  addSection(lines, 'Layout');
  addField(lines, 'main_area_width', uiState.mainAreaWidth);
  addField(lines, 'available_terminal_height', uiState.availableTerminalHeight);
  addField(lines, 'stable_controls_height', uiState.stableControlsHeight);
  addField(
    lines,
    'static_area_max_item_height',
    uiState.staticAreaMaxItemHeight,
  );
  addField(lines, 'static_extra_height', uiState.staticExtraHeight);
  addField(lines, 'constrain_height', formatBoolean(uiState.constrainHeight));
  addField(lines, 'render_markdown', formatBoolean(uiState.renderMarkdown));
  addField(
    lines,
    'show_error_details',
    formatBoolean(uiState.showErrorDetails),
  );
  lines.push('');

  addSection(lines, 'Queues');
  addField(lines, 'message_queue_count', uiState.messageQueue.length);
  addField(lines, 'queue_error', uiState.queueErrorMessage);
  addField(lines, 'model_queue_status', uiState.activeModelQueue?.status);
  addField(lines, 'model_queue_progress', uiState.activeModelQueue?.progress);
  addField(
    lines,
    'model_queue_wait_time_ms',
    uiState.activeModelQueue?.waitTimeMs,
  );
  for (const [index, message] of uiState.messageQueue
    .slice(-MAX_MESSAGE_QUEUE_ITEMS)
    .entries()) {
    addField(lines, `queued_message_${index + 1}`, truncateText(message));
  }
  lines.push('');

  appendHistorySection(
    lines,
    'Recent History',
    uiState.history,
    MAX_HISTORY_ITEMS,
  );
  appendHistorySection(
    lines,
    'Pending Display Items',
    pendingHistory?.pendingHistoryItems ?? [],
    MAX_PENDING_ITEMS,
  );
  appendHistorySection(
    lines,
    'Pending Assistant Items',
    pendingHistory?.pendingGeminiHistoryItems ?? [],
    MAX_PENDING_ITEMS,
  );

  return truncateSnapshot(lines.join('\n') + '\n');
}

function addSection(lines: string[], title: string): void {
  lines.push(title);
  lines.push('-'.repeat(title.length));
}

function addField(
  lines: string[],
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  lines.push(`${key}: ${formatValue(value)}`);
}

function formatValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value === undefined || value === null || value === '') {
    return '(none)';
  }
  return String(value);
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no';
}

function formatBooleanOrUnknown(value: boolean | undefined): string {
  return value === undefined ? 'unknown' : formatBoolean(value);
}

async function getModelDisplayName(
  config: Config,
  model: string | undefined,
): Promise<string | undefined> {
  if (!model) {
    return undefined;
  }
  const listed = await config.getModelProviderManager().getModel(model);
  return getDisplayString(listed, model);
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function getActiveDialogs(uiState: UIState): string[] {
  const entries: Array<[string, boolean]> = [
    ['theme', uiState.isThemeDialogOpen],
    ['editor', uiState.isEditorDialogOpen],
    ['settings', uiState.isSettingsDialogOpen],
    ['session_browser', uiState.isSessionBrowserOpen],
    ['agent_config', uiState.isAgentConfigDialogOpen],
    ['agent_browser', uiState.isAgentBrowserOpen],
    ['mcp_browser', uiState.isMcpBrowserOpen],
    ['hook_browser', uiState.isHookBrowserOpen],
    ['hook_config', uiState.isHookConfigDialogOpen],
    ['skill_browser', uiState.isSkillBrowserOpen],
    ['skill_detail', uiState.isSkillDetailViewOpen],
    ['config_error_detail', uiState.isConfigErrorDetailOpen],
    ['plugin_browser', uiState.isPluginBrowserOpen],
    ['worktree_exit', uiState.isWorktreeExitDialogOpen],
    ['folder_trust', uiState.isFolderTrustDialogOpen],
    ['mcp_approval', uiState.isMcpApprovalDialogOpen],
    ['external_import_approval', uiState.isExternalImportApprovalOpen],
    ['custom', !!uiState.customDialog],
    ['fullscreen', !!uiState.fullScreenDialog],
  ];

  return entries.filter(([, active]) => active).map(([name]) => name);
}

function appendHistorySection(
  lines: string[],
  title: string,
  items: ReadonlyArray<HistoryItem | HistoryItemWithoutId>,
  maxItems: number,
): void {
  addSection(lines, title);
  if (items.length === 0) {
    lines.push('(none)');
    lines.push('');
    return;
  }

  const omitted = Math.max(0, items.length - maxItems);
  if (omitted > 0) {
    lines.push(`... ${omitted} older item(s) omitted ...`);
  }

  for (const [index, item] of items.slice(-maxItems).entries()) {
    lines.push(formatHistoryItem(item, index + omitted));
  }
  lines.push('');
}

function formatHistoryItem(
  item: HistoryItem | HistoryItemWithoutId,
  index: number,
): string {
  const id = 'id' in item ? `#${item.id}` : `pending-${index + 1}`;
  const summary = summarizeHistoryItem(item);
  return `[${id}] ${formatHistoryItemType(item.type)}\n${indent(summary)}`;
}

function formatHistoryItemType(type: HistoryItemWithoutId['type']): string {
  switch (type) {
    case 'gemini':
    case 'gemini_content':
      return 'assistant';
    default:
      return type;
  }
}

function summarizeHistoryItem(
  item: HistoryItem | HistoryItemWithoutId,
): string {
  switch (item.type) {
    case 'user':
    case 'user_shell':
    case 'gemini':
    case 'gemini_content':
    case 'info':
    case 'error':
    case 'warning':
    case 'hint':
      return truncateText(item.text);
    case 'about':
      return [
        `cli_version=${item.cliVersion}`,
        `os_version=${item.osVersion}`,
        `model_version=${item.modelVersion}`,
        `auth_type=${item.selectedAuthType}`,
      ].join('\n');
    case 'help':
      return `timestamp=${item.timestamp.toISOString()}`;
    case 'stats':
      return [
        `duration=${item.duration}`,
        `model=${formatValue(item.currentModel)}`,
      ].join('\n');
    case 'model_stats':
      return [`model=${formatValue(item.currentModel)}`].join('\n');
    case 'tool_stats':
      return 'tool stats rendered';
    case 'model':
      return `model=${item.model}`;
    case 'quit':
      return `duration=${item.duration}`;
    case 'compression':
      return stringifyPreview(item.compression);
    case 'model_queue':
      return [
        `status=${item.modelQueue.status}`,
        `progress=${item.modelQueue.progress}`,
        `queue_count=${formatValue(item.modelQueue.queueCount)}`,
        `wait_time_ms=${formatValue(item.modelQueue.waitTimeMs)}`,
        `wait_elapsed_ms=${formatValue(item.modelQueue.waitElapsedMs)}`,
        `max_wait_ms=${formatValue(item.modelQueue.maxWaitMs)}`,
        `model=${formatValue(item.modelQueue.modelKey)}`,
      ].join('\n');
    case 'tool_group':
      return summarizeTools(item.tools);
    case 'thinking':
      return stringifyPreview(item.thought);
    case 'custom_content':
      return 'custom React content';
    case 'subagent':
      return [
        `agent=${item.agentName}`,
        `messages=${item.messages.length}`,
        `parent_tool_use_id=${formatValue(item.parentToolUseId)}`,
      ].join('\n');
    default: {
      const unexpectedItem: never = item;
      return stringifyPreview(unexpectedItem);
    }
  }
}

function summarizeTools(tools: IndividualToolCallDisplay[]): string {
  if (tools.length === 0) {
    return '(no tools)';
  }

  const lines = tools.slice(0, MAX_TOOL_ITEMS).map((tool, index) => {
    const title = tool.displayTitle || tool.description || '(no title)';
    const progress =
      tool.progress !== undefined && tool.progressTotal !== undefined
        ? ` progress=${tool.progress}/${tool.progressTotal}`
        : '';
    return `${index + 1}. ${tool.status} ${tool.name}: ${truncateText(
      title,
      240,
    )}${progress}`;
  });

  const omitted = tools.length - lines.length;
  if (omitted > 0) {
    lines.push(`... ${omitted} more tool(s) omitted ...`);
  }
  return lines.join('\n');
}

function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function stringifyPreview(value: unknown): string {
  try {
    const text = JSON.stringify(
      value,
      (_key, nestedValue: unknown) => {
        if (typeof nestedValue === 'function') {
          return '[function]';
        }
        if (typeof nestedValue === 'bigint') {
          return nestedValue.toString();
        }
        return nestedValue;
      },
      2,
    );
    return truncateText(text ?? String(value));
  } catch {
    return truncateText(String(value));
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function truncateSnapshot(snapshot: string): string {
  if (snapshot.length <= MAX_SNAPSHOT_CHARS) {
    return snapshot;
  }
  return `${snapshot.slice(
    0,
    MAX_SNAPSHOT_CHARS,
  )}\n... [snapshot truncated ${snapshot.length - MAX_SNAPSHOT_CHARS} chars]\n`;
}
