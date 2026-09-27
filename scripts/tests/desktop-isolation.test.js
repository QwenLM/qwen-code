/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Two agreements nothing else in the suite reads, both of which fail green.
//
// 1. `scripts/check-desktop-isolation.js` keeps a `nativePrefixes` list, and
//    the root workspace manifests keep a `!packages/*` negation per native
//    package. Those two lists are maintained by hand on opposite sides of the
//    same invariant, so a rename that moves one and not the other leaves the
//    guard matching nothing while it still prints "passed".
//    `packages/desktop-shell` -> `packages/desktop` is exactly that rename, and
//    `'packages/desktop'` had to be added to `nativePrefixes` by hand for the
//    guard to keep covering the package. Deleting the added line changes
//    neither the guard's output nor its exit code, so only this file notices.
//
// 2. The `desktop_shell` job in `ci.yml` names the crate directory in five
//    places -- the changed-files filter, the `Cargo.toml` existence guard and
//    its `::notice::` text, the rust-cache `workspaces:`, and two
//    `working-directory:` values. They have to name the same directory as each
//    other and a directory that exists, or the job skips and reports success
//    having compiled nothing.
//
// The npm/pnpm mirror of the negation list is already pinned by
// `package-scripts.test.js` ("mirrors the npm workspace boundaries in
// pnpm-workspace.yaml"), so these tests read `package.json` only.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

// The script runs `npm query` and calls `process.exit` at import time, so it
// cannot be imported for its list; parse the literal instead. Line comments are
// stripped first so prose inside the array cannot contribute an entry.
function nativePrefixesFromSource(source) {
  const array = /const nativePrefixes = \[([\s\S]*?)\n\];/u.exec(source);
  if (!array) {
    throw new Error(
      'scripts/check-desktop-isolation.js no longer declares `const nativePrefixes = [...]`; update this parser.',
    );
  }
  return [...array[1].replace(/\/\/[^\n]*/gu, '').matchAll(/'([^']+)'/gu)].map(
    (match) => match[1],
  );
}

// A hand-copied duplicate of the rule `isNativeLocation` implements in
// `scripts/check-desktop-isolation.js`, used below to check the prefix *data*.
// Only the array literal is read back from the script, not the rule, so a
// change to the script's rule does not fail here -- update this copy by hand.
const isNativeLocation = (location, prefixes) =>
  prefixes.some(
    (prefix) => location === prefix || location.startsWith(`${prefix}/`),
  );

const nativePrefixes = nativePrefixesFromSource(
  read('scripts', 'check-desktop-isolation.js'),
);
const npmNegations = JSON.parse(read('package.json'))
  .workspaces.filter(
    (entry) => typeof entry === 'string' && entry.startsWith('!'),
  )
  .map((entry) => entry.slice(1));

const ci = parseYaml(read('.github', 'workflows', 'ci.yml'));
const desktopJob = ci.jobs.desktop_shell;
const stepNamed = (name) =>
  desktopJob.steps.find((step) => step.name === name) ??
  desktopJob.steps.find((step) => String(step.uses ?? '').includes(name));

describe('desktop isolation guard — nativePrefixes coverage', () => {
  it('matches every negated native workspace entry', () => {
    expect(npmNegations.length).toBeGreaterThan(0);
    for (const location of npmNegations) {
      expect(
        isNativeLocation(location, nativePrefixes),
        `package.json negates !${location}, but no nativePrefixes entry matches it under the script's rule, so check-desktop-isolation.js would not recognise the package if it re-entered the workspace set. nativePrefixes: ${JSON.stringify(nativePrefixes)}`,
      ).toBe(true);
    }
  });

  it('negates every native prefix that exists on disk', () => {
    // Keyed on the manifest, not the directory: `packages/*` only makes a
    // directory a workspace member if it holds a package.json, while ignored
    // build residue (node_modules, src-tauri/target) survives a branch switch
    // under a path that is no longer a package at all.
    const onDisk = nativePrefixes.filter((prefix) =>
      existsSync(join(root, prefix, 'package.json')),
    );
    // Without this the test would also pass on a tree where the package moved
    // and no prefix resolved at all.
    expect(onDisk).toContain('packages/desktop');
    for (const prefix of onDisk) {
      expect(
        npmNegations,
        `${prefix} holds a package.json but the root manifest does not negate it, so \`packages/*\` pulls it into the root npm workspace set.`,
      ).toContain(prefix);
    }
  });

  it('keeps the pre-rename tripwire, which has no negation to mirror', () => {
    // Recorded intent: docs/design/9152-architecture-invariant-classification.md
    // ("fails if `packages/desktop` or `packages/desktop-shell` re-enters the
    // root npm workspace set"). The coverage assertions above are deliberately
    // superset-shaped so this entry, which nothing negates, stays legal.
    expect(nativePrefixes).toContain('packages/desktop-shell');
    // The manifest, not the directory: ignored build residue under the old
    // path survives a branch switch and is not the re-entry this pins.
    expect(
      existsSync(join(root, 'packages', 'desktop-shell', 'package.json')),
      'packages/desktop-shell holds a package.json again, so `packages/*` pulls the pre-rename path back into the root npm workspace set.',
    ).toBe(false);
  });
});

