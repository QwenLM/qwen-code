/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonSessionStatsStatus } from '@qwen-code/web-shell/daemon-react-sdk';
import { DatabaseIcon, GaugeIcon } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  formatCompact,
  outputSpeed,
  summarizeSessionUsage,
} from './artifacts/tokenUsageTotals';
import styles from './ComposerUsageStats.module.css';

/** Refreshes started closer together than this collapse into one. */
const MIN_REFRESH_GAP_MS = 1_000;
/** Catches subagent and side requests while the session is working. */
const RUNNING_POLL_MS = 5_000;

interface ComposerUsageStatsProps {
  sessionId?: string;
  /** Reads `GET /session/:id/stats` without raising a user-facing notice. */
  loadStats?: (sessionId: string) => Promise<DaemonSessionStatsStatus>;
  /**
   * Changes whenever the session may hold new usage, such as the context
   * token count after a model response.
   */
  refreshSignal?: unknown;
  /** The session is working; usage is read on a slow poll meanwhile. */
  running: boolean;
  /** Opens the full token usage panel. */
  onOpen?: () => void;
}

/**
 * Integer percent while rounding stays below 100, else the fewest decimals
 * that do; only a full hit reads 100.
 */
export function formatCacheHitPercent(
  cached: number,
  input: number,
): string | undefined {
  if (input <= 0) return undefined;
  if (cached >= input) return '100';
  const percent = (Math.max(0, cached) / input) * 100;
  for (let digits = 0; digits <= 3; digits += 1) {
    const text = percent.toFixed(digits);
    if (Number(text) < 100) return text;
  }
  return '99.999';
}

/** Whole numbers from 10 tok/s up, one decimal below. */
export function formatSpeed(speed: number): string {
  return speed >= 10 ? String(Math.round(speed)) : speed.toFixed(1);
}

/**
 * Session-wide reading under the composer: turns and output speed, then
 * total tokens and cache hit. It reads the same stats as the token usage
 * panel, with the same definitions.
 */
export function ComposerUsageStats({
  sessionId,
  loadStats,
  refreshSignal,
  running,
  onOpen,
}: ComposerUsageStatsProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonSessionStatsStatus | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const loadStatsRef = useRef(loadStats);
  loadStatsRef.current = loadStats;
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const lastStartRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  const refresh = useCallback(() => {
    const id = sessionIdRef.current;
    const load = loadStatsRef.current;
    if (!id || !load) return;
    // A hidden page reads nothing; becoming visible reads once.
    if (document.visibilityState !== 'visible') return;
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    const wait = lastStartRef.current + MIN_REFRESH_GAP_MS - Date.now();
    if (wait > 0) {
      if (timerRef.current === undefined) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = undefined;
          refresh();
        }, wait);
      }
      return;
    }
    inFlightRef.current = true;
    lastStartRef.current = Date.now();
    Promise.resolve()
      .then(() => load(id))
      .then((snapshot) => {
        if (sessionIdRef.current !== id || snapshot.sessionId !== id) return;
        setStatus(snapshot);
      })
      // A background reading keeps its last value; the panel reports errors.
      .catch(() => undefined)
      .finally(() => {
        inFlightRef.current = false;
        if (pendingRef.current) {
          pendingRef.current = false;
          refresh();
        }
      });
  }, []);

  // Declared before the refresh effect so a new session starts empty and
  // reads at once.
  useEffect(() => {
    setStatus(null);
    lastStartRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [sessionId, refreshSignal, running, refresh]);

  useEffect(() => {
    if (!running) return undefined;
    const interval = window.setInterval(refresh, RUNNING_POLL_MS);
    return () => window.clearInterval(interval);
  }, [running, refresh]);

  useEffect(() => {
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [refresh]);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  if (!status || status.sessionId !== sessionId) return null;
  const totals = summarizeSessionUsage(status);
  if (totals.total <= 0) return null;

  const speed = outputSpeed(totals.generation, totals.legacySpeed);
  const speedText =
    speed !== undefined
      ? t('tokenUsage.tokensPerSecond', { rate: formatSpeed(speed) })
      : undefined;
  const turnsText =
    status.promptCount > 0
      ? t('tokenUsage.bar.turns', { count: status.promptCount })
      : undefined;
  const cachePercent = formatCacheHitPercent(totals.cached, totals.prompt);
  const cacheText =
    cachePercent !== undefined
      ? t('tokenUsage.bar.cacheHit', { percent: cachePercent })
      : undefined;
  const tokensText = t('tokenUsage.bar.tokens', {
    count: formatCompact(totals.total),
  });

  const activity = [turnsText, speedText].filter(
    (part): part is string => !!part,
  );
  const usage = [tokensText, cacheText].filter(
    (part): part is string => !!part,
  );
  const reading = [...activity, ...usage].join(' · ');
  const detail = t('tokenUsage.bar.detailTokens', {
    total: formatCompact(totals.total),
    input: formatCompact(totals.prompt),
    cached: formatCompact(totals.cached),
    output: formatCompact(totals.output),
  });

  return (
    <div className={styles.bar} data-web-shell-composer-usage>
      <button
        type="button"
        className={styles.reading}
        onClick={onOpen}
        disabled={!onOpen}
        aria-label={`${reading}. ${t('tokenUsage.open')}`}
        title={detail}
      >
        {activity.length > 0 && (
          <span className={styles.group} data-stat="activity">
            <GaugeIcon
              className={styles.icon}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <Segments parts={activity} />
          </span>
        )}
        <span className={styles.group} data-stat="usage">
          <DatabaseIcon
            className={styles.icon}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <Segments parts={usage} />
        </span>
      </button>
    </div>
  );
}

function Segments({ parts }: { parts: string[] }) {
  return (
    <span className={styles.text}>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && (
            <span className={styles.separator} aria-hidden="true">
              ·
            </span>
          )}
          {part}
        </span>
      ))}
    </span>
  );
}
