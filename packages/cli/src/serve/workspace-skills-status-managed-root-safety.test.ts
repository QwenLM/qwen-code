/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionStore } from '@qwen-code/qwen-code-core';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';

const layouts = ['fresh', 'store-only', 'extensions-directory'] as const;
type Layout = (typeof layouts)[number];
type Failure = 'removed' | 'relinked' | 'unreadable';

describe('workspace Skills managed-root verification', () => {
  let temporary: string;
  let home: string;
  let workspace: string;
  let managedRoot: string;

  beforeEach(async () => {
    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skills-managed-root-')),
    );
    home = path.join(temporary, 'home');
    workspace = path.join(temporary, 'workspace');
    managedRoot = path.join(temporary, 'managed');
    for (const directory of [home, workspace, managedRoot]) {
      await fs.mkdir(directory);
    }
    vi.stubEnv('QWEN_HOME', home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  async function prepare(layout: Layout) {
    const skillDirectory = path.join(
      managedRoot,
      'bundle',
      'skills',
      'example',
    );
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      path.join(managedRoot, 'bundle', 'qwen-extension.json'),
      JSON.stringify({ name: 'bundle', version: '1.0.0' }),
    );
    await fs.writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: example\ndescription: Managed example\n---\nInstructions',
    );
    if (layout === 'store-only') {
      await new ExtensionStore().ensureInitialized([]);
      await fs.rm(path.join(home, 'extensions'), {
        recursive: true,
        force: true,
      });
    } else if (layout === 'extensions-directory') {
      await fs.mkdir(path.join(home, 'extensions'));
    }
    return createWorkspaceSkillsStatusProvider({
      managedExtensionsDir: managedRoot,
    });
  }

  async function damage(failure: Failure): Promise<() => Promise<void>> {
    if (failure === 'unreadable') {
      await fs.chmod(managedRoot, 0o000);
      return () => fs.chmod(managedRoot, 0o755);
    }
    const moved = path.join(temporary, 'moved-managed');
    await fs.rename(managedRoot, moved);
    if (failure === 'relinked') await fs.symlink(moved, managedRoot, 'dir');
    return async () => {
      if (failure === 'relinked') await fs.unlink(managedRoot);
      await fs.rename(moved, managedRoot);
    };
  }

  async function assertDeferredAndRecovered(layout: Layout, failure: Failure) {
    const provider = await prepare(layout);
    const restore = await damage(failure);
    try {
      const unavailable = await provider(workspace);
      expect.soft(unavailable.initialized).toBe(false);
      expect.soft(unavailable.skills).toEqual([]);
      expect
        .soft(unavailable.errors?.[0])
        .toMatchObject({ kind: 'skills', status: 'error' });
      expect
        .soft(unavailable.errors?.[0]?.error)
        .toMatch(/Managed extensions.*(root|list)/i);
    } finally {
      await restore();
    }
    const recovered = await provider(workspace);
    expect(recovered.initialized).toBe(true);
    expect(recovered.errors).toBeUndefined();
    expect(recovered.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'bundle:example',
          level: 'extension',
          status: 'ok',
        }),
      ]),
    );
    if (layout !== 'extensions-directory') {
      await expect(
        fs.stat(path.join(home, 'extensions')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    if (layout === 'fresh') {
      await expect(
        fs.stat(path.join(home, 'extension-store')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }

  for (const layout of layouts) {
    for (const failure of ['removed', 'relinked'] as const) {
      it.skipIf(process.platform === 'win32' && failure === 'relinked')(
        `defers a ${failure} managed root in a ${layout} home and retries after restoration`,
        () => assertDeferredAndRecovered(layout, failure),
      );
    }

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      `defers an unreadable managed root in a ${layout} home and retries after restoration`,
      () => assertDeferredAndRecovered(layout, 'unreadable'),
    );

    it(`lists a verified managed root in a ${layout} home`, async () => {
      const provider = await prepare(layout);
      const status = await provider(workspace);
      expect(status.initialized).toBe(true);
      expect(status.errors).toBeUndefined();
      expect(status.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'bundle:example',
            level: 'extension',
            status: 'ok',
          }),
        ]),
      );
    });

    it(`accepts a verified empty root in a ${layout} home`, async () => {
      const provider = await prepare(layout);
      await fs.rm(path.join(managedRoot, 'bundle'), { recursive: true });
      const status = await provider(workspace);
      expect(status.initialized).toBe(true);
      expect(status.errors).toBeUndefined();
      expect(
        status.skills.some((skill) => skill.name === 'bundle:example'),
      ).toBe(false);
      expect(status.skills.some((skill) => skill.name === 'review')).toBe(true);
    });

    it(`keeps valid Skills with an auxiliary directory in a ${layout} home`, async () => {
      const provider = await prepare(layout);
      await fs.mkdir(path.join(managedRoot, 'assets'));
      await fs.writeFile(
        path.join(managedRoot, 'assets', 'template.txt'),
        'asset',
      );
      const status = await provider(workspace);
      expect(status.initialized).toBe(true);
      expect(status.errors).toBeUndefined();
      expect(status.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'bundle:example',
            level: 'extension',
            status: 'ok',
          }),
        ]),
      );
    });
  }

  it('keeps bundled Skills without a managed root configured', async () => {
    const status = await createWorkspaceSkillsStatusProvider()(workspace);
    expect(status.initialized).toBe(true);
    expect(status.errors).toBeUndefined();
    expect(status.skills.some((skill) => skill.name === 'review')).toBe(true);
  });
});
