/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strip a leading `export const meta = { ... }` declaration from a workflow
 * script. Required because Node's vm script mode rejects ES module syntax.
 *
 * P1 does not use meta semantically; it is removed so that Claude-Code-trained
 * models whose first line is `export const meta = {...}` do not produce a
 * SyntaxError at sandbox parse time.
 *
 * Recognises `//` / `/* *\/` comments and regex literals in addition to
 * string literals (single, double, template). Throws on unbalanced braces
 * instead of returning a truncated string — silently deleting the script
 * body produced the worst-case failure mode (workflow runs, returns
 * undefined, no diagnostic).
 *
 * Template-literal `${...}` substitutions that contain `{` or `}` are not
 * supported — model-authored `meta` should avoid them.
 */
export function stripExportMeta(source: string): string {
  const bounds = findMetaBlockBounds(source);
  if (!bounds) return source;
  return source.slice(0, bounds.exportIdx) + source.slice(bounds.afterMeta);
}

/**
 * Locate the `export const meta = {...}` declaration's bounds in the source.
 *
 * Shared by stripExportMeta (P1) and extractAndStripMeta (P4). Anchors at file
 * start (no `/m` flag — see T33 comment below); walks the brace block while
 * skipping over comment / regex / string contexts; throws on unbalanced
 * braces rather than returning a truncated string (T9/T17 — silently
 * deleting the script body is the worst-case failure mode).
 *
 * Returns null when no meta declaration is present at the file start —
 * callers treat this as "no meta", not an error.
 */
function findMetaBlockBounds(source: string): {
  /** Start offset of the `export const meta` match. */
  exportIdx: number;
  /** Offset of the `{` opening the meta object literal. */
  startBrace: number;
  /** Offset of the matching `}` closing the literal (inclusive). */
  endBraceIncl: number;
  /** Offset past meta + any trailing whitespace + optional `;`. */
  afterMeta: number;
} | null {
  // T33 (PR #4732 R4): anchor at file start (no `/m` flag). Per the design
  // doc, `export const meta = {...}` must be the script's FIRST statement.
  // With `/m`, the regex matched every line-start occurrence — including
  // inside template literals — and the brace-walker then ripped content
  // out of the string body, silently corrupting the script.
  const re = /^\s*export\s+const\s+meta\s*=\s*\{/;
  const match = re.exec(source);
  if (!match) return null;
  const exportIdx = match.index;
  const startBrace = source.indexOf('{', exportIdx);
  let depth = 1;
  let i = startBrace + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    const next = source[i + 1];
    // Single-line comment: skip to newline (T16).
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // Block comment: skip to closing `*/` (T16).
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/'))
        i++;
      i += 2;
      continue;
    }
    // Regex literal: skip to matching `/`. We accept the heuristic that a `/`
    // appearing as a value in `{` context is a regex literal, not division
    // — meta objects don't perform arithmetic on properties.
    if (ch === '/' && isRegexContext(source, i)) {
      i++;
      let inClass = false;
      while (
        i < source.length &&
        (inClass || source[i] !== '/') &&
        source[i] !== '\n'
      ) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '[') {
          inClass = true;
          i++;
        } else if (source[i] === ']') {
          inClass = false;
          i++;
        } else {
          i++;
        }
      }
      i++; // skip closing /
      // Skip flags
      while (i < source.length && /[gimsuy]/.test(source[i]!)) i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  // T9/T17: refuse to truncate the script when the meta block is unbalanced.
  // Returning `""` previously caused the entire workflow body to vanish
  // silently — the worst possible failure mode.
  if (depth !== 0) {
    throw new Error(
      'stripExportMeta: unbalanced braces in export const meta declaration — ' +
        'the workflow script cannot be safely stripped. Check the meta block syntax.',
    );
  }
  const endBraceIncl = i - 1;
  // Skip trailing whitespace and an optional semicolon.
  while (i < source.length && /[\s;]/.test(source[i]!)) i++;
  return { exportIdx, startBrace, endBraceIncl, afterMeta: i };
}

/**
 * The `meta` object shape — verbatim from upstream Claude Code 2.1.168.
 * `name` and `description` are mandatory; `whenToUse` and `phases` are
 * optional. Each phase carries a mandatory `title` and optional `detail`
 * / `model`. P4 surfaces this shape on `WorkflowRunOutcome.meta` so
 * `/workflows` listing and the phase-tree UI can read it directly.
 */
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}

/**
 * Strip `export const meta = {...}` from the script AND extract the meta
 * object as a plain host-realm value, ready to surface on `WorkflowRunOutcome`.
 *
 * Implementation:
 *   1. `findMetaBlockBounds` (shared with `stripExportMeta`) locates the
 *      object-literal source range via the brace-walker.
 *   2. The literal source is evaluated as `(${metaSource})` inside a fresh
 *      vm context whose globalThis is a null-prototyped object — no
 *      bridge to the host realm, no access to host primitives like
 *      `process` / `require` / the workflow-sandbox bridge globals
 *      (`args` / `agent` / `phase` / `log` / etc.). The vm realm DOES
 *      provide its own intrinsics (`Object`, `Array`, `Math`, `Date`,
 *      `JSON`, …) which is fine: meta extraction is a one-shot at tool-
 *      invocation time, not replayed during resume, so non-determinism in
 *      the meta literal (a `Date.now()` call in `meta.name`) does not
 *      break the resume contract that the script body honors.
 *   3. The vm result is walked field-by-field and copied into a new
 *      host-realm plain object. No JSON round-trip is needed because every
 *      contract field is a primitive — strings and arrays of plain
 *      objects with string fields — so prototype identity on the
 *      intermediate values is irrelevant.
 *
 * Returns `{ stripped, meta: null }` when no meta declaration is present
 * (callers treat this as "no meta"). Throws when meta is present but
 * malformed: vm eval failure, missing required field, or wrong field type.
 * Error messages for the missing-required-field cases match upstream
 * 2.1.168 verbatim so script authors see one consistent error text.
 */
