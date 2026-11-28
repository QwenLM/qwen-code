/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for the NotebookEdit tool.
 *
 * The input carries `notebook_path`. The judgement is the write-shaped flow
 * shared with Write and Edit (`file-check-flow.ts`); each tool keeps its own
 * entry so every checker is a standalone file.
 */

import { checkWriteToolInput, logCheckedPaths } from '../file-check-flow.js';
import type { HostToolChecker } from '../rule-precedence.js';
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tool-names.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../filesystem-permissions/internal-path-deps.js';

export function createNotebookEditToolChecker(
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
        NOTEBOOK_EDIT_TOOL_NAME,
        input,
        ctx,
        ['notebook_path'],
        'notebook_path',
      );
      return checkWriteToolInput(input, ctx);
    },
  };
}
export const notebookEditToolChecker = createNotebookEditToolChecker();
