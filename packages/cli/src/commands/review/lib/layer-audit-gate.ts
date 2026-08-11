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
//    itself.
//
// Fail-open throughout, matching every other transcript reader here: an
// unreadable plan, an invalid context, a missing transcript dir, or zero auditor
// returns each yields no cap. A gate that cannot read must not cap a verdict on
// a coverage it could not measure — the reverse-audit-ran floor (compose-review)
// already owns "the auditor never ran".

import { statSync, readFileSync } from 'node:fs';
import { readTranscripts } from './transcripts.js';
import { repositoryContextOf } from './repository-context.js';
import { MODELED_SYSTEM_DOMAIN, owedLayerDimensions } from './audit-layers.js';

/**
 * The launch-prompt marker that identifies a reverse-audit auditor's transcript
 * — the same string `retirement.ts` filters on (a reverse auditor's prompt names
 * its role). Kept as a local literal rather than an import so this gate does not
 * reach into retirement's internals; both answer to the role name, and a change
 * to it would move both.
 */
const REVERSE_AUDIT_MARKER = 'reverse-audit';

/**
 * The reverse-audit auditors' final returns for this run, newest fence applied.
 * Records older than the plan belong to a previous review of the same PR in the
 * same session (the run-epoch fence every reader here takes); a reverse auditor
 * is identified by its role marker in the launch prompt, exactly as retirement
 * selects them. No `diffPath` is passed — this gate needs the returns, not the
 * diff-given detection, so it does not depend on the plan resolving one.
 */
function readReverseAuditReturns(
  planPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  try {
    const since = statSync(planPath).mtimeMs;
    return readTranscripts(since, env)
      .filter((t) => t.launchPrompt.includes(REVERSE_AUDIT_MARKER))
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

  const returns = readReturns(planPath, env);
  // No auditor return to read is not "every layer owed" — it is "the reverse
  // audit did not run here", which the reverse-audit-ran floor already caps.
  // Capping every layer on top would double-cap and, worse, invent a coverage
  // measurement from an empty transcript set.
  if (returns.length === 0) return { unreviewed: [] };

  return { unreviewed: owedLayerDimensions(returns) };
}
