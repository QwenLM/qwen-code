/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  consumePendingPromptEvents,
  getPendingPromptEvents,
  getPendingPromptVersion,
  subscribePendingPromptEvents,
  subscribePendingPromptVersion,
  useDaemonMidTurnInjected,
  useDaemonSessionOwnerGuard,
  type DaemonSessionActions,
  type DaemonStreamingState,
  type DaemonWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonInputAnnotation,
  DaemonMidTurnMessagesResult,
  DaemonPendingPromptSummary,
  DaemonSessionAttachmentReference,
  DaemonTranscriptStore,
  PromptContentBlock,
} from '@qwen-code/sdk/daemon';
import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import type { EditorHandle } from './useComposerCore';
import { removeInjectedFromQueue } from '../midTurnDedup';
import { isCommandPrompt } from '../utils/localCommandQueue';
import type { getTranslator } from '../i18n';
import type { QueuedPrompt } from '../components/QueuedPromptDisplay';
import { readWorkspaceFileAsBlob } from '../components/artifacts/artifactUtils';
import {
  MAX_FILE_ATTACHMENT_DATA_BYTES,
  normalizeImageMediaType,
  normalizeTextMediaType,
  sanitizeAttachmentName,
} from '../utils/imageIngestion';

interface RefBox<T> {
  current: T;
}

interface UseQueuedPromptsArgs {
  connected: boolean;
  writeBlocked?: boolean;
  sessionId?: string;
  workspaceCwd?: string;
  clientId?: string;
  /**
   * Whether the daemon advertises `session_mid_turn_message_mutation`. Gates the
   * mid-turn delete/edit mutations — including the keyboard path, which the view
   * layer's hidden buttons can't reach — so an older daemon that mints message
   * ids without the route isn't sent a DELETE it answers with a 404.
   */
  canMutateMidTurn: boolean;
  /**
   * Whether the daemon advertises `session_mid_turn_message_query`. Gates the
   * daemon-owned queue lifecycle. With it, accepted messages are restored and
   * reconciled by id across drain or idle promotion; without it the hook keeps
   * the legacy local fallback used by older daemons.
   */
  canQueryMidTurn: boolean;
  /**
   * Whether the daemon advertises `session_attachments`. With it,
   * attachments travel with a mid-turn message and are injected into the
   * running turn; without it they stay queued for the next turn.
   */
  canInjectMidTurnMedia: boolean;
  workspaceFileActions?: Pick<DaemonWorkspaceActions, 'readFileBytes' | 'stat'>;
  streamingState: DaemonStreamingState;
  sessionHasActivePrompt?: boolean;
  /** Keep ordinary submissions local until the Goal is paused, cleared, or the
   * user explicitly inserts one into the current turn. */
  holdQueuedPromptsLocally?: boolean;
  sessionActions: DaemonSessionActions;
  store: DaemonTranscriptStore;
  editorRef: RefBox<EditorHandle | null>;
  reportError: (error: unknown, fallback: string) => void;
  t: ReturnType<typeof getTranslator>;
}

const MAX_COMPLETED_PROMPT_IDS = 100;

function queueOwnerKey(
  workspaceCwd: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  return sessionId ? `${workspaceCwd ?? ''}\u0000${sessionId}` : undefined;
}

/**
 * Resolve the stash key holding `sessionId`'s prompts as of NOW.
 *
 * The workspace half of an owner key can resolve — or change — at any time, and
 * the owner-change effect relocates the whole stash onto the new key and
 * deletes the old one. A key captured when an insert started can therefore be
 * gone by the time that insert settles; writing through it would silently drop
 * the update. Session ids are unique (the same invariant the relocation itself
 * relies on), so any stash whose session half matches belongs to this session.
 */
function resolveStashKey(
  stash: ReadonlyMap<string, QueuedPrompt[]>,
  capturedKey: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (capturedKey !== undefined && stash.has(capturedKey)) return capturedKey;
  if (!sessionId) return capturedKey;
  const suffix = `\u0000${sessionId}`;
  for (const key of stash.keys()) {
    if (key.endsWith(suffix)) return key;
  }
  return capturedKey;
}

function isLocallyHeldPrompt(prompt: QueuedPrompt): boolean {
  return (
    prompt.serverPromptId === undefined &&
    prompt.serverState === undefined &&
    prompt.midTurnState === undefined
  );
}

/**
 * Drop a finished release chain from `ref` so later sends stop queueing behind
 * it. A prompt typed while the chain is draining appends itself to the tail,
 * so "the tail I awaited" and "the tail the chain has now" can differ: when
 * they do, re-arm on the newer tail instead of retiring a chain that still has
 * links to run.
 */
function retireChainWhenDrained<T extends { tail: Promise<void> }>(
  ref: { current: T | null },
  chain: T,
): void {
  const tail = chain.tail;
  const settle = () => {
    if (ref.current !== chain) return;
    if (chain.tail !== tail) {
      retireChainWhenDrained(ref, chain);
      return;
    }
    ref.current = null;
  };
  void tail.then(settle, settle);
}

interface AnnotatedFiles {
  displayText: string;
  paths: string[];
}

function annotatedFiles(
  text: string,
  inputAnnotations: readonly DaemonInputAnnotation[] | undefined,
): AnnotatedFiles | undefined {
  if (!inputAnnotations || inputAnnotations.length === 0) {
    return { displayText: text.trim(), paths: [] };
  }
  const leadingWhitespace = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const ranges: Array<{ start: number; end: number }> = [];
  const paths: string[] = [];
  let previousEnd = 0;
  for (const annotation of inputAnnotations) {
    const start = annotation.start - leadingWhitespace;
    const end = annotation.end - leadingWhitespace;
    const metadata = annotation.reference.metadata;
    const fileKind =
      metadata && typeof metadata === 'object' && 'fileKind' in metadata
        ? metadata.fileKind
        : undefined;
    if (
      annotation.reference.kind !== 'file' ||
      (fileKind !== undefined && fileKind !== 'file') ||
      !annotation.reference.value ||
      start < previousEnd ||
      start < 0 ||
      end > trimmed.length ||
      trimmed.slice(start, end) !== annotation.text
    ) {
      return undefined;
    }
    ranges.push({ start, end });
    paths.push(annotation.reference.value);
    previousEnd = end;
  }
  let displayText = trimmed;
  for (const range of ranges.reverse()) {
    displayText = `${displayText.slice(0, range.start)}${displayText.slice(range.end)}`;
  }
  return {
    displayText: displayText.trim(),
    paths,
  };
}

function annotatedFile(filePath: string): PromptFile {
  const name = sanitizeAttachmentName(filePath);
  return {
    name,
    media_type:
      normalizeImageMediaType('', name) ??
      normalizeTextMediaType('', name) ??
      'application/octet-stream',
  };
}

/**
 * Merge a restored prompt's text into the editor content. Restoration paths
 * (failed submits, failed mid-turn inserts, queue clears) prepend the prompt
 * above whatever the user is currently typing — but several of them can fire
 * for the same prompt across reconnects/refreshes, and a user retrying an
 * identical message produces the same text twice. Stacking those copies is
 * what #7128 reports as "inputs concatenated after refresh", so restoring
 * text that is already present at the top of the editor is a no-op.
 */
export function mergeRestoredPromptText(current: string, text: string): string {
  if (!current.trim()) return text;
  if (current === text || current.startsWith(`${text}\n`)) return current;
  return `${text}\n${current}`;
}

type RefreshPendingPromptsResult =
  | {
      status: 'refreshed';
      pendingPrompts: readonly DaemonPendingPromptSummary[];
    }
  | { status: 'skipped' | 'superseded' | 'failed' };

function areQueuedPromptsEqual(
  left: readonly QueuedPrompt[],
  right: readonly QueuedPrompt[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((prompt, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      prompt.id === other.id &&
      prompt.sessionId === other.sessionId &&
      prompt.text === other.text &&
      prompt.serverPromptId === other.serverPromptId &&
      prompt.serverState === other.serverState &&
      prompt.midTurnState === other.midTurnState &&
      prompt.midTurnMessageId === other.midTurnMessageId &&
      prompt.midTurnFailedAction === other.midTurnFailedAction &&
      prompt.isInserting === other.isInserting &&
      prompt.isEditing === other.isEditing &&
      prompt.isRemoving === other.isRemoving &&
      prompt.payloadCompleteness === other.payloadCompleteness &&
      prompt.submittedPrompt === other.submittedPrompt &&
      (prompt.images?.length ?? 0) === (other.images?.length ?? 0) &&
      (prompt.files?.length ?? 0) === (other.files?.length ?? 0) &&
      (prompt.inputAnnotations?.length ?? 0) ===
        (other.inputAnnotations?.length ?? 0)
    );
  });
}

function toStoreImages(
  images: readonly PromptImage[] | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({
    data: image.data,
    mimeType: image.media_type || 'image/*',
  }));
}

/**
 * Recover queued-row images from a reconciliation snapshot's media blocks.
 * After a page refresh the in-memory pending admission is gone, so the daemon
 * snapshot is the only source left for the attachments.
 */
function contentToImages(
  content: readonly PromptContentBlock[] | undefined,
): PromptImage[] | undefined {
  if (!content || content.length === 0) return undefined;
  const images: PromptImage[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] !== 'image') continue;
    const data = record['data'];
    const mimeType = record['mimeType'];
    if (typeof data === 'string') {
      images.push({
        data,
        media_type: typeof mimeType === 'string' ? mimeType : 'image/*',
      });
    }
  }
  return images.length > 0 ? images : undefined;
}

function contentToFiles(
  content: readonly PromptContentBlock[] | undefined,
): PromptFile[] | undefined {
  if (!content || content.length === 0) return undefined;
  const files: PromptFile[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (
      record['type'] !== 'resource' ||
      typeof record['attachmentId'] !== 'string'
    ) {
      continue;
    }
    files.push({
      name: record['attachmentId'],
      attachmentId: record['attachmentId'],
      media_type:
        typeof record['mimeType'] === 'string'
          ? record['mimeType']
          : 'application/octet-stream',
      ...(typeof record['size'] === 'number' ? { size: record['size'] } : {}),
    });
  }
  return files.length > 0 ? files : undefined;
}

// The SDK substitutes this text block for a attachment reference it could not
// hydrate (DaemonSessionClient.hydrateBlock); keep in sync with the SDK.
const MEDIA_UNAVAILABLE_PLACEHOLDER = '[Attachment is no longer available]';

function contentHasDegradedMedia(
  content: readonly PromptContentBlock[] | undefined,
): boolean {
  if (!content || content.length === 0) return false;
  return content.some((block) => {
    if (typeof block !== 'object' || block === null) return false;
    const record = block as Record<string, unknown>;
    return (
      record['type'] === 'text' &&
      record['text'] === MEDIA_UNAVAILABLE_PLACEHOLDER
    );
  });
}

// A transient hydration failure (anything but 404/410) returns the raw
// reference block — an image-shaped block without string `data` — instead of
// the placeholder (DaemonSessionClient.hydrateBlock). Treat it as provisional
// degradation: the daemon still holds the blob, so a later hydrated snapshot
// upgrades the row back, while editing it must stay blocked.
function contentHasUnhydratedMedia(
  content: readonly PromptContentBlock[] | undefined,
): boolean {
  if (!content || content.length === 0) return false;
  return content.some((block) => {
    if (typeof block !== 'object' || block === null) return false;
    const record = block as Record<string, unknown>;
    return (
      (record['type'] === 'image' && typeof record['data'] !== 'string') ||
      (record['type'] === 'resource' &&
        typeof record['attachmentId'] === 'string')
    );
  });
}

function toStoreFiles(
  files: readonly PromptFile[] | undefined,
): Array<{ name: string; mimeType: string }> | undefined {
  if (!files || files.length === 0) return undefined;
  return files.map((file) => ({
    name: file.name,
    mimeType: file.media_type || 'text/plain',
  }));
}

// The daemon renders a text-less prompt with an image block as this
// placeholder (`extractPromptText` in packages/acp-bridge/src/bridge.ts); a
// text-less prompt without one renders as ''.
const IMAGE_ONLY_PROMPT_TEXT = '[image]';

function pendingPromptTextsMatch(localText: string, serverText: string) {
  return (
    localText === serverText ||
    (localText.trim().length === 0 && serverText === IMAGE_ONLY_PROMPT_TEXT)
  );
}

/**
 * Whether a payload carries more than its rendered text: attachments, or the
 * reference chips a rendering drops. A started event cannot reproduce such a
 * payload, so every route that owes it a transcript copy keeps it under the
 * daemon's id — and the mid-turn insert route, which sends text only, refuses
 * such a row rather than drop what it cannot carry.
 */
function eventCannotReproducePayload(prompt: QueuedPrompt): boolean {
  return (
    (prompt.images?.length ?? 0) > 0 ||
    (prompt.files?.length ?? 0) > 0 ||
    (prompt.inputAnnotations?.length ?? 0) > 0
  );
}

/**
 * Whether a local row still in flight is the same message as a server-side
 * prompt. A rendered text is not an identity: the daemon renders every
 * text-less prompt with an image block as the same '[image]' placeholder,
 * and one without an image block as ''. A row without attachments binds by
 * exact text; the daemon omits the originator when the submitter had no
 * client id, which is still possibly ours, so that route fails open. A row
 * carrying attachments may claim a server prompt only through the guarded
 * placeholder route: stamped with this client's id, rendered text-less, and
 * carrying fully hydrated media identical to the row's — anything that
 * cannot be compared is refused.
 */
function matchesUnboundSubmittingRow(
  item: QueuedPrompt,
  server: {
    text: string;
    originatorClientId?: string | undefined;
    content?: readonly PromptContentBlock[] | undefined;
  },
  clientId: string | undefined,
): boolean {
  if (item.serverPromptId || item.serverState !== 'submitting') return false;
  const hasAttachments =
    (item.images?.length ?? 0) > 0 || (item.files?.length ?? 0) > 0;
  if (!hasAttachments) {
    return (
      item.text === server.text &&
      (server.originatorClientId === undefined ||
        server.originatorClientId === clientId)
    );
  }
  if (
    server.originatorClientId === undefined ||
    server.originatorClientId !== clientId
  ) {
    return false;
  }
  // A prompt with text renders that text, so only a text-less row can own a
  // placeholder rendering.
  if (item.text.trim().length > 0) return false;
  if (server.text !== IMAGE_ONLY_PROMPT_TEXT && server.text !== '') {
    return false;
  }
  if (server.content === undefined) {
    // The started event carries no content to compare media with, so no
    // attachment row can prove ownership here. An ordinary submission's echo
    // waits for its own admission id, and a resubmitted row binds in the
    // submit body's id arm.
    return false;
  }
  if ((item.files?.length ?? 0) > 0) return false;
  // A partially hydrated payload may be silently shortened — a lost image
  // degrades to a text placeholder and a transient failure stays a raw
  // reference, and contentToImages collects neither — so only fully hydrated
  // images can prove ownership.
  if (
    contentHasDegradedMedia(server.content) ||
    contentHasUnhydratedMedia(server.content)
  ) {
    return false;
  }
  const serverImages = contentToImages(server.content);
  if (!serverImages) return false;
  const itemImages = item.images ?? [];
  if (itemImages.length !== serverImages.length) return false;
  return itemImages.every(
    (image, index) => image.data === serverImages[index]?.data,
  );
}

export interface UseQueuedPromptsResult {
  queuedPrompts: QueuedPrompt[];
  queuedTexts: string[];
  enqueuePrompt: (
    text: string,
    images?: PromptImage[],
    files?: PromptFile[],
    onComplete?: () => void,
    inputAnnotations?: DaemonInputAnnotation[],
    onAdmitted?: () => void,
    submittedPrompt?: string,
  ) => boolean;
  removeQueuedPrompt: (id: number) => void;
  insertQueuedPrompt: (id: number) => Promise<void>;
  editQueuedPrompt: (id: number) => Promise<void>;
  editLastQueuedPrompt: () => boolean;
  clearQueuedPrompts: () => boolean;
}

