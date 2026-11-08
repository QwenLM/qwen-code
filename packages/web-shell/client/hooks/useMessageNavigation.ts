import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useDaemonHistoryNavigationStore } from '../daemon/session/DaemonSessionProvider';
import type { MessageListHandle } from '../components/MessageList';

export interface WebShellMessageNavigationRequest {
  sessionId: string;
  /** JSONL 持久化记录 ID，不是渲染块 ID、摘要或时间戳。 */
  recordId: string;
  signal?: AbortSignal;
}

export type WebShellMessageNavigationResult = {
  status:
    | 'located'
    | 'not_found'
    | 'not_ready'
    | 'session_mismatch'
    | 'unsupported'
    | 'cancelled'
    | 'error';
};

export function useMessageNavigation(
  messageListRef: RefObject<MessageListHandle | null>,
  active = true,
) {
  const history = useDaemonHistoryNavigationStore();
  const generation = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!active) generation.current += 1;
  }, [active]);
  const currentHistory = useRef(history);
  currentHistory.current = history;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [history]);

  return useCallback(
    async ({
      sessionId,
      recordId,
      signal,
    }: WebShellMessageNavigationRequest): Promise<WebShellMessageNavigationResult> => {
      if (
        !mounted.current ||
        currentHistory.current !== history ||
        signal?.aborted
      )
        return { status: 'cancelled' };
      const state = history.getSnapshot();
      const viewport = history.getViewportSnapshot();
      if (!state.sessionId) return { status: 'not_ready' };
      if (state.sessionId !== sessionId) return { status: 'session_mismatch' };
      if (state.mode === 'legacy') return { status: 'unsupported' };
      if (
        !activeRef.current ||
        !viewport.connected ||
        state.mode !== 'ready' ||
        !messageListRef.current?.scrollToSearchHit
      )
        return { status: 'not_ready' };
      if (!recordId.trim()) return { status: 'not_found' };
      // 只有可执行的新定位才取代旧请求；被拒绝的调用不改变当前任务。
      const token = ++generation.current;
      const isCurrent = () =>
        mounted.current &&
        activeRef.current &&
        currentHistory.current === history &&
        generation.current === token &&
        !signal?.aborted &&
        history.getSnapshot().sessionId === sessionId &&
        history.getViewportSnapshot().revision === viewport.revision;
      try {
        const hit = await history.resolveMessageRecord(recordId, { isCurrent });
        if (!isCurrent()) return { status: 'cancelled' };
        if (!history.getViewportSnapshot().connected)
          return { status: 'not_ready' };
        if (!hit) return { status: 'not_found' };
        const located = await messageListRef.current?.scrollToSearchHit?.(
          hit,
          isCurrent,
        );
        if (!isCurrent() || located === 'cancelled')
          return { status: 'cancelled' };
        if (!history.getViewportSnapshot().connected)
          return { status: 'not_ready' };
        return { status: located ? 'located' : 'error' };
      } catch {
        if (!isCurrent()) return { status: 'cancelled' };
        return {
          status: history.getViewportSnapshot().connected
            ? 'error'
            : 'not_ready',
        };
      }
    },
    [history, messageListRef],
  );
}
