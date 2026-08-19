/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readdirSync } from 'node:fs';

import {
  SCENARIOS,
  SID,
  admissionOnly,
  assertCanaryStatus,
  chatsDirFor,
  composeCapture,
  isPlainObject,
  readTranscriptFixture,
  retargetTranscript,
} from './serve-ab-drive.mjs';

test('chatsDirFor mirrors the daemon project-dir layout', () => {
  assert.equal(
    chatsDirFor('/home/runner/work/tmp', '/srv/my project'),
    '/home/runner/work/tmp/.qwen/projects/-srv-my-project/chats',
  );
});

test('chatsDirFor sanitizes every non-alphanumeric character, like sanitizeCwd', () => {
  const dir = chatsDirFor('/h', '/a_b.c/d-e');
  assert.equal(dir, '/h/.qwen/projects/-a-b-c-d-e/chats');
  // No path separators survive from the workspace path: the whole workspace
  // collapses into ONE directory name.
  assert.equal(dir.split('/').filter(Boolean).length, 5);
});

test('the transcript fixture is a genuine user + assistant record pair', () => {
  const records = readTranscriptFixture();
  assert.equal(records.length, 2);
  assert.equal(records[0].type, 'user');
  assert.equal(records[0].message.role, 'user');
  assert.equal(records[1].type, 'assistant');
  // The loader rejects `role: "assistant"` here — it wants `model`. Pinning it
  // keeps a well-meaning edit from turning every staged scenario into a 404.
  assert.equal(records[1].message.role, 'model');
  assert.equal(records[1].parentUuid, records[0].uuid);
});

test('retargetTranscript rewrites sessionId + cwd on every record', () => {
  const out = retargetTranscript(
    readTranscriptFixture(),
    'a0000000-0000-4000-8000-00000000da01',
    '/srv/ws',
  );
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const rec = JSON.parse(line);
    assert.equal(rec.sessionId, 'a0000000-0000-4000-8000-00000000da01');
    assert.equal(rec.cwd, '/srv/ws');
  }
  assert.ok(out.endsWith('\n'), 'JSONL must end with a newline');
});

test('every scenario has a unique name, and every id in a path is a SID constant', () => {
  const names = SCENARIOS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  // The two arms run as separate processes, so an id computed at request time
  // would differ between the captures and diff as pure noise. Asserting the
  // paths embed the exported constants is what actually pins that — a check for
  // the substrings "random"/"Date.now" passes for `crypto.randomUUID()` too.
  const known = new Set(Object.values(SID).map((id) => id.toLowerCase()));
  for (const s of SCENARIOS) {
    const id = /\/session\/([^/]+)\//.exec(s.path)?.[1];
    if (!id) continue;
    assert.ok(
      known.has(id.toLowerCase()),
      `scenario ${s.name} uses an id that is not a SID constant: ${id}`,
    );
  }
});

test('restore scenarios never share a session id (an attach also answers 200)', () => {
  const ids = SCENARIOS.filter((s) => s.name.startsWith('session-restore-'))
    .map((s) => /\/session\/([^/]+)\/load/.exec(s.path)?.[1])
    .map((id) => id?.toLowerCase());
  assert.ok(ids.length >= 5, 'expected the staged restore scenarios');
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, ids.length);
});

test('both canaries assert their own precondition', () => {
  const canaries = SCENARIOS.filter(
    (s) => s.expectStatus !== undefined || s.rejectStatus !== undefined,
  );
  assert.deepEqual(
    canaries.map((c) => [c.name, c.expectStatus, c.rejectStatus]),
    [
      // Shared by every scenario below it → must be exactly 200.
      ['session-restore-healthy', 200, undefined],
      // Only 404 proves the staged file was never seen; any other answer is a
      // product decision the captures should carry, not a reason to abort.
      ['session-restore-archived-only', undefined, 404],
    ],
  );
  // One certifies the active `chats` leaf and the fixture, the other the
  // `chats/archive` leaf — every layout fact the harness encodes is covered.
  for (const c of canaries) assert.equal(typeof c.fixtures, 'function');
});

test('assertCanaryStatus enforces both canary shapes and leaves others alone', () => {
  const exact = { name: 'exact', expectStatus: 200 };
  assert.doesNotThrow(() => assertCanaryStatus(exact, 200, 'body'));
  assert.throws(
    () => assertCanaryStatus(exact, 404, 'body'),
    /scenario "exact" expected HTTP 200 but got 404/,
  );

  const reject = { name: 'reject', rejectStatus: 404 };
  assert.doesNotThrow(() => assertCanaryStatus(reject, 409));
  assert.doesNotThrow(
    () => assertCanaryStatus(reject, 200),
    'a changed admission answer is data, not a drift alarm',
  );
  assert.throws(
    () => assertCanaryStatus(reject, 404),
    /scenario "reject" must not answer HTTP 404/,
  );

  // A scenario with neither field is never a canary, whatever it answers.
  for (const status of [200, 404, 409, 500]) {
    assert.doesNotThrow(() => assertCanaryStatus({ name: 'plain' }, status));
  }
});

