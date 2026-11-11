/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for the Read tool.
 *
 * The input carries `file_path`. The judgement itself is the read-shaped flow
 * shared with Glob and Grep (`file-check-flow.ts`); each tool keeps its own
 * entry so every checker is a standalone file.
 */

import { checkReadToolInput, logCheckedPaths } from '../file-check-flow.js';
import type { HostToolChecker } from '../rule-precedence.js';
import { READ_FILE_TOOL_NAME } from '../../tool-names.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../filesystem-permissions/internal-path-deps.js';

export function createReadToolChecker(
  deps: InternalPathDeps = qwenInternalPathDeps,
): HostToolChecker {
  return {
    check: (input, context) => {
      const ctx = {
        ...context,
        internalPaths:
          context.internalPaths ?? deps.resolve({ cwd: context.cwd }),
      };
      logCheckedPaths(
        READ_FILE_TOOL_NAME,
        input,
        ctx,
        ['file_path'],
        'file_path',
      );
      return checkReadToolInput(input, ctx);
    },
  };
}
export const readToolChecker = createReadToolChecker();
