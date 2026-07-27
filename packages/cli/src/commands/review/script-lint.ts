/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review script-lint`: run the deterministic linters over the executable
// code a diff adds or changes, and report what they say.
//
// A diff's shell — a `.sh`/`.bash` file, a Dockerfile `RUN`, a GitHub Actions
// `run:` block — is code, and its bugs (an unquoted `$x` that
// word-splits, a `${PIPESTATUS[1]}` read after the array was already reset, a
// `[ ]` where `[[ ]]` was meant) are exactly the class a reviewer misses by
// *reading* a 3000-line YAML and catches by *running* the checker. Measured:
// a model told in prose to "run the workflow scripts" does not — it reads and
// reasons instead (0 of 4 runs executed anything). So the execution is a
// command, not a request: `shellcheck`/`actionlint`/`hadolint` do the work, an
// agent reads this report, and coverage requires the agent ran.
//
// It is not GitHub-specific. `shellcheck` is the workhorse and applies to shell
// wherever it appears; `actionlint` and `hadolint` are format front-ends for the
// two embeds worth special-casing. A linter that is not installed is disclosed
// as skipped, never treated as a clean bill of health.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { parseDiff } from './lib/diff-plan.js';

/** The deterministic checkers this command dispatches. */
export type LintTool = 'shellcheck' | 'actionlint' | 'hadolint';

/** One diagnostic, normalised across the three tools. */
export interface LintFinding {
  /** New-side line in the post-change file. */
  line: number;
  /** The tool's own rule id — `SC2086`, `DL3006`, or the actionlint kind. */
  code: string;
  /** `error` | `warning` | `info` | `style`. */
  level: string;
  message: string;
  /**
   * Whether `line` falls inside a hunk this diff changed. A lint finding on an
   * unchanged line is pre-existing — real, but not this PR's to answer for — so
   * the agent keys severity on this, exactly as Build & Test keys it on whether
   * the failing file was changed.
   */
  inDiff: boolean;
}

/** One executable file that had an applicable linter, and what it said. */
export interface FileLint {
  path: string;
  tool: LintTool;
  findings: LintFinding[];
}

export interface ScriptLintReport {
  /** Files an installed linter actually checked. */
  checked: FileLint[];
  /**
   * Executable files whose linter is **not installed** — checked by nothing, and
   * said so. Never silently dropped: an unrun checker is not a clean file.
   */
  skipped: Array<{ path: string; tool: LintTool; reason: string }>;
  /**
   * Files whose linter **ran but failed** — a spawn error, a signal, an
   * unexpected exit status, a `maxBuffer` overflow. Distinct from `skipped` (not
   * installed): a checker that crashed reviewed nothing, so we fail closed — an
   * errored file forces `ok` false, it is never a clean pass on the tool's silence.
   */
  errored: Array<{ path: string; tool: LintTool; reason: string }>;
  /**
   * Files a checker **deliberately declines** to lint (not absent, not crashed) —
   * today only actionlint, whose embedded-shell source mapping is not yet parsed.
   * Distinct from `skipped` precisely because the verdict must treat it
   * differently: a deferred checker is a known tool limitation, disclosed but NOT
   * capping — actionlint is installed on ~15% of PRs (every workflow change), and
   * capping all of them on a checker we choose not to run would make them
   * un-Approvable forever, which "install the tool" cannot fix.
   */
  deferred: Array<{ path: string; tool: LintTool; reason: string }>;
  /**
   * True when every applicable linter ran cleanly **and** no finding on a changed
   * line is above `style` — `info`/`warning`/`error` all count against it (the
   * SC2086 word-split is `info`, and it blocks). A run error (`errored[]`
   * non-empty) also makes this false. An uninstalled linter (`skipped[]`) does
   * not flip `ok`, but is disclosed for the agent to report as unreviewed.
   */
  ok: boolean;
  /** One line for the agent's report. */
  note: string;
  /**
   * A hash of the diff this report was produced against (the plan's captured
   * diff). `compose-review` re-hashes the plan's current diff and treats a
   * mismatch as no report. Content, not commit: it identifies **what was
   * reviewed**, so it is correct for a PR (a different commit → a different diff)
   * AND for a local review of uncommitted work (an edit changes the diff even
   * when `HEAD` does not) — a stale report from either can no longer certify.
   * `undefined` only when the diff could not be read.
   */
  diffHash?: string;
}

interface ScriptLintArgs {
  plan: string;
  worktree: string;
  out?: string;
}

interface PlanFile {
  path?: unknown;
  hunks?: Array<{ newStart?: unknown; newEnd?: unknown }>;
}

/**
 * Which linter owns a path by its **name alone** — no file contents needed.
 *
 * Split out from `toolFor` because the roster (`lib/roster.ts`) must decide
 * whether to require the script-lint agent knowing only the plan's file paths,
 * not the files themselves. One detector, so the roster and the command cannot
 * disagree about what counts as an executable script.
 */
export function pathTool(path: string): LintTool | null {
  const p = path.toLowerCase();
  const base = basename(p);
  if (/(^|\/)\.github\/workflows\/.+\.ya?ml$/.test(p)) {
    return 'actionlint';
  }
  if (
    base === 'dockerfile' ||
    p.endsWith('.dockerfile') ||
    base.startsWith('dockerfile.')
  ) {
    return 'hadolint';
  }
  // Every extension `toolFor`'s shebang regex recognises (sh|bash|dash|ksh), so
  // the roster and the command cannot disagree about a `.ksh`/`.dash` file.
  if (
    p.endsWith('.sh') ||
    p.endsWith('.bash') ||
    p.endsWith('.ksh') ||
    p.endsWith('.dash')
  ) {
    return 'shellcheck';
  }
  return null;
}

/** Which linter owns a path, or null when it is not executable code we check.
 *  A name match wins; otherwise an extensionless script is decided by its shebang
 *  (a git hook, a CI helper) — which is why this one needs the file's first line. */
export function toolFor(path: string, firstLine: string): LintTool | null {
  const byPath = pathTool(path);
  if (byPath) return byPath;
  if (/^#!.*\b(sh|bash|dash|ksh)\b/.test(firstLine)) return 'shellcheck';
  return null;
}

/** New-side hunk ranges from the plan, as `[start, end]` pairs (empty if none). */
function hunksOf(file: PlanFile): Array<[number, number]> {
  const hs = Array.isArray(file.hunks) ? file.hunks : [];
  const out: Array<[number, number]> = [];
  for (const h of hs) {
    const s = Number(h?.newStart);
    const e = Number(h?.newEnd);
    if (Number.isInteger(s) && Number.isInteger(e) && e >= s) out.push([s, e]);
  }
  return out;
}

function inAnyHunk(line: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => line >= s && line <= e);
}

/**
 * Added-line ranges per path, parsed from the unified diff — the lines this PR
 * actually **added or changed**, with the three context lines git prints around
 * each hunk EXCLUDED. The plan's `hunks` include that context (see report.ts), so
 * keying `inDiff` off them marks a pre-existing diagnostic three lines from a real
 * change as this PR's and blocks on someone else's bug. `addedRanges` is populated
 * only for heavy files in the plan, so we parse the diff, which carries it for
 * every file. If the diff cannot be read we fall back to the (context-inclusive)
 * plan hunks — over-inclusive, but fail-closed, never fail-open to "nothing changed".
 */
function addedRangesByPath(
  diffPath: string,
): Map<string, Array<[number, number]>> {
  const map = new Map<string, Array<[number, number]>>();
  let text: string;
  try {
    text = readFileSync(diffPath, 'utf8');
  } catch {
    return map;
  }
  let parsed: ReturnType<typeof parseDiff>;
  try {
    parsed = parseDiff(text);
  } catch {
    return map;
  }
  for (const f of parsed.files) {
    map.set(
      f.path,
      f.addedRanges.map((r) => [r.start, r.end] as [number, number]),
    );
  }
  return map;
}

/**
 * The file's first line, read safely for shebang detection — or `null` if the
 * path is not a regular file. A PR is untrusted: a changed `hang.sh` symlinked to
 * `/dev/zero` would hang a whole-file read, and a fifo would block. `lstat` does
 * not follow the link, so a non-regular file is skipped entirely — the linter is
 * never pointed at it either. The read is bounded to one block, not the whole file.
 */
type FirstLine =
  /** A regular file we read — its first line, for shebang detection. */
  | { kind: 'line'; text: string }
  /** No file on the new side: the diff deleted it. Nothing to lint. */
  | { kind: 'missing' }
  /** Present but not a regular file (a symlink, fifo, device) or unreadable —
   *  owed if a linter recognises the path, but we will not follow/read it. */
  | { kind: 'irregular' };

function firstLineOf(abs: string): FirstLine {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { kind: 'missing' };
  }
  if (!st.isFile()) return { kind: 'irregular' };
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);
    const nl = text.indexOf('\n');
    return { kind: 'line', text: nl >= 0 ? text.slice(0, nl) : text };
  } catch {
    return { kind: 'irregular' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** An empty hadolint config, written once. Pointing `HADOLINT_CONFIG` at it makes
 *  hadolint use a config with no `ignored:` rules, so a `.hadolint.yaml` a PR added
 *  to the worktree cannot suppress the findings we run it to catch. Best-effort: if
 *  the write fails, the env var points at a path hadolint will simply not find. */
let hadolintEmptyConfigPath: string | undefined;
function emptyHadolintConfig(): string {
  if (!hadolintEmptyConfigPath) {
    hadolintEmptyConfigPath = join(tmpdir(), 'qwen-review-hadolint-empty.yaml');
    try {
      writeFileSync(hadolintEmptyConfigPath, '');
    } catch {
      /* best-effort — a missing config is still no ignores */
    }
  }
  return hadolintEmptyConfigPath;
}

/** The outcome of pointing a linter at one file. */
export type ToolRun =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' }
  | { kind: 'error'; reason: string };

/**
 * How `runScriptLint` invokes a linter. Injectable so a test can feed canned
 * output for all three tools — and exercise the fail-closed paths — without the
 * binaries installed; the default is the real `spawnSync`-backed runner.
 */
export type ToolRunner = (tool: LintTool, absPath: string) => ToolRun;

/**
 * Run a linter over one file. Fails **closed**: only a clean exit (0) or a
 * findings exit (1) yields output to parse; a spawn error (`EACCES`), a signal,
 * a `maxBuffer` overflow, or any other status is an `error` the caller must not
 * read as a clean file. `ENOENT` alone is `missing` (the binary is not installed).
 */
function runTool(tool: LintTool, absPath: string): ToolRun {
  // The three tools all take a file path and print machine-readable diagnostics.
  // `shellcheck --norc` ignores a PR-controlled `.shellcheckrc` in the worktree
  // (which could disable SC2086), and the sanitized env drops `SHELLCHECK_OPTS`
  // for the same reason: a checker's configuration must come from us, not the diff.
  const argv: Record<LintTool, string[]> = {
    shellcheck: ['--norc', '--format=json1', '--severity=style', absPath],
    actionlint: ['-format', '{{json .}}', '-no-color', absPath],
    // NOTE: hadolint has no `--no-config` flag — a prior attempt to add one made
    // hadolint exit 2 (usage error) on every Dockerfile. Config isolation for
    // hadolint (a PR-controlled `.hadolint.yaml`) needs a verified mechanism
    // (`HADOLINT_CONFIG` / `--config <empty>`) and is tracked separately; for now
    // the invocation is the plain, working one.
    hadolint: ['--format', 'json', absPath],
  };
  // Config isolation, so a PR-controlled config cannot suppress its own findings:
  // shellcheck gets `--norc` + `SHELLCHECK_OPTS` dropped (above); hadolint reads a
  // config from `HADOLINT_CONFIG` when set, so point it at an empty one — that
  // neutralises a `.hadolint.yaml` the diff added. `HADOLINT_NO_COLOR` keeps output
  // clean. (Env vars are benign if a tool ignores them — unlike a bad CLI flag.)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HADOLINT_NO_COLOR: '1',
    HADOLINT_CONFIG: emptyHadolintConfig(),
  };
  delete env['SHELLCHECK_OPTS'];
  const r = spawnSync(tool, argv[tool], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const err = r.error as NodeJS.ErrnoException | undefined;
  if (err?.code === 'ENOENT') return { kind: 'missing' };
  if (err) {
    return { kind: 'error', reason: `${tool} failed to run: ${err.message}` };
  }
  if (r.signal) {
    return { kind: 'error', reason: `${tool} was killed by ${r.signal}` };
  }
  // All three exit 0 (clean) or 1 (found something) on a normal run. Any other
  // status — a parse/usage error, a crash — is not "no findings"; fail closed.
  if (r.status !== 0 && r.status !== 1) {
    const detail = `${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return {
      kind: 'error',
      reason: `${tool} exited ${r.status ?? 'null'}${detail ? `: ${detail}` : ''}`,
    };
  }
  return { kind: 'ok', stdout: `${r.stdout ?? ''}` };
}

