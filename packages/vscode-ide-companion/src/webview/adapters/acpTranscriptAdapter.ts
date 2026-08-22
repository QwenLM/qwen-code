import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonEvent,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
} from '@qwen-code/sdk/daemon';

export interface AcpTranscriptAdapterState {
  readonly transcript: DaemonTranscriptState;
  readonly blocks: readonly DaemonTranscriptBlock[];
  readonly compatible: boolean;
}

export function createAcpTranscriptAdapterState(): AcpTranscriptAdapterState {
  const transcript = createDaemonTranscriptState({ now: 0 });
  return { transcript, blocks: transcript.blocks, compatible: true };
}

export function reduceAcpTranscriptUpdate(
  state: AcpTranscriptAdapterState,
  update: unknown,
  scopeKey: string,
  now = Date.now(),
): AcpTranscriptAdapterState {
  const event: DaemonEvent = {
    v: 1,
    type: 'session_update',
    data: { update },
  };
  const transcript = reduceDaemonTranscriptEvents(
    state.transcript,
    normalizeDaemonEvent(event),
    { now },
  );
  const projected = projectStableTranscriptBlockIds(
    transcript.blocks,
    scopeKey,
  );
  return {
    transcript,
    blocks: projected.blocks,
    compatible: state.compatible && projected.compatible,
  };
}

export function adaptAcpTranscriptUpdates(
  updates: readonly unknown[],
  scopeKey: string,
): AcpTranscriptAdapterState {
  return updates.reduce<AcpTranscriptAdapterState>(
    (state, update) => reduceAcpTranscriptUpdate(state, update, scopeKey, 0),
    createAcpTranscriptAdapterState(),
  );
}

export function projectStableTranscriptBlockIds(
  blocks: readonly DaemonTranscriptBlock[],
  scopeKey: string,
): {
  readonly blocks: readonly DaemonTranscriptBlock[];
  readonly compatible: boolean;
} {
  const stableIdByRuntimeId = new Map<string, string>();
  const seen = new Set<string>();
  let compatible = true;
  for (const block of blocks) {
    const sourceIdentity = getBlockIdentity(block);
    if (!sourceIdentity) {
      compatible = false;
      continue;
    }
    const id = `${block.kind}-${hashIdentity([
      scopeKey,
      block.kind,
      ...sourceIdentity,
    ])}`;
    if (seen.has(id)) compatible = false;
    seen.add(id);
    stableIdByRuntimeId.set(block.id, id);
  }
  return {
    compatible,
    blocks: blocks.map((block) => {
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
    }),
  };
}

function getBlockIdentity(
  block: DaemonTranscriptBlock,
): readonly string[] | undefined {
  if (block.kind === 'tool') return ['toolCallId', block.toolCallId];
  if (block.kind === 'permission') return ['requestId', block.requestId];
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
