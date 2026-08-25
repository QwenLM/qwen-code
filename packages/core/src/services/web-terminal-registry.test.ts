/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawn, getPty } = vi.hoisted(() => ({
  spawn: vi.fn(),
  getPty: vi.fn(),
}));

vi.mock('../utils/getPty.js', () => ({ getPty }));

import {
  MAX_CONCURRENT_WEB_TERMINALS,
  resolveWebTerminalShell,
  WebTerminalRegistry,
} from './web-terminal-registry.js';

describe('WebTerminalRegistry', () => {
  let onData: (data: string) => void;
  let onExit: (event: { exitCode: number; signal?: number }) => void;
  let write: ReturnType<typeof vi.fn>;
  let resize: ReturnType<typeof vi.fn>;
  let kill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    write = vi.fn();
    resize = vi.fn();
    kill = vi.fn();
    spawn.mockReturnValue({
      pid: 1,
      write,
      resize,
      kill,
      onData: vi.fn((listener) => {
        onData = listener;
      }),
      onExit: vi.fn((listener) => {
        onExit = listener;
      }),
    });
    getPty.mockResolvedValue({ module: { spawn }, name: 'node-pty' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the resolved workspace and normalizes its environment', async () => {
    const registry = new WebTerminalRegistry();

    await registry.create({
      workspaceCwd: '/workspace',
      env: {
        PATH: '/bin',
        TERM: 'dumb',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        npm_config_prefix: '/usr/local',
      },
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        cwd: '/workspace',
        env: {
          PATH: '/bin',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          CLICOLOR: '1',
          PROMPT_EOL_MARK: '',
        },
      }),
    );
  });

  it('selects a native Windows shell', () => {
    expect(resolveWebTerminalShell('win32', { COMSPEC: 'pwsh.exe' })).toEqual({
      file: 'pwsh.exe',
      args: [],
    });
    expect(resolveWebTerminalShell('linux', {})).toEqual({
      file: '/bin/sh',
      args: [],
    });
  });

  it('marks concurrent creation as retryable while rejecting established duplicates', async () => {
    let resolvePty: ((value: unknown) => void) | undefined;
    getPty.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePty = resolve;
      }),
    );
    const registry = new WebTerminalRegistry();
    const first = registry.create({
      terminalId: 'terminal:manual-1',
      workspaceCwd: '/workspace',
    });

    await expect(
      registry.create({
        terminalId: 'terminal:manual-1',
        workspaceCwd: '/workspace',
      }),
    ).resolves.toEqual({
      error: 'Web terminal terminal:manual-1 is being created',
      retryable: true,
    });
    resolvePty?.({ module: { spawn }, name: 'node-pty' });
    await first;

    await expect(
      registry.create({
        terminalId: 'terminal:manual-1',
        workspaceCwd: '/workspace',
      }),
    ).resolves.toEqual({
      error: 'Web terminal terminal:manual-1 already exists',
    });
  });

  it('caps established and in-flight terminal sessions', async () => {
    const registry = new WebTerminalRegistry();
    for (let i = 0; i < MAX_CONCURRENT_WEB_TERMINALS - 1; i++) {
      await registry.create({
        terminalId: `terminal:${i}`,
        workspaceCwd: '/workspace',
      });
    }
    let resolvePty: ((value: unknown) => void) | undefined;
    getPty.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePty = resolve;
      }),
    );
    const pending = registry.create({
      terminalId: 'terminal:pending',
      workspaceCwd: '/workspace',
    });

    await expect(
      registry.create({
        terminalId: 'terminal:over-limit',
        workspaceCwd: '/workspace',
      }),
    ).resolves.toEqual({ error: 'Web terminal limit reached' });
    resolvePty?.({ module: { spawn }, name: 'node-pty' });
    await pending;

    registry.release('terminal:0');
    await expect(
      registry.create({
        terminalId: 'terminal:replacement',
        workspaceCwd: '/workspace',
      }),
    ).resolves.toEqual({ terminalId: 'terminal:replacement' });
  });

  it('returns stable errors when PTY loading or spawning fails', async () => {
    const registry = new WebTerminalRegistry();
    getPty.mockResolvedValueOnce(null);
    await expect(
      registry.create({ workspaceCwd: '/workspace' }),
    ).resolves.toEqual({ error: 'PTY not available' });

    spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expect(
      registry.create({ workspaceCwd: '/workspace' }),
    ).resolves.toEqual({ error: 'Failed to spawn shell' });
  });

  it('caps replay output and records exit state', async () => {
    const registry = new WebTerminalRegistry();
    const created = await registry.create({
      terminalId: 'terminal:buffer',
      workspaceCwd: '/workspace',
    });
    if ('error' in created) throw new Error(created.error);
    const { terminalId } = created;

    for (let i = 0; i < 4001; i++) onData(String(i % 10));
    onExit({ exitCode: 7 });

    const snapshot = registry.readSnapshot(terminalId);
    expect(snapshot?.output).toHaveLength(4000);
    expect(snapshot).toMatchObject({
      exited: true,
      exitCode: 7,
      workspaceCwd: '/workspace',
    });
    expect(registry.write(terminalId, 'ignored')).toBe(false);
    expect(registry.resize(terminalId, 80, 24)).toBe(false);
  });

  it('caps replay output by UTF-8 bytes', async () => {
    const registry = new WebTerminalRegistry();
    await registry.create({
      terminalId: 'terminal:utf8-buffer',
      workspaceCwd: '/workspace',
    });

    onData('界'.repeat(1_500_000));

    expect(registry.readSnapshot('terminal:utf8-buffer')?.output).toBe('');
  });

  it('releases a live PTY immediately and only once', async () => {
    const registry = new WebTerminalRegistry();
    await registry.create({
      terminalId: 'terminal:release',
      workspaceCwd: '/workspace',
    });

    expect(registry.release('terminal:release')).toBe(true);
    expect(registry.release('terminal:release')).toBe(false);
    expect(kill).toHaveBeenCalledOnce();
    expect(registry.readSnapshot('terminal:release')).toBeUndefined();
  });

  it('does not spawn a PTY after disposal wins an in-flight create', async () => {
    let resolvePty: ((value: unknown) => void) | undefined;
    getPty.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePty = resolve;
      }),
    );
    const registry = new WebTerminalRegistry();
    const creating = registry.create({
      terminalId: 'terminal:pending',
      workspaceCwd: '/workspace',
    });

    registry.dispose();
    resolvePty?.({ module: { spawn }, name: 'node-pty' });

    await expect(creating).resolves.toEqual({
      error: 'Web terminal registry disposed',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['terminal', 'workspace'] as const)(
    'cancels in-flight creation when releasing its %s',
    async (scope) => {
      let resolvePty: ((value: unknown) => void) | undefined;
      getPty.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePty = resolve;
        }),
      );
      const registry = new WebTerminalRegistry();
      const creating = registry.create({
        terminalId: 'terminal:pending',
        workspaceCwd: '/workspace',
      });

      if (scope === 'terminal') {
        expect(registry.release('terminal:pending')).toBe(true);
      } else {
        registry.releaseWorkspace('/workspace');
      }
      resolvePty?.({ module: { spawn }, name: 'node-pty' });

      await expect(creating).resolves.toEqual({
        error: 'Web terminal creation cancelled',
      });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('keeps another workspace in-flight when one workspace is released', async () => {
    let resolveA: ((value: unknown) => void) | undefined;
    let resolveB: ((value: unknown) => void) | undefined;
    getPty
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveB = resolve;
        }),
      );
    const registry = new WebTerminalRegistry();
    const creatingA = registry.create({
      terminalId: 'terminal:a',
      workspaceCwd: '/workspace-a',
    });
    const creatingB = registry.create({
      terminalId: 'terminal:b',
      workspaceCwd: '/workspace-b',
    });

    registry.releaseWorkspace('/workspace-a');
    resolveA?.({ module: { spawn }, name: 'node-pty' });
    resolveB?.({ module: { spawn }, name: 'node-pty' });

    await expect(creatingA).resolves.toEqual({
      error: 'Web terminal creation cancelled',
    });
    await expect(creatingB).resolves.toEqual({ terminalId: 'terminal:b' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: '/workspace-b' }),
    );
  });

  it('does not let another workspace cancel an in-flight terminal', async () => {
    let resolvePty: ((value: unknown) => void) | undefined;
    getPty.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePty = resolve;
      }),
    );
    const registry = new WebTerminalRegistry();
    const creating = registry.create({
      terminalId: 'terminal:pending',
      workspaceCwd: '/workspace-a',
    });

    expect(registry.release('terminal:pending', '/workspace-b')).toBe(false);
    resolvePty?.({ module: { spawn }, name: 'node-pty' });

    await expect(creating).resolves.toEqual({
      terminalId: 'terminal:pending',
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('releases only terminals owned by a draining workspace', async () => {
    const registry = new WebTerminalRegistry();
    await registry.create({
      terminalId: 'terminal:a',
      workspaceCwd: '/workspace-a',
    });
    const killA = kill;
    const exitA = onExit;
    const exitListener = vi.fn();
    registry.addExitListener('terminal:a', exitListener);
    killA.mockImplementation(() => exitA({ exitCode: 0 }));
    await registry.create({
      terminalId: 'terminal:b',
      workspaceCwd: '/workspace-b',
    });

    registry.releaseWorkspace('/workspace-a');

    expect(killA).toHaveBeenCalledOnce();
    expect(exitListener).toHaveBeenCalledWith({ exitCode: 0 });
    expect(registry.readSnapshot('terminal:a')).toBeUndefined();
    expect(registry.readSnapshot('terminal:b')).toBeDefined();
  });

  it('reclaims only after the final listener stays detached', async () => {
    vi.useFakeTimers();
    const registry = new WebTerminalRegistry();
    await registry.create({
      terminalId: 'terminal:idle',
      workspaceCwd: '/workspace',
    });
    const detachOne = registry.addOutputListener('terminal:idle', vi.fn());
    const detachTwo = registry.addOutputListener('terminal:idle', vi.fn());

    detachOne?.();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(kill).not.toHaveBeenCalled();

    detachTwo?.();
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    const detachReconnect = registry.addOutputListener(
      'terminal:idle',
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(kill).not.toHaveBeenCalled();

    detachReconnect?.();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(kill).toHaveBeenCalledOnce();
    expect(registry.readSnapshot('terminal:idle')).toBeUndefined();
  });
});
