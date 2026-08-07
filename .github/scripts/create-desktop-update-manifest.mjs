#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const options = parseArguments(process.argv.slice(2));
const assets = fs.readdirSync(options.assets).sort();
const platforms = {};
const platformArtifacts = [
  [
    'darwin-aarch64',
    selectArtifact(assets, /-aarch64-apple-darwin\.app\.tar\.gz$/i, 'darwin-aarch64'),
  ],
  [
    'darwin-x86_64',
    selectArtifact(assets, /-x86_64-apple-darwin\.app\.tar\.gz$/i, 'darwin-x86_64'),
  ],
  ['windows-x86_64', selectArtifact(assets, /-setup\.exe$/i, 'windows-x86_64')],
  ['linux-x86_64', selectArtifact(assets, /\.AppImage$/i, 'linux-x86_64')],
];

for (const [platform, artifact] of platformArtifacts) {
  const signatureFile = `${artifact}.sig`;
  if (!assets.includes(signatureFile)) {
    throw new Error(`Missing updater signature for ${artifact}`);
  }
  platforms[platform] = {
    signature: fs.readFileSync(path.join(options.assets, signatureFile), 'utf8').trim(),
    url: `https://github.com/${options.repository}/releases/download/${options.tag}/${encodeURIComponent(artifact)}`,
  };
}

const manifest = {
  version: options.version,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`);

function selectArtifact(assets, pattern, platform) {
  const matches = assets.filter((asset) => pattern.test(asset));
  if (matches.length !== 1) {
    throw new Error(
      `Expected one updater artifact for ${platform}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (!name || value === undefined) throw new Error('Invalid arguments.');
    values[name] = value;
  }
  for (const required of ['assets', 'repository', 'tag', 'version', 'output']) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  return values;
}
