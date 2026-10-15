/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Two agreements nothing else in the suite reads, all of which fail green.
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
// 2. The Desktop release gate must agree on the crate directory across its
//    presence guard, cache and working directories, and retain release tests.
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
const desktop = parseYaml(
  read('.github', 'workflows', 'desktop-packaging-check.yml'),
);
const release = parseYaml(read('.github', 'workflows', 'desktop-release.yml'));
const desktopJob = release.jobs.desktop_shell;
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

  it('fails when the release commit does not contain the desktop crate', () => {
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
      'a release commit without the desktop crate must fail the gate',
    ).toMatch(/^\s*exit 1\s*$/mu);
  });

  it('names one existing crate directory in every step', () => {
    const guardPath = /! -f (\S+)\/src-tauri\/Cargo\.toml/u.exec(
      filterRun,
    )?.[1];
    // The error names the crate's src-tauri, not the package directory.
    const noticePath = /::error::(\S+) is absent from the release commit/u
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

    const sites = {
      'Cargo.toml guard': guardPath,
      'guard ::error::': noticePath,
      'rust-cache workspaces': cacheRoot,
      ...Object.fromEntries(
        workingDirs.map((dir, index) => [`working-directory[${index}]`, dir]),
      ),
    };

    // Every site must resolve; an undefined one means the parser fell behind a
    // rewrite of the workflow, which must not read as agreement.
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

    const crateDir = sites['Cargo.toml guard'];
    expect(
      existsSync(join(root, crateDir, 'src-tauri', 'Cargo.toml')),
      `${crateDir}/src-tauri/Cargo.toml does not exist, so the release gate cannot test the desktop crate.`,
    ).toBe(true);
  });

  it('runs daily or manually without registering PR desktop jobs', () => {
    expect(ci.jobs.desktop_shell).toBeUndefined();
    expect(desktop.jobs.desktop_shell).toBeUndefined();
    expect(desktop.jobs.package.uses).toBe(
      './.github/workflows/desktop-release.yml',
    );
    expect(desktop.jobs.package.with.dry_run).toBe(true);
    expect(Object.keys(desktop.on).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);
    expect(desktop.on.schedule).toEqual([{ cron: '0 16 * * *' }]);
    expect(desktopJob.defaults.run.shell).toBe('bash');
  });

  it('gates publication on parallel checks of the same release commit', () => {
    expect(desktopJob.needs).toBe('prepare');
    expect(desktopJob.if).toBe(
      "${{ needs.prepare.outputs.already_published != 'true' }}",
    );
    expect(desktopJob.strategy.matrix.os).toEqual([
      'ubuntu-22.04',
      'windows-2022',
    ]);
    expect(desktopJob['continue-on-error']).toBeUndefined();
    // The shell lane runs in parallel with build; publish joins on both, so
    // a failed shell check blocks publication without serializing ahead of
    // the 120-minute build that runs the same tests on every matrix entry.
    expect(release.jobs.build.needs).toBe('prepare');
    expect(release.jobs.publish.needs).toEqual([
      'prepare',
      'desktop_shell',
      'build',
    ]);
    for (const name of ['desktop_shell', 'build', 'publish']) {
      const checkout = release.jobs[name].steps.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout.with.ref).toBe(
        '${{ needs.prepare.outputs.qwen_code_sha }}',
      );
    }
    expect(release.jobs.build.env.QWEN_CODE_COMMIT).toBe(
      '${{ needs.prepare.outputs.qwen_code_sha }}',
    );
  });

  it('runs release tests whenever the desktop crate is present', () => {
    expect(filterRun).toMatch(/^changed=true$/mu);
    const lane = stepNamed('Run desktop release tests');
    expect(lane.run).toBe('node scripts/test-release.js');
    expect(lane.if).toBe(
      "${{ steps.filter.outputs.changed == 'true' && runner.os == 'Linux' }}",
    );
  });
});
