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

import { parse as parseShellQuote } from 'shell-quote';
import type { CommandModule } from 'yargs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { gh, setGhHost } from './lib/gh.js';
import { getPlatformReader } from './lib/platform/registry.js';
import { isGitIgnored } from '@qwen-code/qwen-code-core';
import { GIT_TIMEOUT_MS } from './lib/git.js';
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

// `mvn.cmd` is the spelling Windows `cmd.exe` users type for system Maven,
// and scoop/Chocolatey installs create an `mvn.exe` shim — the same suffix
// already granted `mvnd`/`mvnDebug`. The relative wrapper spellings —
// `./mvnw`, `.\mvnw`, and ANY mix of `./` and `../` hops (`../../mvnw` is
// a normal nested-module invocation two levels deep, `././mvnw` and
// `./../mvnw` are ordinary shell spellings) — are command claims exactly
// like the bare runner; without the hops such claims are silently never
// extracted and never ruled. They are modeled for the WHOLE runner
// vocabulary, not `mvnw` alone: `./mvnd test` is a command claim exactly
// like `./mvnw test`, and `./mvn` exactly like `mvn`.
const MAVEN_RUNNER_SOURCE =
  'mvn(?:\\.(?:cmd|exe))?|mvnd(?:\\.(?:cmd|exe))?|mvnDebug(?:\\.(?:cmd|exe))?|mvnw(?:\\.cmd)?' +
  '|(?:\\.{1,2}[/\\\\])+(?:mvn(?:\\.(?:cmd|exe))?|mvnd(?:\\.(?:cmd|exe))?|mvnDebug(?:\\.(?:cmd|exe))?|mvnw(?:\\.cmd)?)';

/** Runners whose presence makes a backticked span a command, not prose.
 *  The legacy runners stay case-sensitive: the script adjudicators are, so
 *  extracting capitalized prose spans (`Node 22`, `NPM RUN test:unit`) only
 *  added claims that can never settle. The Maven alternation is matched
 *  case-insensitively through MAVEN_RUNNER_RE: Windows authors type
 *  `MVNW test` and `mvnw.CMD test` (the filesystem is case-insensitive
 *  there), and a span the runner check rejects is a claim silently never
 *  extracted and never ruled. */
const RUNNER_RE = new RegExp(
  '^(?:npm|npx|yarn|pnpm|bun|make|node|go|cargo|python3?|pytest)\\b',
);

const MAVEN_RUNNER_RE = new RegExp(`^(?:${MAVEN_RUNNER_SOURCE})(?=\\s|$)`, 'i');

/**
 * True when a tokenized command line names lifecycle work beyond its runner:
 * any token after position 0 that is not a flag (flags start with `-`, and
 * the neutral flags a claim may carry are all flags too). A runner followed
 * only by flags — `./mvnw`, `./mvnw -q` — names no settleable work.
 */
