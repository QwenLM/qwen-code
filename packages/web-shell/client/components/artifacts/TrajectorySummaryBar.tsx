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
  trajectoryFailureText,
  type TrajectoryPillState,
  type TrajectoryWarning,
} from '../../trajectory/trajectory-status';
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
  history,
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
  /** An earlier window is on screen: a refresh would leave it for the latest. */
  history: boolean;
  failuresOn: boolean;
  onToggleFailures: () => void;
  about: TrajectoryAboutInfo;
}) {
  const { t, language } = useI18n();
  const labelFirst = language.startsWith('zh');
  const failures = summary ? summary.requestFailures + summary.toolFailures : 0;
  // A read that just failed leaves the records as they were, so the chip alone
  // would go unnoticed; it is also announced.
  const failureAlert = warnings
    .map((warning) =>
      warning.kind === 'refresh-failed' || warning.kind === 'navigation-failed'
        ? trajectoryFailureText(warning.failure, t)
        : '',
    )
    .filter(Boolean)
    .join(' ');
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
        {failureAlert && (
          <div
            className={styles.srOnly}
            role="alert"
            data-testid="trajectory-failure-alert"
          >
            {failureAlert}
          </div>
        )}
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
                      history={history}
                    />
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}
        {/* Kept while the filter is on, so a window without failures still
            shows the control that turns it off. */}
        {(failures > 0 || failuresOn) && (
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
          onClick={() => {
            if (canRefresh) onRefresh();
          }}
          // A read in progress only marks it busy: `disabled` would drop the
          // focus of a reader who just pressed it. An earlier window has
          // nothing to refresh at all.
          disabled={history}
          aria-disabled={!canRefresh}
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
  const label = t(`trajectory.pill.${state}`);
  // While following, connecting or on the way back to the latest records, the
  // pill pauses; otherwise it returns to the latest.
  const action =
    state === 'paused' || state === 'history'
      ? t('trajectory.pill.resume')
      : t('trajectory.pill.pause');
  return (
    <button
      type="button"
      className={styles.chip}
      data-state={state}
      aria-label={`${label} · ${action}`}
      title={action}
      onClick={onClick}
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
  history,
}: {
  warning: TrajectoryWarning;
  onRetry: () => void;
  onRefresh: () => void;
  onReturnToLatest: () => void;
  canRefresh: boolean;
  history: boolean;
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
            {trajectoryFailureText(warning.failure, t)}
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
              onClick={history ? onReturnToLatest : onRefresh}
            >
              {t(history ? 'trajectory.window.return' : 'common.refresh')}
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