export function extractAndStripMeta(source: string): {
  stripped: string;
  meta: WorkflowMeta | null;
} {
  const bounds = findMetaBlockBounds(source);
  if (!bounds) return { stripped: source, meta: null };

  const metaSource = source.slice(bounds.startBrace, bounds.endBraceIncl + 1);
  const stripped =
    source.slice(0, bounds.exportIdx) + source.slice(bounds.afterMeta);

  // Null-prototyped globalThis: no host bridge (no `process` / `require`
  // / `args` / workflow-sandbox bridge globals). The vm realm still
  // provides its own intrinsics, but that's intentional — see the
  // docstring above.
  const metaContext = vm.createContext(Object.create(null));
  let raw: unknown;
  try {
    raw = new vm.Script(`(${metaSource})`).runInContext(metaContext);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `extractAndStripMeta: failed to evaluate meta object literal: ${msg}`,
    );
  }

  // P4a R3 (wenshao): a Promise (e.g. `import('node:fs')`) used as a
  // value in the meta literal would otherwise leave a dangling rejection
  // behind — `runInContext` returns synchronously with the Promise scheduled
  // to reject on the next tick, validateMeta drops the non-contract field
  // silently, and the run completes successfully. Then Node's default
  // `--unhandled-rejections=throw` terminates the host process, decoupled
  // from the run that triggered it. Walk `raw`, neutralise any thenables
  // with `.catch(() => {})` so the rejection is marked handled, and reject
  // the meta literal up front.
  rejectThenablesInMeta(raw);

  const meta = validateMeta(raw);
  return { stripped, meta };
}

/**
 * Recursively scan a vm-eval'd value, marking any thenable as handled
 * (so its rejection cannot terminate the host on the next tick) and
 * throwing an explicit "meta values must not be Promises" so the
 * malformed meta is reported clearly.
 *
 * Recurses through plain objects and arrays — `phases[]` entries may
 * embed an `import()` below the top level.
 */
function rejectThenablesInMeta(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (value === null || typeof value !== 'object') return;
  // P4 Round 4 (wenshao): a cyclic meta literal built via spread of a
  // self-referential object would otherwise overflow the call stack on
  // this walk — the walker exists to reject Promises before they leave
  // a dangling rejection, but the walk itself must terminate on any
  // shape vm-eval can return. Track visited nodes in a WeakSet so cycles
  // and shared subgraphs both early-return without re-walking.
  if (seen.has(value as object)) return;
  seen.add(value as object);
  const maybeThen = (value as { then?: unknown }).then;
  if (typeof maybeThen === 'function') {
    // Mark handled so Node's unhandled-rejection trap does not later kill
    // the process. `.catch` on a non-Promise thenable would synchronously
    // throw if the implementation is non-standard, so swallow defensively.
    try {
      (value as Promise<unknown>).catch(() => {});
    } catch {
      /* non-standard thenable — already rejecting below */
    }
    throw new Error(
      'extractAndStripMeta: meta values must not be Promises ' +
        '(no async / dynamic import allowed in meta literal)',
    );
  }
  if (Array.isArray(value)) {
    for (const v of value) rejectThenablesInMeta(v, seen);
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    rejectThenablesInMeta(v, seen);
  }
}

/**
 * Validate the vm-eval'd meta value and copy it into a fresh host-realm
 * plain object. Throws on shape violation with the upstream-aligned error
 * message text for the required-field cases.
 *
 * Field rules:
 *   - `name`           required, non-empty string
 *   - `description`    required, non-empty string
 *   - `whenToUse`      optional, string (may be empty)
 *   - `phases`         optional, Array of plain objects with:
 *                        `title`   required, non-empty string
 *                        `detail`  optional, string
 *                        `model`   optional, string
 */
function validateMeta(value: unknown): WorkflowMeta {
  if (value === null || typeof value !== 'object') {
    throw new Error('meta must be an object');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['name'] !== 'string' || (obj['name'] as string).length === 0) {
    // Verbatim from upstream Claude Code 2.1.168.
    throw new Error('meta.name must be a non-empty string');
  }
  if (
    typeof obj['description'] !== 'string' ||
    (obj['description'] as string).length === 0
  ) {
    // Verbatim from upstream Claude Code 2.1.168.
    throw new Error('meta.description must be a non-empty string');
  }
  if (obj['whenToUse'] !== undefined && typeof obj['whenToUse'] !== 'string') {
    throw new Error('meta.whenToUse must be a string');
  }
  let phases:
    | Array<{ title: string; detail?: string; model?: string }>
    | undefined;
  if (obj['phases'] !== undefined) {
    if (!Array.isArray(obj['phases'])) {
      throw new Error('meta.phases must be an array');
    }
    phases = [];
    for (const p of obj['phases'] as unknown[]) {
      if (p === null || typeof p !== 'object') {
        throw new Error('meta.phases entries must be objects');
      }
      const ph = p as Record<string, unknown>;
      if (
        typeof ph['title'] !== 'string' ||
        (ph['title'] as string).length === 0
      ) {
        throw new Error('meta.phases[].title must be a non-empty string');
      }
      const phase: { title: string; detail?: string; model?: string } = {
        title: ph['title'] as string,
      };
      if (ph['detail'] !== undefined) {
        if (typeof ph['detail'] !== 'string') {
          throw new Error('meta.phases[].detail must be a string');
        }
        phase.detail = ph['detail'] as string;
      }
      if (ph['model'] !== undefined) {
        if (typeof ph['model'] !== 'string') {
          throw new Error('meta.phases[].model must be a string');
        }
        phase.model = ph['model'] as string;
      }
      phases.push(phase);
    }
  }

  const out: WorkflowMeta = {
    name: obj['name'] as string,
    description: obj['description'] as string,
  };
  if (obj['whenToUse'] !== undefined) {
    out.whenToUse = obj['whenToUse'] as string;
  }
  if (phases !== undefined) {
    out.phases = phases;
  }
  return out;
}

