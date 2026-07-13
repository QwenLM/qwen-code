/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  createMemoryScopedAgentConfig,
  isAllowedMemoryPath,
} from './memory-scoped-agent-config.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';

describe('createMemoryScopedAgentConfig', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-scoped-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    await fs.mkdir(path.join(getAutoMemoryRoot(projectRoot), 'project'), {
      recursive: true,
    });
    await fs.mkdir(path.join(getUserAutoMemoryRoot(), 'user'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    if (originalMemoryBase === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBase;
    }
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function permissionManager(config: Config): PermissionManager {
    const pm = config.getPermissionManager?.();
    if (!pm) throw new Error('missing permission manager');
    return pm;
  }

  it('restricts reads to memory paths only when requested', async () => {
    const unrestricted = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot),
    );
    await expect(
      unrestricted.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: path.join(projectRoot, 'transcripts', 'latest.jsonl'),
      }),
    ).resolves.toBe('default');

    const restricted = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot, {
        restrictReadsToMemoryPaths: true,
      }),
    );
    await expect(
      restricted.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: path.join(projectRoot, 'transcripts', 'latest.jsonl'),
      }),
    ).resolves.toBe('deny');
    await expect(
      restricted.evaluate({
        toolName: ToolNames.GREP,
        filePath: getAutoMemoryRoot(projectRoot),
      }),
    ).resolves.toBe('allow');
    await expect(
      restricted.evaluate({
        toolName: ToolNames.LS,
        filePath: getUserAutoMemoryRoot(),
      }),
    ).resolves.toBe('allow');
  });

  it('can keep writes project-memory-only for the dream agent', async () => {
    const pm = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot, {
        includeUserMemory: false,
      }),
    );

    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getAutoMemoryRoot(projectRoot), 'project', 'a.md'),
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getUserAutoMemoryRoot(), 'user', 'a.md'),
      }),
    ).resolves.toBe('deny');
  });

  it('allows creating new nested topic files inside memory roots', async () => {
    const pm = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot),
    );

    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(
          getAutoMemoryRoot(projectRoot),
          'project',
          'new-topic',
          'fact.md',
        ),
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: ToolNames.EDIT,
        filePath: path.join(
          getUserAutoMemoryRoot(),
          'user',
          'new-topic',
          'fact.md',
        ),
      }),
    ).resolves.toBe('allow');
  });

  it('allows memory paths with dot-prefixed names inside memory roots', async () => {
    const pm = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot),
    );

    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(
          getAutoMemoryRoot(projectRoot),
          '..topic',
          'fact.md',
        ),
      }),
    ).resolves.toBe('allow');
  });

  it('denies memory-root symlinks that resolve outside memory', async () => {
    const outsideDir = path.join(tempDir, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'target.md');
    await fs.writeFile(outsideFile, 'secret');

    const memoryRoot = getAutoMemoryRoot(projectRoot);
    await fs.mkdir(path.join(memoryRoot, 'project'), { recursive: true });
    const symlinkFile = path.join(memoryRoot, 'project', 'link.md');
    const symlinkDir = path.join(memoryRoot, 'project', 'linked-dir');
    await fs.symlink(outsideFile, symlinkFile);
    await fs.symlink(outsideDir, symlinkDir);

    const pm = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot),
    );
    await expect(
      pm.evaluate({
        toolName: ToolNames.EDIT,
        filePath: symlinkFile,
      }),
    ).resolves.toBe('deny');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(symlinkDir, 'new.md'),
      }),
    ).resolves.toBe('deny');
  });

  it('denies dangling symlink leaves inside memory roots', async () => {
    const outsideDir = path.join(tempDir, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });

    const link = path.join(
      getAutoMemoryRoot(projectRoot),
      'project',
      'link.md',
    );
    await fs.symlink(path.join(outsideDir, 'missing.md'), link);

    const pm = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot),
    );
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: link,
      }),
    ).resolves.toBe('deny');
  });

  it('allows only read-only shell commands when shell is enabled', async () => {
    const disabled = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot),
    );
    await expect(disabled.isToolEnabled(ToolNames.SHELL)).resolves.toBe(false);
    await expect(
      disabled.evaluate({
        toolName: ToolNames.SHELL,
        command: 'ls',
      }),
    ).resolves.toBe('deny');

    const enabled = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot, {
        allowShell: true,
      }),
    );
    await expect(enabled.isToolEnabled(ToolNames.SHELL)).resolves.toBe(true);
    await expect(
      enabled.evaluate({
        toolName: ToolNames.SHELL,
        command: 'ls -la',
      }),
    ).resolves.toBe('allow');
    await expect(
      enabled.evaluate({
        toolName: ToolNames.SHELL,
        command: 'touch bad',
      }),
    ).resolves.toBe('deny');
  });

  it('lets base deny rules override scoped allows', async () => {
    const basePm: Pick<
      PermissionManager,
      | 'evaluate'
      | 'findMatchingDenyRule'
      | 'hasMatchingAskRule'
      | 'hasRelevantRules'
      | 'isToolEnabled'
    > = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
      findMatchingDenyRule: vi.fn().mockReturnValue('base deny'),
      evaluate: vi.fn().mockResolvedValue('deny'),
      isToolEnabled: vi.fn().mockResolvedValue(true),
    };
    const pm = permissionManager(
      createMemoryScopedAgentConfig(
        {
          getPermissionManager: () => basePm as PermissionManager,
        } as Config,
        projectRoot,
      ),
    );

    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getAutoMemoryRoot(projectRoot), 'project', 'a.md'),
      }),
    ).resolves.toBe('deny');
  });

  it('can bypass base ask rules for scoped memory writes only', async () => {
    const basePm: Pick<
      PermissionManager,
      | 'evaluate'
      | 'findMatchingDenyRule'
      | 'hasMatchingAskRule'
      | 'hasRelevantRules'
      | 'isToolEnabled'
    > = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      hasMatchingAskRule: vi.fn().mockReturnValue(true),
      findMatchingDenyRule: vi.fn().mockReturnValue(undefined),
      evaluate: vi.fn().mockResolvedValue('ask'),
      isToolEnabled: vi.fn().mockResolvedValue(true),
    };
    const pm = permissionManager(
      createMemoryScopedAgentConfig(
        {
          getPermissionManager: () => basePm as PermissionManager,
        } as Config,
        projectRoot,
        { bypassBaseAskForScopedPaths: true },
      ),
    );

    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getUserAutoMemoryRoot(), 'user', 'a.md'),
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(projectRoot, 'README.md'),
      }),
    ).resolves.toBe('deny');
  });

  it('does not bypass base deny rules for scoped memory writes', async () => {
    const basePm: Pick<
      PermissionManager,
      | 'evaluate'
      | 'findMatchingDenyRule'
      | 'hasMatchingAskRule'
      | 'hasRelevantRules'
      | 'isToolEnabled'
    > = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
      findMatchingDenyRule: vi.fn().mockReturnValue('base deny'),
      evaluate: vi.fn().mockResolvedValue('deny'),
      isToolEnabled: vi.fn().mockResolvedValue(true),
    };
    const pm = permissionManager(
      createMemoryScopedAgentConfig(
        {
          getPermissionManager: () => basePm as PermissionManager,
        } as Config,
        projectRoot,
        { bypassBaseAskForScopedPaths: true },
      ),
    );

    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getUserAutoMemoryRoot(), 'user', 'a.md'),
      }),
    ).resolves.toBe('deny');
  });
});

