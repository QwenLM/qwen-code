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

export interface SandboxOptions {
  /** Value bound to the `args` global inside the script. */
  args: unknown;
  /**
   * Fixed value returned by `Date.now()` inside the script. Workflow scripts
   * must be deterministic for resume; live wall-clock is not exposed.
   */
  startTime: number;
  /**
   * Function called by the script's `agent(prompt, opts)` global. Returns the
   * agent's final text. Injected so tests can mock without spawning an LLM.
   */
  dispatch: (prompt: string, opts: { label?: string }) => Promise<string>;
  /**
   * Optional abort signal. When aborted, in-flight script execution rejects.
   */
  signal?: AbortSignal;
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

export function createWorkflowSandbox(opts: SandboxOptions): WorkflowSandbox {
  const phases: string[] = [];
  const logs: string[] = [];

  const sandboxGlobals = {
    args: opts.args,
    Date: {
      now: () => opts.startTime,
    },
    Math: new Proxy(Math, {
      get(target, prop) {
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
    }),
    phase: (title: string): void => {
      phases.push(String(title));
    },
    log: (message: unknown): void => {
      logs.push(String(message));
    },
    agent: async (
      prompt: string,
      agentOpts: { label?: string } = {},
    ): Promise<string> => opts.dispatch(prompt, agentOpts),
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
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
      const runOpts: vm.RunningScriptOptions = {};
      if (opts.signal) {
        // P1: signal is observed only by dispatch (the long-running side); the
        // sandbox itself runs to completion or throws naturally.
      }
      const result = script.runInContext(ctx, runOpts) as Promise<unknown>;
      return result;
    },
    getPhases: () => [...phases],
    getLogs: () => [...logs],
  };
}
