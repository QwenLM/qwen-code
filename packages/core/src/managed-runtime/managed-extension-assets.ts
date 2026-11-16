/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { managedPackageRelativePath } from '../extension/managed-package.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

const PART_BYTES = 64 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 256;

interface Asset {
  readonly path: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly parts: readonly ManagedSessionDurableRef[];
}

type Resources = Pick<ManagedSessionResourceStore, 'read' | 'publish'>;

/** Materialized archives are only a source; the saved bytes own future reads. */
export async function publishManagedExtensionAssets(
  resources: Pick<Resources, 'publish'>,
  archiveRoot: string,
): Promise<ManagedSessionDurableRef> {
  if (
    !path.isAbsolute(archiveRoot) ||
    !(await fs.lstat(archiveRoot)).isDirectory()
  )
    invalid();
  const root = await fs.realpath(archiveRoot);
  const assets: Asset[] = [];
  let total = 0;
  const visit = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = managedPackageRelativePath(
        path.posix.join(relative, entry.name),
      );
      const file = path.join(root, name);
      if ((await fs.realpath(file)) !== file) invalid();
      if (entry.isDirectory()) {
        await visit(name);
        continue;
      }
      if (!entry.isFile() || assets.length >= MAX_FILES) invalid();
      const size = (await fs.lstat(file)).size;
      if (size > MAX_BYTES - total) invalid();
      const bytes = await fs.readFile(file);
      total += bytes.length;
      if (total > MAX_BYTES) invalid();
      const parts: ManagedSessionDurableRef[] = [];
      for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
        parts.push(
          await resources.publish(
            'managed-extension-asset-part',
            bytes.subarray(offset, offset + PART_BYTES),
          ),
        );
      }
      assets.push({
        path: name,
        byteLength: bytes.length,
        digest: sha(bytes),
        parts,
      });
    }
  };
  await visit('');
  const pages: ManagedSessionDurableRef[] = [];
  let files: Asset[] = [];
  const pageBytes = (items: readonly Asset[]) =>
    Buffer.from(
      JSON.stringify({
        kind: 'managed-extension-assets-page',
        formatVersion: 1,
        files: items,
      }),
    );
  for (const asset of assets) {
    if (pageBytes([...files, asset]).length > PART_BYTES) {
      if (!files.length) invalid();
      pages.push(
        await resources.publish(
          'managed-extension-assets-page',
          pageBytes(files),
        ),
      );
      files = [];
    }
    files.push(asset);
    if (pageBytes(files).length > PART_BYTES) invalid();
  }
  if (files.length) {
    pages.push(
      await resources.publish(
        'managed-extension-assets-page',
        pageBytes(files),
      ),
    );
  }
  return resources.publish(
    'managed-extension-assets',
    Buffer.from(
      JSON.stringify({
        kind: 'managed-extension-assets',
        formatVersion: 1,
        pages,
      }),
    ),
  );
}

export async function readManagedExtensionAsset(
  resources: Pick<Resources, 'read'>,
  assetsRef: ManagedSessionDurableRef,
  requested: string,
): Promise<{ path: string; content: string }> {
  const name = managedPackageRelativePath(requested);
  const files = await readAssets(resources, assetsRef);
  const asset = files.find((entry) => entry.path === name);
  if (!asset)
    throw new Error('The selected package does not contain this asset.');
  const parts = await Promise.all(
    asset.parts.map((ref) =>
      readVerified(resources, ref, 'managed-extension-asset-part'),
    ),
  );
  const bytes = Buffer.concat(parts);
  if (bytes.length !== asset.byteLength || sha(bytes) !== asset.digest)
    invalid();
  return {
    path: name,
    content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  };
}

export async function globManagedExtensionAssets(
  resources: Pick<Resources, 'read'>,
  assetsRef: ManagedSessionDurableRef,
  pattern: string,
): Promise<{ paths: string[] }> {
  if (!pattern || Buffer.byteLength(pattern) > 4096) invalid();
  managedPackageRelativePath(pattern);
  return {
    paths: (await readAssets(resources, assetsRef))
      .map((entry) => entry.path)
      .filter((name) =>
        minimatch(name, pattern, {
          dot: true,
          nonegate: true,
          nocomment: true,
        }),
      ),
  };
}

async function readAssets(
  resources: Pick<Resources, 'read'>,
  ref: ManagedSessionDurableRef,
): Promise<Asset[]> {
  const manifest = object(
    JSON.parse(
      (await readVerified(resources, ref, 'managed-extension-assets')).toString(
        'utf8',
      ),
    ),
  );
  if (
    Object.keys(manifest).sort().join(',') !== 'formatVersion,kind,pages' ||
    manifest['kind'] !== 'managed-extension-assets' ||
    manifest['formatVersion'] !== 1 ||
    !Array.isArray(manifest['pages']) ||
    manifest['pages'].length > MAX_FILES
  )
    invalid();
  const assets: Asset[] = [];
  const names = new Set<string>();
  const references = new Set<string>();
  let total = 0;
  for (const value of manifest['pages']) {
    const pageRef = resourceRef(value);
    if (references.has(pageRef.resourceId)) invalid();
    references.add(pageRef.resourceId);
    const page = object(
      JSON.parse(
        (
          await readVerified(
            resources,
            pageRef,
            'managed-extension-assets-page',
          )
        ).toString('utf8'),
      ),
    );
    if (
      Object.keys(page).sort().join(',') !== 'files,formatVersion,kind' ||
      page['kind'] !== 'managed-extension-assets-page' ||
      page['formatVersion'] !== 1 ||
      !Array.isArray(page['files']) ||
      !page['files'].length ||
      page['files'].length + assets.length > MAX_FILES
    )
      invalid();
    for (const value of page['files']) {
      const file = object(value);
      if (
        Object.keys(file).sort().join(',') !== 'byteLength,digest,parts,path' ||
        typeof file['path'] !== 'string' ||
        !Number.isSafeInteger(file['byteLength']) ||
        Number(file['byteLength']) < 0 ||
        typeof file['digest'] !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(file['digest']) ||
        !Array.isArray(file['parts'])
      )
        invalid();
      const name = managedPackageRelativePath(file['path']);
      if (name !== file['path'] || names.has(name)) invalid();
      names.add(name);
      total += Number(file['byteLength']);
      if (total > MAX_BYTES || file['parts'].length > MAX_BYTES / PART_BYTES)
        invalid();
      const parts = file['parts'].map(resourceRef);
      if (
        parts.some(
          (part) =>
            part.kind !== 'managed-extension-asset-part' ||
            part.schemaVersion !== 1 ||
            part.byteLength > PART_BYTES,
        )
      )
        invalid();
      if (
        parts.reduce((size, part) => size + part.byteLength, 0) !==
        file['byteLength']
      )
        invalid();
      assets.push({
        path: name,
        byteLength: Number(file['byteLength']),
        digest: file['digest'],
        parts,
      });
    }
  }
  return assets;
}

async function readVerified(
  resources: Pick<Resources, 'read'>,
  ref: ManagedSessionDurableRef,
  kind: string,
): Promise<Buffer> {
  if (
    ref.kind !== kind ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > PART_BYTES
  )
    invalid();
  const bytes = await resources.read(ref);
  if (bytes.length !== ref.byteLength || sha(bytes) !== ref.digest) invalid();
  return bytes;
}

function resourceRef(value: unknown): ManagedSessionDurableRef {
  return assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'package asset',
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function invalid(): never {
  throw new Error('Invalid or oversized immutable extension assets.');
}
