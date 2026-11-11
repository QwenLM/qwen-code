/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithI18n as baseRender } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createMockSettings } from '../../test-utils/settings.js';

import { ConfigContext } from '../contexts/ConfigContext.js';
import type { Config } from '@qwen-code/core';

const mockBadge = vi.hoisted(() => ({
  status: null as string | null,
  turnsUsed: 0,
  maxTurns: undefined as number | undefined,
}));
const mockConfig = {
  getGoalManager: () => ({
    getBadgeStatus: () => mockBadge.status,
    // The badge polls refresh() to pick up cross-window goal changes.
    refresh: () => {},
    getGoal: () =>
      mockBadge.status
        ? {
            id: 'mock-goal',
            objective: 'mock',
            status: mockBadge.status,
            turnsUsed: mockBadge.turnsUsed,
            maxTurns: mockBadge.maxTurns,
            timeUsedSeconds: 0,
          }
        : null,
    isGoalActive: false,
  }),
  // The indicator reads these off the session Config. Both were false here
  // before it stopped reading the process-wide runtimeConfig singleton, so the
  // stub keeps returning false and the snapshots below stay unchanged.
  isYoloModeDisabled: () => false,
  isTrustedFolder: () => true,
  getSessionId: () => 'test-session',
  isPlanMode: () => false,
} as unknown as Config;

const renderWithI18n: typeof baseRender = (tree, ...args) =>
  baseRender(
    <ConfigContext.Provider value={mockConfig}>{tree}</ConfigContext.Provider>,
    ...args,
  );
const render = renderWithI18n;

import { PermissionModeIndicator } from './PermissionModeIndicator.js';
import { coreEvents, CoreEvent, GoalStatus } from '@qwen-code/core';

