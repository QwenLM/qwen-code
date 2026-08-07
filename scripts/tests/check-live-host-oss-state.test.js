/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkImmutablePrefix,
  shouldUpdateLatest,
} from '../check-live-host-oss-state.js';

describe('Live Host OSS state checks', () => {
  let directory;
  let manifestPath;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'live-host-oss-state-'));
    manifestPath = path.join(directory, 'Qwen-Live-Host-manifest.json');
    await writeManifest(manifestPath, '1.2.3');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('treats only a missing immutable manifest as unsealed', async () => {
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      checkImmutablePrefix({
        baseUrl: 'https://assets.example',
        version: '1.2.3',
        manifestPath,
        fetchImpl: missing,
      }),
    ).resolves.toBe(false);

    for (const failure of [
      vi.fn(async () => new Response(null, { status: 503 })),
      vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    ]) {
      await expect(
        checkImmutablePrefix({
          baseUrl: 'https://assets.example',
          version: '1.2.3',
          manifestPath,
          fetchImpl: failure,
        }),
      ).rejects.toThrow(/OSS manifest/);
    }
  });

  it('accepts only byte-identical immutable manifests', async () => {
    const bytes = await readFile(manifestPath);
    await expect(
      checkImmutablePrefix({
        baseUrl: 'https://assets.example/',
        version: '1.2.3',
        manifestPath,
        fetchImpl: async () => new Response(bytes),
      }),
    ).resolves.toBe(true);
    await expect(
      checkImmutablePrefix({
        baseUrl: 'https://assets.example',
        version: '1.2.3',
        manifestPath,
        fetchImpl: async () => Response.json({ version: '1.2.3' }),
      }),
    ).rejects.toThrow(/different contents/);
  });

  it('advances latest monotonically and rejects same-version divergence', async () => {
    const fetchVersion = (version) => async () =>
      Response.json({ version, marker: version });
    await expect(
      shouldUpdateLatest({
        baseUrl: 'https://assets.example',
        manifestPath,
        fetchImpl: fetchVersion('1.2.2'),
      }),
    ).resolves.toBe(true);
    await expect(
      shouldUpdateLatest({
        baseUrl: 'https://assets.example',
        manifestPath,
        fetchImpl: fetchVersion('1.2.4'),
      }),
    ).resolves.toBe(false);
    await expect(
      shouldUpdateLatest({
        baseUrl: 'https://assets.example',
        manifestPath,
        fetchImpl: fetchVersion('1.2.3'),
      }),
    ).rejects.toThrow(/different contents/);
  });

  it('does not rewrite an identical latest manifest', async () => {
    const bytes = await readFile(manifestPath);
    await expect(
      shouldUpdateLatest({
        baseUrl: 'https://assets.example',
        manifestPath,
        fetchImpl: async () => new Response(bytes),
      }),
    ).resolves.toBe(false);
  });
});

async function writeManifest(file, version) {
  await writeFile(file, `${JSON.stringify({ version })}\n`);
}
