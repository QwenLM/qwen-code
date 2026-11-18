/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const mode = process.env['MANAGED_LOOP_MODE'] ?? 'shared';
if (mode !== 'shared' && mode !== 'kernel') {
  throw new Error(`Unknown MANAGED_LOOP_MODE: ${mode}`);
}

export const loopEnv = {
  QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: '1',
  QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP: mode === 'kernel' ? '1' : '0',
  QWEN_DEBUG_LOG_FILE: '1',
};

export async function debugLog(runtimeDir: string): Promise<string> {
  const dir = path.join(runtimeDir, 'debug');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
        .map((entry) => readFile(path.join(dir, entry.name), 'utf8')),
    )
  ).join('\n');
}

export async function saveEvidence(surface: string, evidence: unknown) {
  const dir = path.resolve(
    process.env['MANAGED_LOOP_REPORT_DIR'] ?? '../.qwen/managed-loop-reports',
    mode,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${surface}.json`),
    JSON.stringify({ mode, surface, evidence }, null, 2),
  );
}
