/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which CLI sessions this review ran under, written by the thing that ran them.
//
// A review interrupted mid-run and resumed (`--resume`) continues in a NEW CLI
// session: the harness keys its subagent transcripts on `QWEN_CODE_SESSION_ID`,
// so the first attempt's evidence sits in a directory the second attempt's
// environment no longer names. The readers that certify agent work (coverage,
// retirement, the recovery command) need the earlier directory's name — and the
// orchestrator must not be the one to supply it, for the same reason it is never
// given the prompt-record path: a path the model can choose is a path the model
// can point somewhere flattering.
//
// So `fetch-pr` appends its own session id here, read back later from disk. The
// entry is only ever an ADDRESS, never a verdict. For the CERTIFYING readers
// a fabricated id can at most point at a directory inside the harness's own
// `subagents/` tree, where credit still requires the content-shaped pairing
// (verbatim-delivered prompt, opened brief, diff reads) that fabrication
// cannot satisfy. Two consumers sit outside that sentence, deliberately: ids
// also address `chats/<id>.jsonl`, and the COST ledger folds a session's
// usage with no pairing at all — a forged id there can inflate a number the
// review reports about itself, never a verdict it certifies about the code.
// Cost is accounting, not evidence, and the honest claim stops there.
//
// The same file's sibling, `resume.json`, is the resume/restart bookkeeping the
// skill used to hold only in transcript memory: how many times this review has
// resumed, and whether it already restarted once for head movement.

import { lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteFileSync,
  sanitizeFilenameComponent,
} from '@qwen-code/qwen-code-core';
import { promptRecordDir, runEpochMs } from './prompt-record.js';

const SESSIONS_FILE = 'run-sessions.json';
const RESUME_FILE = 'resume.json';

/**
 * Hard cap on resumes of one review. The workflow's own retry loop allows a
 * single retry (MAX_ATTEMPTS=2), so 2 leaves headroom for a manual rerun
 * without permitting an unbounded resume chain on a review that keeps dying.
 */
export const RESUME_MAX = 2;

/**
 * Session ids are used to BUILD A PATH under the harness's `subagents/` dir, so
 * the character set is closed: anything that could traverse (`/`, `\`, `..`) or
 * smuggle separators fails the whole entry. Mirrors the shape the harness
 * actually generates (UUIDs) with room for prefixed variants.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The equivalence key under which two session ids are the SAME session: the
 * path segment they become. Case folds on case-insensitive filesystems,
 * Win32 strips trailing dots, and the harness sanitizes everything outside
 * [A-Za-z0-9_-] to '_' when it creates the directory — so identity
 * comparisons anywhere in this module must fold the same way, or a planted
 * alias reads as a second session with the first one's evidence.
 */
function sessionPathKey(id: string): string {
  return sanitizeFilenameComponent(id).toLowerCase();
}

/**
 * How far ahead of NOW an entry may be stamped. Cross-run exclusion is owed
 * to the exact plan-mtime fence, not to this ceiling — a rewrite moves the
 * plan's mtime and the fence drops every earlier entry regardless of its
 * stamp. What the ceiling refuses is a plausibility lie WITHIN a run: a
 * forged future `atMs` would otherwise shift its session's billing window
 * and its position in the attempt ordering, since nothing legitimate ever
 * writes the future.
 */
const FUTURE_SLACK_MS = 2000;

/**
 * How far an entry's recorded plan mtime may sit from the plan's current one
 * and still count as the same plan.
 *
 * Not slack in the epoch-window sense — this is representation noise. A file
 * mtime is nanoseconds on ext4 and APFS, `mtimeMs` is that value in a double,
 * and restoring one through `utimesSync` (which takes seconds as a double)
 * costs a unit in the last place: 1786717283911.999 goes back as
 * 1786717283911.998. `repo-context` performs exactly that round trip on every
 * enrichment that changes the plan, so an EXACT comparison here declares the
 * run's own plan to be a different one and drops every session entry —
 * silently emptying the resume ledger on the filesystems this runs on.
 *
 * A millisecond is orders of magnitude above that noise and orders of
 * magnitude below the real thing this must still separate: a FRESH capture of
 * the same PR rewrites the plan seconds or minutes later, never inside the
 * same millisecond.
 */
const PLAN_MTIME_TOLERANCE_MS = 1;

