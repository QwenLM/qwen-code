/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component tests for the OpenTUI arena dialogs (#10728 test-hardening
 * slice): the start multi-select (model filtering, the qwen-oauth disabled
 * row, the ≥2-models gate, composer fill), the status table (in-process
 * live stats vs agent-state fallbacks), the stop radio (preserve default,
 * cancel → settle → cleanup chain, failure surface), and the select winner
 * picker (initial cursor on the first successful agent, preview/diff
 * panes, apply + runtime cleanup, discard-all). The dialogs never launch
 * sessions themselves — everything is asserted through the config/manager
 * stubs they call, so no real Arena backend is spawned.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentStatus,
  ArenaSessionStatus,
  AuthType,
  DISPLAY_MODE,
  type Config,
} from '@qwen-code/qwen-code-core';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useRenderer: () => ({}),
  useTerminalDimensions: () => ({ width: 120, height: 40 }),
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: { name?: string }) => ({ name: key.name ?? '' }),
}));
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));

import { OpenTuiArenaDialog } from './dialogs-arena.js';

type ArenaProps = ComponentProps<typeof OpenTuiArenaDialog>;

function press(name: string) {
  const handler = mocks.state.keyboardHandlers.at(-1);
  if (!handler) throw new Error('no keyboard handler registered');
  act(() => handler({ name }));
}

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    getAllConfiguredModels: () => [],
    getArenaManager: () => null,
    setArenaManager: vi.fn(),
    cleanupArenaRuntime: vi.fn().mockResolvedValue(undefined),
    getAgentsSettings: () => ({}),
    ...overrides,
  } as unknown as Config;
}

function makeManager(overrides: Record<string, unknown> = {}) {
  return {
    getBackend: () => null,
    getSessionStatus: () => ArenaSessionStatus.IDLE,
    getAgentStates: () => [],
    getAgentState: (_agentId: string) => undefined,
    getTask: () => 'write more tests',
    getResult: () => null,
    cancel: vi.fn().mockResolvedValue(undefined),
    waitForSettled: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    cleanupRuntime: vi.fn().mockResolvedValue(undefined),
    applyAgentResult: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

const STATS = {
  rounds: 2,
  totalTokens: 1200,
  inputTokens: 600,
  outputTokens: 400,
  durationMs: 4500,
  toolCalls: 6,
  successfulToolCalls: 5,
  failedToolCalls: 1,
};

function makeAgentState(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-a',
    model: { modelId: 'qwen3-coder-plus' },
    status: AgentStatus.COMPLETED,
    startedAt: Date.now() - 5000,
    stats: { ...STATS },
    ...overrides,
  };
}

function makeResultAgent(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-a',
    model: { modelId: 'qwen3-coder-plus' },
    status: AgentStatus.COMPLETED,
    worktree: {},
    stats: { ...STATS },
    diffSummary: {
      files: [{ path: 'src/a.ts', additions: 8, deletions: 2 }],
      additions: 10,
      deletions: 3,
    },
    modifiedFiles: ['src/a.ts'],
    approachSummary: 'Add suites for the arena dialogs',
    diff: 'diff --git a/src/a.ts b/src/a.ts\n+export const A = 1;\n-old line',
    startedAt: Date.now() - 60000,
    ...overrides,
  };
}

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'arena-1',
    task: 'write more tests',
    status: ArenaSessionStatus.COMPLETED,
    agents: [makeResultAgent()],
    startedAt: Date.now() - 60000,
    wasRepoInitialized: false,
    ...overrides,
  };
}

const MODELS = [
  { id: 'qwen3-max', label: 'Qwen3 Max OAuth', authType: AuthType.QWEN_OAUTH },
  { id: 'model-b', label: 'Model B', authType: AuthType.USE_OPENAI },
  { id: 'model-c', label: 'Model C', authType: AuthType.USE_OPENAI },
  {
    id: 'runtime-only',
    label: 'Runtime Only',
    authType: AuthType.USE_OPENAI,
    isRuntimeModel: true,
  },
  {
    id: 'image-only',
    label: 'Image Only',
    authType: AuthType.USE_OPENAI,
    imageOnly: true,
  },
];

