/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonShellTranscriptBlock,
  DaemonStatusTranscriptBlock,
  DaemonUserShellTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonMessage,
  DaemonMessageToolCall,
  DaemonMessageToolCallContent,
  DaemonMessageToolCallStatus,
  DaemonMessageToolKind,
  DaemonMessageTodoItem,
  DaemonUserMessage,
} from './messageTypes.js';
import { isTodoWriteToolName } from '../utils/todos.js';

interface PermissionToolInfo {
  title?: string;
  args?: Record<string, unknown>;
}

type DaemonPermissionTranscriptBlock = Extract<
  DaemonTranscriptBlock,
  { kind: 'permission' }
>;

type ExtendedDaemonStatusTranscriptBlock = DaemonStatusTranscriptBlock & {
  source?: string;
  data?: unknown;
};

type ExtendedDaemonTextTranscriptBlock = DaemonTextTranscriptBlock & {
  meta?: Record<string, unknown>;
};

interface TranscriptMessageLabels {
  promptCancelled?: string;
  branchSuccess?: (name: string) => string;
}

interface TranscriptMessageOptions {
  labels?: TranscriptMessageLabels;
}

function isIgnoredWebShellStatus(text: string): boolean {
  return (
    text.startsWith('language_changed (unrecognized daemon event):') ||
    text.startsWith('Model switched: ')
  );
}

function getSessionBranchDisplayName(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const branchData = data as {
    displayName?: unknown;
    newSessionId?: unknown;
  };
  if (typeof branchData.displayName === 'string' && branchData.displayName) {
    return branchData.displayName;
  }
  return typeof branchData.newSessionId === 'string'
    ? branchData.newSessionId.slice(0, 8)
    : null;
}

function isBackgroundNotificationAssistantBlock(
  block: DaemonTextTranscriptBlock,
): boolean {
  const extended = block as ExtendedDaemonTextTranscriptBlock;
  const meta = extended.meta;
  return (
    meta?.['source'] === 'background_notification' &&
    meta['qwenDiscreteMessage'] === true &&
    meta['backgroundTask'] !== undefined
  );
}

function normalizeAssistantTextBlock(
  block: DaemonTextTranscriptBlock,
): DaemonTextTranscriptBlock | null {
  if (isBackgroundNotificationAssistantBlock(block)) return null;
  if (!block.text && !block.usage) return null;
  return block;
}

function isTextBlockEmpty(block: DaemonTextTranscriptBlock): boolean {
  return block.text.length === 0;
}

function parseDaemonTodoItemsFromEntries(
  entries: readonly unknown[],
): DaemonMessageTodoItem[] | undefined {
  const todos = entries.flatMap((entry, index): DaemonMessageTodoItem[] => {
    const item = getRecord(entry);
    const content = getString(item, 'content');
    if (!content) return [];
    const id = getString(item, 'id') ?? `plan-${index}`;
    return [
      {
        id,
        content,
        status: getTodoStatus(getString(item, 'status')),
        ...(() => {
          const priority = getTodoPriority(getString(item, 'priority'));
          return priority ? { priority } : {};
        })(),
      },
    ];
  });
  return todos.length > 0 ? todos : undefined;
}

/**
 * Sum the per-block token usage the SDK reducer stamped onto assistant blocks
 * when several merge into one rendered message. Returns undefined when neither
 * side has usage, so the message field stays absent rather than a spurious 0/0.
 */
