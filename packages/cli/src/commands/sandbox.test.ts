/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const loadSandboxConfigMock = vi.hoisted(() => vi.fn());
const resolveBwrapWritableRootsMock = vi.hoisted(() => vi.fn());
const buildBwrapArgsMock = vi.hoisted(() => vi.fn());
const resolveSandboxNetworkModeMock = vi.hoisted(() => vi.fn());
const writeStdoutLineMock = vi.hoisted(() => vi.fn());
const writeStderrLineMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

const loadSettingsMock = vi.hoisted(() => vi.fn(() => ({ merged: {} })));

vi.mock('../config/settings.js', () => ({
  loadSettings: loadSettingsMock,
}));

vi.mock('../config/sandboxConfig.js', () => ({
  loadSandboxConfig: loadSandboxConfigMock,
}));

vi.mock('../serve/sandbox.js', () => ({
  resolveBwrapWritableRoots: resolveBwrapWritableRootsMock,
  buildBwrapArgs: buildBwrapArgsMock,
  resolveSandboxNetworkMode: resolveSandboxNetworkModeMock,
}));

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
  writeStderrLine: writeStderrLineMock,
}));

import { sandboxCommand } from './sandbox.js';

/** Joined stdout, so assertions read against the report as the user sees it. */
function report(): string {
  return writeStdoutLineMock.mock.calls.map((call) => call[0]).join('\n');
}

async function run(args: Record<string, unknown> = {}): Promise<void> {
  await (sandboxCommand.handler as (a: unknown) => Promise<void>)({
    _: ['sandbox'],
    $0: 'qwen',
    ...args,
  });
}

