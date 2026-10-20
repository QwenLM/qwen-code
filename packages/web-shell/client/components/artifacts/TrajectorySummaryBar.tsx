/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CircleXIcon,
  ClockIcon,
  InfoIcon,
  LoaderCircleIcon,
  PauseIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import type { TrajectorySummary } from '../../trajectory/summarizeTrajectory';
import {
  isRetryableFailure,
  type TrajectoryPillState,
  type TrajectoryWarning,
} from '../../trajectory/trajectory-status';
import type { TrajectoryWindowFailure } from '../../trajectory/useTrajectoryWindow';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import styles from './TrajectorySummaryBar.module.css';

/** Same rounding as the table: 999,950 tokens already reads as `1.0M`. */
export function compactTokens(value: number): string {
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export interface TrajectoryAboutInfo {
  pages: number;
  searchExcluded: number;
  executionsOmitted: number;
  executionsOutside: number;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

function failureText(failure: TrajectoryWindowFailure, t: Translate): string {
  if (failure.kind === 'partial') return t('trajectory.partial');
  if (failure.kind === 'unreadable')
    return t('trajectory.loadFailed', { message: failure.message });
  return t(`trajectory.window.${failure.kind}`);
}

/**
 * One line above the strip: what the loaded records add up to, whether the
 * panel is following the session, and anything that needs attention. Every
 * caveat about scope lives behind the About button rather than on screen.
 */
export function TrajectorySummaryBar({
  summary,
  pill,
  onPill,
  warnings,
  onRetry,
  onRefresh,
  onReturnToLatest,
  canRefresh,
  failuresOn,
  onToggleFailures,
  about,
}: {
  summary?: TrajectorySummary;
  pill: TrajectoryPillState;
  onPill: () => void;
  warnings: readonly TrajectoryWarning[];
  onRetry: () => void;
  onRefresh: () => void;
  onReturnToLatest: () => void;
  canRefresh: boolean;
  failuresOn: boolean;
  onToggleFailures: () => void;
  about: TrajectoryAboutInfo;
}) {
  const { t, language } = useI18n();
  const labelFirst = language.startsWith('zh');
  const failures = summary ? summary.requestFailures + summary.toolFailures : 0;
  const duration = (value: number | undefined) =>
    value === undefined ? '—' : formatDuration(value);
  const stat = (label: string, value: string, headline = false) => {
    const valueNode = (
      <strong className={headline ? styles.headline : styles.value}>
        {value}
      </strong>
    );
    const labelNode = <span className={styles.label}>{label}</span>;
    return labelFirst ? (
      <>
        {labelNode}
        {valueNode}
      </>
    ) : (
      <>
        {valueNode}
        {labelNode}
      </>
    );
  };

  return (
    <div className={styles.bar}>
      <div
        className={styles.stats}
        data-testid="trajectory-metrics"
        title={t('trajectory.about')}
      >
        <span className={styles.stat}>
          {stat(
            t('trajectory.summary.elapsed'),
            duration(summary?.elapsedMs),
            true,
          )}
        </span>
        <span className={styles.stat}>
          {stat(t('trajectory.summary.active'), duration(summary?.activeMs))}
        </span>
        <span className={`${styles.stat} ${styles.wide}`}>
          {stat(
            t('trajectory.summary.model'),
            duration(summary?.mainRequestMs),
          )}
        </span>
        <span
          className={`${styles.stat} ${styles.wide}`}
          data-testid="trajectory-totals"
        >
          <span className={styles.value}>
            {t('trajectory.summary.requests', {
              count: summary?.requestCount ?? 0,
            })}
          </span>
          <span className={styles.value}>
            {t('trajectory.summary.tools', { count: summary?.toolCount ?? 0 })}
          </span>
        </span>
        {summary?.tokens && (
          <span className={`${styles.stat} ${styles.wide}`}>
            {stat(
              t('trajectory.summary.tokens'),
              `${compactTokens(summary.tokens.input)} → ${compactTokens(summary.tokens.output)}`,
            )}
          </span>
        )}
      </div>
      <div className={styles.actions}>
        {warnings.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`${styles.chip} ${styles.warn}`}
                aria-label={t('trajectory.warnings')}
                title={t('trajectory.warnings')}
                data-testid="trajectory-warnings"
              >
                <TriangleAlertIcon size={13} aria-hidden="true" />
                {warnings.length > 1 && <span>{warnings.length}</span>}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className={styles.popover}>
              <ul className={styles.warningList}>
                {warnings.map((warning) => (
                  <li key={warning.kind}>
                    <WarningItem
                      warning={warning}
                      onRetry={onRetry}
                      onRefresh={onRefresh}
                      onReturnToLatest={onReturnToLatest}
                      canRefresh={canRefresh}
                    />
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}
        {failures > 0 && (
          <button
            type="button"
            className={`${styles.chip} ${styles.failed}`}
            aria-pressed={failuresOn}
            title={t('trajectory.summary.failedFilter')}
            onClick={onToggleFailures}
            data-testid="trajectory-failures"
          >
            <CircleXIcon size={13} aria-hidden="true" />
            {t('trajectory.summary.failed', { count: failures })}
          </button>
        )}
        <StatusPill state={pill} onClick={onPill} />
        <button
          type="button"
          className={styles.iconButton}
          onClick={onRefresh}
          disabled={!canRefresh}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
        >
          <RefreshCwIcon size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t('trajectory.about')}
              title={t('trajectory.about')}
              data-testid="trajectory-about"
            >
              <InfoIcon size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className={styles.popover}>
            <AboutContent summary={summary} about={about} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function StatusPill({
  state,
  onClick,
}: {
  state: TrajectoryPillState;
  onClick: () => void;
}) {
  const { t } = useI18n();
  if (state === 'none') return null;
  const actionable =
    state === 'live' || state === 'paused' || state === 'history';
  const label = t(`trajectory.pill.${state}`);
  const action =
    state === 'live'
      ? t('trajectory.pill.pause')
      : actionable
        ? t('trajectory.pill.resume')
        : undefined;
  return (
    <button
      type="button"
      className={styles.chip}
      data-state={state}
      aria-disabled={!actionable}
      aria-label={action ? `${label} · ${action}` : label}
      title={action}
      onClick={() => {
        if (actionable) onClick();
      }}
      data-testid="trajectory-follow-status"
    >
      {state === 'live' ? (
        <span className={styles.pulse} aria-hidden="true" />
      ) : state === 'paused' ? (
        <PauseIcon size={12} aria-hidden="true" />
      ) : state === 'history' ? (
        <ClockIcon size={12} aria-hidden="true" />
      ) : (
        <LoaderCircleIcon
          size={12}
          className={styles.spin}
          aria-hidden="true"
        />
      )}
      <span>{label}</span>
    </button>
  );
}

function WarningItem({
  warning,
  onRetry,
  onRefresh,
  onReturnToLatest,
  canRefresh,
}: {
  warning: TrajectoryWarning;
  onRetry: () => void;
  onRefresh: () => void;
  onReturnToLatest: () => void;
  canRefresh: boolean;
}) {
  const { t } = useI18n();
  switch (warning.kind) {
    case 'refresh-failed':
    case 'navigation-failed':
      return (
        <>
          <p>
            {t(
              warning.kind === 'refresh-failed'
                ? 'trajectory.refreshStale'
                : 'trajectory.window.failed',
            )}{' '}
            {failureText(warning.failure, t)}
          </p>
          <div className={styles.popoverActions}>
            {isRetryableFailure(warning.failure) ? (
              <button type="button" className={styles.action} onClick={onRetry}>
                {t('common.retry')}
              </button>
            ) : (
              <button
                type="button"
                className={styles.action}
                disabled={!canRefresh}
                onClick={onReturnToLatest}
              >
                {t('trajectory.window.return')}
              </button>
            )}
          </div>
        </>
      );
    case 'history-gap':
      return (
        <>
          <p>{t('trajectory.historyGap')}</p>
          <div className={styles.popoverActions}>
            <button
              type="button"
              className={styles.action}
              disabled={!canRefresh}
              onClick={onRefresh}
            >
              {t('common.refresh')}
            </button>
          </div>
        </>
      );
    case 'lifecycle-incomplete':
      return <p>{t('trajectory.lifecycleIncomplete')}</p>;
  }
}

function AboutContent({
  summary,
  about,
}: {
  summary?: TrajectorySummary;
  about: TrajectoryAboutInfo;
}) {
  const { t } = useI18n();
  const notes = [
    summary && (summary.missingStartCount > 0 || summary.missingTimingCount > 0)
      ? t('trajectory.unplotted', {
          starts: summary.missingStartCount,
          timing: summary.missingTimingCount,
        })
      : '',
    about.searchExcluded > 0
      ? t('trajectory.filter.truncated', { count: about.searchExcluded })
      : '',
    about.executionsOutside > 0
      ? t('trajectory.executions.outside', { count: about.executionsOutside })
      : '',
    about.executionsOmitted > 0
      ? t('trajectory.executions.omitted', { count: about.executionsOmitted })
      : '',
  ].filter(Boolean);
  return (
    <div className={styles.about}>
      <h4>{t('trajectory.about')}</h4>
      <p>
        {t('trajectory.about.scope', {
          pages: about.pages,
          turns: summary?.turnCount ?? 0,
        })}
      </p>
      <p>{t('trajectory.metric.elapsed.help')}</p>
      <p>{t('trajectory.metric.active.help')}</p>
      <p>{t('trajectory.metric.main.help')}</p>
      <p>{t('trajectory.about.tokens')}</p>
      <p>{t('trajectory.about.numbering')}</p>
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      <p>{t('trajectory.metric.missing.help')}</p>
    </div>
  );
}