test('every staged scenario probes an id it actually staged', () => {
  const home = mkdtempSync(join(tmpdir(), 'sad-'));
  const workspace = join(home, 'ws');
  const chats = chatsDirFor(home, workspace);
  for (const s of SCENARIOS) {
    if (!s.fixtures) continue;
    const probed = /\/session\/([^/]+)\//.exec(s.path)?.[1];
    if (!probed) continue;
    s.fixtures({ home, workspace });
    const staged = [
      ...readdirSync(chats),
      ...readdirSync(join(chats, 'archive')),
    ]
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length).toLowerCase());
    // Case-insensitively: mixed-case and case-twins deliberately probe a
    // spelling other than the one on disk. A scenario probing an id it never
    // staged answers 404 on BOTH arms — identical captures, "no response
    // changes", and that branch silently drops out of A/B coverage.
    assert.ok(
      staged.includes(probed.toLowerCase()),
      `${s.name} probes ${probed} but stages no spelling of it`,
    );
  }
});

test('staged scenarios stage fixtures before they probe', () => {
  for (const s of SCENARIOS) {
    if (!s.name.startsWith('session-restore-')) continue;
    assert.equal(
      typeof s.fixtures,
      'function',
      `${s.name} probes restore state but stages nothing`,
    );
  }
});

test('fixtures land in the chats leaf, and archived ones under archive/', () => {
  const home = mkdtempSync(join(tmpdir(), 'sad-'));
  const workspace = join(home, 'ws');
  const chats = chatsDirFor(home, workspace);
  for (const s of SCENARIOS) s.fixtures?.({ home, workspace });

  const active = (id) => join(chats, `${id}.jsonl`);
  const archived = (id) => join(chats, 'archive', `${id}.jsonl`);

  assert.ok(existsSync(active(SID.healthy)), 'healthy canary → chats/');
  assert.ok(
    existsSync(archived(SID.archivedOnly)),
    'archive canary → chats/archive/',
  );
  assert.ok(
    !existsSync(active(SID.archivedOnly)),
    'the archive-only canary must NOT also have an active copy',
  );
  // The conflict scenario needs BOTH copies; with only the active one it loads
  // normally on either arm and silently stops covering the conflict path.
  assert.ok(existsSync(active(SID.archived)));
  assert.ok(existsSync(archived(SID.archived)));
  // Case twins: two spellings, both in the active leaf.
  assert.ok(existsSync(active(SID.twins)));
  assert.ok(existsSync(active(SID.twins.toLowerCase())));
});

test('a raw fixture body is written verbatim, a retargeted one is valid JSONL', () => {
  const home = mkdtempSync(join(tmpdir(), 'sad-'));
  const workspace = join(home, 'ws');
  const chats = chatsDirFor(home, workspace);
  for (const s of SCENARIOS) s.fixtures?.({ home, workspace });

  const damaged = readFileSync(join(chats, `${SID.unreadable}.jsonl`), 'utf8');
  assert.equal(damaged, 'not json at all\n{"broken":\n');
  assert.throws(() => JSON.parse(damaged.split('\n')[0]));

  const healthy = readFileSync(join(chats, `${SID.healthy}.jsonl`), 'utf8');
  for (const line of healthy.split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    assert.equal(rec.sessionId, SID.healthy);
    assert.equal(rec.cwd, workspace);
  }
});

test('admissionOnly keeps the decision and drops the session snapshot', () => {
  const res = { status: 409 };
  assert.deepEqual(
    admissionOnly(
      { code: 'session_conflict', error: 'two spellings', compactedReplay: [] },
      res,
    ),
    { _status: 409, code: 'session_conflict', error: 'two spellings' },
  );
  // A success carries neither discriminator — status alone, not `code: null`,
  // which would diff against a refusal's string as a type change.
  assert.deepEqual(admissionOnly({ sessionId: 'x' }, { status: 200 }), {
    _status: 200,
  });
  // Each discriminator is kept independently of the other.
  assert.deepEqual(admissionOnly({ code: 'c' }, res), {
    _status: 409,
    code: 'c',
  });
  assert.deepEqual(admissionOnly({ error: 'e' }, res), {
    _status: 409,
    error: 'e',
  });
});

test('isPlainObject decides which bodies may be spread into a capture', () => {
  assert.equal(isPlainObject({ a: 1 }), true);
  // Spreading these would drop a scalar/null body and re-key an array into an
  // indexed object, so a future scenario probing such an endpoint would diff
  // clean no matter what changed.
  assert.equal(isPlainObject([1, 2]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(123), false);
  assert.equal(isPlainObject('x'), false);
});

test('composeCapture always records the status the harness saw', () => {
  // A body key of the same name must not win: that would turn a status-only
  // regression into "body unchanged", the masking this harness exists to stop.
  assert.deepEqual(
    composeCapture({}, { _status: 400, ok: true }, { status: 200 }),
    {
      ok: true,
      _status: 200,
    },
  );
  assert.deepEqual(composeCapture({}, { a: 1 }, { status: 409 }), {
    a: 1,
    _status: 409,
  });
});

test('composeCapture nests non-object bodies instead of spreading them', () => {
  assert.deepEqual(composeCapture({}, 123, { status: 200 }), {
    _status: 200,
    _body: 123,
  });
  assert.deepEqual(composeCapture({}, null, { status: 204 }), {
    _status: 204,
    _body: null,
  });
  assert.deepEqual(composeCapture({}, ['a', 'b'], { status: 200 }), {
    _status: 200,
    _body: ['a', 'b'],
  });
});

test('composeCapture defers to a scenario projection when one is declared', () => {
  const scenario = {
    project: (json, res) => ({ _status: res.status, code: json.code }),
  };
  assert.deepEqual(
    composeCapture(
      scenario,
      { code: 'x', compactedReplay: [] },
      { status: 409 },
    ),
    { _status: 409, code: 'x' },
  );
});
