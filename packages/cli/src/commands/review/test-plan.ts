/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review test-plan`: rule on the claims the PR author already wrote down.
//
// A Test Plan is the one place in a pull request where the author states, in
// their own words, what they ran and what they saw — a list of falsifiable
// assertions, handed to the reviewer for free. Nothing in this pipeline read it.
// `pr-context` renders the PR body, but its consumer is Agent 0, whose question
// is root-cause fidelity ("is this the right fix for the linked issue?"), not
// "the author says 471 tests pass — do they?". So a Test Plan could name a file
// the diff never adds, invoke an npm script that does not exist, or report a
// count from three commits ago, and the review would approve around it.
//
// The split is this file's whole design, and it is the one this skill keeps
// arriving at: **determinism owns the evidence, judgment owns the ruling** — but
// only for the claims where determinism can actually own it. Two kinds can be
// settled here with no model and no false positives:
//
//   - **A path that is not there.** "Added `packages/core/src/foo.test.ts`" is
//     checkable against the reviewed tree. Absent from the diff AND absent from
//     the worktree means the sentence describes a commit that is not this one.
//   - **An npm script that does not exist.** "Run `npm run test:unit`" is
//     checkable against the workspace manifests. If no package defines it, the
//     reviewer cannot reproduce the Test Plan by following it.
//
// A third kind — **a test count** — is the one that motivated this command and
// is deliberately NOT ruled as a contradiction. A count is only falsifiable
// against the suite the author meant, and a Test Plan almost never says which
// one; `build-test` runs the workspaces the diff touches plus the workspaces
// that depend on them, which is frequently a different set. Ruling
// "471 ≠ 472, contradiction" off that mismatch would file a defect on
// arithmetic the command cannot do, and this skill's one design philosophy is
// that a wrong comment costs more than a missing one. So a count claim is
// reported as `differs`: both numbers, side by
// side, framed as claimed-vs-observed. That is what the finding was worth in the
// first place — a note to the author, never a blocker.
//
// Everything else is `unchecked` and says so. An unchecked claim does not cap
// the verdict: capping every PR whose Test Plan contains a prose sentence would
// make them un-Approvable forever, and "write fewer sentences" is not a fix the
// author can apply. It is the same disclosed-but-not-capping treatment
// `script-lint` gives a deferred checker, for the same reason.

import type { CommandModule } from 'yargs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { gh, setGhHost } from './lib/gh.js';
import { git } from './lib/git.js';
import { diffHashOf } from './script-lint.js';
import {
  hasUnmodeledWorkspaceGlob,
  readWorkspaceGlobs,
  readWorkspacePackages,
} from './lib/workspaces.js';
import type { BuildTestReport, CommandResult } from './build-test.js';
import { isSourceFailureLine } from './lib/maven-toolchain.js';
import type { FileMetric } from './lib/report.js';

/** What kind of assertion a claim is, which decides how it can be ruled. */
export type ClaimKind = 'path' | 'command' | 'count';

export type ClaimVerdict =
  /** Checked, and the tree agrees. */
  | 'reproduces'
  /** Checked, and the tree disagrees. Sound: a real defect in the Test Plan. */
  | 'contradicted'
  /**
   * Checked against something adjacent, and the numbers are not equal. NOT a
   * contradiction — see the header: the claim and the observation may be about
   * different suites, and this command cannot tell. Reported, never blocking.
   */
  | 'differs'
  /** Nothing here can settle it. Disclosed as scope, never capping. */
  | 'unchecked';

export interface TestPlanClaim {
  kind: ClaimKind;
  /** The claim as the author wrote it, for quoting back. */
  text: string;
  verdict: ClaimVerdict;
  /** What this command observed, when it observed anything. */
  observed?: string;
  /** One line: why the verdict is what it is. Rendered to the reader verbatim. */
  note?: string;
}

export interface TestPlanReport {
  /** False when the PR body has no Test Plan section — not a finding. */
  found: boolean;
  /** The heading the section was found under, verbatim. */
  heading?: string;
  claims: TestPlanClaim[];
  /**
   * Hash of the diff this ran against. `compose-review` re-hashes the plan's
   * current diff and refuses a report that does not match, exactly as it does
   * for `script-lint` — a report from an earlier commit is not this review's.
   */
  diffHash?: string;
  /** Why the run did what it did, in one line. */
  note: string;
}

/**
 * What a Test Plan calls itself. English and Chinese both, because this repo's
 * PRs use either, and a section this command cannot find is a section it
 * silently declines to check.
 *
 * Matched anywhere in the heading TEXT, not anchored to its start. This repo's
 * own PR template writes `## Reviewer Test Plan` / `## Reviewer 测试计划`, and an
 * anchored pattern found neither — the command returned "no Test Plan section"
 * on the very PRs it was built for, which is indistinguishable from an author
 * who wrote none. Other templates prefix with `Manual`, `QA`, `How I`.
 */
const PLAN_NAME_RE =
  /(test\s*plan|\btesting\b|how\s+(?:has\s+this|to)\s+(?:been\s+)?test(?:ed)?|测试计划|测试方案|测试步骤)/i;

/**
 * A `#`-style heading: the level, and everything after it (trimmed at the use
 * sites). Zero backtracking by construction — `\s*(\S.*?)\s*$` here was the
 * same quadratic shape the bold pattern below was rewritten to remove, on the
 * same untrusted line.
 */
// `#` must be followed by whitespace or end-of-line (the ATX rule GitHub
// applies): `#tag`, `#!/bin/bash` outside a fence, `#8176` are prose, and a
// spaceless line once ended the Test Plan section mid-body.
const HEADING_LINE_RE = /^(#{1,6})(?:[ \t](.*))?$/;

/** A standalone bold line: `**Test Plan**`, the same heading in another shape. */
// No `\s*` on either side of the capture and no lazy quantifier: with all
// three able to match a space, a line opening `**` that never closes made the
// engine walk every split of a whitespace run — measured 3.2s at 3,000 spaces,
// unbounded at GitHub's 65,536-char body cap, on a line an untrusted PR body
// controls. The capture is trimmed at the use site instead.
const BOLD_LINE_RE = /^\*\*([^*\n]+)\*\*:?\s*$/;

/**
 * Pull the Test Plan section out of a PR body.
 *
 * Ends at the next heading of the SAME OR HIGHER level (`###` closes on `###`
 * and on `##`, not on `####`), so a Test Plan with sub-headings keeps them. The
 * bold form ends at the next heading of any level or the next standalone bold
 * line, which is as much structure as that form carries.
 */
export function extractTestPlanSection(
  body: string,
): { heading: string; content: string } | null {
  const lines = body.split(/\r?\n/);
  // A `#` inside a fenced block is not a heading — it is a shell comment or a
  // shebang, and a Test Plan's repro steps are full of both. Scanning without
  // this ends the section at the first `#!/usr/bin/env bash` and reports a Test
  // Plan that stops one line into its own repro.
  const fenced = new Array<boolean>(lines.length).fill(false);
  let fenceMarker: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(```|~~~)/.exec(lines[i]);
    if (m) {
      fenced[i] = true;
      if (!fenceMarker) fenceMarker = m[1];
      else if (m[1] === fenceMarker) fenceMarker = null;
      continue;
    }
    fenced[i] = fenceMarker !== null;
  }

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const hash = HEADING_LINE_RE.exec(lines[i]);
    const bold = BOLD_LINE_RE.exec(lines[i]);
    const name = (hash?.[2] ?? bold?.[1])?.trim();
    if (!name || !PLAN_NAME_RE.test(name)) continue;
    // The bold form has no level, so nothing deeper can nest under it; `Infinity`
    // makes every `#` heading close it, which is the only sound reading.
    const level = hash ? hash[1].length : Infinity;
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!fenced[j]) {
        const next = HEADING_LINE_RE.exec(lines[j]);
        // A bare `#` run with no text is not a heading (the old `\s*\S` bar).
        if (next && !next[2]?.trim()) {
          out.push(lines[j]);
          continue;
        }
        if (next && next[1].length <= level) break;
        if (!hash && (next || BOLD_LINE_RE.test(lines[j]))) break;
      }
      out.push(lines[j]);
    }
    return { heading: lines[i].trim(), content: out.join('\n').trim() };
  }
  return null;
}

// `mvn.cmd` is the spelling Windows `cmd.exe` users type for system Maven.
// The relative wrapper spellings — `./mvnw`, `.\mvnw`, and ANY number of
// `../` / `..\` hops (`../../mvnw` is a normal nested-module invocation two
// levels deep) — are command claims exactly like the bare runner; without
// the deeper hops such claims are silently never extracted and never ruled.
// They are modeled for the WHOLE runner vocabulary, not `mvnw` alone:
// `./mvnd test` is a command claim exactly like `./mvnw test`.
const MAVEN_RUNNER_SOURCE =
  'mvn(?:\\.cmd)?|mvnd|mvnDebug|mvnw(?:\\.cmd)?' +
  '|(?:\\.\\.[/\\\\])*\\.[/\\\\](?:mvnw(?:\\.cmd)?|mvnd|mvnDebug)' +
  '|(?:\\.\\.[/\\\\])+(?:mvnw(?:\\.cmd)?|mvnd|mvnDebug)';

