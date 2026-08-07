/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
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
  type DaemonSessionActions,
  type DaemonStreamingState,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  type DaemonInputAnnotation,
  type DaemonPendingPromptSummary,
  type DaemonTranscriptStore,
} from '@qwen-code/sdk/daemon';
import type { PromptImage } from '../adapters/promptTypes';
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
  sessionId?: string;
  clientId?: string;
  /**
   * Whether the daemon advertises `session_mid_turn_message_mutation`. Gates the
   * mid-turn delete/edit mutations — including the keyboard path, which the view
   * layer's hidden buttons can't reach — so an older daemon that mints message
   * ids without the route isn't sent a DELETE it answers with a 404.
   */
  canMutateMidTurn: boolean;
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

export interface UseQueuedPromptsResult {
  queuedPrompts: QueuedPrompt[];
  queuedTexts: string[];
  enqueuePrompt: (
    text: string,
    images?: PromptImage[],
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
  sessionId,
  clientId,
  canMutateMidTurn,
  streamingState,
  sessionActions,
  store,
  editorRef,
  reportError,
  t,
}: UseQueuedPromptsArgs): UseQueuedPromptsResult {
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const ownerTokenRef = useRef({ sessionId });
  if (ownerTokenRef.current.sessionId !== sessionId) {
    ownerTokenRef.current = { sessionId };
  }
  const nextQueuedPromptIdRef = useRef(1);
  const latestSessionIdRef = useRef(sessionId);
  const midTurnEnqueueAbortRef = useRef<AbortController | null>(null);
  const submitAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const removingServerPromptIdsRef = useRef<Set<string>>(new Set());
  const displayedServerPromptIdsRef = useRef<Set<string>>(new Set());
  const completionCallbacksRef = useRef<Map<string, () => void>>(new Map());
  const completedPromptIdsRef = useRef<Set<string>>(new Set());
  const completedPromptIdOrderRef = useRef<string[]>([]);
  const appendedBeforeResponsePromptIdsRef = useRef<Set<string>>(new Set());
  const removedBeforeResponsePromptIdsRef = useRef<Set<string>>(new Set());
  const latestStreamingStateRef = useRef(streamingState);
  const refreshRequestSeqRef = useRef(0);
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
  latestStreamingStateRef.current = streamingState;

  const queuedTexts = useMemo(
    () => queuedPrompts.map((prompt) => prompt.text),
    [queuedPrompts],
  );

  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

  useEffect(() => {
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    completionCallbacksRef.current = new Map();
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
    restoredPromptIdsRef.current = new Set();
    pendingStartedByPromptIdRef.current = new Map();
    initialRefreshSessionIdRef.current = undefined;
    midTurnEnqueueAbortRef.current?.abort();
    midTurnEnqueueAbortRef.current = null;
  }, [sessionId]);

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
          (p) => p.serverPromptId === serverPrompt.promptId,
        );
        const hasDisplayedPrompt = displayedServerPromptIdsRef.current.has(
          serverPrompt.promptId,
        );
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
        const hasUnboundImageSubmission = next.some(
          (prompt) =>
            !prompt.serverPromptId &&
            prompt.serverState === 'submitting' &&
            prompt.admissionOutcome !== 'unknown' &&
            (prompt.images?.length ?? 0) > 0,
        );
        if (hasUnboundImageSubmission) continue;
        next.push({
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: serverPrompt.text,
          serverPromptId: serverPrompt.promptId,
          serverState: serverPrompt.state,
          payloadCompleteness: 'summary-only',
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
          ownerTokenRef.current !== ownerToken ||
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
        ownerTokenRef.current !== expectedOwnerToken ||
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
      if (restoredText) {
        const nextText = mergeRestoredPromptText(currentText, restoredText);
        if (nextText !== currentText) editor.setText(nextText);
      }
      const images = restorable.flatMap((prompt) => prompt.images ?? []);
      if (images.length > 0) editor.restoreImages(images);
      let annotationOffset = 0;
      const inputAnnotations: DaemonInputAnnotation[] = [];
      for (const prompt of restorable) {
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

  const appendLocalQueuedPrompt = useCallback(
    (prompt: QueuedPrompt, promptId: string) => {
      if (
        displayedServerPromptIdsRef.current.has(promptId) ||
        prompt.payloadCompleteness === 'summary-only' ||
        (!prompt.text && (prompt.images?.length ?? 0) === 0)
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
    if (!connected || !sessionId) return;

    const versionChanged =
      prevPendingVersionRef.current !== pendingPromptVersion;
    prevPendingVersionRef.current = pendingPromptVersion;
    if (!versionChanged) {
      if (queuedPromptsRef.current.length > 0) return;
      if (streamingState === 'idle') return;
      if (initialRefreshSessionIdRef.current === sessionId) return;
      initialRefreshSessionIdRef.current = sessionId;
    }

    void refreshPendingPrompts();
  }, [
    pendingPromptVersion,
    connected,
    sessionId,
    streamingState,
    refreshPendingPrompts,
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
              (item) =>
                !item.serverPromptId &&
                item.serverState === 'submitting' &&
                item.admissionOutcome !== 'unknown' &&
                (item.images?.length ?? 0) === 0 &&
                item.text === eventText,
            );
          if (prompt) {
            appendLocalQueuedPrompt(prompt, promptId);
            if (!prompt.serverPromptId) {
              appendedBeforeResponsePromptIdsRef.current.add(promptId);
            }
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
    refreshPendingPrompts,
    rememberCompletedPromptId,
  ]);

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

  const submitPendingPrompt = useCallback(
    (prompt: QueuedPrompt) => {
      const { id: localId, sessionId: targetSessionId } = prompt;
      const ownerToken = ownerTokenRef.current;
      const submitAbort = new AbortController();
      submitAbortControllersRef.current.add(submitAbort);

      sessionActions
        .submitPrompt(prompt.text, {
          images: prompt.images,
          inputAnnotations: prompt.inputAnnotations,
          optimisticUserMessage: false,
          sessionId: targetSessionId,
          signal: submitAbort.signal,
        })
        .then((result) => {
          submitAbortControllersRef.current.delete(submitAbort);
          if (
            ownerTokenRef.current !== ownerToken ||
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
            if ((prompt.images?.length ?? 0) > 0) {
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
          if ((prompt.images?.length ?? 0) > 0) {
            void refreshPendingPrompts(targetSessionId);
          }
        })
        .catch((error: unknown) => {
          submitAbortControllersRef.current.delete(submitAbort);
          if (
            ownerTokenRef.current !== ownerToken ||
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
      onComplete?: () => void,
      inputAnnotations?: DaemonInputAnnotation[],
      onAdmitted?: () => void,
    ) => {
      const trimmed = text.trim();
      if (!trimmed && (images?.length ?? 0) === 0) return true;
      const targetSessionId = latestSessionIdRef.current;
      const ownerToken = ownerTokenRef.current;
      const shouldInsertMidTurn =
        latestStreamingStateRef.current !== 'idle' &&
        (images?.length ?? 0) === 0 &&
        (inputAnnotations?.length ?? 0) === 0 &&
        !isCommandPrompt(trimmed);
      const prompt: QueuedPrompt = {
        id: nextQueuedPromptIdRef.current++,
        sessionId: targetSessionId,
        text: trimmed,
        images: images ? [...images] : undefined,
        inputAnnotations: inputAnnotations ? [...inputAnnotations] : undefined,
        onComplete,
        onAdmitted,
        payloadCompleteness: 'complete',
        ...(shouldInsertMidTurn
          ? { midTurnState: 'submitting' }
          : { serverState: 'submitting' }),
      };
      queuedPromptsRef.current = [...queuedPromptsRef.current, prompt];
      setQueuedPrompts(queuedPromptsRef.current);

      if (!shouldInsertMidTurn) {
        submitPendingPrompt(prompt);
        return true;
      }

      let abort = midTurnEnqueueAbortRef.current;
      if (!abort) {
        abort = new AbortController();
        midTurnEnqueueAbortRef.current = abort;
      }
      void sessionActions
        .enqueueMidTurnMessage(trimmed, { signal: abort.signal })
        .then((result) => {
          if (ownerTokenRef.current !== ownerToken) return;
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
        });
      return true;
    },
    [fallbackToPendingPrompt, sessionActions, submitPendingPrompt],
  );

  const { batches: midTurnInjectedBatches, consume: consumeMidTurnInjected } =
    useDaemonMidTurnInjected();
  // DECLARATION ORDER IS LOAD-BEARING: this effect must stay declared ABOVE the
  // idle effect below. When an injection frame and the idle transition land in
  // the same React batch, effects run in declaration order, so this clears the
  // injected row's midTurnState first — otherwise the idle effect's
  // fallbackToPendingPrompt claims that row and resubmits a message the model
  // already received (double delivery).
  useEffect(() => {
    if (!sessionId || midTurnInjectedBatches.length === 0) return;
    const current = queuedPromptsRef.current;
    const next = removeInjectedFromQueue(
      current,
      midTurnInjectedBatches,
      sessionId,
      clientId,
    );
    if (next) {
      const retainedIds = new Set(next.map((prompt) => prompt.id));
      for (const prompt of current) {
        if (!retainedIds.has(prompt.id)) prompt.onComplete?.();
      }
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    }
    consumeMidTurnInjected(
      midTurnInjectedBatches.filter((batch) => batch.sessionId === sessionId),
    );
  }, [midTurnInjectedBatches, sessionId, clientId, consumeMidTurnInjected]);

  useEffect(() => {
    if (streamingState !== 'idle') return;
    const ctrl = midTurnEnqueueAbortRef.current;
    if (ctrl) {
      ctrl.abort();
      midTurnEnqueueAbortRef.current = null;
    }
    for (const prompt of queuedPromptsRef.current) {
      if (prompt.midTurnFailedAction) {
        const next = queuedPromptsRef.current.filter(
          (item) => item.id !== prompt.id,
        );
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
        if (prompt.midTurnFailedAction === 'edit') {
          restoreQueuedPromptsToEditor([prompt], prompt.sessionId);
        }
      } else if (
        prompt.midTurnState &&
        !prompt.isEditing &&
        !prompt.isRemoving
      ) {
        fallbackToPendingPrompt(prompt.id);
      }
    }
  }, [streamingState, fallbackToPendingPrompt, restoreQueuedPromptsToEditor]);

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
        if (ownerTokenRef.current !== ownerToken) return false;
        removingPromptIds.delete(target.serverPromptId);
        if (!result.removed) {
          setQueuedPromptFlags(target.id, {
            isEditing: false,
            isRemoving: false,
          });
          await refreshPendingPrompts(targetSessionId);
          if (ownerTokenRef.current !== ownerToken) return false;
          reportError(
            new Error('Prompt could not be removed from queue'),
            fallback,
          );
          return false;
        }
        completionCallbacksRef.current.delete(target.serverPromptId);
        const refreshResult = await refreshPendingPrompts(targetSessionId);
        if (ownerTokenRef.current !== ownerToken) return false;
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
        if (ownerTokenRef.current !== ownerToken) return false;
        removingPromptIds.delete(target.serverPromptId);
        setQueuedPromptFlags(target.id, {
          isEditing: false,
          isRemoving: false,
        });
        const refreshResult = await refreshPendingPrompts(targetSessionId);
        if (ownerTokenRef.current !== ownerToken) return false;
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
        if (ownerTokenRef.current !== ownerToken) return false;
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
        if (ownerTokenRef.current !== ownerToken) return false;
        const latest = queuedPromptsRef.current.find(
          (prompt) => prompt.id === target.id,
        );
        if (latest?.midTurnMessageId === target.midTurnMessageId) {
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
    [canMutateMidTurn, reportError, sessionActions, setQueuedPromptFlags],
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
      if (ownerTokenRef.current !== ownerToken) return false;
      const next = queuedPromptsRef.current.map((prompt) =>
        prompt.id === id
          ? {
              ...prompt,
              text: '',
              images: undefined,
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
      const editOwnerToken = ownerTokenRef.current;
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
          restoreQueuedPromptsToEditor(
            [target],
            target.sessionId,
            false,
            editOwnerToken,
          );
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
        restoreQueuedPromptsToEditor(
          [target],
          target.sessionId,
          false,
          editOwnerToken,
        );
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
    const editOwnerToken = ownerTokenRef.current;
    void (async () => {
      const removed = await removeServerPromptForAction(
        target,
        { isEditing: true },
        t('queue.editFailed'),
      );
      if (removed) {
        restoreQueuedPromptsToEditor(
          [target],
          target.sessionId,
          false,
          editOwnerToken,
        );
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
        ownerTokenRef.current !== clearOwnerToken ||
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
    queuedPrompts,
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
