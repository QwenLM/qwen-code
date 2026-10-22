#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const options = parseArguments(process.argv.slice(2));
const assets = fs.readdirSync(options.assets).sort();
// Platforms a caller accepts as absent instead of fatal. Only the OSS mirror's
// re-mirror-an-existing-release path passes this, so it can reproduce the feed
// of a release that predates a platform. Fresh builds stay strict: a missing
// leg fails the publish instead of shipping a feed without it.
const allowMissingPlatforms = new Set(
  (options['allow-missing-platform'] ?? '')
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean),
);
// Tolerated platforms are collected here and reported only once the feed has
// actually been written, so a run that throws on some other leg publishes no
// annotation claiming an incomplete feed went out.
const droppedPlatforms = [];
const platforms = {};
const platformArtifacts = [
  [
    'darwin-aarch64',
    selectArtifact(
      assets,
      /-aarch64-apple-darwin\.app\.tar\.gz$/i,
      'darwin-aarch64',
    ),
  ],
  [
    'darwin-x86_64',
    selectArtifact(
      assets,
      /-x86_64-apple-darwin\.app\.tar\.gz$/i,
      'darwin-x86_64',
    ),
  ],
  ['windows-x86_64', selectArtifact(assets, /-setup\.exe$/i, 'windows-x86_64')],
  // Tauri's AppImage arch tokens are `_amd64`/`_aarch64`; the .deb beside them
  // uses Debian's `_amd64`/`_arm64`. Matching the extension alone is ambiguous.
  [
    'linux-x86_64',
    selectArtifact(assets, /_amd64\.AppImage$/i, 'linux-x86_64'),
  ],
  [
    'linux-aarch64',
    selectArtifact(assets, /_aarch64\.AppImage$/i, 'linux-aarch64'),
  ],
];

for (const [platform, artifact] of platformArtifacts) {
  if (!artifact) continue;
  const signatureFile = `${artifact}.sig`;
  if (!assets.includes(signatureFile)) {
    throw new Error(`Missing updater signature for ${artifact}`);
  }
  platforms[platform] = {
    signature: fs
      .readFileSync(path.join(options.assets, signatureFile), 'utf8')
      .trim(),
    url: `${releaseBaseUrl(options)}/${encodeURIComponent(artifact)}`,
  };
}

const manifest = {
  version: options.version,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`);

// Only now is "publishing the feed without it" true: every leg that was not
// tolerated has been selected and signed, and the feed is on disk. Emitting
// this inside selectArtifact instead would put the annotation on runs that
// later throw and write nothing, sending oncall hunting for a truncated feed
// that never existed.
for (const platform of droppedPlatforms) {
  // stdout, not stderr: GitHub parses workflow commands from stdout only,
  // and stderr has to stay reserved for the thrown error the tests match on.
  // Without this a tolerant run is byte-identical in the log to a complete
  // one, and the dropped key is only discoverable by diffing the published
  // feed against the previous mirror.
  console.log(
    `::warning::no updater artifact for ${platform}; publishing the feed without it (--allow-missing-platform)`,
  );
}

function selectArtifact(assets, pattern, platform) {
  const matches = assets.filter((asset) => pattern.test(asset));
  if (matches.length === 0 && allowMissingPlatforms.has(platform)) {
    droppedPlatforms.push(platform);
    return null;
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one updater artifact for ${platform}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

function releaseBaseUrl(options) {
  return options['base-url']
    ? options['base-url'].replace(/\/+$/, '')
    : `https://github.com/${options.repository}/releases/download/${options.tag}`;
}

function parseArguments(args) {
  // Only this option is genuinely multi-valued. Accumulating repeats for every
  // option would comma-join a duplicated single-valued flag straight into the
  // published, signed feed -- `--version a --version a` writes a version no
  // updater client can parse, and `--output f --output f` writes a file named
  // `f,f` so no feed exists at all, both at exit status 0.
  const multiValueOptions = new Set(['allow-missing-platform']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (!name || value === undefined) throw new Error('Invalid arguments.');
    // Accumulate repeats of the multi-valued option only: a bash-array caller
    // spells it as repeated flags, and plain assignment would keep only the
    // last one — the dropped value then surfaces as a missing build leg during
    // a release run. Single-valued options keep the ordinary last-wins.
    values[name] =
      multiValueOptions.has(name) && values[name] !== undefined
        ? `${values[name]},${value}`
        : value;
  }
  for (const required of ['assets', 'repository', 'tag', 'version', 'output']) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  return values;
}
