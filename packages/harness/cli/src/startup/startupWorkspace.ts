/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  traceStartupStep,
  StartupDiagnostics,
  resolveLatestSameRepoTranscriptSession,
  resolveSameRepoTranscriptSession,
  isHeadlessMode,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import {
  resolveWorktreeStartupRequest,
  type WorktreeStartupRequest,
} from '../utils/worktreeStartupRequest.js';
import { createSessionBootstrap } from './startupContext.js';
import { homedir } from 'node:os';
import { isMultiSessionHost } from './determineStartupMode.js';

export type StartupWorkspaceArgs = Partial<
  Pick<
    CliArgs,
    | 'continue'
    | 'resume'
    | 'sessionId'
    | 'acp'
    | 'sdk'
    | 'listExtensions'
    | 'listSessions'
    | 'listModels'
    | 'deleteSession'
    | 'print'
    | 'prompt'
    | 'inputFormat'
  >
>;

export interface StartupWorkspace {
  resourceRoot: string;
  /** 复用加载项目环境前解析的继承信息；显式名称留到正式 argv 归一化后处理。 */
  inheritedWorktreeRequest?: WorktreeStartupRequest;
  resumeSelection?: PromiseSettledResult<
    Awaited<ReturnType<typeof resolveSameRepoTranscriptSession>>
  >;
}

// 在加载会话项目 .env/Settings 前确定归属；后续 Resume 复用精确选择。
export async function resolveStartupWorkspace(
  argv: StartupWorkspaceArgs,
  launchCwd?: string,
): Promise<StartupWorkspace> {
  // Host 的 cwd 由后续开会话请求提供。此时不解析继承 Worktree 或发现历史会话。
  if (isMultiSessionHost(argv)) {
    return { resourceRoot: homedir() };
  }
  const cwd = launchCwd ?? process.cwd();
  // 与根命令的早退顺序一致：ACP 优先于列表等选项。
  const optionExit = !argv.acp && (
    argv.listExtensions === true ||
    argv.listSessions === true ||
    argv.listModels === true ||
    argv.deleteSession !== undefined
  );
  const inherited = traceStartupStep('workspace.inherited_worktree', () => resolveWorktreeStartupRequest({
    requestedName: undefined,
    originalCwd: cwd,
    strict: !optionExit,
  }));
  const resourceRoot =
    inherited?.kind === 'restore-inherited'
      ? inherited.state.originalCwd
      : cwd;
  // 普通新会话、选择器与外部运行入口不额外发现历史 Worktree。
  if (
    optionExit ||
    argv.acp ||
    argv.sdk ||
    !(argv.continue || argv.resume?.trim())
  ) {
    return { resourceRoot, inheritedWorktreeRequest: inherited };
  }
  const { initialSessionId } = createSessionBootstrap(argv);
  const diagnostics = new StartupDiagnostics(initialSessionId, resourceRoot);
  try {
    const value = await diagnostics.phase(
      argv.continue ? 'workspace.continue_lookup' : 'workspace.resume_lookup',
      () =>
        argv.continue
          ? resolveLatestSameRepoTranscriptSession(resourceRoot, initialSessionId)
          : resolveSameRepoTranscriptSession(
              resourceRoot,
              argv.resume!.trim(),
              initialSessionId,
            ),
    );
    const resolvedResourceRoot =
      value.sessionInfo.worktreeSession?.originalCwd ??
      value.sessionInfo.originalCwd ??
      value.sessionInfo.transcriptProjectRoot ??
      resourceRoot;
    // HeadlessSession owns a fresh resume read. Discovery must not retain its
    // admission lease or replay payload while that session is running.
    if (isHeadlessMode(argv)) {
      value.resumeAttempt?.finish();
      return {
        inheritedWorktreeRequest: inherited,
        resourceRoot: resolvedResourceRoot,
      };
    }
    return {
      inheritedWorktreeRequest: inherited,
      resourceRoot: resolvedResourceRoot,
      resumeSelection: { status: 'fulfilled', value },
    };
  } catch (reason) {
    // 保留原有 Resume 错误展示与退出路径，不在预解析阶段重复报错。
    return {
      resourceRoot,
      inheritedWorktreeRequest: inherited,
      resumeSelection: { status: 'rejected', reason },
    };
  }
}
