/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  createDaemonTranscriptState,
  selectTranscriptBlocks,
} from '@qwen-code/sdk/daemon';
import type { DaemonTranscriptState } from '@qwen-code/sdk/daemon';
import { reduceSessionNotification } from '../adapters/acpTranscriptAdapter.js';

/**
 * Reduce `transcriptUpdate` webview messages into a shared-SDK transcript
 * state and expose the rendered blocks.
 *
 * The transcript state resets on the session boundaries used by the rest of
 * the webview message flow (`qwenSessionSwitched` before an ACP replay, and
 * `conversationCleared` for a new session), so blocks from one session can
 * never leak into another session's replay.
 */
export function useAcpTranscript() {
  const stateRef = useRef<DaemonTranscriptState | null>(null);
  const [blocks, setBlocks] = useState(() =>
    selectTranscriptBlocks(createDaemonTranscriptState()),
  );

  useEffect(() => {
    const resetTranscript = () => {
      stateRef.current = null;
      setBlocks(selectTranscriptBlocks(createDaemonTranscriptState()));
    };

    const handleMessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        data?: SessionNotification;
      };
      if (
        message?.type === 'qwenSessionSwitched' ||
        message?.type === 'conversationCleared'
      ) {
        resetTranscript();
        return;
      }
      if (message?.type !== 'transcriptUpdate' || !message.data) {
        return;
      }
      if (stateRef.current === null) {
        stateRef.current = createDaemonTranscriptState();
      }
      stateRef.current = reduceSessionNotification(
        stateRef.current,
        message.data,
      );
      setBlocks(selectTranscriptBlocks(stateRef.current));
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return blocks;
}
