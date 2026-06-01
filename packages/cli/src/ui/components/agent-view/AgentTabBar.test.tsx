/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStatus } from '@qwen-code/qwen-code-core';
import type { KeypressHandler, Key } from '../../contexts/KeypressContext.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import {
  useAgentViewActions,
  useAgentViewState,
} from '../../contexts/AgentViewContext.js';
import {
  useBackgroundTaskViewActions,
  useBackgroundTaskViewState,
} from '../../contexts/BackgroundTaskViewContext.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { AgentTabBar } from './AgentTabBar.js';

vi.mock('../../hooks/useKeypress.js');
vi.mock('../../contexts/AgentViewContext.js');
vi.mock('../../contexts/BackgroundTaskViewContext.js');
vi.mock('../../contexts/UIStateContext.js');

let activeKeypressHandler: KeypressHandler | null = null;

const createKey = (overrides: Partial<Key>): Key => ({
  name: '',
  sequence: '',
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
  ...overrides,
});

const pressKey = (overrides: Partial<Key>) => {
  if (!activeKeypressHandler) {
    throw new Error('No active keypress handler');
  }
  activeKeypressHandler(createKey(overrides));
};

describe('AgentTabBar', () => {
  const switchToMain = vi.fn();
  const setAgentTabBarFocused = vi.fn();
  const setLivePanelFocused = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    activeKeypressHandler = null;

    vi.mocked(useKeypress).mockImplementation((handler, { isActive }) => {
      if (isActive) {
        activeKeypressHandler = handler;
      }
    });
    vi.mocked(useAgentViewState).mockReturnValue({
      activeView: 'agent-1',
      agents: new Map([
        [
          'agent-1',
          {
            modelId: 'qwen',
            color: 'cyan',
            interactiveAgent: {
              getStatus: () => AgentStatus.IDLE,
              getEventEmitter: () => ({ on: vi.fn(), off: vi.fn() }),
            },
          },
        ],
      ]),
      agentShellFocused: false,
      agentTabBarFocused: true,
    } as never);
    vi.mocked(useAgentViewActions).mockReturnValue({
      switchToNext: vi.fn(),
      switchToPrevious: vi.fn(),
      switchToMain,
      setAgentTabBarFocused,
    } as never);
    vi.mocked(useBackgroundTaskViewState).mockReturnValue({
      entries: [{ kind: 'agent', agentId: 'bg-agent' }],
    } as never);
    vi.mocked(useBackgroundTaskViewActions).mockReturnValue({
      setLivePanelFocused,
    } as never);
    vi.mocked(useUIState).mockReturnValue({
      embeddedShellFocused: false,
    } as never);
  });

  it('uses Ctrl+P/N for focus-chain navigation', () => {
    render(<AgentTabBar />);

    pressKey({ name: 'p', sequence: '\u0010', ctrl: true });
    expect(setAgentTabBarFocused).toHaveBeenCalledWith(false);

    pressKey({ name: 'n', sequence: '\u000E', ctrl: true });
    expect(switchToMain).toHaveBeenCalledTimes(1);
    expect(setLivePanelFocused).toHaveBeenCalledWith(true);
  });
});
