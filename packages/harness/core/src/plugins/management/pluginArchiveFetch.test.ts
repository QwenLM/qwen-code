/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_PLUGIN_META_DIR } from '../../config/brand.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../test-utils/mock-undici-fetch-with-global.js';
import { createZipFromDirectory } from '../zipCache.js';
import { PluginSourceSchema } from '../schemas.js';
import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  fetchArchiveSource,
} from './pluginArchiveFetch.js';

const realFetch = global.fetch;
const tmpDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `test-archive-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

async function buildPluginZip(options?: {
  wrapper?: string;
  name?: string;
  version?: string;
}): Promise<{ bytes: Uint8Array; sha256: string }> {
  const src = await tempDir('src');
  const root = options?.wrapper ? join(src, options.wrapper) : src;
  await mkdir(join(root, BRAND_PLUGIN_META_DIR), { recursive: true });
  await mkdir(join(root, 'skills', 'hello'), { recursive: true });
  await writeFile(
    join(root, BRAND_PLUGIN_META_DIR, 'plugin.json'),
    JSON.stringify({
      name: options?.name ?? 'example-plugin',
      version: options?.version ?? '1.0.0',
    }),
  );
  await writeFile(
    join(root, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: hi\n---\nhello',
  );
  const bytes = await createZipFromDirectory(src);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function respondWith(body: Uint8Array, headers?: Record<string, string>) {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      { status: 200, headers },
    ),
  );
}

afterEach(async () => {
  global.fetch = realFetch;
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe('PluginSourceSchema archive', () => {
  it('accepts an archive source and lowercases the digest', () => {
    const parsed = PluginSourceSchema.parse({
      source: 'archive',
      url: 'https://cdn.example.com/p.zip',
      sha256: 'ABCDEF'.repeat(10) + 'ABCD',
    });
    expect(parsed).toEqual({
      source: 'archive',
      url: 'https://cdn.example.com/p.zip',
      sha256: 'abcdef'.repeat(10) + 'abcd',
    });
  });

  it('rejects a malformed digest', () => {
    expect(
      PluginSourceSchema.safeParse({
        source: 'archive',
        url: 'https://cdn.example.com/p.zip',
        sha256: 'not-a-hash',
      }).success,
    ).toBe(false);
  });
});

describe('fetchArchiveSource', () => {
  it('downloads, verifies and unpacks a flat archive into targetDir', async () => {
    const { bytes, sha256 } = await buildPluginZip();
    respondWith(bytes);
    const target = await tempDir('target');

    await fetchArchiveSource(
      { source: 'archive', url: 'https://cdn.example.com/p.zip', sha256 },
      target,
    );

    const manifest = JSON.parse(
      await readFile(join(target, BRAND_PLUGIN_META_DIR, 'plugin.json'), 'utf-8'),
    );
    expect(manifest.name).toBe('example-plugin');
    expect(existsSync(join(target, 'skills', 'hello', 'SKILL.md'))).toBe(true);
  });

  it('strips a single wrapper directory', async () => {
    const { bytes, sha256 } = await buildPluginZip({
      wrapper: 'example-plugin-1.0.0',
    });
    respondWith(bytes);
    const target = await tempDir('target');

    await fetchArchiveSource(
      { source: 'archive', url: 'https://cdn.example.com/p.zip', sha256 },
      target,
    );

    expect(existsSync(join(target, BRAND_PLUGIN_META_DIR, 'plugin.json'))).toBe(true);
    expect(existsSync(join(target, 'example-plugin-1.0.0'))).toBe(false);
  });

  it('rejects a SHA256 mismatch before touching targetDir', async () => {
    const { bytes } = await buildPluginZip();
    respondWith(bytes);
    const target = await tempDir('target');
    await writeFile(join(target, 'sentinel'), 'keep');

    await expect(
      fetchArchiveSource(
        {
          source: 'archive',
          url: 'https://cdn.example.com/p.zip',
          sha256: '0'.repeat(64),
        },
        target,
      ),
    ).rejects.toThrow(/SHA256 mismatch/);
    expect(existsSync(join(target, 'sentinel'))).toBe(true);
  });

  it('refuses oversized downloads from the Content-Length header', async () => {
    const { bytes, sha256 } = await buildPluginZip();
    respondWith(bytes, {
      'content-length': String(MAX_PLUGIN_ARCHIVE_BYTES + 1),
    });
    const target = await tempDir('target');

    await expect(
      fetchArchiveSource(
        { source: 'archive', url: 'https://cdn.example.com/p.zip', sha256 },
        target,
      ),
    ).rejects.toThrow(/too large/);
  });

  it('surfaces HTTP failures', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('gone', { status: 404 }));
    const target = await tempDir('target');

    await expect(
      fetchArchiveSource(
        {
          source: 'archive',
          url: 'https://cdn.example.com/p.zip',
          sha256: '0'.repeat(64),
        },
        target,
      ),
    ).rejects.toThrow(/HTTP 404/);
  });
});
