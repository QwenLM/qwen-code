/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Was this run authorised to make a public write on the user's behalf?
//
// Extracted verbatim from `submit.ts` when `publish-assets` became the second
// sanctioned public write. Two write gates with two implementations is how they
// drift — one learns a lesson (the target-binding check below was added after a
// dry run showed `--comment` acting as a bearer token) and the other quietly
// keeps the hole. One function, two callers, one lesson-ledger.
//
// The design constraint both callers inherit: authorisation is read from the
// CLI's verbatim record of what the user typed (the session-scoped args file),
// re-parsed here — never from the parser's JSON *output*, which is a document
// the caller writes. A model that wants to post can write
// `{"comment":{"effective":true}}` to any file and point at it; it cannot
// retroactively edit the user's own keystrokes.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  skillArgsPath,
  currentSessionId,
  SKILL_ARGS_DIR,
} from '../../../services/skill-args-file.js';
import { parseReviewArgs } from '../parse-args.js';
import { isOwnerRepo } from './gh.js';
import { hostsEquivalent } from './remote-match.js';

/**
 * Where the CLI records a skill's invocation arguments, verbatim, before the
 * skill's prompt reaches the model. Derived from the session id at call time,
 * not a constant: the args file is named for the session that wrote it, and a
 * review subcommand (a subprocess of that session) reads the same name from the
 * same inherited `QWEN_CODE_SESSION_ID`.
 */
function defaultSkillArgsPath(): string {
  return skillArgsPath('review');
}

export interface WriteAuthorizationRequest {
  /**
   * The skill may pass this only after the user asked, in a message they typed
   * this session, for this review to be published.
   */
  userAuthorized: boolean;
  /**
   * The standing `review.comment` setting, resolved by the caller from
   * settings. When on, a PR review is treated as if `--comment` was passed —
   * the target binding below still applies, so the write remains authorised
   * only for the PR the recorded arguments name.
   */
  defaultComment?: boolean;
  /**
   * Test seam only (there is no session id under vitest). Ignored whenever a
   * session id is present — honouring a caller-supplied path in a real run
   * would hand the gate back the model-writable file the design removed.
   */
  skillArgs?: string;
  /** The pull request this write targets. */
  pr: number;
  /**
   * The `owner/repo` the PR under review lives in, when the caller knows it.
   *
   * Optional because the two callers know different things. `submit` writes TO
   * the pull request, so it always knows (and must bind) the repo it is
   * posting to. `publish-assets` writes to the user-designated assets repo on
   * BEHALF of a PR — the destination is consented to by the designation
   * itself, and the reviewed repo is not among its inputs. Binding the
   * URL-shaped authorisation against the assets repo was the bug this field's
   * optionality fixes: a fork-hosted assets repo plus a URL target refused a
   * legitimately authorised run. When absent, the gate binds the PR number
   * (and host) alone.
   */
  repo?: string;
  /**
   * The host the caller ASSERTS for the write — the semantics are
   * caller-dependent, paired with `absentHostFollowsRecording` below.
   * Callers whose routing falls back to the recorded binding (submit)
   * pass the caller-typed flag only — never the ambient env: absence is
   * NOT a github.com claim there, and the pr-url host check is skipped.
   * Callers whose routing falls back to github.com/ambient
   * (publish-assets) pass the resolved effective host, including an
   * operator-exported GH_HOST: absence reads as github.com, and the
   * gate compares against that default rather than skipping the check —
   * a URL-shaped authorisation recorded for an Enterprise host must not
   * admit a write routed at github.com merely because the caller
   * omitted --host, and vice versa. (The asymmetric `req.host &&` guard
   * this replaces bound the host in one direction only; caught by this
   * skill's own review.)
   */
  host?: string;
  /**
   * True only for callers whose routing FALLS BACK to the recorded
   * binding when no host is asserted (submit: the gh write binds
   * explicitHost ?? recordedHost ?? cwdOriginHost). There the recording
   * cannot contradict the routing it supplies — an absent `host` is NOT
   * a github.com claim, and the pr-url host check is skipped instead of
   * reading absence as one (which refused the ordinary flagless publish
   * of a GHE-recorded review after the whole review ran). publish-assets
   * leaves this false: its routing falls back to github.com/ambient, so
   * an absent host IS github.com there and the comparison stands.
   */
  absentHostFollowsRecording?: boolean;
}

