/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Check tables for forks that are narrower than any rule set can express.
 *
 * Background forks need policies that are not "which tools" but "which
 * calls": autoDream may read anywhere, run shell commands only when they are
 * read-only, and write only inside one directory. Independent memory forks
 * confine both reads and writes to scoped roots. These forks replace entries
 * in the check table to enforce their call-level boundaries.
 *
 * Scoped read/write checkers only narrow the standard check. AutoDream's
 * checker replacements return their final verdict directly so a normal
 * workspace prompt cannot block the background fork.
 */

import {
  isPowerShellReadOnly,
  checkPowerShellPermission,
} from '../shell-permissions/powerShellPermissions.js';
import { withReadProbe } from './rule-precedence.js';
import path from 'node:path';
import { checkReadOnlyShellCommand } from '../shell-permissions/shellReadOnlyValidation.js';
import type { HostToolChecker } from './rule-precedence.js';
import type {
  PermissionUpdate,
  ToolPermissionExtra,
  ToolPermissionReason,
} from './checker-reasons.js';
import type {
  ToolCheckContext,
  ToolCheckResult,
} from '../../permissions/manager/decision/index.js';
import {
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tool-names.js';
import { createReadToolChecker } from './checkers/read-checker.js';
import { createWriteToolChecker } from './checkers/write-checker.js';
import { withCheckLog } from './check-logger.js';
import { withHookAsk, withToolLevelRules } from './rule-precedence.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../filesystem-permissions/internal-path-deps.js';

function absoluteToolPath(filePath: unknown, cwd: string): string | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return undefined;
  }
  return path.resolve(cwd, filePath);
}

function isPathInsideDirectory(filePath: string, dir: string): boolean {
  const relative = path.relative(dir, path.normalize(filePath));
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

type HostCheckResult = ToolCheckResult<
  ToolPermissionReason,
  ToolPermissionExtra,
  PermissionUpdate
>;

function refuse(message: string, decisionPoint: string): HostCheckResult {
  return {
    kind: 'deny',
    extra: {
      decisionPoint,
      denialReason: {
        message,
        attribution: {
          type: 'safetyCheck',
          reason: message,
          safetyCheckKind: decisionPoint,
        },
        denialKind: 'permission-rule',
        decisionPoint,
      },
    },
  };
}

/**
 * Allow a shell call only when the command reads and does not write.
 *
 * The judgement is the same `checkReadOnlyShellCommand` the rest of the host
 * uses, so a command classified as read-only here is the same set of commands
 * classified as read-only everywhere else.
 */
export function readOnlyShellChecker(
  shell: 'bash' | 'powershell' = 'bash',
  internalPaths: InternalPathDeps = qwenInternalPathDeps,
): HostToolChecker {
  return {
    async check(input: Record<string, unknown>, ctx) {
      const command = input['command'];
      if (typeof command !== 'string') {
        return refuse(
          'This context only permits read-only shell commands, and this call names no command.',
          'fork.shell.no_command.deny',
        );
      }

      const decision =
        shell === 'powershell'
          ? {
              readonly: await isPowerShellReadOnly(command, { cwd: ctx.cwd }),
              reason: 'PowerShell command is not read-only',
            }
          : checkReadOnlyShellCommand(command);
      if (!decision.readonly) {
        return refuse(
          `Only read-only shell commands are permitted in this context: ${decision.reason}`,
          'fork.shell.not_read_only.deny',
        );
      }

      if (shell === 'powershell') {
        return checkPowerShellPermission(
          { command, executionCwd: ctx.cwd, permissionCwd: ctx.cwd },
          {
            ...ctx,
            internalPaths:
              ctx.internalPaths ?? internalPaths.resolve({ cwd: ctx.cwd }),
          },
          POWERSHELL_TOOL_NAME,
        );
      }

      return {
        kind: 'allow',
        extra: {
          decisionPoint: 'fork.shell.read_only.allow',
        },
      };
    },
  };
}

/**
 * Let a fork read anywhere without running the standard path checker.
 *
 * The outer rule and mode layers still run before this checker. The checker
 * itself deliberately bypasses the normal workspace-path prompt.
 */
export function unrestrictedReadChecker(): HostToolChecker {
  return {
    async check() {
      return {
        kind: 'allow',
        extra: {
          decisionPoint: 'fork.read.unrestricted.allow',
        },
      };
    },
  };
}

/**
 * Auto-approve a write inside one directory and deny every other target.
 *
 * Unlike directoryScopedWriteChecker, this is a final Dream verdict: the
 * memory directory can live outside the workspace and must not trigger an ask.
 */
export function directoryAutoApproveWriteChecker(
  directory: string,
): HostToolChecker {
  return {
    async check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ) {
      const filePath = absoluteToolPath(input['file_path'], ctx.cwd);
      if (!filePath || !isPathInsideDirectory(filePath, directory)) {
        return refuse(
          `Writing is only allowed within ${directory} in this context.`,
          'fork.write.outside_directory.deny',
        );
      }

      return {
        kind: 'allow',
        extra: { decisionPoint: 'fork.write.memory_directory.allow' },
      };
    },
  };
}

