/**
 * Derives the pet animation state purely from the global agent event stream
 * (`electronAPI.onSessionEvent`), so it works in any window — including the
 * standalone desktop-pet window that has no access to the main window's Jotai
 * session atoms.
 *
 *   activity events (text/tool/status) -> running
 *   permission_request                 -> waiting
 *   complete                           -> jumping (brief) then idle
 *   error / interrupted                -> failed (brief) then idle
 */
import { useEffect, useRef, useState } from 'react';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import type { PetState } from './pet-animation';

const TRANSIENT_MS: Record<'jumping' | 'failed', number> = {
  jumping: 1300,
  failed: 2600,
};

// Safety net: if a turn streams activity but never emits a terminal event,
// fall back to idle after this much silence.
const ACTIVITY_TIMEOUT_MS = 10_000;

const ACTIVITY_EVENTS = new Set([
  'text_delta',
  'text_complete',
  'tool_result',
  'status',
  'task_progress',
]);

export function usePetActivityState(): PetState {
  const [processing, setProcessing] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [transient, setTransient] = useState<PetState | null>(null);

  const transientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!window.electronAPI?.onSessionEvent) return;

    const flash = (next: 'jumping' | 'failed') => {
      setTransient(next);
      if (transientTimer.current) clearTimeout(transientTimer.current);
      transientTimer.current = setTimeout(
        () => setTransient(null),
        TRANSIENT_MS[next],
      );
    };

    const stopActivity = () => {
      setProcessing(false);
      if (activityTimer.current) clearTimeout(activityTimer.current);
    };

    const markActivity = () => {
      setAwaiting(false);
      setProcessing(true);
      if (activityTimer.current) clearTimeout(activityTimer.current);
      activityTimer.current = setTimeout(
        () => setProcessing(false),
        ACTIVITY_TIMEOUT_MS,
      );
    };

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      switch (event.type) {
        case 'permission_request':
          setAwaiting(true);
          break;
        case 'complete':
          setAwaiting(false);
          stopActivity();
          flash('jumping');
          break;
        case 'error':
        case 'interrupted':
          setAwaiting(false);
          stopActivity();
          flash('failed');
          break;
        default:
          if (ACTIVITY_EVENTS.has(event.type)) markActivity();
          break;
      }
    });

    return () => {
      cleanup();
      if (transientTimer.current) clearTimeout(transientTimer.current);
      if (activityTimer.current) clearTimeout(activityTimer.current);
    };
  }, []);

  if (transient) return transient;
  if (awaiting) return 'waiting';
  if (processing) return 'running';
  return 'idle';
}
