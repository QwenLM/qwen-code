/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  toFleetEntry,
  type FleetSessionEntry,
} from '../contexts/FleetViewContext.js';
import { useConfig } from '../contexts/ConfigContext.js';

const POLL_INTERVAL_MS = 3000;
const SESSION_LIST_SIZE = 100;

export interface UseFleetViewSessionsResult {
  sessions: FleetSessionEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFleetViewSessions(opts: {
  isOpen: boolean;
  currentSessionId: string | null;
}): UseFleetViewSessionsResult {
  const { isOpen, currentSessionId } = opts;
  const config = useConfig();
  const [sessions, setSessions] = useState<FleetSessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const sessionService = config.getSessionService();
      setLoading(true);
      const result = await sessionService.listSessions({
        size: SESSION_LIST_SIZE,
      });
      const entries = result.items.map((item) =>
        toFleetEntry(item, currentSessionId),
      );
      setSessions(entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [config, currentSessionId]);

  useEffect(() => {
    if (!isOpen) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    void fetchSessions();
    pollTimerRef.current = setInterval(() => {
      void fetchSessions();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isOpen, fetchSessions]);

  return { sessions, loading, error, refresh: fetchSessions };
}
