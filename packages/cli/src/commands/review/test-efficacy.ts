/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review test-efficacy`: does the diff's new test actually gate the
// diff's new behaviour?
//
// Agent 5 and the test-coverage matrix ask whether a test EXISTS and whether
// its assertions look like they check something. Neither question can catch the
// two ways a test ships without protecting anything:
//
//   1. UNREACHABLE — the project's test command never runs the file. On PR
//      #6486 the new test lived in `integration-tests/`, which is not an npm
//      workspace, so `npm test --workspaces` never collected it; and its CI job
//      (`Integration Tests (CLI, No Sandbox)`) was skipped. The test executed
//      nowhere, in CI or in review, and nothing noticed.
//   2. INERT — it runs, it passes, and it would still pass with the source
//      change reverted. #6486's did: it drove a kitty CSI-u sequence into a PTY
//      that never negotiated the kitty protocol, so the keypress was discarded
//      before it could reach the handler under test. The test could only ever
//      have caught a startup crash.
//
// Both are decidable without judgment, which is why they live here in TypeScript
// rather than in a review agent's prompt. Findings carry `Source: [test]` and
// are pre-confirmed like Agent 7's — they are the outcome of running commands,
// not of reading code.
//
// The revert probe is the load-bearing half, and its trap is the third outcome:
// reverting the source can make the test fail to COMPILE (it imports a symbol
// the new code introduced). That failure is not evidence the test gates
// anything, and calling it "gated" would be exactly the false assurance this
// command exists to remove. So `gated` requires a real assertion failure, and
// everything else that is not a clean pass is `inconclusive`.
//
// The revert probe is also ALL-OR-NOTHING, and a live dogfood found the gap
// that leaves. A PR's file carried six well-tested behaviours and one untested
// safety statement; reverting the whole file went red on the six — "gated" —
// while deleting just the one statement (a `reminders.clear()` in a
// not-continued branch) left the entire 471-test suite green. The PR's headline
// invariant had zero coverage and both probes were structurally blind to it. So
// a third probe runs statement-level deletion MUTANTS over the diff's added
// lines, restricted to a high-precision set of safety verbs. A mutant the suite
// never notices — a SURVIVOR — is a finding: the invariant that statement
// enforces has no test that would fail without it. The third-outcome discipline
// applies here too: a mutant that breaks the compile is `inconclusive`, never
// `killed`.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { dirname, join, isAbsolute, sep } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { probeWorktreePath } from './lib/paths.js';
import { isWorkspaceMember } from './lib/workspaces.js';

export type ProbeVerdict = 'gated' | 'inert' | 'inconclusive';

export interface FileEntry {
  path: string;
  kind: string;
}

// `isWorkspaceMember` now lives in `lib/workspaces.ts`, where `build-test` needs
// the same npm-workspace-glob walk to decide which packages a diff touches.
// Imported (this module still calls it) and re-exported (its tests and callers
// still import it from here).
export { isWorkspaceMember };

export interface EfficacyPlan {
  /** Test files the diff adds or changes that the test command never collects. */
  unreachable: string[];
  /** Test files worth probing — they are reachable, so they can be run. */
  probes: string[];
  /** Production files to revert to base for the probe. */
  revert: string[];
}

/**
 * Test-support data a test file imports: fixtures, mocks, snapshots. Reverting
 * one is both meaningless (it holds no behaviour) and destructive — this PR
 * ships `__fixtures__/pr-6486-comment-4942713150.md`, and deleting it makes
 * `pr-context.test.ts` fail to load, an inconclusive probe caused by the probe
 * itself.
 *
 * The discriminator is the **directory**, not the extension. An earlier cut
 * whitelisted executable extensions, which also dropped runtime-loaded sources
 * that a test genuinely gates: an executable skill prompt
 * (`packages/core/src/skills/**\/SKILL.md`), a settings-schema JSON a test
 * validates against. Those are production source and must stay revertable;
 * only test-support data under a fixtures/mocks/snapshots path is excluded.
 */
const FIXTURE_DIR_RE =
  /(^|\/)(__fixtures__|__mocks__|__snapshots__|fixtures)\//;

/**
 * Split the diff into what to report and what to run.
 *
 * A diff with no source changes has nothing to gate, so it gets no probe: a
 * test-only PR (a new test for old code) must not be told its tests are inert.
 */
export function planTestEfficacy(
  files: FileEntry[],
  workspaceGlobs: string[],
): EfficacyPlan {
  const tests = files.filter((f) => f.kind === 'test').map((f) => f.path);
  // `kind === 'source'` is the diff-plan bucket for "not test/doc/generated",
  // which sweeps in test-support data a test imports. Reverting a fixture is
  // meaningless and destructive (a test that loads it then fails), so exclude
  // the fixture/mock directories — but keep everything else, including
  // runtime-loaded prompts and config a test genuinely gates.
  const revert = files
    .filter((f) => f.kind === 'source' && !FIXTURE_DIR_RE.test(f.path))
    .map((f) => f.path);
  const unreachable = tests.filter(
    (t) => !isWorkspaceMember(t, workspaceGlobs),
  );
  const reachable = tests.filter((t) => isWorkspaceMember(t, workspaceGlobs));
  return {
    unreachable,
    probes: revert.length > 0 ? reachable : [],
    revert,
  };
}

export type MutantVerdict = 'killed' | 'survived' | 'inconclusive';

export interface MutantCandidate {
  file: string;
  /** 1-based line number in the post-change file. */
  line: number;
  /** The statement's text, trimmed — quoted back verbatim in the report. */
  statement: string;
}

export interface MutantResult extends MutantCandidate {
  verdict: MutantVerdict;
  detail: string;
}

/**
 * At most this many deletion mutants per run. Every mutant is a full vitest run
 * over the affected test files, so the cap — not the candidate count — is what
 * keeps this command inside its budget on a diff that clears eight Maps.
 */
export const MAX_MUTANTS = 8;

/** Deadline for one vitest run (baseline, mutant, or revert probe alike). */
const PROBE_RUN_TIMEOUT_MS = 300_000;

/**
 * Whole-command budget. Agent 7 invokes review commands with the 600s
 * (600000ms) tool timeout; staying strictly below it means the budget cutoff in
 * the mutant loop — which reports HOW MANY mutants it skipped — fires before
 * the harness kills the process and reports nothing at all.
 */
const TOTAL_BUDGET_MS = 540_000;

/**
 * Slack added to the measured baseline duration when pricing a mutant run: a
 * killed mutant's run is about as long as a green one, but vitest startup and
 * the restore write jitter, and an estimate that runs hot skips a mutant it
 * could have fit — cheaper than blowing the deadline on one it could not.
 */
