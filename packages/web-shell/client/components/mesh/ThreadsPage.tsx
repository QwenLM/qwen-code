/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from 'react';

import {
  groupThreads,
  needsAttention,
  type ThreadGroup,
  type ThreadSummaryView,
} from './mesh-view-logic';
import styles from './ThreadsPage.module.css';

export interface ThreadsPageProps {
  threads: readonly ThreadSummaryView[];
  onOpenThread: (threadId: string) => void;
  loading?: boolean;
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
  threads,
  onOpenThread,
  loading,
}: ThreadsPageProps) {
  const groups = useMemo(() => groupThreads(threads), [threads]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.title}>Threads</h1>
      </header>
      <div className={styles.pageBody}>
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
