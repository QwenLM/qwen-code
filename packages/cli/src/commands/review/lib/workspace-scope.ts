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
// Every input that makes the scoped set possibly incomplete is DISCLOSED as a
// `caveat` on the scope — a fallback the report does not disclose is a claim
// ("these tests were run") the review cannot honestly make. Every caveat that
// applies is reported, strongest first: "nothing is silent" means composing
// the disclosures, not letting the first one hide the rest:
//
//   - A workspace whose `package.json` does not parse (or has no usable `name`)
//     is invisible to the dependency graph, so its reverse edges are missing
//     and the closure may be silently too small — the confident false green
//     this pipeline exists to prevent. The same holds for a member a glob
//     ORDERING hides from the graph (a literal entry listed before a `*` that
//     claims its parent segment): npm includes it, the walker cannot.
//   - A changed file OUTSIDE every workspace can affect any package: the test
//     scripts themselves live in the root `package.json`, and `scripts/` is
//     imported by whatever chooses to. No per-workspace subset covers that.
//     The one carve-out is the license family — a LICENSE edit cannot fail a
//     suite. Docs-classified files are NOT carved out: this repo's own root
//     AGENTS.md is read and asserted on by packages/cli's load-rules.test.ts,
//     which is exactly the load-bearing prose the carve-out would certify as
//     unable to fail anything. The root `docs/` tree IS carved out — no suite
//     here reads it, and a caveat that fires on most PRs teaches the reader to
//     ignore caveats. When the cost of erring is a sentence of
//     disclosure, not a full-suite run, err toward disclosing.
//   - A closure past HALF the testable workspaces is not a meaningful
//     narrowing, and the report should say so.
//   - A root suite that fans out over every workspace (`npm test
//     --workspaces`) cannot run as one scoped command — it would repeat the
//     whole suite inside a single deadline — so it does not run, and that is
//     disclosed the same way.
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
  /**
   * The dirs whose suites the run executes — exactly those with a test
   * script, in scope (alphabetical) order, NOT run order. The run itself
   * goes affected-first; the report's `test[]` array records that order.
   */
  workspaces: string[];
  /**
   * Suites the whole-call budget stopped before they ran, when that happened.
   * Structural, not just prose: `workspaces` names what ran, `notRun` names
   * what the budget trimmed — a report must never list a suite as run that
   * was not.
   */
  notRun?: string[];
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
 * Outside files no workspace suite reads, however central they are to the
 * repo's OTHER machinery: CI definitions (`.github/` — the workflow tests
 * live outside the npm workspaces and are not run here either), the
 * changelog, and editor/VCS dotfiles. Measured over 120 recent commits,
 * naming these in the caveat would fire on ~2 of 5 diffs — a caveat that
 * fires on most PRs teaches the reader to skim past caveats.
 */
const INERT_OUTSIDE_RE =
  /^(\.github\/|CHANGELOG\.md$|\.gitignore$|\.gitattributes$|\.editorconfig$|\.idea\/|\.vscode\/)/;

/**
 * Decide the test scope for a workspace monorepo. Pure given its inputs; the
 * caveats are DISCLOSED in trust order — every one that applies, strongest
 * first, because "nothing is silent" means composing the disclosures, not
 * letting the first one hide the rest.
 */