/** Runners whose presence makes a backticked span a command, not prose. */
const RUNNER_RE = new RegExp(
  '^(?:npm|npx|yarn|pnpm|bun|make|node|go|cargo|python3?|pytest)\\b' +
    `|^(?:${MAVEN_RUNNER_SOURCE})(?=\\s|$)`,
);

const MAVEN_RUNNER_RE = new RegExp(`^(?:${MAVEN_RUNNER_SOURCE})(?=\\s|$)`);

/** `foo/bar.ts`, `packages/cli/src/x.tsx:42` — a path, not a sentence. */
const PATH_RE = /^[\w.@-]+(?:\/[\w.@-]+)+\/?(?::\d+(?::\d+)?)?$/;

/**
 * Counts, in the shapes test runners and humans actually print them.
 *
 * Deliberately anchored on a test word next to the number. A bare `(42)` in a
 * Test Plan is far more often a PR reference or a line number than a count, and
 * a wrong count claim produces a `differs` note nobody asked for.
 */
const COUNT_RES = [
  // A Test Plan states its count in the future tense as often as the past:
  // "expect all four files and 471 tests **to pass**". Dropping the modal was
  // measured against this repo's own PR #8176, where the exact claim this
  // command exists to check went unextracted.
  /\b(\d+)\s+(?:tests?|specs?|assertions?)\s+(?:(?:to|should|will|would|must)\s+)?(?:pass(?:ed|ing|es)?|green|ok)\b/gi,
  /\btests?:?\s+(\d+)\s+pass(?:ed|ing)?\b/gi,
  /\b(\d+)\s+pass(?:ed|ing)\b/gi,
];

/**
 * Labels after which every number on the line counts FILES, not tests.
 *
 * `Test Files  45 passed (45)` filing its 45 as a differing TEST count was
 * measured on this command's own PR body. The first fix was a lookbehind on
 * the bare-count pattern, which only ever rejected the all-green shape: the
 * moment any file fails the runner prints `Test Files  1 failed | 44 passed`,
 * and the label is no longer adjacent to the number. That mixed shape is the
 * COMMON one — a summary gets pasted into a Test Plan precisely when there is
 * something to show — so the narrow fix left the false note in place for the
 * case that produces it. Masking the rest of the line is label-distance
 * independent, and covers jest's `Test Suites: 1 failed, 44 passed, 45 total`
 * for free.
 *
 * Both runner labels carry the `Test` word, and the pattern requires it: a
 * bare `files` is ordinary prose, and blanking its line ate the future-tense
 * claim in "expect all four files and 471 tests to pass" — an existing test
 * caught it. A rule that silences claims is worth exactly as much as its
 * narrowness.
 */
const FILE_COUNT_LABEL_RE = /\btest\s+(?:files|suites)\b/gi;

/**
 * Blank out file-count segments, preserving length so match offsets still
 * index into the original section.
 */
function maskFileCounts(section: string): string {
  let out = '';
  let cursor = 0;
  FILE_COUNT_LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_COUNT_LABEL_RE.exec(section))) {
    const eol = section.indexOf('\n', m.index);
    const stop = eol === -1 ? section.length : eol;
    out += section.slice(cursor, m.index) + ' '.repeat(stop - m.index);
    cursor = stop;
    // Resume past the blanked run: the label matches again inside it
    // (`Test Files ... 3 files`), and stop > m.index keeps this terminating.
    FILE_COUNT_LABEL_RE.lastIndex = stop;
  }
  return out + section.slice(cursor);
}

