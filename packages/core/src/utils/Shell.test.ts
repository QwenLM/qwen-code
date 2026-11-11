/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../config/brand.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  enableDetachedProcessGuard,
  stopDetachedProcessGuard,
} from '../services/detachedProcessGuard.js';
import { access, constants, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BRAND_TEMP_PATH_SLUG,
  ENV_SHELL_PREFIX,
  ENV_SHELL_PREFIX_COMPAT,
} from '../config/brand.js';
import {
  exec,
  findSuitableShell,
  setCwd,
  setCwdAndNotify,
  setCwdChangedCallback,
  getCwd,
  resetForTest,
  runWithCwdOverride,
  currentCwdForTest,
  initializeShellSession,
  runWithShellSession,
  getOriginalCwd,
  bindCwdContext,
  setOriginalCwd,
} from './Shell.js';
import { buildShellSpawnTransform } from '../services/shellSpawnPreparation.js';
import {
  _resetTaskOutputDirForTest,
  setTaskOutputDir,
} from './task/diskOutput.js';
import { runLogger } from './runLogger.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const isWindows = process.platform === 'win32';

describe(
  'Shell integration tests',
  () => {
    beforeEach(() => {
      vi.stubEnv(ENV_SHELL_PREFIX, '');
      vi.stubEnv(ENV_SHELL_PREFIX_COMPAT, '');
      resetForTest();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      _resetTaskOutputDirForTest();
      setCwdChangedCallback(null);
      resetForTest();
    });

    describe.skipIf(isWindows)('exec', () => {
      it('starts one guard before the first detached shell and reuses it', async () => {
        enableDetachedProcessGuard();
        vi.mocked(spawn).mockClear();
        try {
          for (let i = 0; i < 2; i++) {
            const command = await exec('printf guard-order', new AbortController().signal, 'bash', {
              preventCwdChanges: true,
            });
            expect((await command.result).stdout).toBe('guard-order');
            command.cleanup();
          }
          const calls = vi.mocked(spawn).mock.calls.filter(([, args]) =>
            Array.isArray(args) && (args[0] === '--eval' || args.some(arg => arg.includes('guard-order'))));
          const guardCalls = calls.filter(([, args]) => Array.isArray(args) && args[0] === '--eval');
          expect(guardCalls).toHaveLength(1);
          expect(calls[0]).toBe(guardCalls[0]);
          expect(calls).toHaveLength(3);
        } finally {
          stopDetachedProcessGuard();
        }
      });

      it('passes per-command PATH data through strict spawn environment sanitization', async () => {
        vi.stubEnv('GITHUB_SHA', 'test');
        vi.stubEnv(ENV_CONFIG_DIR, '');

        const command = await exec('printf "%s" "$PATH"', new AbortController().signal, 'bash', {
          preventCwdChanges: true,
          sessionContext: {
            getPluginBinPaths: () => ["/tmp/中文 plugin's/bin"],
            getSessionEnvScript: async () => null,
          },
          transformSpawn: buildShellSpawnTransform({
            sanitizationConfig: {
              allowedEnvironmentVariables: [],
              blockedEnvironmentVariables: [],
              enableEnvironmentVariableRedaction: true,
            },
          }),
        });
        const result = await command.result;
        expect(result.code).toBe(0);
        expect(result.stdout.startsWith("/tmp/中文 plugin's/bin:")).toBe(true);
        command.cleanup();
      });

      it('resolves plugin bin paths from the session context of each command', async () => {
        vi.stubEnv(ENV_CONFIG_DIR, '');

        const runWithPath = async (binPath: string) => {
          const command = await exec(
            'printf "%s" "$PATH"',
            new AbortController().signal,
            'bash',
            {
              preventCwdChanges: true,
              sessionContext: {
                getPluginBinPaths: () => [binPath],
                getSessionEnvScript: async () => null,
              },
            },
          );
          const result = await command.result;
          command.cleanup();
          return result.stdout.split(':')[0];
        };
        // 两个会话共用同一个已缓存的 bash provider，PATH 必须各取各的。
        const [first, second] = await Promise.all([
          runWithPath('/tmp/session-a/bin'),
          runWithPath('/tmp/session-b/bin'),
        ]);
        expect(first).toBe('/tmp/session-a/bin');
        expect(second).toBe('/tmp/session-b/bin');
      });

      it.each([false, true])('records safe diagnostics on failure in file mode=%s', async (stdoutToFile) => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'shell-errors-'));
        setTaskOutputDir(directory);
        const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
        try {
          const command = await exec('qwen_missing_command_fixture', new AbortController().signal, 'bash', {
            stdoutToFile,
            preventCwdChanges: true,
          });
          expect((await command.result).code).toBe(127);
          await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/\[Shell\] execution failed:.*code=127.*command not found/),
          ));
          expect(warn.mock.calls.flat().join('\n')).not.toContain('qwen_missing_command_fixture');
          command.cleanup();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it('captures file diagnostics before result consumers remove the output', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'shell-errors-cleanup-'));
        setTaskOutputDir(directory);
        const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
        try {
          const command = await exec('qwen_missing_command_fixture', new AbortController().signal, 'bash', {
            stdoutToFile: true,
            preventCwdChanges: true,
          });
          await command.result.then(() => {
            fs.unlinkSync(command.taskOutput!.path);
            expect(warn).toHaveBeenCalledWith(
              expect.stringMatching(/\[Shell\] execution failed:.*command not found/),
            );
          }).finally(() => command.cleanup());
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it(
        'returns correct stdout for a simple echo command',
        async () => {
          const ac = new AbortController();
          const cmd = await exec('echo hello', ac.signal);
          const result = await cmd.result;

          expect(result.stdout.trim()).toBe('hello');
          expect(result.code).toBe(0);
          expect(result.interrupted).toBe(false);
          cmd.cleanup();
        },
        { timeout: 5000 },
      );

      it(
        'updates CWD after cd command',
        async () => {
          const ac = new AbortController();
          const cmd = await exec('cd /tmp && pwd', ac.signal);
          const result = await cmd.result;

          expect(result.code).toBe(0);
          // /tmp may resolve to /private/tmp on macOS
          const cwd = getCwd();
          expect(cwd).toMatch(/\/tmp$/);
          cmd.cleanup();
        },
        { timeout: 5000 },
      );

      it.skipIf(!process.env['CLI_TEST_PWSH_EXE'])(
        'cleans PowerShell temporary directories when spawn preparation fails',
        async () => {
          const {
            _setPowerShellRuntimeForTest,
            _resetPowerShellRuntimeForTest,
          } = await import('./shell/powerShell.js');
          _setPowerShellRuntimeForTest({
            executable: process.env['CLI_TEST_PWSH_EXE']!,
            edition: 'core',
          });
          const remove = vi.spyOn(fs, 'rmSync');
          try {
            await expect(
              exec(
                'Write-Output hello',
                new AbortController().signal,
                'powershell',
                {
                  transformSpawn: async () => {
                    throw new Error('preparation failed');
                  },
                },
              ),
            ).rejects.toThrow('preparation failed');
            const directories = remove.mock.calls
              .map(([target]) => String(target))
              .filter((target) =>
                path.basename(target).startsWith(`${BRAND_TEMP_PATH_SLUG}-powershell-`),
              );
            expect(directories).toHaveLength(1);
            expect(fs.existsSync(directories[0])).toBe(false);
          } finally {
            _resetPowerShellRuntimeForTest();
          }
        },
      );

      for (const shellType of ['bash', 'powershell'] as const) {
        it
          .skipIf(
            shellType === 'powershell' && !process.env['CLI_TEST_PWSH_EXE'],
          )
          .each([false, true])(
          `${shellType} preserves interpreter-specific CWD cleanup with directory updates suppressed (background: %s)`,
          async (background) => {
            const {
              _setPowerShellRuntimeForTest,
              _resetPowerShellRuntimeForTest,
            } = await import('./shell/powerShell.js');
            if (shellType === 'powershell')
              _setPowerShellRuntimeForTest({
                executable: process.env['CLI_TEST_PWSH_EXE']!,
                edition: 'core',
              });
            const removeDirectory = vi.spyOn(fs, 'rmSync');
            const cleanup = vi.fn();
            const initialCwd = getCwd();
            const cmd = await exec(
              shellType === 'bash'
                ? 'sleep 0.1; cd /tmp; pwd'
                : 'Start-Sleep -Milliseconds 100; Set-Location /tmp; Get-Location',
              new AbortController().signal,
              shellType,
              {
                preventCwdChanges: true,
                transformSpawn: async (params) => ({ ...params, cleanup }),
              },
            );
            try {
              if (background) expect(cmd.background('test-cleanup')).toBe(true);
              expect(cleanup).not.toHaveBeenCalled();
              const result = await cmd.result;
              expect(result.code).toBe(0);
              expect(getCwd()).toBe(initialCwd);
              expect(cleanup).toHaveBeenCalledOnce();
              const cwdFiles = removeDirectory.mock.calls
                .map(([file]) => String(file))
                .filter((file) =>
                  path.basename(file).startsWith(`${BRAND_TEMP_PATH_SLUG}-powershell-`),
                );
              expect(cwdFiles).toHaveLength(shellType === 'powershell' ? 1 : 0);
              if (shellType === 'powershell')
                expect(fs.existsSync(cwdFiles[0])).toBe(false);
            } finally {
              await cmd.kill();
              cmd.cleanup();
              _resetPowerShellRuntimeForTest();
            }
          },
        );
      }

      it(
        'returns interrupted=true when aborted before exec',
        async () => {
          const ac = new AbortController();
          ac.abort();

          const cmd = await exec('echo should not run', ac.signal);
          const result = await cmd.result;

          expect(result.interrupted).toBe(true);
          expect(result.stdout).toBe('');
          cmd.cleanup();
        },
        { timeout: 5000 },
      );

      it(
        'handles multi-line output',
        async () => {
          const ac = new AbortController();
          const cmd = await exec('printf "line1\\nline2\\nline3"', ac.signal);
          const result = await cmd.result;

          expect(result.code).toBe(0);
          expect(result.stdout).toBe('line1\nline2\nline3');
          cmd.cleanup();
        },
        { timeout: 5000 },
      );

      it(
        'reports non-zero exit code for failing commands',
        async () => {
          const ac = new AbortController();
          const cmd = await exec('exit 42', ac.signal);
          const result = await cmd.result;

          expect(result.code).toBe(42);
          expect(result.interrupted).toBe(false);
          cmd.cleanup();
        },
        { timeout: 5000 },
      );

      it(
        'preserves output and CWD tracking through a shell prefix',
        async () => {
          vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
          const ac = new AbortController();
          const cmd = await exec(
            'printf stdout; printf stderr >&2; cd /tmp',
            ac.signal,
          );
          const result = await cmd.result;

          expect(result.stdout).toBe('stdout');
          expect(result.stderr).toBe('stderr');
          expect(result.code).toBe(0);
          expect(getCwd()).toMatch(/\/tmp$/);
          cmd.cleanup();
        },
        { timeout: 5000 },
      );

      it(
        'does not spawn the command when file output preparation fails',
        async () => {
          const tempRoot = await mkdtemp(
            path.join(os.tmpdir(), 'shell-output-preflight-'),
          );
          const blockerPath = path.join(tempRoot, 'blocker');
          const commandMarker = path.join(tempRoot, 'command-ran');
          await writeFile(blockerPath, 'not a directory');
          setTaskOutputDir(path.join(blockerPath, 'tasks'));
          const warnSpy = vi
            .spyOn(runLogger, 'warn')
            .mockImplementation(() => {});

          try {
            const ac = new AbortController();
            const cmd = await exec(
              `touch ${JSON.stringify(commandMarker)}`,
              ac.signal,
              undefined,
              { stdoutToFile: true },
            );
            const result = await cmd.result;

            expect(result.code).toBe(1);
            expect(result.preSpawnError).toContain(
              'Failed to prepare shell output',
            );
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('');
            expect(result.preSpawnError).not.toContain(
              'bash output unavailable',
            );
            expect(cmd.taskOutput).toBeUndefined();
            await expect(access(commandMarker)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            expect(warnSpy).toHaveBeenCalledWith(
              expect.stringContaining('output preparation failed'),
            );
            cmd.cleanup();
          } finally {
            await rm(tempRoot, { recursive: true, force: true });
          }
        },
        { timeout: 5000 },
      );

      it.skipIf(!process.env['CLI_TEST_PWSH_EXE']).each([false, true])(
        'does not spawn when cancelled during preparation (file output: %s)',
        async (stdoutToFile) => {
          const {
            _setPowerShellRuntimeForTest,
            _resetPowerShellRuntimeForTest,
          } = await import('./shell/powerShell.js');
          _setPowerShellRuntimeForTest({
            executable: process.env['CLI_TEST_PWSH_EXE']!,
            edition: 'core',
          });
          const directory = await mkdtemp(
            path.join(os.tmpdir(), 'shell-preparation-abort-'),
          );
          const marker = path.join(directory, 'must-not-exist');
          setTaskOutputDir(path.join(directory, 'tasks'));
          const controller = new AbortController();
          const cleanup = vi.fn();
          try {
            const cmd = await exec(
              `New-Item -ItemType File '${marker}'`,
              controller.signal,
              'powershell',
              {
                stdoutToFile,
                transformSpawn: async (params) => {
                  controller.abort();
                  return { ...params, cleanup };
                },
              },
            );
            const result = await cmd.result;
            expect(cmd.pid).toBeUndefined();
            expect(result.interrupted).toBe(true);
            expect(fs.existsSync(marker)).toBe(false);
            expect(cleanup).toHaveBeenCalledOnce();
            if (fs.existsSync(path.join(directory, 'tasks')))
              expect(
                await fs.promises.readdir(path.join(directory, 'tasks')),
              ).toEqual([]);
            cmd.cleanup();
          } finally {
            _resetPowerShellRuntimeForTest();
            await rm(directory, { recursive: true, force: true });
          }
        },
      );

      it(
        'assembles the prefix before applying a spawn transform',
        async () => {
          vi.stubEnv(ENV_SHELL_PREFIX, '/bin/bash -c');
          const ac = new AbortController();
          let transformedArgs: string[] | undefined;
          const cmd = await exec('printf transformed', ac.signal, undefined, {
            transformSpawn: async (params) => {
              transformedArgs = params.args;
              return params;
            },
          });
          const result = await cmd.result;

          expect(result.stdout).toBe('transformed');
          expect(transformedArgs?.at(-1)).toMatch(/^\/bin\/bash -c /);
          cmd.cleanup();
        },
        { timeout: 5000 },
      );

      it(
        'closes the output fd when spawn throws synchronously',
        async () => {
          const tempRoot = await mkdtemp(
            path.join(os.tmpdir(), 'shell-spawn-failure-'),
          );
          setTaskOutputDir(path.join(tempRoot, 'tasks'));
          const openSpy = vi.mocked(fs.openSync);
          openSpy.mockClear();
          let outputFd: number | undefined;

          try {
            await expect(
              exec('echo hello', new AbortController().signal, undefined, {
                stdoutToFile: true,
                transformSpawn: async (params) => ({
                  ...params,
                  args: ['\0'],
                }),
              }),
            ).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });

            const outputOpenIndex = openSpy.mock.calls.findIndex(([file]) =>
              String(file).startsWith(tempRoot),
            );
            expect(outputOpenIndex).toBeGreaterThanOrEqual(0);
            outputFd = openSpy.mock.results[outputOpenIndex].value;
            expect(outputFd).toEqual(expect.any(Number));
            expect(() => fs.fstatSync(outputFd!)).toThrow(
              expect.objectContaining({ code: 'EBADF' }),
            );
          } finally {
            // Also release the descriptor if the regression assertion fails.
            if (outputFd !== undefined) {
              try {
                fs.closeSync(outputFd);
              } catch {
                // Expected when exec has already closed it.
              }
            }
            await rm(tempRoot, { recursive: true, force: true });
          }
        },
        { timeout: 5000 },
      );

      it(
        'keeps normal file output mode working',
        async () => {
          const tempRoot = await mkdtemp(
            path.join(os.tmpdir(), 'shell-file-output-'),
          );
          setTaskOutputDir(path.join(tempRoot, 'tasks'));

          try {
            const ac = new AbortController();
            const cmd = await exec('echo hello', ac.signal, undefined, {
              stdoutToFile: true,
            });
            const result = await cmd.result;
            const stdout = await cmd.taskOutput?.getStdout();

            expect(result.code).toBe(0);
            expect(cmd.taskOutput?.stdoutToFile).toBe(true);
            expect(stdout?.trim()).toBe('hello');
            expect(cmd.taskOutput?.outputFileRedundant).toBe(true);
            cmd.cleanup();
          } finally {
            await rm(tempRoot, { recursive: true, force: true });
          }
        },
        { timeout: 5000 },
      );
    });

    describe.skipIf(isWindows)('findSuitableShell', () => {
      it(
        'returns a valid shell path',
        async () => {
          const shellPath = await findSuitableShell();
          expect(shellPath).toBeTruthy();
          expect(shellPath.startsWith('/')).toBe(true);
        },
        { timeout: 5000 },
      );
    });

    describe.skipIf(isWindows)('findSuitableShell - shell selection', () => {
      let originalShell: string | undefined;

      beforeEach(() => {
        originalShell = process.env['SHELL'];
        resetForTest();
      });

      afterEach(() => {
        if (originalShell === undefined) {
          delete process.env['SHELL'];
        } else {
          process.env['SHELL'] = originalShell;
        }
        resetForTest();
      });

      it('ignores fish from SHELL and falls back to a supported shell', async () => {
        process.env['SHELL'] = '/opt/homebrew/bin/fish';
        const result = await findSuitableShell();
        expect(result).not.toContain('fish');
        const basename = result.split('/').pop()!;
        expect(['bash', 'zsh', 'sh']).toContain(basename);
      });

      it('ignores unsupported SHELL values like nu', async () => {
        process.env['SHELL'] = '/usr/local/bin/nu';
        const result = await findSuitableShell();
        expect(result).not.toContain('nu');
        const basename = result.split('/').pop()!;
        expect(['bash', 'zsh', 'sh']).toContain(basename);
      });

      it('uses zsh from SHELL when it is executable', async () => {
        process.env['SHELL'] = '/bin/zsh';
        const result = await findSuitableShell();
        // On systems where /bin/zsh exists, it should be selected
        if (result === '/bin/zsh') {
          expect(result).toBe('/bin/zsh');
        } else {
          // If /bin/zsh is not executable on this system, just verify
          // the result is still a supported shell
          expect(result).toMatch(/\/(bash|zsh|sh)$/);
        }
      });

      it('uses bash from SHELL when it is executable', async () => {
        process.env['SHELL'] = '/bin/bash';
        const result = await findSuitableShell();
        if (result === '/bin/bash') {
          expect(result).toBe('/bin/bash');
        } else {
          expect(result).toMatch(/\/(bash|zsh|sh)$/);
        }
      });

      it('prefers bash candidates when SHELL is bash', async () => {
        process.env['SHELL'] = '/bin/bash';
        const bashAvailable = await access('/bin/bash', constants.X_OK)
          .then(() => true)
          .catch(() => false);
        const result = await findSuitableShell();
        if (bashAvailable) {
          expect(result).toBe('/bin/bash');
        } else {
          // bash not available, accept any supported shell fallback
          expect(result).toMatch(/\/(bash|zsh|sh)$/);
        }
      });

      it('prefers zsh candidates when SHELL is zsh', async () => {
        process.env['SHELL'] = '/bin/zsh';
        const zshAvailable = await access('/bin/zsh', constants.X_OK)
          .then(() => true)
          .catch(() => false);
        const result = await findSuitableShell();
        if (zshAvailable) {
          expect(result).toBe('/bin/zsh');
        } else {
          // zsh not available, accept any supported shell fallback
          expect(result).toMatch(/\/(bash|zsh|sh)$/);
        }
      });
    });

    describe('setCwd / getCwd / resetForTest', () => {
      it('getCwd returns process.cwd() after resetForTest', () => {
        expect(getCwd()).toBe(process.cwd());
      });

      it('setCwd updates the current working directory', () => {
        setCwd('/tmp');
        const cwd = getCwd();
        // /tmp may resolve to /private/tmp on macOS
        expect(cwd).toMatch(/\/tmp$/);
      });

      it('setCwdAndNotify updates the cwd before notifying observers', () => {
        const observer = vi.fn((_oldCwd: string, newCwd: string) => {
          expect(getCwd()).toBe(newCwd);
        });
        const oldCwd = getCwd();
        setCwdChangedCallback(observer);

        setCwdAndNotify('/tmp');

        expect(getCwd()).toMatch(/\/tmp$/);
        expect(observer).toHaveBeenCalledWith(oldCwd, getCwd());
      });

      it('setCwdAndNotify preserves the cwd when an observer throws', () => {
        setCwdChangedCallback(() => {
          throw new Error('observer failed');
        });

        expect(() => setCwdAndNotify('/tmp')).not.toThrow();
        expect(getCwd()).toMatch(/\/tmp$/);
      });

      it('setCwdAndNotify skips observers when the resolved cwd is unchanged', () => {
        const observer = vi.fn();
        setCwdChangedCallback(observer);

        setCwdAndNotify(getCwd());

        expect(observer).not.toHaveBeenCalled();
      });

      it('resetForTest restores CWD to a custom path', () => {
        setCwd('/tmp');
        resetForTest('/usr');
        expect(getCwd()).toBe('/usr');
      });

      it('resetForTest without arguments restores to process.cwd()', () => {
        setCwd('/tmp');
        resetForTest();
        expect(getCwd()).toBe(process.cwd());
      });

      it.skipIf(isWindows)(
        'recovers an implicit missing CWD to the original directory',
        async () => {
          const fakePath = '/this/path/does/not/exist/ever';
          setCwd(fakePath);
          expect(getCwd()).toBe(fakePath);

          const ac = new AbortController();
          const cmd = await exec('echo hello', ac.signal);
          await cmd.result;
          cmd.cleanup();

          // After exec falls back to originalCwd, getCwd() must no longer
          // be the dead path so subsequent commands don't keep hitting
          // the fallback branch.
          expect(getCwd()).not.toBe(fakePath);
        },
        { timeout: 5000 },
      );

      it.skipIf(isWindows)(
        'fails an explicit invalid CWD instead of executing from originalCwd',
        async () => {
          const original = getCwd();
          const missing = path.join(
            os.tmpdir(),
            `test-missing-cwd-${Date.now()}`,
          );
          const ac = new AbortController();
          const cmd = await exec('echo should-not-run', ac.signal, undefined, {
            cwd: missing,
          });
          const result = await cmd.result;
          cmd.cleanup();

          expect(result.code).not.toBe(0);
          expect(result.stdout).toBe('');
          expect(result.preSpawnError).toContain(missing);
          expect(getCwd()).toBe(original);
        },
        { timeout: 5000 },
      );
    });
  },
  { timeout: 10000 },
);

