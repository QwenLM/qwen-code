import type {
  DaemonTranscriptBlock,
  DaemonTranscriptState,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonShellTranscriptBlock,
  DaemonStatusTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type {
  Message,
  ACPToolCall,
  PermissionRequest,
  PermissionOptionKind,
  TodoItem,
  ToolGroupMessage,
  ToolCallStatus,
  ToolKind,
} from './types';

interface ActiveSubAgent {
  tool: ACPToolCall;
  closeAt?: number;
}

export function transcriptBlocksToMessages(
  blocks: readonly DaemonTranscriptBlock[],
): Message[] {
  const messages: Message[] = [];
  const subAgentStack: ActiveSubAgent[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    closeCompletedSubAgentsBefore(subAgentStack, block.createdAt);

    switch (block.kind) {
      case 'user':
        closeAllSubAgents(subAgentStack);
        messages.push({
          id: block.id,
          role: 'user',
          content: (block as DaemonTextTranscriptBlock).text,
        });
        break;

      case 'assistant': {
        const textBlock = block as DaemonTextTranscriptBlock;
        const activeSubAgent = getActiveSubAgent(subAgentStack);
        if (activeSubAgent) {
          activeSubAgent.subContent =
            (activeSubAgent.subContent || '') + textBlock.text;
          break;
        }
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
          lastMsg.content += textBlock.text;
        } else {
          messages.push({
            id: block.id,
            role: 'assistant',
            content: textBlock.text,
            isStreaming: textBlock.streaming,
          });
        }
        break;
      }

      case 'thought': {
        const textBlock = block as DaemonTextTranscriptBlock;
        const activeSubAgent = getActiveSubAgent(subAgentStack);
        if (activeSubAgent) {
          activeSubAgent.subContent =
            (activeSubAgent.subContent || '') + textBlock.text;
          break;
        }
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.thinking = (lastMsg.thinking || '') + textBlock.text;
        } else {
          messages.push({
            id: block.id,
            role: 'assistant',
            content: '',
            thinking: textBlock.text,
            isStreaming: textBlock.streaming,
          });
        }
        break;
      }

      case 'tool': {
        const toolBlock = block as DaemonToolTranscriptBlock;
        const todos = parsePlanToolBlock(toolBlock);
        if (todos) {
          messages.push({
            id: block.id,
            role: 'plan',
            todos,
          });
          break;
        }
        const toolCall = daemonToolBlockToACPToolCall(toolBlock);
        const activeSubAgent = getActiveSubAgent(subAgentStack);

        if (activeSubAgent && isAgentCompletion(toolCall)) {
          mergeToolCall(activeSubAgent, toolCall);
          subAgentStack.pop();
          break;
        }

        if (activeSubAgent) {
          activeSubAgent.subTools ||= [];
          activeSubAgent.subTools.push(toolCall);
          if (isSubAgentToolCall(toolCall) && !isAgentCompletion(toolCall)) {
            subAgentStack.push({ tool: toolCall });
          }
          break;
        }

        appendToolCallMessage(messages, block.id, toolCall);

        if (isSubAgentToolCall(toolCall)) {
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
        const activeSubAgent = getActiveSubAgent(subAgentStack);
        if (activeSubAgent) {
          const lastSubTool =
            activeSubAgent.subTools?.[activeSubAgent.subTools.length - 1];
          if (lastSubTool) {
            lastSubTool.rawOutput =
              ((lastSubTool.rawOutput as string) || '') + shellBlock.text;
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
            lastTool.rawOutput =
              ((lastTool.rawOutput as string) || '') + shellBlock.text;
          }
        }
        break;
      }

      case 'permission':
        // Handled separately via extractPendingPermission
        break;

      case 'status':
      case 'debug': {
        const text = (block as DaemonStatusTranscriptBlock).text;
        const activeSubAgent = getActiveSubAgent(subAgentStack);
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
          break;
        }
        messages.push({
          id: block.id,
          role: 'system',
          content: text,
          variant: 'info',
        });
        break;
      }

      case 'error':
        messages.push({
          id: block.id,
          role: 'system',
          content: (block as DaemonStatusTranscriptBlock).text,
          variant: 'error',
        });
        break;
    }
  }
  closeAllSubAgents(subAgentStack);

  return messages;
}

function getActiveSubAgent(stack: ActiveSubAgent[]): ACPToolCall | undefined {
  return stack[stack.length - 1]?.tool;
}

function closeCompletedSubAgentsBefore(
  stack: ActiveSubAgent[],
  timestamp: number,
): void {
  while (stack.length > 0) {
    const active = stack[stack.length - 1];
    if (!active?.closeAt || timestamp <= active.closeAt) {
      return;
    }
    stack.pop();
  }
}

function closeAllSubAgents(stack: ActiveSubAgent[]): void {
  stack.length = 0;
}

function appendToolCallMessage(
  messages: Message[],
  blockId: string,
  toolCall: ACPToolCall,
): void {
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === 'tool_group') {
    (lastMsg as ToolGroupMessage).tools.push(toolCall);
  } else {
    messages.push({
      id: `tg-${blockId}`,
      role: 'tool_group',
      tools: [toolCall],
    });
  }
}

function mergeToolCall(target: ACPToolCall, source: ACPToolCall): void {
  target.status = source.status || target.status;
  target.title = source.title || target.title;
  target.toolName = source.toolName || target.toolName;
  target.kind = source.kind || target.kind;
  target.endTime = source.endTime || target.endTime;
  target.rawOutput = source.rawOutput ?? target.rawOutput;
  target.args = source.args || target.args;
  target.content = source.content || target.content;
  target.locations = source.locations || target.locations;
}