/**
 * The plan mtime an entry was written against — the EXACT fresh-run boundary.
 *
 * The epoch window alone is inexact by its own slack: a previous run that
 * appended within the slack of this run's plan write survives it, and one of
 * its late transcripts would then be credited here. An entry carries the
 * mtime it saw, and a reader keeps only entries that saw THIS plan — which a
 * fresh run necessarily rewrote and a resumed run deliberately did not.
 * Entries without the field never exist in the wild — it shipped in the same
 * change as the ledger itself — so there is no fallback: an entry that cannot
 * say which plan it saw is dropped. (An earlier revision degraded to the
 * window instead; the fallback was removed as unsound and this paragraph
 * outlived it by one round.)
 *
 * Compared within `PLAN_MTIME_TOLERANCE_MS`, not exactly: the mtime survives a
 * `utimesSync` round trip on every content-changing enrichment, and that round
 * trip costs a unit in the last place. See that constant.
 */
/**
 * The one indirection the fault-injection probes need. `node:fs` arrives as
 * a sealed ESM namespace under the test runner, so a transient EMFILE/EPERM
 * — the fault class the single-read design exists to survive — cannot be
 * injected by mocking the module. Same idea as `contained-read`'s injectable
 * read seam; production code never reassigns these.
 */
export const ledgerIoForTests = { readFileSync, statSync };

