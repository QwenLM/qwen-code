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
// versions share one namespace. The SQL location is required: it is where
// this module's migration sequence lives, so finding no migration there means
// the location moved and the guard went blind. The Java location is optional
// — a module may carry SQL migrations only.
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

// The CI job runs on pull_request — fork PRs included — so the scanned
// filenames are contributor-controlled, and the runner parses workflow
// commands from stderr too: a raw LF in a filename would emit a second,
// forged ::error:: command from this step. Same idiom as
// escapeWorkflowCommand in scripts/generate-release-notes.js.
const escapeWorkflowCommand = (text) =>
  String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

let failed = false;
// Flyway resolves classpath:db/migration across every jar on the classpath,
// and managed-agent-server depends on runtime-broker, so the modules given in
// one invocation share one version namespace — a version claimed in two
// modules collides exactly like two files in one module do. The summary count
// and the required-location check stay per module.
const claimants = new Map();
const reported = new Set();
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
    failed = true;
    console.error(
      `::error::${escapeWorkflowCommand(module)}: found no migration under ` +
        `${moved.dir.join('/')}; if it moved, point this check at the new location`,
    );
    continue;
  }
  const mine = new Set();
  let count = 0;
  for (const { files } of found) {
    for (const file of files) {
      count += 1;
      const version = normalize(MIGRATION_NAME.exec(path.basename(file))[1]);
      mine.add(version);
      const group = claimants.get(version) ?? [];
      group.push(file);
      claimants.set(version, group);
    }
  }
  let duplicated = false;
  for (const version of mine) {
    const group = claimants.get(version);
    if (group.length > 1) {
      duplicated = true;
      // A collision already named for an earlier module is not repeated.
      if (reported.has(version)) continue;
      reported.add(version);
      failed = true;
      console.error(
        `::error::${escapeWorkflowCommand(module)}: ${group.length} migrations claim version ` +
          `${escapeWorkflowCommand(version)}: ${group.map(escapeWorkflowCommand).join(', ')}`,
      );
    }
  }
  if (!duplicated) {
    console.log(`${module}: ${count} migrations, all versions unique`);
  }
}
process.exitCode = failed ? 1 : 0;
