/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const lockfilePath = join(root, 'package-lock.json');

function readJsonFile(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    console.error(`Error reading or parsing ${filePath}:`, error);
    return null;
  }
}

console.log('Checking lockfile...');

const lockfile = readJsonFile(lockfilePath);
if (lockfile === null) {
  process.exit(1);
}
const packages = lockfile.packages || {};
const invalidPackages = [];

for (const [location, details] of Object.entries(packages)) {
  // 1. Skip the root package itself.
  if (location === '') {
    continue;
  }

  // 2. Skip local workspace packages.
  // They are identifiable in two ways:
  // a) As a symlink within node_modules.
  // b) As the source package definition, whose path is not in node_modules.
  if (details.link === true || !location.includes('node_modules')) {
    continue;
  }

  // 3. Any remaining package should be a third-party dependency.
  // 1) Registry package with both "resolved" and "integrity" fields is valid.
  if (details.resolved && details.integrity) {
    continue;
  }
  // 2) Git and file dependencies only need a "resolved" field.
  const isGitOrFileDep =
    details.resolved?.startsWith('git') ||
    details.resolved?.startsWith('file:');
  if (isGitOrFileDep) {
    continue;
  }

  // Mark the left dependency as invalid.
  invalidPackages.push(location);
}

if (invalidPackages.length > 0) {
  console.error(
    '\nError: The following dependencies in package-lock.json are missing the "resolved" or "integrity" field:',
  );
  invalidPackages.forEach((pkg) => console.error(`- ${pkg}`));
  process.exitCode = 1;
} else {
  console.log('Lockfile check passed.');
  process.exitCode = 0;
}

console.log('Checking pnpm lockfile...');

const pnpmLockfilePath = join(root, 'pnpm-lock.yaml');
let pnpmLockfile;
try {
  pnpmLockfile = parseYaml(fs.readFileSync(pnpmLockfilePath, 'utf-8'));
} catch (error) {
  console.error(`Error reading or parsing ${pnpmLockfilePath}:`, error);
  process.exit(1);
}

const invalidPnpmPackages = [];
for (const [key, details] of Object.entries(pnpmLockfile?.packages ?? {})) {
  const resolution = details?.resolution ?? {};
  // Registry packages carry a sha512 integrity hash; git and tarball
  // resolutions identify their source directly, mirroring the npm rules
  // above.
  const hasIntegrity =
    typeof resolution.integrity === 'string' &&
    resolution.integrity.startsWith('sha512-');
  const isGitOrTarball =
    resolution.type === 'git' || typeof resolution.tarball === 'string';
  if (!hasIntegrity && !isGitOrTarball) {
    invalidPnpmPackages.push(key);
  }
}

if (invalidPnpmPackages.length > 0) {
  console.error(
    '\nError: The following dependencies in pnpm-lock.yaml are missing "resolution.integrity":',
  );
  invalidPnpmPackages.forEach((pkg) => console.error(`- ${pkg}`));
  process.exitCode = 1;
} else {
  console.log('pnpm lockfile check passed.');
}

// The dependency name behind a package-lock.json location. An aliased install
// (`"string-width-cjs": "npm:string-width@…"`) sits under the alias and
// records the real name in `name`.
function npmPackageName(location, details) {
  if (details.name) return details.name;
  const marker = 'node_modules/';
  return location.slice(location.lastIndexOf(marker) + marker.length);
}

// pnpm keys are `name@version` (allowBuilds also accepts `name@spec`); a
// scoped name starts with its own `@`.
function pnpmPackageName(key) {
  const at = key.indexOf('@', 1);
  return at === -1 ? key : key.slice(0, at);
}

console.log('Checking pnpm lockfile against package-lock.json...');

const npmLockedVersions = new Set();
for (const [location, details] of Object.entries(packages)) {
  if (details.link === true || !location.includes('node_modules/')) {
    continue;
  }
  npmLockedVersions.add(
    `${npmPackageName(location, details)}@${details.version}`,
  );
}

// form-data nests mime-types@2.1.35, which requires exactly mime-db 1.52.0,
// but package-lock.json locks no nested mime-db there, so npm serves it the
// hoisted 1.54.0 while pnpm honours the pin. Drop the entry once npm locks
// 1.52.0 or form-data moves off mime-types@2.
const knownNpmLockGaps = new Set(['mime-db@1.52.0']);

// pnpm dedupes where npm keeps nested copies (npm locks esbuild 0.25.6 at the
// root and 0.25.12 nested; pnpm uses 0.25.12 for both), so the two graphs are
// never equal. The direction that matters is this one: a pnpm worktree must
// not run a dependency version that CI's npm install has not locked.
const pnpmVersions = Object.keys(pnpmLockfile?.packages ?? {});
const unlockedPnpmVersions = pnpmVersions.filter(
  (key) => !npmLockedVersions.has(key) && !knownNpmLockGaps.has(key),
);
const staleNpmLockGaps = [...knownNpmLockGaps].filter(
  (key) => !pnpmVersions.includes(key) || npmLockedVersions.has(key),
);

if (unlockedPnpmVersions.length > 0) {
  console.error(
    '\nError: pnpm-lock.yaml resolves versions that package-lock.json does not lock. Regenerate it from package-lock.json with `corepack pnpm import`:',
  );
  unlockedPnpmVersions.forEach((key) => console.error(`- ${key}`));
  process.exitCode = 1;
}
if (staleNpmLockGaps.length > 0) {
  console.error(
    '\nError: remove these entries from knownNpmLockGaps in scripts/check-lockfile.js; they no longer describe a gap:',
  );
  staleNpmLockGaps.forEach((key) => console.error(`- ${key}`));
  process.exitCode = 1;
}
if (unlockedPnpmVersions.length === 0 && staleNpmLockGaps.length === 0) {
  console.log('pnpm lockfile matches package-lock.json.');
}

console.log('Checking pnpm build approvals...');

const pnpmWorkspacePath = join(root, 'pnpm-workspace.yaml');
let pnpmWorkspace;
try {
  pnpmWorkspace = parseYaml(fs.readFileSync(pnpmWorkspacePath, 'utf-8'));
} catch (error) {
  console.error(`Error reading or parsing ${pnpmWorkspacePath}:`, error);
  process.exit(1);
}

// npm runs every dependency install script; pnpm runs one only when
// allowBuilds approves it. Requiring an entry for each script npm runs keeps
// that difference a reviewed decision instead of a silent one.
const decidedBuilds = new Set(
  Object.keys(pnpmWorkspace?.allowBuilds ?? {}).map(pnpmPackageName),
);
const undecidedBuilds = new Set();
for (const [location, details] of Object.entries(packages)) {
  if (
    details.hasInstallScript !== true ||
    !location.includes('node_modules/')
  ) {
    continue;
  }
  const name = npmPackageName(location, details);
  if (!decidedBuilds.has(name)) {
    undecidedBuilds.add(name);
  }
}

if (undecidedBuilds.size > 0) {
  console.error(
    '\nError: these dependencies have install scripts but no allowBuilds entry in pnpm-workspace.yaml; add each with true (run it) or false (skip it):',
  );
  [...undecidedBuilds].sort().forEach((name) => console.error(`- ${name}`));
  process.exitCode = 1;
} else {
  console.log('pnpm build approvals cover every install script.');
}
