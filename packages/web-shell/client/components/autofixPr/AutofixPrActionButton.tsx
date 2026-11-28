/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  EyeIcon,
  RotateCwIcon,
  WrenchIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  buildAutofixPrRestartCommand,
  buildAutofixPrStartCommand,
  findWatchForPr,
  isPrOpenForAutofix,
  isWatchActivePhase,
  nonEmptyCwd,
  parseAutofixPrInput,
  resumeCommand,
} from '../../utils/autofixPrWatches';
import {
  isAutofixWatchStateReady,
  useAutofixPrOptional,
} from './AutofixPrContext';
import styles from './AutofixPrActionButton.module.css';

export interface AutofixPrActionButtonProps {
  prNumber: number;
  prUrl: string;
  prState?: string;
  workspaceCwd?: string;
  /** Highlight unwatched open PRs that already need attention (e.g. failing CI). */
  prominent?: boolean;
  /** Slightly tighter padding for dense hover tooltips. */
  compact?: boolean;
  tabIndex?: number;
  /** Called immediately when the user activates the button (e.g. close popover/dialog). */
  onTriggered?: () => void;
}

/**
 * State-aware `/autofix-pr` trigger shared by PR list surfaces:
 * - active watch → status pill that jumps to the watch session / PR watches page
 * - idle watch → Resume button running `/autofix-pr resume <n>`
 * - unwatched or ended open PR → Autofix button running `/autofix-pr <url>`
 */
export function AutofixPrActionButton({
  prNumber,
  prUrl,
  prState,
  workspaceCwd,
  prominent = false,
  compact = false,
  tabIndex,
  onTriggered,
}: AutofixPrActionButtonProps) {
  const ctx = useAutofixPrOptional();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  if (!ctx || !isPrOpenForAutofix(prState)) return null;
  const parsedPrUrl = parseAutofixPrInput(prUrl);
  if (!parsedPrUrl || parsedPrUrl.kind !== 'url') return null;
  const canonicalPrUrl = parsedPrUrl.url;

  const entry = findWatchForPr(ctx.watchIndex, canonicalPrUrl);
  const surfaceCwd = nonEmptyCwd(workspaceCwd);
  const watchCwd = nonEmptyCwd(entry?.workspaceCwd);

  const runAction = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    onTriggered?.();
    void work()
      .catch(() => undefined)
      .finally(() => {
        if (aliveRef.current) setBusy(false);
      });
  };

  if (entry && isWatchActivePhase(entry.phase)) {
    const needsHumanCount = entry.needsHumanCount;
    let toneClass = styles.watching;
    let label = t('autofixPr.action.watching');
    let Icon = EyeIcon;
    if (needsHumanCount > 0) {
      toneClass = styles.attention;
      label = t('autofixPr.action.needsHuman', { count: needsHumanCount });
      Icon = AlertCircleIcon;
    } else if (entry.phase === 'fixing') {
      toneClass = styles.fixing;
      label = t('autofixPr.action.fixing');
      Icon = WrenchIcon;
    } else if (entry.phase === 'abandonedFix') {
      toneClass = styles.attention;
      label = t('autofixPr.action.retrying');
      Icon = RotateCwIcon;
    }
    const hint = t('autofixPr.action.openWatchHint', { number: prNumber });
    return (
      <button
        type="button"
        tabIndex={tabIndex}
        disabled={busy}
        className={`${styles.button} ${toneClass}${compact ? ` ${styles.compact}` : ''}`}
        data-testid="autofix-pr-action"
        data-autofix-pr-state={needsHumanCount > 0 ? 'needsHuman' : entry.phase}
        aria-label={`${label} — ${hint}`}
        title={hint}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          runAction(() => ctx.openWatch(entry));
        }}
      >
        <Icon className={styles.icon} aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  }

  // Live watch state knows the PR was merged/closed even when the session's
  // cached PR state is stale or absent.
  if (entry && (entry.phase === 'merged' || entry.phase === 'closed')) {
    return null;
  }

  if (entry && entry.phase === 'idle') {
    const resumeCwd = watchCwd ?? surfaceCwd;
    if (!ctx.canStartInWorkspace(resumeCwd)) return null;
    const label = t('autofixPr.action.resume');
    const hint = t('autofixPr.action.resumeHint', { number: prNumber });
    return (
      <button
        type="button"
        tabIndex={tabIndex}
        disabled={busy}
        className={`${styles.button} ${styles.attention}${compact ? ` ${styles.compact}` : ''}`}
        data-testid="autofix-pr-action"
        data-autofix-pr-state="idle"
        aria-label={`${label} PR #${prNumber}`}
        title={hint}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          runAction(() =>
            ctx.startInNewSession({
              prompt: resumeCommand(entry.watch),
              workspaceCwd: resumeCwd,
              sessionTitle: t('autofixPr.sessionTitle', { number: prNumber }),
            }),
          );
        }}
      >
        <RotateCwIcon className={styles.icon} aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  }

  const startCwd = entry ? (watchCwd ?? surfaceCwd) : surfaceCwd;
  if (!entry && !isAutofixWatchStateReady(ctx, startCwd)) return null;
  if (!ctx.canStartInWorkspace(startCwd)) return null;

  const startPrompt = entry
    ? buildAutofixPrRestartCommand({
        pr: entry.watch.pr,
        url: entry.watch.url || canonicalPrUrl,
        inPlace: entry.watch.inPlace,
      })
    : buildAutofixPrStartCommand({ pr: canonicalPrUrl });

  const label = t('autofixPr.action.start');
  const hint = t('autofixPr.action.startHint', { number: prNumber });
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      disabled={busy}
      className={`${styles.button}${prominent ? ` ${styles.prominent}` : ''}${compact ? ` ${styles.compact}` : ''}`}
      data-testid="autofix-pr-action"
      data-autofix-pr-state="start"
      aria-label={`${label} PR #${prNumber}`}
      title={hint}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        runAction(() =>
          ctx.startInNewSession({
            prompt: startPrompt,
            workspaceCwd: startCwd,
            sessionTitle: t('autofixPr.sessionTitle', { number: prNumber }),
          }),
        );
      }}
    >
      <WrenchIcon className={styles.icon} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
