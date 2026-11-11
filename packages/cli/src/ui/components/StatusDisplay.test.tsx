/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderWithI18n } from '../../test-utils/render.js';
import { Text } from 'ink';
import { StatusDisplay } from './StatusDisplay.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type {
  AgentUnifiedTask,
  BashUnifiedTask,
  Config,
  InternalAgentUnifiedTask,
} from '@qwen-code/core';
import { ENV_WRITE_SYSTEM_MD } from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { createMockSettings } from '../../test-utils/settings.js';
import type { TextBuffer } from './shared/text-buffer.js';

// Mock child components to simplify testing
vi.mock('./ContextSummaryDisplay.js', () => ({
  ContextSummaryDisplay: (props: {
    skillCount: number;
    backgroundProcessCount: number;
  }) => (
    <Text>
      Mock Context Summary Display (Skills: {props.skillCount}, Shells:{' '}
      {props.backgroundProcessCount})
    </Text>
  ),
  // Non-empty so StatusDisplay renders the native summary.
  buildContextSummaryString: () => 'mock summary',
}));

// Use a type that allows partial buffer for mocking purposes
type UIStateOverrides = Partial<Omit<UIState, 'buffer'>> & {
  buffer?: Partial<TextBuffer>;
};

// Create mock context providers
const createMockUIState = (overrides: UIStateOverrides = {}): UIState =>
  ({
    ctrlCPressedOnce: false,
    transientMessage: null,
    ctrlDPressedOnce: false,
    showEscapePrompt: false,
    shortcutsHelpVisible: false,
    queueErrorMessage: null,
    activeHooks: [],
    memoryMdFileCount: 0,
    contextFileNames: [],
    unifiedRunningCount: 0,
    buffer: { text: '' },
    history: [{ id: 1, type: 'user', text: 'test' }],
    ...overrides,
  }) as UIState;

const createMockConfig = (overrides = {}) => ({
  getScreenReader: vi.fn(() => false),
  getCliVersion: vi.fn(() => '0.0.0'),
  getUseAlternateBuffer: vi.fn(() => false),
  getMcpClientManager: vi.fn().mockImplementation(() => ({
    getMcpConfigurationErrorCount: vi.fn(() => 0),
    getBlockedMcpServers: vi.fn(() => []),
    getMcpServers: vi.fn(() => ({})),
    getNeedsAuthServerCount: vi.fn(() => 0),
  })),
  getSkillManager: vi.fn().mockImplementation(() => ({
    getSkills: vi.fn(() => ['skill1', 'skill2']),
    getDisplayableSkills: vi.fn(() => ['skill1', 'skill2']),
  })),
  ...overrides,
});

const renderStatusDisplay = async (
  props: { hideContextSummary: boolean } = { hideContextSummary: false },
  uiState?: UIState,
  settings?: LoadedSettings,
  config?: ReturnType<typeof createMockConfig>,
  width = 100,
) => {
  const resolvedUIState = uiState ?? createMockUIState();
  const resolvedSettings = settings ?? createMockSettings();
  const resolvedConfig = config ?? createMockConfig();
  const result = await renderWithI18n(
    <ConfigContext.Provider value={resolvedConfig as unknown as Config}>
      <SettingsContext.Provider value={resolvedSettings}>
        <UIStateContext.Provider value={resolvedUIState}>
          <StatusDisplay {...props} />
        </UIStateContext.Provider>
      </SettingsContext.Provider>
    </ConfigContext.Provider>,
    width,
  );
  return result;
};

