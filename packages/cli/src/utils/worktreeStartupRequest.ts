/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ENV_WORKTREE_HANDLED,
  ENV_WORKTREE_INFO,
  parsePRReference,
  readBrandEnv,
  type Config,
  type TranscriptWorktreeSession,
  type WorktreeEnterResult,
  coreEvents,
} from '@qwen-code/core';

export type WorktreeStartupRequest =
  | {
      kind: 'create';
      name: string;
      originalCwd: string;
    }
  | {
      kind: 'restore-inherited';
      state: TranscriptWorktreeSession;
    };

export function resolveWorktreeStartupRequest(options: {
  requestedName: string | undefined;
  originalCwd: string;
  /** 非运行入口仍可读取有效 originalCwd，但不因损坏的继承状态阻断命令。 */
  strict?: boolean;
}): WorktreeStartupRequest | undefined {
  if (readBrandEnv(ENV_WORKTREE_HANDLED) === '1') {
    const inherited = parseInheritedWorktreeState(
      readBrandEnv(ENV_WORKTREE_INFO),
      options.originalCwd,
    );
    if (!inherited) {
      if (options.strict === false) return undefined;
      throw new Error(
        'Invalid inherited worktree information. Clear the worktree environment variables or repair the launch configuration before retrying.',
      );
    }
    return { kind: 'restore-inherited', state: inherited };
  }
  if (options.requestedName === undefined) {
    return undefined;
  }
  return {
    kind: 'create',
    name: options.requestedName,
    originalCwd: options.originalCwd,
  };
}

export async function applyWorktreeStartupRequest(
  config: Config,
  request: WorktreeStartupRequest,
  options: {
    record?: Config['recordWorktreeState'];
  } = {},
): Promise<WorktreeEnterResult | undefined> {
  if (!config.getSessionPersistence()) {
    throw new Error('Worktree entry requires session persistence.');
  }
  // 兼容变量只用于跨启动阶段传递请求；运行中的状态以 Config/JSONL 为准，
  // 不向后续子进程发布一个会在切换或退出后过期的全局副本。
  delete process.env[ENV_WORKTREE_HANDLED];
  delete process.env[ENV_WORKTREE_INFO];
  if (request.kind === 'restore-inherited') {
    const restored = await config.restoreWorktree(
      {
        ...request.state,
        sessionId: config.getSessionId(),
        lifecycle: 'attached',
      },
      options.record,
    );
    if (restored.status === 'failed') {
      throw new Error(restored.message);
    }
    if (restored.status === 'restored') {
      return restored.settings;
    }
    return undefined;
  }

  const name = request.name.trim();
  const prNumber = parsePRReference(name);
  const settings = await config.enterWorktree(
    {
      kind: 'create',
      name: prNumber === null ? name : `pr-${prNumber}`,
      ...(prNumber !== null ? { options: { prNumber } } : {}),
    },
    options.record,
  );
  if (settings.entryWarning) {
    coreEvents.emitFeedback('warning', settings.entryWarning);
  }
  return settings;
}

function parseInheritedWorktreeState(
  serialized: string | undefined,
  fallbackOriginalCwd: string,
): TranscriptWorktreeSession | undefined {
  if (!serialized) {
    return undefined;
  }
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const stringValue = (key: string): string | undefined => {
      const candidate = value[key];
      return typeof candidate === 'string' ? candidate : undefined;
    };
    const worktreeName = stringValue('name');
    const worktreePath = stringValue('path');
    if (!worktreeName || !worktreePath) {
      return undefined;
    }
    const originalCwd = stringValue('originalCwd') ?? fallbackOriginalCwd;
    const hookBased = value['hookBased'];
    return {
      originalCwd,
      worktreePath,
      // 旧启动契约没有此字段，由 restore 按原项目子目录统一推导。
      worktreeCwd: stringValue('worktreeCwd'),
      worktreeName,
      worktreeBranch: stringValue('worktreeBranch'),
      originalBranch: stringValue('originalBranch'),
      originalHeadCommit:
        stringValue('originalHeadCommit') ?? stringValue('baseSha'),
      sessionId: stringValue('sessionId') ?? 'inherited',
      lifecycle: 'attached',
      hookBased:
        hookBased === true || hookBased === false ? hookBased : undefined,
      enteredExisting: true,
    };
  } catch {
    return undefined;
  }
}
