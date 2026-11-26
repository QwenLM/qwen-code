/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import { ENV_PID, ENV_CONFIG_DIR } from '../../config/brand.js';
import {
  _resetSnapshotsDirForTest,
  setSnapshotsDir,
} from '../../utils/bash/ShellSnapshot.js';
import {
  _resetPkillSelfProtectionForTest,
  setPkillSelfProtectionEnabled,
} from '../../utils/shell/pkillSelfProtection.js';
import {
  MAX_PTY_SESSIONS,
  parsePtyInputEvents,
  PtySessionService,
} from './ptySessionService.js';

type ExitHandler = (event: { exitCode: number; signal: number }) => void;
type DataHandler = (data: string) => void;

interface MockPty {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData(data: string): void;
  emitExit(exitCode?: number, signal?: number): void;
}

const ptyMocks = vi.hoisted(() => {
  let nextPid = 1000;
  const created: MockPty[] = [];
  const spawn = vi.fn(() => {
    const dataHandlers: DataHandler[] = [];
    const exitHandlers: ExitHandler[] = [];
    const mockPty: MockPty = {
      pid: nextPid++,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData(data: string) {
        for (const handler of dataHandlers) handler(data);
      },
      emitExit(exitCode = 0, signal = 0) {
        for (const handler of exitHandlers) handler({ exitCode, signal });
      },
    };

    Object.assign(mockPty, {
      onData(handler: DataHandler) {
        dataHandlers.push(handler);
        return { dispose: vi.fn() };
      },
      onExit(handler: ExitHandler) {
        exitHandlers.push(handler);
        return { dispose: vi.fn() };
      },
    });

    created.push(mockPty);
    return mockPty;
  });

  return {
    created,
    reset() {
      created.length = 0;
      nextPid = 1000;
      spawn.mockClear();
    },
    spawn,
  };
});

const shellMocks = vi.hoisted(() => ({
  findSuitableShell: vi.fn(async (): Promise<string> => '/bin/sh'),
}));

vi.mock('@lydell/node-pty', () => ({
  spawn: ptyMocks.spawn,
}));

vi.mock('../../utils/Shell.js', () => ({
  findSuitableShell: shellMocks.findSuitableShell,
}));

function createConfig(sessionId: string, pluginBinPaths: string[] = []): Config {
  return {
    getShellExecutionConfig: () => ({}),
    getTargetDir: () => process.cwd(),
    getSessionId: () => sessionId,
    getPluginBinPaths: () => pluginBinPaths,
    sanitizationConfig: {
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
      enableEnvironmentVariableRedaction: false,
    },
  } as unknown as Config;
}

