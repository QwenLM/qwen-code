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

// Match the runtime's Flyway locations, including their subdirectories.
export const LOCATIONS = [
  { dir: ['src', 'main', 'resources', 'db', 'managed-schema'], suffix: '.sql' },
];

// Keep probing source roots even when no runtime location uses that kind of
// migration, so retiring Java migrations cannot hide misplaced classes.
export const MIGRATION_SOURCES = [
  { dir: ['src', 'main', 'resources'], suffix: '.sql' },
  { dir: ['src', 'main', 'java'], suffix: '.java' },
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

// Flyway matches the suffix case-insensitively — V1__b.SQL claims version 1
// exactly like V1__a.sql does.
export const isMigrationFile = (name, suffix) =>
  name.toLowerCase().endsWith(suffix) && MIGRATION_NAME.test(name);

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