function mergeAssistantUsage(
  a:
    | { inputTokens: number; outputTokens: number; cachedTokens?: number }
    | undefined,
  b:
    | { inputTokens: number; outputTokens: number; cachedTokens?: number }
    | undefined,
):
  | { inputTokens: number; outputTokens: number; cachedTokens?: number }
  | undefined {
  if (!a) return b;
  if (!b) return a;
  const cachedTokens = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

export function transcriptBlocksToDaemonMessages(
  blocks: readonly DaemonTranscriptBlock[],
  options: TranscriptMessageOptions = {},
): DaemonMessage[] {
  const messages: DaemonMessage[] = [];
  const promptCancelledText =
    options.labels?.promptCancelled ?? 'Request cancelled.';
  // Replay can contain thousands of blocks. Keep tool calls indexed by callId
  // so later tool updates, parented children, and permission placeholders
  // merge in O(1)
  // instead of scanning the rendered message list for every block.
  // Subagent-owned assistant/thought/tool blocks are expected to carry
  // parentToolCallId; unparented blocks are rendered as top-level transcript.
  const toolsByCallId = new Map<string, DaemonMessageToolCall>();
  const permissionToolInfoByCallId = new Map<string, PermissionToolInfo>();
  let currentAssistantIdx: number | null = null;
  // Tool cards are standalone transcript turns. Once a tool is emitted,
  // the next top-level assistant/thought block must start a fresh assistant
  // message instead of being appended to text that appeared before the tool.
  let needsNewContentMessage = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // Wall-clock of this block, surfaced as a hover tooltip on the rendered
    // message. Prefer the daemon-authoritative stamp so every client agrees;
    // fall back to the local receive time when the daemon left it unset.
    const blockTime = block.serverTimestamp ?? block.clientReceivedAt;

    switch (block.kind) {
      case 'user': {
        currentAssistantIdx = null;
        needsNewContentMessage = false;
        const textBlock = block as DaemonTextTranscriptBlock;
        const msg: DaemonUserMessage = {
          id: block.id,
          role: 'user',
          content: textBlock.text,
          timestamp: blockTime,
        };
        // Attach images if present
        if (textBlock.images && textBlock.images.length > 0) {
          msg.images = textBlock.images.map((img) => ({
            data: img.data,
            mimeType: img.mimeType || 'image/*',
          }));
        }
        messages.push(msg);
        break;
      }

      case 'assistant': {
        const textBlock = normalizeAssistantTextBlock(
          block as DaemonTextTranscriptBlock,
        );
        if (!textBlock) break;

        const parentSubAgent = textBlock.parentToolCallId
          ? toolsByCallId.get(textBlock.parentToolCallId)
          : undefined;
        if (parentSubAgent) {
          appendSubContent(parentSubAgent, textBlock.text);
          break;
        }

        const insightSegments = splitInsightSegments(textBlock.text);
        if (insightSegments) {
          let lastProgress: ParsedInsight | null = null;
          let hasTerminal = false;
          let readyCount = 0;
          let errorCount = 0;
          for (const seg of insightSegments) {
            if (seg.kind === 'insight') {
              if (seg.data.type === 'insight_progress') {
                lastProgress = seg.data;
              } else if (seg.data.type === 'insight_ready') {
                hasTerminal = true;
                messages.push({
                  id: `${block.id}-ir-${readyCount++}`,
                  role: 'insight_ready',
                  path: seg.data.path,
                  timestamp: blockTime,
                });
              } else if (seg.data.type === 'insight_error') {
                hasTerminal = true;
                messages.push({
                  id: `${block.id}-ie-${errorCount++}`,
                  role: 'insight_error',
                  error: seg.data.error,
                  timestamp: blockTime,
                });
              }
            } else {
              messages.push({
                id: `${block.id}-t-${messages.length}`,
                role: 'assistant',
                content: seg.text,
                timestamp: blockTime,
              });
              currentAssistantIdx = messages.length - 1;
            }
          }
          if (lastProgress && !hasTerminal) {
            messages.push({
              id: `${block.id}-ip`,
              role: 'insight_progress',
              stage: lastProgress.stage,
              progress: lastProgress.progress,
              detail: lastProgress.detail,
              timestamp: blockTime,
            });
          }
          needsNewContentMessage = true;
          break;
        }

        const target =
          currentAssistantIdx !== null
            ? messages[currentAssistantIdx]
            : undefined;
        if (
          target &&
          target.role === 'assistant' &&
          !needsNewContentMessage &&
          !isTextBlockEmpty(textBlock)
        ) {
          const usage = mergeAssistantUsage(target.usage, textBlock.usage);
          messages[currentAssistantIdx!] = {
            ...target,
            content: target.content + textBlock.text,
            isStreaming: textBlock.streaming,
            ...(usage ? { usage } : {}),
          };
          needsNewContentMessage = false;
        } else if (!isTextBlockEmpty(textBlock)) {
          messages.push({
            id: block.id,
            role: 'assistant',
            content: textBlock.text,
            isStreaming: textBlock.streaming,
            timestamp: blockTime,
            ...(textBlock.usage ? { usage: textBlock.usage } : {}),
          });
          currentAssistantIdx = messages.length - 1;
          needsNewContentMessage = false;
        } else if (textBlock.usage && target && target.role === 'assistant') {
          const usage = mergeAssistantUsage(target.usage, textBlock.usage);
          messages[currentAssistantIdx!] = {
            ...target,
            ...(usage ? { usage } : {}),
          };
        }
        break;
      }

      case 'thought': {
        const textBlock = block as DaemonTextTranscriptBlock;
        const parentSubAgent = textBlock.parentToolCallId
          ? toolsByCallId.get(textBlock.parentToolCallId)
          : undefined;
        if (parentSubAgent) {
          appendSubContent(parentSubAgent, textBlock.text);
          break;
        }
        const target =
          currentAssistantIdx !== null
            ? messages[currentAssistantIdx]
            : undefined;
        if (
          target &&
          target.role === 'assistant' &&
          !needsNewContentMessage &&
          !target.content
        ) {
          messages[currentAssistantIdx!] = {
            ...target,
            thinking: (target.thinking || '') + textBlock.text,
            isStreaming: textBlock.streaming,
          };
          needsNewContentMessage = false;
        } else {
          messages.push({
            id: block.id,
            role: 'assistant',
            content: '',
            thinking: textBlock.text,
            isStreaming: textBlock.streaming,
            timestamp: blockTime,
          });
          currentAssistantIdx = messages.length - 1;
          needsNewContentMessage = false;
        }
        break;
      }

      case 'tool': {
        const toolBlock = block as DaemonToolTranscriptBlock;
        const toolCall = daemonToolBlockToToolCall(toolBlock);
        const permissionInfo = permissionToolInfoByCallId.get(toolCall.callId);
        if (permissionInfo?.title) {
          toolCall.title = permissionInfo.title;
        }
        if (!toolCall.args && permissionInfo?.args) {
          toolCall.args = permissionInfo.args;
        }
        const parentSubAgent = toolCall.parentToolCallId
          ? toolsByCallId.get(toolCall.parentToolCallId)
          : undefined;
        const existingTool = toolsByCallId.get(toolCall.callId);

        if (existingTool) {
          mergeToolCall(existingTool, toolCall);
          break;
        }

        if (parentSubAgent) {
          appendSubTool(parentSubAgent, toolCall);
          toolsByCallId.set(toolCall.callId, toolCall);
          break;
        }

        appendToolCallMessage(messages, block.id, toolCall, blockTime);
        toolsByCallId.set(toolCall.callId, toolCall);
        needsNewContentMessage = true;
        break;
      }

      case 'shell': {
        const shellBlock = block as DaemonShellTranscriptBlock;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'tool_group') {
          const targetIdx = findShellOutputTargetIndex(lastMsg.tools);
          const targetTool = lastMsg.tools[targetIdx];
          if (targetTool) {
            const previousOutput =
              typeof targetTool.rawOutput === 'string'
                ? targetTool.rawOutput
                : '';
            const nextTool = {
              ...targetTool,
              rawOutput: previousOutput + shellBlock.text,
            };
            messages[messages.length - 1] = {
              ...lastMsg,
              tools: [
                ...lastMsg.tools.slice(0, targetIdx),
                nextTool,
                ...lastMsg.tools.slice(targetIdx + 1),
              ],
            };
            if (toolsByCallId.get(targetTool.callId) === targetTool) {
              toolsByCallId.set(targetTool.callId, nextTool);
            }
          }
        } else {
          messages.push({
            id: block.id,
            role: 'tool_group',
            tools: [
              {
                callId: block.id,
                toolName: 'shell',
                status: 'completed',
                kind: 'execute',
                rawOutput: shellBlock.text,
              },
            ],
            timestamp: blockTime,
          });
          needsNewContentMessage = true;
        }
        break;
      }

      case 'user_shell': {
        const shellBlock = block as DaemonUserShellTranscriptBlock;
        messages.push({
          id: block.id,
          role: 'user_shell',
          command: shellBlock.command,
          output: shellBlock.text,
          ...(shellBlock.cwd ? { cwd: shellBlock.cwd } : {}),
          timestamp: blockTime,
        });
        needsNewContentMessage = true;
        break;
      }

      case 'permission': {
        const permBlock = block as DaemonPermissionTranscriptBlock;
        rememberPermissionToolInfo(permBlock, permissionToolInfoByCallId);
        const permissionToolCall = permissionBlockToToolCall(permBlock);
        if (!permissionToolCall) break;
        const isSubAgentPermission = isSubAgentToolCall(permissionToolCall);
        // Pending permissions are rendered by the dedicated permission UI.
        if (!permBlock.resolved) {
          break;
        }

        const existingPermission = toolsByCallId.get(permissionToolCall.callId);
        if (existingPermission) {
          const previousStatus = existingPermission.status;
          permissionToolCall.toolName = existingPermission.toolName;
          if (permBlock.resolved) {
            if (isApprovedPermissionResolution(permBlock.resolved)) {
              permissionToolCall.status = isSubAgentPermission
                ? permissionToolCall.status
                : 'in_progress';
            } else {
              permissionToolCall.status = 'failed';
              permissionToolCall.endTime = permBlock.updatedAt;
            }
          }
          mergeToolCall(existingPermission, permissionToolCall);
          if (
            permBlock.resolved &&
            isSubAgentPermission &&
            isApprovedPermissionResolution(permBlock.resolved)
          ) {
            existingPermission.status = previousStatus;
          }
          break;
        }

        if (permBlock.resolved) {
          // Resolved permission with no matching real tool block:
          // - Approved: the daemon may still skip the initial agent tool_call
          //   or a regular tool_call. Keep a pending placeholder visible so
          //   later parented child events and the final update can merge by
          //   callId.
          // - Rejected: render a finished card. Later assistant content stays
          //   in the main conversation unless it has an explicit parent.
          if (isApprovedPermissionResolution(permBlock.resolved)) {
            if (!isSubAgentPermission) {
              permissionToolCall.status = 'in_progress';
            }
            appendToolCallMessage(
              messages,
              block.id,
              permissionToolCall,
              blockTime,
            );
            toolsByCallId.set(permissionToolCall.callId, permissionToolCall);
            needsNewContentMessage = true;
          } else {
            permissionToolCall.status = 'failed';
            permissionToolCall.endTime = permBlock.updatedAt;
            appendToolCallMessage(
              messages,
              block.id,
              permissionToolCall,
              blockTime,
            );
            toolsByCallId.set(permissionToolCall.callId, permissionToolCall);
            needsNewContentMessage = true;
          }
          break;
        }

        break;
      }

      case 'status':
      case 'debug': {
        const statusBlock = block as ExtendedDaemonStatusTranscriptBlock;
        const branchDisplayName =
          statusBlock.source === 'session_branched'
            ? getSessionBranchDisplayName(statusBlock.data)
            : null;
        const text =
          branchDisplayName && options.labels?.branchSuccess
            ? options.labels.branchSuccess(branchDisplayName)
            : statusBlock.text;
        if (isIgnoredWebShellStatus(text)) break;
        const todos = parsePlanTodos(text);
        if (todos) {
          messages.push({
            id: block.id,
            role: 'plan',
            todos,
            timestamp: blockTime,
          });
          needsNewContentMessage = true;
          break;
        }
        // Status/debug blocks are daemon-level diagnostics, not tool output.
        // Keeping them in the main transcript avoids hiding global messages
        // such as SSE lag warnings, malformed-event debug lines, or shell
        // result notices inside whichever subAgent happened to be active.
        messages.push({
          id: block.id,
          role: 'system',
          content: text,
          variant: 'info',
          timestamp: blockTime,
          ...(statusBlock.source ? { source: statusBlock.source } : {}),
          ...(statusBlock.data !== undefined ? { data: statusBlock.data } : {}),
        });
        needsNewContentMessage = true;
        break;
      }

      case 'error': {
        const errorBlock = block as ExtendedDaemonStatusTranscriptBlock;
        messages.push({
          id: block.id,
          role: 'system',
          content: errorBlock.text,
          variant: 'error',
          retryable: errorBlock.source === 'turn_error',
          timestamp: blockTime,
          ...(errorBlock.source ? { source: errorBlock.source } : {}),
          ...(errorBlock.data !== undefined ? { data: errorBlock.data } : {}),
        });
        needsNewContentMessage = true;
        break;
      }

      case 'prompt_cancelled':
        messages.push({
          id: block.id,
          role: 'system',
          content: promptCancelledText,
          variant: 'info',
          timestamp: blockTime,
        });
        needsNewContentMessage = true;
        break;

      default:
        break;
    }
  }

  return messages;
}

