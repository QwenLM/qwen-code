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

console.log('Checking Playwright parity...');

// The root `playwright` and Web Shell's `@playwright/test` both drive the
// chromium revision the capture harness launches, so they must stay on one
// version. Both manifests carry an exact pin: a range on either side lets a
// regeneration resolve the pair apart and re-nest a second tree, which leaves
// the installed browser one the harness cannot launch.
//
// Two other Playwright declarations are deliberately outside this invariant:
//   - `packages/mobile-mcp` depends on `mobilewright`, which pins `playwright`
//     and `playwright-core` to an exact older revision no manifest edit here
//     can dedupe. That tree hoists the older `playwright-core` to the root, so
//     the root `playwright-core` bin is NOT part of this parity — only the two
//     `playwright` CLIs are.
//   - `integration-tests/terminal-capture` declares a `playwright` range but is
//     not an npm or pnpm workspace, so it enters neither lockfile. Add it below
//     if it is ever listed under `workspaces`.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[\w.-]+)?$/;
const playwrightManifests = [
  { manifest: 'package.json', name: 'playwright' },
  { manifest: 'packages/web-shell/package.json', name: '@playwright/test' },
];

const playwrightSpecs = playwrightManifests.map(({ manifest, name }) => {
  const pkg = readJsonFile(join(root, manifest));
  if (pkg === null) {
    process.exit(1);
  }
  const spec = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name] ?? null;
  return { manifest, name, spec, exact: EXACT_VERSION.test(spec ?? '') };
});

const parityErrors = [];
for (const { manifest, name, spec, exact } of playwrightSpecs) {
  if (spec === null) {
    parityErrors.push(`${manifest} does not declare ${name}`);
  } else if (!exact) {
    parityErrors.push(
      `${manifest} declares ${name} as "${spec}"; expected an exact version so it cannot resolve apart from its twin`,
    );
  }
}

const [rootPlaywright, webShellPlaywright] = playwrightSpecs;
if (
  rootPlaywright.exact &&
  webShellPlaywright.exact &&
  rootPlaywright.spec !== webShellPlaywright.spec
) {
  parityErrors.push(
    `${rootPlaywright.name} ${rootPlaywright.spec} and ${webShellPlaywright.name} ${webShellPlaywright.spec} must declare the same version`,
  );
}

// Manifest agreement is not enough on its own: a stale or hand-edited lockfile
// can still resolve the pair apart. Assert the resolved outcome for those two
// packages, scoped as above.
const pinned = rootPlaywright.spec;
if (rootPlaywright.exact) {
  for (const location of [
    'node_modules/playwright',
    'node_modules/@playwright/test',
  ]) {
    const actual = packages[location]?.version;
    if (actual === undefined) {
      parityErrors.push(
        `package-lock.json has no ${location} entry, so nothing hoists the package the harness imports; regenerate the lockfile`,
      );
    } else if (actual !== pinned) {
      parityErrors.push(
        `package-lock.json resolves ${location} to ${actual} instead of ${pinned}; regenerate the lockfile, and if that does not settle it, look for another manifest declaring a Playwright range`,
      );
    }
  }
  // A nested copy at the pinned version is a redundant install, not a split
  // revision, so only a differing one is an error.
  const nested = 'node_modules/@playwright/test/node_modules/playwright';
  if (packages[nested] && packages[nested].version !== pinned) {
    parityErrors.push(
      `package-lock.json nests ${nested} at ${packages[nested].version}, splitting the chromium revision; regenerate it`,
    );
  }
}

// Both lockfiles are committed together, so a specifier or a resolved version
// that lands in one and not the other is the same drift. pnpm's
// --frozen-lockfile validates specifiers only, so the version is asserted too.
const pnpmImporters = pnpmLockfile?.importers ?? {};
for (const { manifest, name, spec, exact } of playwrightSpecs) {
  const importer = dirname(manifest);
  const entry =
    pnpmImporters[importer]?.devDependencies?.[name] ??
    pnpmImporters[importer]?.dependencies?.[name] ??
    null;
  if (entry === null) {
    parityErrors.push(
      `pnpm-lock.yaml has no ${name} entry for importer "${importer}"; regenerate it`,
    );
    continue;
  }
  if (entry.specifier !== spec) {
    parityErrors.push(
      `pnpm-lock.yaml records ${name} in "${importer}" as "${entry.specifier}" but ${manifest} declares "${spec}"; regenerate it`,
    );
  }
  if (exact && entry.version !== spec) {
    parityErrors.push(
      `pnpm-lock.yaml resolves ${name} in "${importer}" to ${entry.version} instead of ${spec}; regenerate it`,
    );
  }
}

if (parityErrors.length > 0) {
  console.error('\nError: Playwright version parity is broken:');
  parityErrors.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log('Playwright parity check passed.');
}
