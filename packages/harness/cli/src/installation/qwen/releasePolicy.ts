/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { parse } from 'semver';
import type { ReleasePolicy } from '../nativeInstallationService.js';
import { detectMusl } from '../install/systemInfo.js';
import {
  fetchManifest,
  fetchVersionManifest,
  pickFile,
} from '../update/manifest.js';
import type { ManifestFile, ManifestJSON } from '../update/updateTypes.js';

export function qwenVersion(version: string): string {
  if (typeof version !== 'string') throw new Error('Invalid Qwen version.');
  const normalized = version.replace(/^v/, '');
  const parsed = parse(normalized);
  if (!parsed) throw new Error('Invalid Qwen version.');
  const canonical = parsed.build.length
    ? `${parsed.version}+${parsed.build.join('.')}`
    : parsed.version;
  if (canonical !== normalized) throw new Error('Invalid Qwen version.');
  return normalized;
}

function artifact(manifest: ManifestJSON): ManifestFile {
  qwenVersion(manifest.latest);
  // Bun 1.4 ships one x64 runtime per libc, including support for older CPUs.
  const { platform, arch } = process;
  const linuxArch = platform === 'linux' && detectMusl() ? `${arch}-musl` : arch;
  const file =
    platform === 'linux'
      ? manifest.files.find(
          (file) => file.os === 'linux' && file.arch === linuxArch,
        )
      : pickFile(manifest.files);
  if (!file)
    throw new Error('This release has no Qwen binary for this platform.');
  const url = new URL(file.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    file.runtime !== 'bun' ||
    !/^[a-fA-F0-9]{64}$/.test(file.sha256) ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  )
    throw new Error('Invalid Qwen binary release metadata.');
  return file;
}

export async function latestQwenRelease(
  baseURL: string,
): Promise<ManifestJSON> {
  const manifest = await fetchManifest(baseURL);
  qwenVersion(manifest.latest);
  artifact(manifest);
  return manifest;
}

/** Selection only. Native execution remains entirely in NativeInstallationService. */
export function createQwenReleasePolicy(options: {
  baseURL: string;
  version?: string;
  force?: boolean;
}): ReleasePolicy {
  const requested = options.version ? qwenVersion(options.version) : undefined;
  return {
    allows(version) {
      try {
        return qwenVersion(version) === version;
      } catch {
        return false;
      }
    },
    async resolve(operation, previousUpdate) {
      if (operation === 'rollback') {
        const target = previousUpdate?.fromVersion ?? requested;
        if (!target)
          throw new Error('Specify a rollback version with --to.');
        if (previousUpdate) {
          const previous = parse(target);
          const current = parse(previousUpdate.toVersion);
          if (
            !previous ||
            !current ||
            previous.major !== 1 ||
            current.major !== 1 ||
            previous.compare(current) >= 0 ||
            (previous.prerelease[0] === 'nightly') !==
              (current.prerelease[0] === 'nightly')
          )
            throw new Error(
              'No previous local Qwen 1.x version in this release channel. Specify a version with --to.',
            );
        }
        // No manifest/network access until the service finds the local version missing.
        return {
          version: target,
          reuseLocal: true,
          getArtifact: async () =>
            artifact(await fetchVersionManifest(options.baseURL, target)),
        };
      }
      const manifest = requested
        ? await fetchVersionManifest(options.baseURL, requested)
        : await latestQwenRelease(options.baseURL);
      const file = artifact(manifest);
      return {
        version: qwenVersion(manifest.latest),
        reuseLocal: !options.force,
        getArtifact: async () => file,
      };
    },
  };
}