describe('desktop_shell CI job — the crate path agrees with itself', () => {
  const filterStep = desktopJob.steps.find((step) => step.id === 'filter');
  const filterRun = String(filterStep?.run ?? '');

  it('still carries the Cargo.toml existence guard, and it clears changed', () => {
    // Not redundant with the filter: the filter also matches on ci.yml and
    // desktop-release.yml changing, which a head with no crate at all can do.
    // That is the #8132 failure the job's header comment describes.
    // The condition is only half the guard: without the assignment inside its
    // own body, every gated step still runs against a crate that is not there.
    const guardBody =
      /! -f \S+\/src-tauri\/Cargo\.toml \]\]; then\n([\s\S]*?)\n[ \t]*fi/u.exec(
        filterRun,
      )?.[1];
    expect(
      guardBody,
      'the Cargo.toml guard lost its `if ...; then ... fi` body',
    ).toBeDefined();
    expect(
      guardBody,
      'the Cargo.toml guard no longer sets changed=false inside its own body, so a head without the crate runs every gated step and reports a missing working directory as a failure of the PR',
    ).toMatch(/^\s*changed=false\s*$/mu);
  });

  it('names one crate directory in all five places, and it exists', () => {
    const filterAlternative = /\^\(([^|]+)\|/u.exec(filterRun)?.[1];
    expect(
      filterAlternative,
      'changed-files filter lost its path alternative',
    ).toBeDefined();

    const guardPath = /! -f (\S+)\/src-tauri\/Cargo\.toml/u.exec(
      filterRun,
    )?.[1];
    // The notice names the crate's src-tauri, not the package directory.
    const noticePath = /::notice::(\S+) is absent from this head/u
      .exec(filterRun)?.[1]
      .replace(/\/src-tauri$/u, '');

    const rustCache = stepNamed('Swatinem/rust-cache');
    const cacheRoot = /^(.+?)\/src-tauri -> /u.exec(
      String(rustCache?.with?.workspaces ?? ''),
    )?.[1];

    const workingDirs = desktopJob.steps
      .map((step) => step['working-directory'])
      .filter((value) => value !== undefined)
      .map(String);

    expect(filterAlternative).toBeDefined();
    const sites = {
      'changed-files filter': filterAlternative.replace(/\/$/u, ''),
      'Cargo.toml guard': guardPath,
      'guard ::notice::': noticePath,
      'rust-cache workspaces': cacheRoot,
      ...Object.fromEntries(
        workingDirs.map((dir, index) => [`working-directory[${index}]`, dir]),
      ),
    };

    // Every site must resolve; an undefined one means the parser fell behind a
    // rewrite of ci.yml, which must not read as agreement.
    for (const [site, value] of Object.entries(sites)) {
      expect(
        value,
        `could not read the crate directory out of ${site}`,
      ).toBeDefined();
    }
    expect(
      new Set(Object.values(sites)).size,
      JSON.stringify(sites, null, 2),
    ).toBe(1);

    const crateDir = sites['changed-files filter'];
    expect(
      existsSync(join(root, crateDir, 'src-tauri', 'Cargo.toml')),
      `${crateDir}/src-tauri/Cargo.toml does not exist, so every gated step in desktop_shell skips and the job reports success having compiled nothing.`,
    ).toBe(true);
    // The filter is `grep -Eq '^(<alternative>|...)'` over the PR's changed
    // file names, so the alternative is a bare path prefix and has to end in
    // `/`: without it, `packages/desktop` also matches a sibling such as
    // `packages/desktop-extra/`, and the job runs on heads that never touch
    // the crate. Building a path out of `crateDir` -- this same alternative
    // with the slash stripped -- and comparing it back proves nothing.
    expect(
      filterAlternative.endsWith('/'),
      `the filter alternative ${filterAlternative} has no trailing slash, so the changed-files filter also matches sibling paths that merely start with it`,
    ).toBe(true);
  });
});
