/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionGoalInfo } from '@qwen-code/sdk/daemon';
import { Target } from 'lucide-react';
import { useI18n } from '../i18n';
import { goalStatusTone, hasVisibleGoal } from './GoalStatusStrip';
import styles from './SessionGoalMarker.module.css';

interface SessionGoalMarkerProps {
  /** The session's goal projection from the catalog (disk sidecar). */
  goal: DaemonSessionGoalInfo;
  /**
   * Opens the session — the same action as the row. Absent on surfaces
   * whose rows do not open (archived list), where the marker is a pure
   * indicator.
   */
  onOpen?: () => void;
}

/**
 * The sidebar's goal marker: the app-wide Goals glyph tinted with the same
 * lifecycle tone as the Goals page, so a session carrying a Goal reads at a
 * glance. Completed goals render nothing — both Goals listings filter
 * `complete`, and the sidebar follows the same policy.
 */
export function SessionGoalMarker({ goal, onOpen }: SessionGoalMarkerProps) {
  const { t } = useI18n();
  if (!hasVisibleGoal(goal)) return null;
  const label = t('sidebar.sessionGoal', {
    status: t(`goal.status.${goal.status}`),
    objective: goal.objective,
  });
  const icon = (
    <Target
      size={14}
      strokeWidth={1.5}
      className={styles.goalMarkerIcon}
      data-status={goalStatusTone(goal.status)}
      aria-hidden="true"
    />
  );
  if (!onOpen) {
    return (
      <span
        className={styles.goalMarker}
        data-testid="session-goal-marker"
        data-status={goalStatusTone(goal.status)}
        role="img"
        aria-label={label}
        title={label}
      >
        {icon}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.goalMarker}
      data-testid="session-goal-marker"
      data-status={goalStatusTone(goal.status)}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.stopPropagation();
      }}
    >
      {icon}
    </button>
  );
}
