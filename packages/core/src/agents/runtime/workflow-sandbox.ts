/**
 * Strip a leading `export const meta = { ... }` declaration from a workflow
 * script. Required because Node's vm script mode rejects ES module syntax.
 *
 * P1 does not use meta semantically; it is removed so that Claude-Code-trained
 * models whose first line is `export const meta = {...}` do not produce a
 * SyntaxError at sandbox parse time.
 *
 * Matches only at the start of a (optionally whitespace-prefixed) line; a
 * naked `const meta = ...` later in the script is left intact. Single-quote,
 * double-quote, and template-literal contents inside the meta object are
 * treated opaquely (their `{` / `}` characters are not counted as braces).
 * Template-literal `${...}` substitutions that contain `{` or `}` are not
 * supported — model-authored `meta` should avoid them.
 */
export function stripExportMeta(source: string): string {
  const re = /^\s*export\s+const\s+meta\s*=\s*\{/m;
  const match = re.exec(source);
  if (!match) return source;
  const exportIdx = match.index;
  const startBrace = source.indexOf('{', exportIdx);
  let depth = 1;
  let i = startBrace + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i++; // skip escaped char
        i++;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
    i++;
  }
  // Skip trailing whitespace and an optional semicolon.
  while (i < source.length && /[\s;]/.test(source[i]!)) i++;
  return source.slice(0, exportIdx) + source.slice(i);
}

import * as vm from 'node:vm';

// FIX-9 (SEC-I2): cap the number of log lines to prevent unbounded memory use.
const MAX_LOG_LINES = 10_000;
// FIX-C5 (SEC-2-I1): cap phases entries similarly; large model-authored loops
// could otherwise push millions of phase titles and OOM the host.
const MAX_PHASE_ENTRIES = 10_000;

/**
 * WorkflowAgentOpts — structured options for the `agent()` global.
 *
 * FIX-4 (UP-C1): extending the options type from `{ label? }` to a
 * documented interface so that unsupported P1 fields produce a clean
 * runtime error rather than silent semantic drift.
 */
export interface WorkflowAgentOpts {
  label?: string;
  phase?: string;
  // The following are documented for future phases. P1 throws if any of them
  // is set — silently ignoring them would produce hard-to-debug semantic drift
  // (e.g. opts.schema set but no StructuredOutput → script gets a string and
  // crashes on .field access).
  schema?: object;
  model?: string;
  isolation?: 'worktree' | 'remote';
  agentType?: string;
  // Allow forward-compat extra keys without TS error; runtime throws on any
  // explicitly-named unsupported field above.
  [key: string]: unknown;
}

/**
 * Forward-compatibility alias for the agent dispatch return type.
 *
 * P1: always `string`. P3 will widen this to support StructuredOutput
 * (the schema-validated object path). Re-declared here so SandboxOptions
 * stays decoupled from `workflow-orchestrator.ts`; the orchestrator
 * re-exports the same alias for external consumers.
 */
export type WorkflowAgentResult = string;

export interface SandboxOptions {
  /** Value bound to the `args` global inside the script. */
  args: unknown;
  /**
   * Function called by the script's `agent(prompt, opts)` global. Returns the
   * agent's final text. Injected so tests can mock without spawning an LLM.
   *
   * FIX-4 (UP-C1): opts type widened to WorkflowAgentOpts.
   * FIX-E (Round 4 ARCH-I1): return type now uses `WorkflowAgentResult` so
   * P3's widening (to `string | { schema; value }`) propagates here
   * automatically.
   */
  dispatch: (
    prompt: string,
    opts: WorkflowAgentOpts,
  ) => Promise<WorkflowAgentResult>;
}

export interface WorkflowSandbox {
  /**
   * Execute the user-authored script source. The script is wrapped as an async
   * IIFE so it may use top-level `await` and `return`. Returns the script's
   * top-level return value.
   */
  run(scriptSource: string): Promise<unknown>;
  /** Phase titles announced by the script in order. */
  getPhases(): string[];
  /** Log lines emitted by the script in order. */
  getLogs(): string[];
}

/**
 * FIX-2 (SEC-C1): Recursively replace every plain-object prototype with null
 * so that `val.constructor` returns undefined in the vm context.
 *
 * Arrays are left as-is (their elements are recursed). Primitives and null
 * pass through. This is applied after the JSON roundtrip so the shape is
 * guaranteed to be JSON-safe (no cycles, no functions).
 */
const DEEP_NULL_PROTO_MAX_DEPTH = 64;

