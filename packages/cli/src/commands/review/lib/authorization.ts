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