describe('isAllowedMemoryPath with a symlinked project root', () => {
  const originalMemoryLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
  let baseDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    // Local-memory mode anchors the managed-memory root at
    // `<projectRoot>/.qwen/memory`, so routing the project root through an
    // explicit symlink puts a symlink component in the memory-root path on
    // every platform — not only where os.tmpdir() happens to be a symlink
    // (e.g. macOS `/var` -> `/private/var`). The memory root is deliberately
    // NOT created, so the allow-check must resolve the nearest existing
    // ancestor (the symlink) rather than assume the root already exists.
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-symlink-'));
    const realProject = path.join(baseDir, 'realproj');
    projectRoot = path.join(baseDir, 'linkproj');
    await fs.mkdir(realProject, { recursive: true });
    await fs.symlink(realProject, projectRoot);
    clearAutoMemoryRootCache();
  });

  afterEach(async () => {
    if (originalMemoryLocal === undefined) {
      delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    } else {
      process.env['QWEN_CODE_MEMORY_LOCAL'] = originalMemoryLocal;
    }
    clearAutoMemoryRootCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('allows a write under a symlinked managed-memory root that does not exist yet', () => {
    // Regression: the root was resolved with path.resolve (symlink kept) while
    // the candidate was realpath'd (symlink resolved), so the two diverged
    // (a `linkproj/...` root vs a `realproj/...` candidate) and a legitimate
    // managed-memory write was rejected. Both sides must resolve the symlink
    // identically even before the root directory exists.
    const memoryFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    expect(isAllowedMemoryPath(memoryFile, projectRoot)).toBe(true);
  });

  it('still denies a path outside the symlinked managed-memory root', () => {
    // The symmetric resolution must not become overly permissive: a normal
    // project file that is not under `<projectRoot>/.qwen/memory` — reached
    // through the same symlinked root — is still rejected.
    const outsideFile = path.join(projectRoot, 'notes.md');
    expect(isAllowedMemoryPath(outsideFile, projectRoot)).toBe(false);
  });
});
