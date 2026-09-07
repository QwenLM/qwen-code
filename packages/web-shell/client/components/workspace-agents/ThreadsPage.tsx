/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState, type FormEvent } from 'react';
import { PlusIcon } from 'lucide-react';

import { Button } from '../ui/button';
import {
  explainSkip,
  groupThreads,
  needsAttention,
  type RoutingPreviewTarget,
  type ThreadGroup,
  type ThreadSummaryView,
} from './agents-view-logic';
import styles from './ThreadsPage.module.css';

/**
 * A change to one agent's configuration. Absent leaves a field alone; `null`
 * clears the override and returns the agent to what its definition says.
 */
export interface AgentConfigPatch {
  description?: string | null;
  color?: string | null;
  model?: string | null;
  instructions?: string | null;
  agentType?: string | null;
  maxConcurrentRuns?: number | null;
}

/** What every agent in this workspace may do. A property of the subsystem. */
export interface AgentCapabilitiesView {
  readOnly: boolean;
  allowed: readonly string[];
  threadTools: readonly string[];
}

export interface ThreadsPageProps {
  agents: readonly WorkspaceAgentSummaryView[];
  threads: readonly ThreadSummaryView[];
  onOpenThread: (threadId: string) => void;
  onCreateAgent: (input: NewWorkspaceAgent) => void;
  onDeleteAgent: (agentId: string) => void;
  onSetAgentEnabled: (agentId: string, enabled: boolean) => void;
  onUpdateAgent?: (agentId: string, patch: AgentConfigPatch) => void;
  capabilities?: AgentCapabilitiesView;
  onCreateThread: (input: NewThread) => void;
  onPreviewThread?: (assignee?: string) => void;
  createPreview?: readonly RoutingPreviewTarget[];
  pending?: boolean;
  loading?: boolean;
}

export interface WorkspaceAgentSummaryView {
  id: string;
  name: string;
  description?: string;
  color?: string;
  /** Definition supplying the persona. Absent uses the workspace default. */
  agentType?: string;
  model?: string;
  /** What this identity is told on top of its definition's prompt. */
  instructions?: string;
  maxConcurrentRuns?: number;
  enabled: boolean;
  /** Set once the identity is retired: it keeps its posts and takes no work. */
  retiredAt?: number;
  workingOn?: {
    id: string;
    title: string;
    state: 'working' | 'finishing' | 'stopping';
  };
  waiting: number;
}

export interface NewWorkspaceAgent {
  name: string;
  description?: string;
  agentType?: string;
}

export type ThreadPriorityChoice = 'urgent' | 'high' | 'normal' | 'low';

export interface NewThread {
  title: string;
  body: string;
  /** What "done" means. Sent only when written, so a blank stays absent. */
  acceptanceCriteria?: string;
  priority?: ThreadPriorityChoice;
  assignee?: string;
}

function ThreadRow({
  thread,
  onOpen,
}: {
  thread: ThreadSummaryView;
  onOpen: (threadId: string) => void;
}) {
  return (
    <button
      type="button"
      className={
        needsAttention(thread)
          ? `${styles.row} ${styles.attention}`
          : styles.row
      }
      onClick={() => onOpen(thread.id)}
    >
      <span className={styles.rowTitle}>{thread.title}</span>
      {/* The status sentence comes from the server's resolver. The UI must not
          derive a second, shorter vocabulary: the shorter one would win
          because it is the one on screen, and the two would drift. */}
      <span className={styles.rowReason}>{thread.reason}</span>
      <span className={styles.rowId}>{thread.id}</span>
    </button>
  );
}

function Group({
  group,
  onOpenThread,
}: {
  group: ThreadGroup;
  onOpenThread: (threadId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(group.collapsedByDefault);
  const collapsible = group.collapsedByDefault;
  return (
    <section className={styles.group}>
      <button
        type="button"
        className={
          collapsible
            ? `${styles.groupHeading} ${styles.groupHeadingToggle}`
            : styles.groupHeading
        }
        onClick={collapsible ? () => setCollapsed((open) => !open) : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        disabled={!collapsible}
      >
        {group.label}
        <span className={styles.groupCount}>{group.threads.length}</span>
      </button>
      {!collapsed &&
        group.threads.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} onOpen={onOpenThread} />
        ))}
    </section>
  );
}

/**
 * The thread list, grouped by what each thread needs.
 *
 * Recency sorting is the obvious default and it buries the two threads that
 * need a person under twenty that do not. Grouping answers the question
 * someone actually opens this page with.
 */
