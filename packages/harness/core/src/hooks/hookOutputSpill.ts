/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRAND_TEMP_PATH_SLUG } from '../config/brand.js';

/**
 * Writes hook output that exceeds the in-memory limit to a temporary file.
 * Returns the absolute path to the spilled file.
 *
 * The file is written to `<tmpdir>/<brand>-hook-output/` with a unique name.
 */
export function spillHookOutputToFile(content: string): string {
  const spillDir = path.join(os.tmpdir(), `${BRAND_TEMP_PATH_SLUG}-hook-output`);
  fs.mkdirSync(spillDir, { recursive: true });

  const fileName = `hook-output-${randomUUID()}.txt`;
  const filePath = path.join(spillDir, fileName);
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });

  return filePath;
}