describe('PtySessionService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    setPkillSelfProtectionEnabled(false);
    _resetPkillSelfProtectionForTest();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pty-pkill-test-'));
    setSnapshotsDir(tmpDir);
    ptyMocks.reset();
    shellMocks.findSuitableShell.mockReset();
    shellMocks.findSuitableShell.mockResolvedValue('/bin/sh');
    vi.stubEnv(ENV_CONFIG_DIR, '');
  });

  afterEach(async () => {
    setPkillSelfProtectionEnabled(false);
    _resetPkillSelfProtectionForTest();
    _resetSnapshotsDirForTest();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('parsePtyInputEvents', () => {
    it('splits text submission into text and enter events', () => {
      expect(parsePtyInputEvents('/agents', true)).toMatchObject({
        events: [
          { kind: 'text', bytes: '/agents', label: 'Text(7)' },
          { kind: 'key', bytes: '\r', label: 'Enter' },
        ],
        warnings: [],
      });
    });

    it('splits repeated recognized control keys', () => {
      expect(parsePtyInputEvents('\\t\\t').events).toEqual([
        { kind: 'key', bytes: '\t', label: 'Tab' },
        { kind: 'key', bytes: '\t', label: 'Tab' },
      ]);
      expect(parsePtyInputEvents('\\u001b[C\\u001b[C').events).toEqual([
        { kind: 'key', bytes: '\x1b[C', label: 'ArrowRight' },
        { kind: 'key', bytes: '\x1b[C', label: 'ArrowRight' },
      ]);
    });

    it('passes unrecognized control sequences through as raw with warnings', () => {
      const parsed = parsePtyInputEvents('\\u001b[999~');
      expect(parsed.events).toEqual([
        { kind: 'raw', bytes: '\x1b[999~', label: 'RawControl' },
      ]);
      expect(parsed.warnings).toHaveLength(1);
    });
  });

  it('runs command strings through the selected shell', async () => {
    vi.stubEnv('PATH', '/root/.local/bin:/usr/bin');
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    await service.open(
      {
        command: '/tmp/test-cli --flag="two words"',
        wait_ms: 0,
        idle_ms: 0,
      },
      config,
      undefined,
    );

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [
        '-lc',
        `export PATH='/root/.local/bin':'/usr/bin'; /tmp/test-cli --flag="two words"`,
      ],
      expect.objectContaining({
        cwd: process.cwd(),
      }),
    );
  });

  it('keeps /bin/sh fallback commands unchanged when the guard is enabled', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    setPkillSelfProtectionEnabled(true);
    vi.stubEnv('PATH', '/root/.local/bin:/usr/bin');
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    await service.open(
      { command: 'printf command-ran', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [
        '-lc',
        `export PATH='/root/.local/bin':'/usr/bin'; printf command-ran`,
      ],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it('installs the guard in Linux bash PTY commands when enabled', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    shellMocks.findSuitableShell.mockResolvedValue('/bin/bash');
    setPkillSelfProtectionEnabled(true);
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    await service.open(
      { command: 'printf command-ran', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );

    const [program, args, options] = ptyMocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const command = args[1];
    expect(program).toBe('/bin/bash');
    expect(args[0]).toBe('-lc');
    expect(command).toContain('pkill-guard-');
    expect(command).not.toContain('pkill() {');
    expect(command).not.toContain('\n');
    expect(command.indexOf('pkill-guard-')).toBeLessThan(
      command.indexOf('printf command-ran'),
    );
    expect(options.env[ENV_PID]).toBe(String(process.pid));
  });

  it('installs the guard in Linux zsh PTY commands when enabled', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    shellMocks.findSuitableShell.mockResolvedValue('/bin/zsh');
    setPkillSelfProtectionEnabled(true);
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    await service.open(
      { command: 'printf command-ran', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );

    const [program, args, options] = ptyMocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const command = args[1];
    expect(program).toBe('/bin/zsh');
    expect(args[0]).toBe('-lc');
    expect(command).toContain('pkill-guard-');
    expect(command).not.toContain('pkill() {');
    expect(command).not.toContain('\n');
    expect(command.indexOf('pkill-guard-')).toBeLessThan(
      command.indexOf('printf command-ran'),
    );
    expect(options.env[ENV_PID]).toBe(String(process.pid));
  });

  it('preserves shell semantics for compound commands', async () => {
    vi.stubEnv('PATH', '/root/.local/bin:/usr/bin');
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    await service.open(
      { command: 'echo hi && pwd', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-lc', `export PATH='/root/.local/bin':'/usr/bin'; echo hi && pwd`],
      expect.objectContaining({
        cwd: process.cwd(),
      }),
    );
  });

  it('uses request PATH when restoring PATH inside login shell commands', async () => {
    vi.stubEnv('PATH', '/host/bin:/usr/bin');
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    await service.open(
      {
        command: 'qwen',
        env: { PATH: '/request/bin:/usr/bin' },
        wait_ms: 0,
        idle_ms: 0,
      },
      config,
      undefined,
    );

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [
        '-lc',
        `export PATH='/request/bin':'/usr/bin':'/host/bin'; qwen`,
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: '/request/bin:/usr/bin:/host/bin',
        }),
      }),
    );
  });

  it('keeps config bin before plugin, request, and host PATH in PTY login shell commands', async () => {
    vi.stubEnv('PATH', '/host/bin:/usr/bin');
    vi.stubEnv(ENV_CONFIG_DIR, '/tmp/qwen-config');
    const service = new PtySessionService();
    const config = createConfig('owner-a', ['/tmp/plugin/bin']);

    await service.open(
      {
        command: 'qwen',
        env: { PATH: '/request/bin:/usr/bin' },
        wait_ms: 0,
        idle_ms: 0,
      },
      config,
      undefined,
    );

    const expectedPath = [
      '/tmp/qwen-config/bin',
      '/tmp/plugin/bin',
      '/request/bin',
      '/usr/bin',
      '/host/bin',
    ].join(':');

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [
        '-lc',
        [
          "export PATH='/tmp/qwen-config/bin'",
          ":'/tmp/plugin/bin'",
          ":'/request/bin'",
          ":'/usr/bin'",
          ":'/host/bin'; qwen",
        ].join(''),
      ],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: expectedPath }),
      }),
    );
  });

  it('does not emit a PATH restore when no PATH is available', async () => {
    vi.stubEnv('PATH', undefined);
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    await service.open(
      { command: 'echo hi', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-lc', 'echo hi'],
      expect.anything(),
    );
  });

  it.each(['omitted', 'undefined', 'explicit'] as const)(
    'uses shell environment preparation with %s execution config',
    async (mode) => {
      vi.stubEnv('GIT_TERMINAL_PROMPT', undefined);
      vi.stubEnv('GH_PROMPT_DISABLED', undefined);

      const service = new PtySessionService();
      const config = createConfig('owner-a');
      const prepare = vi.fn(async () => ({
        afterSanitization(env: Record<string, string | undefined>) {
          env['SESSION_ENV_PROBE'] = 'owner-a';
        },
      }));
      config.getShellExecutionConfig = () => ({
        sanitizationConfig: config.sanitizationConfig,
        environmentPreparation: prepare,
      });

      await service.open(
        { command: 'node', wait_ms: 0, idle_ms: 0 },
        config,
        mode === 'omitted' ? undefined : {
          sanitizationConfig: config.sanitizationConfig,
          environmentPreparation: mode === 'explicit' ? {
            afterSanitization(env) { env['SESSION_ENV_PROBE'] = 'explicit'; },
          } : undefined,
        },
      );
      expect(prepare).toHaveBeenCalledTimes(mode === 'explicit' ? 0 : 1);

      const spawnOptions = (
        ptyMocks.spawn.mock.calls[0] as unknown as [
          string,
          string[],
          { env?: Record<string, string> },
        ]
      )[2];
      expect(spawnOptions.env).toMatchObject({
        GIT_EDITOR: 'true',
        TERM: 'xterm-256color',
        SESSION_ENV_PROBE: mode === 'explicit' ? 'explicit' : 'owner-a',
      });
      expect(spawnOptions.env?.['GIT_TERMINAL_PROMPT']).toBeUndefined();
      expect(spawnOptions.env?.['GH_PROMPT_DISABLED']).toBeUndefined();
    },
  );

  it('limits active sessions per owner', async () => {
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    for (let i = 0; i < MAX_PTY_SESSIONS; i++) {
      await service.open(
        { command: 'node', wait_ms: 0, idle_ms: 0 },
        config,
        undefined,
      );
    }

    await expect(
      service.open(
        { command: 'node', wait_ms: 0, idle_ms: 0 },
        config,
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'pty_max_sessions' });
  });

  it('isolates sessions by owner', async () => {
    const service = new PtySessionService();
    const ownerA = createConfig('owner-a');
    const ownerB = createConfig('owner-b');

    const snapshot = await service.open(
      { command: 'node', wait_ms: 0, idle_ms: 0 },
      ownerA,
      undefined,
    );

    expect(service.list(ownerA)).toHaveLength(1);
    expect(service.list(ownerB)).toHaveLength(0);
    await expect(
      service.snapshot(
        { session_id: snapshot.session_id, wait_ms: 0, idle_ms: 0 },
        ownerB,
      ),
    ).rejects.toMatchObject({ code: 'pty_session_not_found' });
  });

  it('rejects writes to exited sessions with a structured code', async () => {
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    const snapshot = await service.open(
      { command: 'node', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );
    ptyMocks.created[0].emitExit(0, 0);

    await expect(
      service.snapshot(
        { session_id: snapshot.session_id, wait_ms: 0, idle_ms: 0 },
        config,
      ),
    ).resolves.toMatchObject({ exit_code: 0, signal: undefined });

    await expect(
      service.write(
        { session_id: snapshot.session_id, chars: '1+1\r', wait_ms: 0 },
        config,
      ),
    ).rejects.toMatchObject({ code: 'pty_session_exited' });
  });

  it('supports pid-based write, snapshot, resize, and close adapters', async () => {
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    const opened = await service.open(
      { command: 'node', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );
    const pid = opened.pid!;
    expect(opened.output_path).toContain(`pty-${pid}-`);

    ptyMocks.created[0].emitData('ready');

    const written = await service.writeByPid(
      { pid, chars: '1+1', submit: true, wait_ms: 0, idle_ms: 0 },
      config,
    );
    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(1, '1+1');
    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(2, '\r');
    expect(written.pid).toBe(pid);
    expect(written.input_events).toEqual(['Text(3)', 'Enter']);

    const snapshot = await service.snapshotByPid(
      { pid, wait_ms: 0, idle_ms: 0 },
      config,
    );
    expect(snapshot.raw_tail).toContain('ready');

    await service.resizeByPid({ pid, cols: 100, rows: 30 }, config);
    expect(ptyMocks.created[0].resize).toHaveBeenCalledWith(100, 30);

    const closed = await service.closeByPid({ pid, force: true }, config);
    expect(closed.pid).toBe(pid);
    expect(closed.alive).toBe(false);
  });

  it('decodes escaped control sequences before writing to the PTY', async () => {
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    const opened = await service.open(
      { command: 'node', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );

    await service.writeByPid(
      {
        pid: opened.pid!,
        chars: '\\u0003\\r\\x1b\\e\\t\\\\',
        wait_ms: 0,
        idle_ms: 0,
      },
      config,
    );

    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(1, '\u0003');
    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(2, '\r');
    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(3, '\x1b');
    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(4, '\x1b');
    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(5, '\t');
    expect(ptyMocks.created[0].write).toHaveBeenNthCalledWith(6, '\\');
  });

  describe('input transaction', () => {
    async function openSession() {
      const service = new PtySessionService();
      const config = createConfig('owner-a');
      const opened = await service.open(
        { command: 'node', wait_ms: 0, idle_ms: 0 },
        config,
        undefined,
      );
      return { service, config, opened, pty: ptyMocks.created[0] };
    }

    it('sends submit enter after typed text has a chance to render', async () => {
      const { service, config, opened, pty } = await openSession();

      const writePromise = service.write(
        {
          session_id: opened.session_id,
          chars: '/agents',
          submit: true,
          wait_ms: 5,
          idle_ms: 0,
        },
        config,
      );
      await vi.waitFor(() => {
        expect(pty.write).toHaveBeenNthCalledWith(1, '/agents');
      });
      pty.emitData('> /agents');

      await vi.waitFor(() => {
        expect(pty.write).toHaveBeenNthCalledWith(2, '\r');
      });
      pty.emitData('Agents');
      await writePromise;

      expect(pty.write).toHaveBeenCalledTimes(2);
    });

    it('splits repeated control keys and waits between them', async () => {
      const { service, config, opened, pty } = await openSession();

      const writePromise = service.write(
        {
          session_id: opened.session_id,
          chars: '\\t\\t',
          wait_ms: 5,
          idle_ms: 0,
        },
        config,
      );
      await vi.waitFor(() => {
        expect(pty.write).toHaveBeenNthCalledWith(1, '\t');
      });
      pty.emitData('tab 1');
      await vi.waitFor(() => {
        expect(pty.write).toHaveBeenNthCalledWith(2, '\t');
      });
      pty.emitData('tab 2');
      await writePromise;

      expect(pty.write).toHaveBeenCalledTimes(2);
    });

    it('marks unsettled input when the screen never changes', async () => {
      const { service, config, opened, pty } = await openSession();

      const writePromise = service.write(
        { session_id: opened.session_id, chars: '\r', wait_ms: 5, idle_ms: 0 },
        config,
      );
      await vi.waitFor(() => {
        expect(pty.write).toHaveBeenCalledExactlyOnceWith('\r');
      });
      const snapshot = await writePromise;
      expect(snapshot.settled).toBe(false);
      expect(snapshot.input_warnings).toContain(
        'Timed out before the rendered screen became stable after input.',
      );
    });
  });

  it('notifies pid-based exit listeners', async () => {
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    const opened = await service.open(
      { command: 'node', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );
    const listener = vi.fn();

    service.onExitByPid(config, opened.pid!, listener);
    ptyMocks.created[0].emitExit(7, 0);

    expect(listener).toHaveBeenCalledWith(7, undefined);
  });

  it('notifies pid-based data listeners', async () => {
    const service = new PtySessionService();
    const config = createConfig('owner-a');

    const opened = await service.open(
      { command: 'node', wait_ms: 0, idle_ms: 0 },
      config,
      undefined,
    );
    const listener = vi.fn();

    service.onDataByPid(config, opened.pid!, listener);
    ptyMocks.created[0].emitData('ready');

    expect(listener).toHaveBeenCalledWith('ready');
  });
});