/**
 * What the recorded-args lookup found for THIS write's target.
 * - `host`: the recorded host to bind the refusal on, when one exists.
 * - `unbound`: a recording naming the same PR exists but yields NO host
 *   evidence (bare-number spellings without a `--host` flag). The target's
 *   platform is then unprovable from the recording — for a public,
 *   irreversible write the gate fails CLOSED on this rather than trusting
 *   the runtime environment alone (a bare-number Aone review recorded in
 *   an Aone clone otherwise posts at github.com's same-named repo from a
 *   non-Aone cwd — the canonical Aone invocation shape carries no URL).
 */
interface RecordedHostLookup {
  host?: string;
  unbound: boolean;
}

/** Bound on a recorded-args read: the files are one-line CLI invocations;
 *  anything bigger is not a recording this code wrote and must not be
 *  slurped (a planted symlink to an endless source would otherwise hang
 *  the publish). */
const RECORDED_ARGS_MAX_BYTES = 64 * 1024;

/**
 * Lookup of the recorded target's host for the `--user-authorized` fast
 * path — it must publish without running the full gate, but the write
 * gate's platform binding must not lose the host the recorded target
 * names.
 *
 * The host is bound to THIS write: only a recording naming the same PR
 * number AND the same repo supplies a host — a stale recording of a
 * different target must not supply one (the refusal would fire on the
 * wrong target, or a stale host would suppress the environment arms). A
 * bare-number recording of the same PR supplies the recorded `--host`
 * flag when present — that spelling carries no URL host, and the flag is
 * the only recorded platform evidence.
 *
 * The scan is HARDENED — the store lives under `.qwen/tmp/`, which also
 * holds review worktrees checked out from the PR's own tree, so the
 * content there is attacker-influenceable:
 *  - only `s-*` session directories are scanned (never `review-pr-*`
 *    worktrees or anything else a reviewed PR can plant);
 *  - symlinks are skipped at both the directory and the file level
 *    (mirroring writeSkillArgs' O_NOFOLLOW policy on the write side of
 *    this same store) — a planted link must not be followed;
 *  - reads are size-bounded (RECORDED_ARGS_MAX_BYTES).
 *
 * Candidate set: the session-scoped args file (the publishing session's
 * own recording — it may post an OLDER same-PR recording than a sibling
 * session's, so it joins the ordering instead of preceding it), every
 * sibling session directory's recording, and the sessionless root-level
 * recording. ALL of them order by the recording FILE's mtime, newest
 * first. The args file is named for the session that recorded the
 * review, and a `--user-authorized` publish characteristically runs in a
 * DIFFERENT session ("post the review we saved") — without the sibling
 * scan the file is simply absent there and a recorded Aone target posts
 * at github.com's same-named repo. Any read/parse trouble still degrades
 * gracefully and never blocks a user-authorised publish.
 */
