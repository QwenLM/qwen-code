/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentSpawnConfig } from './types.js';

// ─── Hoisted mocks for tmux-commands ────────────────────────────
const hoistedVerifyTmux = vi.hoisted(() => vi.fn());
const hoistedTmuxCurrentPaneId = vi.hoisted(() => vi.fn());
const hoistedTmuxCurrentWindowTarget = vi.hoisted(() => vi.fn());
const hoistedTmuxHasSession = vi.hoisted(() => vi.fn());
const hoistedTmuxHasWindow = vi.hoisted(() => vi.fn());
const hoistedTmuxNewSession = vi.hoisted(() => vi.fn());
const hoistedTmuxNewWindow = vi.hoisted(() => vi.fn());
const hoistedTmuxSplitWindow = vi.hoisted(() => vi.fn());
const hoistedTmuxSendKeys = vi.hoisted(() => vi.fn());
const hoistedTmuxSelectPane = vi.hoisted(() => vi.fn());
const hoistedTmuxSelectPaneTitle = vi.hoisted(() => vi.fn());
const hoistedTmuxSelectPaneStyle = vi.hoisted(() => vi.fn());
const hoistedTmuxSelectLayout = vi.hoisted(() => vi.fn());
const hoistedTmuxListPanes = vi.hoisted(() => vi.fn());
const hoistedTmuxSetOption = vi.hoisted(() => vi.fn());
const hoistedTmuxRespawnPane = vi.hoisted(() => vi.fn());
const hoistedTmuxKillPane = vi.hoisted(() => vi.fn());
const hoistedTmuxKillSession = vi.hoisted(() => vi.fn());
const hoistedTmuxResizePane = vi.hoisted(() => vi.fn());
const hoistedTmuxGetFirstPaneId = vi.hoisted(() => vi.fn());

vi.mock('./tmux-commands.js', () => ({
  verifyTmux: hoistedVerifyTmux,
  tmuxCurrentPaneId: hoistedTmuxCurrentPaneId,
  tmuxCurrentWindowTarget: hoistedTmuxCurrentWindowTarget,
  tmuxHasSession: hoistedTmuxHasSession,
  tmuxHasWindow: hoistedTmuxHasWindow,
  tmuxNewSession: hoistedTmuxNewSession,
  tmuxNewWindow: hoistedTmuxNewWindow,
  tmuxSplitWindow: hoistedTmuxSplitWindow,
  tmuxSendKeys: hoistedTmuxSendKeys,
  tmuxSelectPane: hoistedTmuxSelectPane,
  tmuxSelectPaneTitle: hoistedTmuxSelectPaneTitle,
  tmuxSelectPaneStyle: hoistedTmuxSelectPaneStyle,
  tmuxSelectLayout: hoistedTmuxSelectLayout,
  tmuxListPanes: hoistedTmuxListPanes,
  tmuxSetOption: hoistedTmuxSetOption,
  tmuxRespawnPane: hoistedTmuxRespawnPane,
  tmuxKillPane: hoistedTmuxKillPane,
  tmuxKillSession: hoistedTmuxKillSession,
  tmuxResizePane: hoistedTmuxResizePane,
  tmuxGetFirstPaneId: hoistedTmuxGetFirstPaneId,
}));