const RUN_ESTIMATE_MARGIN_MS = 15_000;

/**
 * The statements worth mutating: calls that discard, detach or reset state, and
 * reassignment to an empty collection. Deliberately high-precision — every
 * selected line costs a full suite run, so this matches the safety-verb shapes
 * whose deletion is (a) silent at compile time and (b) exactly the kind of
 * cleanup a test suite forgets to gate. Matched against the TRIMMED line.
 */
const SAFETY_VERB_RE =
  /\.(?:clear|delete|reset|abort|removeListener|unref)\(|=\s*\[\]\s*;$|=\s*new\s+(?:Map|Set|WeakMap|WeakSet)(?:<[^=;]*>)?\(\)\s*;$/;

/**
 * Files a deletion mutant can run in: TS/JS production source (not `.d.ts` —
 * declarations never execute). The revert set also carries runtime-loaded prose
 * and config (an executable SKILL.md, a schema JSON); deleting a line of prose
 * never breaks anything the runner sees, so every such mutant would "survive"
 * and file a false finding.
 */
const MUTANT_SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;

/**
 * Line starts that are not deletable expression statements: declarations,
 * control-flow headers, and clause keywords. Class-member modifiers are in the
 * list because a class field (`private timers = new Map();`) looks exactly like
 * an assignment statement from one line away.
 */
const NON_STATEMENT_START_RE =
  /^(?:const|let|var|function|class|interface|type|enum|import|export|return|throw|yield|if|for|while|switch|do|else|try|catch|finally|case|default|break|continue|async|public|private|protected|readonly|static)\b/;

/**
 * Skip a template literal that opens at `line[start]`. Returns the index of
 * its closing backtick, or -1 when it does not close on this line. Tracks
 * `${…}` interpolation brace depth so a backtick seen inside an interpolation
 * opens a NESTED template and is never mistaken for the outer close — without
 * this, everything after the nested backtick (its string content included)
 * reads as code. Approximate by construction (a `}` in a nested template's
 * text, or in a string inside the interpolation, still miscounts), but the
 * approximation only mis-scans shapes the delimiter check then rejects.
 */
function skipTemplateOnLine(line: string, start: number): number {
  let depth = 0;
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
    } else if (depth === 0) {
      if (ch === '`') return i;
      if (ch === '$' && line[i + 1] === '{') {
        depth = 1;
        i++;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
  }
  return -1;
}

/**
 * Scan one line's code, skipping string literals and comments. Returns `null`
 * when the line cannot be judged in isolation — an unterminated string or block
 * comment (it continues on another line), or a closer without an opener (the
 * line is the tail of a multi-line expression). A regex literal containing a
 * quote or bracket can confuse this scanner, but only toward rejection or a
 * mutant that fails to compile (`inconclusive`) — never toward a false finding.
 */
function scanLineDelimiters(
  line: string,
): { paren: number; bracket: number; brace: number } | null {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '`') {
      const close = skipTemplateOnLine(line, i);
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < line.length && line[i] !== ch) {
        if (line[i] === '\\') i++;
        i++;
      }
      if (i >= line.length) return null;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    if (paren < 0 || bracket < 0 || brace < 0) return null;
  }
  return { paren, bracket, brace };
}

interface FileScan {
  /** Per line: does it START inside a template literal or block comment? */
  inLiteral: boolean[];
  /** Per line: its code portion — comments stripped, literal contents blanked
   *  (delimiters kept), trimmed. */
  codeLines: string[];
  /** The scanner's state at EOF. A non-`code` end means a regex literal or
   *  similar shape derailed the scan — every later line's `inLiteral` is
   *  suspect, so the caller discards the file's candidates. */
  endState: 'code' | 'template' | 'comment';
}

/**
 * One pass over the whole file, feeding every text check mutant selection runs.
 *
 * `inLiteral`: without it, a safety-verb line inside a multi-line template (an
 * agent-brief string, a here-doc in a test) or a commented-out block would be
 * "deleted" without changing any behaviour — a guaranteed false survivor.
 * Interpolations (`${…}`) are treated as still-template, tracked with a STACK
 * of frames — one per open template literal: `${` opens an interpolation on
 * the innermost template, a backtick inside an interpolation opens a NESTED
 * template, a `}` only closes the interpolation at the top of the stack, and a
 * backtick in template text only closes the CURRENT template, never an outer
 * one. A depth counter cannot represent this: a `}` in a nested template's
 * TEXT drained it to zero, so the nested template's closing backtick read as
 * the OUTER close and the outer literal's remaining text was admitted as code
 * — still-template can only skip a candidate, never admit one.
 * Quotes inside an interpolation are deliberately not skipped: a regex literal
 * (`/'/g`) is not a string, and skipping to its matching quote runs past the
 * interpolation's own `}`, derailing the scan and dropping every later candidate
 * in the file. A `}` in a plain string can still close an interpolation early —
 * handling that needs regex-literal awareness — but not skipping is what the
 * corpus shows is safe today.
 *
 * `codeLines`: the selection checks are end-anchored — `endsWith(';')`, the
 * `$` alternatives in {@link SAFETY_VERB_RE}, the predecessor `/[;{}]$/` — so
 * they must see the real statement end: a trailing comment
 * (`reminders.clear(); // why`) otherwise hides it, and a verb inside a string
 * (`log("sessions.clear()")`) fakes it. Whole-file state is what lets a line
 * that is comment or template CONTENT come out empty — per-line stripping
 * cannot know that, and its stray `{`/`}` mislead the class-body walk. A line
 * holding an unterminated single/double-quoted string cannot be judged at all
 * and is kept verbatim, which only ever preserves the conservative rejection
 * the checks already apply. The scan stops such a string BEFORE its newline:
 * consuming the `\n` (a `\`-continued line swallows it) would drop one per-line
 * entry and shift every later line's verdict onto its neighbour — the template
 * escape skip below guards its newline for the same reason.
 */
