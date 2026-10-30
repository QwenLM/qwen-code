/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Flyway's naming rules for managed-agent-server's hand-allocated versions,
// shared by check-flyway-migrations.js (one checkout) and
// check-flyway-open-prs.js (open pull requests against main).

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Registered locations cover the legacy upgrades and the fresh managed-schema
// baseline in Managed Agent Server; versions are checked across dependencies.
// Flyway scans each location AND its subdirectories, and nowhere else — a
// versioned-migration file anywhere
// else under the source root is invisible to it, so finding one there means
// the location moved and check-flyway-migrations.js must say so instead of
// passing on what is left. Its probes derive the db roots and source roots
// from this table, so editing it cannot silently blind them.
export const LOCATIONS = [
  { dir: ['src', 'main', 'resources', 'db', 'migration'], suffix: '.sql' },
  { dir: ['src', 'main', 'java', 'db', 'migration'], suffix: '.java' },
  { dir: ['src', 'main', 'resources', 'db', 'managed-schema'], suffix: '.sql' },
];

// A versioned migration is V<version>__<description>; the version is numeric
// segments joined by dots or underscores.
const MIGRATION_NAME = /^V(\d+(?:[._]\d+)*)__/;

// Flyway compares versions numerically segment by segment, so V016 collides
// with V16 and a trailing .0 segment carries no meaning.
const normalize = (version) =>
  version
    .split(/[._]/)
    .map((segment) => segment.replace(/^0+(?=\d)/, ''))
    .join('.')
    .replace(/(\.0)*$/, '');

export const migrationVersion = (name) =>
  normalize(MIGRATION_NAME.exec(name)[1]);

export function compareMigrationVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0n;
    const y = b[i] ?? 0n;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Flyway matches the suffix case-insensitively — V1__b.SQL claims version 1
// exactly like V1__a.sql does.
export const isMigrationFile = (name, suffix) =>
  name.toLowerCase().endsWith(suffix) && MIGRATION_NAME.test(name);

export const isMigrationPath = (modules, file) =>
  modules.some((module) =>
    LOCATIONS.some(
      (location) =>
        file.startsWith(`${path.posix.join(module, ...location.dir)}/`) &&
        isMigrationFile(path.posix.basename(file), location.suffix),
    ),
  );

// Not readdirSync's `recursive`: a Node older than 18.17 ignores it (see
// check-failsafe-reports.js). Flyway scans a location's subdirectories too.
export const migrationFiles = (dir, suffix) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? migrationFiles(path.join(dir, entry.name), suffix)
      : isMigrationFile(entry.name, suffix)
        ? [path.join(dir, entry.name)]
        : [],
  );
};
