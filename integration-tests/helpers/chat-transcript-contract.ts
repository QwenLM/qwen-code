import { readFileSync } from 'node:fs';
import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonEvent,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
} from '@qwen-code/sdk/daemon';
import { transcriptBlocksToDaemonMessages } from '../../packages/web-shell/client/adapters/transcriptToMessages.js';

export interface TranscriptCandidate {
  readonly blocks: readonly DaemonTranscriptBlock[];
  readonly compatible: boolean;
}

interface AcpTranscriptProbeState extends TranscriptCandidate {
  readonly transcript: DaemonTranscriptState;
}

export function readJsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

export function adaptDirectDaemonEvents(
  events: readonly DaemonEvent[],
  scopeKey: string,
): TranscriptCandidate {
  const transcript = reduceDaemonTranscriptEvents(
    createDaemonTranscriptState({ now: 0 }),
    events.flatMap((event) => normalizeDaemonEvent(event)),
    { now: 0 },
  );
  return projectStableTranscriptBlockIds(transcript.blocks, scopeKey);
}

export function adaptAcpTranscriptUpdates(
  updates: readonly unknown[],
  scopeKey: string,
): TranscriptCandidate {
  return updates.reduce<AcpTranscriptProbeState>(
    (state, update) => {
      const transcript = reduceDaemonTranscriptEvents(
        state.transcript,
        normalizeDaemonEvent({
          v: 1,
          type: 'session_update',
          data: { update },
        }),
        { now: 0, maxBlocks: Number.MAX_SAFE_INTEGER },
      );
      return {
        transcript,
        ...projectStableTranscriptBlockIds(transcript.blocks, scopeKey),
      };
    },
    {
      transcript: createDaemonTranscriptState({
        now: 0,
        maxBlocks: Number.MAX_SAFE_INTEGER,
      }),
      blocks: [],
      compatible: true,
    },
  );
}

export function projectStableTranscriptBlockIds(
  blocks: readonly DaemonTranscriptBlock[],
  scopeKey: string,
): TranscriptCandidate {
  const stableIdByRuntimeId = new Map<string, string>();
  const seen = new Set<string>();
  let compatible = true;
  for (const block of blocks) {
    const identity = getBlockIdentity(block);
    if (!identity) {
      compatible = false;
      continue;
    }
    const id = `${block.kind}-${hashIdentity([
      scopeKey,
      block.kind,
      ...identity,
    ])}`;
    if (seen.has(id)) compatible = false;
    seen.add(id);
    stableIdByRuntimeId.set(block.id, id);
  }
  const projected = blocks.map((block) => {
    const id = stableIdByRuntimeId.get(block.id) ?? block.id;
    if (block.kind !== 'tool' || !block.parentBlockId) {
      return id === block.id ? block : { ...block, id };
    }
    return {
      ...block,
      id,
      parentBlockId:
        stableIdByRuntimeId.get(block.parentBlockId) ?? block.parentBlockId,
    };
  });
  return { blocks: projected, compatible };
}

function getBlockIdentity(
  block: DaemonTranscriptBlock,
): readonly string[] | undefined {
  if (block.kind === 'tool') return ['toolCallId', block.toolCallId];
  if (block.kind === 'permission') return ['requestId', block.requestId];
  if (
    block.kind === 'user' &&
    block.sourceRecordIds &&
    block.sourceRecordIds.length > 0
  ) {
    return ['sourceRecordIds', ...block.sourceRecordIds];
  }
  if (block.segmentId) return ['segmentId', block.segmentId];
  if (
    block.kind === 'user' ||
    block.kind === 'assistant' ||
    block.kind === 'thought'
  ) {
    return undefined;
  }
  return block.eventId === undefined
    ? undefined
    : ['eventId', String(block.eventId)];
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

export function stableTailIdentity(
  complete: TranscriptCandidate,
  tail: TranscriptCandidate,
  completeOffset = 1,
): boolean {
  if (!complete.compatible || !tail.compatible) return false;
  if (
    JSON.stringify(
      complete.blocks.slice(completeOffset).map((block) => block.id),
    ) !== JSON.stringify(tail.blocks.map((block) => block.id))
  ) {
    return false;
  }
  const completeMessages = transcriptBlocksToDaemonMessages(complete.blocks);
  const tailMessages = transcriptBlocksToDaemonMessages(tail.blocks);
  return (
    JSON.stringify(
      completeMessages
        .slice(completeOffset)
        .map((message) => [message.id, message.role]),
    ) ===
    JSON.stringify(tailMessages.map((message) => [message.id, message.role]))
  );
}
