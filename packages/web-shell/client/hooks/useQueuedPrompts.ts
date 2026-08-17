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
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonInputAnnotation,
  DaemonMidTurnMessagesResult,
  DaemonPendingPromptSummary,
  DaemonSessionMediaReference,
  DaemonTranscriptStore,
  PromptContentBlock,
} from '@qwen-code/sdk/daemon';
import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import type { EditorHandle } from './useComposerCore';
import { removeInjectedFromQueue } from '../midTurnDedup';
import { isCommandPrompt } from '../utils/localCommandQueue';
import { isDefinitelyRejectedPromptAdmission } from '../utils/promptAdmission';
import type { getTranslator } from '../i18n';
import type { QueuedPrompt } from '../components/QueuedPromptDisplay';

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
   * Whether the daemon advertises `session_media`. With it,
   * images attached to a mid-turn send travel with the message and are
   * injected into the running turn; without it they stay queued for the next
   * turn (an older daemon would silently drop them).
   */
  canInjectMidTurnMedia: boolean;
  streamingState: DaemonStreamingState;
  sessionActions: DaemonSessionActions;
  store: DaemonTranscriptStore;
  editorRef: RefBox<EditorHandle | null>;
  reportError: (error: unknown, fallback: string) => void;
  t: ReturnType<typeof getTranslator>;
}

const MAX_COMPLETED_PROMPT_IDS = 100;

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
      prompt.isEditing === other.isEditing &&
      prompt.isRemoving === other.isRemoving &&
      prompt.payloadCompleteness === other.payloadCompleteness &&
      prompt.admissionOutcome === other.admissionOutcome &&
      prompt.payloadAvailable === other.payloadAvailable &&
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