function renderArena(props: Partial<ArenaProps> = {}) {
  const merged = {
    mode: 'start',
    onClose: vi.fn(),
    notify: vi.fn(),
    ...props,
  } as ArenaProps;
  return render(<OpenTuiArenaDialog {...merged} />);
}

beforeEach(() => {
  mocks.state.keyboardHandlers.length = 0;
});

describe('OpenTuiArenaDialog start', () => {
  it('lists only selectable models, disables qwen-oauth, links the guide', () => {
    const onFillInput = vi.fn();
    renderArena({
      config: makeConfig({ getAllConfiguredModels: () => MODELS }),
      onFillInput,
    });

    expect(screen.getByText('[qwen-oauth] Qwen3 Max OAuth')).toBeTruthy();
    expect(screen.getByText('[openai] Model B')).toBeTruthy();
    expect(screen.getByText('[openai] Model C')).toBeTruthy();
    // Runtime and image-only models never reach the picker.
    expect(screen.queryByText(/Runtime Only/)).toBeNull();
    expect(screen.queryByText(/Image Only/)).toBeNull();
    expect(
      screen.getByText('Note: qwen-oauth models are not supported in Arena.'),
    ).toBeTruthy();
    // Exactly two selectable models also surfaces the docs hint.
    expect(screen.getByText(/modelProviders guide/)).toBeTruthy();
  });

  it('does not toggle the disabled qwen-oauth row with space', () => {
    renderArena({
      config: makeConfig({ getAllConfiguredModels: () => MODELS }),
    });
    press('space');
    expect(screen.queryByText(/\[x\]/)).toBeNull();
  });

  it('rejects Enter with fewer than two models checked', () => {
    const onClose = vi.fn();
    const onFillInput = vi.fn();
    renderArena({
      config: makeConfig({ getAllConfiguredModels: () => MODELS }),
      onClose,
      onFillInput,
    });
    press('down');
    press('space');
    press('return');
    expect(
      screen.getByText(
        'Please select at least 2 models to start an Arena session.',
      ),
    ).toBeTruthy();
    expect(onFillInput).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fills the composer with the checked models and closes on Enter', () => {
    const onClose = vi.fn();
    const onFillInput = vi.fn();
    renderArena({
      config: makeConfig({ getAllConfiguredModels: () => MODELS }),
      onClose,
      onFillInput,
    });
    press('down');
    press('space');
    press('down');
    press('space');
    press('return');
    expect(onFillInput).toHaveBeenCalledWith(
      '/arena start --models openai:model-b,openai:model-c ',
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks for more models when fewer than two are selectable', () => {
    renderArena({
      config: makeConfig({
        getAllConfiguredModels: () => MODELS.slice(0, 2),
      }),
    });
    expect(
      screen.getByText('Arena requires at least 2 models. To add more:'),
    ).toBeTruthy();
    expect(screen.queryByText(/modelProviders guide/)).toBeNull();
  });

  it('closes on Esc without filling the composer', () => {
    const onClose = vi.fn();
    const onFillInput = vi.fn();
    renderArena({
      config: makeConfig({ getAllConfiguredModels: () => MODELS }),
      onClose,
      onFillInput,
    });
    press('escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFillInput).not.toHaveBeenCalled();
  });
});

describe('OpenTuiArenaDialog status', () => {
  it('shows the empty frame when no session is registered', () => {
    renderArena({ mode: 'status', config: makeConfig() });
    expect(screen.getByText('No running Arena session found.')).toBeTruthy();
  });

  it('renders the live agent table, preferring in-process stats', () => {
    const manager = makeManager({
      getSessionStatus: () => ArenaSessionStatus.RUNNING,
      getAgentStates: () => [
        makeAgentState(),
        makeAgentState({
          agentId: 'agent-b',
          model: { modelId: 'm'.repeat(40) },
          status: AgentStatus.FAILED,
          stats: { ...STATS, outputTokens: 2500 },
        }),
      ],
      getBackend: () => ({
        type: DISPLAY_MODE.IN_PROCESS,
        getAgent: (agentId: string) =>
          agentId === 'agent-a'
            ? {
                getStats: () => ({
                  outputTokens: 65000,
                  rounds: 3,
                  totalToolCalls: 4,
                  successfulToolCalls: 4,
                  failedToolCalls: 0,
                }),
              }
            : undefined,
      }),
    });
    renderArena({
      mode: 'status',
      config: makeConfig({ getArenaManager: () => manager }),
    });

    expect(screen.getByText('Arena Status')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('"write more tests"')).toBeTruthy();
    // Live in-process numbers override the persisted agent stats...
    expect(screen.getByText('65,000')).toBeTruthy();
    // ...while agents without an interactive handle fall back to state.
    expect(screen.getByText('2,500')).toBeTruthy();
    // Status labels come from the shared arena status mapping.
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    // Over-long model ids truncate with an ellipsis at 35 chars.
    expect(screen.getByText(`${'m'.repeat(34)}…`)).toBeTruthy();
  });

  it('closes on Esc, Enter, or q', () => {
    const onClose = vi.fn();
    renderArena({ mode: 'status', config: makeConfig(), onClose });
    press('q');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OpenTuiArenaDialog stop', () => {
  it('runs cancel → settle → cleanup by default and clears the manager', async () => {
    const manager = makeManager({
      getSessionStatus: () => ArenaSessionStatus.RUNNING,
    });
    const config = makeConfig({ getArenaManager: () => manager });
    const notify = vi.fn();
    const onClose = vi.fn();
    renderArena({ mode: 'stop', config, notify, onClose });

    expect(screen.getByText('Stop and clean up')).toBeTruthy();
    expect(screen.getByText('Stop and preserve artifacts')).toBeTruthy();
    press('return');
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Arena session stopped. All Arena resources (including Git worktrees) were cleaned up.',
      ),
    );
    expect(manager.cancel).toHaveBeenCalledTimes(1);
    expect(manager.waitForSettled).toHaveBeenCalledTimes(1);
    expect(manager.cleanup).toHaveBeenCalledTimes(1);
    expect(manager.cleanupRuntime).not.toHaveBeenCalled();
    expect(config.setArenaManager).toHaveBeenCalledWith(null);
  });

  it('preselects preserve from agents.arena.preserveArtifacts', async () => {
    const manager = makeManager({
      getSessionStatus: () => ArenaSessionStatus.IDLE,
    });
    const config = makeConfig({
      getArenaManager: () => manager,
      getAgentsSettings: () => ({ arena: { preserveArtifacts: true } }),
    });
    const notify = vi.fn();
    renderArena({ mode: 'stop', config, notify, onClose: vi.fn() });

    expect(
      screen.getByText(
        'Default: preserve (agents.arena.preserveArtifacts is enabled)',
      ),
    ).toBeTruthy();
    press('return');
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('Worktrees and session files were preserved'),
      ),
    );
    // An idle session is never cancelled, and preserve keeps the worktrees.
    expect(manager.cancel).not.toHaveBeenCalled();
    expect(manager.cleanupRuntime).toHaveBeenCalledTimes(1);
    expect(manager.cleanup).not.toHaveBeenCalled();
  });

  it('arrow keys move the radio, so cleanup-default can still preserve', async () => {
    const manager = makeManager({
      getSessionStatus: () => ArenaSessionStatus.IDLE,
    });
    const config = makeConfig({ getArenaManager: () => manager });
    renderArena({ mode: 'stop', config, notify: vi.fn(), onClose: vi.fn() });
    press('up');
    press('return');
    await waitFor(() => expect(manager.cleanupRuntime).toHaveBeenCalled());
    expect(manager.cleanup).not.toHaveBeenCalled();
  });

  it('reports a missing session and cleanup failures through notify', async () => {
    const notify = vi.fn();
    renderArena({
      mode: 'stop',
      config: makeConfig(),
      notify,
      onClose: vi.fn(),
    });
    press('return');
    expect(notify).toHaveBeenCalledWith('✗ No running Arena session found.');

    const failing = makeManager({
      getSessionStatus: () => ArenaSessionStatus.IDLE,
      cleanup: vi.fn().mockRejectedValue(new Error('disk exploded')),
    });
    const notifyFail = vi.fn();
    renderArena({
      mode: 'stop',
      config: makeConfig({ getArenaManager: () => failing }),
      notify: notifyFail,
      onClose: vi.fn(),
    });
    press('return');
    await waitFor(() =>
      expect(notifyFail).toHaveBeenCalledWith(
        '✗ Failed to stop Arena session: disk exploded',
      ),
    );
  });
});

