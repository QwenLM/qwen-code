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
  realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, isAbsolute, resolve, sep } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { probeWorktreePath } from './lib/paths.js';
// `discardWorktree` moved to `lib/worktree.ts` when `base-tree` needed the same
// stale-sweep-then-remove step (its rationale lives there, with the helper), and
// `exposeDependencies` followed it when `scratch-tree` needed the same
// dependency farm for the verifier's own probe tree.
import { shellQuotePath } from './lib/shell-quote.js';
import {
  boxedRunLeftContainer,
  containerCommand,
  containerName,
  containerPathFor,
  killContainer,
  mountRootFor,
  refuseUnsandboxedPhase,
  reviewSandboxImage,
  runtimeIsRootless,
  runtimeClientEnv,
  sandboxVerdict,
  type ContainerRuntime,
} from './lib/sandboxed-exec.js';
import {
  discardWorktree,
  exposeDependencies,
  localFilterCommands,
  redirectedAncestor,
  screenKeyList,
  screenStopDetail,
  sanitizedGitEnv,
  worktreeCreateFailureDetail,
  type SweepResult,
} from './lib/worktree.js';
import { isWorkspaceMember } from './lib/workspaces.js';

export type ProbeVerdict = 'gated' | 'inert' | 'inconclusive';

/**
 * WHY a probe was `inconclusive`, as the run knew it at the time.
 *
 * Seven different things arrive at the same verdict and they are not
 * interchangeable:
 *
 * - `control-failed` — the suite ran and read green, but the positive control
 *   proved the runner could not have gone red, so the reading is not evidence.
 * - `not-run` — no suite ran for it: the tree could not be prepared, or the
 *   runner could not be started at all. Nothing was measured.
 * - `runner-died` — a suite WAS started and did not survive: killed at the
 *   deadline, or by a signal. It may have executed most of its tests, so
 *   "nothing ran" is a claim about it that nothing checked.
 * - `no-output` — the runner ran and produced nothing parseable, so whether it
 *   collected anything is unknown.
 * - `not-in-results` — the run produced results and this file was not among
 *   them. A compile or import error looks like this, and so does a path that
 *   failed to match.
 * - `no-tests` — the file WAS in the results and collected zero assertions.
 * - `all-skipped` — it collected tests and executed none of them.
 *
 * Anything downstream that explains an `inconclusive` has to pick between
 * these, and the prose `detail` is written for a human, not for that decision.
 */
export type ProbeReason =
  | 'control-failed'
  | 'not-run'
  | 'runner-died'
  | 'no-output'
  | 'not-in-results'
  | 'no-tests'
  | 'all-skipped';

/**
 * A union, not an optional field: every `inconclusive` MUST say which way, and
 * the compiler is what enforces it. Left optional, a branch that forgot to tag
 * itself fell through to a vague catch-all wording with nothing failing —
 * measured, deleting one tag left all 116 tests green while every hold of that
 * kind silently degraded. The one part of this file that has to be right is the
 * part a runtime fallback was quietly covering for.
 */
export type ProbeResult =
  | { file: string; verdict: 'gated' | 'inert'; detail: string }
  | {
      file: string;
      verdict: 'inconclusive';
      detail: string;
      reason: ProbeReason;
    };

/**
 * `Omit` applied across each arm instead of to the union as a whole. A plain
 * `Omit`/`Pick` collapses `ProbeResult` into one object type and makes `reason`
 * optional again — which is how an `inert` entry could reach the explanation
 * helper and come back described as "did not come back green", the opposite of
 * what `inert` means. Distributing keeps the discrimination, so the helper
 * cannot read `reason` without first narrowing on `verdict`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** What the two explanation helpers read: `ProbeResult` without its prose. */
export type ProbeOutcome = DistributiveOmit<ProbeResult, 'detail'>;

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

/**
 * Which of `probes` are committed as mode 120000. Such a test is collected by
 * vitest THROUGH the link: its imports resolve from the target's realpath,
 * outside the tree this command mutates, so every verdict it could produce is
 * about code no mutant touched. The write guards never see it, because the
 * harness never WRITES a probe file — it only runs them. The COMMITTED mode is
 * the check rather than an lstat of the checkout: the index a fresh
 * `worktree add` leaves is the head commit's, and the checkout is what a
 * relinking probe would have tampered with. A git failure keeps every probe —
 * the guards still cover the shapes they always did; only the committed mode
 * is new ground.
 */
export function committedSymlinkProbes(
  tree: string,
  probes: string[],
): Set<string> {
  if (probes.length === 0) return new Set();
  // `:(literal)` on every pathspec: a probe filename may itself begin with
  // pathspec MAGIC (`:(literal)x.test.ts` is a legal name a PR can commit), and
  // git would then parse the name as a directive and match a different blob —
  // so the symlink this function exists to catch would not be found under the
  // name the caller holds. The prefix says "the rest is a literal path".
  const r = spawnSync(
    'git',
    [
      '-c',
      'core.fsmonitor=',
      'ls-files',
      '-s',
      '-z',
      '--',
      ...probes.map((probe) => `:(literal)${probe}`),
    ],
    {
      cwd: tree,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    },
  );
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
    // A pathspec git refuses is not an answer of "no symlinks": the caller
    // would run every probe it just failed to vet. An empty set is only
    // honest when git answered.
    return new Set(probes);
  }
  const linked = new Set<string>();
  for (const rec of r.stdout.split('\0')) {
    if (!rec.startsWith('120000 ')) continue;
    const tab = rec.indexOf('\t');
    if (tab >= 0) linked.add(rec.slice(tab + 1));
  }
  return linked;
}

export type MutantVerdict = 'killed' | 'survived' | 'inconclusive';

/**
 * A candidate the probe will run. The two shapes are a union so an operator
 * without its replacement line is UNREPRESENTABLE: `runOneMutant` takes the
 * ACTION from `mutated` and the verdict WORDING from `operator`, so a
 * half-populated candidate would delete a line while reporting "with its
 * `?? fallback` dropped".
 */
export type MutantCandidate = DeletionMutant | ReplacementMutant;

export interface ReplacementMutant extends MutantBase {
  operator: 'coalesce' | 'guard-true' | 'term-drop';
  /** The full replacement LINE (untrimmed). Required by construction. */
  mutated: string;
}

/** What both mutant shapes carry. */
export interface MutantBase {
  file: string;
  /** 1-based line number in the post-change file. */
  line: number;
  /** The statement's text, trimmed — quoted back verbatim in the report. */
  statement: string;
}

/**
 * The legacy shape: the line is DELETED. `operator` is absent (or `'delete'`)
 * and there is no replacement line — see the union above for why that is
 * enforced by the type rather than by a convention.
 */
export interface DeletionMutant extends MutantBase {
  operator?: 'delete';
  mutated?: undefined;
}

/** An intersection, not `extends`: the candidate is a union now. */
export type MutantResult = MutantCandidate & {
  verdict: MutantVerdict;
  detail: string;
};

/**
 * At most this many deletion mutants per run. Every mutant is a full vitest run
 * over the affected test files, so the cap — not the candidate count — is what
 * keeps this command inside its budget on a diff that clears eight Maps.
 */
export const MAX_MUTANTS = 8;

export type HunkVerdict = MutantVerdict;

export interface HunkCandidate {
  file: string;
  /** 0-based index of this hunk within the file's diff against base. */
  index: number;
  /** The `@@ … @@` line, quoted back in the report. */
  header: string;
  /** New-side first line the hunk occupies — where the finding points. */
  startLine: number;
  /** A complete patch: the file header plus this ONE hunk. */
  patch: string;
}

export interface HunkResult extends Omit<HunkCandidate, 'patch'> {
  verdict: HunkVerdict;
  detail: string;
}

/**
 * At most this many per-hunk probes per run.
 *
 * Lower than {@link MAX_MUTANTS} on purpose: a hunk probe costs the same full
 * suite run, but it is the THIRD claim on a budget the mutants and the revert
 * probe already share, and it runs last. The cap is what keeps a 40-hunk diff
 * from starving the revert probe rather than a statement about how many hunks
 * are worth probing.
 */
export const MAX_HUNK_PROBES = 6;

/**
 * At most this many REPLACEMENT mutants per run, inside the shared cap — see
 * the selection comment for the 24x pool measurement that forced this.
 */
export const REPLACEMENT_SUB_CAP = 3;

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
/**
 * (Below: the replacement operators. `selectMutants`' own contract doc sits
 * directly above `selectMutants` — this block documents its helper.)
 *
 * Replacement mutants for one added line. High-precision by construction: each
 * pattern is anchored to a shape whose survival maps to one crisp sentence,
 * because a survivor becomes a public Suggestion and a fuzzy operator would
 * flood the report with "so what" mutations.
 *
 * The edit is computed on `codeLine` — the scanner's literal-blanked,
 * comment-stripped, TRIMMED view — and reattached to the raw line's leading
 * whitespace. That is only sound when the two views agree, so a line whose
 * trimmed raw text differs from its code view (it carries a string literal or
 * a comment) yields NO candidate: an index computed on one view and applied to
 * the other spliced `iftrue 0)` into a guard the first time this ran, and a
 * mangled mutant is worse than a skipped one — its compile error reads as
 * `inconclusive` and quietly eats a cap slot. Conservative silence, as with
 * every other selector here.
 *
 * At most ONE candidate per line, first match wins (coalesce → term-drop →
 * guard-true, most-specific first): two mutants of the same line would run the
 * suite twice to say nearly the same thing.
 */
