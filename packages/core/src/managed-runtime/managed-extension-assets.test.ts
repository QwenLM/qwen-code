/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { managedSessionNestedResourceRefs } from './managed-session-resource-references.js';
import {
  globManagedExtensionAssets,
  publishManagedExtensionAssets,
  readManagedExtensionAsset,
} from './managed-extension-assets.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-assets-'));
  directories.push(directory);
  const root = path.join(directory, 'package');
  await mkdir(path.join(root, 'references'), { recursive: true });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: path.join(directory, 'store'),
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
  });
  return { root, resources };
}

it('keeps pinned reference bytes after the source package changes or disappears', async () => {
  const { root, resources } = await fixture();
  await writeFile(
    path.join(root, 'references', 'guide.md'),
    'original instructions',
  );
  const ref = await publishManagedExtensionAssets(resources, root);
  await writeFile(
    path.join(root, 'references', 'guide.md'),
    'new instructions',
  );
  await rm(root, { recursive: true });
  await expect(
    readManagedExtensionAsset(resources, ref, 'references/guide.md'),
  ).resolves.toEqual({
    path: 'references/guide.md',
    content: 'original instructions',
  });
  await expect(
    globManagedExtensionAssets(resources, ref, '**/*.md'),
  ).resolves.toEqual({ paths: ['references/guide.md'] });
  await expect(
    readManagedExtensionAsset(resources, ref, '../guide.md'),
  ).rejects.toThrow();
  await expect(
    readManagedExtensionAsset(resources, ref, 'other/guide.md'),
  ).rejects.toThrow(/does not contain/);
});

it('retains every asset page and byte part through declared resource edges', async () => {
  const { root, resources } = await fixture();
  await writeFile(
    path.join(root, 'references', 'guide.md'),
    'a'.repeat(70_000),
  );
  const ref = await publishManagedExtensionAssets(resources, root);
  const pages = managedSessionNestedResourceRefs(
    ref,
    await resources.read(ref),
  );
  expect(pages).toHaveLength(1);
  const parts = managedSessionNestedResourceRefs(
    pages[0]!,
    await resources.read(pages[0]!),
  );
  expect(parts).toHaveLength(2);
  expect(
    Buffer.concat(
      await Promise.all(parts.map((part) => resources.read(part))),
    ).toString(),
  ).toBe('a'.repeat(70_000));
});

it('rejects corrupted asset bytes even when the resource reader returns them', async () => {
  const { root, resources } = await fixture();
  await writeFile(path.join(root, 'guide.md'), 'trusted');
  const ref = await publishManagedExtensionAssets(resources, root);
  const corrupted = {
    read: async (part: Parameters<typeof resources.read>[0]) =>
      part.kind === 'managed-extension-asset-part'
        ? Buffer.from('altered')
        : resources.read(part),
  };
  await expect(
    readManagedExtensionAsset(corrupted, ref, 'guide.md'),
  ).rejects.toThrow(/immutable extension assets/);
});

it('does not follow an archive entry symlink into a different directory', async () => {
  const { root, resources } = await fixture();
  await writeFile(path.join(root, '..', 'private.txt'), 'private');
  await symlink(
    path.join(root, '..', 'private.txt'),
    path.join(root, 'escape.txt'),
  );
  await expect(
    publishManagedExtensionAssets(resources, root),
  ).rejects.toThrow();
});

it('rejects oversized assets before reading their bytes into a published snapshot', async () => {
  const { root, resources } = await fixture();
  await writeFile(
    path.join(root, 'large.txt'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  await expect(publishManagedExtensionAssets(resources, root)).rejects.toThrow(
    /oversized/,
  );
});

it('refuses binary references instead of decoding replacement characters', async () => {
  const { root, resources } = await fixture();
  await writeFile(path.join(root, 'binary'), Buffer.from([255, 254]));
  const ref = await publishManagedExtensionAssets(resources, root);
  await expect(
    readManagedExtensionAsset(resources, ref, 'binary'),
  ).rejects.toThrow();
});