function planMtimeMs(planPath: string): number | null {
  try {
    return ledgerIoForTests.statSync(planPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Entries stamped past this are not this run's; nothing writes the future. */
function runCeilingMs(nowMs: number = Date.now()): number {
  return nowMs + FUTURE_SLACK_MS;
}

interface SessionEntry {
  sessionId: string;
  atMs: number;
  /** The plan mtime this entry was written against. Required on read. */
  planMtimeMs?: number;
}

/** Where the session ledger lives — derived from the plan path, never passed. */
export function runSessionsPath(planPath: string): string {
  return join(promptRecordDir(planPath), SESSIONS_FILE);
}

/**
 * Read one ledger file, refusing anything that is not a regular file.
 *
 * The write side is hardened with `noFollow`; the read side must match, or a
 * planted symlink redirects the read and a planted FIFO blocks it forever —
 * a hang, not an error, in a command a review is waiting on.
 */
const MAX_LEDGER_BYTES = 256 * 1024;
const MAX_LEDGER_ENTRIES = 64;

/**
 * What occupies a ledger path, classified in ONE pass so a writer can make
 * its whole decision from a single read. The clobber guard used to ask two
 * separate questions ("did the read fail?" then "is a regular file there?"),
 * and a transient fault that cleared between them defeated the guard: the
 * first read failed, the second succeeded, and the append rewrote the whole
 * file from the empty fallback — erasing every recorded session.
 *
 * - `ok`      — a bounded regular file whose bytes are in hand.
 * - `absent`  — nothing there; an empty ledger is the ordinary first-write
 *               state.
 * - `plant`   — an occupant that CANNOT be legitimate state: a symlink or
 *               FIFO (this module never writes one), a directory (ditto —
 *               and the noFollow rename would fail EISDIR on it forever,
 *               silently killing every future append), or a regular file
 *               over `MAX_LEDGER_BYTES` (a legitimate ledger is ≤64 capped
 *               entries, a few KB; refusing to touch an oversize plant
 *               would freeze the ledger for the life of the plan). Writers
 *               heal these; readers see no entries.
 * - `refused` — a present, plausible regular file whose read failed
 *               (EMFILE, an AV scanner's EPERM). It holds every previously
 *               recorded entry, so writers must preserve it: skipping one
 *               append loses one entry, a rewrite loses them all.
 */
type LedgerOccupant =
  | { kind: 'ok'; text: string }
  | { kind: 'absent' }
  | { kind: 'plant'; shape: 'directory' | 'special' | 'oversize' }
  | { kind: 'refused' };

function ledgerOccupant(path: string): LedgerOccupant {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isDirectory()) return { kind: 'plant', shape: 'directory' };
  // A symlink would redirect the read and a FIFO would block it forever — a
  // hang, not an error, in a command a review waits on.
  if (!st.isFile()) return { kind: 'plant', shape: 'special' };
  // Bounded before the read: these files are bookkeeping (a handful of
  // small entries), and a planted multi-gigabyte one would otherwise stall
  // or exhaust every command that touches them.
  if (st.size > MAX_LEDGER_BYTES) return { kind: 'plant', shape: 'oversize' };
  try {
    return { kind: 'ok', text: ledgerIoForTests.readFileSync(path, 'utf8') };
  } catch {
    return { kind: 'refused' };
  }
}

/**
 * Clear a planted occupant so the atomic write can land. The noFollow
 * rename already replaces a symlink, FIFO or regular file; only a DIRECTORY
 * survives it (EISDIR on every attempt), so only a directory needs removing.
 */
function healPlant(path: string, occ: LedgerOccupant): void {
  if (occ.kind === 'plant' && occ.shape === 'directory') {
    rmSync(path, { recursive: true, force: true });
  }
}

function readLedgerFile(path: string): string | null {
  const occ = ledgerOccupant(path);
  return occ.kind === 'ok' ? occ.text : null;
}

/**
 * This run's session entries, oldest first. Unreadable or malformed → empty:
 * the failure direction is "earlier evidence invisible", which coverage answers
 * by requiring the work again — never the reverse.
 */
function readSessions(planPath: string): SessionEntry[] {
  return parseSessions(
    readLedgerFile(runSessionsPath(planPath)),
    planPath,
    planMtimeMs(planPath),
  );
}

/**
 * Parse and fence ledger text that has already been read. The plan mtime is
 * an ARGUMENT, not a fresh stat: the writers pass the same value they stamp
 * into the new entry, so a transient stat fault cannot make the fence drop
 * every existing entry while the writer's own stat succeeds — which would
 * hand the append an empty list to rewrite the intact file from.
 */
function parseSessions(
  raw: string | null,
  planPath: string,
  planMtime: number | null,
): SessionEntry[] {
  try {
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const epoch = runEpochMs(planPath);
    const ceiling = runCeilingMs();
    // Validate FIRST, cap the survivors: sliced raw, 64 malformed entries at
    // the front consume the whole cap and hide every real one behind them —
    // `sessionEntryCount` then reads 0 and the resume cap resets, which is
    // the attack the count exists to survive. Validation cost is bounded by
    // MAX_LEDGER_BYTES (the file cannot hold enough entries to matter); the
    // cap's own job — bounding the directory reads CONSUMERS pay per entry —
    // is done by capping what is returned, and that stands either way.
    const kept = parsed.filter(
      (e): e is SessionEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as SessionEntry).sessionId === 'string' &&
        SESSION_ID_RE.test((e as SessionEntry).sessionId) &&
        typeof (e as SessionEntry).atMs === 'number' &&
        (e as SessionEntry).atMs >= epoch &&
        (e as SessionEntry).atMs <= ceiling &&
        // The exact boundary, with no fallback: an entry written against a
        // DIFFERENT plan belongs to a different run, whatever the window
        // says, and an entry that cannot say which plan it saw cannot be
        // placed at all. The window alone is inexact by construction — a
        // previous run that appended within its slack survives it — and the
        // field ships in the same change as the ledger itself, so there are
        // no older files to be lenient toward.
        typeof (e as SessionEntry).planMtimeMs === 'number' &&
        planMtime !== null &&
        Math.abs((e as SessionEntry).planMtimeMs! - planMtime) <=
          PLAN_MTIME_TOLERANCE_MS,
    );
    // Order matters, and each step has a payload it defeats: SORT first
    // (earliest wins, not file order), DEDUP second (a flood of valid
    // duplicates collapses to one before any cap can be consumed), CAP last
    // over the distinct survivors — capped in file order before dedup, 64
    // planted duplicates evicted every genuine entry and the next append
    // laundered the plant permanently.
    const capped = kept;
    // Deduplicate on READ, not only on append: the file lives in a directory
    // the orchestrator can reach, and a hand-written duplicate would make a
    // consumer that iterates entries (the cost ledger) bill one session
    // twice. EARLIEST occurrence wins — sorted by time first, because "first
    // in file order" hands a hand-written out-of-order duplicate the
    // session's identity, and its later atMs then erases the window between
    // the real start and itself from every consumer's billing.
    //
    // The equivalence key is the SANITIZED, lowercased id: these ids become
    // path segments, and two ids are the same session exactly when they
    // reach the same directory — case-insensitive filesystems fold case,
    // Win32 strips trailing dots, and the harness's own sanitizer maps
    // everything outside [A-Za-z0-9_-] to '_'. Folding on the raw id left
    // every one of those aliases open as a second identity.
    const seen = new Set<string>();
    return (
      capped
        .slice()
        .sort((x, y) => x.atMs - y.atMs)
        .filter((e) => {
          const k = sessionPathKey(e.sessionId);
          return seen.has(k) ? false : (seen.add(k), true);
        })
        // Keep the NEWEST end. Keeping the oldest handed a flood of distinct
        // BACKDATED plants the whole cap: they sorted ahead of the genuine
        // entries, the truncation evicted the genuine newest end — the running
        // session's own entry included — and the next append rewrote the file
        // from the filtered list, laundering the eviction permanently. A
        // backdated flood now truncates itself.
        .slice(-MAX_LEDGER_ENTRIES)
    );
  } catch {
    return [];
  }
}

/**
 * Record the current session against this plan. Id comes from the environment
 * the CLI itself exported, never from an argument. Write errors are swallowed
 * for the same reason `stampRound` swallows them — a read-only tmp dir must
 * not stop a review being built; it only costs a later resume its evidence.
 */
export function appendRunSession(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): void {
  try {
    const id = env['QWEN_CODE_SESSION_ID']?.trim();
    if (!id || !SESSION_ID_RE.test(id)) return;
    const mtime = planMtimeMs(planPath);
    // No plan mtime, no entry. `readSessions` hard-requires the field — an
    // entry that cannot say which plan it saw is dropped on every read, and
    // the next append rewrites the file from the filtered list, so a
    // field-less entry is not a degraded record but a GUARANTEED-dead write
    // that silently loses the id. Refusing up front is honest and identical
    // in effect, minus the false success.
    if (mtime === null) return;
    const path = runSessionsPath(planPath);
    // ONE read decides everything below. This append rewrites the whole file
    // from what it read, so a ledger that EXISTS but could not be read must
    // refuse the append: proceeding on a transient fault (EMFILE, an AV
    // scanner's EPERM) would clobber every previously recorded entry —
    // erasing attempt 1's address exactly when a resume needs it. Skipping
    // the append loses one entry; the clobber loses them all. Deciding from
    // a SECOND read opened a race: a fault clearing between the two reads
    // made the guard see a healthy file while `entries` held the empty
    // fallback.
    const occ = ledgerOccupant(path);
    if (occ.kind === 'refused') return;
    const entries = parseSessions(
      occ.kind === 'ok' ? occ.text : null,
      planPath,
      mtime,
    );
    // Same equivalence as the read side: a pre-planted case- or alias-variant
    // otherwise passes this check, and first-write-wins hands it the
    // session's identity.
    if (entries.some((e) => sessionPathKey(e.sessionId) === sessionPathKey(id)))
      return;
    healPlant(path, occ);
    entries.push({ sessionId: id, atMs: nowMs, planMtimeMs: mtime });
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(entries), {
      noFollow: true,
    });
  } catch {
    // Bookkeeping only; the review itself must not fail on it.
  }
}

