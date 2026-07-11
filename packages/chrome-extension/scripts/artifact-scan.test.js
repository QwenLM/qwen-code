/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanArtifactRoots } from './artifact-scan.js';

describe('scanArtifactRoots', () => {
  it('accepts a generated payload without external adapter signatures', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-clean-'));
    try {
      mkdirSync(path.join(root, 'background'));
      writeFileSync(
        path.join(root, 'background/service-worker.js'),
        'console.log("qwen bridge");',
      );

      await expect(scanArtifactRoots([root])).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports external Chrome DevTools MCP source signatures', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-artifact-dirty-'));
    try {
      const file = path.join(root, 'adapter.js');
      writeFileSync(file, 'class McpContext { /* PageCollector */ }');

      await expect(scanArtifactRoots([root])).resolves.toEqual([
        { file, signature: 'class McpContext' },
        { file, signature: 'PageCollector' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