function scanFileLines(content: string): FileScan {
  const inLiteral: boolean[] = [];
  const codeLines: string[] = [];
  let state: 'code' | 'comment' = 'code';
  // One entry per open template literal, innermost last: -1 while the scan is
  // in that template's TEXT, otherwise the brace depth of its open `${…}`
  // interpolation.
  const templates: number[] = [];
  let buf = '';
  let lineStart = 0;
  let rawLine = false;
  const inTemplateOrComment = () => state !== 'code' || templates.length > 0;
  inLiteral.push(inTemplateOrComment());
  const endLine = (i: number) => {
    codeLines.push(rawLine ? content.slice(lineStart, i).trim() : buf.trim());
    buf = '';
    rawLine = false;
    lineStart = i + 1;
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '\n') {
      endLine(i);
      inLiteral.push(inTemplateOrComment());
      continue;
    }
    if (templates.length > 0) {
      const top = templates.length - 1;
      if (ch === '\\' && content[i + 1] !== '\n') {
        i++;
      } else if (templates[top] < 0) {
        // In the innermost template's text.
        if (ch === '`') {
          templates.pop();
          if (templates.length === 0) buf += '`';
        } else if (ch === '$' && content[i + 1] === '{') {
          templates[top] = 0;
          i++;
        }
      } else if (ch === '`') {
        templates.push(-1);
      } else if (ch === '{') {
        templates[top]++;
      } else if (ch === '}') {
        if (templates[top] === 0) templates[top] = -1;
        else templates[top]--;
      }
      continue;
    }
    if (state === 'comment') {
      if (ch === '*' && content[i + 1] === '/') {
        state = 'code';
        i++;
      }
      continue;
    }
    if (ch === '`') {
      buf += '`';
      templates.push(-1);
    } else if (ch === '/' && content[i + 1] === '*') {
      state = 'comment';
      i++;
    } else if (ch === '/' && content[i + 1] === '/') {
      while (i + 1 < content.length && content[i + 1] !== '\n') i++;
    } else if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < content.length && content[k] !== ch && content[k] !== '\n') {
        if (content[k] === '\\' && content[k + 1] !== '\n') k++;
        k++;
      }
      if (k < content.length && content[k] === ch) {
        buf += ch + ch;
        i = k;
      } else {
        rawLine = true;
        i = k < content.length && content[k] === '\n' ? k - 1 : k;
      }
    } else {
      buf += ch;
    }
  }
  endLine(content.length);
  return {
    inLiteral,
    codeLines,
    endState: templates.length > 0 ? 'template' : state,
  };
}

/**
 * Does `lines[idx]` sit directly inside a `class` body? A modifier-less class
 * field (`cache = new Map();`) reads exactly like a bare assignment statement
 * from one line away, yet deleting it removes a DECLARATION, not a cleanup — a
 * compile error (`inconclusive`) or, for an unused field, a false `survived`
 * that labels a field an added safety statement. Walk backward to the brace
 * that opens the immediately enclosing block and report whether it belongs to a
 * `class`. A statement in a method body is enclosed by the method's brace, not
 * the class's, so it is unaffected. Over-rejecting here is the cheap error.
 * Walks the {@link scanFileLines} code lines, never the raw text: a `{` in
 * template or comment CONTENT (an agent brief embedding a JSON example) would
 * otherwise read as an opening brace, stop the walk early, and admit the field.
 */
function insideClassBody(codeLines: string[], idx: number): boolean {
  let depth = 0;
  for (let j = idx - 1; j >= 0; j--) {
    const code = codeLines[j];
    for (let i = code.length - 1; i >= 0; i--) {
      const ch = code[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) {
          if (/\bclass\b/.test(code.slice(0, i))) return true;
          for (let k = j - 1; k >= 0; k--) {
            const prev = codeLines[k];
            if (prev.includes(';')) break;
            const d = scanLineDelimiters(prev);
            if (!d || d.brace !== 0) break;
            if (/\bclass\b/.test(prev)) return true;
          }
          return false;
        }
        depth--;
      }
    }
  }
  return false;
}

/**
 * Is `lines[idx]` deletable as one whole statement? Conservative on purpose: a
 * false negative costs one unprobed candidate, a false positive costs a full
 * suite run on a mutant that cannot compile — or worse, one whose deletion is
 * syntactically fine but rebinds the NEXT statement (the sole statement of a
 * brace-less `if`). So the line must end in `;`, start like an expression
 * statement, balance its own delimiters, and follow a line that clearly ENDED
 * something: `;`, `{`, or `}`. Anything else — a trailing `(`, `,`, `=>`,
 * `&&`, or the bare `)` that may be an `if (…)` header — is skipped.
 */
function isRemovableStatement(
  lines: string[],
  codeLines: string[],
  idx: number,
): boolean {
  const t = (lines[idx] ?? '').trim();
  // End-anchored checks run on the code portion only, so a trailing comment
  // (`reminders.clear(); // why`) does not hide the statement's real end.
  if (!(codeLines[idx] ?? '').endsWith(';')) return false;
  if ((codeLines[idx] ?? '').slice(0, -1).includes(';')) return false;
  if (!/^(?:await\s+)?[A-Za-z_$]/.test(t)) return false;
  if (NON_STATEMENT_START_RE.test(t)) return false;
  if (insideClassBody(codeLines, idx)) return false;
  const depth = scanLineDelimiters(t);
  if (!depth || depth.paren !== 0 || depth.bracket !== 0 || depth.brace !== 0) {
    return false;
  }
  // The nearest line that holds any CODE at all — a blank line, a comment
  // (whether it looks like one or is the content of a block), or template text
  // decides nothing about where the previous statement ended.
  let j = idx - 1;
  while (j >= 0 && codeLines[j] === '') j--;
  if (j < 0) return true;
  return /[;{}]$/.test(codeLines[j]);
}

export interface MutantSourceFile {
  file: string;
  /** Post-change content at the PR head — what the probe tree checks out. */
  content: string;
  /** 1-based new-side line numbers the diff ADDED in this file. */
  addedLines: number[];
  /** The diff also adds/changes this file's collocated test. Preference only:
   *  under the cap these candidates go first — a mutant is most informative
   *  exactly where the PR claims its new tests cover the new code. */
  hasNewTests: boolean;
}

/**
 * Deterministic mutant selection: among the diff's added lines, the complete
 * single-line safety-verb statements, capped at {@link MAX_MUTANTS} — files
 * with new tests first, then diff order, then line order. Candidates the cap
 * cannot fit are counted in `skippedForCap`, not silently lost — a report that
 * omits them lets a capped `survived: 0` read as "every safety statement is
 * covered", the same false assurance `skippedForBudget` exists to prevent. A
 * file whose scan ends outside code state (a regex literal holding a quote or
 * backtick derails it) has ALL its candidates dropped and is returned in
 * `derailed` — the caller must disclose that zero for the same reason.
 */
