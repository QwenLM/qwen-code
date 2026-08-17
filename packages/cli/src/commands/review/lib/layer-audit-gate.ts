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
// IDENTITY line, not a free-text mention of the role — and (b) shown by the
// harness's tool-call record to have READ ITS TERRITORY: it made a diff read
// (`diffToolCalls > 0`) AND, when its launch prompt baked specific diff ranges,
// one of those reads overlapped them (`openedTheTerritory`, retirement's full
// bar — `diffToolCalls > 0` alone is range-blind, and an auditor that read a far
// chunk then parroted its receipts would otherwise pass). A whole-diff auditor
// bakes no ranges, so the overlap check passes and the diff-read floor stands.
//
// Two properties make it safe to land:
//
//  - **Opt-in, inert by default.** Without the `modeled-executable-system`
//    domain (which only a `.qwen/review-context.json` matching rule, read from
//    the trusted base branch, can set) the gate returns nothing. Every ordinary
//    review is untouched.
//  - **Only ever WITHHOLDS an Approve.** It appends to `unreviewedDimensions`,
//    which caps — it never ends the reverse-audit loop, never blocks a Request
//    changes, never touches the convergence rule. The corroboration errs the
//    same way: an auditor that walked a layer but whose territory read we cannot
//    see is dropped, which can only OVER-owe a layer (withhold), never release
//    one.
//
// Fail-open only where it cannot MEASURE: an unreadable plan, an invalid context,
// or a transcript read that throws yields no cap (a gate that cannot read must
// not cap a verdict on a coverage it could not measure). But a read that
// SUCCEEDS and finds reverse auditors that ran yet none corroborated is a
// measurement, not a blind spot — and the reverse-audit-ran floor does not cover
// it (compose-review's `deliveryOf` requires a verbatim launch, an opened brief
// and a read findings file, with no diff-read requirement), so this owes every
// layer rather than deferring. Only "no reverse auditor ran at all" defers to the
// floor.

import { statSync, readFileSync } from 'node:fs';
import { readTranscripts } from './transcripts.js';
import { bakedRanges, openedTheTerritory } from './retirement.js';
import {
  repositoryContextOf,
  type RepositoryContext,
} from './repository-context.js';
import { MODELED_SYSTEM_DOMAIN, owedLayerDimensions } from './audit-layers.js';

/**
 * The launch-prompt IDENTITY line of a reverse-audit auditor. `agent-prompt`
 * builds every role's header as `` You are review agent `<role>` — <label> ``,
 * so this anchors on the reverse auditor's own identity rather than a bare
 * `includes('reverse-audit')` substring, which counted any transcript whose
 * prompt merely MENTIONED the role — a verifier inlining reverse-audit findings,
 * a nested subagent writing the same session dir.
 */
export const REVERSE_AUDIT_IDENTITY = 'You are review agent `reverse-audit`';

/** What the reader found: the corroborated auditors' final returns, and how many
 *  identity-matched reverse auditors ran at all (corroborated or not). */
interface AuditorReturns {
  corroborated: string[];
  identityMatched: number;
}

/**
 * The reverse-audit auditors' returns for this run — identity-anchored and
 * corroborated by a territory-overlapping diff read. `diffPath` is the plan's
 * `diffPathAbsolute`: `readTranscripts` populates `diffToolCalls`/`diffReads`
 * only when given it, and `bakedRanges` reads the launch prompt's baked
 * `read_file` ranges against it. The run-epoch fence (records older than the plan
 * belong to a previous review of the same PR) is `readTranscripts`'s own.
 */
function readReverseAuditReturns(
  planPath: string,
  env: NodeJS.ProcessEnv,
  diffPath: string | undefined,
): AuditorReturns {
  try {
    const since = statSync(planPath).mtimeMs;
    const auditors = readTranscripts(since, env, diffPath).filter((t) =>
      t.launchPrompt.includes(REVERSE_AUDIT_IDENTITY),
    );
    const corroborated = auditors
      .filter(
        (t) =>
          t.diffToolCalls > 0 &&
          openedTheTerritory(
            t.diffReads,
            bakedRanges(t.launchPrompt, diffPath),
          ),
      )
      .map((t) => t.finalText ?? '');
    return { corroborated, identityMatched: auditors.length };
  } catch {
    // Could not MEASURE — a missing transcript dir (readTranscripts throws
    // TranscriptsUnavailableError), an unstat-able plan, any read failure. Yield
    // nothing and no cap: without this the throw took compose down on a
    // manifest-marked diff in a transcript-less environment (a sandbox, a
    // read-only HOME, a re-compose on a clean machine). The reverse-audit-ran
    // floor owns "the auditor never ran".
    return { corroborated: [], identityMatched: 0 };
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
  ) => AuditorReturns = readReverseAuditReturns,
): { unreviewed: string[] } {
  if (!planPath) return { unreviewed: [] };

  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    return { unreviewed: [] };
  }

  // Typed, not inferred: the annotation pins the declared type regardless of how
  // the assignment's control flow is later restructured (or if
  // `repositoryContextOf` starts returning `any`), so `context.domains` stays
  // checked against `RepositoryContext` at compile time. (An evolving `let`
  // already narrows to the return type today, so this is belt-and-braces, not the
  // sole guard.)
  let context: RepositoryContext | null;
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

  // Corroboration needs the diff path: `readTranscripts` populates
  // `diffToolCalls`/`diffReads` only when given it, so a plan WITHOUT
  // `diffPathAbsolute` fails every auditor's corroboration and owes all six
  // layers. That is fail-safe (over-caps, never releases), and the gate arms only
  // on a manifest read from a pr-worktree base where the path is present — but the
  // dependency is real, not incidental: a plan shape that dropped it would defeat
  // corroboration silently, so it is stated here.
  const diffPathValue = (plan as { diffPathAbsolute?: unknown })
    ?.diffPathAbsolute;
  const diffPath =
    typeof diffPathValue === 'string' && diffPathValue.length > 0
      ? diffPathValue
      : undefined;

  const { corroborated, identityMatched } = readReturns(
    planPath,
    env,
    diffPath,
  );
  if (corroborated.length > 0) {
    return { unreviewed: owedLayerDimensions(corroborated) };
  }
  // No corroborated auditor. If identity-matched auditors ran but none read their
  // territory, the reverse-audit-ran floor does NOT cap it (no diff-read
  // requirement), so owe every layer — `owedLayerDimensions([])` is all of them.
  // If no reverse auditor ran at all (or the read threw), the floor owns it.
  if (identityMatched > 0) {
    return { unreviewed: owedLayerDimensions([]) };
  }
  return { unreviewed: [] };
}