function appendSubTool(
  parent: DaemonMessageToolCall,
  toolCall: DaemonMessageToolCall,
): void {
  parent.subTools ||= [];
  parent.subTools.push(toolCall);
}

function appendSubContent(parent: DaemonMessageToolCall, text: string): void {
  parent.subContent = (parent.subContent || '') + text;
}

function appendToolCallMessage(
  messages: DaemonMessage[],
  blockId: string,
  toolCall: DaemonMessageToolCall,
  timestamp?: number,
): void {
  // Native CLI groups every tool call of one scheduler batch into a single
  // bordered tool_group (mapToDisplay in useReactToolScheduler). The daemon
  // transcript carries no batch marker, so the replay-stable equivalent is
  // adjacency: a tool block arriving while a tool_group is still the latest
  // visible message joins that group instead of opening a new box.
  //
  // Sub-agent calls stay in their own single-tool groups — MessageList's
  // groupParallelAgents relies on that shape to render consecutive agent
  // launches as ParallelAgentsGroup.
  //
  // Synthetic raw-shell groups (pushed by the `shell` block fallback) use the
  // bare block id without the `tg-` prefix and never absorb real tool calls.
  // Sub-agent calls and todo_write updates each stand alone in their own group
  // box instead of being crammed in with the tools around them: an agent renders
  // an expandable panel, and a todo update is its own collapsible checklist.
  const isStandalone = (t: DaemonMessageToolCall) =>
    isSubAgentToolCall(t) || isTodoWriteToolName(t.toolName);
  const last = messages[messages.length - 1];
  if (
    last &&
    last.role === 'tool_group' &&
    last.id.startsWith('tg-') &&
    !isStandalone(toolCall) &&
    !last.tools.some(isStandalone)
  ) {
    last.tools.push(toolCall);
    return;
  }
  messages.push({
    id: `tg-${blockId}`,
    role: 'tool_group',
    tools: [toolCall],
    timestamp,
  });
}

