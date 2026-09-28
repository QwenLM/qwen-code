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

// Both locations resolve into Flyway's classpath:db/migration, so their
// versions share one namespace.
const LOCATIONS = [
  { dir: ['src', 'main', 'resources', 'db', 'migration'], suffix: '.sql' },
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
// check-failsafe-reports.js). Flyway scans a location's subdirectories too.
const migrationFiles = (dir, suffix) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? migrationFiles(path.join(dir, entry.name), suffix)
      : entry.name.endsWith(suffix) && MIGRATION_NAME.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );
};

let failed = false;
for (const module of modules) {
  if (!existsSync(module)) {
    failed = true;
    console.error(`::error::${module}: no such Maven module directory`);
    continue;
  }
  const claimants = new Map();
  for (const { dir, suffix } of LOCATIONS) {
    for (const file of migrationFiles(path.join(module, ...dir), suffix)) {
      const version = normalize(MIGRATION_NAME.exec(path.basename(file))[1]);
      const files = claimants.get(version) ?? [];
      files.push(file);
      claimants.set(version, files);
    }
  }
  // A module with no migration at all means the locations moved and the
  // guard went with them; say so instead of passing vacuously.
  if (claimants.size === 0) {
    failed = true;
    console.error(
      `::error::${module}: found no migration under ` +
        `${LOCATIONS.map(({ dir }) => dir.join('/')).join(' or ')}; ` +
        'if they moved, point this check at the new locations',
    );
    continue;
  }
  let duplicated = false;
  for (const [version, files] of claimants) {
    if (files.length > 1) {
      failed = true;
      duplicated = true;
      console.error(
        `::error::${module}: ${files.length} migrations claim version ` +
          `${version}: ${files.join(', ')}`,
      );
    }
  }
  if (!duplicated) {
    console.log(`${module}: ${claimants.size} migrations, all versions unique`);
  }
}
process.exitCode = failed ? 1 : 0;
