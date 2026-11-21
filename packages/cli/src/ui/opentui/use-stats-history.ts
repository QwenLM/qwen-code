/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  metricsToUsageRecord,
  type TimeRange,
} from '@qwen-code/qwen-code-core/services/usageHistoryService.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { loadStatsData, type StatsData } from '../utils/statsDataService.js';

export function useStatsHistory(
  config: Config | null | undefined,
  stats: SessionStatsState | undefined,
  range: TimeRange,
) {
  const session = config?.getSessionId?.();
  const project = config?.getProjectRoot?.();
  const valid = Boolean(
    config && stats && session && project && session === stats.sessionId,
  );
  const owner = useRef({ config, session, project, revoked: false });
  if (
    owner.current.config !== config ||
    owner.current.session !== session ||
    owner.current.project !== project
  ) {
    owner.current.revoked = true;
    owner.current = { config, session, project, revoked: false };
  }
  const captured = owner.current;
  const request = useRef({ owner: captured, range });
  if (request.current.owner !== captured || request.current.range !== range) {
    request.current = { owner: captured, range };
  }
  const selectedRequest = request.current;
  const [loaded, setLoaded] = useState<{
    request: typeof selectedRequest;
    data?: StatsData;
    error?: string;
  }>();
  useEffect(() => {
    if (!config || !stats || !valid || !project || !session) return;
    let alive = true;
    const current = () => {
      if (
        !alive ||
        captured.revoked ||
        owner.current !== captured ||
        request.current !== selectedRequest
      )
        return false;
      if (
        config.getSessionId() !== session ||
        config.getProjectRoot() !== project
      ) {
        captured.revoked = true;
        return false;
      }
      return true;
    };
    const hasActivity = Object.values(stats.metrics.models).some(
      (model) => model.api.totalRequests > 0,
    );
    const live = hasActivity
      ? metricsToUsageRecord(
          session,
          project,
          stats.sessionStartTime.getTime(),
          Date.now(),
          stats.metrics,
        )
      : undefined;
    void loadStatsData(range, live).then(
      (data) => {
        if (current()) setLoaded({ request: selectedRequest, data });
      },
      () => {
        if (current())
          setLoaded({
            request: selectedRequest,
            error: 'Failed to load stats. Press r to retry.',
          });
      },
    );
    return () => {
      alive = false;
    };
    // Telemetry updates do not reload disk history; Ink reloads on range/session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, session, project, range, valid, captured, selectedRequest]);
  if (!valid || captured.revoked)
    return {
      data: undefined,
      error: 'Statistics owner is unavailable.',
      loading: false,
    };
  const result = loaded?.request === selectedRequest ? loaded : undefined;
  return { data: result?.data, error: result?.error, loading: !result };
}
