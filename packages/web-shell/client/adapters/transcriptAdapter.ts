import type { DaemonTranscriptBlock } from '@qwen-code/webui/daemon-react-sdk';
import type { PermissionRequest, PermissionOptionKind } from './types';

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
    return {
      id: perm.requestId,
      sessionId: perm.sessionId,
      toolCallId,
      title: perm.title,
      content: [
        {
          type: 'text',
          text: perm.title || 'Tool permission',
        },
      ],
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
