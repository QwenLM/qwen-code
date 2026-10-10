/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openNoFollow } from '../utils/no-follow-open.js';
import { MOD_MAX_BYTES } from './types.js';

function isContainedFile(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    Boolean(relative) &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function readWithin(root: string, file: string): Promise<string> {
  if (!isContainedFile(root, file)) {
    throw new Error('Mod file must stay inside the installed extension.');
  }
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Mod files cannot be symbolic links.');
    }
    if (current === file && !stat.isFile()) {
      throw new Error('Mod input must be a regular file.');
    }
  }
  const handle = await openNoFollow(file);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MOD_MAX_BYTES) {
      throw new Error('Mod file exceeds the 256 KiB regular-file limit.');
    }
    const buffer = Buffer.alloc(MOD_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MOD_MAX_BYTES) throw new Error('Mod file is too large.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readManifest(
  root: string,
  relative: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    if (path.isAbsolute(relative)) {
      throw new Error('Mod manifest path must be relative to the extension.');
    }
    const value: unknown = JSON.parse(
      await readWithin(root, path.resolve(root, relative)),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Mod manifest must be a JSON object.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function loadModSource(
  extensionPath: string,
): Promise<string | undefined> {
  const root = await fs.realpath(extensionPath);
  const qwen = await readManifest(root, 'qwen-extension.json');
  // External Qwen hook manifests belong to the existing classic hook loader.
  if (
    typeof qwen?.['hooks'] === 'string' &&
    (path.isAbsolute(qwen['hooks']) ||
      !isContainedFile(root, path.resolve(root, qwen['hooks'])))
  ) {
    return undefined;
  }
  // Conversion preserves the original Claude manifest and its relative paths.
  const claude = await readManifest(root, '.claude-plugin/plugin.json');
  const hooksPath =
    typeof qwen?.['hooks'] === 'string'
      ? qwen['hooks']
      : typeof claude?.['hooks'] === 'string'
        ? claude['hooks']
        : 'hooks/hooks.json';
  const hooks = await readManifest(root, hooksPath);
  if (!hooks || !Object.hasOwn(hooks, 'modules')) return undefined;
  const modules = hooks['modules'];
  if (
    !Array.isArray(modules) ||
    modules.length !== 1 ||
    typeof modules[0] !== 'string' ||
    path.isAbsolute(modules[0]) ||
    !/\.(?:js|mjs)$/.test(modules[0])
  ) {
    throw new Error('Mods currently require one relative .js or .mjs module.');
  }
  for (const manifest of [qwen, claude]) {
    for (const key of ['userConfig', 'dependencies']) {
      const value = manifest?.[key];
      if (value !== undefined && Object.keys(Object(value)).length > 0) {
        throw new Error(`Mod ${key} is not supported yet.`);
      }
    }
  }
  return readWithin(
    root,
    path.resolve(root, path.dirname(hooksPath), modules[0]),
  );
}
