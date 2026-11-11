/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { quote } from 'shell-quote';

import { createBashShellProvider } from './bashProvider.js';
import type { ShellProvider, ShellSessionContext } from './shellProvider.js';
import { wrapPosixShellCommand } from './shellPrefix.js';
import {
  setSnapshotsDir,
  _resetSnapshotsDirForTest,
} from '../bash/ShellSnapshot.js';
import { singleQuoteForEval } from '../bash/shellQuoting.js';
import {
  ENV_PID,
  ENV_CONFIG_DIR,
  BRAND_FIXED_ENV_PREFIX,
  ENV_SHELL_PREFIX,
  ENV_SHELL_PREFIX_COMPAT,
} from '../../config/brand.js';
import {
  _resetPkillSelfProtectionForTest,
  setPkillSelfProtectionEnabled,
} from './pkillSelfProtection.js';

// Skip on Windows — bash provider targets POSIX shells.
const isWindows = os.platform() === 'win32';
const describeUnix = isWindows ? describe.skip : describe;
const execFileAsync = promisify(execFile);
const TEST_SHELL_PATH = '/bin/bash';
const bashPathPrefixEnv = `__${BRAND_FIXED_ENV_PREFIX}BASH_PATH_PREFIX`;
const pathPrefixExport = `export PATH="\${${bashPathPrefixEnv}:+$${bashPathPrefixEnv}:}$PATH"`;
const tempPathSlug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';

/** ShellSessionContext 的成员都是必填的，而多数用例只关心其中一个。 */
function sessionContext(
  overrides: Partial<ShellSessionContext> = {},
): ShellSessionContext {
  return {
    getPluginBinPaths: () => [],
    getSessionEnvScript: async () => null,
    ...overrides,
  };
}

async function runBashEval(command: string): Promise<string> {
  const { stdout } = await execFileAsync(TEST_SHELL_PATH, [
    '-c',
    `eval ${singleQuoteForEval(command)} < /dev/null`,
  ]);
  return stdout.trim();
}

function extractEvalPart(commandString: string): string {
  const evalStart = commandString.indexOf('eval ');
  const pwdStart = commandString.lastIndexOf(' && pwd -P >|');
  if (evalStart < 0 || pwdStart <= evalStart) {
    throw new Error(
      `Cannot extract eval part from: ${commandString} (evalStart=${evalStart}, pwdStart=${pwdStart})`,
    );
  }
  return commandString.slice(evalStart, pwdStart);
}

