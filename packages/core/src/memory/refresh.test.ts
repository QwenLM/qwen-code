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
  AGENT_CONTEXT_FILENAME,
  DEFAULT_CONTEXT_FILENAME,
  setMemoryFilename,
} from '../utils/memory-constants.js';
import {
  didWriteManagedMemory,
  didWriteProjectContextFile,
  refreshMemoryAfterManagedWrite,
  refreshMemoryInstruction,
  type MemoryWriteCandidate,
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
    getLlmClient: vi.fn().mockReturnValue({
      refreshSystemInstruction: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Config;
}

const toolCall = (
  toolName: string,
  args: Record<string, unknown>,
  status = 'success',
): MemoryWriteCandidate => ({ toolName, args, status });
const writeFile = (file_path: string, status = 'success') =>
  toolCall('write_file', { file_path }, status);

function expectRefreshedOnce(config: Config) {
  expect(config.refreshHierarchicalMemory).toHaveBeenCalledTimes(1);
  expect(config.getLlmClient().refreshSystemInstruction).toHaveBeenCalledTimes(
    1,
  );
}

function expectNotRefreshed(config: Config) {
  expect(config.refreshHierarchicalMemory).not.toHaveBeenCalled();
  expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
}

describe('managed memory refresh helper', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;

  const wroteMemory = (call: MemoryWriteCandidate) =>
    didWriteManagedMemory([call], projectRoot);
  const wroteContext = (call: MemoryWriteCandidate) =>
    didWriteProjectContextFile([call], projectRoot);
  const memoryPath = (name: string) =>
    path.join(getAutoMemoryRoot(projectRoot), name);

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
    setMemoryFilename([DEFAULT_CONTEXT_FILENAME, AGENT_CONTEXT_FILENAME]);
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
    const memoryFile = memoryPath('project.md');
    const teamFile = path.join(
      projectRoot,
      '.qwen',
      'team-memory',
      'shared.md',
    );

    expect(wroteMemory(writeFile(memoryFile))).toBe(true);
    expect(
      wroteMemory(toolCall('edit', { file_path: memoryFile }, 'error')),
    ).toBe(false);
    expect(wroteMemory(writeFile(path.join(projectRoot, 'src/file.ts')))).toBe(
      false,
    );
    expect(wroteMemory(writeFile(teamFile))).toBe(false);
  });

  it('supports legacy edit names and alternate file path arguments', () => {
    const memoryFile = memoryPath('project.md');

    expect(wroteMemory(toolCall('replace', { target_file: memoryFile }))).toBe(
      true,
    );
  });

  it('detects successful project context file writes only', () => {
    const contextFile = path.join(projectRoot, DEFAULT_CONTEXT_FILENAME);

    expect(wroteContext(writeFile(contextFile))).toBe(true);
    expect(
      wroteContext(toolCall('edit', { file_path: DEFAULT_CONTEXT_FILENAME })),
    ).toBe(true);
    expect(
      wroteContext(
        toolCall('replace', { target_file: DEFAULT_CONTEXT_FILENAME }),
      ),
    ).toBe(true);
    expect(
      wroteContext(writeFile(path.join(projectRoot, AGENT_CONTEXT_FILENAME))),
    ).toBe(true);
    expect(wroteContext(writeFile(contextFile, 'error'))).toBe(false);
    expect(wroteContext(writeFile(path.join(projectRoot, 'notes.md')))).toBe(
      false,
    );
    expect(
      wroteContext(writeFile(path.join('docs', DEFAULT_CONTEXT_FILENAME))),
    ).toBe(false);
    expect(
      wroteContext(
        writeFile(path.join(projectRoot, '..', DEFAULT_CONTEXT_FILENAME)),
      ),
    ).toBe(false);
  });

  it('detects configured project context file writes', () => {
    setMemoryFilename('PROJECT_CONTEXT.md');

    expect(
      wroteContext(writeFile(path.join(projectRoot, 'PROJECT_CONTEXT.md'))),
    ).toBe(true);
    expect(
      wroteContext(writeFile(path.join(projectRoot, DEFAULT_CONTEXT_FILENAME))),
    ).toBe(false);
  });

  it('rebuilds touched indexes before refreshing the live instruction', async () => {
    const config = createConfig(projectRoot);
    const projectFile = memoryPath('project.md');
    const userFile = path.join(getUserAutoMemoryRoot(), 'user.md');

    await expect(
      refreshMemoryAfterManagedWrite(config, [
        writeFile(projectFile),
        toolCall('edit', { file_path: userFile }),
      ]),
    ).resolves.toBe(true);

    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
    expectRefreshedOnce(config);
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
      refreshMemoryAfterManagedWrite(config, [writeFile(memoryPath('x.md'))]),
    ).resolves.toBe(true);

    expectRefreshedOnce(config);
  });

  it('keeps refreshing the system instruction when hierarchical refresh fails', async () => {
    const config = createConfig(projectRoot);
    vi.mocked(config.refreshHierarchicalMemory).mockRejectedValueOnce(
      new Error('hierarchical refresh failed'),
    );

    await expect(refreshMemoryInstruction(config)).resolves.toBeUndefined();

    expectRefreshedOnce(config);
  });

  it('returns false without refreshing when managed memory is unavailable', async () => {
    const config = createConfig(projectRoot, false);

    await expect(
      refreshMemoryAfterManagedWrite(config, [writeFile(memoryPath('x.md'))]),
    ).resolves.toBe(false);

    expectNotRefreshed(config);
  });

  it('returns false when refresh guard evaluation throws', async () => {
    const config = createConfig(projectRoot);
    vi.mocked(config.getProjectRoot).mockImplementationOnce(() => {
      throw new Error('project root unavailable');
    });

    await expect(
      refreshMemoryAfterManagedWrite(config, [writeFile(memoryPath('x.md'))]),
    ).resolves.toBe(false);

    expectNotRefreshed(config);
  });
});
