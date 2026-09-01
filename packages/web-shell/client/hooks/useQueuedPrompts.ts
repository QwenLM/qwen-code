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
  | 'refreshed'
  | 'skipped'
  | 'superseded'
  | 'failed';

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
  /** Stale-response fence for `getMidTurnMessages` reconciliation calls. */
  const midTurnReconcileSeqRef = useRef(0);
  const restoredPromptIdsRef = useRef<Set<number>>(new Set());
  const pendingStartedByPromptIdRef = useRef<Map<string, string>>(new Map());

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
        prompt.serverPromptId !== promptId &&
        prompt.midTurnMessageId !== promptId,
    );
    if (next.length === queuedPromptsRef.current.length) return;
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);

  const hideSettledServerPrompt = useCallback(
    (promptId: string) => {
      displayedServerPromptIdsRef.current.delete(promptId);
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
    [removeDaemonOwnedPrompt],
  );

  latestSessionIdRef.current = sessionId;
  latestWorkspaceCwdRef.current = workspaceCwd;
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
      completionCallbacksRef.current.set(promptId, onComplete);
    },
    [],
  );

  const syncServerQueuedPrompts = useCallback(
    (serverQueued: DaemonPendingPromptSummary[], targetSessionId: string) => {
      const next = queuedPromptsRef.current.filter((p) => {
        const promptId = p.serverPromptId ?? p.midTurnMessageId;
        if (promptId && settledServerPromptIdsRef.current.has(promptId)) {
          return false;
        }
        if (!p.serverPromptId) return true;
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
          if (hasDisplayedPrompt) {
            next.splice(existingIndex, 1);
            continue;
          }
          next[existingIndex] = {
            ...next[existingIndex]!,
            ...(next[existingIndex]!.payloadCompleteness === 'summary-only'
              ? { text: serverPrompt.text }
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
        const submittingMatches = next.filter(
          (p) =>
            !p.serverPromptId &&
            p.serverState === 'submitting' &&
            (p.images?.length ?? 0) === 0 &&
            (p.files?.length ?? 0) === 0 &&
            p.text === serverPrompt.text,
        );
        if (submittingMatches.length === 1) {
          const submittingIndex = next.indexOf(submittingMatches[0]!);
          if (hasDisplayedPrompt) {
            next.splice(submittingIndex, 1);
            continue;
          }
          next[submittingIndex] = {
            ...submittingMatches[0]!,
            serverPromptId: serverPrompt.promptId,
            serverState: serverPrompt.state,
          };
          continue;
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
        if (hasUnboundAttachmentSubmission) continue;
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

  const refreshPendingPrompts = useCallback(
    async (
      targetSessionId = sessionId,
    ): Promise<RefreshPendingPromptsResult> => {
      if (!connected || !targetSessionId) return 'skipped';
      if (latestSessionIdRef.current !== targetSessionId) return 'skipped';
      const ownerToken = ownerTokenRef.current;
      const requestSeq = ++refreshRequestSeqRef.current;
      try {
        const result = await sessionActions.getPendingPrompts({
          sessionId: targetSessionId,
        });
        if (requestSeq !== refreshRequestSeqRef.current) return 'superseded';
        if (
          !isCurrentOwnerTokenRef.current(ownerToken) ||
          latestSessionIdRef.current !== targetSessionId
        ) {
          return 'skipped';
        }
        syncServerQueuedPrompts(
          result.pendingPrompts.filter(
            (p) => p.state === 'queued' || p.state === 'running',
          ),
          targetSessionId,
        );
        return 'refreshed';
      } catch (error) {
        console.warn('Failed to refresh pending prompts', error);
        return 'failed';
      }
    },
    [connected, sessionActions, sessionId, syncServerQueuedPrompts],
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
      const pendingResult = await refreshPendingPrompts(targetSessionId);
      if (!isCurrent()) return undefined;
      const waitingIds = applyMidTurnSnapshot(
        snapshot,
        targetSessionId,
        pendingResult === 'refreshed',
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
    initialRefreshSessionIdRef.current = undefined;
    midTurnEnqueueAbortRef.current?.abort();
    midTurnEnqueueAbortRef.current = null;
  }, [ownerToken, sessionId, workspaceCwd]);

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
      store.appendLocalUserMessage(
        prompt.text,
        toStoreImages(prompt.images),
        prompt.inputAnnotations?.length
          ? { inputAnnotations: prompt.inputAnnotations }
          : undefined,
        toStoreFiles(prompt.files),
      );
    },
    [store],
  );

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
          const prompt =
            queuedPromptsRef.current.find(
              (item) => item.serverPromptId === promptId,
            ) ??
            queuedPromptsRef.current.find(
              (item) => item.midTurnMessageId === promptId,
            ) ??
            pendingMidTurnPrompt ??
            queuedPromptsRef.current.find(
              (item) =>
                !item.serverPromptId &&
                item.serverState === 'submitting' &&
                (item.images?.length ?? 0) === 0 &&
                (item.files?.length ?? 0) === 0 &&
                item.text === eventText,
            );
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
            store.appendLocalUserMessage(eventText, undefined, undefined);
          }
          if (!prompt?.serverPromptId) {
            pendingStartedByPromptIdRef.current.set(promptId, eventText);
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
        removeDaemonOwnedPrompt(promptId);
        void refreshPendingPrompts();
      } else if (event.type === 'turn_complete') {
        hideSettledServerPrompt(promptId);
        const callback = completionCallbacksRef.current.get(promptId);
        completionCallbacksRef.current.delete(promptId);
        if (callback) {
          callback();
        } else if (
          event.data.stopReason !== 'cancelled' ||
          pendingStartedByPromptIdRef.current.has(promptId)
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
   * keep the daemon's queue in the order the user typed them.
   */
  const submitPendingPrompt = useCallback(
    (prompt: QueuedPrompt): Promise<void> => {
      const { id: localId, sessionId: targetSessionId } = prompt;
      const ownerToken = ownerTokenRef.current;
      const submitAbort = new AbortController();
      submitAbortControllersRef.current.add(submitAbort);
      let admissionStarted = false;

      return sessionActions
        .submitPrompt(prompt.text, {
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
        .then((result) => {
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
          if (!latestSessionActiveRef.current) {
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
            sessionActions
              .removePendingPrompt(result.promptId, {
                sessionId: targetSessionId,
              })
              .then(
                (removeResult) => {
                  if (!removeResult.removed)
                    void refreshPendingPrompts(targetSessionId);
                },
                () => {
                  void refreshPendingPrompts(targetSessionId);
                },
              );
            return;
          }
          const updated = [...current];
          const localPrompt = updated[idx]!;
          updated[idx] = {
            ...localPrompt,
            serverPromptId: result.promptId,
            serverState: 'queued',
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
          if (!queuedPromptsRef.current.some((p) => p.id === localId)) return;
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
                (prompt) => prompt.midTurnMessageId !== midTurnMessageId,
              );
              // The daemon rejected the insert outright, so nothing of it is
              // queued server-side. If the turn has meanwhile ended, send the
              // message through the ordinary path (or hold it while a Goal
              // runs) instead of dropping it.
              if (
                targetIsCurrent() &&
                latestRawStreamingStateRef.current === 'idle'
              ) {
                const shouldHold =
                  holdQueuedPromptsLocallyRef.current ||
                  writeBlockedRef.current;
                const prompt: QueuedPrompt = {
                  ...restoreAdmission,
                  midTurnState: undefined,
                  midTurnMessageId: undefined,
                  ...(shouldHold ? {} : { serverState: 'submitting' as const }),
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
        const refreshResult = await refreshPendingPrompts(targetSessionId);
        if (!isCurrentOwnerTokenRef.current(ownerToken)) return true;
        if (refreshResult === 'failed') {
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
        if (refreshResult !== 'refreshed') {
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
        (prompt.images?.length ?? 0) > 0 ||
        (prompt.files?.length ?? 0) > 0 ||
        (prompt.inputAnnotations?.length ?? 0) > 0 ||
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
      ): boolean => {
        const submitAtIdle =
          isCurrentOwnerTokenRef.current(insertionOwnerToken) &&
          insertOwnerMatches() &&
          !latestSessionActiveRef.current &&
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
          if (pendingPrompt) submitPendingPrompt(pendingPrompt);
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
        const submitted = recoverAfterSettledInsert({
          isInserting: false,
          midTurnMessageId: undefined,
        });
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
      const remaining = queuedPromptsRef.current.filter(
        (prompt) => !submittingIds.has(prompt.id),
      );
      queuedPromptsRef.current = remaining;
      setQueuedPrompts(remaining);
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