export function selectMutants(
  files: MutantSourceFile[],
  cap: number = MAX_MUTANTS,
): { selected: MutantCandidate[]; skippedForCap: number; derailed: string[] } {
  const preferred: MutantCandidate[] = [];
  const rest: MutantCandidate[] = [];
  const derailed: string[] = [];
  for (const f of files) {
    const lines = f.content.split('\n');
    const { inLiteral, codeLines, endState } = scanFileLines(f.content);
    if (endState !== 'code') {
      derailed.push(f.file);
      continue;
    }
    for (const n of [...f.addedLines].sort((a, b) => a - b)) {
      const raw = lines[n - 1];
      if (raw === undefined) continue;
      const t = raw.trim();
      if (!SAFETY_VERB_RE.test(codeLines[n - 1] ?? '')) continue;
      if (inLiteral[n - 1]) continue;
      if (!isRemovableStatement(lines, codeLines, n - 1)) continue;
      (f.hasNewTests ? preferred : rest).push({
        file: f.file,
        line: n,
        statement: t,
      });
    }
  }
  const eligible = [...preferred, ...rest];
  return {
    selected: eligible.slice(0, cap),
    skippedForCap: Math.max(0, eligible.length - cap),
    derailed,
  };
}

/**
 * The new-side line numbers a `--unified=0` diff ADDED, per post-change path.
 * Zero context is what the caller asks git for, but context lines are counted
 * anyway so a diff captured with the default `-U3` still numbers correctly.
 */
export function parseAddedLines(diffText: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let file: string | null = null;
  let inHunk = false;
  let newLine = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // A new file's header block follows; leave the previous file's hunk so
      // its `+++ ` header is recognised rather than read as an added line.
      inHunk = false;
      continue;
    }
    // `!inHunk`: inside a hunk an added source line that begins with `++ `
    // (spaced pre-increment) renders as `+++ x` and is not a file header.
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).split('\t')[0];
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      newLine = Number(m[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    if (line.startsWith('+')) {
      const list = added.get(file);
      if (list) list.push(newLine);
      else added.set(file, [newLine]);
      newLine++;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      newLine++;
    }
  }
  return added;
}

/**
 * Does the diff add or change a test collocated with this production file?
 * The repo convention is `file.test.ts` beside `file.ts`. Used only to ORDER
 * candidates under the cap, so a miss costs priority, not selection.
 */
export function hasCollocatedNewTest(
  file: string,
  testPaths: string[],
): boolean {
  const stem = file.replace(/\.[^./]+$/, '');
  return testPaths.some((t) => {
    const tstem = t.replace(/\.[^./]+$/, '');
    return tstem === `${stem}.test` || tstem === `${stem}.spec`;
  });
}

/**
 * Rule on one mutant from the per-file revert-probe verdicts of its run.
 *
 * `gated` on any file means an assertion failed with the statement deleted —
 * the mutant was caught, which is the good outcome and NOT a finding. But
 * `survived` requires every affected test file to have genuinely run and
 * passed: a file that collected nothing might be the very one that would have
 * caught the deletion, so any `inconclusive` without a kill makes the mutant
 * `inconclusive` — the same never-read-an-error-as-a-verdict asymmetry the
 * revert probe holds.
 */
export function classifyMutantRun(
  perFile: Array<{ verdict: ProbeVerdict }>,
): MutantVerdict {
  if (perFile.some((r) => r.verdict === 'gated')) return 'killed';
  if (perFile.length === 0 || perFile.some((r) => r.verdict === 'inconclusive'))
    return 'inconclusive';
  return 'survived';
}

/**
 * Can the remaining budget fit one more mutant? The revert probe's slot is
 * reserved by the deadline passed to {@link runProbeSuite}, so this guard
 * only prices the mutant's own suite run.
 */
export function fitsAnotherMutantRun(
  remainingMs: number,
  estimatedRunMs: number,
): boolean {
  return remainingMs >= estimatedRunMs;
}

interface VitestAssertion {
  status?: string;
}
interface VitestFileResult {
  /** Absolute path of the test file this result belongs to. */
  name?: string;
  assertionResults?: VitestAssertion[];
}
interface VitestJson {
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: VitestFileResult[];
}

/**
 * Rule on the revert probe, **per test file**.
 *
 * Per-file, not per-run, and that distinction is load-bearing. One `vitest run`
 * covers every probe at once, but a run-level verdict lets one honest test cover
 * for a useless one: the gating test fails, the run reports failures, and the
 * inert test sitting beside it is scored `gated` too. Every inert test with a
 * working sibling would be invisible — which is the exact defect this command
 * exists to find. (Found by running it, not by unit-testing it. The unit tests
 * for the run-level classifier all passed.) `testResults[].name` carries the
 * file, so the mapping is available; use it.
 *
 * The three-way asymmetry is deliberate:
 *
 * - `inert` — this file's tests PASSED with the source change reverted. They do
 *   not gate the change. This is a finding.
 * - `gated` — at least one ASSERTION in this file failed. It caught the revert;
 *   it is doing its job. Requires a real assertion failure, never a bare
 *   non-zero exit: reverting source routinely breaks a test's own compile (it
 *   imports a symbol the diff introduced), and a compile error proves nothing
 *   about whether the test would catch a behavioural regression.
 * - `inconclusive` — everything else: the file collected nothing, an
 *   import/type error, unparseable output. Do NOT let this read as `gated`; a
 *   review that mistakes "it errored" for "it caught the bug" is back where it
 *   started.
 */
export function classifyProbeRun(
  exitCode: number,
  stdout: string,
  probes: string[],
  stderr = '',
): Array<{ file: string; verdict: ProbeVerdict; detail: string }> {
  let parsed: VitestJson | undefined;
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      parsed = JSON.parse(stdout.slice(start)) as VitestJson;
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed) {
    // The runner's own error is the only thing that explains this, and dropping
    // it leaves an `inconclusive` nobody can act on.
    const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return probes.map((file) => ({
      file,
      verdict: 'inconclusive' as const,
      detail: `runner produced no parseable JSON (exit ${exitCode})${why ? `: ${why}` : ''}`,
    }));
  }

  const byFile = parsed.testResults ?? [];
  return probes.map((file) => {
    // `testResults[].name` is absolute; the probe path is repo-relative. Match
    // on a path-separator boundary, so `src/a.test.ts` cannot be satisfied by
    // `/w/vendor/other-src/a.test.ts` — a bare `endsWith` would take the wrong
    // file's verdict and never say so.
    const result = byFile.find(
      (r) => (r.name ?? '').endsWith(`/${file}`) || r.name === file,
    );
    const assertions = result?.assertionResults ?? [];
    const failed = assertions.filter((a) => a.status === 'failed').length;
    const passed = assertions.filter((a) => a.status === 'passed').length;

    if (!result || assertions.length === 0) {
      return {
        file,
        verdict: 'inconclusive' as const,
        detail: `collected no tests with the source reverted (run exit ${exitCode}) — likely a compile or import error, which is not evidence either way`,
      };
    }
    if (failed > 0) {
      return {
        file,
        verdict: 'gated' as const,
        detail: `${failed} assertion(s) failed with the source reverted — this test catches the change`,
      };
    }
    if (passed === 0) {
      // Collected, but nothing failed AND nothing passed — every test skipped
      // (`it.skip`, an unmet `describe.runIf`). A file that ran no assertions
      // proves nothing; calling that `inert` would report "still passed" about
      // tests that never executed.
      return {
        file,
        verdict: 'inconclusive' as const,
        detail: `${assertions.length} test(s) collected but none executed with the source reverted (all skipped) — not evidence either way`,
      };
    }
    return {
      file,
      verdict: 'inert' as const,
      detail: `all ${passed} test(s) still PASSED with the source change reverted — this test does not gate the change`,
    };
  });
}

