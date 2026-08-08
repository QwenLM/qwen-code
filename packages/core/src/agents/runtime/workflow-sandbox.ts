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
import type { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';

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
   * The owning run's id. Stamped onto every dispatch rejection that
   * crosses the vm boundary so the adoption-escape hook (see `run()`)
   * attributes a process-level unhandledRejection to THIS run when
   * multiple runs share one process (background runs). Omitted by
   * bare-sandbox tests.
   */
  runId?: string;
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
  /**
   * The run's dispatch scheduler. When provided, the async wall-clock
   * watchdog suspends only while the scheduler is `paused`: by then no
   * dispatch is in flight or being issued, so paused time must neither
   * burn wall-clock budget nor let the timer kill the run mid-pause
   * (resume would then be impossible). During `pausing` the backstop
   * stays armed because an in-flight dispatch is typically still
   * executing real work. Known limitation: an in-flight dispatch parked
   * on a tool approval waits on the user rather than executing, but
   * `pausing` time still burns wall-clock budget until the approval is
   * answered (the watchdog cannot suspend on `pausing` without losing
   * the backstop for genuinely executing dispatches, and `resume()`
   * only works from `paused`).
   *
   * The guarantee covers dispatch-gated code only: script awaits outside
   * a scheduler gate keep executing while paused and are not covered by
   * the wall-clock backstop until resume.
   */
  scheduler?: WorkflowDispatchScheduler;
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

/**
 * Async wall-clock watchdog whose budget only accrues while armed.
 * `pause()` clears the timer and banks the unconsumed remainder;
 * `resume()` re-arms with that remainder — so pause/resume cycles
 * neither extend the total active-time budget nor lose any of it.
 */
class WallClockWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remainingMs: number;
  private armedAt = 0;
  private paused = false;
  private stopped = false;

  constructor(
    budgetMs: number,
    private readonly onFire: () => void,
  ) {
    this.remainingMs = budgetMs;
    this.arm();
  }

  pause(): void {
    if (this.stopped || this.paused || this.timer === undefined) return;
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    // The deadline is a setTimeout (libuv's monotonic loop clock), so the
    // elapsed-armed-time deduction must measure with the monotonic clock
    // too: Date.now() diverges on system suspend and any NTP / manual
    // clock step, corrupting the banked remainder in both directions.
    this.remainingMs = Math.max(
      0,
      this.remainingMs - (performance.now() - this.armedAt),
    );
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.armedAt = performance.now();
    this.timer = setTimeout(() => {
      this.stopped = true;
      this.timer = undefined;
      this.onFire();
    }, this.remainingMs);
    // Don't keep the event loop alive on Node — if the run resolves
    // quickly, the timer will be stopped in finally; this guards against
    // edge cases where the caller drops the promise.
    this.timer.unref?.();
  }
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
   * Append a log line produced by a nested workflow run. Nested logs
   * reach no production surface on their own (the nested sandbox's
   * buffer is never read by the orchestrator), so the orchestrator
   * merges them into the parent run's logs at nested settlement —
   * including the nested unconsumed-rejection mirror lines.
   */
  appendLog(line: string): void;
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

  // Unconsumed-rejection mirror bookkeeping (see `observeDispatch` in the
  // init script below). The verdict is deferred to run settlement: an entry
  // recorded at rejection-settlement time is cleared if the script still
  // consumes the promise afterwards (a delayed `await` / `.catch`), and
  // only still-uncleared entries are flushed into the run log in `run()`'s
  // `finally`. A rejection whose root the script attached a rejection
  // handler to anywhere in the chain is never mirrored — the script had a
  // chance to surface it itself. Keys are opaque ids; the bridge contract
  // only allows primitives across, so the vm side passes ids and strings.
  //
  // All four are reset at the top of `run()`: the bookkeeping is per-run,
  // and latching it for the sandbox's lifetime would let a second `run()`
  // on the same sandbox bypass the deferred-verdict design entirely (every
  // rejection would take the post-settlement immediate-mirror path).
  // Per-root mirror state. rejectionHandled: the script attached a
  // visible rejection handler — the strongest "never mirror" marker.
  // adoptedOut: a native adoption attach (await / Promise.resolve / a
  // returned thenable) consumed the root; the rejection's fate then
  // rides the (unobserved) adopting promise, so the flush defers
  // forwarded sibling entries to the adopting chain — handled there
  // they need no signal, forgotten there the escape hook provides one.
  const unconsumedRoots = new Map<
    number,
    { rejectionHandled: boolean; adoptedOut: boolean }
  >();
  interface UnconsumedRejectionEntry {
    rootId: number;
    isRoot: boolean;
    dispatchFailed: boolean;
    msg: string;
  }
  const unconsumedRejections = new Map<number, UnconsumedRejectionEntry>();
  let nextUnconsumedId = 1;
  let unconsumedSettled = false;
  // Per-run dedupe keys (rootId + msg) shared by the flush and the
  // adoption-escape hook in run(): one failed dispatch fanned out into
  // N unconsumed branches is one failure and must surface as exactly
  // one log line, whichever surface reports it first (R11-11).
  let mirroredEscapeKeys = new Set<string>();

  // Precise attribution: 'dispatch failed' only when the root dispatch
  // itself rejected (marked at the vm boundary), '(result not consumed)'
  // only when the root was never attached to.
  const unconsumedRejectionLine = (rec: UnconsumedRejectionEntry): string => {
    if (rec.dispatchFailed) {
      return rec.isRoot
        ? 'dispatch failed (result not consumed): ' + rec.msg
        : 'dispatch failed (rejection not handled): ' + rec.msg;
    }
    // The root WAS attached to in every shape that reaches this branch
    // (a derived node exists only because the root was attached), so
    // '(result not consumed)' contradicts the attribution contract —
    // '(rejection not handled)' matches the sibling non-root branch.
    return 'script handler failed (rejection not handled): ' + rec.msg;
  };

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
    // --- Unconsumed-rejection mirror bookkeeping ---
    wfRegisterRoot: (): number => {
      const id = nextUnconsumedId++;
      unconsumedRoots.set(id, { rejectionHandled: false, adoptedOut: false });
      return id;
    },
    wfMarkRejectionHandled: (rootId: number): void => {
      const root = unconsumedRoots.get(rootId);
      if (root) root.rejectionHandled = true;
    },
    wfIsRootHandled: (rootId: number): boolean =>
      unconsumedRoots.get(rootId)?.rejectionHandled === true,
    wfMarkAdopted: (rootId: number): void => {
      const root = unconsumedRoots.get(rootId);
      if (root) root.adoptedOut = true;
    },
    runId: opts.runId ?? '',
    wfReportUnconsumed: (
      rootId: number,
      isRoot: boolean,
      dispatchFailed: boolean,
      msg: string,
    ): number => {
      if (unconsumedSettled) {
        // Post-settlement rejection: the script can no longer consume it
        // (the run's finally already flushed), so mirror it immediately.
        const rec: UnconsumedRejectionEntry = {
          rootId,
          isRoot,
          dispatchFailed,
          msg,
        };
        const rootState = unconsumedRoots.get(rootId);
        if (
          !rootState?.rejectionHandled &&
          !(dispatchFailed && rootState?.adoptedOut)
        ) {
          safeLog(unconsumedRejectionLine(rec));
        }
        return 0;
      }
      const id = nextUnconsumedId++;
      unconsumedRejections.set(id, { rootId, isRoot, dispatchFailed, msg });
      return id;
    },
    wfClearUnconsumed: (id: number): void => {
      unconsumedRejections.delete(id);
    },
    // R10-1: teardown discrimination cannot key on the error name alone.
    // The dominant in-flight cancellation path (controller.abort() →
    // subagent returns terminateMode=CANCELLED → runSingleDispatch throws
    // a PLAIN Error) never produces an 'AbortError', so the mirror would
    // log a spurious dispatch failure for a correctly-cancelled run. Once
    // the run's abort signal has fired, the run is already settling as
    // cancelled / timed-out — every rejection still crossing the boundary
    // is teardown noise regardless of its shape.
    isRunAborted: (): boolean => opts.abortOnTimeout?.signal.aborted === true,
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
      // Dispatch promises are ObservedPromise instances (a vm-realm
      // Promise subclass). Its then override marks the result consumed
      // and re-attaches the teardown observer to the derived promise, so
      // script-derived chains (agent(...).then(...), await, and the
      // ELEMENTS of static-combinator aggregates — everything that
      // funnels through then) stay observed at every depth. The
      // AGGREGATES of Promise.all/race/any are built by the native
      // statics and never pass through the observed then, so those
      // statics are wrapped explicitly below (observeAggregate).
      // Without this, a correctly-cancelled run holding a pending derived
      // chain fired a process-level unhandledRejection even though the
      // bare dispatch promise was observed.
      //
      // Unconsumed rejections of an observed node are recorded through
      // the bridge and mirrored into the run log at run settlement (a
      // later consumption clears the record first) — a dispatch refused
      // at the entry gate (budget / agent cap) or failing mid-run reaches
      // no other surface, so without the mirror the failure leaves no
      // log, alarm, or telemetry.
      function mapDispatchError(hostErr) {
        var msg;
        try {
          msg = (hostErr && hostErr.message != null)
            ? String(hostErr.message)
            : String(hostErr);
        } catch (e) {
          msg = '[unserializable rejection value]';
        }
        const vmErr = new Error(msg);
        // Teardown discrimination at the host boundary — before the error
        // is flattened into a vm-realm Error. Two shapes count as
        // teardown: an error NAMED 'AbortError' (the scheduler's
        // abortError() DOMException), and ANY rejection that crosses
        // after the run's abort signal has fired — the dominant
        // cancellation path rejects with a plain Error ('did not complete
        // (terminate mode: CANCELLED).'), which a name-only match would
        // mirror as a spurious dispatch failure on a correctly-cancelled
        // run. Matching the name here (rather than the message text)
        // still suppresses teardown noise without swallowing genuine
        // failures whose message merely contains 'aborted' (e.g. a
        // network-layer 'connection aborted by peer').
        var isAbort = false;
        try {
          isAbort = !!(hostErr && hostErr.name === 'AbortError');
        } catch (e) {
          isAbort = false;
        }
        if (isAbort || __b.isRunAborted()) vmErr.__wfAbort = true;
        vmErr.__wfDispatchFailed = true;
        return vmErr;
      }
      function readFlag(value, name) {
        try {
          return !!(value && value[name]);
        } catch (e) {
          return false;
        }
      }
      function observeDispatch(promise) {
        // Direct native-then call: routing through ObservedPromise.then
        // would mark the promise consumed and recurse the observer. The
        // observer body must be exception-safe on ANY rejection value:
        // a script handler can throw an exotic value (a message getter
        // that throws, a Proxy with throwing traps), and an observer
        // killed mid-body would turn the very rejection it watches into
        // a process-level unhandledRejection — the exact failure class
        // the observer exists to remove.
        Promise.prototype.then.call(promise, undefined, function (err) {
          if (promise.__wfConsumed) return;
          // R11-30: also suppress on the run-level abort state, not just
          // the rejection's own marker — a wrapped Promise.any aggregate
          // rejects with a natively built AggregateError that carries
          // neither marker, so teardown rejections of a correctly-
          // cancelled run would still be mirrored when it is unconsumed.
          if (readFlag(err, '__wfAbort') || __b.isRunAborted()) return;
          var dispatchFailed = readFlag(err, '__wfDispatchFailed');
          var errors = null;
          try {
            if (err && Array.isArray(err.errors)) errors = err.errors;
          } catch (e) {
            errors = null;
          }
          if (!dispatchFailed && errors) {
            // R11-4: Promise.any rejects with a fresh vm-realm
            // AggregateError carrying no flags; the element errors are
            // reachable on .errors with their markers preserved. Derive
            // the attribution from the causes instead of blaming the
            // script for a dispatch failure.
            for (var i = 0; i < errors.length; i++) {
              if (readFlag(errors[i], '__wfDispatchFailed')) {
                dispatchFailed = true;
                break;
              }
            }
          }
          // R11-15: cross-root suppression — aggregate roots track
          // rejectionHandled independently of their elements' roots, so
          // a forwarded dispatch failure whose originating element root
          // the script already handled must not mirror from the
          // aggregate. The element rootId is stamped in vmAsync;
          // Promise.all/race forward the element's own reason,
          // Promise.any surfaces them on .errors.
          try {
            var sourceIds = [];
            if (err && err.__wfRootId) {
              sourceIds.push(err.__wfRootId);
            } else if (errors) {
              for (var j = 0; j < errors.length; j++) {
                if (errors[j] && errors[j].__wfRootId) {
                  sourceIds.push(errors[j].__wfRootId);
                }
              }
            }
            for (var k = 0; k < sourceIds.length; k++) {
              if (
                sourceIds[k] !== promise.__wfRootId &&
                __b.wfIsRootHandled(sourceIds[k])
              ) {
                return;
              }
            }
          } catch (e) {
            // A throwing exotic value must not kill the observer; fall
            // through and mirror conservatively.
          }
          var msg;
          try {
            msg = String(err && err.message != null ? err.message : err);
          } catch (e) {
            msg = '[unserializable rejection value]';
          }
          promise.__wfUnconsumedId = __b.wfReportUnconsumed(
            promise.__wfRootId,
            promise.__wfIsRoot === true,
            dispatchFailed,
            msg,
          );
        });
      }
      // R11-3: await / Promise.resolve / returning a thenable from a
      // handler adopts an ObservedPromise through this then with the
      // adopting promise's capability (resolve, reject) pair — native
      // functions, indistinguishable from real handlers by arity. They
      // are detected by the native toString signature. Adoption
      // CONSUMES the result (a delayed adoption clears a recorded
      // verdict exactly like a delayed await) but is NOT a rejection
      // handler: the rejection transfers into the adopting promise —
      // typically an async wrapper's implicit promise, which is a plain
      // vm-realm Promise the mirror cannot observe. Marking adoption as
      // handling would silently disarm the mirror for the forgotten-
      // await failure class; the run-level escape hook in the host
      // surfaces those escapes instead. Bound script functions also
      // stringify as native code; misreading one as adoption only
      // forgoes the rejectionHandled marking, never native semantics.
      function isAdoptionAttach(handler) {
        try {
          return (
            typeof handler === 'function' &&
            Function.prototype.toString
              .call(handler)
              .indexOf('[native code]') !== -1
          );
        } catch (e) {
          return false;
        }
      }
      class ObservedPromise extends Promise {
        then(onFulfilled, onRejected) {
          // R11-26: introspect the handler BEFORE any state mutation.
          // The read is guarded because a script-supplied handler can
          // be exotic (a revoked Proxy wrapping a function, a throwing
          // accessor) — an unguarded read made .then() throw
          // synchronously, something native then never does, leaving
          // the promise marked consumed with no handler attached.
          var rethrows = false;
          try {
            rethrows = !!(onRejected && onRejected.__wfRethrows);
          } catch (e) {
            rethrows = false;
          }
          this.__wfConsumed = true;
          // An attached rejection handler means the script can surface the
          // root rejection itself; the mirror stays silent for it. The
          // finally override below routes through this then with marked
          // rethrow combinators — those re-raise the rejection instead of
          // handling it, so they must NOT set the flag (marking them
          // handled would silently drop a fire-and-forget
          // agent(...).finally(...) failure). Adoption attaches count
          // as consumption only, never handling (see isAdoptionAttach):
          // they mark adoptedOut so forwarded sibling entries defer to
          // the adopting chain / escape hook instead of mirroring.
          if (isAdoptionAttach(onRejected)) {
            __b.wfMarkAdopted(this.__wfRootId);
          } else if (typeof onRejected === 'function' && !rethrows) {
            __b.wfMarkRejectionHandled(this.__wfRootId);
          }
          // A delayed consumption clears a verdict recorded at
          // rejection-settlement time, so a late-but-real await is not
          // misreported as unconsumed.
          if (this.__wfUnconsumedId !== undefined) {
            __b.wfClearUnconsumed(this.__wfUnconsumedId);
            this.__wfUnconsumedId = undefined;
          }
          const derived = super.then(onFulfilled, onRejected);
          derived.__wfRootId = this.__wfRootId;
          observeDispatch(derived);
          return derived;
        }
        finally(onFinally) {
          // Native Promise.prototype.finally calls the observed then with
          // two function combinators, indistinguishable there from a real
          // then(f, g) — which would mark the root rejection handled even
          // though finally rethrows it. Implement finally through the
          // observed then with an explicitly-marked rethrow combinator so
          // the mirror stays armed for finally-only chains.
          if (typeof onFinally !== 'function') {
            return this.then(undefined, undefined);
          }
          const onRethrow = function (err) {
            return Promise.resolve(onFinally()).then(function () {
              throw err;
            });
          };
          onRethrow.__wfRethrows = true;
          return this.then(
            function (value) {
              return Promise.resolve(onFinally()).then(function () {
                return value;
              });
            },
            onRethrow,
          );
        }
      }
      // --- Static combinators: observe the aggregate promise ---
      // Promise.all/race/any build their aggregate via the native static;
      // it never passes through the observed then, so a fire-and-forget
      // aggregate holding a failed dispatch would escape the run-log
      // mirror. While the run is live the host's adoption-escape hook
      // (R11-3) still catches and mirrors the process-level
      // unhandledRejection — a round-14 A/B confirmed that hook, not
      // this wrap, is the live-run backstop — but only with the coarse
      // '(rejection not handled)' wording, and once the run's hook is
      // detached nothing in the sandbox catches the escape. R14-A:
      // wrapping the statics gives each aggregate its own observer, so
      // consumption tracking works through the aggregate's own observed
      // then (await / .catch / .then marks it handled) and the mirror
      // itself classifies the rejection; the elements still funnel
      // through the then override via the native static's internal
      // attach, so they stay marked consumed.
      function observeAggregate(nativeAggregate) {
        const rootId = __b.wfRegisterRoot();
        const observed = new ObservedPromise(function (resolve, reject) {
          Promise.prototype.then.call(nativeAggregate, resolve, reject);
        });
        observed.__wfRootId = rootId;
        observed.__wfIsRoot = true;
        observeDispatch(observed);
        return observed;
      }
      const nativePromiseAll = Promise.all;
      const nativePromiseRace = Promise.race;
      const nativePromiseAny = Promise.any;
      // R11-16: a static called on a script-defined Promise subclass
      // must honor the species contract and return a subclass instance,
      // so non-default receivers bypass observation (their elements
      // still funnel through the observed then, and a fire-and-forget
      // dispatch failure escaping such an aggregate is still caught by
      // the host's adoption-escape hook via its stamped markers).
      Promise.all = function (items) {
        if (this !== Promise) return nativePromiseAll.call(this, items);
        return observeAggregate(nativePromiseAll.call(this, items));
      };
      Promise.race = function (items) {
        if (this !== Promise) return nativePromiseRace.call(this, items);
        return observeAggregate(nativePromiseRace.call(this, items));
      };
      Promise.any = function (items) {
        if (this !== Promise) return nativePromiseAny.call(this, items);
        return observeAggregate(nativePromiseAny.call(this, items));
      };
      function vmAsync(hostFn) {
        return function (...vmArgs) {
          const rootId = __b.wfRegisterRoot();
          const p = new ObservedPromise(function (resolve, reject) {
            function rejectMapped(hostErr) {
              const vmErr = mapDispatchError(hostErr);
              // Stamp the originating root and run BEFORE the error can
              // be forwarded into aggregate promises: the observer's
              // cross-root suppression (R11-15) reads __wfRootId and
              // the host's adoption-escape hook (R11-3) attributes by
              // __wfRunId.
              try {
                vmErr.__wfRootId = rootId;
                vmErr.__wfRunId = __b.runId;
              } catch (e) {}
              reject(vmErr);
            }
            try {
              const hostPromise = hostFn.apply(null, vmArgs);
              hostPromise.then(
                function (value) { resolve(value); },
                rejectMapped
              );
            } catch (hostErr) {
              rejectMapped(hostErr);
            }
          });
          p.__wfRootId = rootId;
          p.__wfIsRoot = true;
          observeDispatch(p);
          return p;
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

  // Flush still-unconsumed rejection entries into the run log. Called from
  // `run()`'s finally: the one-macrotask yield lets rejection observers
  // queued behind the script's settlement microtasks land before the
  // verdict. When no dispatch root was ever registered the yield is skipped
  // — dispatch-free runs keep their settlement free of timer dependencies
  // (load-bearing for fake-timer tests of the wall-clock backstop).
  const flushUnconsumedRejections = async (): Promise<void> => {
    unconsumedSettled = true;
    if (nextUnconsumedId === 1) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    for (const rec of unconsumedRejections.values()) {
      // Contract: a rejection whose root the script attached a
      // rejection handler to anywhere in the chain is never mirrored —
      // regardless of attribution (R11-14). A forwarded dispatch
      // rejection whose root was adopted out defers to the adopting
      // chain too (see unconsumedRoots): handled there it needs no
      // signal, forgotten there the escape hook provides it, deduped
      // by the shared key below.
      const rootState = unconsumedRoots.get(rec.rootId);
      if (rootState?.rejectionHandled) {
        continue;
      }
      if (rec.dispatchFailed && rootState?.adoptedOut) {
        continue;
      }
      const key = rec.rootId + '\u0000' + rec.msg;
      if (mirroredEscapeKeys.has(key)) continue;
      mirroredEscapeKeys.add(key);
      safeLog(unconsumedRejectionLine(rec));
    }
    // Clear after flushing so a subsequent flush (a reused sandbox's next
    // run) does not re-log entries this run already reported.
    unconsumedRejections.clear();
  };

  // R11-3: adoption (await / Promise.resolve / returning a thenable
  // from a handler) forwards a root rejection into the adopting
  // promise — typically an async wrapper's implicit promise, a plain
  // vm-realm Promise the mirror cannot observe. When the script never
  // handles that promise, Node fires a process-level
  // 'unhandledRejection' carrying the marked vm-realm error; this hook
  // mirrors those escapes into the run log while the run is live, so a
  // forgotten dispatch failure no longer loses its only log / alarm /
  // telemetry surface. Roots whose rejection the script handled stay
  // silent here too (the contract keys on the root, same as the flush).
  // The hook is installed per run() and matches only this run's stamped
  // rejections, so concurrent runs don't log into each other. Known
  // limits: a rejection landing after this run's flush (a fire-and-
  // forget dispatch outliving the run) escapes as before, and the event
  // itself cannot be cancelled from inside the sandbox — a host with
  // its own unhandledRejection listener still observes it.
  const hookRunId = opts.runId ?? '';
  const adoptionEscapeHook = (
    reason: unknown,
    _promise: Promise<unknown>,
  ): void => {
    try {
      if (!reason || typeof reason !== 'object') return;
      const marked = reason as {
        __wfDispatchFailed?: unknown;
        __wfRunId?: unknown;
        __wfRootId?: unknown;
        message?: unknown;
      };
      if (marked.__wfDispatchFailed !== true) return;
      if (String(marked.__wfRunId ?? '') !== hookRunId) return;
      const rootId =
        typeof marked.__wfRootId === 'number' ? marked.__wfRootId : undefined;
      if (
        rootId !== undefined &&
        unconsumedRoots.get(rootId)?.rejectionHandled
      ) {
        return;
      }
      let msg: string;
      try {
        msg = marked.message != null ? String(marked.message) : String(reason);
      } catch {
        msg = '[unserializable rejection value]';
      }
      const key = String(rootId ?? '') + '\u0000' + msg;
      if (mirroredEscapeKeys.has(key)) return;
      mirroredEscapeKeys.add(key);
      safeLog('dispatch failed (rejection not handled): ' + msg);
    } catch (e) {
      debugLogger.warn('adoptionEscapeHook failed:', e);
    }
  };

  let extractedMeta: WorkflowMeta | null = null;
  return {
    async run(scriptSource: string): Promise<unknown> {
      // R10-7: the unconsumed-rejection bookkeeping is per-run. Reset it
      // here (not just in flush) so a second run() on the same sandbox
      // starts from the same clean slate as a fresh sandbox — otherwise
      // the first run's flush latches unconsumedSettled for the sandbox's
      // lifetime and every later rejection takes the immediate-mirror
      // path, bypassing the deferred verdict.
      unconsumedSettled = false;
      unconsumedRoots.clear();
      unconsumedRejections.clear();
      nextUnconsumedId = 1;
      mirroredEscapeKeys = new Set();

      let watchdog: WallClockWatchdog | undefined;
      let stopWatchingState: (() => void) | undefined;
      let rearmWatchdogOnAbort: (() => void) | undefined;
      process.on('unhandledRejection', adoptionEscapeHook);
      try {
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
        const timeoutPromise = new Promise<never>((_, reject) => {
          watchdog = new WallClockWatchdog(maxWallClockMs, () => {
            // T40 (PR #4732 R4): abort linked controller BEFORE rejecting so
            // in-flight subagents see the cancellation and stop. Order
            // matters: rejecting first then aborting would race the
            // caller's finally block.
            opts.abortOnTimeout?.abort();
            reject(
              new Error(
                `Workflow execution exceeded ${maxWallClockMs} ms of active time (paused time is not counted). ` +
                  'Override via SandboxOptions.maxWallClockMs or QWEN_CODE_MAX_WORKFLOW_SECONDS env var.',
              ),
            );
          });
        });
        // Pause-aware watchdog: suspend only while the scheduler is
        // `paused` — once truly idle, the run must neither burn budget it
        // will need after resume nor be killed mid-pause (resume would
        // then be impossible). During `pausing` the backstop stays armed:
        // an in-flight dispatch is typically still executing real work.
        // Known edge: an in-flight dispatch parked on a tool approval
        // waits on the user, not on real work, yet still burns budget
        // until it is answered — see the `scheduler` option docs.
        // Note the suspension assumes the script is idle while paused
        // (blocked at a dispatch gate); ungated script awaits still run
        // and are not covered by the backstop until resume. Once the run
        // is aborted the watchdog must stay armed: a draining in-flight
        // dispatch can still land a `pausing` → `paused` transition after
        // the abort, and re-suspending would orphan a hung script.
        const aborted = (): boolean =>
          opts.abortOnTimeout?.signal.aborted === true;
        stopWatchingState = opts.scheduler?.onStateChange(({ state }) => {
          if (state === 'paused' && !aborted()) watchdog?.pause();
          else watchdog?.resume();
        });
        // A nested sandbox created while the scheduler is ALREADY `paused`
        // never receives a `paused` transition (the subscription only sees
        // future transitions), so seed the current state — otherwise the
        // watchdog stays armed and kills the nested run mid-pause.
        if (opts.scheduler?.snapshot().state === 'paused' && !aborted()) {
          watchdog?.pause();
        }
        // Cancellation must settle the run even when the script hangs in
        // ungated code: `registry.cancel()` aborts this controller, but
        // `abortPending()` emits no state transition, so a pause-suspended
        // watchdog would never re-arm and the race below has no abort arm
        // — the hung run would never reach its settlement `finally`
        // (snapshot, telemetry, and handle release all skipped). Re-arm
        // with the banked remainder on abort to restore the bound.
        rearmWatchdogOnAbort = (): void => watchdog?.resume();
        opts.abortOnTimeout?.signal.addEventListener(
          'abort',
          rearmWatchdogOnAbort,
          { once: true },
        );
        return await Promise.race([result, timeoutPromise]);
      } finally {
        if (rearmWatchdogOnAbort) {
          opts.abortOnTimeout?.signal.removeEventListener(
            'abort',
            rearmWatchdogOnAbort,
          );
        }
        stopWatchingState?.();
        watchdog?.stop();
        // R11-10: the flush shares the finally that wraps the ENTIRE
        // run body, so a synchronous throw before the race — most
        // notably runInContext's 30s sync vm timeout, which precedes
        // it — still surfaces already-queued mirror entries instead of
        // discarding them with the per-run sandbox.
        await flushUnconsumedRejections();
        process.off('unhandledRejection', adoptionEscapeHook);
      }
    },
    getPhases: () => [...phases],
    getLogs: () => [...logs],
    appendLog: (line: string) => safeLog(line),
    getMeta: () => extractedMeta,
  };
}
