/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import {
  CoreEvent,
  coreEvents,
  type CompressionProgressPayload,
} from '@qwen-code/core';
import type { CompressionProgressView } from '../contexts/UIStateContext.js';
import { getCompressionModelRequestFailureText } from '../../utils/compressionFailureText.js';

const SHOW_DELAY_MS = 200;
const COMPLETE_HOLD_MS = 400;
const FAILURE_HOLD_MS = 1_500;
const SUMMARIZING_ANIMATION_INTERVAL_MS = 250;
const STAGE_TWEEN_INTERVAL_MS = 50;
const POST_PROCESSING_TWEEN_MS = 700;
const DONE_TWEEN_MS = 1_000;
const SUMMARIZING_START = 8;
const SUMMARIZING_SOFT_CEILING = 75;
const SUMMARIZING_TIME_CONSTANT_SECONDS = 35;

const STAGE_VIEWS: Record<
  CompressionProgressPayload['stage'],
  Omit<CompressionProgressView, 'stage'>
> = {
  starting: { label: 'Compacting conversation…', percent: 2, tone: 'active' },
  summarizing: {
    label: 'Compacting conversation…',
    percent: SUMMARIZING_START,
    tone: 'active',
  },
  post_processing: {
    label: 'Applying compacted context…',
    percent: 90,
    tone: 'active',
  },
  done: { label: 'Applying compacted context…', percent: 100, tone: 'active' },
  failed: {
    label: 'Conversation compaction failed',
    percent: 100,
    tone: 'warning',
  },
};

function viewForPayload(
  payload: CompressionProgressPayload,
): CompressionProgressView {
  const view = { stage: payload.stage, ...STAGE_VIEWS[payload.stage] };
  if (payload.stage === 'failed' && payload.displayErrorCode !== undefined) {
    view.label = getCompressionModelRequestFailureText(payload);
  }
  return view;
}

/** Keep the displayed percent monotonic — never let a new stage regress it. */
function clampBackward(next: number, previous: number | undefined): number {
  return Math.min(next, previous ?? next);
}

/**
 * Projects main-thread compression events into a small TUI-only progress
 * model. Percentages are phase progress, never token usage.
 */
