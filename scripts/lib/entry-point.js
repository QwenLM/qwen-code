/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module is the executed entry point rather than an import.
 *
 * `import.meta.url` is a percent-encoded file URL, so comparing it to a plain
 * `file://` + path breaks on spaces or non-ASCII characters. Both sides are
 * resolved through `realpath`, because Node resolves the entry module's
 * symlinks while `argv[1]` keeps the path the shell was given.
 */
export function isEntryPoint(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return (
      realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}
