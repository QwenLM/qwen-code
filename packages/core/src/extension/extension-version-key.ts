/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ExtensionInstallMetadata } from '../config/config.js';
import type { ExtensionConfig } from './extensionManager.js';
import { EXTENSION_SETTINGS_FILENAME } from './variables.js';
import { EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME } from './extension-git-credentials.js';

const IGNORED_CONTENT_HASH_FILES = new Set([
  '.qwen-extension-install.json',
  '.qwen-extension-settings.json',
  EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME,
  EXTENSION_SETTINGS_FILENAME,
  '.DS_Store',
]);

function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw error;
  }
}

/**
 * Computes a deterministic SHA-256 content digest over all regular files in
 * `rootDir`, ignoring managed install/settings sidecars so identical archives
 * or local copies hash to the same digest across machines.
 */
export async function computeDirectoryContentHash(
  rootDir: string,
): Promise<string> {
  const files: string[] = [];
  const walk = async (currentDir: string, relPrefix: string): Promise<void> => {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (relPrefix === '' && IGNORED_CONTENT_HASH_FILES.has(entry.name)) {
        continue;
      }
      if (entry.name === '.git') continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  };
  await walk(rootDir, '');
  const hash = crypto.createHash('sha256');
  for (const relPath of files) {
    hash.update(`file:${relPath}\0`);
    const content = await fsp.readFile(path.join(rootDir, relPath));
    hash.update(String(content.byteLength));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Computes a deterministic version locator key for a resolved install source.
 * Returns `undefined` for credentialed installs (`snapshot` / `stored`) so
 * private credentials are never silently shared across workspaces.
 */
export function computeVersionKey(
  config: Pick<ExtensionConfig, 'name' | 'version'>,
  installMetadata: ExtensionInstallMetadata,
  contentHash?: string,
): string | undefined {
  if (
    installMetadata.type === 'snapshot' ||
    installMetadata.credentialPersistence === 'stored'
  ) {
    return undefined;
  }
  const normalizedName = config.name.toLowerCase();
  const pluginSuffix = installMetadata.pluginName
    ? `:plugin:${installMetadata.pluginName}`
    : '';
  switch (installMetadata.type) {
    case 'npm': {
      const registry = (installMetadata.registryUrl ?? 'default').replace(
        /\/+$/,
        '',
      );
      const version = installMetadata.releaseTag ?? config.version;
      return `npm:${registry}:${normalizedName}@${version}${pluginSuffix}`;
    }
    case 'github-release': {
      const tag = installMetadata.releaseTag ?? config.version;
      return `gh-release:${installMetadata.source.toLowerCase()}:${tag}${pluginSuffix}`;
    }
    case 'git': {
      const rev =
        installMetadata.gitCommit ?? installMetadata.ref ?? config.version;
      return `git:${installMetadata.source.toLowerCase()}:${rev}${pluginSuffix}`;
    }
    case 'link': {
      const target = canonicalizePath(installMetadata.source);
      const normalizedTarget =
        process.platform === 'win32' || process.platform === 'darwin'
          ? target.toLowerCase()
          : target;
      return `link:${normalizedTarget}`;
    }
    case 'local':
    case 'archive-url': {
      const digest = contentHash ?? config.version;
      return `content:${normalizedName}:${digest}${pluginSuffix}`;
    }
    default:
      return undefined;
  }
}

export function getVersionedExtensionId(
  baseId: string,
  versionKey: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`v2:${baseId}:${versionKey}`)
    .digest('hex');
}

export function sanitizeVersionSlotSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9-_.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'v';
  }
  return cleaned;
}

/**
 * Produces a readable, store-valid directory slot name under
 * `<QWEN_HOME>/extension-versions/<name>/<slot>/`.
 *
 * Uses `<version>` directly when unambiguous, falling back to
 * `<label>-<id8>` when linking, when no semver tag exists, or when another
 * installed version of the same extension already claims that slot name.
 */
export function formatVersionSlot(
  config: Pick<ExtensionConfig, 'version'>,
  installMetadata: ExtensionInstallMetadata,
  extensionId: string,
  occupiedSlotsByOtherIds: ReadonlySet<string> = new Set(),
): string {
  const shortId = extensionId.slice(0, 8);
  let baseLabel: string;
  if (installMetadata.type === 'link') {
    const dirBase = path.basename(canonicalizePath(installMetadata.source));
    baseLabel = `link-${sanitizeVersionSlotSegment(dirBase)}`;
  } else if (installMetadata.type === 'git' && installMetadata.gitCommit) {
    const ver = sanitizeVersionSlotSegment(config.version || 'git');
    baseLabel = `${ver}-${installMetadata.gitCommit.slice(0, 7)}`;
  } else {
    baseLabel = sanitizeVersionSlotSegment(
      installMetadata.releaseTag ?? config.version ?? 'v',
    );
  }

  const candidate =
    installMetadata.type === 'link' ||
    installMetadata.type === 'local' ||
    installMetadata.type === 'archive-url' ||
    installMetadata.type === 'snapshot'
      ? `${baseLabel}-${shortId}`
      : baseLabel;

  if (!occupiedSlotsByOtherIds.has(candidate.toLowerCase())) {
    return candidate;
  }
  return `${baseLabel}-${shortId}`;
}