/**
 * Pick which tool in a group should receive a raw shell output chunk.
 *
 * Shell transcript blocks carry no toolCallId, so attachment is heuristic.
 * Single-tool groups (the only shape before adjacent-merge) keep the old
 * "last tool" behavior. In merged groups, prefer the most recent `execute`
 * tool that is still running — the scheduler executes one tool at a time, so
 * that is the tool producing output. On replay every status is already
 * terminal; fall back to the most recent `execute` tool, then to the last
 * tool so groups without kind metadata behave exactly as before.
 */
function findShellOutputTargetIndex(
  tools: readonly DaemonMessageToolCall[],
): number {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool.kind === 'execute' && tool.status === 'in_progress') {
      return i;
    }
  }
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].kind === 'execute') {
      return i;
    }
  }
  return tools.length - 1;
}

function mergeToolCall(
  target: DaemonMessageToolCall,
  source: DaemonMessageToolCall,
): void {
  target.status = source.status ?? target.status;
  target.title = source.title ?? target.title;
  target.toolName = source.toolName ?? target.toolName;
  target.kind = source.kind ?? target.kind;
  target.content = source.content ?? target.content;
  target.endTime = source.endTime ?? target.endTime;
  target.rawOutput = source.rawOutput ?? target.rawOutput;
  target.args = source.args ?? target.args;
  target.locations = source.locations ?? target.locations;
}