interface TestEfficacyArgs {
  report: string;
  worktree: string;
  base: string;
  out: string;
  /** Injectable clock, for tests only — the budget math cannot be driven to
   *  its cutoff in real time. Defaults to `Date.now`. */
  now?: () => number;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  // `git` not on PATH leaves `status` null and `stderr` undefined, which the
  // status check below would report as `failed: ` — an error message with no
  // error in it. The runner spawn already guards this; so does this one now.
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
}

/** Run git and return trimmed stdout; throws on spawn failure or non-zero. */
function gitOut(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * Run git and return stdout VERBATIM, with a large buffer. Mutant selection
 * reads blob contents and a whole diff through this: `gitOut`'s trim would
 * strip a file's leading blank lines and silently shift every line number, and
 * the 1 MiB default buffer would ENOBUFS on a large PR's diff.
 */
function gitCapture(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return r.stdout ?? '';
}

/**
 * Does this path exist at the given rev? A non-zero exit is a legitimate "no"
 * (git prints nothing), but a spawn *failure* (`r.error`, e.g. git missing) is
 * not evidence of absence — surface it rather than reading it as "not present".
 */
function existsAtRev(cwd: string, rev: string, path: string): boolean {
  const r = spawnSync('git', ['cat-file', '-e', `${rev}:${path}`], { cwd });
  if (r.error) throw r.error;
  return r.status === 0;
}
/**
 * Remove `join(worktree, relPath)` without following a PR-controlled symlink.
 *
 * `rmSync` follows symlinks in the path PREFIX, and the revert set is
 * PR-controlled: a diff that turns `dir` into a symlink to an outside directory
 * and has the probe delete `dir/victim` would make `rmSync` follow `dir` and
 * delete the outside file — a real P0 a reviewer reproduced. The lexical
 * `escapes the worktree` guard cannot catch it, because `dir/victim` is lexically
 * inside the tree; the escape happens at runtime through the link.
 *
 * So walk every component from the worktree root down and refuse if any
 * ANCESTOR is a symlink — the target must be reachable through real directories
 * only. The final component being a symlink is fine: `rmSync` unlinks the link
 * itself, not what it points at, which is exactly what reverting an added
 * symlink should do. A missing component means there is nothing to remove
 * (`force` rm is already a no-op there), so return quietly.
 */
export function safeRmWithin(worktree: string, relPath: string): void {
  const parts = relPath.split(/[/\\]+/).filter((s) => s && s !== '.');
  let cur = worktree;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink() && i < parts.length - 1) {
      throw new Error(
        `refusing to delete through a symlink: ${relPath} ` +
          `(ancestor ${parts.slice(0, i + 1).join('/')} is a symlink)`,
      );
    }
  }
  rmSync(cur, { force: true });
}

type SweepResult = ReturnType<typeof spawnSync>;

/**
 * Free the probe worktree's path: unregister it, then remove whatever is left.
 *
 * `git worktree remove --force` only clears a tree git still tracks. A directory
 * left at the path after metadata loss or a partial cleanup is reported "not a
 * working tree" and left in place — and a *non-empty* one then makes
 * `git worktree add` fail `already exists`, wedging every probe as
 * `inconclusive` until someone clears it by hand. So the unregister is followed
 * by a plain remove of whatever dir remains. `rmSync` unlinks a symlink rather
 * than following it, so a tampered leftover cannot redirect the delete outside
 * `tree`.
 *
 * This is `releaseWorktree`'s two-step, and deliberately NOT a call to it:
 * `releaseWorktree` runs git from the process cwd, which need not be this
 * worktree's repo, and it discards the sweep's stderr — which is usually the
 * only thing that explains a subsequent `add` failure. Both callers here need
 * `cwd: worktree` and that stderr, so the step lives here and is shared between
 * them.
 *
 * Best-effort by design: a clean path is the normal case, so the unregister does
 * not go through the throwing `git()` wrapper. `rmSync` can still throw (`force`
 * suppresses ENOENT but not EPERM/EBUSY) — callers decide what that means.
 */
function discardWorktree(cwd: string, tree: string): SweepResult {
  const sweep = spawnSync('git', ['worktree', 'remove', '--force', tree], {
    cwd,
    encoding: 'utf8',
  });
  rmSync(tree, { recursive: true, force: true });
  return sweep;
}

const existsAtBase = (cwd: string, base: string, path: string) =>
  existsAtRev(cwd, base, path);

/**
 * The `inconclusive` detail for a probe worktree that could not be created.
 *
 * Pure, and extracted for that reason: the branch it lives on fires only when
 * `git worktree add` fails, and there is no portable way to force that in a
 * real-git test — the one lever (making `.git/worktrees` unwritable) is bypassed
 * by root and behaves differently under CI's unprivileged user, so a test built
 * on it would assert one thing locally and another in CI. The composition is the
 * part with logic in it, so it is testable here on its own.
 *
 * The stale-sweep's stderr is folded in because it is usually the explanation:
 * when `add` fails on a leftover the sweep could not clear, the sweep is what
 * says why.
 */
export function probeCreateFailureDetail(
  err: unknown,
  sweepStderr: string,
): string {
  const sweepErr = sweepStderr.trim();
  return (
    `probe worktree could not be created: ${err instanceof Error ? err.message : String(err)}` +
    (sweepErr ? ` (stale-tree sweep also reported: ${sweepErr})` : '')
  );
}

