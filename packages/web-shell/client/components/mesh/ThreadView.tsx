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
} from './mesh-view-logic';
import styles from './ThreadView.module.css';

export interface ThreadPostView {
  id: string;
  sequence: number;
  authorKind: 'human' | 'agent' | 'system';
  authorName: string;
  text: string;
  at: number;
}

export interface ThreadDetailView {
  id: string;
  title: string;
  body: string;
  status: 'open' | 'in_progress' | 'blocked' | 'in_review' | 'done';
  /** The resolver's sentence. Rendered verbatim. */
  reason: string;
  posts: readonly ThreadPostView[];
  runs: readonly RunView[];
  budget: {
    turnsUsed: number;
    turnLimit: number;
    tokensUsed: number;
    tokenLimit: number;
  };
}

export interface ThreadViewProps {
  thread: ThreadDetailView;
  /** Server-computed routing for the current draft. */
  preview?: readonly RoutingPreviewTarget[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onReply: () => void;
  onBack: () => void;
  onOpenTranscript: (runId: string) => void;
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
}: {
  row: RunRow;
  onOpenTranscript: (runId: string) => void;
}) {
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
      <span className={stateClass}>{row.state}</span>
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
      </span>
    </div>
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
  preview,
  draft,
  onDraftChange,
  onReply,
  onBack,
  onOpenTranscript,
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
  const working = live.find((row) => row.run.status === 'running');

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
        {working ? (
          <span className={styles.workingChip}>
            <span className={styles.workingDot} aria-hidden="true" />
            {working.run.agentName} working
          </span>
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
                <span className={styles.author}>{post.authorName}</span>
                <span className={styles.time}>{formatTime(post.at)}</span>
                {/* A system trigger is a ledger entry: its author line already
                    says what happened, so it has no body to render. */}
                {post.authorKind === 'system' ? null : (
                  <p className={styles.postText}>{post.text}</p>
                )}
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
      </div>
    </div>
  );
}
