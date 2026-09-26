/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const {
  spawnSyncMock,
  existsSyncMock,
  homedirMock,
  tmpdirMock,
  enableCompileCacheMock,
} = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0, signal: null })),
  existsSyncMock: vi.fn(() => false),
  homedirMock: vi.fn(() => '/home/test-user'),
  tmpdirMock: vi.fn(() => '/tmp'),
  enableCompileCacheMock: vi.fn(() => ({
    status: 1,
    directory: '/tmp/node-compile-cache',
  })),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: existsSyncMock,
  realpathSync: vi.fn((p) => p),
  readFileSync: vi.fn(() => JSON.stringify({ version: '0.0.0-test' })),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: homedirMock,
  tmpdir: tmpdirMock,
}));

// Mocked so the launcher never enables a real compile cache in the test worker.
vi.mock('node:module', () => ({
  default: {
    enableCompileCache: enableCompileCacheMock,
    constants: { compileCacheStatus: { ENABLED: 1, ALREADY_ENABLED: 2 } },
  },
}));

const normalizePath = (path) => String(path).replaceAll('\\', '/');

describe('scripts/cli-entry.js production entry', () => {
  const originalArgv = process.argv;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let exitSpy;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    homedirMock.mockReturnValue('/home/test-user');
    tmpdirMock.mockReturnValue('/tmp');
    // Every import stamps these into the real process.env, and the pin's
    // bootstrap guard cannot tell two imports of this file apart — Vitest drops
    // the cache-buster query from import.meta.url — so a leftover pin would be
    // honoured as an inherited managed-version pin and its updateRoot would win
    // over the home this test is trying to observe. Each test here drives a
    // top-level invocation, which starts with neither.
    delete process.env.QWEN_CODE_MANAGED_NPM_PIN;
    delete process.env.QWEN_CODE_MANAGED_NPM_ROOT;
    // A non-fast-path command on Windows, so the entry takes the spawnSync
    // branch (mocked) instead of importing the real dist/cli.js in-process.
    process.argv = ['node', 'scripts/cli-entry.js', 'review', 'check'];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // The entry exits after its child returns; the import must survive that.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process, 'platform', originalPlatform);
    exitSpy.mockRestore();
  });

  it('stamps QWEN_CODE_CLI with its own path, overriding an inherited one', async () => {
    // The dev and start launchers had this pin; the production entry — the one
    // every npm install actually runs — did not, so a regression back to
    // honouring an inherited value would route installed review subprocesses to
    // an outer or stale CLI with every test green.
    const inherited = process.env.QWEN_CODE_CLI;
    process.env.QWEN_CODE_CLI = '/somewhere/else/entirely/qwen';
    try {
      await import('../cli-entry.js?stamps-own-cli');
      expect(normalizePath(process.env.QWEN_CODE_CLI)).toMatch(
        /scripts\/cli-entry\.js$/,
      );
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inherited;
    }
  });

  it('preserves the startup version in child review commands', async () => {
    const inherited = process.env.QWEN_CODE_STARTUP_VERSION;
    process.env.QWEN_CODE_STARTUP_VERSION = '0.21.3';
    try {
      await import('../cli-entry.js?stamps-version');
      expect(process.env.QWEN_CODE_STARTUP_VERSION).toBe('0.21.3');
      // And the value rides the spawned child's env — the hop that actually
      // reaches the submit handler — not merely the parent's copy.
      const spawnEnv = spawnSyncMock.mock.calls.at(-1)?.[2]?.env;
      expect(spawnEnv.QWEN_CODE_STARTUP_VERSION).toBe('0.21.3');
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_STARTUP_VERSION;
      else process.env.QWEN_CODE_STARTUP_VERSION = inherited;
    }
  });

  it('initializes the version for a fresh CLI process', async () => {
    const inherited = process.env.QWEN_CODE_STARTUP_VERSION;
    delete process.env.QWEN_CODE_STARTUP_VERSION;
    try {
      await import('../cli-entry.js?initializes-version');
      expect(process.env.QWEN_CODE_STARTUP_VERSION).toBe('0.0.0-test');
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_STARTUP_VERSION;
      else process.env.QWEN_CODE_STARTUP_VERSION = inherited;
    }
  });

  it('clears the startup version before a managed-update relaunch', async () => {
    // Behavioural, not source-text: the update child exits 44, and the
    // relaunch through the launcher must NOT inherit the old session's
    // stamp, so the new build stamps its own version.
    const inherited = process.env.QWEN_CODE_STARTUP_VERSION;
    const inheritedShim = process.env.QWEN_CODE_LAUNCHER_PATH;
    process.env.QWEN_CODE_STARTUP_VERSION = '0.21.3';
    process.env.QWEN_CODE_LAUNCHER_PATH = '/opt/qwen-standalone/bin/qwen';
    existsSyncMock.mockImplementation(
      (p) => normalizePath(p) === '/opt/qwen-standalone/bin/qwen',
    );
    // Snapshot the env AT call time: the mock records the object by
    // reference, so asserting on it later would let a delete that happens
    // AFTER the spawn mutate the record and hide the regression.
    const spawnEnvs = [];
    const spawnImpl = spawnSyncMock.getMockImplementation();
    spawnSyncMock.mockImplementation((_cmd, _args, opts) => {
      spawnEnvs.push({ ...opts.env });
      return spawnEnvs.length === 1
        ? { status: 44, signal: null }
        : { status: 0, signal: null };
    });
    try {
      await import('../cli-entry.js?clears-version-on-relaunch');
      expect(spawnEnvs).toHaveLength(2);
      // The pre-update child inherits the session's stamp...
      expect(spawnEnvs[0].QWEN_CODE_STARTUP_VERSION).toBe('0.21.3');
      // ...and the post-update relaunch does not.
      expect('QWEN_CODE_STARTUP_VERSION' in spawnEnvs[1]).toBe(false);
    } finally {
      spawnSyncMock.mockImplementation(spawnImpl);
      existsSyncMock.mockImplementation(() => false);
      if (inherited === undefined) delete process.env.QWEN_CODE_STARTUP_VERSION;
      else process.env.QWEN_CODE_STARTUP_VERSION = inherited;
      if (inheritedShim === undefined)
        delete process.env.QWEN_CODE_LAUNCHER_PATH;
      else process.env.QWEN_CODE_LAUNCHER_PATH = inheritedShim;
    }
  });

  it('hands the post-update relaunch command line to cmd.exe verbatim', async () => {
    // #12687: the ""…"" idiom only reaches cmd intact when the spawn passes
    // windowsVerbatimArguments — otherwise Node's MSVCRT escaping rewrites
    // every embedded quote as \" and cmd /s rule 2 strips the line down to
    // a literal \"\"path\"\" program name, which is exactly the reporter's
    // error. The standalone Windows shim stamps an un-normalized
    // bin\..\bin launcher path, so the fixture carries one.
    const inheritedShim = process.env.QWEN_CODE_LAUNCHER_PATH;
    const launcher =
      'C:\\Users\\test\\AppData\\Local\\qwen-code\\qwen-code\\bin\\..\\bin\\qwen.cmd';
    process.env.QWEN_CODE_LAUNCHER_PATH = launcher;
    existsSyncMock.mockImplementation((p) => p === launcher);
    let spawnCount = 0;
    const spawnImpl = spawnSyncMock.getMockImplementation();
    spawnSyncMock.mockImplementation(() => {
      spawnCount += 1;
      return spawnCount === 1
        ? { status: 44, signal: null }
        : { status: 0, signal: null };
    });
    try {
      await import('../cli-entry.js?verbatim-cmd-relaunch');
      // First spawn is the managed-update child (exit 44), second is the
      // relaunch through the standalone shim. The interpreter mirrors the
      // production `process.env['ComSpec'] ?? 'cmd.exe'` so the assertion
      // also holds on a real Windows host, where ComSpec is always set.
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(spawnSyncMock).toHaveBeenLastCalledWith(
        process.env['ComSpec'] ?? 'cmd.exe',
        ['/d', '/s', '/c', `""${launcher}""`],
        expect.objectContaining({
          stdio: 'inherit',
          windowsVerbatimArguments: true,
        }),
      );
    } finally {
      spawnSyncMock.mockImplementation(spawnImpl);
      existsSyncMock.mockImplementation(() => false);
      if (inheritedShim === undefined)
        delete process.env.QWEN_CODE_LAUNCHER_PATH;
      else process.env.QWEN_CODE_LAUNCHER_PATH = inheritedShim;
    }
  });

  it('refuses a verbatim cmd relaunch when the launcher has cmd metacharacters', async () => {
    // windowsVerbatimArguments drops Node's escaping safety net, so a
    // launcher path containing cmd metacharacters would be re-tokenized
    // into extra commands. The update itself already landed at that point,
    // so the entry must skip the relaunch instead of spawning a malformed
    // command line.
    const inheritedShim = process.env.QWEN_CODE_LAUNCHER_PATH;
    const launcher = 'C:\\evil&whoami\\bin\\qwen.cmd';
    process.env.QWEN_CODE_LAUNCHER_PATH = launcher;
    existsSyncMock.mockImplementation((p) => p === launcher);
    let spawnCount = 0;
    const spawnImpl = spawnSyncMock.getMockImplementation();
    spawnSyncMock.mockImplementation(() => {
      spawnCount += 1;
      return spawnCount === 1
        ? { status: 44, signal: null }
        : { status: 0, signal: null };
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await import('../cli-entry.js?unsafe-cmd-launcher');
      // Only the managed-update child ran; no cmd.exe relaunch followed.
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('next run'),
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      stderrSpy.mockRestore();
      spawnSyncMock.mockImplementation(spawnImpl);
      existsSyncMock.mockImplementation(() => false);
      if (inheritedShim === undefined)
        delete process.env.QWEN_CODE_LAUNCHER_PATH;
      else process.env.QWEN_CODE_LAUNCHER_PATH = inheritedShim;
    }
  });

  it('leaves the startup version unset when package metadata is unreadable', async () => {
    const inherited = process.env.QWEN_CODE_STARTUP_VERSION;
    delete process.env.QWEN_CODE_STARTUP_VERSION;
    const readFileSyncMock = vi.mocked(readFileSync);
    const impl = readFileSyncMock.getMockImplementation();
    readFileSyncMock.mockImplementation(() => {
      throw new Error('unreadable');
    });
    try {
      await import('../cli-entry.js?unreadable-metadata');
      expect(process.env.QWEN_CODE_STARTUP_VERSION).toBeUndefined();
    } finally {
      readFileSyncMock.mockImplementation(impl);
      if (inherited === undefined) delete process.env.QWEN_CODE_STARTUP_VERSION;
      else process.env.QWEN_CODE_STARTUP_VERSION = inherited;
    }
  });

  it('stamps unknown when the package metadata has no version', async () => {
    const inherited = process.env.QWEN_CODE_STARTUP_VERSION;
    delete process.env.QWEN_CODE_STARTUP_VERSION;
    const readFileSyncMock = vi.mocked(readFileSync);
    const impl = readFileSyncMock.getMockImplementation();
    readFileSyncMock.mockImplementation(() => '{}');
    try {
      await import('../cli-entry.js?versionless-metadata');
      expect(process.env.QWEN_CODE_STARTUP_VERSION).toBe('unknown');
    } finally {
      readFileSyncMock.mockImplementation(impl);
      if (inherited === undefined) delete process.env.QWEN_CODE_STARTUP_VERSION;
      else process.env.QWEN_CODE_STARTUP_VERSION = inherited;
    }
  });

  it('prefers the standalone launcher shim, which carries the bundled Node', async () => {
    // The standalone package launches this file through `bin/qwen`, a shim that
    // selects the BUNDLED Node — the host may have none — and announces itself
    // via QWEN_CODE_LAUNCHER_PATH. There, stamping this file would hand every
    // subprocess a `#!/usr/bin/env node` script on a machine where that resolves
    // to nothing. The shim is the entry that reaches this build; stamp it.
    const inheritedCli = process.env.QWEN_CODE_CLI;
    const inheritedShim = process.env.QWEN_CODE_LAUNCHER_PATH;
    process.env.QWEN_CODE_LAUNCHER_PATH = '/opt/qwen-standalone/bin/qwen';
    delete process.env.QWEN_CODE_CLI;
    existsSyncMock.mockImplementation(
      (p) => normalizePath(p) === '/opt/qwen-standalone/bin/qwen',
    );
    try {
      await import('../cli-entry.js?stamps-shim');
      expect(process.env.QWEN_CODE_CLI).toBe('/opt/qwen-standalone/bin/qwen');
      // And the hint is CONSUMED, not leaked: the serve/mcp fast path never
      // reaches the spawn branch that used to delete it, and a child qwen from
      // a different checkout would read the leftover shim and republish it as
      // its own entry — the wrong build, wearing this one's stamp.
      expect('QWEN_CODE_LAUNCHER_PATH' in process.env).toBe(false);
    } finally {
      if (inheritedCli === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inheritedCli;
      if (inheritedShim === undefined)
        delete process.env.QWEN_CODE_LAUNCHER_PATH;
      else process.env.QWEN_CODE_LAUNCHER_PATH = inheritedShim;
    }
  });

  it('hands the compile cache to the spawned CLI', async () => {
    // Without it every spawned run — one-shot `-p` included — recompiles the
    // whole bundle; only the in-process fast paths used to enable the cache.
    const inherited = process.env.NODE_COMPILE_CACHE;
    delete process.env.NODE_COMPILE_CACHE;
    try {
      await import('../cli-entry.js?compile-cache');
      const spawnEnv = spawnSyncMock.mock.calls.at(-1)?.[2]?.env;
      expect(spawnEnv.NODE_COMPILE_CACHE).toBe('/tmp/node-compile-cache');
    } finally {
      if (inherited === undefined) delete process.env.NODE_COMPILE_CACHE;
      else process.env.NODE_COMPILE_CACHE = inherited;
    }
  });

  it('keeps an inherited compile cache and a disabled one', async () => {
    const inherited = process.env.NODE_COMPILE_CACHE;
    process.env.NODE_COMPILE_CACHE = '/custom/cache';
    try {
      await import('../cli-entry.js?inherited-compile-cache');
      expect(spawnSyncMock.mock.calls.at(-1)?.[2]?.env.NODE_COMPILE_CACHE).toBe(
        '/custom/cache',
      );

      delete process.env.NODE_COMPILE_CACHE;
      // NODE_DISABLE_COMPILE_CACHE=1 makes Node report the cache as disabled.
      enableCompileCacheMock.mockReturnValueOnce({ status: 3 });
      vi.resetModules();
      await import('../cli-entry.js?disabled-compile-cache');
      expect(
        'NODE_COMPILE_CACHE' in spawnSyncMock.mock.calls.at(-1)[2].env,
      ).toBe(false);
    } finally {
      if (inherited === undefined) delete process.env.NODE_COMPILE_CACHE;
      else process.env.NODE_COMPILE_CACHE = inherited;
    }
  });

  it('falls back to tmpdir for tilde QWEN_HOME when homedir is unavailable', async () => {
    const inheritedHome = process.env.QWEN_HOME;
    homedirMock.mockImplementation(() => {
      throw new Error('homedir unavailable');
    });
    process.env.QWEN_HOME = '~';
    try {
      await import('../cli-entry.js?tilde-home-fallback');
      expect(normalizePath(process.env.QWEN_CODE_MANAGED_NPM_ROOT)).toBe(
        '/tmp/updates/npm',
      );
    } finally {
      if (inheritedHome === undefined) delete process.env.QWEN_HOME;
      else process.env.QWEN_HOME = inheritedHome;
    }
  });

  describe('outside Windows', () => {
    const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

    const inheritedCompileCache = process.env.NODE_COMPILE_CACHE;

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock(cliPath, () => ({}));
      delete process.env.NODE_COMPILE_CACHE;
    });

    afterEach(() => {
      vi.doUnmock(cliPath);
      if (inheritedCompileCache === undefined) {
        delete process.env.NODE_COMPILE_CACHE;
      } else {
        process.env.NODE_COMPILE_CACHE = inheritedCompileCache;
      }
    });

    it('runs the CLI in this process with gc exposed', async () => {
      await import('../cli-entry.js?in-process');

      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(process.argv.slice(1)).toEqual([cliPath, 'review', 'check']);
      expect(typeof globalThis.gc).toBe('function');
      // Supervised relaunches and tool subprocesses inherit it from here.
      expect(process.env.NODE_COMPILE_CACHE).toBe('/tmp/node-compile-cache');
    });

    it('keeps the spawned child with --expose-gc under Bun', async () => {
      Object.defineProperty(process.versions, 'bun', {
        value: '1.3.14',
        configurable: true,
      });
      try {
        await import('../cli-entry.js?bun');

        expect(spawnSyncMock).toHaveBeenCalledWith(
          process.execPath,
          ['--expose-gc', expect.stringMatching(/cli\.js$/), 'review', 'check'],
          expect.anything(),
        );
      } finally {
        delete process.versions.bun;
      }
    });

    it('relaunches through the launcher when the CLI exits after an update', async () => {
      const exitListeners = process.listeners('exit');
      process.env.QWEN_CODE_LAUNCHER_PATH = '/opt/qwen-standalone/bin/qwen';
      existsSyncMock.mockImplementation(
        (p) => normalizePath(p) === '/opt/qwen-standalone/bin/qwen',
      );
      try {
        await import('../cli-entry.js?in-process-update');
        const hook = process
          .listeners('exit')
          .find((l) => !exitListeners.includes(l));

        hook(0);
        expect(spawnSyncMock).not.toHaveBeenCalled();

        hook(44);
        expect(spawnSyncMock).toHaveBeenCalledWith(
          '/opt/qwen-standalone/bin/qwen',
          [],
          expect.objectContaining({
            env: expect.objectContaining({
              QWEN_CODE_RELAUNCH_ARGS: JSON.stringify(['review', 'check']),
            }),
          }),
        );
        process.removeListener('exit', hook);
      } finally {
        delete process.env.QWEN_CODE_LAUNCHER_PATH;
      }
    });

    it('defers a --bg launch to cli.js instead of exiting on its version token', async () => {
      // `qwen --bg -v "$TASK"`: the version token is one of that launch's
      // prompt words. Intercepting it here printed a version and exited 0
      // before cli.js ever ran, so a wrapper's `qwen --bg -v "$TASK" &&
      // notify` reported success with no session started.
      process.argv = [
        'node',
        'scripts/cli-entry.js',
        '--bg',
        '-v',
        'audit the release',
      ];
      process.env.CLI_VERSION = '9.9.9';
      const writes = [];
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk) => {
          writes.push(String(chunk));
          return true;
        });
      try {
        await import('../cli-entry.js?bg-version-token');

        expect(writes).not.toContain('9.9.9\n');
        expect(exitSpy).not.toHaveBeenCalledWith(0);
        // The launch reached cli.js, which owns the --bg gate, with every
        // token intact.
        expect(process.argv.slice(1)).toEqual([
          cliPath,
          '--bg',
          '-v',
          'audit the release',
        ]);
      } finally {
        writeSpy.mockRestore();
        delete process.env.CLI_VERSION;
      }
    });

    it('still fast-paths a plain version request', async () => {
      // The --bg deferral is narrow: an argv with no --bg token keeps the
      // in-process fast path, so the fix cannot cost every `qwen --version`.
      process.argv = ['node', 'scripts/cli-entry.js', '--version'];
      process.env.CLI_VERSION = '9.9.9';
      const writes = [];
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk) => {
          writes.push(String(chunk));
          return true;
        });
      try {
        await import('../cli-entry.js?plain-version');

        expect(writes).toContain('9.9.9\n');
        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        writeSpy.mockRestore();
        delete process.env.CLI_VERSION;
      }
    });
  });
});