/**
 * How many sessions this run's ledger records — a COUNT, ungated.
 *
 * The authorization gate on `priorSessionEntries` protects EVIDENCE: it stops
 * a session that was never granted a resume from reading another attempt's
 * transcripts. A count is not evidence. It says how many times this review has
 * been picked up, which is exactly what a cap needs and reveals nothing about
 * what any attempt did.
 *
 * The distinction matters because the cap read both terms through the gate,
 * and the gate cannot be satisfied at ruling time: a session is recorded as an
 * authorized resume only AFTER its ruling passes, so the ledger term was
 * structurally zero for every ruling. Deleting `resume.json` then reset the
 * cap that the ledger was supposed to backstop — the one attack the two-counter
 * design existed to defeat.
 */
export function sessionEntryCount(
  planPath: string,
  opts: {
    /**
     * Exclude the session this id names (folded on the path key). The resume
     * cap counts OTHER attempts: a same-session retry of the last permitted
     * resume is that same resume, and counting the session's own entry in
     * either term refuses the retry — whose fresh fall-through then destroys
     * the very state being resumed.
     */
    excludeSessionId?: string;
  } = {},
): number {
  const entries = readSessions(planPath);
  if (opts.excludeSessionId === undefined) return entries.length;
  const key = sessionPathKey(opts.excludeSessionId);
  return entries.filter((e) => sessionPathKey(e.sessionId) !== key).length;
}

