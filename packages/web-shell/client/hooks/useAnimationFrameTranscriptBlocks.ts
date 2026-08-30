import {
  useCallback,
  useDeferredValue,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type {
  DaemonTranscriptBlock,
  DaemonTranscriptBlockChangeSummary,
} from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useTranscriptStore,
} from '@qwen-code/web-shell/daemon-react-sdk';

// Cap transcript re-renders at ~20fps. During streaming every network chunk
// notifies the store; each render then runs the O(transcript) normalization
// pass, so rendering at 60fps triples that cost per second while the visible
// text (itself throttled at 80ms for markdown) cannot change that fast. A
// 50ms window is still smooth for streaming text.
const TRANSCRIPT_RENDER_THROTTLE_MS = 50;
const INPUT_QUIET_WINDOW_MS = 100;
const MAX_INPUT_DEFERRAL_MS = 250;

function hasPendingInput(): boolean {
  const scheduling = (
    navigator as Navigator & {
      scheduling?: { isInputPending?: () => boolean };
    }
  ).scheduling;
  return scheduling?.isInputPending?.() === true;
}

interface AnimationFrameTranscriptSnapshot {
  blocks: readonly DaemonTranscriptBlock[];
  blockChangeSummary?: DaemonTranscriptBlockChangeSummary;
}

interface AnimationFrameTranscriptSnapshotOptions {
  structuralOnly?: boolean;
}

function isSameTranscriptStructure(
  previous: DaemonTranscriptBlockChangeSummary | undefined,
  next: DaemonTranscriptBlockChangeSummary | undefined,
): boolean {
  return (
    previous !== undefined &&
    next !== undefined &&
    previous.source === next.source &&
    previous.tailAppendBarrierRevision === next.tailAppendBarrierRevision
  );
}

export function useAnimationFrameTranscriptSnapshot(
  options: AnimationFrameTranscriptSnapshotOptions = {},
): AnimationFrameTranscriptSnapshot {
  const structuralOnly = options.structuralOnly === true;
  const store = useTranscriptStore();
  const { sessionId } = useConnection();
  const subscribe = useCallback(
    (notify: () => void) => {
      let frame: number | null = null;
      let lastNotifyTs = Number.NEGATIVE_INFINITY;
      let lastInputTs = Number.NEGATIVE_INFINITY;
      let pendingSinceTs: number | null = null;
      const recordInput = () => {
        lastInputTs = performance.now();
      };
      const dispatchWhenDue = (ts: number) => {
        frame = null;
        if (
          ts - lastNotifyTs >= TRANSCRIPT_RENDER_THROTTLE_MS &&
          ((ts - lastInputTs >= INPUT_QUIET_WINDOW_MS && !hasPendingInput()) ||
            (pendingSinceTs !== null &&
              ts - pendingSinceTs >= MAX_INPUT_DEFERRAL_MS))
        ) {
          lastNotifyTs = ts;
          pendingSinceTs = null;
          notify();
        } else {
          frame = window.requestAnimationFrame(dispatchWhenDue);
        }
      };
      document.addEventListener('beforeinput', recordInput, true);
      let previousSummary = store.getBlockChangeSummary?.();
      const unsubscribe = store.subscribe(() => {
        const nextSummary = store.getBlockChangeSummary?.();
        const tailOnly =
          structuralOnly &&
          isSameTranscriptStructure(previousSummary, nextSummary);
        previousSummary = nextSummary;
        if (tailOnly) return;
        if (frame !== null) return;
        pendingSinceTs = performance.now();
        frame = window.requestAnimationFrame(dispatchWhenDue);
      });
      return () => {
        unsubscribe();
        document.removeEventListener('beforeinput', recordInput, true);
        if (frame !== null) {
          window.cancelAnimationFrame(frame);
        }
      };
    },
    [store, structuralOnly],
  );
  const getSnapshot = useMemo(() => {
    let cached:
      | {
          blocks: readonly DaemonTranscriptBlock[];
          blockIndexById: Readonly<Record<string, number>>;
          blockChangeSummary: DaemonTranscriptBlockChangeSummary | undefined;
        }
      | undefined;
    return () => {
      const state = store.getSnapshot();
      const blockChangeSummary = store.getBlockChangeSummary?.();
      const canCompareStructure =
        structuralOnly &&
        cached?.blockChangeSummary !== undefined &&
        blockChangeSummary !== undefined;
      const changed = canCompareStructure
        ? !isSameTranscriptStructure(
            cached?.blockChangeSummary,
            blockChangeSummary,
          ) || cached?.blockIndexById !== state.blockIndexById
        : cached?.blocks !== state.blocks ||
          cached?.blockIndexById !== state.blockIndexById ||
          cached?.blockChangeSummary !== blockChangeSummary;
      if (!cached || changed) {
        cached = {
          blocks: state.blocks,
          blockIndexById: state.blockIndexById,
          blockChangeSummary,
        };
      }
      return cached;
    };
  }, [store, structuralOnly]);
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Defer transcript re-renders so urgent updates — composer keystrokes,
  // button presses — are never queued behind a streaming frame. The deferred
  // value catches up on the next idle render, so streaming stays smooth while
  // typing stays responsive.
  //
  // Session and block-index identities ride inside the deferred snapshot. The
  // session id rejects a previous session, while the index identity rejects a
  // same-session store reset without blocking ordinary streamed text updates.
  const snapshot = useMemo(() => ({ sessionId, ...live }), [live, sessionId]);
  const deferred = useDeferredValue(snapshot);
  const current =
    deferred.sessionId === sessionId &&
    deferred.blockIndexById === live.blockIndexById
      ? deferred
      : live;
  return {
    blocks: current.blocks,
    blockChangeSummary: current.blockChangeSummary,
  };
}
