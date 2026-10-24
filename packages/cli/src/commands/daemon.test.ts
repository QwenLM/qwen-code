/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Argv } from 'yargs';

const sanitizeTerminalText = vi.hoisted(() =>
  vi.fn((value: string) => value.replace(/\p{Cc}/gu, '')),
);

vi.mock('../ui/utils/textUtils.js', () => ({ sanitizeTerminalText }));

// A record only names a process inside the namespace it was written in, so
// the decision table is pinned against a fixed local namespace here.
vi.mock('../serve/daemon-discovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../serve/daemon-discovery.js')>();
  return {
    ...actual,
    currentPidNamespace: () => 'pid:[1]',
    isProcessAlive: () => false,
  };
});

import {
  buildDaemonStartArgs,
  buildDaemonStartEnv,
  buildDaemonRestartPlan,
  canonicalizeStartWorkspaces,
  daemonCommand,
  daemonRejectsToken,
  formatDaemonAge,
  formatDaemonDetail,
  formatDaemonStartSummary,
  fetchDaemonDetail,
  followFile,
  isProcessAncestor,
  listenerIdentityVerified,
  pidResolvableHere,
  probeHealth,
  processParentTable,
  processStartMatchesRecord,
  processStartTime,
  resolveStartEnvPath,
  runDaemonRestart,
  selectDaemonEntries,
  selectRestartTarget,
  summarizeDaemonStatus,
  sweepStaleStartLogs,
  tailLines,
  terminateTree,
  waitForDaemonReady,
  type DaemonRestartDeps,
  type DaemonRestartPlan,
} from './daemon.js';
import {
  readDaemonToken,
  writeDaemonToken,
  type DaemonDiscoveryEntry,
  type DaemonDiscoveryRecord,
} from '../serve/daemon-discovery.js';

function entry(port: number): DaemonDiscoveryEntry {
  return {
    path: `/tmp/daemon-${port}.json`,
    record: {
      v: 1,
      pid: 1000 + port,
      port,
      hostname: '127.0.0.1',
      url: `http://127.0.0.1:${port}`,
      workspaces: [`/tmp/project-${port}`],
      primaryWorkspace: `/tmp/project-${port}`,
      startedAt: '2026-10-19T00:00:00.000Z',
      auth: 'none',
    },
  };
}

