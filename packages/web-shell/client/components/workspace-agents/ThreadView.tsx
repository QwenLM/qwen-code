/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon } from 'lucide-react';

import { Button } from '../ui/button';
import { Markdown } from '../messages/Markdown';
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

export interface ThreadViewProps {
  thread: ThreadDetailView;
  agents: readonly {
    name: string;
    enabled: boolean;
    /** Retired identities stay in the list and are never offered new work. */
    retiredAt?: number;
    status?: string;
    runtime?: { label: string; status: string };
  }[];
  /** Server-computed routing for the current draft. */
  preview?: readonly RoutingPreviewTarget[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onReply: () => void;
  onBack: () => void;
  onOpenThread?: (threadId: string) => void;
  /**
   * Opens the agent session a run ran in. Absent where the shell has no
   * session view to switch to, which is why every use of it is guarded.
   */
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun?: (runId: string) => void;
  onMarkDone?: () => void;
  onAssign?: (assignee?: string) => void;
  replyPending?: boolean;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RunRowView({
  row,
  agent,
  onOpenAgentSession,
  onCancelRun,
}: {
  row: RunRow;
  agent?: { status?: string; runtime?: { label: string; status: string } };
  onOpenAgentSession?: (sessionId: string) => void;
  onCancelRun?: (runId: string) => void;
}) {
  const sessionId = row.run.sessionId;
  const progress = row.run.progress;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!row.live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [row.live]);
  const stale = progress && now - progress.receivedAt > 20000;
  const quiet = progress && now - progress.activityAt > 15000;
  const stages: Record<string, string> = {
    starting: '正在启动',
    resuming: '继续会话中',
    waiting: '等待模型',
    thinking: '思考中',
    tool: '调用工具中',
    responding: '正在回复',
  };
  const state =
    row.run.status === 'queued'
      ? agent?.status === 'offline' || agent?.runtime?.status === 'offline'
        ? `执行主机 ${agent.runtime?.label ?? ''} 离线，等待恢复`
        : '消息已接收，排队等待启动'
      : row.run.status === 'running'
        ? progress
          ? stale
            ? '连接中断待确认'
            : quiet
              ? '等待新输出'
              : (stages[progress.stage] ?? '执行中')
          : '等待执行端确认'
        : row.state;
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
        {state}
        {row.live && row.run.status !== 'cancelling' && onCancelRun ? (
          <button
            type="button"
            className={styles.runCancel}
            onClick={() => onCancelRun(row.run.id)}
          >
            取消
          </button>
        ) : null}
      </span>
      {row.live && (
        <div className={styles.runProgress} role="status">
          {row.run.startedAt && (
            <div>
              已等待 {Math.max(0, Math.floor((now - row.run.startedAt) / 1000))}{' '}
              秒
            </div>
          )}
          {progress ? (
            <>
              <div>
                {stale
                  ? '执行端超过 20 秒未响应，不能确认仍在工作'
                  : '执行端连接正常'}{' '}
                · {Math.max(0, Math.floor((now - progress.receivedAt) / 1000))}{' '}
                秒前响应
              </div>
              <div>
                最近活动：
                {Math.max(
                  0,
                  Math.floor((now - progress.activityAt) / 1000),
                )}{' '}
                秒前
              </div>
            </>
          ) : (
            <div>
              {row.run.status === 'queued'
                ? '尚未启动模型，不是在思考。任务保留在队列中，无需重发。'
                : '尚未收到启动或输出信号，暂不能确认模型已开始工作。无需重复发送。'}
            </div>
          )}
        </div>
      )}
      {progress?.detail && (
        <details className={styles.runProgress} open={row.live}>
          <summary>最近执行活动</summary>
          <div>{progress.detail}</div>
        </details>
      )}
      {progress?.thoughtText && (
        <details className={styles.runProgress} open={row.live}>
          <summary>思考过程（执行器提供）</summary>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
            {progress.thoughtText}
          </div>
          {progress.thoughtText.length >= 65536 && (
            <p>思考预览已达长度上限。</p>
          )}
        </details>
      )}
      {progress?.outputText && (
        <details className={styles.runProgress}>
          <summary>执行输出（含中间回复）</summary>
          <Markdown
            content={progress.outputText}
            isStreaming={row.run.status === 'running'}
          />
          {progress.outputText.length >= 262144 && (
            <p>实时预览已达长度上限；完整最终回复见对话正文。</p>
          )}
        </details>
      )}
      <span className={styles.runTrigger}>
        {row.run.trigger}
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
  onOpenAgentSession,
  onCancelRun,
  onMarkDone,
  onAssign,
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
          aria-label="Back to tasks"
        >
          <ArrowLeftIcon />
        </Button>
        {thread.parent && onOpenThread ? (
          <button
            type="button"
            className={styles.parentLink}
            onClick={() => onOpenThread(thread.parent!.id)}
          >
            {thread.parent.title}
            <span aria-hidden="true"> /</span>
          </button>
        ) : null}
        <h1 className={styles.title}>{thread.title}</h1>
        {onAssign ? (
          <select
            className={styles.assigneeSelect}
            value={thread.assigneeName ?? ''}
            onChange={(event) => onAssign(event.target.value || undefined)}
            disabled={thread.status === 'done' || replyPending}
            aria-label="Task assignee"
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
            <div className={styles.threadBody}>
              <Markdown content={thread.body} />
            </div>
          ) : null}

          {thread.acceptanceCriteria ? (
            <section className={styles.criteria}>
              <h2 className={styles.criteriaTitle}>Done when</h2>
              <div className={styles.criteriaText}>
                <Markdown content={thread.acceptanceCriteria} />
              </div>
            </section>
          ) : null}

          {thread.children && thread.children.length > 0 ? (
            <section className={styles.children}>
              <h2 className={styles.sectionTitle}>Subtasks</h2>
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
                <div className={styles.postText}>
                  <Markdown
                    content={post.text}
                    {...(post.authorKind === 'agent'
                      ? { source: 'assistant' as const }
                      : {})}
                  />
                </div>
                {post.outcomes?.map((outcome, index) => {
                  const skipped =
                    outcome.kind === 'skip'
                      ? explainSkip(
                          outcome.reason ?? '',
                          outcome.agentName ?? '',
                        )
                      : undefined;
                  const result = skipped
                    ? `${skipped.what}. ${skipped.fix}`
                    : outcome.kind === 'dispatch'
                      ? 'Booked for execution'
                      : outcome.into === 'running'
                        ? 'Added to a running task; not a read receipt'
                        : 'Added to queued work';
                  return (
                    <p className={styles.postOutcome} key={index}>
                      Routing:{' '}
                      {outcome.agentName ? `@${outcome.agentName} · ` : ''}
                      {result}
                    </p>
                  );
                })}
              </article>
            ))}
          </div>

          <div className={styles.composer}>
            <textarea
              className={styles.composerInput}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="Reply to this task"
              aria-label="Reply to this task"
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
                Nothing has run on this task yet.
              </p>
            ) : null}
            {live.map((row) => (
              <RunRowView
                key={row.run.id}
                row={row}
                agent={agents.find((agent) => agent.name === row.run.agentName)}
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
                        {...(onOpenAgentSession ? { onOpenAgentSession } : {})}
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
      </div>
    </div>
  );
}