export function ThreadsPage({
  agents,
  threads,
  onOpenThread,
  onCreateAgent,
  onDeleteAgent,
  onSetAgentEnabled,
  onUpdateAgent,
  capabilities,
  onCreateThread,
  onPreviewThread,
  createPreview,
  pending,
  loading,
}: ThreadsPageProps) {
  const groups = useMemo(() => groupThreads(threads), [threads]);
  const [creating, setCreating] = useState<'agent' | 'thread' | undefined>();
  const [configuring, setConfiguring] = useState<string>();

  const submitConfig =
    (agentId: string) => (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!onUpdateAgent) return;
      const data = new FormData(event.currentTarget);
      const field = (name: string): string | null => {
        const value = String(data.get(name) ?? '').trim();
        // A field emptied on purpose clears the override rather than being
        // ignored, which is the difference between "no opinion" and "back to
        // the definition".
        return value === '' ? null : value;
      };
      const runs = String(data.get('maxConcurrentRuns') ?? '').trim();
      onUpdateAgent(agentId, {
        description: field('description'),
        model: field('model'),
        agentType: field('agentType'),
        instructions: field('instructions'),
        maxConcurrentRuns: runs === '' ? null : Number(runs),
      });
      setConfiguring(undefined);
    };

  const submitAgent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const description = String(data.get('description') ?? '').trim();
    const agentType = String(data.get('agentType') ?? '').trim();
    onCreateAgent({
      name: String(data.get('name') ?? '').trim(),
      ...(description ? { description } : {}),
      ...(agentType ? { agentType } : {}),
    });
    setCreating(undefined);
  };

  const submitThread = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const assignee = String(data.get('assignee') ?? '');
    const acceptanceCriteria = String(
      data.get('acceptanceCriteria') ?? '',
    ).trim();
    const priority = String(data.get('priority') ?? '');
    onCreateThread({
      title: String(data.get('title') ?? '').trim(),
      body: String(data.get('body') ?? '').trim(),
      // Left out when blank or ordinary, so the thread records a decision
      // only where one was made.
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      ...(priority && priority !== 'normal'
        ? { priority: priority as ThreadPriorityChoice }
        : {}),
      ...(assignee ? { assignee } : {}),
    });
    onPreviewThread?.(undefined);
    setCreating(undefined);
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.title}>Threads</h1>
        <div className={styles.headerActions}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreating('agent')}
          >
            <PlusIcon data-icon="inline-start" />
            Agent
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCreating('thread');
              onPreviewThread?.(undefined);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Thread
          </Button>
        </div>
      </header>
      <div className={styles.pageBody}>
        {creating === 'agent' ? (
          <form className={styles.createForm} onSubmit={submitAgent}>
            <strong>New persistent agent</strong>
            <input
              className={styles.field}
              name="name"
              placeholder="Name, e.g. alice"
              required
            />
            <input
              className={styles.field}
              name="description"
              placeholder="Role or specialty"
            />
            <input
              className={styles.field}
              name="agentType"
              placeholder="Agent definition (optional)"
            />
            <div className={styles.formActions}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreating(undefined)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                Create agent
              </Button>
            </div>
          </form>
        ) : null}

        {creating === 'thread' ? (
          <form className={styles.createForm} onSubmit={submitThread}>
            <strong>New shared thread</strong>
            <input
              className={styles.field}
              name="title"
              placeholder="What needs to be done?"
              required
            />
            <textarea
              className={styles.field}
              name="body"
              placeholder="Give the team the full task"
              required
            />
            <textarea
              className={styles.field}
              name="acceptanceCriteria"
              placeholder="Done when… (the agent is told this, and reports against it)"
            />
            <select
              className={styles.field}
              name="priority"
              defaultValue="normal"
            >
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal priority</option>
              <option value="low">Low</option>
            </select>
            <select
              className={styles.field}
              name="assignee"
              defaultValue=""
              onChange={(event) =>
                onPreviewThread?.(event.target.value || undefined)
              }
            >
              <option value="">No assignee</option>
              {agents
                .filter((agent) => agent.enabled && !agent.retiredAt)
                .map((agent) => (
                  <option key={agent.id} value={agent.name}>
                    {agent.name}
                  </option>
                ))}
            </select>
            {createPreview ? (
              <div
                role="status"
                className="space-y-1 text-xs text-muted-foreground"
              >
                <strong>
                  {createPreview.some((target) => target.willWake)
                    ? `Will start ${createPreview
                        .filter((target) => target.willWake)
                        .map((target) => `@${target.agentName}`)
                        .join(', ')}.`
                    : 'No agent will start.'}
                </strong>
                {createPreview
                  .filter((target) => !target.willWake)
                  .map((target) => {
                    const explained =
                      target.reason === 'no_target'
                        ? {
                            what: 'this thread has no assignee',
                            fix: 'Choose an assignee to start it.',
                          }
                        : explainSkip(target.reason ?? '', target.agentName);
                    return (
                      <p
                        key={`${target.agentName}:${target.reason ?? 'unknown'}`}
                      >
                        {explained.what}. {explained.fix}
                      </p>
                    );
                  })}
              </div>
            ) : null}
            <div className={styles.formActions}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCreating(undefined);
                  onPreviewThread?.(undefined);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                Create thread
              </Button>
            </div>
          </form>
        ) : null}

        <section className={styles.roster}>
          <h2 className={styles.sectionTitle}>Persistent agents</h2>
          {agents.length === 0 ? (
            <p className={styles.emptyRoster}>
              No agents yet. Add one to start handing work across shared
              threads.
            </p>
          ) : (
            agents.map((agent) => (
              <div
                key={agent.id}
                className={
                  agent.enabled && !agent.retiredAt
                    ? styles.agentRow
                    : `${styles.agentRow} ${styles.agentRowDisabled}`
                }
              >
                <span
                  className={
                    agent.enabled && !agent.retiredAt
                      ? styles.agentDot
                      : styles.agentDotDisabled
                  }
                  style={agent.color ? { color: agent.color } : undefined}
                  aria-hidden="true"
                />
                <strong>{agent.name}</strong>
                <span className={styles.agentDescription}>
                  {agent.description || 'general agent'}
                </span>
                <span className={styles.agentActivity}>
                  {agent.retiredAt
                    ? 'retired'
                    : agent.workingOn
                      ? `${agent.workingOn.state} · ${agent.workingOn.title}`
                      : 'idle'}
                </span>
                <span className={styles.agentWaiting}>
                  {agent.waiting ? `${agent.waiting} waiting` : '—'}
                </span>
                {agent.retiredAt ? null : (
                  <>
                    {onUpdateAgent ? (
                      <button
                        type="button"
                        className={styles.agentAction}
                        onClick={() =>
                          setConfiguring(
                            configuring === agent.id ? undefined : agent.id,
                          )
                        }
                      >
                        {configuring === agent.id ? 'Close' : 'Configure'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.agentAction}
                      disabled={pending}
                      onClick={() =>
                        onSetAgentEnabled(agent.id, !agent.enabled)
                      }
                    >
                      {agent.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      className={`${styles.agentAction} ${styles.agentRemove}`}
                      disabled={Boolean(agent.workingOn || agent.waiting)}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Retire agent "${agent.name}"? It stops taking work. Its posts stay on every thread, and its name stays taken so nothing else can post as it.`,
                          )
                        ) {
                          onDeleteAgent(agent.id);
                        }
                      }}
                    >
                      Retire
                    </button>
                  </>
                )}
                {configuring === agent.id && onUpdateAgent ? (
                  <form
                    className={styles.agentConfig}
                    onSubmit={submitConfig(agent.id)}
                  >
                    <label className={styles.configLabel}>
                      What this agent is for
                      <input
                        className={styles.field}
                        name="description"
                        defaultValue={agent.description ?? ''}
                        placeholder="Reviews changes before they ship"
                      />
                    </label>
                    <label className={styles.configLabel}>
                      Instructions, on top of its definition
                      <textarea
                        className={styles.field}
                        name="instructions"
                        rows={4}
                        defaultValue={agent.instructions ?? ''}
                        placeholder="How this one should work. It cannot widen what the agent may do."
                      />
                    </label>
                    <label className={styles.configLabel}>
                      Definition
                      <input
                        className={styles.field}
                        name="agentType"
                        defaultValue={agent.agentType ?? ''}
                        placeholder="Workspace default"
                      />
                    </label>
                    <label className={styles.configLabel}>
                      Model
                      <input
                        className={styles.field}
                        name="model"
                        defaultValue={agent.model ?? ''}
                        placeholder="Workspace default"
                      />
                    </label>
                    <label className={styles.configLabel}>
                      Threads at once
                      <input
                        className={styles.field}
                        name="maxConcurrentRuns"
                        type="number"
                        min={1}
                        max={8}
                        defaultValue={agent.maxConcurrentRuns ?? 1}
                      />
                    </label>
                    <p className={styles.configNote}>
                      Emptying a field returns it to what the definition says.
                    </p>
                    <div className={styles.formActions}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfiguring(undefined)}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" size="sm" disabled={pending}>
                        Save changes
                      </Button>
                    </div>
                  </form>
                ) : null}
              </div>
            ))
          )}
          {capabilities ? (
            <div className={styles.ceiling}>
              <h3 className={styles.ceilingTitle}>What agents can do here</h3>
              <p className={styles.ceilingText}>
                {capabilities.readOnly
                  ? 'Agents read the workspace and post to threads. They cannot edit files, run commands, or reach the network. Instructions and definitions change what an agent is for, never what it may do.'
                  : 'Agents run without the read-only boundary.'}
              </p>
              <p className={styles.ceilingTools}>
                {capabilities.allowed.join(', ')}
              </p>
            </div>
          ) : null}
        </section>

        {loading && threads.length === 0 ? null : groups.length === 0 ? (
          <div className={styles.emptyState}>
            {/* An empty screen is an invitation, not a shrug. */}
            <p className={styles.emptyLead}>No threads yet.</p>
            <p>
              A thread is a piece of work you hand to an agent. Assign one when
              you open it and the agent starts straight away.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <Group key={group.key} group={group} onOpenThread={onOpenThread} />
          ))
        )}
      </div>
    </div>
  );
}
