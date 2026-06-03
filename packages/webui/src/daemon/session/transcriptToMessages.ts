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
import { parseDaemonTodoItemsFromEntries } from './selectors.js';
import type {
  DaemonMessage,
  DaemonMessageToolCall,
  DaemonMessageToolCallStatus,
  DaemonMessageToolKind,
  DaemonMessageTodoItem,
} from './messageTypes.js';

interface ActiveSubAgent {
  tool: DaemonMessageToolCall;
  closeAt?: number;
}

type DaemonPermissionTranscriptBlock = Extract<
  DaemonTranscriptBlock,
  { kind: 'permission' }
>;

export function transcriptBlocksToDaemonMessages(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonMessage[] {
  const messages: DaemonMessage[] = [];
  // Replay can contain thousands of blocks. Keep top-level tool calls indexed
  // by callId so later tool updates and permission placeholders merge in O(1)
  // instead of scanning the rendered message list for every block.
  const topLevelToolsByCallId = new Map<string, DaemonMessageToolCall>();
  const subAgentStack: ActiveSubAgent[] = [];
  let currentAssistantIdx: number | null = null;
  // Tool cards are standalone transcript turns. Once a tool is emitted,
  // the next top-level assistant/thought block must start a fresh assistant
  // message instead of being appended to text that appeared before the tool.
  let needsNewContentMessage = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    closeCompletedSubAgentsBefore(subAgentStack, block.createdAt);

    switch (block.kind) {
      case 'user':
        closeAllSubAgents(subAgentStack);
        currentAssistantIdx = null;
        needsNewContentMessage = false;
        messages.push({
          id: block.id,
          role: 'user',
          content: (block as DaemonTextTranscriptBlock).text,
        });
        break;

      case 'assistant': {
        const textBlock = block as DaemonTextTranscriptBlock;

        const activeSubAgent = getFallbackActiveSubAgent(subAgentStack);
        if (activeSubAgent) {
          activeSubAgent.subContent =
            (activeSubAgent.subContent || '') + textBlock.text;
          break;
        }
        if (subAgentStack.length > 0) {
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
                });
              } else if (seg.data.type === 'insight_error') {
                hasTerminal = true;
                messages.push({
                  id: `${block.id}-ie-${errorCount++}`,
                  role: 'insight_error',
                  error: seg.data.error,
                });
              }
            } else {
              messages.push({
                id: `${block.id}-t-${messages.length}`,
                role: 'assistant',
                content: seg.text,
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
            });
          }
          needsNewContentMessage = true;
          break;
        }

        const target =
          currentAssistantIdx !== null
            ? messages[currentAssistantIdx]
            : undefined;
        if (target && target.role === 'assistant' && !needsNewContentMessage) {
          messages[currentAssistantIdx!] = {
            ...target,
            content: target.content + textBlock.text,
            isStreaming: textBlock.streaming,
          };
          needsNewContentMessage = false;
        } else {
          messages.push({
            id: block.id,
            role: 'assistant',
            content: textBlock.text,
            isStreaming: textBlock.streaming,
          });
          currentAssistantIdx = messages.length - 1;
          needsNewContentMessage = false;
        }
        break;
      }

      case 'thought': {
        const textBlock = block as DaemonTextTranscriptBlock;
        const activeSubAgent = getFallbackActiveSubAgent(subAgentStack);
        if (activeSubAgent) {
          activeSubAgent.subContent =
            (activeSubAgent.subContent || '') + textBlock.text;
          break;
        }
        if (subAgentStack.length > 0) {
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
          });
          currentAssistantIdx = messages.length - 1;
          needsNewContentMessage = false;
        }
        break;
      }

      case 'tool': {
        const toolBlock = block as DaemonToolTranscriptBlock;
        const toolCall = daemonToolBlockToToolCall(toolBlock);
        const parentSubAgent = toolCall.parentToolCallId
          ? findSubAgent(subAgentStack, toolCall.parentToolCallId)
          : undefined;
        const existingTopLevelTool = topLevelToolsByCallId.get(toolCall.callId);

        if (isSubAgentToolCall(toolCall)) {
          const matchingSubAgentIndex = findSubAgentIndex(
            subAgentStack,
            toolCall.callId,
          );
          if (matchingSubAgentIndex >= 0) {
            mergeToolCall(subAgentStack[matchingSubAgentIndex].tool, toolCall);
            if (
              isAgentCompletion(toolCall) ||
              isBackgroundAgentLaunch(toolCall)
            ) {
              subAgentStack.splice(matchingSubAgentIndex, 1);
            }
            break;
          }
        }

        if (existingTopLevelTool) {
          mergeToolCall(existingTopLevelTool, toolCall);
          break;
        }

        if (parentSubAgent) {
          appendSubTool(parentSubAgent, toolCall);
          if (isSubAgentToolCall(toolCall) && !isAgentCompletion(toolCall)) {
            subAgentStack.push({ tool: toolCall });
          }
          break;
        }

        const isImplicitTopLevelSubAgent =
          isSubAgentToolCall(toolCall) && !toolCall.parentToolCallId;
        if (!isImplicitTopLevelSubAgent) {
          const fallbackActiveSubAgent =
            getFallbackActiveSubAgent(subAgentStack);
          if (fallbackActiveSubAgent) {
            appendSubTool(fallbackActiveSubAgent, toolCall);
            break;
          }
        }

        appendToolCallMessage(messages, block.id, toolCall);
        topLevelToolsByCallId.set(toolCall.callId, toolCall);
        needsNewContentMessage = true;

        if (isSubAgentToolCall(toolCall) && !isBackgroundSubAgent(toolCall)) {
          const closeAt =
            isAgentCompletion(toolCall) &&
            toolBlock.updatedAt > toolBlock.createdAt
              ? toolBlock.updatedAt
              : undefined;
          if (!isAgentCompletion(toolCall) || closeAt) {
            subAgentStack.push({ tool: toolCall, closeAt });
          }
        }
        break;
      }

      case 'shell': {
        const shellBlock = block as DaemonShellTranscriptBlock;
        const activeSubAgent = getFallbackActiveSubAgent(subAgentStack);
        if (activeSubAgent) {
          const lastSubTool =
            activeSubAgent.subTools?.[activeSubAgent.subTools.length - 1];
          if (lastSubTool) {
            lastSubTool.rawOutput =
              String(lastSubTool.rawOutput ?? '') + shellBlock.text;
          } else {
            activeSubAgent.subContent =
              (activeSubAgent.subContent || '') + shellBlock.text;
          }
          break;
        }
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'tool_group') {
          const lastTool = lastMsg.tools[lastMsg.tools.length - 1];
          if (lastTool) {
            const nextTool = {
              ...lastTool,
              rawOutput: String(lastTool.rawOutput ?? '') + shellBlock.text,
            };
            messages[messages.length - 1] = {
              ...lastMsg,
              tools: [...lastMsg.tools.slice(0, -1), nextTool],
            };
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
        });
        needsNewContentMessage = true;
        break;
      }

      case 'permission': {
        const permBlock = block as DaemonPermissionTranscriptBlock;
        const permissionToolCall = permissionBlockToToolCall(permBlock);
        if (!permissionToolCall) break;
        const isSubAgentPermission = isSubAgentToolCall(permissionToolCall);

        const matchingSubAgentIndex = findSubAgentIndex(
          subAgentStack,
          permissionToolCall.callId,
        );
        if (matchingSubAgentIndex >= 0) {
          break;
        }

        const existingTopLevelPermission = topLevelToolsByCallId.get(
          permissionToolCall.callId,
        );
        if (existingTopLevelPermission) {
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
          mergeToolCall(existingTopLevelPermission, permissionToolCall);
          break;
        }

        if (permBlock.resolved) {
          // Resolved permission with no matching real tool block:
          // - Approved: the daemon may still skip the initial agent tool_call
          //   or a regular tool_call. Keep a pending placeholder visible; for
          //   agents, also keep it on the stack so child thought/tool events
          //   stay grouped until the final update merges by callId.
          // - Rejected: no child events belong to the agent. Render a finished
          //   card without pushing to subAgentStack so later assistant content
          //   stays in the main conversation.
          if (isApprovedPermissionResolution(permBlock.resolved)) {
            if (!isSubAgentPermission) {
              permissionToolCall.status = 'in_progress';
            }
            appendToolCallMessage(messages, block.id, permissionToolCall);
            topLevelToolsByCallId.set(
              permissionToolCall.callId,
              permissionToolCall,
            );
            needsNewContentMessage = true;
            if (isSubAgentPermission) {
              subAgentStack.push({ tool: permissionToolCall });
            }
          } else {
            permissionToolCall.status = 'failed';
            permissionToolCall.endTime = permBlock.updatedAt;
            appendToolCallMessage(messages, block.id, permissionToolCall);
            topLevelToolsByCallId.set(
              permissionToolCall.callId,
              permissionToolCall,
            );
            needsNewContentMessage = true;
          }
          break;
        }

        // Unresolved: render as pending agent awaiting approval.
        appendToolCallMessage(messages, block.id, permissionToolCall);
        topLevelToolsByCallId.set(
          permissionToolCall.callId,
          permissionToolCall,
        );
        needsNewContentMessage = true;
        if (isSubAgentPermission) {
          subAgentStack.push({ tool: permissionToolCall });
        }
        break;
      }

      case 'status':
      case 'debug': {
        const text = (block as DaemonStatusTranscriptBlock).text;
        const todos = parsePlanTodos(text);
        if (todos) {
          messages.push({
            id: block.id,
            role: 'plan',
            todos,
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
        });
        needsNewContentMessage = true;
        break;
      }

      case 'error':
        messages.push({
          id: block.id,
          role: 'system',
          content: (block as DaemonStatusTranscriptBlock).text,
          variant: 'error',
        });
        needsNewContentMessage = true;
        break;

      default:
        break;
    }
  }
  closeAllSubAgents(subAgentStack);

  return messages;
}