// The SDK substitutes this text block for a media reference it could not
// hydrate (DaemonSessionClient.hydrateBlock); keep in sync with the SDK.
const MEDIA_UNAVAILABLE_PLACEHOLDER = '[Attached media is no longer available]';

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
    return record['type'] === 'image' && typeof record['data'] !== 'string';
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
  editQueuedPrompt: (id: number) => Promise<void>;
  editLastQueuedPrompt: () => boolean;
  clearQueuedPrompts: () => boolean;
  restoreUnknownQueuedPrompt: (id: number) => boolean;
  discardUnknownQueuedPrompt: (id: number) => boolean;
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
  streamingState,
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
  const nextQueuedPromptIdRef = useRef(1);
  const latestSessionIdRef = useRef(sessionId);
  const latestWorkspaceCwdRef = useRef(workspaceCwd);
  const midTurnEnqueueAbortRef = useRef<AbortController | null>(null);
  const submitAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const removingServerPromptIdsRef = useRef<Set<string>>(new Set());
  const displayedServerPromptIdsRef = useRef<Set<string>>(new Set());
  const completionCallbacksRef = useRef<Map<string, () => void>>(new Map());
  const completedPromptIdsRef = useRef<Set<string>>(new Set());
  const completedPromptIdOrderRef = useRef<string[]>([]);
  const pendingMidTurnAdmissionsRef = useRef<
    Map<string, { prompt: QueuedPrompt; workspaceCwd?: string }>
  >(new Map());
  const appendedBeforeResponsePromptIdsRef = useRef<Set<string>>(new Set());
  const removedBeforeResponsePromptIdsRef = useRef<Set<string>>(new Set());
  const latestStreamingStateRef = useRef(streamingState);
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

  latestSessionIdRef.current = sessionId;
  latestWorkspaceCwdRef.current = workspaceCwd;
  const streamingIdle = streamingState === 'idle';
  useLayoutEffect(() => {
    midTurnReconcileSeqRef.current += 1;
  }, [streamingIdle]);
  latestStreamingStateRef.current = streamingState;

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
        if (!p.serverPromptId) return true;
        return serverQueued.some(
          (server) => server.promptId === p.serverPromptId,
        );
      });
      for (const serverPrompt of serverQueued) {
        if (removingServerPromptIdsRef.current.has(serverPrompt.promptId)) {
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
        // Extract images from the server prompt's content field (if present)
        const serverImages = contentToImages(serverPrompt.content);
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
            ...(serverImages &&
            contentFullyHydrated &&
            !next[existingIndex]!.images
              ? { images: serverImages, payloadCompleteness: undefined }
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
            p.admissionOutcome !== 'unknown' &&
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
            prompt.admissionOutcome !== 'unknown' &&
            ((prompt.images?.length ?? 0) > 0 ||
              (prompt.files?.length ?? 0) > 0),
        );
        if (hasUnboundAttachmentSubmission) continue;
        next.push({
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: serverPrompt.text,
          ...(serverImages && contentFullyHydrated
            ? { images: serverImages }
            : {}),
          serverPromptId: serverPrompt.promptId,
          serverState: serverPrompt.state,
          // A row rebuilt with fully hydrated images is payload-complete;
          // pinning it to summary-only would disable editing until the user
          // deletes (and loses) the attachments. A partially hydrated
          // payload stays summary-only so editing cannot silently discard
          // the attachments the daemon still holds — a later fully hydrated
          // refresh upgrades the row.
          payloadCompleteness:
            serverImages && contentFullyHydrated ? undefined : 'summary-only',
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
        pendingMidTurnAdmissionsRef.current.delete(messageId);
      }
      const waitingIds = new Set(
        snapshot.messages.map((message) => message.messageId),
      );
      const current = queuedPromptsRef.current;
      let next = current.filter(
        (prompt) =>
          !(
            (prompt.midTurnState !== undefined ||
              prompt.admissionOutcome === 'unknown') &&
            prompt.midTurnMessageId !== undefined &&
            !prompt.isEditing &&
            !prompt.isRemoving &&
            (settledIds.has(prompt.midTurnMessageId) ||
              (applyPromoted && promotedIds.has(prompt.midTurnMessageId)))
          ),
      );
      next = next.map((prompt) =>
        prompt.admissionOutcome === 'unknown' &&
        prompt.midTurnMessageId !== undefined &&
        waitingIds.has(prompt.midTurnMessageId)
          ? {
              ...prompt,
              midTurnState: 'queued',
              admissionOutcome: undefined,
              payloadAvailable: undefined,
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
        if (!hydrated) return prompt;
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
        if (localIds.has(message.messageId)) continue;
        // Prefer the in-memory admission's images; after a refresh only the
        // snapshot's media blocks remain.
        const salvaged = salvagedImages.get(message.messageId);
        const images = salvaged ?? contentToImages(message.content);
        restoredRows.push({
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: message.text,
          ...(images ? { images } : {}),
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
      const snapshot = await sessionActions.getMidTurnMessages({
        signal: opts?.signal,
      });
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
      allowUnknown = false,
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
          (allowUnknown || prompt.admissionOutcome !== 'unknown') &&
          prompt.payloadAvailable !== false &&
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
        prompt.midTurnState === 'submitting' ||
        prompt.midTurnFailedAction === 'edit',
    );
    if (interruptedPrompts.length > 0) {
      restoreQueuedPromptsToEditorRef.current(interruptedPrompts);
    }
    queuedPromptsOwnerRef.current = ownerToken;
    const retainedPrompts = retainedAdmissions.map(([, entry]) => entry.prompt);
    queuedPromptsRef.current = retainedPrompts;
    setQueuedPrompts(retainedPrompts);
    completionCallbacksRef.current = retainedCompletionCallbacks;
    completedPromptIdsRef.current = new Set();
    completedPromptIdOrderRef.current = [];
    appendedBeforeResponsePromptIdsRef.current = new Set();
    removedBeforeResponsePromptIdsRef.current = new Set();
    for (const controller of submitAbortControllersRef.current) {
      controller.abort();
    }
    submitAbortControllersRef.current.clear();
    removingServerPromptIdsRef.current = new Set();
    displayedServerPromptIdsRef.current = new Set();
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
      if (streamingState === 'idle' && !canQueryMidTurn) return;
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
    streamingState,
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
            queuedPromptsRef.current.find(
              (item) =>
                !item.serverPromptId &&
                item.serverState === 'submitting' &&
                item.admissionOutcome !== 'unknown' &&
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
        void refreshPendingPrompts();
      } else if (event.type === 'turn_complete') {
        displayedServerPromptIdsRef.current.delete(promptId);
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
        displayedServerPromptIdsRef.current.delete(promptId);
        const callback = completionCallbacksRef.current.get(promptId);
        completionCallbacksRef.current.delete(promptId);
        if (callback) callback();
        else rememberCompletedPromptId(promptId);
      } else if (
        event.type === 'pending_prompt_completed' &&
        event.data.state === 'removed'
      ) {
        displayedServerPromptIdsRef.current.delete(promptId);
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
  ]);

  const submitPendingPrompt = useCallback(
    (prompt: QueuedPrompt) => {
      const { id: localId, sessionId: targetSessionId } = prompt;
      const ownerToken = ownerTokenRef.current;
      const submitAbort = new AbortController();
      submitAbortControllersRef.current.add(submitAbort);

      sessionActions
        .submitPrompt(prompt.text, {
          images: prompt.images,
          files: prompt.files,
          inputAnnotations: prompt.inputAnnotations,
          optimisticUserMessage: false,
          sessionId: targetSessionId,
          signal: submitAbort.signal,
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
          if (latestStreamingStateRef.current === 'idle') {
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
            if (
              (prompt.images?.length ?? 0) > 0 ||
              (prompt.files?.length ?? 0) > 0
            ) {
              void refreshPendingPrompts(targetSessionId);
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
            admissionOutcome: undefined,
            payloadAvailable: undefined,
            ...(localPrompt.payloadAvailable === false
              ? { payloadCompleteness: 'summary-only' }
              : {}),
          };
          queuedPromptsRef.current = updated;
          setQueuedPrompts(updated);
          if (prompt.onComplete) {
            settleCompletionCallback(result.promptId, prompt.onComplete);
          }
          if (
            (prompt.images?.length ?? 0) > 0 ||
            (prompt.files?.length ?? 0) > 0
          ) {
            void refreshPendingPrompts(targetSessionId);
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
          const definitelyRejected = isDefinitelyRejectedPromptAdmission(error);
          if (!definitelyRejected) {
            const uncertain = queuedPromptsRef.current.map((item) =>
              item.id === localId
                ? {
                    ...item,
                    serverState: undefined,
                    admissionOutcome: 'unknown' as const,
                    payloadAvailable: true,
                  }
                : item,
            );
            queuedPromptsRef.current = uncertain;
            setQueuedPrompts(uncertain);
            void refreshPendingPrompts(targetSessionId);
            reportError(error, t('queue.admissionUnknown'));
            return;
          }
          const next = queuedPromptsRef.current.filter(
            (prompt) => prompt.id !== localId,
          );
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
          restoreQueuedPromptsToEditor([prompt], targetSessionId);
          reportError(error, t('queue.queueFailed'));
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

  const fallbackToPendingPrompt = useCallback(
    (id: number) => {
      if (writeBlockedRef.current) return;
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
        serverState: 'submitting',
        isEditing: false,
        isRemoving: false,
      };
      const next = [...current];
      next[index] = prompt;
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      submitPendingPrompt(prompt);
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
      const shouldInsertMidTurn =
        latestStreamingStateRef.current !== 'idle' &&
        (files?.length ?? 0) === 0 &&
        (imageList.length === 0 || canSendMidTurnMedia) &&
        (inputAnnotations?.length ?? 0) === 0 &&
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

      if (shouldInsertMidTurn && canQueryMidTurn && midTurnMessageId) {
        const pendingAdmission: QueuedPrompt = {
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: trimmed,
          ...(imageList.length > 0 ? { images: [...imageList] } : {}),
          midTurnMessageId,
          admissionOutcome: 'unknown',
          payloadCompleteness: 'complete',
          payloadAvailable: true,
        };
        pendingMidTurnAdmissionsRef.current.set(midTurnMessageId, {
          prompt: pendingAdmission,
          workspaceCwd: targetWorkspaceCwd,
        });
        if (imageList.length > 0) {
          queuedPromptsRef.current = [
            ...queuedPromptsRef.current,
            { ...pendingAdmission, midTurnState: 'submitting' },
          ];
          setQueuedPrompts(queuedPromptsRef.current);
        }
        if (onComplete) {
          settleCompletionCallback(midTurnMessageId, onComplete);
        }
        const abort = midTurnEnqueueAbortRef.current ?? new AbortController();
        midTurnEnqueueAbortRef.current = abort;
        let enqueueStarted = false;
        let uploadedMediaReferences: DaemonSessionMediaReference[] = [];
        const removeUploadedMedia = async () => {
          if (!targetSessionId) return;
          await Promise.allSettled(
            uploadedMediaReferences.map(
              async (reference) =>
                await sessionActions.removeMedia(reference.mediaId, {
                  sessionId: targetSessionId,
                }),
            ),
          );
        };
        void Promise.allSettled(
          imageList.map(
            async (image) =>
              await sessionActions.uploadMedia(
                {
                  data: image.data,
                  mimeType: image.media_type,
                },
                { signal: abort.signal },
              ),
          ),
        )
          .then(async (results) => {
            uploadedMediaReferences = results.flatMap((result) =>
              result.status === 'fulfilled' ? [result.value] : [],
            );
            const failure = results.find(
              (result): result is PromiseRejectedResult =>
                result.status === 'rejected',
            );
            if (failure) {
              await removeUploadedMedia();
              throw failure.reason;
            }
            if (
              abort.signal.aborted ||
              latestSessionIdRef.current !== targetSessionId ||
              latestWorkspaceCwdRef.current !== targetWorkspaceCwd
            ) {
              await removeUploadedMedia();
              throw new DOMException('Session changed', 'AbortError');
            }
            enqueueStarted = true;
            return await sessionActions.enqueueMidTurnMessage(trimmed, {
              signal: abort.signal,
              messageId: midTurnMessageId,
              ...(uploadedMediaReferences.length > 0
                ? { content: uploadedMediaReferences }
                : {}),
            });
          })
          .then(async (result) => {
            if (!result.accepted) {
              await removeUploadedMedia();
              completionCallbacksRef.current.delete(midTurnMessageId);
              const pendingAdmissionStillOwned =
                pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
              if (
                latestSessionIdRef.current !== targetSessionId ||
                latestWorkspaceCwdRef.current !== targetWorkspaceCwd
              ) {
                if (pendingAdmissionStillOwned) {
                  restoreQueuedPromptsToEditor(
                    [pendingAdmission],
                    undefined,
                    true,
                  );
                  reportError(
                    new Error('Daemon rejected mid-turn message'),
                    t('queue.queueFailed'),
                  );
                }
                return;
              }
              if (!pendingAdmissionStillOwned) return;
              const next = queuedPromptsRef.current.filter(
                (prompt) => prompt.midTurnMessageId !== midTurnMessageId,
              );
              queuedPromptsRef.current = next;
              setQueuedPrompts(next);
              restoreQueuedPromptsToEditor(
                [pendingAdmission],
                targetSessionId,
                true,
              );
              reportError(
                new Error('Daemon rejected mid-turn message'),
                t('queue.queueFailed'),
              );
              return;
            }
            if (
              latestSessionIdRef.current === targetSessionId &&
              latestWorkspaceCwdRef.current === targetWorkspaceCwd &&
              targetSessionId
            ) {
              await reconcileMidTurnMessages(targetSessionId);
            }
            // Do NOT delete the pending admission here. `applyMidTurnSnapshot`
            // deletes it atomically with salvaging its images; deleting early
            // opens a race where a concurrent (e.g. streaming-driven) reconcile
            // applies after this delete and rebuilds the row without the images.
          })
          .catch(async (error: unknown) => {
            if (
              latestSessionIdRef.current !== targetSessionId ||
              latestWorkspaceCwdRef.current !== targetWorkspaceCwd ||
              !targetSessionId
            ) {
              completionCallbacksRef.current.delete(midTurnMessageId);
              const pendingAdmissionStillOwned =
                pendingMidTurnAdmissionsRef.current.delete(midTurnMessageId);
              if (!enqueueStarted) {
                // Nothing reached the daemon, so the draft is still ours to
                // return: restore it to the current editor instead of
                // leaking it across the session switch.
                if (pendingAdmissionStillOwned) {
                  restoreQueuedPromptsToEditor(
                    [pendingAdmission],
                    undefined,
                    true,
                  );
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
              restoreQueuedPromptsToEditor(
                [pendingAdmission],
                targetSessionId,
                true,
              );
              reportError(error, t('queue.queueFailed'));
              return;
            }
            const snapshot = await reconcileMidTurnMessages(targetSessionId);
            if (!snapshot) {
              if (!pendingMidTurnAdmissionsRef.current.has(midTurnMessageId)) {
                return;
              }
              if (
                !queuedPromptsRef.current.some(
                  (prompt) =>
                    prompt.midTurnMessageId === midTurnMessageId ||
                    prompt.serverPromptId === midTurnMessageId,
                )
              ) {
                const next = [
                  ...queuedPromptsRef.current,
                  {
                    id: nextQueuedPromptIdRef.current++,
                    sessionId: targetSessionId,
                    text: trimmed,
                    // Keep the images so resolving this unknown row restores
                    // the full payload, not just the text.
                    ...(imageList.length > 0 ? { images: [...imageList] } : {}),
                    midTurnMessageId,
                    admissionOutcome: 'unknown' as const,
                    payloadCompleteness: 'complete' as const,
                    payloadAvailable: true,
                  },
                ];
                queuedPromptsRef.current = next;
                setQueuedPrompts(next);
              }
              reportError(error, t('queue.admissionUnknown'));
              return;
            }
            const known =
              snapshot.messages.some(
                (message) => message.messageId === midTurnMessageId,
              ) ||
              snapshot.settledMessageIds.includes(midTurnMessageId) ||
              snapshot.promotedMessageIds.includes(midTurnMessageId);
            if (known) return;
            if (!pendingMidTurnAdmissionsRef.current.has(midTurnMessageId)) {
              return;
            }
            const next = queuedPromptsRef.current.map((prompt) =>
              prompt.midTurnMessageId === midTurnMessageId
                ? {
                    ...prompt,
                    midTurnState: undefined,
                    admissionOutcome: 'unknown' as const,
                  }
                : prompt,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            reportError(error, t('queue.admissionUnknown'));
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
        ...(shouldInsertMidTurn
          ? {
              midTurnState: 'submitting',
            }
          : { serverState: 'submitting' }),
      };
      queuedPromptsRef.current = [...queuedPromptsRef.current, prompt];
      setQueuedPrompts(queuedPromptsRef.current);

      if (!shouldInsertMidTurn) {
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
          if (!result.accepted || latestStreamingStateRef.current === 'idle') {
            fallbackToPendingPrompt(prompt.id);
            return;
          }
          prompt.onAdmitted?.();
          const next = [...current];
          next[index] = {
            ...current[index]!,
            midTurnState: 'queued',
            midTurnMessageId: result.messageId,
          };
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
        })
        .catch(() => {});
      return true;
    },
    [
      canInjectMidTurnMedia,
      canQueryMidTurn,
      fallbackToPendingPrompt,
      reconcileMidTurnMessages,
      reportError,
      restoreQueuedPromptsToEditor,
      sessionActions,
      settleCompletionCallback,
      submitPendingPrompt,
      t,
    ],
  );

  const { batches: midTurnInjectedBatches, consume: consumeMidTurnInjected } =
    useDaemonMidTurnInjected();
  // Keep injection echoes ahead of idle handling for legacy daemons, whose
  // local rows still fall back to the ordinary queue at the turn boundary.
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
    if (streamingState !== 'idle' || writeBlocked) return;
    const ctrl = midTurnEnqueueAbortRef.current;
    if (ctrl && !canQueryMidTurn) {
      ctrl.abort();
      midTurnEnqueueAbortRef.current = null;
    }
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
    if (!canQueryMidTurn) {
      for (const prompt of queuedPromptsRef.current) {
        if (
          prompt.midTurnState &&
          !prompt.midTurnFailedAction &&
          !prompt.isEditing &&
          !prompt.isRemoving
        ) {
          fallbackToPendingPrompt(prompt.id);
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
    streamingState,
    writeBlocked,
    canQueryMidTurn,
    fallbackToPendingPrompt,
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
        Pick<QueuedPrompt, 'isEditing' | 'isRemoving' | 'midTurnFailedAction'>
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
          const settledAtIdle = latestStreamingStateRef.current === 'idle';
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
        const next = current.filter((prompt) => prompt.id !== target.id);
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
          const settledAtIdle = latestStreamingStateRef.current === 'idle';
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
      if (target?.admissionOutcome === 'unknown') return;
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

  const resolveUnknownQueuedPrompt = useCallback(
    (id: number, restore: boolean): boolean => {
      const ownerToken = ownerTokenRef.current;
      const target = queuedPromptsRef.current.find(
        (prompt) => prompt.id === id,
      );
      if (
        !target ||
        target.admissionOutcome !== 'unknown' ||
        target.payloadCompleteness === 'summary-only' ||
        target.payloadAvailable === false ||
        target.sessionId !== latestSessionIdRef.current
      ) {
        return false;
      }
      if (
        restore &&
        !restoreQueuedPromptsToEditor([target], target.sessionId, true)
      ) {
        return false;
      }
      if (!isCurrentOwnerTokenRef.current(ownerToken)) return false;
      if (target.midTurnMessageId) {
        completionCallbacksRef.current.delete(target.midTurnMessageId);
        pendingMidTurnAdmissionsRef.current.delete(target.midTurnMessageId);
      }
      const next = queuedPromptsRef.current.map((prompt) =>
        prompt.id === id
          ? {
              ...prompt,
              text: '',
              images: undefined,
              files: undefined,
              inputAnnotations: undefined,
              onComplete: undefined,
              payloadAvailable: false,
            }
          : prompt,
      );
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      return true;
    },
    [restoreQueuedPromptsToEditor],
  );

  const restoreUnknownQueuedPrompt = useCallback(
    (id: number) => resolveUnknownQueuedPrompt(id, true),
    [resolveUnknownQueuedPrompt],
  );
  const discardUnknownQueuedPrompt = useCallback(
    (id: number) => resolveUnknownQueuedPrompt(id, false),
    [resolveUnknownQueuedPrompt],
  );

  const editQueuedPrompt = useCallback(
    async (id: number) => {
      const target = queuedPromptsRef.current.find((p) => p.id === id);
      if (!target || target.serverState === 'submitting') return;
      if (
        target.payloadCompleteness === 'summary-only' ||
        target.admissionOutcome === 'unknown'
      ) {
        return;
      }
      if (target.isEditing || target.isRemoving) return;
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
      target.payloadCompleteness === 'summary-only' ||
      target.admissionOutcome === 'unknown'
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
        prompt.serverState === 'submitting' &&
        prompt.admissionOutcome !== 'unknown',
    );
    const clearablePrompts = queuedPromptsRef.current.filter(
      (prompt) =>
        prompt.midTurnState === undefined &&
        prompt.serverState !== 'submitting' &&
        prompt.admissionOutcome !== 'unknown',
    );
    if (submittingPrompts.length > 0) {
      const submittingIds = new Set(
        submittingPrompts.map((prompt) => prompt.id),
      );
      const uncertain = queuedPromptsRef.current.map((prompt) =>
        submittingIds.has(prompt.id)
          ? {
              ...prompt,
              serverState: undefined,
              admissionOutcome: 'unknown' as const,
              payloadAvailable: true,
            }
          : prompt,
      );
      queuedPromptsRef.current = uncertain;
      setQueuedPrompts(uncertain);
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
        (prompt) =>
          retainedIds.has(prompt.id) || prompt.admissionOutcome === 'unknown',
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
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
    restoreUnknownQueuedPrompt,
    discardUnknownQueuedPrompt,
  };
}
