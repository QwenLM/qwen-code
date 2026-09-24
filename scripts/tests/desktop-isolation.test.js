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

// The rule `isNativeLocation` implements, restated so a change there has to be
// made here too.
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
    const onDisk = nativePrefixes.filter((prefix) =>
      existsSync(join(root, prefix)),
    );
    // Without this the test would also pass on a tree where the package moved
    // and no prefix resolved at all.
    expect(onDisk).toContain('packages/desktop');
    for (const prefix of onDisk) {
      expect(
        npmNegations,
        `${prefix} exists on disk but package.json does not negate it, so it joins the root npm workspace set.`,
      ).toContain(prefix);
    }
  });

  it('keeps the pre-rename tripwire, which has no negation to mirror', () => {
    // Recorded intent: docs/design/9152-architecture-invariant-classification.md
    // ("fails if `packages/desktop` or `packages/desktop-shell` re-enters the
    // root npm workspace set"). The coverage assertions above are deliberately
    // superset-shaped so this entry, which nothing negates, stays legal.
    expect(nativePrefixes).toContain('packages/desktop-shell');
    expect(existsSync(join(root, 'packages', 'desktop-shell'))).toBe(false);
  });
});

describe('desktop_shell CI job — the crate path agrees with itself', () => {
  const filterStep = desktopJob.steps.find((step) => step.id === 'filter');
  const filterRun = String(filterStep?.run ?? '');

  it('still carries the Cargo.toml existence guard', () => {
    // Not redundant with the filter: the filter also matches on ci.yml and
    // desktop-release.yml changing, which a head with no crate at all can do.
    // That is the #8132 failure the job's header comment describes.
    expect(filterRun).toMatch(/! -f \S+\/src-tauri\/Cargo\.toml/u);
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
    // file names, so the alternative has to be a literal prefix of a path
    // inside the crate: a head that edits only the crate must still run the
    // job.
    expect(
      `${crateDir}/src-tauri/src/main.rs`.startsWith(filterAlternative),
      `the filter alternative ${filterAlternative} does not match paths under ${crateDir}`,
    ).toBe(true);
  });
});