describe('runWithCwdOverride', () => {
  it('keeps a scoped child config in its ACP parent shell context', () => {
    const session = {};
    const child = Object.create(session) as object;
    initializeShellSession(session, '/acp-parent');
    runWithShellSession(session, () => {
      runWithCwdOverride('/child-worktree', () => {
        runWithShellSession(child, () => {
          expect(getCwd()).toBe('/child-worktree');
          expect(getOriginalCwd()).toBe('/child-worktree');
        });
      });
    });
    expect(currentCwdForTest()).toBe('/global-start');
  });
  it('binds iterator next, throw and return to a persistent CWD without leaking to its consumer', async () => {
    const context = { cwd: '/session', originalCwd: '/session' };
    const seen: string[] = [];
    async function* generate() {
      try {
        seen.push(getCwd());
        setCwd('/session/changed');
        yield getCwd();
      } catch {
        seen.push(getCwd());
        yield 'caught';
      } finally {
        seen.push(getCwd());
        expect(getOriginalCwd()).toBe('/session');
      }
    }
    const iterator = bindCwdContext(context, generate());
    expect((await iterator.next()).value).toBe('/session/changed');
    expect(getCwd()).toBe('/global-start');
    expect((await iterator.throw(new Error('test'))).value).toBe('caught');
    await iterator.return();
    expect(seen).toEqual(['/session', '/session/changed', '/session/changed']);
    expect(getCwd()).toBe('/global-start');
  });

  it('keeps reset directories local to the session and nested agent', () => {
    runWithCwdOverride('/session', () => {
      setOriginalCwd('/session/reset');
      runWithCwdOverride('/agent', () =>
        expect(getOriginalCwd()).toBe('/agent'),
      );
      expect(getOriginalCwd()).toBe('/session/reset');
    });
    expect(getOriginalCwd()).toBe('/global-start');
  });
  beforeEach(() => {
    resetForTest('/global-start');
  });

  afterEach(() => {
    resetForTest();
  });

  it('getCwd() returns override value inside context', () => {
    let seen: string | undefined;
    runWithCwdOverride('/subagent-cwd', () => {
      seen = getCwd();
    });
    expect(seen).toBe('/subagent-cwd');
  });

  it('getCwd() returns global cwd outside context', () => {
    runWithCwdOverride('/subagent-cwd', () => {});
    expect(getCwd()).toBe('/global-start');
  });

  it('setCwd() inside context updates only that context', () => {
    let seenInside: string | undefined;
    runWithCwdOverride('/subagent-cwd', () => {
      setCwd('/global-start/subdir');
      seenInside = getCwd();
    });
    expect(seenInside).toBe(path.join('/global-start', 'subdir'));
    expect(currentCwdForTest()).toBe('/global-start');
  });

  it('nested contexts keep independent mutable values', () => {
    let outer: string | undefined;
    let outerAfterInner: string | undefined;
    let inner: string | undefined;
    runWithCwdOverride('/outer', () => {
      setCwd('/outer/changed');
      outer = getCwd();
      runWithCwdOverride('/inner', () => {
        setCwd('/inner/changed');
        inner = getCwd();
      });
      outerAfterInner = getCwd();
    });
    expect(outer).toBe('/outer/changed');
    expect(inner).toBe('/inner/changed');
    expect(outerAfterInner).toBe('/outer/changed');
    expect(getCwd()).toBe('/global-start');
  });
});