export function replacementMutantsOf(
  raw: string,
  codeLine: string,
): {
  operator: 'coalesce' | 'guard-true' | 'term-drop';
  mutated: string;
} | null {
  if (raw.trim() !== codeLine) return null;
  const lead = /^\s*/.exec(raw)![0];
  const done = (
    operator: 'coalesce' | 'guard-true' | 'term-drop',
    edited: string,
  ) => ({ operator, mutated: lead + edited });

  // `a ?? b` with a SIMPLE fallback — an identifier/member/call chain, no
  // operators — so the drop cannot truncate a larger expression.
  const coalesce =
    /\s\?\?\s+[\w$.]+(?:\((?:[^()]|\([^()]*\))*\))?(?=\s*[;,)\]}]|\s*$)/.exec(
      codeLine,
    );
  if (coalesce) {
    return done(
      'coalesce',
      codeLine.slice(0, coalesce.index) +
        codeLine.slice(coalesce.index + coalesce[0].length),
    );
  }
  // `+ UPPER_CONST` — a constant-looking reserve/limit term in arithmetic.
  const term = /\s\+\s+[A-Z][A-Z0-9_]{2,}\b/.exec(codeLine);
  if (term) {
    return done(
      'term-drop',
      codeLine.slice(0, term.index) +
        codeLine.slice(term.index + term[0].length),
    );
  }
  // A single-line `if (…)` whose condition CONTAINS a comparison — guards, not
  // every branch: `if (ready)` survivors are noise, `if (a !== b)` survivors
  // mean nothing pins when the guard must not fire. The condition must close on
  // this line (balanced parens), or `true` would splice mid-expression.
  // `}` optional before `else`: a brace-less `else if (a !== b)` is the same
  // guard shape and was silently skipped.
  const ifm = /^((?:}?\s*else\s+)?if\s*\()(.*)$/.exec(codeLine);
  if (ifm) {
    let depth = 1;
    let condEnd = -1;
    for (let i = 0; i < ifm[2].length; i++) {
      if (ifm[2][i] === '(') depth++;
      else if (ifm[2][i] === ')' && --depth === 0) {
        condEnd = i;
        break;
      }
    }
    // The comparison must be in the CONDITION, not anywhere after `if (`:
    // testing the whole remainder admitted `if (ready) emit(a !== b);` — the
    // comparison-less shape whose survivors are pure noise, which this gate
    // exists to exclude.
    if (
      condEnd > 0 &&
      // Two exclusions, both measured. `(?<![=!<>])…(?![=>])` keeps an arrow
      // function's `=>` from reading as a comparison. And the trailing `\s` is
      // REQUIRED, not an accidental asymmetry with `[!=]==`: without it a
      // generic call — `if (isRecord<string>(v))` — matches at `<string`, and
      // a type-guard predicate is exactly the `if (ready)` shape whose
      // survivors this gate calls noise. Telling `a<b` from `fn<T>(x)` needs a
      // parser; the gate is silence-biased by design, and Prettier makes the
      // unformatted comparison near-nonexistent here.
      /[!=]==|(?<![=!<>])[<>]=?(?![=>])\s/.test(ifm[2].slice(0, condEnd))
    ) {
      return done('guard-true', ifm[1] + 'true' + ifm[2].slice(condEnd));
    }
  }
  return null;
}

