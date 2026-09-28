/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-flyway-migrations.js',
);
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-flyway-migrations-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A Maven module holding the two migration locations that share one Flyway
// version sequence: SQL under resources, BaseJavaMigration classes under the
// db.migration package.
function module(name, { sql = [], java = [] } = {}) {
  const dir = join(root, name);
  for (const file of sql) {
    const target = join(dir, 'src/main/resources/db/migration', file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '');
  }
  for (const file of java) {
    const target = join(dir, 'src/main/java/db/migration', file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '');
  }
  return dir;
}

function check(...args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('check-flyway-migrations', () => {
  it('passes when every version is claimed once across both locations', () => {
    const dir = module('server', {
      sql: ['V1__core.sql', 'V2__store.sql', 'V16__evidence.sql'],
      java: ['V15__event_identity.java'],
    });
    const result = check(dir);
    expect(result.output).toContain('4 migrations, all versions unique');
    expect(result.status).toBe(0);
  });

  it('names both files when two migrations claim one version', () => {
    const dir = module('server', {
      sql: ['V16__runtime_loss_evidence.sql', 'V16__session_operation.sql'],
    });
    const result = check(dir);
    expect(result.output).toContain('2 migrations claim version 16');
    expect(result.output).toContain('V16__runtime_loss_evidence.sql');
    expect(result.output).toContain('V16__session_operation.sql');
    expect(result.output).not.toContain('all versions unique');
    expect(result.status).toBe(1);
  });

  it('sees a collision between the SQL and the Java location', () => {
    const dir = module('server', {
      sql: ['V15__event_identity.sql'],
      java: ['V15__event_identity.java'],
    });
    const result = check(dir);
    expect(result.output).toContain('2 migrations claim version 15');
    expect(result.status).toBe(1);
  });

  it('compares versions numerically the way Flyway does', () => {
    const dir = module('server', {
      sql: ['V016__a.sql', 'V16.0__c.sql', 'V16__b.sql'],
    });
    const result = check(dir);
    expect(result.output).toContain('3 migrations claim version 16');
    expect(result.status).toBe(1);
    const distinct = module('distinct', {
      sql: ['V16__a.sql', 'V16.1__b.sql'],
    });
    expect(check(distinct).status).toBe(0);
  });

  it('ignores files that are not versioned migrations', () => {
    const dir = module('server', {
      sql: [
        'V1__core.sql',
        'notes.md',
        'R__refresh_view.sql',
        'V2_missing_a_separator.sql',
      ],
      java: ['package-info.java'],
    });
    const result = check(dir);
    expect(result.output).toContain('1 migrations, all versions unique');
    expect(result.status).toBe(0);
  });

  it('scans subdirectories, which Flyway scans too', () => {
    const dir = module('server', {
      sql: ['V1__core.sql', join('backfill', 'V1__again.sql')],
    });
    const result = check(dir);
    expect(result.output).toContain('2 migrations claim version 1');
    expect(result.status).toBe(1);
  });

  it('checks every module it is given', () => {
    const first = module('first', { sql: ['V1__a.sql'] });
    const second = module('second', { sql: ['V2__b.sql', 'V2__c.sql'] });
    const result = check(first, second);
    expect(result.output).toContain('first: 1 migrations, all versions unique');
    expect(result.output).toContain('second: 2 migrations claim version 2');
    expect(result.status).toBe(1);
  });

  it('fails when a location rename would empty the guard', () => {
    const dir = module('server', { sql: ['V1__a.sql'] });
    rmSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'src/main/resources/db/migrations'), {
      recursive: true,
    });
    const result = check(dir);
    expect(result.output).toContain('found no migration under');
    expect(result.status).toBe(1);
  });

  it('refuses a missing module or a missing argument', () => {
    expect(check(join(root, 'absent')).status).toBe(1);
    const bare = check();
    expect(bare.output).toContain('usage:');
    expect(bare.status).toBe(2);
  });
});
