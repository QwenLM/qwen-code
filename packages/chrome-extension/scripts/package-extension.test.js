/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZipEntries, scanZipArtifact } from './artifact-scan.js';
import { packageExtension } from './package-extension.js';

describe('packageExtension', () => {
  it('recreates the archive without stale entries', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-extension-package-'));
    const source = path.join(root, 'extension');
    const archive = path.join(root, 'extension.zip');
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, 'stale.js'), 'stale');
      await packageExtension({ source, archive });

      rmSync(path.join(source, 'stale.js'));
      writeFileSync(path.join(source, 'current.js'), 'current');
      await packageExtension({ source, archive });

      const entries = await readZipEntries(archive);
      expect(entries.map((entry) => entry.name)).toEqual(['current.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the release scanner inspect the packaged contents', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-extension-scan-'));
    const source = path.join(root, 'extension');
    const archive = path.join(root, 'extension.zip');
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, 'adapter.js'), 'class McpContext {}');
      await packageExtension({ source, archive });

      await expect(scanZipArtifact(archive)).resolves.toEqual([
        {
          file: `${archive}:adapter.js`,
          signature: 'class McpContext',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
