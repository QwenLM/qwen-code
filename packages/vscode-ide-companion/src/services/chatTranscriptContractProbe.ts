import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonEvent,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';

export interface TranscriptAdapterContext {
  readonly scopeKey: string;
  readonly generation: number;
}

export interface TranscriptDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly sourceIndex?: number;
}

export interface TranscriptIdentityEvidence {
  readonly blockId: string;
  readonly sourceKind: string;
  readonly sourceIdentity: readonly string[];
}

export interface TranscriptAdapterProbeResult {
  readonly model: { readonly blocks: readonly DaemonTranscriptBlock[] };
  readonly diagnostics: readonly TranscriptDiagnostic[];
  readonly identities: readonly TranscriptIdentityEvidence[];
}

export function probeDirectDaemonTranscript(
  events: readonly DaemonEvent[],
  context: TranscriptAdapterContext,
  activeContext: TranscriptAdapterContext,
): TranscriptAdapterProbeResult {
  return probeEvents(events, context, activeContext);
}

export function probeAcpTranscriptUpdates(
  updates: readonly unknown[],
  context: TranscriptAdapterContext,
  activeContext: TranscriptAdapterContext,
): TranscriptAdapterProbeResult {
  const events = updates.map(
    (update): DaemonEvent => ({
      v: 1,
      type: 'session_update',
      data: { update },
    }),
  );
  return probeEvents(events, context, activeContext);
}

function probeEvents(
  events: readonly DaemonEvent[],
  context: TranscriptAdapterContext,
  activeContext: TranscriptAdapterContext,
): TranscriptAdapterProbeResult {
  if (
    context.scopeKey !== activeContext.scopeKey ||
    context.generation !== activeContext.generation
  ) {
    return {
      model: { blocks: [] },
      diagnostics: [
        { code: 'stale_scope_generation_ignored', severity: 'info' },
      ],
      identities: [],
    };
  }

  let state = createDaemonTranscriptState({ now: 0 });
  const diagnostics: TranscriptDiagnostic[] = [];
  events.forEach((event, sourceIndex) => {
    const normalized = normalizeDaemonEvent(event);
    if (normalized.some((item) => item.type === 'debug')) {
      diagnostics.push({
        code: 'normalizer_debug_output',
        severity: 'warning',
        sourceIndex,
      });
    }
    state = reduceDaemonTranscriptEvents(state, normalized, { now: 0 });
  });
  const projected = projectStableBlockIds(state.blocks, context.scopeKey);
  const seenBlockIds = new Set<string>();
  const identities = projected.blocks.map((block) => {
    const sourceIdentity = getBlockIdentity(block);
    if (sourceIdentity.length === 0) {
      diagnostics.push({
        code: 'stable_native_identity_missing',
        severity: 'error',
      });
    } else if (seenBlockIds.has(block.id)) {
      diagnostics.push({
        code: 'duplicate_stable_block_identity',
        severity: 'error',
      });
    }
    seenBlockIds.add(block.id);
    return {
      blockId: block.id,
      sourceKind: block.kind,
      sourceIdentity,
    };
  });
  return {
    model: { blocks: projected.blocks },
    diagnostics,
    identities,
  };
}

function getBlockIdentity(block: DaemonTranscriptBlock): string[] {
  if (block.kind === 'tool') {
    return ['toolCallId', block.toolCallId];
  }
  if (block.kind === 'permission') {
    return ['requestId', block.requestId];
  }
  if (block.segmentId) {
    return ['segmentId', block.segmentId];
  }
  if (
    block.kind === 'user' ||
    block.kind === 'assistant' ||
    block.kind === 'thought'
  ) {
    return [];
  }
  if (block.eventId !== undefined) {
    return ['eventId', String(block.eventId)];
  }
  return [];
}

function projectStableBlockIds(
  blocks: readonly DaemonTranscriptBlock[],
  scopeKey: string,
): { readonly blocks: readonly DaemonTranscriptBlock[] } {
  const stableIdByRuntimeId = new Map<string, string>();
  for (const block of blocks) {
    const sourceIdentity = getBlockIdentity(block);
    if (sourceIdentity.length === 0) continue;
    stableIdByRuntimeId.set(
      block.id,
      `${block.kind}-${hashIdentity([
        scopeKey,
        block.kind,
        ...sourceIdentity,
      ])}`,
    );
  }
  return {
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