function hasWorkBeyondRunner(tokens: string[]): boolean {
  return tokens.slice(1).some((token) => !token.startsWith('-'));
}

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
    // A bare Maven runner token WITHOUT a lifecycle phase (`./mvnw`) is a
    // FILENAME, not a command claim: the command reading can never settle
    // (no phase to compare against any recorded run) and it suppressed the
    // path verification the same token actually is — "added `./mvnw`" is a
    // claim about the tree. Spans naming WORK beyond the runner stay
    // commands; a work this review never runs reads `unchecked` there. A
    // runner followed only by neutral flags (`./mvnw -q`) names no work, so
    // it is not a command claim either — measuring token count, not work,
    // once classified it a command that could never settle while suppressing
    // the wrapper-existence path claim the span also is.
    const spanTokens = span.split(/\s+/);
    const mavenCommand =
      MAVEN_RUNNER_RE.test(span) && hasWorkBeyondRunner(spanTokens);
    if (RUNNER_RE.test(span) || mavenCommand) {
      push('command', span);
    }
    if (PATH_RE.test(span)) {
      if (isPathClaim(span)) push('path', span);
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
    // `./mvnw` is a runner — not a path claim — only when it LEADS a Maven
    // command line that names work: as an ARGUMENT of any other command
    // (`chmod +x ./mvnw`, `bash ./mvnw`) it unambiguously names a file in
    // the tree, and a runner with only neutral flags (`./mvnw -q`) carries
    // no settleable work — in both cases the wrapper-existence claim must
    // not be silently dropped.
    const runnerHead =
      MAVEN_RUNNER_RE.test(tokens[0] ?? '') && hasWorkBeyondRunner(tokens);
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
      if (PATH_RE.test(t) && isPathClaim(t) && !(i === 0 && runnerHead)) {
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
    // The same exclusion family ruleCommand applies to command claims
    // (finished() plus the exit-0 failure gate): an interrupted or
    // infrastructure-classified run is not a completed suite, and its
    // partial counts must not adjudicate a count claim. A fail-never run
    // that swallowed failures is the same — the field's contract forbids
    // ruling any claim reproduced against it — and so is a run whose
    // evidence the adapter refused to certify: part of it was never read.
    // An exit-0 run over fresh FAILING reports (swallowedReports) is a
    // failed run exactly like its command-claim twin: its derived pass
    // count once ruled a count claim `reproduces` while build-test marked
    // the same run ok:false. A plain non-zero exit is the commonest failed
    // shape — contribute counts only when the run finished green, mirroring
    // ruleCommand's green-settlement family.
    if (
      cmd.timedOut ||
      cmd.exitCode === null ||
      cmd.exitCode !== 0 ||
      cmd.infrastructure ||
      cmd.swallowedFailure ||
      cmd.evidenceCapped ||
      cmd.testsSuppressed ||
      cmd.neverRan ||
      cmd.swallowedReports
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
      /^\[maven-test-report\]\s+(.+?):\s+tests=(\d+),\s+failures=(\d+),\s+errors=(\d+),\s+skipped=(\d+)$/gim;
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
    // `-pl <modules> -am` also tests the UPSTREAM closure, and one rollup
    // line per project records it. A count claim about the changed modules
    // must be able to match their SUBTOTAL, not only the reactor-wide sum —
    // "42 tests pass" for module `core` otherwise reads `differs` against
    // a 187 total that includes upstream `common`'s 145, even though the
    // `-am` carve-out exists precisely because upstream evidence is out of
    // the claim's scope. Collect the per-project lines and emit both
    // readings; ruleCount settles on either.
    const moduleSet = cmd.maven?.modules ?? null;
    let moduleSubtotal = 0;
    let sawModuleLine = false;
    if (isMavenCommand) {
      while ((m = mavenRe.exec(text))) {
        // Surefire does not guarantee tests >= failures + errors + skipped
        // (class-level @Disabled and rerunFailingTestsCount reruns both perturb
        // it), and this sum spans every report of the command: one negative
        // value would silently cancel legitimate counts from its neighbours.
        const passed = Math.max(
          0,
          Number(m[2]) - Number(m[3]) - Number(m[4]) - Number(m[5]),
        );
        total += passed;
        saw = true;
        // The rollup lines append ` (N report(s))` to the project dir;
        // strip it to compare against the recorded module names. The
        // omitted-rollup marker lines carry no module attribution and
        // never match a `-pl` module name, so they stay in the total only.
        if (moduleSet !== null) {
          const project = m[1].replace(
            / \(\d+ (?:failing )?report\(s\)\)$/,
            '',
          );
          if (moduleSet.includes(project)) {
            moduleSubtotal += passed;
            sawModuleLine = true;
          }
        }
      }
    }
    if (saw) counts.push(total);
    if (sawModuleLine && moduleSubtotal !== total) counts.push(moduleSubtotal);
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
 * its Environment sections should not pay twice. The memo stays caller-side:
 * the shared helper is fresh-by-default because the audit guard's remedy
 * re-check must observe a flip.
 *
 * `--` before the path is belt-and-braces, and measured as such: `PATH_RE`'s
 * class admits a leading `-`, but no `-`-leading text survives extraction today
 * (`extractClaims('`-packages/old/gone.ts`')` returns nothing), so nothing
 * reaches `check-ignore` in OPTION position. It is one token against a future
 * extraction change, not a live hole. A non-zero exit means either "not
 * ignored" or "no git here"; both fall through to the ordinary ruling, which is
 * why this returns a plain boolean.
 *
 * The probe runs under GIT_TIMEOUT_MS, the same generous deadline every other
 * git invocation in these commands uses — it runs against a worktree the
 * review does not control, and a kill on a short deadline reads as "not
 * ignored", which turns a gitignored build output into a false `contradicted`
 * ruling in the presubmit report.
 */
function isGitIgnoredCached(worktree: string, path: string): boolean {
  const key = `${worktree}\0${path}`;
  const memo = ignoreCache.get(key);
  if (memo !== undefined) return memo;
  const ignored = isGitIgnored(worktree, path, GIT_TIMEOUT_MS);
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
  const ignored = isGitIgnoredCached(worktree, path);
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
  /^(?:deploy|site|site-deploy|pre-site|post-site|pre-clean|post-clean|prepare-package|pre-integration-test|integration-test|post-integration-test|initialize|process-resources|process-classes|process-test-classes|generate-sources|process-sources|generate-resources|generate-test-sources|process-test-sources|generate-test-resources|process-test-resources)$/;

/**
 * Boolean flags that change no outcome the review measures — batch mode and
 * transfer-progress suppression (the review's own command carries them),
 * verbosity and error stack traces, and the version banner that does not
 * stop the build (`-v`/`--version` DOES stop it and joins the zero-work
 * guards). A claim carrying one settles exactly like the claim without it.
 */
const NEUTRAL_MAVEN_FLAGS = new Set([
  '-B',
  '--batch-mode',
  '-ntp',
  '--no-transfer-progress',
  '-q',
  '--quiet',
  '-e',
  '--errors',
  '-X',
  '--debug',
  '-V',
  '--show-version',
]);

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
  // The password-encryption options consume their argument and perform
  // zero lifecycle work — reading that argument as a positional phase
  // settles claims that built and tested nothing.
  '-emp',
  '--encrypt-master-password',
  '-ep',
  '--encrypt-password',
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
  'encrypt-master-password',
  'encrypt-password',
  'batch-mode',
  'help',
  'version',
  'show-version',
  // The single-dash long spellings of the neutral flags the `--` set above
  // models: without them a claim carrying `-quiet` reads as unknown work and
  // never settles, while its `-q` twin settles — the docstring promise that
  // a neutral-flag claim settles like the claim without it, broken.
  'quiet',
  'errors',
  'debug',
  'no-transfer-progress',
  // The repository-layout flags: their single-dash long spellings start with
  // `-l` and must not bypass the scope/value checks modeled on the `--`
  // forms via the attached `-l` carve-out.
  'legacy-local-repository',
  'lax-checksums',
]);

function normalizeMavenSingleDashLongTokens(tokens: string[]): string[] {
  return tokens.map((token) => {
    const eq = token.indexOf('=');
    const head = eq === -1 ? token : token.slice(0, eq);
    if (
      head.length > 2 &&
      head.startsWith('-') &&
      !head.startsWith('--') &&
      MAVEN_SINGLE_DASH_LONGS.has(head.slice(1))
    ) {
      return `-${token}`;
    }
    return token;
  });
}

/**
 * shell-quote's parse() reduced to plain strings — the same word-splitting
 * a shell performs: quoted selectors arrive as one unquoted word (a quote
 * spanning a flag=value pair with a space, adjacent quoting like
 * `-pl core","other`, backslash escapes, and the `'\''` apostrophe dance
 * all resolve), and control operators and glob patterns survive as their
 * literal text so the grammar below treats them like any other unmodeled
 * token. `$NAME` references stay literal instead of expanding to empty.
 */
function shellTokens(text: string): string[] {
  const literalEnv = (name: string): string => `$${name}`;
  // shellQuotePath's `'\''` dance for dirs with an apostrophe is the ONE
  // escape sequence claims carry: substitute it before the parse, because
  // the parse runs with escaping disabled — backslashes elsewhere are
  // Windows path separators (`-pl .\core`), not shell escapes, and must
  // survive as literal text for the module-dir normalization below.
  const danced = text.replace(/'\\''/g, '\u0001');
  let parsed: ReturnType<typeof parseShellQuote>;
  try {
    parsed = parseShellQuote(danced, literalEnv, { escape: '\u0000' });
  } catch {
    // An unclosed `${` or an empty `${}` makes shell-quote throw
    // (`Bad substitution`); one malformed span — adversarial or a truncated
    // `${` log paste, common in Maven logs — otherwise aborted the ENTIRE
    // test-plan step and no claim in the plan was ruled. Fall back to
    // whitespace splitting, the pre-shell-quote behavior: the claim still
    // rules (unmodeled work reads `unchecked`) instead of never ruling.
    return text.split(/\s+/).filter((token) => token.length > 0);
  }
  return parsed.flatMap((entry): string[] => {
    // A quoted-empty word (`''`/`""`) is a REAL argv slot — bash hands Maven
    // `['test', '']` and Maven dies on `Unknown lifecycle phase ""`. Keeping
    // it (instead of the old length filter) lets the positional reach the
    // unknown-work check and refuse settlement, matching the shell.
    // eslint-disable-next-line no-control-regex -- the dance sentinel is the character under test
    if (typeof entry === 'string') return [entry.replace(/\u0001/g, "'")];
    if (typeof entry === 'object' && entry !== null) {
      if ('pattern' in entry && typeof entry.pattern === 'string') {
        return [entry.pattern];
      }
      if ('op' in entry && typeof entry.op === 'string') return [entry.op];
    }
    return [];
  });
}

/**
 * The tokens of a Maven command line that are not consumed as flag values.
 * shellTokens already resolved the quoting. A space-separated value flag
 * consumes the next token only when it is not itself option-like —
 * commons-cli's isArgument gate; an option-like next token is a missing
 * value, not a value — and the attached `<flag>=<value>` form carries its
 * value in-token.
 */
function mavenPositionalTokens(tokens: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (MAVEN_VALUE_FLAGS.has(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) i += 1;
      continue;
    }
    const eq = token.indexOf('=');
    if (
      eq > 0 &&
      token.startsWith('-') &&
      MAVEN_VALUE_FLAGS.has(token.slice(0, eq))
    ) {
      continue;
    }
    positional.push(token);
  }
  return positional;
}

/**
 * True when a value flag's value is missing — the command ends on the flag
 * itself (`mvn test -l`), or the next token is itself an option (`mvn
 * -l -am test` — `-am` is no log file). Real Maven's
 * commons-cli only consumes a next token that is not option-like (its
 * isArgument gate) and dies in argument parsing otherwise
 * (`MissingArgumentException`): zero lifecycle work runs, and the claim
 * names a command that cannot execute.
 */
function mavenDanglingValueFlag(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    // The attached `<flag>=<value>` form carries its value in-token, so
    // only the space-separated spelling can dangle.
    if (MAVEN_VALUE_FLAGS.has(tokens[i])) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith('-')) return true;
      i += 1;
    }
  }
  return false;
}

