/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonAutofixPrWatch } from '../../daemon/workspace/types';
import { useI18n } from '../../i18n';
import { watchPhase } from '../../utils/autofixPrWatches';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import styles from './AutofixPrWatchSummary.module.css';

interface AutofixPrWatchSummaryProps {
  watch: DaemonAutofixPrWatch;
  /** The scheduled task showing it no longer drives the watch. */
  stale?: boolean;
  /** Show the PR as a link heading (the PR watches page); a scheduled-task
   * card names it in its own title. */
  showPr?: boolean;
  /** Open the session that owns the watch; absent when it is no session of
   * this Web Shell. */
  onOpenSession?: () => void;
  /** Run `/autofix-pr stop <n>` in the session that owns the watch; absent
   * when it is no session of this Web Shell. */
  onStop?: () => void;
  stopping?: boolean;
  /** Its session is no session of this Web Shell: say where to stop it. */
  outsideDaemon?: boolean;
}

const MINUTE_MS = 60_000;

/**
 * One watch's state, as `qwen autofix-pr status` reports it: where the watch
 * is, its pushes and last check, and the items left for a person. Shared by
 * the scheduled-task card of a watch and the PR watches page.
 */
export function AutofixPrWatchSummary({
  watch,
  stale = false,
  showPr = false,
  onOpenSession,
  onStop,
  stopping = false,
  outsideDaemon = false,
}: AutofixPrWatchSummaryProps) {
  const { t } = useI18n();
  const phase = watchPhase(watch);
  const phaseText = (() => {
    switch (phase) {
      case 'merged':
        return t('autofixPrWatches.phase.merged');
      case 'closed':
        return t('autofixPrWatches.phase.closed');
      case 'ended':
        return t('autofixPrWatches.phase.ended', {
          reason: watch.ended?.reason ?? '',
        });
      case 'unscheduled':
        return t('autofixPrWatches.phase.unscheduled');
      case 'fixing': {
        const started = watch.fix?.startedAt
          ? Date.parse(watch.fix.startedAt)
          : NaN;
        return Number.isNaN(started)
          ? t('autofixPrWatches.phase.fixingStarting')
          : t('autofixPrWatches.phase.fixing', {
              minutes: Math.max(
                0,
                Math.floor((Date.now() - started) / MINUTE_MS),
              ),
            });
      }
      case 'abandonedFix':
        return t('autofixPrWatches.phase.abandonedFix');
      case 'watching':
        return t('autofixPrWatches.phase.watching');
      case 'idle':
        return t('autofixPrWatches.phase.idle');
    }
  })();
  const facts = [
    t('autofixPrWatches.pushes', {
      count: watch.pushes,
      max: watch.maxPushes,
    }),
    watch.lastCheck
      ? t('autofixPrWatches.lastCheck', {
          when: formatRelativeTime(watch.lastCheck, t),
        })
      : t('autofixPrWatches.neverChecked'),
    ...(watch.lastRound
      ? [
          t('autofixPrWatches.lastRound', {
            when: formatRelativeTime(watch.lastRound, t),
          }),
        ]
      : []),
  ];

  return (
    <div className={styles.summary} data-testid="autofix-pr-watch">
      <div className={styles.headline}>
        {showPr && (
          <a
            className={styles.prLink}
            href={watch.url}
            target="_blank"
            rel="noreferrer noopener"
            title={watch.url}
          >
            {watch.repo}#{watch.pr}
          </a>
        )}
        <span
          className={`${styles.phase} ${styles[`phase_${phase}`] ?? ''}`}
          data-phase={phase}
        >
          {phaseText}
        </span>
        <span className={styles.facts}>{facts.join(' · ')}</span>
      </div>
      {stale && (
        <div className={styles.stale}>{t('autofixPrWatches.staleTask')}</div>
      )}
      {watch.needsHuman.length > 0 && (
        <details className={styles.needsHuman}>
          <summary>
            {t('autofixPrWatches.needsHuman', {
              count: watch.needsHuman.length,
            })}
          </summary>
          <ul>
            {watch.needsHuman.map((item, index) => (
              <li key={`${item.at}:${index}`} title={item.at}>
                {item.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(onOpenSession || onStop) && (
        <div className={styles.actions}>
          {onOpenSession && (
            <button
              type="button"
              className={styles.action}
              onClick={onOpenSession}
            >
              {t('autofixPrWatches.openSession')}
            </button>
          )}
          {onStop && (
            <button
              type="button"
              className={styles.action}
              onClick={onStop}
              disabled={stopping}
              title={t('autofixPrWatches.stopHint', { pr: watch.pr })}
            >
              {t('autofixPrWatches.stop')}
            </button>
          )}
        </div>
      )}
      {outsideDaemon && (
        <div className={styles.hint}>{t('autofixPrWatches.outsideDaemon')}</div>
      )}
    </div>
  );
}
