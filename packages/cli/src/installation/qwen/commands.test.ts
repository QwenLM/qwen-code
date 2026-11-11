/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { qwenInstallationCommands } from './commands.js';
import type { createManualUpdateProgress } from '../manualUpdateProgress.js';

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  install: vi.fn(),
  check: vi.fn(),
  update: vi.fn(),
  rollback: vi.fn(),
  resolveExecutable: vi.fn(),
  linkPath: '',
  stdout: vi.fn(),
  stderr: vi.fn(),
  exit: vi.fn(),
}));
vi.mock('@qwen-code/core', () => ({
  writeToStdout: mocks.stdout,
  writeToStderr: mocks.stderr,
  resolveExecutable: mocks.resolveExecutable,
}));
vi.mock('./operations.js', () => ({
  createQwenInstallation: () => ({
    configurePath: mocks.configure,
    install: mocks.install,
    check: mocks.check,
    update: mocks.update,
    rollback: mocks.rollback,
  }),
}));
vi.mock('./paths.js', () => ({
  getQwenPaths: () => ({ linkPath: mocks.linkPath }),
}));
vi.mock('../../utils/exitCli.js', () => ({ exitCli: mocks.exit }));
afterEach(() => vi.clearAllMocks());

it('prints manual update stages before the operation returns', async () => {
  mocks.update.mockImplementationOnce(
    async (progress: ReturnType<typeof createManualUpdateProgress>) => {
      expect(mocks.stdout).toHaveBeenLastCalledWith('Checking for updates...\n');
      progress.onUpdateAvailable('1.0.0', '1.0.1');
      progress.onNativeEvent({ stage: 'download', phase: 'start' });
      expect(mocks.stdout.mock.calls.flat()).toEqual([
        'Checking for updates...\n',
        'Update available: 1.0.0 -> 1.0.1\n',
        'Downloading update...\n',
      ]);
      progress.onNativeEvent({ stage: 'download', phase: 'success' });
      progress.onNativeEvent({ stage: 'install', phase: 'start' });
      progress.onNativeEvent({ stage: 'link', phase: 'start' });
      return { version: '1.0.1', changed: true };
    },
  );
  const command = qwenInstallationCommands().find(
    (item) => item.command.name() === 'update',
  )!.command;
  await command.parseAsync([], { from: 'user' });
  expect(mocks.stdout.mock.calls.flat().slice(3)).toEqual([
    'Installing update...\n',
    'Activating update...\n',
    'Updated Qwen Code to 1.0.1. The next run uses this version.\n',
  ]);
  expect(mocks.exit).toHaveBeenCalledWith(0);
});

it('checks for a new version without starting a manual update', async () => {
  mocks.check.mockResolvedValueOnce({
    current: '1.0.0',
    latest: '1.0.1',
    available: true,
  });
  const command = qwenInstallationCommands().find(
    (item) => item.command.name() === 'update',
  )!.command;
  await command.parseAsync(['--check'], { from: 'user' });
  expect(mocks.stdout.mock.calls.flat()).toEqual([
    'Checking for updates...\n',
    'Qwen Code update available: 1.0.0 → 1.0.1\n',
  ]);
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.exit).toHaveBeenCalledWith(0);
});

it('passes an omitted rollback target to the native installation', async () => {
  mocks.rollback.mockResolvedValueOnce({ version: '1.0.0' });
  const command = qwenInstallationCommands().find(
    (item) => item.command.name() === 'rollback',
  )!.command;
  await command.parseAsync([], { from: 'user' });
  expect(mocks.rollback).toHaveBeenCalledWith(undefined);
  expect(mocks.exit).toHaveBeenCalledWith(0);
});

it.each([
  'available',
  'missing',
  'configured',
  'already configured',
  'shadowed',
  'quiet',
] as const)(
  'gives useful install guidance when the managed command is %s',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-install-command-'));
    try {
      mocks.linkPath = join(directory, 'qwen');
      const otherExecutable = join(directory, 'other-qwen');
      await writeFile(mocks.linkPath, '');
      await writeFile(otherExecutable, '');
      mocks.install.mockResolvedValue({
        version: '1.0.1',
        pathResult:
          mode === 'configured'
            ? { modified: true, configFile: join(homedir(), '.zshrc') }
            : mode === 'already configured'
              ? { modified: false, skipReason: 'rc_file_configured' }
              : undefined,
      });
      mocks.resolveExecutable.mockResolvedValue(
        mode === 'available'
          ? mocks.linkPath
          : mode === 'shadowed'
            ? otherExecutable
            : undefined,
      );
      const command = qwenInstallationCommands().find(
        (item) => item.command.name() === 'install',
      )!.command;
      await command.parseAsync(mode === 'quiet' ? ['--quiet'] : [], {
        from: 'user',
      });
      if (mode === 'quiet') {
        expect(mocks.stdout).not.toHaveBeenCalled();
        expect(mocks.resolveExecutable).not.toHaveBeenCalled();
      } else {
        const output = mocks.stdout.mock.calls[0][0] as string;
        expect(output).toContain('Qwen Code 1.0.1 installed.');
        expect(output).toContain(
          mode === 'shadowed' || mode === 'missing'
            ? `'${mocks.linkPath}'`
            : '  qwen --help',
        );
        expect(output.includes('Open a new terminal')).toBe(
          mode === 'configured' || mode === 'already configured',
        );
        expect(output.includes('Added Qwen to PATH in ~/.zshrc.')).toBe(
          mode === 'configured',
        );
      }
      expect(mocks.exit).toHaveBeenCalledWith(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  [
    { modified: true, method: 'registry' },
    'Configured Qwen in the user PATH. Restart your shell.',
  ],
  [
    { modified: true, method: 'rc_append', configFile: '/home/test/.bashrc' },
    'Configured PATH in /home/test/.bashrc. Restart your shell.',
  ],
  [{ modified: false }, 'Qwen PATH is already configured.'],
])('reports the actual PATH configuration method', async (result, message) => {
  mocks.configure.mockResolvedValueOnce(result);
  const command = qwenInstallationCommands().find(
    (item) => item.command.name() === 'configure-path',
  )!.command;
  await command.parseAsync([], { from: 'user' });
  expect(mocks.stdout).toHaveBeenCalledWith(message + '\n');
  expect(mocks.exit).toHaveBeenCalledWith(0);
});
