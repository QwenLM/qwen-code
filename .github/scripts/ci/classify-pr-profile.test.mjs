/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Executes the real classify-pr-profile.sh with a stubbed `gh` (and, for the
// classifier-failure case, a stubbed `node`) on PATH. The wrapper's own
// comment declares its jq projection the single home of the classifier's
// input contract — these tests are what make that claim enforceable: dropping
// `status` from the projection turns a renamed source→docs file into a plain
// docs path (classifyFileEntry consults `previous_filename` only when
// `status === "renamed"`), which downgraded a source PR in the probe that
// motivated this file. The exit-code contract (2 listing / 3 classifier) is
// consumed by both ci.yml and the review workflow's docs-only gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, 'classify-pr-profile.sh');

function run(scenario, { stubNodeFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'classify-pr-profile-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const write = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  // The gh stub serves the two calls the wrapper makes: the paginated file
  // listing and the PR object's changed_files count. For the listing it
  // applies the wrapper's OWN `--jq` argument to a full API-shaped fixture
  // with real jq — so the projection (the input contract this wrapper exists
  // to be the single home of) is genuinely under test: dropping `status` or
  // `previous_filename` from it changes what the classifier sees and turns
  // the renamed-source scenario red, instead of the stub hardcoding the
  // projected output and keeping every projection mutant green.
  write(
    'gh',
    [
      '#!/bin/bash',
      'jqfilter=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--jq" ]; then jqfilter="$a"; fi; prev="$a"; done',
      'case "$*" in',
      '  *"/files"*)',
      '    case "$SCENARIO" in',
      '      list-fail) exit 1 ;;',
      '      docs-only) FIXTURE=\'[{"filename":"docs/users/a.md","status":"modified","previous_filename":null,"sha":"x","additions":1},{"filename":"README.md","status":"modified","previous_filename":null,"sha":"y","additions":1}]\' ;;',
      '      renamed-source) FIXTURE=\'[{"filename":"docs/new.md","status":"renamed","previous_filename":"packages/core/src/runtime.ts","sha":"z","additions":0}]\' ;;',
      '      truncated) FIXTURE=\'[{"filename":"docs/users/a.md","status":"modified","previous_filename":null,"sha":"x","additions":1}]\' ;;',
      '      declared-fails) FIXTURE=\'[{"filename":"docs/users/a.md","status":"modified","previous_filename":null,"sha":"x","additions":1}]\' ;;',
      '      *) exit 9 ;;',
      '    esac',
      '    printf \'%s\' "$FIXTURE" | jq -c "$jqfilter" ;;',
      '  *"repos/"*)',
      '    case "$SCENARIO" in',
      '      truncated) echo 5 ;;',
      '      declared-fails) exit 1 ;;',
      '      docs-only) echo 2 ;;',
      '      renamed-source) echo 1 ;;',
      '      *) exit 9 ;;',
      '    esac ;;',
      '  *) exit 9 ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
  );
  if (stubNodeFailure) {
    write('node', '#!/bin/bash\nexit 1\n');
  }
  try {
    const stdout = execFileSync('bash', [wrapper, 'o/r', '42'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SCENARIO: scenario,
        RUNNER_TEMP: dir,
      },
    });
    return { code: 0, stdout: stdout.trim() };
  } catch (e) {
    return { code: e.status, stdout: `${e.stdout ?? ''}`.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('classifies a docs-only listing as docs_only', () => {
  assert.deepEqual(run('docs-only'), { code: 0, stdout: 'docs_only' });
});

test('a renamed source→docs file classifies full (the projection carries status/previous_filename)', () => {
  assert.deepEqual(run('renamed-source'), { code: 0, stdout: 'full' });
});

test('a listing shorter than the PR-declared changed_files classifies full (3,000-file cap)', () => {
  assert.deepEqual(run('truncated'), { code: 0, stdout: 'full' });
});

test('exit 2 when the file listing fails', () => {
  assert.equal(run('list-fail').code, 2);
});

test('exit 3 when the classifier fails', () => {
  assert.equal(run('docs-only', { stubNodeFailure: true }).code, 3);
});

test('exit 2 when the changed_files fetch fails after a successful listing', () => {
  // The truncation guard's precondition: a swallowed failure here leaves
  // `declared` empty and the guard silently skipped (probed mutant
  // `|| exit 2` → `|| true` classified a docs first page as docs_only).
  const r = run('declared-fails');
  assert.equal(r.code, 2);
});