describe('qwen sandbox', () => {
  beforeEach(() => {
    loadSettingsMock.mockReturnValue({ merged: {} });
    resolveSandboxNetworkModeMock.mockReturnValue('open');
    resolveBwrapWritableRootsMock.mockReturnValue({
      targetDir: '/ws',
      roots: ['/ws', '/tmp', '/repo/.git'],
    });
    buildBwrapArgsMock.mockImplementation(
      ({ cliArgs }: { cliArgs: string[] }) => ['--stub', '--', ...cliArgs],
    );
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it('says so plainly when no backend is configured', async () => {
    loadSandboxConfigMock.mockResolvedValue(undefined);

    await run();

    expect(report()).toContain('Backend: none (running unconfined)');
  });

  it('reports the resolved backend, roots, and network mode', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });

    await run();

    const text = report();
    expect(text).toContain('Backend: bwrap');
    expect(text).toContain('Network: open');
    expect(text).toContain('/repo/.git');
  });

  it('feeds the settings-declared workspace directories into the roots', async () => {
    // The hop binds these too, so a report that omitted them would understate
    // what is writable.
    loadSettingsMock.mockReturnValue({
      merged: { context: { includeDirectories: ['/extra'] } },
    } as never);
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });

    await run();

    expect(resolveBwrapWritableRootsMock).toHaveBeenCalledWith(['/extra']);
  });

  it('reports from inside a confinement instead of describing nothing', async () => {
    // `loadSandboxConfig` answers "already sandboxed" with no command, which
    // would otherwise print "running unconfined" from inside a sandbox.
    vi.stubEnv('SANDBOX', 'bwrap');
    vi.stubEnv('SANDBOX_ENFORCEMENT', 'full');

    await run();

    expect(report()).toContain('Already inside a sandbox: bwrap');
    expect(loadSandboxConfigMock).not.toHaveBeenCalled();
  });

  it('exits non-zero when the backend probe fails', async () => {
    // A probe failure for an explicitly requested backend is fatal by design;
    // surfacing it is the reason this subcommand exists.
    loadSandboxConfigMock.mockRejectedValue(
      new Error("Sandbox command 'bwrap' is installed but cannot run: nope"),
    );

    await run();

    expect(writeStderrLineMock.mock.calls[0]?.[0]).toContain(
      'Sandbox unavailable',
    );
    expect(process.exitCode).toBe(1);
  });

  it('refuses --verify for a backend it cannot inspect', async () => {
    loadSandboxConfigMock.mockResolvedValue({
      command: 'docker',
      image: 'example.com/img:1',
    });

    await run({ verify: true });

    expect(writeStderrLineMock.mock.calls[0]?.[0]).toContain(
      'only supported for bwrap',
    );
    expect(process.exitCode).toBe(1);
  });

  it('runs a command given after `--` and passes its exit code through', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    spawnSyncMock.mockReturnValue({ status: 42, stdout: 'out', stderr: '' });

    await run({ '--': ['sh', '-c', 'exit 42'] });

    expect(buildBwrapArgsMock.mock.calls[0]?.[0].cliArgs).toEqual([
      'sh',
      '-c',
      'exit 42',
    ]);
    expect(process.exitCode).toBe(42);
  });

  describe('--verify', () => {
    beforeEach(() => {
      loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    });

    /** Answers each battery case by matching on its argv. */
    function respond(handlers: Array<[RegExp, unknown]>): void {
      spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
        const joined = args.join(' ');
        for (const [pattern, result] of handlers) {
          if (pattern.test(joined)) {
            return result;
          }
        }
        return { status: 0, stdout: '', stderr: '' };
      });
    }

    it('passes when every property holds', async () => {
      respond([
        [/proc\/net\/dev/, { status: 0, stdout: 'lo\neth0\n', stderr: '' }],
        [
          /usr\/local\/bin/,
          { status: 1, stdout: '', stderr: 'Read-only file system' },
        ],
        [/ls \/proc/, { status: 0, stdout: '137\n', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('Confinement verified (4 checks).');
      expect(process.exitCode).toBeUndefined();
    });

    // A battery that cannot fail proves nothing, so each property is also
    // exercised in its broken direction.
    it('fails when a write outside the roots is allowed', async () => {
      respond([
        [/proc\/net\/dev/, { status: 0, stdout: 'lo\neth0\n', stderr: '' }],
        [/usr\/local\/bin/, { status: 0, stdout: '', stderr: '' }],
        [/ls \/proc/, { status: 0, stdout: '137\n', stderr: '' }],
      ]);

      await run({ verify: true });

      const text = report();
      expect(text).toContain('FAIL  write outside the roots is denied');
      expect(text).toContain('1 of 4 checks failed.');
      expect(process.exitCode).toBe(1);
    });

    // `touch` on a root-owned directory answers EACCES for an ordinary user with
    // or without a sandbox, so treating that as a denial would make this check
    // pass while nothing is confined. Only EROFS proves a read-only mount.
    it('fails when the refusal is EACCES rather than a read-only mount', async () => {
      respond([
        [/proc\/net\/dev/, { status: 0, stdout: 'lo\neth0\n', stderr: '' }],
        [
          /usr\/local\/bin/,
          {
            status: 1,
            stdout: '',
            stderr: "touch: cannot touch '/usr/local/bin/x': Permission denied",
          },
        ],
        [/ls \/proc/, { status: 0, stdout: '137\n', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('FAIL  write outside the roots is denied');
      expect(process.exitCode).toBe(1);
    });

    it('fails when host PIDs are hidden, which would break owner arbitration', async () => {
      respond([
        [/proc\/net\/dev/, { status: 0, stdout: 'lo\neth0\n', stderr: '' }],
        [
          /usr\/local\/bin/,
          { status: 1, stdout: '', stderr: 'Read-only file system' },
        ],
        [/ls \/proc/, { status: 0, stdout: '3\n', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('FAIL  host processes stay visible');
      expect(process.exitCode).toBe(1);
    });

    it('checks the network property in the direction the mode implies', async () => {
      resolveSandboxNetworkModeMock.mockReturnValue('closed');
      // Only loopback is what closed mode must show; seeing eth0 means the
      // namespace was never unshared.
      respond([
        [/proc\/net\/dev/, { status: 0, stdout: 'lo\neth0\n', stderr: '' }],
        [
          /usr\/local\/bin/,
          { status: 1, stdout: '', stderr: 'Read-only file system' },
        ],
        [/ls \/proc/, { status: 0, stdout: '137\n', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain(
        'FAIL  network namespace is private in closed mode',
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
