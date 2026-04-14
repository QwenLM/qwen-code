/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentSpawnConfig } from './types.js';

// ─── Hoisted mocks for iterm-it2 ────────────────────────────────
const hoistedVerifyITerm = vi.hoisted(() => vi.fn());
const hoistedItermSplitPane = vi.hoisted(() => vi.fn());
const hoistedItermRunCommand = vi.hoisted(() => vi.fn());
const hoistedItermSendText = vi.hoisted(() => vi.fn());
const hoistedItermFocusSession = vi.hoisted(() => vi.fn());
const hoistedItermCloseSession = vi.hoisted(() => vi.fn());

vi.mock('./iterm-it2.js', () => ({
  verifyITerm: hoistedVerifyITerm,
  itermSplitPane: hoistedItermSplitPane,
  itermRunCommand: hoistedItermRunCommand,
  itermSendText: hoistedItermSendText,
  itermFocusSession: hoistedItermFocusSession,
  itermCloseSession: hoistedItermCloseSession,
}));

// ─── Hoisted mocks for node:fs/promises ─────────────────────────
const hoistedFsMkdir = vi.hoisted(() => vi.fn());
const hoistedFsReadFile = vi.hoisted(() => vi.fn());
const hoistedFsRm = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  mkdir: hoistedFsMkdir,
  readFile: hoistedFsReadFile,
  rm: hoistedFsRm,
}));

