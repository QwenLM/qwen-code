#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const downloadTag = 'desktop-stable';
const feedTag = 'desktop-latest';

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input });
}

function release(repository, tag) {
  // Unlike REST's tag lookup, gh release view also resolves pending draft tags.
  return JSON.parse(
    gh([
      'release',
      'view',
      tag,
      '--repo',
      repository,
      '--json',
      'assets,isDraft,isPrerelease',
    ]),
  );
}

function verifyAssets(actual, expected) {
  for (const asset of expected) {
    const published = actual.assets.find((item) => item.name === asset.name);
    if (
      published?.state !== 'uploaded' ||
      published.size !== asset.size ||
      published.digest !== asset.digest
    ) {
      throw new Error(
        `Installer missing or different on ${downloadTag}: ${asset.name}`,
      );
    }
  }
}

export async function updateDesktopDownloads({
  assets,
  version,
  repository,
  verify = false,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Desktop downloads require a stable X.Y.Z version.');
  }
  const sourceTag = `desktop-v${version}`;
  const source = release(repository, sourceTag);
  if (source.isDraft || source.isPrerelease) {
    throw new Error(`${sourceTag} is not a published stable release.`);
  }
  const feed = JSON.parse(
    gh([
      'release',
      'download',
      feedTag,
      '--repo',
      repository,
      '--pattern',
      'desktop-latest.json',
      '--output',
      '-',
    ]),
  );
  if (feed.version !== version) {
    throw new Error(
      `Stable feed is ${feed.version}, not ${version}; downloads unchanged.`,
    );
  }

  const installers = source.assets.filter((asset) =>
    /(?:\.dmg|-setup\.exe|\.AppImage|\.deb)$/.test(asset.name),
  );
  if (installers.length === 0)
    throw new Error(`${sourceTag} has no installers.`);
  for (const asset of installers) {
    const file = path.join(assets, asset.name);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (
      asset.size !== statSync(file).size ||
      asset.digest !== `sha256:${hash.digest('hex')}`
    ) {
      throw new Error(
        `Local installer differs from ${sourceTag}: ${asset.name}`,
      );
    }
  }

  let current;
  try {
    current = release(repository, downloadTag);
  } catch (error) {
    if (verify || String(error.stderr).trim() !== 'release not found')
      throw error;
  }
  if (verify) {
    verifyAssets(current, installers);
    if (
      current.isDraft ||
      current.isPrerelease ||
      current.assets.length !== installers.length
    ) {
      throw new Error(
        `${downloadTag} must contain only the current stable installers.`,
      );
    }
    return;
  }

  const files = installers
    .filter(
      (asset) =>
        !current?.assets.some(
          (item) =>
            item.name === asset.name &&
            item.state === 'uploaded' &&
            item.digest === asset.digest &&
            item.size === asset.size,
        ),
    )
    .map((asset) => path.join(assets, asset.name));
  if (!current) {
    gh([
      'release',
      'create',
      downloadTag,
      ...files,
      '--repo',
      repository,
      '--draft',
      '--latest=false',
    ]);
  } else if (files.length) {
    gh([
      'release',
      'upload',
      downloadTag,
      ...files,
      '--repo',
      repository,
      '--clobber',
    ]);
  }

  current = release(repository, downloadTag);
  verifyAssets(current, installers);
  const base = `https://github.com/${repository}/releases`;
  const links = installers
    .map(
      (asset) =>
        `- [${asset.name}](${base}/download/${downloadTag}/${asset.name})`,
    )
    .join('\n');
  gh(
    [
      'release',
      'edit',
      downloadTag,
      '--repo',
      repository,
      '--draft=false',
      '--prerelease=false',
      '--latest=false',
      '--title',
      `Qwen Code Desktop v${version}`,
      '--notes-file',
      '-',
    ],
    `Current stable Desktop installers for macOS, Windows, and Linux.\n\n${links}\n\n[Release notes and checksums](${base}/tag/${sourceTag}).\n`,
  );
  // Retain old links until both their replacements and the new body are ready.
  for (const asset of current.assets) {
    if (!installers.some((item) => item.name === asset.name)) {
      gh([
        'release',
        'delete-asset',
        downloadTag,
        asset.name,
        '--repo',
        repository,
        '--yes',
      ]);
    }
  }
  gh(
    ['release', 'edit', feedTag, '--repo', repository, '--notes-file', '-'],
    `This release serves the Desktop updater feed. Legacy Electron installers and manifests are retained for the Electron-to-Tauri update bridge.\n\nFor a new installation, [download the current Qwen Code Desktop](${base}/tag/${downloadTag}).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      assets: { type: 'string' },
      version: { type: 'string' },
      repository: { type: 'string' },
      verify: { type: 'boolean', default: false },
    },
  });
  if (!values.assets || !values.version || !values.repository) {
    throw new Error(
      'Required: --assets DIRECTORY --version X.Y.Z --repository OWNER/REPO [--verify]',
    );
  }
  await updateDesktopDownloads(values);
}