function lookupRecordedHost(
  req: WriteAuthorizationRequest,
): RecordedHostLookup {
  const bindHost = (raw: string): string | undefined | null => {
    // undefined = matches this write but yields no host (bare number, no
    // recorded --host); null = not this write's recording.
    try {
      const parsed = parseReviewArgs(raw, { comment: req.defaultComment });
      const t = parsed.target;
      if (t.type === 'pr-url') {
        // Repo axis case-INSENSITIVE — the slow-path gate and the floor
        // recovery both lowercase both sides, and GitHub resolves
        // owner/repo case-insensitively server-side. A case-drifted
        // `--repo` used to make this binding vanish silently, dropping the
        // recording out of platform selection between two writable
        // platforms.
        return t.number === req.pr &&
          `${t.owner}/${t.repo}`.toLowerCase() ===
            (req.repo ?? '').toLowerCase()
          ? t.host
          : null;
      }
      if (t.type === 'pr-number' && t.number === req.pr) {
        return parsed.host;
      }
      return null;
    } catch {
      return null;
    }
  };
  // The FULL candidate set: the session-scoped (or override) recording,
  // every sibling session recording, and the sessionless root recording.
  // A Set dedupes the publishing session's own directory, which the
  // sibling scan reaches again.
  const candidatePaths = new Set<string>([
    currentSessionId() === '' && req.skillArgs
      ? req.skillArgs
      : defaultSkillArgsPath(),
  ]);
  try {
    for (const entry of readdirSync(SKILL_ARGS_DIR, { withFileTypes: true })) {
      // Session directories ONLY — `.qwen/tmp/` also holds review
      // worktrees materialized from the reviewed PR's own tree; their
      // content is attacker-controlled and must never supply a host.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!/^s-/.test(entry.name)) continue;
      candidatePaths.add(
        join(SKILL_ARGS_DIR, entry.name, 'qwen-skill-args-review.txt'),
      );
    }
    candidatePaths.add(join(SKILL_ARGS_DIR, 'qwen-skill-args-review.txt'));
  } catch {
    // No recorded-args directory at all — the session-scoped candidate
    // above is the only one.
  }
  // Order every candidate by the recording FILE's mtime, newest first.
  // Session ids are arbitrary strings, so name order is a coin flip; the
  // record itself is last-writer-wins and the cross-session scan must
  // read it the same way, or an OLDER session's same-number recording
  // (Aone's small global MR ids collide with GitHub PR numbers easily)
  // supplies a stale host that masks the newest recording's hostlessness.
  // The DIRECTORY's mtime is NOT the key: writeSkillArgs rewrites the
  // recording in place (O_WRONLY|O_CREAT|O_TRUNC, no unlink/rename),
  // which advances the file's mtime and never the parent directory's —
  // and any other skill's args file created in the session dir bumps it.
  // Keying the sort on the directory let a plain re-run of an older
  // session's review (the re-run the unbound refusal's remedy prescribes)
  // lose its newest-wins position, routing an irreversible write on
  // stale evidence. Symlinks are skipped at the file level, mirroring
  // writeSkillArgs' O_NOFOLLOW policy on the write side of this store.
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const path of candidatePaths) {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || st.size > RECORDED_ARGS_MAX_BYTES) continue;
      candidates.push({ path, mtime: st.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { path } of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const bound = bindHost(raw);
    if (bound === null) continue;
    // The FIRST (newest) same-PR recording decides: it yields its host, or
    // — when it carries none — the unbound verdict. Scanning PAST a
    // hostless newest recording to harvest an older session's host is the
    // stale-evidence hole the mtime ordering exists to close.
    return { host: bound, unbound: bound === undefined };
  }
  return { host: undefined, unbound: false };
}

/**
 * The structural class of a write refusal. The advice at the submit call
 * site branches on THIS, never on the refusal text: `why` embeds the
 * operator's verbatim recorded arguments (JSON.stringify of the raw
 * record), and any marker string can itself appear inside that quoted
 * record — text that embeds operator input cannot classify itself.
 */
export type ReviewWriteRefusalClass =
  | 'topology'
  | 'comment-not-requested'
  | 'unbound';

/**
 * Exactly three things authorise a public write, and all are facts rather than
 * impressions: `--comment` in the arguments the user typed (re-parsed from the
 * CLI's verbatim record), the standing `review.comment` setting, or
 * `--user-authorized`. Authorisation is for a *target*, not a mood: the
 * recorded arguments must name the same pull request (and, for a URL target,
 * the same repo and host) as the write being attempted.
 */
