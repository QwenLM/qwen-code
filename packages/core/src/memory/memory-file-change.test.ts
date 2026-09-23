/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeMemoryFileChange,
  notifyMemoryEnabledChange,
  notifyMemoryFileChange,
  registerMemoryChangedListener,
  type MemoryChangedNotice,
} from './memory-file-change.js';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
} from './paths.js';

describe('memory file change hook', () => {
  const originalBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string | undefined;

  afterEach(async () => {
    if (originalBase === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalBase;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function setup(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-file-change-'));
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = tempDir;
    const projectRoot = path.join(tempDir, 'repo');
    await fs.mkdir(projectRoot, { recursive: true });
    return projectRoot;
  }

  it('classifies user, project, and unrelated paths', async () => {
    const projectRoot = await setup();

    expect(
      describeMemoryFileChange(
        path.join(tempDir!, 'memories', 'user', 'role.md'),
        projectRoot,
      ),
    ).toMatchObject({
      scope: 'user',
      relativePath: 'user/role.md',
    });
    expect(
      describeMemoryFileChange(
        path.join(getAutoMemoryRoot(projectRoot), 'feedback.md'),
        projectRoot,
      ),
    ).toMatchObject({
      scope: 'project',
      relativePath: 'feedback.md',
    });
    expect(
      describeMemoryFileChange(path.join(tempDir!, 'notes.md'), projectRoot),
    ).toBeUndefined();
    for (const schedulingPath of [
      getAutoMemoryMetadataPath(projectRoot),
      getAutoMemoryExtractCursorPath(projectRoot),
      getAutoMemoryConsolidationLockPath(projectRoot),
    ]) {
      expect(
        describeMemoryFileChange(schedulingPath, projectRoot),
      ).toBeUndefined();
    }
  });

  it('notifies listeners only for managed memory files', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    try {
      await notifyMemoryFileChange(
        path.join(tempDir!, 'memories', 'MEMORY.md'),
        projectRoot,
        'update',
      );
      await notifyMemoryFileChange(
        path.join(tempDir!, 'notes.md'),
        projectRoot,
        'update',
      );
      await notifyMemoryFileChange(
        getAutoMemoryMetadataPath(projectRoot),
        projectRoot,
        'update',
      );
    } finally {
      unregister();
    }
    expect(seen).toEqual([
      expect.objectContaining({
        scope: 'user',
        operation: 'update',
        relativePaths: ['MEMORY.md'],
      }),
    ]);
    expect(seen[0]).not.toHaveProperty('workspace');
    expect(seen[0]).not.toHaveProperty('enabled');
    expect(seen[0]).toMatchObject({
      paths: [path.join(tempDir!, 'memories', 'MEMORY.md')],
    });
  });

  it('sends one path alone and paths changed together as one array', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    const role = path.join(tempDir!, 'memories', 'user', 'role.md');
    const feedback = path.join(tempDir!, 'memories', 'feedback', 'tone.md');
    try {
      await notifyMemoryFileChange(role, projectRoot, 'update');
      await notifyMemoryFileChange([role, feedback], projectRoot, 'update');
    } finally {
      unregister();
    }
    expect(
      seen.map((change) =>
        'relativePaths' in change ? change.relativePaths : [],
      ),
    ).toEqual([['user/role.md'], ['user/role.md', 'feedback/tone.md']]);
  });

  it('splits mixed scopes and keeps workspace on project and team memory', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    const userFile = path.join(tempDir!, 'memories', 'user', 'role.md');
    const projectFile = path.join(getAutoMemoryRoot(projectRoot), 'a.md');
    const teamFile = path.join(getTeamAutoMemoryRoot(projectRoot), 'b.md');
    try {
      await notifyMemoryFileChange(
        [userFile, projectFile, teamFile],
        projectRoot,
        'create',
      );
    } finally {
      unregister();
    }
    expect(seen).toEqual([
      expect.objectContaining({
        scope: 'user',
        operation: 'create',
        relativePaths: ['user/role.md'],
      }),
      expect.objectContaining({
        scope: 'project',
        operation: 'create',
        relativePaths: ['a.md'],
        workspace: projectRoot,
      }),
      expect.objectContaining({
        scope: 'team',
        operation: 'create',
        relativePaths: ['b.md'],
        workspace: projectRoot,
      }),
    ]);
    expect(seen[0]).not.toHaveProperty('workspace');
  });

  it('reports the on/off toggle without document paths', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    try {
      await notifyMemoryEnabledChange(projectRoot, false);
    } finally {
      unregister();
    }
    expect(seen).toEqual([
      {
        paths: [],
        relativePaths: [],
        workspace: projectRoot,
        enabled: false,
      },
    ]);
  });

  it('isolates a listener failure from the write', async () => {
    const projectRoot = await setup();
    const seen: string[] = [];
    const unregisterFail = registerMemoryChangedListener(projectRoot, () => {
      throw new Error('upload failed');
    });
    const unregisterOk = registerMemoryChangedListener(projectRoot, () => {
      seen.push('ok');
    });
    try {
      await expect(
        notifyMemoryFileChange(
          path.join(tempDir!, 'memories', 'MEMORY.md'),
          projectRoot,
          'delete',
        ),
      ).resolves.toBeUndefined();
    } finally {
      unregisterFail();
      unregisterOk();
    }
    expect(seen).toEqual(['ok']);
  });

  it('does not deliver a write to another workspace', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(
      path.join(tempDir!, 'other'),
      (change) => {
        seen.push(change);
      },
    );
    try {
      await notifyMemoryFileChange(
        path.join(tempDir!, 'memories', 'MEMORY.md'),
        projectRoot,
        'update',
      );
    } finally {
      unregister();
    }
    expect(seen).toEqual([]);
  });
});
