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

export function transcriptBlocksToDaemonMessages(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonMessage[] {
  const messages: DaemonMessage[] = [];
  const subAgentStack: ActiveSubAgent[] = [];
  let currentAssistantIdx: number | null = null;
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
        if (target && target.role === 'assistant' && !needsNewContentMessage) {
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

        if (isAgentCompletion(toolCall) || isBackgroundAgentLaunch(toolCall)) {
          const matchingSubAgentIndex = findSubAgentIndex(
            subAgentStack,
            toolCall.callId,
          );
          if (matchingSubAgentIndex >= 0) {
            mergeToolCall(subAgentStack[matchingSubAgentIndex].tool, toolCall);
            subAgentStack.splice(matchingSubAgentIndex, 1);
            break;
          }
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

      case 'permission':
        break;

      case 'status':
      case 'debug': {
        const text = (block as DaemonStatusTranscriptBlock).text;
        const activeSubAgent = getFallbackActiveSubAgent(subAgentStack);
        if (activeSubAgent) {
          activeSubAgent.subContent =
            (activeSubAgent.subContent || '') + text + '\n';
          break;
        }
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
  while (stack.length > 0) {
    const active = stack[stack.length - 1];
    if (!active?.closeAt || timestamp < active.closeAt) {
      return;
    }
    stack.pop();
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
  target.status = source.status || target.status;
  target.title = source.title || target.title;
  target.toolName = source.toolName || target.toolName;
  target.kind = source.kind || target.kind;
  target.endTime = source.endTime || target.endTime;
  target.rawOutput = source.rawOutput ?? target.rawOutput;
  target.args = source.args || target.args;
  target.locations = source.locations || target.locations;
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