/** Extract every backticked span, including fenced-block bodies. */
function codeSpans(section: string): string[] {
  const spans: string[] = [];
  const add = (line: string) => {
    // A pasted unified diff is EVIDENCE, and the PR template invites pasting
    // it inside the Test Plan ("paste logs or test output"). Its syntax lines
    // would otherwise shed false path claims (`+++ b/<path>` → `b/<path>`,
    // `diff --git a/x b/x` → both). Drop them whole; a diff's body lines
    // carry no runner and match no claim shape on their own.
    if (/^(?:diff --git |\+\+\+ |--- |@@ |index )/.test(line.trim())) return;
    // A diff BODY line is a claim-shedder too: `-packages/old/gone.ts` matches
    // PATH_RE (its class admits a leading -/+) and ruled a false contradicted
    // on a realistic pasted diff. Inside a ```diff fence every content line is
    // prefixed, so dropping +/- prefixed lines loses no repro command — a
    // command line in a Test Plan is never itself diff content.
    if (/^[+-]/.test(line.trim())) return;
    // Strip a prompt marker, then anything after a `#` comment: a repro line is
    // written `npm test   # 471 pass`, and the comment is not part of the command.
    const t = line
      .trim()
      .replace(/^[$>]\s+/, '')
      .replace(/\s+#.*$/, '')
      .trim();
    if (t) spans.push(t);
  };
  // Backreference: a ``` fence closes only on ``` and ~~~ only on ~~~ — the
  // alternation form let a ~~~ line inside a ``` block end the span early.
  const fence = /(```|~~~)[^\n]*\n([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(section))) m[2].split('\n').forEach(add);

  const inline = /`([^`\n]+)`/g;
  const outsideFences = section.replace(fence, ' ');
  while ((m = inline.exec(outsideFences))) add(m[1]);
  return spans;
}

/**
 * Turn a Test Plan section into the claims this command can rule on.
 *
 * Only three kinds are extracted, and prose is not one of them: a sentence has
 * no deterministic ruling, so lifting it into the report as an `unchecked`
 * entry would produce a list the length of the Test Plan and tell the reader
 * nothing they could not get by reading it. The `unchecked` verdict is for a
 * claim of a checkable KIND that this run could not settle — a count with no
 * observed count to compare against — which is a fact about the run.
 */
export function extractClaims(section: string): Array<{
  kind: ClaimKind;
  text: string;
}> {
  const claims: Array<{ kind: ClaimKind; text: string }> = [];
  const seen = new Set<string>();
  const push = (kind: ClaimKind, text: string) => {
    const key = `${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ kind, text });
  };

  // The review's temp root and gitignored build output are excluded outright:
  // absent at the reviewed commit by construction. Applied to both standalone
  // path tokens (via isPathClaim) and cd bases (which legitimately carry no
  // file extension, so the evidence bar below does not apply to them).
  const isExcludedPath = (bare: string): boolean =>
    bare.startsWith('.qwen/') ||
    /(?:^|\/)(?:dist|build|out|bundle|coverage|node_modules)\//.test(bare);

  // A slash token is claimed as a repo path only with EVIDENCE it is one: a
  // file extension on its last segment, or an explicit ./ prefix. A bare
  // `owner/repo` is far more often a slug (`--repo QwenLM/qwen-code`), and
  // `origin/main` a ref — this PR's own Test Plan produced two false
  // `contradicted` notes before this bar existed.
  const isPathClaim = (t: string): boolean => {
    const bare = t.replace(/:\d+(?::\d+)?$/, '').replace(/\/$/, '');
    if (isExcludedPath(bare)) return false;
    return /\.\w+$/.test(bare) || t.startsWith('./');
  };

  for (const span of codeSpans(section)) {
    // A unified diff pasted into the Test Plan (the template's Evidence
    // section invites it) is not a set of path claims about the tree.
    if (/^(?:diff --git|---|\+\+\+|@@)\s/.test(span)) continue;
    if (RUNNER_RE.test(span)) push('command', span);
    if (PATH_RE.test(span)) {
      // A bare Maven runner token (`./mvnw`) is a command, not a claim
      // about the tree, even though its spelling happens to match PATH_RE.
      if (isPathClaim(span) && !MAVEN_RUNNER_RE.test(span)) push('path', span);
      continue;
    }
    // Paths named as ARGUMENTS of a command line. A Test Plan's most checkable
    // sentence is usually its repro command — "run vitest on these four files" —
    // and every one of those files is an existence claim about the tree.
    //
    // The `cd` prefix is load-bearing, not a nicety. `cd packages/core && npx
    // vitest run src/telemetry/loggers.test.ts` names a path that is relative to
    // `packages/core`, not to the repo root; resolving it against the root finds
    // nothing and files four `contradicted` notes on a PR whose Test Plan was
    // correct. Anything more exotic than the leading-`cd` shape keeps its tokens
    // unresolved, which is why they are only extracted when there is no `cd` to
    // misread.
    const cd = /^cd\s+([^\s&;|]+)\s*(?:&&|;)\s*(.*)$/.exec(span);
    if (!cd && /(^|\s)cd\s/.test(span)) continue;
    // A CHAINED cd (`cd a && cd b && …`) matches the leading-cd shape but the
    // single-hop resolver would join file tokens against the FIRST directory
    // only — a wrong base is worse than none. Bail like the exotic case.
    if (cd && /(^|\s)cd\s/.test(cd[2])) continue;
    const base = cd?.[1] ?? '';
    if (base && PATH_RE.test(base)) {
      const bareBase = base.replace(/:\d+(?::\d+)?$/, '').replace(/\/$/, '');
      if (!isExcludedPath(bareBase)) push('path', base);
    }
    // Flags that rebase relative paths (`--root ./integration-tests`) are
    // `cd`'s twin: a path token after one is relative to the flag's value,
    // not the repo root. Bail like the exotic-`cd` case — the `cd` directory
    // above was already pushed.
    const rest = cd?.[2] ?? span;
    if (/(?:^|\s)(?:--root|--prefix|--cwd|--project|-C)(?:\s|=)/.test(rest))
      continue;
    // Strip quoted arguments before tokenizing: `-t 'covers write/edit tools'`
    // is prose inside a flag value, not a path claim about the tree.
    const tokens = rest
      .replace(/'[^']*'/g, '')
      .replace(/"[^"]*"/g, '')
      .split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      // A token following a flag is that flag's VALUE (`--repo owner/repo`,
      // `-f infra/compose.yml`) — a claim about the tool's argument space,
      // not about this tree. The inline `--flag=value` form is the exception:
      // it carries its value in the same token and does NOT consume the next
      // one, so a positional path after it is still a claim about the tree.
      if (
        i > 0 &&
        tokens[i - 1].startsWith('-') &&
        !tokens[i - 1].includes('=')
      )
        continue;
      const t = tokens[i].replace(/[.,;:)'"]+$/, '');
      // The bare-runner guard above applies to argument tokens too: `./mvnw`
      // as a command's runner token is the runner, not a path claim.
      if (PATH_RE.test(t) && isPathClaim(t) && !MAVEN_RUNNER_RE.test(t)) {
        push('path', base ? `${base}/${t}` : t);
      }
    }
  }

  // The count patterns overlap by construction — `Tests  471 passed` matches
  // both the runner-summary shape and the bare `<n> passed` shape. Matched
  // spans are claimed so the more specific pattern (listed first) wins, and one
  // statement produces one claim instead of two near-identical ones.
  const taken: Array<[number, number]> = [];
  // Length-preserving and byte-identical outside the blanked spans, so a match
  // found here carries the original text and indexes the original section.
  const forCounts = maskFileCounts(section);
  for (const re of COUNT_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(forCounts))) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      push('count', m[0].trim());
    }
  }
  return claims;
}

/** Every test count the runners actually printed, summed per command. */
export function observedTestCounts(report: BuildTestReport | null): number[] {
  if (!report) return [];
  const counts: number[] = [];
  for (const cmd of report.test ?? []) {
    // The same exclusion that ruleCommand's finished() applies to command claims:
    // an interrupted or infrastructure-classified run is not a completed
    // suite, and its partial counts must not adjudicate a count claim. A
    // fail-never run that swallowed failures is the same — the field's
    // contract forbids ruling any claim reproduced against it — and so is a
    // run whose evidence the adapter refused to certify: its parsed subset
    // is partial by definition.
    if (
      cmd.timedOut ||
      cmd.exitCode === null ||
      cmd.infrastructure ||
      cmd.swallowedFailure ||
      cmd.evidenceCapped ||
      cmd.testsSuppressed ||
      cmd.neverRan
    )
      continue;
    // vitest: `Tests  472 passed (472)`. jest: `Tests:  12 passed, 12 total`.
    let total = 0;
    let saw = false;
    // `Tests  472 passed (472)`, `Tests: 12 passed, 12 total`, and multi-
    // segment forms like `Tests  2 failed | 3 skipped | 40 passed (45)` —
    // vitest separates with ` | `, jest with `, `.
    const re = /^\s*Tests:?\s+(?:\d+\s+\w+\s*[,|]\s*)*(\d+)\s+passed/gim;
    const mavenRe =
      /^\[maven-test-report\]\s+.+?:\s+tests=(\d+),\s+failures=(\d+),\s+errors=(\d+),\s+skipped=(\d+)$/gim;
    // Strip ANSI SGR sequences first. A real runner writes its summary through
    // a color-enabled pipe, so the kept text reads
    // `Tests\x1b[2m  \x1b[22m\x1b[1m3 failed\x1b[22m…` — the codes sit BETWEEN
    // the tokens, and no token-level regex survives that. Measured on a live
    // review of PR #8176: the count claim fell to `unchecked` with the summary
    // line right there in the report.
    // eslint-disable-next-line no-control-regex -- ESC is the character under test
    const text = (cmd.output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    let m: RegExpExecArray | null;
    // Runner-gated in BOTH directions: the JS console-summary regex is
    // skipped on Maven runs because surefire echoes test stdout — a Maven
    // run's own test printing `Tests 499 passed (499)` is not the run's
    // count — and the `[maven-test-report]` markers are only evidence a
    // MAVEN run prints. The same text mined from the other toolchain's
    // stdout is a fabricated count in either direction; each shape is gated
    // behind its own runner.
    const isMavenCommand = MAVEN_RUNNER_RE.test(cmd.command);
    if (!isMavenCommand) {
      while ((m = re.exec(text))) {
        total += Number(m[1]);
        saw = true;
      }
    }
    if (isMavenCommand) {
      while ((m = mavenRe.exec(text))) {
        // Surefire does not guarantee tests >= failures + errors + skipped
        // (class-level @Disabled and rerunFailingTestsCount reruns both perturb
        // it), and this sum spans every report of the command: one negative
        // value would silently cancel legitimate counts from its neighbours.
        total += Math.max(
          0,
          Number(m[1]) - Number(m[2]) - Number(m[3]) - Number(m[4]),
        );
        saw = true;
      }
    }
    if (saw) counts.push(total);
  }
  return counts;
}

/** A path claim's own text reduced to a repo-relative path. */
function normalizeClaimPath(text: string): string {
  return normalize(text.replace(/:\d+(?::\d+)?$/, '').replace(/\/$/, ''));
}

/**
 * Is `path` gitignored in `worktree`? One `git` spawn per distinct path, memoed
 * for the process — a Test Plan naming the same artifact in its Evidence and
 * its Environment sections should not pay twice.
 *
 * `--` before the path is belt-and-braces, and measured as such: `PATH_RE`'s
 * class admits a leading `-`, but no `-`-leading text survives extraction today
 * (`extractClaims('`-packages/old/gone.ts`')` returns nothing), so nothing
 * reaches `check-ignore` in OPTION position. It is one token against a future
 * extraction change, not a live hole. A non-zero exit means either "not
 * ignored" or "no git here"; both fall through to the ordinary ruling, which is
 * why this returns a plain boolean.
 *
 * Spawned through the package's own `git` helper rather than a bare
 * `execFileSync`, for the deadline it carries: every other git invocation in
 * these commands runs under `GIT_TIMEOUT_MS` because, as that constant's
 * comment puts it, "a hang must still end". This was the one without it, and
 * it runs against a worktree the review does not control.
 */
function isGitIgnored(worktree: string, path: string): boolean {
  const key = `${worktree}\0${path}`;
  const memo = ignoreCache.get(key);
  if (memo !== undefined) return memo;
  let ignored: boolean;
  try {
    git('-C', worktree, 'check-ignore', '-q', '--', path);
    ignored = true;
  } catch {
    ignored = false;
  }
  ignoreCache.set(key, ignored);
  return ignored;
}

const ignoreCache = new Map<string, boolean>();

function rulePath(
  text: string,
  worktree: string,
  changed: Set<string>,
): TestPlanClaim {
  const path = normalizeClaimPath(text);
  if (changed.has(path)) {
    return {
      kind: 'path',
      text,
      verdict: 'reproduces',
      note: 'the diff changes this file',
    };
  }
  // A path that escapes the repo root is not a claim about this tree, so it is
  // ruled `unchecked`, never "missing" — calling `../scratch/out.json` a
  // contradiction would be a finding about the reviewer's filesystem. (Absolute
  // paths never reach here: `PATH_RE` does not admit a leading `/`, precisely
  // because `/tmp/x.json` is never a claim about the repository.)
  if (path.startsWith('..')) {
    return {
      kind: 'path',
      text,
      verdict: 'unchecked',
      note: 'not a repo-relative path',
    };
  }
  // ONE existence check, and the ignore status only ever picks the WORDING or
  // downgrades a would-be contradiction — never swallows a `reproduces`. Two
  // existence checks with the ignore probe between them made the second one
  // unreachable and silently retired its note, which is the distinction a
  // reader needs: a tracked file that is present is state at the reviewed
  // commit, an ignored file that is present is something this run produced.
  const ignored = isGitIgnored(worktree, path);
  if (existsSync(join(worktree, path))) {
    return {
      kind: 'path',
      text,
      verdict: 'reproduces',
      note: ignored
        ? 'exists in the review worktree — gitignored, so it is a build output this run produced, not state at the reviewed commit'
        : 'exists at the reviewed commit (the diff does not change it)',
    };
  }
  // A gitignored path (a build output the Environment section names — the
  // template's own example is a dist/ entry point) is absent at the reviewed
  // commit BY CONSTRUCTION, the same reasoning that excludes `.qwen/` paths.
  if (ignored) {
    return {
      kind: 'path',
      text,
      verdict: 'unchecked',
      note: 'gitignored — a build output, absent at the reviewed commit by construction',
    };
  }
  return {
    kind: 'path',
    text,
    verdict: 'contradicted',
    observed: 'no such file or directory',
    note: 'the Test Plan names a path that is neither in the diff nor in the tree at the reviewed commit',
  };
}

/** `npm run build` / `npm test` / `npm run x --workspace=y` → the script name. */
export function npmScriptOf(command: string): string | null {
  // ALLOWLIST, not denylist: only the `<runner> run <name>` form and npm's own
  // script aliases are ruled. A denylist of four verbs read every OTHER npm
  // builtin (`npm audit`, `npm pack`, `npm ls`, ~fifty of them) as a script
  // name and filed `no package defines this script` on correct Test Plans —
  // measured on real PR bodies. The true positive this exists for
  // ("`npm run test:unit` was renamed") lives entirely in the allowed forms.
  const m = /^(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/.exec(command);
  if (m && !m[1].startsWith('-')) return m[1];
  // `bun test` is bun's own built-in runner, not a package-script alias — it
  // runs whether or not any manifest defines `test`, so ruling it against the
  // scripts table filed a false contradicted.
  const alias = /^(?:npm|pnpm|yarn)\s+(test|start|stop|restart)(?=\s|$)/.exec(
    command,
  );
  return alias ? alias[1] : null;
}

/** Lifecycle phases a Maven command can name. */
const MAVEN_PHASE_RE =
  /^(?:clean|validate|compile|test-compile|test|package|verify|install)$/;

/**
 * Work this review never runs, for reduction DISCLOSURE only — deliberately
 * wider than the settlement vocabulary above: a claim carrying `deploy`,
 * `site`, or a plugin goal (a positional carrying `:`) in non-trailing
 * position settles via its trailing in-vocabulary phase, and the reduction
 * must be disclosed rather than read as if the whole claim ran. Trailing
 * out-of-vocabulary work is refused separately by claimFinalWork.
 */
const MAVEN_UNRUN_WORK_RE =
  /^(?:deploy|site|pre-site|post-site|pre-clean|post-clean|prepare-package|pre-integration-test|integration-test|post-integration-test)$/;

/**
 * Flags whose space-separated form consumes the NEXT token as their value
 * (the attached `=` forms carry it in-token and consume nothing). A module
 * dir named `test` handed to one is a flag VALUE, not a lifecycle phase.
 */
const MAVEN_VALUE_FLAGS = new Set([
  '-pl',
  '--projects',
  '-P',
  '--activate-profiles',
  '-D',
  '--define',
  '-rf',
  '--resume-from',
  '-f',
  '--file',
  '-s',
  '--settings',
  '-gs',
  '--global-settings',
  '-l',
  '--log-file',
  '-T',
  '--threads',
  '-b',
  '--builder',
  '-t',
  '--toolchains',
  '-gt',
  '--global-toolchains',
]);

/**
 * Long options whose single-dash spelling Maven's commons-cli ALSO accepts
 * (`mvn -projects core` — verified on real Maven 3.8.7). They are
 * normalized to their `--` spellings before parsing, or they bypass every
 * scope/value check modeled on the `--` forms. Exact names only: rewriting
 * arbitrary multi-char `-x` tokens would mangle the separator-less attached
 * short forms (`-rfcore`), which have their own checks.
 */
const MAVEN_SINGLE_DASH_LONGS = new Set([
  'projects',
  'also-make',
  'also-make-dependents',
  'activate-profiles',
  'define',
  'resume-from',
  'file',
  'settings',
  'global-settings',
  'log-file',
  'threads',
  'builder',
  'toolchains',
  'global-toolchains',
  'non-recursive',
  'offline',
  'update-snapshots',
  'fail-never',
  'fail-fast',
  'fail-at-end',
]);

function normalizeMavenSingleDashLongs(command: string): string {
  return command
    .split(/\s+/)
    .map((token) => {
      // One layer of surrounding quotes hides the flag from the head check
      // exactly like it hides it from the scope guards below.
      const inner = unquoteToken(token);
      const eq = inner.indexOf('=');
      const head = eq === -1 ? inner : inner.slice(0, eq);
      if (
        head.length > 2 &&
        head.startsWith('-') &&
        !head.startsWith('--') &&
        MAVEN_SINGLE_DASH_LONGS.has(head.slice(1))
      ) {
        return `-${inner}`;
      }
      return token;
    })
    .join(' ');
}

/**
 * The tokens of a Maven command line that are not consumed as flag values —
 * quote-aware like mavenPlModules, so a quoted selector is one value.
 */
function mavenPositionalTokens(command: string): string[] {
  const tokens = command.trim().split(/\s+/);
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (MAVEN_VALUE_FLAGS.has(token)) {
      i += 1;
      const raw = tokens[i];
      if (raw === undefined) break;
      const quote = raw.startsWith("'") || raw.startsWith('"') ? raw[0] : null;
      if (quote !== null && !(raw.length > 1 && raw.endsWith(quote))) {
        while (i + 1 < tokens.length && !tokens[i].endsWith(quote)) i += 1;
      }
      continue;
    }
    // The attached `-pl='foo bar'` form carries the same quoted value
    // in-token: the split broke it at the space, so consume through the
    // closing quote here too, or a phase-looking word inside the selector
    // (`-pl='foo test'`) would be read as a claimed phase.
    if (token.startsWith('-pl=') || token.startsWith('--projects=')) {
      const raw = token.slice(token.indexOf('=') + 1);
      const quote = raw.startsWith("'") || raw.startsWith('"') ? raw[0] : null;
      if (quote !== null && !(raw.length > 1 && raw.endsWith(quote))) {
        while (i + 1 < tokens.length && !tokens[i].endsWith(quote)) i += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return positional;
}

function mavenLifecycle(command: string): string | null {
  const trimmed = command.trim();
  if (!MAVEN_RUNNER_RE.test(trimmed)) return null;
  // The LAST phase token that is not a flag value: that reads a phase-first
  // spelling (`mvnw test -pl core`) correctly and never mistakes a
  // phase-named `-pl` VALUE (`-pl test`) for the command's lifecycle.
  let lifecycle: string | null = null;
  for (const token of mavenPositionalTokens(trimmed)) {
    if (MAVEN_PHASE_RE.test(token)) lifecycle = token;
  }
  return lifecycle;
}

const BARE_MAVEN_LIFECYCLE_RE = new RegExp(
  `^(?:${MAVEN_RUNNER_SOURCE})\\s+(clean|validate|compile|test-compile|test|package|verify|install)$`,
);

function bareMavenLifecycle(command: string): string | null {
  return BARE_MAVEN_LIFECYCLE_RE.exec(command.trim())?.[1] ?? null;
}

/** True when a command carries `-am`/`--also-make` (upstream closure). */
function mavenHasAlsoMake(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // A quoted `-pl` selector can carry `-am` inside a module dir name
    // (`-pl 'foo -am bar'` — spaces pass the POM entry gate); consume the
    // whole selector so the split inside it is not read as the flag. The
    // attached `-pl='foo -am bar'` form breaks the same way at the space,
    // so it gets the same consumption.
    if (
      token === '-pl' ||
      token === '--projects' ||
      token.startsWith('-pl=') ||
      token.startsWith('--projects=')
    ) {
      let raw: string | undefined;
      if (token === '-pl' || token === '--projects') {
        i += 1;
        raw = tokens[i];
      } else {
        raw = token.slice(token.indexOf('=') + 1);
      }
      if (raw === undefined) break;
      const quote = raw.startsWith("'") || raw.startsWith('"') ? raw[0] : null;
      if (quote !== null && !(raw.length > 1 && raw.endsWith(quote))) {
        while (i + 1 < tokens.length && !tokens[i].endsWith(quote)) i += 1;
      }
      continue;
    }
    if (token === '-am' || token === '--also-make') return true;
  }
  return false;
}

/** Strip one layer of matching surrounding quotes from a claim token. */
function unquoteToken(token: string): string {
  if (
    token.length >= 2 &&
    (token.startsWith("'") || token.startsWith('"')) &&
    token.endsWith(token[0])
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/** The module set of a command's `-pl`/`--projects` selector, sorted. */
function mavenPlModules(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/);
  // Maven ACCUMULATES repeated `-pl` (commons-cli `getOptionValues`):
  // `mvn -pl m1 -pl m2` builds both modules, so every occurrence joins the
  // set — keeping only the last read a claim that covered m1 as scoped to
  // m2 alone.
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    // A quoted flag token (`mvn "-pl" core`) is the same flag once its quote
    // layer is stripped.
    const token = unquoteToken(tokens[i]);
    let raw: string | undefined;
    // Advance BEFORE reading, like the sibling token walkers: reading
    // tokens[i + 1] here made the rejoin loop below push that same token
    // again, duplicating the first word of every space-bearing selector.
    if (token === '-pl' || token === '--projects') {
      i += 1;
      raw = tokens[i];
    } else if (token.startsWith('-pl=')) raw = token.slice('-pl='.length);
    else if (token.startsWith('--projects='))
      raw = token.slice('--projects='.length);
    if (raw === undefined) continue;
    // A module dir can carry a space (it passes the POM entry gate), so
    // shellSelector wraps the selector in quotes, and the split above broke
    // it into its first word — collapsing two different module sets that
    // share one. Rejoin through the closing quote before splitting on `,`.
    const quote = raw.startsWith("'") || raw.startsWith('"') ? raw[0] : null;
    if (quote !== null && !(raw.length > 1 && raw.endsWith(quote))) {
      const parts = [raw];
      while (
        i + 1 < tokens.length &&
        !parts[parts.length - 1].endsWith(quote)
      ) {
        i += 1;
        parts.push(tokens[i]);
      }
      raw = parts.join(' ');
    }
    let value: string;
    if (quote !== null && raw.length > 1 && raw.endsWith(quote)) {
      value = raw.slice(1, -1);
      // Undo shellQuotePath's `'\''` dance for dirs with an apostrophe.
      if (quote === "'") value = value.replace(/'\\''/g, "'");
    } else {
      value = raw;
    }
    values.push(value);
  }
  if (values.length === 0) return null;
  const modules = [
    ...new Set(
      values
        .flatMap((value) => value.split(','))
        .map((module) => {
          const trimmed = module.trim();
          // Quoted and unquoted spellings compare equal.
          const quoted = /^(['"])(.*)\1$/.exec(trimmed);
          // Windows backslash selectors (`.\core`) and trailing-slash
          // spellings (`core/`) name the same module dir as their POSIX
          // twins; normalize them so the claim can settle against the
          // recorded dir instead of silently discarding its evidence.
          const unquoted = (quoted ? quoted[2] : trimmed)
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
          // A `[groupId]:artifactId` coordinate selector names a different
          // NAMESPACE than the recorded module directories: artifactId and
          // dir name can disagree, and two dirs can share one artifactId,
          // so reducing the coordinate and string-matching it against a dir
          // could settle — or contradict — the claim with a DIFFERENT
          // module's run. Kept raw instead: a coordinate never matches a
          // recorded dir (dirs can't carry `:`), so such claims stay
          // unsettleable (unchecked) rather than risk a wrong-module
          // verdict.
          if (unquoted.includes(':')) return unquoted;
          // Maven treats `-pl ./core` identically to `-pl core`, and the
          // recorded modules come from repo-relative paths that never carry
          // the prefix — normalize the claim spelling away, or the claim
          // could never settle or be contradicted. A bare `.` (the root
          // project) survives the strip as `''` and is restored.
          return unquoted.replace(/^\.\/+/, '') || '.';
        })
        .filter((module) => module.length > 0),
    ),
  ].sort();
  return modules.length > 0 ? modules : null;
}

function sameModuleSet(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null || a.length !== b.length) return false;
  // Sorted here rather than assumed: only the CLAIM side comes back sorted
  // from mavenPlModules. The run side is the adapter's own module list, and
  // a set comparison must not depend on how that list happened to be
  // ordered when it was recorded.
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((module, i) => module === right[i]);
}

function ruleCommand(
  text: string,
  worktree: string,
  buildTest: BuildTestReport | null,
): TestPlanClaim {
  // A command this review actually ran is settled by its exit code — the
  // strongest evidence available, and it needs no manifest lookup.
  const rawClaimed = text.trim();
  // Maven's commons-cli accepts single-dash spellings of its long options;
  // normalize them to the `--` forms so they cannot bypass the grammar
  // below. Applied to Maven claims only — the comparison against recorded
  // commands is unaffected, because the adapter never renders those
  // spellings.
  const claimed = MAVEN_RUNNER_RE.test(rawClaimed)
    ? normalizeMavenSingleDashLongs(rawClaimed)
    : rawClaimed;
  // A workspace-scoped run (`npm run build --workspace=...`) still settles
  // the plan's bare command. Maven scopes before the lifecycle
  // (`./mvnw -pl core -am test`), so compare lifecycle phases there — but the
  // settling is module-scoped, and the note must not read as if the full
  // reactor were verified. Settling follows the claim's FINAL lifecycle when
  // the claim carries no scoping of its own (`mvn clean test` settles on
  // `test`); a claim naming its own `-pl`/`-P`/`-D` scope keeps its
  // conservative treatment, because one scoped run cannot settle a
  // differently scoped claim.
  const mavenRunnerClaim = MAVEN_RUNNER_RE.test(claimed);
  const claimedLifecycle = mavenLifecycle(claimed);
  // Maven flags that scope a run to less — or other — than the full reactor.
  // A claim carrying one can only be settled by a run of the SAME scope: one
  // scoped run cannot settle a differently scoped claim.
  const scopesNonPl = (token: string): boolean =>
    token.startsWith('-P') ||
    token.startsWith('-D') ||
    token === '--activate-profiles' ||
    token.startsWith('--activate-profiles=') ||
    token === '--define' ||
    token.startsWith('--define=') ||
    token === '-rf' ||
    token.startsWith('-rf=') ||
    token === '--resume-from' ||
    token.startsWith('--resume-from=') ||
    token === '-N' ||
    token === '--non-recursive' ||
    token === '-f' ||
    token.startsWith('-f=') ||
    token === '--file' ||
    token.startsWith('--file=') ||
    token === '-amd' ||
    // commons-cli accepts attached values too; the exact-token match alone
    // let `-amd=` claims bypass the conservative treatment.
    token.startsWith('-amd=') ||
    token === '--also-make-dependents' ||
    token.startsWith('--also-make-dependents=') ||
    // The other semantics-altering value flags MAVEN_VALUE_FLAGS models:
    // a claim carrying one cannot settle on a run that never used it,
    // exactly like the `-D`/`-P` claims of comparable weight above.
    token === '-s' ||
    token.startsWith('-s=') ||
    token === '--settings' ||
    token.startsWith('--settings=') ||
    token === '-gs' ||
    token.startsWith('-gs=') ||
    token === '--global-settings' ||
    token.startsWith('--global-settings=') ||
    token === '-t' ||
    token.startsWith('-t=') ||
    token === '--toolchains' ||
    token.startsWith('--toolchains=') ||
    token === '-gt' ||
    token.startsWith('-gt=') ||
    token === '--global-toolchains' ||
    token.startsWith('--global-toolchains=') ||
    token === '-b' ||
    token.startsWith('-b=') ||
    token === '--builder' ||
    token.startsWith('--builder=') ||
    // Parallelism changes outcomes (modules racing shared state), and the
    // review only ever runs serial: a `-T` claim cannot settle on a serial
    // run. `-l`/`--log-file` is the one value flag left out on purpose —
    // log redirection changes no outcomes.
    token.startsWith('-T') ||
    token === '--threads' ||
    token.startsWith('--threads=') ||
    // Offline mode changes what resolution the run performs (an offline
    // build can fail where an online one succeeds), and `-U` forces
    // snapshot re-resolution the review never did: a claim carrying one
    // cannot settle on a run that never used it.
    token === '-o' ||
    token === '--offline' ||
    token === '-U' ||
    token === '--update-snapshots' ||
    // commons-cli also accepts separator-less ATTACHED short forms
    // (`-fother/pom.xml`, `-rf:core`, `-ssettings.xml`, `-plcore`); the
    // exact-token and `=`-attached matches alone let them bypass the
    // conservative treatment. The attached `-pl` form cannot be reduced to
    // a module set here, so it keeps the same treatment as the other scopes.
    (token.startsWith('-rf') && token !== '-rf') ||
    (token.startsWith('-f') && token !== '-f') ||
    (token.startsWith('-s') && token !== '-s') ||
    (token.startsWith('-gs') && token !== '-gs') ||
    (token.startsWith('-t') && token !== '-t') ||
    (token.startsWith('-gt') && token !== '-gt') ||
    (token.startsWith('-b') && token !== '-b') ||
    (token.startsWith('-amd') && token !== '-amd') ||
    // The `-pl=` spelling is still reducible to a module set (the value is
    // in-token); only separator-less attached forms (`-plcore`) are not.
    (token.startsWith('-pl') && token !== '-pl' && !token.startsWith('-pl='));
  // One layer of surrounding quotes is stripped before the scope checks:
  // `mvn "-pl" core test` carries the same scoping as the unquoted spelling,
  // and comparing raw tokens let a quoted flag bypass every guard here.
  const claimTokens = claimed.split(/\s+/).map(unquoteToken);
  // Lifecycle phases the claim names, in order: a multi-phase claim
  // (`clean test`) runs phases the recorded single-phase run never did.
  // Flag values are excluded: a module dir named `test` handed to `-pl` is
  // a selector, not a claimed phase. Out-of-vocabulary WORK counts too
  // (`mvn deploy test`, a leading plugin goal): it never ran here, and
  // settling the trailing phase without disclosing the reduction would
  // overstate the evidence.
  const claimPhases = mavenPositionalTokens(claimed).filter(
    (token) =>
      MAVEN_PHASE_RE.test(token) ||
      MAVEN_UNRUN_WORK_RE.test(token) ||
      (!token.startsWith('-') && token.includes(':')),
  );
  const claimScopesItself = claimTokens.some(
    (token) =>
      token === '-pl' ||
      token.startsWith('-pl=') ||
      token === '--projects' ||
      token.startsWith('--projects=') ||
      scopesNonPl(token),
  );
  // The claim's final positional token names the last work it runs: a
  // trailing goal outside the lifecycle vocabulary (`mvn test deploy`,
  // `site`, a plugin goal) never ran here, and settling the recognized
  // phase alone would read undisclosed — unlike `mvn clean test`, which
  // discloses its phase reduction. Trailing flag tokens (`-B`, attached
  // `-D…`) name no work of their own.
  const claimFinalWork = mavenPositionalTokens(claimed)
    .filter((token) => !token.startsWith('-'))
    .at(-1);
  const claimPlModules = mavenPlModules(claimed);
  // A claim scoped by `-pl` ALONE can settle on a recorded run with the same
  // module set and final lifecycle — that is the SAME scope, and discarding
  // the evidence would assert the review never ran what it did. Claims also
  // carrying -P/-D/-rf/-N/-f keep the conservative treatment: those scopes
  // cannot be compared here.
  const claimOnlyPlScoped =
    claimPlModules !== null && !claimTokens.some(scopesNonPl);
  // The RUN side is never parsed: build-test records what its Maven command
  // scopes on `c.maven`, straight from the values it rendered the command
  // line from. Only `claimed` — free text a PR author wrote — needs a
  // grammar. Keeping one grammar means a claim can never be settled by a
  // reading of our own command that the adapter would not recognize.
  const settledByLifecycle = (c: CommandResult): boolean =>
    c.command.trim() !== claimed &&
    !(
      c.command.trim().startsWith(claimed) &&
      c.command.trim()[claimed.length] === ' '
    ) &&
    claimedLifecycle !== null &&
    claimFinalWork === claimedLifecycle &&
    !claimScopesItself &&
    c.maven?.lifecycle === claimedLifecycle;
  const settledBySameScope = (c: CommandResult): boolean =>
    claimOnlyPlScoped &&
    claimedLifecycle !== null &&
    claimFinalWork === claimedLifecycle &&
    c.maven?.lifecycle === claimedLifecycle &&
    sameModuleSet(c.maven?.modules ?? null, claimPlModules);
  // A run this review itself classified as infrastructure (a timeout, a
  // spawn-level death, a Maven acquisition failure) is the same evidence the
  // build-test note disavowed as environmental — it must not settle a claim.
  // Neither may a run whose fresh-report evidence the adapter refused to
  // certify: its parsed subset is partial by definition.
  const finished = (c: CommandResult): boolean =>
    !c.timedOut &&
    c.exitCode !== null &&
    !c.infrastructure &&
    !c.evidenceCapped;
  // The marker is mined from the command's own output — PR test stdout can
  // print it too, so it is not tamper-proof (same property as the npm
  // console-summary parsing). Runner-gated like the `[maven-test-report]`
  // count mining below: only the Maven adapter emits the marker, so the same
  // text in a non-Maven command's stdout is fabricated evidence.
  const freshTestFailures = (c: CommandResult): boolean =>
    MAVEN_RUNNER_RE.test(c.command) &&
    /^\[maven-test-failure\] /m.test(c.output ?? '');
  // A zero exit over fresh failing reports (surefire `testFailureIgnore`),
  // or over framed errors a fail-never setting swallowed, is a FAILED run
  // for ruling purposes: the Maven adapter marks both ok:false, so the
  // claim must not read as reproduced. A run whose evidence was capped is
  // ok:false for the opposite reason — it certified NOTHING — so it counts
  // as failed here too, never as reproduced: the capped cascade arm rules
  // it unchecked or contradicted (never reproduces), and the `-am`
  // exclusion reads it as failing so an upstream-only failure still
  // cannot contradict a narrower claim.
  const ranFailed = (c: CommandResult): boolean =>
    c.exitCode !== 0 ||
    freshTestFailures(c) ||
    c.swallowedFailure === true ||
    c.evidenceCapped === true ||
    c.neverRan === true;
  // A run's `[maven-test-failure]` markers attribute each failure to its
  // report path `<module>/target/...`: when one resolves inside the claimed
  // `-pl` set the failure is provably inside the claim's scope, and the
  // `-am` carve-outs must not discard it. Mined from the command's own
  // output, so it carries the same tamper surface as freshTestFailures.
  // The 200-line case cap can drop EVERY `[maven-test-failure]` line of the
  // claimed module when an upstream module fails first in path order, so a
  // surviving `[maven-test-report]` PROJECT rollup line with non-zero
  // failures for the claimed module is in-scope failure evidence too.
  const failureInsideClaim = (c: CommandResult): boolean => {
    if (claimPlModules === null) return false;
    const output = c.output ?? '';
    const lines = output.split('\n');
    // Compile/goal failures inside a claimed module write no Surefire
    // reports, so the test-phase markers below cannot attribute them; but a
    // compiler error line names the file it failed on, worktree-absolute
    // (`[ERROR] /wt/core/src/…/Foo.java:[10,5] …`). One beneath a claimed
    // module dir is a failure the claim's own command would share.
    const worktreePosix = worktree.split(sep).join('/');
    if (
      lines.some((line) => {
        if (!isSourceFailureLine(line)) return false;
        const linePosix = line.replace(/\\/g, '/');
        return claimPlModules.some((module) =>
          module === '.'
            ? linePosix.includes(`${worktreePosix}/src/`)
            : linePosix.includes(`${worktreePosix}/${module}/`),
        );
      })
    ) {
      return true;
    }
    return claimPlModules.some((module) => {
      const prefix = module === '.' ? '' : `${module}/`;
      if (output.includes(`[maven-test-failure] ${prefix}target/`)) {
        return true;
      }
      return lines.some(
        (line) =>
          line.startsWith(`[maven-test-report] ${module} (`) &&
          (/ failures=[1-9]/.test(line) || / errors=[1-9]/.test(line)),
      );
    });
  };
  // How a matched run relates to the claim — module-scoped and/or
  // phase-reduced — in the wording the notes use. Shared by the
  // finished-run ruling below and the interrupted/cascade notes, so the
  // same evidence cannot read overstated in one branch merely because
  // the run did (or did not) finish.
  const runForm = (
    c: CommandResult,
  ): { howItRan: string; reduced: boolean } => {
    // Reactor-wide recorded runs carry no `-pl`; calling those
    // module-scoped would understate what the evidence verified.
    const settledReduced = settledByLifecycle(c);
    const scoped =
      (settledReduced || settledBySameScope(c)) && c.maven?.modules != null;
    // A multi-phase claim (`clean test`) settles on its FINAL phase when
    // it carries no scoping of its own — the adapter only ever runs
    // `test` or `test-compile`, so the note must not read as if the
    // earlier phases ran.
    const phaseReduced =
      (settledReduced || settledBySameScope(c)) && claimPhases.length > 1;
    const howItRan =
      scoped && phaseReduced
        ? `this review ran a module-scoped form of its final phase (\`${claimedLifecycle}\`), ` +
          `not the full \`${claimPhases.join(' ')}\` it claims`
        : scoped
          ? 'this review ran a module-scoped form of it'
          : phaseReduced
            ? `this review ran its final phase (\`${claimedLifecycle}\`), ` +
              `not the full \`${claimPhases.join(' ')}\` it claims`
            : 'this review ran it';
    return { howItRan, reduced: scoped || phaseReduced };
  };
  const matches = [
    ...(buildTest?.build ?? []),
    ...(buildTest?.test ?? []),
  ].filter((c) => {
    const command = c.command.trim();
    if (
      !(
        command === claimed ||
        // A bare Maven runner claim (`./mvnw`, `mvn`) carries no lifecycle, so
        // prefix-matching it would settle the WHOLE wrapper run from one
        // module-scoped run; such claims fall through to the Maven cascade.
        (command.startsWith(claimed) &&
          command[claimed.length] === ' ' &&
          (!mavenRunnerClaim || bareMavenLifecycle(claimed) !== null)) ||
        settledByLifecycle(c) ||
        settledBySameScope(c)
      )
    ) {
      return false;
    }
    // An `-am` run also tests the UPSTREAM modules it pulls in, which a
    // claim without `-am` never runs: its green exit still settles the
    // claim, but its failure may live entirely in modules the claim never
    // tests, so it cannot contradict it — one scoped run must not settle a
    // differently scoped claim in the failing direction. (The converse IS
    // sound: a run WITHOUT `-am` that fails inside the claimed module set
    // falsifies an `-am` claim too, so that direction stays settled.) The
    // exclusion yields when the run's own markers attribute a failure to a
    // module INSIDE the claimed set: that failure is in-scope evidence.
    // Runs whose evidence was capped join the exclusion for the same
    // reason: the capped arm treats their non-zero exit as definitive,
    // which would contradict a differently scoped claim off failures in
    // modules it never tests.
    return !(
      settledBySameScope(c) &&
      c.maven?.alsoMake === true &&
      !mavenHasAlsoMake(claimed) &&
      (finished(c) || c.evidenceCapped === true) &&
      ranFailed(c) &&
      !failureInsideClaim(c)
    );
  });
  // build-test records one scoped command per package and does not stop on
  // failure, so a bare claim can match several runs. Prefer a failure: if ANY
  // scoped run failed, the phase failed, and the bare claim must read
  // `contradicted` — the first match could be a green package that merely
  // sorted first, stating the opposite of the authoritative `ok: false`.
  // A Maven run interrupted with fresh recorded failures OUT-RANKS a green
  // finished sibling: the build-test report says ok:false with the recorded
  // markers, and reading `reproduces` off the sibling states the opposite
  // of the authoritative evidence. Ranked below a finished FAILED run —
  // the stronger evidence — like the spawn-death ranking beside it.
  const interruptedWithFailures = mavenRunnerClaim
    ? matches.find(
        (c) =>
          (c.timedOut || c.exitCode === null) &&
          freshTestFailures(c) &&
          // The same scope asymmetry the `-am` guard above applies to
          // finished runs: an interrupted `-am` run's fresh failures may
          // live entirely in upstream modules the claim never tests, so it
          // cannot contradict the claim either — unless the markers
          // attribute a failure to a module inside the claimed set.
          !(
            settledBySameScope(c) &&
            c.maven?.alsoMake === true &&
            !mavenHasAlsoMake(claimed) &&
            !failureInsideClaim(c)
          ),
      )
    : undefined;
  const ran =
    matches.find((c) => finished(c) && ranFailed(c)) ??
    // A spawn-level death (exitCode null, no deadline kill) is a failed run
    // for a non-Maven claim, ranked ABOVE any green finished sibling: one
    // green package must not shadow the death and read the claim
    // `reproduces` while the build-test report says `ok: false`. Maven
    // claims rank their interrupted-with-failures run here instead.
    (!mavenRunnerClaim
      ? matches.find(
          (c) => !c.timedOut && c.exitCode === null && !c.infrastructure,
        )
      : interruptedWithFailures) ??
    matches.find(finished);
  if (ran) {
    if (ran === interruptedWithFailures) {
      return {
        kind: 'command',
        text,
        verdict: 'contradicted',
        observed:
          'interrupted, but fresh Surefire/Failsafe reports record failures',
        note: `${runForm(ran).howItRan}; it was interrupted, but fresh test reports record failures`,
      };
    }
    const form = runForm(ran);
    const howItRan = form.howItRan;
    if (ran.exitCode === 0 && ranFailed(ran)) {
      // The wording splits on what the zero exit actually swallowed: a skip
      // setting suppressed the phase (nothing was tested — there are no
      // failures to hunt), a wrapper never started Maven (same), or the
      // output records failures the exit code did not fail on.
      const observed = freshTestFailures(ran)
        ? 'exit 0, but fresh Surefire/Failsafe reports record failures'
        : ran.testsSuppressed
          ? 'exit 0, but a skip setting suppressed the test phase — nothing was tested'
          : ran.neverRan
            ? 'exit 0, but Maven never started — nothing was built or tested'
            : 'exit 0, but the output records failures the exit code did not fail on';
      const note =
        `${howItRan}, but ` +
        (freshTestFailures(ran)
          ? 'fresh test reports record failures despite the zero exit'
          : ran.testsSuppressed
            ? 'a skip setting suppressed the test phase — nothing was tested'
            : ran.neverRan
              ? 'the wrapper exited 0 without starting Maven — nothing was built or tested'
              : 'the run recorded failures despite the zero exit');
      return {
        kind: 'command',
        text,
        verdict: 'contradicted',
        observed,
        note,
      };
    }
    return ran.exitCode === 0
      ? {
          kind: 'command',
          text,
          verdict: 'reproduces',
          observed: 'exit 0',
          note: howItRan,
        }
      : {
          kind: 'command',
          text,
          verdict: 'contradicted',
          observed: `exit ${ran.exitCode}`,
          note: form.reduced
            ? `${howItRan}, and that failed`
            : 'this review ran it and it failed',
        };
  }

  if (mavenRunnerClaim) {
    // The interrupted-with-failures ruling is ranked into `ran` above: by
    // the time this cascade runs, no such run matched — an interrupted run
    // with fresh failures either already contradicted the claim there or
    // was excluded by the same `-am` scope asymmetry.
    const timedOutRun = matches.find((c) => c.timedOut);
    if (timedOutRun) {
      return {
        kind: 'command',
        text,
        verdict: 'unchecked',
        note: `${runForm(timedOutRun).howItRan}; it timed out`,
      };
    }
    const spawnDeath = matches.find((c) => c.exitCode === null);
    if (spawnDeath) {
      return {
        kind: 'command',
        text,
        verdict: 'unchecked',
        note: `${runForm(spawnDeath).howItRan}; it ended without an exit code`,
      };
    }
    const environmental = matches.find((c) => c.infrastructure);
    if (environmental) {
      return {
        kind: 'command',
        text,
        verdict: 'unchecked',
        note: `${runForm(environmental).howItRan}; it failed for environmental reasons`,
      };
    }
    // A run the adapter refused to certify settles nothing either way:
    // name the cap rather than letting the claim fall through to the
    // "not run" wording, which would misstate what happened.
    const capped = matches.find((c) => c.evidenceCapped);
    if (capped) {
      // A NON-ZERO exit is a definitive failure even when part of the fresh
      // report evidence went unread — the cap withholds certification of a
      // PASS, it does not retroactively excuse a failure, exactly like the
      // interrupted-with-failures policy above. Only exit 0 is genuinely
      // unknown.
      if (capped.exitCode !== null && capped.exitCode !== 0) {
        return {
          kind: 'command',
          text,
          verdict: 'contradicted',
          observed: `exit ${capped.exitCode}`,
          note:
            `${runForm(capped).howItRan}, and it failed — part of its fresh ` +
            'report evidence was never read (cap, parse rejection, or a truncated ' +
            'sweep), but the non-zero exit is definitive',
        };
      }
      // Cap-INDEPENDENT positive failure evidence is definitive the same
      // way: markers from reports the sweep DID parse (or failures a
      // fail-never setting swallowed) prove the run failed regardless of
      // what the unread evidence holds — the finished path's exit-0 arm
      // rules the identical evidence contradicted, and the verdict must
      // not flip just because the cap also fired.
      if (
        capped.exitCode === 0 &&
        (freshTestFailures(capped) || capped.swallowedFailure === true)
      ) {
        return {
          kind: 'command',
          text,
          verdict: 'contradicted',
          observed: freshTestFailures(capped)
            ? 'exit 0, but fresh Surefire/Failsafe reports record failures'
            : 'exit 0, but the output records failures the exit code did not fail on',
          note:
            `${runForm(capped).howItRan}, and the failure evidence it DID ` +
            'record is definitive — part of its fresh report evidence was never ' +
            'read (cap, parse rejection, or a truncated sweep), but that ' +
            'withholds certification of a pass, it does not excuse a recorded failure',
        };
      }
      return {
        kind: 'command',
        text,
        verdict: 'unchecked',
        note:
          `${runForm(capped).howItRan}; part of its fresh report evidence ` +
          'was never read (cap, parse rejection, or a truncated sweep), so the run was not certified',
      };
    }

    // The review may still have run Maven at a different scope or phase —
    // say so instead of asserting nothing ran.
    const anyMavenRun = [
      ...(buildTest?.build ?? []),
      ...(buildTest?.test ?? []),
    ].some((c) => c.maven !== undefined);
    return {
      kind: 'command',
      text,
      verdict: 'unchecked',
      note: anyMavenRun
        ? 'this Maven command was not run by this review — the Maven runs it made had a different scope or phase'
        : 'this Maven command was not run by this review',
    };
  }

  const script = npmScriptOf(text);
  if (!script) {
    return {
      kind: 'command',
      text,
      verdict: 'unchecked',
      note: 'not an npm script',
    };
  }
  // The root manifest's scripts read directly: `readRootPackage` returns null
  // when the root defines neither `build` nor `test` (it is scoped to those),
  // which would drop a root-only `lint`/`format` from `defined` and rule a
  // correct `npm run lint` claim `contradicted`.
  let rootScripts: string[] = [];
  try {
    const rootPkg = JSON.parse(
      readFileSync(join(worktree, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, unknown> };
    rootScripts = Object.keys(rootPkg.scripts ?? {});
  } catch {
    // No readable root manifest; workspace packages may still define scripts.
  }
  const defined = new Set<string>(rootScripts);
  const { packages, skipped } = readWorkspacePackages(worktree);
  for (const pkg of packages) {
    for (const s of pkg.scripts) defined.add(s);
  }
  // A skipped dir whose manifest still PARSES — no usable `name`, or shadowed
  // by a later glob — has a fully readable scripts table (scripts need no
  // `name` to enumerate), and discarding it would rule `unchecked` on evidence
  // this check actually holds. Merge those scripts; reserve `unchecked` for
  // the genuinely unreadable manifests.
  const unreadable: string[] = [];
  for (const dir of skipped) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(worktree, dir, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, unknown> } | null;
      for (const s of Object.keys(pkg?.scripts ?? {})) defined.add(s);
    } catch {
      unreadable.push(dir);
    }
  }
  // No manifest could be read at all (a tree this command cannot inspect):
  // absent evidence, not evidence of absence.
  if (defined.size === 0) {
    return {
      kind: 'command',
      text,
      verdict: 'unchecked',
      note: 'no package manifest could be read',
    };
  }
  if (defined.has(script)) {
    return {
      kind: 'command',
      text,
      verdict: 'reproduces',
      note: `\`${script}\` is a defined script`,
    };
  }
  // A workspace layout this check cannot model (`packages/**`, an inner or
  // prefix star) hides whole packages from the walker — they land in NEITHER
  // `packages` nor `skipped`, so the script table may be silently incomplete.
  // Absent evidence, not evidence of absence.
  if (hasUnmodeledWorkspaceGlob(readWorkspaceGlobs(worktree))) {
    return {
      kind: 'command',
      text,
      verdict: 'unchecked',
      note:
        'the workspace globs use a shape this check does not model, so the ' +
        'script table may be incomplete',
    };
  }
  // A member the graph could not read may still define it — the same rule as
  // the total absence above: absent evidence, not evidence of absence.
  if (unreadable.length > 0) {
    return {
      kind: 'command',
      text,
      verdict: 'unchecked',
      note:
        `${unreadable.join(', ')} ${unreadable.length === 1 ? 'has' : 'have'} a ` +
        'package.json this check could not read, so the script table may be ' +
        'incomplete',
    };
  }
  return {
    kind: 'command',
    text,
    verdict: 'contradicted',
    observed: 'no package defines this script',
    note: 'the Test Plan tells the reviewer to run a script that does not exist at the reviewed commit',
  };
}

function ruleCount(text: string, observed: number[]): TestPlanClaim {
  const claimed = Number(/(\d+)/.exec(text)?.[1]);
  if (!observed.length || !Number.isFinite(claimed)) {
    return {
      kind: 'count',
      text,
      verdict: 'unchecked',
      note: 'no suite in this review reported a pass count to compare against',
    };
  }
  if (observed.includes(claimed)) {
    return {
      kind: 'count',
      text,
      verdict: 'reproduces',
      observed: `${claimed} passed`,
      note: 'a suite this review ran reported the same count',
    };
  }
  return {
    kind: 'count',
    text,
    verdict: 'differs',
    observed: `${observed.join(', ')} passed`,
    // The header's reason, restated where the reader meets the verdict: this is
    // not a contradiction, because the two numbers may be about different suites.
    note: 'the suites this review ran reported a different count — they may not be the suite the Test Plan means',
  };
}

export interface TestPlanArgs {
  plan: string;
  pr: string;
  repo: string;
  worktree: string;
  out?: string;
  /**
   * yargs' camel-case expansion turns `--build-test` into `buildTest`; naming
   * the field for the flag would read `undefined` on every real invocation and
   * silently downgrade every count claim to `unchecked`.
   */
  buildTest?: string;
  host?: string;
}

/** Production reader: one `gh pr view` for the description body. */
function fetchPrBody(ownerRepo: string, prNumber: string): string {
  return gh(
    'pr',
    'view',
    prNumber,
    '--repo',
    ownerRepo,
    '--json',
    'body',
    '--jq',
    '.body',
  );
}

export function runTestPlan(
  args: TestPlanArgs,
  fetchBody: (ownerRepo: string, pr: string) => string = fetchPrBody,
): TestPlanReport {
  let plan: { files?: FileMetric[]; diffPathAbsolute?: unknown };
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  } catch (err) {
    throw new Error(
      `test-plan: cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }
  const diffHash = diffHashOf(plan.diffPathAbsolute);

  let body: string;
  try {
    body = fetchBody(args.repo, args.pr);
  } catch (err) {
    // A body we could not fetch is not a body with no Test Plan. Say which one
    // happened — `found: false` on a failed fetch would read as "the author
    // wrote no Test Plan", which is a different (and unearned) statement.
    return {
      found: false,
      claims: [],
      diffHash,
      note: `the PR description could not be fetched (${(err as Error).message.split('\n')[0]}); no Test Plan was checked`,
    };
  }

  const section = extractTestPlanSection(body ?? '');
  if (!section) {
    return {
      found: false,
      claims: [],
      diffHash,
      note: 'the PR description has no Test Plan section',
    };
  }

  const worktree = resolve(args.worktree);
  const changed = new Set(
    (plan.files ?? []).map((f) => normalize(String(f.path))),
  );
  let buildTest: BuildTestReport | null = null;
  if (args.buildTest) {
    try {
      buildTest = JSON.parse(
        readFileSync(args.buildTest, 'utf8'),
      ) as BuildTestReport;
    } catch {
      // Absent build/test evidence downgrades count and command claims to
      // `unchecked` on their own paths; it is not an error here.
      buildTest = null;
    }
  }
  const counts = observedTestCounts(buildTest);

  const claims = extractClaims(section.content).map((c) => {
    if (c.kind === 'path') return rulePath(c.text, worktree, changed);
    if (c.kind === 'command') return ruleCommand(c.text, worktree, buildTest);
    return ruleCount(c.text, counts);
  });

  const contradicted = claims.filter(
    (c) => c.verdict === 'contradicted',
  ).length;
  const differs = claims.filter((c) => c.verdict === 'differs').length;
  return {
    found: true,
    heading: section.heading,
    claims,
    diffHash,
    note: claims.length
      ? `checked ${claims.length} claim(s): ${contradicted} contradicted, ${differs} differing, ` +
        `${claims.filter((c) => c.verdict === 'reproduces').length} reproduced, ` +
        `${claims.filter((c) => c.verdict === 'unchecked').length} unchecked`
      : 'the Test Plan states no path, command, or count this command can check',
  };
}

export const testPlanCommand: CommandModule = {
  command: 'test-plan',
  describe:
    "Rule on the PR Test Plan's checkable claims (paths, npm scripts, test counts) against the reviewed tree",
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'The plan report from Step 1',
      })
      .option('pr', {
        type: 'string',
        demandOption: true,
        describe: 'PR number',
      })
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: 'owner/repo the PR belongs to',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe: "The PR's worktree — the tree claims are checked against",
      })
      .option('build-test', {
        type: 'string',
        describe:
          "Agent 7's build-test report; supplies the observed test counts and exit codes",
      })
      .option('out', { type: 'string', describe: 'Write the JSON report here' })
      .option('host', {
        type: 'string',
        describe: 'GitHub host for GitHub Enterprise (routes every gh call)',
      }),
  handler: (argv) => {
    const args = argv as unknown as TestPlanArgs;
    setGhHost(args.host);
    try {
      const report = runTestPlan(args);
      if (args.out) {
        mkdirSync(dirname(resolve(args.out)), { recursive: true });
        writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
      writeStderrLine(`test-plan: ${report.note}`);
    } catch (err) {
      // A missing/invalid plan makes `runTestPlan` throw. Emit the one-line
      // message and a non-zero exit (matching build-test and script-lint), not
      // yargs' stack trace — the orchestrator reads a clean error.
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
