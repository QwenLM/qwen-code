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
  mkdtempSync,
  rmSync,
  lstatSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename, sep } from 'node:path';
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
   *
   * `reasonZh` is the same reason for the review body's Chinese half — the
   * deferral is the one lint outcome rendered inside a translated sentence,
   * and without it that sentence carried the English reason verbatim.
   * Optional so a report written by an older CLI still renders (English both
   * halves).
   */
  deferred: Array<{
    path: string;
    tool: LintTool;
    reason: string;
    reasonZh?: string;
  }>;
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
  // Two linear checks — a directory test plus an end-anchored suffix — not
  // one anchored-then-unbounded regex: PR paths are attacker-controlled,
  // and a repeatable anchor followed by a backtracking quantifier is
  // quadratic on `.github/workflows/.github/workflows/…` inputs. The suffix
  // requires a stem before `.ya?ml`: a stemless `.yml`/`.yaml` dotfile in a
  // nested workflows/ directory is deliberately unrouted even though the
  // GITHUB_ACTIONS checklist arm still governs that path.
  if (
    /(?:^|\/)\.github\/workflows\//.test(p) &&
    /(?:^|\/)[^/]+\.ya?ml$/.test(p)
  ) {
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
  // Only the shells shellcheck actually supports. zsh and fish are deliberately
  // excluded: shellcheck refuses both (`SC1071: ShellCheck only supports
  // sh/bash/dash/ksh`), so routing a `#!/usr/bin/env zsh` hook here would make every
  // zsh file a bogus SC1071 "[lint]" Critical on its shebang line. A zsh/fish script
  // is simply not owed — the same as a Python or Ruby script we have no linter for.
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
function addedRangesFromDiff(
  diffText: string,
): Map<string, Array<[number, number]>> {
  const map = new Map<string, Array<[number, number]>>();
  // Let a parse failure THROW to the caller — it reads the diff once and needs to
  // distinguish "parsed, no added lines for this path" (safe) from "could not parse
  // at all" (fail closed), which it cannot do if we swallow the error into `[]`.
  const parsed = parseDiff(diffText);
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

/** `realpathSync`, or undefined when the path does not fully exist (a deleted child,
 *  a broken link). Used for worktree containment — a path we cannot canonicalise is
 *  handled downstream as missing/irregular, never trusted as inside. */
function realIfExists(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function firstLineOf(abs: string): FirstLine {
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    // Only a genuinely absent path is "missing" (deleted on the new side — nothing
    // to lint). Any OTHER metadata failure — EACCES on a parent dir, EIO, ELOOP —
    // is NOT a clean deletion: classify it as irregular so it is disclosed as
    // skipped and fails closed, never silently dropped into "nothing changed".
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'missing' }
      : { kind: 'irregular' };
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

/**
 * A private neutral hadolint config, created once per process — or `undefined` when
 * we could not create one. Passed to hadolint via `--config` (see below); a config
 * with no `ignored:` rules is what stops a `.hadolint.yaml` a PR added from
 * suppressing the findings we run hadolint to catch.
 *
 * The content is `ignored: []`, NOT an empty file: hadolint's `--config` rejects an
 * empty file ("empty YAML stream", exit 1), which the fail-closed path would then
 * (correctly) turn into an errored run — but that would disable hadolint entirely.
 *
 * Two path properties, both load-bearing and in OPPOSITE directions:
 * - UNPREDICTABLE and freshly ours, because it is a `writeFileSync` target — a fixed
 *   `tmpdir()` name is a symlink-race (we'd follow a planted symlink and truncate its
 *   target). `mkdtempSync` gives a 0700 dir with a random suffix.
 * - One WE CONTROL, because `--config` is a file hadolint READS — a predictable
 *   fallback we do not own lets an attacker plant an `ignored:` config there and
 *   reopen the very suppression this closes. So there is NO fixed fallback: if
 *   `mkdtempSync`/`writeFileSync` fails we return `undefined`, and the caller fails
 *   the hadolint run CLOSED rather than read a config we cannot vouch for.
 */
let hadolintEmptyConfigPath: string | undefined;
function emptyHadolintConfig(): string | undefined {
  if (!hadolintEmptyConfigPath) {
    try {
      const d = mkdtempSync(join(tmpdir(), 'qwen-review-hadolint-'));
      // Register cleanup RIGHT AFTER mkdtemp, before the write: `cleanup.ts` only
      // sweeps `.qwen/tmp`, so we remove `d` ourselves at exit — and registering it
      // first means a `writeFileSync` that throws still leaves `d` swept, not leaked.
      process.on('exit', () => {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      });
      const p = join(d, 'config.yaml');
      writeFileSync(p, 'ignored: []\n');
      hadolintEmptyConfigPath = p;
    } catch {
      return undefined; // no controllable config → caller must fail hadolint closed
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
 * The argv and environment for invoking one linter — the config-isolation layer,
 * factored out of `runTool` so it can be asserted WITHOUT spawning a binary. Every
 * defence here is load-bearing: a PR that adds its own linter config must not be
 * able to suppress the findings we run the linter to catch.
 *
 * - shellcheck: `--norc` ignores a PR-controlled `.shellcheckrc` (which could
 *   `disable=SC2086`), and `SHELLCHECK_OPTS` is dropped from the env for the same
 *   reason — configuration comes from us, not the diff.
 * - hadolint: reads a config from `--config`, then a `.hadolint.yaml` in the process
 *   CWD, then `$XDG_CONFIG_HOME/hadolint.yaml` — and NOT from any env var (real
 *   hadolint 2.14.0 has no `HADOLINT_CONFIG`; an earlier env-based attempt was a
 *   silent no-op, letting the diff's own `.hadolint.yaml` suppress findings because
 *   `--worktree .` runs the linter inside the reviewed tree). Isolation is therefore
 *   `--config <private neutral file>`, which overrides both the cwd and XDG configs.
 *   Set only for a hadolint run, and only when a private config exists; `runTool`
 *   fails hadolint closed when it does not (so it never runs unisolated).
 *
 * Also carries `timeoutMs`: the wall-clock bound `runTool` puts on the spawn, kept
 * here so the bound is one asserted value rather than a literal buried in the spawn.
 */
export function buildToolInvocation(
  tool: LintTool,
  absPath: string,
): { argv: string[]; env: NodeJS.ProcessEnv; timeoutMs: number } {
  const cfg = tool === 'hadolint' ? emptyHadolintConfig() : undefined;
  const argv: Record<LintTool, string[]> = {
    shellcheck: ['--norc', '--format=json1', '--severity=style', absPath],
    actionlint: ['-format', '{{json .}}', '-no-color', absPath],
    // `--config <neutral>` is the ONLY channel that isolates hadolint (env is
    // ignored). When `cfg` is absent this bare form is unreachable — `runTool` has
    // already failed the hadolint run closed rather than lint without isolation.
    hadolint: cfg
      ? ['--config', cfg, '--format', 'json', absPath]
      : ['--format', 'json', absPath],
  };
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['SHELLCHECK_OPTS'];
  // hadolint 2.14 MERGES config from its `HADOLINT_*` env vars — `HADOLINT_IGNORE`,
  // `HADOLINT_OVERRIDE_*`, `HADOLINT_CONFIG`, trusted-registry settings — WITH the
  // explicit `--config`, so an inherited one could suppress or downgrade the findings
  // the neutral config exists to force. Scrub them all: hadolint's configuration
  // comes from our `--config` alone, never from whatever the reviewer's env carries.
  for (const k of Object.keys(env)) {
    if (k.startsWith('HADOLINT_')) delete env[k];
  }
  return { argv: argv[tool], env, timeoutMs: 120_000 };
}

/**
 * Run a linter over one file. Fails **closed**: only a clean exit (0) or a
 * findings exit (1) yields output to parse; a spawn error (`EACCES`), a signal,
 * a `maxBuffer` overflow, or any other status is an `error` the caller must not
 * read as a clean file. `ENOENT` alone is `missing` (the binary is not installed).
 *
 * A `timeout` bounds the run, matching the sibling command runners
 * (`build-test.ts`, `test-efficacy.ts`): a crafted script that hangs a linter
 * (pathological `eval`/`source` nesting) must not block the whole review until the
 * outer CI job timeout reclaims the runner. On a timeout Node sets BOTH `r.error`
 * (`ETIMEDOUT`) and `r.signal` (`SIGTERM`); `r.error` is checked first, so a timeout
 * is reported through the error branch below — still fail-closed either way.
 */
function runTool(tool: LintTool, absPath: string): ToolRun {
  // Isolation is `--config <private neutral file>`; if we could not create that file,
  // running hadolint would honour a PR-added (or planted) `.hadolint.yaml` in the cwd
  // and let it suppress findings. Fail the hadolint run CLOSED rather than lint
  // without isolation (buildToolInvocation then also omits `--config`).
  if (tool === 'hadolint' && !emptyHadolintConfig()) {
    return {
      kind: 'error',
      reason: 'hadolint config isolation unavailable — failing closed',
    };
  }
  const { argv, env, timeoutMs } = buildToolInvocation(tool, absPath);
  const r = spawnSync(tool, argv, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
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

/** A hash of the captured diff — the identity of *what was reviewed*. `undefined`
 *  when the diff cannot be read; the gate treats an absent hash on either side as
 *  unverifiable and fails closed (it does NOT skip the freshness check).
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
  // Read the captured diff EXACTLY ONCE and derive BOTH the added-line ranges and
  // the freshness hash from that one immutable buffer. Reading it twice (ranges
  // before the linters run, hash after) opens a TOCTOU window: a concurrent
  // recapture could classify findings against snapshot A while the report carries
  // snapshot B's hash, and `compose-review` would accept it as fresh.
  let addedRanges = new Map<string, Array<[number, number]>>();
  let diffHash: string | undefined;
  let diffBuf: Buffer | undefined;
  if (typeof plan.diffPathAbsolute === 'string') {
    try {
      diffBuf = readFileSync(plan.diffPathAbsolute);
    } catch {
      diffBuf = undefined; // unreadable → no hash → the gate fails closed
    }
  }
  if (diffBuf) {
    try {
      addedRanges = addedRangesFromDiff(diffBuf.toString('utf8'));
      diffHash = createHash('sha256').update(diffBuf).digest('hex');
    } catch {
      // Diff read but UNPARSEABLE — we have no ground truth for `inDiff`. Leave
      // `diffHash` undefined so the gate rejects the report as unverifiable (fail
      // closed) rather than trust findings mapped against context-inclusive hunks.
      addedRanges = new Map();
      diffHash = undefined;
      writeStderrLine(
        'WARNING: script-lint could not parse the captured diff; the report is ' +
          'left without a diffHash and the review gate will reject it as stale.',
      );
    }
  }

  const checked: FileLint[] = [];
  const skipped: ScriptLintReport['skipped'] = [];
  const errored: ScriptLintReport['errored'] = [];
  const deferred: ScriptLintReport['deferred'] = [];
  const missing = new Set<LintTool>();

  const wt = resolve(args.worktree);
  const wtReal = realIfExists(wt); // canonical worktree, symlinks resolved
  for (const f of files) {
    const path = typeof f?.path === 'string' ? f.path : '';
    if (!path) continue;
    const abs = resolve(join(args.worktree, path));
    // Defence-in-depth: the plan is a file the orchestrator writes, not fully
    // trusted input. Two escapes to refuse, disclosed as skipped rather than read:
    //  1. LEXICAL — a `../../etc/passwd`-style path resolves outside the worktree.
    //  2. SYMLINKED ANCESTOR — the path is lexically inside, but a directory on the
    //     way has been replaced with a symlink, so its REAL location is outside.
    //     `lstatSync` only spares the final component; ancestors are followed, so
    //     the canonical path is what the linter would actually read. `realIfExists`
    //     returns undefined for a path that does not fully exist — that is fine, it
    //     is handled as `missing`/`irregular` by `firstLineOf` below.
    const escapes = (p: string, root: string) =>
      p !== root && !p.startsWith(root + sep);
    const real = realIfExists(abs);
    if (escapes(abs, wt) || (wtReal && real && escapes(real, wtReal))) {
      const byName = pathTool(path);
      if (byName) {
        skipped.push({
          path,
          tool: byName,
          reason: 'path resolves outside the worktree',
        });
      }
      continue;
    }
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
        // Nor does it end with "not linted": the body renders every reason
        // under a header that already says so ("Not reviewed:" / "Not
        // linted:"), and a tail here posted the phrase twice in one sentence.
        skipped.push({
          path,
          tool: byName,
          reason: 'not a regular file (symlink/fifo) or unreadable',
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
        reason: 'actionlint embedded-shell source mapping is not yet supported',
        reasonZh: 'actionlint 对 workflow 内嵌 shell 的源映射尚未支持',
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
    // Prefer the diff's added-line ranges (context excluded). A path the PARSED diff
    // does not mention yields `[]` (nothing added → nothing blocks) — NOT the plan's
    // context-inclusive hunks, which would false-positive a pre-existing finding on a
    // context line into a blocker. The context-inclusive `hunksOf` fallback is used
    // ONLY when no diff was parsed at all (`addedRanges` empty), a report the gate
    // then rejects as stale anyway.
    const ranges =
      addedRanges.get(path) ?? (addedRanges.size > 0 ? [] : hunksOf(f));
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
    diffHash, // derived from the SAME buffer the ranges came from (read once, above)
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
    try {
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
    } catch (err) {
      // A missing/invalid plan makes `runScriptLint` throw. Emit the one-line
      // message and a non-zero exit (matching build-test), not yargs' stack trace —
      // the orchestrator reads a clean error, and the gate still fails closed on the
      // absent report.
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
