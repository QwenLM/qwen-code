/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isHeadlessMode } from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import type { StartupMode } from './determineStartupMode.js';

type StartupPreloadArgs = Pick<
  CliArgs,
  | 'acp'
  | 'deleteSession'
  | 'headlessFastHooks'
  | 'includePartialMessages'
  | 'inputFormat'
  | 'listExtensions'
  | 'listModels'
  | 'listSessions'
  | 'outputFormat'
  | 'print'
  | 'prompt'
  | 'rawOutput'
  | 'acceptRawOutputRisk'
  | 'replayUserMessages'
>;

function hasPostConfigExitFlag(argv: StartupPreloadArgs): boolean {
  return (
    !!argv.listExtensions ||
    !!argv.listSessions ||
    !!argv.listModels ||
    argv.deleteSession !== undefined
  );
}

function hasHeadlessOnlyFlag(argv: StartupPreloadArgs): boolean {
  return (
    (!!argv.outputFormat && argv.outputFormat !== 'text') ||
    !!argv.includePartialMessages ||
    !!argv.replayUserMessages ||
    !!argv.rawOutput ||
    !!argv.acceptRawOutputRisk ||
    !!argv.headlessFastHooks
  );
}

export function shouldEagerPreloadInteractiveUI(
  startupMode: StartupMode,
  argv: StartupPreloadArgs,
): boolean {
  if (startupMode.kind !== 'interactive') {
    return false;
  }

  if (
    isHeadlessMode({
      prompt: argv.prompt,
      inputFormat: argv.inputFormat,
      print: argv.print,
    })
  ) {
    return false;
  }

  if (
    argv.acp ||
    hasPostConfigExitFlag(argv) ||
    hasHeadlessOnlyFlag(argv)
  ) {
    return false;
  }

  return true;
}
