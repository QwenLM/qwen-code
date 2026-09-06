/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The session ledger and resume marker, in isolation. The properties under
// test are the failure directions: an entry the ledger cannot vouch for
// (malformed, stale, traversal-shaped) must read as ABSENT — invisible
// evidence re-runs work, fabricated evidence must never mint credit — and a
// fresh run of the same PR (plan rewritten, epoch advanced) must start with
// an empty history.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRunSession,
  priorSessionEntries,
  priorSessionIds,
  sessionEntryCount,
  ledgerResumeCount,
  runSessionsPath,
  readResumeMarker,
  recordResume,
  recordRestart,
  resumeMarkerPath,
  RESUME_MAX,
  currentSessionEntry,
} from './run-ledger.js';

let root: string;
let plan: string;

const envOf = (sessionId: string): NodeJS.ProcessEnv => ({
  QWEN_CODE_PROJECT_DIR: root,
  QWEN_CODE_SESSION_ID: sessionId,
});

/**
 * Authorize `sessionId` to read prior evidence — what `fetch-pr --resume`
 * records once every probe has passed. Reading the ledger's prior entries at
 * all requires it, so a test about ledger CONTENT states that precondition
 * explicitly rather than relying on its absence.
 */
function authorize(sessionId: string, atMs: number = Date.now()): void {
  recordResume(plan, envOf(sessionId), atMs);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'run-ledger-')));
  plan = join(root, 'qwen-review-pr-7-fetch.json');
  writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('sessionEntryCount — the cap term the gate must not swallow', () => {
  it('counts every ledgered session without any authorization', () => {
    // The gate on `priorSessionEntries` protects evidence, and a session is
    // recorded as an authorized resume only after its ruling passes — so a
    // cap that read its ledger term through the gate always saw zero, and
    // deleting `resume.json` reset the very cap the ledger backstops.
    appendRunSession(plan, envOf('S1'));
    appendRunSession(plan, envOf('S2'));
    // No `authorize()` call anywhere: that is the point.
    expect(sessionEntryCount(plan)).toBe(2);
  });

  it('is zero when there is no ledger at all', () => {
    expect(sessionEntryCount(plan)).toBe(0);
  });

  it('validates entries BEFORE the cap, so junk cannot consume it', () => {
    // Sliced raw, 64 malformed entries at the front hide every real one:
    // `sessionEntryCount` reads 0 and the resume cap resets — the attack the
    // count exists to survive. The witness is the reviewer's own: junk
    // first, one valid entry last.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(runSessionsPath(plan), 'utf8'),
    ) as Array<Record<string, unknown>>;
    const junk = Array.from({ length: 70 }, (_, i) => ({ garbage: i }));
    writeFileSync(runSessionsPath(plan), JSON.stringify([...junk, ...raw]));

    expect(sessionEntryCount(plan)).toBe(1);
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('still caps the VALIDATED entries at the bound', () => {
    // The cap's job — bounding the directory reads consumers pay per entry —
    // survives the reorder: valid entries past the bound are dropped.
    const mtime = statSync(plan).mtimeMs;
    const now = Date.now();
    const entries = Array.from({ length: 70 }, (_, i) => ({
      sessionId: `S${i}`,
      atMs: now,
      planMtimeMs: mtime,
    }));
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(runSessionsPath(plan), JSON.stringify(entries));

    expect(sessionEntryCount(plan)).toBe(64);
  });

  it('applies the same fences as every other read', () => {
    // A count that admitted a foreign or stale entry would cap the wrong
    // number: it runs through `readSessions`, so the epoch, plan-mtime and
    // charset fences all still hold.
    appendRunSession(plan, envOf('S1'));
    appendRunSession(plan, envOf('../evil'));
    expect(sessionEntryCount(plan)).toBe(1);
  });
});

describe('ledgerResumeCount — entries past the original, no double subtraction', () => {
  // The ledger's first entry is the original run's own session, which is
  // not a resume. The resuming session is excluded from the REMAINDER — and
  // when it IS the original, the exclusion has already removed the first
  // entry, so subtracting the original again counts one resume short: the
  // exact backstop shape (a deleted marker, the original session resuming)
  // passed a cap it had already exhausted.
  // Stamped at call time, not when this block is COLLECTED. Entries are
  // fenced against the plan file's mtime with RUN_EPOCH_SLACK_MS (2s) of
  // slack, and `beforeEach` writes that file — so a stamp taken at collection
  // is stale by however long collection took, and the fence drops the entries
  // as a previous run's. Release run 33713579913 collected for 2260s on a
  // contended host; this block then read 1, then 0, then 0 across its three
  // attempts, against an expected 2.
  function threeSessions(): void {
    const now = Date.now();
    appendRunSession(plan, envOf('S0'), now);
    appendRunSession(plan, envOf('S1'), now + 1000);
    appendRunSession(plan, envOf('S2'), now + 2000);
  }

  it('counts the resumes past the original session', () => {
    threeSessions();
    expect(ledgerResumeCount(plan)).toBe(2);
  });

  it('excludes the original resuming without subtracting it twice', () => {
    threeSessions();
    // S0 resumes again: the exclusion removes the first entry, leaving S1
    // and S2 — two resumes, the cap already out. The double subtraction
    // read 1 here and admitted a third resume.
    expect(ledgerResumeCount(plan, { excludeSessionId: 'S0' })).toBe(2);
  });

  it('excludes a resuming session that is not the original', () => {
    threeSessions();
    // S1 retries its own resume: S2 is the only OTHER resume.
    expect(ledgerResumeCount(plan, { excludeSessionId: 'S1' })).toBe(1);
  });

  it('is zero on a fresh ledger, whatever excludes', () => {
    appendRunSession(plan, envOf('S0'), Date.now());
    expect(ledgerResumeCount(plan)).toBe(0);
    expect(ledgerResumeCount(plan, { excludeSessionId: 'S0' })).toBe(0);
    expect(ledgerResumeCount(plan, { excludeSessionId: 'S9' })).toBe(0);
  });

  it('is zero when there is no ledger at all', () => {
    expect(ledgerResumeCount(plan, { excludeSessionId: 'S0' })).toBe(0);
  });
});

describe('appendRunSession / priorSessionIds', () => {
  it('records a session and surfaces it to a LATER session as prior', () => {
    appendRunSession(plan, envOf('S1'));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('excludes the current session from its own priors', () => {
    appendRunSession(plan, envOf('S1'));
    authorize('S1');
    expect(priorSessionIds(plan, envOf('S1'))).toEqual([]);
  });

  it('appends each session once, preserving order', () => {
    appendRunSession(plan, envOf('S1'));
    appendRunSession(plan, envOf('S1'));
    appendRunSession(plan, envOf('S2'));
    authorize('S3');
    expect(priorSessionIds(plan, envOf('S3'))).toEqual(['S1', 'S2']);
  });

  it('refuses a session id that could traverse out of subagents/', () => {
    appendRunSession(plan, envOf('../evil'));
    appendRunSession(plan, envOf('a/b'));
    appendRunSession(plan, envOf(''));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('drops a traversal id from the MARKER even with a valid fence', () => {
    // The planted entry must fail ONLY the charset gate: with planMtimeMs
    // valid, removing SESSION_ID_RE from readResumeMarker is what this pins.
    recordResume(plan, envOf('S1'));
    const raw = JSON.parse(readFileSync(resumeMarkerPath(plan), 'utf8')) as {
      resumes: Array<Record<string, unknown>>;
    };
    raw.resumes.push({
      sessionId: '../../etc',
      atMs: Date.now(),
      planMtimeMs: statSync(plan).mtimeMs,
    });
    writeFileSync(resumeMarkerPath(plan), JSON.stringify(raw));
    expect(readResumeMarker(plan).resumes.map((r) => r.sessionId)).toEqual([
      'S1',
    ]);
  });

  it('does not write the marker at all for a charset-refused id', () => {
    // The write-side gate, observed through the FILE: the read gate would
    // mask its removal.
    recordResume(plan, envOf('../evil'));
    expect(existsSync(resumeMarkerPath(plan))).toBe(false);
  });

  it('authorizes a case-variant of the recorded resume session', () => {
    // resumeAuthorized folds on the path key like every other comparison; a
    // raw-string compare ships green on byte-identical fixtures and refuses
    // the continuation on the first case-folding filesystem.
    recordResume(plan, envOf('S2'));
    appendRunSession(plan, envOf('S1'));
    expect(priorSessionIds(plan, envOf('s2'))).toEqual(['S1']);
  });

  it('drops a traversal-shaped id on READ even when the file carries it', () => {
    // The ledger file itself is inside the record dir the orchestrator can
    // reach; a hand-written entry must still fail the character-set gate.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(runSessionsPath(plan), 'utf8'),
    ) as Array<Record<string, unknown>>;
    raw.push({ sessionId: '../../etc', atMs: Date.now() });
    writeFileSync(runSessionsPath(plan), JSON.stringify(raw));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('drops entries older than the plan — a previous review of the same PR', () => {
    appendRunSession(plan, envOf('S0'), Date.now() - 60_000);
    // Rewriting the plan advances the run epoch past the stale entry.
    writeFileSync(plan, JSON.stringify({ diffLines: 2, chunks: [] }));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('keeps entries when the plan is untouched — the resume case', () => {
    // A resume does not rewrite the plan, so the entry's recorded plan mtime
    // still matches. (Backdating the plan here would be a DIFFERENT plan
    // state, which the exact fresh-run boundary is right to reject — the
    // rewrite case has its own test below.)
    appendRunSession(plan, envOf('S1'));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('drops an entry written against a DIFFERENT plan state', () => {
    // The window's slack is inexact by construction: a previous run that
    // appended within it survives the fence. The recorded plan mtime is the
    // exact boundary — a fresh run rewrites the plan, a resume does not.
    appendRunSession(plan, envOf('S0'));
    const later = new Date(Date.now() + 1000);
    utimesSync(plan, later, later);
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('reads NO prior sessions until this session was authorized to resume', () => {
    // The ledger is an address book, not permission. Without the marker any
    // session pointing at an old plan would inherit the ledgered attempts'
    // evidence — after head drift, stale work could certify unreviewed code.
    appendRunSession(plan, envOf('S1'));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('reads a case-variant of the current session as the SAME session', () => {
    // These ids become path segments; on APFS/Windows `s1` and `S1` are one
    // directory, so treating a variant as a prior session double-reads every
    // record this run wrote and mints a resume that never happened.
    appendRunSession(plan, envOf('s1'));
    authorize('S1');
    expect(priorSessionIds(plan, envOf('S1'))).toEqual([]);
  });

  it('reads a corrupt ledger as empty', () => {
    appendRunSession(plan, envOf('S1'));
    writeFileSync(runSessionsPath(plan), '{not json');
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('reads a non-array ledger as empty', () => {
    appendRunSession(plan, envOf('S1'));
    writeFileSync(runSessionsPath(plan), JSON.stringify({ sessionId: 'S1' }));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('reads a missing ledger as empty', () => {
    authorize('S1');
    expect(priorSessionIds(plan, envOf('S1'))).toEqual([]);
  });

  it('swallows an unwritable record dir', () => {
    // The record dir path collides with an existing FILE: mkdir fails. The
    // append must not throw — bookkeeping never takes the review down.
    writeFileSync(join(root, 'qwen-review-pr-7-fetch-prompts'), 'a file');
    expect(() => appendRunSession(plan, envOf('S1'))).not.toThrow();
  });
});

describe('resume marker', () => {
  it('reads an absent marker as the empty history', () => {
    expect(readResumeMarker(plan)).toEqual({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    });
  });

  it('round-trips resumes and restarts', () => {
    recordResume(plan, envOf('S2'));
    recordRestart(plan, 'head-moved abc1234->def5678');
    const marker = readResumeMarker(plan);
    expect(marker.resumes.map((r) => r.sessionId)).toEqual(['S2']);
    expect(marker.restarts.map((r) => r.reason)).toEqual([
      'head-moved abc1234->def5678',
    ]);
  });

  it('counts multiple resumes in order', () => {
    recordResume(plan, envOf('S2'));
    recordResume(plan, envOf('S3'));
    expect(readResumeMarker(plan).resumes.map((r) => r.sessionId)).toEqual([
      'S2',
      'S3',
    ]);
  });

  it('refuses a resume under an invalid session id', () => {
    recordResume(plan, envOf('a/b'));
    expect(readResumeMarker(plan).resumes).toEqual([]);
  });

  it('reads a corrupt marker as the empty history', () => {
    recordResume(plan, envOf('S2'));
    writeFileSync(resumeMarkerPath(plan), '][');
    expect(readResumeMarker(plan)).toEqual({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    });
  });

  it('reads an unknown schemaVersion as the empty history', () => {
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(
      resumeMarkerPath(plan),
      JSON.stringify({ schemaVersion: 2, resumes: [], restarts: [] }),
    );
    expect(readResumeMarker(plan)).toEqual({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    });
  });

  it('drops marker entries older than the plan — a fresh run starts at zero', () => {
    recordResume(plan, envOf('S2'), Date.now() - 60_000);
    recordRestart(plan, 'head-moved', Date.now() - 60_000);
    writeFileSync(plan, JSON.stringify({ diffLines: 2, chunks: [] }));
    const marker = readResumeMarker(plan);
    expect(marker.resumes).toEqual([]);
    expect(marker.restarts).toEqual([]);
  });

  it('exports the resume cap', () => {
    expect(RESUME_MAX).toBe(2);
  });
});

describe('marker dedup — a caller retry must not double-count', () => {
  it('records one resume per session', () => {
    recordResume(plan, envOf('S2'));
    recordResume(plan, envOf('S2'));
    expect(readResumeMarker(plan).resumes).toHaveLength(1);
  });

  it('records one restart per reason', () => {
    recordRestart(plan, 'head-moved abc1234->def5678');
    recordRestart(plan, 'head-moved abc1234->def5678');
    expect(readResumeMarker(plan).restarts).toHaveLength(1);
  });

  it('still records distinct restarts', () => {
    recordRestart(plan, 'head-moved abc1234->def5678');
    recordRestart(plan, 'head-moved def5678->0123abc');
    expect(readResumeMarker(plan).restarts).toHaveLength(2);
  });
});

describe('the properties the threat model rests on', () => {
  it('refuses the bare traversal ids `..` and `.`', () => {
    // Today only the leading-alphanumeric rule stops these; pinning them
    // means a regex refactor cannot quietly hand them to the path assembler.
    for (const id of ['..', '.', './x', '..\\evil']) {
      appendRunSession(plan, envOf(id));
    }
    authorize('S9');
    expect(priorSessionIds(plan, envOf('S9'))).toEqual([]);
  });

  it('applies the same charset gate to the resume marker on read', () => {
    recordResume(plan, envOf('S2'));
    const marker = JSON.parse(readFileSync(resumeMarkerPath(plan), 'utf8'));
    marker.resumes.push({ sessionId: '../../etc', atMs: Date.now() });
    writeFileSync(resumeMarkerPath(plan), JSON.stringify(marker));
    expect(readResumeMarker(plan).resumes.map((r) => r.sessionId)).toEqual([
      'S2',
    ]);
  });

  it('deduplicates on READ, not only on append', () => {
    // The file sits in a directory the orchestrator can reach; a duplicated
    // entry would make the cost ledger bill one session twice.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(readFileSync(runSessionsPath(plan), 'utf8'));
    writeFileSync(runSessionsPath(plan), JSON.stringify([...raw, ...raw]));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('keeps a same-millisecond append inside the epoch fence', () => {
    // fetch-pr writes the plan and appends two statements later: Date.now()
    // floors to integer ms while mtimeMs is fractional, so without the slack
    // a same-millisecond entry would read as older than its own run.
    const mtimeMs = statSync(plan).mtimeMs;
    appendRunSession(plan, envOf('S1'), Math.floor(mtimeMs));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('drops a FUTURE-dated entry', () => {
    // Not for cross-run survival — the exact plan fence already drops every
    // entry on a rewrite — but because nothing legitimate writes the future:
    // a forged future atMs shifts its session's billing window and its place
    // in the attempt ordering.
    appendRunSession(plan, envOf('S1'), Date.now() + 3_600_000);
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('orders the cost clamp by time, not by file order', () => {
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
    const base = Math.floor(statSync(plan).mtimeMs);
    // Written out of order, as a hand-edited ledger or a backwards clock
    // step between attempts would leave it.
    appendRunSession(plan, envOf('S1'), base + 60_000);
    appendRunSession(plan, envOf('S0'), base);
    authorize('S2');
    expect(priorSessionEntries(plan, envOf('S2'))).toEqual([
      { sessionId: 'S0', atMs: base, endsAtMs: base + 60_000 },
      { sessionId: 'S1', atMs: base + 60_000, endsAtMs: null },
    ]);
  });

  it('refuses a ledger path that is not a regular file', () => {
    // A planted FIFO blocks readFileSync forever — a hang, not an error.
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    const target = join(root, 'elsewhere.json');
    // A fully VALID entry behind the link: without the fence fields, the
    // mandatory planMtimeMs clause dropped it even through a FOLLOWING read,
    // and the node-type refusal was deletable with the test green.
    writeFileSync(
      target,
      JSON.stringify([
        {
          sessionId: 'X',
          atMs: Date.now(),
          planMtimeMs: statSync(plan).mtimeMs,
        },
      ]),
    );
    symlinkSync(target, runSessionsPath(plan));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('keeps an entry whose plan mtime drifted by a last-place unit', () => {
    // What `repo-context`'s restore actually leaves behind: `mtimeMs` is a
    // double over a nanosecond clock, and putting it back through
    // `utimesSync` (seconds, also a double) returns it a fraction of a
    // microsecond off. Compared exactly, the run's OWN plan reads as a
    // different one and every entry is dropped — the resume ledger empties
    // itself on ext4 and APFS.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(runSessionsPath(plan), 'utf8'),
    ) as Array<Record<string, unknown>>;
    raw[0]['planMtimeMs'] = (raw[0]['planMtimeMs'] as number) - 0.001;
    writeFileSync(runSessionsPath(plan), JSON.stringify(raw));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('still drops an entry written against a genuinely different plan', () => {
    // The tolerance is representation noise, not a window. A fresh capture of
    // the same PR rewrites the plan seconds or minutes later, never inside
    // the same millisecond, so it stays outside.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(runSessionsPath(plan), 'utf8'),
    ) as Array<Record<string, unknown>>;
    raw[0]['planMtimeMs'] = (raw[0]['planMtimeMs'] as number) - 50;
    writeFileSync(runSessionsPath(plan), JSON.stringify(raw));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('reads an over-budget ledger as empty, before parsing it', () => {
    // The byte bound: a planted multi-gigabyte file would otherwise be read
    // fully into memory by every consumer. 256 KiB + 1 of valid JSON reads
    // as no ledger at all.
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    const pad = 'x'.repeat(256 * 1024 + 1);
    // A VALID entry rides inside: with the byte guard deleted the parse
    // succeeds and this entry survives — so only the guard can produce the
    // empty read, and deleting it goes red instead of green.
    writeFileSync(
      runSessionsPath(plan),
      JSON.stringify([
        {
          sessionId: 'S1',
          atMs: Date.now(),
          planMtimeMs: statSync(plan).mtimeMs,
        },
        { pad },
      ]),
    );
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
    expect(sessionEntryCount(plan)).toBe(0);
  });

  it('denies a session the marker names to every OTHER session', () => {
    // The gate's per-session property: authorization granted to S3 must not
    // open the ledger to S2. Degraded to "any resume exists", every test
    // that reads as the session it authorized stays green.
    appendRunSession(plan, envOf('S1'));
    authorize('S3');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('currentSessionEntry finds its own entry without any authorization', () => {
    // The third read export, previously untested anywhere: the cost floor
    // depends on it, and on a FRESH run there is never a resume marker — a
    // gated variant returns null exactly where the floor exists to act, and
    // pre-review turns of a long-lived session bill as review cost.
    appendRunSession(plan, envOf('S1'), Date.now());
    const own = currentSessionEntry(plan, envOf('S1'));
    expect(own?.sessionId).toBe('S1');
    expect(typeof own?.atMs).toBe('number');
    expect(currentSessionEntry(plan, envOf('S-absent'))).toBeNull();
    expect(currentSessionEntry(plan, {})).toBeNull();
  });

  it('drops a traversal id at READ even when the fence would pass it', () => {
    // The hand-planted entry must fail ONLY the charset gate: with
    // planMtimeMs valid, deleting SESSION_ID_RE from readSessions is what
    // this pins — traversal ids would otherwise flow into subagents/<id>
    // path assembly.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(runSessionsPath(plan), 'utf8'),
    ) as Array<Record<string, unknown>>;
    raw.push({
      sessionId: '../../etc',
      atMs: Date.now(),
      planMtimeMs: statSync(plan).mtimeMs,
    });
    writeFileSync(runSessionsPath(plan), JSON.stringify(raw));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('keeps the EARLIEST duplicate, not the first in file order', () => {
    // An out-of-order hand-written duplicate must not pick its survivor by
    // file position: the later atMs would erase the window between the real
    // start and itself from every consumer's billing.
    // Backdate the plan so both timestamps sit inside the epoch window AND
    // below the future ceiling — otherwise the ceiling drops the later
    // duplicate and the ordering never gets to decide.
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
    const mtime = statSync(plan).mtimeMs;
    const base = Math.floor(mtime);
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(
      runSessionsPath(plan),
      JSON.stringify([
        { sessionId: 'S1', atMs: base + 120_000, planMtimeMs: mtime },
        { sessionId: 'S1', atMs: base, planMtimeMs: mtime },
      ]),
    );
    authorize('S2');
    expect(priorSessionEntries(plan, envOf('S2'))[0]?.atMs).toBe(base);
  });

  it('folds path-equivalent id variants into one session', () => {
    // `s1`, `S1` and `S1.` all reach the same directory (case folding,
    // Win32 trailing-dot stripping, the harness sanitizer's '.' → '_'), so
    // they are one session everywhere or an alias reads as a second session
    // wearing the first one's evidence.
    // Backdate the plan so every offset sits inside BOTH halves of the
    // window — at now-based stamps, base+3000 exceeded the now+2000 future
    // ceiling and the S2_ entry was dropped by the fence before the dedup
    // this test pins ever saw it.
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
    const mtime = statSync(plan).mtimeMs;
    const base = Math.floor(mtime);
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(
      runSessionsPath(plan),
      JSON.stringify([
        { sessionId: 'S1', atMs: base, planMtimeMs: mtime },
        { sessionId: 's1', atMs: base + 1000, planMtimeMs: mtime },
        // The sanitizer maps '.' to '_', so `S2.` and `S2_` are ONE
        // directory — and note this also moots the Win32 trailing-dot alias:
        // `S2.` never reaches `S2`, because the lookup never uses the raw
        // name.
        { sessionId: 'S2.', atMs: base + 2000, planMtimeMs: mtime },
        { sessionId: 'S2_', atMs: base + 3000, planMtimeMs: mtime },
      ]),
    );
    authorize('S9');
    authorize('s1');
    authorize('s2_');
    // S9 is not in the ledger, so everything reads as prior.
    expect(priorSessionIds(plan, envOf('S9'))).toEqual(['S1', 'S2.']);
    // Reading as s1 (folds with S1, the EARLIEST entry): S2. started after
    // it, so it is a successor, not a prior — priors are the prefix.
    expect(priorSessionIds(plan, envOf('s1'))).toEqual([]);
    expect(priorSessionIds(plan, envOf('s2_'))).toEqual(['S1']);
  });

  it('drops an entry whose plan mtime is NEWER than the plan, too', () => {
    // The fence is symmetric by |diff|: pinned only from the older side, a
    // signed comparison ships green while a forged future-plan entry reads
    // as this run's.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(runSessionsPath(plan), 'utf8'),
    ) as Array<Record<string, unknown>>;
    (raw[0] as { planMtimeMs: number }).planMtimeMs += 50;
    writeFileSync(runSessionsPath(plan), JSON.stringify(raw));
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses to append over a ledger it could not read',
    () => {
      // A present-but-unreadable REGULAR file holds every recorded entry, and
      // this append rewrites the whole file from what it read — proceeding on
      // a transient fault would clobber attempt 1's address exactly when a
      // resume needs it. chmod 0o000 is a POSIX-only fault: on Windows it
      // toggles the read-only attribute and the file stays readable, and root
      // bypasses the mode entirely — the repo convention for this shape.
      appendRunSession(plan, envOf('S1'));
      const before = readFileSync(runSessionsPath(plan), 'utf8');
      chmodSync(runSessionsPath(plan), 0o000);
      try {
        appendRunSession(plan, envOf('S2'));
      } finally {
        chmodSync(runSessionsPath(plan), 0o644);
      }
      expect(readFileSync(runSessionsPath(plan), 'utf8')).toBe(before);
      authorize('S3');
      expect(priorSessionIds(plan, envOf('S3'))).toEqual(['S1']);
    },
  );

  it('does not write at all when the id fails the charset gate', () => {
    // The write-side guard, discriminated from the read-side one by looking
    // at the FILE: with only the read gate, the bad id would be on disk.
    appendRunSession(plan, envOf('../evil'));
    expect(existsSync(runSessionsPath(plan))).toBe(false);
  });

  it('writes one marker entry for a same-session retry', () => {
    // recordResume's write-side dedup, discriminated by reading the raw
    // file: the read-side dedup would hide a double write.
    recordResume(plan, envOf('S1'));
    recordResume(plan, envOf('S1'));
    const raw = JSON.parse(readFileSync(resumeMarkerPath(plan), 'utf8')) as {
      resumes: unknown[];
    };
    expect(raw.resumes).toHaveLength(1);
  });

  it('drops marker entries from a previous run of the same PR', () => {
    // The marker takes the same exact plan fence as the ledger, for the
    // same reason: surviving a plan rewrite means arriving with the cap
    // already spent, against this reader's own "a fresh run always starts
    // at zero".
    recordResume(plan, envOf('S1'));
    expect(readResumeMarker(plan).resumes).toHaveLength(1);
    // A fresh capture rewrites the plan. Nudged 3s forward — outside the
    // 1ms tolerance AND small enough that the entry's atMs stays inside the
    // new epoch window (a +60s jump put the epoch past atMs, so the entry
    // died on the window fence and the plan-mtime clause was deletable).
    writeFileSync(plan, JSON.stringify({ diffLines: 2, chunks: [] }));
    const later = new Date(Date.now() + 3_000);
    utimesSync(plan, later, later);
    expect(readResumeMarker(plan).resumes).toEqual([]);
  });

  it('dedupes identical restart entries on read', () => {
    // Each duplicate spends the once-per-review restart bound again.
    recordRestart(plan, 'head-moved');
    const raw = JSON.parse(readFileSync(resumeMarkerPath(plan), 'utf8')) as {
      restarts: Array<Record<string, unknown>>;
    };
    raw.restarts.push({ ...raw.restarts[0] });
    writeFileSync(resumeMarkerPath(plan), JSON.stringify(raw));
    expect(readResumeMarker(plan).restarts).toHaveLength(1);
  });

  it('drops a v2 marker even when it carries entries', () => {
    // The schemaVersion refusal, discriminated with POPULATED arrays: on an
    // empty marker the refusal and the fallback are byte-identical.
    recordResume(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(resumeMarkerPath(plan), 'utf8'),
    ) as Record<string, unknown>;
    raw['schemaVersion'] = 2;
    writeFileSync(resumeMarkerPath(plan), JSON.stringify(raw));
    expect(readResumeMarker(plan).resumes).toEqual([]);
  });

  it('folds case-variant marker resumes into one cap slot', () => {
    recordResume(plan, envOf('S2'));
    const raw = JSON.parse(readFileSync(resumeMarkerPath(plan), 'utf8')) as {
      resumes: Array<Record<string, unknown>>;
    };
    raw.resumes.push({ ...raw.resumes[0], sessionId: 's2' });
    writeFileSync(resumeMarkerPath(plan), JSON.stringify(raw));
    expect(readResumeMarker(plan).resumes).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'writes the marker through a planted symlink without following it',
    () => {
      // The noFollow property, pinned for BOTH ledger writes as the sibling
      // test's comment promises — this is the resume.json half.
      mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
        recursive: true,
      });
      const target = join(root, 'marker-outside.json');
      writeFileSync(target, '"untouched"');
      symlinkSync(target, resumeMarkerPath(plan));
      recordResume(plan, envOf('S1'));
      expect(readFileSync(target, 'utf8')).toBe('"untouched"');
      expect(lstatSync(resumeMarkerPath(plan)).isSymbolicLink()).toBe(false);
      expect(readResumeMarker(plan).resumes).toHaveLength(1);
    },
  );

  it('swallows a marker write into a colliding path, like the ledger', () => {
    // The "bookkeeping never takes the review down" property, pinned for
    // the writer that lacked it: a FILE standing where the record dir must
    // be makes mkdir throw, and that throw must not escape.
    writeFileSync(join(root, 'qwen-review-pr-7-fetch-prompts'), 'a file');
    expect(() => recordResume(plan, envOf('S1'))).not.toThrow();
    expect(() => recordRestart(plan, 'head-moved')).not.toThrow();
  });

  it('collapses a duplicate flood BEFORE the cap can be consumed', () => {
    // 64 valid hand-written duplicates at the front used to evict every
    // genuine entry, and the next append rewrote the file from the filtered
    // survivors — laundering the plant permanently.
    const mtime = statSync(plan).mtimeMs;
    const now = Date.now();
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    const dupes = Array.from({ length: 64 }, () => ({
      sessionId: 'DUP',
      atMs: now,
      planMtimeMs: mtime,
    }));
    writeFileSync(
      runSessionsPath(plan),
      JSON.stringify([
        ...dupes,
        { sessionId: 'S1', atMs: now - 1000, planMtimeMs: mtime },
      ]),
    );
    expect(sessionEntryCount(plan)).toBe(2);
    authorize('S9');
    expect(priorSessionIds(plan, envOf('S9'))).toEqual(['S1', 'DUP']);
  });

  it('treats a SUCCESSOR session as not-prior, with the window closed at self', () => {
    // A twice-resumed run read as the middle attempt: the successor is not
    // "earlier evidence", and the middle attempt's last prior window closes
    // at its OWN start — not at null.
    const past = new Date(Date.now() - 3600_000);
    utimesSync(plan, past, past);
    const mtime = statSync(plan).mtimeMs;
    const base = Math.floor(mtime);
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(
      runSessionsPath(plan),
      JSON.stringify([
        { sessionId: 'S0', atMs: base, planMtimeMs: mtime },
        { sessionId: 'S1', atMs: base + 510_000, planMtimeMs: mtime },
        { sessionId: 'S2', atMs: base + 2_900_000, planMtimeMs: mtime },
      ]),
    );
    authorize('S1');
    const entries = priorSessionEntries(plan, envOf('S1'));
    expect(entries.map((e) => e.sessionId)).toEqual(['S0']);
    // S0's window closes when S1 began — not at S2, and never unbounded.
    expect(entries[0].endsAtMs).toBe(base + 510_000);
  });

  it('drops an entry older than the slack window', () => {
    const mtimeMs = statSync(plan).mtimeMs;
    appendRunSession(plan, envOf('S1'), Math.floor(mtimeMs) - 3000);
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('writes through a planted symlink without following it', () => {
    // `noFollow: true` on both ledger writes: without it atomicWriteFileSync
    // resolves the chain and the rename lands on the TARGET.
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    const target = join(root, 'outside.json');
    writeFileSync(target, '"untouched"');
    symlinkSync(target, runSessionsPath(plan));
    appendRunSession(plan, envOf('S1'));
    expect(readFileSync(target, 'utf8')).toBe('"untouched"');
    expect(lstatSync(runSessionsPath(plan)).isSymbolicLink()).toBe(false);
    authorize('S2');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('bounds each prior session by the next attempt start', () => {
    // Inside BOTH halves of the fence: at or after the plan's capture, and
    // not in the future. Backdate the plan so a later entry is still past.
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
    const base = Math.floor(statSync(plan).mtimeMs);
    appendRunSession(plan, envOf('S0'), base);
    appendRunSession(plan, envOf('S1'), base + 60_000);
    authorize('S2');
    expect(priorSessionEntries(plan, envOf('S2'))).toEqual([
      { sessionId: 'S0', atMs: base, endsAtMs: base + 60_000 },
      { sessionId: 'S1', atMs: base + 60_000, endsAtMs: null },
    ]);
  });
});

describe('plant shapes — heal what cannot be legitimate, preserve what can', () => {
  // The boundary the occupant classifier draws: a symlink, FIFO, directory
  // or oversize regular file CANNOT be legitimate ledger state (this module
  // never writes one), so preserving it hands a planted shape a permanent
  // freeze of all recording — while a plausible regular file that merely
  // failed to read may hold every recorded entry, and must be preserved.

  it('heals an OVERSIZE regular-file plant instead of freezing the ledger', () => {
    // >256 KiB can never be legitimate (≤64 capped entries ≈ a few KB).
    // Treated as a transient fault it froze every future append: nothing
    // ever removed the file, so the ledger was dead for the life of the
    // plan — the resume cap's backstop read 0 permanently.
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(runSessionsPath(plan), 'x'.repeat(262 * 1024));
    appendRunSession(plan, envOf('S1'));
    expect(sessionEntryCount(plan)).toBe(1);
    expect(statSync(runSessionsPath(plan)).size).toBeLessThan(10_240);
    expect(currentSessionEntry(plan, envOf('S1'))?.sessionId).toBe('S1');
  });

  it('heals a DIRECTORY plant instead of dying on the rename forever', () => {
    // A directory passes an is-regular-file guard in the negative direction
    // and then fails the noFollow rename with EISDIR on every attempt —
    // swallowed, so nothing was ever recorded and nothing ever self-healed.
    mkdirSync(runSessionsPath(plan), { recursive: true });
    appendRunSession(plan, envOf('S1'));
    expect(lstatSync(runSessionsPath(plan)).isFile()).toBe(true);
    expect(sessionEntryCount(plan)).toBe(1);
  });

  it('heals both plant shapes at the resume marker too', () => {
    mkdirSync(resumeMarkerPath(plan), { recursive: true });
    recordResume(plan, envOf('S1'));
    expect(lstatSync(resumeMarkerPath(plan)).isFile()).toBe(true);
    expect(readResumeMarker(plan).resumes.map((r) => r.sessionId)).toEqual([
      'S1',
    ]);
    writeFileSync(resumeMarkerPath(plan), 'x'.repeat(262 * 1024));
    recordRestart(plan, 'head-moved');
    expect(readResumeMarker(plan).restarts.map((r) => r.reason)).toEqual([
      'head-moved',
    ]);
    expect(statSync(resumeMarkerPath(plan)).size).toBeLessThan(10_240);
  });

  it('a backdated flood of 65 distinct plants cannot evict the genuine entry', () => {
    // The cap keeps the NEWEST end. Keeping the oldest handed a flood of
    // distinct backdated ids the whole cap: they sorted ahead, truncation
    // evicted the genuine newest entries — the running session's own entry
    // included, so its cost floor silently vanished — and the next append
    // rewrote the file from the filtered list, laundering the eviction.
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
    const mtime = statSync(plan).mtimeMs;
    const base = Math.floor(mtime);
    const flood = Array.from({ length: 65 }, (_, i) => ({
      sessionId: `P${i}`,
      atMs: base + i,
      planMtimeMs: mtime,
    }));
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(runSessionsPath(plan), JSON.stringify(flood));
    appendRunSession(plan, envOf('S-genuine'), base + 100_000);
    expect(currentSessionEntry(plan, envOf('S-genuine'))?.sessionId).toBe(
      'S-genuine',
    );
    expect(sessionEntryCount(plan)).toBe(64);
  });
});