describe('qwen daemon command', () => {
  it('declares the daemon namespace', () => {
    expect(daemonCommand.command).toBe('daemon');
    expect(typeof daemonCommand.builder).toBe('function');
    expect(typeof daemonCommand.handler).toBe('function');
  });

  it('registers start, status, logs, stop, restart and token subcommands', () => {
    const mockYargs = {
      command: vi.fn().mockReturnThis(),
      demandCommand: vi.fn().mockReturnThis(),
      version: vi.fn().mockReturnThis(),
    };
    const builder = daemonCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('daemon command builder must be a function');
    }
    builder(mockYargs as unknown as Argv);

    expect(mockYargs.command.mock.calls.map((call) => call[0].command)).toEqual(
      ['start', 'status', 'logs', 'stop', 'restart', 'token'],
    );
  });

  describe('restart', () => {
    const cli = '/opt/qwen/index.js';
    const plan = (
      record: DaemonDiscoveryRecord,
      options: Parameters<typeof buildDaemonRestartPlan>[1] = {},
      baseEnv: NodeJS.ProcessEnv = {},
    ) => buildDaemonRestartPlan(record, options, cli, [], baseEnv);
    const recorded = (
      overrides: Partial<DaemonDiscoveryRecord> = {},
    ): DaemonDiscoveryRecord => ({
      ...entry(4170).record,
      workspaces: ['/tmp/project-4170', '/tmp/restored-4170'],
      startupWorkspaces: ['/tmp/project-4170'],
      web: true,
      requireAuth: false,
      ...overrides,
    });
    const bearer = (overrides: Partial<DaemonDiscoveryRecord> = {}) =>
      recorded({ auth: 'bearer', ...overrides });

    it('refuses an HTTPS daemon before stopping it', () => {
      const result = plan(recorded({ url: 'https://127.0.0.1:4170' }));
      expect(result.error).toContain('HTTPS');
      expect(result.stopArgs).toBeUndefined();
    });

    it('replays only the recorded startup settings', () => {
      const result = plan(
        recorded({
          startupWorkspaces: ['/tmp/project-4170', '/tmp/second-4170'],
          web: false,
        }),
      );
      expect(result.error).toBeUndefined();
      expect(result.notices).toEqual([]);
      expect(result.stopArgs).toEqual([
        cli,
        'daemon',
        'stop',
        '--port',
        '4170',
      ]);
      expect(result.startArgs).toEqual([
        cli,
        'daemon',
        'start',
        '--port',
        '4170',
        '--hostname',
        '127.0.0.1',
        '--wait',
        '--workspace',
        '/tmp/project-4170',
        '--workspace',
        '/tmp/second-4170',
        '--no-web',
      ]);
      expect(result.workspaces).toEqual([
        '/tmp/project-4170',
        '/tmp/second-4170',
      ]);
    });

    it('refuses an older record whose workspaces may include restored registrations', () => {
      const result = plan(
        recorded({ startupWorkspaces: undefined, web: undefined }),
      );
      expect(result.error).toContain('did not record its startup workspaces');
      expect(result.stopArgs).toBeUndefined();
    });

    it('names the defaults it assumes for an older single-workspace record', () => {
      const none = plan(entry(4170).record);
      expect(none.error).toBeUndefined();
      expect(none.startArgs).toEqual([
        cli,
        'daemon',
        'start',
        '--port',
        '4170',
        '--hostname',
        '127.0.0.1',
        '--wait',
        '--workspace',
        '/tmp/project-4170',
      ]);
      expect(none.notices).toEqual([
        expect.stringContaining('Web Shell was enabled'),
      ]);

      const legacyBearer = plan(
        { ...entry(4170).record, auth: 'bearer' },
        { web: true },
        { QWEN_SERVER_TOKEN: 'secret' },
      );
      expect(legacyBearer.startArgs).toContain('--require-auth');
      expect(legacyBearer.notices).toEqual([
        expect.stringContaining('--require-auth was set'),
      ]);
    });

    it('lets explicit flags override the record', () => {
      const result = plan(
        bearer({ requireAuth: true }),
        { web: false, requireAuth: false },
        { QWEN_SERVER_TOKEN: 'secret' },
      );
      expect(result.startArgs).toContain('--no-web');
      expect(result.startArgs).not.toContain('--require-auth');
      expect(result.env?.['QWEN_SERVER_TOKEN']).toBe('secret');
    });

    it('requires a token before hardening an auth-none daemon', () => {
      const result = plan(recorded(), { requireAuth: true });
      expect(result.error).toBe(
        '--require-auth requires --token or QWEN_SERVER_TOKEN.',
      );
      expect(result.stopArgs).toBeUndefined();
    });

    it('keeps an explicit token when hardening an auth-none daemon', () => {
      const result = plan(recorded(), { token: 'secret', requireAuth: true });
      expect(result.error).toBeUndefined();
      expect(result.env?.['QWEN_SERVER_TOKEN']).toBe('secret');
      expect(result.startArgs).toContain('--require-auth');
    });

    it('lets an explicit token configure bearer auth, as daemon start does', () => {
      const result = plan(recorded(), { token: 'secret' });
      expect(result.error).toBeUndefined();
      expect(result.env?.['QWEN_SERVER_TOKEN']).toBe('secret');
      expect(result.startArgs).not.toContain('--require-auth');
      expect(result.notices).toEqual([
        expect.stringContaining('--token is visible'),
      ]);
    });

    it('does not add an inherited token to an auth-none daemon', () => {
      const result = plan(
        recorded(),
        {},
        { QWEN_SERVER_TOKEN: 'ambient', PATH: '/usr/bin' },
      );
      expect(result.error).toBeUndefined();
      expect(result.env).toEqual({ PATH: '/usr/bin' });
      expect(result.notices).toEqual([]);
    });

    it('requires a token for a bearer daemon before stopping it', () => {
      const result = plan(bearer());
      expect(result.error).toContain('restarting a bearer daemon requires');
      expect(result.error).toContain('.env');
      expect(result.stopArgs).toBeUndefined();

      const generated = plan(bearer({ tokenGenerated: true }));
      expect(generated.error).toContain('generated at startup');
      expect(generated.stopArgs).toBeUndefined();
    });

    it('takes a bearer token from the environment and keeps the recorded require-auth', () => {
      const open = plan(bearer(), {}, { QWEN_SERVER_TOKEN: ' secret ' });
      expect(open.error).toBeUndefined();
      expect(open.env?.['QWEN_SERVER_TOKEN']).toBe('secret');
      expect(open.startArgs).not.toContain('--require-auth');

      const strict = plan(
        bearer({ requireAuth: true }),
        {},
        { QWEN_SERVER_TOKEN: 'secret' },
      );
      expect(strict.startArgs).toContain('--require-auth');
    });

    it('adds --force only when restart explicitly asks for it', () => {
      expect(plan(recorded()).stopArgs).not.toContain('--force');
      expect(plan(recorded(), { force: true }).stopArgs).toContain('--force');
    });

    it('preserves Node loader arguments for a TypeScript entry', () => {
      const result = buildDaemonRestartPlan(
        recorded(),
        {},
        '/opt/qwen/index.ts',
        ['--import', 'tsx'],
        {},
      );
      expect(result.stopArgs?.slice(0, 3)).toEqual([
        '--import',
        'tsx',
        '/opt/qwen/index.ts',
      ]);
      expect(result.startArgs?.slice(0, 3)).toEqual([
        '--import',
        'tsx',
        '/opt/qwen/index.ts',
      ]);
    });

    it('selects one target without advising --all', () => {
      expect(
        selectRestartTarget([entry(4170), entry(4171)], undefined),
      ).toEqual({
        error: '2 daemons are registered; pass --port <port> to choose one.',
      });
      expect(selectRestartTarget([], undefined).error).toBe(
        'no daemon is registered. Start one with `qwen serve`.',
      );
      expect(selectRestartTarget([entry(4170)], 4171).error).toBe(
        'No daemon is registered on port 4171.',
      );
      expect(selectRestartTarget([entry(4170), entry(4171)], 4171)).toEqual({
        entry: entry(4171),
      });
    });

    it('finds an ancestor on the parent chain', () => {
      const parents = new Map([
        [30, 20],
        [20, 10],
        [10, 1],
        [40, 41],
        [41, 40],
      ]);
      expect(isProcessAncestor(10, 30, parents)).toBe(true);
      expect(isProcessAncestor(20, 30, parents)).toBe(true);
      expect(isProcessAncestor(99, 30, parents)).toBe(false);
      expect(isProcessAncestor(30, 10, parents)).toBe(false);
      expect(isProcessAncestor(99, 40, parents)).toBe(false);
    });

    it('reads this process from the live parent table', () => {
      if (process.platform === 'win32') return;
      const parents = processParentTable();
      expect(parents?.get(process.pid)).toBe(process.ppid);
      expect(isProcessAncestor(process.ppid, process.pid, parents!)).toBe(true);
    });

    it('detects a token the running daemon rejects', async () => {
      const responses = [
        new Response(null, { status: 401 }),
        new Response('{}', { status: 200 }),
        new Response(null, { status: 403 }),
      ];
      const fetchMock = vi.fn(
        async (_input: URL | string, _init?: RequestInit) =>
          responses.shift() ?? Promise.reject(new Error('offline')),
      );
      vi.stubGlobal('fetch', fetchMock);
      try {
        const record = bearer();
        await expect(daemonRejectsToken(record, 'wrong', true)).resolves.toBe(
          true,
        );
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
          Authorization: 'Bearer wrong',
        });
        await expect(daemonRejectsToken(record, 'right', true)).resolves.toBe(
          false,
        );
        // Only a 401 proves a mismatch; another gate's 403 does not.
        await expect(daemonRejectsToken(record, 'right', true)).resolves.toBe(
          false,
        );
        await expect(daemonRejectsToken(record, 'any', true)).resolves.toBe(
          false,
        );
        await expect(daemonRejectsToken(record, 'any', false)).resolves.toBe(
          false,
        );
        expect(fetchMock).toHaveBeenCalledTimes(4);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    describe('sequencing', () => {
      const restartedRecord = { ...recorded(), pid: 9999 };
      const harness = (
        overrides: Partial<DaemonRestartDeps> = {},
        after: Array<readonly DaemonDiscoveryEntry[]> = [
          [{ path: '/tmp/daemon-4170.json', record: restartedRecord }],
        ],
      ) => {
        const run = vi.fn(
          (_command: string, _args: readonly string[]) =>
            ({ status: 0 }) as { status: number | null; error?: Error },
        );
        const lines: string[] = [];
        const stderr = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation((chunk) => {
            lines.push(String(chunk));
            return true;
          });
        const stdout = vi
          .spyOn(process.stdout, 'write')
          .mockImplementation((chunk) => {
            lines.push(String(chunk));
            return true;
          });
        const deps: DaemonRestartDeps = {
          run,
          entries: vi.fn(() => after.shift() ?? []),
          hostedBy: vi.fn(() => false),
          validateWorkspaces: vi.fn(async () => undefined),
          rejectsToken: vi.fn(async () => false),
          ...overrides,
        };
        return {
          deps,
          run,
          output: () => lines.join(''),
          restore: () => {
            stderr.mockRestore();
            stdout.mockRestore();
          },
        };
      };
      const restart = async (
        h: ReturnType<typeof harness>,
        record: DaemonDiscoveryRecord = recorded(),
        restartPlan: DaemonRestartPlan = plan(record),
      ) => {
        try {
          return await runDaemonRestart(record, restartPlan, h.deps);
        } finally {
          h.restore();
        }
      };

      it('stops, starts, and confirms the daemon is back on its port', async () => {
        const h = harness();
        await expect(restart(h)).resolves.toBe(0);
        expect(h.run.mock.calls.map((call) => call[1][2])).toEqual([
          'stop',
          'start',
        ]);
      });

      it('preserves a persisted token for the restarted pid', async () => {
        const dir = await fsp.mkdtemp(
          path.join(os.tmpdir(), 'qwen-restart-token-'),
        );
        const previous = process.env['QWEN_RUNTIME_DIR'];
        process.env['QWEN_RUNTIME_DIR'] = dir;
        try {
          const record = recorded();
          writeDaemonToken(record.port, record.pid, 'secret-token');
          const h = harness();
          await expect(restart(h, record)).resolves.toBe(0);
          expect(readDaemonToken(record.port, restartedRecord.pid)).toBe(
            'secret-token',
          );
        } finally {
          if (previous === undefined) {
            delete process.env['QWEN_RUNTIME_DIR'];
          } else {
            process.env['QWEN_RUNTIME_DIR'] = previous;
          }
          await fsp.rm(dir, { recursive: true, force: true });
        }
      });

      it('refuses before stopping when this command runs inside the daemon', async () => {
        const h = harness({ hostedBy: vi.fn(() => true) });
        await expect(restart(h)).resolves.toBe(1);
        expect(h.run).not.toHaveBeenCalled();
        expect(h.output()).toContain('Web Shell terminal');
      });

      it('refuses before stopping when a startup workspace is gone', async () => {
        const h = harness({
          validateWorkspaces: vi.fn(async () => {
            throw new Error(
              'Invalid --workspace "/tmp/project-4170": directory does not exist.',
            );
          }),
        });
        await expect(restart(h)).resolves.toBe(1);
        expect(h.run).not.toHaveBeenCalled();
        expect(h.output()).toContain(
          'cannot restart: Invalid --workspace "/tmp/project-4170"',
        );
      });

      it('refuses before stopping when the running daemon rejects the token', async () => {
        const record = bearer();
        const h = harness({ rejectsToken: vi.fn(async () => true) });
        await expect(
          restart(h, record, plan(record, {}, { QWEN_SERVER_TOKEN: 'wrong' })),
        ).resolves.toBe(1);
        expect(h.deps.rejectsToken).toHaveBeenCalledWith(record, 'wrong');
        expect(h.run).not.toHaveBeenCalled();
        expect(h.output()).toContain('rejected the supplied token');
      });

      it('does not start after a stop refusal that kept the record', async () => {
        const h = harness({}, [[entry(4170)]]);
        h.run.mockReturnValueOnce({ status: 1 });
        await expect(restart(h)).resolves.toBe(1);
        expect(h.run).toHaveBeenCalledTimes(1);
      });

      it('starts when the daemon exited on its own during the stop leg', async () => {
        const h = harness({}, [
          [],
          [{ path: '/tmp/daemon-4170.json', record: restartedRecord }],
        ]);
        h.run.mockReturnValueOnce({ status: 1 });
        await expect(restart(h)).resolves.toBe(0);
        expect(h.run).toHaveBeenCalledTimes(2);
        expect(h.output()).toContain('already exited; starting it again');
      });

      it('reports a stop leg that could not be launched', async () => {
        const h = harness();
        h.run.mockReturnValueOnce({
          status: null,
          error: new Error('spawnSync /opt/qwen/index.js ENOENT'),
        });
        await expect(restart(h)).resolves.toBe(1);
        expect(h.run).toHaveBeenCalledTimes(1);
        expect(h.output()).toContain('could not run daemon stop: spawnSync');
      });

      it('reports a start leg that could not be launched', async () => {
        const h = harness();
        h.run.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({
          status: null,
          error: new Error('spawnSync /opt/qwen/index.js EACCES'),
        });
        await expect(restart(h)).resolves.toBe(1);
        expect(h.output()).toContain('could not run daemon start');
        expect(h.output()).toContain('port 4170 is stopped');
      });

      it('fails when the daemon came back on another port', async () => {
        const h = harness({}, [
          [
            {
              path: '/tmp/daemon-4171.json',
              record: { ...restartedRecord, port: 4171 },
            },
          ],
        ]);
        await expect(restart(h)).resolves.toBe(1);
        expect(h.output()).toContain('is not on port 4170');
      });

      it('fails when the start leg fails', async () => {
        const h = harness();
        h.run.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({
          status: 1,
        });
        await expect(restart(h)).resolves.toBe(1);
        expect(h.deps.entries).not.toHaveBeenCalled();
      });

      it('runs nothing for a refused plan', async () => {
        const h = harness();
        await expect(
          restart(h, recorded(), { error: 'restarting an HTTPS daemon' }),
        ).resolves.toBe(1);
        expect(h.run).not.toHaveBeenCalled();
        expect(h.deps.hostedBy).not.toHaveBeenCalled();
      });
    });
  });

  it('builds a detached serve invocation for a JavaScript entry', () => {
    const { command, args } = buildDaemonStartArgs({
      entry: '/opt/qwen/index.js',
      port: 4171,
      hostname: '127.0.0.1',
      workspaces: ['/repo'],
      web: false,
      requireAuth: true,
    });
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      ...process.execArgv,
      '/opt/qwen/index.js',
      'serve',
      '--port',
      '4171',
      '--hostname',
      '127.0.0.1',
      '--no-token-qr',
      '--no-web',
      '--require-auth',
      '--workspace',
      '/repo',
    ]);
  });

  it('spawns a non-JavaScript entry directly', () => {
    const { command, args } = buildDaemonStartArgs({
      entry: '/usr/local/bin/qwen',
      port: 4170,
      hostname: '127.0.0.1',
      workspaces: ['/repo'],
      web: true,
      requireAuth: false,
    });
    expect(command).toBe('/usr/local/bin/qwen');
    expect(args).toEqual([
      'serve',
      '--port',
      '4170',
      '--hostname',
      '127.0.0.1',
      '--no-token-qr',
      '--workspace',
      '/repo',
    ]);
  });

  it('formats a start summary with the bound port', () => {
    const summary = formatDaemonStartSummary(entry(4170).record);
    expect(summary).toContain('started pid');
    expect(summary).toContain('http://127.0.0.1:4170');
    expect(summary).toContain('qwen daemon stop --port 4170');
  });

  it('waits for a daemon to report ready', async () => {
    const responses = [
      { status: 'warning', issues: ['starting'], starting: true },
      { status: 'ok', issues: [] },
    ];
    const fetchDetail = vi.fn(async () => responses.shift()!);
    await expect(
      waitForDaemonReady(
        entry(4170).record,
        undefined,
        1_000,
        1,
        fetchDetail,
        () => true,
      ),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(fetchDetail).toHaveBeenCalledTimes(2);
  });

  it('treats a permanent warning as ready', async () => {
    const fetchDetail = vi.fn(async () => ({
      status: 'warning',
      issues: ['channel restore failed'],
      starting: false,
    }));
    await expect(
      waitForDaemonReady(
        entry(4170).record,
        undefined,
        1_000,
        1,
        fetchDetail,
        () => true,
      ),
    ).resolves.toMatchObject({ status: 'warning' });
    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });

  it('fails readiness when the listener identity is lost', async () => {
    const fetchDetail = vi.fn(async () => ({ status: 'ok', issues: [] }));
    const identity = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(
      waitForDaemonReady(
        entry(4170).record,
        undefined,
        1_000,
        1,
        fetchDetail,
        identity,
      ),
    ).resolves.toBe('daemon process exited before readiness');
    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });

  it('returns the last status when readiness times out', async () => {
    const fetchDetail = vi.fn(async () => ({
      status: 'warning',
      issues: ['starting'],
      starting: true,
    }));
    await expect(
      waitForDaemonReady(
        entry(4170).record,
        undefined,
        0,
        1,
        fetchDetail,
        () => true,
      ),
    ).resolves.toMatchObject({ status: 'warning' });
    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });

  it('summarizes a daemon status response', () => {
    const summary = summarizeDaemonStatus({
      v: 1,
      status: 'ok',
      daemon: { qwenCodeVersion: '0.25.3', uptimeMs: 65_000 },
      runtime: { sessions: { active: 2, admissionInFlight: 1 } },
      issues: [{ message: 'one' }],
    });
    expect(summary).toEqual({
      status: 'ok',
      version: '0.25.3',
      uptimeMs: 65_000,
      sessions: { active: 2, admissionInFlight: 1 },
      issues: ['one'],
    });
    expect(formatDaemonDetail(entry(4170).record, summary!)).toContain(
      'status=ok version=0.25.3 uptime=1m sessions=2(+1 admitting) issues=1',
    );
    expect(
      formatDaemonDetail(
        entry(4170).record,
        'auth required; set QWEN_SERVER_TOKEN',
      ),
    ).toContain('detail unavailable');
    expect(summarizeDaemonStatus({ v: 1 })).toBeUndefined();
    expect(
      summarizeDaemonStatus({
        v: 1,
        status: 'warning',
        issues: [{ code: 'daemon_runtime_starting', message: 'starting' }],
      })?.starting,
    ).toBe(true);
  });

  it('reads daemon status detail over HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              v: 1,
              status: 'ok',
              daemon: { qwenCodeVersion: '0.25.3', uptimeMs: 1_000 },
              runtime: { sessions: { active: 0 } },
              issues: [],
            }),
            { status: 200 },
          ),
      ),
    );
    try {
      await expect(
        fetchDaemonDetail(entry(4170).record, true),
      ).resolves.toMatchObject({ status: 'ok', version: '0.25.3' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports auth-required and HTTP failures as detail text', async () => {
    const responses = [
      new Response(null, { status: 401 }),
      new Response(null, { status: 500 }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    );
    try {
      await expect(fetchDaemonDetail(entry(4170).record, true)).resolves.toBe(
        'auth required; set QWEN_SERVER_TOKEN',
      );
      await expect(fetchDaemonDetail(entry(4170).record, true)).resolves.toBe(
        'status endpoint returned HTTP 500',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('verifies the recorded listener before trusting a bearer', () => {
    const record = entry(4170).record;
    const started = Date.parse(record.startedAt);
    expect(
      listenerIdentityVerified(
        record,
        'pid:[1]',
        () => true,
        () => started,
      ),
    ).toBe(true);
    expect(
      listenerIdentityVerified(
        { ...record, pidNamespace: 'pid:[2]' },
        'pid:[1]',
        () => true,
        () => started,
      ),
    ).toBe(false);
    expect(
      listenerIdentityVerified(
        record,
        'pid:[1]',
        () => false,
        () => started,
      ),
    ).toBe(false);
    expect(
      listenerIdentityVerified(
        record,
        'pid:[1]',
        () => true,
        () => started - 3_600_000,
      ),
    ).toBe(false);
    expect(
      listenerIdentityVerified(
        record,
        'pid:[1]',
        () => true,
        () => undefined,
      ),
    ).toBe(false);
    expect(
      listenerIdentityVerified(
        { ...record, startedAt: 'not-a-date' },
        'pid:[1]',
        () => true,
        () => started,
      ),
    ).toBe(false);
  });

  it('withholds the bearer from an unverified listener', async () => {
    const previous = process.env['QWEN_SERVER_TOKEN'];
    process.env['QWEN_SERVER_TOKEN'] = 'secret';
    const fetchMock = vi.fn(
      async (_input: URL | string, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const bearer = { ...entry(4170).record, auth: 'bearer' as const };
    try {
      await expect(
        fetchDaemonDetail({ ...bearer, pidNamespace: 'pid:[2]' }, false),
      ).resolves.toBe(
        'listener identity unverified; not sending QWEN_SERVER_TOKEN',
      );
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(fetchDaemonDetail(bearer, true)).resolves.toBe(
        'invalid status response',
      );
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.headers).toEqual({ Authorization: 'Bearer secret' });

      await expect(fetchDaemonDetail(entry(4170).record, true)).resolves.toBe(
        'invalid status response',
      );
      const unauth = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
      expect(unauth?.headers).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) {
        delete process.env['QWEN_SERVER_TOKEN'];
      } else {
        process.env['QWEN_SERVER_TOKEN'] = previous;
      }
    }
  });

  it('sanitizes daemon-derived detail text', () => {
    const esc = String.fromCharCode(27);
    const newline = String.fromCharCode(10);
    const line = formatDaemonDetail(entry(4170).record, {
      status: `ok${esc}[31mred`,
      version: `1.0${newline}FAKE`,
      issues: [],
    });
    expect(line).not.toContain(esc);
    expect(line).not.toContain(`${newline}FAKE`);

    const unavailable = formatDaemonDetail(
      entry(4170).record,
      `boom${esc}[2J${newline}second`,
    );
    expect(unavailable).not.toContain(esc);
    expect(unavailable).not.toContain(`${newline}second`);
  });

  it('drops parent session bindings from the child environment', () => {
    const env = buildDaemonStartEnv(
      {
        PATH: '/bin',
        QWEN_SERVER_TOKEN: 'old',
        QWEN_CODE_SESSION_ID: 'sid',
        QWEN_CODE_SERVE: '1',
        QWEN_DAEMON_TOKEN: 'daemon',
        QWEN_CODE_PRIVATE_ACP_CAPABILITY: 'capability',
      },
      'new-token',
    );
    expect(env['PATH']).toBe('/bin');
    expect(env['QWEN_SERVER_TOKEN']).toBe('new-token');
    expect(env['QWEN_CODE_SESSION_ID']).toBeUndefined();
    expect(env['QWEN_CODE_SERVE']).toBeUndefined();
    expect(env['QWEN_DAEMON_TOKEN']).toBeUndefined();
    expect(env['QWEN_CODE_PRIVATE_ACP_CAPABILITY']).toBeUndefined();
  });

  it('pins relative runtime directories to the launching directory', () => {
    const cwd = path.join(os.tmpdir(), 'qwen-start-launch');
    const env = buildDaemonStartEnv(
      { QWEN_RUNTIME_DIR: 'runtime', QWEN_HOME: 'home' },
      undefined,
      cwd,
    );
    expect(env['QWEN_RUNTIME_DIR']).toBe(path.resolve(cwd, 'runtime'));
    expect(env['QWEN_HOME']).toBe(path.resolve(cwd, 'home'));
  });

  it('resolves Windows drive-relative roots against the launching drive', () => {
    const sep = path.win32.sep;
    const cwd = ['C:', 'launch'].join(sep);
    const driveRelative = sep + 'runtime';
    const slashRelative = '/runtime';
    const drivePath = ['C:', 'runtime'].join(sep);
    const unc = sep + sep + ['server', 'share', 'runtime'].join(sep);
    const winFullyQualified = (value: string) =>
      path.win32.isAbsolute(value) &&
      (/^[a-zA-Z]:/.test(value) || value.startsWith(sep + sep));
    expect(
      resolveStartEnvPath(driveRelative, cwd, path.win32, winFullyQualified),
    ).toBe(drivePath);
    expect(
      resolveStartEnvPath(slashRelative, cwd, path.win32, winFullyQualified),
    ).toBe(drivePath);
    expect(
      resolveStartEnvPath(drivePath, cwd, path.win32, winFullyQualified),
    ).toBe(drivePath);
    expect(resolveStartEnvPath(unc, cwd, path.win32, winFullyQualified)).toBe(
      unc,
    );
  });

  it('preserves an explicit empty runtime directory', () => {
    const cwd = path.join(os.tmpdir(), 'qwen-start-empty');
    const env = buildDaemonStartEnv(
      { QWEN_RUNTIME_DIR: '', QWEN_HOME: '' },
      undefined,
      cwd,
    );
    expect(Object.hasOwn(env, 'QWEN_RUNTIME_DIR')).toBe(true);
    expect(env['QWEN_RUNTIME_DIR']).toBe('');
    expect(Object.hasOwn(env, 'QWEN_HOME')).toBe(true);
    expect(env['QWEN_HOME']).toBe('');
    expect(resolveStartEnvPath('', cwd)).toBe('');
    expect(resolveStartEnvPath(undefined, cwd)).toBeUndefined();
  });

  it('drops every private marker by prefix', () => {
    const env = buildDaemonStartEnv(
      {
        QWEN_CODE_PRIVATE_CONVERSATIONS_RUNTIME: '1',
        QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER: '1',
        QWEN_CODE_PRIVATE_ACP_CAPABILITY: '1',
      },
      undefined,
    );
    expect(env['QWEN_CODE_PRIVATE_CONVERSATIONS_RUNTIME']).toBeUndefined();
    expect(
      env['QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER'],
    ).toBeUndefined();
    expect(env['QWEN_CODE_PRIVATE_ACP_CAPABILITY']).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'canonicalizes a symlinked workspace',
    async () => {
      const root = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-start-workspace-'),
      );
      const real = path.join(root, 'real');
      const alias = path.join(root, 'alias');
      await fsp.mkdir(real);
      await fsp.symlink(real, alias);
      try {
        const [canonical] = await canonicalizeStartWorkspaces([alias]);
        expect(canonical).toBe(await fsp.realpath(real));
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('sweeps stale start logs', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-start-logs-'));
    const oldFile = path.join(dir, 'start-old.log');
    const newFile = path.join(dir, 'start-new.log');
    await fsp.writeFile(oldFile, 'old');
    await fsp.writeFile(newFile, 'new');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fsp.utimes(oldFile, old, old);
    try {
      sweepStaleStartLogs(dir);
      await expect(fsp.stat(oldFile)).rejects.toThrow();
      await expect(fsp.stat(newFile)).resolves.toBeDefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('selects exactly one daemon only when the choice is unambiguous', () => {
    const one = entry(4170);
    const two = entry(4171);

    expect(selectDaemonEntries([one], {})).toEqual([one]);
    expect(selectDaemonEntries([one, two], {})).toEqual([]);
    expect(selectDaemonEntries([one, two], { port: 4171 })).toEqual([two]);
    expect(selectDaemonEntries([one, two], { all: true })).toEqual([one, two]);
  });

  it('formats ages for humans', () => {
    expect(formatDaemonAge(0)).toBe('0s');
    expect(formatDaemonAge(65_000)).toBe('1m');
    expect(formatDaemonAge(3_600_000)).toBe('1h');
    expect(formatDaemonAge(86_400_000)).toBe('1d');
  });

  it('treats a process that started after the record as a reused pid', () => {
    const recorded = '2026-10-19T00:00:00.000Z';
    const at = Date.parse(recorded);
    // A slow start may predate the record, but a much older process cannot
    // be the daemon (e.g. a pid reused across a namespace).
    expect(processStartMatchesRecord(recorded, at - 60_000)).toBe(true);
    expect(processStartMatchesRecord(recorded, at - 3_600_000)).toBe(false);
    // Clock precision inside the tolerance is still the recorded daemon.
    expect(processStartMatchesRecord(recorded, at + 1_000)).toBe(true);
    // A later start cannot be the daemon that wrote the record.
    expect(processStartMatchesRecord(recorded, at + 60_000)).toBe(false);
    expect(processStartMatchesRecord(recorded, undefined)).toBe(true);
    expect(processStartMatchesRecord('not-a-date', at)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'reads a live process start time that matches a record written now',
    () => {
      const started = processStartTime(process.pid);
      expect(started).toBeTypeOf('number');
      expect(processStartMatchesRecord(new Date().toISOString(), started)).toBe(
        true,
      );
    },
  );

  it('returns the trailing lines of a log', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tailLines('a\nb\nc', 10)).toEqual(['a', 'b', 'c']);
    expect(tailLines('', 5)).toEqual([]);
  });

  it('resolves a pid only inside the namespace that wrote the record', () => {
    const record = entry(4170).record;
    expect(pidResolvableHere(record, 'pid:[1]')).toBe(true);
    expect(
      pidResolvableHere({ ...record, pidNamespace: 'pid:[1]' }, 'pid:[1]'),
    ).toBe(true);
    // A record from a container sharing the runtime dir names another process.
    expect(
      pidResolvableHere({ ...record, pidNamespace: 'pid:[2]' }, 'pid:[1]'),
    ).toBe(false);
    // The writing kernel is not this one, so its pid means nothing here.
    expect(
      pidResolvableHere({ ...record, pidNamespace: 'pid:[1]' }, undefined),
    ).toBe(false);
  });

  it('does not read a foreign pid as death when the listener answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    try {
      // A private PID namespace hides the daemon's pid, which is not evidence
      // that the daemon is gone: the answered listener is the proof.
      await expect(
        probeHealth({ ...entry(4170).record, pidNamespace: 'pid:[2]' }),
      ).resolves.toBe('running');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still calls a recycled port stale inside one namespace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    try {
      // Another application may hold the port; inside the namespace the
      // recorded pid is addressable, so its absence still vetoes the answer.
      await expect(
        probeHealth({ ...entry(4170).record, pidNamespace: 'pid:[1]' }),
      ).resolves.toBe('stale');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a foreign record when its listener does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    try {
      // Removing the record here would lose a daemon that is merely
      // unreachable from this namespace.
      await expect(
        probeHealth({ ...entry(4170).record, pidNamespace: 'pid:[2]' }),
      ).resolves.toBe('unreachable');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'sends SIGTERM to a POSIX daemon',
    () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        terminateTree(999_998, false);
        expect(kill).toHaveBeenCalledWith(999_998, 'SIGTERM');
      } finally {
        kill.mockRestore();
      }
    },
  );

  it('never signals on Windows, where the kill is unconditional', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      // process.kill there is TerminateProcess: it runs no handler and leaves
      // the daemon's children behind, so the tree goes through taskkill.
      terminateTree(999_998, false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
      kill.mockRestore();
    }
  });

  it('ends a follow once the reader closed the pipe', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qws-follow-'));
    const file = path.join(dir, 'daemon.log');
    await fsp.writeFile(file, 'line one\n');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
    });
    let settled = false;
    try {
      void followFile(file, 0).then(() => {
        settled = true;
      });
      // A reader that exits (`| head`) closes the pipe; the follow must end
      // instead of re-reading the same bytes forever.
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    } finally {
      write.mockRestore();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
