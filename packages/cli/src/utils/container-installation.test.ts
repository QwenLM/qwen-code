/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerTrustedDirectories } from './container-installation.js';

const { lookupPaths } = vi.hoisted(() => ({ lookupPaths: vi.fn() }));
vi.mock('node:module', () => ({
  createRequire: (entry: string) => ({
    resolve: { paths: () => lookupPaths(entry) },
  }),
}));

describe.skipIf(process.platform === 'win32')(
  'container CLI installation',
  () => {
    let root: string;
    let bundle: string;
    let dependencies: string;
    let signal: AbortSignal;

    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'container-installation-')),
      );
      bundle = join(root, 'dist');
      dependencies = join(root, 'node_modules');
      await mkdir(bundle);
      await mkdir(dependencies);
      await writeFile(join(bundle, 'cli.js'), '');
      await writeFile(join(bundle, 'execution-worker.js'), '');
      lookupPaths.mockReset().mockReturnValue([dependencies]);
      signal = new AbortController().signal;
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('protects hoisted dependencies and future lookup directories', async () => {
      const future = join(root, 'future', 'node_modules');
      lookupPaths.mockReturnValue([dependencies, future]);
      expect(await containerTrustedDirectories(bundle, signal)).toEqual([
        bundle,
        dependencies,
        future,
      ]);
    });

    it.each(['root', 'ancestor'])(
      'rejects a symlinked lookup %s that the workspace could redirect',
      async (location) => {
        const alias = join(root, 'alias');
        await symlink(dependencies, alias, 'dir');
        lookupPaths.mockReturnValue([
          location === 'root' ? alias : join(alias, 'nested', 'node_modules'),
        ]);
        await expect(
          containerTrustedDirectories(bundle, signal),
        ).rejects.toThrow('does not support symlinked');
      },
    );

    it('includes lookup ancestors of canonical/global roots', async () => {
      const globalRoot = join(root, 'global', '.node_modules');
      const ancestorLookup = join(root, 'global', 'node_modules');
      await mkdir(globalRoot, { recursive: true });
      lookupPaths.mockImplementation((entry: string) =>
        entry === join(globalRoot, 'cli.js')
          ? [globalRoot, ancestorLookup]
          : [globalRoot],
      );
      expect(await containerTrustedDirectories(bundle, signal)).toContain(
        ancestorLookup,
      );
    });

    it.each(['bundle', 'dependency'])(
      'rejects a %s link to workspace code outside the protected roots',
      async (location) => {
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        const parent = location === 'bundle' ? bundle : dependencies;
        await symlink(workspace, join(parent, 'linked-code'), 'dir');
        await expect(
          containerTrustedDirectories(bundle, signal),
        ).rejects.toThrow(
          'without links outside its protected dependency directories',
        );
      },
    );

    it('allows internal dependency links and checks their targets for escaping links', async () => {
      const packageRoot = join(dependencies, '.store', 'package');
      await mkdir(packageRoot, { recursive: true });
      await symlink(packageRoot, join(dependencies, 'package'), 'dir');
      await mkdir(join(dependencies, '.bin'));
      await writeFile(join(packageRoot, 'cli.js'), '');
      await symlink(
        '../.store/package/cli.js',
        join(dependencies, '.bin', 'package'),
      );
      await expect(
        containerTrustedDirectories(bundle, signal),
      ).resolves.toContain(dependencies);
      await symlink(root, join(packageRoot, 'escape'), 'dir');
      await expect(containerTrustedDirectories(bundle, signal)).rejects.toThrow(
        'without links outside',
      );
    });

    it('rejects a link chain that leaves the protected roots and returns inside', async () => {
      const packageRoot = join(dependencies, 'real-package');
      await mkdir(packageRoot);
      const redirect = join(root, 'workspace-link');
      await symlink(packageRoot, redirect, 'dir');
      await symlink(redirect, join(dependencies, 'package'), 'dir');
      await expect(containerTrustedDirectories(bundle, signal)).rejects.toThrow(
        'without links outside',
      );
    });

    it('rejects trusted code sharing an inode with a writable workspace file', async () => {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const code = join(dependencies, 'host-code.js');
      await writeFile(code, 'trusted code');
      await link(code, join(workspace, 'alias.js'));
      await expect(containerTrustedDirectories(bundle, signal)).rejects.toThrow(
        'hard-linked installation files',
      );
    });

    it('rejects link targets whose parent segments hide an intermediate workspace path', async () => {
      const workspace = join(root, 'workspace');
      await mkdir(join(workspace, 'placeholder'), { recursive: true });
      await mkdir(join(bundle, 'real-package'));
      await symlink(
        join(workspace, 'placeholder'),
        join(workspace, 'redirect'),
        'dir',
      );
      const packageLink = join(dependencies, 'package');
      await symlink(
        '../workspace/redirect/../../dist/real-package',
        packageLink,
        'dir',
      );
      expect(await realpath(packageLink)).toBe(join(bundle, 'real-package'));
      await expect(containerTrustedDirectories(bundle, signal)).rejects.toThrow(
        'normalized package links',
      );
    });

    it.each(['lookup-root', 'package-entry'])(
      'rejects a dangling %s link instead of treating it as an absent lookup',
      async (location) => {
        const link = join(
          location === 'lookup-root' ? root : bundle,
          'dangling',
        );
        await symlink(join(root, 'missing'), link, 'dir');
        if (location === 'lookup-root') lookupPaths.mockReturnValue([link]);
        if (location === 'lookup-root') {
          await expect(
            containerTrustedDirectories(bundle, signal),
          ).rejects.toThrow('does not support symlinked');
        } else {
          await expect(
            containerTrustedDirectories(bundle, signal),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        }
      },
    );

    it('rejects source/tsc directories without the complete bundle', async () => {
      await rm(join(bundle, 'cli.js'));
      await expect(containerTrustedDirectories(bundle, signal)).rejects.toThrow(
        'source and tsc launches are unsupported',
      );
    });

    it('honors cancellation before scanning', async () => {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      controller.abort(reason);
      await expect(
        containerTrustedDirectories(bundle, controller.signal),
      ).rejects.toBe(reason);
      expect(lookupPaths).not.toHaveBeenCalled();
    });
  },
);
