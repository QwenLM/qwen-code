/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The single-read property of the ledger writers, pinned by fault injection.
//
// The clobber guard used to decide from a SECOND read: "did the read fail?"
// asked once to build `entries`, then again to decide whether a present file
// was preserved. A transient fault (EMFILE, an AV scanner's EPERM) that
// cleared between the two reads defeated the guard — the first read failed,
// the guard's read succeeded, and the append rewrote the whole ledger from
// the empty fallback, erasing every recorded session. These probes live in
// their own file because they inject faults; every other run-ledger test
// runs against the real filesystem.
//
// `node:fs` is a sealed ESM namespace under the runner (vi.mock does not
// reach the module under test and vi.spyOn cannot redefine the export), so
// the faults go through the module's own `ledgerIoForTests` seam.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRunSession,
  ledgerIoForTests,
  readResumeMarker,
  recordResume,
  resumeMarkerPath,
  runSessionsPath,
  sessionEntryCount,
} from './run-ledger.js';

let root: string;
let plan: string;

const envOf = (sessionId: string): NodeJS.ProcessEnv => ({
  QWEN_CODE_PROJECT_DIR: root,
  QWEN_CODE_SESSION_ID: sessionId,
});

const transient = (code: string): Error =>
  Object.assign(new Error(code), { code });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'run-ledger-race-')));
  plan = join(root, 'qwen-review-pr-7-fetch.json');
  writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('single-read ledger writers', () => {
  it('the append decides from exactly ONE read of the ledger', () => {
    // Structural pin: with one read there is no between-reads window for a
    // transient fault to clear in. A reintroduced guard read turns this red
    // before any race does.
    appendRunSession(plan, envOf('S1'));
    const spy = vi.spyOn(ledgerIoForTests, 'readFileSync');
    appendRunSession(plan, envOf('S2'));
    const ledgerReads = spy.mock.calls.filter(
      (c) => c[0] === runSessionsPath(plan),
    );
    expect(ledgerReads).toHaveLength(1);
    expect(sessionEntryCount(plan)).toBe(2);
  });

  it('a transient fault on that one read refuses the append, never clobbers', () => {
    appendRunSession(plan, envOf('S1'));
    const before = readFileSync(runSessionsPath(plan), 'utf8');
    vi.spyOn(ledgerIoForTests, 'readFileSync').mockImplementationOnce(() => {
      throw transient('EMFILE');
    });
    appendRunSession(plan, envOf('S2'));
    // S2's append was skipped — one entry lost — but S1 survives: the
    // failure direction is "skip one", never "erase all".
    expect(readFileSync(runSessionsPath(plan), 'utf8')).toBe(before);
    expect(sessionEntryCount(plan)).toBe(1);
  });

  it('a transient fault on the marker read refuses the record, never clobbers', () => {
    recordResume(plan, envOf('S1'));
    const before = readFileSync(resumeMarkerPath(plan), 'utf8');
    vi.spyOn(ledgerIoForTests, 'readFileSync').mockImplementationOnce(() => {
      throw transient('EPERM');
    });
    recordResume(plan, envOf('S2'));
    expect(readFileSync(resumeMarkerPath(plan), 'utf8')).toBe(before);
    expect(readResumeMarker(plan).resumes.map((r) => r.sessionId)).toEqual([
      'S1',
    ]);
  });

  it('a transient plan-stat fault refuses the append, never clobbers', () => {
    // The fence used to be computed from a SEPARATE stat inside the read
    // path: a transient failure there dropped every entry while the
    // writer's own stat succeeded, and the append rewrote the intact file
    // from the empty list. One stat now serves the fence and the new entry.
    appendRunSession(plan, envOf('S1'));
    const before = readFileSync(runSessionsPath(plan), 'utf8');
    vi.spyOn(ledgerIoForTests, 'statSync').mockImplementationOnce(() => {
      throw transient('EPERM');
    });
    appendRunSession(plan, envOf('S2'));
    expect(readFileSync(runSessionsPath(plan), 'utf8')).toBe(before);
  });
});
