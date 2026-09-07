/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from 'react';
import { ArrowLeftIcon } from 'lucide-react';

import { Button } from '../ui/button';
import {
  buildRunRows,
  explainSkip,
  formatBudget,
  summarizePreview,
  type RoutingPreviewTarget,
  type RunRow,
  type RunView,
} from './agents-view-logic';
import styles from './ThreadView.module.css';

export interface ThreadPostView {
  id: string;
  sequence: number;
  authorKind: 'human' | 'agent' | 'system';
  authorName: string;
  authorDeleted?: boolean;
  text: string;
  at: number;
}

export interface ThreadDetailView {
  id: string;
  title: string;
  body: string;
  /** What "done" means here, in the author's words. */
  acceptanceCriteria?: string;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  assigneeName?: string;
  status: 'open' | 'in_progress' | 'blocked' | 'in_review' | 'done';
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
}

export interface TranscriptSliceView {
  runId: string;
  agentName: string;
  startOffset: number;
  endOffset: number;
  content: string;
}

export interface ThreadViewProps {
  thread: ThreadDetailView;
  agents: readonly {
    name: string;
    enabled: boolean;
    /** Retired identities stay in the list and are never offered new work. */
    retiredAt?: number;
  }[];
  /** Server-computed routing for the current draft. */
  preview?: readonly RoutingPreviewTarget[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onReply: () => void;
  onBack: () => void;
  onOpenThread?: (threadId: string) => void;
  onOpenTranscript: (runId: string) => void;
  onCloseTranscript?: () => void;
  /**
   * Opens the agent session a run ran in. Absent where the shell has no
   * session view to switch to, which is why every use of it is guarded.
   */
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun?: (runId: string) => void;
  onMarkDone?: () => void;
  onAssign?: (assignee?: string) => void;
  transcript?: TranscriptSliceView;
  replyPending?: boolean;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function RunRowView({
  row,
  onOpenTranscript,
  onOpenAgentSession,
  onCancelRun,
}: {
  row: RunRow;
  onOpenTranscript: (runId: string) => void;
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun?: (runId: string) => void;
}) {
  const sessionId = row.run.sessionId;
  const stateClass = row.outstanding
    ? `${styles.runState} ${styles.runStateOutstanding}`
    : row.live
      ? `${styles.runState} ${styles.runStateLive}`
      : styles.runState;
  return (
    <div
      className={styles.runRow}
      style={
        row.run.agentColor
          ? { borderInlineStartColor: row.run.agentColor }
          : undefined
      }
    >
      <span className={styles.runAgent}>{row.run.agentName}</span>
      <span className={stateClass}>
        {row.state}
        {row.live && row.run.status !== 'cancelling' && onCancelRun ? (
          <button
            type="button"
            className={styles.runCancel}
            onClick={() => onCancelRun(row.run.id)}
          >
            Cancel
          </button>
        ) : null}
      </span>
      <span className={styles.runTrigger}>
        {row.run.trigger}
        {row.run.hasTranscriptSlice ? (
          <>
            {' · '}
            <button
              type="button"
              className={styles.runLink}
              onClick={() => onOpenTranscript(row.run.id)}
            >
              transcript
            </button>
          </>
        ) : null}
        {sessionId && onOpenAgentSession ? (
          <>
            {' · '}
            <button
              type="button"
              className={styles.runLink}
              onClick={() => onOpenAgentSession(sessionId)}
            >
              open {row.run.agentName}&rsquo;s session
            </button>
          </>
        ) : null}
      </span>
      {row.run.error ? (
        <span className={styles.runError}>{row.run.error}</span>
      ) : null}
    </div>
  );
}

function TranscriptPanel({
  transcript,
  onClose,
}: {
  transcript: TranscriptSliceView;
  onClose: () => void;
}) {
  return (
    <aside className={styles.transcriptPanel}>
      <div className={styles.transcriptHeader}>
        <strong>
          run {transcript.runId} · {transcript.agentName} · this thread only
        </strong>
        <button type="button" className={styles.runLink} onClick={onClose}>
          Close
        </button>
      </div>
      <pre className={styles.transcriptContent}>{transcript.content}</pre>
    </aside>
  );
}

/**
 * Previews what pressing send will actually do.
 *
 * The rules are a pure function on the server, so this is the real outcome
 * rather than a guess: who will be woken, who will not, and the fix for each
 * refusal. The case worth designing for is "nobody" — that is the one the
 * system used to swallow silently, so it is the headline when it happens.
 */
function RoutingPreview({
  targets,
}: {
  targets: readonly RoutingPreviewTarget[];
}) {
  const lead = summarizePreview(targets);
  const nobody = !targets.some((target) => target.willWake);
  return (
    <div className={styles.preview}>
      <p
        className={
          nobody
            ? `${styles.previewLead} ${styles.previewLeadNobody}`
            : styles.previewLead
        }
      >
        {lead}
      </p>
      {targets
        .filter((target) => !target.willWake)
        .map((target) => {
          const explained = explainSkip(target.reason ?? '', target.agentName);
          return (
            <p
              key={`${target.agentName}:${target.reason ?? 'unknown'}`}
              className={`${styles.previewTarget} ${
                target.unknown ? styles.previewUnknown : styles.previewSkip
              }`}
            >
              <span className={styles.previewName}>@{target.agentName}</span>
              <span>
                {explained.what}. {explained.fix}
              </span>
            </p>
          );
        })}
    </div>
  );
}

/**
 * A thread as a ledger of outstanding obligations, with the conversation as
 * the evidence underneath it.
 *
 * A chat log with a status badge is the obvious shape, and it would hide what
 * this system knows that a chat app does not: who owes what, and what the
 * thread is waiting on. So the header is the resolver's sentence, and every
 * run carries its close obligation where a task list would carry a status.
 */
export function ThreadView({
  thread,
  agents,
  preview,
  draft,
  onDraftChange,
  onReply,
  onBack,
  onOpenThread,
  onOpenTranscript,
  onCloseTranscript,
  onOpenAgentSession,
  onCancelRun,
  onMarkDone,
  onAssign,
  transcript,
  replyPending,
}: ThreadViewProps) {
  const { live, past } = useMemo(
    () => buildRunRows(thread.runs),
    [thread.runs],
  );
  const [showPast, setShowPast] = useState(false);
  const budget = useMemo(() => formatBudget(thread.budget), [thread.budget]);
  const attention =
    thread.status === 'blocked' || thread.status === 'in_review';
  const active = live.find((row) => row.run.status !== 'queued') ?? live[0];
  const currentAssignee = agents.find(
    (agent) => agent.name === thread.assigneeName,
  );

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <Button
          variant="ghost"
          size="icon"
          className={styles.backButton}
          onClick={onBack}
          aria-label="Back to threads"
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className={styles.title}>{thread.title}</h1>
        <span className={styles.threadId}>{thread.id}</span>
        {onAssign ? (
          <select
            className={styles.assigneeSelect}
            value={thread.assigneeName ?? ''}
            onChange={(event) => onAssign(event.target.value || undefined)}
            disabled={thread.status === 'done' || replyPending}
            aria-label="Thread assignee"
          >
            <option value="">No assignee</option>
            {thread.assigneeName &&
            (!currentAssignee?.enabled || currentAssignee?.retiredAt) ? (
              // The thread keeps naming whoever it was assigned to, and says
              // in what way they are unavailable rather than dropping them.
              <option value={thread.assigneeName}>
                {thread.assigneeName}{' '}
                {currentAssignee?.retiredAt
                  ? '(retired)'
                  : currentAssignee
                    ? '(disabled)'
                    : '(removed)'}
              </option>
            ) : null}
            {agents
              .filter((agent) => agent.enabled && !agent.retiredAt)
              .map((agent) => (
                <option key={agent.name} value={agent.name}>
                  {agent.name}
                </option>
              ))}
          </select>
        ) : null}
        {thread.priority && thread.priority !== 'normal' ? (
          // Only when it is not the default: a chip on every thread saying
          // "Normal" would be a label where no decision was made.
          <span
            className={
              thread.priority === 'urgent'
                ? `${styles.priorityChip} ${styles.priorityUrgent}`
                : styles.priorityChip
            }
          >
            {thread.priority === 'urgent'
              ? 'Urgent'
              : thread.priority === 'high'
                ? 'High priority'
                : 'Low priority'}
          </span>
        ) : null}
        {active ? (
          <span className={styles.workingChip}>
            <span className={styles.workingDot} aria-hidden="true" />
            {active.run.agentName} {active.state}
          </span>
        ) : null}
        {thread.status !== 'done' && onMarkDone ? (
          <Button
            variant="outline"
            size="sm"
            className={styles.doneButton}
            onClick={onMarkDone}
          >
            Mark done
          </Button>
        ) : null}
      </header>

      <div className={styles.body}>
        <div className={styles.main}>
          <p
            className={
              attention
                ? `${styles.reason} ${styles.reasonAttention}`
                : styles.reason
            }
            aria-live="polite"
          >
            {thread.reason}
          </p>

          {thread.body ? (
            <p className={styles.threadBody}>{thread.body}</p>
          ) : null}

          {thread.acceptanceCriteria ? (
            <section className={styles.criteria}>
              <h2 className={styles.criteriaTitle}>Done when</h2>
              <p className={styles.criteriaText}>{thread.acceptanceCriteria}</p>
            </section>
          ) : null}

          {thread.children && thread.children.length > 0 ? (
            <section className={styles.children}>
              <h2 className={styles.sectionTitle}>Sub-threads</h2>
              {thread.children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className={styles.childRow}
                  onClick={() => onOpenThread?.(child.id)}
                  disabled={!onOpenThread}
                >
                  <strong>{child.title}</strong>
                  <span>{child.reason}</span>
                </button>
              ))}
            </section>
          ) : null}