describeUnix('bashProvider', () => {
  const shellPath = TEST_SHELL_PATH;
  let provider: ShellProvider;
  let tmpDir: string;

  beforeEach(async () => {
    setPkillSelfProtectionEnabled(false);
    _resetPkillSelfProtectionForTest();
    vi.stubEnv(ENV_CONFIG_DIR, '');
    vi.stubEnv(ENV_SHELL_PREFIX, '');
    vi.stubEnv(ENV_SHELL_PREFIX_COMPAT, '');
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'bashprov-test-'));
    setSnapshotsDir(tmpDir);
    provider = await createBashShellProvider(shellPath, {
      skipSnapshot: true,
    });
  });

  afterEach(async () => {
    setPkillSelfProtectionEnabled(false);
    _resetPkillSelfProtectionForTest();
    vi.unstubAllEnvs();
    _resetSnapshotsDirForTest();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── createBashShellProvider ──────────────────────────────────────────

  describe('createBashShellProvider', () => {
    it('returns a provider with type "bash"', () => {
      expect(provider.type).toBe('bash');
    });

    it('returns the shellPath that was passed in', () => {
      expect(provider.shellPath).toBe(shellPath);
    });

    it('sets detached to true', () => {
      expect(provider.detached).toBe(true);
    });

    it('works with a custom shell path', async () => {
      const zshProvider = await createBashShellProvider('/bin/zsh');
      expect(zshProvider.type).toBe('bash');
      expect(zshProvider.shellPath).toBe('/bin/zsh');
      expect(zshProvider.detached).toBe(true);
    });
  });

  // ── buildExecCommand ─────────────────────────────────────────────────

  describe('buildExecCommand', () => {
    const defaultOpts = { id: 42, };

    it('returns a commandString containing eval', async () => {
      const { commandString } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );
      expect(commandString).toContain('eval ');
    });

    it('returns a commandString containing extglob disable for bash', async () => {
      const { commandString } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );
      expect(commandString).toContain('shopt -u extglob');
    });

    it('installs the opted-in guard immediately before the user command on Linux', async () => {
      setPkillSelfProtectionEnabled(true);

      const { commandString } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );

      if (process.platform === 'linux') {
        const guardStart = commandString.indexOf('pkill-guard-');
        const userEval = commandString.lastIndexOf('eval ');
        expect(guardStart).toBeGreaterThanOrEqual(0);
        expect(guardStart).toBeLessThan(userEval);
        expect(commandString).not.toContain('pkill() {');
        expect(commandString).not.toContain('\n');
      } else {
        expect(commandString).not.toContain('pkill-guard-');
      }
    });

    it('installs the opted-in guard for a zsh shell path on Linux', async () => {
      setPkillSelfProtectionEnabled(true);
      const zshProvider = await createBashShellProvider('/bin/zsh', {
        skipSnapshot: true,
      });

      const { commandString } = await zshProvider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );

      if (process.platform === 'linux') {
        const guardStart = commandString.indexOf('pkill-guard-');
        const userEval = commandString.lastIndexOf('eval ');
        expect(guardStart).toBeGreaterThanOrEqual(0);
        expect(guardStart).toBeLessThan(userEval);
        expect(commandString).not.toContain('pkill() {');
        expect(commandString).not.toContain('\n');
      } else {
        expect(commandString).not.toContain('pkill-guard-');
      }
    });

    it('does not install the guard without entry-point opt-in', async () => {
      const { commandString } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );

      expect(commandString).not.toContain('pkill-guard-');
    });

    it('does not inject shell-specific syntax through a command prefix', async () => {
      setPkillSelfProtectionEnabled(true);
      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/sh -c');

      const { commandString } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );

      expect(commandString).not.toContain('pkill-guard-');
    });

    it.skipIf(process.platform !== 'linux')(
      'keeps /proc shell detection stable when the guard is enabled',
      async () => {
        setPkillSelfProtectionEnabled(true);
        const { commandString } = await provider.buildExecCommand(
          String.raw`sed -r -e 's/\x0.*//' /proc/$$/cmdline`,
          defaultOpts,
        );
        const environment = await provider.getEnvironmentOverrides('');
        const { stdout } = await execFileAsync(
          shellPath,
          provider.getSpawnArgs(commandString),
          { env: { ...process.env, ...environment } },
        );

        expect(path.basename(stdout.trim())).toBe('bash');
      },
    );

    it('uses zsh extglob disable for zsh shell path', async () => {
      const zshProvider = await createBashShellProvider('/usr/bin/zsh');
      const { commandString } = await zshProvider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );
      expect(commandString).toContain('setopt NO_EXTENDED_GLOB');
      expect(commandString).not.toContain('shopt -u extglob');
    });

    it('wraps the fully assembled command when a prefix is enabled', async () => {
      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
      const sessionScript = `export SESSION_MARKER='ready'`;
      const prefixedProvider = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });

      const { commandString, cwdFilePath } =
        await prefixedProvider.buildExecCommand('echo "$SESSION_MARKER"', {
          id: 'wrapped',
          sessionContext: sessionContext({
            getSessionEnvScript: async () => sessionScript,
          }),
        });
      const assembledCommand = [
        sessionScript,
        '{ { shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true; }',
        `eval 'echo "$SESSION_MARKER"' < /dev/null`,
        `pwd -P >| ${quote([cwdFilePath])}`,
      ].join(' && ');

      expect(commandString).toBe(
        wrapPosixShellCommand(assembledCommand, '/bin/bash -c'),
      );
    });

    it('reads the prefix environment for every command', async () => {
      const first = await provider.buildExecCommand('echo first', defaultOpts);

      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
      const second = await provider.buildExecCommand(
        'echo second',
        defaultOpts,
      );

      expect(first.commandString).not.toMatch(/^\/bin\/bash -c /);
      expect(second.commandString).toMatch(/^\/bin\/bash -c /);
    });

    it('reads prefix updates made while awaiting the session environment', async () => {
      let signalSessionEnvStarted!: () => void;
      const sessionEnvStarted = new Promise<void>((resolve) => {
        signalSessionEnvStarted = resolve;
      });
      let releaseSessionEnv!: () => void;
      const sessionEnvGate = new Promise<void>((resolve) => {
        releaseSessionEnv = resolve;
      });
      const latePrefixProvider = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });

      const commandPromise = latePrefixProvider.buildExecCommand(
        'echo delayed',
        {
          ...defaultOpts,
          sessionContext: sessionContext({
            getSessionEnvScript: async () => {
              signalSessionEnvStarted();
              await sessionEnvGate;
              return null;
            },
          }),
        },
      );
      await sessionEnvStarted;
      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
      releaseSessionEnv();

      const { commandString } = await commandPromise;
      expect(commandString).toMatch(/^\/bin\/bash -c /);
      expect(commandString).toContain(
        '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true',
      );
    });

    it('uses the compatibility prefix when the branded variable is absent', async () => {
      delete process.env[ENV_SHELL_PREFIX];
      vi.stubEnv(ENV_SHELL_PREFIX_COMPAT, '/bin/bash -c');

      const { commandString } = await provider.buildExecCommand(
        'echo compat',
        defaultOpts,
      );

      expect(commandString).toMatch(/^\/bin\/bash -c /);
    });

    it('lets an empty branded prefix disable the compatibility prefix', async () => {
      vi.stubEnv(ENV_SHELL_PREFIX, '');
      vi.stubEnv(ENV_SHELL_PREFIX_COMPAT, '/bin/bash -c');

      const { commandString } = await provider.buildExecCommand(
        'echo direct',
        defaultOpts,
      );

      expect(commandString).not.toMatch(/^\/bin\/bash -c /);
      expect(commandString).toContain('shopt -u extglob');
      expect(commandString).not.toContain('setopt NO_EXTENDED_GLOB');
    });

    it('uses the shell-agnostic extglob guard for a bash wrapper under zsh', async () => {
      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
      const zshProvider = await createBashShellProvider('/usr/bin/zsh', {
        skipSnapshot: true,
      });

      const { commandString } = await zshProvider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );

      expect(commandString).toContain(
        '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true',
      );
    });

    it('uses the shell-agnostic extglob guard for a zsh wrapper under bash', async () => {
      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/zsh -c');

      const { commandString } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );

      expect(commandString).toContain(
        '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true',
      );
    });

    it('returns a commandString containing pwd tracking', async () => {
      const { commandString } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );
      expect(commandString).toContain('pwd -P >|');
    });

    it('returns a cwdFilePath under os.tmpdir() by default', async () => {
      const { cwdFilePath } = await provider.buildExecCommand(
        'echo hello',
        defaultOpts,
      );
      expect(cwdFilePath).toBe(
        path.join(os.tmpdir(), `${tempPathSlug}-${defaultOpts.id}-cwd`),
      );
    });

    it('embeds the cwdFilePath in the commandString for pwd tracking', async () => {
      const { commandString, cwdFilePath } = await provider.buildExecCommand(
        'ls',
        defaultOpts,
      );
      // The posix path of cwdFilePath should appear inside the command
      const posixCwd = cwdFilePath.replace(/\\/g, '/');
      expect(commandString).toContain(posixCwd);
    });

    it('quotes cwd tracking paths with embedded single quotes', async () => {
      const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue("/tmp/it'works");
      try {
        const { commandString } = await provider.buildExecCommand('ls', {
          id: 7,
        });

        expect(commandString).toContain(
          `pwd -P >| "/tmp/it'works/${tempPathSlug}-7-cwd"`,
        );
        expect(commandString).not.toContain(
          `pwd -P >| '/tmp/it'works/${tempPathSlug}-7-cwd'`,
        );
      } finally {
        tmpdirSpy.mockRestore();
      }
    });

    it('supports string ids', async () => {
      const { cwdFilePath } = await provider.buildExecCommand('ls', {
        id: 'abc-123',
        });
      expect(cwdFilePath).toContain(`${tempPathSlug}-abc-123-cwd`);
    });
  });

  describe('prefixed command execution', () => {
    it('preserves stdout, stderr, and CWD tracking', async () => {
      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
      const targetDir = path.join(tmpDir, 'nested');
      await mkdir(targetDir);

      const { commandString, cwdFilePath } = await provider.buildExecCommand(
        `printf stdout; printf stderr >&2; cd ${quote([targetDir])}`,
        { id: 'execution', },
      );
      const { stdout, stderr } = await execFileAsync(
        shellPath,
        provider.getSpawnArgs(commandString),
        { cwd: tmpDir },
      );

      expect(stdout).toBe('stdout');
      expect(stderr).toBe('stderr');
      await expect(readFile(cwdFilePath, 'utf8')).resolves.toBe(
        `${await realpath(targetDir)}\n`,
      );
    });

    it('preserves a non-zero exit code from the wrapped command', async () => {
      vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
      const { commandString } = await provider.buildExecCommand(
        'printf failed >&2; exit 7',
        { id: 'failure', },
      );

      await expect(
        execFileAsync(shellPath, provider.getSpawnArgs(commandString), {
          cwd: tmpDir,
        }),
      ).rejects.toMatchObject({ code: 7, stderr: 'failed' });
    });

    it('reports a missing wrapper as a normal shell failure', async () => {
      vi.stubEnv(ENV_SHELL_PREFIX, path.join(tmpDir, 'missing-wrapper'));
      const { commandString } = await provider.buildExecCommand(
        'printf unreachable',
        { id: 'missing-wrapper', },
      );

      await expect(
        execFileAsync(shellPath, provider.getSpawnArgs(commandString), {
          cwd: tmpDir,
        }),
      ).rejects.toMatchObject({ code: 127 });
    });
  });

  // ── CWD file path format ─────────────────────────────────────────────

  describe('CWD file path format', () => {
    it('follows the <brand>-<id>-cwd naming convention', async () => {
      const { cwdFilePath } = await provider.buildExecCommand('ls', {
        id: 99,
        });
      expect(path.basename(cwdFilePath)).toBe(`${tempPathSlug}-99-cwd`);
    });
  });

  // ── stdin redirect for regular vs heredoc commands ───────────────────

  describe('command assembly – stdin redirect', () => {
    it('adds stdin redirect (< /dev/null) for regular commands', async () => {
      const { commandString } = await provider.buildExecCommand('echo hello', {
        id: 1,
        });
      expect(commandString).toContain('/dev/null');
    });

    it('does NOT add stdin redirect for heredoc commands', async () => {
      const heredocCmd = 'cat <<EOF\nhello\nEOF';
      const { commandString } = await provider.buildExecCommand(heredocCmd, {
        id: 2,
        });
      // The eval-quoted command should not contain a stdin redirect
      // Heredocs are their own stdin, so < /dev/null must be absent from the
      // quoting layer (it may still appear in the pwd tracking part).
      const evalPart = commandString
        .split('&&')
        .find((p) => p.includes('eval'));
      expect(evalPart).toBeDefined();
      expect(evalPart).not.toContain('< /dev/null');
    });

    it('preserves fd redirects in piped commands without introducing a stray 2 token', async () => {
      const { commandString } = await provider.buildExecCommand(
        'bazel test //pkg:target --test_output=all 2>&1 | tail -60',
        { id: 3, },
      );
      const evalPart = extractEvalPart(commandString);

      expect(evalPart).toContain(
        'bazel test //pkg:target --test_output=all 2>&1 | tail -60',
      );
      expect(evalPart).toContain("' < /dev/null");
      expect(evalPart).not.toContain('\\< /dev/null');
      expect(evalPart).not.toMatch(/(?:^|\s)2\s+>&\s+1(?:\s|$)/);
    });

    it('uses raw eval-level stdin redirect for non-piped commands too', async () => {
      const { commandString } = await provider.buildExecCommand('echo hello', {
        id: 4,
        });
      const evalPart = extractEvalPart(commandString);

      expect(evalPart).toBe("eval 'echo hello' < /dev/null");
    });
  });

  // ── getSpawnArgs ─────────────────────────────────────────────────────

  describe('getSpawnArgs', () => {
    it('returns ["-c", "-l", commandString] (login shell, no snapshot)', () => {
      const cmd = 'echo hello';
      const args = provider.getSpawnArgs(cmd);
      expect(args).toEqual(['-c', '-l', cmd]);
    });

    it('includes the full commandString as the last element', () => {
      const cmd = 'shopt -u extglob && eval echo hello && pwd -P >| /tmp/cwd';
      const args = provider.getSpawnArgs(cmd);
      expect(args[args.length - 1]).toBe(cmd);
    });
  });

  // ── getEnvironmentOverrides ──────────────────────────────────────────

  describe('getEnvironmentOverrides', () => {
    it('returns an empty object', async () => {
      const overrides = await provider.getEnvironmentOverrides('echo hello');
      expect(overrides).toEqual({});
    });

    it('passes the trusted parent pid separately from the command string', async () => {
      setPkillSelfProtectionEnabled(true);

      const overrides = await provider.getEnvironmentOverrides('echo hello');

      if (process.platform === 'linux') {
        expect(overrides).toEqual({
          [ENV_PID]: String(process.pid),
        });
      } else {
        expect(overrides).toEqual({});
      }
    });
  });

  // ── Snapshot integration ────────────────────────────────────────────

  describe('snapshot integration', () => {
    it('skips -l flag when snapshot is active', async () => {
      // Create provider WITH snapshot (not skipped)
      const snapshotProvider = await createBashShellProvider(shellPath);
      const args = snapshotProvider.getSpawnArgs('echo hello');

      // If snapshot was created successfully, -l should be absent
      // If snapshot failed (e.g., shell too slow), -l should be present
      // Either way, -c and the command should be present
      expect(args).toContain('-c');
      expect(args[args.length - 1]).toBe('echo hello');
    });

    it('includes source command when snapshot is active', async () => {
      const snapshotProvider = await createBashShellProvider(shellPath);
      const { commandString } = await snapshotProvider.buildExecCommand(
        'echo hello',
        { id: 1, },
      );

      // Check if snapshot was created — if so, source should be in command
      const args = snapshotProvider.getSpawnArgs('test');
      if (!args.includes('-l')) {
        // Snapshot is active
        expect(commandString).toContain('source ');
        expect(commandString).toContain('2>/dev/null || true');
      }
    });

    it('skipSnapshot option prevents snapshot creation', async () => {
      const noSnapshotProvider = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });
      const args = noSnapshotProvider.getSpawnArgs('echo hello');
      expect(args).toContain('-l');
    });

    it('falls back to -l when snapshot file is deleted', async () => {
      const snapshotProvider = await createBashShellProvider(shellPath);
      const argsBefore = snapshotProvider.getSpawnArgs('test');

      if (!argsBefore.includes('-l')) {
        // Snapshot was active — now delete all snapshot files
        const { readdir, unlink } = await import('node:fs/promises');
        const files = await readdir(tmpDir);
        for (const f of files) {
          await unlink(path.join(tmpDir, f));
        }

        // Next buildExecCommand should detect the missing snapshot
        const { commandString } = await snapshotProvider.buildExecCommand(
          'echo test',
          { id: 99, },
        );

        // After invalidation, getSpawnArgs should include -l again
        const argsAfter = snapshotProvider.getSpawnArgs('test');
        expect(argsAfter).toContain('-l');
        // And no source command
        expect(commandString).not.toContain('source ');
      }
    });
  });

  // ── Plugin bin paths (PATH injection) ───────────────────────────────

  describe('plugin bin paths', () => {
    const optsFor = (getPluginBinPaths: () => string[]) => ({
      id: 7,
      sessionContext: sessionContext({ getPluginBinPaths }),
    });

    it('does not emit export PATH when the session context reports no paths', async () => {
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });
      const { commandString } = await p.buildExecCommand(
        'echo hi',
        optsFor(() => []),
      );
      expect(commandString).not.toContain('export PATH=');
    });

    it('prepends bin paths to PATH when provided', async () => {
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });
      const { commandString, env } = await p.buildExecCommand(
        'echo hi',
        optsFor(() => ['/tmp/plug-a/bin', '/tmp/plug-b/bin']),
      );
      expect(commandString).toContain(pathPrefixExport);
      expect(commandString).not.toContain('/tmp/plug-a');
      expect(env?.[bashPathPrefixEnv]).toBe('/tmp/plug-a/bin:/tmp/plug-b/bin');
    });

    it('escapes single quotes in bin paths safely', async () => {
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });
      const { commandString, env } = await p.buildExecCommand(
        'echo hi',
        optsFor(() => ["/tmp/it's-a-plugin/bin"]),
      );
      expect(commandString).not.toContain("it's-a-plugin");
      expect(env?.[bashPathPrefixEnv]).toBe("/tmp/it's-a-plugin/bin");
    });

    it('reads the session context per buildExecCommand so sessions cannot share paths', async () => {
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });

      const { env: first } = await p.buildExecCommand(
        'echo hi',
        optsFor(() => ['/tmp/first/bin']),
      );
      expect(first?.[bashPathPrefixEnv]).toBe('/tmp/first/bin');

      const { env: second } = await p.buildExecCommand(
        'echo hi',
        optsFor(() => ['/tmp/second/bin']),
      );
      expect(second?.[bashPathPrefixEnv]).toBe('/tmp/second/bin');
      expect(first?.[bashPathPrefixEnv]).toBe('/tmp/first/bin');
    });

    it('reads the session env script per buildExecCommand so sessions cannot share it', async () => {
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });

      const { commandString: first } = await p.buildExecCommand('echo hi', {
        id: 7,
        sessionContext: sessionContext({
          getSessionEnvScript: async () => 'export FROM=first',
        }),
      });
      expect(first).toContain('export FROM=first');
      expect(first).not.toContain('export FROM=second');

      const { commandString: second } = await p.buildExecCommand('echo hi', {
        id: 8,
        sessionContext: sessionContext({
          getSessionEnvScript: async () => 'export FROM=second',
        }),
      });
      expect(second).toContain('export FROM=second');
      expect(second).not.toContain('export FROM=first');
    });

    it('omits plugin bin paths when no session context is supplied', async () => {
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });
      const { env } = await p.buildExecCommand('echo hi', { id: 7 });
      expect(env?.[bashPathPrefixEnv]).toBeUndefined();
    });

    it('orders PATH export after snapshot source so it is not overridden', async () => {
      // Use a real snapshot-enabled provider to ensure ordering survives.
      const p = await createBashShellProvider(shellPath);
      const { commandString } = await p.buildExecCommand(
        'echo hi',
        optsFor(() => ['/tmp/plug/bin']),
      );

      const args = p.getSpawnArgs('test');
      if (!args.includes('-l')) {
        // Snapshot is active — verify ordering
        const sourceIdx = commandString.indexOf('source ');
        const pathIdx = commandString.indexOf('export PATH=');
        expect(sourceIdx).toBeGreaterThanOrEqual(0);
        expect(pathIdx).toBeGreaterThan(sourceIdx);
      }
    });
  });

  // ── Config bin paths (PATH injection) ───────────────────────────────

  describe('config bin paths', () => {
    const opts = { id: 7, };

    it('prepends the configured bin directory to PATH when provided', async () => {
      vi.stubEnv(ENV_CONFIG_DIR, '/tmp/qwen-work');
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });

      const { commandString, env } = await p.buildExecCommand('echo hi', opts);
      expect(commandString).toContain(pathPrefixExport);
      expect(env?.[bashPathPrefixEnv]).toBe('/tmp/qwen-work/bin');
    });

    it('orders a unified PATH export after session env with config before plugin bin', async () => {
      vi.stubEnv(ENV_CONFIG_DIR, '/tmp/qwen-work');
      const p = await createBashShellProvider(shellPath, {
        skipSnapshot: true,
      });

      const { commandString, env } = await p.buildExecCommand('echo hi', {
        id: 7,
        sessionContext: sessionContext({
          getPluginBinPaths: () => ['/tmp/plug/bin'],
          getSessionEnvScript: async () =>
            `export PATH='/tmp/session/bin':"$PATH"`,
        }),
      });
      const sessionIdx = commandString.indexOf(
        `export PATH='/tmp/session/bin':"$PATH"`,
      );
      const policyIdx = commandString.indexOf(
        pathPrefixExport,
      );
      const evalIdx = commandString.indexOf('eval ');

      expect(sessionIdx).toBeGreaterThanOrEqual(0);
      expect(policyIdx).toBeGreaterThan(sessionIdx);
      expect(evalIdx).toBeGreaterThan(policyIdx);
      expect(env?.[bashPathPrefixEnv]).toBe('/tmp/qwen-work/bin:/tmp/plug/bin');
    });
  });
});