function mavenLifecycle(tokens: string[]): string | null {
  if (!MAVEN_RUNNER_RE.test(tokens[0] ?? '')) return null;
  // The LAST phase token that is not a flag value: that reads a phase-first
  // spelling (`mvnw test -pl core`) correctly and never mistakes a
  // phase-named `-pl` VALUE (`-pl test`) for the command's lifecycle.
  // Lowercased so a capitalized claim (`./mvnw TEST`) matches the
  // lowercase-only phase vocabulary consistently with the case-insensitive
  // runner extraction; the returned lifecycle is the canonical lowercase
  // form the settlement comparisons and the adapter's recorded lifecycle
  // use.
  let lifecycle: string | null = null;
  for (const token of mavenPositionalTokens(tokens)) {
    const lower = token.toLowerCase();
    if (MAVEN_PHASE_RE.test(lower)) lifecycle = lower;
  }
  return lifecycle;
}

const BARE_MAVEN_LIFECYCLE_RE = new RegExp(
  `^(?:${MAVEN_RUNNER_SOURCE})\\s+(clean|validate|compile|test-compile|test|package|verify|install)$`,
  'i',
);

function bareMavenLifecycle(command: string): string | null {
  return BARE_MAVEN_LIFECYCLE_RE.exec(command.trim())?.[1] ?? null;
}

