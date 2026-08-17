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

import { readFileSync } from 'node:fs';
import {
  skillArgsPath,
  currentSessionId,
} from '../../../services/skill-args-file.js';
import { parseReviewArgs } from '../parse-args.js';
import { isOwnerRepo } from './gh.js';

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
   * The EFFECTIVE host of the write — where the gh calls will actually route,
   * including an operator-exported GH_HOST the caller resolved. Absent means
   * github.com, and the gate compares against that default rather than
   * skipping the check: a URL-shaped authorisation recorded for an Enterprise
   * host must not admit a write routed at github.com merely because the
   * caller omitted --host — and vice versa. (The asymmetric `req.host &&`
   * guard this replaces bound the host in one direction only; caught by this
   * skill's own review.)
   */
  host?: string;
}

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
} {
  if (req.userAuthorized) {
    return { ok: true, why: 'the user asked for this review to be published' };
  }

  const sessionScoped = defaultSkillArgsPath();
  const path =
    currentSessionId() === '' && req.skillArgs ? req.skillArgs : sessionScoped;
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
  if (!verdict.comment.effective) {
    // The refusal must name the REAL blocker. When comment was requested —
    // by the flag or the standing `review.comment` setting — but the target
    // is not a PR, effective is false because the arguments name no pull
    // request to bind the write to; blaming a missing `--comment` flag the
    // operator never typed (and implying typing one would fix it) misdirects.
    const commentRequested =
      verdict.comment.requested || req.defaultComment === true;
    return {
      ok: false,
      why: commentRequested
        ? `the review arguments (${JSON.stringify(raw.trim())}) do not name a ` +
          'pull request, so they cannot authorise posting to one'
        : '`--comment` was not in the review arguments ' +
          `(${JSON.stringify(raw.trim())})`,
    };
  }

  const t = verdict.target;
  const authorisedPr =
    t.type === 'pr-number' || t.type === 'pr-url' ? t.number : undefined;
  if (authorisedPr === undefined) {
    return {
      ok: false,
      why:
        `the review arguments (${JSON.stringify(raw.trim())}) do not name a ` +
        'pull request, so they cannot authorise posting to one',
    };
  }
  if (authorisedPr !== req.pr) {
    return {
      ok: false,
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
          why:
            `the review arguments authorise ${authorisedRepo}, but this ` +
            `submission targets ${req.repo}`,
        };
      }
    }
    // The host check stands on its own, NOT nested under the repo binding —
    // and it binds in BOTH directions: an absent req.host means the write
    // routes at github.com, which is a host like any other, not an exemption.
    const writeHost = (req.host ?? 'github.com').toLowerCase();
    if (t.host.toLowerCase() !== writeHost) {
      return {
        ok: false,
        why:
          `the review arguments authorise ${t.host}, but this submission ` +
          `targets ${req.host ?? 'github.com'}`,
      };
    }
  }

  return {
    ok: true,
    why: verdict.comment.requested
      ? `\`--comment\` was in the review arguments for #${authorisedPr}`
      : `\`review.comment\` is enabled in settings, and the review arguments name #${authorisedPr}`,
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
  /** The caller's repo / effective host — first sources for the URL-record
   * bar, plan values filling in when absent. */
  callerRepo?: string;
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
  let planHost: string | undefined;
  try {
    if (opts.planPath) {
      const plan = JSON.parse(readFileSync(opts.planPath, 'utf8')) as {
        prNumber?: unknown;
        ownerRepo?: unknown;
        host?: unknown;
      };
      const n = plan?.prNumber;
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) planPr = n;
      else if (typeof n === 'string' && /^\d+$/.test(n)) planPr = Number(n);
      if (typeof plan?.ownerRepo === 'string' && isOwnerRepo(plan.ownerRepo)) {
        planRepo = plan.ownerRepo;
      }
      if (typeof plan?.host === 'string' && plan.host.trim() !== '') {
        planHost = plan.host;
      }
    }
  } catch {
    /* the identity falls back to the caller's, exactly as with no plan */
  }
  const pr = opts.callerPr ?? planPr;
  if (pr === undefined) return undefined;
  const repo = opts.callerRepo ?? planRepo;
  const host = (opts.callerHost ?? planHost ?? 'github.com').toLowerCase();
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
      if (
        repo !== undefined &&
        `${t.owner}/${t.repo}`.toLowerCase() !== repo.toLowerCase()
      ) {
        return undefined;
      }
      if (t.host.toLowerCase() !== host) return undefined;
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