describe('PermissionModeIndicator', () => {
  it('keeps restricted modes in the TUI cycle hint', async () => {
    const config = {
      ...mockConfig,
      getPermissionModeRestriction: () => 'Disabled by policy',
    } as unknown as Config;
    const { lastFrame, unmount } = await baseRender(
      <ConfigContext.Provider value={config}>
        <PermissionModeIndicator permissionMode="acceptEdits" />
      </ConfigContext.Provider>,
    );
    try {
      expect(lastFrame()).toContain('Accept Edits Shift+Tab to YOLO');
    } finally {
      unmount();
    }
  });

  it('renders without a Goal badge before the session is initialized', async () => {
    const { lastFrame, unmount } = await baseRender(
      <PermissionModeIndicator permissionMode="default" />,
    );
    expect(lastFrame()).toContain('Shift+Tab');
    expect(lastFrame()).not.toContain('goal');
    unmount();
  });

  it('shows why cycling is unavailable and updates after this session is trusted', async () => {
    let trusted = false;
    const config = {
      ...mockConfig,
      isTrustedFolder: () => trusted,
    } as Config;
    const { lastFrame, unmount } = await baseRender(
      <ConfigContext.Provider value={config}>
        <PermissionModeIndicator permissionMode="default" />
      </ConfigContext.Provider>,
    );

    expect(lastFrame()).toContain('Default');
    expect(lastFrame()).toContain('Trust the project folder to change modes');
    expect(lastFrame()).not.toContain('Shift+Tab');
    expect(lastFrame()).toMatchSnapshot();

    trusted = true;
    act(() => coreEvents.emitTrustChanged('another-session', true));
    expect(lastFrame()).not.toContain('Shift+Tab');
    act(() => coreEvents.emitTrustChanged('test-session', true));
    await waitFor(() => {
      expect(lastFrame()).toContain('Default Shift+Tab to Accept Edits');
      expect(lastFrame()).not.toContain('Trust the project folder');
    });
    unmount();
  });

  it('localizes the normal permission label while preserving Shift+Tab', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithI18n(
      <PermissionModeIndicator permissionMode="auto" />,
      undefined,
      1000,
      settings,
    );

    expect(lastFrame()).toContain('自动模式');
    expect(lastFrame()).toContain('Shift+Tab');
    expect(lastFrame()).toContain('不再询问');
    unmount();
  });

  it('renders correctly for acceptEdits mode', async () => {
    const { lastFrame } = await render(
      <PermissionModeIndicator permissionMode={'acceptEdits'} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders correctly for acceptEdits mode with plan enabled', async () => {
    const { lastFrame } = await render(
      <PermissionModeIndicator
        permissionMode={'acceptEdits'}
        allowPlanMode={true}
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders correctly for plan mode', async () => {
    const { lastFrame } = await render(
      <PermissionModeIndicator permissionMode={'default'} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders correctly for bypassPermissions mode', async () => {
    const { lastFrame } = await render(
      <PermissionModeIndicator permissionMode={'yolo'} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders correctly for default mode', async () => {
    const { lastFrame } = await render(
      <PermissionModeIndicator permissionMode={'default'} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders correctly for default mode with plan enabled', async () => {
    const { lastFrame } = await render(
      <PermissionModeIndicator
        permissionMode={'default'}
        allowPlanMode={true}
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('updates goal badge from actual goal status events', async () => {
    mockBadge.status = null;
    const { lastFrame } = await render(
      <PermissionModeIndicator permissionMode={'auto'} />,
    );

    expect(lastFrame()).not.toContain('goal on');

    mockBadge.status = GoalStatus.Active;
    mockBadge.turnsUsed = 3;
    mockBadge.maxTurns = 20;
    coreEvents.emit(CoreEvent.GoalUpdated, {
      sessionId: 'test-session',
      goal: {
        id: 'goal-1',
        objective: 'Finish task',
        status: GoalStatus.Active,
        turnsUsed: 3,
        timeUsedSeconds: 0,
      },
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('goal on 3/20');
    });

    // Pausing must keep the badge visible (as "goal paused") until the goal
    // is cleared or completed.
    mockBadge.status = GoalStatus.Paused;
    mockBadge.turnsUsed = 4;
    mockBadge.maxTurns = -1;
    coreEvents.emit(CoreEvent.GoalUpdated, {
      sessionId: 'test-session',
      goal: {
        id: 'goal-1',
        objective: 'Finish task',
        status: GoalStatus.Paused,
        turnsUsed: 4,
        timeUsedSeconds: 1,
      },
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('goal paused 4/unlimited');
    });
    expect(lastFrame()).not.toContain('goal on');

    // Completion hides the badge (getBadgeStatus returns null for Complete).
    mockBadge.status = null;
    coreEvents.emit(CoreEvent.GoalUpdated, {
      sessionId: 'test-session',
      goal: {
        id: 'goal-1',
        objective: 'Finish task',
        status: GoalStatus.Complete,
        turnsUsed: 2,
        timeUsedSeconds: 2,
      },
    });

    await waitFor(() => {
      expect(lastFrame()).not.toContain('goal on');
      expect(lastFrame()).not.toContain('goal paused');
    });
  });

  // Regression: a goal created by the CreateGoal tool (rather than /goal)
  // must light the badge too. The badge reads the manager at render time, so
  // any goal event is enough to surface the new status.
  it('shows goal badge for a tool-created goal', async () => {
    mockBadge.status = null;
    const { lastFrame } = await render(
      <PermissionModeIndicator permissionMode={'acceptEdits'} />,
    );

    expect(lastFrame()).not.toContain('goal on');

    mockBadge.status = GoalStatus.Active;
    coreEvents.emit(CoreEvent.GoalUpdated, {
      sessionId: 'test-session',
      goal: {
        id: 'goal-tool',
        objective: 'Created via CreateGoal tool',
        status: GoalStatus.Active,
        turnsUsed: 0,
        timeUsedSeconds: 0,
      },
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('goal on');
    });
  });

  it('hides goal badge on GoalCleared', async () => {
    mockBadge.status = null;
    const { lastFrame } = await render(
      <PermissionModeIndicator permissionMode={'auto'} />,
    );

    mockBadge.status = GoalStatus.Paused;
    coreEvents.emit(CoreEvent.GoalUpdated, {
      sessionId: 'test-session',
      goal: {
        id: 'goal-2',
        objective: 'Clear me',
        status: GoalStatus.Paused,
        turnsUsed: 0,
        timeUsedSeconds: 0,
      },
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('goal paused');
    });

    mockBadge.status = null;
    coreEvents.emit(CoreEvent.GoalCleared, {
      sessionId: 'test-session',
      goalId: 'goal-2',
      timestamp: Date.now(),
      reason: 'user',
    });

    await waitFor(() => {
      expect(lastFrame()).not.toContain('goal paused');
    });
  });
});
