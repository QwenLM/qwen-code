#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = process.env.QWEN_DESKTOP_PACKAGE_DIR
  ? path.resolve(process.env.QWEN_DESKTOP_PACKAGE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2]?.replace(/^v/, '');
if (
  !version ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
) {
  throw new Error('Usage: node scripts/version.js <semver>');
}

const cargoPath = path.join(packageDir, 'src-tauri', 'Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8');
const cargoVersionPattern = /(^\[package\][\s\S]*?^version = ")([^"]+)("$)/m;
const cargoMatch = cargoVersionPattern.exec(cargo);
if (!cargoMatch) {
  throw new Error('Failed to find the Cargo package version.');
}
if (cargoMatch[2] === version) {
  console.log(`Desktop version already set to ${version}`);
  process.exit(0);
}

updateJson(path.join(packageDir, 'package.json'), (manifest) => {
  manifest.version = version;
});
updateJson(path.join(packageDir, 'src-tauri', 'tauri.conf.json'), (config) => {
  config.version = version;
});
fs.writeFileSync(
  cargoPath,
  cargo.replace(cargoVersionPattern, `$1${version}$3`),
);
console.log(`Desktop version set to ${version}`);

function updateJson(file, update) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  update(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
