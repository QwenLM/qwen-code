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
const execMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      spawn: spawnMock,
      execSync: execSyncMock,
      exec: execMock,
    },
    spawn: spawnMock,
    execSync: execSyncMock,
    exec: execMock,
  };
});

import {
  BUILTIN_SEATBELT_PROFILES,
  resolveSeatbeltProfileFile,
  start_sandbox,
} from './sandbox.js';

interface Mount {
  source: string;
  destination: string;
  readOnly: boolean;
}

function volumes(args: string[]): Mount[] {
  return args.flatMap((spec, index) => {
    if (args[index - 1] === '--mount') {
      const fields = (spec.match(/"(?:[^"]|"")*"|[^,]+/g) ?? []).map((field) =>
        field.startsWith('"')
          ? field.slice(1, -1).replaceAll('""', '"')
          : field,
      );
      return [
        {
          source: fields.find((field) => field.startsWith('source='))!.slice(7),
          destination: fields
            .find((field) => field.startsWith('target='))!
            .slice(7),
          readOnly: fields.includes('readonly'),
        },
      ];
    }
    if (args[index - 1] !== '--volume') return [];
    const [source, destination, mode] = spec.split(':');
    return [
      {
        source,
        destination: path.posix.resolve('/', destination),
        readOnly: mode?.split(',').includes('ro') ?? false,
      },
    ];
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
      vi.stubEnv('HOME', path.join(root, 'home'));
      vi.stubEnv('QWEN_HOME', qwenHome);
      vi.stubEnv('QWEN_RUNTIME_DIR', qwenHome);
      vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
      for (const variable of [
        'QWEN_SANDBOX',
        'SANDBOX',
        'SANDBOX_ENV',
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

    async function launch(
      managedRoot?: string,
      command: 'docker' | 'podman' = 'docker',
    ) {
      const config = managedRoot
        ? ({ getManagedExtensionsDir: () => managedRoot } as unknown as Config)
        : undefined;
      await expect(
        start_sandbox(
          { command, image: 'example.com/qwen-code:test' },
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

    function runArgs(): string[] {
      return spawnMock.mock.calls.find((call) => call[1]?.[0] === 'run')![1];
    }

    function requireSourceWithoutCreation(managedRoot: string) {
      const args = runArgs();
      const unsafe = args.filter(
        (spec, index) =>
          args[index - 1] === '--volume' && spec.startsWith(`${managedRoot}:`),
      );
      expect(unsafe).toEqual([]);
      const mounts = args.filter((_, index) => args[index - 1] === '--mount');
      expect(mounts).toContain(
        `type=bind,"source=${managedRoot.replaceAll('"', '""')}","target=${managedRoot.replaceAll('"', '""')}",readonly`,
      );
      expect(mounts.some((spec) => spec.includes('bind-create-src'))).toBe(
        false,
      );
    }

    it('requires a missing pinned managed source instead of using an auto-creating Docker volume', async () => {
      const managed = path.join(root, 'managed');
      fs.mkdirSync(managed);
      const pinned = fs.realpathSync.native(managed);
      fs.rmdirSync(managed);
      await launch(pinned);
      requireSourceWithoutCreation(pinned);
      expect(fs.existsSync(pinned)).toBe(false);
    });

    it.each([false, true])(
      'requires a source removed at the process boundary, including an existing readonly volume: %s',
      async (existing) => {
        const managed = path.join(root, 'managed');
        fs.mkdirSync(managed);
        fs.writeFileSync(path.join(managed, 'sentinel'), 'deployment content');
        if (existing) vi.stubEnv('SANDBOX_MOUNTS', `${managed}:${managed}:ro`);
        const transport = spawnMock.getMockImplementation()!;
        spawnMock.mockImplementation((command: string, args: string[]) => {
          if (args[0] === 'run') fs.rmSync(managed, { recursive: true });
          return transport(command, args);
        });
        await launch(managed);
        requireSourceWithoutCreation(managed);
        expect(fs.existsSync(managed)).toBe(false);
        expect(runArgs()).toContain(`${workspace}:${workspace}`);
      },
    );

    it('converts a same-root readonly volume at a separate alias', async () => {
      const managed = path.join(root, 'managed');
      fs.mkdirSync(managed);
      vi.stubEnv('SANDBOX_MOUNTS', `${managed}:/readonly-alias:ro`);
      await launch(managed);
      requireSourceWithoutCreation(managed);
      expect(runArgs()).toContain(
        `type=bind,"source=${managed}","target=/readonly-alias",readonly`,
      );
    });

    it('requires the source of an existing managed readonly subtree', async () => {
      const managed = path.join(root, 'managed');
      const pkg = path.join(managed, 'pkg');
      fs.mkdirSync(pkg, { recursive: true });
      vi.stubEnv('SANDBOX_MOUNTS', `${pkg}:${pkg}:ro`);
      await launch(managed);
      expect(runArgs()).toContain(
        `type=bind,"source=${pkg}","target=${pkg}",readonly`,
      );
      expect(runArgs()).not.toContain(`${pkg}:${pkg}:ro`);
    });

    it.each(['with,comma', 'with"quote', 'with space, and "quote"'])(
      'encodes managed bind CSV fields for %s',
      async (name) => {
        const managed = path.join(root, name);
        fs.mkdirSync(managed);
        const mounts = await launch(managed);
        requireSourceWithoutCreation(managed);
        expect(mounts).toContainEqual({
          source: managed,
          destination: managed,
          readOnly: true,
        });
      },
    );

    it('retains Podman source-required volume syntax without changing ordinary mounts', async () => {
      const managed = path.join(root, 'managed');
      fs.mkdirSync(managed);
      fs.rmdirSync(managed);
      await launch(managed, 'podman');
      expect(runArgs()).toContain(`${managed}:${managed}:ro`);
      expect(runArgs()).not.toContain('--mount');
      expect(runArgs()).toContain(`${workspace}:${workspace}`);
      expect(fs.existsSync(managed)).toBe(false);
    });

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

    it.each(['rw', '', 'ro'])(
      'refuses an unrelated %s mount inside the managed destination',
      async (mode) => {
        const managed = path.join(root, 'managed');
        const other = path.join(root, 'other');
        fs.mkdirSync(path.join(managed, 'pkg'), { recursive: true });
        fs.mkdirSync(other);
        vi.stubEnv('SANDBOX_MOUNTS', `${other}:${managed}/pkg:${mode}`);
        await requireRefusal(managed);
      },
    );

    it.each(['pkg/nested', 'pkg/../pkg', 'pkg/'])(
      'refuses a writable overlay at normalized descendant %s',
      async (relative) => {
        const managed = path.join(root, 'managed');
        const other = path.join(root, 'other');
        fs.mkdirSync(path.join(managed, 'pkg', 'nested'), { recursive: true });
        fs.mkdirSync(other);
        vi.stubEnv('SANDBOX_MOUNTS', `${other}:${managed}/${relative}:rw`);
        await requireRefusal(managed);
      },
    );

    it('refuses a writable descendant of a generated settings alias', async () => {
      const managed = path.join(qwenHome, 'prepared');
      const other = path.join(root, 'other');
      fs.mkdirSync(path.join(managed, 'pkg'), { recursive: true });
      fs.mkdirSync(other);
      vi.stubEnv('SANDBOX_MOUNTS', `${other}:/home/node/.qwen/prepared/pkg:rw`);
      await requireRefusal(managed);
    });

    it('refuses an unrelated readonly descendant of an explicit ancestor alias', async () => {
      const parent = path.join(root, 'deployment');
      const managed = path.join(parent, 'prepared');
      const other = path.join(root, 'other');
      fs.mkdirSync(path.join(managed, 'pkg'), { recursive: true });
      fs.mkdirSync(other);
      vi.stubEnv(
        'SANDBOX_MOUNTS',
        `${parent}:/deployment-alias:rw,${other}:/deployment-alias/prepared/pkg:ro`,
      );
      await requireRefusal(managed);
    });

    it('allows a readonly overlay from the corresponding managed subtree', async () => {
      const managed = path.join(root, 'managed');
      const pkg = path.join(managed, 'pkg');
      fs.mkdirSync(pkg, { recursive: true });
      vi.stubEnv('SANDBOX_MOUNTS', `${pkg}:${pkg}:ro`);
      expect(await launch(managed)).toContainEqual({
        source: pkg,
        destination: pkg,
        readOnly: true,
      });
    });

    it('allows a corresponding readonly subtree through a canonical source alias', async () => {
      const managed = path.join(root, 'managed');
      const pkg = path.join(managed, 'pkg');
      const alias = path.join(root, 'pkg-alias');
      fs.mkdirSync(pkg, { recursive: true });
      fs.symlinkSync(pkg, alias, 'dir');
      vi.stubEnv('SANDBOX_MOUNTS', `${alias}:${pkg}:ro`);
      expect(await launch(managed)).toContainEqual({
        source: alias,
        destination: pkg,
        readOnly: true,
      });
    });

    it('allows a readonly overlay matching a symlinked deployed subtree', async () => {
      const managed = path.join(root, 'managed');
      const deployed = path.join(root, 'deployed-pkg');
      const pkg = path.join(managed, 'pkg');
      fs.mkdirSync(managed);
      fs.mkdirSync(deployed);
      fs.symlinkSync(deployed, pkg, 'dir');
      vi.stubEnv('SANDBOX_MOUNTS', `${deployed}:${pkg}:ro`);
      expect(await launch(managed)).toContainEqual({
        source: deployed,
        destination: pkg,
        readOnly: true,
      });
    });

    it('refuses a readonly overlay when its managed counterpart is missing', async () => {
      const managed = path.join(root, 'managed');
      const other = path.join(root, 'other');
      fs.mkdirSync(managed);
      fs.mkdirSync(other);
      vi.stubEnv('SANDBOX_MOUNTS', `${other}:${managed}/missing:ro`);
      await requireRefusal(managed);
    });

    it('allows a writable destination with only a shared managed prefix', async () => {
      const managed = path.join(root, 'managed');
      const other = path.join(root, 'other');
      const destination = `${managed}-other/pkg`;
      fs.mkdirSync(managed);
      fs.mkdirSync(other);
      fs.mkdirSync(destination, { recursive: true });
      vi.stubEnv('SANDBOX_MOUNTS', `${other}:${destination}:rw`);
      expect(await launch(managed)).toContainEqual({
        source: other,
        destination,
        readOnly: false,
      });
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

describe.skipIf(process.platform === 'win32')(
  'managed Seatbelt startup boundary',
  () => {
    let root: string;
    let workspace: string;
    let qwenHome: string;
    let runtime: string;
    let cache: string;
    const customProfile = 'managed-test';
    const profiles = [...BUILTIN_SEATBELT_PROFILES, customProfile];

    beforeEach(() => {
      root = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-seatbelt-')),
      );
      workspace = path.join(root, 'workspace');
      qwenHome = path.join(root, 'home', '.qwen');
      runtime = path.join(root, 'runtime');
      cache = path.join(root, 'cache');
      for (const directory of [workspace, path.dirname(qwenHome), cache])
        fs.mkdirSync(directory, { recursive: true });
      fs.mkdirSync(path.join(root, 'tmp'));
      vi.spyOn(process, 'cwd').mockReturnValue(workspace);
      vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(qwenHome));
      vi.spyOn(os, 'tmpdir').mockReturnValue(path.join(root, 'tmp'));
      const existsSync = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((file) =>
        existsSync(
          path.isAbsolute(String(file))
            ? file
            : path.resolve(workspace, String(file)),
        ),
      );
      vi.stubEnv('QWEN_HOME', qwenHome);
      vi.stubEnv('QWEN_RUNTIME_DIR', runtime);
      vi.stubEnv('BUILD_SANDBOX', '');
      vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', '');
      vi.stubEnv('SEATBELT_PROFILE', 'permissive-open');
      execSyncMock.mockReset().mockReturnValue(Buffer.from(`${cache}\n`));
      execMock.mockReset().mockImplementation((_command, callback) => {
        callback(null, '', '');
        return new EventEmitter();
      });
      spawnMock.mockReset().mockImplementation((command: string) => {
        const child = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(),
        });
        if (command !== 'bash') queueMicrotask(() => child.emit('close', 0));
        return child;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    });

    async function refuse(managedRoot: string) {
      const mkdir = vi.spyOn(fs, 'mkdirSync');
      const realpath = vi.spyOn(fs, 'realpathSync');
      const exists = vi.mocked(fs.existsSync);
      exists.mockClear();
      const pause = vi.spyOn(process.stdin, 'pause');
      const resume = vi.spyOn(process.stdin, 'resume');
      const wasPaused = process.stdin.isPaused();
      const on = vi.spyOn(process, 'on').mockReturnValue(process);
      const profileBefore = process.env['SEATBELT_PROFILE'];
      const marker = path.join(workspace, 'ordinary.txt');
      fs.writeFileSync(marker, 'preserved');
      const getTargetDir = vi.fn(() => workspace);
      const getWorkspaceContext = vi.fn(() => ({
        getDirectories: () => [workspace],
      }));
      const config = {
        getManagedExtensionsDir: () => managedRoot,
        getTargetDir,
        getWorkspaceContext,
      } as unknown as Config;

      const launch = start_sandbox({ command: 'sandbox-exec' }, [], config, [
        '/bin/true',
      ]);
      await expect(launch).rejects.toThrow(FatalSandboxError);
      await expect(launch).rejects.toThrow(
        /managed.*sandbox-exec|sandbox-exec.*managed/i,
      );
      expect(spawnMock).not.toHaveBeenCalled();
      expect(execMock).not.toHaveBeenCalled();
      expect(execSyncMock).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(getTargetDir).not.toHaveBeenCalled();
      expect(getWorkspaceContext).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(process.stdin.isPaused()).toBe(wasPaused);
      expect(on).not.toHaveBeenCalled();
      expect(process.env['SEATBELT_PROFILE']).toBe(profileBefore);
      expect(fs.readFileSync(marker, 'utf8')).toBe('preserved');
      expect(fs.readdirSync(path.dirname(qwenHome))).toEqual([]);
      expect(fs.readdirSync(root)).not.toContain('runtime');
    }

    it.each(profiles)(
      'refuses configured managed content for %s',
      async (profile) => {
        vi.stubEnv('SEATBELT_PROFILE', profile);
        if (profile === customProfile) {
          fs.mkdirSync(path.join(workspace, '.qwen'));
          fs.writeFileSync(
            path.join(workspace, '.qwen', `sandbox-macos-${customProfile}.sb`),
            '(version 1)\n(allow default)\n',
          );
        }
        const managed = path.join(workspace, 'managed');
        fs.mkdirSync(managed);
        await refuse(managed);
      },
    );

    it('refuses a pinned root that became unavailable', async () => {
      const managed = path.join(root, 'managed');
      fs.mkdirSync(managed);
      const pinned = fs.realpathSync.native(managed);
      fs.rmdirSync(managed);
      await refuse(pinned);
    });

    it('refuses a pinned root after its enclosing path is relinked', async () => {
      const parent = path.join(root, 'deployment');
      const managed = path.join(parent, 'managed');
      const replacement = path.join(root, 'replacement');
      fs.mkdirSync(managed, { recursive: true });
      fs.mkdirSync(path.join(replacement, 'managed'), { recursive: true });
      const pinned = fs.realpathSync.native(managed);
      fs.renameSync(parent, `${parent}-original`);
      fs.symlinkSync(replacement, parent, 'dir');
      await refuse(pinned);
    });

    it.each(['missing', 'malformed'])(
      'refuses managed content before loading a %s custom profile',
      async (state) => {
        vi.stubEnv('SEATBELT_PROFILE', customProfile);
        if (state === 'malformed') {
          fs.mkdirSync(path.join(workspace, '.qwen'));
          fs.writeFileSync(
            path.join(workspace, '.qwen', `sandbox-macos-${customProfile}.sb`),
            'invalid profile',
          );
        }
        await refuse(path.join(root, 'managed'));
      },
    );

    it('refuses before build, proxy, profile-default and bootstrap setup', async () => {
      vi.stubEnv('SEATBELT_PROFILE', undefined);
      vi.stubEnv('BUILD_SANDBOX', '1');
      vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'printf proxy-started');
      await refuse(path.join(root, 'managed'));
    });

    it('refuses before proxy startup or assigning the default profile', async () => {
      vi.stubEnv('SEATBELT_PROFILE', undefined);
      vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'printf proxy-started');
      await refuse(path.join(root, 'managed'));
    });

    it.each(profiles)(
      'keeps ordinary Seatbelt startup for %s',
      async (profile) => {
        vi.stubEnv('SEATBELT_PROFILE', profile);
        if (profile === customProfile) {
          fs.mkdirSync(path.join(workspace, '.qwen'));
          fs.writeFileSync(
            path.join(workspace, '.qwen', `sandbox-macos-${customProfile}.sb`),
            '(version 1)\n(allow default)\n',
          );
        }
        const config = {
          getManagedExtensionsDir: () => undefined,
          getTargetDir: () => workspace,
          getWorkspaceContext: () => ({ getDirectories: () => [workspace] }),
        } as unknown as Config;
        await expect(
          start_sandbox({ command: 'sandbox-exec' }, [], config, ['/bin/true']),
        ).resolves.toBe(0);
        expect(spawnMock).toHaveBeenCalledOnce();
        const [command, args] = spawnMock.mock.calls[0];
        expect(command).toBe('sandbox-exec');
        expect(args).toContain(`QWEN_DIR=${qwenHome}`);
        expect(args).toContain(`RUNTIME_DIR=${runtime}`);
        expect(args).toContain(`TARGET_DIR=${workspace}`);
        expect(args).toContain(`CACHE_DIR=${cache}`);
        expect(args[args.indexOf('-f') + 1]).toBe(
          resolveSeatbeltProfileFile(profile),
        );
        expect(fs.statSync(qwenHome).isDirectory()).toBe(true);
        expect(fs.statSync(runtime).isDirectory()).toBe(true);
      },
    );
  },
);