/**
 * How many RESUMES this run's ledger records — the entries PAST the first.
 * The ledger's first entry is the original run's own session, which is not
 * a resume. `excludeSessionId` removes the resuming session's own entry
 * from that remainder — and when the resuming session IS the original, the
 * exclusion has already removed the first entry, so the original must not
 * be subtracted AGAIN: the double subtraction undercounted the cap by one
 * and admitted a resume past the cap through the exact backstop path
 * (deleted marker, original session resuming) this term exists to hold.
 */
export function ledgerResumeCount(
  planPath: string,
  opts: { excludeSessionId?: string } = {},
): number {
  const past = readSessions(planPath).slice(1);
  if (opts.excludeSessionId === undefined) return past.length;
  const key = sessionPathKey(opts.excludeSessionId);
  return past.filter((e) => sessionPathKey(e.sessionId) !== key).length;
}

/**
 * Session ids of EARLIER attempts of this same run — the current session
 * excluded, order preserved, deduplicated by the ledger's own append guard.
 * These are addresses for `subagents/<id>` lookups, nothing more.
 */
export function priorSessionIds(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return priorSessionEntries(planPath, env).map((e) => e.sessionId);
}

/**
 * This session's own ledger entry, if it wrote one.
 *
 * Needed for the cost floor: a review that starts inside an EXISTING CLI
 * session must not bill that session's earlier, unrelated turns, and the
 * plan floor alone cannot tell them apart. No authorization gate here — a
 * session reading its own entry is not reading anyone else's evidence.
 */