/** True when a command carries `-am`/`--also-make` (upstream closure). */
function mavenHasAlsoMake(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // EVERY space-separated value flag's value is skipped, not just `-pl`'s:
    // a selector can carry `-am` inside a module dir name (`-pl 'foo
    // -am bar'` — spaces pass the POM entry gate), and a file named `-am`
    // handed to `-f` is a value the same way. shellTokens keeps a quoted
    // value one token; the isArgument gate consumes a plain-word next token
    // and leaves an option-like one unconsumed — the command is dangling
    // there anyway (mavenDanglingValueFlag), so the flag is never read.
    if (MAVEN_VALUE_FLAGS.has(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) i += 1;
      continue;
    }
    const eq = token.indexOf('=');
    if (
      eq > 0 &&
      token.startsWith('-') &&
      MAVEN_VALUE_FLAGS.has(token.slice(0, eq))
    ) {
      continue;
    }
    if (token === '-am' || token === '--also-make') return true;
  }
  return false;
}

/** The module set of a command's `-pl`/`--projects` selector, sorted. */
function mavenPlModules(tokens: string[]): string[] | null {
  // Maven ACCUMULATES repeated `-pl` (commons-cli `getOptionValues`):
  // `mvn -pl m1 -pl m2` builds both modules, so every occurrence joins the
  // set — keeping only the last read a claim that covered m1 as scoped to
  // m2 alone.
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let raw: string | undefined;
    // Advance BEFORE reading, like the sibling token walkers, and with the
    // same isArgument gate: an option-like next token is a missing value,
    // not a selector.
    if (token === '-pl' || token === '--projects') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        i += 1;
        raw = next;
      }
    } else if (token.startsWith('-pl=')) raw = token.slice('-pl='.length);
    else if (token.startsWith('--projects=')) {
      raw = token.slice('--projects='.length);
    } else if (MAVEN_VALUE_FLAGS.has(token)) {
      // The OTHER space-separated value flags consume their own values:
      // `mvn -l -pl test` hands `-pl` to `-l` as its log file, so the `-pl`
      // token must not be read a second time as a selector — the double
      // read yielded lifecycle `test` AND a phantom module set `['test']`,
      // settling the claim as module-scoped when real Maven ran it
      // reactor-wide (or died in argument parsing).
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) i += 1;
      continue;
    }
    if (raw === undefined) continue;
    // shellTokens already resolved the quoting — space-bearing selectors,
    // adjacent quoting, and the `'\''` apostrophe dance all arrive as one
    // plain unquoted word, so the value splits on `,` as-is.
    values.push(raw);
  }
  if (values.length === 0) return null;
  const modules = [
    ...new Set(
      values
        .flatMap((value) => value.split(','))
        .map((module) => {
          // Windows backslash selectors (`.\core`) and trailing-slash
          // spellings (`core/`) name the same module dir as their POSIX
          // twins; normalize them so the claim can settle against the
          // recorded dir instead of silently discarding its evidence.
          const unquoted = module
            .trim()
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

/**
 * The file a compiler-error line names: every shape `isSourceFailureLine`
 * recognizes carries a JVM source path followed by a line/column.
 */
const SOURCE_FAILURE_PATH_RE =
  /^\[(?:ERROR|FATAL)\] .*?((?:[A-Za-z]:)?\/.*?\.(?:java|kts?|scala|groovy))(?=:(?:\[|\s?\(|\s?\d))/;

function sourceFailurePath(line: string): string | null {
  return SOURCE_FAILURE_PATH_RE.exec(line.replace(/\\/g, '/'))?.[1] ?? null;
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
  // shell-quote splits the claim like a shell would (see shellTokens):
  // quoted flag=value pairs and selectors stay one word, so normalization
  // and every scope walker below read the words a shell would hand Maven.
  // Maven's commons-cli ALSO accepts single-dash spellings of its long
  // options; normalize them to the `--` forms so they cannot bypass the
  // grammar below. Both applied to Maven claims only — the comparison
  // against recorded commands is unaffected, because the adapter never
  // renders those spellings. `claimed` keeps the RAW text for the
  // exact/prefix comparison against recorded command lines, which carry
  // their own quoting from shellSelector.
  const mavenClaim = MAVEN_RUNNER_RE.test(rawClaimed);
  const claimTokenList = mavenClaim
    ? normalizeMavenSingleDashLongTokens(shellTokens(rawClaimed))
    : rawClaimed.split(/\s+/);
  const claimed = rawClaimed;
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
  const claimedLifecycle = mavenLifecycle(claimTokenList);
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
    // The repository-layout flags change resolution behavior (legacy local
    // repository layout, lax checksums): a claim carrying one cannot settle
    // on a run that never used it. They are NOT the neutral `-l` log-file
    // family — the modeledMavenOption carve-out below must not swallow them,
    // and the single-dash long spellings are normalized above.
    token === '-llr' ||
    token === '--legacy-local-repository' ||
    token === '--lax-checksums' ||
    // fail-never makes Maven exit 0 over failures it would otherwise die
    // on: a claim carrying it cannot settle on a run that never used it —
    // the run's recorded exit codes are ones the claimed command cannot
    // produce. The single-dash long spelling is normalized above.
    token === '-fn' ||
    token === '--fail-never' ||
    // The password-encryption options and the usage/version printers
    // perform zero lifecycle work: a claim carrying one cannot settle on a
    // run that executed phases, and the attached/commons-cli separator-less
    // spellings carry the same scope. `-V`/`--show-version` deliberately
    // stays neutral — it prints the version WITHOUT stopping the build.
    token.startsWith('-emp') ||
    token.startsWith('-ep') ||
    token === '-h' ||
    token === '--help' ||
    token === '-v' ||
    token === '--version' ||
    token === '--encrypt-master-password' ||
    token.startsWith('--encrypt-master-password=') ||
    token === '--encrypt-password' ||
    token.startsWith('--encrypt-password=') ||
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
  // shellTokens already stripped the quoting: `mvn "-pl" core test` carries
  // the same scoping as the unquoted spelling.
  const claimTokens = claimTokenList;
  // Lifecycle phases the claim names, in order: a multi-phase claim
  // (`clean test`) runs phases the recorded single-phase run never did.
  // Flag values are excluded: a module dir named `test` handed to `-pl` is
  // a selector, not a claimed phase. Out-of-vocabulary WORK counts too
  // (`mvn deploy test`, a leading plugin goal): it never ran here, and
  // settling the trailing phase without disclosing the reduction would
  // overstate the evidence.
  const positionalTokens = mavenPositionalTokens(claimTokenList);
  // Phase tests lowercase the token so a capitalized claim matches the
  // lowercase-only vocabularies consistently with the runner extraction.
  const claimPhases = positionalTokens.filter(
    (token) =>
      MAVEN_PHASE_RE.test(token.toLowerCase()) ||
      MAVEN_UNRUN_WORK_RE.test(token.toLowerCase()) ||
      (!token.startsWith('-') && token.includes(':')),
  );
  // Maven dies on 'Unknown lifecycle phase' for any bare positional outside
  // its lifecycle vocabulary (the settlement phases plus the default-
  // lifecycle phases MAVEN_UNRUN_WORK_RE models), and on 'Unable to parse
  // command line options' for any option it does not have (`mvn foo test`
  // and `mvn test --verbose` run no work): the settlement invariant the
  // comment above states for trailing and unrun work applies to mid-position
  // junk of BOTH kinds, or the claim settles `reproduces` over a command
  // that errored out. Position 0 is the runner itself, which names no
  // lifecycle work.
  // A dash token real Maven accepts: a value flag (the space-separated form
  // is consumed before the positionals; the attached spellings carry their
  // value in-token), a boolean flag scopesNonPl or mavenHasAlsoMake models,
  // or a neutral flag that changes no outcome the review measures.
  const modeledMavenOption = (token: string): boolean =>
    MAVEN_VALUE_FLAGS.has(token) ||
    scopesNonPl(token) ||
    token === '-am' ||
    token === '--also-make' ||
    NEUTRAL_MAVEN_FLAGS.has(token) ||
    // The `-l` family's attached spelling (`-lbuild.log`): `-l` is the one
    // value flag scopesNonPl leaves out on purpose, so its attached form
    // would otherwise read as an unknown option.
    (token.startsWith('-l') && token !== '-l');
  const unknownWork = positionalTokens
    .slice(1)
    .some((token) =>
      token.startsWith('-')
        ? !modeledMavenOption(token)
        : !MAVEN_PHASE_RE.test(token.toLowerCase()) &&
          !MAVEN_UNRUN_WORK_RE.test(token.toLowerCase()) &&
          !token.includes(':'),
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
  // Lowercased to match the canonical lowercase lifecycle the settlement
  // comparisons use (a capitalized claim's final work still compares equal).
  const claimFinalWork = positionalTokens
    .filter((token) => !token.startsWith('-'))
    .at(-1)
    ?.toLowerCase();
  // A value flag missing its value (`mvn test -l`) dies in Maven's argument
  // parsing before any lifecycle work — the claim settles nothing, exactly
  // like unknown work.
  const danglingValueFlag =
    mavenClaim && mavenDanglingValueFlag(claimTokenList);
  const claimPlModules = mavenPlModules(claimTokenList);
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
    !unknownWork &&
    !danglingValueFlag &&
    c.maven?.lifecycle === claimedLifecycle;
  const settledBySameScope = (c: CommandResult): boolean =>
    claimOnlyPlScoped &&
    claimedLifecycle !== null &&
    claimFinalWork === claimedLifecycle &&
    !unknownWork &&
    !danglingValueFlag &&
    c.maven?.lifecycle === claimedLifecycle &&
    sameModuleSet(c.maven?.modules ?? null, claimPlModules);
  // A run this review itself classified as infrastructure (a timeout, a
  // spawn-level death, a Maven acquisition failure) is the same evidence the
  // build-test note disavowed as environmental — it must not settle a claim.
  // Neither may a run whose evidence the adapter refused to certify: part
  // of it was never read.
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
    // (`[ERROR] /wt/core/src/…/Foo.java:[10,5] …`). Attribute the file to
    // the module that OWNS it — its nearest pom.xml-bearing ancestor — not
    // to whichever claimed dir the path happens to sit beneath: a module
    // literally named `src` (or a `<module>src/core</module>` layout) sits
    // beneath `<worktree>/src/` but is not the root project, and `-am` can
    // pull in modules the claim never names. A failure the claim's own
    // command would share is one inside a module it DOES name.
    const worktreePosix = worktree.split(sep).join('/');
    // The owning module of a worktree-relative file: its nearest pom.xml-
    // bearing ancestor. Null when the tree carries no pom.xml at all —
    // ownership is unknowable there, and attribution falls back to the
    // module-prefix reading.
    const owningModuleOf = (rel: string): string | null => {
      const segments = rel.split('/');
      for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
        const dir = segments.slice(0, depth).join('/');
        // Match the adapter's ownership model: a POM beneath a `src/` tree
        // is maven-invoker/archetype test data, not a reactor member, so it
        // must not re-own a failure out of the real module — a PR could
        // otherwise plant an unreferenced src-nested pom.xml to shift
        // attribution and make the carve-out discard an in-claim failure.
        if (/(?:^|\/)src\//.test(dir)) continue;
        try {
          if (statSync(join(worktree, dir, 'pom.xml')).isFile()) {
            return dir === '' ? '.' : dir;
          }
        } catch {
          // no pom.xml at this depth
        }
      }
      return null;
    };
    if (
      lines.some((line) => {
        if (!isSourceFailureLine(line)) return false;
        const path = sourceFailurePath(line);
        if (path === null || !path.startsWith(`${worktreePosix}/`)) {
          return false;
        }
        const rel = path.slice(worktreePosix.length + 1);
        const owner = owningModuleOf(rel);
        return claimPlModules.some((module) =>
          owner !== null
            ? owner === module
            : module === '.'
              ? rel.startsWith('src/')
              : rel.startsWith(`${module}/`),
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
    // A claim without `-am` settling on an `-am` run: the recorded run
    // resolved inter-module dependencies from the reactor while the claim's
    // bare command resolves them from the local repository — the note must
    // not read as if the exact command ran.
    const alsoMakeAsymmetry =
      scoped && c.maven?.alsoMake === true && !mavenHasAlsoMake(claimTokenList);
    const asymmetry = alsoMakeAsymmetry
      ? ', with the upstream closure (`-am`) the claim does not name'
      : '';
    // A multi-phase claim (`clean test`) settles on its FINAL phase when
    // it carries no scoping of its own — the adapter only ever runs
    // `test` or `test-compile`, so the note must not read as if the
    // earlier phases ran.
    const phaseReduced =
      (settledReduced || settledBySameScope(c)) && claimPhases.length > 1;
    const howItRan =
      scoped && phaseReduced
        ? `this review ran a module-scoped form of its final phase (\`${claimedLifecycle}\`), ` +
          `not the full \`${claimPhases.join(' ')}\` it claims${asymmetry}`
        : scoped
          ? `this review ran a module-scoped form of it${asymmetry}`
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
    // A CAPPED run is NEVER carved: its markers are incomplete by
    // construction (a rejected report emits none, and upstream markers do
    // not prove the claimed module also passed), so whether the failure
    // lives inside the claim is unknowable — keep it in `matches` and let
    // the capped cascade rule the non-zero exit definitive.
    // A suppressed run is carved (excluded) only when the suppression is a
    // GLOBAL skip — then nothing was tested anywhere. A module-local skip
    // seen only in stdout can live in an upstream module while the claimed
    // module ran green, so carving it like other failure evidence avoids a
    // manufactured "nothing was tested" contradiction.
    return !(
      settledBySameScope(c) &&
      c.maven?.alsoMake === true &&
      !mavenHasAlsoMake(claimTokenList) &&
      // An infrastructure run cannot contradict — the cascade's
      // environmental arm is its only consumer — so the carve-out must not
      // hide a capped one from that arm.
      !c.infrastructure &&
      (finished(c) || c.evidenceCapped === true) &&
      ranFailed(c) &&
      // A wrapper that never started Maven cannot live in an upstream
      // module: it applies to the claim's own command at any scope, so the
      // exclusion must not discard it.
      !c.neverRan &&
      // Suppression: only a GLOBAL skip is kept out of the carve-out (nothing
      // was tested anywhere); a stdout-only module-local skip is carved.
      (!c.testsSuppressed || c.maven?.globalSkip !== true) &&
      !failureInsideClaim(c) &&
      c.evidenceCapped !== true
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
            !mavenHasAlsoMake(claimTokenList) &&
            !failureInsideClaim(c)
          ),
      )
    : undefined;
  // A run whose evidence was capped can still carry DEFINITIVE failure
  // proof: a non-zero exit (the cap withholds certification of a pass, it
  // does not retroactively excuse a failure), or exit-0 failure evidence
  // the cap's own cause cannot defeat (markers from reports the sweep DID
  // parse, or failures a fail-never setting swallowed). `neverRan` is NOT
  // in this set: the states that fire `evidenceCapped` — a fresh report
  // rejected, a truncated sweep — are positive proof the toolchain DID
  // start, defeating the zero-summaries inference `neverRan` is built on.
  // Ranked ABOVE the green finished fallback: one green finished sibling
  // matching the same claim otherwise shadows the capped run and reads the
  // claim `reproduces` — the exact shadowing this ranking exists to
  // forbid. The capped cascade below rules the identical shapes with the
  // identical wording when no sibling matches, so the verdict cannot flip
  // on which other runs the claim matched.
  const cappedDefinitiveRuling = (c: CommandResult): TestPlanClaim | null => {
    // A run this review classified as an environmental acquisition failure
    // must not settle a claim, capped or not — the same exclusion arms 1/2/4
    // apply via `finished()` or an explicit check. Without this guard the
    // non-zero-exit arm below settles such a run `contradicted` whenever it
    // also carries `evidenceCapped`, laundering an environmental death into
    // a definitive ruling.
    if (c.infrastructure === true) return null;
    // A never-ran run is not definitive either, capped or not: the cap can
    // fire on `rescueOverflow` from a stub wrapper's OWN output, which is
    // not proof the toolchain started. Returning a ruling here would
    // contradict that with wording describing a run that started; instead
    // fall through to the capped cascade, which rules such a run
    // `unchecked` with the capped-evidence note (the "Maven never started"
    // wording lives only in the finished-run exit-0 arm, unreachable for a
    // capped run).
    if (c.neverRan === true) return null;
    if (c.exitCode !== null && c.exitCode !== 0) {
      return {
        kind: 'command',
        text,
        verdict: 'contradicted',
        observed: `exit ${c.exitCode}`,
        note:
          `${runForm(c).howItRan}, and it failed — part of its ` +
          'evidence was never read (rejected or unseen fresh reports, or the ' +
          'trim rescue cap), but the non-zero exit is definitive',
      };
    }
    if (
      c.exitCode === 0 &&
      (freshTestFailures(c) || c.swallowedFailure === true)
    ) {
      // The observed/note split mirrors the finished path's exit-0 arm:
      // the cap must not change WHICH failure the evidence records.
      const observed = freshTestFailures(c)
        ? 'exit 0, but fresh Surefire/Failsafe reports record failures'
        : c.testsSuppressed
          ? 'exit 0, but a skip setting suppressed the test phase — nothing was tested'
          : 'exit 0, but the output records failures the exit code did not fail on';
      const cause = freshTestFailures(c)
        ? 'fresh test reports record failures despite the zero exit'
        : c.testsSuppressed
          ? 'a skip setting suppressed the test phase — nothing was tested'
          : 'the run recorded failures despite the zero exit';
      return {
        kind: 'command',
        text,
        verdict: 'contradicted',
        observed,
        note:
          `${runForm(c).howItRan}, and ${cause} — part of its ` +
          'evidence was never read (rejected or unseen fresh reports, or the ' +
          'trim rescue cap), but that withholds ' +
          'certification of a pass, it does not excuse what the run DID record',
      };
    }
    return null;
  };
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
    matches.find(
      (c) =>
        !c.infrastructure &&
        c.evidenceCapped === true &&
        cappedDefinitiveRuling(c) !== null,
    ) ??
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
    if (ran.evidenceCapped === true) {
      // The ranking above only admits capped runs with a definitive ruling.
      const definitive = cappedDefinitiveRuling(ran);
      if (definitive) return definitive;
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
          observed:
            ran.exitCode === null
              ? 'it ended without an exit code'
              : `exit ${ran.exitCode}`,
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
    // name the reason rather than letting the claim fall through to the
    // "not run" wording, which would misstate what happened.
    const capped = matches.find((c) => c.evidenceCapped);
    if (capped) {
      // The definitive shapes — a non-zero exit, or exit-0 failure evidence
      // the cap cannot defeat — rule through the shared helper, the same
      // ruling the ranking above hands them when a sibling matches.
      // `neverRan` is deliberately NOT definitive here: the states that
      // fire the cap (a rejected fresh report, a truncated sweep) are
      // positive proof the toolchain DID start, which defeats the
      // zero-summaries inference `neverRan` rests on — a capped never-ran
      // run reads unchecked, never contradicted.
      const definitive = cappedDefinitiveRuling(capped);
      if (definitive) return definitive;
      return {
        kind: 'command',
        text,
        verdict: 'unchecked',
        note:
          `${runForm(capped).howItRan}; part of its evidence was never ` +
          'read (rejected or unseen fresh reports, or the trim rescue cap), so the run was not certified',
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

/** Production reader for GitHub: one `gh pr view` for the description body. */
export function fetchPrBody(ownerRepo: string, prNumber: string): string {
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

/**
 * The body fetcher the target's platform backs: on Aone, the MR description
 * from the platform reader's fetch metadata — the same `a1 repo mr view`
 * fetch the read path already relies on, so routing the Test Plan through
 * it adds no new API surface; on GitHub, the `gh pr view` above. Detection
 * is the registry's (`--host` hint, else the cwd clone's origin).
 */
export function platformBodyFetcher(
  host?: string,
): (ownerRepo: string, prNumber: string) => string {
  const platform = getPlatformReader({ host });
  if (platform.kind !== 'aone') return fetchPrBody;
  // The auth gate every other a1-backed flow runs BEFORE its platform call
  // — presence, the version floor, and the login check. Without it a
  // standalone invocation on a missing/stale/logged-out a1 exits 0 with the
  // generic "could not be fetched" note and no remedy; with it, the three
  // states fail with the actionable install/upgrade/login messages the user
  // docs promise ("at authentication time"). The GitHub arm keeps its
  // historical degrade (a failed `gh pr view` reads as the unchecked note).
  platform.ensureAuthenticated();
  return (ownerRepo: string, prNumber: string): string => {
    // The a1 seam is addressed by number; classify a malformed id before
    // the fetch so the degraded note names the invocation, not a platform
    // error. Decimal shape first — a bare `Number()` admits '0x10'/'1e3'/
    // ' 7 ' and would silently fetch a DIFFERENT MR; isSafeInteger (the
    // pipeline's isDiffLine gate) rejects a digit run past 2^53 that would
    // double-round the same way.
    const n = Number(prNumber);
    if (!/^\d+$/.test(prNumber) || !Number.isSafeInteger(n) || n <= 0) {
      throw new TypeError(
        `expected a positive MR id, got ${JSON.stringify(prNumber)}`,
      );
    }
    return platform.getFetchMeta(n, ownerRepo).body ?? '';
  };
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
        describe:
          "The host the target lives on. The canonical Aone hosts (code.alibaba-inc.com / gitlab.alibaba-inc.com) select the a1 backend (the body is the MR description) — a non-canonical *.alibaba-inc.com host is a GitHub Enterprise instance and stays on gh; omitted: detected from the clone's origin, else GitHub (GH_HOST, then github.com).",
      }),
  handler: (argv) => {
    const args = argv as unknown as TestPlanArgs;
    setGhHost(args.host);
    try {
      const report = runTestPlan(args, platformBodyFetcher(args.host));
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