function deepNullProto(val: unknown, depth = 0): unknown {
  if (depth > DEEP_NULL_PROTO_MAX_DEPTH) {
    // FIX-E (Round 4 Important): explicit depth cap. Without this, an args
    // object with nesting depth ~5_000 throws a generic RangeError from the
    // host stack overflow — opaque to the caller.
    throw new Error(
      `WorkflowSandbox: args exceeded max nesting depth of ${DEEP_NULL_PROTO_MAX_DEPTH}`,
    );
  }
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    // FIX-E (Round 4 CRITICAL): sever the array's own prototype too.
    // Previously the array body kept Array.prototype, so `args.constructor`
    // was host `Array` and `args.constructor.constructor` was host
    // `Function` — a confirmed PoC read `process.env.HOME`.
    const out = val.map((x) => deepNullProto(x, depth + 1));
    Object.setPrototypeOf(out, null);
    return out;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = deepNullProto(v, depth + 1);
  }
  return out;
}

/**
 * FIX-3 (SEC-C1) + FIX-D (Round 3 SEC C1-C3): Sever the prototype chain of an
 * injected host-realm object so sandbox scripts cannot walk it back to the
 * host Function constructor.
 *
 * Round 2 added `.constructor = undefined`, which blocked the direct path
 * `fn.constructor.constructor`. Round 3 PoCs showed three remaining escapes:
 *   - `fn.toString.constructor` — toString inherited from host Function.prototype
 *   - `fn.__proto__.constructor` — direct prototype access
 *   - `Math.abs.constructor` — inherited Math methods are host functions
 *
 * Fix: also call `Object.setPrototypeOf(obj, null)`. This makes:
 *   - `obj.constructor` → undefined (per defineProperty above)
 *   - `obj.toString` → undefined (no Function.prototype inherited)
 *   - `obj.__proto__` → undefined (no Object.prototype inherited)
 *   - `obj.bind/.call/.apply` → undefined (severed Function.prototype)
 *
 * The function is still callable (its [[Call]] internal slot is unaffected).
 */
function hardenInjected<T extends object>(obj: T): T {
  Object.defineProperty(obj, 'constructor', {
    value: undefined,
    writable: false,
    configurable: false,
  });
  Object.setPrototypeOf(obj, null);
  return obj;
}