function isSubAgentToolCall(tool: DaemonMessageToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'agent' || name === 'task') return true;
  if (tool.subTools || tool.subContent) return true;
  if (isTaskExecutionRaw(tool.rawOutput)) return true;
  return Boolean(tool.args?.subagent_type);
}

function isTaskExecutionRaw(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).type === 'task_execution'
  );
}

function parsePlanTodos(text: string): DaemonMessageTodoItem[] | undefined {
  const rawJson = text.startsWith('plan: ')
    ? text.slice('plan: '.length)
    : undefined;
  if (!rawJson) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const record = getRecord(parsed);
    if (
      record?.['sessionUpdate'] !== 'plan' ||
      !Array.isArray(record['entries'])
    ) {
      return undefined;
    }
    return parseDaemonTodoItemsFromEntries(record['entries']);
  } catch {
    return undefined;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getTodoStatus(
  value: string | undefined,
): DaemonMessageTodoItem['status'] {
  return value === 'completed' || value === 'in_progress' || value === 'pending'
    ? value
    : 'pending';
}

function getTodoPriority(
  value: string | undefined,
): DaemonMessageTodoItem['priority'] | undefined {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function daemonToolBlockToToolCall(
  block: DaemonToolTranscriptBlock,
): DaemonMessageToolCall {
  const rawOutput = getToolRawOutput(block);
  const isBackgroundAgent = isBackgroundAgentBlock(block, rawOutput);
  const content = normalizeToolContent(block.content);
  const statusMap: Record<string, DaemonMessageToolCallStatus> = {
    running: 'in_progress',
    pending: 'pending',
    confirming: 'pending',
    background: 'pending',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'completed',
    canceled: 'completed',
    in_progress: 'in_progress',
  };
  const isComplete =
    block.status === 'completed' ||
    block.status === 'failed' ||
    block.status === 'cancelled' ||
    block.status === 'canceled';

  return {
    callId: block.toolCallId,
    toolName: block.toolName || 'unknown',
    title: block.title,
    status:
      (isBackgroundAgent ? 'pending' : statusMap[block.status]) ||
      (block.status as DaemonMessageToolCallStatus) ||
      'in_progress',
    kind: inferToolKind(block.toolName, block.toolKind),
    rawOutput,
    args: block.rawInput as Record<string, unknown> | undefined,
    parentToolCallId: block.parentToolCallId,
    startTime: block.createdAt,
    endTime: isComplete && !isBackgroundAgent ? block.updatedAt : undefined,
    ...(content ? { content } : {}),
  };
}

function permissionBlockToToolCall(
  block: DaemonPermissionTranscriptBlock,
): DaemonMessageToolCall | undefined {
  const toolCall = getRecord(block.toolCall);
  if (!toolCall) return undefined;

  const rawInput = getToolCallRawInput(toolCall);
  // AskUserQuestion permissions are rendered by the shell as a dedicated
  // interactive form from the pending permission itself. Emitting a synthetic
  // generic tool card here would show the same permission twice, especially
  // when older daemon events only expose it as kind: "think".
  if (Array.isArray(rawInput?.['questions'])) return undefined;

  const meta = getRecord(toolCall['_meta']);
  const kind = getString(toolCall, 'kind');
  const toolName =
    getString(meta, 'toolName') ??
    getString(toolCall, 'toolName') ??
    getString(toolCall, 'name') ??
    (rawInput?.['subagent_type'] ? 'agent' : undefined) ??
    (kind === 'fetch' ? 'web_fetch' : kind);
  const toolCallId =
    getString(toolCall, 'toolCallId') ?? getString(toolCall, 'id');
  if (!toolCallId || !toolName) return undefined;

  const syntheticTool: DaemonMessageToolCall = {
    callId: toolCallId,
    toolName,
    title: getString(toolCall, 'title') ?? block.title,
    status: 'pending',
    kind: inferToolKind(toolName, kind),
    args: rawInput,
    startTime: block.createdAt,
  };

  return syntheticTool;
}

function rememberPermissionToolInfo(
  block: DaemonPermissionTranscriptBlock,
  infoByCallId: Map<string, PermissionToolInfo>,
): void {
  const toolCall = getRecord(block.toolCall);
  const toolCallId =
    getString(toolCall, 'toolCallId') ?? getString(toolCall, 'id');
  if (!toolCallId) return;
  const title = getString(toolCall, 'title') ?? block.title;
  const rawInput = toolCall ? getToolCallRawInput(toolCall) : undefined;
  if (!Array.isArray(rawInput?.['questions'])) return;
  infoByCallId.set(toolCallId, {
    ...(title ? { title } : {}),
    ...(rawInput ? { args: rawInput } : {}),
  });
}

function isApprovedPermissionResolution(resolved: string): boolean {
  const [primary = '', detail = ''] = resolved.toLowerCase().split(':', 2);
  if (isApprovalToken(primary)) return true;
  if (primary !== 'selected') return false;
  return isApprovalToken(detail.trim());
}

function isApprovalToken(token: string): boolean {
  return (
    token === 'allow' ||
    token === 'allowed' ||
    token === 'approve' ||
    token === 'approved' ||
    token === 'accept' ||
    token === 'accepted' ||
    token === 'confirm' ||
    token === 'confirmed' ||
    token === 'proceed' ||
    token === 'proceed_once' ||
    token === 'proceed_always_project' ||
    token === 'proceed_always_user' ||
    token === 'allow_once' ||
    token === 'allow_always' ||
    token === 'success' ||
    token === 'succeeded'
  );
}

function getToolCallRawInput(
  toolCall: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    getRecord(toolCall['rawInput']) ??
    getRecord(toolCall['input']) ??
    getRecord(toolCall['args'])
  );
}

function isBackgroundAgentBlock(
  block: DaemonToolTranscriptBlock,
  rawOutput: unknown,
): boolean {
  const name = block.toolName?.toLowerCase();
  if (name !== 'agent' && name !== 'task') return false;
  const raw = getRecord(rawOutput);
  return raw?.['status'] === 'background';
}

function getToolRawOutput(block: DaemonToolTranscriptBlock): unknown {
  if (isAskUserQuestionBlock(block) && block.status === 'failed') {
    return getToolContentText(block) ?? block.details ?? block.rawOutput;
  }

  if (!isCancelledStatus(block.status) || !block.details) {
    return block.rawOutput ?? block.details;
  }

  if (
    block.rawOutput &&
    typeof block.rawOutput === 'object' &&
    !Array.isArray(block.rawOutput)
  ) {
    return {
      ...(block.rawOutput as Record<string, unknown>),
      status: block.status,
      reason: block.details,
    };
  }

  return {
    status: block.status,
    reason: block.details,
    text:
      typeof block.rawOutput === 'string' && block.rawOutput
        ? block.rawOutput
        : block.details,
  };
}

function normalizeToolContent(
  value: unknown,
): DaemonMessageToolCallContent[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const content = value.flatMap((entry): DaemonMessageToolCallContent[] => {
    const item = getRecord(entry);
    if (!item) return [];

    const type = item['type'];
    if (type === 'content') {
      const body = getRecord(item['content']);
      if (!body || typeof body['type'] !== 'string') return [];
      return [
        {
          type: 'content',
          content: { ...body, type: body['type'] },
        },
      ];
    }

    if (type === 'diff') {
      const newText = item['newText'];
      if (typeof newText !== 'string') return [];

      const path = item['path'];
      const oldText = item['oldText'];
      return [
        {
          type: 'diff',
          ...(typeof path === 'string' ? { path } : {}),
          ...(typeof oldText === 'string' ? { oldText } : {}),
          newText,
        },
      ];
    }

    if (type === 'terminal') {
      const terminalId = item['terminalId'];
      return [
        {
          type: 'terminal',
          ...(typeof terminalId === 'string' ? { terminalId } : {}),
        },
      ];
    }

    return [];
  });

  return content.length > 0 ? content : undefined;
}

function isAskUserQuestionBlock(block: DaemonToolTranscriptBlock): boolean {
  if (!block.toolName) return false;
  const normalized = block.toolName.toLowerCase();
  return normalized === 'ask_user_question' || normalized === 'askuserquestion';
}

function getToolContentText(
  block: DaemonToolTranscriptBlock,
): string | undefined {
  if (!Array.isArray(block.content)) return undefined;
  const parts = block.content
    .map((item) => item?.content?.text)
    .filter((text): text is string => Boolean(text));
  if (!parts || parts.length === 0) return undefined;
  return parts.join('\n');
}

function isCancelledStatus(status: string): boolean {
  return status === 'cancelled' || status === 'canceled';
}

type ParsedInsight =
  | {
      type: 'insight_progress';
      stage: string;
      progress: number;
      detail?: string;
    }
  | { type: 'insight_ready'; path: string }
  | { type: 'insight_error'; error: string };

type InsightSegment =
  | { kind: 'text'; text: string }
  | { kind: 'insight'; data: ParsedInsight };

const INSIGHT_PREFIXES = [
  '"insight_progress":',
  '"insight_ready":',
  '"insight_error":',
];

function parseInsightJson(json: string): ParsedInsight | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const prog = getRecord(parsed['insight_progress']);
    if (
      prog &&
      typeof prog['stage'] === 'string' &&
      typeof prog['progress'] === 'number'
    ) {
      return {
        type: 'insight_progress',
        stage: prog['stage'] as string,
        progress: prog['progress'] as number,
        detail:
          typeof prog['detail'] === 'string'
            ? (prog['detail'] as string)
            : undefined,
      };
    }
    const ready = getRecord(parsed['insight_ready']);
    if (ready && typeof ready['path'] === 'string') {
      return { type: 'insight_ready', path: ready['path'] as string };
    }
    const insightError = getRecord(parsed['insight_error']);
    if (insightError && typeof insightError['error'] === 'string') {
      return { type: 'insight_error', error: insightError['error'] as string };
    }
  } catch {
    // not valid JSON
  }
  return null;
}

