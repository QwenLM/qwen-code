/**
 * Quick notification cards shown above the desktop pet — one card per session,
 * updated in place as that session's state changes (running -> pending ->
 * complete / error). Driven by the global agent event stream.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionEvent } from '@craft-agent/shared/protocol';

export type PetNotificationKind =
  | 'running'
  | 'pending'
  | 'success'
  | 'error'
  | 'info';

export interface PetNotification {
  sessionId: string;
  kind: PetNotificationKind;
  /** i18n key for the card title. */
  titleKey: string;
  /** monotonic update counter — newest on top. */
  seq: number;
}

// Streaming/working signals that keep a session in the "running" state.
const ACTIVITY = new Set([
  'text_delta',
  'text_complete',
  'tool_result',
  'status',
  'task_progress',
]);

let seq = 0;

export function usePetNotifications() {
  const [bySession, setBySession] = useState<Map<string, PetNotification>>(
    () => new Map(),
  );

  const dismiss = useCallback((sessionId: string) => {
    setBySession((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const clear = useCallback(() => setBySession(new Map()), []);

  useEffect(() => {
    if (!window.electronAPI?.onSessionEvent) return;

    const setState = (
      sessionId: string,
      kind: PetNotificationKind,
      titleKey: string,
    ) => {
      setBySession((prev) => {
        const cur = prev.get(sessionId);
        if (cur && cur.kind === kind) return prev; // no transition -> no churn
        seq += 1;
        const next = new Map(prev);
        next.set(sessionId, { sessionId, kind, titleKey, seq });
        return next;
      });
    };

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      const sessionId = (event as { sessionId?: string }).sessionId;
      if (!sessionId) return;
      switch (event.type) {
        case 'permission_request':
          setState(sessionId, 'pending', 'pet.notify.approval');
          break;
        case 'complete':
          setState(sessionId, 'success', 'pet.notify.complete');
          break;
        case 'error':
          setState(sessionId, 'error', 'pet.notify.error');
          break;
        case 'interrupted':
          setState(sessionId, 'info', 'pet.notify.interrupted');
          break;
        default:
          if (ACTIVITY.has(event.type)) {
            setState(sessionId, 'running', 'pet.notify.running');
          }
          break;
      }
    });

    return cleanup;
  }, []);

  const items = useMemo(
    () => Array.from(bySession.values()).sort((a, b) => b.seq - a.seq),
    [bySession],
  );

  return { items, dismiss, clear };
}