// Mock the debug logger
vi.mock('../../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { TmuxBackend } from './TmuxBackend.js';

function makeConfig(
  agentId: string,
  overrides?: Partial<AgentSpawnConfig>,
): AgentSpawnConfig {
  return {
    agentId,
    command: '/usr/bin/node',
    args: ['agent.js'],
    cwd: '/tmp/test',
    ...overrides,
  };
}

/**
 * Spawn an agent with fake timers active. The `sleep()` inside
 * `spawnAgentAsync` uses `setTimeout`, so we must advance fake timers
 * while the spawn promise is pending.
 */
async function spawnWithTimers(
  backend: TmuxBackend,
  config: AgentSpawnConfig,
): Promise<void> {
  const promise = backend.spawnAgent(config);
  // Advance past INTERNAL_LAYOUT_SETTLE_MS (200) / EXTERNAL_LAYOUT_SETTLE_MS (120)
  // and the 100ms triggerMainProcessRedraw timeout
  await vi.advanceTimersByTimeAsync(300);
  await promise;
}

function setupDefaultMocks(): void {
  hoistedVerifyTmux.mockResolvedValue(undefined);
  hoistedTmuxHasSession.mockResolvedValue(false);
  hoistedTmuxHasWindow.mockResolvedValue(false);
  hoistedTmuxNewSession.mockResolvedValue(undefined);
  hoistedTmuxNewWindow.mockResolvedValue(undefined);
  hoistedTmuxGetFirstPaneId.mockResolvedValue('%0');
  hoistedTmuxRespawnPane.mockResolvedValue(undefined);
  hoistedTmuxSplitWindow.mockResolvedValue('%1');
  hoistedTmuxSetOption.mockResolvedValue(undefined);
  hoistedTmuxSelectPaneTitle.mockResolvedValue(undefined);
  hoistedTmuxSelectPaneStyle.mockResolvedValue(undefined);
  hoistedTmuxSelectLayout.mockResolvedValue(undefined);
  hoistedTmuxSelectPane.mockResolvedValue(undefined);
  hoistedTmuxResizePane.mockResolvedValue(undefined);
  hoistedTmuxListPanes.mockResolvedValue([]);
  hoistedTmuxSendKeys.mockResolvedValue(undefined);
  hoistedTmuxKillPane.mockResolvedValue(undefined);
  hoistedTmuxKillSession.mockResolvedValue(undefined);
  hoistedTmuxCurrentPaneId.mockResolvedValue('%0');
  hoistedTmuxCurrentWindowTarget.mockResolvedValue('main:0');
}

describe('TmuxBackend', () => {
  let backend: TmuxBackend;
  let savedTmuxEnv: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    savedTmuxEnv = process.env['TMUX'];
    // Default: running outside tmux
    delete process.env['TMUX'];
    setupDefaultMocks();
    backend = new TmuxBackend();
  });

  afterEach(async () => {
    await backend.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (savedTmuxEnv !== undefined) {
      process.env['TMUX'] = savedTmuxEnv;
    } else {
      delete process.env['TMUX'];
    }
  });

  const pane = (paneId: string, dead = false, deadStatus = 0) => ({
    paneId,
    dead,
    deadStatus,
  });
  const listPanes = (...panes: Array<ReturnType<typeof pane>>) =>
    hoistedTmuxListPanes.mockResolvedValue(panes);
  function onExit() {
    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);
    return exitCallback;
  }

  /**
   * init(), spawn `first`, then spawn each of `more` by splitting: list-panes
   * returns the first agent pane and split-window returns '%2'.
   */
  async function start(first: string, ...more: string[]) {
    await backend.init();
    await spawnWithTimers(backend, makeConfig(first));
    for (const id of more) {
      listPanes(pane('%0'));
      hoistedTmuxSplitWindow.mockResolvedValue('%2');
      await spawnWithTimers(backend, makeConfig(id));
    }
  }

  /** Recreates the backend inside tmux, init()s it, optionally spawns `id`. */
  async function startInsideTmux(id?: string) {
    process.env['TMUX'] = '/tmp/tmux-1000/default,12345,0';
    backend = new TmuxBackend();
    await backend.init();
    if (id === undefined) return;
    listPanes(pane('%0'));
    hoistedTmuxSplitWindow.mockResolvedValue('%1');
    await spawnWithTimers(backend, makeConfig(id));
  }

  it('throws if spawnAgent is called before init', async () => {
    await expect(backend.spawnAgent(makeConfig('a1'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('init verifies tmux availability', async () => {
    await backend.init();
    expect(hoistedVerifyTmux).toHaveBeenCalled();
  });

  it('init is idempotent', async () => {
    await backend.init();
    await backend.init();
    expect(hoistedVerifyTmux).toHaveBeenCalledTimes(1);
  });

  it('spawns first agent outside tmux by respawning the initial pane', async () => {
    await start('agent-1');

    expect(hoistedTmuxNewSession).toHaveBeenCalled();
    expect(hoistedTmuxRespawnPane).toHaveBeenCalledWith(
      '%0',
      expect.any(String),
      expect.any(String),
    );
    expect(backend.getActiveAgentId()).toBe('agent-1');
  });

  it('spawns second agent outside tmux by splitting', async () => {
    await start('agent-1', 'agent-2');

    expect(hoistedTmuxSplitWindow).toHaveBeenCalled();
  });

  it('rejects duplicate agent IDs', async () => {
    await start('dup');

    await expect(backend.spawnAgent(makeConfig('dup'))).rejects.toThrow(
      'already exists',
    );
  });

  it('spawns first agent inside tmux by splitting from main pane', async () => {
    await startInsideTmux('agent-1');

    // Should have split horizontally with firstSplitPercent
    expect(hoistedTmuxSplitWindow).toHaveBeenCalledWith(
      '%0',
      expect.objectContaining({ horizontal: true, percent: 70 }),
    );
    // Should refocus on main pane (inside tmux, no server name arg)
    expect(hoistedTmuxSelectPane).toHaveBeenCalledWith('%0');
  });

  it('switchTo changes active agent', async () => {
    await start('a', 'b');

    backend.switchTo('b');
    expect(backend.getActiveAgentId()).toBe('b');
  });

  it('switchTo throws for unknown agent', async () => {
    await backend.init();
    expect(() => backend.switchTo('ghost')).toThrow('not found');
  });

  it('switchToNext and switchToPrevious cycle correctly', async () => {
    await start('a', 'b');

    expect(backend.getActiveAgentId()).toBe('a');
    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('b');
    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('a');
    backend.switchToPrevious();
    expect(backend.getActiveAgentId()).toBe('b');
  });

  it('switchToNext does nothing with a single agent', async () => {
    await start('solo');
    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('solo');
  });

  it('stopAgent kills the pane', async () => {
    await start('a');
    backend.stopAgent('a');
    expect(hoistedTmuxKillPane).toHaveBeenCalledWith('%0', expect.any(String));
  });

  it('stopAll kills all running panes', async () => {
    await start('a', 'b');

    backend.stopAll();
    expect(hoistedTmuxKillPane).toHaveBeenCalledTimes(2);
  });

  it('cleanup kills panes and the external session', async () => {
    await start('a');
    await backend.cleanup();

    expect(hoistedTmuxKillPane).toHaveBeenCalledWith('%0', expect.any(String));
    expect(hoistedTmuxKillSession).toHaveBeenCalled();
    expect(backend.getActiveAgentId()).toBeNull();
  });

  it('cleanup does not kill session when running inside tmux', async () => {
    await startInsideTmux('a');

    hoistedTmuxKillSession.mockClear();
    await backend.cleanup();

    expect(hoistedTmuxKillSession).not.toHaveBeenCalled();
  });

  // ─── Exit Detection (Bug #1: missing pane → exited) ──────

  it('marks agent as exited when pane disappears from tmux', async () => {
    await start('a');
    const exitCallback = onExit();

    // Polling returns no panes → agent's pane is gone
    listPanes();
    await vi.advanceTimersByTimeAsync(600);

    expect(exitCallback).toHaveBeenCalledWith('a', 1, null);
  });

  it('marks agent as exited when pane reports dead', async () => {
    await start('a');
    const exitCallback = onExit();

    // Polling returns the pane as dead with exit code 42
    listPanes(pane('%0', true, 42));
    await vi.advanceTimersByTimeAsync(600);

    expect(exitCallback).toHaveBeenCalledWith('a', 42, null);
  });

  // ─── waitForAll (Bug #3: cleanup resolves waiters) ────────

  it('waitForAll resolves when all agents exit', async () => {
    await start('a');
    listPanes(pane('%0', true, 0));

    const waitPromise = backend.waitForAll();
    await vi.advanceTimersByTimeAsync(600);

    expect(await waitPromise).toBe(true);
  });

  it('waitForAll resolves after cleanup is called', async () => {
    await start('a');
    // Pane stays alive — without cleanup, waitForAll would hang
    listPanes(pane('%0'));

    const waitPromise = backend.waitForAll();
    // Poll runs but agent still alive; then cleanup, then advance again so
    // the waitForAll interval fires
    await vi.advanceTimersByTimeAsync(600);
    await backend.cleanup();
    await vi.advanceTimersByTimeAsync(600);

    // The key thing is the promise resolves instead of hanging forever.
    // allExited() returns true since panes were cleared in cleanup.
    expect(await waitPromise).toBe(true);
  });

  it('waitForAll returns false on timeout', async () => {
    await start('a');
    listPanes(pane('%0')); // Pane stays alive

    const waitPromise = backend.waitForAll(1000);
    await vi.advanceTimersByTimeAsync(1100);

    expect(await waitPromise).toBe(false);
  });

  it('forwardInput sends literal keys to active agent pane', async () => {
    await start('a');

    expect(backend.forwardInput('hello')).toBe(true);
    expect(hoistedTmuxSendKeys).toHaveBeenCalledWith(
      '%0',
      'hello',
      { literal: true },
      expect.any(String),
    );
  });

  it('forwardInput returns false with no active agent', async () => {
    await backend.init();
    expect(backend.forwardInput('hello')).toBe(false);
  });

  it('getActiveSnapshot returns null (tmux handles rendering)', async () => {
    await start('a');
    expect(backend.getActiveSnapshot()).toBeNull();
  });

  it('getAgentScrollbackLength returns 0', async () => {
    await start('a');
    expect(backend.getAgentScrollbackLength('a')).toBe(0);
  });

  it('returns attach command when outside tmux', async () => {
    await backend.init();
    expect(backend.getAttachHint()).toMatch(/^tmux -L arena-server-\d+ a$/);
  });

  it('returns null when inside tmux', async () => {
    await startInsideTmux();
    expect(backend.getAttachHint()).toBeNull();
  });

  it('registers failed agent and fires exit callback on spawn error', async () => {
    await backend.init();
    // Make the external session setup fail
    hoistedTmuxHasSession.mockRejectedValueOnce(new Error('tmux exploded'));
    const exitCallback = onExit();

    await spawnWithTimers(backend, makeConfig('fail'));

    expect(exitCallback).toHaveBeenCalledWith('fail', 1, null);
  });
});