/**
 * Allow a write only when its target sits inside one directory.
 *
 * Expressed as a check rather than an `Edit(//dir/**)` allow rule because an
 * allow rule only vouches — it would not stop a write elsewhere, it would just
 * fail to grant it, and the fork's refusing ask handler would then be the only
 * thing standing in the way. A denial is the honest shape for "this fork may
 * not write there".
 */
export function directoryScopedWriteChecker(
  inner: HostToolChecker,
  directory: string | readonly string[],
): HostToolChecker {
  const directories = Array.isArray(directory) ? directory : [directory];
  return {
    async check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ) {
      const filePath = absoluteToolPath(input['file_path'], ctx.cwd);
      if (
        !filePath ||
        !directories.some((dir) => isPathInsideDirectory(filePath, dir))
      ) {
        return refuse(
          `Writing is only allowed within ${directories.join(', ')} in this context.`,
          'fork.write.outside_directory.deny',
        );
      }

      return inner.check(input, ctx);
    },
  };
}

/**
 * Allow a read only when its target sits inside one of the given directories.
 * The read-side twin of the write checker: the independent memory fork must
 * not look outside its scoped roots either.
 */
export function directoryScopedReadChecker(
  inner: HostToolChecker,
  directory: string | readonly string[],
): HostToolChecker {
  const directories = Array.isArray(directory) ? directory : [directory];
  return {
    async check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ) {
      const filePath = absoluteToolPath(input['file_path'], ctx.cwd);
      if (
        !filePath ||
        !directories.some((dir) => isPathInsideDirectory(filePath, dir))
      ) {
        return refuse(
          `Reading is only allowed within ${directories.join(', ')} in this context.`,
          'fork.read.outside_directory.deny',
        );
      }

      return inner.check(input, ctx);
    },
  };
}

export interface ForkCheckerMapOptions {
  readonly internalPaths?: InternalPathDeps;
  /** Auto-approve Read, Glob and Grep without a workspace-path check. */
  unrestrictedRead?: boolean;
  /** Include a shell checker, narrowed so only read-only commands pass. */
  readOnlyShell?: boolean;
  /** Include the write checkers, narrowed to this directory. */
  writeDirectory?: string;
  /**
   * Confine reads AND writes to these roots. Stronger than writeDirectory:
   * the fork may not even look outside its roots. The independent memory
   * fork uses it; glob and grep are left out — a confined fork has nothing
   * to search beyond what it can already read.
   */
  readWriteDirectories?: readonly string[];
  /** Names the fork in the permission-check log lines. */
  label?: string;
}

/**
 * The whole table a restricted fork runs on.
 *
 * Built here rather than layered over the session's table, because the component
 * refuses any tool the table has no entry for — so a table holding only the
 * fork's tools *is* the fork's allowlist. That turns the old callback's
 * catch-all "anything else is denied" into a structural fact, and it means a tool
 * added to the product later is refused to the fork until someone decides it
 * belongs there.
 *
 * Read, glob and grep are always present: a fork that cannot look at anything
 * has nothing to summarise.
 */
export function buildForkCheckerMap(
  options: ForkCheckerMapOptions,
): Map<string, HostToolChecker> {
  const internalPaths = options.internalPaths ?? qwenInternalPathDeps;
  const readToolChecker = createReadToolChecker(internalPaths);
  const writeToolChecker = createWriteToolChecker(internalPaths);
  const map = new Map<string, HostToolChecker>();

  // 模式落定由会话的 `bindMode` 统一完成，fork 表只保留工具级规则与 hook ask。
  const label = options.label ?? 'fork';
  const register = (name: string, checker: HostToolChecker): void => {
    map.set(
      name,
      withReadProbe(
        withCheckLog(
          `${label} ${name}`,
          withHookAsk(withToolLevelRules(name, checker)),
        ),
        withToolLevelRules(name, checker),
      ),
    );
  };

  // Read, glob and grep are otherwise always present: a fork that cannot look
  // at anything has nothing to summarise.
  for (const name of [READ_FILE_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]) {
    register(
      name,
      options.unrestrictedRead ? unrestrictedReadChecker() : readToolChecker,
    );
  }

  if (options.readOnlyShell) {
    register(SHELL_TOOL_NAME, readOnlyShellChecker('bash', internalPaths));
    register(
      POWERSHELL_TOOL_NAME,
      readOnlyShellChecker('powershell', internalPaths),
    );
  }

  if (options.writeDirectory) {
    for (const name of [WRITE_FILE_TOOL_NAME, EDIT_TOOL_NAME]) {
      register(name, directoryAutoApproveWriteChecker(options.writeDirectory));
    }
  }

  if (options.readWriteDirectories?.length) {
    // Confined roots supersede the open reading set above: reads narrow to the
    // roots and glob/grep disappear — a confined fork does not search.
    map.delete(GLOB_TOOL_NAME);
    map.delete(GREP_TOOL_NAME);
    register(
      READ_FILE_TOOL_NAME,
      directoryScopedReadChecker(readToolChecker, options.readWriteDirectories),
    );
    for (const name of [
      WRITE_FILE_TOOL_NAME,
      EDIT_TOOL_NAME,
      NOTEBOOK_EDIT_TOOL_NAME,
    ]) {
      register(
        name,
        directoryScopedWriteChecker(
          writeToolChecker,
          options.readWriteDirectories,
        ),
      );
    }
  }

  return map;
}