export function resolveTestScope(input: {
  changed: string[];
  globs: string[];
  packages: WorkspacePackage[];
  /** From `readWorkspacePackages` — dirs the graph cannot see. */
  skipped: string[];
  /**
   * The root package as a graph node, whenever the root manifest is a package
   * with a build or test script. Its declared dependencies are reverse edges
   * the closure cannot do without — a root that depends on a changed
   * workspace is a dependent like any other, and a dependent reached THROUGH
   * the root's name is dropped when the root is absent. Whether the root's
   * own scripts RUN is decided separately (a build-only root joins the graph
   * but no test list; a fan-out root test joins neither — see below).
   */
  rootPackage?: WorkspacePackage | null;
  /**
   * True when the root's `test` script fans out over every workspace
   * (`npm test --workspaces …`). Such a suite cannot run as one scoped
   * command — it would repeat the ENTIRE suite inside a single command
   * deadline, the fallback this module exists to refuse — so the root is
   * dropped from the executed set and the non-run is disclosed as a caveat.
   */
  rootTestFansOut?: boolean;
}): TestScope {
  const { changed, globs, packages, skipped } = input;

  const affected = affectedWorkspaces(changed, globs);
  // The root goes FIRST: on a name collision a member must win — this very
  // repo's root and packages/cli share the name `@qwen-code/qwen-code`, and
  // last-write-wins would resolve a dependent of the CLI package to the root,
  // silently dropping the member's dependents from the closure.
  const graph = input.rootPackage ? [input.rootPackage, ...packages] : packages;
  const scriptsOf = new Map(graph.map((p) => [p.dir, p.scripts]));

  // Every caveat that applies is disclosed, strongest first. The graph
  // caveat leads: a graph that cannot be computed makes the later,
  // graph-derived answers the least of the report's worries.
  const caveats: string[] = [];
  if (skipped.length > 0) {
    caveats.push(
      `the workspace graph could not be fully computed: ${skipped.join(', ')} ` +
        `${skipped.length === 1 ? 'has' : 'have'} a package.json that does not ` +
        'parse, has no usable `name`, or is shadowed by a later workspace glob, ' +
        'so a reverse dependency may be missing from the scoped set',
    );
  }
  // A dir a positive glob claims but no manifest populates hosts no suite
  // the scoped set can run, and its reverse edges are invisible to the
  // closure — an empty scoped set there must not read as a complete answer.
  // (build-test's unmapped guard reaches the same conclusion; the scope
  // discloses it itself so the invariant does not rest on one call site.)
  const unmapped = affected.filter(
    (d) => d !== '.' && !scriptsOf.has(d) && !skipped.includes(d),
  );
  // Files a negation excludes (!packages/desktop — a separate toolchain with
  // its own lockfile) cannot affect any included workspace's tests, so they
  // earn no incomplete-scope caveat — but their own suites were not run
  // either, and "nothing is silent" covers that too: disclose it as the
  // softest line, not as an incompleteness. Nor does the root `docs/` tree
  // (no suite here reads it) or the CI/changelog/dotfile family. Root-LEVEL
  // prose (AGENTS.md) stays influential — this repo's load-rules.test.ts
  // asserts on it.
  const outside = changed.filter((f) => workspaceDirFor(f, globs) === null);
  const excluded = outside.filter((f) => isNegationExcluded(f, globs));
  const influential = outside.filter(
    (f) =>
      !isInertLicense(f) &&
      !f.startsWith('docs/') &&
      !INERT_OUTSIDE_RE.test(f) &&
      !isNegationExcluded(f, globs),
  );
  if (unmapped.length > 0) {
    caveats.push(
      `the workspace globs claim ${unmapped.join(', ')}, but no readable ` +
        'package.json there makes a graph member — no suite covers a change ' +
        'inside, and a dependent of the diff may be missing from the scoped set',
    );
  }
  if (influential.length > 0) {
    caveats.push(
      `${influential.length} changed file(s) sit outside every workspace ` +
        `and are not inert (e.g. ${influential.slice(0, 3).join(', ')}); a ` +
        "root script or config can affect any package's tests, and the " +
        'scoped set cannot cover them',
    );
  }
  if (excluded.length > 0) {
    caveats.push(
      `${excluded.length} changed file(s) sit in negated workspaces (e.g. ` +
        `${excluded.slice(0, 3).join(', ')}) — excluded from the npm ` +
        'workspace graph (a separate toolchain and lockfile); their own ' +
        "toolchain's suites were not run",
    );
  }

  const closure = reverseDependencyClosure(affected, graph);
  // Exactly the suites the run executes: the closure, minus members that
  // define no test script — naming those would claim coverage nothing can run.
  let workspaces = closure.filter((d) => scriptsOf.get(d)?.includes('test'));

  // A root suite that fans out over every workspace (`npm test --workspaces`)
  // is one command that repeats the ENTIRE suite — the run that cannot finish
  // inside a command deadline, which this module exists to refuse. The root
  // stays in the graph (its edges matter) but leaves the executed set, and
  // the non-run is disclosed rather than dressed up as coverage.
  let fanOutCaveat: string | undefined;
  if (input.rootTestFansOut && workspaces.includes('.')) {
    workspaces = workspaces.filter((d) => d !== '.');
    fanOutCaveat =
      "the root's `test` script fans out over every workspace " +
      '(`--workspaces`), so the root suite did not run — it cannot finish ' +
      'inside one command deadline; the scoped member suites are the coverage';
  }

  // Testable-to-testable: a closure past half the suites that CAN run is not a
  // meaningful narrowing, and counting script-less members would overstate it.
  // The root suite counts on BOTH sides when it participates — with a running
  // root the executed set is larger than workspace-only arithmetic models. A
  // build-only root has no suite to count; a fan-out root cannot run.
  {
    const rootRuns =
      input.rootPackage?.scripts.includes('test') && !input.rootTestFansOut
        ? 1
        : 0;
    const testable =
      packages.filter((p) => p.scripts.includes('test')).length + rootRuns;
    const scoped = workspaces.length;
    if (scoped * 2 > testable) {
      caveats.push(
        `the diff's reverse-dependency closure covers ${scoped} of ` +
          `${testable} testable ${
            rootRuns ? 'suites (including the root)' : 'workspaces'
          } — more than half, so the scoped set is not a meaningful narrowing`,
      );
    }
  }
  if (fanOutCaveat) caveats.push(fanOutCaveat);

  return caveats.length > 0
    ? { workspaces, caveat: caveats.join('; ') }
    : { workspaces };
}
