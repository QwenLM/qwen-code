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
  canonicalizeStartWorkspaces,
  daemonCommand,
  formatDaemonAge,
  formatDaemonDetail,
  formatDaemonStartSummary,
  fetchDaemonDetail,
  followFile,
  listenerIdentityVerified,
  pidResolvableHere,
  probeHealth,
  processStartMatchesRecord,
  processStartTime,
  resolveStartEnvPath,
  selectDaemonEntries,
  summarizeDaemonStatus,
  sweepStaleStartLogs,
  tailLines,
  terminateTree,
} from './daemon.js';
import type { DaemonDiscoveryEntry } from '../serve/daemon-discovery.js';

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

  it('registers start, status, logs and stop subcommands', () => {
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
      ['start', 'status', 'logs', 'stop'],
    );
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
