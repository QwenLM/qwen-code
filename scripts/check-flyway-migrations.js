/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// managed-agent-server allocates Flyway versions by hand across two
// directories that share one sequence — src/main/resources/db/migration (SQL)
// and src/main/java/db/migration (BaseJavaMigration classes). On 2026-09-28
// two in-flight PRs each added a V16 and merged 23 minutes apart; each branch
// was green in isolation, and Flyway refused to boot the merged result
// ("Found more than one migration with version 16"), leaving main red for two
// hours (#12940). The test that catches a duplicate boots a database and runs
// only in the slow database-backed lanes, after the merge has landed. This
// check is the fast lane: it scans both locations and fails when two files
// claim the same version, naming them, in milliseconds and with no database.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { escapeWorkflowCommand } from './release-script-utils.js';

// Both locations resolve into Flyway's classpath:db/migration, so their
// versions share one namespace. Flyway scans each location AND its
// subdirectories, and nowhere else — a versioned-migration file anywhere
// else under the source root is invisible to it, so finding one there means
// the location moved and the guard must say so instead of passing on what is
// left. Everything below derives the db roots and source roots from this
// table, so editing it cannot silently blind the probes.
const LOCATIONS = [
  { dir: ['src', 'main', 'resources', 'db', 'migration'], suffix: '.sql' },
  { dir: ['src', 'main', 'java', 'db', 'migration'], suffix: '.java' },
];

// A versioned migration is V<version>__<description>; the version is numeric
// segments joined by dots or underscores.
const MIGRATION_NAME = /^V(\d+(?:[._]\d+)*)__/;

const modules = [...new Set(process.argv.slice(2))];
if (modules.length === 0) {
  console.error(
    'usage: node scripts/check-flyway-migrations.js <maven-module-dir>...',
  );
  process.exit(2);
}

// Flyway compares versions numerically segment by segment, so V016 collides
// with V16 and a trailing .0 segment carries no meaning.
const normalize = (version) =>
  version
    .split(/[._]/)
    .map((segment) => segment.replace(/^0+(?=\d)/, ''))
    .join('.')
    .replace(/(\.0)*$/, '');

// Flyway matches the suffix case-insensitively — V1__b.SQL claims version 1
// exactly like V1__a.sql does.
const isMigrationFile = (name, suffix) =>
  name.toLowerCase().endsWith(suffix) && MIGRATION_NAME.test(name);

// Not readdirSync's `recursive`: a Node older than 18.17 ignores it (see
// check-failsafe-reports.js). Flyway scans a location's subdirectories too.
const migrationFiles = (dir, suffix) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? migrationFiles(path.join(dir, entry.name), suffix)
      : isMigrationFile(entry.name, suffix)
        ? [path.join(dir, entry.name)]
        : [],
  );
};

// Files shaped like a versioned migration of this location's kind, anywhere
// under the source root EXCEPT inside the configured location. A renamed
// location (db/migration → db/changelog) leaves the guard scanning an empty
// directory, so the renamed-away state must fail here — and so must a
// location whose files moved while its sibling stayed populated.
const outOfPlaceFiles = (module, location) => {
  const sourceRoot = path.join(module, ...location.dir.slice(0, -2));
  const configured = path.join(module, ...location.dir);
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (file !== configured) walk(file);
      } else if (isMigrationFile(entry.name, location.suffix)) {
        found.push(file);
      }
    }
  };
  walk(sourceRoot);
  return found;
};

// A db/migration* sibling under the location's OWN db root — including an
// emptied rename such as db/migrations — marks the location as moved even
// when nothing migration-shaped survives anywhere. A module with no such
// directory at all (runtime-broker today) simply has no sequence to check,
// which is what lets one invocation cover every module that shares the
// classpath namespace below.
const hasMigrationDir = (module, location) => {
  const dbRoot = path.join(module, ...location.dir.slice(0, -1));
  return (
    existsSync(dbRoot) &&
    readdirSync(dbRoot, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(location.dir.at(-1)),
    )
  );
};

let failed = false;
// Flyway resolves classpath:db/migration across every jar on the classpath,
// and managed-agent-server depends on the other modules at compile scope, so
// the modules given in one invocation share one version namespace — a version
// claimed in two modules collides exactly like two files in one module do.
// Collisions are reported only after every module is scanned: one ::error::
// line per collided version names EVERY claimant (the consumer keys its issue
// on the module and version in this line, so a second line for the same
// version would file a second issue), and a claimant module never prints an
// "all versions unique" summary.
const claimants = new Map();
const scanned = [];
for (const module of modules) {
  if (!existsSync(module)) {
    failed = true;
    console.error(
      `::error::${escapeWorkflowCommand(module)}: no such Maven module directory`,
    );
    continue;
  }
  let errored = false;
  let count = 0;
  for (const location of LOCATIONS) {
    const files = migrationFiles(
      path.join(module, ...location.dir),
      location.suffix,
    );
    // Out-of-place files must not join the claimants: invisible to Flyway,
    // they cannot collide at runtime — they are the moved location's error,
    // not a second claimant for their version. A location that EXISTS is not
    // moved, however empty: the rename probe fires only when the location
    // directory itself is gone and a migration* sibling took its place.
    const misplaced = outOfPlaceFiles(module, location);
    if (
      misplaced.length > 0 ||
      (files.length === 0 &&
        !existsSync(path.join(module, ...location.dir)) &&
        hasMigrationDir(module, location))
    ) {
      failed = true;
      errored = true;
      console.error(
        `::error::${escapeWorkflowCommand(module)}: found no migration under ` +
          `${location.dir.join('/')}; if it moved, point this check at the ` +
          `new location${
            misplaced.length > 0
              ? `: ${misplaced.map(escapeWorkflowCommand).join(', ')}`
              : ''
          }`,
      );
    }
    for (const file of files) {
      count += 1;
      const version = normalize(MIGRATION_NAME.exec(path.basename(file))[1]);
      const group = claimants.get(version) ?? [];
      group.push({ module, file });
      claimants.set(version, group);
    }
  }
  if (!errored && count === 0) {
    console.log(`${module}: no migration directories`);
    continue;
  }
  scanned.push({ module, count, errored });
}
const collided = new Set();
for (const [version, group] of claimants) {
  if (group.length < 2) continue;
  failed = true;
  console.error(
    `::error::${escapeWorkflowCommand(group[0].module)}: ${group.length} migrations claim version ` +
      `${escapeWorkflowCommand(version)}: ${group.map(({ file }) => escapeWorkflowCommand(file)).join(', ')}`,
  );
  for (const { module } of group) collided.add(module);
}
for (const { module, count, errored } of scanned) {
  if (errored || collided.has(module)) continue;
  console.log(`${module}: ${count} migrations, all versions unique`);
}
process.exitCode = failed ? 1 : 0;
