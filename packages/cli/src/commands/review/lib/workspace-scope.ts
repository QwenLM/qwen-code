/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which test suites a diff obliges a review to run — and when scoping must not
// be trusted at all.
//
// `build-test` scopes its BUILD to the diff (see `workspaces.ts`), and for a
// while it tested only the workspaces the diff changed. That under-tests in
// exactly the way a compile cannot catch: a behaviour change in `core` leaves
// every dependent compiling and still fails their suites — the break surfaces
// in a consumer's tests or nowhere. So the test scope is the reverse-dependency
// closure of the diff: the changed workspaces plus everything that depends on
// them, computed from the same declared graph the build set uses.
//
// The decision fails OPEN. Scoping is an optimisation over the full suite, and
// every input that would make the scoped set unsound falls back to full — with
// the reason recorded, because a fallback the report does not disclose is a
// claim ("these tests were run") the review cannot honestly make:
//
//   - A changed file OUTSIDE every workspace can affect any package: the test
//     scripts themselves live in the root `package.json`, and `scripts/` is
//     imported by whatever chooses to. No per-workspace subset covers that.
//     Inert prose is the one carve-out — a README or LICENSE edit cannot fail
//     a suite, and treating it as influential would spend a full-suite run
//     (minutes, on a large monorepo) measuring nothing. What counts as prose
//     is the plan pipeline's own docs classifier, not a second definition.
//   - A workspace whose `package.json` does not parse is invisible to the
//     dependency graph, so its reverse edges are missing and the closure may be
//     silently too small — the confident false green this pipeline exists to
//     prevent.
//   - A closure past HALF the workspaces is not a meaningful narrowing: at that
//     size the repo's own full-suite command (one process, its own parallelism)
//     beats a majority of serial per-workspace runs, and the disclosure "the
//     full suite ran" is simpler to trust than a near-total subset.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPath } from './diff-plan.js';
import {
  affectedWorkspaces,
  reverseDependencyClosure,
  workspaceDirCandidates,
  workspaceDirFor,
  type WorkspacePackage,
} from './workspaces.js';

/**
 * What the test phase ran, for the report. `workspaces` means a strict subset
 * chosen from the diff; `full` means the whole suite — either because scoping
 * did not apply or because it fell back, and `reason` says which.
 */
export interface TestScope {
  mode: 'workspaces' | 'full';
  /** In `workspaces` mode: the dirs whose suites the run executes. */
  workspaces?: string[];
  /** Why the mode was forced, when it was — rendered into the agent's report. */
  reason?: string;
}

/**
 * License-family files, which carry no extension the docs classifier could key
 * on (`LICENSE`, `COPYING`, `NOTICE`, and suffixed variants like `LICENSE-MIT`
 * or a generated `NOTICES.txt`). The optional text extension is deliberate:
 * `LICENSE.js` must NOT match — a name is only inert when nothing executes it.
 */
const LICENSE_LIKE_RE =
  /(^|\/)(LICENSE|LICENCE|COPYING|NOTICES?)(-[^/.]+)?(\.(md|txt|rst))?$/;

/**
 * Is this changed file inert prose — unable to fail any test suite?
 *
 * Consulted only for files OUTSIDE every workspace, where the alternative is a
 * full-suite fallback: a README edit that triggers the whole suite spends the
 * command budget measuring nothing, which is the very waste scoping exists to
 * remove. "Prose" is the plan pipeline's own docs classifier (`classifyPath`),
 * not a second definition that could drift from it — so markdown outside the
 * documentation directories and the repo root stays influential (the
 * classifier's judgment: markdown in a source tree can be executable
 * behaviour), which errs toward running MORE tests, the safe direction.
 */
export function isInertProse(path: string): boolean {
  return classifyPath(path) === 'docs' || LICENSE_LIKE_RE.test(path);
}

/**
 * Workspace dirs whose `package.json` exists but cannot be parsed.
 *
 * `readWorkspacePackages` skips these silently — the right call for the build
 * set, where an unbuildable manifest has nothing to build — but the test scope
 * must not: a package the graph cannot see contributes no reverse edges, so a
 * closure computed without it may omit a real dependent. The caller treats a
 * non-empty result as "the graph cannot be computed" and falls back to full.
 */
export function unparseableWorkspaceManifests(
  root: string,
  globs: string[],
): string[] {
  const broken: string[] = [];
  for (const dir of workspaceDirCandidates(root, globs)) {
    // A dir a negation excludes is not a workspace; its manifest is not ours to
    // judge. A dir with no manifest at all is not a workspace either (npm skips
    // it), so neither can hide an edge.
    if (workspaceDirFor(`${dir}/package.json`, globs) !== dir) continue;
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      broken.push(dir);
    }
  }
  return broken;
}

/**
 * Decide the test scope for a workspace monorepo. Pure given its inputs; the
 * fallback checks run in trust order — a graph that cannot be computed makes
 * the later, graph-derived answers meaningless.
 */
export function resolveTestScope(input: {
  changed: string[];
  globs: string[];
  packages: WorkspacePackage[];
  /** From `unparseableWorkspaceManifests` — dirs the graph cannot see. */
  unparseable: string[];
}): TestScope {
  const { changed, globs, packages, unparseable } = input;

  if (unparseable.length > 0) {
    return {
      mode: 'full',
      reason:
        `the workspace graph could not be computed: ${unparseable.join(', ')} ` +
        `${unparseable.length === 1 ? 'has' : 'have'} an unparseable ` +
        'package.json, so a reverse dependency may be missing from any scoped set',
    };
  }

  // Only INFLUENTIAL outside files force the full suite. Inert prose (docs,
  // license files) neither forces it nor widens a scoped set — a diff of
  // README plus one workspace stays scoped to that workspace, and a diff of
  // prose alone obliges no test at all.
  const outside = changed.filter((f) => workspaceDirFor(f, globs) === null);
  const influential = outside.filter((f) => !isInertProse(f));
  if (influential.length > 0) {
    return {
      mode: 'full',
      reason:
        `${influential.length} changed file(s) sit outside every workspace ` +
        `and are not inert docs (e.g. ${influential.slice(0, 3).join(', ')}); ` +
        "a root script or config can affect any package's tests, so no " +
        'per-workspace subset covers them',
    };
  }

  const affected = affectedWorkspaces(changed, globs);
  const closure = reverseDependencyClosure(affected, packages);
  if (closure.length * 2 > packages.length) {
    return {
      mode: 'full',
      reason:
        `the diff's reverse-dependency closure covers ${closure.length} of ` +
        `${packages.length} workspaces — more than half, so a scoped run would ` +
        'not be meaningfully narrower than the full suite',
    };
  }

  return { mode: 'workspaces', workspaces: closure };
}
