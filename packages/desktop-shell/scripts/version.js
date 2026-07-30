#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = process.env.QWEN_DESKTOP_PACKAGE_DIR
  ? path.resolve(process.env.QWEN_DESKTOP_PACKAGE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/version.js <semver>');
}

updateJson(path.join(packageDir, 'package.json'), (manifest) => {
  manifest.version = version;
});
updateJson(path.join(packageDir, 'src-tauri', 'tauri.conf.json'), (config) => {
  config.version = version;
});

const cargoPath = path.join(packageDir, 'src-tauri', 'Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8');
const updatedCargo = cargo.replace(
  /(^\[package\][\s\S]*?^version = ")[^"]+("$)/m,
  `$1${version}$2`,
);
if (updatedCargo === cargo) {
  throw new Error('Failed to update the Cargo package version.');
}
fs.writeFileSync(cargoPath, updatedCargo);
console.log(`Desktop version set to ${version}`);

function updateJson(file, update) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  update(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