export function selectMutants(
  files: MutantSourceFile[],
  cap: number = MAX_MUTANTS,
): { selected: MutantCandidate[]; skippedForCap: number; derailed: string[] } {
  const preferred: MutantCandidate[] = [];
  const rest: MutantCandidate[] = [];
  const replPreferred: MutantCandidate[] = [];
  const replRest: MutantCandidate[] = [];
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
      if (inLiteral[n - 1]) continue;
      const code = codeLines[n - 1] ?? '';
      if (
        SAFETY_VERB_RE.test(code) &&
        isRemovableStatement(lines, codeLines, n - 1)
      ) {
        // No `operator` field: deletion is the legacy shape, and stamping it
        // would churn every existing report reader for zero information.
        (f.hasNewTests ? preferred : rest).push({
          file: f.file,
          line: n,
          statement: t,
        });
        continue; // one candidate per line — deletion is the sharper experiment
      }
      const repl = replacementMutantsOf(raw, code);
      if (repl) {
        (f.hasNewTests ? replPreferred : replRest).push({
          file: f.file,
          line: n,
          statement: t,
          operator: repl.operator,
          mutated: repl.mutated,
        });
      }
    }
  }
  // Deletions first, then replacements — and replacements carry their OWN
  // sub-cap. Measured over 40 real commits, the replacement operators produce
  // ~24x the deletion pool (215 vs 9 candidates; guard-true drives it), and
  // every mutant run drains the same time window hunk probes draw from last:
  // uncapped, most diffs with any replacement candidates would leave hunk
  // probing zero runs and the hunk-survived finding class would silently stop
  // firing. Three slots keeps the highest-value replacements without buying
  // coarser answers at the hunk probes' expense; what the sub-cap drops is
  // counted in skippedForCap, never silently lost.
  const replacements = [...replPreferred, ...replRest];
  const eligible = [
    ...preferred,
    ...rest,
    ...replacements.slice(0, REPLACEMENT_SUB_CAP),
  ];
  const subCapSkipped = Math.max(0, replacements.length - REPLACEMENT_SUB_CAP);
  return {
    selected: eligible.slice(0, cap),
    skippedForCap: Math.max(0, eligible.length - cap) + subCapSkipped,
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
 * The probe file that is the collocated test of `file` (the repo convention
 * `file.test.ts` / `file.spec.ts` beside it), if one is in `testPaths`.
 */
export function collocatedProbe(
  file: string,
  testPaths: readonly string[],
): string | undefined {
  const stem = file.replace(/\.[^./]+$/, '');
  return testPaths.find((t) => {
    const tstem = t.replace(/\.[^./]+$/, '');
    return tstem === `${stem}.test` || tstem === `${stem}.spec`;
  });
}

/**
 * Should this candidate be held `inconclusive` because the test collocated with
 * the file it touches was not green in the unmutated baseline — and if so, with
 * what explanation?
 *
 * ONE decision for both loops. The rule and its wording had already been
 * duplicated across the mutant and hunk guards, and the duplication had already
 * drifted twice: the hunk loop had the rule first and the mutant loop shipped
 * eight survivors through the gap before it was copied over, and the shared
 * explanation was then corrected in one place and hand-copied to the other.
 * A rule stated twice is a rule that will be true in one place.
 */
export function heldForRedCollocatedTest(
  kind: 'mutant' | 'hunk',
  file: string,
  probes: readonly string[],
  greenProbes: readonly string[],
  baselinePerFile: readonly ProbeOutcome[],
): string | undefined {
  const own = collocatedProbe(file, probes);
  if (!own || greenProbes.includes(own)) return undefined;
  return collocatedNotGreenDetail(kind, own, baselinePerFile);
}

/**
 * Did this spawn result start a suite and lose it, or never start one?
 *
 * Read off the result's STRUCTURE, not its message. The first version of this
 * matched `/^runner (killed|spawn failed)/` against the thrown text and was
 * inoperative: `spawnSync` reports a timeout as `error` (`ETIMEDOUT`, with
 * `signal` also set) and `runProbeSuite` throws `r.error` before it ever
 * composes a "runner killed by" sentence, so the real messages are
 * `spawnSync … ETIMEDOUT` and `spawnSync … ENOENT` and neither matched. The
 * tag it exists to produce was therefore never produced, and the test that
 * covered it asserted strings the code does not emit.
 *
 * A deadline kill may have executed most of the suite; a runner that could not
 * be started ran nothing. That is the distinction a reader acts on.
 */
export function runnerFailureReason(r: {
  error?: (Error & { code?: string }) | undefined;
  signal?: NodeJS.Signals | null;
}): ProbeReason {
  return r.signal || r.error?.code === 'ETIMEDOUT' ? 'runner-died' : 'not-run';
}

/** A probe run that threw, carrying WHY rather than leaving it to be parsed
 *  back out of the message. */
export class ProbeRunFailure extends Error {
  constructor(
    message: string,
    readonly reason: ProbeReason,
  ) {
    super(message);
    this.name = 'ProbeRunFailure';
  }
}

/** The reasons `classifyProbeRun` can produce — the only ones a baseline entry
 *  can carry, and so the only ones this explanation is written for. */
const BASELINE_REASON = new Set<ProbeReason>([
  'no-output',
  'not-in-results',
  'no-tests',
  'all-skipped',
]);

const REASON_PHRASE: Record<ProbeReason, string> = {
  // The suite ran and read green, but the control proved the runner could not
  // have reported otherwise.
  'control-failed':
    'it read green there, but the positive control failed, so nothing could have turned that run red',
  // Nothing ran: no worktree, the checkout failed, or the runner could not be
  // started at all — a spawn that fails with ENOENT never gets to a test.
  'not-run': 'no probe suite ran for it at all there',
  // Started and did not survive. How much of it ran before that is unknown.
  'runner-died':
    'the probe suite was started there and did not survive (killed at the deadline, or by a signal)',
  // Nothing is known about collection here — the runner never produced output
  // to read. Saying "collected no tests" would be the same invented cause this
  // function exists to stop, one layer down: a reader sent after a compile
  // error that is not there, while the runner itself is what fell over.
  'no-output':
    'the runner produced no parseable output there, so nothing at all is known about it',
  // The run answered, and this file was not in the answer. A compile or import
  // error looks like this — and so does a path that failed to match, which the
  // boundary and case rules in `classifyProbeRun` exist because of. Naming one
  // would be picking between two live possibilities.
  'not-in-results':
    'the run produced results there but none for it — which a compile or import error looks like, and so does a path that did not match',
  'no-tests':
    'it collected no tests there — the shape a compile or import error in the probe tree takes',
  'all-skipped': 'it collected tests there but executed none of them',
};

/** No entry at all — the baseline never reported this probe. Absent is its own
 *  state, and is not evidence that its tests failed. */
const NOT_REPORTED = 'the baseline did not report it';

/**
 * The whole sentence a mutant or hunk is held `inconclusive` with when its own
 * collocated test was not green in the unmutated baseline — the ONLY wording
 * either guard has, so what this returns is what the report says.
 *
 * It reads the reason off the baseline rather than asserting one. The ways a
 * probe fails to be green are different failures with different fixes, and the
 * guards used to name one of them flatly: measured on PR #8368,
 * `AuthDialog.test.tsx` compiled, collected 26 tests and failed exactly one,
 * and all three mutants in its source were held with "likely a compile or
 * import error in the probe tree" — sending a reader after an import problem
 * that was never there.
 *
 * A probe with no baseline entry at all is reported as not measured, which is a
 * different claim from measured-and-empty and the one the run actually
 * supports. It cannot arise in this pipeline — `classifyProbeRun` maps over
 * exactly the probe list `own` is drawn from — so it is a default, not a case.
 */
export function collocatedNotGreenDetail(
  kind: 'mutant' | 'hunk',
  probe: string,
  baselinePerFile: readonly ProbeOutcome[],
): string {
  const entry = baselinePerFile.find((p) => p.file === probe);
  const reason =
    entry === undefined
      ? NOT_REPORTED
      : entry.verdict === 'inconclusive'
        ? // Three reasons are set on the run-level `results` array and never by
          // `classifyProbeRun`, so a baseline entry cannot carry them. Reaching
          // one means the caller passed something other than the baseline —
          // say that, rather than emit "did not run green … it read green".
          BASELINE_REASON.has(entry.reason)
          ? REASON_PHRASE[entry.reason]
          : `the baseline did not classify it (${REASON_PHRASE[entry.reason]}), so this explanation does not apply to it`
        : entry.verdict === 'gated'
          ? 'it was RED there'
          : // `inert` IS green, so the sentence this function builds does not
            // apply to it. Say that, rather than produce a fluent claim that
            // contradicts the measurement — the caller is what is wrong here.
            'the baseline reported it GREEN, so this explanation does not apply to it';
  const what = kind === 'mutant' ? 'the statement' : 'the hunk';
  return `this ${kind}'s collocated test ${probe} did not run green in the unmutated baseline — ${reason}, so the remaining probes passing cannot show ${what} is uncovered`;
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
  return collocatedProbe(file, testPaths) !== undefined;
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
): ProbeResult[] {
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
      reason: 'no-output' as const,
      detail: `runner produced no parseable JSON (exit ${exitCode})${why ? `: ${why}` : ''}`,
    }));
  }

  const byFile = parsed.testResults ?? [];
  return probes.map((file) => {
    // `testResults[].name` is absolute; the probe path is repo-relative. Match
    // on a path-separator boundary, so `src/a.test.ts` cannot be satisfied by
    // `/w/vendor/other-src/a.test.ts` — a bare `endsWith` would take the wrong
    // file's verdict and never say so. Normalise `\` to `/` only on Windows:
    // there backslash IS a separator, but on POSIX it is a legal filename
    // character, so normalising it unconditionally would let
    // `/w/vendor/other\src/a.test.ts` satisfy `src/a.test.ts` — the very false
    // match the boundary exists to prevent. Fold case on Windows as well: its
    // paths are case-insensitive, so a drive letter or 8.3 name reported in a
    // different case would otherwise miss and read `inconclusive` — the same
    // wrong-verdict silence, in the other direction. Never fold on POSIX, where
    // case is significant.
    const probe =
      process.platform === 'win32'
        ? file.replace(/\\/g, '/').toLowerCase()
        : file;
    const result = byFile.find((r) => {
      const raw = r.name ?? '';
      const name =
        process.platform === 'win32'
          ? raw.replace(/\\/g, '/').toLowerCase()
          : raw;
      return name.endsWith(`/${probe}`) || name === probe;
    });
    const assertions = result?.assertionResults ?? [];
    const failed = assertions.filter((a) => a.status === 'failed').length;
    const passed = assertions.filter((a) => a.status === 'passed').length;

    if (!result) {
      // The run produced results and this file is not among them. A compile or
      // import error looks like this — and so does a path that did not match
      // (the boundary and case rules above are why that is not hypothetical),
      // and those are different problems. Say only what was observed.
      return {
        file,
        verdict: 'inconclusive' as const,
        reason: 'not-in-results' as const,
        detail: `the run produced results but none for this file (run exit ${exitCode}) — a compile or import error looks like this, and so does a path that did not match; not evidence either way`,
      };
    }
    if (assertions.length === 0) {
      return {
        file,
        verdict: 'inconclusive' as const,
        reason: 'no-tests' as const,
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
        reason: 'all-skipped' as const,
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

// Sanitized env on every git spawn below: an exported GIT_DIR redirects
// repository discovery for ALL of them at once — the head sha read, the probe
// resets, the revert's checkout — so the mutations would land in whichever
// repository the environment names while every check against the tree passes
// silently. The trees this file touches are chosen by the paths it is given.
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
  });
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
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * Resolve the vitest CLI entry the probe runs with.
 *
 * Spawning `process.execPath` against vitest's own entry — not `npx` — sidesteps
 * `npx.cmd` and shell quoting on Windows entirely. The entry is read from
 * vitest's `bin` field rather than a hard-coded `vitest.mjs`: `package.json`
 * pins a caret range, so a minor bump can move the bin target. A miss must also
 * explain itself — name the search root and what was sought — because the throw
 * lands in the probe's catch and an unexplained `inconclusive` is the one failure
 * shape a review must not have. `createRequire` anchored at the worktree does the
 * same up-tree walk Node uses for the probe's own imports, so it also survives
 * non-hoisted layouts.
 */
export function findVitestBin(
  worktree: string,
  resolveModule: (specifier: string) => string = createRequire(
    join(worktree, 'noop.js'),
  ).resolve,
): string {
  let pkgPath: string;
  try {
    pkgPath = resolveModule('vitest/package.json');
  } catch (error) {
    // Only a genuine MODULE_NOT_FOUND is "vitest not found". A present vitest
    // whose `exports` no longer exposes `./package.json` throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED — a different problem with a different fix;
    // folding it into "not found" sends the reader hunting a missing install.
    if ((error as { code?: string }).code === 'MODULE_NOT_FOUND') {
      throw new Error(`vitest not found searching up from ${worktree}`);
    }
    throw error;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    bin?: { vitest?: string };
  };
  const bin = pkg.bin?.vitest;
  if (!bin) {
    throw new Error(`vitest package at ${pkgPath} declares no "vitest" bin`);
  }
  return join(dirname(pkgPath), bin);
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
    env: sanitizedGitEnv(),
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
  const r = spawnSync('git', ['cat-file', '-e', `${rev}:${path}`], {
    cwd,
    env: sanitizedGitEnv(),
  });
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
  // Platform-correct separators, the same split `probeTargetEscapes` makes and
  // for the same reason: on POSIX a backslash is an ordinary character in a
  // filename, so splitting on it unconditionally turns ONE committed name —
  // `\\..\\review-pr-42\\package.json`, a legal POSIX filename — into three
  // components, two of which `join` then walks UP out of the tree. The write
  // side took this fix; the delete side is where it costs more.
  const separators = process.platform === 'win32' ? /[/\\]+/ : /\/+/;
  const parts = relPath.split(separators).filter((s) => s && s !== '.');
  // And nothing climbs, however it got spelled. `join` normalises `..` away
  // silently, which is what made the split above a delete-anywhere primitive
  // rather than a wrong-path bug.
  if (parts.includes('..')) {
    throw new Error(
      `refusing to delete through a parent reference: ${relPath}`,
    );
  }
  // The ROOT is an ancestor too, and the one this guarantee was missing: a
  // symlink at the tree root resolves the whole prefix in the kernel, so every
  // component below it lstats as an ordinary entry and the delete lands
  // wherever the root points — the shared review worktree, in the shape that
  // reached this function after a mid-run relink.
  try {
    if (lstatSync(worktree).isSymbolicLink()) {
      throw new Error(
        `refusing to delete through a symlink: ${relPath} ` +
          `(the tree root ${worktree} is a symlink)`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('refusing')) throw err;
    return; // No root to delete within.
  }
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

const existsAtBase = (cwd: string, base: string, path: string) =>
  existsAtRev(cwd, base, path);

/**
 * The warning for a probe worktree that survived its discard.
 *
 * Pure, and for the same reason as `worktreeCreateFailureDetail`: the branch it lives on
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
 * Put the probe tree's TRACKED files back to the commit, before a run.
 *
 * The tree is reused across the baseline, the control, every mutant and every
 * hunk probe, and what runs in it between those phases is the PR's own test
 * suite. {@link runProbeSuite} re-links `node_modules` for exactly this
 * reason; tracked files are the other half of the same state, and the half
 * that decides verdicts more directly. A suite that rewrites a probe file
 * after vitest has collected it — so the run it was collected for still scores
 * green — hands every later run a file of its choosing, and the verdict that
 * buys is `killed`: "a test catches this", asserted for statements no test
 * covers. The mirror direction plants a compile error and buys a blanket
 * `inconclusive`.
 *
 * Untracked files go too, because the tracked half alone is a half-measure a
 * suite can walk around: a `vitest.config.ts` that no zero-config project
 * commits is untracked, is picked up from the runner's cwd, and decides every
 * later run's collection. `-fd` and not `-fdx`, so the borrowed `node_modules`
 * farm and the ignored build output the probes need survive; what an ignored
 * path can still hide is the same blindness the residue probe discloses.
 *
 * Returns null when the tree is as the commit left it, or a reason when it
 * could not be put back — and an ABSENT `.git` is the second kind, not the
 * first. It is the one state the tree can never be restored from, `.git` is
 * an untracked pointer file sitting inside the tree the PR's own suite runs
 * in, and treating "nothing to restore from" as "nothing to restore" hands a
 * guest the whole guarantee for one `rm`. Running the restore anyway is not
 * the alternative: with no `.git`, discovery walks UP and checks the enclosing
 * repository out into the tree, which is the hazard the residue probe's
 * identity gate exists for. Refusing is the only answer that is neither.
 */
/**
 * The container argv for one probe-suite run, or null to spawn it directly.
 *
 * Same three null cases as `build-test`'s: policy off, no runtime under
 * `auto`, or a tree that is not under a review temp dir (a `/review` of a
 * local checkout, where there is no `.qwen/tmp` layout to mount).
 */
function probeContainer(
  command: string,
  probeTree: string,
): {
  file: string;
  args: string[];
  name: string;
  runtime: ContainerRuntime;
} | null {
  const verdict = sandboxVerdict();
  if (verdict.kind !== 'container') return null;
  const tmpDir = mountRootFor(probeTree);
  if (tmpDir === null) return null;
  // Canonical, matching the mount — see the twin in `build-test.ts`.
  const workdir = containerPathFor(probeTree);
  if (workdir === null) return null;
  const name = containerName();
  return {
    ...containerCommand(command, {
      cwd: workdir,
      tmpDir,
      kind: 'test',
      name,
      runtime: verdict.runtime,
      rootless: runtimeIsRootless(verdict.runtime),
      image: reviewSandboxImage(),
    }),
    name,
    runtime: verdict.runtime,
  };
}

function restoreProbeTreeTracked(probeTree: string): string | null {
  if (!existsSync(join(probeTree, '.git'))) {
    return `${probeTree} carries no .git, so there is no commit to put it back to`;
  }
  const top = spawnSync(
    'git',
    [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
      '--git-dir',
    ],
    { cwd: probeTree, encoding: 'utf8', env: sanitizedGitEnv() },
  );
  if (top.error || top.status !== 0 || typeof top.stdout !== 'string') {
    return top.error
      ? top.error.message
      : (top.stderr ?? '').toString().trim() ||
          `git rev-parse exited ${top.status}`;
  }
  const [toplevel, commonDir, gitDir] = top.stdout.trim().split('\n');
  try {
    // The LEAF first. Every comparison below realpaths both sides, so a probe
    // tree that is itself a symlink into the shared review worktree agrees
    // with itself all the way down — and the restore's `checkout --force` and
    // `clean -ffdx` would then run in the tree every other agent is reading.
    if (lstatSync(probeTree).isSymbolicLink()) {
      return `${probeTree} is a symlink, so the restore would land wherever it points`;
    }
    if (realpathSync(toplevel) !== realpathSync(probeTree)) {
      return `the tree at ${probeTree} is not the root of its own checkout`;
    }
    // `--show-toplevel` prints the directory the `.git` FILE sits in, whatever
    // that file points at — so a rewritten gitfile naming another repository
    // passes the check above while the checkout below writes THAT repository's
    // content into this tree and certifies it. `scratch-tree` gates its own
    // reset on the admin entry pointing back, and this function is the same
    // reset one directory over; it now asks the same question — of the shape
    // that HAS an answer. A probe tree the pipeline built is a linked worktree
    // and carries its `.git` as a gitfile; a plain checkout has a `.git`
    // DIRECTORY and no admin entry to round-trip, and demanding one there
    // would refuse every ordinary repository.
    if (lstatSync(join(probeTree, '.git')).isFile()) {
      const backpointer = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim();
      if (
        realpathSync(dirname(resolve(gitDir, backpointer))) !==
        realpathSync(probeTree)
      ) {
        return `${probeTree}'s admin entry does not point back at it`;
      }
      // And every ancestor between the tree and the repository it belongs to:
      // a link above the tree redirects the checkout and the clean together,
      // while every check here resolves through it and agrees with itself.
      // Only for a LINKED worktree — a standalone checkout IS the repository
      // root, so there is nothing between it and the stop point to walk, and
      // an unbounded walk above it meets the system links (`/var` on macOS)
      // this bound exists to stay below.
      const redirected = redirectedAncestor(
        dirname(resolve(probeTree)),
        dirname(realpathSync(commonDir)),
      );
      if (redirected !== null) {
        return `${redirected} is a symlink, so the restore would land wherever it points`;
      }
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  // A pathspec checkout runs no hook — but the config that decides that lives
  // in a tree this code is defending against, so it is emptied here the way
  // every other checkout in this pipeline empties it. `--` and a pathspec:
  // this restores FILES and never moves HEAD.
  // Filters, before either spawn. A checkout EXECUTES `filter.<name>.smudge`
  // whenever it rewrites a file, and the restore below rewrites every tracked
  // file this tree has — so the same surface `scratch-tree` refuses to reset
  // through was, one directory over, run through twice per probe run. The
  // screen reads repo-LOCAL config only: `git lfs install` writes
  // `filter.lfs.clean` into the user's GLOBAL config, and refusing on that
  // would put every contributor with git-lfs into permanent refusal — the same
  // failure as a tripwire that fires on every healthy run.
  const filters = localFilterCommands(probeTree);
  if (filters.unreadable) {
    return `the screen could not clear this tree's restore: ${screenStopDetail(filters)}`;
  }
  if (filters.keys.length > 0) {
    return `the repository's local config defines content filter(s) ${screenKeyList(filters)}, which this tree's restore would EXECUTE`;
  }
  // `core.fsmonitor` runs a command on BOTH of these, and the config that sets
  // it lives in the tree they are cleaning: the residue probe empties it for
  // exactly this reason and these two spawns were the ones still steerable.
  const inert = [
    '-c',
    'core.hooksPath=/dev/null/no-hooks',
    '-c',
    'core.fsmonitor=',
  ];
  for (const args of [
    [...inert, 'checkout', '--force', 'HEAD', '--', '.'],
    // `-ffdx`, because `-fd` honors the ignore rules — and those belong to the
    // commit under test, so a plant named to match one of them (a committed
    // `.gitignore` line and a file to match it) survived every restore. The
    // one exception is the dependency farm: it is ignored, it is borrowed
    // rather than built, and it is the only ignored thing in this tree the
    // probes cannot run without. Everything else ignored — a built `dist`, a
    // planted config — goes.
    [...inert, 'clean', '-ffdx', '-e', 'node_modules'],
  ]) {
    const r = spawnSync('git', args, {
      cwd: probeTree,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
    });
    if (r.error) return r.error.message;
    if (r.status !== 0) {
      return (
        (r.stderr ?? '').toString().trim() ||
        `git ${args[2]} exited ${r.status}`
      );
    }
  }
  // `checkout --force` SILENTLY skips a file carrying the skip-worktree bit,
  // and `clean` never touches a tracked file — so a bit the suite set with
  // `update-index` leaves its tampered content standing through a restore that
  // returns "as the commit left it", with `git status` reading empty.
  // `scratch-tree` documents this shape for the identical reset and refuses on
  // it; this function did not read the bits at all.
  const bits = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=', 'ls-files', '-v', '-z'],
    {
      cwd: probeTree,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    },
  );
  if (bits.error || bits.status !== 0 || typeof bits.stdout !== 'string') {
    return bits.error
      ? bits.error.message
      : (bits.stderr ?? '').toString().trim() ||
          `git ls-files exited ${bits.status}`;
  }
  if (bits.stdout.split('\0').some((rec) => /^[a-zS]/.test(rec))) {
    return 'the index carries skip-worktree or assume-unchanged bits, so the restore cannot have reached every tracked file';
  }
  return null;
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
  dependencyRoot: string = probeTree,
): {
  perFile: ProbeResult[];
  ms: number;
  exposed: { linked: number; failed: number };
} {
  const started = now();
  const timeout =
    deadlineAt !== undefined
      ? Math.max(1, Math.min(PROBE_RUN_TIMEOUT_MS, deadlineAt - started))
      : PROBE_RUN_TIMEOUT_MS;
  // `rebuild` because this tree is reused across the baseline, the control,
  // every mutant and the revert probe, and the code running in it is the PR's
  // own test code: a suite that plants or replaces a module in `node_modules`
  // would otherwise decide every later run's verdict. Re-linking costs about a
  // second per run against the budget's minutes.
  // The farm's link TARGETS must be spelled the way the mount is. The mount and
  // `--workdir` are canonical (`mountRootFor` realpaths), while
  // `exposeDependencies` builds targets from the argument it is given — so
  // under a symlinked ancestor (macOS `/tmp` → `/private/tmp` is the everyday
  // one) every link dangles INSIDE the container, and the phase reports "every
  // file was red or collected nothing": a wiring failure published as a
  // statement about the PR's own suite. Canonicalise what crosses the
  // boundary, and only there — the direct path keeps the caller's spelling.
  let farmRoot = dependencyRoot;
  if (sandboxVerdict().kind === 'container') {
    try {
      farmRoot = realpathSync(dependencyRoot);
    } catch {
      // Unresolvable: the farm below reports what it could not link.
    }
  }
  const exposed = exposeDependencies(probeTree, farmRoot, {
    rebuild: true,
  });
  // The reviewed repository's own suite, run once per baseline / control /
  // mutant / hunk probe / revert — the second of the two places a review
  // executes the code it is reviewing (#9556). Sandboxed it is a container
  // per run, offline, with an env allowlist instead of this process's own;
  // unsandboxed it is the direct spawn this has always been, and the caller
  // has already disclosed that.
  // `node` off the IMAGE's PATH, not `process.execPath`: the host's interpreter
  // path (`/usr/bin/node` here, `/opt/hostedtoolcache/…` on a GitHub runner) is
  // neither mounted nor present in the image, so baking it in exits 127 and
  // maps every probe — baseline, control, each mutant, each hunk, the revert —
  // to inconclusive, blaming the runner's output for a wiring error. The vitest
  // bin path DOES resolve, because it lives under the mounted temp dir.
  const suite = `node ${shellQuotePath(
    findVitestBin(dependencyRoot),
  )} run --reporter=json ${probes.map(shellQuotePath).join(' ')}`;
  const boxed = probeContainer(suite, probeTree);
  const r = boxed
    ? spawnSync(boxed.file, boxed.args, {
        cwd: probeTree,
        encoding: 'utf8',
        timeout,
        // SIGKILL, not the default SIGTERM, and only on the boxed branch.
        // `spawnSync` sends its `killSignal` at the deadline and then WAITS for
        // the child to exit — so an attached runtime client that forwards the
        // signal and keeps waiting on a workload whose own trap ignores it
        // never returns, and the `killContainer` below is never reached. That
        // is what made the round-4 machinery unreachable rather than wrong.
        // SIGKILL cannot be ignored, so the client dies, the call returns, and
        // the container is then reaped BY NAME at the daemon — which is where
        // the deadline had to be enforced all along.
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
        // The RUNTIME CLIENT's environment, minus the daemon-selecting
        // variables a repository could have shipped in its own `.env` — the
        // container's own environment is the allowlist in `containerEnv`.
        env: runtimeClientEnv(),
      })
    : spawnSync(
        process.execPath,
        [findVitestBin(dependencyRoot), 'run', '--reporter=json', ...probes],
        {
          cwd: probeTree,
          encoding: 'utf8',
          timeout,
          // Vitest's JSON reporter on a large suite easily exceeds spawnSync's
          // 1 MiB default stdout buffer, which returns ENOBUFS and turns every
          // probe `inconclusive`. Match the 64 MiB ceiling the gh wrapper uses.
          maxBuffer: 64 * 1024 * 1024,
        },
      );
  // `r.error` is set — and `r.status` is null — when the process never ran
  // (vitest entry missing or unresolvable) or was killed (the timeout above
  // fires SIGTERM). Ignoring it reports those as "the runner produced no
  // parseable JSON", which
  // blames the runner's output for a run that produced none.
  // `r.error` first, as before: when both are set — ENOBUFS on a run that was
  // also killed — the error names the actual failure and the signal only says
  // it did not finish. Reversing them buried `ENOBUFS` under "killed by
  // SIGTERM", which is a less useful sentence about the same event. The reason
  // tag is derived from the whole result either way, so it does not depend on
  // which message wins.
  if (boxed && boxedRunLeftContainer(r.status)) {
    // The deadline killed the CLIENT; the container outlives it — `--rm` fires
    // only on a self-exit. Reach the daemon before reporting, or a
    // TERM-ignoring suite keeps this mount writable past the end of the review.
    killContainer(boxed.runtime, boxed.name);
  }
  if (r.error)
    throw new ProbeRunFailure(r.error.message, runnerFailureReason(r));
  if (r.signal) {
    throw new ProbeRunFailure(
      `runner killed by ${r.signal}${r.signal === 'SIGTERM' ? ` (probe timed out after ${Math.round(timeout / 1000)}s)` : ''}`,
      runnerFailureReason(r),
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
    exposed,
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
 * in a fresh checkout every ancestor is a real directory. The LEAF is a different
 * story — a PR can commit it as a symlink (mode 120000) — and every write site
 * below refuses one rather than write through it.)
 *
 * Exported for its tests: the never-delete-a-mismatched-line guard cannot be
 * reached through the command (selection and the probe tree derive from the
 * same commit), so the test pins it directly rather than not at all.
 */
/**
 * Split one file's diff into one self-contained patch per hunk.
 *
 * The statement mutants answer "is this one safety statement protected?" for a
 * deliberately narrow class of statement; the revert probe answers "is ANY of
 * this protected?" all at once. Between them sits the question neither can
 * reach: **which particular change in this diff has no test behind it.** A hunk
 * is the natural unit for that — it is the granularity the author wrote and the
 * granularity a reviewer reads — and reverting one at a time is the only way to
 * attribute a green suite to a specific change rather than to the diff at large.
 *
 * A column-0 `@@` is unambiguously a hunk header: every body line of a unified
 * diff starts with ' ', '+', '-' or '\', so a removed line whose own text begins
 * `@@` arrives as `-@@` and cannot be mistaken for one.
 *
 * Rename patches are not guarded here: `hunkProbeInputs` diffs one pathspec at
 * a time, so a rename renders as a pure add (`--- /dev/null`) and
 * `selectHunkProbes` skips it. A rename reaching `runOneHunkProbe` directly
 * would reverse-apply the rename and leave both paths present.
 */
export function splitDiffIntoHunks(
  diffText: string,
): Array<{ header: string; patch: string; startLine: number }> {
  const lines = diffText.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  if (first < 0) return [];
  // Re-captured at every `diff --git` boundary: a hunk's patch must carry ITS
  // file's header, or a multi-file diff hands git a patch naming the wrong
  // file. (Latent while hunkProbeInputs diffs one path at a time — but this is
  // exported and reads as general-purpose, so it behaves as one.)
  // Start from the LAST `diff --git` before the first `@@`: a binary entry
  // before it has no hunks, and including its header in the initial slice
  // would hand the first real hunk a patch naming two files.
  let headerStart = 0;
  for (let k = first - 1; k >= 0; k--) {
    if (lines[k].startsWith('diff --git ')) {
      headerStart = k;
      break;
    }
  }
  let fileHeader = lines.slice(headerStart, first);
  const out: Array<{ header: string; patch: string; startLine: number }> = [];
  let i = first;
  while (i < lines.length) {
    if (lines[i].startsWith('diff --git ')) {
      const start = i;
      while (
        i < lines.length &&
        !lines[i].startsWith('@@') &&
        !(i > start && lines[i].startsWith('diff --git '))
      )
        i++;
      fileHeader = lines.slice(start, i);
      continue;
    }
    if (!lines[i].startsWith('@@')) {
      i++;
      continue;
    }
    const header = lines[i];
    let j = i + 1;
    while (
      j < lines.length &&
      !lines[j].startsWith('@@') &&
      !lines[j].startsWith('diff --git ')
    ) {
      j++;
    }
    // Anchor at the first ADDED line, not the hunk header's start: the header
    // opens up to three context lines above the change, and a finding anchored
    // on untouched context misleads the reader (and the inline-comment anchor).
    let startLine = Number(
      /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(header)?.[1] ?? '0',
    );
    let offset = 0;
    for (let k = i + 1; k < j; k++) {
      if (lines[k].startsWith('+')) {
        startLine += offset;
        break;
      }
      // `\ No newline at end of file` marks no file line — exclude it like a
      // removal, or startLine drifts off by one per marker (parseAddedLines
      // already excludes it the same way).
      if (!lines[k].startsWith('-') && !lines[k].startsWith('\\')) offset++;
    }
    out.push({
      header: header.trim(),
      startLine,
      // `git apply` requires the trailing newline; a patch that ends mid-line is
      // rejected with `corrupt patch`.
      patch: `${[...fileHeader, ...lines.slice(i, j)].join('\n').replace(/\n+$/, '')}\n`,
    });
    i = j;
  }
  return out;
}

/**
 * The hunks worth probing, in the order they should be spent.
 *
 * Two selection rules, both about not paying twice for the same answer:
 *
 *  - **A hunk that already contains a mutant is skipped.** The mutant ran a
 *    finer-grained version of the same experiment on that hunk's own lines; a
 *    second run over the whole hunk buys a coarser answer at the same price,
 *    and the budget is better spent on ground nothing has covered.
 *  - **Files whose collocated tests the diff also touches go first**, as with
 *    mutants: a survivor is most informative exactly where the PR claims its
 *    new tests cover the new code.
 *
 * Candidates the cap cannot fit are counted, never dropped in silence — a
 * capped `survived: 0` that read as "every change is covered" is the same false
 * assurance the mutant cap already guards against.
 */
export function selectHunkProbes(
  files: Array<{
    file: string;
    diff: string;
    hasNewTests: boolean;
    mutantLines: number[];
  }>,
  cap: number = MAX_HUNK_PROBES,
): { selected: HunkCandidate[]; skippedForCap: number } {
  const preferred: HunkCandidate[] = [];
  const rest: HunkCandidate[] = [];
  for (const f of files) {
    // A deleted file's hunks are all removals; `runOneHunkProbe` reads the
    // file first and returns `inconclusive` every time. Spending cap slots on
    // guaranteed inconclusives wastes the budget on a delete-heavy diff.
    // An added file's reverse-apply deletes the whole file — the same waste
    // when a probe imports it, and a file-level statement wearing a hunk-level
    // message when nothing does.
    if (f.diff.includes('\n+++ /dev/null')) continue;
    if (f.diff.includes('\n--- /dev/null')) continue;
    const hunks = splitDiffIntoHunks(f.diff);
    hunks.forEach((h, index) => {
      // Range from the header's new-side start, not `startLine`: that anchor
      // sits at the first ADDED line, past leading context, so adding the hunk's
      // full new-side length to it overshoots the hunk's end by the context-line
      // count and silently skips a mutant in a closely following hunk.
      const hunkStart = Number(
        /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(h.header)?.[1] ?? '0',
      );
      const end = hunkStart + newSideLength(h.header);
      if (f.mutantLines.some((n) => n >= hunkStart && n < end)) return;
      (f.hasNewTests ? preferred : rest).push({
        file: f.file,
        index,
        header: h.header,
        startLine: h.startLine,
        patch: h.patch,
      });
    });
  }
  const eligible = [...preferred, ...rest];
  return {
    selected: eligible.slice(0, cap),
    skippedForCap: Math.max(0, eligible.length - cap),
  };
}

/** New-side line count from an `@@ -a,b +c,d @@` header (`d` defaults to 1). */
function newSideLength(header: string): number {
  const m = /^@@ -\d+(?:,\d+)? \+\d+(?:,(\d+))? @@/.exec(header);
  return m ? Number(m[1] ?? '1') : 1;
}

/**
 * Whether a probe target resolves OUT of the tree through a symlink — at the
 * LEAF or at any ANCESTOR. A PR can commit a test or source file as mode
 * 120000 naming anywhere a relative path reaches — including the shared
 * review worktree, whose sibling path is predictable — and the probe writes
 * below would follow the link and land there. Checking the leaf alone is not
 * enough: `lstat` resolves every intermediate component, so once a directory
 * in a REUSED probe tree has been relinked by code that ran in it, a leaf
 * check reports the outside file as ordinary and every later write follows
 * the link — the same escape class `safeRmWithin` walks ancestors for on the
 * delete side. Any symlink on the path is refused as inconclusive (or a
 * control that never ran) rather than written through; a component missing on
 * disk escapes nothing — the read or write fails on its own.
 */
function probeTargetEscapes(probeTree: string, file: string): boolean {
  // The separator set is platform-dependent: on POSIX a backslash is an
  // ordinary NAME character, so splitting on it turns `x\\y.test.ts` into two
  // phantom components, the first `lstat` dies ENOENT, and the catch below
  // reports "no escape" for a leaf nobody ever looked at.
  const separators = process.platform === 'win32' ? /[/\\]+/ : /\/+/;
  const parts = file.split(separators).filter((part) => part && part !== '.');
  // The ROOT first: replacing the probe tree itself with a symlink defeats
  // every per-component check at once, because the kernel resolves the prefix
  // and each component below it lstats as an ordinary entry.
  let cur = probeTree;
  try {
    if (lstatSync(cur).isSymbolicLink()) return true;
  } catch {
    return true; // No tree to write into is not a tree to trust.
  }
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Neutralise ONE hunk in the probe tree, run the affected tests, restore.
 *
 * Reverse-applying the hunk's own patch is what makes this attributable: `git
 * checkout base -- <file>` would revert the whole file and the verdict would
 * belong to no particular change, which is precisely the all-or-nothing limit
 * of the revert probe. `git` does the line-offset arithmetic, so a hunk later in
 * the file is neutralised at the right place without this code tracking offsets.
 *
 * The asymmetry the mutants established holds here too, and for the same
 * reason: a patch that will not apply, or a tree that will not compile without
 * the hunk, is `inconclusive` — NEVER `killed`. A compile error says nothing
 * about whether a test would have caught a behavioural regression, and scoring
 * it as "a test caught it" is exactly the false assurance this command exists
 * to remove.
 */
export function runOneHunkProbe(
  probeTree: string,
  hunk: HunkCandidate,
  probes: string[],
  deadlineAt?: number,
  now: () => number = Date.now,
  dependencyRoot: string = probeTree,
): HunkResult {
  const { patch: _patch, ...meta } = hunk;
  const abs = join(probeTree, hunk.file);
  if (probeTargetEscapes(probeTree, hunk.file)) {
    return {
      ...meta,
      verdict: 'inconclusive',
      detail:
        'the probe target resolves through a symlink — the reverse patch and the restore would follow it out of the probe tree, so nothing was neutralised',
    };
  }
  const stale = restoreProbeTreeTracked(probeTree);
  if (stale !== null) {
    return {
      ...meta,
      verdict: 'inconclusive',
      detail: `the probe tree could not be put back to the commit before this run, so an earlier run's writes may still be standing: ${stale}`,
    };
  }
  let original: string;
  try {
    original = readFileSync(abs, 'utf8');
  } catch (e) {
    return {
      ...meta,
      verdict: 'inconclusive',
      detail: `the probe tree does not hold ${hunk.file}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // Re-check at the write itself: the guard above and the apply below are a
  // check-then-use pair, and the threat this guard exists for has a shell
  // inside these trees and picks its moment.
  if (probeTargetEscapes(probeTree, hunk.file)) {
    return {
      ...meta,
      verdict: 'inconclusive',
      detail:
        'the probe target was relinked through a symlink before the reverse patch applied — nothing was neutralised',
    };
  }
  const applied = spawnSync('git', ['apply', '--reverse', '-'], {
    cwd: probeTree,
    input: hunk.patch,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
  });
  if (applied.error || applied.status !== 0) {
    // Nothing was changed (git applies a patch atomically), so there is nothing
    // to restore — and nothing was learned.
    return {
      ...meta,
      verdict: 'inconclusive',
      detail: `the hunk could not be reverse-applied, so nothing was neutralised: ${(applied.stderr ?? applied.error?.message ?? '').toString().trim()}`,
    };
  }
  // Re-validation of the restore write must be able to STOP the phase — a
  // throw from inside the finally itself is not safe — so the attempt reports
  // what its finally saw, and the refusal lands after it.
  let relinkedMidRun = false;
  const attempt = (): HunkResult => {
    try {
      const { perFile } = runProbeSuite(
        probeTree,
        probes,
        deadlineAt,
        now,
        dependencyRoot,
      );
      const verdict = classifyMutantRun(perFile);
      const detail =
        verdict === 'killed'
          ? 'the suite went red with this hunk reverted — a test covers this change'
          : verdict === 'survived'
            ? 'every affected test still PASSED with this hunk reverted — no test in this diff fails when the change is undone'
            : 'the tree with this hunk reverted produced no clean verdict (likely a compile or import error) — not evidence either way';
      return { ...meta, verdict, detail };
    } finally {
      // Re-validate immediately before the restore WRITE: the suite the
      // reverse patch just ran on is the PR's own test code, and it can
      // relink the target while the run is in flight. A restore through the
      // link is the same escape as a mutation through it — refuse it, and
      // let the throw below stop the phase: a tree this code can no longer
      // restore is a tree no later probe may trust.
      if (probeTargetEscapes(probeTree, hunk.file)) {
        relinkedMidRun = true;
      } else {
        // Restore by content, not by re-applying the patch forward: a forward
        // apply can fail on its own and would leave the tree neutralised for
        // every later probe, turning one bad restore into a run of false
        // survivors. Writing the saved bytes back also recreates a file the
        // reverse patch deleted — and the parent directory first:
        // reverse-applying a `new file` hunk removes the directories it
        // emptied, and a restore that throws ENOENT here loses the verdict
        // AND marks every remaining hunk inconclusive.
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, original, 'utf8');
      }
    }
  };
  const result = attempt();
  if (relinkedMidRun) {
    throw new Error(
      `refusing to restore ${hunk.file} through a symlink — the probe tree was relinked mid-run`,
    );
  }
  return result;
}

/**
 * The positive control: append one always-failing test to a GREEN probe file,
 * run that file, restore. Red = the harness demonstrably executes assertions
 * (true), green = it does not (false). Restore is by content in finally, the
 * same discipline as every other probe edit in this file.
 *
 * `null` is the THIRD outcome, and it is not the same as `false`: the control
 * never ran, so nothing was demonstrated either way. Returning `false` there
 * would state as fact that an injected test stayed green when none was ever
 * injected — the fabricated verdict this file's budget path already refuses
 * ("never a fabricated true or false"), and it would additionally discard the
 * whole mutant/hunk window over an I/O error.
 *
 * KNOWN BOUND: it validates ONE file, not the collection. The injection goes
 * into `greenProbes[0]`, so a collector that silently drops a DIFFERENT probe
 * file still passes the control while that file's survivors stand. The
 * per-file baseline gate bounds the residual window — a file that collected
 * nothing is never scored green to begin with — so what is left is a collector
 * that runs one file and skips another. Named because a `true` here is read as
 * covering the whole run.
 */
export function runControlMutant(
  probeTree: string,
  probeFile: string,
  deadlineAt?: number,
  now: () => number = Date.now,
  dependencyRoot: string = probeTree,
): boolean | null {
  const abs = join(probeTree, probeFile);
  // A probe file reached through a symlink — at the leaf or an ancestor —
  // would take the injection OUT of the probe tree: into the shared review
  // worktree for a link aimed at the predictable sibling path. The control
  // never ran, which is `null`, not a verdict.
  if (probeTargetEscapes(probeTree, probeFile)) return null;
  // A control run on a tree an earlier run wrote into demonstrates that
  // tree's behaviour, not the suite's — and this is the run every survivor
  // verdict is conditioned on.
  if (restoreProbeTreeTracked(probeTree) !== null) return null;
  let original: string;
  try {
    original = readFileSync(abs, 'utf8');
  } catch {
    return null; // cannot even read the probe file — nothing was demonstrated
  }
  let relinkedMidRun = false;
  const attempt = (): boolean | null => {
    try {
      // Same pre-write re-check as the mutant and hunk paths: the entry guard
      // is several calls back, and the injection is what would follow a link
      // out of the tree.
      if (probeTargetEscapes(probeTree, probeFile)) return null;
      writeFileSync(
        abs,
        `${original}\n;import { it as __qcIt, expect as __qcExpect } from 'vitest';\n__qcIt('QWEN-REVIEW-POSITIVE-CONTROL', () => {\n  __qcExpect(1).toBe(2);\n});\n`,
        'utf8',
      );
      const { perFile } = runProbeSuite(
        probeTree,
        [probeFile],
        deadlineAt,
        now,
        dependencyRoot,
      );
      // `gated` is the runner's "went red" verdict; anything else — still
      // green, collected nothing, crashed — means the control did NOT
      // demonstrate a working kill path.
      return perFile.some((r) => r.verdict === 'gated');
    } finally {
      // Same re-validation as every other restore write: the run just
      // executed the PR's own test code, which can relink the target
      // mid-run. Refuse the write; the throw below stops the phase.
      if (probeTargetEscapes(probeTree, probeFile)) {
        relinkedMidRun = true;
      } else {
        writeFileSync(abs, original, 'utf8');
      }
    }
  };
  const demonstrated = attempt();
  if (relinkedMidRun) {
    throw new Error(
      `refusing to restore ${probeFile} through a symlink — the probe tree was relinked mid-run`,
    );
  }
  return demonstrated;
}

export function runOneMutant(
  probeTree: string,
  mutant: MutantCandidate,
  probes: string[],
  deadlineAt?: number,
  now: () => number = Date.now,
  dependencyRoot: string = probeTree,
): MutantResult {
  const abs = join(probeTree, mutant.file);
  if (probeTargetEscapes(probeTree, mutant.file)) {
    return {
      ...mutant,
      verdict: 'inconclusive',
      detail:
        'the probe target resolves through a symlink — the mutation and the restore would follow it out of the probe tree, so nothing was mutated',
    };
  }
  const stale = restoreProbeTreeTracked(probeTree);
  if (stale !== null) {
    return {
      ...mutant,
      verdict: 'inconclusive',
      detail: `the probe tree could not be put back to the commit before this run, so an earlier run's writes may still be standing: ${stale}`,
    };
  }
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
  // A replacement operator edits the line; the legacy shape deletes it.
  const what =
    mutant.operator === 'coalesce'
      ? 'with its `?? fallback` dropped'
      : mutant.operator === 'guard-true'
        ? 'with its guard condition replaced by `true`'
        : mutant.operator === 'term-drop'
          ? 'with its `+ CONSTANT` term dropped'
          : 'deleted';
  if (mutant.mutated !== undefined) {
    lines[mutant.line - 1] = mutant.mutated;
  } else {
    lines.splice(mutant.line - 1, 1);
  }
  let relinkedMidRun = false;
  const attempt = (): MutantResult => {
    try {
      // Re-check at the write itself. The guard at the top of this function
      // and this line are a check-then-use pair with a `readFileSync` and a
      // restore between them, and the threat it exists for has a shell inside
      // these trees and picks its moment — the hunk probe carries the same
      // re-check immediately before its own mutation op, with the same
      // reasoning, and these two writes were the ones without it.
      if (probeTargetEscapes(probeTree, mutant.file)) {
        return {
          ...mutant,
          verdict: 'inconclusive',
          detail:
            'the probe target was relinked through a symlink before the mutation was written — nothing was mutated',
        };
      }
      writeFileSync(abs, lines.join('\n'), 'utf8');
      const { perFile } = runProbeSuite(
        probeTree,
        probes,
        deadlineAt,
        now,
        dependencyRoot,
      );
      const verdict = classifyMutantRun(perFile);
      const detail =
        verdict === 'killed'
          ? `the suite went red with this statement ${what} — a test catches it`
          : verdict === 'survived'
            ? `every affected test still PASSED with this statement ${what} — no test fails ${
                mutant.mutated === undefined
                  ? 'when it is removed'
                  : 'when it changes'
              }`
            : 'the mutated tree produced no clean verdict (likely a compile or import error) — not evidence either way';
      return { ...mutant, verdict, detail };
    } finally {
      // Same re-validation as every other restore write: the suite just ran
      // the PR's own test code, which can relink the target mid-run. Refuse
      // the write; the throw below stops the phase.
      if (probeTargetEscapes(probeTree, mutant.file)) {
        relinkedMidRun = true;
      } else {
        writeFileSync(abs, original, 'utf8');
      }
    }
  };
  const result = attempt();
  if (relinkedMidRun) {
    throw new Error(
      `refusing to restore ${mutant.file} through a symlink — the probe tree was relinked mid-run`,
    );
  }
  return result;
}

/**
 * The per-file inputs `selectHunkProbes` needs, read from the COMMITTED head.
 *
 * Same discipline as mutant selection: the diff comes from `base..HEAD` and so
 * describes exactly the tree the probe worktree checks out, never whatever
 * uncommitted state the shared worktree happens to hold. Default context (three
 * lines) rather than `--unified=0`, because these patches are handed to
 * `git apply`, which needs context to place a hunk.
 *
 * Per-file failures are swallowed to an empty diff: a blob that will not read
 * says nothing about any test, and it must not take down the probing of the
 * other files.
 */
function hunkProbeInputs(
  worktree: string,
  base: string,
  headSha: string,
  sources: string[],
  probes: string[],
  mutants: MutantCandidate[],
): Array<{
  file: string;
  diff: string;
  hasNewTests: boolean;
  mutantLines: number[];
}> {
  return sources.map((file) => {
    let diff = '';
    try {
      diff = gitCapture(
        worktree,
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-ext-diff',
        '--no-textconv',
        base,
        headSha,
        '--',
        file,
      );
    } catch {
      diff = '';
    }
    return {
      file,
      diff,
      hasNewTests: hasCollocatedNewTest(file, probes),
      mutantLines: mutants.filter((m) => m.file === file).map((m) => m.line),
    };
  });
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

  const efficacyPlan = planTestEfficacy(plan.files ?? [], globs);
  const { unreachable, revert } = efficacyPlan;
  // `let` because probes committed as symlinks are dropped from it below,
  // before any vitest run collects them.
  let { probes } = efficacyPlan;
  // The probe set as PLANNED, kept whole: the symlink drop below narrows
  // `probes` to what will actually run, while the collocated-test hold has to
  // keep asking whether a mutant's own test EXISTS at all.
  let allProbes = probes;

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

  // `ProbeResult`, not a structural echo of it: this array is what `probed`
  // serialises, so an entry pushed here without a reason is an untagged
  // `inconclusive` in the artifact — the exact hole the union was introduced to
  // close, reopened one level up. Typed this way, neither catch below nor the
  // control-failed re-class compiles until it says which way it failed.
  const results: ProbeResult[] = [];
  let cleanupFailure: string | undefined;
  const mutantResults: MutantResult[] = [];
  let mutantsSkippedForBudget = 0;
  let mutantsSkippedForCap = 0;
  const hunkResults: HunkResult[] = [];
  let hunksSkippedForBudget = 0;
  let hunksSkippedForCap = 0;
  let hunksSkippedForBaseline = 0;
  /** Null until the positive control ran; false = dead runner, survivors lie. */
  let harnessValidated: boolean | null = null;
  // Its OWN counter, not the budget's or the baseline's: a control that came
  // back red stops the run with candidates still unprobed, and folding them
  // into `skippedForBudget` would say the window ran out when it did not. The
  // note explains why; these numbers are what a reader can count.
  let mutantsSkippedForControl = 0;
  let hunksSkippedForControl = 0;
  let mutantsSkippedForBaseline = 0;
  let mutantsNote: string | undefined;
  // Notes can stack (a derailed file AND a red baseline); never clobber one
  // disclosure with another.
  const noteMutants = (note: string) => {
    mutantsNote = mutantsNote ? `${mutantsNote}; ${note}` : note;
  };
  // A partial dependency farm lets vitest spawn but fails every probe's
  // imports, reading red for a reason that is not the tests. Disclose it rather
  // than let the report blame the suite for links that never arrived.
  const noteDependencyFarm = (exposed: {
    linked: number;
    failed: number;
  }): void => {
    if (exposed.failed > 0) {
      noteMutants(
        `dependency farm incomplete: exposed ${exposed.linked}/${
          exposed.linked + exposed.failed
        } dependencies into the probe tree (${
          exposed.failed
        } failed to link) — probe results may not be evidence`,
      );
    }
  };

  // BEFORE the probe tree is even created. Every run this phase makes executes
  // the reviewed repository's suite, so under `review.sandbox: required` with no
  // container runtime the honest outcome is no efficacy evidence — not evidence
  // bought by running that suite unsandboxed. Refusing here rather than at the
  // spawn keeps the report's vocabulary intact: the phase produced nothing, and
  // says why, instead of a run of probes each blaming the runner.
  // The probe tree this phase WOULD build, named before it exists — the gate
  // has to answer before anything is created, and `probeWorktreePath` is a
  // pure path function.
  const sandboxRefusal = refuseUnsandboxedPhase(probeWorktreePath(worktree));
  if (sandboxRefusal) {
    noteMutants(
      `mutation probes did not run: ${sandboxRefusal}. Every probe executes ` +
        `the reviewed repository's own test suite, which is what the policy ` +
        `forbids unsandboxed — read the absence as unmeasured, not as covered.`,
    );
  } else if (probes.length > 0 && revert.length > 0) {
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

    // Hunk candidates are chosen HERE, beside the mutants, and not inside the
    // mutant branch below. Gating them on `candidates.length > 0` would run
    // per-hunk probes only on diffs that already have a safety-verb mutant —
    // exactly inverting their purpose, which is to cover the changes the
    // safety-verb filter cannot see. A diff of pure condition and return-value
    // edits has no mutants at all and is precisely the diff this reaches.
    let hunkCandidates: HunkCandidate[] = [];
    try {
      const selection = selectHunkProbes(
        hunkProbeInputs(worktree, base, headSha, revert, probes, candidates),
      );
      hunkCandidates = selection.selected;
      hunksSkippedForCap = selection.skippedForCap;
    } catch {
      // Selection is bookkeeping, like the mutants': a diff that will not read
      // says nothing about any test. Probe nothing rather than guess.
      hunkCandidates = [];
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
      const detail = worktreeCreateFailureDetail(
        'probe',
        e,
        String(sweep?.stderr ?? ''),
      );
      for (const file of probes) {
        results.push({
          file,
          verdict: 'inconclusive' as const,
          reason: 'not-run' as const,
          detail,
        });
      }
      for (const c of candidates) {
        mutantResults.push({ ...c, verdict: 'inconclusive' as const, detail });
      }
      for (const { patch: _p, ...h } of hunkCandidates) {
        hunkResults.push({ ...h, verdict: 'inconclusive' as const, detail });
      }
    }

    if (created && probes.length > 0) {
      // BEFORE the baseline run: a probe committed as mode 120000 is executed
      // through the link, scoring mutants against code this tree never
      // mutated — the fabricated-verdict class this command exists to
      // prevent, reached without tripping any write guard.
      const linked = committedSymlinkProbes(probeTree, probes);
      if (linked.size > 0) {
        // The hold below asks "does this mutant's own collocated test exist,
        // and did it run green?" against the probe LIST. Reassigning `probes`
        // to the survivors answers "there is no such test" for a dropped one —
        // so the mutant it covers is scored `survived` on the strength of the
        // other probes passing, which is exactly what the hold exists to
        // refuse. The full list is kept for that lookup.
        allProbes = [...probes];
        const kept: string[] = [];
        for (const file of probes) {
          if (linked.has(file)) {
            results.push({
              file,
              verdict: 'inconclusive' as const,
              reason: 'not-run' as const,
              detail:
                'committed as a symlink (mode 120000) — vitest would collect it through the link and score mutants against code this tree never mutated, so it was dropped from the probe set',
            });
          } else {
            kept.push(file);
          }
        }
        probes = kept;
        if (probes.length === 0) {
          noteMutants(
            'mutants not run: every probe file is committed as a symlink (mode 120000), so no suite can be scored in this tree',
          );
        }
      }
    }

    if (
      created &&
      probes.length > 0 &&
      (candidates.length > 0 || hunkCandidates.length > 0)
    ) {
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
        // The probe tree is reused ACROSS reviews too (#6832), so the baseline
        // is not exempt: it can open on whatever the previous review's suite
        // left in it.
        const staleBaseline = restoreProbeTreeTracked(probeTree);
        if (staleBaseline !== null) {
          throw new Error(
            `the probe tree could not be put back to the commit: ${staleBaseline}`,
          );
        }
        const baseline = runProbeSuite(
          probeTree,
          probes,
          mutantDeadline,
          now,
          worktree,
        );
        noteDependencyFarm(baseline.exposed);
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
          // Their own reason, not the budget's: the mutants ran zero suites in
          // this branch, and "the mutants used the window" would be a false note.
          hunksSkippedForBaseline = hunkCandidates.length;
          noteMutants(
            'mutants not run: no probe file was green in the unmutated baseline (every file was red or collected nothing), so a red mutant run would prove nothing',
          );
        } else {
          const estimatedRunMs = baseline.ms + RUN_ESTIMATE_MARGIN_MS;
          // POSITIVE CONTROL, before any real mutant spends the window: inject
          // one test that must fail into a green probe file and confirm the
          // runner actually goes red. A runner that stays green while executing
          // a false assertion is not running assertions at all — and against a
          // dead runner every real mutant "survives", which is precisely the
          // false gap-report this command exists to prevent. Control green →
          // every survivor this run would report is re-classed inconclusive.
          // (A live review measured the cost of lacking this: four survivors
          // reported off a runner whose collected suite never covered them.)
          // The control pays for its run like any other experiment: without
          // this check it silently ate one budgeted slot and skippedForBudget
          // under-reported by one. No budget for the control — and equally, a
          // control that could not be set up at all — means nothing was
          // validated (null), never a fabricated true or false.
          // Nothing to pre-set here: both loops below run with
          // `harnessValidated` still null, re-check the same budget against a
          // later clock, and set their own counters. Assigning full counts
          // first was dead in every path and worse than dead in one — the hunk
          // loop pushes collocated-probe inconclusives BEFORE its budget
          // check, so its own figure excludes them and this one did not.
          if (fitsAnotherMutantRun(mutantDeadline - now(), estimatedRunMs)) {
            harnessValidated = runControlMutant(
              probeTree,
              greenProbes[0],
              mutantDeadline,
              now,
              // The dependency root, so this run re-links the farm like the
              // others. Defaulting it to the probe tree made the farm rebuild
              // a no-op here (`exposeDependencies` returns at once when the
              // two are the same) — and the control is the run that decides
              // whether ANY mutant verdict is trusted.
              worktree,
            );
            if (harnessValidated === null) {
              // The probe file could not be read, so no test was injected and
              // no run happened. That is not a verdict about the runner —
              // fall through and let the mutants spend the window as usual.
              noteMutants(
                `the positive control could not be set up (${greenProbes[0]} could not be read in the probe tree), so the harness was NOT validated this run — read every survivor below as unconfirmed by a control`,
              );
            }
          }
          if (harnessValidated === false) {
            // Three causes share this shape — a runner that executes nothing,
            // a collector that skips the injected test, a reporter that drops
            // failures — and none of them can kill, so spending the rest of
            // the window would only manufacture survivors to re-class.
            mutantsSkippedForControl = candidates.length;
            hunksSkippedForControl = hunkCandidates.length;
            noteMutants(
              'positive control FAILED (the injected always-failing test did not turn the run red — a dead runner, a collector that skipped it, or a reporter that dropped the failure): nothing here can kill, every would-be survivor is reported inconclusive, and the remaining mutant/hunk window was not spent',
            );
          }
          for (const c of harnessValidated === false ? [] : candidates) {
            // The hunk loop's rule, which the mutants needed just as much.
            // A mutant runs against `greenProbes` only, so a file whose OWN
            // test was red in the unmutated baseline has that test excluded
            // from the run — and then "every affected test still passed"
            // is computed over a set that omits the one test most likely to
            // catch the deletion. Measured live on PR #8213: six hunks in
            // `bridge.ts` were correctly held at `inconclusive` because
            // `bridge.test.ts` was not green, while eight mutants in the SAME
            // file were scored `survived` and shipped as findings.
            //
            // The comment below this loop framed the asymmetry as "mutants
            // guard the killed direction, hunks guard the survived one". That
            // is true of an inconclusive RUN; it left the survived direction
            // of a mutant unguarded against an absent covering test. Checked
            // before the budget, because a candidate that cannot yield a
            // verdict should not spend a suite run to say so.
            const heldDetail = heldForRedCollocatedTest(
              'mutant',
              c.file,
              allProbes,
              greenProbes,
              baseline.perFile,
            );
            if (heldDetail) {
              mutantResults.push({
                ...c,
                verdict: 'inconclusive' as const,
                detail: heldDetail,
              });
              continue;
            }
            const remaining = mutantDeadline - now();
            if (!fitsAnotherMutantRun(remaining, estimatedRunMs)) {
              mutantsSkippedForBudget =
                candidates.length - mutantResults.length;
              break;
            }
            mutantResults.push(
              runOneMutant(
                probeTree,
                c,
                greenProbes,
                mutantDeadline,
                now,
                worktree,
              ),
            );
          }

          // Per-hunk probes run LAST and out of the same window, on whatever
          // the mutants left. That ordering is the priority statement: a
          // safety-verb mutant is the higher-precision experiment, so it gets
          // the budget first, and a hunk probe is what the leftovers buy. It
          // also means a diff whose mutants consumed the window reports zero
          // hunk probes with `skippedForBudget` set — never a silent zero.
          for (const h of harnessValidated === false ? [] : hunkCandidates) {
            // A hunk whose OWN collocated test the baseline dropped (red, or the
            // case this exists for: a probe-tree import error that collected
            // nothing) cannot be scored `survived`: the other probes passing
            // shows only that THEY do not cover it, not that nothing does, since
            // the one test that would catch it never ran. The mutants hold
            // BOTH halves of this now: an inconclusive run is never `killed`,
            // and — since the loop above gained the same collocated check —
            // an absent covering test is never `survived` there either. The
            // two halves are separate guards; having one was read as having
            // the rule, and eight mutant survivors shipped through the gap.
            const heldDetail = heldForRedCollocatedTest(
              'hunk',
              h.file,
              allProbes,
              greenProbes,
              baseline.perFile,
            );
            if (heldDetail) {
              const { patch: _patch, ...meta } = h;
              hunkResults.push({
                ...meta,
                verdict: 'inconclusive' as const,
                detail: heldDetail,
              });
              continue;
            }
            const remaining = mutantDeadline - now();
            if (!fitsAnotherMutantRun(remaining, estimatedRunMs)) {
              hunksSkippedForBudget =
                hunkCandidates.length - hunkResults.length;
              break;
            }
            hunkResults.push(
              runOneHunkProbe(
                probeTree,
                h,
                greenProbes,
                mutantDeadline,
                now,
                worktree,
              ),
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
        for (const { patch: _p, ...h } of hunkCandidates.slice(
          hunkResults.length,
        )) {
          hunkResults.push({ ...h, verdict: 'inconclusive' as const, detail });
        }
      }
    }

    // `probes.length > 0` for the same reason as the mutation gate above: a
    // `runProbeSuite` with no files runs vitest with no filter, which collects
    // whatever the repo holds — minutes of unrelated suite, scored as this
    // probe's evidence.
    if (created && probes.length > 0) {
      try {
        // The tree must still BE the tree. The mutation phase above can end by
        // detecting that the probe tree was relinked mid-run — and this phase
        // then ran `git checkout base -- …` and `safeRmWithin` with a cwd that
        // resolves through the link into the shared review worktree, which is
        // the one thing this whole command exists to keep untouched. Detection
        // that is followed by the damage it detected is not detection.
        if (probeTargetEscapes(probeTree, '.')) {
          throw new Error(
            'the probe tree no longer resolves to itself (a symlink at its ' +
              'root), so the revert would run against whatever it points at',
          );
        }
        // Filters, again, and for the same reason the restore screens them:
        // `checkout base -- <paths>` below rewrites files, and a rewrite
        // EXECUTES `filter.<name>.smudge`. Screening once at the restore is
        // not enough — every run between then and here has executed the PR's
        // own test code, which can plant the filter mid-run, and the mutation
        // phase's catch deliberately continues so that this revert still runs.
        // A refused restore therefore reaches this line with the plant live.
        // The throw lands in this phase's existing catch and is recorded as a
        // probe that did not run, which is what it is.
        const revertFilters = localFilterCommands(probeTree);
        if (revertFilters.unreadable) {
          throw new Error(
            'the screen could not clear this revert: ' +
              screenStopDetail(revertFilters),
          );
        }
        if (revertFilters.keys.length > 0) {
          throw new Error(
            "the repository's local config defines content filter(s) " +
              `${screenKeyList(revertFilters)}, which this revert's checkout ` +
              'would EXECUTE',
          );
        }
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

        // The probes were screened for symlinks ONCE, from the index, before
        // the baseline — and every run since has executed the PR's own test
        // code, which can replace a probe file with a link at any point. The
        // mutation writers re-check their target immediately before they
        // write; this collection had no equivalent, so a probe relinked out of
        // the tree during an earlier run was collected THROUGH the link here
        // and its verdict scored against code the revert never touched. A
        // probe that escapes is dropped from this run rather than believed.
        const collectable = probes.filter(
          (p) => !probeTargetEscapes(probeTree, p),
        );
        // Every probe relinked away leaves nothing to run, and `vitest run`
        // with no file argument collects the WHOLE suite — a run whose verdicts
        // belong to files this phase never selected. The `probes.length > 0`
        // gate this phase opened with was taken before the screen above could
        // empty the list. Thrown before the per-probe records below, so the
        // report carries one reason rather than the same file twice.
        if (collectable.length === 0) {
          throw new Error(
            'every probe was relinked out of the probe tree after the baseline — the revert phase had nothing left it could score',
          );
        }
        for (const p of probes) {
          if (collectable.includes(p)) continue;
          results.push({
            file: p,
            verdict: 'inconclusive',
            reason: 'not-run',
            detail:
              'the probe resolves through a symlink out of the probe tree — it was relinked after the baseline, so this run could not score it',
          });
        }

        const revertRun = runProbeSuite(
          probeTree,
          collectable,
          startedAt + TOTAL_BUDGET_MS,
          now,
          worktree,
        );
        noteDependencyFarm(revertRun.exposed);
        results.push(...revertRun.perFile);
      } catch (e) {
        // The probe could not be set up or run. That is not evidence about any
        // test — record it and keep going, so the report (and the unreachable
        // findings, which needed no probe at all) still reaches the caller.
        const message = e instanceof Error ? e.message : String(e);
        const detail = `probe could not run: ${message}`;
        const reason =
          e instanceof ProbeRunFailure ? e.reason : ('not-run' as const);
        results.push(
          ...probes.map((file) => ({
            file,
            verdict: 'inconclusive' as const,
            reason,
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

  // A dead runner cannot kill, so its "survivors" are non-evidence: re-class
  // them before findings are derived, keeping the control's verdict upstream
  // of everything a reader acts on.
  if (harnessValidated === false) {
    const detail =
      'the positive control failed (an injected always-failing test stayed green), so a surviving mutant proves nothing about coverage';
    for (const m of mutantResults) {
      if (m.verdict === 'survived') {
        m.verdict = 'inconclusive';
        m.detail = detail;
      }
    }
    for (const h of hunkResults) {
      if (h.verdict === 'survived') {
        h.verdict = 'inconclusive';
        h.detail = detail;
      }
    }
    // The file-level revert probe's "inert" is the same survivor claim one
    // level up — a dead runner reports every reverted file green too.
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.verdict === 'inert') {
        // Replaced rather than mutated in place: the union makes `reason`
        // mandatory on the arm this becomes, and assigning `verdict` alone
        // would leave the entry untagged — which is the whole failure the
        // union exists to make impossible.
        results[i] = {
          file: r.file,
          verdict: 'inconclusive',
          reason: 'control-failed',
          detail,
        };
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
        message:
          m.operator === 'coalesce'
            ? `\`${m.file}:${m.line}\`: dropping the \`?? fallback\` from \`${m.statement}\` leaves every affected test green — the fallback is untested, and it is frequently the only thing standing between a miss and a worse default. Add a test that exercises the miss path.`
            : m.operator === 'guard-true'
              ? `\`${m.file}:${m.line}\`: forcing this guard's condition to \`true\` leaves every affected test green — no test pins when the guard must NOT fire. Add a case just on the other side of the condition.`
              : m.operator === 'term-drop'
                ? `\`${m.file}:${m.line}\`: dropping the \`+ CONSTANT\` term from \`${m.statement}\` leaves every affected test green — nothing pins what that term contributes. Add a case where its presence decides the outcome (a boundary, if the expression is arithmetic).`
                : `\`${m.file}:${m.line}\`: deleting the added safety statement \`${m.statement}\` leaves every affected test green. No test in this diff fails when it is removed — confirm an existing test covers it, or add one, so a regression that drops or skips this statement is caught.`,
      })),
    ...hunkResults
      .filter((h) => h.verdict === 'survived')
      .map((h) => {
        const own = collocatedProbe(h.file, probes);
        const restatesInert =
          !!own && results.some((r) => r.verdict === 'inert' && r.file === own);
        return {
          file: h.file,
          kind: 'hunk-survived' as const,
          message: `\`${h.file}:${h.startLine}\` (\`${h.header}\`): reverting this hunk on its own leaves every affected test green. No test in this diff fails when this particular change is undone — confirm an existing test covers it, or add one. (The suite as a whole may still be gated: this says only that THIS change is not what any of it turns on.${
            restatesInert
              ? ' A file-level revert probe also came back inert, so this restates that gap at hunk granularity — read the two as one finding, not two.'
              : ''
          })`,
        };
      }),
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
      skippedForControl: mutantsSkippedForControl,
      ...(mutantsNote ? { note: mutantsNote } : {}),
    },
    /**
     * `true` — an injected always-failing test turned the runner red, so this
     * harness can kill. `false` — it stayed green: nothing here can kill, and
     * every survivor was re-classed. `null` — the control never ran (no green
     * baseline, no candidates, no budget, or the probe file was unreadable):
     * the run is neither validated nor refuted, and it is NOT a survivor claim.
     */
    harnessValidated,
    hunks: {
      probed: hunkResults,
      killed: hunkResults.filter((h) => h.verdict === 'killed').length,
      survived: hunkResults.filter((h) => h.verdict === 'survived').length,
      inconclusive: hunkResults.filter((h) => h.verdict === 'inconclusive')
        .length,
      skippedForBudget: hunksSkippedForBudget,
      skippedForCap: hunksSkippedForCap,
      skippedForBaseline: hunksSkippedForBaseline,
      skippedForControl: hunksSkippedForControl,
    },
    findings,
    cleanupFailure,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  writeStdoutLine(
    `Wrote test-efficacy report to ${out} (${unreachable.length} unreachable, ${results.length} probed, ${mutantResults.length} mutant(s), ${hunkResults.length} hunk probe(s), ${findings.length} finding(s))`,
  );
  for (const f of findings) {
    writeStdoutLine(`  [test] ${f.kind}: ${f.file}`);
  }
  if (mutantsSkippedForCap > 0) {
    writeStdoutLine(
      // BOTH caps, because this count carries drops from either: with 2
      // deletions and 6 replacements the total is exactly MAX_MUTANTS and the
      // main cap never fires, yet the sub-cap drops 3. Naming only the main cap
      // then sends the reader looking for a pool of 11 candidates that does not
      // exist — the number is right, the reason was not.
      `  ${mutantsSkippedForCap} mutant(s) skipped: more candidates than the selection caps (${MAX_MUTANTS} total, ${REPLACEMENT_SUB_CAP} of them replacements)`,
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
  // Both skip counts are printed for the same reason the mutants' are: a hunk
  // probe that never ran must not be readable as a hunk that came back clean.
  if (hunksSkippedForCap > 0) {
    writeStdoutLine(
      `  ${hunksSkippedForCap} hunk probe(s) skipped: more hunks than the cap of ${MAX_HUNK_PROBES}`,
    );
  }
  if (hunksSkippedForBudget > 0) {
    writeStdoutLine(
      `  ${hunksSkippedForBudget} hunk probe(s) skipped: the mutants used the window`,
    );
  }
  if (hunksSkippedForBaseline > 0) {
    writeStdoutLine(
      `  ${hunksSkippedForBaseline} hunk probe(s) skipped: no probe file was green in the unmutated baseline`,
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
    "Check whether the diff's new tests actually gate its new behaviour (unreachable + revert probe + statement-deletion mutants + per-hunk probes)",
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
