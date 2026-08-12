/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The deterministic layer-coverage cap for the reverse audit.
//
// A modeled executable system — a shell/git guard, a sandbox, a permission
// interpreter — has defect LAYERS a "two dry rounds" stop is silent about (see
// audit-layers.ts). This gate turns that silence into a disclosed cap: when a
// maintainer has declared a diff a modeled system (the repository-context
// `domains` sentinel), it reads the reverse-audit auditors' returns, and for
// every layer none of them RECEIPTED (`Layer walked: <id>`), it emits one
// `unreviewedDimensions` entry. compose-review already caps a would-be Approve
// to Comment on any such entry and renders it in the "Not reviewed" section, so
// this reuses the existing cap — model out of the loop, like scriptLintGate.
//
// Coverage is CORROBORATED, not taken from prose alone. A receipt is text an
// auditor writes, and the reverse-audit brief hands every auditor the receipt
// form and all six layer ids — so a return that read its brief and nothing else
// holds the material to parrot all six receipts without walking a single layer.
// Counting those would release Approve on a diff whose layers went unwalked, the
// exact incident this feature exists to catch. So a transcript's receipts count
// only when it is (a) genuinely a reverse-audit auditor — matched on its launch
// IDENTITY line, not a free-text mention of the role a verifier or nested
// subagent can carry — and (b) shown by the harness's tool-call record to have
// actually read the diff (`diffToolCalls > 0`, the bar retirement.ts applies
// before a dry receipt retires a chunk). A brief-only parrot has `diffToolCalls
// === 0` and is dropped; note that `successfulToolCalls > 0` alone would NOT drop
// it, since reading the brief is a successful call.
//
// Two properties make it safe to land:
//
//  - **Opt-in, inert by default.** Without the `modeled-executable-system`
//    domain (which only a `.qwen/review-context.json` matching rule, read from
//    the trusted base branch, can set) the gate returns nothing. Every ordinary
//    review is untouched.
//  - **Only ever WITHHOLDS an Approve.** It appends to `unreviewedDimensions`,
//    which caps — it never ends the reverse-audit loop, never blocks a Request
//    changes, never touches the convergence rule. This is the safe half of the
//    layer-aware-convergence work, staged ahead of any change to the stop rule
//    itself. The corroboration errs the same way: an auditor that walked a layer
//    but whose diff read we cannot see is dropped, which can only OVER-owe a
//    layer (withhold), never release one.
//
// Fail-open throughout, matching every other transcript reader here: an
// unreadable plan, an invalid context, a missing transcript dir, or zero counted
// auditor returns each yields no cap. A gate that cannot read must not cap a
// verdict on a coverage it could not measure — the reverse-audit-ran floor
// (compose-review) already owns "the auditor never ran".

import { statSync, readFileSync } from 'node:fs';
import { readTranscripts } from './transcripts.js';
import { repositoryContextOf } from './repository-context.js';
import { MODELED_SYSTEM_DOMAIN, owedLayerDimensions } from './audit-layers.js';

/**
 * The launch-prompt IDENTITY line of a reverse-audit auditor. `agent-prompt`
 * builds every role's header as `` You are review agent `<role>` — <label> ``,
 * so this anchors on the reverse auditor's own identity rather than a bare
 * `includes('reverse-audit')` substring. That substring counted any transcript
 * whose prompt merely MENTIONED the role — a verifier inlining reverse-audit
 * findings and quoting their receipt lines, a nested subagent writing the same
 * session dir — and pulled its finalText into the receipt pool. retirement.ts
 * uses the bare substring too, but only as a pre-filter before pairing each
 * transcript to a recorded prompt; this gate has no such second stage, so the
 * selector itself must be the identity line.
 */
export const REVERSE_AUDIT_IDENTITY = 'You are review agent `reverse-audit`';

/**
 * The reverse-audit auditors' final returns for this run — identity-anchored and
 * corroborated by a real diff read. `diffPath` is the plan's `diffPathAbsolute`:
 * `readTranscripts` populates `diffToolCalls` only when it is given the diff
 * path, so without it the corroboration filter would drop every transcript. The
 * run-epoch fence (records older than the plan belong to a previous review of
 * the same PR in the same session) is `readTranscripts`'s own, via `since`.
 */
function readReverseAuditReturns(
  planPath: string,
  env: NodeJS.ProcessEnv,
  diffPath: string | undefined,
): string[] {
  try {
    const since = statSync(planPath).mtimeMs;
    return readTranscripts(since, env, diffPath)
      .filter((t) => t.launchPrompt.includes(REVERSE_AUDIT_IDENTITY))
      .filter((t) => t.diffToolCalls > 0)
      .map((t) => t.finalText ?? '');
  } catch {
    // Fail-open, as this module's header promises — and as every sibling
    // transcript reader in composeReviewBody already does. A missing transcript
    // dir makes readTranscripts throw TranscriptsUnavailableError, an unstat-able
    // plan makes statSync throw, and any other read failure lands here too: each
    // yields no returns, hence no cap. Without this catch the throw propagated out
    // of the gate and took compose down with it on a manifest-marked diff in a
    // transcript-less environment (a sandbox, a read-only HOME, a re-compose on a
    // clean machine) — posting nothing on exactly the security diffs this feature
    // exists for. The reverse-audit-ran floor owns "the auditor never ran".
    return [];
  }
}

/**
 * The `unreviewedDimensions` entries a modeled-system diff owes for defect
 * layers its reverse audit never walked. `readReturns` is injectable so the gate
 * logic — the domain sentinel, the owed computation — is testable without a
 * transcript dir; the default is the real reader above.
 */
export function layerAuditGate(
  planPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  readReturns: (
    planPath: string,
    env: NodeJS.ProcessEnv,
    diffPath: string | undefined,
  ) => string[] = readReverseAuditReturns,
): { unreviewed: string[] } {
  if (!planPath) return { unreviewed: [] };

  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    return { unreviewed: [] };
  }

  let context;
  try {
    context = repositoryContextOf(plan as { repositoryContext?: unknown });
  } catch {
    // An invalid context is the manifest provider's problem, surfaced elsewhere;
    // here it is simply "not a declared modeled system", fail-open.
    return { unreviewed: [] };
  }
  if (context === null || !context.domains.includes(MODELED_SYSTEM_DOMAIN)) {
    return { unreviewed: [] };
  }

  const diffPathValue = (plan as { diffPathAbsolute?: unknown })
    ?.diffPathAbsolute;
  const diffPath =
    typeof diffPathValue === 'string' && diffPathValue.length > 0
      ? diffPathValue
      : undefined;

  const returns = readReturns(planPath, env, diffPath);
  // No counted auditor return is not "every layer owed" — it is "no corroborated
  // reverse auditor ran here", which the reverse-audit-ran floor already caps.
  // Capping every layer on top would double-cap and invent a coverage
  // measurement from an empty transcript set.
  if (returns.length === 0) return { unreviewed: [] };

  return { unreviewed: owedLayerDimensions(returns) };
}
