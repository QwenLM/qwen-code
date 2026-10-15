/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Managed CSI checkpoint evidence entry', () => {
  it.each([
    ['malformed', 'record is not valid JSON.'],
    ['oversized', 'Snapshot exceeds its size limit.'],
    ['missing', 'ENOENT'],
    ['invalid', 'snapshot format is unsupported.'],
  ] as const)('emits unresolved JSON for %s input', (kind, reason) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qwen-csi-evidence-'));
    const file = path.join(directory, 'snapshot.json');
    try {
      if (kind !== 'missing') {
        writeFileSync(file, kind === 'malformed' ? '{' : '{}');
        if (kind === 'oversized') truncateSync(file, 48 * 1024 * 1024 + 1);
      }
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          fileURLToPath(
            new URL('./managed-csi-checkpoint-evidence.ts', import.meta.url),
          ),
          file,
        ],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: fileURLToPath(
              new URL('../../tsconfig.json', import.meta.url),
            ),
          },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        status: 'unresolved',
        reason: expect.stringContaining(reason),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
