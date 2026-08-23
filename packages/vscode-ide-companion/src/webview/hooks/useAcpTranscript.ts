import { useEffect, useState } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  createAcpTranscriptAdapterState,
  reduceAcpTranscriptUpdate,
  type AcpTranscriptAdapterState,
} from '../adapters/acpTranscriptAdapter.js';

interface ScopedTranscriptState extends AcpTranscriptAdapterState {
  readonly enabled: boolean;
  readonly scopeKey?: string;
}

const initialState = (
  enabled = document.body.dataset.webShellTranscript === 'enabled',
): ScopedTranscriptState => ({
  ...createAcpTranscriptAdapterState(),
  enabled,
});

export function useAcpTranscript(): {
  enabled: boolean;
  blocks: readonly DaemonTranscriptBlock[];
  compatible: boolean;
} {
  const [state, setState] = useState<ScopedTranscriptState>(initialState);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: unknown;
        data?: { enabled?: unknown; sessionId?: unknown; update?: unknown };
      };
      if (message.type === 'agentConnectionError') {
        setState((previous) => ({
          ...initialState(previous.enabled),
          compatible: false,
        }));
        return;
      }
      if (message.type === 'conversationLoaded') {
        setState((previous) => ({
          ...initialState(previous.enabled),
          compatible: false,
          ...(previous.scopeKey ? { scopeKey: previous.scopeKey } : {}),
        }));
        return;
      }
      if (message.type === 'agentConnected') {
        const scopeKey =
          typeof message.data?.sessionId === 'string'
            ? message.data.sessionId
            : undefined;
        setState((previous) => ({
          ...initialState(previous.enabled),
          ...(scopeKey ? { scopeKey } : {}),
        }));
        return;
      }
      if (message.type === 'webShellTranscriptSettingChanged') {
        const enabled = message.data?.enabled === true;
        setState({
          ...initialState(enabled),
          ...(enabled ? { compatible: false } : {}),
        });
        return;
      }
      if (
        message.type === 'conversationCleared' ||
        message.type === 'qwenSessionSwitched'
      ) {
        const scopeKey =
          typeof message.data?.sessionId === 'string'
            ? message.data.sessionId
            : undefined;
        setState((previous) => ({
          ...initialState(previous.enabled),
          ...(scopeKey ? { scopeKey } : {}),
        }));
        return;
      }
      if (message.type !== 'transcriptUpdate') return;
      const sessionId =
        typeof message.data?.sessionId === 'string'
          ? message.data.sessionId
          : undefined;
      setState((previous) => {
        if (!previous.enabled) return previous;
        if (!sessionId || !previous.scopeKey) return previous;
        if (previous.scopeKey !== sessionId) {
          return previous;
        }
        const scopeKey = previous.scopeKey;
        return {
          ...reduceAcpTranscriptUpdate(
            previous,
            message.data?.update,
            scopeKey,
          ),
          enabled: previous.enabled,
          scopeKey,
        };
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return {
    enabled: state.enabled,
    blocks: state.blocks,
    compatible: state.compatible,
  };
}
