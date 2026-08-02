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
export function defaultSkillArgsPath(): string {
  return skillArgsPath('review');
}

export interface WriteAuthorizationRequest {
  /**
   * The skill may pass this only after the user asked, in a message they typed
   * this session, for this review to be published.
   */
  userAuthorized: boolean;
  /**
   * Test seam only (there is no session id under vitest). Ignored whenever a
   * session id is present — honouring a caller-supplied path in a real run
   * would hand the gate back the model-writable file the design removed.
   */
  skillArgs?: string;
  /** The pull request this write targets. */
  pr: number;
  /** The `owner/repo` this write targets. */
  repo: string;
  /** GitHub Enterprise host, when not github.com. */
  host?: string;
}

/**
 * Exactly two things authorise a public write, and both are facts rather than
 * impressions: `--comment` in the arguments the user typed (re-parsed from the
 * CLI's verbatim record), or `--user-authorized`. Authorisation is for a
 * *target*, not a mood: the recorded arguments must name the same pull request
 * (and, for a URL target, the same repo and host) as the write being attempted.
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
    return {
      ok: false,
      why:
        `no review arguments were recorded at ${path}, so this run cannot ` +
        'show that `--comment` was requested',
    };
  }

  const verdict = parseReviewArgs(raw);
  if (!verdict.comment.effective) {
    return {
      ok: false,
      why:
        '`--comment` was not in the review arguments ' +
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
    const authorisedRepo = `${t.owner}/${t.repo}`;
    if (authorisedRepo.toLowerCase() !== req.repo.toLowerCase()) {
      return {
        ok: false,
        why:
          `the review arguments authorise ${authorisedRepo}, but this ` +
          `submission targets ${req.repo}`,
      };
    }
    if (req.host && t.host.toLowerCase() !== req.host.toLowerCase()) {
      return {
        ok: false,
        why:
          `the review arguments authorise ${t.host}, but this submission ` +
          `targets ${req.host}`,
      };
    }
  }

  return {
    ok: true,
    why: `\`--comment\` was in the review arguments for #${authorisedPr}`,
  };
}
