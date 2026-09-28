/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

import { Markdown } from '../messages/Markdown';
import { useI18n } from '../../i18n';
import {
  formatElapsed,
  triggerLabel,
  type RunRow,
  type RunView,
} from './agents-view-logic';
import styles from './ThreadView.module.css';

export interface ThreadPostView {
  sourceRunId?: string;
  id: string;
  sequence: number;
  authorKind: 'human' | 'agent' | 'system';
  authorName: string;
  authorDeleted?: boolean;
  text: string;
  at: number;
  outcomes?: readonly {
    agentName?: string;
    kind: 'dispatch' | 'coalesce' | 'skip';
    reason?: string;
    into?: 'queued' | 'running';
  }[];
}

export interface ThreadDetailView {
  id: string;
  title: string;
  body: string;
  /** What "done" means here, in the author's words. */
  acceptanceCriteria?: string;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  parent?: { id: string; title: string };
  assigneeName?: string;
  status:
    | 'open'
    | 'in_progress'
    | 'blocked'
    | 'in_review'
    | 'done'
    | 'cancelled';
  /** The resolver's sentence. Rendered verbatim. */
  reason: string;
  posts: readonly ThreadPostView[];
  runs: readonly RunView[];
  children?: readonly ThreadChildView[];
  budget: {
    turnsUsed: number;
    turnLimit: number;
    tokensUsed: number;
    tokenLimit: number;
  };
}

export interface ThreadChildView {
  id: string;
  title: string;
  status: ThreadDetailView['status'];
  reason: string;
  assigneeName?: string;
}

const RUN_STAGES = new Set([
  'starting',
  'resuming',
  'waiting',
  'thinking',
  'tool',
  'responding',
]);

/**
 * One run: its state, how long it has gone, and what it is doing, with the
 * thinking and output so far folded under it. Under a member in the Team
 * panel the member row already names the agent, so `hideAgent` drops it.
 */
export function RunRowView({
  row,
  agent,
  hideAgent = false,
  onOpenAgentSession,
  onCancelRun,
}: {
  row: RunRow;
  agent?: { status?: string; runtime?: { label: string; status: string } };
  hideAgent?: boolean;
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun?: (runId: string) => void;
}) {
  const { t } = useI18n();
  const sessionId = row.run.sessionId;
  const progress = row.run.progress;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!row.live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [row.live]);
  // Liveness is judged by the agent's own activity, not by when the last
  // snapshot arrived: a long tool call writes nothing and is still working.
  const quiet = progress && now - progress.activityAt > 15000;
  const state =
    row.run.status === 'queued'
      ? agent?.status === 'offline' || agent?.runtime?.status === 'offline'
        ? t('collab.runRow.hostOffline', { host: agent.runtime?.label ?? '' })
        : t('collab.runRow.queued')
      : row.run.status === 'running'
        ? progress
          ? progress.stage === 'awaiting_approval'
            ? t('collab.runRow.stage.awaiting_approval')
            : quiet
              ? t('collab.runRow.quiet')
              : RUN_STAGES.has(progress.stage)
                ? t(`collab.runRow.stage.${progress.stage}`)
                : t('collab.runRow.working')
          : t('collab.runRow.unconfirmed')
        : row.state;
  const stateClass = row.outstanding
    ? `${styles.runState} ${styles.runStateOutstanding}`
    : row.live
      ? `${styles.runState} ${styles.runStateLive}`
      : styles.runState;
  return (
    <div className={styles.runRow} data-compact={hideAgent || undefined}>
      {hideAgent ? null : (
        <span className={styles.runAgent}>{row.run.agentName}</span>
      )}
      <span className={stateClass}>
        {state}
        {row.live && row.run.status !== 'cancelling' && onCancelRun ? (
          <button
            type="button"
            className={styles.runCancel}
            onClick={() => onCancelRun(row.run.id)}
          >
            {t('collab.runRow.cancel')}
          </button>
        ) : null}
      </span>
      {row.live && (
        <div className={styles.runProgress} role="status">
          {row.run.startedAt && (
            <div>
              {t('collab.runRow.elapsed', {
                elapsed: formatElapsed(now - row.run.startedAt, t),
              })}
            </div>
          )}
          {progress ? (
            <div>
              {t('collab.runRow.lastActivity', {
                elapsed: formatElapsed(now - progress.activityAt, t),
              })}
            </div>
          ) : (
            <div>
              {row.run.status === 'queued'
                ? t('collab.runRow.queuedHint')
                : t('collab.runRow.unconfirmedHint')}
            </div>
          )}
        </div>
      )}
      {progress?.detail && (
        <details className={styles.runProgress} open={row.live}>
          <summary>{t('collab.runRow.activity')}</summary>
          <div>{progress.detail}</div>
        </details>
      )}
      {progress?.thoughtText && (
        <details className={styles.runProgress} open={row.live}>
          <summary>{t('collab.runRow.thinking')}</summary>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
            {progress.thoughtText}
          </div>
          {progress.thoughtText.length >= 65536 && (
            <p>{t('collab.runRow.thinkingCap')}</p>
          )}
        </details>
      )}
      {progress?.outputText && (
        <details className={styles.runProgress}>
          <summary>{t('collab.runRow.output')}</summary>
          <Markdown
            content={progress.outputText}
            isStreaming={row.run.status === 'running'}
          />
          {progress.outputText.length >= 262144 && (
            <p>{t('collab.runRow.outputCap')}</p>
          )}
        </details>
      )}
      <span className={styles.runTrigger}>
        {triggerLabel(row.run.trigger, t)}
        {sessionId && onOpenAgentSession ? (
          <>
            {' · '}
            <button
              type="button"
              className={styles.runLink}
              onClick={() => onOpenAgentSession(sessionId)}
            >
              {t('collab.runRow.openSession', { agent: row.run.agentName })}
            </button>
          </>
        ) : null}
      </span>
      {row.run.error ? (
        <span className={styles.runError}>
          {row.run.error === 'agent_run_stalled'
            ? t('collab.runRow.stalled')
            : row.run.error === 'agent_program_unavailable'
              ? t('collab.runRow.programUnavailable')
              : row.run.error}
        </span>
      ) : null}
    </div>
  );
}