describe('StatusDisplay', () => {
  beforeEach(() => {
    vi.stubEnv(ENV_WRITE_SYSTEM_MD, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders nothing by default if context summary is hidden via props', async () => {
    const { lastFrame, unmount } = await renderStatusDisplay({
      hideContextSummary: true,
    });
    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  it('renders ContextSummaryDisplay by default', async () => {
    const { lastFrame, unmount } = await renderStatusDisplay();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders an active update in the status-line area', async () => {
    const uiState = createMockUIState({
      updateInfo: {
        update: {
          latest: '1.1.1',
          current: '1.1.0',
          type: 'patch',
          name: 'qwen',
        },
        message: 'Update available',
        isUpdating: true,
        status: 'updating',
      },
    });
    const { lastFrame, unmount } = await renderStatusDisplay(
      { hideContextSummary: true },
      uiState,
    );

    const frame = lastFrame().trimEnd();
    expect(frame.split('\n')).toHaveLength(1);
    expect(frame).toContain('Updating from 1.1.0 to 1.1.1');
    expect(frame).not.toContain('Mock Context Summary Display');
    unmount();
  });

  it('renders a failed update in the status-line area', async () => {
    const uiState = createMockUIState({
      updateInfo: {
        update: {
          latest: '1.1.1',
          current: '1.1.0',
          type: 'patch',
          name: 'qwen',
        },
        message: 'Automatic update failed',
        isUpdating: false,
        status: 'failed',
      },
    });
    const { lastFrame, unmount } = await renderStatusDisplay(
      undefined,
      uiState,
    );

    expect(lastFrame()).toContain('✗ Automatic update failed');
    expect(lastFrame()).not.toContain('Mock Context Summary Display');
    unmount();
  });

  it('renders system md indicator if env var is set', async () => {
    vi.stubEnv(ENV_WRITE_SYSTEM_MD, 'true');
    const { lastFrame, unmount } = await renderStatusDisplay();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('hides ContextSummaryDisplay if configured in settings', async () => {
    const settings = createMockSettings({
      ui: { hideContextSummary: true },
    });
    const { lastFrame, unmount } = await renderStatusDisplay(
      { hideContextSummary: false },
      undefined,
      settings,
    );
    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  it('passes unifiedRunningCount to ContextSummaryDisplay', async () => {
    const uiState = createMockUIState({
      unifiedRunningCount: 3,
    });
    const { lastFrame, unmount } = await renderStatusDisplay(
      { hideContextSummary: false },
      uiState,
    );
    expect(lastFrame()).toContain('Shells: 3');
    unmount();
  });

  it('does not repeat a running agent already represented by the session rail', async () => {
    const agent: AgentUnifiedTask = {
      id: 'agent-task',
      type: 'local_agent',
      status: 'running',
      description: 'Check environment compatibility',
      startTime: Date.now(),
      notified: false,
      executionId: 1,
      completionBehavior: 'notify',
      agentId: 'agent-1',
      agentType: 'general-purpose',
      agentName: 'general-purpose',
      prompt: 'Check environment compatibility',
      isBackgrounded: true,
      taskId: 'agent-1',
      inProgressToolUseIds: [],
    };
    const uiState = createMockUIState({
      unifiedTasks: [agent],
      unifiedRunningCount: 1,
    });

    const { lastFrame, unmount } = await renderStatusDisplay(
      { hideContextSummary: false },
      uiState,
    );

    expect(lastFrame()).toContain('Shells: 0');
    unmount();
  });

  it('keeps a background shell visible when memory and dream share one rail row', async () => {
    const now = Date.now();
    const shell: BashUnifiedTask = {
      id: 'b-shell',
      type: 'local_bash',
      status: 'running',
      description: 'sleep 10',
      startTime: now,
      notified: false,
      executionId: 10,
      completionBehavior: 'notify',
      command: 'sleep 10',
      isBackgrounded: true,
      output: '',
    };
    const memory: InternalAgentUnifiedTask = {
      id: 'internal-auto-memory',
      type: 'internal_agent',
      status: 'running',
      description: 'Memory',
      startTime: now,
      notified: false,
      executionId: -1,
      completionBehavior: 'silent',
      agentName: 'Memory',
      agentType: 'memory',
      prompt: 'Memory',
      phase: 'running',
      isBackgrounded: true,
      killable: false,
    };
    const dream: InternalAgentUnifiedTask = {
      ...memory,
      id: 'internal-auto-dream',
      executionId: -2,
      description: 'Dreaming',
      agentName: 'Dreaming',
      agentType: 'dream',
      prompt: 'Dreaming',
    };
    const uiState = createMockUIState({
      unifiedTasks: [shell, memory, dream],
      unifiedRunningCount: 3,
    });

    const { lastFrame, unmount } = await renderStatusDisplay(
      { hideContextSummary: false },
      uiState,
    );

    expect(lastFrame()).toContain('Shells: 1');
    unmount();
  });

});