export function reviewWriteAuthorization(req: WriteAuthorizationRequest): {
  ok: boolean;
  why: string;
  /**
   * The refusal class — present on every refusal, absent on success. See
   * `ReviewWriteRefusalClass` for why the caller branches on this instead
   * of matching `why`.
   */
  cls?: ReviewWriteRefusalClass;
  /**
   * The host the recorded target names, when it names one: a pr-url target
   * carries it; a bare pr-number supplies a recorded `--host` flag or none.
   * The `--user-authorized` fast path reads it best-effort from the
   * recorded args (below) for the same reason the slow path does. Write
   * gates that must reason about the target's PLATFORM read it here
   * instead of re-deriving the platform from the runtime environment alone
   * — the effective host can be steered by an ambient GH_HOST export away
   * from where the recorded review actually lives (submit's Aone refusal
   * uses it to stay shut in both directions).
   */
  recordedHost?: string;
  /**
   * A recording naming this PR exists but yields NO host evidence (see
   * lookupRecordedHost). The platform is unprovable from the recording;
   * the write gate fails closed on this arm rather than trusting the
   * runtime environment alone. Absent on the refusal paths.
   */
  recordedUnbound?: boolean;
  /**
   * True when the slow path authorised from a caller-supplied
   * `--skill-args` path (honoured only when no session id is present) —
   * a recording that belongs to ANOTHER cwd. The write gate must not let
   * the submission cwd's origin probe stand in for such a recording's
   * missing platform evidence: the probe names submit's clone, not the
   * review's, so a hostless override recording fails closed instead.
   * Absent on the fast path and on refusals.
   */
  viaSkillArgsOverride?: boolean;
} {
  if (req.userAuthorized) {
    const lookup = lookupRecordedHost(req);
    return {
      ok: true,
      why: 'the user asked for this review to be published',
      // The fast path publishes because the user asked — but it must still
      // surface the recorded target's host: the write gate's platform
      // binding keys on it, and skipping it here re-opens the exact leak
      // the binding exists to close (a recorded Aone codereview target,
      // user-authorised from a non-Aone cwd with no --host/GH_HOST, would
      // otherwise post at github.com's same-named repo). Best effort: any
      // read/parse trouble degrades gracefully (see lookupRecordedHost)
      // and never blocks a user-authorised publish.
      recordedHost: lookup.host,
      recordedUnbound: lookup.unbound,
    };
  }

  const sessionScoped = defaultSkillArgsPath();
  // The caller-supplied seam is honoured ONLY when no session id is
  // present (see WriteAuthorizationRequest.skillArgs). When it is used,
  // the recording belongs to another cwd, and the write gate must know:
  // the submission cwd's origin probe is not platform evidence for it.
  const skillArgsOverride =
    currentSessionId() === '' && req.skillArgs ? req.skillArgs : undefined;
  const path = skillArgsOverride ?? sessionScoped;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No args file means no arguments — which means no `--comment`. Fail
    // closed: a missing authorisation record is not an absent objection.
    // The wording must not send a setting-driven operator to type a flag
    // they never needed: with `review.comment` on, the real blocker is that
    // no recorded invocation names a pull request to bind the write to, and
    // a plain re-run of the review fixes that — typing `--comment` does not.
    return {
      ok: false,
      cls: req.defaultComment === true ? 'unbound' : 'comment-not-requested',
      why:
        req.defaultComment === true
          ? `no review arguments were recorded at ${path}, so no recorded ` +
            'invocation names a pull request to bind this write to — re-run ' +
            'the review naming the pull request'
          : `no review arguments were recorded at ${path}, so this run ` +
            'cannot show that `--comment` was requested',
    };
  }

  const verdict = parseReviewArgs(raw, { comment: req.defaultComment });
  if (!verdict.comment.effective && verdict.topology !== 'minimal') {
    // When comment was requested — by the flag or the standing
    // `review.comment` setting — but the target is not a PR, effective is
    // false because the arguments name no pull request to bind the write to;
    // blaming a missing `--comment` flag the operator never typed (and
    // implying typing one would fix it) misdirects.
    const commentRequested =
      verdict.comment.requested || req.defaultComment === true;
    return {
      ok: false,
      cls: commentRequested ? 'unbound' : 'comment-not-requested',
      why: commentRequested
        ? `the review arguments (${JSON.stringify(raw.trim())}) do not name a ` +
          'pull request, so they cannot authorise posting to one'
        : '`--comment` was not in the review arguments ' +
          `(${JSON.stringify(raw.trim())})`,
    };
  }
  // A minimal record falls through to the binding checks below: the refusal
  // must name the REAL blocker, and the topology is it only when it is the
  // SOLE one — "re-run the review without it" cannot lift a refusal that a
  // non-PR target, or another PR's number, repo, or host, still holds, and
  // leading with the topology sends the operator to re-run into the same
  // refusal with the binding blocker still unnamed.

  const t = verdict.target;
  const authorisedPr =
    t.type === 'pr-number' || t.type === 'pr-url' ? t.number : undefined;
  if (authorisedPr === undefined) {
    return {
      ok: false,
      cls: 'unbound',
      why:
        `the review arguments (${JSON.stringify(raw.trim())}) do not name a ` +
        'pull request, so they cannot authorise posting to one',
    };
  }
  if (authorisedPr !== req.pr) {
    return {
      ok: false,
      cls: 'unbound',
      why:
        `the review arguments authorise pull request #${authorisedPr}, but ` +
        `this submission targets #${req.pr}`,
    };
  }
  if (t.type === 'pr-url') {
    if (req.repo !== undefined) {
      const authorisedRepo = `${t.owner}/${t.repo}`;
      if (authorisedRepo.toLowerCase() !== req.repo.toLowerCase()) {
        return {
          ok: false,
          cls: 'unbound',
          why:
            `the review arguments authorise ${authorisedRepo}, but this ` +
            `submission targets ${req.repo}`,
        };
      }
    }
    // The host check stands on its own, NOT nested under the repo binding —
    // and it binds in BOTH directions: an absent req.host means the write
    // routes at github.com, which is a host like any other, not an exemption
    // — UNLESS the caller's routing follows the recorded binding when no
    // host is asserted (submit): there the recording supplies the routing
    // host itself, so absence is not a github.com claim and cannot
    // contradict the recording. Reading it as one refused the ordinary
    // flagless publish of a GHE-recorded review after the whole review ran.
    // Hosts compare through hostsEquivalent, not raw equality — Aone is one
    // platform under TWO names (the CR URL records the web host
    // `code.alibaba-inc.com`; the skill's own `--host` rule for Aone targets
    // carries the git host `gitlab.alibaba-inc.com`). Raw equality refused
    // every codereview-URL target that followed that rule — the whole review
    // ran, and the write died at the gate.
    const hostUnasserted =
      req.host === undefined && req.absentHostFollowsRecording === true;
    const writeHost = (req.host ?? 'github.com').toLowerCase();
    if (!hostUnasserted && !hostsEquivalent(t.host.toLowerCase(), writeHost)) {
      return {
        ok: false,
        cls: 'unbound',
        why:
          `the review arguments authorise ${t.host}, but this submission ` +
          `targets ${req.host ?? 'github.com'}`,
      };
    }
  }

  if (!verdict.comment.effective) {
    // Minimal, and bound to this write on every axis above. When a comment
    // source was recorded, the parser forced effective false, so the
    // topology is the sole blocker and its remedy lifts the refusal; when
    // none was, the topology is still the blocker to name — even a typed
    // --comment would not lift the refusal while minimal stands.
    return {
      ok: false,
      cls: 'topology',
      why:
        `the review arguments (${JSON.stringify(raw.trim())}) ran with ` +
        '`--topology minimal`, which is terminal-only and cannot authorise ' +
        'posting — re-run the review without it',
    };
  }

  return {
    ok: true,
    why: verdict.comment.requested
      ? `\`--comment\` was in the review arguments for #${authorisedPr}`
      : `\`review.comment\` is enabled in settings, and the review arguments name #${authorisedPr}`,
    // Mirror of the fast-path binding: a bare-number recording supplies
    // the recorded `--host` flag (its only host evidence). The UNBOUND
    // fail-closed does NOT ride the slow path — the reason is not what it
    // was when first written (the write gate's cwd arm REFUSED then; it
    // SELECTS now). It survives because the slow path reads the CURRENT
    // SESSION's args file, so it is same-session by construction: the cwd
    // probe the write gate falls back to names the clone the review
    // itself ran in — sound evidence, not a guess — and it no longer
    // reads the ambient GH_HOST (aligned with read detection).
    // Cross-session publishes are the fast path's business, where the
    // unbound refusal covers the same bare-number shape. The ONE shape
    // that is NOT same-session by construction — a session-less caller
    // reading a caller-supplied `--skill-args` override — rides
    // `viaSkillArgsOverride` below, and the write gate fails closed on
    // its hostless form instead of probing the submission cwd.
    recordedHost: t.type === 'pr-url' ? t.host : verdict.host,
    viaSkillArgsOverride: skillArgsOverride !== undefined,
  };
}

