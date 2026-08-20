import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { DaemonMessage, DaemonMessageToolCall } from './messageTypes.js';
import { groupParallelAgents } from './parallelAgentGrouping.js';
import { transcriptBlocksToDaemonMessages } from './transcriptToMessages.js';

export interface TranscriptRenderedItemEvidence {
  readonly renderedItemId: string;
  readonly sourceBlockIds: readonly string[];
  readonly sourceToolCallIds: readonly string[];
  readonly capabilities: readonly (
    | 'copy'
    | 'open-file'
    | 'edit-user-message'
  )[];
}

export interface TranscriptRenderProbeResult {
  readonly items: readonly TranscriptRenderedItemEvidence[];
  readonly semanticCopyHashes: Readonly<Record<string, string>>;
  readonly actions: {
    readonly copyAll: {
      readonly renderedItemIds: readonly string[];
      readonly semanticHash: string;
    };
    readonly copyLastReply?: TranscriptActionTargetEvidence;
    readonly editLastUserMessage?: TranscriptActionTargetEvidence;
    readonly openFiles: readonly {
      readonly renderedItemId: string;
      readonly sourceToolCallId: string;
    }[];
  };
}

export interface TranscriptActionTargetEvidence {
  readonly renderedItemId: string;
  readonly sourceBlockIds: readonly string[];
  readonly semanticHash: string;
}

interface RenderProbeItem {
  readonly id: string;
  readonly role: DaemonMessage['role'] | 'parallel_agents';
  readonly sourceBlockIds: readonly string[];
  readonly sourceToolCallIds: readonly string[];
  readonly fileToolCallIds: readonly string[];
  readonly semanticText: string;
}

export function probeTranscriptRenderIdentity(
  blocks: readonly DaemonTranscriptBlock[],
  options: { safeToolProjection?: boolean } = {},
): TranscriptRenderProbeResult {
  const messages = transcriptBlocksToDaemonMessages(blocks, {
    includeSourceIdentity: true,
    safeToolProjection: options.safeToolProjection,
  });
  const renderItems = groupParallelAgents(messages).map(
    (item): RenderProbeItem => {
      if (item.type === 'message') {
        const { message } = item;
        return {
          id: message.id,
          role: message.role,
          sourceBlockIds: [...new Set(message.sourceBlockIds ?? [message.id])],
          sourceToolCallIds: collectToolCallIds(message),
          fileToolCallIds: collectFileTargetToolCallIds(message),
          semanticText: semanticCopyText(message),
        };
      }
      return {
        id: item.key,
        role: 'parallel_agents',
        sourceBlockIds: [
          ...new Set(
            item.agents.flatMap((agent) => agent.sourceBlockIds ?? []),
          ),
        ],
        sourceToolCallIds: collectToolCallIdsFromTools(item.agents),
        fileToolCallIds: collectFileTargetToolCallIdsFromTools(item.agents),
        semanticText: item.agents.map(semanticToolText).join('\n'),
      };
    },
  );
  const semanticCopyHashes: Record<string, string> = Object.create(null);
  const semanticTexts = renderItems.map((item) => item.semanticText);
  const fileToolCallIdsByItem: string[][] = [];
  const items = renderItems.map((renderItem, index) => {
    const renderedItemId = `item-${encodeIdentity([
      renderItem.role,
      renderItem.id,
      String(renderItem.sourceBlockIds.length),
      ...renderItem.sourceBlockIds,
      String(renderItem.sourceToolCallIds.length),
      ...renderItem.sourceToolCallIds,
    ])}`;
    semanticCopyHashes[renderedItemId] = hashIdentity([semanticTexts[index]!]);
    const fileToolCallIds = [...renderItem.fileToolCallIds];
    fileToolCallIdsByItem.push(fileToolCallIds);
    const capabilities: TranscriptRenderedItemEvidence['capabilities'] = [
      'copy',
      ...(renderItem.role === 'user' ? (['edit-user-message'] as const) : []),
      ...(fileToolCallIds.length > 0 ? (['open-file'] as const) : []),
    ];
    return {
      renderedItemId,
      sourceBlockIds: renderItem.sourceBlockIds,
      sourceToolCallIds: renderItem.sourceToolCallIds,
      capabilities,
    };
  });
  const lastAssistantIndex = findLastMessageIndex(
    renderItems,
    (item) => item.role === 'assistant',
  );
  const lastUserIndex = findLastMessageIndex(
    renderItems,
    (item) => item.role === 'user',
  );
  const actionTarget = (
    index: number,
  ): TranscriptActionTargetEvidence | undefined => {
    const item = items[index];
    if (!item) return undefined;
    return {
      renderedItemId: item.renderedItemId,
      sourceBlockIds: item.sourceBlockIds,
      semanticHash: semanticCopyHashes[item.renderedItemId]!,
    };
  };
  return {
    items,
    semanticCopyHashes,
    actions: {
      copyAll: {
        renderedItemIds: items.map((item) => item.renderedItemId),
        semanticHash: hashIdentity([JSON.stringify(semanticTexts)]),
      },
      ...(lastAssistantIndex >= 0
        ? { copyLastReply: actionTarget(lastAssistantIndex) }
        : {}),
      ...(lastUserIndex >= 0
        ? { editLastUserMessage: actionTarget(lastUserIndex) }
        : {}),
      openFiles: items.flatMap((item, index) =>
        fileToolCallIdsByItem[index]!.map((sourceToolCallId) => ({
          renderedItemId: item.renderedItemId,
          sourceToolCallId,
        })),
      ),
    },
  };
}

