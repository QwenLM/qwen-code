/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallContext, PolicyExplanation } from './evaluator.js';
import { POLICY_OPERATIONS } from './loader.js';

/** Outcome of {@link parseExplainArgs}. `tool` is undefined when none was given. */
export interface ParsedExplain {
  tool?: string;
  ctx: ToolCallContext;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Thrown by {@link parseExplainArgs} when an argument fails validation (today:
 * an `--operation=` value outside `read | write | execute`). The CLI catches
 * this and prints the message alongside the usage line.
 */
export class ExplainArgsError extends Error {}

/**
 * Parse `<toolName> [--args=…] [--path=…] [--operation=…] [--scope=…]
 * [--tag=…] [--project-root=…]` (the argv AFTER `policy explain`) into the
 * evaluator's `ToolCallContext` shape. Only the `--key=value` form is parsed
 * (matches the spec examples); the first non-flag token is the tool; unknown
 * flags and bare `--flag`s are ignored.
 *
 * - `--args=V`: if `V` parses as a JSON object/array → that value; otherwise the
 *   RAW string. NOTE: real enforcement sees `args` as the tool INPUT OBJECT, so
 *   a structure-sensitive `argsGlob` matches against the JSON encoding; a
 *   bare-string `--args` is a convenience that can diverge from that — pass the
 *   JSON input object for an exact match.
 * - `--path=V`: sets `ctx.paths = [V]` directly, so a `pathGlob` rule can match
 *   the simulated call. If `args` is a plain object, also sets its `.path`
 *   (when absent, purely for display/argsGlob purposes); otherwise `--path`
 *   WINS → `args = { path: V }` (a bare-string `--args` is dropped for path
 *   purposes — the single `args` field cannot be both a clean match string
 *   and a path-bearing object).
 * - `--operation=V`: populates `ctx.operations`, for `match.operation` rules.
 *   Repeatable (`--operation=read --operation=write`) and/or comma-separated
 *   (`--operation=read,write`); values are validated against
 *   `read | write | execute` — an invalid value throws {@link ExplainArgsError}
 *   (previously `ctx.operations` was never set by this CLI, so an
 *   `operation`-matching rule could never be shown matching).
 * - `--scope=V` → `originScope`; `--tag=V` → `sessionTag`.
 * - `--project-root=V` → overrides the `process.cwd()` default for both
 *   `ctx.projectRoot` and `ctx.cwd` (real enforcement anchors `pathGlob` to the
 *   daemon's own workspace, not wherever `policy explain` happens to run —
 *   without this flag, running `explain` outside that workspace can report a
 *   verdict that diverges from what the running gateway would actually do).
 */
export function parseExplainArgs(argv: string[]): ParsedExplain {
  let tool: string | undefined;
  const flags: Record<string, string> = {};
  const operationValues: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        const key = a.slice(2, eq);
        const value = a.slice(eq + 1);
        if (key === 'operation') {
          operationValues.push(value);
        } else {
          flags[key] = value;
        }
      }
      // a bare `--flag` (no `=`) carries no value → ignored.
    } else if (tool === undefined) {
      tool = a;
    }
  }

  let args: unknown;
  if (flags['args'] !== undefined) {
    const raw = flags['args'];
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        args = JSON.parse(trimmed);
      } catch {
        args = raw;
      }
    } else {
      args = raw;
    }
  }

  if (flags['path'] !== undefined) {
    if (isPlainObject(args)) {
      if (args['path'] === undefined) args['path'] = flags['path'];
    } else {
      args = { path: flags['path'] };
    }
  }

  let operations: string[] | undefined;
  if (operationValues.length > 0) {
    const raw = operationValues
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    for (const o of raw) {
      if (!(POLICY_OPERATIONS as readonly string[]).includes(o)) {
        throw new ExplainArgsError(
          `invalid --operation value '${o}'; expected one of ` +
            `${POLICY_OPERATIONS.join(' | ')}`,
        );
      }
    }
    operations = raw;
  }

  const projectRoot = flags['project-root'] ?? process.cwd();
  const ctx: ToolCallContext = {
    tool: tool ?? '',
    projectRoot,
    cwd: projectRoot,
  };
  if (flags['path'] !== undefined) ctx.paths = [flags['path']];
  if (args !== undefined) ctx.args = args;
  if (operations !== undefined) ctx.operations = operations;
  if (flags['scope'] !== undefined) ctx.originScope = flags['scope'];
  if (flags['tag'] !== undefined) ctx.sessionTag = flags['tag'];
  return { tool, ctx };
}

/**
 * Render a {@link PolicyExplanation} as human-readable lines: each rule in
 * evaluation order with a MATCHED / SKIPPED / not-reached annotation, then the
 * authoritative decision and its source. When the matched winner carries a
 * `maxPerWindow` whose quota was not consulted (the dry run has no live store —
 * `trace[].quotaNotEvaluated`), a caveat notes the runtime result could differ.
 */
export function formatExplanation(exp: PolicyExplanation): string {
  const { decision, trace } = exp;
  const lines: string[] = ['rules considered (evaluation order):'];
  if (trace.length === 0) lines.push('  (no rules)');
  for (const t of trace) {
    const id = t.id ?? `[${t.index}]`;
    if (t.status === 'matched') {
      const tail = t.downgraded
        ? `-> ${t.action} (downgraded: ${t.reason})`
        : `-> ${t.action}`;
      lines.push(`  MATCHED   ${id} ${tail}`);
    } else if (t.status === 'skipped') {
      lines.push(`  SKIPPED   ${id} (${t.reason})`);
    } else {
      lines.push(`  -         ${id} (not reached: ${t.reason})`);
    }
  }

  const src =
    decision.source === 'default'
      ? 'default'
      : `rule ${decision.ruleId ?? '(id-less)'}`;
  let dline = `decision: ${decision.action} (source: ${src})`;
  if (decision.usedDeferredField) dline += ' [downgraded to prompt]';
  lines.push(dline);

  if (trace.some((t) => t.quotaNotEvaluated)) {
    lines.push(
      'note: maxPerWindow is not evaluated in this dry run (no live quota ' +
        'store); at runtime the matched rule applies with its real action ' +
        'while it has quota room, or is skipped once exhausted (a later rule ' +
        'or the default then decides) — so the live result may differ from ' +
        'what is shown here.',
    );
  }
  return lines.join('\n');
}
