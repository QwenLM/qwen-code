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

const packagePath = path.join(packageDir, 'package.json');
const lockPath = path.join(packageDir, 'package-lock.json');
const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

if (
  manifest.version === version &&
  lock.version === version &&
  lock.packages?.['']?.version === version
) {
  console.log(`Desktop version already set to ${version}`);
  process.exit(0);
}

manifest.version = version;
lock.version = version;
if (lock.packages?.['']) lock.packages[''].version = version;
fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Desktop version set to ${version}`);
