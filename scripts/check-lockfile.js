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
// Three other Playwright declarations are deliberately outside this invariant:
//   - `packages/mobile-mcp` declares `@playwright/test` as a range directly.
//     npm satisfies it from the single hoisted copy at the pinned version
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
//     not a workspace member, so it enters neither lockfile. Bringing it inside
//     the invariant takes three steps, not one: pin it exact, list the directory
//     in BOTH the root `workspaces` and `pnpm-workspace.yaml`'s `packages:`
//     (scripts/tests/package-scripts.test.js asserts the two lists are equal),
//     then append it below and regenerate both lockfiles. Two test-side edits
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
// can still resolve the set apart. Assert the resolved outcome too, deriving
// each location from the manifest list so an entry added above is covered by
// both halves rather than only by the exactness check.
if (pinEntry.exact) {
  for (const { name } of playwrightSpecs) {
    const location = `node_modules/${name}`;
    const actual = packages[location]?.version;
    if (actual === undefined) {
      parityErrors.push(
        `package-lock.json has no ${location} entry, so nothing hoists the package the harness imports; regenerate the lockfile`,
      );
    } else if (actual !== pinned) {
      parityErrors.push(
        `package-lock.json resolves ${location} to ${actual} instead of ${pinned}; regenerate the lockfile, and if that does not settle it then something is rewriting the resolved version — a manifest range resolving above the pin (packages/mobile-mcp's @playwright/test is the only in-workspace one) or the root package.json \`overrides:\` block, which carries no Playwright entry today`,
      );
    }
  }
  // A nested copy at the pinned version is a redundant install, not a split
  // revision, so only a differing one is an error. Derived from the manifest
  // list in both directions, so an entry appended above is covered by this
  // check as well as by the two over it — a split revision is the failure this
  // whole block exists to own, and it is the one check a hardcoded path would
  // silently stop applying to a third manifest.
  const pinnedNames = playwrightSpecs.map(({ name }) => name);
  for (const outer of pinnedNames) {
    for (const inner of pinnedNames) {
      if (outer === inner) {
        continue;
      }
      const nested = `node_modules/${outer}/node_modules/${inner}`;
      if (packages[nested] && packages[nested].version !== pinned) {
        parityErrors.push(
          `package-lock.json nests ${nested} at ${packages[nested].version}, splitting the chromium revision; regenerate the lockfile`,
        );
      }
    }
  }
}

// Both lockfiles are committed together, so a specifier or a resolved version
// that lands in one and not the other is the same drift. pnpm's
// --frozen-lockfile validates specifiers only, so the version is asserted too.
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
const npmLockedSources = new Set();
for (const [location, details] of Object.entries(packages)) {
  if (details.link === true || !location.includes('node_modules/')) {
    continue;
  }
  npmLockedVersions.add(
    `${npmPackageName(location, details)}@${details.version}`,
  );
  // pnpm keys a git or file: dependency by its source instead of a version
  // (`name@git+https://…#hash`), so those keys can only ever match npm's
  // `resolved`.
  if (
    details.resolved?.startsWith('git') ||
    details.resolved?.startsWith('file:')
  ) {
    npmLockedSources.add(
      `${npmPackageName(location, details)}@${details.resolved}`,
    );
  }
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
if (pnpmVersions.length === 0) {
  console.error(
    'Error: pnpm-lock.yaml has no packages section; the version agreement gate read nothing.',
  );
  process.exit(1);
}
const unlockedPnpmVersions = pnpmVersions.filter(
  (key) =>
    !npmLockedVersions.has(key) &&
    !npmLockedSources.has(key) &&
    !knownNpmLockGaps.has(key),
);
const staleNpmLockGaps = [...knownNpmLockGaps].filter(
  (key) => !pnpmVersions.includes(key) || npmLockedVersions.has(key),
);

if (unlockedPnpmVersions.length > 0) {
  console.error(
    '\nError: pnpm-lock.yaml resolves versions that package-lock.json does not lock. Regenerate it from package-lock.json with `corepack pnpm import`. If the divergence survives that, a pnpm-workspace.yaml `overrides:` entry is deciding the version (three pin typescript today) and no npm-side regeneration can match it:',
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
  Object.entries(pnpmWorkspace?.allowBuilds ?? {})
    // pnpm itself records an undecided entry as the string 'set this to true
    // or false'; only a boolean runs or skips a build.
    .filter(([, decision]) => typeof decision === 'boolean')
    .map(([key]) => pnpmPackageName(key)),
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