export function currentSessionEntry(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { sessionId: string; atMs: number } | null {
  const raw = env['QWEN_CODE_SESSION_ID']?.trim();
  if (!raw) return null;
  const current = sessionPathKey(raw);
  return (
    readSessions(planPath).find(
      (e) => sessionPathKey(e.sessionId) === current,
    ) ?? null
  );
}

/**
 * Did the CURRENT session actually earn the right to read prior evidence?
 *
 * The ledger is an address book; it does not say a resume was authorized.
 * Without this gate any session that points at an old plan unions the
 * ledgered attempts' transcripts and inherits their coverage — after head
 * drift, stale evidence could certify code nobody reviewed. `fetch-pr
 * --resume` records the resume only after every probe passed (worktree at
 * the fetched SHA and clean, diff bytes unchanged, live head unmoved), so
 * the marker naming this session IS that proof, written by the CLI.
 */
function resumeAuthorized(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env['QWEN_CODE_SESSION_ID']?.trim();
  if (!raw) return false;
  const current = sessionPathKey(raw);
  return readResumeMarker(planPath).resumes.some(
    (r) => sessionPathKey(r.sessionId) === current,
  );
}

/**
 * The same prior sessions, with the timestamps that bound them.
 *
 * `endsAtMs` is the NEXT ledger entry's `atMs` — the moment the following
 * attempt started, which is the only end boundary this run records. The cost
 * ledger clamps a prior session's chat usage to it: an interrupted session
 * whose CLI kept being used for unrelated turns afterwards would otherwise
 * bill that activity as review cost, the mirror of the omission the ledger
 * exists to prevent. `null` only when this session has no ledger entry of
 * its own to close the last prior's window with — in the normal flow
 * `fetch-pr` appends unconditionally, so the newest prior is clamped to
 * THIS session's start.
 */
export function priorSessionEntries(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ sessionId: string; atMs: number; endsAtMs: number | null }> {
  // Case-insensitive for the same reason the dedup is: a case-variant of the
  // CURRENT session id resolves to the current session's own directory, so
  // reading it as a prior session double-reads every record this run wrote —
  // minting `recoveredAgents` and a resumed disclosure on a run that never
  // resumed, and folding the current chat into the prior totals.
  if (!resumeAuthorized(planPath, env)) return [];
  const current0 = env['QWEN_CODE_SESSION_ID']?.trim();
  const current = current0 ? sessionPathKey(current0) : undefined;
  // Sort by time, not file order: `endsAtMs` is a COST CLAMP, and an
  // out-of-order (hand-written) ledger or a backwards wall-clock step
  // between attempts would otherwise invert it — a null or negative window
  // silently unbounds or empties a prior session's bill.
  const all = [...readSessions(planPath)].sort((a, b) => a.atMs - b.atMs);
  // PRIOR means "started before this session", not "is not this session".
  // A twice-resumed run read as the MIDDLE attempt otherwise receives its
  // own successor as a prior with `endsAtMs: null` — the successor's whole
  // activity, unrelated later turns included, folds into this attempt's
  // bill unclamped, and its stamped records enter the evidence pool with no
  // upper window. Only the prefix strictly before this session's own entry
  // is prior; its last window closes at THIS session's start.
  const ownIdx =
    current === undefined
      ? -1
      : all.findIndex((e) => sessionPathKey(e.sessionId) === current);
  const prefix = ownIdx >= 0 ? all.slice(0, ownIdx) : all;
  const ownAtMs = ownIdx >= 0 ? all[ownIdx].atMs : null;
  return prefix
    .map((e, i) => ({
      sessionId: e.sessionId,
      atMs: e.atMs,
      endsAtMs: i + 1 < prefix.length ? prefix[i + 1].atMs : ownAtMs,
    }))
    .filter((e) => sessionPathKey(e.sessionId) !== current);
}

/** Resume/restart bookkeeping for one review run. */
export interface ResumeMarker {
  schemaVersion: 1;
  /** Each successful `--resume` continuation, in order. */
  resumes: Array<{ sessionId: string; atMs: number; planMtimeMs?: number }>;
  /** Each restart-for-head-movement, in order. The skill's cap is one. */
  restarts: Array<{ atMs: number; reason: string; planMtimeMs?: number }>;
}

// A fresh object every time: callers mutate the arrays (`recordResume`
// pushes into them), so a shared constant would accumulate history across
// reads.
const emptyMarker = (): ResumeMarker => ({
  schemaVersion: 1,
  resumes: [],
  restarts: [],
});

/** Where the resume marker lives — derived from the plan path, never passed. */
export function resumeMarkerPath(planPath: string): string {
  return join(promptRecordDir(planPath), RESUME_FILE);
}

/**
 * The marker, epoch-fenced like the session ledger: entries from a previous
 * review of the same PR are dropped, so a fresh run always starts at zero
 * resumes and zero restarts. Malformed → the empty marker (fail toward "no
 * history", which the caps then treat most permissively — the hard bound on
 * abuse is the session ledger's entry count and the workflow's MAX_ATTEMPTS).
 */
export function readResumeMarker(planPath: string): ResumeMarker {
  return parseMarker(
    readLedgerFile(resumeMarkerPath(planPath)),
    planPath,
    planMtimeMs(planPath),
  );
}

/**
 * Parse and fence marker text that has already been read. Like
 * `parseSessions`, the plan mtime is an argument: the writers pass the value
 * they stamp into the new entry, so one stat serves the fence and the entry
 * both, and a transient stat fault inside a second stat cannot fence-drop
 * every recorded resume while the writer proceeds to rewrite the file.
 */
function parseMarker(
  text: string | null,
  planPath: string,
  planMtime: number | null,
): ResumeMarker {
  try {
    if (text === null) return emptyMarker();
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as ResumeMarker).schemaVersion !== 1
    ) {
      return emptyMarker();
    }
    const epoch = runEpochMs(planPath);
    const ceiling = runCeilingMs();
    const raw = parsed as ResumeMarker;
    const seenResume = new Set<string>();
    const seenRestart = new Set<string>();
    const resumes = Array.isArray(raw.resumes)
      ? raw.resumes
          .filter(
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              typeof e.sessionId === 'string' &&
              // Same closed charset as the session ledger: these ids have the
              // same address semantics, and one read path applying the gate
              // while the other does not is how a threat model rots.
              SESSION_ID_RE.test(e.sessionId) &&
              typeof e.atMs === 'number' &&
              e.atMs >= epoch &&
              e.atMs <= ceiling &&
              // The same exact plan fence as the session ledger, for the
              // same reason: the window alone is inexact by its own slack,
              // and a previous run's resumes surviving into a fresh run
              // arrive with the cap already spent — this reader's own doc
              // promises "a fresh run always starts at zero".
              typeof e.planMtimeMs === 'number' &&
              planMtime !== null &&
              Math.abs(e.planMtimeMs - planMtime) <= PLAN_MTIME_TOLERANCE_MS &&
              // Duplicates would each consume a RESUME_MAX slot and refuse a
              // legitimate continuation.
              !seenResume.has(sessionPathKey(e.sessionId)) &&
              (seenResume.add(sessionPathKey(e.sessionId)), true),
          )
          .slice(0, MAX_LEDGER_ENTRIES)
      : [];
    const restarts = Array.isArray(raw.restarts)
      ? raw.restarts
          .filter(
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              typeof e.reason === 'string' &&
              typeof e.atMs === 'number' &&
              e.atMs >= epoch &&
              e.atMs <= ceiling &&
              typeof e.planMtimeMs === 'number' &&
              planMtime !== null &&
              Math.abs(e.planMtimeMs - planMtime) <= PLAN_MTIME_TOLERANCE_MS &&
              // Dedup for the same reason resumes dedup: each duplicate
              // spends the once-per-review restart bound again.
              !seenRestart.has(`${e.reason}@${e.atMs}`) &&
              (seenRestart.add(`${e.reason}@${e.atMs}`), true),
          )
          // Validated first, like the ledger and the resumes above: sliced
          // raw, junk at the front hides the real restart and the
          // once-per-review bound resets.
          .slice(0, MAX_LEDGER_ENTRIES)
      : [];
    return { schemaVersion: 1, resumes, restarts };
  } catch {
    return emptyMarker();
  }
}

