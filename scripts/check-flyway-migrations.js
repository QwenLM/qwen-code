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
// versions share one namespace. The SQL location is required of a module
// that owns migrations: finding none there means the location moved and the
// guard went blind. The Java location is optional — a module may carry SQL
// migrations only.
const LOCATIONS = [
  {
    dir: ['src', 'main', 'resources', 'db', 'migration'],
    suffix: '.sql',
    required: true,
  },
  { dir: ['src', 'main', 'java', 'db', 'migration'], suffix: '.java' },
];

// A versioned migration is V<version>__<description>; the version is numeric
// segments joined by dots or underscores.
const MIGRATION_NAME = /^V(\d+(?:[._]\d+)*)__/;

const modules = process.argv.slice(2);
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

// Not readdirSync's `recursive`: a Node older than 18.17 ignores it (see
// check-failsafe-reports.js). Flyway scans a location's subdirectories too,
// and matches the suffix case-insensitively — V1__b.SQL claims version 1
// exactly like V1__a.sql does.
const migrationFiles = (dir, suffix) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? migrationFiles(path.join(dir, entry.name), suffix)
      : entry.name.toLowerCase().endsWith(suffix) &&
          MIGRATION_NAME.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );
};

// A db/migration* directory under either db root — including a renamed-away
// sibling such as db/migrations — marks the module as owning a migration
// sequence. Only then does an empty SQL location mean the location moved;
// a module with no such directory at all (runtime-broker today) simply has
// no sequence to check, which is what lets one invocation cover every module
// that shares the classpath namespace below.
const hasMigrationDir = (module) =>
  ['src/main/resources/db', 'src/main/java/db'].some((dbRoot) => {
    const dir = path.join(module, dbRoot);
    return (
      existsSync(dir) &&
      readdirSync(dir, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && entry.name.startsWith('migration'),
      )
    );
  });

let failed = false;
// Flyway resolves classpath:db/migration across every jar on the classpath,
// and managed-agent-server depends on runtime-broker, so the modules given in
// one invocation share one version namespace — a version claimed in two
// modules collides exactly like two files in one module do. Collisions are
// reported only after every module is scanned: one ::error:: line per
// collided version names EVERY claimant (the consumer keys its issue on the
// module and version in this line, so a second line for the same version
// would file a second issue), and a claimant module never prints an
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
  const found = LOCATIONS.map(({ dir, suffix, required = false }) => ({
    dir,
    required,
    files: migrationFiles(path.join(module, ...dir), suffix),
  }));
  const moved = found.find(
    ({ required, files }) => required && files.length === 0,
  );
  if (moved) {
    if (!hasMigrationDir(module)) {
      console.log(`${module}: no migration directories`);
      continue;
    }
    failed = true;
    console.error(
      `::error::${escapeWorkflowCommand(module)}: found no migration under ` +
        `${moved.dir.join('/')}; if it moved, point this check at the new location`,
    );
    continue;
  }
  let count = 0;
  for (const { files } of found) {
    for (const file of files) {
      count += 1;
      const version = normalize(MIGRATION_NAME.exec(path.basename(file))[1]);
      const group = claimants.get(version) ?? [];
      group.push({ module, file });
      claimants.set(version, group);
    }
  }
  scanned.push({ module, count });
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
for (const { module, count } of scanned) {
  if (collided.has(module)) continue;
  console.log(`${module}: ${count} migrations, all versions unique`);
}
process.exitCode = failed ? 1 : 0;