/**
 * Best-effort recovery of the operator's recorded posting floor, shared by
 * the two boundaries that must resolve the floor from the CLI's verbatim
 * record rather than the model-written state: `submit` (the posting write)
 * and `compose-review`'s CLI handler (the archived composed JSON and the
 * terminal verdict). Both resolving through this ONE function — with the
 * SAME identity source — is what keeps the registered artifact and the
 * posted review describing the same floor.
 *
 * **The identity is the CALLER'S CLI-typed one first; the plan only fills
 * the axes the caller did not supply.** The plan's CONTENT is CLI-written,
 * but its PATH arrives through the model-written state JSON — the same
 * document whose floor copy this recovery exists to outrank — so a
 * plan-first precedence let a parseable-but-wrong plan choose which
 * identity the operator's verbatim record was tested against and silently
 * stand the recovery down. Caller-first closes that: at submit the caller
 * pr is additionally gate-bound to the recorded target on the `--comment`
 * path, and both boundaries are fed the same caller identity by the skill
 * (`--pr`/`--repo`/`--host` at compose mirroring submit's own flags), so
 * the two recoveries still resolve one floor for one review.
 *
 * The record is bound to that identity at the SAME bar the `--comment`
 * authorisation applies to the same record: the number always, and — for a
 * URL-shaped record — the repo (when an identity repo is known) and the
 * host, both case-insensitive with an absent host reading as github.com.
 * The record is last-writer-wins (`writeSkillArgs` truncates), so a later
 * `/review` of a different PR — or the same number in a DIFFERENT repo —
 * must recover nothing.
 *
 * Returns the floor with its source only when the record carries an
 * operator decision (`severityFloorSource` of `explicit`/`configured`) —
 * the source rides along so the boundaries' audit notes can name the true
 * origin instead of claiming a flag the operator never typed. A
 * default-resolved `auto` (including one produced by silently discarding an
 * invalid configured value) is not a decision and recovers nothing. Every
 * failure mode — no plan PR, no record, unreadable, no decision, another
 * PR's or repo's record — returns undefined and leaves the caller's state
 * value standing, the same fail-open direction enforcement itself takes.
 * The path rule is the gate's own: the caller-supplied seam is honoured
 * only when no session id is present.
 */
