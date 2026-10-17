import type {
  DaemonTranscriptBlock,
  DaemonTranscriptStore,
} from '@qwen-code/sdk/daemon';
import type { Message } from '../adapters/types.js';

export interface MessageDeletionGroup {
  id: string;
  promptId?: string;
  promptIds?: string[];
  recordIds: string[];
}

export function messageDeletionGroups(
  messages: readonly Message[],
  groups: readonly MessageDeletionGroup[],
): Map<string, string> {
  const byPrompt = new Map(
    groups.flatMap((group) =>
      [
        ...new Set([
          ...(group.promptIds ?? []),
          ...(group.promptId ? [group.promptId] : []),
        ]),
      ].map((id) => [id, group.id] as const),
    ),
  );
  const byRecord = new Map(
    groups.flatMap((group) =>
      group.recordIds.map((id) => [id, group.id] as const),
    ),
  );
  const result = new Map<string, string>();
  let current: string | undefined;
  for (const message of messages) {
    const explicit =
      message.localCommandId ??
      (message.promptId ? byPrompt.get(message.promptId) : undefined) ??
      message.sourceRecordIds?.map((id) => byRecord.get(id)).find(Boolean);
    if (message.role === 'user' && !message.localCommandId) current = explicit;
    if (explicit && !message.localCommandId) current = explicit;
    // A different, unmapped prompt must never inherit a neighbouring group.
    const inherits =
      ['assistant', 'thinking', 'tool_group', 'error'].includes(message.role) ||
      (message.role === 'system' && message.source === 'prompt_cancelled');
    const group =
      explicit ?? (!message.promptId && inherits ? current : undefined);
    if (group) result.set(message.id, group);
  }
  return result;
}

export function localMessageDeletionGroups(messages: readonly Message[]) {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.localCommandId ? [message.localCommandId] : [],
      ),
    ),
  ].map((id) => ({ id, recordIds: [] }));
}

export function localDeletionBlocks(blocks: readonly DaemonTranscriptBlock[]) {
  return blocks.filter((block) => {
    const meta = 'meta' in block ? block.meta : undefined;
    return (
      typeof meta?.['localCommandId'] === 'string' ||
      block.promptId?.startsWith('local-command:')
    );
  });
}

const pendingLocalHistory = new WeakMap<
  DaemonTranscriptStore,
  readonly (DaemonTranscriptBlock | string | undefined)[]
>();

function deletionBlockIdentity(block: DaemonTranscriptBlock) {
  return block.sourceRecordIds?.[0]
    ? `record:${block.sourceRecordIds[0]}:${block.kind}`
    : block.promptId
      ? `prompt:${block.promptId}:${block.kind}`
      : undefined;
}

export function restoreLocalDeletionBlocks(
  store: DaemonTranscriptStore,
  before: readonly DaemonTranscriptBlock[],
) {
  const local = localDeletionBlocks(before);
  if (local.length === 0) return;
  const fresh = store.getSnapshot();
  const localIds = new Set(local.map((block) => block.id));
  const saved = pendingLocalHistory.get(store);
  const savedLocalIds = new Set(
    saved?.flatMap((entry) =>
      entry && typeof entry === 'object' ? [entry.id] : [],
    ) ?? [],
  );
  const reference =
    saved && local.some((block) => savedLocalIds.has(block.id))
      ? [
          ...saved.filter(
            (entry) =>
              !entry || typeof entry === 'string' || localIds.has(entry.id),
          ),
          ...local.filter((block) => !savedLocalIds.has(block.id)),
        ]
      : before.map((block) =>
          localIds.has(block.id) ? block : deletionBlockIdentity(block),
        );
  const remapped = new Map<string, string>();
  const repeated = new Set(
    localDeletionBlocks(fresh.blocks)
      .filter((block) => localIds.has(block.id))
      .map((block) => block.id),
  );
  const blocks = fresh.blocks.filter((block) => !repeated.has(block.id));
  if (blocks.length === 0) pendingLocalHistory.set(store, reference);
  else pendingLocalHistory.delete(store);
  for (const block of blocks) {
    if (localIds.has(block.id))
      remapped.set(block.id, `reloaded:${crypto.randomUUID()}`);
  }
  const indices = new Map(
    blocks.flatMap((block, index) => {
      const key = deletionBlockIdentity(block);
      return key ? [[key, index] as const] : [];
    }),
  );
  const slots: DaemonTranscriptBlock[][] = Array.from(
    { length: blocks.length + 1 },
    () => [],
  );
  let next = blocks.length;
  for (let index = reference.length - 1; index >= 0; index--) {
    const block = reference[index]!;
    if (typeof block === 'object') slots[next]!.unshift(block);
    else {
      const position = block && indices.get(block);
      if (typeof position === 'number') next = position;
    }
  }
  store.reset({
    ...fresh,
    retainedBytes: undefined,
    activeUserBlockId:
      fresh.activeUserBlockId &&
      (remapped.get(fresh.activeUserBlockId) ?? fresh.activeUserBlockId),
    activeAssistantBlockId:
      fresh.activeAssistantBlockId &&
      (remapped.get(fresh.activeAssistantBlockId) ??
        fresh.activeAssistantBlockId),
    activeThoughtBlockId:
      fresh.activeThoughtBlockId &&
      (remapped.get(fresh.activeThoughtBlockId) ?? fresh.activeThoughtBlockId),
    blocks: blocks
      .flatMap((block, index) => [
        ...slots[index]!,
        remapped.has(block.id)
          ? { ...block, id: remapped.get(block.id)! }
          : block,
      ])
      .concat(slots[blocks.length]!),
  });
}

const pendingLocalCommands = new WeakMap<DaemonTranscriptStore, Set<string>>();

export function beginLocalCommand(store: DaemonTranscriptStore, id: string) {
  const pending = pendingLocalCommands.get(store) ?? new Set<string>();
  pending.add(id);
  pendingLocalCommands.set(store, pending);
}

export function finishLocalCommand(store: DaemonTranscriptStore, id?: string) {
  if (id) pendingLocalCommands.get(store)?.delete(id);
}

export function hasPendingLocalCommands(store: DaemonTranscriptStore) {
  return (pendingLocalCommands.get(store)?.size ?? 0) > 0;
}

export function clearPendingLocalCommands(store: DaemonTranscriptStore) {
  pendingLocalCommands.delete(store);
}
