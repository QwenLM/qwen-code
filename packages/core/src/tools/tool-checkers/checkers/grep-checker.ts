/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for the Grep tool.
 *
 * The input carries `pattern` and an optional `path`. The judgement is the
 * read-shaped flow shared with Read and Glob (`file-check-flow.ts`); each tool
 * keeps its own entry so every checker is a standalone file.
 */

import { checkReadToolInput, logCheckedPaths } from '../file-check-flow.js';
import type { HostToolChecker } from '../rule-precedence.js';
import { stringField } from '../content-checkers.js';
import { GREP_TOOL_NAME } from '../../tool-names.js';
import { resolveSearchRoot } from '../../../utils/searchPaths.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../filesystem-permissions/internal-path-deps.js';

export function createGrepToolChecker(
  getSearchCwd?: () => string,
  internalPaths: InternalPathDeps = qwenInternalPathDeps,
): HostToolChecker {
  return {
    check: (input, context) => {
      const ctx = {
        ...context,
        internalPaths:
          context.internalPaths ?? internalPaths.resolve({ cwd: context.cwd }),
      };
      const resolvedInput = {
        ...input,
        path: resolveSearchRoot(
          stringField(input, 'path'),
          getSearchCwd?.() ?? ctx.cwd,
        ),
      };
      logCheckedPaths(
        GREP_TOOL_NAME,
        input,
        ctx,
        ['path', 'pattern'],
        'path',
        resolvedInput.path,
      );
      return checkReadToolInput(resolvedInput, ctx);
    },
  };
}

export const grepToolChecker = createGrepToolChecker();