function isSubAgentToolCall(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'agent' || name === 'task') return true;
  if (tool.subTools || tool.subContent) return true;
  if (tool.rawOutput && isTaskExecutionRaw(tool.rawOutput)) return true;
  if (tool.args?.subagent_type) return true;
  return false;
}

function isAgentCompletion(tool: ACPToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  return tool.status === 'completed' || tool.status === 'failed';
}

function isTaskExecutionRaw(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).type === 'task_execution'
  );
}

export function extractPendingPermission(
  state: DaemonTranscriptState,
): PermissionRequest | null {
  for (const block of state.blocks) {
    if (block.kind !== 'permission') continue;
    const perm = block as unknown as Record<string, unknown>;
    if (perm['resolved']) continue;
    const options = Array.isArray(perm['options']) ? perm['options'] : [];
    return {
      id: getString(perm, 'requestId') || '',
      sessionId: getString(perm, 'sessionId'),
      toolCallId: getString(perm, 'toolCallId'),
      title: getString(perm, 'title'),
      content: [
        {
          type: 'text',
          text: getString(perm, 'title') || 'Tool permission',
        },
      ],
      options: options.map((rawOpt) => {
        const opt = getRecord(rawOpt) ?? {};
        return {
          id: getString(opt, 'optionId') || '',
          label: getString(opt, 'label') || getString(opt, 'name') || '',
          kind: getPermissionOptionKind(opt['raw']),
        };
      }),
      rawInput: getPermissionRawInput(perm['toolCall']),
    };
  }
  return null;
}

function parsePlanTodos(text: string): TodoItem[] | undefined {
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
    return entriesToTodos(record['entries']);
  } catch {
    return undefined;
  }
}

function parsePlanToolBlock(
  block: DaemonToolTranscriptBlock,
): TodoItem[] | undefined {
  if (block.toolName !== 'TodoWrite' && block.toolKind !== 'updated_plan') {
    return undefined;
  }
  const raw = getRecord(block.rawOutput);
  const entries = Array.isArray(raw?.['entries']) ? raw['entries'] : undefined;
  if (!entries) {
    return undefined;
  }
  return entriesToTodos(entries);
}

function entriesToTodos(entries: readonly unknown[]): TodoItem[] | undefined {
  const todos = entries.flatMap((entry, index): TodoItem[] => {
    const item = getRecord(entry);
    const content = getString(item, 'content');
    if (!content) return [];
    return [
      {
        id: getString(item, 'id') ?? `plan-${index}`,
        content,
        status: getTodoStatus(getString(item, 'status')),
        priority: getTodoPriority(getString(item, 'priority')),
      },
    ];
  });
  return todos.length > 0 ? todos : undefined;
}

function getTodoStatus(value: string | undefined): TodoItem['status'] {
  return value === 'completed' || value === 'in_progress' || value === 'pending'
    ? value
    : 'pending';
}

function getTodoPriority(
  value: string | undefined,
): TodoItem['priority'] | undefined {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function getPermissionRawInput(
  toolCall: unknown,
): Record<string, unknown> | undefined {
  const record = getRecord(toolCall);
  if (!record) {
    return undefined;
  }

  const nested =
    getRecord(record['rawInput']) ??
    getRecord(record['input']) ??
    getRecord(record['args']);
  return nested ?? record;
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

function getPermissionOptionKind(
  raw: unknown,
): PermissionOptionKind | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const kind = (raw as Record<string, unknown>).kind;
  return kind === 'allow_once' ||
    kind === 'allow_always' ||
    kind === 'reject_once' ||
    kind === 'reject_always'
    ? kind
    : undefined;
}

export function extractStreamingState(
  state: DaemonTranscriptState,
): 'idle' | 'waiting' | 'responding' | 'thinking' {
  const blocks = state.blocks;
  if (blocks.length === 0) return 'idle';

  const last = blocks[blocks.length - 1];
  if (
    last.kind === 'thought' &&
    (last as DaemonTextTranscriptBlock).streaming
  ) {
    return 'thinking';
  }
  if (
    last.kind === 'assistant' &&
    (last as DaemonTextTranscriptBlock).streaming
  ) {
    return 'responding';
  }
  if (
    last.kind === 'tool' &&
    (last as DaemonToolTranscriptBlock).status === 'in_progress'
  ) {
    return 'responding';
  }

  // Check if any tool is still in progress
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'user') break;
    if (
      b.kind === 'tool' &&
      (b as DaemonToolTranscriptBlock).status === 'in_progress'
    ) {
      return 'responding';
    }
  }

  return 'idle';
}

function daemonToolBlockToACPToolCall(
  block: DaemonToolTranscriptBlock,
): ACPToolCall {
  const statusMap: Record<string, ToolCallStatus> = {
    running: 'in_progress',
    pending: 'pending',
    completed: 'completed',
    failed: 'failed',
    in_progress: 'in_progress',
  };

  return {
    callId: block.toolCallId,
    toolName: block.toolName || 'unknown',
    title: block.title,
    status:
      statusMap[block.status] ||
      (block.status as ToolCallStatus) ||
      'in_progress',
    kind: inferToolKind(block.toolName, block.toolKind),
    rawOutput: block.rawOutput ?? block.details,
    args: block.rawInput as Record<string, unknown> | undefined,
    startTime: block.createdAt,
    endTime:
      block.status === 'completed' || block.status === 'failed'
        ? block.updatedAt
        : undefined,
  };
}

function inferToolKind(
  toolName?: string,
  toolKind?: string,
): ToolKind | undefined {
  if (toolKind) return toolKind as ToolKind;
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
