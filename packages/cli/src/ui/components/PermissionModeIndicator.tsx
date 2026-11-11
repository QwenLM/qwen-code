/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useContext, useEffect, useMemo, useState } from 'react';
import { Text } from 'ink';
import type { PermissionMode } from '@qwen-code/core';
import {
  permissionModeColor,
  WORK_STATE_COLORS,
  coreEvents,
  CoreEvent,
  GoalStatus,
  isUnlimitedGoalTurns,
  type TrustChangedPayload,
} from '@qwen-code/core';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { resolveThemeColor, theme } from '../semantic-colors.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { Command } from '../key/keyBindings.js';
import {
  getLocalizedPermissionModeTitle,
  useI18nService,
} from '../i18n/index.js';

interface PermissionModeIndicatorProps {
  permissionMode: PermissionMode;
  allowPlanMode?: boolean;
}

/**
 * How often the goal badge re-reads the persisted goal to pick up out-of-band
 * changes (external cleanup, another process resuming this session).
 * coreEvents does not cross process boundaries, so this poll is the only
 * cross-process sync path.
 */
const GOAL_BADGE_POLL_INTERVAL_MS = 3000;

export const PermissionModeIndicator: React.FC<
  PermissionModeIndicatorProps
> = ({ permissionMode }) => {
  const i18n = useI18nService();
  // Tolerant read (not `useConfig()`, which throws): this indicator also renders
  // in hosts that provide no Config, and every read below already defaults.
  const config = useContext(ConfigContext);
  const cycleHint = formatCommand(Command.CYCLE_PERMISSION_MODE);

  const textColor = useMemo(() => {
    const color = permissionModeColor(permissionMode);
    // Raw hex values (from PERMISSION_MODE_COLORS) are used directly;
    // legacy semantic paths are resolved via theme.
    return color.startsWith('#') ? color : resolveThemeColor(color);
  }, [permissionMode]);
  const textContent = getLocalizedPermissionModeTitle(permissionMode, i18n.get);

  let subText = '';
  let targetMode: PermissionMode;
  const yoloDisabled = config?.isYoloModeDisabled() ?? false;
  // Cycle order: dontAsk → default → acceptEdits → yolo → auto → dontAsk
  switch (permissionMode) {
    case 'dontAsk':
      targetMode = 'default';
      break;
    case 'default':
      targetMode = 'acceptEdits';
      break;
    case 'acceptEdits':
      targetMode = yoloDisabled ? 'auto' : 'yolo';
      break;
    case 'yolo':
      targetMode = 'auto';
      break;
    case 'auto':
      targetMode = 'dontAsk';
      break;
    default:
      targetMode = 'acceptEdits';
      break;
  }
  subText =
    config?.isTrustedFolder() === false
      ? i18n.get('status.permission.untrusted')
      : i18n.get('status.permission.cycle', {
          shortcut: cycleHint,
          mode: getLocalizedPermissionModeTitle(targetMode, i18n.get),
        });

  // Plan/goal state badges — shown AFTER the cycle hint, separated by |
  const isPlanActive = config?.isPlanMode() ?? false;
  // Badge is bound to the actual goal lifecycle: an owned goal stays visible
  // (active or paused) until the user clears it or the goal completes.
  // The badge value is read from the GoalManager at render time — the truth
  // source — so a missed event can never leave a stale badge; goal events
  // only trigger a re-render.
  const [, setIndicatorVersion] = useState(0);

  useEffect(() => {
    const bump = () => setIndicatorVersion((v) => v + 1);
    const onTrustChanged = ({ sessionId }: TrustChangedPayload) => {
      if (sessionId === config?.getSessionId()) bump();
    };

    coreEvents.on(CoreEvent.GoalUpdated, bump);
    coreEvents.on(CoreEvent.GoalCleared, bump);
    coreEvents.on(CoreEvent.TrustChanged, onTrustChanged);
    return () => {
      coreEvents.off(CoreEvent.GoalUpdated, bump);
      coreEvents.off(CoreEvent.GoalCleared, bump);
      coreEvents.off(CoreEvent.TrustChanged, onTrustChanged);
    };
  }, [config]);

  // coreEvents is process-local, so a goal changed by another process of the
  // SAME session (or removed by external cleanup) emits nothing here and would
  // leave a stale badge (the goal file is the source of truth). Poll it back
  // into sync.
  useEffect(() => {
    const timer = setInterval(() => {
      const mgr = config?.getGoalManager();
      if (!mgr) return;
      const before = mgr.getBadgeStatus();
      mgr.refresh();
      if (mgr.getBadgeStatus() !== before) {
        setIndicatorVersion((v) => v + 1);
      }
    }, GOAL_BADGE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [config]);

  const goalManager = config?.getGoalManager();
  const goalBadge = goalManager?.getBadgeStatus();
  // Turn progress rendered next to the badge, e.g. "goal on 3/20". Read at
  // render time like the badge itself so it stays current as turns accrue.
  const badgeGoal = goalBadge ? goalManager?.getGoal() : null;
  const goalTurns = badgeGoal
    ? ` ${badgeGoal.turnsUsed}${badgeGoal.maxTurns ? `/${isUnlimitedGoalTurns(badgeGoal.maxTurns) ? 'unlimited' : badgeGoal.maxTurns}` : ''}`
    : '';

  return (
    <Text color={textColor}>
      {textContent ? textContent : null}
      {subText ? (
        <Text color={theme.text.secondary}>
          {textContent ? ' ' : ''}
          {subText}
        </Text>
      ) : null}
      {isPlanActive ? (
        <Text color={WORK_STATE_COLORS.plan}>
          {' | '}
          {i18n.get('status.permission.planOn')}
        </Text>
      ) : null}
      {goalBadge === GoalStatus.Active ? (
        <Text color={WORK_STATE_COLORS.goal}>
          {' | '}
          {i18n.get('status.permission.goalOn')}
          {goalTurns}
        </Text>
      ) : null}
      {goalBadge === GoalStatus.Paused ? (
        <Text color={WORK_STATE_COLORS.goal}>
          {' | '}
          {i18n.get('status.permission.goalPaused')}
          {goalTurns}
        </Text>
      ) : null}
    </Text>
  );
};
