/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for the Glob tool.
 *
 * The input carries `pattern` and an optional `path`. The judgement is the
 * read-shaped flow shared with Read and Grep (`file-check-flow.ts`); each tool
 * keeps its own entry so every checker is a standalone file.
 */

import { checkReadToolInput, logCheckedPaths } from '../file-check-flow.js';
import type { HostToolChecker } from '../rule-precedence.js';
import { stringField } from '../content-checkers.js';
import { GLOB_TOOL_NAME } from '../../tool-names.js';
import { resolveSearchRoot } from '../../../utils/searchPaths.js';
import {
  isNetworkPathEnforced,
  isNetworkShapedPath,
} from '../../../utils/pathShape.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../filesystem-permissions/internal-path-deps.js';

export function createGlobToolChecker(
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
      // Glob patterns can name filesystem locations. Grep patterns are content
      // regular expressions, so this check belongs only to Glob.
      const pattern = stringField(input, 'pattern');
      if (pattern && isNetworkPathEnforced() && isNetworkShapedPath(pattern)) {
        return {
          kind: 'ask',
          reason: {
            message: `This search pattern names a network location and requires confirmation: ${pattern}`,
            attribution: {
              type: 'other',
              reason: 'Network glob pattern requires confirmation',
            },
            decisionPoint: 'fs_read.network_glob_pattern.ask',
          },
        };
      }

      const resolvedInput = {
        ...input,
        path: resolveSearchRoot(
          stringField(input, 'path'),
          getSearchCwd?.() ?? ctx.cwd,
          stringField(input, 'pattern'),
        ),
      };
      logCheckedPaths(
        GLOB_TOOL_NAME,
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

export const globToolChecker = createGlobToolChecker();
