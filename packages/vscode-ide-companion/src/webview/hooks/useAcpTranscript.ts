import { useEffect, useState } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  createAcpTranscriptAdapterState,
  reduceAcpTranscriptUpdate,
  type AcpTranscriptAdapterState,
} from '../adapters/acpTranscriptAdapter.js';

interface ScopedTranscriptState extends AcpTranscriptAdapterState {
  readonly scopeKey?: string;
}

const initialState = (): ScopedTranscriptState => ({
  ...createAcpTranscriptAdapterState(),
});

export function useAcpTranscript(enabled: boolean): {
  blocks: readonly DaemonTranscriptBlock[];
  compatible: boolean;
} {
  const [state, setState] = useState<ScopedTranscriptState>(initialState);

  useEffect(() => {
    if (!enabled) return;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: unknown;
        data?: { sessionId?: unknown; update?: unknown };
      };
      if (
        message.type === 'conversationCleared' ||
        message.type === 'qwenSessionSwitched'
      ) {
        const scopeKey =
          typeof message.data?.sessionId === 'string'
            ? message.data.sessionId
            : undefined;
        setState({ ...initialState(), ...(scopeKey ? { scopeKey } : {}) });
        return;
      }
      if (message.type !== 'transcriptUpdate') return;
      const sessionId =
        typeof message.data?.sessionId === 'string'
          ? message.data.sessionId
          : undefined;
      setState((previous) => {
        if (previous.scopeKey && sessionId && previous.scopeKey !== sessionId) {
          return previous;
        }
        const scopeKey = previous.scopeKey ?? sessionId ?? 'active-session';
        return {
          ...reduceAcpTranscriptUpdate(
            previous,
            message.data?.update,
            scopeKey,
          ),
          scopeKey,
        };
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [enabled]);

  return { blocks: state.blocks, compatible: state.compatible };
}