function getFallbackActiveSubAgent(
  stack: ActiveSubAgent[],
): DaemonMessageToolCall | undefined {
  // Only use positional fallback when there is exactly one active top-level
  // agent. Multiple top-level agents usually mean parallel/background work;
  // without an explicit parentToolCallId, assigning text or shell output to
  // the newest agent would steal main-thread content and scramble grouping.
  // Nested agents keep the fallback because their parent link makes ownership
  // unambiguous even while the daemon streams child output out-of-band.
  if (stack.length === 1) return stack[0]?.tool;
  const top = stack[stack.length - 1]?.tool;
  return top?.parentToolCallId ? top : undefined;
}

function findSubAgentIndex(
  stack: ActiveSubAgent[],
  toolCallId: string,
): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.tool.callId === toolCallId) return i;
  }
  return -1;
}

function findSubAgent(
  stack: ActiveSubAgent[],
  toolCallId: string,
): DaemonMessageToolCall | undefined {
  const index = findSubAgentIndex(stack, toolCallId);
  return index >= 0 ? stack[index]?.tool : undefined;
}

function appendSubTool(
  parent: DaemonMessageToolCall,
  toolCall: DaemonMessageToolCall,
): void {
  parent.subTools ||= [];
  parent.subTools.push(toolCall);
}