export function useCompressionProgress(
  sessionScopeId: string,
): CompressionProgressView | null {
  const [view, setView] = useState<CompressionProgressView | null>(null);
  const latestViewRef = useRef<CompressionProgressView | null>(null);
  const visibleRef = useRef(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestViewRef.current = null;
    visibleRef.current = false;
    setView(null);

    const cancelShowTimer = () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };
    const cancelClearTimer = () => {
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
    const clearVisibleView = () => {
      latestViewRef.current = null;
      visibleRef.current = false;
      setView(null);
    };

    const handleProgress = (payload: CompressionProgressPayload) => {
      if (
        payload.sessionScopeId !== sessionScopeId ||
        payload.target !== 'main'
      ) {
        return;
      }

      if (
        payload.stage === 'failed' &&
        payload.failureReason === 'cancelled'
      ) {
        // User cancellation is not a compaction failure. Clear any visible or
        // pending progress immediately while the Abort error continues through
        // the request lifecycle.
        cancelShowTimer();
        cancelClearTimer();
        clearVisibleView();
        return;
      }

      const previousView = latestViewRef.current;
      const nextView = viewForPayload(payload);
      if (
        previousView &&
        (payload.stage === 'post_processing' || payload.stage === 'done')
      ) {
        nextView.percent = clampBackward(nextView.percent, previousView.percent);
      }
      latestViewRef.current = nextView;
      cancelClearTimer();

      if (payload.stage === 'done') {
        cancelShowTimer();
        if (!visibleRef.current) {
          // Fast compactions are represented by the persistent completion row;
          // avoid flashing a transient 100% panel for a few milliseconds.
          clearVisibleView();
          return;
        }

        setView((current) => {
          const animatedView = {
            ...nextView,
            percent: clampBackward(nextView.percent, current?.percent),
          };
          latestViewRef.current = animatedView;
          return animatedView;
        });
        clearTimerRef.current = setTimeout(
          clearVisibleView,
          DONE_TWEEN_MS + COMPLETE_HOLD_MS,
        );
        return;
      }

      if (payload.stage === 'failed') {
        // Unlike success, failure may not produce a persistent history row.
        // Surface it immediately even if the operation failed within the
        // anti-flicker delay.
        cancelShowTimer();
        visibleRef.current = true;
        setView(nextView);
        clearTimerRef.current = setTimeout(
          clearVisibleView,
          FAILURE_HOLD_MS,
        );
        return;
      }

      if (visibleRef.current) {
        setView((current) => {
          const animatedView =
            payload.stage === 'post_processing'
              ? {
                  ...nextView,
                  percent: clampBackward(nextView.percent, current?.percent),
                }
              : nextView;
          latestViewRef.current = animatedView;
          return animatedView;
        });
        return;
      }

      if (!showTimerRef.current) {
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          const latest = latestViewRef.current;
          if (!latest || latest.stage === 'done' || latest.stage === 'failed') {
            return;
          }
          visibleRef.current = true;
          setView(latest);
        }, SHOW_DELAY_MS);
      }
    };

    coreEvents.on(CoreEvent.CompressionProgress, handleProgress);
    return () => {
      coreEvents.off(CoreEvent.CompressionProgress, handleProgress);
      cancelShowTimer();
      cancelClearTimer();
    };
  }, [sessionScopeId]);

  useEffect(() => {
    if (view?.stage !== 'summarizing') return;

    // The provider exposes no fractional completion for summarization. Use a
    // slow asymptotic curve so short runs still move while long runs never
    // race to the post-processing boundary. The spinner communicates liveness
    // when the rounded percentage holds for several seconds.
    const startedAt = Date.now();

    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAt) / 1_000;
      const easedProgress =
        (SUMMARIZING_SOFT_CEILING - SUMMARIZING_START) *
          (1 -
            Math.exp(
              -elapsedSeconds / SUMMARIZING_TIME_CONSTANT_SECONDS,
            ));
      const targetPercent = Math.min(
        SUMMARIZING_SOFT_CEILING - 0.01,
        SUMMARIZING_START + easedProgress,
      );

      setView((current) => {
        if (!current || current.stage !== 'summarizing') return current;
        // Only re-render when the displayed integer percent advances; the
        // asymptotic curve creeps by sub-integer amounts every tick and the
        // spinner already communicates liveness between visible steps.
        if (Math.floor(targetPercent) <= Math.floor(current.percent)) {
          return current;
        }
        const nextView = {
          ...current,
          percent: targetPercent,
        };
        latestViewRef.current = nextView;
        return nextView;
      });
    }, SUMMARIZING_ANIMATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [view?.stage]);

  useEffect(() => {
    const stage = view?.stage;
    if (stage !== 'post_processing' && stage !== 'done') return;

    const targetPercent = STAGE_VIEWS[stage].percent;
    const startPercent = latestViewRef.current?.percent ?? targetPercent;
    if (startPercent >= targetPercent) return;

    const durationMs =
      stage === 'post_processing'
        ? POST_PROCESSING_TWEEN_MS
        : DONE_TWEEN_MS;
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      const nextPercent =
        startPercent + (targetPercent - startPercent) * progress;

      setView((current) => {
        if (!current || current.stage !== stage) return current;
        // Skip ticks that don't advance the displayed integer percent, but
        // always apply the final frame so the bar lands exactly on target.
        if (
          progress < 1 &&
          Math.floor(nextPercent) <= Math.floor(current.percent)
        ) {
          return current;
        }
        const nextView = { ...current, percent: nextPercent };
        latestViewRef.current = nextView;
        return nextView;
      });

      if (progress >= 1) clearInterval(interval);
    }, STAGE_TWEEN_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [view?.stage]);

  return view;
}