/**
 * Normalise each tool's JSON into `LintFinding[]` — or `null` when non-empty
 * output could not be parsed. Empty output is a clean run (`[]`); non-empty
 * output the tool's own format cannot parse (a version skew, a deprecation line
 * printed before the JSON) is a failure the caller must treat as errored, not as
 * a clean file — the same fail-closed stance `runTool` takes on a bad exit.
 */
function parseFindings(tool: LintTool, raw: string): LintFinding[] | null {
  if (!raw.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const mk = (
    line: unknown,
    code: string,
    level: string,
    message: unknown,
  ): LintFinding | null => {
    const l = Number(line);
    if (!Number.isInteger(l) || l < 1) return null;
    return {
      line: l,
      code,
      level,
      message: String(message ?? ''),
      inDiff: false,
    };
  };
  if (tool === 'shellcheck') {
    const comments = (json as { comments?: unknown[] })?.comments ?? [];
    return (Array.isArray(comments) ? comments : [])
      .map((c) => {
        const o = c as {
          line?: unknown;
          code?: unknown;
          level?: unknown;
          message?: unknown;
        };
        return mk(
          o.line,
          `SC${o.code}`,
          String(o.level ?? 'warning'),
          o.message,
        );
      })
      .filter((x): x is LintFinding => x !== null);
  }
  if (tool === 'hadolint') {
    return (Array.isArray(json) ? json : [])
      .map((c) => {
        const o = c as {
          line?: unknown;
          code?: unknown;
          level?: unknown;
          message?: unknown;
        };
        return mk(
          o.line,
          String(o.code ?? 'DL'),
          String(o.level ?? 'warning'),
          o.message,
        );
      })
      .filter((x): x is LintFinding => x !== null);
  }
  // actionlint never reaches here — a workflow is recorded as skipped upstream
  // (its embedded-shell source mapping is not yet parsed). Fail closed if it ever
  // does, rather than inventing severities/lines we cannot trust.
  return null;
}

/** The worktree's HEAD commit, or undefined when it is not a git checkout (tests,
 *  a plain directory). Best-effort — a missing SHA just skips the freshness check. */
/** A hash of the captured diff — the identity of *what was reviewed*. `undefined`
 *  when the diff cannot be read (there is then nothing to bind freshness to).
 *  Exported so `compose-review`'s gate hashes the plan's diff the SAME way. */
export function diffHashOf(diffPath: unknown): string | undefined {
  if (typeof diffPath !== 'string' || !diffPath) return undefined;
  try {
    return createHash('sha256').update(readFileSync(diffPath)).digest('hex');
  } catch {
    return undefined;
  }
}

export function runScriptLint(
  args: ScriptLintArgs,
  runner: ToolRunner = runTool,
): ScriptLintReport {
  let plan: { files?: PlanFile[]; diffPathAbsolute?: unknown };
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  } catch (err) {
    throw new Error(
      `script-lint: cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }
  const files = Array.isArray(plan.files) ? plan.files : [];
  // The lines this PR actually added or changed, context excluded — keyed off the
  // diff, not the plan's context-inclusive hunks. Empty when the diff is absent,
  // in which case each file falls back to its (over-inclusive) plan hunks below.
  const addedRanges =
    typeof plan.diffPathAbsolute === 'string'
      ? addedRangesByPath(plan.diffPathAbsolute)
      : new Map<string, Array<[number, number]>>();

  const checked: FileLint[] = [];
  const skipped: ScriptLintReport['skipped'] = [];
  const errored: ScriptLintReport['errored'] = [];
  const deferred: ScriptLintReport['deferred'] = [];
  const missing = new Set<LintTool>();

  for (const f of files) {
    const path = typeof f?.path === 'string' ? f.path : '';
    if (!path) continue;
    const abs = resolve(join(args.worktree, path));
    const first = firstLineOf(abs);
    if (first.kind === 'missing') continue; // deleted on the new side — nothing to lint
    if (first.kind === 'irregular') {
      // A symlink/fifo/unreadable file. If a linter owns it BY NAME it was owed,
      // so record it as skipped — never drop it silently, or an empty report reads
      // as clean over a file we refused to read (a `hook.sh` -> /dev/zero symlink).
      const byName = pathTool(path);
      if (byName) {
        // Reason does NOT lead with the path — the gate prefixes `${path}:` when
        // it discloses, and leading with it here would print the path twice.
        skipped.push({
          path,
          tool: byName,
          reason:
            'not a regular file (symlink/fifo) or unreadable — not linted',
        });
      }
      continue;
    }
    const tool = toolFor(path, first.text);
    if (!tool) continue;

    // Actionlint lints a workflow's embedded shell, but its JSON anchors each
    // diagnostic at the `run:` key line (not the changed shell line) and flattens
    // ShellCheck's severity — so a style nit reads as an `error` and a real finding
    // reads as pre-existing. Until that source-mapping is parsed and verified a
    // workflow is **deferred**: disclosed, but NOT capping the verdict (it is a
    // tool limitation, not a finding, and actionlint touches ~15% of PRs — capping
    // every one of them would make workflow changes un-Approvable). shellcheck
    // still covers standalone `.sh`.
    if (tool === 'actionlint') {
      deferred.push({
        path,
        tool,
        reason:
          'actionlint embedded-shell source mapping is not yet supported — not linted',
      });
      continue;
    }

    if (missing.has(tool)) {
      skipped.push({ path, tool, reason: `${tool} is not installed` });
      continue;
    }
    const res = runner(tool, abs);
    if (res.kind === 'missing') {
      missing.add(tool);
      skipped.push({ path, tool, reason: `${tool} is not installed` });
      continue;
    }
    if (res.kind === 'error') {
      // Fail closed: a checker that crashed reviewed nothing, so this file is not
      // a clean pass — it is surfaced as errored and forces `ok` false below.
      errored.push({ path, tool, reason: res.reason });
      continue;
    }
    const parsed = parseFindings(tool, res.stdout);
    if (parsed === null) {
      // Non-empty output the tool's own format could not parse — fail closed, so
      // it is not mistaken for a clean file (the trap `runTool` already avoids).
      errored.push({
        path,
        tool,
        reason: `${tool} produced unparseable output`,
      });
      continue;
    }
    // Prefer the diff's added-line ranges (context excluded); fall back to the
    // plan's context-inclusive hunks only when the diff was unavailable. A file
    // present in the diff with no added lines yields `[]` — correctly nothing.
    const ranges = addedRanges.get(path) ?? hunksOf(f);
    const findings = parsed.map((x) => ({
      ...x,
      inDiff: inAnyHunk(x.line, ranges),
    }));
    checked.push({ path, tool, findings });
  }

  // `style` is cosmetic (SC2006 backticks, SC2250 brace-your-vars); everything
  // else shellcheck reports — including the `info`-rated SC2086 word-splitting
  // and SC2046 — is a real correctness/quoting bug worth the agent's eyes. So a
  // changed-line finding at any level except `style` counts against `ok`.
  const blocking = checked
    .flatMap((c) => c.findings)
    .filter((x) => x.inDiff && x.level !== 'style');
  // Fail closed: a linter that errored on a file also blocks — that file is not
  // clean, and `ok: true` on a crashed checker's silence is the trap we avoid.
  const ok = blocking.length === 0 && errored.length === 0;
  const note = buildNote(checked, skipped, errored, deferred, blocking.length);
  return {
    checked,
    skipped,
    errored,
    deferred,
    ok,
    note,
    diffHash: diffHashOf(plan.diffPathAbsolute),
  };
}

function buildNote(
  checked: FileLint[],
  skipped: ScriptLintReport['skipped'],
  errored: ScriptLintReport['errored'],
  deferred: ScriptLintReport['deferred'],
  blocking: number,
): string {
  if (
    checked.length === 0 &&
    skipped.length === 0 &&
    errored.length === 0 &&
    deferred.length === 0
  ) {
    return 'No executable scripts changed — nothing to lint.';
  }
  const parts: string[] = [];
  parts.push(
    `Linted ${checked.length} file(s); ${blocking} finding(s) on changed lines.`,
  );
  if (errored.length > 0) {
    const tools = [...new Set(errored.map((e) => e.tool))].join(', ');
    parts.push(
      `${errored.length} file(s) failed to lint — ${tools} errored (fail closed: not clean).`,
    );
  }
  if (skipped.length > 0) {
    // `skipped` mixes reasons — a tool not installed, an irregular file — so
    // summarise by tool without claiming they were all "not installed". The
    // per-file reason is in each `skipped[]` entry.
    const tools = [...new Set(skipped.map((s) => s.tool))].join(', ');
    parts.push(
      `${skipped.length} file(s) not checked (${tools}) — report as unreviewed, not clean.`,
    );
  }
  if (deferred.length > 0) {
    const tools = [...new Set(deferred.map((d) => d.tool))].join(', ');
    parts.push(
      `${deferred.length} file(s) deferred (${tools} — a tool limitation, disclosed but not blocking).`,
    );
  }
  return parts.join(' ');
}

export const scriptLintCommand: CommandModule = {
  command: 'script-lint',
  describe:
    'Run shellcheck/actionlint/hadolint over the executable scripts a diff ' +
    'changed, filtered to the changed lines; the evidence is what the linters say',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the plan report from Step 1',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the checkout whose files are linted',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the report JSON to this path',
      }),
  handler: (argv) => {
    const args = argv as unknown as ScriptLintArgs;
    const report = runScriptLint(args);
    const json = JSON.stringify(report, null, 2);
    // Write the file when asked AND always print the JSON — the agent's brief
    // says "read the JSON it prints", and the roster's generated command passes
    // `--out`, so an `--out`-only "Wrote ..." line would leave the agent with no
    // findings to read. Build & Test does exactly this (writes then prints).
    if (args.out) {
      mkdirSync(dirname(resolve(args.out)), { recursive: true });
      writeFileSync(args.out, json);
    }
    writeStdoutLine(json);
    writeStderrLine(report.note);
  },
};