function closeCompletedSubAgentsBefore(
  stack: ActiveSubAgent[],
  timestamp: number,
): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    const active = stack[i];
    if (active?.closeAt && timestamp >= active.closeAt) {
      stack.splice(i, 1);
    }
  }
}

function closeAllSubAgents(stack: ActiveSubAgent[]): void {
  stack.length = 0;
}

function appendToolCallMessage(
  messages: DaemonMessage[],
  blockId: string,
  toolCall: DaemonMessageToolCall,
): void {
  messages.push({
    id: `tg-${blockId}`,
    role: 'tool_group',
    tools: [toolCall],
  });
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

function isAgentCompletion(tool: DaemonMessageToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  return tool.status === 'completed' || tool.status === 'failed';
}

function isBackgroundAgentLaunch(tool: DaemonMessageToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  const raw = getRecord(tool.rawOutput);
  return raw?.['status'] === 'background';
}

function isBackgroundSubAgent(tool: DaemonMessageToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  if (isBackgroundAgentLaunch(tool)) return true;
  return tool.args?.run_in_background === true;
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
  return typeof value === 'string' ? value : undefined;
}

function daemonToolBlockToToolCall(
  block: DaemonToolTranscriptBlock,
): DaemonMessageToolCall {
  const rawOutput = getToolRawOutput(block);
  const isBackgroundAgent = isBackgroundAgentBlock(block, rawOutput);
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

function isApprovedPermissionResolution(resolved: string): boolean {
  const [primary = '', detail = ''] = resolved.toLowerCase().split(':', 2);
  if (isApprovalToken(primary)) return true;
  if (primary !== 'selected') return false;
  return detail
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some(isApprovalToken);
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