/**
 * The warning for a probe worktree that survived its discard.
 *
 * Pure, and for the same reason as its sibling above: the branch it lives on
 * fires only when the path outlives both `worktree remove` and `rmSync`, which
 * no portable test can force. The reason is what makes it useful — whoever has
 * to delete the tree by hand needs to know WHY it would not go, and a bare
 * "could not remove <path>" tells them nothing. Prefer the exception (`rmSync`
 * hit EPERM/EBUSY); fall back to what git said when it refused to unregister.
 */
export function probeCleanupFailureDetail(
  probeTree: string,
  removeError: unknown,
  sweepStderr: string,
): string {
  const why = removeError
    ? removeError instanceof Error
      ? removeError.message
      : String(removeError)
    : sweepStderr.trim();
  return `could not remove probe worktree ${probeTree}${why ? `: ${why}` : ''}`;
}

/**
 * One vitest run over the probe files, classified per file. Shared by the
 * baseline run, every mutant run, and the revert probe — the same suite, the
 * same runner, the same classifier. Throws when the run never produced output
 * to classify (spawn failure, or killed by the deadline).
 *
 * `deadlineAt` clamps the per-run timeout so the baseline + mutants + revert
 * cannot together exceed {@link TOTAL_BUDGET_MS}: the baseline and mutant
 * runs share a window that reserves the revert probe's full slot, and the
 * revert probe gets the remainder of the whole budget.
 */
function runProbeSuite(
  probeTree: string,
  probes: string[],
  deadlineAt?: number,
  now: () => number = Date.now,
): {
  perFile: Array<{ file: string; verdict: ProbeVerdict; detail: string }>;
  ms: number;
} {
  const started = now();
  const timeout =
    deadlineAt !== undefined
      ? Math.max(1, Math.min(PROBE_RUN_TIMEOUT_MS, deadlineAt - started))
      : PROBE_RUN_TIMEOUT_MS;
  const r = spawnSync('npx', ['vitest', 'run', '--reporter=json', ...probes], {
    cwd: probeTree,
    encoding: 'utf8',
    timeout,
    // Vitest's JSON reporter on a large suite easily exceeds spawnSync's
    // 1 MiB default stdout buffer, which returns ENOBUFS and turns every
    // probe `inconclusive`. Match the 64 MiB ceiling the gh wrapper uses.
    maxBuffer: 64 * 1024 * 1024,
  });
  // `r.error` is set — and `r.status` is null — when the process never ran
  // (npx missing) or was killed (the timeout above fires SIGTERM). Ignoring
  // it reports those as "the runner produced no parseable JSON", which
  // blames the runner's output for a run that produced none.
  if (r.error) throw r.error;
  if (r.signal) {
    throw new Error(
      `runner killed by ${r.signal}${r.signal === 'SIGTERM' ? ` (probe timed out after ${Math.round(timeout / 1000)}s)` : ''}`,
    );
  }
  return {
    perFile: classifyProbeRun(
      r.status ?? 1,
      `${r.stdout ?? ''}`,
      probes,
      `${r.stderr ?? ''}`,
    ),
    ms: now() - started,
  };
}

/**
 * Delete one statement in the probe tree, run the affected tests, put the file
 * back. The restore is a plain content write, not a git call: the original
 * bytes are already in hand, and a write cannot be confused by whatever
 * checkout state a failed run leaves. A restore failure throws — the caller
 * must not keep mutating a tree it cannot prove clean. (Writing through
 * `join(probeTree, file)` is symlink-safe here the way `safeRmWithin` has to
 * enforce for deletes: the candidate resolved as a blob at the head commit, and
 * one git tree cannot hold both `dir` as a symlink and `dir/file` as a blob, so
 * in a fresh checkout every ancestor is a real directory.)
 *
 * Exported for its tests: the never-delete-a-mismatched-line guard cannot be
 * reached through the command (selection and the probe tree derive from the
 * same commit), so the test pins it directly rather than not at all.
 */
export function runOneMutant(
  probeTree: string,
  mutant: MutantCandidate,
  probes: string[],
  deadlineAt?: number,
  now: () => number = Date.now,
): MutantResult {
  const abs = join(probeTree, mutant.file);
  const original = readFileSync(abs, 'utf8');
  const lines = original.split('\n');
  if ((lines[mutant.line - 1] ?? '').trim() !== mutant.statement) {
    // The tree does not hold the selected statement at that line. Never delete
    // a line that is not the one selected — a wrong-line mutant's verdict would
    // be attributed to a statement it never touched.
    return {
      ...mutant,
      verdict: 'inconclusive',
      detail:
        'the probe tree does not match the selected statement at this line — nothing was mutated',
    };
  }
  lines.splice(mutant.line - 1, 1);
  try {
    writeFileSync(abs, lines.join('\n'), 'utf8');
    const { perFile } = runProbeSuite(probeTree, probes, deadlineAt, now);
    const verdict = classifyMutantRun(perFile);
    const detail =
      verdict === 'killed'
        ? 'the suite went red with this statement deleted — a test catches its removal'
        : verdict === 'survived'
          ? 'every affected test still PASSED with this statement deleted — no test fails when it is removed'
          : 'the mutated tree produced no clean verdict (likely a compile or import error) — not evidence either way';
    return { ...mutant, verdict, detail };
  } finally {
    writeFileSync(abs, original, 'utf8');
  }
}

