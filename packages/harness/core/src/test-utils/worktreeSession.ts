/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { TranscriptStore } from '../services/transcript/store.js';
import type { FileHistoryManager } from '../file-history/file-history.js';
import type { WorktreeSettings } from '../services/worktree/contracts.js';

// 共享可观察的运行态夹具，避免各生命周期测试维护不同的 Config 投影。
interface RuntimeState {
  targetDir: string;
  workingDir: string;
  worktreeSettings: WorktreeSettings | undefined;
  workspaceDirectories: string[];
  fileHistoryManager?: FileHistoryManager;
}

export function createRuntimeConfig(
  cwd: string,
  workspaceDirectories: string[] = [cwd],
): { config: Config; state: RuntimeState } {
  const state: RuntimeState = {
    targetDir: cwd,
    workingDir: cwd,
    worktreeSettings: undefined,
    workspaceDirectories,
  };
  const workspaceContext = {
    getDirectories: vi.fn(() => state.workspaceDirectories),
    setDirectories: vi.fn((directories: readonly string[]) => {
      state.workspaceDirectories = [...directories];
    }),
  };
  const transcriptStore = new TranscriptStore();
  const hookSystem = { onCwdChanged: vi.fn() };
  const config = {
    getHookSystem: () => hookSystem,
    getTranscriptStore: vi.fn(() => transcriptStore),
    getActiveSessionTranscriptPath: vi.fn(() => path.join(cwd, 'session-1.jsonl')),
    getTargetDir: vi.fn(() => state.targetDir),
    setTargetDir: vi.fn((directory: string) => {
      state.targetDir = directory;
    }),
    getWorkingDir: vi.fn(() => state.workingDir),
    setWorkingDir: vi.fn((directory: string) => {
      state.workingDir = directory;
    }),
    getWorktreeSettings: vi.fn(() => state.worktreeSettings),
    setWorktreeSettings: vi.fn((settings: WorktreeSettings | undefined) => {
      state.worktreeSettings = settings;
    }),
    getWorkspaceContext: vi.fn(() => workspaceContext),
    refreshRuntimeWorkspaceServices: vi.fn(),
    synchronizeWorktreeRuntimeState: vi.fn(),
    getFileHistoryManager: vi.fn(() => state.fileHistoryManager),
    getPromptAssembler: vi.fn(() => undefined),
    getSessionId: vi.fn(() => 'session-1'),
  } as unknown as Config;
  return { config, state };
}
// mock 注册仍由测试文件负责，工厂不依赖被替换模块的运行时初始化。
export function createWorktreeServiceMock(
  actual: typeof import('../services/worktreeService.js'),
) {
  return {
    ...actual,
    cleanupCreatedWorktreeForSession: vi.fn(),
    createWorktreeForSession: vi.fn(),
    cleanupWorktreeSession: vi.fn(),
    countWorktreeChanges: vi.fn(),
    readWorktreeBaseCommit: vi.fn().mockResolvedValue(undefined),
    findProjectRootForWorktree: vi.fn(),
    resolveExistingWorktreeForSession: vi.fn(),
  };
}

export function createWorktreeOwnerMock() {
  return {
    claimWorktreeOwnership: vi.fn(),
    claimReusableWorktreeOwnership: vi.fn().mockResolvedValue('owned'),
    getWorktreeEntryOwnership: vi.fn().mockResolvedValue('claim'),
    getWorktreeOwnerClaimId: vi.fn().mockReturnValue('test-claim'),
    rollbackReusableWorktreeOwnership: vi.fn().mockResolvedValue(undefined),
    hasRegisteredWorktree: vi.fn().mockResolvedValue(false),
    inspectWorktreeOwnership: vi.fn(),
    isWorktreeOwnedBySession: vi.fn(),
    readWorktreeOwnerState: vi.fn(),
    releaseWorktreeOwnershipForHandoff: vi.fn(),
    releaseWorktreeOwnership: vi.fn(),
  };
}
