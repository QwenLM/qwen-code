import type {
  DaemonInputAnnotation,
  DaemonMidTurnTarget,
  PromptContentBlock,
} from '@qwen-code/sdk/daemon';
import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import { runIndexedDbRequest } from '../utils/indexeddb';

export interface MidTurnDraft {
  messageId: string;
  text: string;
  images?: PromptImage[];
  files?: PromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
}

export interface MidTurnDraftAdmission extends MidTurnDraft {
  target: DaemonMidTurnTarget;
  order: number;
  request?: { text: string; content?: PromptContentBlock[]; draftText: string };
}

const SCHEMA = {
  name: 'qwen-web-shell-mid-turn-drafts',
  version: 1,
  store: 'admissions',
};

export function midTurnDraftOwner(sessionId: string, clientId: string) {
  return `${JSON.stringify([sessionId, clientId])}:`;
}

export async function saveMidTurnAdmission(
  owner: string,
  draft: MidTurnDraftAdmission,
) {
  return runIndexedDbRequest(indexedDB, SCHEMA, 'readwrite', (store) =>
    store.put(draft, `${owner}${draft.messageId}`),
  );
}

export async function deleteMidTurnAdmission(owner: string, messageId: string) {
  return runIndexedDbRequest(indexedDB, SCHEMA, 'readwrite', (store) =>
    store.delete(`${owner}${messageId}`),
  );
}

export function readMidTurnCancelGeneration(owner: string): number {
  try {
    return Number(sessionStorage.getItem(`${SCHEMA.name}:${owner}`) ?? -1);
  } catch {
    return -1;
  }
}

export function saveMidTurnCancelGeneration(owner: string, generation: number) {
  try {
    sessionStorage.setItem(`${SCHEMA.name}:${owner}`, String(generation));
  } catch {
    // The in-memory fence still stops work in this tab.
  }
}

export async function loadMidTurnAdmissions(
  owner: string,
): Promise<MidTurnDraftAdmission[]> {
  const drafts = await runIndexedDbRequest<MidTurnDraftAdmission[]>(
    indexedDB,
    SCHEMA,
    'readonly',
    (store) => store.getAll(IDBKeyRange.bound(owner, `${owner}\uffff`)),
  );
  return drafts.sort((left, right) => left.order - right.order);
}
