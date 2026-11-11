/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Startup mode determination - pure function.
 * Consolidates the scattered mode detection from the TUI entry module into one place.
 */

import { isHeadlessMode } from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';

export type StartupMode =
  | { kind: 'acp' }
  | { kind: 'daemon' }
  | { kind: 'headless' }
  | { kind: 'interactive' };

/** 常驻 Host 不在进程启动时绑定会话项目。 */
export function isMultiSessionHost(
  argv: Pick<CliArgs, 'sdk' | 'acp'>,
): boolean {
  return !!(argv.sdk || argv.acp);
}

/**
 * 是否借用应用级共享运行期（插件与用户资源）。bare 与非交互短操作不借用；
 * 根入口的资源等待、scope 选择与 loadCliConfig 的插件接线共用这一判据。
 */
export function usesSharedRuntime(
  argv: Pick<
    CliArgs,
    | 'bare'
    | 'acp'
    | 'sdk'
    | 'listExtensions'
    | 'listSessions'
    | 'listModels'
    | 'deleteSession'
  >,
): boolean {
  return (
    !argv.bare &&
    !(
      !argv.acp &&
      !argv.sdk &&
      (argv.listExtensions ||
        argv.listSessions ||
        argv.listModels ||
        argv.deleteSession !== undefined)
    )
  );
}

/**
 * Determine the startup mode from parsed arguments and the SDK entrypoint environment.
 *
 * Priority order:
 * 1. daemon - product-supplied daemon flag (the commercial SDK entry uses --sdk)
 * 2. acp - --acp
 * 3. sdk - Agent SDK entrypoint env present + --print + stream-json I/O
 * 4. headless - explicit non-interactive flags without SDK entrypoint
 * 5. interactive - default REPL/TUI
 */
export function determineStartupMode(argv: CliArgs): StartupMode {
  // 1. Product daemon (the commercial SDK entry supplies --sdk).
  if (argv.sdk) {
    return { kind: 'daemon' };
  }

  // 2. ACP mode
  if (argv.acp) {
    return { kind: 'acp' };
  }

  // 3. Headless. Keep route selection aligned with Config's interactive
  // setting, including CI and stdin/stdout TTY detection.
  if (
    isHeadlessMode({
      prompt: argv.prompt,
      inputFormat: argv.inputFormat,
      print: argv.print,
    })
  ) {
    return { kind: 'headless' };
  }

  // 5. Interactive (default)
  return { kind: 'interactive' };
}
