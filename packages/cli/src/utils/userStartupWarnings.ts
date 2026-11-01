/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GLOBAL_DIR_MARKER,
  OAUTH_FILE,
  QWEN_DIR,
  Storage,
} from '@qwen-code/qwen-code-core/config/storage.js';
import { tildeifyPath } from '@qwen-code/qwen-code-core/utils/paths.js';
import { canUseRipgrep } from '@qwen-code/qwen-code-core/utils/ripgrepUtils.js';

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

const ripgrepAvailabilityCheck: WarningCheck = {
  id: 'ripgrep-availability',
  check: async (options: WarningCheckOptions) => {
    if (!options.useRipgrep) {
      return null;
    }

    try {
      const isAvailable = await canUseRipgrep(options.useBuiltinRipgrep);
      if (!isAvailable) {
        return 'Ripgrep not available: Please install ripgrep globally to enable faster file content search. Falling back to built-in grep.';
      }
      return null;
    } catch (error) {
      return `Ripgrep not available: ${error instanceof Error ? error.message : 'Unknown error'}. Falling back to built-in grep.`;
    }
  },
};

// The files that decide whether the user is signed in.
const SIGN_IN_FILES = ['settings.json', OAUTH_FILE];

// Nothing reads ~/.qwen while the XDG directory is the global dir, so signing
// in from an install that still uses ~/.qwen (an older release that recreated
// it, say) looks like being signed out here. Say where those files are rather
// than read them: both installs would then refresh one Qwen OAuth token
// without a shared lock or file.
const legacyGlobalDirCheck: WarningCheck = {
  id: 'legacy-global-dir',
  check: async () => {
    const xdgDir = Storage.getXdgGlobalQwenDir();
    if (
      process.env['QWEN_HOME'] ||
      !xdgDir ||
      Storage.getGlobalQwenDir() !== xdgDir
    ) {
      return null;
    }
    const legacyDir = path.join(os.homedir(), QWEN_DIR);
    const files = SIGN_IN_FILES.filter(
      (file) =>
        existsSync(path.join(legacyDir, file)) &&
        !existsSync(path.join(xdgDir, file)),
    );
    if (files.length === 0) {
      return null;
    }
    const legacy = tildeifyPath(legacyDir);
    return (
      `${legacy} has ${files.join(' and ')} from another Qwen Code install, ` +
      `but this install uses ${tildeifyPath(xdgDir)} and does not read them. ` +
      `Run /auth to sign in here, or delete ` +
      `${tildeifyPath(path.join(xdgDir, GLOBAL_DIR_MARKER))} to use ${legacy} instead.`
    );
  },
};

// All warning checks
const WARNING_CHECKS: readonly WarningCheck[] = [
  rootDirectoryCheck,
  ripgrepAvailabilityCheck,
  legacyGlobalDirCheck,
];

export async function getUserStartupWarnings(
  options: WarningCheckOptions,
): Promise<string[]> {
  const results = await Promise.all(
    WARNING_CHECKS.map((check) => check.check(options)),
  );
  return results.filter((msg) => msg !== null);
}