export function createWorkflowSandbox(opts: SandboxOptions): WorkflowSandbox {
  const phases: string[] = [];
  const logs: string[] = [];

  // FIX-9 (SEC-I2): cap log lines to prevent unbounded memory growth.
  const safeLog = (msg: unknown): void => {
    if (logs.length < MAX_LOG_LINES) {
      logs.push(String(msg));
    } else if (logs.length === MAX_LOG_LINES) {
      logs.push(`[workflow log truncated at ${MAX_LOG_LINES} lines]`);
    }
    // Beyond MAX_LOG_LINES + 1, additional entries are silently dropped.
  };

  // FIX-C5 (SEC-2-I1): same cap pattern for phases.
  const safePhase = (title: string): void => {
    if (phases.length < MAX_PHASE_ENTRIES) {
      phases.push(String(title));
    } else if (phases.length === MAX_PHASE_ENTRIES) {
      phases.push(
        `[workflow phases truncated at ${MAX_PHASE_ENTRIES} entries]`,
      );
    }
  };

  // FIX-2 (SEC-C1): JSON-roundtrip args then strip all Object.prototype links
  // via deepNullProto. Two-step rationale:
  //
  //   1. JSON.parse(JSON.stringify(x)) rejects non-serialisable values (functions,
  //      circular refs) with a clear error, keeping the surface well-defined.
  //   2. deepNullProto(x) replaces every plain-object's prototype with null so
  //      that `args.constructor` returns undefined inside the vm context instead
  //      of pointing at the host Object/Function constructor chain. Without this
  //      step the classic PoC `args.constructor.constructor("return process")()`
  //      still reaches the host realm even after JSON roundtrip.
  let safeArgs: unknown;
  try {
    safeArgs =
      opts.args === undefined
        ? undefined
        : deepNullProto(JSON.parse(JSON.stringify(opts.args)));
  } catch (err) {
    throw new Error(
      `WorkflowSandbox: args must be JSON-serializable (no functions, no circular references). Got: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // FIX-D (Round 3 SEC C1-C3, UP C1): Math and Date are NOT injected here.
  // Round 3 PoCs proved that injecting host-realm Math (via Proxy) and Date
  // (as a plain object) leaks the host Function constructor via three paths:
  //   1. `Math.__proto__.constructor.constructor("return process")()`
  //   2. `Math.toString.constructor("return process")()` (Math.toString
  //      inherited from host Function.prototype)
  //   3. `Date.constructor.constructor("return process")()` (Date stub is a
  //      plain host Object, its constructor is the host Object).
  // Instead, after vm.createContext, we evaluate an init script that
  // constructs Math and Date IN-CONTEXT using vm-realm primordials. A
  // vm-realm `Math.abs.constructor` is the vm-realm `Function`; invoking it
  // runs code in the vm realm where `process` is undefined — escape blocked
  // at the source.
  const sandboxGlobals = {
    // FIX-2 (SEC-C1): use JSON-roundtripped args instead of opts.args directly.
    args: safeArgs,
    // FIX-3 + FIX-D: harden phase/log/agent closures so .constructor AND
    // .toString AND .__proto__ all return undefined — blocking every known
    // closure-based realm-escape PoC.
    // FIX-C5: route phase through safePhase for the entries cap.
    phase: hardenInjected((title: string): void => {
      safePhase(String(title));
    }),
    log: hardenInjected((message: unknown): void => {
      safeLog(message);
    }),
    // FIX-4 (UP-C1): agent() now validates opts fields and throws on any
    // unsupported option rather than silently discarding them.
    agent: hardenInjected(
      async (
        prompt: string,
        agentOpts: WorkflowAgentOpts = {},
      ): Promise<string> => {
        // Reject opts that P1 cannot honor — silently dropping them produces
        // semantic corruption rather than a clean error.
        if (agentOpts.schema !== undefined) {
          throw new Error(
            'agent({schema}) is not supported in P1. ' +
              'Schema enforcement / StructuredOutput contract is scheduled for P3.',
          );
        }
        if (agentOpts.isolation !== undefined) {
          throw new Error(
            `agent({isolation: '${agentOpts.isolation}'}) is not supported in P1. ` +
              'Worktree / remote isolation is scheduled for a later phase.',
          );
        }
        if (agentOpts.model !== undefined) {
          throw new Error(
            'agent({model}) is not supported in P1. Model override is scheduled for a later phase.',
          );
        }
        if (agentOpts.agentType !== undefined) {
          throw new Error('agent({agentType}) is not supported in P1.');
        }
        // opts.phase IS honored — push it to the phases array if not duplicate.
        // FIX-C5: route through safePhase for the entries cap.
        if (typeof agentOpts.phase === 'string' && agentOpts.phase.length > 0) {
          if (phases[phases.length - 1] !== agentOpts.phase) {
            safePhase(agentOpts.phase);
          }
        }
        // opts.label is harmless to dispatch as-is.
        return opts.dispatch(prompt, agentOpts);
      },
    ),
    // FIX-3 + FIX-D: console.* closures hardened (proto null) and routed
    // through safeLog for the log cap. The `console` container object is
    // ALSO hardened so `console.constructor.constructor` cannot escape.
    console: hardenInjected({
      log: hardenInjected((...args: unknown[]) =>
        safeLog(args.map(String).join(' ')),
      ),
      warn: hardenInjected((...args: unknown[]) =>
        safeLog(args.map(String).join(' ')),
      ),
      error: hardenInjected((...args: unknown[]) =>
        safeLog(args.map(String).join(' ')),
      ),
    }),
  };

  const ctx = vm.createContext(sandboxGlobals);

  // FIX-D (Round 3 SEC C1-C3, UP C1): construct vm-realm Math and Date stubs.
  // Evaluating this init script inside the vm context means:
  //   - `Math` is now a vm-realm null-proto object
  //   - `Math.abs.constructor` is vm-realm Function (cannot reach host process)
  //   - `Math.__proto__` is null (no prototype chain to walk)
  //   - `Date` is a vm-realm function whose [[Call]] throws our nice message
  //   - `Date.constructor` is undefined (proto severed)
  // Error messages are verbatim from claude-code 2.1.160 binary §axO and §sxO.
  vm.runInContext(
    `(() => {
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
    })();`,
    ctx,
    { filename: 'workflow-sandbox-init.js' },
  );

  return {
    async run(scriptSource: string): Promise<unknown> {
      const stripped = stripExportMeta(scriptSource);
      const wrapped = `(async () => {\n${stripped}\n})()`;
      const script = new vm.Script(wrapped, {
        filename: 'workflow.js',
      });
      // FIX-1 (SEC-C2): add a 30s wall-clock timeout to protect the host
      // from synchronous infinite loops (e.g. `while(true){}`).
      //
      // IMPORTANT: vm `timeout` only covers SYNCHRONOUS execution per the
      // Node.js vm docs. An async infinite loop such as
      //   `while(true) { await agent(...) }`
      // is NOT killed by this timeout — that is the responsibility of the
      // 1000-agent cap scheduled for P2.
      const runOpts: vm.RunningScriptOptions = {
        timeout: 30_000, // 30s wall-clock cap; protects host from sync infinite loops.
      };
      const result = script.runInContext(ctx, runOpts) as Promise<unknown>;
      return result;
    },
    getPhases: () => [...phases],
    getLogs: () => [...logs],
  };
}