function writeMarker(planPath: string, marker: ResumeMarker): void {
  try {
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(resumeMarkerPath(planPath), JSON.stringify(marker), {
      noFollow: true,
    });
  } catch {
    // Bookkeeping only.
  }
}

/**
 * Record a successful `--resume` continuation under the current session.
 * One entry per session, like the session ledger's own guard: a session
 * resumes a run at most once, so a repeated call is a caller-side retry and
 * must not spend the resume cap twice.
 */
export function recordResume(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): void {
  const id = env['QWEN_CODE_SESSION_ID']?.trim();
  if (!id || !SESSION_ID_RE.test(id)) return;
  const mtime = planMtimeMs(planPath);
  // Same refusal as the session ledger: an entry that cannot say which plan
  // it saw is dropped on every read, so writing it would be a dead write.
  if (mtime === null) return;
  // Same single-read decision as `appendRunSession`: the guard and the
  // parse consume ONE read, so a transient fault clearing between two reads
  // cannot make the guard see a healthy marker while the parse holds the
  // empty fallback — which `writeMarker` would then commit, erasing every
  // recorded resume and restart.
  const markerPath = resumeMarkerPath(planPath);
  const occ = ledgerOccupant(markerPath);
  if (occ.kind === 'refused') return;
  const marker = parseMarker(
    occ.kind === 'ok' ? occ.text : null,
    planPath,
    mtime,
  );
  if (
    marker.resumes.some(
      (r) => sessionPathKey(r.sessionId) === sessionPathKey(id),
    )
  )
    return;
  healPlant(markerPath, occ);
  marker.resumes.push({ sessionId: id, atMs: nowMs, planMtimeMs: mtime });
  writeMarker(planPath, marker);
}

/**
 * Record a restart-for-head-movement (the skill's once-per-review event).
 * Deduplicated by reason: the event is at-most-once by rule, so a repeated
 * identical call is a caller-side retry, not a second restart.
 */
export function recordRestart(
  planPath: string,
  reason: string,
  nowMs: number = Date.now(),
): void {
  const mtime = planMtimeMs(planPath);
  if (mtime === null) return;
  // Single-read decision; see `recordResume`.
  const markerPath = resumeMarkerPath(planPath);
  const occ = ledgerOccupant(markerPath);
  if (occ.kind === 'refused') return;
  const marker = parseMarker(
    occ.kind === 'ok' ? occ.text : null,
    planPath,
    mtime,
  );
  if (marker.restarts.some((r) => r.reason === reason)) return;
  healPlant(markerPath, occ);
  marker.restarts.push({ atMs: nowMs, reason, planMtimeMs: mtime });
  writeMarker(planPath, marker);
}
