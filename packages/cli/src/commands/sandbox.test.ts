/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const runBwrapMock = vi.hoisted(() => vi.fn());
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
  buildBwrapEnv: () => ({ SANDBOX: 'bwrap', SANDBOX_ENFORCEMENT: 'full' }),
  runBwrap: runBwrapMock,
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
    vi.stubEnv('SANDBOX', undefined);
    vi.stubEnv('SANDBOX_ENFORCEMENT', undefined);
    vi.stubEnv('QWEN_CODE_SIMPLE', undefined);
    vi.stubEnv('QWEN_CODE_SAFE_MODE', undefined);
    loadSettingsMock.mockReturnValue({ merged: {} });
    resolveSandboxNetworkModeMock.mockReturnValue('open');
    resolveBwrapWritableRootsMock.mockReturnValue({
      targetDir: '/ws',
      roots: ['/ws', '/tmp', '/repo/.git'],
      readOnlyOverrides: [],
    });
    buildBwrapArgsMock.mockImplementation(
      ({ cliArgs }: { cliArgs: string[] }) => ['--stub', '--', ...cliArgs],
    );
    runBwrapMock.mockResolvedValue(0);
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
    expect(process.exitCode).toBeUndefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([{ verify: true }, { '--': ['echo', 'must-run'] }])(
    'fails an unfulfilled request without a backend: %j',
    async (args) => {
      loadSandboxConfigMock.mockResolvedValue(undefined);
      await run(args);
      expect(process.exitCode).toBe(1);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(writeStderrLineMock).toHaveBeenCalledWith(
        expect.stringContaining('No verification or command was run'),
      );
    },
  );

  it.each([{ verify: true }, { '--': ['echo', 'must-run'] }])(
    'fails an unfulfilled request inside a sandbox: %j',
    async (args) => {
      vi.stubEnv('SANDBOX', 'bwrap');
      await run(args);
      expect(process.exitCode).toBe(1);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(loadSandboxConfigMock).not.toHaveBeenCalled();
    },
  );

  it('forwards explicit sandbox options to the resolver', async () => {
    loadSandboxConfigMock.mockResolvedValue({
      command: 'docker',
      image: 'flag/image',
    });
    await run({ sandbox: true, sandboxImage: 'flag/image' });
    expect(loadSandboxConfigMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sandbox: true, sandboxImage: 'flag/image' }),
    );
    expect(report()).toContain('Image: flag/image');
  });

  it('ignores settings in bare mode', async () => {
    loadSettingsMock.mockReturnValue({
      merged: {
        tools: { sandbox: true },
        context: { includeDirectories: ['/extra'] },
      },
    } as never);
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    await run({ bare: true });
    expect(loadSandboxConfigMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ bare: true }),
    );
    expect(resolveBwrapWritableRootsMock).toHaveBeenCalledWith([]);
    expect(loadSettingsMock).not.toHaveBeenCalled();
  });

  // The session hop selects the backend from the full merged settings even in
  // safe mode (llm.tsx), so reporting "none" here would contradict the
  // confinement the same invocation actually gets. Safe mode still suppresses
  // the settings-derived roots, matching the Config record's rule.
  it('keeps settings for backend selection in safe mode, matching the hop', async () => {
    const merged = {
      tools: { sandbox: true },
      context: { includeDirectories: ['/extra'] },
    };
    loadSettingsMock.mockReturnValue({ merged } as never);
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    await run({ safeMode: true });
    expect(loadSandboxConfigMock).toHaveBeenCalledWith(
      merged,
      expect.objectContaining({ safeMode: true }),
    );
    expect(resolveBwrapWritableRootsMock).toHaveBeenCalledWith([]);
    expect(report()).toContain('Backend: bwrap');
  });

  // The env var, not only the flag: deleting `?? isSafeModeEnv()` must turn
  // this red (the roots would become the settings-derived ['/extra']).
  it('drives safe mode from QWEN_CODE_SAFE_MODE, not only the flag', async () => {
    const merged = {
      tools: { sandbox: true },
      context: { includeDirectories: ['/extra'] },
    };
    loadSettingsMock.mockReturnValue({ merged } as never);
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    vi.stubEnv('QWEN_CODE_SAFE_MODE', '1');

    await run();

    expect(loadSandboxConfigMock).toHaveBeenCalledWith(
      merged,
      expect.anything(),
    );
    expect(resolveBwrapWritableRootsMock).toHaveBeenCalledWith([]);
  });

  // Same for bare mode: reducing `isBareMode(args.bare)` to `args.bare ===
  // true` must turn this red (loadSettings would be called).
  it('drives bare mode from QWEN_CODE_SIMPLE, not only the flag', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    vi.stubEnv('QWEN_CODE_SIMPLE', '1');

    await run();

    expect(loadSettingsMock).not.toHaveBeenCalled();
    expect(loadSandboxConfigMock).toHaveBeenCalledWith({}, expect.anything());
  });

  // The root resolver throws FatalSandboxError for a workspace at or above the
  // home directory; that refusal is exactly what this subcommand exists to
  // explain, so it must take the reported failure path, not escape as a raw
  // rejection.
  it('reports a writable-root refusal instead of rejecting with a stack', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    resolveBwrapWritableRootsMock.mockImplementation(() => {
      throw new Error(
        "Refusing sandbox writable root '/home/user': the home directory ('/home/user') and its ancestors must stay read-only.",
      );
    });

    await run();

    expect(writeStderrLineMock.mock.calls[0]?.[0]).toContain(
      'Sandbox unavailable',
    );
    expect(writeStderrLineMock.mock.calls[0]?.[0]).toContain(
      'Refusing sandbox writable root',
    );
    expect(process.exitCode).toBe(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects command flags before -- instead of silently dropping them', () => {
    const handler = vi.fn();
    expect(() =>
      yargs()
        .exitProcess(false)
        .showHelpOnFail(false)
        .command({ ...sandboxCommand, handler })
        .parseSync(['sandbox', 'npm', 'publish', '--dry-run']),
    ).toThrow('Unknown argument');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { input: ['sandbox', 'npm', 'test'], expected: { cmd: ['npm', 'test'] } },
    {
      input: ['sandbox', '--', 'sh', '-c', 'echo hi'],
      expected: { '--': ['sh', '-c', 'echo hi'] },
    },
    {
      // Numeric-looking tokens after `--` must reach the handler verbatim —
      // yargs-parser would otherwise coerce them (`1e5` → 100000).
      input: ['sandbox', '--', 'echo', '1e5', '0x10', '1.50'],
      expected: { '--': ['echo', '1e5', '0x10', '1.50'] },
    },
  ])(
    'preserves the supported command spelling $input',
    async ({ input, expected }) => {
      let captured: unknown;
      const handler = vi.fn((args) => {
        captured = structuredClone(args);
      });
      await yargs()
        .exitProcess(false)
        .command({ ...sandboxCommand, handler })
        .parseAsync(input);
      expect(captured).toEqual(expect.objectContaining(expected));
    },
  );

  it('reports the resolved backend, roots, and network mode', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });

    await run();

    const text = report();
    expect(text).toContain('Backend: bwrap');
    expect(text).toContain('Network: open');
    expect(text).toContain('/repo/.git');
    expect(text).toContain('Enforcement: full');
    expect(spawnSyncMock).not.toHaveBeenCalled();
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
    expect(report()).toContain('Enforcement: full');
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
    runBwrapMock.mockResolvedValue(42);

    await run({ '--': ['sh', '-c', 'exit 42'] });

    expect(runBwrapMock.mock.calls[0]?.[0].cliArgs).toEqual([
      'sh',
      '-c',
      'exit 42',
    ]);
    expect(process.exitCode).toBe(42);
    expect(runBwrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        networkMode: 'open',
        writableRoots: ['/ws', '/tmp', '/repo/.git'],
      }),
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(writeStdoutLineMock).not.toHaveBeenCalled();
    expect(writeStderrLineMock).toHaveBeenCalledWith('Backend: bwrap');
  });

  it('keeps positional command arguments before arguments after the separator', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    await run({ cmd: ['sh'], '--': ['-c', 'echo fixture'] });
    expect(runBwrapMock.mock.calls[0]?.[0].cliArgs).toEqual([
      'sh',
      '-c',
      'echo fixture',
    ]);
  });

  it('reports a failed command launch', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    runBwrapMock.mockRejectedValueOnce(new Error('fixture launch failed'));
    await run({ '--': ['echo', 'fixture'] });
    expect(process.exitCode).toBe(1);
    expect(writeStderrLineMock).toHaveBeenCalledWith(
      'Sandbox command failed: fixture launch failed',
    );
  });

  it('discloses the retained repository configuration and hooks grant', async () => {
    loadSandboxConfigMock.mockResolvedValue({ command: 'bwrap' });
    await run();
    expect(report()).toContain('repository config and hooks remain writable');
    expect(report()).toContain('later unconfined Git commands');
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
        [/\$\$/, { status: 0, stdout: '', stderr: '' }],
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
        [/\$\$/, { status: 0, stdout: '', stderr: '' }],
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
        [/\$\$/, { status: 0, stdout: '', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('FAIL  write outside the roots is denied');
      expect(process.exitCode).toBe(1);
    });

    it('fails when a PID namespace isolates the payload, which would break owner arbitration', async () => {
      respond([
        [/proc\/net\/dev/, { status: 0, stdout: 'lo\neth0\n', stderr: '' }],
        [
          /usr\/local\/bin/,
          { status: 1, stdout: '', stderr: 'Read-only file system' },
        ],
        [/\$\$/, { status: 1, stdout: '', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('FAIL  payload shares the host PID namespace');
      expect(process.exitCode).toBe(1);
    });

    // glibc renders strerror() in the child's locale, so a non-English
    // LC_ALL/LANG would turn a holding confinement into a FAIL on the EROFS
    // match. The probes run with the C locale pinned so the battery never
    // matches a localized message; the user's own command spawn is untouched.
    it('pins the C locale on the probe spawns', async () => {
      respond([
        [/proc\/net\/dev/, { status: 0, stdout: 'lo\neth0\n', stderr: '' }],
        [
          /usr\/local\/bin/,
          { status: 1, stdout: '', stderr: 'Read-only file system' },
        ],
        [/\$\$/, { status: 0, stdout: '', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('Confinement verified (4 checks).');
      for (const call of spawnSyncMock.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({
            encoding: 'utf8',
            env: expect.objectContaining({ LC_ALL: 'C' }),
          }),
        );
      }
    });

    // The probe pipeline exits with `cut`'s status, so a minimal image without
    // `tail` still reports status 0 and writes the error to stderr. A check
    // that read the combined output would count "tail:" as a host interface
    // and pass a property it never measured.
    it('fails the network check when the probe could not list interfaces', async () => {
      respond([
        [
          /proc\/net\/dev/,
          { status: 0, stdout: '', stderr: 'sh: 1: tail: not found' },
        ],
        [
          /usr\/local\/bin/,
          { status: 1, stdout: '', stderr: 'Read-only file system' },
        ],
        [/\$\$/, { status: 0, stdout: '', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('FAIL  host network is shared in open mode');
      expect(process.exitCode).toBe(1);
    });

    it.each(['', 'eth0\n'])(
      'fails closed mode when the interface listing omits loopback: %j',
      async (stdout) => {
        resolveSandboxNetworkModeMock.mockReturnValue('closed');
        respond([
          [/proc\/net\/dev/, { status: 0, stdout, stderr: '' }],
          [
            /usr\/local\/bin/,
            { status: 1, stdout: '', stderr: 'Read-only file system' },
          ],
          [/\$\$/, { status: 0, stdout: '', stderr: '' }],
        ]);
        await run({ verify: true });
        expect(report()).toContain(
          'FAIL  network namespace is private in closed mode',
        );
        expect(process.exitCode).toBe(1);
      },
    );

    it('fails the network check on a non-zero probe status', async () => {
      respond([
        [
          /proc\/net\/dev/,
          { status: 127, stdout: '', stderr: 'sh: 1: tail: not found' },
        ],
        [
          /usr\/local\/bin/,
          { status: 1, stdout: '', stderr: 'Read-only file system' },
        ],
        [/\$\$/, { status: 0, stdout: '', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain('FAIL  host network is shared in open mode');
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
        [/\$\$/, { status: 0, stdout: '', stderr: '' }],
      ]);

      await run({ verify: true });

      expect(report()).toContain(
        'FAIL  network namespace is private in closed mode',
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
