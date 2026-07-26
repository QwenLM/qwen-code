/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review script-lint`: run the deterministic linters over the executable
// code a diff adds or changes, and report what they say.
//
// A diff's shell — a `.sh` file, a `Makefile` recipe, a Dockerfile `RUN`, a
// GitHub Actions `run:` block — is code, and its bugs (an unquoted `$x` that
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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

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
  /** True when no finding on a changed line is an `error` or `warning`. */
  ok: boolean;
  /** One line for the agent's report. */
  note: string;
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
  if (p.endsWith('.sh') || p.endsWith('.bash')) return 'shellcheck';
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

/** Run a tool, or report it missing. `null` means the binary is not installed. */
function runTool(tool: LintTool, absPath: string): string | null {
  // The three tools all take a file path and print machine-readable diagnostics.
  const argv: Record<LintTool, string[]> = {
    shellcheck: ['--format=json1', '--severity=style', absPath],
    actionlint: ['-format', '{{json .}}', '-no-color', absPath],
    hadolint: ['--format', 'json', absPath],
  };
  const r = spawnSync(tool, argv[tool], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return null; // not installed
  }
  // All three exit non-zero when they find something — that is not a failure of
  // the command, it is the finding. stdout carries the JSON; stderr is noise.
  return `${r.stdout ?? ''}`;
}

/** Normalise each tool's JSON into `LintFinding[]` (line/code/level/message). */
function parseFindings(tool: LintTool, raw: string): LintFinding[] {
  if (!raw.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
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
  // actionlint: an array of { message, line, column, kind, ... }
  return (Array.isArray(json) ? json : [])
    .map((c) => {
      const o = c as { line?: unknown; kind?: unknown; message?: unknown };
      return mk(o.line, String(o.kind ?? 'actionlint'), 'error', o.message);
    })
    .filter((x): x is LintFinding => x !== null);
}

export function runScriptLint(args: ScriptLintArgs): ScriptLintReport {
  let plan: { files?: PlanFile[] };
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  } catch (err) {
    throw new Error(
      `script-lint: cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }
  const files = Array.isArray(plan.files) ? plan.files : [];
  const checked: FileLint[] = [];
  const skipped: ScriptLintReport['skipped'] = [];
  const missing = new Set<LintTool>();

  for (const f of files) {
    const path = typeof f?.path === 'string' ? f.path : '';
    if (!path) continue;
    const abs = resolve(join(args.worktree, path));
    // A file the diff deleted has nothing to lint on the new side.
    if (!existsSync(abs)) continue;
    const firstLine = readFileSync(abs, 'utf8').split('\n', 1)[0] ?? '';
    const tool = toolFor(path, firstLine);
    if (!tool) continue;

    if (missing.has(tool)) {
      skipped.push({ path, tool, reason: `${tool} is not installed` });
      continue;
    }
    const raw = runTool(tool, abs);
    if (raw === null) {
      missing.add(tool);
      skipped.push({ path, tool, reason: `${tool} is not installed` });
      continue;
    }
    const ranges = hunksOf(f);
    const findings = parseFindings(tool, raw).map((x) => ({
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
  const ok = blocking.length === 0;
  const note = buildNote(checked, skipped, blocking.length);
  return { checked, skipped, ok, note };
}

function buildNote(
  checked: FileLint[],
  skipped: ScriptLintReport['skipped'],
  blocking: number,
): string {
  if (checked.length === 0 && skipped.length === 0) {
    return 'No executable scripts changed — nothing to lint.';
  }
  const parts: string[] = [];
  parts.push(
    `Linted ${checked.length} file(s); ${blocking} finding(s) on changed lines.`,
  );
  if (skipped.length > 0) {
    const tools = [...new Set(skipped.map((s) => s.tool))].join(', ');
    parts.push(
      `${skipped.length} file(s) not checked — ${tools} not installed (report as unreviewed, not clean).`,
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
    if (args.out) {
      mkdirSync(dirname(resolve(args.out)), { recursive: true });
      writeFileSync(args.out, json);
      writeStdoutLine(`Wrote script-lint report to ${args.out}`);
    } else {
      writeStdoutLine(json);
    }
    writeStderrLine(report.note);
  },
};
