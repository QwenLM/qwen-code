/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which test suites a diff obliges a review to run — and when the answer must
// carry a caveat.
//
// `build-test` scopes its BUILD to the diff (see `workspaces.ts`), and for a
// while it tested only the workspaces the diff changed. That under-tests in
// exactly the way a compile cannot catch: a behaviour change in `core` leaves
// every dependent compiling and still fails their suites — the break surfaces
// in a consumer's tests or nowhere. So the test scope is the reverse-dependency
// closure of the diff: the changed workspaces plus everything that depends on
// them, computed from the same declared graph the build set uses.
//
// Every input that makes the scoped set possibly incomplete is DISCLOSED, in
// trust order, as a `caveat` on the scope — a fallback the report does not
// disclose is a claim ("these tests were run") the review cannot honestly make:
//
//   - A workspace whose `package.json` does not parse (or has no usable `name`)
//     is invisible to the dependency graph, so its reverse edges are missing
//     and the closure may be silently too small — the confident false green
//     this pipeline exists to prevent.
//   - A changed file OUTSIDE every workspace can affect any package: the test
//     scripts themselves live in the root `package.json`, and `scripts/` is
//     imported by whatever chooses to. No per-workspace subset covers that.
//     The one carve-out is the license family — a LICENSE edit cannot fail a
//     suite. Docs-classified files are NOT carved out: this repo's own root
//     AGENTS.md is read and asserted on by packages/cli's load-rules.test.ts,
//     which is exactly the load-bearing prose the carve-out would certify as
//     unable to fail anything. When the cost of erring is a sentence of
//     disclosure, not a full-suite run, err toward disclosing.
//   - A closure past HALF the testable workspaces is not a meaningful
//     narrowing, and the report should say so.
//
// None of these fall back to the repo's root test command. That command — one
// `npm test` over every workspace — is exactly what cannot finish inside a
// command deadline on a large monorepo: this repo's suite took 31 minutes in
// CI against a 300-second deadline, and measured over recent PRs a third of
// diffs would have hit the fallback. A fallback that reliably times out is not
// coverage — it is zero signal framed as a failure. The scoped set is the run
// that can finish; the caveat says what it might miss.

import {
  affectedWorkspaces,
  isNegationExcluded,
  reverseDependencyClosure,
  workspaceDirFor,
  type WorkspacePackage,
} from './workspaces.js';

/**
 * What the test phase covers, for the report. The scoped set is what runs —
 * there is no full-suite mode (see the module comment for why).
 */
export interface TestScope {
  /** The dirs whose suites the run executes — exactly those with a test script. */
  workspaces: string[];
  /**
   * Present when the scoped set may be incomplete — rendered verbatim into the
   * report so the review can state what it does not cover. Absent means the
   * run covers everything the diff can break, as far as the graph can see.
   */
  caveat?: string;
}

/**
 * License-family files, which carry no extension the docs classifier could key
 * on (`LICENSE`, `COPYING`, `NOTICE`, and suffixed variants like `LICENSE-MIT`
 * or a generated `NOTICES.txt`). The optional text extension is deliberate:
 * `LICENSE.js` must NOT match — a name is only inert when nothing executes it.
 */
const LICENSE_LIKE_RE =
  /(^|\/)(LICEN[CS]ES?|COPYING|NOTICES?)(-[^/.]+)?(\.(md|txt|rst))?$/;

/**
 * Is this changed file inert — unable to fail any test suite?
 *
 * Consulted only for files OUTSIDE every workspace, to decide whether they
 * deserve the incomplete-scope caveat: a LICENSE edit cannot fail a suite, so
 * it neither widens the run nor earns a disclosure. Everything else outside
 * the workspaces is caveat-worthy — including docs-classified prose, which is
 * load-bearing in this very repo (root AGENTS.md is asserted on by
 * packages/cli's load-rules.test.ts).
 */
export function isInertLicense(path: string): boolean {
  return LICENSE_LIKE_RE.test(path);
}

/**
 * Decide the test scope for a workspace monorepo. Pure given its inputs; the
 * caveat checks run in trust order — a graph that cannot be computed makes the
 * later, graph-derived answers the least of the report's worries.
 */
export function resolveTestScope(input: {
  changed: string[];
  globs: string[];
  packages: WorkspacePackage[];
  /** From `readWorkspacePackages` — dirs the graph cannot see. */
  skipped: string[];
  /**
   * The root package when it defines a test script. A root suite that declares
   * a dependency on a changed workspace is a dependent like any other — the
   * closure must see it, or it silently never runs while the report claims
   * every dependent was covered.
   */
  rootPackage?: WorkspacePackage | null;
}): TestScope {
  const { changed, globs, packages, skipped } = input;

  let caveat: string | undefined;
  if (skipped.length > 0) {
    caveat =
      `the workspace graph could not be fully computed: ${skipped.join(', ')} ` +
      `${skipped.length === 1 ? 'has' : 'have'} a package.json that does not ` +
      'parse or has no usable `name`, so a reverse dependency may be missing ' +
      'from the scoped set';
  } else {
    // Files a negation excludes (!packages/desktop — a separate toolchain with
    // its own lockfile) cannot affect any included workspace's tests, so they
    // earn no caveat either.
    const outside = changed.filter((f) => workspaceDirFor(f, globs) === null);
    const influential = outside.filter(
      (f) => !isInertLicense(f) && !isNegationExcluded(f, globs),
    );
    if (influential.length > 0) {
      caveat =
        `${influential.length} changed file(s) sit outside every workspace and ` +
        `are not inert (e.g. ${influential.slice(0, 3).join(', ')}); a root ` +
        "script or config can affect any package's tests, and the scoped set " +
        'cannot cover them';
    }
  }

  const affected = affectedWorkspaces(changed, globs);
  const graph = input.rootPackage ? [...packages, input.rootPackage] : packages;
  const closure = reverseDependencyClosure(affected, graph);
  // Exactly the suites the run executes: the closure, minus members that
  // define no test script — naming those would claim coverage nothing can run.
  const scriptsOf = new Map(graph.map((p) => [p.dir, p.scripts]));
  const workspaces = closure.filter((d) => scriptsOf.get(d)?.includes('test'));

  // Testable-to-testable: a closure past half the suites that CAN run is not a
  // meaningful narrowing, and counting script-less members would overstate it.
  if (!caveat) {
    const testable = packages.filter((p) => p.scripts.includes('test')).length;
    const scoped = workspaces.filter((d) => d !== '.').length;
    if (scoped * 2 > testable) {
      caveat =
        `the diff's reverse-dependency closure covers ${scoped} of ` +
        `${testable} testable workspaces — more than half, so the scoped set ` +
        'is not a meaningful narrowing of the suite';
    }
  }

  return caveat ? { workspaces, caveat } : { workspaces };
}
