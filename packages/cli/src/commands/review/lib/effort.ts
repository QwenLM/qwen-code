/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Resolve the review effort for a capture command's plan — with the orchestrator
// taken OUT of the threading loop.
//
// The effort reaches every consumer (roster, check-coverage, compose-review) as
// `plan.effort`, which the capture commands (`capture-local`, `plan-diff`,
// `fetch-pr`) write. They learn it from `--effort <level>`, and the skill tells the
// orchestrator to pass the level `parse-args` resolved. But that is a *value the
// model must copy from one file into a flag*, and measured, it does not reliably
// happen: a `/review --effort medium` local run had the orchestrator omit the flag,
// so `plan.effort` was absent and the roster safe-fell-back to the FULL set — the
// user asked for the reduced medium roster and silently got every agent (6a/6b/6c
// included; 6d needs a PR identity, which a local run has none of). The fix is
// deterministic: when `--effort` is not given, read the level `parse-args`
// already wrote to its conventional report. No model action required.

import { readFileSync } from 'node:fs';
import { writeStderrLine } from '../../../utils/stdioHelpers.js';
import { PARSE_ARGS_REPORT } from './paths.js';
import { EFFORT_LEVELS } from '../parse-args.js';
import type { ReviewEffort } from '../parse-args.js';

/**
 * The effort to record in a capture command's plan. An explicit `--effort` wins;
 * otherwise fall back to the level `parse-args` resolved (read from
 * `PARSE_ARGS_REPORT`, relative to the same CWD the skill tee'd it in). `undefined`
 * when neither is available — the roster then fail-safes to the full set, exactly as
 * before, so a missing report never *reduces* coverage.
 */
export function resolveEffort(
  explicit: string | undefined,
): ReviewEffort | undefined {
  if (explicit && EFFORT_LEVELS.has(explicit)) return explicit as ReviewEffort;
  try {
    const parsed = JSON.parse(readFileSync(PARSE_ARGS_REPORT, 'utf8')) as {
      effort?: unknown;
    };
    if (typeof parsed.effort === 'string' && EFFORT_LEVELS.has(parsed.effort)) {
      return parsed.effort as ReviewEffort;
    }
  } catch {
    /* no report, or unreadable/unparseable — undefined (roster fail-safe to full) */
  }
  return undefined;
}

/**
 * The resolved effort shaped for spreading into a capture command's plan:
 * `{ effort }` when a level resolves, `{}` otherwise (roster fail-safes to full).
 * The three capture commands spread this verbatim, so the conditional spread lives
 * here once rather than being re-spelled at each call site.
 */
export function planEffortField(explicit: string | undefined): {
  effort?: ReviewEffort;
} {
  const effort = resolveEffort(explicit);
  if (!effort) return {};
  // The fallback this PR adds is silent by nature — name the resolved level and
  // where it came from so a review that ran at an unexpected effort is one stderr
  // line to diagnose, not a hunt for the parse-args report. Quiet when nothing
  // resolves: the full-roster fail-safe is the long-standing default, not news.
  writeStderrLine(
    `effort: ${effort} (from ${
      explicit && EFFORT_LEVELS.has(explicit) ? '--effort' : 'parse-args report'
    })`,
  );
  return { effort };
}
