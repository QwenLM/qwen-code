/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallContext, PolicyExplanation } from './evaluator.js';

/** Outcome of {@link parseExplainArgs}. `tool` is undefined when none was given. */
export interface ParsedExplain {
  tool?: string;
  ctx: ToolCallContext;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse `<toolName> [--args=…] [--path=…] [--scope=…] [--tag=…]` (the argv AFTER
 * `policy explain`) into the enforcer's `ctx = { tool, args }` shape
 * (enforcer.ts: `args = toolCall.input ?? …`). Only the `--key=value` form is
 * parsed (matches the spec examples); the first non-flag token is the tool;
 * unknown flags and bare `--flag`s are ignored.
 *
 * - `--args=V`: if `V` parses as a JSON object/array → that value; otherwise the
 *   RAW string. NOTE: real enforcement sees `args` as the tool INPUT OBJECT, so
 *   a structure-sensitive `argsGlob` matches against the JSON encoding; a
 *   bare-string `--args` is a convenience that can diverge from that — pass the
 *   JSON input object for an exact match.
 * - `--path=V`: feeds `pathGlob` via the evaluator's `candidatePaths` (which
 *   reads `args.path/cwd/files`). If `args` is a plain object, sets `.path`
 *   (when absent); otherwise `--path` WINS → `args = { path: V }` (a bare-string
 *   `--args` is dropped for path purposes — the single `args` field cannot be
 *   both a clean match string and a path-bearing object).
 * - `--scope=V` → `originScope`; `--tag=V` → `sessionTag`.
 */
export function parseExplainArgs(argv: string[]): ParsedExplain {
  let tool: string | undefined;
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1);
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

  const ctx: ToolCallContext = {
    tool: tool ?? '',
    projectRoot: process.cwd(),
    cwd: process.cwd(),
  };
  if (flags['path'] !== undefined) ctx.paths = [flags['path']];
  if (args !== undefined) ctx.args = args;
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