          <div className={styles.posts}>
            {thread.posts.map((post) => (
              <article
                key={post.id}
                className={
                  post.authorKind === 'system'
                    ? `${styles.post} ${styles.systemPost}`
                    : styles.post
                }
              >
                <span className={styles.sequence}>{post.sequence}</span>
                <span className={styles.author}>
                  {post.authorName}
                  {post.authorDeleted ? ' (removed)' : ''}
                </span>
                <span className={styles.time}>{formatTime(post.at)}</span>
                <p className={styles.postText}>{post.text}</p>
              </article>
            ))}
          </div>

          <div className={styles.composer}>
            <textarea
              className={styles.composerInput}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="Reply to this thread"
              aria-label="Reply to this thread"
            />
            {preview && draft.trim() ? (
              <RoutingPreview targets={preview} />
            ) : null}
            <div className={styles.composerActions}>
              <Button
                size="sm"
                onClick={onReply}
                disabled={!draft.trim() || replyPending}
              >
                Post reply
              </Button>
            </div>
          </div>
        </div>

        {transcript ? (
          <TranscriptPanel
            transcript={transcript}
            onClose={onCloseTranscript ?? (() => {})}
          />
        ) : (
          <aside className={styles.sidebar}>
            <section>
              <h2 className={styles.sectionTitle}>Runs</h2>
              {live.length === 0 && past.length === 0 ? (
                <p className={styles.budgetLine}>
                  Nothing has run on this thread yet.
                </p>
              ) : null}
              {live.map((row) => (
                <RunRowView
                  key={row.run.id}
                  row={row}
                  onOpenTranscript={onOpenTranscript}
                  {...(onOpenAgentSession ? { onOpenAgentSession } : {})}
                  {...(onCancelRun ? { onCancelRun } : {})}
                />
              ))}
              {past.length > 0 ? (
                <>
                  {showPast
                    ? past.map((row) => (
                        <RunRowView
                          key={row.run.id}
                          row={row}
                          onOpenTranscript={onOpenTranscript}
                          {...(onOpenAgentSession
                            ? { onOpenAgentSession }
                            : {})}
                          {...(onOpenAgentSession
                            ? { onOpenAgentSession }
                            : {})}
                          {...(onCancelRun ? { onCancelRun } : {})}
                        />
                      ))
                    : null}
                  <button
                    type="button"
                    className={styles.pastToggle}
                    onClick={() => setShowPast((open) => !open)}
                    aria-expanded={showPast}
                  >
                    {showPast
                      ? 'Hide past runs'
                      : `Show past runs (${past.length})`}
                  </button>
                </>
              ) : null}
            </section>

            <section>
              <h2 className={styles.sectionTitle}>Budget</h2>
              <p className={styles.budgetLine}>{budget.turns}</p>
              <p className={styles.budgetLine}>{budget.tokens}</p>
              <p className={styles.budgetLine}>{budget.scope}</p>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}
