/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appEvents,
  AppEvent,
  type TransientMessagePayload,
} from '../../utils/events.js';

export interface ActiveTransientMessage {
  id?: string;
  text: string;
  type: TransientMessagePayload['type'];
}

/**
 * Owns the single transient message shown in the StatusRow hint slot.
 *
 * Messages may override the default duration, remain visible until replaced,
 * or be cleared by id without disturbing a newer unrelated message. App events
 * and direct callers share the same state and timer.
 */
export function useTransientMessage(defaultDurationMs: number) {
  const [message, setMessage] = useState<ActiveTransientMessage | null>(null);
  const currentRef = useRef<ActiveTransientMessage | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const showMessage = useCallback(
    (payload: TransientMessagePayload | null) => {
      if (!payload) {
        clearTimer();
        currentRef.current = null;
        setMessage(null);
        return;
      }

      if (!payload.message) {
        if (!payload.id || currentRef.current?.id === payload.id) {
          clearTimer();
          currentRef.current = null;
          setMessage(null);
        }
        return;
      }

      clearTimer();
      const next: ActiveTransientMessage = {
        ...(payload.id ? { id: payload.id } : {}),
        text: payload.message,
        type: payload.type,
      };
      currentRef.current = next;
      setMessage(next);

      if (!payload.persist) {
        const durationMs =
          payload.durationMs && payload.durationMs > 0
            ? payload.durationMs
            : defaultDurationMs;
        timeoutRef.current = setTimeout(() => {
          if (currentRef.current === next) {
            currentRef.current = null;
            setMessage(null);
          }
          timeoutRef.current = null;
        }, durationMs);
      }
    },
    [clearTimer, defaultDurationMs],
  );

  useEffect(() => {
    appEvents.on(AppEvent.TransientMessage, showMessage);
    return () => {
      appEvents.off(AppEvent.TransientMessage, showMessage);
      clearTimer();
    };
  }, [clearTimer, showMessage]);

  return [message, showMessage] as const;
}
