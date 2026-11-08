/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-contract-version.js',
);
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-contract-version-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A contract document carrying `version`; `note` varies the bytes without
// moving the number, so "the document changed" and "the version moved" are
// independent fixture knobs — the two failure modes of #13804 differ
// exactly in which one moved.
function document(version, note = 'a') {
  const body = JSON.stringify(
    { openapi: '3.1.0', info: { title: 't', version }, note },
    null,
    2,
  );
  const file = join(root, `document-${version}-${note}-${body.length}.json`);
  writeFileSync(file, `${body}\n`);
  return file;
}
function raw(name, text) {
  const file = join(root, `${name}.json`);
  writeFileSync(file, text);
  return file;
}

function check(...args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

// The newline forgery below needs a path only the POSIX lanes allow; gate
// on the capability, as check-flyway-migrations.test.js does for names.
const newlinePathsWork = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'contract-path-probe-'));
  try {
    writeFileSync(join(probe, 'a\nb'), '{}');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe('check-contract-version', () => {
  it('passes a document identical to the base ref without comparing versions', () => {
    // The changed-paths list may name the document while the merge
    // result's bytes are the base ref's own; no version movement is owed.
    const file = document('1.38.0');
    const result = check(file, file);
    expect(result.output).toContain('identical to the base ref');
    expect(result.status).toBe(0);
  });

  it('fails a changed document that stayed at the base version', () => {
    // #13163's shape: the document moved (+4 −4) and info.version did not.
    const result = check(document('1.33.0'), document('1.33.0', 'b'));
    expect(result.output).toContain(
      'declares info.version 1.33.0, which does not advance past ' +
        "the base ref's 1.33.0",
    );
    expect(result.status).toBe(1);
  });

  it('fails a changed document whose version is below the base ref', () => {
    // The merge result's copy is what gets published: main at 1.35.0 with
    // a pull request declaring 1.34.0 is a regression, not a stall.
    const result = check(document('1.35.0'), document('1.34.0', 'b'));
    expect(result.output).toContain(
      'declares info.version 1.34.0, which regresses below ' +
        "the base ref's 1.35.0",
    );
    expect(result.status).toBe(1);
  });

  it('passes a changed document whose version strictly advances', () => {
    const result = check(document('1.38.0'), document('1.39.0'));
    expect(result.output).toContain(
      "info.version 1.39.0 advances past the base ref's 1.38.0",
    );
    expect(result.status).toBe(0);
  });

  it('compares versions numerically per segment', () => {
    // Witness for the numeric compare: a lexicographic one ranks '1.9.0'
    // above '1.37.0' and passes the regression below.
    const regressed = check(document('1.37.0'), document('1.9.0', 'b'));
    expect(regressed.output).toContain('regresses below');
    expect(regressed.status).toBe(1);
    const advanced = check(document('1.9.0'), document('1.37.0'));
    expect(advanced.status).toBe(0);
  });

  it('reads a missing trailing segment as zero', () => {
    // 1.38 declares the same version as 1.38.0, and 1.38.1 advances it.
    const stalled = check(document('1.38.0'), document('1.38', 'b'));
    expect(stalled.output).toContain('does not advance past');
    expect(stalled.status).toBe(1);
    expect(check(document('1.38'), document('1.38.1')).status).toBe(0);
  });

  it('ignores leading zeros when comparing', () => {
    const result = check(document('1.38.0'), document('1.038.0', 'b'));
    expect(result.output).toContain('does not advance past');
    expect(result.status).toBe(1);
  });

  it('fails a head document that does not parse', () => {
    // The guard must never pass vacuously: a broken document at the head
    // is the pull request's own failure, named on the head's path.
    const result = check(document('1.38.0'), raw('broken', '{"info":'));
    expect(result.output).toContain('is not parseable JSON');
    expect(result.output).toContain('broken.json');
    expect(result.status).toBe(1);
  });

  it('fails a head document without a numeric-segment version', () => {
    const result = check(document('1.38.0'), document('1.39-SNAPSHOT'));
    expect(result.output).toContain('declares no numeric-segment info.version');
    expect(result.status).toBe(1);
  });

  it('fails when the base ref copy does not parse', () => {
    // Nothing comparable means nothing may pass — never a silent pass on a
    // rotted fetch or a broken baseline.
    const result = check(raw('base-broken', 'not json'), document('1.39.0'));
    expect(result.output).toContain("base ref's copy is not parseable JSON");
    expect(result.status).toBe(1);
  });

  it('fails when the head document is missing or empty', () => {
    const missing = check(document('1.38.0'), join(root, 'gone.json'));
    expect(missing.output).toContain('gone.json');
    expect(missing.output).toContain('missing or empty');
    expect(missing.status).toBe(1);
    const empty = check(document('1.38.0'), raw('empty', '  \n'));
    expect(empty.output).toContain('missing or empty');
    expect(empty.status).toBe(1);
  });

  it('fails when the base document is missing or empty', () => {
    const missing = check(join(root, 'no-base.json'), document('1.39.0'));
    expect(missing.output).toContain('nothing to compare against');
    expect(missing.status).toBe(1);
  });

  it('refuses to run without both documents', () => {
    expect(check().status).toBe(2);
    const one = check(document('1.38.0'));
    expect(one.output).toContain('usage:');
    expect(one.status).toBe(2);
    // Three arguments can only be operator error, never a third document.
    expect(check(document('1.38.0'), document('1.39.0'), 'x').status).toBe(2);
  });

  it.skipIf(!newlinePathsWork)(
    'escapes a forged ::error:: line smuggled through the head path',
    () => {
      // The runner decodes a command's data where the log is rendered, so
      // the byte alphabet reaching it is bound the way
      // check-flyway-migrations.js binds contributor-controlled names.
      const forged = join(root, 'a\n::error::forged.json');
      writeFileSync(forged, '{"info":{"version":"1.38.0"}}');
      const result = check(document('1.38.0', 'b'), forged);
      expect(result.status).toBe(1);
      expect(
        result.output
          .split('\n')
          .every((line) => !line.startsWith('::error::forged')),
      ).toBe(true);
    },
  );
});
