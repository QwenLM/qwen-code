/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import type {
  ShellExecutionHandle,
  ShellExecutionConfig,
  ShellExecuteOptions,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { getShellContextEnvVars } from '../services/shellContextEnv.js';
import { sanitizeChildEnv } from '../utils/sanitize-child-env.js';
import { getShellPagerEnv } from '../utils/shell-pager-env.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';
import { executeBwrap } from './bwrap-execution.js';
import { assertShellSandboxCwd } from './runtime-shell-policy.js';

export function executeRuntimeShell(
  runtime: Config,
  command: string,
  cwd: string,
  onOutput: (event: ShellOutputEvent) => void,
  signal: AbortSignal,
  usePty: boolean,
  config: ShellExecutionConfig = {},
  options: ShellExecuteOptions = {},
): Promise<ShellExecutionHandle> {
  const policy = runtime.getShellExecutionSandbox?.();
  if (!policy) {
    return ShellExecutionService.execute(
      command,
      cwd,
      onOutput,
      signal,
      usePty,
      config,
      options,
    );
  }
  try {
    assertShellSandboxCwd(policy, runtime.getTargetDir());
    assertShellSandboxCwd(policy, cwd);
    const env = Object.fromEntries(
      Object.entries({
        ...sanitizeChildEnv(process.env),
        QWEN_CODE: '1',
        TERM: 'xterm-256color',
        ...getShellPagerEnv(config.pager, {
          includeGitPager: usePty,
          platform: 'linux',
        }),
        ...sessionIdContext.run(runtime.getSessionId(), getShellContextEnvVars),
        QWEN_CODE_SESSION_ID: runtime.getSessionId(),
        QWEN_CODE_PROJECT_DIR: runtime.storage.getProjectDir(),
        PWD: cwd,
      }).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    return executeBwrap(
      policy,
      { executable: '/bin/bash', args: ['-c', command], cwd, env },
      onOutput,
      signal,
      usePty,
      config,
      options,
    );
  } catch (error) {
    return Promise.reject(error);
  }
}
