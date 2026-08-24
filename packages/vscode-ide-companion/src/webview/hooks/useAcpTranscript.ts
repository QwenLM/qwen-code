/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  createDaemonTranscriptState,
  reduceDaemonTranscriptEvents,
  selectTranscriptBlocks,
} from '@qwen-code/sdk/daemon';
import type { DaemonTranscriptState } from '@qwen-code/sdk/daemon';
import {
  cachedMessageToNotification,
  reduceSessionNotification,
} from '../adapters/acpTranscriptAdapter.js';

/** Map webview `streamEnd` reasons onto the reducer's done reasons. */
function streamEndToDoneReason(reason: unknown): string {
  if (reason === 'user_cancelled') {
    return 'cancelled';
  }
  // Timeouts and expired sessions terminate the turn at the application
  // layer; map them onto the reducer's abnormal-reason set so in-flight
  // tool blocks are force-finalized instead of spinning forever.
  if (reason === 'timeout' || reason === 'session_expired') {
    return 'error';
  }
  return typeof reason === 'string' && reason.length > 0 ? reason : 'end_turn';
}

/**
 * Reduce `transcriptUpdate` webview messages into a shared-SDK transcript
 * state and expose the rendered blocks.
 *
 * The transcript state resets on every session boundary used by the rest of
 * the webview message flow (`qwenSessionSwitched` before an ACP replay,
 * `conversationCleared` for a new session, and `conversationLoaded` on
 * startup/reconnect), so blocks from one session can never leak into another
 * session's replay. Frames arriving after a boundary are additionally
 * dropped when their `sessionId` no longer matches the active session.
 * Boundaries that publish a session id pin the guard to it, so trailing
 * frames from the just-abandoned session cannot be adopted into the fresh
 * conversation; a `liveSessionId` (load-failure fallbacks that create a
 * fresh ACP session) wins over the archived `sessionId` so the fresh
 * session's live frames pass the guard. Boundaries without an id fall back
 * to adopting the first frame's session id.
 */
export function useAcpTranscript() {
  const stateRef = useRef<DaemonTranscriptState | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  // Track the active requestId from the latest streamStart so stale or
  // untagged streamEnd events can be dropped (mirrors useWebViewMessages).
  const activeRequestIdRef = useRef<string | null>(null);
  const [blocks, setBlocks] = useState(() =>
    selectTranscriptBlocks(createDaemonTranscriptState()),
  );

  useEffect(() => {
    const resetTranscript = () => {
      stateRef.current = null;
      activeSessionIdRef.current = null;
      activeRequestIdRef.current = null;
      setBlocks(selectTranscriptBlocks(createDaemonTranscriptState()));
    };

    /** Finalize in-flight assistant/thought blocks at a turn boundary. */
    const finishTurn = (reason: unknown) => {
      if (stateRef.current === null) {
        return;
      }
      stateRef.current = reduceDaemonTranscriptEvents(stateRef.current, [
        { type: 'assistant.done', reason: streamEndToDoneReason(reason) },
      ]);
      setBlocks(selectTranscriptBlocks(stateRef.current));
    };

    const handleMessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        data?: unknown;
      };
      if (
        message?.type === 'qwenSessionSwitched' ||
        message?.type === 'conversationCleared' ||
        message?.type === 'conversationLoaded'
      ) {
        resetTranscript();
        const data = message.data as
          | {
              sessionId?: unknown;
              liveSessionId?: unknown;
              messages?: Array<Record<string, unknown>>;
            }
          | undefined;
        // Boundaries that publish a session id pin the transcript guard to
        // it: trailing frames from the just-abandoned session (which may
        // still be streaming on the CLI) are dropped by the guard below
        // instead of being blindly adopted into the fresh conversation.
        // Load-failure fallbacks keep the archived conversation id for the
        // session list while creating a fresh ACP session for live
        // streaming; the boundary publishes that fresh id as
        // `liveSessionId`, which wins over the archived `sessionId` so the
        // live frames carrying it are not dropped (cached history is
        // seeded under the same adopted id).
        if (typeof data?.liveSessionId === 'string' && data.liveSessionId) {
          activeSessionIdRef.current = data.liveSessionId;
        } else if (typeof data?.sessionId === 'string' && data.sessionId) {
          activeSessionIdRef.current = data.sessionId;
        }
        if (message.type === 'qwenSessionSwitched') {
          // Offline restores and load-failure fallbacks deliver cached
          // history here and never replay it through `transcriptUpdate`,
          // so seed the transcript from the cached rows directly.
          if (Array.isArray(data?.messages) && data.messages.length > 0) {
            let state = createDaemonTranscriptState();
            for (const cached of data.messages) {
              const notification = cachedMessageToNotification(
                cached,
                activeSessionIdRef.current ?? '',
              );
              if (notification) {
                state = reduceSessionNotification(state, notification);
              }
            }
            stateRef.current = state;
            setBlocks(selectTranscriptBlocks(state));
          }
        }
        return;
      }
      if (message?.type === 'streamStart') {
        const startData = message.data as
          | { timestamp?: number; requestId?: string }
          | undefined;
        activeRequestIdRef.current = startData?.requestId ?? null;
        return;
      }
      if (message?.type === 'streamEnd') {
        const endData = message.data as
          | { reason?: unknown; requestId?: string; source?: string }
          | undefined;
        // Background-task completions emit end-turn notifications while
        // an interactive turn may be mid-stream; they must not finalize
        // (and thereby split or force-cancel) the live turn.
        if (endData?.source === 'background_notification') {
          return;
        }
        const endRequestId = endData?.requestId ?? null;
        // Mirror useWebViewMessages: while a tagged stream is active,
        // drop stale or untagged streamEnd events so a foreign turn-end
        // cannot finalize the in-flight answer early — the next delta
        // would otherwise start a second assistant block, and abnormal
        // reasons would force-cancel genuinely running tool blocks.
        if (
          activeRequestIdRef.current !== null &&
          endRequestId !== activeRequestIdRef.current
        ) {
          return;
        }
        activeRequestIdRef.current = null;
        finishTurn(endData?.reason);
        return;
      }
      if (message?.type === 'sessionLoadComplete') {
        // History replays (and cached restores) have no turn-end frame of
        // their own; finalize so the last block does not stay streaming.
        finishTurn('end_turn');
        return;
      }
      if (message?.type !== 'transcriptUpdate' || !message.data) {
        return;
      }
      const notification = message.data as SessionNotification;
      // Drop late frames from a previous session that arrive after the
      // boundary reset; adopt the session id on the first frame when the
      // boundary did not carry one.
      if (activeSessionIdRef.current === null) {
        if (
          typeof notification.sessionId === 'string' &&
          notification.sessionId
        ) {
          activeSessionIdRef.current = notification.sessionId;
        }
      } else if (notification.sessionId !== activeSessionIdRef.current) {
        return;
      }
      if (stateRef.current === null) {
        stateRef.current = createDaemonTranscriptState();
      }
      stateRef.current = reduceSessionNotification(
        stateRef.current,
        notification,
      );
      setBlocks(selectTranscriptBlocks(stateRef.current));
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return blocks;
}