// Balanced-braces JSON extractor. Handles string escapes but not standalone
// arrays — sufficient for the insight protocol's object-only payloads.
function extractJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function splitInsightSegments(text: string): InsightSegment[] | null {
  const segments: InsightSegment[] = [];
  let lastIndex = 0;
  let pos = 0;
  let hasInsight = false;

  while (pos < text.length) {
    const braceIdx = text.indexOf('{', pos);
    if (braceIdx === -1) break;

    const afterBrace = text.slice(braceIdx + 1).trimStart();
    const isInsight = INSIGHT_PREFIXES.some((p) => afterBrace.startsWith(p));
    if (!isInsight) {
      pos = braceIdx + 1;
      continue;
    }

    const json = extractJsonObject(text, braceIdx);
    if (!json) {
      pos = braceIdx + 1;
      continue;
    }

    const insight = parseInsightJson(json);
    if (!insight) {
      pos = braceIdx + 1;
      continue;
    }

    hasInsight = true;
    const before = text.slice(lastIndex, braceIdx).trim();
    if (before) {
      segments.push({ kind: 'text', text: before });
    }
    segments.push({ kind: 'insight', data: insight });
    lastIndex = braceIdx + json.length;
    pos = lastIndex;
  }

  if (!hasInsight) return null;

  const after = text.slice(lastIndex).trim();
  if (after) {
    segments.push({ kind: 'text', text: after });
  }

  return segments.length > 0 ? segments : null;
}

function inferToolKind(
  toolName?: string,
  toolKind?: string,
): DaemonMessageToolKind | undefined {
  if (toolKind) return toolKind as DaemonMessageToolKind;
  if (!toolName) return undefined;
  const name = toolName.toLowerCase();
  if (name === 'bash' || name === 'execute') return 'execute';
  if (name === 'read') return 'read';
  if (name === 'edit' || name === 'write') return 'edit';
  if (name.includes('search') || name === 'grep' || name === 'glob')
    return 'search';
  if (name === 'agent' || name === 'task') return 'other';
  return undefined;
}