async function runTestEfficacy(args: TestEfficacyArgs): Promise<void> {
  const now = args.now ?? Date.now;
  const startedAt = now();
  const { report, worktree, base, out } = args;
  const plan = JSON.parse(readFileSync(report, 'utf8')) as {
    files?: FileEntry[];
  };
  const rootPkg = JSON.parse(
    readFileSync(`${worktree}/package.json`, 'utf8'),
  ) as { workspaces?: string[] };
  const globs = rootPkg.workspaces ?? [];

  const { unreachable, probes, revert } = planTestEfficacy(
    plan.files ?? [],
    globs,
  );

  // The report JSON is untrusted input, and `revert` paths become both git
  // pathspecs and `join(worktree, …)` filesystem targets we check out and
  // delete. Reject anything that is not a plain repository-relative path — an
  // absolute path, or one that normalises outside the worktree (`../`, or a
  // `a/../../b` that looks clean per-segment) — before it can point the
  // checkout/delete at a file outside the tree.
  for (const p of revert) {
    const norm = join(worktree, p);
    const root = join(worktree, '.');
    if (isAbsolute(p) || (norm !== root && !norm.startsWith(root + sep))) {
      throw new Error(
        `refusing to run: revert path escapes the worktree: ${JSON.stringify(p)}`,
      );
    }
  }

  const results: Array<{
    file: string;
    verdict: ProbeVerdict;
    detail: string;
  }> = [];
  let cleanupFailure: string | undefined;
  const mutantResults: MutantResult[] = [];
  let mutantsSkippedForBudget = 0;
  let mutantsSkippedForCap = 0;
  let mutantsSkippedForBaseline = 0;
  let mutantsNote: string | undefined;
  // Notes can stack (a derailed file AND a red baseline); never clobber one
  // disclosure with another.
  const noteMutants = (note: string) => {
    mutantsNote = mutantsNote ? `${mutantsNote}; ${note}` : note;
  };

  if (probes.length > 0 && revert.length > 0) {
    // The probe reverts the PR's source to base and runs the tests against it —
    // in its OWN disposable worktree, checked out at the PR head and discarded
    // wholesale when the probe finishes. The shared worktree the other review
    // agents read is never mutated (so a concurrent reader can never observe a
    // half-reverted tree), and there is no in-place restore to get wrong (so the
    // restore delete that once followed a PR-controlled symlink out of the tree
    // is gone with it). See #6832.
    //
    // Isolation is also why there is no dirty-worktree guard anymore: the probe
    // tree is a fresh checkout of the committed head, so nothing the caller has
    // uncommitted in the shared tree is ever touched or discarded.
    //
    // `node_modules` resolves without a per-tree install because the probe tree
    // is nested under the repo (`.qwen/tmp/…-probe`), so Node walks up to the
    // repo-root `node_modules` — exactly how the shared review worktree already
    // runs vitest.
    const headSha = gitOut(worktree, 'rev-parse', 'HEAD');

    // Mutant selection, from the COMMITTED head: the diff's added lines come
    // from `base..HEAD` and the contents from the head blobs, so the selection
    // describes exactly the tree the probe worktree below checks out — never
    // whatever uncommitted state the shared worktree happens to hold.
    let candidates: MutantCandidate[] = [];
    try {
      const mutantFiles = revert.filter(
        (p) => MUTANT_SOURCE_RE.test(p) && !DECLARATION_FILE_RE.test(p),
      );
      if (mutantFiles.length > 0) {
        const added = parseAddedLines(
          gitCapture(
            worktree,
            '-c',
            'core.quotePath=false',
            'diff',
            '--unified=0',
            '--no-color',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            '--no-ext-diff',
            '--no-textconv',
            base,
            headSha,
            '--',
            ...mutantFiles,
          ),
        );
        const selection = selectMutants(
          mutantFiles
            .filter((p) => (added.get(p) ?? []).length > 0)
            .map((p) => ({
              file: p,
              content: gitCapture(worktree, 'show', `${headSha}:${p}`),
              addedLines: added.get(p) ?? [],
              hasNewTests: hasCollocatedNewTest(p, probes),
            })),
        );
        candidates = selection.selected;
        mutantsSkippedForCap = selection.skippedForCap;
        if (selection.derailed.length > 0) {
          noteMutants(
            `mutant selection dropped ${selection.derailed.length} file(s) whose literal scan derailed (${selection.derailed.join(', ')}) — a regex literal holding a quote or backtick can do this; their candidates were not probed`,
          );
        }
      }
    } catch (e) {
      // Selection is bookkeeping, not evidence: a diff that will not parse or a
      // blob that will not read says nothing about any test. Disclose and move
      // on — the probes and the unreachable findings do not depend on it.
      noteMutants(
        `mutant selection failed: ${e instanceof Error ? e.message : String(e)} — no mutants were run`,
      );
      candidates = [];
    }

    const probeTree = probeWorktreePath(worktree);
    let created = false;
    let sweep: SweepResult | undefined;
    try {
      // Clear a stale probe tree left by a crashed run — it would fail `add`.
      // Its stderr is kept to explain a subsequent `add` failure.
      sweep = discardWorktree(worktree, probeTree);
      git(worktree, 'worktree', 'add', '--detach', probeTree, headSha);
      created = true;
    } catch (e) {
      // Could not isolate — probe nothing rather than fall back to mutating the
      // shared tree. Probes are inconclusive; the unreachable findings, which
      // need no probe, still ship.
      const detail = probeCreateFailureDetail(e, String(sweep?.stderr ?? ''));
      for (const file of probes) {
        results.push({ file, verdict: 'inconclusive' as const, detail });
      }
      for (const c of candidates) {
        mutantResults.push({ ...c, verdict: 'inconclusive' as const, detail });
      }
    }

    if (created && candidates.length > 0) {
      // The mutation phase runs BEFORE the revert: it needs the probe tree at
      // the unmodified PR head, and the revert below rewrites that tree to
      // base. The two cannot contaminate each other — every mutated file is in
      // the revert set, so the revert's checkout/delete resets it regardless of
      // what a failed restore left behind.
      try {
        // The baseline run does two jobs. A mutant is only evidence against a
        // suite that is green WITHOUT it — against a base run that already
        // fails, every mutant would be "killed" by failures it did not cause.
        // And its measured duration is the unit the budget check prices a
        // suite run at.
        // The baseline and mutant runs share a window that ends one
        // PROBE_RUN_TIMEOUT_MS before the whole budget, reserving the
        // revert probe's full slot so the pair can never exceed the
        // 600s tool ceiling (540s budget: at most 240s here + 300s revert).
        const mutantDeadline =
          startedAt + TOTAL_BUDGET_MS - PROBE_RUN_TIMEOUT_MS;
        const baseline = runProbeSuite(probeTree, probes, mutantDeadline, now);
        // A mutant is only evidence against a probe file that is green WITHOUT
        // it: against a file already red the mutant is "killed" by failures it
        // did not cause, and a file that collected nothing proves nothing. Gate
        // PER FILE, not on the whole suite — one unrelated quarantined (all-skip)
        // file is `inconclusive`, not red, and must not take the whole probe down.
        // (`inert` here is the baseline's "all passed" — the same verdict the
        // revert probe reads as "still passed with the source reverted".)
        const greenProbes = baseline.perFile
          .filter((r) => r.verdict === 'inert')
          .map((r) => r.file);
        if (greenProbes.length === 0) {
          mutantsSkippedForBaseline = candidates.length;
          noteMutants(
            'mutants not run: no probe file was green in the unmutated baseline (every file was red or collected nothing), so a red mutant run would prove nothing',
          );
        } else {
          const estimatedRunMs = baseline.ms + RUN_ESTIMATE_MARGIN_MS;
          for (const c of candidates) {
            const remaining = mutantDeadline - now();
            if (!fitsAnotherMutantRun(remaining, estimatedRunMs)) {
              mutantsSkippedForBudget =
                candidates.length - mutantResults.length;
              break;
            }
            mutantResults.push(
              runOneMutant(probeTree, c, greenProbes, mutantDeadline, now),
            );
          }
        }
      } catch (e) {
        // The baseline, a mutant run, or a restore failed. Not evidence about
        // any statement — mark whatever never got a verdict and keep going, so
        // the revert probe below still runs.
        const detail = `mutation probe could not run: ${e instanceof Error ? e.message : String(e)}`;
        for (const c of candidates.slice(mutantResults.length)) {
          mutantResults.push({
            ...c,
            verdict: 'inconclusive' as const,
            detail,
          });
        }
      }
    }

    if (created) {
      try {
        // "Revert to base" is two operations, confined to the throwaway tree. A
        // file the PR MODIFIED is checked out from base; a file the PR ADDED did
        // not exist at base, so it is removed — through `safeRmWithin`, which
        // still refuses to delete through a PR-controlled symlink even here.
        // Removing an added file usually makes the probe fail to compile, which
        // is `inconclusive` — a non-verdict, but an honest one.
        const modified: string[] = [];
        const added: string[] = [];
        for (const p of revert) {
          (existsAtBase(probeTree, base, p) ? modified : added).push(p);
        }
        if (modified.length > 0) {
          git(probeTree, 'checkout', base, '--', ...modified);
        }
        for (const p of added) safeRmWithin(probeTree, p);

        results.push(
          ...runProbeSuite(probeTree, probes, startedAt + TOTAL_BUDGET_MS, now)
            .perFile,
        );
      } catch (e) {
        // The probe could not be set up or run. That is not evidence about any
        // test — record it and keep going, so the report (and the unreachable
        // findings, which needed no probe at all) still reaches the caller.
        const detail = `probe could not run: ${e instanceof Error ? e.message : String(e)}`;
        results.push(
          ...probes.map((file) => ({
            file,
            verdict: 'inconclusive' as const,
            detail,
          })),
        );
      } finally {
        // Discard the whole probe tree. There is no in-place restore to fail —
        // the shared worktree was never mutated — and a path that survives the
        // discard corrupts nothing: the next run's pre-sweep and cleanup.ts both
        // sweep it. So this is a warning, not the "every later step reads the
        // wrong source" alarm the old in-place restore had to raise.
        //
        // Whether the path is still THERE is the signal, not whether a call
        // threw: `worktree remove` can fail while `rmSync` still frees the path.
        // But keep the reason — a bare "could not remove <path>" tells whoever
        // has to clean it up by hand nothing about why they must.
        let removeError: unknown;
        let discard: SweepResult | undefined;
        try {
          discard = discardWorktree(worktree, probeTree);
        } catch (e) {
          removeError = e;
        }
        if (existsSync(probeTree)) {
          cleanupFailure = probeCleanupFailureDetail(
            probeTree,
            removeError,
            String(discard?.stderr ?? ''),
          );
        }
      }
    }
  }

  const findings = [
    ...unreachable.map((f) => ({
      file: f,
      kind: 'unreachable' as const,
      message: `\`${f}\` is outside every npm workspace, so the project's test command never collects it. It did not run in this review, and it does not gate this change. Confirm it runs in CI — and check \`ciStatus.skippedCheckNames\`, because the job that would run it is exactly the kind that gets skipped.`,
    })),
    ...results
      .filter((r) => r.verdict === 'inert')
      .map((r) => ({
        file: r.file,
        kind: 'inert' as const,
        message: `\`${r.file}\`: ${r.detail}. It passes whether or not the change is present, so it cannot catch a regression in it.`,
      })),
    ...mutantResults
      .filter((m) => m.verdict === 'survived')
      .map((m) => ({
        file: m.file,
        kind: 'mutant-survived' as const,
        message: `\`${m.file}:${m.line}\`: deleting the added safety statement \`${m.statement}\` leaves every affected test green. No test in this diff fails when it is removed — confirm an existing test covers it, or add one, so a regression that drops or skips this statement is caught.`,
      })),
  ];

  const count = (v: MutantVerdict) =>
    mutantResults.filter((m) => m.verdict === v).length;
  const result = {
    unreachable,
    probed: results,
    inconclusive: results.filter((r) => r.verdict === 'inconclusive'),
    mutants: {
      probed: mutantResults,
      killed: count('killed'),
      survived: count('survived'),
      inconclusive: count('inconclusive'),
      skippedForBudget: mutantsSkippedForBudget,
      skippedForCap: mutantsSkippedForCap,
      skippedForBaseline: mutantsSkippedForBaseline,
      ...(mutantsNote ? { note: mutantsNote } : {}),
    },
    findings,
    cleanupFailure,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  writeStdoutLine(
    `Wrote test-efficacy report to ${out} (${unreachable.length} unreachable, ${results.length} probed, ${mutantResults.length} mutant(s), ${findings.length} finding(s))`,
  );
  for (const f of findings) {
    writeStdoutLine(`  [test] ${f.kind}: ${f.file}`);
  }
  if (mutantsSkippedForCap > 0) {
    writeStdoutLine(
      `  ${mutantsSkippedForCap} mutant(s) skipped: more candidates than the cap of ${MAX_MUTANTS}`,
    );
  }
  if (mutantsSkippedForBaseline > 0) {
    writeStdoutLine(
      `  ${mutantsSkippedForBaseline} mutant(s) skipped: no probe file was green in the unmutated baseline`,
    );
  }
  if (mutantsSkippedForBudget > 0) {
    writeStdoutLine(
      `  ${mutantsSkippedForBudget} mutant(s) skipped: the remaining budget cannot fit another suite run`,
    );
  }
  if (mutantsNote) {
    writeStdoutLine(`  ${mutantsNote}`);
  }
  if (cleanupFailure) {
    // A leftover probe worktree does not corrupt the shared tree — it is swept
    // at the start of the next run and by cleanup.ts — so this is a warning, not
    // the non-zero-exit alarm the old in-place restore failure had to raise.
    writeStderrLine(`WARNING: ${cleanupFailure}`);
  }
}

export const testEfficacyCommand: CommandModule = {
  command: 'test-efficacy <report>',
  describe:
    "Check whether the diff's new tests actually gate its new behaviour (unreachable + revert probe + statement-deletion mutants)",
  builder: (yargs) =>
    yargs
      .positional('report', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the fetch-pr / plan-diff report JSON',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe: 'Worktree to probe in',
      })
      .option('base', {
        type: 'string',
        demandOption: true,
        describe: 'Base SHA to revert source files to',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path',
      }),
  handler: async (argv) => {
    await runTestEfficacy(argv as unknown as TestEfficacyArgs);
  },
};
