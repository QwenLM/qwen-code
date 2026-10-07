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
// Tests point the gate at a fixture root; the default stays the repository.
// Truthiness, not `??`: an exported-but-empty variable would otherwise make
// every path below cwd-relative, and the gate would report on whatever
// lockfiles happen to sit in that directory as if they were the repository's.
const envRoot = process.env.CHECK_LOCKFILE_ROOT?.trim();
const root = envRoot ? envRoot : join(__dirname, '..');

function readJsonFile(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    console.error(`Error reading or parsing ${filePath}:`, error);
    return null;
  }
}

// pnpm enforces build approvals itself: strictDepBuilds (on by default in
// pnpm 11) fails any install in which a dependency's install script has no
// decision in pnpm-workspace.yaml's allowBuilds, and every CI install is a
// --frozen-lockfile one, which also rejects a lockfile that no longer matches
// the manifests. This gate covers what an install does not check.
console.log('Checking pnpm lockfile...');

const pnpmLockfilePath = join(root, 'pnpm-lock.yaml');
let pnpmLockfile;
try {
  pnpmLockfile = parseYaml(fs.readFileSync(pnpmLockfilePath, 'utf-8'));
} catch (error) {
  console.error(`Error reading or parsing ${pnpmLockfilePath}:`, error);
  process.exit(1);
}

const pnpmPackages = pnpmLockfile?.packages ?? {};
if (Object.keys(pnpmPackages).length === 0) {
  console.error(
    '\nError: pnpm-lock.yaml has no packages section; regenerate it with `corepack pnpm install`.',
  );
  process.exit(1);
}

const invalidPnpmPackages = [];
for (const [key, details] of Object.entries(pnpmPackages)) {
  const resolution = details?.resolution ?? {};
  // Registry packages carry a sha512 integrity hash; git and tarball
  // resolutions identify their source directly.
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
// Three other Playwright declarations are deliberately outside this invariant:
//   - `packages/mobile-mcp` declares `@playwright/test` as a range directly.
//     pnpm satisfies it from the single hoisted copy at the pinned version
//     today, and the harness never resolves into that workspace, so it stays
//     out of scope here — but it is the only in-workspace range on a name this
//     check pins, which makes it the first manifest to look at when the
//     resolved-version assertion below fires. Do NOT append it to
//     `playwrightManifests` as it stands: the exactness check rejects its range
//     and would turn `check:lockfile` red immediately.
//   - `packages/mobile-mcp` also depends on `mobilewright`, which pins
//     `playwright` and `playwright-core` to an exact older revision no manifest
//     edit here can dedupe. That tree hoists the older `playwright-core` to the
//     root, so the root `playwright-core` bin is NOT part of this parity — only
//     the `playwright` CLIs are.
//   - `integration-tests/terminal-capture` declares a `playwright` range but is
//     not a workspace member, so it does not enter the lockfile. Bringing it inside
//     the invariant takes three steps, not one: pin it exact, list the directory
//     in BOTH the root `workspaces` and `pnpm-workspace.yaml`'s `packages:`
//     (scripts/tests/package-scripts.test.js asserts the two lists are equal),
//     then append it below and regenerate the lockfile. Two test-side edits
//     ride with the append: `scripts/tests/check-lockfile.test.js` copies only
//     the manifests its fixtures perturb, so the new one joins its `FILES`, and
//     its third-manifest arm builds a third entry by rewriting a literal copy
//     of the list below — with a real third entry present that arm asserts on a
//     list the file no longer has, so retire it or repoint it at a fourth.
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
      `${manifest} declares ${name} as "${spec}"; expected an exact version so it cannot resolve apart from the others`,
    );
  }
}

