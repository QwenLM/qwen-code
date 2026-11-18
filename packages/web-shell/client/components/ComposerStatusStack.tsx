import type { ComponentProps } from 'react';
import { GoalStatusStrip, type GoalStatusStripProps } from './GoalStatusStrip';
import { QueuedPromptDisplay } from './QueuedPromptDisplay';
import styles from './ComposerStatusStack.module.css';

export interface ComposerStatusStackProps {
  queued: ComponentProps<typeof QueuedPromptDisplay>;
  goal?: GoalStatusStripProps;
}

// The host decides whether to mount the stack (queue non-empty or a live
// goal); the goal strip renders only while the snapshot still carries a goal.
// Keeping both gates here would duplicate the host's mount condition.
export function ComposerStatusStack({
  queued,
  goal,
}: ComposerStatusStackProps) {
  return (
    <div className={styles.root} data-testid="composer-status-stack">
      <QueuedPromptDisplay {...queued} />
      {goal?.snapshot.goal && <GoalStatusStrip {...goal} />}
    </div>
  );
}
