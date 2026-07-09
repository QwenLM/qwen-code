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
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import {
  didWriteManagedMemory,
  refreshMemoryAfterManagedWrite,
} from './refresh.js';

vi.mock('./indexer.js', () => ({
  rebuildManagedAutoMemoryIndex: vi.fn(),
  rebuildUserAutoMemoryIndex: vi.fn(),
}));

function createConfig(projectRoot: string, managed = true): Config {
  return {
    isManagedMemoryAvailable: vi.fn().mockReturnValue(managed),
    getProjectRoot: vi.fn().mockReturnValue(projectRoot),
    refreshHierarchicalMemory: vi.fn().mockResolvedValue(undefined),
    getGeminiClient: vi.fn().mockReturnValue({
      refreshSystemInstruction: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Config;
}

describe('managed memory refresh helper', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-refresh-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    vi.mocked(rebuildManagedAutoMemoryIndex).mockReset();
    vi.mocked(rebuildUserAutoMemoryIndex).mockReset();
    vi.mocked(rebuildManagedAutoMemoryIndex).mockResolvedValue('');
    vi.mocked(rebuildUserAutoMemoryIndex).mockResolvedValue('');
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

  it('detects successful private managed-memory writes only', () => {
    const memoryFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');

    expect(
      didWriteManagedMemory(
        [
          {
            toolName: 'write_file',
            args: { file_path: memoryFile },
            status: 'success',
          },
        ],
        projectRoot,
      ),
    ).toBe(true);
    expect(
      didWriteManagedMemory(
        [
          {
            toolName: 'edit',
            args: { file_path: memoryFile },
            status: 'error',
          },
        ],
        projectRoot,
      ),
    ).toBe(false);
    expect(
      didWriteManagedMemory(
        [
          {
            toolName: 'write_file',
            args: { file_path: path.join(projectRoot, 'src/file.ts') },
            status: 'success',
          },
        ],
        projectRoot,
      ),
    ).toBe(false);
    expect(
      didWriteManagedMemory(
        [
          {
            toolName: 'write_file',
            args: {
              file_path: path.join(
                projectRoot,
                '.qwen',
                'team-memory',
                'shared.md',
              ),
            },
            status: 'success',
          },
        ],
        projectRoot,
      ),
    ).toBe(false);
  });

  it('supports legacy edit names and alternate file path arguments', () => {
    const memoryFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');

    expect(
      didWriteManagedMemory(
        [
          {
            toolName: 'replace',
            args: { target_file: memoryFile },
            status: 'success',
          },
        ],
        projectRoot,
      ),
    ).toBe(true);
  });

  it('rebuilds touched indexes before refreshing the live instruction', async () => {
    const config = createConfig(projectRoot);
    const projectFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    const userFile = path.join(getUserAutoMemoryRoot(), 'user.md');

    await expect(
      refreshMemoryAfterManagedWrite(config, [
        {
          toolName: 'write_file',
          args: { file_path: projectFile },
          status: 'success',
        },
        { toolName: 'edit', args: { file_path: userFile }, status: 'success' },
      ]),
    ).resolves.toBe(true);

    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
    expect(config.refreshHierarchicalMemory).toHaveBeenCalledTimes(1);
    expect(
      config.getGeminiClient().refreshSystemInstruction,
    ).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(rebuildManagedAutoMemoryIndex).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(config.refreshHierarchicalMemory).mock.invocationCallOrder[0],
    );
  });

  it('keeps refreshing when index rebuild fails', async () => {
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValueOnce(
      new Error('index failed'),
    );
    const config = createConfig(projectRoot);

    await expect(
      refreshMemoryAfterManagedWrite(config, [
        {
          toolName: 'write_file',
          args: {
            file_path: path.join(getAutoMemoryRoot(projectRoot), 'x.md'),
          },
          status: 'success',
        },
      ]),
    ).resolves.toBe(true);

    expect(config.refreshHierarchicalMemory).toHaveBeenCalledTimes(1);
    expect(
      config.getGeminiClient().refreshSystemInstruction,
    ).toHaveBeenCalledTimes(1);
  });

  it('returns false without refreshing when managed memory is unavailable', async () => {
    const config = createConfig(projectRoot, false);

    await expect(
      refreshMemoryAfterManagedWrite(config, [
        {
          toolName: 'write_file',
          args: {
            file_path: path.join(getAutoMemoryRoot(projectRoot), 'x.md'),
          },
          status: 'success',
        },
      ]),
    ).resolves.toBe(false);

    expect(config.refreshHierarchicalMemory).not.toHaveBeenCalled();
    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
  });
});
