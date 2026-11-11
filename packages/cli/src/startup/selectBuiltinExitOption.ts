/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CliArgs } from '../config/config.js';

type BuiltinExitOption =
  | 'listExtensions'
  | 'listSessions'
  | 'listModels'
  | 'deleteSession';

/** Shared selection for the existing root commands that exit after startup. */
export function selectBuiltinExitOption(
  argv: Partial<Pick<CliArgs, BuiltinExitOption>>,
): BuiltinExitOption | undefined {
  if (argv.listExtensions === true) return 'listExtensions';
  if (argv.listSessions === true) return 'listSessions';
  if (argv.listModels === true) return 'listModels';
  if (argv.deleteSession !== undefined) return 'deleteSession';
  return undefined;
}
