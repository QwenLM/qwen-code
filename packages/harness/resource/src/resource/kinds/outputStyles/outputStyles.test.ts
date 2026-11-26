/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadOutputStylesFromDir,
  loadOutputStylesFromPath,
} from '../../../index.js';

import { createNoopFileWatcher } from '../../../file-watcher/fileWatcher.js';
import { ProjectResource } from '../../core/projectResource.js';
import { UserResource } from '../../core/userResource.js';
import { OutputStyleProvider } from './providers/outputStyleProvider.js';

describe('OutputStyle one-shot loaders', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'output-style-loaders-'));
    dir = join(root, 'styles');
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(name: string, content: string): Promise<void> {
    await writeFile(join(dir, name), content);
  }

  it('parses CRLF frontmatter, scalar descriptions and strict booleans', async () => {
    await write(
      'name.MD',
      '---\r\nname: " Custom "\r\ndescription: 42\r\nkeep-coding-instructions: " true "\r\nforce-for-plugin: false\r\n---\r\n\r\nBody\r\n',
    );
    expect(await loadOutputStylesFromDir(dir, 'plugin', 'owner')).toEqual([
      expect.objectContaining({
        name: 'owner:Custom',
        description: '42',
        prompt: 'Body',
        keepCodingInstructions: true,
        forceForPlugin: false,
      }),
    ]);
  });

  it('supports manifest file paths and recursive plugin directories without following nested symlinks', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true });
    await write('nested/style.md', '# Title\nDescription');
    await symlink(dir, join(dir, 'nested', 'loop'));
    expect(await loadOutputStylesFromDir(dir, 'userSettings')).toEqual([]);
    const styles = await loadOutputStylesFromPath(dir, 'plugin', 'p');
    expect(styles).toHaveLength(1);
    expect(styles[0]).toMatchObject({
      name: 'p:style',
      description: 'Description',
    });
    expect(
      await loadOutputStylesFromPath(
        join(dir, 'nested/style.md'),
        'plugin',
        'p',
      ),
    ).toEqual(styles);
    await symlink(join(dir, 'nested/style.md'), join(root, 'linked.md'));
    expect(
      await loadOutputStylesFromPath(join(root, 'linked.md'), 'plugin', 'p'),
    ).toEqual([expect.objectContaining({ name: 'p:linked' })]);
  });

  it('handles absent directories, non-Markdown paths and non-object frontmatter', async () => {
    expect(await loadOutputStylesFromDir(dir, 'userSettings')).toEqual([]);
    await write('other.txt', 'Ignored');
    await write('style.md', '---\n- ignored\n---\nBody');
    expect(
      await loadOutputStylesFromPath(join(dir, 'other.txt'), 'plugin'),
    ).toEqual([]);
    expect(await loadOutputStylesFromDir(dir, 'userSettings')).toEqual([
      expect.objectContaining({
        name: 'style',
        description: 'Body',
        prompt: 'Body',
      }),
    ]);
  });
});

describe('OutputStyle resources', () => {
  let root: string;
  let user: UserResource;
  let project: ProjectResource;
  let userDir: string;
  let projectDir: string;

  async function write(
    dir: string,
    name: string,
    content: string,
  ): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'output-style-resource-'));
    userDir = join(root, 'custom-user', 'output-styles');
    projectDir = join(root, 'custom-project', 'output-styles');
    user = new UserResource({
      homeDir: root,
      globalConfigDirOverride: join(root, 'custom-user'),
    });
    project = new ProjectResource({
      cwd: join(root, 'workspace'),
      homeDir: root,
      projectConfigDirOverride: join(root, 'custom-project'),
      isTrusted: false,
      additionalDirectories: [join(root, 'extra')],
      fileWatcher: createNoopFileWatcher(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await project.dispose();
    await user.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('loads overridden paths, preserves candidates and applies no trust gate', async () => {
    await write(userDir, 'shared.md', 'User');
    await write(projectDir, 'shared.md', 'Project');
    await write(
      join(root, 'extra/.qwen/output-styles'),
      'extra.md',
      'Ignored',
    );
    await write(join(projectDir, 'nested'), 'nested.md', 'Ignored');
    await user.reloadOutputStyles();
    await project.reloadOutputStyles();

    expect(
      user.outputStyles.getAllDiscoveredOutputStyles().map((s) => s.source),
    ).toEqual(['userSettings']);
    expect(
      project.outputStyles.getAllDiscoveredOutputStyles().map((s) => s.source),
    ).toEqual(['projectSettings']);
    const copy = project.outputStyles.getAllDiscoveredOutputStyles()[0];
    copy.prompt = 'Mutated';
    expect(project.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'Project',
    );
  });

  it('keeps the snapshot until an explicit reload', async () => {
    await write(projectDir, 'shared.md', 'Project');
    await project.reloadOutputStyles();
    await rm(join(projectDir, 'shared.md'));
    expect(project.outputStyles.getAllDiscoveredOutputStyles()).toHaveLength(1);
    await project.reloadOutputStyles();
    expect(project.outputStyles.getAllDiscoveredOutputStyles()).toHaveLength(0);
  });

  it('keeps the previous complete snapshot after a failed refresh and recovers on the next reload', async () => {
    await write(userDir, 'a.md', 'Old');
    await user.reloadOutputStyles();
    await write(userDir, 'a.md', 'New');
    const spy = vi
      .spyOn(OutputStyleProvider.prototype, 'load')
      .mockRejectedValueOnce(new Error('failed'));
    await expect(user.reloadOutputStyles()).rejects.toThrow('failed');
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'Old',
    );
    spy.mockRestore();
    await user.reloadOutputStyles();
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'New',
    );
  });

  it('does not load the initial style snapshot twice when the host loads styles before ready', async () => {
    const spy = vi.spyOn(OutputStyleProvider.prototype, 'load');
    await project.reloadOutputStyles();
    await project.ready;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reloads a changed workspace path while keeping the global styles', async () => {
    await write(userDir, 'global.md', 'Global');
    await write(projectDir, 'local.md', 'Original');
    await user.reloadOutputStyles();
    await project.reloadOutputStyles();
    const worktreeConfig = join(root, 'worktree/.qwen');
    await write(join(worktreeConfig, 'output-styles'), 'local.md', 'Worktree');
    await project.reloadOutputStyles({
      projectConfigDirOverride: worktreeConfig,
    });
    expect(project.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'Worktree',
    );
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'Global',
    );
    await project.reloadOutputStyles();
    expect(project.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'Original',
    );
  });

  it('retains legacy same-home source labeling', async () => {
    const homeProject = new ProjectResource({
      cwd: root,
      homeDir: root,
      fileWatcher: createNoopFileWatcher(),
    });
    try {
      await write(join(root, '.qwen/output-styles'), 'home.md', 'Body');
      await homeProject.reloadOutputStyles();
      expect(
        homeProject.outputStyles
          .getAllDiscoveredOutputStyles()
          .map((s) => s.source),
      ).toEqual(['projectSettings']);
    } finally {
      await homeProject.dispose();
    }
  });

  it('reports malformed YAML while preserving the historical body fallback and clears errors on reload', async () => {
    await write(userDir, 'broken.md', '---\nname: [\n---\nBody');
    await user.reloadOutputStyles();
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'Body',
    );
    expect(user.outputStyles.getLoadErrors()).toHaveLength(1);
    await write(userDir, 'broken.md', 'Fixed');
    await user.reloadOutputStyles();
    expect(user.outputStyles.getLoadErrors()).toEqual([]);
  });
});
