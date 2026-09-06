/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Executes the real upsert-bot-comment.sh with a stubbed `gh` + `sleep` on
// PATH. The scenarios pin the protocol's load-bearing properties, each of
// which survived as a green mutant when it lived untested inside a workflow
// step: the author scope (a user-posted marker must not capture the upsert),
// the per-attempt re-resolution (a comment deleted mid-retry falls back to
// POST instead of PATCHing a stale id), and the --update-only no-op (a
// supersede must never mint a badge where none existed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'upsert-bot-comment.sh');
const MARKER = '<!-- test-marker -->';

function run(scenario, { updateOnly = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'upsert-bot-comment-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const bodyFile = join(dir, 'body');
  writeFileSync(bodyFile, `${MARKER}\nhello`);
  const write = (name, body) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  write('sleep', '#!/bin/bash\nexit 0\n');
  write(
    'gh',
    [
      '#!/bin/bash',
      'echo "$*" >> "$CALLS"',
      'n=$(grep -c "method GET" "$CALLS" || true)',
      'case "$*" in',
      '  "api user"*)',
      '    if [ "$SCENARIO" = "user-fails" ]; then exit 1; fi',
      '    echo bot ;;',
      '  *"--method GET"*)',
      '    case "$SCENARIO" in',
      '      listing-always-fails) exit 1 ;;',
      '      listing-fails-once)',
      '        if [ "$n" -le 1 ]; then exit 1; else echo \'[{"id":7,"user":{"login":"bot"},"body":"<!-- test-marker --> old"}]\'; fi ;;',
      '      fresh) echo "[]" ;;',
      '      existing-bot) echo \'[{"id":7,"user":{"login":"bot"},"body":"<!-- test-marker --> old"}]\' ;;',
      '      duplicate-pair) echo \'[{"id":5,"user":{"login":"bot"},"body":"<!-- test-marker --> older"},{"id":9,"user":{"login":"bot"},"body":"<!-- test-marker --> newer"}]\' ;;',
      '      existing-user) echo \'[{"id":8,"user":{"login":"alice"},"body":"<!-- test-marker --> mine"}]\' ;;',
      '      deleted-mid-retry)',
      '        if [ "$n" -le 1 ]; then echo \'[{"id":9,"user":{"login":"bot"},"body":"<!-- test-marker --> old"}]\'; else echo "[]"; fi ;;',
      '    esac ;;',
      '  *"--method PATCH"*)',
      '    if [ "$SCENARIO" = "deleted-mid-retry" ]; then exit 1; fi ;;',
      '  *) : ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
  );
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync(
      'bash',
      [
        script,
        'o/r',
        '42',
        MARKER,
        bodyFile,
        ...(updateOnly ? ['--update-only'] : []),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SCENARIO: scenario,
          CALLS: calls,
        },
      },
    );
  } catch (e) {
    code = e.status;
    stdout = `${e.stdout ?? ''}`;
  }
  const recorded = readFileSync(calls, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { code, stdout, calls: recorded };
}

test('POSTs a fresh comment when no bot-authored marker exists', () => {
  const r = run('fresh');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /posted new comment/);
  assert.doesNotMatch(r.calls, /--method PATCH/);
});

test('PATCHes the existing bot-authored marker comment', () => {
  const r = run('existing-bot');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /updated comment 7/);
  assert.match(r.calls, /--method PATCH repos\/o\/r\/issues\/comments\/7/);
});

test('a user-authored marker comment never captures the upsert', () => {
  const r = run('existing-user');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /posted new comment/);
  assert.doesNotMatch(r.calls, /--method PATCH/);
});

test('falls back to POST when the target vanishes mid-retry (re-resolution)', () => {
  const r = run('deleted-mid-retry');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /posted new comment/);
  // Attempt 1 PATCHed the stale id and failed; attempt 2 re-resolved to
  // empty and POSTed — a hoisted lookup would PATCH id 9 three times.
  assert.match(r.calls, /--method PATCH repos\/o\/r\/issues\/comments\/9/);
});

test('--update-only is a no-op success when nothing exists', () => {
  const r = run('fresh', { updateOnly: true });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to update/);
  assert.doesNotMatch(r.calls, /--method PATCH/);
  // And no POST either: the only api writes would be comment creation.
  assert.doesNotMatch(r.calls, /issues\/42\/comments -f/);
});

test('a failed listing NEVER falls through to POST (retries, then PATCHes)', () => {
  // The critical shape: the badge already exists, the first listing GET hits
  // a transient failure. Conflating that failure with "no match" would POST
  // a permanent duplicate; the fix retries and PATCHes the real comment.
  const r = run('listing-fails-once');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /updated comment 7/);
  assert.doesNotMatch(r.calls, /issues\/42\/comments -f/);
});

test('a persistently failing identity lookup exits 1 without writing', () => {
  const r = run('user-fails');
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.calls, /--method PATCH/);
  assert.doesNotMatch(r.calls, /issues\/42\/comments -f/);
});

test('--update-only with a failing lookup exits 1, not the no-op success', () => {
  // The supersede caller's ::warning:: path depends on this: a failed lookup
  // must not masquerade as "nothing to update".
  const r = run('listing-always-fails', { updateOnly: true });
  assert.equal(r.code, 1);
});

test('--update-only PATCHes an existing bot-authored badge', () => {
  const r = run('existing-bot', { updateOnly: true });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /updated comment 7/);
  assert.match(r.calls, /--method PATCH repos\/o\/r\/issues\/comments\/7/);
});

test('with duplicate badges, the upsert refreshes the LAST (newest) one', () => {
  // The header's documented duplicate-resolution semantics: after a
  // transient failure once minted a pair, every subsequent upsert must
  // target the newest — a flip to `first` would refresh the older comment
  // while the newer stale one stays the visible latest.
  const r = run('duplicate-pair');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /updated comment 9/);
  assert.doesNotMatch(r.calls, /comments\/5/);
});