// Every entry is compared against the first rather than the second against the
// first: `playwrightManifests` is a list a maintainer extends, and a positional
// destructure hands a third entry the exactness check while silently skipping
// the agreement check this block exists for.
const [pinEntry, ...restEntries] = playwrightSpecs;
const pinned = pinEntry.spec;
for (const { manifest, name, spec, exact } of restEntries) {
  if (exact && pinEntry.exact && spec !== pinned) {
    parityErrors.push(
      `${pinEntry.name} ${pinned} (${pinEntry.manifest}) and ${name} ${spec} (${manifest}) must declare the same version`,
    );
  }
}

// Manifest agreement is not enough on its own: a stale or hand-edited lockfile
// can still resolve the set apart. The importer check below asserts what each
// manifest resolves to; this one asserts that no pinned package pulls in
// another pinned package at a different revision, which would install a second
// chromium beside the one the harness launches. Derived from the manifest list
// in both directions, so an entry appended above is covered here too.
if (pinEntry.exact) {
  const pinnedNames = playwrightSpecs.map(({ name }) => name);
  const snapshots = pnpmLockfile?.snapshots ?? {};
  for (const outer of pinnedNames) {
    const key = Object.keys(snapshots).find(
      (candidate) =>
        candidate === `${outer}@${pinned}` ||
        candidate.startsWith(`${outer}@${pinned}(`),
    );
    if (key === undefined) {
      parityErrors.push(
        `pnpm-lock.yaml has no snapshot for ${outer}@${pinned}; regenerate it`,
      );
      continue;
    }
    for (const inner of pinnedNames) {
      if (outer === inner) {
        continue;
      }
      const version = snapshots[key]?.dependencies?.[inner];
      // A peer-resolved version carries a `(peer@x)` suffix; the revision is
      // the part before it.
      if (version !== undefined && String(version).split('(')[0] !== pinned) {
        parityErrors.push(
          `pnpm-lock.yaml resolves ${inner} under ${outer}@${pinned} to ${version}, splitting the chromium revision; regenerate the lockfile`,
        );
      }
    }
  }
}

// pnpm's --frozen-lockfile validates specifiers only, so the resolved version
// is asserted too.
// The recorded value is not always the manifest string: pnpm-workspace.yaml's
// `overrides:` and .pnpmfile.mjs's readPackage hook both rewrite it — web-shell
// declares `typescript: ^5.3.3` while the lockfile records `5.8.3`, because
// `overrides:` pins it. Neither layer touches Playwright today, so a divergence
// here is drift, but the messages name those layers because "regenerate it" is
// a no-op when one of them is what decides the value.
const pnpmImporters = pnpmLockfile?.importers ?? {};
for (const { manifest, name, spec, exact } of playwrightSpecs) {
  // A declaration that is simply gone is already an error above, and every
  // remedy this block offers — regenerate, check the importer is listed, an
  // overrides entry decides the value — presupposes the manifest still
  // declares the package. Running them anyway diagnoses one absence three
  // times and interpolates the missing spec as the string "null".
  if (spec === null) {
    continue;
  }
  const importer = dirname(manifest);
  const entry =
    pnpmImporters[importer]?.devDependencies?.[name] ??
    pnpmImporters[importer]?.dependencies?.[name] ??
    null;
  if (entry === null) {
    parityErrors.push(
      `pnpm-lock.yaml has no ${name} entry for importer "${importer}"; importers come from pnpm-workspace.yaml's packages:, so check that ${importer} is listed there, then regenerate`,
    );
    continue;
  }
  if (entry.specifier !== spec) {
    parityErrors.push(
      `pnpm-lock.yaml records ${name} in "${importer}" as "${entry.specifier}" but ${manifest} declares "${spec}"; regenerate it — unless pnpm-workspace.yaml's overrides: or .pnpmfile.mjs rewrites this package, in which case that layer decides the value and the manifest is not the source of truth`,
    );
  }
  if (exact && entry.version !== spec) {
    parityErrors.push(
      `pnpm-lock.yaml resolves ${name} in "${importer}" to ${entry.version} instead of ${spec}; regenerate it — unless an overrides: entry pins a different version`,
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