export function useQueuedPrompts({
  connected,
  writeBlocked = false,
  sessionId,
  workspaceCwd,
  clientId,
  canMutateMidTurn,
  canQueryMidTurn,
  canInjectMidTurnMedia,
  workspaceFileActions,
  streamingState,
  sessionHasActivePrompt = false,
  holdQueuedPromptsLocally = false,
  sessionActions,
  store,
  editorRef,
  reportError,
  t,
}: UseQueuedPromptsArgs): UseQueuedPromptsResult {
  const writeBlockedRef = useRef(writeBlocked);
  writeBlockedRef.current = writeBlocked;
  const sessionOwnerGuard = useDaemonSessionOwnerGuard();
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const ownerTokenRef = useRef({
    sessionId,
    workspaceCwd,
    snapshot: sessionOwnerGuard.capture(),
  });
  if (
    ownerTokenRef.current.sessionId !== sessionId ||
    ownerTokenRef.current.workspaceCwd !== workspaceCwd ||
    !ownerTokenRef.current.snapshot.isCurrent()
  ) {
    ownerTokenRef.current = {
      sessionId,
      workspaceCwd,
      snapshot: sessionOwnerGuard.capture(),
    };
  }
  const ownerToken = ownerTokenRef.current;
  const isCurrentOwnerTokenRef = useRef(
    (token: typeof ownerToken) =>
      ownerTokenRef.current === token && token.snapshot.isCurrent(),
  );
  const queuedPromptsOwnerRef = useRef(ownerToken);
  /**
   * Prompts the serial release chain has stamped `submitting` but not yet
   * handed to `submitPendingPrompt`. Each link drops its own id as it fires,
   * and the owner-change effect empties the set after reading it, so at any
   * owner change it holds exactly the rows the chain never got to POST.
   */
  const unreleasedPromptIdsRef = useRef<Set<number>>(new Set());
  /**
   * The live serial release chain, if a drain is in flight. Published so that
   * `enqueuePrompt` can append to its tail: the chain exists to keep a prompt
   * carrying media from being overtaken, and a prompt typed inside that window
   * was typed AFTER the rows still waiting on it, so POSTing it immediately
   * would land it ahead of them.
   */
  const releaseChainRef = useRef<{
    owner: typeof ownerToken;
    tail: Promise<void>;
  } | null>(null);
  const heldPromptsByOwnerRef = useRef<Map<string, QueuedPrompt[]>>(new Map());
  const nextQueuedPromptIdRef = useRef(1);
  const latestSessionIdRef = useRef(sessionId);
  const latestWorkspaceCwdRef = useRef(workspaceCwd);
  const latestConnectedRef = useRef(connected);
  const midTurnEnqueueAbortRef = useRef<AbortController | null>(null);
  const explicitInsertGenerationsRef = useRef<Map<number, number>>(new Map());
  const submitAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const removingServerPromptIdsRef = useRef<Set<string>>(new Set());
  const displayedServerPromptIdsRef = useRef<Set<string>>(new Set());
  const settledServerPromptIdsRef = useRef<Set<string>>(new Set());
  const completionCallbacksRef = useRef<Map<string, () => void>>(new Map());
  const completedPromptIdsRef = useRef<Set<string>>(new Set());
  const completedPromptIdOrderRef = useRef<string[]>([]);
  const pendingMidTurnAdmissionsRef = useRef<
    Map<string, { prompt: QueuedPrompt; workspaceCwd?: string }>
  >(new Map());
  const appendedBeforeResponsePromptIdsRef = useRef<Set<string>>(new Set());
  const removedBeforeResponsePromptIdsRef = useRef<Set<string>>(new Set());
  const latestRawStreamingStateRef = useRef(streamingState);
  const latestSessionActiveRef = useRef(
    streamingState !== 'idle' || sessionHasActivePrompt,
  );
  const holdQueuedPromptsLocallyRef = useRef(holdQueuedPromptsLocally);
  const refreshRequestSeqRef = useRef(0);
  /**
   * The tracked in-flight pending-prompts GET, if any. A caller that finds its
   * own session's flight under a current owner token waits it out rather than
   * dispatching beside it, then takes exactly one fresh snapshot — or joins a
   * flight dispatched after its own `notBefore` anchor, which is what keeps
   * two re-awaiting submit bodies from invalidating each other forever. One
   * slot means a dispatch for another session, or one after an owner-token
   * invalidation, leaves the previous flight untracked while a second GET for
   * the same session runs beside it; the dispatch-sequence fence, not this
   * ref, is what stops that older flight from syncing a stale snapshot. `seq`
   * is the dispatch sequence: the wait path joins only a newer flight, and the
   * `finally` clears this ref only while it still holds that dispatch.
   */
  const inflightRefreshRef = useRef<{
    sessionId: string;
    ownerToken: typeof ownerToken;
    seq: number;
    promise: Promise<RefreshPendingPromptsResult>;
  } | null>(null);
  /** Stale-response fence for `getMidTurnMessages` reconciliation calls. */
  const midTurnReconcileSeqRef = useRef(0);
  const restoredPromptIdsRef = useRef<Set<number>>(new Set());
  const pendingStartedByPromptIdRef = useRef<
    Map<string, { text: string; rowIdFrontier: number }>
  >(new Map());
  /**
   * Unbound `submitting` rows the confirming sync spliced out because an
   * already-displayed server prompt matched their rendered text. A submit
   * body that finds its row gone after the confirmation refresh reads this
   * to tell "the sync claimed the row" apart from "the user cleared it" —
   * only the latter licenses a DELETE.
   */
  const syncClaimedSubmittingRowIdsRef = useRef<Set<number>>(new Set());
  /**
   * Payloads a started event cannot reproduce — attachments, or the
   * reference chips its rendered text drops — keyed by the id the daemon
   * returned. Written by a resubmission's confirmation head, by both claim
   * arms whose row the sync spliced, by the ordinary discard arm before it
   * issues a removal, and by the duplicate-drop arm whose row a materialized
   * copy replaced — so when no payload-complete local row remains, the echo
   * comes from here instead of the event's rendering.
   */
  const pendingEchoByPromptIdRef = useRef<Map<string, QueuedPrompt>>(new Map());
  /**
   * Prompts the user cleared while nothing on hand said what the daemon was
   * doing with them — no snapshot had arrived, or the one that had no longer
   * listed the prompt. Removing needs positive evidence that the prompt is
   * still queued, so the clear is applied by the next snapshot that carries it
   * instead of being dropped on the floor.
   */
  const clearedUnconfirmedPromptIdsRef = useRef<Set<string>>(new Set());
  /**
   * Started events that arrived while the prompt's removal was in flight.
   * The event cannot be honoured yet: a removal that succeeds means the
   * daemon either never dispatched the prompt or aborted the turn the user
   * asked to cancel. The removal can still come back not-removed (the id
   * absent, or already removed by another client while the doomed prompt
   * runs on to settle), so the submit-body, discard and deferred-clear
   * failure arms replay from here instead of dropping the message from the
   * transcript; the two explicit user-action removal arms do not replay yet.
   */
  const startedDuringRemovalRef = useRef<Map<string, string>>(new Map());
  /**
   * Prompts whose submit body returned with the row still unbound because no
   * confirmation snapshot ever landed, mapped to that row's id. From that
   * return on, no in-flight admission will echo the message, so the
   * settle-time last-chance echo must not defer to a row that merely renders
   * the same text; the id also lets the settle drop a still-unbound row. A
   * row carrying images or files cannot bind once its text is non-blank — the
   * attachment route refuses it, and the started event carries no content to
   * compare — and a text-less image row that has not bound by settle time has
   * no later snapshot left to bind from. An annotation-only row does bind, by
   * exact text, so it is no longer unbound by then.
   */
  const returnedUnboundPromptIdsRef = useRef<Map<string, number>>(new Map());

  const rememberCompletedPromptId = useCallback((promptId: string) => {
    if (completedPromptIdsRef.current.has(promptId)) return;
    completedPromptIdsRef.current.add(promptId);
    completedPromptIdOrderRef.current.push(promptId);
    while (
      completedPromptIdOrderRef.current.length > MAX_COMPLETED_PROMPT_IDS
    ) {
      const expiredPromptId = completedPromptIdOrderRef.current.shift();
      if (expiredPromptId)
        completedPromptIdsRef.current.delete(expiredPromptId);
    }
  }, []);

  const removeDaemonOwnedPrompt = useCallback((promptId: string) => {
    const next = queuedPromptsRef.current.filter(
      (prompt) =>
        prompt.isEditing ||
        prompt.isRemoving ||
        (prompt.serverPromptId !== promptId &&
          prompt.midTurnMessageId !== promptId),
    );
    if (next.length === queuedPromptsRef.current.length) return;
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);

  latestSessionIdRef.current = sessionId;
  latestWorkspaceCwdRef.current = workspaceCwd;
  latestConnectedRef.current = connected;
  holdQueuedPromptsLocallyRef.current = holdQueuedPromptsLocally;
  const sessionActive = streamingState !== 'idle' || sessionHasActivePrompt;
  useLayoutEffect(() => {
    midTurnReconcileSeqRef.current += 1;
  }, [sessionActive]);
  latestRawStreamingStateRef.current = streamingState;
  latestSessionActiveRef.current = sessionActive;

  const visibleQueuedPrompts =
    queuedPromptsOwnerRef.current === ownerToken ? queuedPrompts : [];
  const queuedTexts = visibleQueuedPrompts.map((prompt) => prompt.text);

  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

  const settleCompletionCallback = useCallback(
    (promptId: string, onComplete: () => void) => {
      if (completedPromptIdsRef.current.delete(promptId)) {
        completedPromptIdOrderRef.current =
          completedPromptIdOrderRef.current.filter((id) => id !== promptId);
        onComplete();
        return;
      }
      // A settle whose terminal event fired a registered callback is
      // deliberately not remembered as completed: a registration arriving
      // after that settle could only ever fire again on a duplicate
      // terminal event.
      if (settledServerPromptIdsRef.current.has(promptId)) return;
      completionCallbacksRef.current.set(promptId, onComplete);
    },
    [],
  );

  const syncServerQueuedPrompts = useCallback(
    (
      serverQueued: DaemonPendingPromptSummary[],
      targetSessionId: string,
      clientId: string | undefined,
    ) => {
      const next = queuedPromptsRef.current.filter((p) => {
        if (
          (p.isEditing || p.isRemoving) &&
          (!p.serverPromptId ||
            removingServerPromptIdsRef.current.has(p.serverPromptId))
        ) {
          return true;
        }
        const promptId = p.serverPromptId ?? p.midTurnMessageId;
        if (promptId && settledServerPromptIdsRef.current.has(promptId)) {
          return false;
        }
        if (!p.serverPromptId) return true;
        // A flight dispatched before a submit body bound this row may have
        // been served before the daemon admitted the prompt — the client's
        // dispatch order is not the daemon's processing order — so the
        // snapshot's silence proves nothing: keep a row whose bind is not
        // older than the dispatch that produced this snapshot.
        if ((p.boundAtSeq ?? 0) >= refreshRequestSeqRef.current) return true;
        return serverQueued.some(
          (server) => server.promptId === p.serverPromptId,
        );
      });
      for (const serverPrompt of serverQueued) {
        if (
          removingServerPromptIdsRef.current.has(serverPrompt.promptId) ||
          settledServerPromptIdsRef.current.has(serverPrompt.promptId)
        ) {
          continue;
        }
        const existingIndex = next.findIndex(
          (p) =>
            p.serverPromptId === serverPrompt.promptId ||
            p.midTurnMessageId === serverPrompt.promptId,
        );
        const hasDisplayedPrompt = displayedServerPromptIdsRef.current.has(
          serverPrompt.promptId,
        );
        // Extract attachment summaries from the server prompt's content field.
        const serverImages = contentToImages(serverPrompt.content);
        const serverFiles = contentToFiles(serverPrompt.content);
        // A partially hydrated payload (a loss placeholder or a raw,
        // unhydrated reference) must not upgrade a row: editing it would
        // silently discard the attachments the daemon still holds. Only
        // fully hydrated content restores images and clears summary-only.
        const contentFullyHydrated =
          !contentHasDegradedMedia(serverPrompt.content) &&
          !contentHasUnhydratedMedia(serverPrompt.content);
        if (existingIndex !== -1) {
          if (
            next[existingIndex]!.isEditing ||
            next[existingIndex]!.isRemoving
          ) {
            continue;
          }
          if (hasDisplayedPrompt) {
            next.splice(existingIndex, 1);
            continue;
          }
          next[existingIndex] = {
            ...next[existingIndex]!,
            ...(next[existingIndex]!.payloadCompleteness === 'summary-only'
              ? { text: serverPrompt.text, submittedPrompt: undefined }
              : {}),
            // Restore images from server content if local row doesn't have
            // them; clearing summary-only makes the restored row editable.
            ...(serverImages && !next[existingIndex]!.images
              ? { images: serverImages }
              : {}),
            ...(serverImages && contentFullyHydrated && !serverFiles
              ? { payloadCompleteness: undefined }
              : {}),
            ...(serverFiles && !next[existingIndex]!.files
              ? { files: serverFiles, payloadCompleteness: 'summary-only' }
              : {}),
            midTurnState: undefined,
            midTurnMessageId: undefined,
            midTurnFailedAction: undefined,
            serverPromptId: serverPrompt.promptId,
            serverState: serverPrompt.state,
          };
          continue;
        }
        const couldBeOurs =
          serverPrompt.originatorClientId === undefined ||
          serverPrompt.originatorClientId === clientId;
        const submittingMatches = next.filter((p) =>
          matchesUnboundSubmittingRow(p, serverPrompt, clientId),
        );
        if (submittingMatches.length === 1) {
          const submittingRow = submittingMatches[0]!;
          // An attachment row claims through a placeholder rendering, so the
          // match must be unique on the server side too: with two prompts it
          // could own, it claims neither and waits for its body to bind by
          // id.
          const rowHasAttachments =
            (submittingRow.images?.length ?? 0) > 0 ||
            (submittingRow.files?.length ?? 0) > 0;
          const serverSideUnique =
            !rowHasAttachments ||
            serverQueued.filter((candidate) =>
              matchesUnboundSubmittingRow(submittingRow, candidate, clientId),
            ).length === 1;
          if (serverSideUnique) {
            const submittingIndex = next.indexOf(submittingRow);
            // A payload-bearing row matched to a prompt already displayed is
            // left unbound: claiming or content-binding it would
            // misattribute a deliberate re-send of identical bytes — and the
            // payload (attachments, or the reference chips the rendered text
            // drops) would be unrecoverable. Its own body binds it to the id
            // the daemon returned for it.
            if (
              hasDisplayedPrompt &&
              (rowHasAttachments ||
                (submittingRow.inputAnnotations?.length ?? 0) > 0)
            )
              continue;
            if (hasDisplayedPrompt) {
              // Remember the claim: a submit body that later finds this row
              // gone must not read the splice as a user cancellation. Both
              // the resubmission branch and the ordinary tail read it.
              syncClaimedSubmittingRowIdsRef.current.add(submittingRow.id);
              while (syncClaimedSubmittingRowIdsRef.current.size > 200) {
                const oldestClaim = syncClaimedSubmittingRowIdsRef.current
                  .values()
                  .next().value;
                if (typeof oldestClaim !== 'number') break;
                syncClaimedSubmittingRowIdsRef.current.delete(oldestClaim);
              }
              next.splice(submittingIndex, 1);
              continue;
            }
            next[submittingIndex] = {
              ...submittingRow,
              serverPromptId: serverPrompt.promptId,
              serverState: serverPrompt.state,
            };
            continue;
          }
        }
        if (serverPrompt.state === 'running' || hasDisplayedPrompt) {
          continue;
        }
        const hasUnboundAttachmentSubmission = next.some(
          (prompt) =>
            !prompt.serverPromptId &&
            prompt.serverState === 'submitting' &&
            ((prompt.images?.length ?? 0) > 0 ||
              (prompt.files?.length ?? 0) > 0),
        );
        // The suppression guards against duplicating an in-flight attachment
        // submission of THIS client; a prompt the originator already proved
        // foreign cannot be its duplicate and must materialize.
        if (couldBeOurs && hasUnboundAttachmentSubmission) continue;
        next.push({
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: serverPrompt.text,
          ...(serverImages ? { images: serverImages } : {}),
          ...(serverFiles ? { files: serverFiles } : {}),
          serverPromptId: serverPrompt.promptId,
          serverState: serverPrompt.state,
          // A row rebuilt with fully hydrated images is payload-complete;
          // pinning it to summary-only would disable editing until the user
          // deletes (and loses) the attachments. A partially hydrated
          // payload stays summary-only so editing cannot silently discard
          // the attachments the daemon still holds — a later fully hydrated
          // refresh upgrades the row.
          payloadCompleteness:
            serverImages && contentFullyHydrated && !serverFiles
              ? undefined
              : 'summary-only',
        });
      }
      if (areQueuedPromptsEqual(queuedPromptsRef.current, next)) return;
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    },
    [],
  );

  const appendLocalQueuedPrompt = useCallback(
    (prompt: QueuedPrompt, promptId: string) => {
      if (
        displayedServerPromptIdsRef.current.has(promptId) ||
        prompt.payloadCompleteness === 'summary-only' ||
        (!prompt.text &&
          (prompt.images?.length ?? 0) === 0 &&
          (prompt.files?.length ?? 0) === 0)
      ) {
        return;
      }
      displayedServerPromptIdsRef.current.add(promptId);
      pendingEchoByPromptIdRef.current.delete(promptId);
      store.appendLocalUserMessage(
        prompt.text,
        toStoreImages(prompt.images),
        {
          promptId,
          ...(prompt.inputAnnotations?.length
            ? { inputAnnotations: prompt.inputAnnotations }
            : {}),
        },
        toStoreFiles(prompt.files),
      );
    },
    [store],
  );

  // The removal failed, so a started event parked on the removing-set guard
  // was real after all: echo what it carried. The stash holds the payload
  // for attachments the event cannot reproduce; a text-only message is
  // reproduced faithfully by the event's own text.
  const replayStartedDuringRemoval = useCallback(
    (promptId: string) => {
      const startedText = startedDuringRemovalRef.current.get(promptId);
      if (startedText === undefined) return;
      startedDuringRemovalRef.current.delete(promptId);
      if (displayedServerPromptIdsRef.current.has(promptId)) return;
      const stashed = pendingEchoByPromptIdRef.current.get(promptId);
      if (stashed) {
        appendLocalQueuedPrompt(stashed, promptId);
      } else if (startedText) {
        displayedServerPromptIdsRef.current.add(promptId);
        store.appendLocalUserMessage(startedText, undefined, { promptId });
      }
    },
    [appendLocalQueuedPrompt, store],
  );

  const hideSettledServerPrompt = useCallback(
    (promptId: string) => {
      // A start whose raw-text echo was suppressed (an unrelated unbound
      // submission was in flight) outlives its submit body's own consume;
      // settling is the last chance to show the message at all. Only an
      // unechoed park is consumed: an echoed one stays as the "already
      // started" marker late admissions dedupe against, a second terminal
      // event for the same prompt must not re-append it, and a matching
      // unbound submission means this prompt's own admission is still in
      // flight — its body will echo the full payload when it lands, unless
      // that body already returned without binding.
      const parked = pendingStartedByPromptIdRef.current.get(promptId);
      const parkedText = parked?.text;
      // A row already bound to this id proves the park is not the in-flight
      // own-admission case below, even when a foreign unbound submission
      // happens to render the same text. A matching row younger than the park
      // is a different message, not this prompt's own admission in flight.
      const boundRowExists = queuedPromptsRef.current.some(
        (item) => item.serverPromptId === promptId,
      );
      const pendingOwnSubmission =
        parked !== undefined &&
        !returnedUnboundPromptIdsRef.current.has(promptId) &&
        queuedPromptsRef.current.some(
          (item) =>
            !item.serverPromptId &&
            item.serverState === 'submitting' &&
            item.id < parked.rowIdFrontier &&
            pendingPromptTextsMatch(item.text, parked.text),
        );
      // The parked text is the daemon's rendering: for a payload the event
      // cannot reproduce, echo the stashed or row-held full payload instead
      // of the placeholder.
      const full =
        parkedText !== undefined
          ? (pendingEchoByPromptIdRef.current.get(promptId) ??
            queuedPromptsRef.current.find(
              (item) =>
                item.serverPromptId === promptId &&
                item.payloadCompleteness !== 'summary-only',
            ))
          : undefined;
      if (
        parkedText !== undefined &&
        // A rendering with no payload source carries no message to show:
        // leave the park (inert once settled) rather than echo a blank
        // bubble, or the daemon's placeholder for an attachment this client
        // no longer holds. Both sibling consumers of a parked text refuse
        // those two as well.
        (full !== undefined ||
          (parkedText !== '' && parkedText !== IMAGE_ONLY_PROMPT_TEXT)) &&
        !settledServerPromptIdsRef.current.has(promptId) &&
        !displayedServerPromptIdsRef.current.has(promptId) &&
        (boundRowExists || !pendingOwnSubmission)
      ) {
        pendingStartedByPromptIdRef.current.delete(promptId);
        // The settle clears the displayed marker below; this marker is what
        // the prompt's own submit body re-reads to know the echo happened,
        // so a still-pending body must not echo it again. A body that
        // already returned unbound has no remaining read of it — skip the
        // write rather than leave an entry nothing will ever prune.
        if (!returnedUnboundPromptIdsRef.current.has(promptId)) {
          appendedBeforeResponsePromptIdsRef.current.add(promptId);
        }
        if (full) {
          appendLocalQueuedPrompt(full, promptId);
        } else {
          store.appendLocalUserMessage(parkedText, undefined, { promptId });
        }
      }
      displayedServerPromptIdsRef.current.delete(promptId);
      // A settled prompt will never start, so no echo is owed for it and its
      // stashed attachments must not stay reachable — unless a start is
      // parked behind an in-flight removal, whose failure arm replays from
      // that stash.
      if (!startedDuringRemovalRef.current.has(promptId)) {
        pendingEchoByPromptIdRef.current.delete(promptId);
      }
      const returnedRowId = returnedUnboundPromptIdsRef.current.get(promptId);
      returnedUnboundPromptIdsRef.current.delete(promptId);
      // A settled prompt can never bind its row anymore: for a body that
      // returned unbound the row has no remaining recovery route, so drop a
      // still-unbound copy rather than leave a phantom submitting row
      // suppressing materialization.
      if (returnedRowId !== undefined) {
        const returnedRow = queuedPromptsRef.current.find(
          (item) => item.id === returnedRowId,
        );
        if (returnedRow && returnedRow.serverPromptId === undefined) {
          const next = queuedPromptsRef.current.filter(
            (item) => item.id !== returnedRowId,
          );
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
        }
      }
      settledServerPromptIdsRef.current.add(promptId);
      while (
        settledServerPromptIdsRef.current.size > MAX_COMPLETED_PROMPT_IDS
      ) {
        const oldestPromptId = settledServerPromptIdsRef.current
          .values()
          .next().value;
        if (typeof oldestPromptId !== 'string') break;
        settledServerPromptIdsRef.current.delete(oldestPromptId);
      }
      removeDaemonOwnedPrompt(promptId);
    },
    [appendLocalQueuedPrompt, removeDaemonOwnedPrompt, store],
  );

  const refreshPendingPrompts = useCallback(
    (
      targetSessionId = sessionId,
      // Fence anchor: a refresh that follows a local state change must not
      // sync from a flight dispatched before that change — it waits the
      // stale flight out and re-dispatches, joining only a flight dispatched
      // after this anchor.
      notBefore = refreshRequestSeqRef.current,
    ): Promise<RefreshPendingPromptsResult> => {
      if (!latestConnectedRef.current || !targetSessionId)
        return Promise.resolve({ status: 'skipped' });
      if (latestSessionIdRef.current !== targetSessionId)
        return Promise.resolve({ status: 'skipped' });
      const dispatchRefresh = (): Promise<RefreshPendingPromptsResult> => {
        const ownerToken = ownerTokenRef.current;
        const requestSeq = ++refreshRequestSeqRef.current;
        // The finally clears the ref by dispatch sequence, not by promise
        // identity: a synchronous throw inside the try would reach the
        // finally before `promise` below is assigned.
        const runRefresh = async (): Promise<RefreshPendingPromptsResult> => {
          try {
            const result = await sessionActions.getPendingPrompts({
              sessionId: targetSessionId,
            });
            if (requestSeq !== refreshRequestSeqRef.current)
              return { status: 'superseded' };
            if (
              !isCurrentOwnerTokenRef.current(ownerToken) ||
              latestSessionIdRef.current !== targetSessionId
            ) {
              return { status: 'skipped' };
            }
            // Apply a clear the user made while the daemon's state was
            // unknown: this snapshot is the positive evidence that removal
            // was waiting for. Anything it does not list as still queued has
            // either started or gone, and removing that would abort a live
            // turn, so the entry is dropped.
            const overruledClearedIds = new Set<string>();
            for (const clearedPromptId of [
              ...clearedUnconfirmedPromptIdsRef.current,
            ]) {
              clearedUnconfirmedPromptIdsRef.current.delete(clearedPromptId);
              if (
                !result.pendingPrompts.some(
                  (p) => p.promptId === clearedPromptId && p.state === 'queued',
                )
              ) {
                continue;
              }
              // Client-side evidence wins over a snapshot the daemon answered
              // before the start it shows: removing a prompt that already
              // started would abort a live turn. The same stale snapshot
              // must not re-materialize the cancelled message either, so the
              // id is kept out of this pass's sync.
              if (
                displayedServerPromptIdsRef.current.has(clearedPromptId) ||
                pendingStartedByPromptIdRef.current.has(clearedPromptId) ||
                startedDuringRemovalRef.current.has(clearedPromptId) ||
                completedPromptIdsRef.current.has(clearedPromptId) ||
                settledServerPromptIdsRef.current.has(clearedPromptId) ||
                // A removal this client already owns decides the prompt's
                // fate: a second DELETE would answer not-removed and its
                // `.finally` would clear the flag the owning flight still
                // needs to park a start behind.
                removingServerPromptIdsRef.current.has(clearedPromptId)
              ) {
                overruledClearedIds.add(clearedPromptId);
                continue;
              }
              removingServerPromptIdsRef.current.add(clearedPromptId);
              // The daemon publishes pending_prompt_completed
              // {state:'removed'} inside bridgeApi.removePendingPrompt,
              // before the DELETE resolves, and an event-first ordering
              // fires any callback still registered — for a prompt the user
              // cancelled. Capture and unregister it now; a failed removal
              // re-settles it, because the prompt may already be running.
              const clearedCallback =
                completionCallbacksRef.current.get(clearedPromptId);
              completionCallbacksRef.current.delete(clearedPromptId);
              sessionActions
                .removePendingPrompt(clearedPromptId, {
                  sessionId: targetSessionId,
                })
                .then(
                  (removeResult) => removeResult.removed,
                  () => false,
                )
                // Clearing the flag before the re-sync matters: a sync that
                // runs while the id is still marked as being removed skips
                // the very prompt the failed removal left behind.
                .finally(() => {
                  removingServerPromptIdsRef.current.delete(clearedPromptId);
                })
                .then((removed) => {
                  if (removed) {
                    // The daemon confirmed the removal: the prompt never
                    // ran, so a start parked inside the flight and the
                    // stashed payload are both dead weight.
                    startedDuringRemovalRef.current.delete(clearedPromptId);
                    pendingEchoByPromptIdRef.current.delete(clearedPromptId);
                  } else {
                    if (clearedCallback) {
                      settleCompletionCallback(
                        clearedPromptId,
                        clearedCallback,
                      );
                    }
                    replayStartedDuringRemoval(clearedPromptId);
                    void refreshPendingPrompts(targetSessionId);
                  }
                });
            }
            syncServerQueuedPrompts(
              result.pendingPrompts.filter(
                (p) =>
                  (p.state === 'queued' || p.state === 'running') &&
                  !overruledClearedIds.has(p.promptId),
              ),
              targetSessionId,
              clientId,
            );
            return {
              status: 'refreshed',
              pendingPrompts: result.pendingPrompts,
            };
          } catch (error) {
            console.warn('Failed to refresh pending prompts', error);
            return { status: 'failed' };
          } finally {
            if (inflightRefreshRef.current?.seq === requestSeq) {
              inflightRefreshRef.current = null;
            }
          }
        };
        const promise = runRefresh();
        inflightRefreshRef.current = {
          sessionId: targetSessionId,
          ownerToken,
          seq: requestSeq,
          promise,
        };
        return promise;
      };
      const inflight = inflightRefreshRef.current;
      if (
        inflight &&
        inflight.sessionId === targetSessionId &&
        isCurrentOwnerTokenRef.current(inflight.ownerToken)
      ) {
        // The in-flight snapshot was dispatched before the state change the
        // caller is confirming, so it can prove nothing about it. Wait the
        // stale flight out rather than storm the daemon, then take exactly
        // one fresh snapshot — or join one dispatched meanwhile.
        return inflight.promise.then(() => {
          // The wait can outlive the session or the connection: re-apply
          // the entry guards before dispatching against them.
          if (
            !latestConnectedRef.current ||
            latestSessionIdRef.current !== targetSessionId
          ) {
            return { status: 'skipped' } as const;
          }
          const latest = inflightRefreshRef.current;
          if (
            latest &&
            latest.sessionId === targetSessionId &&
            isCurrentOwnerTokenRef.current(latest.ownerToken) &&
            latest.seq > notBefore
          ) {
            return latest.promise;
          }
          return dispatchRefresh();
        });
      }
      return dispatchRefresh();
    },
    [
      clientId,
      replayStartedDuringRemoval,
      sessionActions,
      sessionId,
      settleCompletionCallback,
      syncServerQueuedPrompts,
    ],
  );

  const applyMidTurnSnapshot = useCallback(
    (
      snapshot: DaemonMidTurnMessagesResult,
      targetSessionId: string,
      applyPromoted: boolean,
    ): Set<string> => {
      const settledIds = new Set(snapshot.settledMessageIds);
      const promotedIds = new Set(snapshot.promotedMessageIds);
      // The daemon snapshot is text-only; salvage the images still held by the
      // pending admissions before deleting them, so the restored rows stay
      // payload-complete (an edited or displayed row must not lose them).
      const salvagedImages = new Map<string, PromptImage[]>();
      for (const message of snapshot.messages) {
        const pending = pendingMidTurnAdmissionsRef.current.get(
          message.messageId,
        );
        const images = pending?.prompt.images;
        if (images && images.length > 0) {
          salvagedImages.set(message.messageId, images);
        }
        pendingMidTurnAdmissionsRef.current.delete(message.messageId);
      }
      for (const messageId of settledIds) {
        pendingMidTurnAdmissionsRef.current.delete(messageId);
        const callback = completionCallbacksRef.current.get(messageId);
        completionCallbacksRef.current.delete(messageId);
        callback?.();
      }
      // A promoted message surfaces as a pending-prompt (server) row built from
      // the text-only `getPendingPrompts` summary, so salvage its images here
      // too — otherwise the promoted row displays nothing and editing it can't
      // restore the attachments.
      const promotedImages = new Map<string, PromptImage[]>();
      for (const messageId of promotedIds) {
        const pending = pendingMidTurnAdmissionsRef.current.get(messageId);
        const images = pending?.prompt.images;
        if (images && images.length > 0) {
          promotedImages.set(messageId, images);
        }
        // A failed pending-prompt refresh leaves no row for a later start
        // event to recover media from, so retain the hidden payload until the
        // server row is available.
        if (applyPromoted) {
          pendingMidTurnAdmissionsRef.current.delete(messageId);
        }
      }
      const waitingIds = new Set(
        snapshot.messages.map((message) => message.messageId),
      );
      const current = queuedPromptsRef.current;
      let next = current.filter(
        (prompt) =>
          !(
            prompt.midTurnState !== undefined &&
            prompt.midTurnMessageId !== undefined &&
            !prompt.isEditing &&
            !prompt.isRemoving &&
            (displayedServerPromptIdsRef.current.has(prompt.midTurnMessageId) ||
              settledServerPromptIdsRef.current.has(prompt.midTurnMessageId) ||
              settledIds.has(prompt.midTurnMessageId) ||
              (applyPromoted && promotedIds.has(prompt.midTurnMessageId)))
          ),
      );
      next = next.map((prompt) =>
        prompt.midTurnState === 'submitting' &&
        prompt.midTurnMessageId !== undefined &&
        waitingIds.has(prompt.midTurnMessageId)
          ? {
              ...prompt,
              midTurnState: 'queued',
            }
          : prompt,
      );
      // A degraded (summary-only) row is provisional: the daemon still holds
      // the media, so a later snapshot that hydrates it restores the payload.
      next = next.map((prompt) => {
        if (
          prompt.payloadCompleteness !== 'summary-only' ||
          prompt.midTurnMessageId === undefined
        ) {
          return prompt;
        }
        const message = snapshot.messages.find(
          (item) => item.messageId === prompt.midTurnMessageId,
        );
        if (
          !message ||
          contentHasDegradedMedia(message.content) ||
          contentHasUnhydratedMedia(message.content)
        ) {
          return prompt;
        }
        const hydrated = contentToImages(message.content);
        if (!hydrated || contentToFiles(message.content)) return prompt;
        return { ...prompt, images: hydrated, payloadCompleteness: undefined };
      });
      if (next.length !== current.length) {
        const retainedIds = new Set(next.map((prompt) => prompt.id));
        for (const prompt of current) {
          if (retainedIds.has(prompt.id) || !prompt.onComplete) continue;
          if (
            applyPromoted &&
            prompt.midTurnMessageId &&
            promotedIds.has(prompt.midTurnMessageId)
          ) {
            settleCompletionCallback(
              prompt.midTurnMessageId,
              prompt.onComplete,
            );
          } else {
            prompt.onComplete();
          }
        }
      }
      const localIds = new Set(
        next
          .map((prompt) => prompt.midTurnMessageId ?? prompt.serverPromptId)
          .filter((id): id is string => id !== undefined),
      );
      const restoredRows: QueuedPrompt[] = [];
      for (const message of snapshot.messages) {
        if (
          localIds.has(message.messageId) ||
          displayedServerPromptIdsRef.current.has(message.messageId) ||
          settledServerPromptIdsRef.current.has(message.messageId)
        ) {
          continue;
        }
        // Prefer the in-memory admission's images; after a refresh only the
        // snapshot's media blocks remain.
        const salvaged = salvagedImages.get(message.messageId);
        const images = salvaged ?? contentToImages(message.content);
        const files = contentToFiles(message.content);
        restoredRows.push({
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: message.text,
          ...(images ? { images } : {}),
          ...(files ? { files } : {}),
          // A hydration-failure placeholder in the snapshot means the row's
          // attachments are gone from the client; an unhydrated reference
          // means they are transiently unreachable. Degrade both like a
          // summary-only row so editing cannot silently discard them — a
          // later hydrated snapshot upgrades the provisional case back.
          ...(salvaged === undefined &&
          (contentHasDegradedMedia(message.content) ||
            contentHasUnhydratedMedia(message.content))
            ? { payloadCompleteness: 'summary-only' as const }
            : {}),
          midTurnState: 'queued',
          midTurnMessageId: message.messageId,
        });
      }
      if (restoredRows.length > 0) next = [...next, ...restoredRows];
      if (promotedImages.size > 0) {
        next = next.map((prompt) => {
          if ((prompt.images?.length ?? 0) > 0) return prompt;
          const key = prompt.serverPromptId ?? prompt.midTurnMessageId;
          const images = key ? promotedImages.get(key) : undefined;
          return images ? { ...prompt, images } : prompt;
        });
      }
      if (!areQueuedPromptsEqual(current, next)) {
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
      }
      if (!applyPromoted) {
        for (const messageId of promotedIds) waitingIds.add(messageId);
      }
      return waitingIds;
    },
    [settleCompletionCallback],
  );

  const pruneMissingMidTurnRows = useCallback(
    (waitingIds: ReadonlySet<string>, targetSessionId: string) => {
      const current = queuedPromptsRef.current;
      const next = current.filter(
        (prompt) =>
          prompt.sessionId !== targetSessionId ||
          prompt.midTurnState !== 'queued' ||
          prompt.midTurnMessageId === undefined ||
          prompt.isEditing ||
          prompt.isRemoving ||
          waitingIds.has(prompt.midTurnMessageId),
      );
      if (next.length === current.length) return;
      const retainedIds = new Set(next.map((prompt) => prompt.id));
      for (const prompt of current) {
        if (!retainedIds.has(prompt.id)) prompt.onComplete?.();
      }
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    },
    [],
  );

  const reconcileMidTurnMessages = useCallback(
    async (
      targetSessionId: string,
      opts?: { signal?: AbortSignal; seq?: number },
    ): Promise<DaemonMidTurnMessagesResult | undefined> => {
      const expectedSeq = opts?.seq ?? ++midTurnReconcileSeqRef.current;
      const expectedOwnerToken = ownerTokenRef.current;
      const isCurrent = () =>
        !opts?.signal?.aborted &&
        !writeBlockedRef.current &&
        isCurrentOwnerTokenRef.current(expectedOwnerToken) &&
        latestSessionIdRef.current === targetSessionId &&
        expectedSeq === midTurnReconcileSeqRef.current;
      if (!isCurrent()) return undefined;
      let snapshot: DaemonMidTurnMessagesResult | undefined;
      try {
        snapshot = await sessionActions.getMidTurnMessages({
          signal: opts?.signal,
        });
      } catch (error) {
        console.warn('Failed to refresh mid-turn messages', error);
      }
      if (!snapshot || !isCurrent()) {
        if (isCurrent()) await refreshPendingPrompts(targetSessionId);
        return undefined;
      }
      // The pending snapshot must post-date the mid-turn snapshot above: the
      // fence default refuses to join a GET dispatched before this call,
      // which would read a queue that cannot list the promoted message and
      // drop its row.
      const pendingResult = await refreshPendingPrompts(targetSessionId);
      if (!isCurrent()) return undefined;
      const waitingIds = applyMidTurnSnapshot(
        snapshot,
        targetSessionId,
        pendingResult.status === 'refreshed',
      );
      pruneMissingMidTurnRows(waitingIds, targetSessionId);
      return snapshot;
    },
    [
      applyMidTurnSnapshot,
      pruneMissingMidTurnRows,
      refreshPendingPrompts,
      sessionActions,
    ],
  );

  const restoreQueuedPrompts = useCallback((prompts: QueuedPrompt[]) => {
    const currentSessionId = latestSessionIdRef.current;
    const sameSessionPrompts = prompts.filter(
      (prompt) =>
        prompt.sessionId === undefined || prompt.sessionId === currentSessionId,
    );
    if (sameSessionPrompts.length === 0) return;
    const existingIds = new Set(queuedPromptsRef.current.map((p) => p.id));
    const restored = sameSessionPrompts.filter(
      (prompt) => !existingIds.has(prompt.id),
    );
    if (restored.length === 0) return;
    const next = [...queuedPromptsRef.current, ...restored].sort(
      (a, b) => a.id - b.id,
    );
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);

  const restoreQueuedPromptsToEditor = useCallback(
    (
      prompts: readonly QueuedPrompt[],
      targetSessionId?: string,
      expectedOwnerToken = ownerTokenRef.current,
    ): boolean => {
      if (
        !isCurrentOwnerTokenRef.current(expectedOwnerToken) ||
        (targetSessionId !== undefined &&
          latestSessionIdRef.current !== targetSessionId)
      ) {
        return false;
      }
      const editor = editorRef.current;
      if (!editor) return false;
      const restorable = prompts.filter(
        (prompt) =>
          prompt.payloadCompleteness !== 'summary-only' &&
          !restoredPromptIdsRef.current.has(prompt.id),
      );
      if (restorable.length === 0) return false;
      const currentText = editor.getText();
      const restoredText = restorable
        .map((prompt) => prompt.text)
        .filter(Boolean)
        .join('\n');
      let textWasRestored = false;
      if (restoredText) {
        const nextText = mergeRestoredPromptText(currentText, restoredText);
        if (nextText !== currentText) {
          editor.setText(nextText);
          textWasRestored = true;
        }
      }
      const attachmentPrompts = restorable.filter(
        (prompt) => !prompt.text || textWasRestored,
      );
      const images = attachmentPrompts.flatMap((prompt) => prompt.images ?? []);
      if (images.length > 0) editor.restoreImages(images);
      const files = attachmentPrompts.flatMap((prompt) => prompt.files ?? []);
      if (files.length > 0) editor.restoreFiles(files);
      let annotationOffset = 0;
      const inputAnnotations: DaemonInputAnnotation[] = [];
      for (const prompt of attachmentPrompts) {
        if (!prompt.text) continue;
        for (const annotation of prompt.inputAnnotations ?? []) {
          inputAnnotations.push({
            ...annotation,
            start: annotation.start + annotationOffset,
            end: annotation.end + annotationOffset,
          });
        }
        annotationOffset += prompt.text.length + 1;
      }
      if (inputAnnotations.length > 0) {
        editor.restoreInputAnnotations?.(inputAnnotations);
      }
      for (const prompt of restorable) {
        restoredPromptIdsRef.current.add(prompt.id);
      }
      editor.focus();
      return true;
    },
    [editorRef],
  );
  const restoreQueuedPromptsToEditorRef = useRef(restoreQueuedPromptsToEditor);
  restoreQueuedPromptsToEditorRef.current = restoreQueuedPromptsToEditor;

  useEffect(() => {
    restoredPromptIdsRef.current = new Set();
    const previousOwner = queuedPromptsOwnerRef.current;
    const previousOwnerKey = queueOwnerKey(
      previousOwner.workspaceCwd,
      previousOwner.sessionId,
    );
    if (previousOwnerKey) {
      const heldPrompts = queuedPromptsRef.current
        .filter(
          (prompt) =>
            (isLocallyHeldPrompt(prompt) ||
              // Rows the drain stamped `submitting` up front but never got to
              // POST. Nothing exists for them on the daemon, so unlike a real
              // in-flight admission (deliberately fenced and dropped here)
              // they can be stashed with no risk of a duplicate — and they
              // must be, or a mid-drain session switch loses the text.
              unreleasedPromptIdsRef.current.has(prompt.id)) &&
            (!prompt.midTurnMessageId ||
              !pendingMidTurnAdmissionsRef.current.has(
                prompt.midTurnMessageId,
              )),
        )
        // Drop the optimistic stamp on the way in: the row has to come back as
        // a plain held prompt, because `isLocallyHeldPrompt` is what both the
        // next drain and the next owner change look for.
        .map((prompt) =>
          prompt.serverState === undefined
            ? prompt
            : { ...prompt, serverState: undefined },
        );
      if (heldPrompts.length > 0) {
        heldPromptsByOwnerRef.current.set(previousOwnerKey, heldPrompts);
      } else {
        heldPromptsByOwnerRef.current.delete(previousOwnerKey);
      }
    }
    const retainedAdmissions = [
      ...pendingMidTurnAdmissionsRef.current.entries(),
    ].filter(
      ([, entry]) =>
        entry.prompt.sessionId === sessionId &&
        entry.workspaceCwd === workspaceCwd,
    );
    const retainedAdmissionIds = new Set(
      retainedAdmissions.map(([messageId]) => messageId),
    );
    const retainedCompletionCallbacks = new Map(
      [...completionCallbacksRef.current.entries()].filter(([promptId]) =>
        retainedAdmissionIds.has(promptId),
      ),
    );
    const interruptedPrompts = queuedPromptsRef.current.filter(
      (prompt) =>
        (prompt.midTurnState === 'submitting' &&
          prompt.midTurnMessageId === undefined) ||
        prompt.midTurnFailedAction === 'edit',
    );
    if (interruptedPrompts.length > 0) {
      restoreQueuedPromptsToEditorRef.current(interruptedPrompts);
    }
    queuedPromptsOwnerRef.current = ownerToken;
    const nextOwnerKey = queueOwnerKey(workspaceCwd, sessionId);
    let heldPrompts = nextOwnerKey
      ? (heldPromptsByOwnerRef.current.get(nextOwnerKey) ?? [])
      : [];
    if (nextOwnerKey && sessionId) {
      // The workspace half of the key can resolve at any time — including
      // while the user is on a different session — so a stash written under an
      // unresolved (or since-changed) cwd would be orphaned under a key nobody
      // looks up again, silently losing the text. Session ids are unique, so
      // any stash whose session half matches belongs to this owner: relocate
      // them all and restore in queue order.
      const suffix = `\u0000${sessionId}`;
      const relocated: QueuedPrompt[] = [];
      for (const [key, prompts] of [...heldPromptsByOwnerRef.current]) {
        if (key === nextOwnerKey || !key.endsWith(suffix)) continue;
        heldPromptsByOwnerRef.current.delete(key);
        relocated.push(...prompts);
      }
      if (relocated.length > 0) {
        const seen = new Set(heldPrompts.map((prompt) => prompt.id));
        heldPrompts = [
          ...heldPrompts,
          ...relocated.filter((prompt) => !seen.has(prompt.id)),
        ].sort((a, b) => a.id - b.id);
        heldPromptsByOwnerRef.current.set(nextOwnerKey, heldPrompts);
      }
    }
    // Daemon-owned rows are re-rendered from the next queue snapshot; only the
    // locally held Goal queue survives an owner change.
    queuedPromptsRef.current = heldPrompts;
    setQueuedPrompts(heldPrompts);
    completionCallbacksRef.current = retainedCompletionCallbacks;
    completedPromptIdsRef.current = new Set();
    completedPromptIdOrderRef.current = [];
    appendedBeforeResponsePromptIdsRef.current = new Set();
    removedBeforeResponsePromptIdsRef.current = new Set();
    for (const controller of submitAbortControllersRef.current) {
      controller.abort();
    }
    submitAbortControllersRef.current.clear();
    unreleasedPromptIdsRef.current = new Set();
    releaseChainRef.current = null;
    removingServerPromptIdsRef.current = new Set();
    displayedServerPromptIdsRef.current = new Set();
    settledServerPromptIdsRef.current = new Set();
    pendingStartedByPromptIdRef.current = new Map();
    syncClaimedSubmittingRowIdsRef.current = new Set();
    pendingEchoByPromptIdRef.current = new Map();
    clearedUnconfirmedPromptIdsRef.current = new Set();
    startedDuringRemovalRef.current = new Map();
    returnedUnboundPromptIdsRef.current = new Map();
    initialRefreshSessionIdRef.current = undefined;
    midTurnEnqueueAbortRef.current?.abort();
    midTurnEnqueueAbortRef.current = null;
  }, [ownerToken, sessionId, workspaceCwd]);

  const pendingPromptVersion = useSyncExternalStore(
    subscribePendingPromptVersion,
    getPendingPromptVersion,
  );
  const prevPendingVersionRef = useRef(pendingPromptVersion);
  const initialRefreshSessionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!connected) {
      initialRefreshSessionIdRef.current = undefined;
      return;
    }
    if (!sessionId) return;

    const versionChanged =
      prevPendingVersionRef.current !== pendingPromptVersion;
    prevPendingVersionRef.current = pendingPromptVersion;
    if (!versionChanged) {
      if (!canQueryMidTurn && queuedPromptsRef.current.length > 0) return;
      if (!sessionActive && !canQueryMidTurn) return;
      if (initialRefreshSessionIdRef.current === sessionId) return;
      initialRefreshSessionIdRef.current = sessionId;
    }

    if (canQueryMidTurn) {
      void reconcileMidTurnMessages(sessionId);
    } else {
      void refreshPendingPrompts();
    }
  }, [
    pendingPromptVersion,
    connected,
    sessionId,
    sessionActive,
    canQueryMidTurn,
    ownerToken,
    refreshPendingPrompts,
    reconcileMidTurnMessages,
  ]);

  const pendingPromptEvents = useSyncExternalStore(
    subscribePendingPromptEvents,
    getPendingPromptEvents,
    getPendingPromptEvents,
  );
  useEffect(() => {
    if (!sessionId || pendingPromptEvents.length === 0) return;
    const handled: Array<(typeof pendingPromptEvents)[number]> = [];
    for (const event of pendingPromptEvents) {
      if (event.data.sessionId !== sessionId) continue;
      handled.push(event);
      const promptId = event.data.promptId;
      if (!promptId) continue;
      const pendingMidTurnPrompt =
        pendingMidTurnAdmissionsRef.current.get(promptId)?.prompt;
      pendingMidTurnAdmissionsRef.current.delete(promptId);
      if (event.type === 'pending_prompt_started') {
        if (removingServerPromptIdsRef.current.has(promptId)) {
          // Park rather than drop: the removal may still come back
          // not-removed (the id can be absent, or already removed by another
          // client while the doomed prompt runs on to settle). The
          // submit-body, discard and deferred-clear failure arms replay from
          // here; the two explicit user-action removal arms do not yet.
          startedDuringRemovalRef.current.set(
            promptId,
            typeof event.data.text === 'string' ? event.data.text : '',
          );
          while (startedDuringRemovalRef.current.size > 200) {
            const oldest = startedDuringRemovalRef.current.keys().next().value;
            if (typeof oldest !== 'string') break;
            startedDuringRemovalRef.current.delete(oldest);
          }
          continue;
        }
        const shouldAppendLocalUserMessage =
          event.originatorClientId === undefined ||
          event.originatorClientId === clientId;
        if (
          shouldAppendLocalUserMessage &&
          !displayedServerPromptIdsRef.current.has(promptId)
        ) {
          const eventText =
            typeof event.data.text === 'string' ? event.data.text : '';
          // A rendered text is not an identity, so ambiguity degrades to no
          // echo: each submit body echoes its own row once its admission
          // resolves, and a body that already returned without binding
          // leaves the echo to this park's settle-time consume.
          const unboundMatches = queuedPromptsRef.current.filter((item) =>
            matchesUnboundSubmittingRow(
              item,
              {
                text: eventText,
                originatorClientId: event.originatorClientId,
              },
              clientId,
            ),
          );
          const prompt =
            queuedPromptsRef.current.find(
              (item) =>
                item.serverPromptId === promptId &&
                item.payloadCompleteness !== 'summary-only',
            ) ??
            queuedPromptsRef.current.find(
              (item) => item.midTurnMessageId === promptId,
            ) ??
            pendingMidTurnPrompt ??
            // Keyed by the daemon's own id, so this outranks the rendered-text
            // match below: a text row that happens to render the same must not
            // steal another message's echo.
            pendingEchoByPromptIdRef.current.get(promptId) ??
            // A summary-only bound row still shadows the text matcher and the
            // raw-text branch: appendLocalQueuedPrompt refuses to echo it, and
            // silence beats a placeholder or a wrong-row echo. Only the stash
            // above outranks it, because the stash is the same prompt's full
            // payload under the same authoritative id.
            queuedPromptsRef.current.find(
              (item) => item.serverPromptId === promptId,
            ) ??
            (unboundMatches.length === 1 ? unboundMatches[0] : undefined);
          if (prompt) {
            if (prompt.onComplete) {
              settleCompletionCallback(promptId, prompt.onComplete);
            }
            appendLocalQueuedPrompt(prompt, promptId);
            if (!prompt.serverPromptId) {
              appendedBeforeResponsePromptIdsRef.current.add(promptId);
            }
          } else if (
            eventText &&
            !queuedPromptsRef.current.some(
              (item) =>
                !item.serverPromptId && item.serverState === 'submitting',
            )
          ) {
            displayedServerPromptIdsRef.current.add(promptId);
            store.appendLocalUserMessage(eventText, undefined, { promptId });
          }
          if (!prompt?.serverPromptId) {
            pendingStartedByPromptIdRef.current.set(promptId, {
              text: eventText,
              // Only a row that existed when the event was parked can be its
              // own in-flight admission: a younger row that renders the same
              // text is a different message and must not suppress the echo.
              rowIdFrontier: nextQueuedPromptIdRef.current,
            });
            while (pendingStartedByPromptIdRef.current.size > 200) {
              const oldest = pendingStartedByPromptIdRef.current
                .keys()
                .next().value;
              if (typeof oldest !== 'string') break;
              pendingStartedByPromptIdRef.current.delete(oldest);
              appendedBeforeResponsePromptIdsRef.current.delete(oldest);
            }
          }
        }
        if (!shouldAppendLocalUserMessage) {
          displayedServerPromptIdsRef.current.add(promptId);
        }
        if (displayedServerPromptIdsRef.current.has(promptId)) {
          removeDaemonOwnedPrompt(promptId);
        }
        void refreshPendingPrompts();
      } else if (event.type === 'turn_complete') {
        // The settle path consumes the suppression park, so read both
        // started markers first: a cancelled turn for a started prompt
        // still counts as completed for a callback registered later.
        const startedBeforeSettle =
          pendingStartedByPromptIdRef.current.has(promptId) ||
          startedDuringRemovalRef.current.has(promptId);
        hideSettledServerPrompt(promptId);
        const callback = completionCallbacksRef.current.get(promptId);
        completionCallbacksRef.current.delete(promptId);
        if (callback) {
          callback();
        } else if (
          event.data.stopReason !== 'cancelled' ||
          startedBeforeSettle
        ) {
          rememberCompletedPromptId(promptId);
        }
      } else if (event.type === 'turn_error') {
        hideSettledServerPrompt(promptId);
        const callback = completionCallbacksRef.current.get(promptId);
        completionCallbacksRef.current.delete(promptId);
        if (callback) callback();
        else rememberCompletedPromptId(promptId);
      } else if (
        event.type === 'pending_prompt_completed' &&
        event.data.state === 'removed'
      ) {
        hideSettledServerPrompt(promptId);
        const callback = completionCallbacksRef.current.get(promptId);
        completionCallbacksRef.current.delete(promptId);
        if (callback) callback();
        else {
          removedBeforeResponsePromptIdsRef.current.add(promptId);
          while (removedBeforeResponsePromptIdsRef.current.size > 200) {
            const oldest = removedBeforeResponsePromptIdsRef.current
              .values()
              .next().value;
            if (typeof oldest !== 'string') break;
            removedBeforeResponsePromptIdsRef.current.delete(oldest);
          }
        }
      }
    }
    consumePendingPromptEvents(handled);
  }, [
    appendLocalQueuedPrompt,
    pendingPromptEvents,
    sessionId,
    clientId,
    store,
    refreshPendingPrompts,
    settleCompletionCallback,
    rememberCompletedPromptId,
    hideSettledServerPrompt,
    removeDaemonOwnedPrompt,
  ]);

  /**
   * Submit one pending prompt. Returns the admission promise (already
   * error-handled) so callers releasing several prompts can chain them and
   * keep the daemon's queue in the order the user typed them. A chain link is
   * never an idle-rejected resubmission — those are submitted directly, and
   * only their bodies await a confirming snapshot — so a link settles at its
   * admission.
   */
  const submitPendingPrompt = useCallback(
    (prompt: QueuedPrompt): Promise<void> => {
      const { id: localId, sessionId: targetSessionId } = prompt;
      const ownerToken = ownerTokenRef.current;
      const submitAbort = new AbortController();
      submitAbortControllersRef.current.add(submitAbort);
      let admissionStarted = false;
      let refreshedInBody = false;

      return sessionActions
        .submitPrompt(prompt.text, {
          ...(prompt.submittedPrompt !== undefined
            ? { submittedPrompt: prompt.submittedPrompt }
            : {}),
          images: prompt.images,
          files: prompt.files,
          inputAnnotations: prompt.inputAnnotations,
          optimisticUserMessage: false,
          sessionId: targetSessionId,
          signal: submitAbort.signal,
          onAdmissionStarted: () => {
            admissionStarted = true;
          },
        })
        .then(async (result) => {
          submitAbortControllersRef.current.delete(submitAbort);
          if (
            !isCurrentOwnerTokenRef.current(ownerToken) ||
            latestSessionIdRef.current !== targetSessionId
          ) {
            return;
          }
          if (result.removedAfterAbort) {
            pendingStartedByPromptIdRef.current.delete(result.promptId);
            appendedBeforeResponsePromptIdsRef.current.delete(result.promptId);
            removedBeforeResponsePromptIdsRef.current.delete(result.promptId);
            completedPromptIdsRef.current.delete(result.promptId);
            completedPromptIdOrderRef.current =
              completedPromptIdOrderRef.current.filter(
                (promptId) => promptId !== result.promptId,
              );
            const next = queuedPromptsRef.current.filter(
              (item) => item.id !== localId,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            return;
          }
          const startedBeforeResponse =
            pendingStartedByPromptIdRef.current.delete(result.promptId);
          const appendedBeforeResponse =
            appendedBeforeResponsePromptIdsRef.current.delete(result.promptId);
          const removedBeforeResponse =
            removedBeforeResponsePromptIdsRef.current.delete(result.promptId);
          const settledBeforeResponse = completedPromptIdsRef.current.delete(
            result.promptId,
          );
          if (settledBeforeResponse) {
            completedPromptIdOrderRef.current =
              completedPromptIdOrderRef.current.filter(
                (promptId) => promptId !== result.promptId,
              );
          }
          if (removedBeforeResponse && !startedBeforeResponse) {
            const next = queuedPromptsRef.current.filter(
              (item) => item.id !== localId,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            return;
          }
          let localMessageAppended = appendedBeforeResponse;
          if (
            !localMessageAppended &&
            (startedBeforeResponse || settledBeforeResponse)
          ) {
            appendLocalQueuedPrompt(prompt, result.promptId);
            localMessageAppended = true;
          }
          prompt.onAdmitted?.();
          if (settledBeforeResponse) {
            const next = queuedPromptsRef.current.filter(
              (item) => item.id !== localId,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            prompt.onComplete?.();
            displayedServerPromptIdsRef.current.delete(result.promptId);
            return;
          }
          // Not gated on the client's activity mirror: it lags the daemon
          // state this confirmation exists to correct.
          if (prompt.resubmittedAfterIdleRejection && !localMessageAppended) {
            // The row can be cleared while this await is open, and a started
            // event carries only rendered text — no attachments and no
            // annotation chips — so keep the payload under the id the daemon
            // returned until something echoes it.
            if (eventCannotReproducePayload(prompt)) {
              pendingEchoByPromptIdRef.current.set(result.promptId, prompt);
              while (pendingEchoByPromptIdRef.current.size > 200) {
                const oldest = pendingEchoByPromptIdRef.current
                  .keys()
                  .next().value;
                if (typeof oldest !== 'string') break;
                pendingEchoByPromptIdRef.current.delete(oldest);
              }
            }
            // Refreshes are single-flight per session, but the snapshot must
            // post-date this body's own admission: the fence default refuses
            // to join a GET dispatched before this call, which would read a
            // queue that cannot list the prompt and confirm a wrong verdict.
            // The UI-side writes stay behind the sequence fence inside
            // `refreshPendingPrompts`.
            const refresh = await refreshPendingPrompts(targetSessionId);
            // The started handler may have echoed this message while the
            // snapshot was in flight, and a terminal event in the same window
            // clears the displayed-id dedupe, so re-read its flag instead of
            // trusting the one consumed before the await.
            if (
              appendedBeforeResponsePromptIdsRef.current.delete(result.promptId)
            ) {
              localMessageAppended = true;
            }
            // A row with attachments is still unbound while this snapshot is
            // applied, and that state suppresses materializing every other
            // queued prompt in it, so this is not the body's sync: let the
            // `.finally` refresh re-apply the snapshot once the row stops
            // being an unbound attachment submission — whether it bound,
            // echoed and dropped, or was removed.
            refreshedInBody =
              refresh.status === 'refreshed' &&
              (prompt.images?.length ?? 0) === 0 &&
              (prompt.files?.length ?? 0) === 0;
            if (
              !isCurrentOwnerTokenRef.current(ownerToken) ||
              latestSessionIdRef.current !== targetSessionId
            ) {
              return;
            }
            const localRowExists = queuedPromptsRef.current.some(
              (item) => item.id === localId,
            );
            // A start or completion that beat the snapshot wins over it:
            // stamping the id here would mark a running prompt queued, and
            // its Remove would abort the turn.
            const startedSinceSnapshot =
              displayedServerPromptIdsRef.current.has(result.promptId) ||
              pendingStartedByPromptIdRef.current.has(result.promptId) ||
              completedPromptIdsRef.current.has(result.promptId);
            if (!localRowExists) {
              if (syncClaimedSubmittingRowIdsRef.current.delete(localId)) {
                // The confirming sync attributed this row to an
                // already-displayed prompt with the same rendered text and
                // dropped it — nothing was cleared, so the admitted prompt
                // stays. The row a later snapshot materializes for it is
                // summary-only and cannot echo, so the started event's
                // source is the payload this body still holds: stash it
                // under the daemon's id.
                pendingEchoByPromptIdRef.current.set(result.promptId, prompt);
                while (pendingEchoByPromptIdRef.current.size > 200) {
                  const oldestClaimEcho = pendingEchoByPromptIdRef.current
                    .keys()
                    .next().value;
                  if (typeof oldestClaimEcho !== 'string') break;
                  pendingEchoByPromptIdRef.current.delete(oldestClaimEcho);
                }
                if (prompt.onComplete) {
                  settleCompletionCallback(result.promptId, prompt.onComplete);
                }
                return;
              }
              // removePendingPrompt aborts a prompt the daemon already runs,
              // and a snapshot that never arrived proves nothing, so only a
              // snapshot listing the prompt as still queued licenses removing
              // it; the started event echoes it in every other case.
              const snapshotState =
                refresh.status === 'refreshed'
                  ? refresh.pendingPrompts.find(
                      (p) => p.promptId === result.promptId,
                    )?.state
                  : undefined;
              if (
                snapshotState !== 'queued' ||
                settledServerPromptIdsRef.current.has(result.promptId) ||
                startedSinceSnapshot
              ) {
                // The started event's own echo is suppressed whenever an
                // unrelated unbound submission is in flight, and the park
                // that records the suppression has no other consumer on this
                // path — echo from the copy this body still holds.
                if (
                  !localMessageAppended &&
                  !displayedServerPromptIdsRef.current.has(result.promptId) &&
                  pendingStartedByPromptIdRef.current.delete(result.promptId)
                ) {
                  appendLocalQueuedPrompt(prompt, result.promptId);
                  localMessageAppended = true;
                }
                // A started event carries only rendered text, which loses
                // attachments and annotation chips, so echo from the copy this
                // body still holds when the snapshot says the daemon is
                // already running it.
                if (
                  snapshotState === 'running' &&
                  !localMessageAppended &&
                  eventCannotReproducePayload(prompt)
                ) {
                  appendLocalQueuedPrompt(prompt, result.promptId);
                }
                if (
                  snapshotState === undefined &&
                  !displayedServerPromptIdsRef.current.has(result.promptId)
                ) {
                  // The user cleared this row and nothing on hand says what
                  // the daemon is doing with it — either no snapshot arrived,
                  // or the one that did no longer lists the prompt — so hand
                  // the clear to the next snapshot instead of dropping it:
                  // otherwise the message the user cancelled reappears in the
                  // queue and still runs. A snapshot that already dropped the
                  // prompt resolves the entry on its next pass.
                  clearedUnconfirmedPromptIdsRef.current.add(result.promptId);
                }
                // The confirming sync may already have materialized a row for
                // the prompt the user cleared — drop it rather than resurrect
                // the cleared draft, unless an action is pending on that row.
                const remaining = queuedPromptsRef.current.filter(
                  (item) =>
                    item.isEditing ||
                    item.isRemoving ||
                    item.serverPromptId !== result.promptId,
                );
                if (remaining.length !== queuedPromptsRef.current.length) {
                  queuedPromptsRef.current = remaining;
                  setQueuedPrompts(remaining);
                }
                if (prompt.onComplete) {
                  settleCompletionCallback(result.promptId, prompt.onComplete);
                }
                return;
              }
              if (removingServerPromptIdsRef.current.has(result.promptId)) {
                // A delete or edit action already owns this removal; its own
                // refresh settles the rows.
                if (prompt.onComplete) {
                  settleCompletionCallback(result.promptId, prompt.onComplete);
                }
                return;
              }
              removingServerPromptIdsRef.current.add(result.promptId);
              // The echo stash survives the DELETE: if the removal fails and
              // the daemon goes on to start the prompt, the started event can
              // only render '[image]' — the stash is the payload's last copy.
              // It is deleted below once the removal is confirmed.
              // The confirming sync above may have materialized a row for the
              // prompt the user already cleared; drop it before the DELETE,
              // unless an action is already pending on that row.
              const next = queuedPromptsRef.current.filter(
                (item) =>
                  item.isEditing ||
                  item.isRemoving ||
                  item.serverPromptId !== result.promptId,
              );
              queuedPromptsRef.current = next;
              setQueuedPrompts(next);
              sessionActions
                .removePendingPrompt(result.promptId, {
                  sessionId: targetSessionId,
                })
                .then(
                  (removeResult) => removeResult.removed,
                  () => false,
                )
                // Clearing the flag before acting on the outcome matters: a
                // re-sync that runs while the id is still marked as being
                // removed skips the very prompt a failed removal left behind.
                .finally(() => {
                  removingServerPromptIdsRef.current.delete(result.promptId);
                })
                .then((removed) => {
                  if (removed) {
                    startedDuringRemovalRef.current.delete(result.promptId);
                    pendingEchoByPromptIdRef.current.delete(result.promptId);
                    const next = queuedPromptsRef.current.filter(
                      (item) => item.serverPromptId !== result.promptId,
                    );
                    queuedPromptsRef.current = next;
                    setQueuedPrompts(next);
                  } else {
                    // The removal came back not-removed — the id is absent,
                    // or another client already removed it while the doomed
                    // prompt runs on to settle — so a start may have parked
                    // for a prompt that really did run: the replay echoes
                    // it, and the callback must still be registered or no
                    // terminal event will ever fire it.
                    if (prompt.onComplete) {
                      settleCompletionCallback(
                        result.promptId,
                        prompt.onComplete,
                      );
                    }
                    replayStartedDuringRemoval(result.promptId);
                    void refreshPendingPrompts(targetSessionId);
                  }
                });
              return;
            }
            const bound = queuedPromptsRef.current.find(
              (item) => item.serverPromptId === result.promptId,
            );
            if (bound?.serverState === 'queued') {
              if (bound.id !== localId) {
                // The sync materialized its own row for this prompt, so this
                // body's duplicate has to go. That row is summary-only and
                // cannot echo, so the started event's source is the payload
                // this body still holds: stash it under the daemon's id.
                pendingEchoByPromptIdRef.current.set(result.promptId, prompt);
                while (pendingEchoByPromptIdRef.current.size > 200) {
                  const oldestDuplicateEcho = pendingEchoByPromptIdRef.current
                    .keys()
                    .next().value;
                  if (typeof oldestDuplicateEcho !== 'string') break;
                  pendingEchoByPromptIdRef.current.delete(oldestDuplicateEcho);
                }
                const next = queuedPromptsRef.current.filter(
                  (item) => item.id !== localId,
                );
                queuedPromptsRef.current = next;
                setQueuedPrompts(next);
              }
              if (prompt.onComplete) {
                settleCompletionCallback(result.promptId, prompt.onComplete);
              }
              return;
            }
            // The daemon returned this prompt id for this very row, so binding
            // to it is not a guess: the started event corrects the state label
            // when it lands, while an unbound row can be neither echoed, nor
            // cleared against the daemon, nor deleted by the user.
            const bindRowToPrompt = () => {
              const next = queuedPromptsRef.current.map((item) =>
                item.id === localId
                  ? {
                      ...item,
                      serverPromptId: result.promptId,
                      serverState: 'queued' as const,
                      boundAtSeq: refreshRequestSeqRef.current,
                    }
                  : item,
              );
              queuedPromptsRef.current = next;
              setQueuedPrompts(next);
              if (prompt.onComplete) {
                settleCompletionCallback(result.promptId, prompt.onComplete);
              }
            };
            // A start whose raw-text echo was suppressed (an identical
            // unbound submission was in flight) parked the message, and the
            // settle's own consume defers to this body while it is in
            // flight — so this body is the last echo path. Consume the park
            // here, before the settled arms below drop the row in silence.
            if (
              !localMessageAppended &&
              !displayedServerPromptIdsRef.current.has(result.promptId) &&
              pendingStartedByPromptIdRef.current.delete(result.promptId)
            ) {
              appendLocalQueuedPrompt(prompt, result.promptId);
              localMessageAppended = true;
            }
            if (refresh.status !== 'refreshed') {
              // A settle that beat the snapshot wins over it: the message
              // already ran (and the settle cleared the echo guard), so the
              // row drops without a second echo.
              const settled =
                settledServerPromptIdsRef.current.has(result.promptId) ||
                completedPromptIdsRef.current.has(result.promptId);
              const startedOrCompleted =
                settled ||
                displayedServerPromptIdsRef.current.has(result.promptId) ||
                pendingStartedByPromptIdRef.current.has(result.promptId);
              if (startedOrCompleted) {
                // No echo here: a settle means the message already ran and
                // the settle cleared the displayed guard, and a start is
                // either already echoed (displayed) or was consumed by the
                // park consume above — this arm only drops the row.
                const next = queuedPromptsRef.current.filter(
                  (item) => item.id !== localId,
                );
                queuedPromptsRef.current = next;
                setQueuedPrompts(next);
                if (prompt.onComplete) {
                  settleCompletionCallback(result.promptId, prompt.onComplete);
                }
              } else {
                returnedUnboundPromptIdsRef.current.set(
                  result.promptId,
                  localId,
                );
                while (returnedUnboundPromptIdsRef.current.size > 200) {
                  const oldestReturned = returnedUnboundPromptIdsRef.current
                    .keys()
                    .next().value;
                  if (typeof oldestReturned !== 'string') break;
                  returnedUnboundPromptIdsRef.current.delete(oldestReturned);
                }
                if (prompt.onComplete) {
                  // The daemon already holds the prompt, so its callback
                  // must be registered now or no terminal event will ever
                  // fire it.
                  settleCompletionCallback(result.promptId, prompt.onComplete);
                }
              }
              return;
            }
            // A settle or removal that beat the confirmation snapshot wins
            // over it: the sync treats both markers as authoritative, and
            // stamping the id here would leave a sticky row the next sync
            // destroys — and the fall-through below would re-echo a message
            // that never ran.
            const settledOrRemoving =
              settledServerPromptIdsRef.current.has(result.promptId) ||
              removingServerPromptIdsRef.current.has(result.promptId);
            if (bound === undefined && settledOrRemoving) {
              const next = queuedPromptsRef.current.filter(
                (item) => item.id !== localId,
              );
              queuedPromptsRef.current = next;
              setQueuedPrompts(next);
              if (prompt.onComplete) {
                settleCompletionCallback(result.promptId, prompt.onComplete);
              }
              return;
            }
            // Bind by the id the daemon returned, not by rendered text:
            // identical resubmissions carrying attachments suppress both the
            // text binding and the materialization, and the fall-through
            // below echoes a message the daemon still holds queued. The
            // settled-or-removing case already returned above.
            const queuedInSnapshot =
              !startedSinceSnapshot &&
              refresh.pendingPrompts.some(
                (p) => p.promptId === result.promptId && p.state === 'queued',
              );
            if (bound === undefined && queuedInSnapshot) {
              bindRowToPrompt();
              return;
            }
          }
          if (
            !latestSessionActiveRef.current ||
            prompt.resubmittedAfterIdleRejection
          ) {
            if (!localMessageAppended) {
              appendLocalQueuedPrompt(prompt, result.promptId);
            }
            const next = queuedPromptsRef.current.filter(
              (prompt) => prompt.id !== localId,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            if (prompt.onComplete) {
              settleCompletionCallback(result.promptId, prompt.onComplete);
            }
            return;
          }
          const current = queuedPromptsRef.current;
          const idx = current.findIndex((p) => p.id === localId);
          if (idx === -1) {
            if (syncClaimedSubmittingRowIdsRef.current.delete(localId)) {
              // The confirming sync attributed this row to an
              // already-displayed prompt with the same rendered text and
              // dropped it — nothing was cleared, so the admitted prompt
              // stays. The row the next snapshot materializes for it is
              // summary-only and cannot echo, so the started event's source
              // is the payload this body still holds: stash it under the
              // daemon's id. The `.finally` below issues this path's only
              // refresh.
              pendingEchoByPromptIdRef.current.set(result.promptId, prompt);
              while (pendingEchoByPromptIdRef.current.size > 200) {
                const oldestClaimEcho = pendingEchoByPromptIdRef.current
                  .keys()
                  .next().value;
                if (typeof oldestClaimEcho !== 'string') break;
                pendingEchoByPromptIdRef.current.delete(oldestClaimEcho);
              }
              if (prompt.onComplete) {
                settleCompletionCallback(result.promptId, prompt.onComplete);
              }
              return;
            }
            // The row can also be gone because the prompt already ran: a
            // sync bound it and the started event's echo dropped the bound
            // row, leaving no marker this body consumes. Client-side
            // evidence of a start or settle licenses no cancellation — the
            // DELETE would abort a live turn.
            if (
              displayedServerPromptIdsRef.current.has(result.promptId) ||
              settledServerPromptIdsRef.current.has(result.promptId) ||
              pendingStartedByPromptIdRef.current.has(result.promptId) ||
              completedPromptIdsRef.current.has(result.promptId)
            ) {
              if (prompt.onComplete) {
                settleCompletionCallback(result.promptId, prompt.onComplete);
              }
              return;
            }
            // The removal can still come back not-removed — the id may be
            // absent, or already removed by another client while the doomed
            // prompt runs on to settle — and the started event carries only
            // rendered text, so keep the payload under the daemon's id until
            // the outcome: a failed removal replays the echo from here
            // instead of dropping to the placeholder.
            if (eventCannotReproducePayload(prompt)) {
              pendingEchoByPromptIdRef.current.set(result.promptId, prompt);
              while (pendingEchoByPromptIdRef.current.size > 200) {
                const oldestEcho = pendingEchoByPromptIdRef.current
                  .keys()
                  .next().value;
                if (typeof oldestEcho !== 'string') break;
                pendingEchoByPromptIdRef.current.delete(oldestEcho);
              }
            }
            // The removal owns the prompt from here: a start landing inside
            // the DELETE flight must park like every sibling removal path,
            // so the outcome — not the event — decides whether it echoes.
            removingServerPromptIdsRef.current.add(result.promptId);
            sessionActions
              .removePendingPrompt(result.promptId, {
                sessionId: targetSessionId,
              })
              .then(
                (removeResult) => removeResult.removed,
                () => false,
              )
              // Clearing the flag before acting on the outcome matters: a
              // re-sync that runs while the id is still marked as being
              // removed skips the very prompt a failed removal left behind.
              .finally(() => {
                removingServerPromptIdsRef.current.delete(result.promptId);
              })
              .then((removed) => {
                if (removed) {
                  // The daemon confirmed the removal: the prompt never ran
                  // to completion, so the parked start and the stashed
                  // payload are both dead weight.
                  startedDuringRemovalRef.current.delete(result.promptId);
                  pendingEchoByPromptIdRef.current.delete(result.promptId);
                } else {
                  // The removal came back not-removed — the id is absent, or
                  // already removed by another client while the doomed
                  // prompt runs on to settle — so a start may have parked
                  // for a prompt that really did run: replay it, and
                  // register the callback either way, since no terminal
                  // event fires a callback that was never registered. The
                  // success arm stays silent — a removed prompt is a
                  // cancellation.
                  if (prompt.onComplete) {
                    settleCompletionCallback(
                      result.promptId,
                      prompt.onComplete,
                    );
                  }
                  replayStartedDuringRemoval(result.promptId);
                  void refreshPendingPrompts(targetSessionId);
                }
              });
            return;
          }
          const updated = [...current];
          const localPrompt = updated[idx]!;
          updated[idx] = {
            ...localPrompt,
            serverPromptId: result.promptId,
            serverState: 'queued',
            boundAtSeq: refreshRequestSeqRef.current,
          };
          queuedPromptsRef.current = updated;
          setQueuedPrompts(updated);
          if (prompt.onComplete) {
            settleCompletionCallback(result.promptId, prompt.onComplete);
          }
        })
        .catch((error: unknown) => {
          submitAbortControllersRef.current.delete(submitAbort);
          if (
            !isCurrentOwnerTokenRef.current(ownerToken) ||
            latestSessionIdRef.current !== targetSessionId
          ) {
            return;
          }
          // A row the confirming sync claimed for an already-displayed
          // prompt is gone without any user cancellation; the failure path
          // still owns it when nothing reached the daemon, or the draft
          // would vanish with no error. Once admission started the daemon
          // may already hold and echo the prompt, so a transport failure
          // past that point must not report a false queue failure.
          const syncClaimed =
            syncClaimedSubmittingRowIdsRef.current.delete(localId);
          if (
            !(syncClaimed && !admissionStarted) &&
            !queuedPromptsRef.current.some((p) => p.id === localId)
          ) {
            return;
          }
          const next = queuedPromptsRef.current.filter(
            (prompt) => prompt.id !== localId,
          );
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
          if (!admissionStarted) {
            restoreQueuedPromptsToEditor([prompt], targetSessionId);
          }
          reportError(error, t('queue.queueFailed'));
        })
        .finally(() => {
          if (
            !refreshedInBody &&
            isCurrentOwnerTokenRef.current(ownerToken) &&
            latestSessionIdRef.current === targetSessionId
          ) {
            void refreshPendingPrompts(targetSessionId);
          }
        });
    },
    [
      appendLocalQueuedPrompt,
      refreshPendingPrompts,
      replayStartedDuringRemoval,
      reportError,
      restoreQueuedPromptsToEditor,
      sessionActions,
      settleCompletionCallback,
      t,
    ],
  );

  /**
   * One link of the serial release chain: hand the daemon a prompt the drain
   * has already stamped `submitting`, but only while it is still ours to send.
   * Shared with `enqueuePrompt`, which appends to a live chain rather than
   * POSTing past it, so both paths carry the same guards.
   */
  const releaseChainedPrompt = useCallback(
    (prompt: QueuedPrompt, chainOwner: typeof ownerToken): Promise<void> => {
      // Owner changed mid-drain: `submitPrompt` would throw on the session
      // mismatch before POSTing and the `.catch` below would swallow it,
      // dropping the prompt silently. Bail and leave the rows alone — the
      // owner-change effect has already stashed them for the session they
      // were typed in, and touching state here would fight it.
      //
      // The id must stay in `unreleasedPromptIdsRef` on this path. The
      // token is replaced in the render body while the stash is a passive
      // effect flushed after commit, so a link firing in that window would
      // otherwise leave a row that is neither locally held (it is stamped
      // `submitting`) nor unreleased — and the stash drops exactly those.
      if (!isCurrentOwnerTokenRef.current(chainOwner)) {
        return Promise.resolve();
      }
      unreleasedPromptIdsRef.current.delete(prompt.id);
      // Every path that removes a stamped row means cancellation: a queue
      // clear mid-drain aborts the in-flight link's controller, but the
      // links still pending have no controller yet, so only the row's
      // absence tells them the user cleared what they were about to POST.
      if (!queuedPromptsRef.current.some((item) => item.id === prompt.id)) {
        return Promise.resolve();
      }
      // Re-check the hold per link, not once for the whole batch: the chain
      // is built synchronously when the hold lifts, but each link runs only
      // after the previous admission settles. A Goal resumed inside that
      // window (or a write block) must stop the remaining links instead of
      // POSTing them against an active Goal — they return to held, and the
      // next inactive transition re-drains them in order.
      if (holdQueuedPromptsLocallyRef.current || writeBlockedRef.current) {
        // Inline rather than `setQueuedPromptFlags`: that callback is
        // declared below, so naming it here would read it before its
        // initializer.
        const reverted = queuedPromptsRef.current.map((item) =>
          item.id === prompt.id ? { ...item, serverState: undefined } : item,
        );
        queuedPromptsRef.current = reverted;
        setQueuedPrompts(reverted);
        return Promise.resolve();
      }
      return submitPendingPrompt(prompt).catch(() => undefined);
    },
    [submitPendingPrompt],
  );

  const fallbackToPendingPrompt = useCallback(
    (id: number) => {
      const deferSubmission =
        writeBlockedRef.current || holdQueuedPromptsLocallyRef.current;
      const current = queuedPromptsRef.current;
      const index = current.findIndex(
        (prompt) => prompt.id === id && prompt.midTurnState !== undefined,
      );
      if (index === -1) return;
      const prompt: QueuedPrompt = {
        ...current[index]!,
        midTurnState: undefined,
        midTurnMessageId: undefined,
        midTurnFailedAction: undefined,
        ...(deferSubmission ? {} : { serverState: 'submitting' as const }),
        isEditing: false,
        isRemoving: false,
      };
      const next = [...current];
      next[index] = prompt;
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      if (!deferSubmission) submitPendingPrompt(prompt);
    },
    [submitPendingPrompt],
  );

  const enqueuePrompt = useCallback(
    (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      onComplete?: () => void,
      inputAnnotations?: DaemonInputAnnotation[],
      onAdmitted?: () => void,
      submittedPrompt?: string,
    ) => {
      const trimmed = text.trim();
      if (!trimmed && (images?.length ?? 0) === 0 && (files?.length ?? 0) === 0)
        return true;
      const targetSessionId = latestSessionIdRef.current;
      const targetWorkspaceCwd = latestWorkspaceCwdRef.current;
      const ownerToken = ownerTokenRef.current;
      const imageList = images ?? [];
      const fileList = files ?? [];
      const annotated = annotatedFiles(text, inputAnnotations);
      const annotatedFileList = annotated?.paths.map(annotatedFile) ?? [];
      // Mid-turn media needs the daemon-owned id surface AND the daemon's media
      // capability; an image we can't type also keeps the whole message on the
      // next-turn path so the daemon never drops part of the payload.
      const canSendMidTurnMedia =
        imageList.length > 0 &&
        canQueryMidTurn &&
        canInjectMidTurnMedia &&
        imageList.every(
          (image) =>
            image.data.length > 0 &&
            image.media_type.startsWith('image/') &&
            image.media_type !== 'image/*',
        );
      const canSendMidTurnFiles =
        fileList.length > 0 && canQueryMidTurn && canInjectMidTurnMedia;
      const canSendMidTurnAnnotatedFiles =
        annotatedFileList.length > 0 &&
        canQueryMidTurn &&
        canInjectMidTurnMedia &&
        workspaceFileActions !== undefined;
      const shouldInsertMidTurn =
        !holdQueuedPromptsLocallyRef.current &&
        latestSessionActiveRef.current &&
        (imageList.length === 0 || canSendMidTurnMedia) &&
        (fileList.length === 0 || canSendMidTurnFiles) &&
        annotated !== undefined &&
        (annotatedFileList.length === 0 || canSendMidTurnAnnotatedFiles) &&
        !isCommandPrompt(trimmed);
      const midTurnMessageId =
        shouldInsertMidTurn && canQueryMidTurn
          ? `webui_${
              typeof crypto !== 'undefined' &&
              typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
            }`
          : undefined;

      if (
        shouldInsertMidTurn &&
        canQueryMidTurn &&
        midTurnMessageId &&
        targetSessionId
      ) {
        const targetIsCurrent = () =>
          isCurrentOwnerTokenRef.current(ownerToken) &&
          latestSessionIdRef.current === targetSessionId &&
          latestWorkspaceCwdRef.current === targetWorkspaceCwd;
        const pendingAdmission: QueuedPrompt = {
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: annotated?.displayText ?? trimmed,
          ...(imageList.length > 0 ? { images: [...imageList] } : {}),
          ...(fileList.length > 0 || annotatedFileList.length > 0
            ? { files: [...fileList, ...annotatedFileList] }
            : {}),
          midTurnMessageId,
          midTurnState: 'submitting',
          payloadCompleteness:
            annotatedFileList.length > 0 ? 'summary-only' : 'complete',
        };
        pendingMidTurnAdmissionsRef.current.set(midTurnMessageId, {
          prompt: pendingAdmission,
          workspaceCwd: targetWorkspaceCwd,
        });
        const restoreAdmission: QueuedPrompt = {
          ...pendingAdmission,
          text: trimmed,
          files: fileList.length > 0 ? [...fileList] : undefined,
          ...(submittedPrompt !== undefined ? { submittedPrompt } : {}),
          inputAnnotations: inputAnnotations
            ? [...inputAnnotations]
            : undefined,
          payloadCompleteness: 'complete',
        };
        if (
          imageList.length > 0 ||
          fileList.length > 0 ||
          annotatedFileList.length > 0
        ) {
          queuedPromptsRef.current = [
            ...queuedPromptsRef.current,
            pendingAdmission,
          ];
          setQueuedPrompts(queuedPromptsRef.current);
        }
        if (onComplete) {
          settleCompletionCallback(midTurnMessageId, onComplete);
        }
        const abort = midTurnEnqueueAbortRef.current ?? new AbortController();
        midTurnEnqueueAbortRef.current = abort;
        let enqueueStarted = false;
        let enqueueDispatched = false;
        let uploadedAttachmentReferences: DaemonSessionAttachmentReference[] =
          [];
        const removeUploadedAttachments = async () => {
          await Promise.allSettled(
            uploadedAttachmentReferences.map((reference) =>
              sessionActions.removeAttachment(reference.attachmentId, {
                sessionId: targetSessionId,
              }),
            ),
          );
          uploadedAttachmentReferences = [];
        };
        void Promise.allSettled([
          ...imageList.map(
            async (image) =>
              await sessionActions.uploadAttachment(
                {
                  data: image.data,
                  mimeType: image.media_type,
                },
                { signal: abort.signal, sessionId: targetSessionId },
              ),
          ),
          ...fileList.map(
            async (file) =>
              await sessionActions.uploadAttachment(
                {
                  name: file.name,
                  data: file.data,
                  text: file.text,
                  mimeType: file.media_type,
                },
                { signal: abort.signal, sessionId: targetSessionId },
              ),
          ),
          ...annotatedFileList.map(async (file, index) => {
            const filePath = annotated!.paths[index]!;
            const data = await readWorkspaceFileAsBlob(
              (path, options) =>
                workspaceFileActions!.readFileBytes(path, options),
              filePath,
              file.media_type,
              {
                statFile: (path) => workspaceFileActions!.stat(path),
                isCancelled: () => abort.signal.aborted,
                maxBytes: MAX_FILE_ATTACHMENT_DATA_BYTES,
              },
            );
            return await sessionActions.uploadAttachment(
              {
                name: file.name,
                data,
                mimeType: file.media_type,
              },
              { signal: abort.signal, sessionId: targetSessionId },
            );
          }),
        ])
          .then(async (results) => {
            uploadedAttachmentReferences = results.flatMap((result) =>
              result.status === 'fulfilled' ? [result.value] : [],
            );
            const failure = results.find(
              (result): result is PromiseRejectedResult =>
                result.status === 'rejected',
            );
            if (failure) {
              throw failure.reason;
            }
            if (
              abort.signal.aborted ||
              latestSessionIdRef.current !== targetSessionId ||
              latestWorkspaceCwdRef.current !== targetWorkspaceCwd
            ) {
              throw new DOMException('Session changed', 'AbortError');
            }
            if (fileList.length > 0 || annotatedFileList.length > 0) {
              const sourceFiles = [...fileList, ...annotatedFileList];
              const attachedFiles = uploadedAttachmentReferences
                .slice(imageList.length)
                .map((reference, index) => ({
                  ...sourceFiles[index]!,
                  media_type: reference.mimeType,
                  size: reference.size,
                  attachmentId: reference.attachmentId,
                }));
              const admittedPrompt = {
                ...pendingAdmission,
                ...(attachedFiles.length > 0 ? { files: attachedFiles } : {}),
              };
              pendingMidTurnAdmissionsRef.current.set(midTurnMessageId, {
                prompt: admittedPrompt,
                workspaceCwd: targetWorkspaceCwd,
              });
              queuedPromptsRef.current = queuedPromptsRef.current.map(
                (prompt) =>
                  prompt.midTurnMessageId === midTurnMessageId
                    ? admittedPrompt
                    : prompt,
              );
              setQueuedPrompts(queuedPromptsRef.current);
            }
            enqueueStarted = true;
            return await sessionActions.enqueueMidTurnMessage(
              annotated?.displayText ?? trimmed,
              {
                signal: abort.signal,
                messageId: midTurnMessageId,
                onAdmissionStarted: () => {
                  enqueueDispatched = true;
                },
                ...(uploadedAttachmentReferences.length > 0
                  ? { content: uploadedAttachmentReferences }
                  : {}),
              },
            );
          })
          .then(async (result) => {
            if (!result.accepted) {
              if (!enqueueDispatched) {
                enqueueStarted = false;
                throw new Error('Mid-turn message was not dispatched');
              }
              await removeUploadedAttachments();
              completionCallbacksRef.current.delete(midTurnMessageId);
              pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
              const next = queuedPromptsRef.current.filter(
                (prompt) =>
                  prompt.midTurnMessageId !== midTurnMessageId &&
                  prompt.id !== restoreAdmission.id,
              );
              // The daemon rejected the insert outright, so nothing of it is
              // queued server-side. Its idle verdict can precede the UI update;
              // use the ordinary path (or hold it while a Goal runs) in either
              // case instead of dropping it. Keep the UI-idle term beside
              // `reason`: daemons older than that field omit it, and a
              // rejection with another cause can still land after the turn
              // ends.
              if (
                targetIsCurrent() &&
                (result.reason === 'session_idle' ||
                  latestRawStreamingStateRef.current === 'idle')
              ) {
                const shouldHold =
                  holdQueuedPromptsLocallyRef.current ||
                  writeBlockedRef.current;
                const prompt: QueuedPrompt = {
                  ...restoreAdmission,
                  midTurnState: undefined,
                  midTurnMessageId: undefined,
                  ...(shouldHold
                    ? {}
                    : {
                        serverState: 'submitting' as const,
                        resubmittedAfterIdleRejection:
                          result.reason === 'session_idle',
                      }),
                  onComplete,
                  onAdmitted,
                };
                const requeued = [...next, prompt];
                queuedPromptsRef.current = requeued;
                setQueuedPrompts(requeued);
                if (shouldHold) return;
                submitPendingPrompt(prompt);
                return;
              }
              queuedPromptsRef.current = next;
              setQueuedPrompts(next);
              if (!targetIsCurrent()) return;
              await reconcileMidTurnMessages(targetSessionId);
              if (!targetIsCurrent()) return;
              reportError(
                new Error('Daemon rejected mid-turn message'),
                t('queue.queueFailed'),
              );
              return;
            }
            if (targetIsCurrent()) onAdmitted?.();
            const next = queuedPromptsRef.current.filter(
              (prompt) => prompt.midTurnMessageId !== midTurnMessageId,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            if (targetIsCurrent()) {
              await reconcileMidTurnMessages(targetSessionId);
            } else {
              pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
              completionCallbacksRef.current.delete(midTurnMessageId);
            }
          })
          .catch(async (error: unknown) => {
            if (!enqueueStarted) await removeUploadedAttachments();
            if (!targetIsCurrent()) {
              completionCallbacksRef.current.delete(midTurnMessageId);
              const pendingAdmissionStillOwned =
                pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
              if (!enqueueStarted) {
                // Nothing reached the daemon, so the draft is still ours to
                // return: restore it to the current editor instead of
                // leaking it across the session switch.
                if (pendingAdmissionStillOwned) {
                  restoreQueuedPromptsToEditor([restoreAdmission], undefined);
                  reportError(error, t('queue.queueFailed'));
                }
              }
              // An enqueue already dispatched when the session changed may
              // have reached the daemon: keep the uploaded media (a queued
              // message may reference it) and drop only the admission, so
              // its base64 payload is not pinned until reload and no stale
              // row materializes when returning to the old session.
              return;
            }
            if (!enqueueStarted) {
              completionCallbacksRef.current.delete(midTurnMessageId);
              const pendingAdmissionStillOwned =
                pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
              if (!pendingAdmissionStillOwned) return;
              const next = queuedPromptsRef.current.filter(
                (prompt) => prompt.midTurnMessageId !== midTurnMessageId,
              );
              queuedPromptsRef.current = next;
              setQueuedPrompts(next);
              restoreQueuedPromptsToEditor([restoreAdmission], targetSessionId);
              reportError(error, t('queue.queueFailed'));
              return;
            }
            const snapshot = await reconcileMidTurnMessages(targetSessionId);
            if (!targetIsCurrent()) {
              completionCallbacksRef.current.delete(midTurnMessageId);
              pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
              return;
            }
            const known =
              snapshot?.messages.some(
                (message) => message.messageId === midTurnMessageId,
              ) === true ||
              snapshot?.settledMessageIds.includes(midTurnMessageId) === true ||
              snapshot?.promotedMessageIds.includes(midTurnMessageId) === true;
            if (known) return;
            if (
              snapshot === undefined &&
              queuedPromptsRef.current.some(
                (prompt) =>
                  (prompt.midTurnMessageId === midTurnMessageId &&
                    prompt.midTurnState === 'queued') ||
                  prompt.serverPromptId === midTurnMessageId,
              )
            ) {
              return;
            }
            completionCallbacksRef.current.delete(midTurnMessageId);
            pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
            const next = queuedPromptsRef.current.filter(
              (prompt) => prompt.midTurnMessageId !== midTurnMessageId,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            reportError(error, t('queue.queueFailed'));
          });
        return true;
      }

      const prompt: QueuedPrompt = {
        ...(submittedPrompt !== undefined ? { submittedPrompt } : {}),
        id: nextQueuedPromptIdRef.current++,
        sessionId: targetSessionId,
        text: trimmed,
        images: images ? [...images] : undefined,
        files: files ? [...files] : undefined,
        inputAnnotations: inputAnnotations ? [...inputAnnotations] : undefined,
        onComplete,
        onAdmitted,
        payloadCompleteness: 'complete',
        ...(holdQueuedPromptsLocallyRef.current
          ? {}
          : shouldInsertMidTurn
            ? {
                midTurnState: 'submitting',
              }
            : { serverState: 'submitting' }),
      };
      queuedPromptsRef.current = [...queuedPromptsRef.current, prompt];
      setQueuedPrompts(queuedPromptsRef.current);

      if (holdQueuedPromptsLocallyRef.current) return true;

      if (!shouldInsertMidTurn) {
        // A drain is still releasing older held prompts: append to its tail
        // rather than POSTing past it. The chain exists because the prompt at
        // its head may await media uploads for seconds; this prompt was typed
        // inside that window — i.e. AFTER the rows still waiting — so sending
        // it now would admit it ahead of them.
        const chain = releaseChainRef.current;
        if (chain && isCurrentOwnerTokenRef.current(chain.owner)) {
          // Stamped `submitting` above but not yet POSTed: the same state the
          // chain's own undrained rows are in, so record it as unreleased and
          // an owner change stashes the text instead of losing it.
          unreleasedPromptIdsRef.current.add(prompt.id);
          chain.tail = chain.tail.then(() =>
            releaseChainedPrompt(prompt, chain.owner),
          );
          return true;
        }
        submitPendingPrompt(prompt);
        return true;
      }

      const abort = midTurnEnqueueAbortRef.current ?? new AbortController();
      midTurnEnqueueAbortRef.current = abort;
      void sessionActions
        .enqueueMidTurnMessage(trimmed, {
          signal: abort.signal,
        })
        .then((result) => {
          if (!isCurrentOwnerTokenRef.current(ownerToken)) return;
          const current = queuedPromptsRef.current;
          const index = current.findIndex((item) => item.id === prompt.id);
          if (index === -1) return;
          if (current[index]?.midTurnState === undefined) return;
          if (latestSessionIdRef.current !== targetSessionId) return;
          if (!result.accepted) {
            fallbackToPendingPrompt(prompt.id);
            return;
          }
          if (!latestSessionActiveRef.current) {
            const next = current.filter((item) => item.id !== prompt.id);
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            prompt.onAdmitted?.();
            if (prompt.onComplete && result.messageId) {
              settleCompletionCallback(result.messageId, prompt.onComplete);
            }
            return;
          }
          prompt.onAdmitted?.();
          if (prompt.onComplete && result.messageId) {
            settleCompletionCallback(result.messageId, prompt.onComplete);
          }
          const next = [...current];
          next[index] = {
            ...current[index]!,
            midTurnState: 'queued',
            midTurnMessageId: result.messageId,
          };
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
        })
        .catch(() => {
          if (!isCurrentOwnerTokenRef.current(ownerToken)) return;
          if (latestSessionIdRef.current !== targetSessionId) return;
          fallbackToPendingPrompt(prompt.id);
        });
      return true;
    },
    [
      canInjectMidTurnMedia,
      canQueryMidTurn,
      fallbackToPendingPrompt,
      reconcileMidTurnMessages,
      releaseChainedPrompt,
      reportError,
      restoreQueuedPromptsToEditor,
      sessionActions,
      settleCompletionCallback,
      submitPendingPrompt,
      t,
      workspaceFileActions,
    ],
  );

  const { batches: midTurnInjectedBatches, consume: consumeMidTurnInjected } =
    useDaemonMidTurnInjected();
  useEffect(() => {
    if (!sessionId || midTurnInjectedBatches.length === 0) return;
    const sessionBatches = midTurnInjectedBatches.filter(
      (batch) => batch.sessionId === sessionId,
    );
    if (sessionBatches.length === 0) return;
    for (const batch of sessionBatches) {
      for (const messageId of batch.messageIds ?? []) {
        pendingMidTurnAdmissionsRef.current.delete(messageId);
        const callback = completionCallbacksRef.current.get(messageId);
        completionCallbacksRef.current.delete(messageId);
        callback?.();
      }
    }
    const current = queuedPromptsRef.current;
    const next = removeInjectedFromQueue(
      current,
      sessionBatches,
      sessionId,
      clientId,
      canQueryMidTurn,
    );
    if (next) {
      const retainedIds = new Set(next.map((prompt) => prompt.id));
      for (const prompt of current) {
        if (!retainedIds.has(prompt.id)) prompt.onComplete?.();
      }
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    }
    consumeMidTurnInjected(sessionBatches);
    // Fence an enqueue-time snapshot that may have captured the message before
    // this injection, then confirm the local removal against daemon state.
    if (canQueryMidTurn) void reconcileMidTurnMessages(sessionId);
  }, [
    midTurnInjectedBatches,
    sessionId,
    clientId,
    canQueryMidTurn,
    consumeMidTurnInjected,
    reconcileMidTurnMessages,
  ]);

  useEffect(() => {
    if (sessionActive || writeBlocked) return;
    if (!canQueryMidTurn) {
      const acceptedIds = new Set(
        queuedPromptsRef.current
          .filter(
            (prompt) =>
              prompt.midTurnState === 'queued' &&
              !prompt.midTurnFailedAction &&
              !prompt.isEditing &&
              !prompt.isRemoving,
          )
          .map((prompt) => prompt.id),
      );
      if (acceptedIds.size > 0) {
        const next = queuedPromptsRef.current.filter(
          (prompt) => !acceptedIds.has(prompt.id),
        );
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
      }
    }
    if (holdQueuedPromptsLocally) return;
    for (const prompt of queuedPromptsRef.current) {
      if (!prompt.midTurnFailedAction) continue;
      const next = queuedPromptsRef.current.filter(
        (item) => item.id !== prompt.id,
      );
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      if (prompt.midTurnFailedAction === 'edit') {
        restoreQueuedPromptsToEditor([prompt], prompt.sessionId);
      }
    }
    const localPrompts = queuedPromptsRef.current.filter(
      (prompt) =>
        isLocallyHeldPrompt(prompt) &&
        !prompt.isEditing &&
        !prompt.isRemoving &&
        !prompt.isInserting,
    );
    if (localPrompts.length > 0) {
      const localIds = new Set(localPrompts.map((prompt) => prompt.id));
      const next = queuedPromptsRef.current.map((prompt) =>
        localIds.has(prompt.id)
          ? { ...prompt, serverState: 'submitting' as const }
          : prompt,
      );
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      // Release serially: a prompt carrying media awaits its uploads before its
      // admission POST, so firing the whole batch at once lets a later plain
      // prompt overtake it and reach the daemon's queue out of order.
      //
      // The chain is built synchronously, but each link runs only after the
      // previous admission settles, so the session can change mid-drain.
      // Pinned here rather than read per link: the guard has to ask "is this
      // still the owner the chain was built for", not "is there an owner".
      const chainOwner = ownerTokenRef.current;
      // A chain for this owner may still be draining (a hold that flipped on
      // and back off re-drains the rows its links reverted). Extend it instead
      // of racing it, so every release for one owner stays on one chain.
      const liveChain = releaseChainRef.current;
      const liveTail =
        liveChain && isCurrentOwnerTokenRef.current(liveChain.owner)
          ? liveChain.tail
          : undefined;
      let release: Promise<void> | undefined = liveTail;
      for (const id of localIds) unreleasedPromptIdsRef.current.add(id);
      for (const prompt of next) {
        if (!localIds.has(prompt.id)) continue;
        const submit = () => releaseChainedPrompt(prompt, chainOwner);
        // With no chain already draining, the first release stays synchronous,
        // so a single held prompt reaches the daemon exactly as it did before.
        release = release ? release.then(submit) : submit();
      }
      // Publish the tail so a prompt typed during the drain queues behind the
      // rows it was typed after instead of POSTing past them.
      if (release) {
        if (liveChain && liveTail !== undefined) {
          liveChain.tail = release;
        } else {
          const chain = { owner: chainOwner, tail: release };
          releaseChainRef.current = chain;
          retireChainWhenDrained(releaseChainRef, chain);
        }
      }
    }
    if (!canQueryMidTurn) return;
    // Query-capable daemons own accepted rows. Never POST them again at idle;
    // only project the authoritative mid-turn and pending snapshots.
    const reconcileCtrl = new AbortController();
    const targetSessionId = latestSessionIdRef.current;
    if (!targetSessionId) return;
    const seq = ++midTurnReconcileSeqRef.current;
    void reconcileMidTurnMessages(targetSessionId, {
      signal: reconcileCtrl.signal,
      seq,
    });
    return () => {
      reconcileCtrl.abort();
    };
  }, [
    sessionActive,
    writeBlocked,
    holdQueuedPromptsLocally,
    canQueryMidTurn,
    releaseChainedPrompt,
    submitPendingPrompt,
    restoreQueuedPromptsToEditor,
    reconcileMidTurnMessages,
  ]);

  const popQueuedPromptForEdit = useCallback(
    (id?: number): QueuedPrompt | null => {
      const current = queuedPromptsRef.current;
      if (current.length === 0) return null;
      const index =
        id === undefined
          ? current.length - 1
          : current.findIndex((prompt) => prompt.id === id);
      if (index < 0) return null;
      const prompt = current[index];
      if (!prompt) return null;
      const next = current.filter((_, i) => i !== index);
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      return prompt;
    },
    [],
  );

  const setQueuedPromptFlags = useCallback(
    (
      id: number,
      flags: Partial<
        Pick<
          QueuedPrompt,
          | 'isEditing'
          | 'isRemoving'
          | 'isInserting'
          | 'midTurnFailedAction'
          | 'midTurnState'
          | 'midTurnMessageId'
          | 'serverState'
        >
      >,
    ) => {
      const next = queuedPromptsRef.current.map((prompt) =>
        prompt.id === id ? { ...prompt, ...flags } : prompt,
      );
      if (areQueuedPromptsEqual(next, queuedPromptsRef.current)) return;
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    },
    [],
  );

  const removeServerPromptForAction = useCallback(
    async (
      target: QueuedPrompt,
      flags: Partial<Pick<QueuedPrompt, 'isEditing' | 'isRemoving'>>,
      fallback: string,
    ): Promise<boolean> => {
      const ownerToken = ownerTokenRef.current;
      const removingPromptIds = removingServerPromptIdsRef.current;
      if (!target.serverPromptId) return true;
      if (target.serverState !== 'queued') return false;
      if (removingPromptIds.has(target.serverPromptId)) {
        return false;
      }
      const targetSessionId = target.sessionId;
      removingPromptIds.add(target.serverPromptId);
      setQueuedPromptFlags(target.id, flags);
      try {
        const result = await sessionActions.removePendingPrompt(
          target.serverPromptId,
          {
            sessionId: targetSessionId,
          },
        );
        removingPromptIds.delete(target.serverPromptId);
        if (!isCurrentOwnerTokenRef.current(ownerToken)) return result.removed;
        if (!result.removed) {
          setQueuedPromptFlags(target.id, {
            isEditing: false,
            isRemoving: false,
          });
          await refreshPendingPrompts(targetSessionId);
          if (!isCurrentOwnerTokenRef.current(ownerToken)) return false;
          reportError(
            new Error('Prompt could not be removed from queue'),
            fallback,
          );
          return false;
        }
        completionCallbacksRef.current.delete(target.serverPromptId);
        pendingEchoByPromptIdRef.current.delete(target.serverPromptId);
        startedDuringRemovalRef.current.delete(target.serverPromptId);
        // The confirming snapshot must post-date the DELETE: the fence
        // default refuses to join a GET dispatched before it, which would
        // re-list the prompt and keep the row its own removal deleted.
        const refreshResult = await refreshPendingPrompts(targetSessionId);
        if (!isCurrentOwnerTokenRef.current(ownerToken)) return true;
        if (refreshResult.status === 'failed') {
          setQueuedPromptFlags(target.id, {
            isEditing: false,
            isRemoving: false,
          });
          reportError(
            new Error('Queue changed but pending prompts could not refresh'),
            fallback,
          );
        }
        return true;
      } catch (error) {
        if (!isCurrentOwnerTokenRef.current(ownerToken)) return false;
        removingPromptIds.delete(target.serverPromptId);
        setQueuedPromptFlags(target.id, {
          isEditing: false,
          isRemoving: false,
        });
        const refreshResult = await refreshPendingPrompts(targetSessionId);
        if (!isCurrentOwnerTokenRef.current(ownerToken)) return false;
        if (refreshResult.status !== 'refreshed') {
          restoreQueuedPrompts([target]);
        }
        reportError(error, fallback);
        return false;
      }
    },
    [
      refreshPendingPrompts,
      reportError,
      restoreQueuedPrompts,
      sessionActions,
      setQueuedPromptFlags,
    ],
  );

  const removeMidTurnPromptForAction = useCallback(
    async (
      target: QueuedPrompt,
      flags: Partial<Pick<QueuedPrompt, 'isEditing' | 'isRemoving'>>,
      fallback: string,
    ): Promise<boolean> => {
      const ownerToken = ownerTokenRef.current;
      if (
        target.midTurnState !== 'queued' ||
        !target.midTurnMessageId ||
        !canMutateMidTurn ||
        target.isEditing ||
        target.isRemoving
      ) {
        return false;
      }
      midTurnReconcileSeqRef.current += 1;
      const failedAction = flags.isEditing ? 'edit' : 'delete';
      setQueuedPromptFlags(target.id, {
        ...flags,
        midTurnFailedAction: undefined,
      });
      try {
        const result = await sessionActions.removeMidTurnMessage(
          target.midTurnMessageId,
          { sessionId: target.sessionId },
        );
        if (result.removed) {
          await Promise.allSettled(
            (target.files ?? []).flatMap((file) =>
              file.attachmentId
                ? [
                    sessionActions.removeAttachment(file.attachmentId, {
                      sessionId: target.sessionId,
                    }),
                  ]
                : [],
            ),
          );
        }
        if (!isCurrentOwnerTokenRef.current(ownerToken)) return result.removed;
        const current = queuedPromptsRef.current;
        const latest = current.find((prompt) => prompt.id === target.id);
        if (!latest) return result.removed;
        if (
          latest.midTurnState !== 'queued' ||
          latest.midTurnMessageId !== target.midTurnMessageId
        ) {
          return false;
        }
        if (!result.removed) {
          if (canQueryMidTurn) {
            setQueuedPromptFlags(target.id, {
              isEditing: false,
              isRemoving: false,
            });
            if (target.sessionId) {
              await reconcileMidTurnMessages(target.sessionId);
            }
            reportError(
              new Error('Message was already delivered or completed'),
              fallback,
            );
            return false;
          }
          const settledAtIdle = !latestSessionActiveRef.current;
          if (settledAtIdle) {
            const next = current.filter((prompt) => prompt.id !== target.id);
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
          } else {
            setQueuedPromptFlags(target.id, {
              isEditing: false,
              isRemoving: false,
              midTurnFailedAction: failedAction,
            });
          }
          reportError(
            new Error('Message is no longer in the mid-turn queue'),
            fallback,
          );
          return settledAtIdle;
        }
        const next = queuedPromptsRef.current.filter(
          (prompt) => prompt.id !== target.id,
        );
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
        return true;
      } catch (error) {
        if (!isCurrentOwnerTokenRef.current(ownerToken)) return false;
        const latest = queuedPromptsRef.current.find(
          (prompt) => prompt.id === target.id,
        );
        if (latest?.midTurnMessageId === target.midTurnMessageId) {
          if (canQueryMidTurn) {
            setQueuedPromptFlags(target.id, {
              isEditing: false,
              isRemoving: false,
            });
            if (target.sessionId) {
              await reconcileMidTurnMessages(target.sessionId);
            }
            reportError(error, fallback);
            return false;
          }
          const settledAtIdle = !latestSessionActiveRef.current;
          if (settledAtIdle) {
            const next = queuedPromptsRef.current.filter(
              (prompt) => prompt.id !== target.id,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
          } else {
            setQueuedPromptFlags(target.id, {
              isEditing: false,
              isRemoving: false,
              midTurnFailedAction: failedAction,
            });
          }
          reportError(error, fallback);
          return settledAtIdle;
        }
        return false;
      }
    },
    [
      canMutateMidTurn,
      canQueryMidTurn,
      reconcileMidTurnMessages,
      reportError,
      sessionActions,
      setQueuedPromptFlags,
    ],
  );

  const removeQueuedPrompt = useCallback(
    (id: number) => {
      const target = queuedPromptsRef.current.find((p) => p.id === id);
      if (target?.isInserting) return;
      if (
        target?.serverState === 'submitting' ||
        target?.midTurnState === 'submitting'
      )
        return;
      if (!target) return;
      if (target.midTurnState) {
        void removeMidTurnPromptForAction(
          target,
          { isRemoving: true },
          t('queue.deleteFailed'),
        );
        return;
      }
      if (!target.serverPromptId) {
        const next = queuedPromptsRef.current.filter(
          (prompt) => prompt.id !== id,
        );
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
        return;
      }
      void removeServerPromptForAction(
        target,
        { isRemoving: true },
        t('queue.deleteFailed'),
      );
    },
    [removeMidTurnPromptForAction, removeServerPromptForAction, t],
  );

  const insertQueuedPrompt = useCallback(
    async (id: number) => {
      const prompt = queuedPromptsRef.current.find((item) => item.id === id);
      if (
        !canMutateMidTurn ||
        !latestSessionActiveRef.current ||
        !prompt ||
        prompt.serverState !== undefined ||
        prompt.serverPromptId !== undefined ||
        prompt.midTurnState !== undefined ||
        prompt.isEditing ||
        prompt.isRemoving ||
        prompt.isInserting ||
        eventCannotReproducePayload(prompt) ||
        isCommandPrompt(prompt.text)
      ) {
        return;
      }

      const messageId = canQueryMidTurn
        ? `webui_${
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
          }`
        : undefined;
      const targetSessionId = prompt.sessionId ?? latestSessionIdRef.current;
      const promptOwnerKey = queueOwnerKey(
        latestWorkspaceCwdRef.current,
        targetSessionId,
      );
      // Both resolved at USE time, not capture time: an owner change while the
      // insert is in flight relocates the stash onto a new key without the row
      // ever leaving the session it was started from.
      const currentStashKey = () =>
        resolveStashKey(
          heldPromptsByOwnerRef.current,
          promptOwnerKey,
          targetSessionId,
        );
      // Compare the session half only — the workspace half resolving is not an
      // owner change for a row already pinned to `targetSessionId`.
      const insertOwnerMatches = () =>
        targetSessionId === undefined
          ? latestSessionIdRef.current === undefined
          : latestSessionIdRef.current === targetSessionId;
      const insertionOwnerToken = ownerTokenRef.current;
      const insertionGeneration =
        (explicitInsertGenerationsRef.current.get(prompt.id) ?? 0) + 1;
      explicitInsertGenerationsRef.current.set(prompt.id, insertionGeneration);
      const isCurrentInsertion = () =>
        explicitInsertGenerationsRef.current.get(prompt.id) ===
        insertionGeneration;
      const finishInsertion = () => {
        if (isCurrentInsertion()) {
          explicitInsertGenerationsRef.current.delete(prompt.id);
        }
      };
      const clearInsertionFlag = (
        flags: Partial<
          Pick<
            QueuedPrompt,
            'isInserting' | 'midTurnState' | 'midTurnMessageId' | 'serverState'
          >
        > = { isInserting: false },
      ) => {
        setQueuedPromptFlags(prompt.id, flags);
        const stashKey = currentStashKey();
        if (!stashKey) return;
        const stashed = heldPromptsByOwnerRef.current.get(stashKey);
        if (!stashed) return;
        heldPromptsByOwnerRef.current.set(
          stashKey,
          stashed.map((item) =>
            item.id === prompt.id ? { ...item, ...flags } : item,
          ),
        );
      };
      const dropInsertedPrompt = () => {
        const next = queuedPromptsRef.current.filter(
          (item) => item.id !== prompt.id,
        );
        if (next.length !== queuedPromptsRef.current.length) {
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
        }
        const stashKey = currentStashKey();
        if (!stashKey) return;
        const stashed = heldPromptsByOwnerRef.current.get(stashKey);
        if (!stashed) return;
        heldPromptsByOwnerRef.current.set(
          stashKey,
          stashed.filter((item) => item.id !== prompt.id),
        );
      };
      const recoverAfterSettledInsert = (
        flags: Partial<
          Pick<
            QueuedPrompt,
            'isInserting' | 'midTurnState' | 'midTurnMessageId' | 'serverState'
          >
        >,
        serverSaidIdle = false,
      ): boolean => {
        const submitAtIdle =
          isCurrentOwnerTokenRef.current(insertionOwnerToken) &&
          insertOwnerMatches() &&
          (serverSaidIdle || !latestSessionActiveRef.current) &&
          !writeBlockedRef.current &&
          !holdQueuedPromptsLocallyRef.current;
        const nextFlags = {
          ...flags,
          ...(submitAtIdle ? { serverState: 'submitting' as const } : {}),
        };
        clearInsertionFlag(nextFlags);
        finishInsertion();
        if (submitAtIdle) {
          const pendingPrompt = queuedPromptsRef.current.find(
            (item) => item.id === prompt.id,
          );
          if (pendingPrompt)
            submitPendingPrompt({
              ...pendingPrompt,
              resubmittedAfterIdleRejection: serverSaidIdle,
            });
        }
        return submitAtIdle;
      };
      setQueuedPromptFlags(prompt.id, {
        isInserting: true,
        isRemoving: false,
        ...(messageId ? { midTurnMessageId: messageId } : {}),
      });
      // Deliberately uncancellable: an explicit insert the user asked for
      // outlives an owner rotation and settles into the queue of the session it
      // was started from (pinned by the source-session stash tests), so it gets
      // no abort signal.
      let result: Awaited<
        ReturnType<typeof sessionActions.enqueueMidTurnMessage>
      >;
      try {
        result = await sessionActions.enqueueMidTurnMessage(prompt.text, {
          ...(messageId ? { messageId } : {}),
        });
      } catch (error) {
        if (!isCurrentInsertion()) return;
        if (messageId) {
          // The request was dispatched, so the daemon may already own this
          // message: its queue snapshot decides. A message the daemon reports
          // as waiting becomes a daemon-owned mid-turn row, one it reports as
          // settled or promoted has left the local queue, and anything it does
          // not know (or that it cannot be asked about) returns to the local
          // hold rather than being dropped.
          finishInsertion();
          const stillOwned =
            targetSessionId !== undefined && insertOwnerMatches();
          const snapshot = stillOwned
            ? await reconcileMidTurnMessages(targetSessionId).catch(
                () => undefined,
              )
            : undefined;
          if (
            snapshot?.messages.some(
              (message) => message.messageId === messageId,
            )
          ) {
            clearInsertionFlag({
              isInserting: false,
              midTurnState: 'queued',
              midTurnMessageId: messageId,
            });
            prompt.onAdmitted?.();
            return;
          }
          if (
            snapshot?.settledMessageIds.includes(messageId) ||
            snapshot?.promotedMessageIds.includes(messageId)
          ) {
            dropInsertedPrompt();
            prompt.onAdmitted?.();
            return;
          }
          clearInsertionFlag({
            isInserting: false,
            midTurnMessageId: undefined,
          });
          if (stillOwned) reportError(error, t('queue.insertFailed'));
          return;
        }
        recoverAfterSettledInsert({
          isInserting: false,
          midTurnMessageId: undefined,
        });
        if (insertOwnerMatches()) {
          reportError(error, t('queue.insertFailed'));
        }
        return;
      }
      if (!isCurrentInsertion()) return;
      if (!result.accepted) {
        const submitted = recoverAfterSettledInsert(
          {
            isInserting: false,
            midTurnMessageId: undefined,
          },
          result.reason === 'session_idle',
        );
        if (!submitted && insertOwnerMatches()) {
          reportError(
            new Error('Queued message was not accepted for insertion'),
            t('queue.insertFailed'),
          );
        }
        return;
      }

      const current = queuedPromptsRef.current;
      const index = current.findIndex((item) => item.id === prompt.id);
      const acceptedAtLegacyIdle =
        insertOwnerMatches() &&
        !latestSessionActiveRef.current &&
        !canQueryMidTurn;
      if (index === -1) {
        const stashKey = currentStashKey();
        if (stashKey) {
          const stashed = heldPromptsByOwnerRef.current.get(stashKey);
          if (stashed) {
            heldPromptsByOwnerRef.current.set(
              stashKey,
              acceptedAtLegacyIdle
                ? stashed.filter((item) => item.id !== prompt.id)
                : stashed.map((item) =>
                    item.id === prompt.id
                      ? {
                          ...item,
                          midTurnState: 'queued' as const,
                          midTurnMessageId: result.messageId ?? messageId,
                          isInserting: false,
                        }
                      : item,
                  ),
            );
          }
        }
        finishInsertion();
        prompt.onAdmitted?.();
        if (canQueryMidTurn && targetSessionId) {
          await reconcileMidTurnMessages(targetSessionId).catch((error) => {
            reportError(error, t('queue.insertFailed'));
          });
        }
        return;
      }
      if (acceptedAtLegacyIdle) {
        const next = current.filter((item) => item.id !== prompt.id);
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
        finishInsertion();
        prompt.onAdmitted?.();
        return;
      }
      if (!current[index]!.isInserting) {
        finishInsertion();
        return;
      }
      const next = [...current];
      next[index] = {
        ...current[index]!,
        serverPromptId: undefined,
        serverState: undefined,
        midTurnState: 'queued',
        midTurnMessageId: result.messageId ?? messageId,
        isInserting: false,
      };
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      finishInsertion();
      prompt.onAdmitted?.();

      if (canQueryMidTurn && targetSessionId) {
        await reconcileMidTurnMessages(targetSessionId).catch((error) => {
          reportError(error, t('queue.insertFailed'));
        });
      }
    },
    [
      canMutateMidTurn,
      canQueryMidTurn,
      reconcileMidTurnMessages,
      reportError,
      sessionActions,
      setQueuedPromptFlags,
      submitPendingPrompt,
      t,
    ],
  );

  const editQueuedPrompt = useCallback(
    async (id: number) => {
      const target = queuedPromptsRef.current.find((p) => p.id === id);
      if (!target || target.serverState === 'submitting') return;
      if (target.payloadCompleteness === 'summary-only') {
        return;
      }
      if (target.isEditing || target.isRemoving || target.isInserting) return;
      if (target.midTurnState) {
        const removed = await removeMidTurnPromptForAction(
          target,
          { isEditing: true },
          t('queue.editFailed'),
        );
        if (removed) {
          restoreQueuedPromptsToEditor([target]);
        }
        return;
      }
      if (target.serverPromptId) {
        const removed = await removeServerPromptForAction(
          target,
          { isEditing: true },
          t('queue.editFailed'),
        );
        if (!removed) return;
        restoreQueuedPromptsToEditor([target]);
        return;
      }
      const popped = popQueuedPromptForEdit(id);
      if (!popped) return;
      restoreQueuedPromptsToEditor([target], target.sessionId);
    },
    [
      popQueuedPromptForEdit,
      removeMidTurnPromptForAction,
      removeServerPromptForAction,
      restoreQueuedPromptsToEditor,
      t,
    ],
  );

  const editLastQueuedPrompt = useCallback((): boolean => {
    const current = queuedPromptsRef.current;
    if (current.length === 0) return false;
    const target = current[current.length - 1];
    if (!target) return false;
    if (
      target.serverState === 'submitting' ||
      target.midTurnState === 'submitting' ||
      (target.midTurnState === 'queued' && !target.midTurnMessageId) ||
      target.isEditing ||
      target.isRemoving ||
      target.isInserting ||
      target.payloadCompleteness === 'summary-only'
    ) {
      return true;
    }
    if (target.midTurnState === 'queued') {
      void editQueuedPrompt(target.id);
      return true;
    }
    if (!target.serverPromptId) {
      const popped = popQueuedPromptForEdit(target.id);
      if (!popped) return false;
      restoreQueuedPromptsToEditor([target], target.sessionId);
      return true;
    }
    if (target.serverState !== 'queued') return false;
    void (async () => {
      const removed = await removeServerPromptForAction(
        target,
        { isEditing: true },
        t('queue.editFailed'),
      );
      if (removed) {
        restoreQueuedPromptsToEditor([target]);
      }
    })().catch((error: unknown) => {
      reportError(error, t('queue.editFailed'));
    });
    return true;
  }, [
    popQueuedPromptForEdit,
    editQueuedPrompt,
    removeServerPromptForAction,
    reportError,
    restoreQueuedPromptsToEditor,
    t,
  ]);

  const clearQueuedPrompts = useCallback((): boolean => {
    if (queuedPromptsRef.current.length === 0) return false;
    const clearOwnerToken = ownerTokenRef.current;
    const clearSessionId = latestSessionIdRef.current;
    const removingPromptIds = removingServerPromptIdsRef.current;
    const midTurnPrompts = queuedPromptsRef.current.filter(
      (prompt) => prompt.midTurnState !== undefined,
    );
    const submittingPrompts = queuedPromptsRef.current.filter(
      (prompt) =>
        prompt.midTurnState === undefined &&
        prompt.serverState === 'submitting',
    );
    const clearablePrompts = queuedPromptsRef.current.filter(
      (prompt) =>
        prompt.midTurnState === undefined &&
        prompt.serverState !== 'submitting' &&
        !prompt.isInserting,
    );
    if (submittingPrompts.length > 0) {
      const submittingIds = new Set(
        submittingPrompts.map((prompt) => prompt.id),
      );
      let handedOffClear = false;
      // A row whose submit body already returned unbound carries a daemon
      // id this clear path would otherwise lose — the row has no
      // serverPromptId to DELETE. Hand the id to the deferred clear so the
      // next snapshot that still lists it queued cancels the message the
      // user just cleared. The returned-unbound record itself must survive:
      // the settle-time echo exemption still needs it, and its own cleanup
      // (the settle, or the size bound) owns the delete.
      for (const prompt of submittingPrompts) {
        for (const [promptId, rowId] of returnedUnboundPromptIdsRef.current) {
          if (rowId === prompt.id) {
            clearedUnconfirmedPromptIdsRef.current.add(promptId);
            handedOffClear = true;
            break;
          }
        }
      }
      const remaining = queuedPromptsRef.current.filter(
        (prompt) => !submittingIds.has(prompt.id),
      );
      queuedPromptsRef.current = remaining;
      setQueuedPrompts(remaining);
      // The deferred clear only runs inside a snapshot pass, and nothing else
      // on this path requests one — a quiet session would leave the recorded
      // cancellation unattempted until the daemon promotes the very message
      // the user cleared. Ask for the evidence the handoff depends on. The
      // pass cannot resurrect the row: the loop marks the id as being removed
      // before it DELETEs, and the sync skips every marked id.
      if (handedOffClear) void refreshPendingPrompts(clearSessionId);
    }
    for (const controller of submitAbortControllersRef.current) {
      controller.abort();
    }
    const serverPrompts = clearablePrompts.filter(
      (prompt) => prompt.serverPromptId,
    );
    if (serverPrompts.length === 0) {
      const retainedIds = new Set(midTurnPrompts.map((prompt) => prompt.id));
      const retained = queuedPromptsRef.current.filter(
        (prompt) => retainedIds.has(prompt.id) || prompt.isInserting,
      );
      queuedPromptsRef.current = retained;
      setQueuedPrompts(retained);
      if (clearablePrompts.length > 0) {
        store.dispatch([{ type: 'status', text: t('queue.cleared') }]);
      }
      return submittingPrompts.length > 0 || clearablePrompts.length > 0;
    }

    const clearIds = new Set(clearablePrompts.map((prompt) => prompt.id));
    const serverPromptIds = new Set(
      serverPrompts
        .map((prompt) => prompt.serverPromptId)
        .filter((id): id is string => Boolean(id)),
    );
    for (const promptId of serverPromptIds) {
      removingPromptIds.add(promptId);
    }

    const removingQueue = queuedPromptsRef.current
      .filter((prompt) => !clearIds.has(prompt.id))
      .concat(serverPrompts.map((prompt) => ({ ...prompt, isRemoving: true })));
    queuedPromptsRef.current = removingQueue;
    setQueuedPrompts(removingQueue);

    void (async () => {
      const failedPrompts: QueuedPrompt[] = [];
      await Promise.all(
        serverPrompts.map(async (prompt) => {
          const promptId = prompt.serverPromptId!;
          try {
            const result = await sessionActions.removePendingPrompt(promptId, {
              sessionId: prompt.sessionId,
            });
            if (result.removed) {
              completionCallbacksRef.current.delete(promptId);
              pendingEchoByPromptIdRef.current.delete(promptId);
              startedDuringRemovalRef.current.delete(promptId);
              return;
            }
            failedPrompts.push(prompt);
          } catch {
            failedPrompts.push(prompt);
          } finally {
            removingPromptIds.delete(promptId);
          }
        }),
      );

      if (
        !isCurrentOwnerTokenRef.current(clearOwnerToken) ||
        latestSessionIdRef.current !== clearSessionId
      ) {
        return;
      }
      const restoredPrompts = failedPrompts.map((prompt) => ({
        ...prompt,
        isRemoving: false,
      }));
      const next = queuedPromptsRef.current
        .filter((prompt) => {
          if (prompt.serverPromptId) {
            return !serverPromptIds.has(prompt.serverPromptId);
          }
          return !clearIds.has(prompt.id);
        })
        .concat(restoredPrompts);
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);

      if (failedPrompts.length > 0) {
        reportError(
          new Error('Some prompts could not be removed from queue'),
          t('queue.deleteFailed'),
        );
        void refreshPendingPrompts(failedPrompts[0]?.sessionId);
        return;
      }
      store.dispatch([{ type: 'status', text: t('queue.cleared') }]);
    })();
    return true;
  }, [refreshPendingPrompts, reportError, store, t, sessionActions]);

  return {
    queuedPrompts: visibleQueuedPrompts,
    queuedTexts,
    enqueuePrompt,
    removeQueuedPrompt,
    insertQueuedPrompt,
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
  };
}
