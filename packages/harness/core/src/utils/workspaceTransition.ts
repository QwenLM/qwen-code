/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { notifyCwdChanged } from './Shell.js';
import type { Config } from '../config/config.js';

interface WorkspaceRuntime {
  getWorkingDir(): string;
  getWorkspaceContext(): { getDirectories(): readonly string[] };
}

function captureWorkspace(runtime: WorkspaceRuntime) {
  return {
    cwd: runtime.getWorkingDir(),
    directories: [...runtime.getWorkspaceContext().getDirectories()],
  };
}

const transitions = new WeakMap<
  WorkspaceRuntime,
  {
    workspace: ReturnType<typeof captureWorkspace>;
    pending: number;
    committed: boolean;
  }
>();

/** 产物操作只消费已提交的目录，不因临时投影或回滚删除已有索引。 */
export function getCommittedWorkspace(runtime: WorkspaceRuntime) {
  return transitions.get(runtime)?.workspace ?? captureWorkspace(runtime);
}

/** 仅协调内存可见性和通知；运行态及持久化的回滚仍由调用方负责。 */
export async function runWithWorkspaceTransition<T>(
  runtime: WorkspaceRuntime & Pick<Config, 'getHookSystem'>,
  operation: () => Promise<T>,
): Promise<T> {
  const transition = transitions.get(runtime) ?? {
    workspace: captureWorkspace(runtime),
    pending: 0,
    committed: false,
  };
  transition.pending++;
  transitions.set(runtime, transition);
  try {
    const result = await operation();
    transition.committed = true;
    return result;
  } finally {
    // TUI 外层和 Core 内层共享边界；其他尚未结束的切换也不能提前暴露临时目录。
    if (--transition.pending === 0) {
      transitions.delete(runtime);
      if (
        transition.committed &&
        transition.workspace.cwd !== runtime.getWorkingDir()
      ) {
        notifyCwdChanged(
          transition.workspace.cwd,
          runtime.getWorkingDir(),
          runtime.getHookSystem()?.onCwdChanged ?? null,
        );
      }
    }
  }
}
