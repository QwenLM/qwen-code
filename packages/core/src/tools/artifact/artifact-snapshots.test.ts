/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteArtifactSnapshot,
  retainArtifactSnapshot,
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
      'owner',
      runtime,
    );
    const repeated = await saveArtifactSnapshot(
      html,
      'Page',
      'https://example.com/latest',
      'owner',
      runtime,
    );
    const second = await saveArtifactSnapshot(
      '<h1>第二版</h1>',
      'Page',
      'https://example.com/latest',
      'owner',
      runtime,
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
      'owner',
      runtime,
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
      'owner',
      runtime,
    );
    for (const override of [
      { source: 'client' },
      { toolName: 'record_artifact' },
      { source: 'tool', toolName: 'record_artifact' },
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

  it('reclaims an evicted snapshot while retained versions stay readable', async () => {
    const first = await saveArtifactSnapshot(
      '<h1>v1</h1>',
      'Page',
      'https://example.com/latest',
      'owner',
      runtime,
    );
    const second = await saveArtifactSnapshot(
      '<h1>v2</h1>',
      'Page',
      'https://example.com/latest',
      'owner',
      runtime,
    );
    await deleteArtifactSnapshot(first, runtime, 'owner');
    await expect(readArtifactSnapshot(first, runtime)).rejects.toThrow();
    await expect(readArtifactSnapshot(second, runtime)).resolves.toBe(
      '<h1>v2</h1>',
    );
    // Reclaiming an already-reclaimed snapshot is a quiet no-op.
    await expect(
      deleteArtifactSnapshot(first, runtime, 'owner'),
    ).resolves.toBeUndefined();
  });

  it('preserves unloaded fork ownership and removes bytes only for the final owner', async () => {
    const snapshot = await saveArtifactSnapshot(
      'shared',
      'Page',
      'https://example.com',
      'owner',
      runtime,
    );
    await retainArtifactSnapshot(snapshot, runtime, 'fork', 'committed-fork');
    await retainArtifactSnapshot(snapshot, runtime, 'fork', 'failed-fork');
    await deleteArtifactSnapshot(snapshot, runtime, 'fork', 'failed-fork');
    await deleteArtifactSnapshot(snapshot, runtime, 'owner');
    await expect(readArtifactSnapshot(snapshot, runtime)).resolves.toBe(
      'shared',
    );
    await deleteArtifactSnapshot(snapshot, runtime, 'fork');
    await expect(
      fs.stat(path.dirname(fileURLToPath(snapshot.url!))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the captured runtime and never collects an untracked legacy snapshot', async () => {
    const snapshot = await saveArtifactSnapshot(
      'history',
      'Page',
      'https://example.com',
      'owner',
      runtime,
    );
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(runtime, 'other'));
    await deleteArtifactSnapshot(
      snapshot,
      path.join(runtime, 'other'),
      'owner',
    );
    await expect(readArtifactSnapshot(snapshot, runtime)).resolves.toBe(
      'history',
    );
    const legacy = { ...snapshot, metadata: { ...snapshot.metadata } };
    delete legacy.metadata['qwen.snapshot.references'];
    await deleteArtifactSnapshot(legacy, runtime, 'owner');
    await expect(readArtifactSnapshot(snapshot, runtime)).resolves.toBe(
      'history',
    );
    await deleteArtifactSnapshot(snapshot, runtime, 'owner');
    await expect(readArtifactSnapshot(snapshot, runtime)).rejects.toThrow();
  });

  it('fails a retain after reclamation claims the reference directory', async () => {
    const snapshot = await saveArtifactSnapshot(
      'history',
      'Page',
      'https://example.com',
      'owner',
      runtime,
    );
    await fs.rm(
      path.join(path.dirname(fileURLToPath(snapshot.url!)), 'references'),
      { recursive: true },
    );
    await expect(
      retainArtifactSnapshot(snapshot, runtime, 'fork', 'operation'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(path.dirname(fileURLToPath(snapshot.url!)), {
      recursive: true,
    });
    await expect(
      retainArtifactSnapshot(snapshot, runtime, 'fork', 'operation'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans partial files when writing the snapshot fails', async () => {
    const write = fs.writeFile.bind(fs);
    const spy = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('index.html'))
          throw new Error('disk full');
        return write(...args);
      });
    try {
      await expect(
        saveArtifactSnapshot(
          'history',
          'Page',
          'https://example.com',
          'owner',
          runtime,
        ),
      ).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    expect(
      await fs.readdir(path.join(runtime, 'artifacts', 'snapshots')),
    ).toEqual([]);
  });

  it('rechecks deletion ownership after asynchronous reference lookup', async () => {
    const snapshot = await saveArtifactSnapshot(
      'history',
      'Page',
      'https://example.com',
      'owner',
      runtime,
    );
    let lost = false;
    const readdir = fs.readdir.bind(fs);
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const result = await readdir(...args);
      lost = true;
      return result;
    });
    try {
      await expect(
        deleteArtifactSnapshot(snapshot, runtime, 'owner', undefined, () => {
          if (lost) throw new Error('lease lost');
        }),
      ).rejects.toThrow('lease lost');
    } finally {
      spy.mockRestore();
    }
    await expect(readArtifactSnapshot(snapshot, runtime)).resolves.toBe(
      'history',
    );
  });

  it('never deletes outside the exact file the descriptor points at', async () => {
    const snapshot = await saveArtifactSnapshot(
      'original',
      'Page',
      'https://example.com/latest',
      'owner',
      runtime,
    );
    const id = snapshot.managedId!.slice('preview-'.length);
    for (const override of [
      // Classifier rejects: wrong suffix, wrong metadata, wrong source.
      { url: 'file:///tmp/elsewhere.html' },
      { managedId: '../outside' },
      { metadata: { artifactType: 'web_preview_snapshot' } },
      { source: 'client' as const },
      // Classifier passes, but the url root is another runtime's tree:
      // reclamation must not follow it anywhere.
      {
        url: pathToFileURL(
          path.join(
            runtime,
            'foreign',
            'artifacts',
            'snapshots',
            id,
            'index.html',
          ),
        ).href,
      },
    ]) {
      await deleteArtifactSnapshot(
        { ...snapshot, ...override },
        runtime,
        'owner',
      );
      await expect(readArtifactSnapshot(snapshot, runtime)).resolves.toBe(
        'original',
      );
    }
  });
});
