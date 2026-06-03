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

export interface SandboxOptions {
  /** Value bound to the `args` global inside the script. */
  args: unknown;
  /**
   * Function called by the script's `agent(prompt, opts)` global. Returns the
   * agent's final text. Injected so tests can mock without spawning an LLM.
   *
   * FIX-4 (UP-C1): opts type widened to WorkflowAgentOpts.
   */
  dispatch: (prompt: string, opts: WorkflowAgentOpts) => Promise<string>;
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
function deepNullProto(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(deepNullProto);
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = deepNullProto(v);
  }
  return out;
}

/**
 * FIX-3 (SEC-C1): Make a closure's .constructor opaque to sandbox scripts.
 *
 * Injected host-realm functions are accessible as globals inside the vm
 * context. Without this guard, a script can call `fn.constructor.constructor`
 * to retrieve the host `Function` constructor and then execute arbitrary host
 * code — the classic realm-escape PoC:
 *   `phase.constructor.constructor("return process")()`
 *
 * By redefining `.constructor` to `undefined` (non-writable, non-configurable),
 * the escape chain is severed before the script can traverse it.
 */
function hardenClosure<T extends (...a: never[]) => unknown>(fn: T): T {
  // Make the closure's prototype chain opaque to scripts: `fn.constructor`
  // returns undefined instead of host-realm Function, blocking the classic
  // `fn.constructor.constructor("return process")()` realm-escape PoC.
  Object.defineProperty(fn, 'constructor', {
    value: undefined,
    writable: false,
    configurable: false,
  });
  return fn;
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

  const sandboxGlobals = {
    // FIX-2 (SEC-C1): use JSON-roundtripped args instead of opts.args directly.
    args: safeArgs,
    Date: {
      // FIX-C6 (UP-2-I1): Date.now() throws instead of returning a placeholder.
      // Binary statically rejects scripts that use Date.now; silently returning
      // 0 produced wrong results in scripts that do `Date.now() - start` style
      // duration math. Throwing matches the Math.random treatment.
      now: () => {
        throw new Error(
          'Date.now() is unavailable in workflow scripts (breaks resume). ' +
            'Pass timestamps via args or stamp results after the workflow returns.',
        );
      },
    },
    Math: new Proxy(Math, {
      get(target, prop) {
        // FIX-C1 (SEC-2-C1): block Math.constructor realm escape. PoC:
        //   `Math.constructor.constructor("return process")()` reaches host
        //   `process` because Math is the host realm's Math, and its
        //   constructor chain points at host Function. Returning undefined
        //   severs the chain.
        if (prop === 'constructor') return undefined;
        if (prop === 'random') {
          return () => {
            throw new Error(
              'Math.random() is unavailable in workflow scripts (breaks resume). ' +
                'For N independent samples, include the index in the agent label or prompt.',
            );
          };
        }
        return Reflect.get(target, prop);
      },
      // FIX-C1 (defense in depth): block `Object.getOwnPropertyDescriptor(Math, 'random').value()`
      // which would otherwise bypass the get trap on `random`.
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'random' || prop === 'constructor') return undefined;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    }),
    // FIX-3 (SEC-C1): harden phase/log/agent closures so .constructor is
    // undefined — blocking the fn.constructor.constructor realm-escape PoC.
    // FIX-C5: route phase through safePhase for the entries cap.
    phase: hardenClosure((title: string): void => {
      safePhase(String(title));
    }),
    log: hardenClosure((message: unknown): void => {
      safeLog(message);
    }),
    // FIX-4 (UP-C1): agent() now validates opts fields and throws on any
    // unsupported option rather than silently discarding them.
    agent: hardenClosure(
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
    // FIX-3 (SEC-C1) + FIX-9 (SEC-I2): console.* closures hardened and
    // routed through safeLog for the log cap.
    console: {
      log: hardenClosure((...args: unknown[]) =>
        safeLog(args.map(String).join(' ')),
      ),
      warn: hardenClosure((...args: unknown[]) =>
        safeLog(args.map(String).join(' ')),
      ),
      error: hardenClosure((...args: unknown[]) =>
        safeLog(args.map(String).join(' ')),
      ),
    },
  };

  const ctx = vm.createContext(sandboxGlobals);

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
