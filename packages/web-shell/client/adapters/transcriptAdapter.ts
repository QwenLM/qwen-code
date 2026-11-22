import type { DaemonTranscriptBlock } from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  ContentBlock,
  PermissionRequest,
  PermissionOptionKind,
} from './types.js';
import { isAskUserPermission } from '../utils/askUserPermission.js';

type PermissionTranscriptBlock = Extract<
  DaemonTranscriptBlock,
  { kind: 'permission' }
>;

export function extractPendingPermission(
  blocks: readonly DaemonTranscriptBlock[],
): PermissionRequest | null {
  for (const block of blocks) {
    if (!isPermissionBlock(block)) continue;
    const perm = block;
    if (perm.resolved) continue;
    const toolCallRecord = getRecord(perm.toolCall);
    const toolCallId =
      typeof toolCallRecord?.['toolCallId'] === 'string'
        ? toolCallRecord['toolCallId']
        : typeof toolCallRecord?.['id'] === 'string'
          ? toolCallRecord['id']
          : undefined;
    const toolKind =
      typeof toolCallRecord?.['kind'] === 'string'
        ? toolCallRecord['kind']
        : undefined;
    const metaRecord = getRecord(toolCallRecord?.['_meta']);
    const toolName =
      typeof metaRecord?.['toolName'] === 'string'
        ? metaRecord['toolName']
        : undefined;
    const titleIsMachine = metaRecord?.['titleIsMachine'];
    const todoApproval = getRecord(metaRecord?.['qwenTodoApproval']);
    const planId = getString(todoApproval, 'planId');
    const sourceCallId = getString(todoApproval, 'sourceCallId');
    return {
      id: perm.requestId,
      sessionId: perm.sessionId,
      toolCallId,
      title: perm.title,
      ...(typeof titleIsMachine === 'boolean' ? { titleIsMachine } : {}),
      toolKind,
      toolName,
      hasDiffPreview: hasPermissionDiffPreview(toolCallRecord),
      ...(planId && sourceCallId ? { todoPlan: { planId, sourceCallId } } : {}),
      ...getPermissionContent(toolCallRecord, perm.title),
      options: perm.options.map((opt) => ({
        id: opt.optionId,
        label: opt.label,
        kind: getPermissionOptionKind(opt.raw),
      })),
      rawInput: getPermissionRawInput(perm.toolCall),
    };
  }
  return null;
}

/**
 * Cheap block-level form of `isAskUserPermission(extractPendingPermission(...))`:
 * it reads only the tool name and raw input the classification needs, without
 * building the preview content (`escapePreviewText` of the serialized input).
 * Callers that classify a pending set on every render use this so a streaming
 * delta does not re-serialize each outstanding approval's payload.
 */
export function isAskUserPermissionBlock(
  block: DaemonTranscriptBlock,
): boolean {
  if (!isPermissionBlock(block) || block.resolved) return false;
  const toolCallRecord = getRecord(block.toolCall);
  const metaRecord = getRecord(toolCallRecord?.['_meta']);
  const toolName =
    typeof metaRecord?.['toolName'] === 'string'
      ? metaRecord['toolName']
      : undefined;
  return isAskUserPermission({
    toolName,
    rawInput: getPermissionRawInput(block.toolCall),
  });
}

/**
 * Cheap content revision for a pending permission block, used to key the
 * binding's split cache. A re-emitted `permission.request` under the same
 * request id can change the title/options while id and classification stay
 * put, so id+classification alone would serve a stale render-ready request.
 * Reads only scalar/option-id fields (no payload serialization) so a streaming
 * delta does not re-serialize the payload; `updatedAt` additionally catches
 * raw-input-only updates that bump the block's revision.
 */
export function pendingPermissionRevision(
  block: DaemonTranscriptBlock,
): string {
  if (!isPermissionBlock(block)) return '';
  const optionIds = block.options.map((option) => option.optionId).join(',');
  return `${block.updatedAt}:${block.title}:${optionIds}`;
}

function hasPermissionDiffPreview(
  toolCall: Record<string, unknown> | undefined,
): boolean {
  const content = toolCall?.['content'];
  if (!Array.isArray(content)) return false;
  return content.some((value) => {
    const block = getRecord(value);
    return (
      block?.['type'] === 'diff' &&
      typeof block['path'] === 'string' &&
      (typeof block['oldText'] === 'string' ||
        typeof block['newText'] === 'string')
    );
  });
}

export function escapePreviewText(text: string): string {
  return text.replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (character) =>
    character
      .split('')
      .map(
        (codeUnit) =>
          `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
      .join(''),
  );
}

function getPermissionContent(
  toolCall: Record<string, unknown> | undefined,
  fallback?: string,
): Pick<PermissionRequest, 'content' | 'contentIsInput'> {
  const rawContent = toolCall?.['content'];
  if (Array.isArray(rawContent)) {
    const content = rawContent.flatMap((value): ContentBlock[] => {
      const block = getRecord(value);
      if (
        block?.['type'] === 'diff' &&
        typeof block['path'] === 'string' &&
        typeof block['newText'] === 'string'
      ) {
        return [
          {
            type: 'diff',
            path: escapePreviewText(block['path']),
            oldText:
              typeof block['oldText'] === 'string'
                ? escapePreviewText(block['oldText'])
                : '',
            newText: escapePreviewText(block['newText']),
          },
        ];
      }
      const nested = getRecord(block?.['content']);
      const text =
        block?.['type'] === 'text' && typeof block['text'] === 'string'
          ? block['text']
          : nested?.['type'] === 'text' && typeof nested['text'] === 'string'
            ? nested['text']
            : undefined;
      return text ? [{ type: 'text', text }] : [];
    });
    if (content.length > 0) return { content };
  }
  const input = getExplicitPermissionInput(toolCall);
  // An empty input object carries no information; rendering its serialization
  // would show a bare `{}` as the approval body.
  if (
    input &&
    Object.keys(input).length > 0 &&
    !hasPermissionDiffPreview(toolCall)
  ) {
    return {
      content: [
        {
          type: 'text',
          text: escapePreviewText(JSON.stringify(input, null, 2)),
        },
      ],
      contentIsInput: true,
    };
  }
  return { content: [{ type: 'text', text: fallback || 'Tool permission' }] };
}

function isPermissionBlock(
  block: DaemonTranscriptBlock,
): block is PermissionTranscriptBlock {
  return block.kind === 'permission';
}

function getPermissionRawInput(
  toolCall: unknown,
): Record<string, unknown> | undefined {
  const record = getRecord(toolCall);
  if (!record) {
    return undefined;
  }

  return getExplicitPermissionInput(record) ?? record;
}

function getExplicitPermissionInput(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return (
    getRecord(record?.['rawInput']) ??
    getRecord(record?.['input']) ??
    getRecord(record?.['args'])
  );
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
