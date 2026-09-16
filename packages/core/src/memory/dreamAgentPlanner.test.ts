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
import { Storage } from '../config/storage.js';
import type { ForkedAgentResult } from '../agents/forkedAgent.js';
import { runForkedAgent } from '../agents/forkedAgent.js';
import { escapeShellArg, getShellConfiguration } from '../utils/shell-utils.js';
import {
  AUTO_MEMORY_PINNED_DIRNAME,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
  clearAutoMemoryRootCache,
} from './paths.js';
import {
  buildConsolidationTaskPrompt,
  getTranscriptDir,
  planManagedAutoMemoryDreamByAgent,
} from './dreamAgentPlanner.js';
import { applyDreamOperations } from './dream-operations.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { AUTO_MEMORY_TREE_CATEGORIES } from './types.js';

vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

describe('dreamAgentPlanner', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'auto-memory-dream-agent-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    await ensureAutoMemoryScaffold(projectRoot);
    config = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getModel: vi.fn().mockReturnValue('qwen-test'),
      getApprovalMode: vi.fn(),
      getMemoryAgentTimeoutMinutes: vi.fn().mockReturnValue(undefined),
      getMemoryAgentMaxTurns: vi.fn().mockReturnValue(undefined),
      getAutoMemoryPrompt: vi.fn().mockReturnValue('session routing contract'),
    } as unknown as Config;
    vi.mocked(runForkedAgent).mockReset();
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    if (originalMemoryBase === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBase;
    }
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('returns project-scoped session transcript directory', () => {
    const runtimeDir = path.join(tempDir, 'runtime');
    Storage.setRuntimeBaseDir(runtimeDir);

    expect(getTranscriptDir(projectRoot)).toBe(
      path.join(new Storage(projectRoot).getProjectDir(), 'chats'),
    );
    expect(getTranscriptDir(projectRoot)).toContain(
      path.join(runtimeDir, 'projects'),
    );
    expect(getTranscriptDir(projectRoot)).not.toContain(
      `${path.sep}.qwen${path.sep}tmp${path.sep}`,
    );
  });

  it('shell-quotes the transcript directory in the grep example', () => {
    const transcriptDir = path.join(
      tempDir,
      'runtime dir; touch BAD',
      'projects',
      '-tmp-project',
      'chats',
    );
    const quotedTranscriptDir = escapeShellArg(
      `${transcriptDir}${path.sep}`,
      getShellConfiguration().shell,
    );
    const prompt = buildConsolidationTaskPrompt(
      path.join(tempDir, 'memory'),
      transcriptDir,
    );

    expect(prompt).toContain(
      `grep -rn "<narrow term>" ${quotedTranscriptDir} --include="*.jsonl" | tail -50`,
    );
    expect(prompt).not.toContain(
      `grep -rn "<narrow term>" ${transcriptDir}${path.sep} --include="*.jsonl" | tail -50`,
    );
  });

  it('excludes pinned memories from consolidation', () => {
    const prompt = buildConsolidationTaskPrompt(
      path.join(tempDir, 'memory'),
      path.join(tempDir, 'transcripts'),
    );

    expect(prompt).toContain('`pinned/`');
    expect(prompt).toContain('Skip `pinned/` during Dream');
    expect(prompt).toContain('description`, `category`, `usage_scenarios`');
    expect(prompt).toContain('2-6 discriminative retrieval terms');
    expect(prompt).toContain('at most 64 characters');
    for (const category of AUTO_MEMORY_TREE_CATEGORIES) {
      expect(prompt).toContain(category);
    }
    expect(prompt).toContain(
      'Do not intentionally remove existing index entries for valid `pinned/` files',
    );
    expect(prompt).toContain('normal index limits still apply');
  });

  it('gives the Dream agent a manifest example the runtime accepts', async () => {
    const memoryRoot = path.join(tempDir, 'dream-root');
    const prompt = buildConsolidationTaskPrompt(
      memoryRoot,
      path.join(tempDir, 'transcripts'),
      { runtimeManagedOperations: true },
    );
    expect(prompt).toContain('must also appear in `delete`');
    const example = prompt.match(/`(\{"version":1[^`]*\})`/)?.[1];
    expect(example).toBeDefined();
    const manifest = JSON.parse(example!) as {
      delete: string[];
      operations: Array<
        | { type: 'dedupe'; sources: string[]; target: string }
        | { type: 'split'; source: string; targets: string[] }
      >;
    };
    const writeDoc = async (relativePath: string, name: string) => {
      const filePath = path.join(memoryRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const content = [
        '---',
        `name: ${name}`,
        'description: Dream operations fixture',
        'type: project',
        'category: project_introduction',
        'keywords:',
        '  - dream operations',
        '  - manifest example',
        'usage_scenarios:',
        '  - verifying dream manifests',
        '---',
        'Body.',
      ].join('\n');
      await fs.writeFile(filePath, content, 'utf-8');
      return content;
    };
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.writeFile(
      path.join(memoryRoot, '.dream-operations.json'),
      JSON.stringify(manifest),
      'utf-8',
    );
    const beforeSnapshot = new Map<string, { content: string }>();
    for (const relativePath of manifest.delete) {
      beforeSnapshot.set(relativePath, {
        content: await writeDoc(relativePath, `deleted ${relativePath}`),
      });
    }
    for (const operation of manifest.operations) {
      const targets =
        operation.type === 'dedupe' ? [operation.target] : operation.targets;
      for (const relativePath of targets) {
        await writeDoc(relativePath, `target ${relativePath}`);
      }
    }

    await expect(
      applyDreamOperations(memoryRoot, beforeSnapshot),
    ).resolves.toEqual({
      deletedPaths: manifest.delete,
      dedupedEntries: 1,
      splitEntries: 1,
    });
  });

  it('returns the forked agent result', async () => {
    const mockResult: ForkedAgentResult = {
      status: 'completed',
      finalText: 'Merged 2 duplicate Vim entries into prefers-vim.md.',
      filesTouched: [
        path.join(projectRoot, '.qwen', 'memory', 'user', 'prefers-vim.md'),
      ],
    };

    vi.mocked(runForkedAgent).mockResolvedValue(mockResult);

    const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot);

    expect(result).toBe(mockResult);
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskPrompt: expect.stringContaining('.dream-operations.json'),
        systemPrompt: expect.stringContaining(
          'discriminative retrieval terms or short phrases',
        ),
        maxTurns: 8,
        maxTimeMinutes: 5,
        tools: [
          'read_file',
          'grep_search',
          'glob',
          'run_shell_command',
          'write_file',
          'edit',
        ],
      }),
    );
  });

  it('does not inherit the session auto-memory routing contract', async () => {
    // The session contract routes body access through search_memory /
    // manage_memory — tools this agent does not have — and forbids the
    // direct file tools it does have.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
    } satisfies ForkedAgentResult);

    await planManagedAutoMemoryDreamByAgent(config, projectRoot);

    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      systemPrompt: string;
    };
    expect(params.config.getAutoMemoryPrompt()).toBe('');
    // The frontmatter format reference travels with the agent's own prompt
    // instead (it used to arrive via the inherited legacy section).
    expect(params.systemPrompt).toContain('Memory file format reference:');
    expect(params.systemPrompt).toContain('usage_scenarios:');
  });

  it('threads the configured memory agent timeout into the forked agent', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
    } satisfies ForkedAgentResult);
    vi.mocked(config.getMemoryAgentTimeoutMinutes).mockReturnValueOnce(30);

    await planManagedAutoMemoryDreamByAgent(config, projectRoot);

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTimeMinutes: 30 }),
    );
  });

  it('threads the configured memory agent turn limit into the forked agent', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
    } satisfies ForkedAgentResult);
    vi.mocked(config.getMemoryAgentMaxTurns).mockReturnValueOnce(25);

    await planManagedAutoMemoryDreamByAgent(config, projectRoot);

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 25 }),
    );
  });

  it('preserves the zero turn limit sentinel', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
    } satisfies ForkedAgentResult);
    vi.mocked(config.getMemoryAgentMaxTurns).mockReturnValueOnce(0);

    await planManagedAutoMemoryDreamByAgent(config, projectRoot);

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 0 }),
    );
  });

  it('can read transcripts while keeping writes project-memory-only', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
    } satisfies ForkedAgentResult);

    await planManagedAutoMemoryDreamByAgent(config, projectRoot);
    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
    };
    const pm = params.config.getPermissionManager?.() as PermissionManager;

    await expect(
      pm.evaluate({
        toolName: ToolNames.GREP,
        filePath: getTranscriptDir(projectRoot),
      }),
    ).resolves.toBe('default');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getAutoMemoryRoot(projectRoot), 'project.md'),
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: ToolNames.EDIT,
        filePath: path.join(
          getAutoMemoryRoot(projectRoot),
          AUTO_MEMORY_PINNED_DIRNAME,
          'architecture.md',
        ),
      }),
    ).resolves.toBe('deny');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getUserAutoMemoryRoot(), 'user', 'a.md'),
      }),
    ).resolves.toBe('deny');
    // Pinned protection applies to write/edit; shell deletion is blocked by
    // the pre-existing read-only shell policy.
    await expect(
      pm.evaluate({
        toolName: ToolNames.SHELL,
        command: `rm ${path.join(
          getAutoMemoryRoot(projectRoot),
          AUTO_MEMORY_PINNED_DIRNAME,
          'architecture.md',
        )}`,
      }),
    ).resolves.toBe('deny');
  });

  it('throws when the agent fails', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'Model timed out',
      filesTouched: [],
    } satisfies ForkedAgentResult);

    await expect(
      planManagedAutoMemoryDreamByAgent(config, projectRoot),
    ).rejects.toThrow('Model timed out');
  });

  it('throws when the agent terminates as cancelled', async () => {
    // runForkedAgent maps AgentTerminateMode.CANCELLED to a resolved
    // `{status: 'cancelled'}` rather than a rejection. Without
    // re-throwing here, `runDreamByAgent` and downstream callers would
    // treat an aborted run as a normal completion — bumping
    // `lastDreamAt` metadata and overwriting a user-cancelled task
    // record with `'completed'`. The throw lets the manager's existing
    // catch path (which checks `signal.aborted && status === 'cancelled'`)
    // do the right thing.
    const mockResult: ForkedAgentResult = {
      status: 'cancelled',
      terminateReason: 'CANCELLED',
      filesTouched: [],
    };

    vi.mocked(runForkedAgent).mockResolvedValue(mockResult);

    await expect(
      planManagedAutoMemoryDreamByAgent(config, projectRoot),
    ).rejects.toThrow(/cancelled/i);
  });
});
