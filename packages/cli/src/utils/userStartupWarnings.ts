/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { canUseRipgrep } from '@qwen-code/qwen-code-core/utils/ripgrepUtils.js';

const debugLogger = createDebugLogger('STARTUP_WARNINGS');

type WarningCheckOptions = {
  workspaceRoot: string;
  useRipgrep: boolean;
  useBuiltinRipgrep: boolean;
};

type WarningCheck = {
  id: string;
  check: (options: WarningCheckOptions) => Promise<string | null>;
};

// Individual warning checks
const rootDirectoryCheck: WarningCheck = {
  id: 'root-directory',
  check: async (options: WarningCheckOptions) => {
    try {
      const workspaceRealPath = await fs.realpath(options.workspaceRoot);
      const errorMessage =
        'Warning: You are running Qwen Code in the root directory. Your entire folder structure will be used for context. It is strongly recommended to run in a project-specific directory.';

      // Check for Unix root directory
      if (path.dirname(workspaceRealPath) === workspaceRealPath) {
        return errorMessage;
      }

      return null;
    } catch (_err: unknown) {
      return 'Could not verify the current directory due to a file system error.';
    }
  },
};

/**
 * The startup notice shown when ripgrep cannot be used.
 *
 * Deliberately a single actionable line, with none of the probe's own output: a
 * bundled binary that cannot run on the host prints its loader/allocator
 * diagnostics (`<jemalloc>: Unsupported system page size`, `memory allocation of
 * 160 bytes failed`, …), which in a terminal reads like Qwen Code itself ran out
 * of memory right before the user starts debugging (#13704). Nothing is lost by
 * keeping the banner to one line: `/doctor` reports the ripgrep state together
 * with the reason and the install hint, and `ripgrepAvailabilityCheck` also
 * writes the reason to the debug log — the latter only when
 * `QWEN_DEBUG_LOG_FILE` is enabled, which `--debug` sets and a default run does
 * not.
 */
const RIPGREP_UNAVAILABLE_WARNING =
  'Ripgrep not available: falling back to built-in grep, which is slower on large codebases. Install ripgrep for faster file content search.';

const ripgrepAvailabilityCheck: WarningCheck = {
  id: 'ripgrep-availability',
  check: async (options: WarningCheckOptions) => {
    if (!options.useRipgrep) {
      return null;
    }

    try {
      const isAvailable = await canUseRipgrep(options.useBuiltinRipgrep);
      return isAvailable ? null : RIPGREP_UNAVAILABLE_WARNING;
    } catch (error) {
      // A probe that threw and a probe that answered "no" leave the user in the
      // same place — built-in grep — so both get the same quiet notice. The
      // banner stays one line, but the reason has to survive somewhere, and on
      // this path nothing else records it: `resolveHealthyRipgrep` re-throws a
      // *system* rg failure before reaching its own `debugLogger.warn`, so an
      // empty `catch` would drop the only copy. (`/doctor` re-probes and reports
      // the reason on its own, but it does not run here.)
      debugLogger.warn(`Ripgrep probe failed: ${error}`);
      return RIPGREP_UNAVAILABLE_WARNING;
    }
  },
};

// All warning checks
const WARNING_CHECKS: readonly WarningCheck[] = [
  rootDirectoryCheck,
  ripgrepAvailabilityCheck,
];

export async function getUserStartupWarnings(
  options: WarningCheckOptions,
): Promise<string[]> {
  const results = await Promise.all(
    WARNING_CHECKS.map((check) => check.check(options)),
  );
  return results.filter((msg) => msg !== null);
}
