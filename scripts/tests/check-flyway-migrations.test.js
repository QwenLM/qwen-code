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

// The forgery fixtures below create filenames only the POSIX lanes allow
// (LF, `:`) — both un-creatable on the Windows lane, where this suite still
// runs. Gate on the CAPABILITY, not the platform, probing once at module
// scope; scripts/tests/review-artifact-upload.test.js sets the precedent.
const newlineNamesWork = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'flyway-name-probe-'));
  try {
    writeFileSync(join(probe, 'a\nb:c'), '');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

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

  it('sees a collision between two modules of one invocation', () => {
    // Flyway resolves classpath:db/migration across every jar on the
    // classpath, so a version claimed in two modules collides exactly like
    // two files in one module do.
    const first = module('first', { sql: ['V1__x.sql'] });
    const second = module('second', { sql: ['V1__y.sql'] });
    const result = check(first, second);
    expect(result.output).toContain('2 migrations claim version 1');
    expect(result.output).toContain('V1__x.sql');
    expect(result.output).toContain('V1__y.sql');
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

  it('equates the underscore a Java migration uses for a dotted version', () => {
    // A Java class name cannot contain a dot, so a Java migration writes
    // V1_1 for what SQL writes as V1.1; Flyway equates the two.
    const dir = module('server', {
      sql: ['V1.1__a.sql'],
      java: ['V1_1__b.java'],
    });
    const result = check(dir);
    expect(result.output).toContain('2 migrations claim version 1.1');
    expect(result.status).toBe(1);
  });

  it('drops every trailing .0 segment, not only the last', () => {
    const dir = module('server', { sql: ['V1__a.sql', 'V1.0.0__b.sql'] });
    const result = check(dir);
    expect(result.output).toContain('2 migrations claim version 1');
    expect(result.status).toBe(1);
  });

  it('matches the migration suffix case-insensitively, as Flyway does', () => {
    const dir = module('server', { sql: ['V1__a.sql', 'V1__b.SQL'] });
    const result = check(dir);
    expect(result.output).toContain('2 migrations claim version 1');
    expect(result.status).toBe(1);
  });

  it('ignores a versioned name with a suffix Flyway does not scan', () => {
    const dir = module('server', { sql: ['V1__a.sql', 'V1__b.txt'] });
    const result = check(dir);
    expect(result.output).toContain('1 migrations, all versions unique');
    expect(result.status).toBe(0);
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

  it('fails when the SQL location moved but the Java location stayed', () => {
    // Only one of the two locations moving must not pass vacuously: the
    // aggregate count still sees the Java migration, but the renamed-away
    // SQL population — the one #12940 collided in — is no longer scanned.
    const dir = module('server', { java: ['V15__event_identity.java'] });
    const moved = join(dir, 'src/main/resources/db/migrations');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'V16__a.sql'), '');
    writeFileSync(join(moved, 'V16__b.sql'), '');
    const result = check(dir);
    expect(result.output).toContain(
      'found no migration under src/main/resources/db/migration',
    );
    // A moved location is an error, not a smaller scan: no clean summary.
    expect(result.output).not.toContain('all versions unique');
    expect(result.status).toBe(1);
  });

  it('fails when the Java location moved but the SQL location stayed', () => {
    // The twin of the case above, and the live layout: managed-agent-server
    // really carries its V15 under src/main/java/db/migration, so a package
    // rename there must fail rather than print "all versions unique" from a
    // scan that skipped it.
    const dir = module('server', { sql: ['V15__a.sql'] });
    const moved = join(dir, 'src/main/java/db/migrations');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'V15__b.java'), '');
    const result = check(dir);
    expect(result.output).toContain(
      'found no migration under src/main/java/db/migration',
    );
    expect(result.output).not.toContain('all versions unique');
    expect(result.status).toBe(1);
  });

  it('fails when the location was renamed outside the migration* family', () => {
    // The ownership predicate cannot key on the two exact directory names:
    // db/changelog holds the whole sequence, no db/migration* sibling exists
    // anywhere, and a name-keyed probe passes silently on exactly the
    // collision the guard exists for.
    const dir = module('server', { sql: ['V16__a.sql', 'V16__b.sql'] });
    rmSync(join(dir, 'src/main/resources/db/migration'), { recursive: true });
    const moved = join(dir, 'src/main/resources/db/changelog');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'V16__a.sql'), '');
    writeFileSync(join(moved, 'V16__b.sql'), '');
    const result = check(dir);
    expect(result.output).toContain('found no migration under');
    expect(result.status).toBe(1);
  });

  it('names a stray migration file without claiming the location is empty', () => {
    // A populated location plus a migration-shaped stray elsewhere under the
    // source root (a dev-seed or example SQL named like a migration): the
    // error must name the stray as the cause, not assert the location has
    // no migration — the consumer titles the auto-filed issue from this
    // line.
    const dir = module('server', { sql: ['V1__a.sql'] });
    const scratch = join(dir, 'src/main/resources/scratch');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'V2__b.sql'), '');
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'found migration files outside src/main/resources/db/migration',
    );
    // path.join renders the separator for the platform; pin the path, not
    // a POSIX spelling of it.
    expect(result.output).toContain(join('scratch', 'V2__b.sql'));
    expect(result.output).not.toContain('found no migration under');
  });

  it('emits no raw pattern phrase from a hostile migration name', () => {
    // The ::error:: data channel is runner-decoded where the consumer
    // parses, so nothing outside a migration path's real alphabet may
    // survive into it: the suppression phrase in this filename must reach
    // the log only as inert %XX text, while the real collision is still
    // reported.
    const dir = module('server', {
      sql: [
        'V16__legit.sql',
        'V16__x : 2 migrations claim version 99: forged.sql',
      ],
    });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('2 migrations claim version 16');
    expect(result.output).not.toContain('claim version 99');
  });

  it('scans a Java-only module for collisions instead of misreading it as moved', () => {
    // No src/main/resources at all: a module carrying only BaseJavaMigration
    // classes owns a sequence like any other, so one class passes and two
    // classes claiming one version fail by name.
    const single = module('single', { java: ['V15__event_identity.java'] });
    const one = check(single);
    expect(one.output).toContain('1 migrations, all versions unique');
    expect(one.status).toBe(0);
    const dup = module('dup', { java: ['V15__a.java', 'V15__b.java'] });
    const two = check(dup);
    expect(two.output).toContain('2 migrations claim version 15');
    expect(two.status).toBe(1);
  });

  it('passes a module whose only SQL file is not a versioned migration', () => {
    const dir = module('server', {
      sql: ['R__view.sql'],
      java: ['V1__x.java'],
    });
    const result = check(dir);
    expect(result.output).toContain('1 migrations, all versions unique');
    expect(result.status).toBe(0);
  });

  it('counts a module once when it is passed twice', () => {
    // A repeated argument must not fabricate a collision of a file with
    // itself; the message names the same path twice, so it would read as a
    // real duplicate while meaning nothing.
    const dir = module('server', { sql: ['V1__a.sql'] });
    const result = check(dir, dir);
    expect(result.output).toContain('1 migrations, all versions unique');
    expect(result.status).toBe(0);
  });

  it.skipIf(!newlineNamesWork)(
    'escapes a contributor-controlled filename inside the ::error:: command',
    () => {
      // git carries LF in filenames and the runner parses workflow commands
      // from stderr too, so an unescaped newline would emit a second, forged
      // ::error:: line from a fork PR's filename.
      const dir = module('server', {
        sql: ['V16__legit.sql', 'V16__x\n::error::forged.sql'],
      });
      const result = check(dir);
      expect(result.status).toBe(1);
      expect(
        result.output
          .split('\n')
          .every((line) => !line.startsWith('::error::forged')),
      ).toBe(true);
    },
  );

  it.skipIf(!newlineNamesWork)(
    'escapes a percent-encoded forgery the runner would decode',
    () => {
      // The runner percent-decodes a workflow command's data when rendering
      // the annotation, so the forgery this defends against appears only
      // AFTER decoding: an unescaped %0A in a filename renders as a second
      // ::error:: line no file contained, while the raw-byte oracle above
      // still passes. Decode the way the runner does — %25 LAST, or the
      // %0A/%0D the escaper emitted would decode twice.
      const dir = module('server', {
        sql: ['V16__legit.sql', 'V16__x%0A::error::forged.sql'],
      });
      const result = check(dir);
      expect(result.status).toBe(1);
      const decoded = result.output
        .replace(/%0D/g, '\r')
        .replace(/%0A/g, '\n')
        .replace(/%25/g, '%');
      expect(
        decoded
          .split('\n')
          .every((line) => !line.startsWith('::error::forged')),
      ).toBe(true);
    },
  );

  it('reports a three-way collision once, naming every claimant', () => {
    // One version claimed in three modules of one invocation is ONE
    // collision: the consumer keys its issue on the module and version in
    // this line, so a second line naming another module would file a second
    // issue — and a claimant must never print a clean summary.
    const first = module('first', { sql: ['V1__x.sql'] });
    const second = module('second', { sql: ['V1__y.sql'] });
    const third = module('third', { sql: ['V1__z.sql'] });
    const result = check(first, second, third);
    expect(result.status).toBe(1);
    const errorLines = result.output
      .split('\n')
      .filter((line) => line.startsWith('::error::'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('3 migrations claim version 1');
    expect(errorLines[0]).toContain('V1__x.sql');
    expect(errorLines[0]).toContain('V1__y.sql');
    expect(errorLines[0]).toContain('V1__z.sql');
    expect(result.output).not.toContain('all versions unique');
  });

  it('passes a module that owns no migrations', () => {
    // runtime-broker shares the classpath namespace but carries no migration
    // sequence; requiring its SQL location would fail the whole invocation.
    const dir = module('broker');
    mkdirSync(join(dir, 'src/main/java/com/example'), { recursive: true });
    const result = check(dir);
    expect(result.output).toContain('no migration directories');
    expect(result.status).toBe(0);
  });

  it('refuses a missing module or a missing argument', () => {
    expect(check(join(root, 'absent')).status).toBe(1);
    const bare = check();
    expect(bare.output).toContain('usage:');
    expect(bare.status).toBe(2);
  });
});