function collectToolCallIds(message: DaemonMessage): string[] {
  if (message.role !== 'tool_group') return [];
  return collectToolCallIdsFromTools(message.tools);
}

function collectToolCallIdsFromTools(
  tools: readonly DaemonMessageToolCall[],
): string[] {
  const ids: string[] = [];
  const visit = (tools: readonly DaemonMessageToolCall[]): void => {
    for (const tool of tools) {
      ids.push(tool.callId);
      if (tool.subTools) visit(tool.subTools);
    }
  };
  visit(tools);
  return ids;
}

function collectFileTargetToolCallIds(message: DaemonMessage): string[] {
  if (message.role !== 'tool_group') return [];
  return collectFileTargetToolCallIdsFromTools(message.tools);
}

function collectFileTargetToolCallIdsFromTools(
  tools: readonly DaemonMessageToolCall[],
): string[] {
  const ids: string[] = [];
  const visit = (tools: readonly DaemonMessageToolCall[]): void => {
    for (const tool of tools) {
      if (isFileTargetTool(tool)) ids.push(tool.callId);
      if (tool.subTools) visit(tool.subTools);
    }
  };
  visit(tools);
  return ids;
}

function isFileTargetTool(tool: DaemonMessageToolCall): boolean {
  if (
    tool.kind === 'read' ||
    tool.kind === 'edit' ||
    tool.kind === 'delete' ||
    tool.kind === 'move'
  ) {
    return true;
  }
  if (
    tool.args &&
    typeof tool.args === 'object' &&
    !Array.isArray(tool.args) &&
    (typeof tool.args['path'] === 'string' ||
      typeof tool.args['file_path'] === 'string' ||
      typeof tool.args['absolute_path'] === 'string')
  ) {
    return true;
  }
  return Boolean(tool.content?.some((item) => item.path));
}

function findLastMessageIndex<T>(
  messages: readonly T[],
  predicate: (message: T) => boolean,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index]!)) return index;
  }
  return -1;
}

function semanticCopyText(message: DaemonMessage): string {
  switch (message.role) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
      return message.content;
    case 'tool_group':
      return message.tools.map(semanticToolText).join('\n');
    case 'plan':
      return message.todos
        .map((todo) => `${todo.status}: ${todo.content}`)
        .join('\n');
    case 'user_shell':
      return [message.command, message.output].filter(Boolean).join('\n');
    case 'btw':
      return [message.question, message.answer].filter(Boolean).join('\n');
    case 'insight_progress':
      return [message.stage, message.detail].filter(Boolean).join('\n');
    case 'insight_ready':
      return message.path;
    case 'insight_error':
      return message.error;
  }
}

function semanticToolText(tool: DaemonMessageToolCall): string {
  return [
    tool.title ?? tool.toolName,
    safeStringify(tool.content),
    safeStringify(tool.rawOutput),
    tool.subContent,
    ...(tool.subTools?.map(semanticToolText) ?? []),
  ]
    .filter(Boolean)
    .join('\n');
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function hashIdentity(parts: readonly string[]): string {
  const value = parts.join('\u0000');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function encodeIdentity(parts: readonly string[]): string {
  return parts
    .map((part) => {
      let encoded = '';
      for (let index = 0; index < part.length; index += 1) {
        encoded += part.charCodeAt(index).toString(16).padStart(4, '0');
      }
      return encoded;
    })
    .join('-');
}
