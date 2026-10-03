/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, FatalSandboxError } from '@qwen-code/qwen-code-core';

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock, execSync: execSyncMock },
    spawn: spawnMock,
    execSync: execSyncMock,
  };
});

import { start_sandbox } from './sandbox.js';

interface Mount {
  source: string;
  destination: string;
  readOnly: boolean;
}

function volumes(args: string[]): Mount[] {
  return args
    .filter((_, index) => args[index - 1] === '--volume')
    .map((spec) => {
      const [source, destination, mode] = spec.split(':');
      return {
        source,
        destination: path.posix.resolve('/', destination),
        readOnly: mode?.split(',').includes('ro') ?? false,
      };
    });
}

function unprotectedAliases(mounts: Mount[], managedRoot: string) {
  return mounts.flatMap((mount) => {
    if (mount.readOnly) return [];
    const relative = path.relative(
      fs.realpathSync.native(mount.source),
      managedRoot,
    );
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return [];
    const alias = path.join(mount.destination, relative);
    const protectedChild = mounts.some(
      (candidate) =>
        candidate.readOnly &&
        candidate.source === managedRoot &&
        candidate.destination === alias,
    );
    return protectedChild
      ? []
      : [{ source: mount.source, destination: mount.destination, alias }];
  });
}

describe.skipIf(process.platform === 'win32')(
  'managed container mount boundaries',
  () => {
    let root: string;
    let workspace: string;
    let qwenHome: string;

    beforeEach(() => {
      root = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-r25-mounts-')),
      );
      workspace = path.join(root, 'workspace');
      qwenHome = path.join(root, 'home', '.qwen');
      for (const directory of [workspace, qwenHome, path.join(root, 'tmp')])
        fs.mkdirSync(directory, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(workspace);
      vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
      vi.spyOn(os, 'tmpdir').mockReturnValue(path.join(root, 'tmp'));
      vi.stubEnv('QWEN_HOME', qwenHome);
      vi.stubEnv('QWEN_RUNTIME_DIR', qwenHome);
      vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
      for (const variable of [
        'SANDBOX_MOUNTS',
        'SANDBOX_FLAGS',
        'BUILD_SANDBOX',
        'QWEN_SANDBOX_PROXY_COMMAND',
        'VIRTUAL_ENV',
        'GOOGLE_APPLICATION_CREDENTIALS',
      ])
        vi.stubEnv(variable, '');
      execSyncMock.mockReturnValue(Buffer.from(''));
      spawnMock.mockReset();
      spawnMock.mockImplementation((_command: string, args: string[]) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
        });
        queueMicrotask(() => {
          if (args[0] !== 'run')
            child.stdout.emit('data', Buffer.from('image-id'));
          child.emit('close', 0);
        });
        return child;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    });

    async function launch(managedRoot?: string) {
      const config = managedRoot
        ? ({ getManagedExtensionsDir: () => managedRoot } as unknown as Config)
        : undefined;
      await expect(
        start_sandbox(
          { command: 'docker', image: 'example.com/qwen-code:test' },
          [],
          config,
          [
            process.execPath,
            '/path/to/cli.js',
            ...(managedRoot ? ['--managed-extensions', managedRoot] : []),
          ],
        ),
      ).resolves.toBe(0);
      const run = spawnMock.mock.calls.find((call) => call[1]?.[0] === 'run');
      expect(run).toBeDefined();
      return volumes(run![1] as string[]);
    }

    async function requireRefusal(managedRoot: string) {
      const config = {
        getManagedExtensionsDir: () => managedRoot,
      } as unknown as Config;
      await expect(
        start_sandbox(
          { command: 'docker', image: 'example.com/qwen-code:test' },
          [],
          config,
          [
            process.execPath,
            '/path/to/cli.js',
            '--managed-extensions',
            managedRoot,
          ],
        ),
      ).rejects.toBeInstanceOf(FatalSandboxError);
      expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === 'run')).toBe(
        false,
      );
    }

    it('does not expose a managed sibling through the writable Qwen settings alias', async () => {
      const managed = path.join(qwenHome, 'prepared');
      fs.mkdirSync(managed);
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: qwenHome,
        destination: '/home/node/.qwen',
        readOnly: false,
      });
      expect(mounts).toContainEqual({
        source: managed,
        destination: '/home/node/.qwen/prepared',
        readOnly: true,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });

    it('does not silently drop read-only protection when the managed root equals the workspace', async () => {
      await requireRefusal(workspace);
    });

    it('does not expose a managed root through an explicit writable ancestor alias', async () => {
      const parent = path.join(root, 'deployment');
      const managed = path.join(parent, 'prepared');
      fs.mkdirSync(managed, { recursive: true });
      vi.stubEnv('SANDBOX_MOUNTS', `${parent}:/deployment-alias:rw`);
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: parent,
        destination: '/deployment-alias',
        readOnly: false,
      });
      expect(mounts).toContainEqual({
        source: managed,
        destination: '/deployment-alias/prepared',
        readOnly: true,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });

    it('protects managed content exposed through the virtual environment mount alias', async () => {
      const managed = path.join(workspace, '.qwen', 'sandbox.venv', 'prepared');
      fs.mkdirSync(managed, { recursive: true });
      vi.stubEnv('VIRTUAL_ENV', path.join(workspace, '.venv'));
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: managed,
        destination: path.join(workspace, '.venv', 'prepared'),
        readOnly: true,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });

    it('keeps settings and workspace mounts writable without managed extensions', async () => {
      const mounts = await launch();
      expect(mounts).toContainEqual({
        source: workspace,
        destination: workspace,
        readOnly: false,
      });
      expect(mounts).toContainEqual({
        source: qwenHome,
        destination: '/home/node/.qwen',
        readOnly: false,
      });
    });

    it('keeps a non-overlapping managed root read-only while settings stay writable', async () => {
      const managed = path.join(root, 'managed');
      fs.mkdirSync(managed);
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: managed,
        destination: managed,
        readOnly: true,
      });
      expect(mounts).toContainEqual({
        source: qwenHome,
        destination: '/home/node/.qwen',
        readOnly: false,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });

    it('allows a canonical writable workspace ancestor covered by a read-only managed child', async () => {
      const managed = path.join(workspace, 'prepared');
      fs.mkdirSync(managed);
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: workspace,
        destination: workspace,
        readOnly: false,
      });
      expect(mounts).toContainEqual({
        source: managed,
        destination: managed,
        readOnly: true,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });

    it('allows an explicitly read-only ancestor alias', async () => {
      const parent = path.join(root, 'deployment');
      const managed = path.join(parent, 'prepared');
      fs.mkdirSync(managed, { recursive: true });
      vi.stubEnv('SANDBOX_MOUNTS', `${parent}:/deployment-alias:ro`);
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: parent,
        destination: '/deployment-alias',
        readOnly: true,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });

    it('refuses a writable mount sourced from inside the managed root', async () => {
      const managed = path.join(root, 'managed');
      const nested = path.join(managed, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      vi.stubEnv('SANDBOX_MOUNTS', `${nested}:/nested-alias:rw`);
      await requireRefusal(managed);
    });

    it.each(['', '/'])(
      'reuses an existing identical read-only mount with destination suffix %s',
      async (suffix) => {
        const managed = path.join(root, 'managed');
        fs.mkdirSync(managed);
        vi.stubEnv('SANDBOX_MOUNTS', `${managed}:${managed}${suffix}:ro`);
        const mounts = await launch(managed);
        expect(
          mounts.filter(
            (mount) => path.posix.resolve('/', mount.destination) === managed,
          ),
        ).toEqual([{ source: managed, destination: managed, readOnly: true }]);
      },
    );

    it.each(['', '/'])(
      'refuses an unrelated read-only source at the managed destination with suffix %s',
      async (suffix) => {
        const managed = path.join(root, 'managed');
        const other = path.join(root, 'other');
        fs.mkdirSync(managed);
        fs.mkdirSync(other);
        vi.stubEnv('SANDBOX_MOUNTS', `${other}:${managed}${suffix}:ro`);
        await requireRefusal(managed);
      },
    );

    it('protects the canonical relative child through a symlinked ancestor source', async () => {
      const parent = path.join(root, 'deployment');
      const managed = path.join(parent, 'prepared');
      const alias = path.join(root, 'host-alias');
      fs.mkdirSync(managed, { recursive: true });
      fs.symlinkSync(parent, alias, 'dir');
      vi.stubEnv('SANDBOX_MOUNTS', `${alias}:/deployment-alias:rw`);
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: managed,
        destination: '/deployment-alias/prepared',
        readOnly: true,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });

    it('protects a writable ancestor source reached through a filesystem case alias', async (context) => {
      const parent = path.join(root, 'Deployment');
      const alias = path.join(root, 'deployment');
      const managed = path.join(parent, 'prepared');
      fs.mkdirSync(managed, { recursive: true });
      if (!fs.existsSync(alias)) {
        context.skip();
        return;
      }
      expect(fs.statSync(parent).ino).toBe(fs.statSync(alias).ino);
      vi.stubEnv('SANDBOX_MOUNTS', `${alias}:/case-alias:rw`);
      const mounts = await launch(fs.realpathSync.native(managed));
      expect(mounts).toContainEqual({
        source: fs.realpathSync.native(managed),
        destination: '/case-alias/prepared',
        readOnly: true,
      });
      expect(
        unprotectedAliases(mounts, fs.realpathSync.native(managed)),
      ).toEqual([]);
    });

    it('does not confuse a sibling path prefix with an ancestor', async () => {
      const managed = path.join(root, 'deployment');
      const sibling = path.join(root, 'deployment-other');
      fs.mkdirSync(managed);
      fs.mkdirSync(sibling);
      vi.stubEnv('SANDBOX_MOUNTS', `${sibling}:/deployment-alias:rw`);
      const mounts = await launch(managed);
      expect(mounts).toContainEqual({
        source: sibling,
        destination: '/deployment-alias',
        readOnly: false,
      });
      expect(unprotectedAliases(mounts, managed)).toEqual([]);
    });
  },
);