export function recordedSeverityFloor(opts: {
  /** The plan of the review being composed or posted — CLI-written content
   * behind a model-written path, so it only FILLS identity axes the caller
   * did not supply, never overrides them. */
  planPath?: string;
  /** The caller's CLI-typed PR number — the identity's first source. */
  callerPr?: number;
  /** The caller's repo — the URL-record bar's first repo source, the plan's
   * `ownerRepo` filling in when absent. */
  callerRepo?: string;
  /** The caller's EFFECTIVE host. Never plan-filled: absent means
   * github.com by the gate's own rule, so there is no gap to fill — the
   * axis where absence is meaningful must not read absence as a gap. */
  callerHost?: string;
  defaultSeverityFloor?: string;
  skillArgs?: string;
}):
  | {
      floor: 'critical' | 'suggestion' | 'auto';
      source: 'explicit' | 'configured';
    }
  | undefined {
  let planPr: number | undefined;
  let planRepo: string | undefined;
  try {
    if (opts.planPath) {
      const plan = JSON.parse(readFileSync(opts.planPath, 'utf8')) as {
        prNumber?: unknown;
        ownerRepo?: unknown;
      };
      const n = plan?.prNumber;
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) planPr = n;
      else if (typeof n === 'string' && /^\d+$/.test(n)) planPr = Number(n);
      if (typeof plan?.ownerRepo === 'string' && isOwnerRepo(plan.ownerRepo)) {
        planRepo = plan.ownerRepo;
      }
    }
  } catch {
    /* the identity falls back to the caller's, exactly as with no plan */
  }
  const pr = opts.callerPr ?? planPr;
  if (pr === undefined) return undefined;
  const repo = opts.callerRepo ?? planRepo;
  // The host axis is NEVER plan-filled: an absent caller host IS github.com
  // by the gate's own rule ("an absent req.host means the write routes at
  // github.com — a host like any other, not an exemption"), so there is no
  // gap for the plan to fill — and a gap-read here handed the model-pathed
  // plan the one identity axis the mandatory caller flags did not pin.
  const host = (opts.callerHost ?? 'github.com').toLowerCase();
  const path =
    currentSessionId() === '' && opts.skillArgs
      ? opts.skillArgs
      : defaultSkillArgsPath();
  try {
    const verdict = parseReviewArgs(readFileSync(path, 'utf8'), {
      severityFloor: opts.defaultSeverityFloor,
    });
    const t = verdict.target;
    if (t.type === 'pr-number') {
      if (t.number !== pr) return undefined;
    } else if (t.type === 'pr-url') {
      if (t.number !== pr) return undefined;
      // A URL-shaped record NAMES a repo, so the repo bar is part of its
      // identity — and an unknown identity repo cannot check it. Skipping
      // the comparison there (the gate's shape, whose only repo-less
      // caller is publish-assets writing to a DESIGNATED assets repo) let
      // another repo's record bind on number and host alone: the record is
      // last-writer-wins, so a `/review other/repo#123` in the session
      // could hand its floor to this repo's #123. Unknown repo therefore
      // recovers nothing — the same direction every other doubt state
      // takes here, leaving the state's floor standing.
      if (
        repo === undefined ||
        `${t.owner}/${t.repo}`.toLowerCase() !== repo.toLowerCase()
      ) {
        return undefined;
      }
      // hostsEquivalent, not raw equality — the same shape the `--comment`
      // gate above binds: an Aone CR-URL record carries the web host while
      // the submission carries the git host (one platform, two names). Raw
      // equality silently discarded the operator's floor exactly on the
      // Aone shape this repo supports.
      if (!hostsEquivalent(t.host.toLowerCase(), host)) return undefined;
    } else {
      return undefined;
    }
    if (verdict.severityFloorSource === 'default') return undefined;
    return {
      floor: verdict.severityFloor,
      source: verdict.severityFloorSource,
    };
  } catch {
    return undefined;
  }
}
