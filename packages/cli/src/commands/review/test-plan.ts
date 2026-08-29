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
import { dirname, join, normalize, resolve } from 'node:path';
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
import type { BuildTestReport } from './build-test.js';
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

/** Runners whose presence makes a backticked span a command, not prose. */
const RUNNER_RE =
  /^(npm|npx|yarn|pnpm|bun|make|node|go|cargo|python3?|pytest)\b/;

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
      if (PATH_RE.test(t) && isPathClaim(t)) {
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
    // vitest: `Tests  472 passed (472)`. jest: `Tests:  12 passed, 12 total`.
    let total = 0;
    let saw = false;
    // `Tests  472 passed (472)`, `Tests: 12 passed, 12 total`, and multi-
    // segment forms like `Tests  2 failed | 3 skipped | 40 passed (45)` —
    // vitest separates with ` | `, jest with `, `.
    const re = /^\s*Tests:?\s+(?:\d+\s+\w+\s*[,|]\s*)*(\d+)\s+passed/gim;
    // Strip ANSI SGR sequences first. A real runner writes its summary through
    // a color-enabled pipe, so the kept text reads
    // `Tests\x1b[2m  \x1b[22m\x1b[1m3 failed\x1b[22m…` — the codes sit BETWEEN
    // the tokens, and no token-level regex survives that. Measured on a live
    // review of PR #8176: the count claim fell to `unchecked` with the summary
    // line right there in the report.
    // eslint-disable-next-line no-control-regex -- ESC is the character under test
    const text = (cmd.output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      total += Number(m[1]);
      saw = true;
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

function ruleCommand(
  text: string,
  worktree: string,
  buildTest: BuildTestReport | null,
): TestPlanClaim {
  // A command this review actually ran is settled by its exit code — the
  // strongest evidence available, and it needs no manifest lookup.
  const matches = [
    ...(buildTest?.build ?? []),
    ...(buildTest?.test ?? []),
  ].filter((c) => {
    const command = c.command.trim();
    const claimed = text.trim();
    // A workspace-scoped run (`npm run build --workspace=...`) still settles
    // the plan's bare command, so match it plus any extra flags — not only an
    // exact string. The space guard keeps `build` from matching `build:all`.
    return (
      command === claimed ||
      (command.startsWith(claimed) && command[claimed.length] === ' ')
    );
  });
  // build-test records one scoped command per package and does not stop on
  // failure, so a bare claim can match several runs. Prefer a failure: if ANY
  // scoped run failed, the phase failed, and the bare claim must read
  // `contradicted` — the first match could be a green package that merely
  // sorted first, stating the opposite of the authoritative `ok: false`.
  const ran =
    matches.find((c) => !c.timedOut && c.exitCode !== 0) ??
    matches.find((c) => !c.timedOut);
  if (ran) {
    return ran.exitCode === 0
      ? {
          kind: 'command',
          text,
          verdict: 'reproduces',
          observed: 'exit 0',
          note: 'this review ran it',
        }
      : {
          kind: 'command',
          text,
          verdict: 'contradicted',
          observed: `exit ${ran.exitCode}`,
          note: 'this review ran it and it failed',
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