// Mock debug logger
vi.mock('../../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { ITermBackend } from './ITermBackend.js';

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

function setupDefaultMocks(): void {
  hoistedVerifyITerm.mockResolvedValue(undefined);
  hoistedItermSplitPane.mockResolvedValue('sess-new-1');
  hoistedItermRunCommand.mockResolvedValue(undefined);
  hoistedItermSendText.mockResolvedValue(undefined);
  hoistedItermFocusSession.mockResolvedValue(undefined);
  hoistedItermCloseSession.mockResolvedValue(undefined);
  hoistedFsMkdir.mockResolvedValue(undefined);
  // Default: marker file doesn't exist yet (agent still running)
  hoistedFsReadFile.mockRejectedValue(new Error('ENOENT'));
  hoistedFsRm.mockResolvedValue(undefined);
}

describe('ITermBackend', () => {
  let backend: ITermBackend;
  let savedItermSessionId: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    savedItermSessionId = process.env['ITERM_SESSION_ID'];
    delete process.env['ITERM_SESSION_ID'];
    setupDefaultMocks();
    backend = new ITermBackend();
  });

  afterEach(async () => {
    await backend.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (savedItermSessionId !== undefined) {
      process.env['ITERM_SESSION_ID'] = savedItermSessionId;
    } else {
      delete process.env['ITERM_SESSION_ID'];
    }
  });

  // ─── Initialization ─────────────────────────────────────────

  it('throws if spawnAgent is called before init', async () => {
    await expect(backend.spawnAgent(makeConfig('a1'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('init verifies iTerm availability', async () => {
    await backend.init();
    expect(hoistedVerifyITerm).toHaveBeenCalled();
  });

  it('init creates exit marker directory', async () => {
    await backend.init();
    expect(hoistedFsMkdir).toHaveBeenCalledWith(
      expect.stringContaining('agent-iterm-exit-'),
      { recursive: true },
    );
  });

  it('init is idempotent', async () => {
    await backend.init();
    await backend.init();
    expect(hoistedVerifyITerm).toHaveBeenCalledTimes(1);
  });

  // ─── Spawning ─────────────────────────────────────────────

  it('spawns first agent using ITERM_SESSION_ID when set', async () => {
    process.env['ITERM_SESSION_ID'] = 'leader-sess';
    backend = new ITermBackend();
    await backend.init();

    await backend.spawnAgent(makeConfig('agent-1'));

    expect(hoistedItermSplitPane).toHaveBeenCalledWith('leader-sess');
    expect(hoistedItermRunCommand).toHaveBeenCalledWith(
      'sess-new-1',
      expect.any(String),
    );
    expect(backend.getActiveAgentId()).toBe('agent-1');
  });

  it('spawns first agent without ITERM_SESSION_ID', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('agent-1'));

    expect(hoistedItermSplitPane).toHaveBeenCalledWith(undefined);
    expect(backend.getActiveAgentId()).toBe('agent-1');
  });

  it('spawns subsequent agent from last session', async () => {
    await backend.init();

    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('agent-1'));

    hoistedItermSplitPane.mockResolvedValueOnce('sess-2');
    await backend.spawnAgent(makeConfig('agent-2'));

    // Second split should use the first agent's session as source
    expect(hoistedItermSplitPane).toHaveBeenLastCalledWith('sess-1');
  });

  it('rejects duplicate agent IDs', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('dup'));

    await expect(backend.spawnAgent(makeConfig('dup'))).rejects.toThrow(
      'already exists',
    );
  });

  it('registers failed agent and fires exit callback on spawn error', async () => {
    await backend.init();
    hoistedItermSplitPane.mockRejectedValueOnce(new Error('split failed'));

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    await backend.spawnAgent(makeConfig('fail'));

    expect(exitCallback).toHaveBeenCalledWith('fail', 1, null);
  });

  // ─── buildShellCommand (env key validation) ────────────────

  it('rejects invalid environment variable names', async () => {
    await backend.init();

    await expect(
      backend.spawnAgent(makeConfig('bad-env', { env: { 'FOO BAR': 'baz' } })),
    ).rejects.toThrow('Invalid environment variable name');
  });

  it('rejects env key starting with a digit', async () => {
    await backend.init();

    await expect(
      backend.spawnAgent(makeConfig('bad-env', { env: { '1VAR': 'baz' } })),
    ).rejects.toThrow('Invalid environment variable name');
  });

  it('accepts valid environment variable names', async () => {
    await backend.init();

    await expect(
      backend.spawnAgent(
        makeConfig('good-env', {
          env: { MY_VAR_123: 'hello', _PRIVATE: 'world' },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  // ─── buildShellCommand (atomic marker write) ──────────────

  it('builds command with atomic exit marker write', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    const cmdArg = hoistedItermRunCommand.mock.calls[0]![1] as string;
    // Should contain write-then-rename pattern
    expect(cmdArg).toMatch(/echo \$\? > .+\.tmp.+ && mv .+\.tmp/);
  });

  it('builds command with cd and quoted args', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    const cmdArg = hoistedItermRunCommand.mock.calls[0]![1] as string;
    expect(cmdArg).toContain("cd '/tmp/test'");
    expect(cmdArg).toContain("'/usr/bin/node'");
    expect(cmdArg).toContain("'agent.js'");
  });

  it('includes env vars in command when provided', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a', { env: { NODE_ENV: 'test' } }));

    const cmdArg = hoistedItermRunCommand.mock.calls[0]![1] as string;
    expect(cmdArg).toContain("NODE_ENV='test'");
    expect(cmdArg).toContain('env ');
  });

  // ─── Navigation ───────────────────────────────────────────

  it('switchTo changes active agent and focuses session', async () => {
    await backend.init();
    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    hoistedItermSplitPane.mockResolvedValueOnce('sess-2');
    await backend.spawnAgent(makeConfig('b'));

    backend.switchTo('b');
    expect(backend.getActiveAgentId()).toBe('b');
    expect(hoistedItermFocusSession).toHaveBeenCalledWith('sess-2');
  });

  it('switchTo throws for unknown agent', async () => {
    await backend.init();
    expect(() => backend.switchTo('ghost')).toThrow('not found');
  });

  it('switchToNext and switchToPrevious cycle correctly', async () => {
    await backend.init();

    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    hoistedItermSplitPane.mockResolvedValueOnce('sess-2');
    await backend.spawnAgent(makeConfig('b'));

    expect(backend.getActiveAgentId()).toBe('a');
    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('b');
    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('a');
    backend.switchToPrevious();
    expect(backend.getActiveAgentId()).toBe('b');
  });

  it('switchToNext does nothing with a single agent', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('solo'));
    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('solo');
  });

  it('switchToPrevious does nothing with a single agent', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('solo'));
    backend.switchToPrevious();
    expect(backend.getActiveAgentId()).toBe('solo');
  });

  // ─── Stop & Cleanup ──────────────────────────────────────

  it('stopAgent closes session and fires exit callback', async () => {
    await backend.init();
    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    backend.stopAgent('a');

    expect(hoistedItermCloseSession).toHaveBeenCalledWith('sess-1');
    expect(exitCallback).toHaveBeenCalledWith('a', 1, null);
  });

  it('stopAgent is a no-op for already-stopped agent', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));
    backend.stopAgent('a');
    hoistedItermCloseSession.mockClear();

    backend.stopAgent('a');
    expect(hoistedItermCloseSession).not.toHaveBeenCalled();
  });

  it('stopAgent is a no-op for unknown agent', async () => {
    await backend.init();
    backend.stopAgent('ghost');
    expect(hoistedItermCloseSession).not.toHaveBeenCalled();
  });

  it('stopAll closes all sessions and resets activeAgentId', async () => {
    await backend.init();
    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    hoistedItermSplitPane.mockResolvedValueOnce('sess-2');
    await backend.spawnAgent(makeConfig('b'));

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    backend.stopAll();

    expect(hoistedItermCloseSession).toHaveBeenCalledTimes(2);
    expect(exitCallback).toHaveBeenCalledTimes(2);
    expect(backend.getActiveAgentId()).toBeNull();
  });

  it('cleanup closes sessions and removes exit marker directory', async () => {
    await backend.init();
    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    await backend.cleanup();

    expect(hoistedItermCloseSession).toHaveBeenCalledWith('sess-1');
    expect(hoistedFsRm).toHaveBeenCalledWith(
      expect.stringContaining('agent-iterm-exit-'),
      { recursive: true, force: true },
    );
    expect(backend.getActiveAgentId()).toBeNull();
  });

  it('cleanup tolerates session close errors', async () => {
    await backend.init();
    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    hoistedItermCloseSession.mockRejectedValueOnce(new Error('session gone'));

    // Should not throw
    await expect(backend.cleanup()).resolves.toBeUndefined();
  });

  it('cleanup tolerates exit marker removal errors', async () => {
    await backend.init();
    hoistedFsRm.mockRejectedValueOnce(new Error('ENOENT'));

    // Should not throw
    await expect(backend.cleanup()).resolves.toBeUndefined();
  });

  // ─── Exit Detection ─────────────────────────────────────────

  it('marks agent as exited when marker file appears', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    // Simulate marker file appearing with exit code 0
    hoistedFsReadFile.mockResolvedValue('0\n');

    await vi.advanceTimersByTimeAsync(600);

    expect(exitCallback).toHaveBeenCalledWith('a', 0, null);
  });

  it('preserves non-zero exit codes from marker', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    hoistedFsReadFile.mockResolvedValue('42\n');

    await vi.advanceTimersByTimeAsync(600);

    expect(exitCallback).toHaveBeenCalledWith('a', 42, null);
  });

  it('defaults to exit code 1 when marker contains NaN', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    hoistedFsReadFile.mockResolvedValue('garbage\n');

    await vi.advanceTimersByTimeAsync(600);

    expect(exitCallback).toHaveBeenCalledWith('a', 1, null);
  });

  it('does not fire callback twice for the same agent', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    hoistedFsReadFile.mockResolvedValue('0\n');

    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);

    expect(exitCallback).toHaveBeenCalledTimes(1);
  });

  it('stops polling once all agents have exited', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    hoistedFsReadFile.mockResolvedValue('0\n');

    await vi.advanceTimersByTimeAsync(600);

    // Reset to track future reads
    hoistedFsReadFile.mockClear();

    // Advance more — should not poll anymore
    await vi.advanceTimersByTimeAsync(2000);
    expect(hoistedFsReadFile).not.toHaveBeenCalled();
  });

  // ─── waitForAll ─────────────────────────────────────────────

  it('waitForAll resolves immediately when no agents exist', async () => {
    await backend.init();
    const result = await backend.waitForAll();
    expect(result).toBe(true);
  });

  it('waitForAll resolves when all agents exit', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    hoistedFsReadFile.mockResolvedValue('0\n');

    const waitPromise = backend.waitForAll();
    await vi.advanceTimersByTimeAsync(600);

    const result = await waitPromise;
    expect(result).toBe(true);
  });

  it('waitForAll returns false on timeout', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));

    // Marker never appears (readFile keeps throwing)
    const waitPromise = backend.waitForAll(1000);
    await vi.advanceTimersByTimeAsync(1100);

    const result = await waitPromise;
    expect(result).toBe(false);
  });

  // ─── Input ─────────────────────────────────────────────────

  it('writeToAgent sends text via itermSendText', async () => {
    await backend.init();
    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    const result = backend.writeToAgent('a', 'hello');
    expect(result).toBe(true);
    expect(hoistedItermSendText).toHaveBeenCalledWith('sess-1', 'hello');
  });

  it('writeToAgent returns false for unknown agent', async () => {
    await backend.init();
    expect(backend.writeToAgent('ghost', 'hello')).toBe(false);
  });

  it('writeToAgent returns false for stopped agent', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));
    backend.stopAgent('a');

    expect(backend.writeToAgent('a', 'hello')).toBe(false);
  });

  it('forwardInput delegates to active agent', async () => {
    await backend.init();
    hoistedItermSplitPane.mockResolvedValueOnce('sess-1');
    await backend.spawnAgent(makeConfig('a'));

    const result = backend.forwardInput('hello');
    expect(result).toBe(true);
    expect(hoistedItermSendText).toHaveBeenCalledWith('sess-1', 'hello');
  });

  it('forwardInput returns false with no active agent', async () => {
    await backend.init();
    expect(backend.forwardInput('hello')).toBe(false);
  });

  // ─── Snapshots ──────────────────────────────────────────────

  it('getActiveSnapshot returns null', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));
    expect(backend.getActiveSnapshot()).toBeNull();
  });

  it('getAgentSnapshot returns null', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));
    expect(backend.getAgentSnapshot('a')).toBeNull();
  });

  it('getAgentScrollbackLength returns 0', async () => {
    await backend.init();
    await backend.spawnAgent(makeConfig('a'));
    expect(backend.getAgentScrollbackLength('a')).toBe(0);
  });

  // ─── getAttachHint ──────────────────────────────────────────

  it('getAttachHint returns null', async () => {
    await backend.init();
    expect(backend.getAttachHint()).toBeNull();
  });

  // ─── resizeAll ──────────────────────────────────────────────

  it('resizeAll is a no-op', async () => {
    await backend.init();
    // Should not throw
    backend.resizeAll(80, 24);
  });

  // ─── type ───────────────────────────────────────────────────

  it('has type "iterm2"', () => {
    expect(backend.type).toBe('iterm2');
  });
});
