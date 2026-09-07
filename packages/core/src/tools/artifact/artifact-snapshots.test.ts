/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readArtifactSnapshot,
  saveArtifactSnapshot,
} from './artifact-snapshots.js';
import { MAX_ARTIFACT_BYTES } from './html.js';

describe('saved Artifact versions', () => {
  let runtime: string;
  beforeEach(async () => {
    runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-snapshot-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', runtime);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  it('saves distinct invocations, preserving exact UTF-8 bytes after later saves', async () => {
    const html = '<h1>第一版</h1><script>let count=0</script>';
    const first = await saveArtifactSnapshot(
      html,
      'Page',
      'https://example.com/latest',
    );
    const repeated = await saveArtifactSnapshot(
      html,
      'Page',
      'https://example.com/latest',
    );
    const second = await saveArtifactSnapshot(
      '<h1>第二版</h1>',
      'Page',
      'https://example.com/latest',
    );
    expect(
      new Set([first.managedId, repeated.managedId, second.managedId]).size,
    ).toBe(3);
    await expect(readArtifactSnapshot(first, runtime)).resolves.toBe(html);
    await expect(readArtifactSnapshot(second, runtime)).resolves.toBe(
      '<h1>第二版</h1>',
    );
    await expect(
      readArtifactSnapshot(first, path.join(runtime, 'other')),
    ).rejects.toThrow();
  });

  it('rejects missing, changed and oversized files without reading latest', async () => {
    const snapshot = await saveArtifactSnapshot(
      'original',
      'Page',
      'https://example.com/latest',
    );
    const file = fileURLToPath(snapshot.url!);
    await fs.writeFile(file, 'changed');
    await expect(readArtifactSnapshot(snapshot, runtime)).rejects.toThrow();
    const handle = await fs.open(file, 'r+');
    await handle.truncate(MAX_ARTIFACT_BYTES + 1);
    await handle.close();
    await expect(readArtifactSnapshot(snapshot, runtime)).rejects.toThrow();
    await fs.unlink(file);
    await expect(readArtifactSnapshot(snapshot, runtime)).rejects.toThrow();
  });

  it('rejects forged descriptors and symlink files or directories even with matching bytes', async () => {
    const snapshot = await saveArtifactSnapshot(
      'original',
      'Page',
      'https://example.com/latest',
    );
    for (const override of [
      { managedId: '../outside' },
      { metadata: { artifactType: 'web_preview_snapshot' } },
      { storage: 'external_url' as const },
      { url: 'file:///tmp/elsewhere.html' },
    ]) {
      await expect(
        readArtifactSnapshot({ ...snapshot, ...override }, runtime),
      ).rejects.toThrow();
    }
    const file = fileURLToPath(snapshot.url!);
    const outside = path.join(runtime, 'outside.html');
    await fs.writeFile(outside, 'original');
    await fs.unlink(file);
    await fs.symlink(outside, file);
    await expect(readArtifactSnapshot(snapshot, runtime)).rejects.toThrow();
    const dir = path.dirname(file);
    await fs.rm(dir, { recursive: true });
    const otherDir = path.join(runtime, 'other');
    await fs.mkdir(otherDir);
    await fs.writeFile(path.join(otherDir, 'index.html'), 'original');
    await fs.symlink(otherDir, dir, 'dir');
    await expect(readArtifactSnapshot(snapshot, runtime)).rejects.toThrow();
  });
});