describe('OpenTuiArenaDialog select', () => {
  it('shows the empty frame when no session is registered', () => {
    renderArena({ mode: 'select', config: makeConfig() });
    expect(
      screen.getByText('No arena session found. Start one with /arena start.'),
    ).toBeTruthy();
  });

  function setupSelect(overrides: { applyResult?: unknown } = {}) {
    const agents = [
      makeAgentState({
        agentId: 'agent-b',
        model: { modelId: 'model-b' },
        status: AgentStatus.FAILED,
      }),
      makeAgentState({ agentId: 'agent-a' }),
    ];
    const manager = makeManager({
      getAgentStates: () => agents,
      getResult: () => makeResult(),
      getAgentState: (agentId: string) =>
        agents.find((a) => a.agentId === agentId),
      applyAgentResult: vi
        .fn()
        .mockResolvedValue(overrides.applyResult ?? { success: true }),
    });
    const config = makeConfig({ getArenaManager: () => manager });
    const notify = vi.fn();
    const onClose = vi.fn();
    renderArena({ mode: 'select', config, notify, onClose });
    return { manager, config, notify, onClose };
  }

  it('starts on the first successful agent and applies it on Enter', async () => {
    const { manager, config, notify, onClose } = setupSelect();
    // The failed agent-b is row 0; the cursor must still land on agent-a.
    press('return');
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Applied changes from qwen3-coder-plus to workspace. Arena session complete.',
      ),
    );
    expect(manager.applyAgentResult).toHaveBeenCalledWith('agent-a');
    expect(config.cleanupArenaRuntime).toHaveBeenCalledWith(true);
  });

  it('shows per-agent diff stats next to each row', () => {
    setupSelect();
    expect(screen.getByText('+10')).toBeTruthy();
    expect(screen.getByText('-3')).toBeTruthy();
    expect(screen.getByText('· 1 files')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('toggles the quick preview with p', () => {
    setupSelect();
    expect(screen.queryByText(/Quick Preview/)).toBeNull();
    press('p');
    expect(screen.getByText('Quick Preview · qwen3-coder-plus')).toBeTruthy();
    expect(screen.getByText('Add suites for the arena dialogs')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    press('p');
    expect(screen.queryByText(/Quick Preview/)).toBeNull();
  });

  it('toggles the detailed diff with d', () => {
    setupSelect();
    expect(screen.queryByText(/Detailed Diff/)).toBeNull();
    press('d');
    expect(screen.getByText('Detailed Diff · qwen3-coder-plus')).toBeTruthy();
    expect(screen.getByText('diff --git a/src/a.ts b/src/a.ts')).toBeTruthy();
    expect(screen.getByText('+export const A = 1;')).toBeTruthy();
    press('d');
    expect(screen.queryByText(/Detailed Diff/)).toBeNull();
  });

  it('surfaces an apply failure without cleaning the runtime', async () => {
    const { manager, config, notify } = setupSelect({
      applyResult: { success: false, error: 'merge conflict' },
    });
    press('return');
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        '✗ Failed to apply changes from qwen3-coder-plus: merge conflict',
      ),
    );
    expect(manager.applyAgentResult).toHaveBeenCalledWith('agent-a');
    expect(config.cleanupArenaRuntime).not.toHaveBeenCalled();
  });

  it('discards everything with x', async () => {
    const { config, notify } = setupSelect();
    press('x');
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Arena results discarded. All worktrees cleaned up.',
      ),
    );
    expect(config.cleanupArenaRuntime).toHaveBeenCalledWith(true);
  });

  it('closes on Esc', () => {
    const { onClose } = setupSelect();
    press('escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