/**
 * Heuristic: a `/` at offset `i` is a regex literal (not division) if the
 * previous non-whitespace character is an operator, opening brace/bracket,
 * comma, colon, or `=` — i.e. positions where a value is expected.
 */
function isRegexContext(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j]!)) j--;
  if (j < 0) return true;
  const prev = source[j]!;
  return /[{[(,;:=!&|?+\-*/%^~<>]/.test(prev);
}

import * as vm from 'node:vm';
import { createDebugLogger } from '../../utils/debugLogger.js';

// Shared with workflow-orchestrator (avoids a duplicate createDebugLogger
// instance with the same 'WORKFLOW' namespace). Re-exported so orchestrator
// imports the same instance — orchestrator already imports from this module,
// so this is the natural direction (the reverse would be a circular dep).
export const debugLogger = createDebugLogger('WORKFLOW');

// Cap log + phase lines to prevent unbounded memory growth from runaway
// model-authored loops.
const MAX_LOG_LINES = 10_000;
const MAX_PHASE_ENTRIES = 10_000;
// Max nesting depth for args; defends against stack-overflow on deeply
// nested model-authored input.
const ARGS_MAX_DEPTH = 64;

/**
 * WorkflowAgentOpts — structured options for the `agent()` global.
 *
 * The named fields below are explicitly recognised. P1 throws for unsupported
 * fields (`schema`, `model`, `isolation`, `agentType`) rather than silently
 * dropping them. The runtime allowlist enforced in the vm-realm init script
 * additionally throws on ANY field not in the known set — catching typos
 * like `scema` before they reach dispatch.
 */
export interface WorkflowAgentOpts {
  label?: string;
  phase?: string;
  schema?: object;
  model?: string;
  isolation?: 'worktree' | 'remote';
  agentType?: string;
  /**
   * P-stall: per-call stall-watchdog timeout in milliseconds. The dispatch
   * is aborted + retried (up to 3 attempts) after this many ms of no
   * subagent progress (with no tool in flight). Defaults to 60_000 (env
   * override `QWEN_CODE_WORKFLOW_STALL_SECONDS`). `0` disables the watchdog
   * for this call.
   */
  stallMs?: number;
  // The index signature exists so TypeScript accepts forward-compat opt names
  // at compile time; the runtime allowlist still rejects unknown names.
  [key: string]: unknown;
}

/**
 * Agent dispatch return type. P1/P2 was `string` (the subagent's final text
 * verbatim). P3 widens to also allow a JSON-serializable object — the
 * validated arguments of the subagent's `structured_output` call when
 * `agent({schema})` is used. Strings remain the no-schema return shape;
 * the sandbox's `agent` wrapper revives object returns into the vm realm
 * per-call so a host-realm prototype escape (T1/T8/T14) cannot ride the
 * structured payload back into a script.
 */
export type WorkflowAgentResult = string | object;

/**
 * P5: budget global API surface. P1 default is throwing stubs (total = null,
 * spent()/remaining() throw). P5 will inject a real tracker.
 */
export interface WorkflowBudget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

/**
 * P4b: host-side live-event channel for the orchestrator and sandbox to
 * notify external consumers (typically the `WorkflowRunRegistry`) when
 * a phase boundary or agent dispatch happens, or when the script logs
 * something. Every method is host-realm (called from sandbox closures
 * and `countedDispatch`) — no vm-realm bridge concerns.
 *
 * All methods are no-ops by default — implementations are free to
 * implement only the events they care about.
 *
 * Truncation: `phaseStarted` / `logAppended` are NOT called once the
 * sandbox's internal `MAX_PHASE_ENTRIES` / `MAX_LOG_LINES` cap has
 * been reached, mirroring `getPhases()` / `getLogs()` so a chatty
 * workflow does not flood the registry with thousands of events.
 */
export interface WorkflowOrchestratorEmitter {
  /** Sandbox `phase(title)` was called. */
  phaseStarted?(title: string): void;
  /** Sandbox `log(...)` produced one line of output (or `console.log`). */
  logAppended?(line: string): void;
  /** Orchestrator's `countedDispatch` is about to invoke `dispatch(...)`. */
  agentDispatched?(label?: string): void;
  /** `dispatch(...)` settled (success or thrown). `error` set on rejection. */
  agentCompleted?(label?: string, error?: string): void;
  /**
   * P5: cumulative `spent` re-snapshot after each successful agent
   * completion. `total` is `null` when no per-run cap is set
   * (`QWEN_CODE_MAX_TOKENS_PER_WORKFLOW` unset). Caller (the
   * `WorkflowTool`) mirrors this into the `WorkflowRunRegistry` so the
   * pill / dialog / detail body surface the live token usage. The
   * orchestrator only fires this when a `budget` was passed to
   * `WorkflowRunRequest.budget`.
   */
  budgetUpdated?(spent: number, total: number | null): void;
}

export interface SandboxOptions {
  /** Value bound to the `args` global inside the script. */
  args: unknown;
  /**
   * Function called by the script's `agent(prompt, opts)` global. Returns the
   * agent's final text. Injected so tests can mock without spawning an LLM.
   */
  dispatch: (
    prompt: string,
    opts: WorkflowAgentOpts,
  ) => Promise<WorkflowAgentResult>;
  /**
   * Forward-compatibility injection seams for P2 (parallel / pipeline) and
   * P5 (budget). When omitted the sandbox falls back to throwing stubs.
   */
  parallel?: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
  pipeline?: (
    items: unknown[],
    ...stages: Array<
      (prev: unknown, item: unknown, idx: number) => Promise<unknown>
    >
  ) => Promise<unknown[]>;
  /**
   * Host-side `workflow(nameOrRef, args)` implementation. When provided, the
   * sandbox exposes the `workflow` global that resolves a saved workflow
   * (by name from `.qwen/workflows/<name>.js`, or by `{scriptPath}`) and runs
   * it as a nested orchestration sharing this run's agent-count cap and token
   * budget. When omitted the sandbox falls back to a throwing stub — this is
   * also how single-level nesting is enforced: the orchestrator injects
   * `workflow` only at the top level, so a nested workflow's sandbox has no
   * `workflow` impl and a second-level `workflow()` call throws.
   */
  workflow?: (
    nameOrRef: string | { scriptPath: string },
    args: unknown,
  ) => Promise<unknown>;
  budget?: WorkflowBudget;
  /**
   * T23 (PR #4732 R2): async wall-clock cap (ms) covering the entire script
   * including awaits. The vm `timeout` option only covers the synchronous
   * portion; once the IIFE yields its first `await`, the watchdog is
   * disarmed and `return new Promise(() => {})` would hang forever.
   *
   * Defaults to 30 minutes, override via `QWEN_CODE_MAX_WORKFLOW_SECONDS`
   * env var, or pass an explicit value here (tests use small values for
   * fast verification).
   *
   * This stays a permanent defense even after P5's `budget` ships:
   * budget caps tokens, but a 0-token hang (`new Promise(() => {})`) only
   * a wall-clock can catch.
   */
  maxWallClockMs?: number;
  /**
   * T40 (PR #4732 R4): completes the R2 wall-clock defense. When the timer
   * fires, the sandbox `abort()`s this controller BEFORE rejecting. The
   * caller threads the same controller's `signal` into the dispatch
   * function (via `createProductionDispatch`) so in-flight subagents see
   * the abort and stop. Without this, the workflow user-side rejects but
   * the subagent keeps burning tokens until its own `max_time_minutes`
   * limit (10 min default).
   *
   * The caller is responsible for cleanup on natural completion (call
   * `abort()` in a `finally` block to cancel any straggler dispatch).
   */
  abortOnTimeout?: AbortController;
  /**
   * P4b: optional host-side event channel. When provided, the sandbox's
   * `safePhase` / `safeLog` closures fire `phaseStarted` / `logAppended`
   * on every accepted entry (after the per-cap truncation guard). The
   * caller (typically `WorkflowTool` via `WorkflowOrchestrator`) wires
   * these into the `WorkflowRunRegistry` so the UI surfaces (pill /
   * dialog / detail body) can re-render without polling `getPhases()`.
   */
  emitter?: WorkflowOrchestratorEmitter;
}

/**
 * T23 (PR #4732 R2): default async wall-clock cap. The wall clock is a
 * 0-token-hang backstop, NOT a precise cost cap: it bounds patterns like an
 * in-script `await new Promise(() => {})` that the vm timeout cannot reach.
 * For genuine cost control, use the env-overridable per-run cap
 * (`QWEN_CODE_MAX_WORKFLOW_AGENTS`) and concurrency window
 * (`QWEN_CODE_MAX_WORKFLOW_CONCURRENCY`). 30 minutes is set generously
 * enough that typical workflows never see it but a hang doesn't waste
 * operator hours; raise via `QWEN_CODE_MAX_WORKFLOW_SECONDS` for long
 * legitimate fan-outs (1000 agents × 10-min subagent cap ÷ default
 * concurrency would already exceed 30 min).
 */
const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60 * 1000;

function resolveMaxWallClockMs(opts: SandboxOptions): number {
  if (typeof opts.maxWallClockMs === 'number' && opts.maxWallClockMs > 0) {
    return opts.maxWallClockMs;
  }
  const envSec = Number(process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS']);
  if (Number.isFinite(envSec) && envSec > 0) return envSec * 1000;
  return DEFAULT_MAX_WALL_CLOCK_MS;
}

export interface WorkflowSandbox {
  /**
   * Execute the user-authored script source. The script is wrapped as an async
   * IIFE so it may use top-level `await` and `return`. Returns the script's
   * top-level return value.
   *
   * `export const meta = {...}` is extracted before parsing and exposed via
   * `getMeta()` — the script body sees the meta-stripped source.
   */
  run(scriptSource: string): Promise<unknown>;
  /** Phase titles announced by the script in order. */
  getPhases(): string[];
  /** Log lines emitted by the script in order. */
  getLogs(): string[];
  /**
   * The script's `export const meta = {...}` declaration, validated and
   * extracted before the script body runs. `null` when the script omits
   * the declaration. Throws (during `run`) when the declaration is
   * present but malformed.
   */
  getMeta(): WorkflowMeta | null;
}

/**
 * Validate `args` without mutating it. Throws on functions, BigInts, circular
 * references, and nesting beyond `ARGS_MAX_DEPTH`. The actual sandbox `args`
 * global is built INSIDE the vm context via `JSON.parse` so it inherits
 * vm-realm prototypes — this validation just gates what we hand to JSON
 * stringification.
 */
function validateArgs(
  val: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (depth > ARGS_MAX_DEPTH) {
    throw new Error(
      `WorkflowSandbox: args exceeded max nesting depth of ${ARGS_MAX_DEPTH}`,
    );
  }
  if (val === null) return;
  const t = typeof val;
  if (t === 'function') {
    throw new Error(
      'WorkflowSandbox: args must be JSON-serializable (functions are not allowed).',
    );
  }
  if (t === 'bigint') {
    throw new Error(
      'WorkflowSandbox: args must be JSON-serializable (BigInt is not allowed — pass as string).',
    );
  }
  if (t !== 'object') return;
  const obj = val as object;
  if (seen.has(obj)) {
    throw new Error(
      'WorkflowSandbox: args must be JSON-serializable (circular reference detected).',
    );
  }
  seen.add(obj);
  if (Array.isArray(val)) {
    for (const item of val) validateArgs(item, depth + 1, seen);
  } else {
    for (const v of Object.values(val as Record<string, unknown>)) {
      validateArgs(v, depth + 1, seen);
    }
  }
}

export function createWorkflowSandbox(opts: SandboxOptions): WorkflowSandbox {
  const phases: string[] = [];
  const logs: string[] = [];

  const safeLog = (msg: unknown): void => {
    if (logs.length < MAX_LOG_LINES) {
      const line = String(msg);
      logs.push(line);
      // P4b: emit to host-side subscriber (registry). Defensive try/catch
      // because a subscriber error must not interrupt script execution
      // — the script body has no business knowing about UI plumbing.
      try {
        opts.emitter?.logAppended?.(line);
      } catch (e) {
        debugLogger.warn('emitter.logAppended threw:', e);
      }
    } else if (logs.length === MAX_LOG_LINES) {
      logs.push(`[workflow log truncated at ${MAX_LOG_LINES} lines]`);
    }
  };

  const safePhase = (title: string): void => {
    if (phases.length < MAX_PHASE_ENTRIES) {
      const t = String(title);
      // R7 (wenshao): collapse consecutive identical titles so the
      // sandbox is the single source of truth for the phase list.
      // Without this, `outcome.phases` (terminal `returnDisplay` JSON)
      // carried duplicates while `entry.phases` on the registry
      // (live UI / `/workflows` detail) was deduped by the registry's
      // own `onPhaseStarted` collapse — the same run showed different
      // phase counts in the terminal output vs the live UI. The
      // `agent({phase})` wrapper already dedups (see the `__b.lastPhase()`
      // check); this brings the bare `phase()` global into the same
      // contract.
      if (phases[phases.length - 1] === t) return;
      phases.push(t);
      // P4b: emit to host-side subscriber. Same defensive try/catch as
      // safeLog — subscriber errors must not bubble into the script.
      try {
        opts.emitter?.phaseStarted?.(t);
      } catch (e) {
        debugLogger.warn('emitter.phaseStarted threw:', e);
      }
    } else if (phases.length === MAX_PHASE_ENTRIES) {
      phases.push(
        `[workflow phases truncated at ${MAX_PHASE_ENTRIES} entries]`,
      );
    }
  };

  // FIX-Round1-T6: validate args structure (functions/BigInt/circular/depth)
  // before serialising. Without this, `JSON.stringify({fn: () => {}})` silently
  // drops the function key.
  if (opts.args !== undefined) validateArgs(opts.args);
  const argsJson = opts.args === undefined ? null : JSON.stringify(opts.args);

  // FIX-Round1-T1/T8/T14: build EVERY sandbox global inside the vm-realm
  // via the init script below. Host-realm objects (Promises returned by host
  // async functions, Error objects thrown by host code) leak the host Function
  // constructor through their prototype chains:
  //   `agent("x").constructor.constructor("return process")()` (T8, success path)
  //   `try { throw new Error } catch(e) { e.constructor.constructor(...)() }` (T1)
  // The fix is to NEVER expose a host object across the vm boundary. Instead
  // we expose a primitive bridge (functions and strings) on globalThis,
  // delete it as the first init action, and have the init script build vm-realm
  // wrappers that internally call the bridge but only return / throw vm-realm
  // values.
  const bridge = {
    argsJson,
    pushPhase: safePhase,
    pushLog: safeLog,
    lastPhase: () => phases[phases.length - 1],
    hostAgent: opts.dispatch,
    // PR #4947 R2 T7 (qwen-code-ci-bot): host-side log hook for reviveInRealm's
    // catch path. Mirrors the rejection-logging in settleToNullArray so an
    // operator running with debug logging can distinguish "thunk rejected"
    // (settleToNullArray.warn) from "thunk resolved to a non-JSON-serializable
    // value" (this warn). Receives only primitive strings/numbers — the bridge
    // contract forbids host objects crossing back to the script.
    logRevivalFailure: (idx: number, reason: string): void => {
      debugLogger.warn(
        `Workflow result revival failed at index ${idx}: ${reason}; ` +
          `slot set to null (non-JSON-serializable thunk return).`,
      );
    },
    // The truthy flags distinguish "injected" from "default stub" inside the
    // init script without leaking the host function itself when not used.
    hasParallel: !!opts.parallel,
    hasPipeline: !!opts.pipeline,
    hasWorkflow: !!opts.workflow,
    hasBudget: !!opts.budget,
    hostParallel: opts.parallel,
    hostPipeline: opts.pipeline,
    hostWorkflow: opts.workflow,
    budgetTotal: opts.budget ? opts.budget.total : null,
    hostBudgetSpent: opts.budget ? opts.budget.spent.bind(opts.budget) : null,
    hostBudgetRemaining: opts.budget
      ? opts.budget.remaining.bind(opts.budget)
      : null,
  };

  // T22 (PR #4732 R2): sever the host Object.prototype on both the
  // bridge AND the sandboxGlobals container. Without this,
  // `globalThis.constructor.constructor("return process")()` inside the
  // sandbox reaches the host Object → host Function → host process,
  // bypassing every other vm-realm hardening measure in this file.
  // PoC confirmed leak prior to fix; regression covered by
  // "globalThis.constructor cannot reach host process".
  Object.setPrototypeOf(bridge, null);
  const sandboxGlobals: { __workflowBridge: typeof bridge } = Object.assign(
    Object.create(null) as { __workflowBridge: typeof bridge },
    { __workflowBridge: bridge },
  );
  const ctx = vm.createContext(sandboxGlobals);

  // FIX-D + FIX-Round1: build Math, Date, args, all async/sync globals,
  // and the console object entirely inside the vm-realm. After this init
  // script completes, `globalThis.__workflowBridge` is deleted so the user
  // script cannot reach it.
  vm.runInContext(
    `(() => {
      const __b = globalThis.__workflowBridge;
      delete globalThis.__workflowBridge;

      // --- Math (vm-realm, random throws) ---
      const realMath = Math;
      const safeMath = Object.create(null);
      for (const k of Object.getOwnPropertyNames(realMath)) {
        if (k === 'random' || k === 'constructor') continue;
        safeMath[k] = realMath[k];
      }
      safeMath.random = () => {
        throw new Error(
          'Math.random() is unavailable in workflow scripts (breaks resume). ' +
          'For N independent samples, include the index in the agent label or prompt.'
        );
      };
      globalThis.Math = safeMath;

      // --- Date (vm-realm function that throws on any access) ---
      const dateMsg = 'Date.now() / new Date() are unavailable in workflow ' +
        'scripts (breaks resume). Stamp results after the workflow returns, ' +
        'or pass timestamps via args.';
      const safeDate = function Date() { throw new Error(dateMsg); };
      safeDate.now = () => { throw new Error(dateMsg); };
      safeDate.UTC = () => { throw new Error(dateMsg); };
      safeDate.parse = () => { throw new Error(dateMsg); };
      Object.setPrototypeOf(safeDate, null);
      Object.defineProperty(safeDate, 'constructor', {
        value: undefined, writable: false, configurable: false,
      });
      globalThis.Date = safeDate;

      // --- args (parsed via vm-realm JSON → vm-realm objects/arrays) ---
      // FIX-Round1-T2: vm-realm arrays keep their vm-realm Array.prototype,
      // so for...of, .map, .forEach, spread, destructuring all work — and
      // their inherited methods' constructors are vm-realm Function, which
      // cannot reach host process.
      globalThis.args = __b.argsJson === null ? undefined : JSON.parse(__b.argsJson);

      // --- Wrap a host async function so it returns a vm-realm Promise ---
      // FIX-Round1-T1/T8/T14: success and failure both cross the boundary
      // as vm-realm values: resolve with the host's value (a primitive
      // string for dispatch; vm-realm arrays for parallel/pipeline because
      // those wrappers will produce vm-realm results); reject with a
      // freshly-constructed vm-realm Error so e.constructor.constructor
      // stays in the vm realm.
      function vmAsync(hostFn) {
        return function (...vmArgs) {
          return new Promise(function (resolve, reject) {
            try {
              const hostPromise = hostFn.apply(null, vmArgs);
              hostPromise.then(
                function (value) { resolve(value); },
                function (hostErr) {
                  const msg = (hostErr && hostErr.message != null)
                    ? String(hostErr.message)
                    : String(hostErr);
                  reject(new Error(msg));
                }
              );
            } catch (hostErr) {
              const msg = (hostErr && hostErr.message != null)
                ? String(hostErr.message)
                : String(hostErr);
              reject(new Error(msg));
            }
          });
        };
      }

      // --- phase / log ---
      globalThis.phase = function phase(title) {
        __b.pushPhase(String(title));
      };
      globalThis.log = function log(msg) {
        __b.pushLog(msg);
      };

      // --- console (object with hardened methods, all in vm-realm) ---
      const safeConsole = Object.create(null);
      safeConsole.log = function () {
        const parts = [];
        for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
        __b.pushLog(parts.join(' '));
      };
      safeConsole.warn = safeConsole.log;
      safeConsole.error = safeConsole.log;
      globalThis.console = safeConsole;

      // --- agent (with runtime allowlist + named throws, all vm-realm) ---
      // FIX-Round1-T13: throw on any opts key not in the allowlist — catches
      // typos like { scema: ... } that previously slipped through the
      // [key:string]: unknown index signature.
      const KNOWN_AGENT_OPTS = ['label', 'phase', 'schema', 'model', 'isolation', 'agentType', 'stallMs'];
      globalThis.agent = vmAsync(function (prompt, agentOpts) {
        agentOpts = agentOpts || {};
        const keys = Object.keys(agentOpts);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (KNOWN_AGENT_OPTS.indexOf(k) === -1) {
            throw new Error(
              "agent({" + k + "}): unknown option. " +
              "Known options are: " + KNOWN_AGENT_OPTS.join(', ') + "."
            );
          }
        }
        // P3: schema + model + agentType + isolation are all wired through
        // createProductionDispatch → SubagentManager.createAgentHeadless.
        // The dispatch surfaces descriptive errors for "agent type not found",
        // "isolation:'remote' is not available in this build", parent-dirty
        // refuse, worktree creation failures, and StructuredOutput contract
        // violations ("completed without calling StructuredOutput after 2
        // in-conversation nudges").
        if (
          agentOpts.isolation !== undefined &&
          agentOpts.isolation !== 'worktree' &&
          agentOpts.isolation !== 'remote'
        ) {
          throw new Error(
            "agent({isolation: '" + agentOpts.isolation + "'}): unknown isolation mode. " +
            "Known modes are: 'worktree', 'remote'."
          );
        }
        if (typeof agentOpts.phase === 'string' && agentOpts.phase.length > 0) {
          if (__b.lastPhase() !== agentOpts.phase) {
            __b.pushPhase(agentOpts.phase);
          }
        }
        // SECURITY (P3 R2 self-review): user-script-controlled agentOpts
        // cross the vm/host boundary verbatim via vmAsync's hostFn.apply.
        // A Proxy / inherited-getter / non-plain object in agentOpts.schema
        // would let host-side code (SyntheticOutputTool constructor + AJV
        // compile) trigger user-controlled trap handlers that execute with
        // the host realm's full surface. Revive agentOpts through JSON
        // round-trip BEFORE crossing so the host only ever sees vm-realm
        // plain objects with vm-realm prototypes. Same mechanism that
        // makes args + parallel/pipeline results safe.
        var safeOpts;
        try {
          safeOpts = JSON.parse(JSON.stringify(agentOpts));
        } catch (e) {
          throw new Error(
            "agent() opts contain a non-JSON-serializable value: " +
            String(e && e.message != null ? e.message : e)
          );
        }
        // SECURITY (PR #4947 R1 wenshao, extended for P3): vmAsync's resolve
        // path is verbatim (no re-wrap of resolved values). Host-realm
        // strings cross the boundary harmlessly because primitives have no
        // prototype identity. But P3's schema-mode dispatch returns the
        // validated structured_output args as a host-realm OBJECT --
        // handing that to the script reopens the T1/T8/T14 escape:
        // result.constructor.constructor("return process")() would walk
        // the host Object.prototype chain to the host Function
        // constructor. Per-call JSON revival inside this vm runInContext
        // block makes the returned object carry vm-realm prototypes (same
        // mechanism as parallel/pipeline reviveInRealm and the args
        // global revival). The fallback to null on a non-serializable
        // resolve mirrors the errors-as-data convention parallel/pipeline
        // already use for individual slot failures.
        // R3 review (wenshao T3 [Suggestion]): the null fallback below is
        // a SECURITY backstop, not a contract path. In schema mode the
        // host return is the validated args of a structured_output tool
        // call -- LLM tool_call payloads are always JSON-serializable
        // (the model sends them through the OpenAI tool-call protocol
        // which serializes through JSON itself) and SyntheticOutputTool's
        // AJV validation runs over the parsed JSON, so a non-serializable
        // host return is unreachable in production schema mode. The
        // sentinel preserves the errors-as-data convention parallel /
        // pipeline already use for individual slot failures, and stays as
        // residual defense for any future dispatch path whose return
        // value isn't a tool_call payload. logRevivalFailure surfaces
        // the actionable detail (slot 0 + the error string) to operators
        // so a real trigger in production isn't silent.
        return __b.hostAgent(prompt, safeOpts).then(function (value) {
          if (value === null || typeof value !== 'object') {
            return value;
          }
          try {
            return JSON.parse(JSON.stringify(value));
          } catch (e) {
            __b.logRevivalFailure(0, String(e && e.message != null ? e.message : e));
            return null;
          }
        });
      });

      // --- parallel / pipeline ---
      // SECURITY (PR #4732 P2): the host impl resolves with a HOST-realm array.
      // vmAsync's resolve path is verbatim (it does NOT re-wrap resolved
      // values), so handing that host array to the script would reopen the
      // T1/T8/T14 escape: result.constructor.constructor('return process')()
      // walks the host Array.prototype chain to the host Function constructor.
      // We revive the array INSIDE the vm realm with JSON.parse(JSON.stringify)
      // -- the same mechanism that makes the args global safe (see the args
      // revival above) -- so the value the script sees has vm-realm prototypes
      // whose constructors can't reach host process. Agent results are JSON
      // strings (and null slots), so the round-trip is lossless for P2.
      //
      // EAD-1 (P2 self-review): revive PER-ELEMENT, not the whole array in one
      // JSON.stringify. A single slot whose VALUE is non-serializable (a thunk
      // that returns a BigInt or a circular object) must become null at its
      // index -- it must NOT throw on the whole array and destroy every sibling
      // result, which would defeat errors-as-data for return values. The outer
      // [] is built in-realm here, so the result keeps vm-realm prototypes.
      //
      // SECURITY (PR #4947 R1 wenshao): reviveInRealm MUST remain inside this
      // vm init runInContext block. JSON, Array, Object here are vm-realm
      // globals; extracting this function to a host-side utility (e.g. a
      // shared utils/jsonRevive.ts) would resolve those references against
      // the HOST realm, silently reopening the T1/T8/T14 escape that the
      // revival is designed to prevent. The textual identity to a host-side
      // util is exactly the trap.
      function reviveInRealm(hostArr) {
        const out = [];
        for (let i = 0; i < hostArr.length; i++) {
          try {
            out[i] = JSON.parse(JSON.stringify(hostArr[i]));
          } catch (e) {
            // Cross to host realm for debug logging. The bridge function
            // accepts only primitive strings/numbers; the error message is
            // coerced to a String here so no vm-realm Error object crosses.
            __b.logRevivalFailure(i, String(e?.message ?? e));
            out[i] = null;
          }
        }
        return out;
      }
      if (__b.hasParallel) {
        const callParallel = vmAsync(function (thunks) {
          return __b.hostParallel(thunks);
        });
        globalThis.parallel = function parallel(thunks) {
          return callParallel(thunks).then(reviveInRealm);
        };
      } else {
        globalThis.parallel = function parallel() {
          return new Promise(function (_, reject) {
            reject(new Error(
              'parallel() is unavailable: this sandbox was created without a ' +
              'parallel implementation. The orchestrator injects one; a bare ' +
              'sandbox has no concurrent-dispatch capability.'
            ));
          });
        };
      }
      if (__b.hasPipeline) {
        const callPipeline = vmAsync(function (items) {
          const stages = [];
          for (let i = 1; i < arguments.length; i++) stages.push(arguments[i]);
          return __b.hostPipeline.apply(null, [items].concat(stages));
        });
        globalThis.pipeline = function pipeline() {
          return callPipeline.apply(null, arguments).then(reviveInRealm);
        };
      } else {
        globalThis.pipeline = function pipeline() {
          return new Promise(function (_, reject) {
            reject(new Error(
              'pipeline() is unavailable: this sandbox was created without a ' +
              'pipeline implementation. The orchestrator injects one; a bare ' +
              'sandbox has no staggered multi-stage capability.'
            ));
          });
        };
      }
      // --- workflow (nested, single-level) ---
      // Mirrors agent(): args cross vm→host verbatim (safe direction), the
      // single result is revived back into the vm realm via JSON round-trip
      // (same T1/T8/T14 escape defense as agent / parallel / pipeline). The
      // host impl resolves a saved workflow and runs it sharing this run's
      // agent-count cap + token budget. When __b.hasWorkflow is false, the
      // sandbox is either bare (no resolver wired) OR is itself a nested
      // workflow — in both cases workflow() must throw, which is how the
      // single-level nesting limit is enforced (a nested sandbox is created
      // without a workflow impl, so its workflow() lands in the else branch).
      if (__b.hasWorkflow) {
        const callWorkflow = vmAsync(function (nameOrRef, wfArgs) {
          // Sanitize args through a JSON round-trip BEFORE crossing so the
          // host only ever sees vm-realm plain objects (same defense as
          // agent()'s safeOpts). nameOrRef may be a string or {scriptPath}.
          var safeRef;
          var safeArgs;
          try {
            safeRef = nameOrRef === undefined
              ? undefined
              : JSON.parse(JSON.stringify(nameOrRef));
            safeArgs = wfArgs === undefined
              ? undefined
              : JSON.parse(JSON.stringify(wfArgs));
          } catch (e) {
            throw new Error(
              'workflow() received a non-JSON-serializable argument: ' +
              String(e && e.message != null ? e.message : e)
            );
          }
          return __b.hostWorkflow(safeRef, safeArgs).then(function (value) {
            if (value === null || typeof value !== 'object') {
              return value;
            }
            try {
              return JSON.parse(JSON.stringify(value));
            } catch (e) {
              __b.logRevivalFailure(0, String(e && e.message != null ? e.message : e));
              return null;
            }
          });
        });
        globalThis.workflow = function workflow(nameOrRef, wfArgs) {
          return callWorkflow(nameOrRef, wfArgs);
        };
      } else {
        globalThis.workflow = function workflow() {
          return new Promise(function (_, reject) {
            reject(new Error(
              "workflow() is unavailable here. Either this sandbox was created " +
              "without a saved-workflow resolver, or this script is already " +
              "running as a nested workflow — workflow() nesting is limited to " +
              "a single level (a workflow cannot call another workflow that " +
              "itself calls workflow())."
            ));
          });
        };
      }

      // --- budget ---
      const safeBudget = Object.create(null);
      Object.defineProperty(safeBudget, 'total', {
        value: __b.budgetTotal,
        writable: false, configurable: false,
      });
      if (__b.hasBudget) {
        Object.defineProperty(safeBudget, 'spent', {
          value: function spent() { return __b.hostBudgetSpent(); },
          writable: false, configurable: false,
        });
        Object.defineProperty(safeBudget, 'remaining', {
          value: function remaining() { return __b.hostBudgetRemaining(); },
          writable: false, configurable: false,
        });
      } else {
        Object.defineProperty(safeBudget, 'spent', {
          value: function spent() {
            throw new Error(
              'budget.spent() is not supported in P1. Token tracking is scheduled for P5.'
            );
          },
          writable: false, configurable: false,
        });
        Object.defineProperty(safeBudget, 'remaining', {
          value: function remaining() {
            throw new Error(
              'budget.remaining() is not supported in P1. Token tracking is scheduled for P5.'
            );
          },
          writable: false, configurable: false,
        });
      }
      globalThis.budget = safeBudget;
    })();`,
    ctx,
    { filename: 'workflow-sandbox-init.js' },
  );

  const maxWallClockMs = resolveMaxWallClockMs(opts);

  let extractedMeta: WorkflowMeta | null = null;
  return {
    async run(scriptSource: string): Promise<unknown> {
      // P4: extract `export const meta = {...}` once before the body runs.
      // The stripped source is what the vm executes; the meta object is
      // surfaced via `getMeta()` after the run (or after a malformed-meta
      // throw, in which case the caller's catch block sees a clear error).
      const { stripped, meta } = extractAndStripMeta(scriptSource);
      extractedMeta = meta;
      const wrapped = `(async () => {\n${stripped}\n})()`;
      const script = new vm.Script(wrapped, {
        filename: 'workflow.js',
      });
      // 30s sync wall-clock cap inside vm — covers `while(true){}` style
      // synchronous loops only. Once the IIFE hits its first `await`,
      // `runInContext` returns and this timer is disarmed.
      const runOpts: vm.RunningScriptOptions = {
        timeout: 30_000,
      };
      const result = script.runInContext(ctx, runOpts) as Promise<unknown>;

      // T23 (PR #4732 R2): async wall-clock cap covers everything past the
      // first await — `return new Promise(() => {})`, async infinite loops,
      // hung network calls — none of which the vm timeout or future P5
      // budget can stop (a 0-token hang spends no budget). Permanent
      // defense-in-depth; default 30 min, env-tunable.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // T40 (PR #4732 R4): abort linked controller BEFORE rejecting so
          // in-flight subagents see the cancellation and stop. Order
          // matters: rejecting first then aborting would race the
          // caller's finally block.
          opts.abortOnTimeout?.abort();
          reject(
            new Error(
              `Workflow execution timed out after ${maxWallClockMs} ms wall clock. ` +
                'Override via SandboxOptions.maxWallClockMs or QWEN_CODE_MAX_WORKFLOW_SECONDS env var.',
            ),
          );
        }, maxWallClockMs);
        // Don't keep the event loop alive on Node — if the run resolves
        // quickly, the timer will be cleared in finally; this guards against
        // edge cases where the caller drops the promise.
        timer.unref?.();
      });
      try {
        return await Promise.race([result, timeoutPromise]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    getPhases: () => [...phases],
    getLogs: () => [...logs],
    getMeta: () => extractedMeta,
  };
}