describeUnix('bash eval – pipeline fd redirect behavior', () => {
  it.each([
    ['B1 pipe output is consumed', 'printf x | wc -c', '1'],
    ['B2 larger pipe output is consumed', 'printf hello | wc -c', '5'],
    [
      'B3 stderr merge flows through pipe',
      'sh -c "printf err >&2" 2>&1 | tail -1',
      'err',
    ],
    [
      'B4 stdout and stderr merge through pipe',
      'sh -c "printf out; printf err >&2" 2>&1 | wc -c',
      '6',
    ],
  ])('%s', async (_name, command, expected) => {
    await expect(runBashEval(command)).resolves.toBe(expected);
  });

  describe('with redirect files', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'bashprov-behavior-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('B5 sends stdout through pipe and appends stderr to file with 2>>file', async () => {
      const redirectFile = path.join(tmpDir, 'b5-stderr');

      await expect(
        runBashEval(
          `sh -c "printf out; printf err >&2" 2>>${redirectFile} | wc -c`,
        ),
      ).resolves.toBe('3');
      await expect(readFile(redirectFile, 'utf8')).resolves.toBe('err');
    });

    it('B6 sends stdout and stderr to file with &>file, leaving pipe empty', async () => {
      const redirectFile = path.join(tmpDir, 'b6-output');

      await expect(
        runBashEval(
          `sh -c "printf out; printf err >&2" &>${redirectFile} | wc -c`,
        ),
      ).resolves.toBe('0');
      await expect(readFile(redirectFile, 'utf8')).resolves.toBe('outerr');
    });

    it('B7 sends stdout and stderr to file with >file 2>&1, leaving pipe empty', async () => {
      const redirectFile = path.join(tmpDir, 'b7-output');

      await expect(
        runBashEval(
          `sh -c "printf out; printf err >&2" >${redirectFile} 2>&1 | wc -c`,
        ),
      ).resolves.toBe('0');
      await expect(readFile(redirectFile, 'utf8')).resolves.toBe('outerr');
    });
  });

  it('|& merged pipe output is preserved when supported by the shell', async () => {
    try {
      expect(await runBashEval('sh -c "printf err >&2" |& cat')).toBe('err');
    } catch (error) {
      expect(String(error)).toContain("unexpected token `&'");
    }
  });
});
