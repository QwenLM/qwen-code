/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { SandboxOptions, WorkflowAgentOpts } from './workflow-sandbox.js';
import {
  stripExportMeta,
  extractAndStripMeta,
  createWorkflowSandbox,
  compileWorkflowScript,
  describeWorkflowCompileError,
} from './workflow-sandbox.js';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';
import { WorkflowUnsupportedSyntaxError } from './workflow-script-validation.js';
import { expectWithinLatencyBudget } from '../../test-utils/latency-budget.js';

const walkFailure = vi.hoisted(() => ({ fail: false }));
vi.mock('acorn-walk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('acorn-walk')>();
  return {
    ...actual,
    simple: (...args: Parameters<typeof actual.simple>) => {
      if (walkFailure.fail) {
        throw new TypeError('baseVisitor[type] is not a function');
      }
      return actual.simple(...args);
    },
  };
});

type Opts = Partial<SandboxOptions>;
type Dispatch = SandboxOptions['dispatch'];

/** A bare sandbox: no args, a dispatch answering 'ignored', then `opts`. */
const sb = (opts: Opts = {}) =>
  createWorkflowSandbox({
    args: undefined,
    dispatch: async () => 'ignored',
    ...opts,
  });
/** Runs `script` in a fresh {@link sb} sandbox. */
const runIn = (script: string, opts?: Opts) => sb(opts).run(script);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rejecting =
  (message: string): Dispatch =>
  () =>
    Promise.reject(new Error(message));
/** The rejection `script` settles with, in a fresh sandbox. */
const rejectionOf = async (script: string) =>
  (await runIn(script).catch((e: unknown) => e)) as Error;

const HANG = 'return new Promise(() => {});';
const OVER_100 = /exceeded 100 ms of active time/;
const CANCELLED = /aborted \(cancelled\)/;
const UNAVAILABLE = /unavailable in workflow scripts/i;
const NAME_ERROR = /^meta\.name must be a non-empty string$/;
const DESCRIPTION_ERROR = /^meta\.description must be a non-empty string$/;
const INVALID_META = /invalid meta object literal/;
const TERMINATED =
  'Workflow subagent x did not complete (terminate mode: CANCELLED).';
/** Awaits `slow` before consuming the `flaky` dispatch's rejection. */
const CONSUME_FLAKY_LATE = `
  const p = agent('flaky');
  await agent('slow');
  try { await p; } catch (e) { log('handled: ' + e.message); }
  return 'done';`;
const notConsumed = (m: string) =>
  `dispatch failed (result not consumed): ${m}`;
const notHandled = (m: string) =>
  `dispatch failed (rejection not handled): ${m}`;

/** Host-side parallel / pipeline impls; both resolve with HOST-realm arrays. */
const parallelAll: SandboxOptions['parallel'] = async (thunks) =>
  Promise.all(thunks.map((t) => t()));
const pipelineSeq: SandboxOptions['pipeline'] = async (items, ...stages) => {
  const out: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    let cur: unknown = items[i];
    for (const stage of stages) {
      cur = await stage(cur, items[i], i);
    }
    out.push(cur);
  }
  return out;
};

/** Matches a probe answer that carries host `process` data. */
const HOST = /object|darwin|linux|win32/i;
/**
 * Realm-escape probe: after `setup`, asks the Function constructor `ctor`
 * reaches for `typeof process` (`caught` if it throws); asserts no leak.
 */
async function probeHost(
  ctor: string,
  opts?: Opts,
  setup = '',
  caught = `'threw:' + String(e.message).slice(0, 40)`,
) {
  const result = await runIn(
    `${setup}\ntry { const v = ${ctor}("return typeof process")(); return String(v); } catch (e) { return ${caught}; }`,
    opts,
  );
  expect(result).not.toMatch(HOST);
  return result;
}
/** {@link probeHost}, and the probe answered `undefined` or threw in-vm. */
async function expectSealed(ctor: string, opts?: Opts, setup?: string) {
  const result = await probeHost(ctor, opts, setup);
  expect(String(result)).toMatch(/^undefined|^threw/);
}

/**
 * Runs a script in a fresh sandbox; returns its result, logs and phases.
 * Curried so the (often multi-line) script is the call's only argument.
 */
const traceWith = (opts?: Opts) => async (script: string) => {
  const sandbox = sb(opts);
  const result = await sandbox.run(script);
  return { result, logs: sandbox.getLogs(), phases: sandbox.getPhases() };
};
/** Awaits the run of `script` to reject with `error`. */
const rejects = (script: string, error: RegExp | string, opts?: Opts) =>
  expect(runIn(script, opts)).rejects.toThrow(error);

/** Runs `script`; dispatch records each call and answers `reply(prompt)`. */
async function runRecording(
  script: string,
  reply: (prompt: string) => string | object = () => 'done',
) {
  const calls: Array<{ prompt: string; opts: WorkflowAgentOpts }> = [];
  const result = await runIn(script, {
    dispatch: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return reply(prompt);
    },
  });
  return { result, calls, opts: calls.map((c) => c.opts) };
}
/** One `agent("x", { <option> })` call; its result and the opts dispatch saw. */
async function agentWith(option: string) {
  const { result, opts } = await runRecording(
    `return await agent("x", { ${option} });`,
  );
  return { result, opts: opts[0] };
}

/**
 * Asserts `script` is refused with `message` before any dispatch and, when
 * `phases` is given, that the refusal left exactly those phases.
 */
async function expectRefused(
  script: string,
  message: RegExp,
  phases?: string[],
) {
  const dispatch = vi.fn(async () => 'ignored');
  const sandbox = sb({ dispatch });
  await expect(sandbox.run(script)).rejects.toThrow(message);
  if (phases) expect(sandbox.getPhases()).toEqual(phases);
  expect(dispatch).not.toHaveBeenCalled();
}

/** Awaits `body` while collecting process-level unhandled rejections. */
async function captureUnhandled(body: () => Promise<unknown>) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return unhandled;
}
/** {@link traceWith}, capturing unhandled rejections through `settleMs`. */
const captureWith =
  (opts: Opts, settleMs = 10) =>
  async (script: string) => {
    const sandbox = sb(opts);
    let result: unknown;
    const unhandled = await captureUnhandled(async () => {
      result = await sandbox.run(script);
      await sleep(settleMs);
    });
    return { result, unhandled, logs: sandbox.getLogs() };
  };

/** A dispatch whose calls stay pending until the test settles them. */
function pendingDispatch() {
  const calls: Array<{
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }> = [];
  const dispatch = () =>
    new Promise<string>((resolve, reject) => calls.push({ resolve, reject }));
  return { dispatch, calls };
}

/** Asserts `run` is still unsettled one macrotask from now. */
async function expectPending(run: Promise<unknown>) {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  void run.then(settle, settle);
  await sleep(0);
  expect(settled).toBe(false);
}

/**
 * The production teardown error (a real aborted scheduler job, not a literal)
 * so a change to abortError()'s message turns the tests using it red.
 */
async function abortedJob() {
  const controller = new AbortController();
  const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
  scheduler.pause();
  const queued = scheduler.run(async () => 'never');
  controller.abort();
  const teardownError: unknown = await queued.catch((error: unknown) => error);
  return { scheduler, teardownError };
}

/** Extracts from a script whose meta is `literal`, followed by `return 1`. */
const extractFrom = (literal: string) => () =>
  extractAndStripMeta(`export const meta = ${literal}\nreturn 1`);

describe('stripExportMeta', () => {
  it('returns input unchanged when no export meta present', () => {
    const src = `phase("plan")\nreturn 1`;
    expect(stripExportMeta(src)).toBe(src);
  });

  it('strips a simple export const meta declaration', () => {
    const src = `export const meta = { name: 'x', description: 'y' }\nphase("plan")\nreturn 1`;
    expect(stripExportMeta(src)).toBe(`phase("plan")\nreturn 1`);
  });

  it('strips a multi-line export const meta with nested braces', () => {
    const src = `export const meta = {
  name: 'x',
  phases: [{ title: 'a' }, { title: 'b' }],
}
phase("plan")
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  it('strips an export meta followed by a trailing semicolon', () => {
    const src = `export const meta = { name: 'x' };\nphase("plan")`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")`);
  });

  it('does not strip a const meta without export keyword', () => {
    const src = `const meta = { name: 'x' }\nreturn meta`;
    expect(stripExportMeta(src)).toBe(src);
  });

  it('handles string literals containing closing brace characters', () => {
    const src = `export const meta = { name: 'x', description: 'hello }' }
phase("plan")
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  it('handles string literals containing opening brace characters', () => {
    const src = `export const meta = { name: 'x', description: 'hello { world' }
phase("plan")
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  it('handles escaped quote characters inside string literals', () => {
    const src = `export const meta = { name: 'x', description: 'it\\'s fine }' }
phase("plan")`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")`);
  });

  // T16 (Round 1 review Suggestion): line comments must skip their contents,
  // stray quotes and braces included, or an `it's a plan` comment opens a
  // phantom string literal that walks to EOF.
  it('handles single-line comments inside meta object', () => {
    const src = `export const meta = {
  // it's the plan
  name: 'x',
}
phase("plan")
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  it('handles braces inside single-line comments', () => {
    const src = `export const meta = {
  name: 'x', // closes brace } here
}
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`return 1`);
  });

  it('handles block comments inside meta object', () => {
    const src = `export const meta = {
  /* a multi-line comment with } and ' inside */
  name: 'x',
}
return 42`;
    expect(stripExportMeta(src).trim()).toBe(`return 42`);
  });

  // T16: regex literals shouldn't be parsed as division on `/`.
  it('handles regex literals in meta values', () => {
    const src = `export const meta = { name: 'x', pattern: /\\{[a-z]+\\}/g }
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`return 1`);
  });

  // T9 / T17 (Round 1 review Critical): unmatched meta braces must throw, not
  // silently delete the script — the old `""` made the workflow appear to
  // succeed while returning nothing.
  it('throws on unbalanced meta braces (does not silently delete script)', () =>
    expect(() => stripExportMeta(`export const meta = { name: 'x'`)).toThrow(
      /unbalanced/i,
    ));

  it('throws on meta with unterminated string', () =>
    expect(() =>
      stripExportMeta(`export const meta = { name: 'foo }\nreturn 1`),
    ).toThrow(/unbalanced/i));

  // T33 (PR #4732 R4): the regex anchors at file start, not every line start;
  // otherwise a template literal containing `\nexport const meta = {\n`
  // false-matches and the brace-walker corrupts the string body.
  it('does not strip an export const meta declaration inside a template literal (T33)', () => {
    const src = `const banner = \`
export const meta = { name: 'fake' }
\`;
return banner;`;
    expect(stripExportMeta(src)).toBe(src);
  });

  it('does not strip an export const meta declaration after leading code (T33)', () => {
    const src = `const x = 1;
export const meta = { name: 'fake' }
return x;`;
    expect(stripExportMeta(src)).toBe(src);
  });

  // Sanity: leading whitespace at file start is still tolerated.
  it('strips export const meta even with leading whitespace/newlines (T33)', () => {
    const src = `\n\n  export const meta = { name: 'x' }\nphase("plan")\nreturn 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  // Reported in PR #12245 review: the anchor must tolerate every
  // whitespace spelling Claude Code accepts (`export  const`,
  // `export const meta=`, tabs and newlines around `=`).
  it.each([
    [
      'single space',
      `export const meta = { name: 'x', description: 'd' }\nreturn 1;`,
    ],
    [
      'double space after export',
      `export  const meta = { name: 'x', description: 'd' }\nreturn 1;`,
    ],
    [
      'double space after equals',
      `export const meta =  { name: 'x', description: 'd' }\nreturn 1;`,
    ],
    [
      'no space around equals',
      `export const meta={ name: 'x', description: 'd' }\nreturn 1;`,
    ],
    [
      'tab before brace',
      `export const meta =\t{ name: 'x', description: 'd' }\nreturn 1;`,
    ],
    [
      'newline before brace',
      `export const meta =\n{ name: 'x', description: 'd' }\nreturn 1;`,
    ],
  ])('accepts the anchor spelling: %s', (_label, src) => {
    const { meta } = compileWorkflowScript(src);
    expect(meta).toEqual({ name: 'x', description: 'd' });
  });
});

describe('extractAndStripMeta', () => {
  // P4: extracts `export const meta = {...}` into a typed object AND strips
  // it from the source (same brace-walker as stripExportMeta). `meta: null`
  // without a declaration; throws when one is present but malformed.
  it('returns meta: null and unchanged source when no meta declaration', () => {
    const src = `phase("plan")\nreturn 1`;
    const { stripped, meta } = extractAndStripMeta(src);
    expect(stripped).toBe(src);
    expect(meta).toBeNull();
  });

  it('extracts the required name + description fields', () => {
    const src = `export const meta = { name: 'demo', description: 'a demo workflow' }\nreturn 1`;
    const { stripped, meta } = extractAndStripMeta(src);
    expect(stripped.trim()).toBe('return 1');
    expect(meta).toEqual({ name: 'demo', description: 'a demo workflow' });
  });

  /** Carries every optional field: whenToUse, and phases with detail / model. */
  const FULL_META = `export const meta = {
      name: 'multi',
      description: 'multi-phase',
      whenToUse: 'when the user needs a multi-phase report',
      phases: [
        { title: 'collect' },
        { title: 'analyse', detail: 'aggregate findings', model: 'qwen3-coder-plus' },
      ],
    }
    return 1;`;

  it('extracts optional whenToUse + phases array', () => {
    const { meta } = extractAndStripMeta(FULL_META);
    expect(meta).toEqual({
      name: 'multi',
      description: 'multi-phase',
      whenToUse: 'when the user needs a multi-phase report',
      phases: [
        { title: 'collect' },
        {
          title: 'analyse',
          detail: 'aggregate findings',
          model: 'qwen3-coder-plus',
        },
      ],
    });
  });

  it('throws upstream-verbatim error when name is missing', () =>
    expect(extractFrom(`{ description: 'no name' }`)).toThrow(NAME_ERROR));

  it('throws upstream-verbatim error when description is missing', () =>
    expect(extractFrom(`{ name: 'x' }`)).toThrow(DESCRIPTION_ERROR));

  it('throws when name is empty string', () =>
    expect(extractFrom(`{ name: '', description: 'd' }`)).toThrow(NAME_ERROR));

  it('throws when phases is not an array', () =>
    expect(
      extractFrom(`{ name: 'n', description: 'd', phases: 'oops' }`),
    ).toThrow(/phases must be an array/));

  it('throws when a phase is missing its title', () =>
    expect(
      extractFrom(
        `{ name: 'n', description: 'd', phases: [{ detail: 'no title here' }] }`,
      ),
    ).toThrow(/phases\[\]\.title must be a non-empty string/));

  // Security regression: meta is parsed, not executed, so an identifier is
  // not "resolved to undefined" or "not found" — the grammar does not admit
  // it. Pinned for an unknown identifier and the `args` bridge global.
  it('rejects meta that references an unknown identifier', () =>
    expect(extractFrom(`{ name: totallyUnknown, description: 'd' }`)).toThrow(
      INVALID_META,
    ));

  // Security regression: with no evaluation there is no scope to reach out
  // of — neither the bridge globals (`args` / `agent` / `phase` / `log` / …)
  // nor host primitives like `process` and `require`.
  it('meta source cannot reference a workflow-sandbox bridge global (args)', () =>
    expect(extractFrom(`{ name: args.x, description: 'd' }`)).toThrow(
      INVALID_META,
    ));

  it('meta source cannot reach the host process / require / fs', () => {
    expect(extractFrom(`{ name: process.version, description: 'd' }`)).toThrow(
      INVALID_META,
    );
    expect(
      extractFrom(
        `{ name: 'x', description: require('fs').readFileSync('/etc/passwd', 'utf8') }`,
      ),
    ).toThrow(INVALID_META);
  });

  it('unbalanced braces still throw the stripExportMeta error', () =>
    expect(() =>
      extractAndStripMeta(`export const meta = { name: 'x'`),
    ).toThrow(/unbalanced/i));

  // P4a adversarial review (HIGH × 3 lenses): workflow-sandbox.ts:283-294
  // promises a HOST-realm meta (a per-field copy) against T1/T8/T14-style
  // `outcome.meta.constructor.constructor('return process')()` escapes. A
  // regression returning the vm-eval'd value would pass every structural
  // `toEqual`, so meta, its phases array and each entry are checked here.
  it('returned meta + phases array + phase entries are all host-realm objects', () => {
    const { meta } = extractAndStripMeta(FULL_META);
    expect(meta).not.toBeNull();
    expect(Object.getPrototypeOf(meta as object)).toBe(Object.prototype);
    const phases = (meta as { phases: object[] }).phases;
    expect(Object.getPrototypeOf(phases)).toBe(Array.prototype);
    for (const p of phases) {
      expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    }
  });

  // P4a Round 3 (wenshao): a Promise meta value (e.g. `import('node:fs')`)
  // used to crash the host: validateMeta dropped the non-contract field, the
  // workflow returned, and only THEN did the dangling rejection kill the
  // process under Node's default `--unhandled-rejections=throw` (a walker
  // neutralising thenables once prevented it). Nothing is evaluated now, so
  // the literal is refused on syntax; both the throw AND no unhandled
  // rejection (what users cared about, now guaranteed structurally) are pinned.
  it('rejects a Promise-valued meta field (dynamic import) with no unhandled rejection', async () => {
    const unhandled = await captureUnhandled(async () => {
      expect(
        extractFrom(
          `{ name: 'x', description: 'd', extra: import('node:fs') }`,
        ),
      ).toThrow(INVALID_META);
      // Let any rejection a previous implementation would have scheduled
      // reach the handler before asserting none arrived.
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(unhandled).toEqual([]);
  });

  it('rejects a Promise-valued meta field nested inside a phases entry', () => {
    const src = `export const meta = {
      name: 'x',
      description: 'd',
      phases: [{ title: 't', extra: import('node:fs') }],
    }
    return 1`;
    expect(() => extractAndStripMeta(src)).toThrow(INVALID_META);
  });

  // P4 Round 7 (wenshao): `phase('X'); phase('X')` gave outcome.phases
  // ['X','X'] while the registry's onPhaseStarted deduped to ['X'], so the
  // terminal and live UI diverged. Deduping here makes the sandbox the single
  // source of truth, so the safePhase / phase() docstring is honest.
  it('consecutive identical phase titles dedup at the sandbox layer', async () => {
    const { phases } = await traceWith()(
      `phase('X'); phase('X'); phase('Y'); phase('X'); return 1`,
    );
    expect(phases).toEqual(['X', 'Y', 'X']);
  });

  // P4 Round 4 (wenshao): spread-built cyclic meta overflowed the walker's
  // stack; both fixtures used to SUCCEED (validateMeta dropped the field).
  // Refusing is a deliberate narrowing, not a regression: a spread means
  // "evaluate and merge", which meta no longer does, and a literal cannot be
  // cyclic. The message names the rule so authors know what to write.
  it('refuses a spread in meta rather than evaluating it', () => {
    const src = `export const meta = {
      name: 'x',
      description: 'y',
      ...(function () { const a = {}; a.self = a; return a; })(),
    }
    return 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /spread is not allowed in meta/,
    );
  });

  it('refuses a spread that would have built a cycle through nested arrays', () => {
    const src = `export const meta = {
      name: 'x',
      description: 'y',
      // Cycle reached through items[0].ref → ref back to outer container.
      ...(function () {
        const outer = { items: [] };
        outer.items.push({ ref: outer });
        return outer;
      })(),
    }
    return 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /spread is not allowed in meta/,
    );
  });
});

describe('createWorkflowSandbox', () => {
  it('exposes args verbatim', async () => {
    const result = await runIn(`return args.question`, {
      args: { question: 'why?' },
    });
    expect(result).toBe('why?');
  });

  // FIX-C6 (UP-2-I1): Date.now() throws (the binary's static-reject intent,
  // like Math.random); the old sentinel let scripts silently compute wrong
  // durations.
  it('Date.now() throws inside sandbox', () =>
    rejects(`return Date.now()`, /Date\.now/));

  it('Math.random() throws inside sandbox', () =>
    rejects(`return Math.random()`, /Math\.random/));

  it('return statement at top level captures the script result', async () =>
    expect(await runIn(`return 1 + 2`)).toBe(3));

  // P4: meta is extracted before the body runs and exposed via getMeta();
  // the body sees the stripped source.
  it('getMeta() returns null when no export const meta declaration', async () => {
    const sandbox = sb();
    await sandbox.run(`return 42`);
    expect(sandbox.getMeta()).toBeNull();
  });

  it('getMeta() returns the parsed meta when present', async () => {
    const sandbox = sb();
    const result = await sandbox.run(
      `export const meta = { name: 'unit', description: 'unit-test workflow', phases: [{ title: 'one' }] }\nreturn 'done'`,
    );
    expect(result).toBe('done');
    expect(sandbox.getMeta()).toEqual({
      name: 'unit',
      description: 'unit-test workflow',
      phases: [{ title: 'one' }],
    });
  });

  it('getMeta() failure on malformed meta propagates as the run rejection', () =>
    rejects(`export const meta = { name: 'x' }\nreturn 1`, DESCRIPTION_ERROR));
});

// Security PoC tests — every known realm-escape vector must yield
// 'undefined' / safe values rather than the host `process` object.
describe('createWorkflowSandbox security', () => {
  // Round 1 (PR #4732): all globals are built in the vm realm by an init
  // script, so `args.constructor.constructor` is vm-realm Function, which
  // runs where `process` is not defined.
  it('args.constructor.constructor cannot reach host process', () =>
    expectSealed('args.constructor.constructor', { args: { x: 1 } }));

  // T1 (Round 1 review Critical): `catch (e) { e.constructor }` reached host
  // Function via host-realm Errors thrown by injected closures; the wrapper
  // now rethrows each rejection as an in-context `new Error(msg)`. Since P3
  // (PR #4947+) passes schema/model/agentType/isolation through, the thrown
  // path used is an INVALID isolation value, refused before dispatch.
  it('thrown Error from agent() options validation cannot reach host process', async () => {
    const result = await runIn(`try {
        await agent("x", { isolation: "not-a-real-mode" });
        return 'no-throw';
      } catch (e) {
        try {
          const v = e.constructor.constructor("return typeof process")();
          return String(v);
        } catch (err) { return 'inner-threw:' + String(err.message).slice(0, 40); }
      }`);
    expect(result).not.toMatch(HOST);
    expect(String(result)).toMatch(/^undefined|^inner-threw/);
  });

  // T8 / T14 (Round 1 review Critical): agent() returned a host-realm
  // Promise whose constructor chain reached host Function; the wrapper now
  // builds a vm-realm `new Promise(...)` inside the init script.
  it('agent() success-path Promise constructor cannot reach host process', () =>
    expectSealed(
      'p.constructor.constructor',
      { dispatch: async () => 'ok' },
      'const p = agent("x");',
    ));

  // Same vector via the parallel / pipeline / workflow stubs, which all
  // return vm-realm Promises now.
  it('parallel() Promise constructor cannot reach host process', () =>
    probeHost(
      'p.constructor.constructor',
      { dispatch: async () => 'ok' },
      'const p = parallel([async () => 1]).catch(() => 0);',
    ));

  // T13 (Round 1 review Suggestion): the `[key: string]: unknown` index
  // signature lets typos like `scema` past TypeScript; the runtime allowlist
  // throws on any unknown opt name.
  it('agent() rejects unknown opts (typo guard)', () =>
    rejects(
      `return agent("hi", { scema: { type: 'object' } });`,
      /scema.*unknown option/,
    ));

  // T2 (Round 1 review Critical): null-proto args (`setPrototypeOf(out,
  // null)`) broke for...of / .map / .forEach / spread / destructuring; args
  // now come from vm-realm `JSON.parse` and keep vm-realm Array.prototype.
  it('array args support for...of iteration', async () => {
    const result = await sb({ args: [1, 2, 3] }).run(
      `let sum = 0; for (const x of args) sum += x; return sum;`,
    );
    expect(result).toBe(6);
  });

  it('array args support .map / .filter / spread / destructuring', async () => {
    const result = await sb({ args: [1, 2, 3, 4] }).run(`
      const doubled = args.map(x => x * 2);
      const evens = args.filter(x => x % 2 === 0);
      const spread = [0, ...args, 5];
      const [first, ...rest] = args;
      return { doubled, evens, spread, first, rest };`);
    expect(result).toEqual({
      doubled: [2, 4, 6, 8],
      evens: [2, 4],
      spread: [0, 1, 2, 3, 4, 5],
      first: 1,
      rest: [2, 3, 4],
    });
  });

  // Nested-object args also iterate correctly via Object.entries / keys.
  it('object args support Object.keys / entries / spread', async () => {
    const result = await sb({ args: { a: 1, b: 2, c: 3 } }).run(`
      const keys = Object.keys(args);
      const vals = Object.values(args);
      const ents = Object.entries(args);
      const spread = { ...args, d: 4 };
      return { keys, vals, ents, spread };`);
    expect(result).toEqual({
      keys: ['a', 'b', 'c'],
      vals: [1, 2, 3],
      ents: [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ],
      spread: { a: 1, b: 2, c: 3, d: 4 },
    });
  });

  // Sanity: vm-realm phase.constructor exists but cannot reach host.
  it('phase global is a vm-realm function (constructor cannot reach host)', () =>
    probeHost('phase.constructor.constructor'));

  // SEC-C2: vm timeout kills a synchronous infinite loop within 30s.
  it('synchronous infinite loop is aborted by vm timeout', async () => {
    await rejects(`while(true){}`, /Script execution timed out/i);
  }, 35_000); // wall clock for the test itself

  // P3 (PR #5xxx): schema / model / agentType / isolation pass through; the
  // dispatch surfaces "agent type not found", "isolation:'remote' is not
  // available in this build" and the StructuredOutput contract. Only invalid
  // isolation modes are still refused here (security regression above).
  it('agent({schema}) is passed through to dispatch in P3', async () => {
    const { result, calls } = await runRecording(
      `return await agent("hi", { schema: { type: "object", properties: { ok: { type: "boolean" } } } });`,
      (prompt) => ({ ok: true, echoed: prompt }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.schema).toBeDefined();
    // Result is the revived object payload.
    expect(result).toEqual({ ok: true, echoed: 'hi' });
  });

  // UP-C1: agent({phase}) is honored — pushed to the phases array.
  it('agent() honors opts.phase by appending to phases', async () => {
    const { result, phases } = await traceWith({
      dispatch: async (_p, opts) => `done:${opts.phase ?? 'no-phase'}`,
    })(`return await agent("x", { phase: "Search" });`);
    expect(result).toBe('done:Search');
    expect(phases).toEqual(['Search']);
  });

  // effort is validated and normalized on the revived copy, so the host (and
  // the resume key) sees one canonical tier for every alias /effort accepts.
  it('agent({effort}) hands the host the canonical tier', async () => {
    const { opts } = await runRecording(`
      await agent("a", { effort: "high" });
      await agent("b", { effort: "X-High" });
      await agent("c", { effort: "med" });
      await agent("d", {});
      return "done";`);
    expect(opts.map((o) => o.effort)).toEqual([
      'high',
      'xhigh',
      'medium',
      undefined,
    ]);
  });

  it.each([['"turbo"'], ['3'], ['{}']])(
    'agent({effort: %s}) is rejected before dispatch',
    (literal) =>
      expectRefused(
        `return agent("hi", { effort: ${literal} });`,
        /agent\(\{effort\}\): unknown effort tier .*Known tiers are: low, medium, high, xhigh, max\./,
      ),
  );

  // Order and duplicates are not part of what the list means, so they must
  // not reach the resume key; an empty list denies nothing and is dropped.
  it('agent({disallowedTools}) hands the host a sorted, de-duplicated list', async () => {
    const { opts } = await runRecording(`
      await agent("a", { disallowedTools: ["write_file", "run_shell_command", "write_file"] });
      await agent("b", { disallowedTools: [] });
      return "done";`);
    expect(opts.map((o) => o.disallowedTools)).toEqual([
      ['run_shell_command', 'write_file'],
      undefined,
    ]);
  });

  it.each([['"run_shell_command"'], ['[""]'], ['[" edit"]'], ['[42]']])(
    'agent({disallowedTools: %s}) is rejected before dispatch',
    (literal) =>
      expectRefused(
        `return agent("hi", { disallowedTools: ${literal} });`,
        /agent\(\{disallowedTools\}\): must be an array of non-empty tool-name strings/,
      ),
  );

  it('names effort, disallowedTools and tools among the known options', () =>
    rejects(
      `return agent("hi", { efort: "low" });`,
      /Known options are: .*effort.*disallowedTools, tools\./,
    ));

  // The allowlist gets the deny list's normalization: one built-in named two
  // ways, or the same tools in another order, is one resume key. Other names
  // reach the host as written.
  it('agent({tools}) hands the host a sorted, de-duplicated list of names', async () => {
    const { opts } = await runRecording(`
      await agent("a", { tools: ["run_shell_command", "ReadFile", "Shell"] });
      await agent("b", { tools: ["mcp__warehouse__query"] });
      await agent("c", {});
      return "done";`);
    expect(opts.map((o) => o.tools)).toEqual([
      ['read_file', 'run_shell_command'],
      ['mcp__warehouse__query'],
      undefined,
    ]);
  });

  // Unlike an empty deny list, an empty allowlist would leave nothing to call.
  it.each([['"read_file"'], ['[]'], ['[""]'], ['[" read_file"]'], ['[42]']])(
    'agent({tools: %s}) is rejected before dispatch',
    (literal) =>
      expectRefused(
        `return agent("hi", { tools: ${literal} });`,
        /agent\(\{tools\}\): must be a non-empty array of tool-name strings/,
      ),
  );

  it.each([
    ['"*"', /"\*" is a pattern, and the allowlist takes exact tool names/],
    ['"mcp__warehouse__*"', /is a pattern/],
    ['"mcp__warehouse"', /names a whole MCP server/],
    ['"exec"', /"exec" is the code-mode surface, not a tool to allow/],
    ['"Exec"', /is the code-mode surface/],
  ])(
    'agent({tools: ["read_file", %s]}) is rejected before dispatch',
    (entry, message) =>
      expectRefused(
        `return agent("hi", { tools: ["read_file", ${entry}] });`,
        message,
      ),
  );

  // The refused entry is script-controlled and echoed in the message.
  it('strips control characters from an echoed tools entry', async () => {
    const { message } = await rejectionOf(
      `return agent("x", { tools: ["mcp\u0085__srv__*"] });`,
    );
    expect(message).toMatch(/agent\(\{tools\}\): "mcp__srv__\*" is a pattern/);
    expect(message).not.toMatch(/[\u007f-\u009f]/);
  });

  // A rejected call must leave no phase behind: the phase is recorded only
  // after every option gate has passed.
  it.each([
    ['effort: "turbo"', /unknown effort tier/],
    ['disallowedTools: "edit"', /must be an array/],
    ['tools: []', /must be a non-empty array/],
    ['tools: ["exec"]', /is the code-mode surface/],
  ])('records no phase for a call rejected over %s', (option, message) =>
    expectRefused(
      `return agent("x", { phase: "Verify", ${option} });`,
      message,
      [],
    ),
  );

  // The rejected value is script-controlled, and JSON.stringify leaves DEL and
  // C1 (incl. NEL) in place, so the echo is sanitized before the message.
  it('strips control characters from an echoed effort value', async () => {
    const { message } = await rejectionOf(
      `return agent("x", { effort: "turbo\u0085inject\u007f" });`,
    );
    expect(message).toMatch(/unknown effort tier "turboinject"/);
    expect(message).not.toMatch(/[\u007f-\u009f]/);
  });

  // Built-in display names become tool names before the resume key is
  // derived, so renaming Edit to edit keeps the cache; MCP patterns pass as is.
  it('hands the host built-in deny names as tool names', async () => {
    const { opts } = await runRecording(
      `return agent("a", { disallowedTools: ["Edit", "edit", "WriteFile", "mcp__github"] });`,
    );
    expect(opts.map((o) => o.disallowedTools)).toEqual([
      ['edit', 'mcp__github', 'write_file'],
    ]);
  });

  // SEC-I2: log() must cap at MAX_LOG_LINES and add a truncation marker.
  it('log() caps at MAX_LOG_LINES with a truncation marker', async () => {
    const emitted: string[] = [];
    const { logs } = await traceWith({
      emitter: { logAppended: (line) => emitted.push(line) },
    })(`for (let i = 0; i < 10100; i++) log(i); return 0;`);
    expect(logs.length).toBe(10_001); // 10_000 entries + 1 truncation marker
    expect(logs[10_000]).toMatch(/truncated/);
    expect(emitted.at(-1)).toBe(logs[10_000]);
  });

  // FIX-C5 (SEC-2-I1): same cap for the phases array — protects the host
  // from `for(let i=0;i<1e6;i++) phase("p"+i)` style memory bombs.
  it('phase() caps at MAX_PHASE_ENTRIES with a truncation marker', async () => {
    const { phases } = await traceWith()(
      `for (let i = 0; i < 10100; i++) phase("p"+i); return 0;`,
    );
    expect(phases.length).toBe(10_001);
    expect(phases[10_000]).toMatch(/truncated/);
  });

  // FIX-C1 (SEC-2-C1): Round 2 PoC — `Math.constructor.constructor("return
  // process")()` reached the host realm because Math was the host's Math
  // object. The Proxy `get` trap on `constructor` blocks the chain.
  it('blocks Math.constructor realm escape', async () => {
    const result = await runIn(`const ctor = Math.constructor;
      return ctor === undefined ? 'blocked' : 'leaked:' + typeof ctor;`);
    expect(result).toBe('blocked');
  });

  // FIX-D (Round 3 SEC C1): Math is now a null-proto vm-realm object; its
  // getOwnPropertyDescriptor is real, but `.value()` still throws the
  // "Math.random unavailable" error, so no real randomness leaks.
  it('Math.random descriptor.value() still throws the unavailable error', () =>
    rejects(
      `const d = Object.getOwnPropertyDescriptor(Math, 'random'); return d.value();`,
      /Math\.random/,
    ));

  // FIX-D (Round 3 SEC-C1 PoC): the adversarial reviewer confirmed
  // `Math.__proto__.constructor.constructor("return process")()` reached host
  // `process` (returned darwin:pid). A null-proto Math has no __proto__.
  it('Math.__proto__ is undefined (blocks proto-chain escape)', async () =>
    expect([null, undefined]).toContain(await runIn(`return Math.__proto__`)));

  // FIX-D (Round 3 SEC-C2): Math.toString reached host
  // Function.prototype.toString, whose .constructor is host Function; a
  // null-proto Math inherits no toString.
  it('Math.toString is undefined (blocks inherited-method escape)', async () =>
    expect(await runIn(`return typeof Math.toString`)).toBe('undefined'));

  // FIX-D (Round 3 TST-C1): Math.abs.constructor reached host Function; now
  // Math.abs is vm-realm, so its constructor cannot see host process.
  // Whether the probe throws or answers 'undefined', no host info leaks.
  it('Math.abs.constructor cannot reach host process', async () => {
    const result = await probeHost('Math.abs.constructor', {}, '', `'threw'`);
    expect(['undefined', 'threw']).toContain(result);
  });

  // FIX-D (Round 3 SEC-C3): Date.constructor reached host Object (then host
  // Function); Date is now a null-prototype vm-realm function.
  it('Date.constructor is undefined (blocks Date-object escape)', async () =>
    expect(await runIn(`return Date.constructor`)).toBeUndefined());

  // FIX-D (Round 3 UP-C1): new Date() fell through to host Date and leaked
  // real wall-clock time. The Date stub itself throws, and [[Construct]]
  // invokes [[Call]].
  it('new Date() throws inside sandbox', () =>
    rejects(`return new Date()`, UNAVAILABLE));

  it('Date() (bare call) throws inside sandbox', () =>
    rejects(`return Date()`, UNAVAILABLE));

  it('Date.UTC() throws inside sandbox', () =>
    rejects(`return Date.UTC(2026, 0, 1)`, UNAVAILABLE));

  // FIX-D: console itself is hardened (null proto, .constructor undefined),
  // blocking `console.constructor.constructor`.
  it('console.constructor is undefined (blocks container-object escape)', async () =>
    expect(await runIn(`return console.constructor`)).toBeUndefined());

  // T22 (PR #4732 R2): a host-realm `globalThis` let `.constructor.constructor(
  // "return process")()` return host process (.env/.platform/.pid readable);
  // the fix severs sandboxGlobals's prototype before createContext.
  it('blocks globalThis.constructor host-realm escape', async () => {
    const result = await runIn(`try {
        const Obj = globalThis.constructor;
        if (!Obj) return 'no-ctor';
        const Fn = Obj.constructor;
        if (!Fn) return 'no-inner-ctor';
        const v = Fn("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }`);
    expect(result).not.toMatch(HOST);
    expect(['no-ctor', 'no-inner-ctor', 'undefined', 'threw']).toContain(
      result,
    );
  });

  // T22: same root via implicit `this` (== globalThis at top level).
  it('blocks implicit globalThis (this) host-realm escape', async () => {
    const result = await runIn(`try {
        const t = (function(){ return this; })();
        if (!t || !t.constructor || !t.constructor.constructor) return 'blocked';
        const v = t.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }`);
    expect(result).not.toMatch(HOST);
  });

  // T23 (PR #4732 R2): the vm `timeout` is sync-only — `return new Promise(()
  // => {})` disarms it at the first `await` and hangs forever. A Promise.race
  // wall clock rejects after maxWallClockMs (tiny here for a fast test).
  it('rejects an async never-resolving Promise via wall-clock timeout', () =>
    rejects(HANG, OVER_100, { maxWallClockMs: 100 }));

  // NOTE: deliberately NOT tested — an in-script async microtask loop
  // (`(async () => { while(true) await Promise.resolve(); })()`): Node cannot
  // halt it in the vm context, so it outlives the wall-clock rejection and
  // hangs the runner. Acceptable in production (the timeout error returns and
  // the unreferenced context is eventually GC'd); a node:vm limitation.

  // T40 (PR #4732 R4): after R2's timer fires, in-flight subagents (on the
  // dispatch signal) run on until max_time_minutes; `abortOnTimeout` lets the
  // caller link wall-clock fires to dispatch-signal aborts.
  it('aborts the abortOnTimeout controller when wall-clock timeout fires (T40)', async () => {
    const abortOnTimeout = new AbortController();
    const sandbox = sb({ maxWallClockMs: 100, abortOnTimeout });
    expect(abortOnTimeout.signal.aborted).toBe(false);
    await expect(sandbox.run(HANG)).rejects.toThrow(OVER_100);
    expect(abortOnTimeout.signal.aborted).toBe(true);
  });

  // T40 sibling: normal completion must NOT abort the controller — the
  // caller cleans up in its finally block.
  it('does not abort the abortOnTimeout controller on normal completion (T40)', async () => {
    const abortOnTimeout = new AbortController();
    const result = await runIn(`return 42`, {
      maxWallClockMs: 5000,
      abortOnTimeout,
    });
    expect(result).toBe(42);
    expect(abortOnTimeout.signal.aborted).toBe(false);
  });

  // T23: env var override is honored when no explicit opt is passed.
  it('QWEN_CODE_MAX_WORKFLOW_SECONDS env var sets the wall-clock cap', async () => {
    process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = '0.1';
    try {
      await rejects(HANG, OVER_100);
    } finally {
      delete process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
    }
  });

  // Pause-aware watchdog: `paused` means no dispatch in flight or issued, so
  // paused time must not burn the budget or let the timer kill the run
  // mid-pause (no resume possible while the UI promises "press p to resume").
  it('suspends the wall-clock watchdog while the scheduler is paused', async () => {
    const scheduler = new WorkflowDispatchScheduler(1);
    const run = runIn(HANG, { maxWallClockMs: 100, scheduler });
    await sleep(20);
    expect(scheduler.pause()).toBe(true);
    // Wait out the whole budget while paused — pre-fix the watchdog fired
    // mid-pause and rejected the run.
    await sleep(150);
    await expectPending(run);

    expect(scheduler.resume()).toBe(true);
    await expect(run).rejects.toThrow(OVER_100);
  });

  it('re-arms with the banked remainder on resume, not a fresh budget', async () => {
    const scheduler = new WorkflowDispatchScheduler(1);
    const { dispatch, calls } = pendingDispatch();
    const sandbox = sb({ dispatch, maxWallClockMs: 200, scheduler });
    // Consume most of the budget BEFORE pausing; only the banked remainder
    // may fire after resume.
    const run = sandbox.run(`await agent('a'); ${HANG}`);
    await vi.waitFor(() => expect(calls[0]).toBeDefined());
    await sleep(120);
    expect(scheduler.pause()).toBe(true);
    calls[0]?.resolve('done');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    await sleep(200);
    await expectPending(run);

    scheduler.resume();
    const resumedAt = Date.now();
    await expect(run).rejects.toThrow(/exceeded 200 ms of active time/);
    // The banked remainder (~80 ms) fires promptly; a fresh full budget
    // (200 ms) would overshoot the upper bound, and a pause-duration
    // deduction would fire before the lower bound.
    expectWithinLatencyBudget(Date.now() - resumedAt, 150);
    expect(Date.now() - resumedAt).toBeGreaterThan(40);
  });

  it('survives a second pause after resume without burning banked budget', async () => {
    // R11-19: other watchdog tests cover one pause→resume cycle; multi-cycle
    // relies on resume() clearing the paused flag (pause() early-returns while
    // set), so a second pause must suspend again without settling the run.
    const scheduler = new WorkflowDispatchScheduler(1);
    const run = runIn(HANG, { maxWallClockMs: 100, scheduler });
    await sleep(20);

    expect(scheduler.pause()).toBe(true);
    await sleep(150);
    await expectPending(run);

    expect(scheduler.resume()).toBe(true);
    await sleep(10);

    expect(scheduler.pause()).toBe(true);
    // Wait out the (remaining) budget inside the SECOND pause — pre-fix the
    // watchdog stayed armed and killed the run mid-pause.
    await sleep(200);
    await expectPending(run);

    expect(scheduler.resume()).toBe(true);
    await expect(run).rejects.toThrow(OVER_100);
  });

  it('keeps the wall-clock watchdog armed while an in-flight dispatch drains a pause', async () => {
    // `pausing` = a dispatch still doing real work, the exact hang the
    // backstop exists for; suspending there would leave it unbounded (and
    // resume() returns false in `pausing`, so the backstop could not re-arm).
    const scheduler = new WorkflowDispatchScheduler(1);
    const run = runIn(`await agent('a');`, {
      // Route through the scheduler like the orchestrator does so the hung
      // thunk counts as in-flight and the pause parks in `pausing`.
      dispatch: () => scheduler.run(() => new Promise<string>(() => {})),
      maxWallClockMs: 100,
      scheduler,
    });
    await sleep(20);
    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot().state).toBe('pausing');
    await expect(run).rejects.toThrow(OVER_100);
  });

  it('settles a cancelled paused run at once, not on the banked wall-clock remainder', async () => {
    // Cancelling a paused run aborts the controller, but abortPending() emits
    // no scheduler transition, so settlement waited for the watchdog to re-arm
    // with its banked remainder — a cancelled run refusing to end that long.
    // The abort now settles it immediately; the re-arm stays as a backstop.
    vi.useFakeTimers();
    const scheduler = new WorkflowDispatchScheduler(1);
    const abortOnTimeout = new AbortController();
    const { dispatch, calls } = pendingDispatch();
    const run = runIn(`await agent('a'); ${HANG}`, {
      dispatch,
      maxWallClockMs: 200,
      scheduler,
      abortOnTimeout,
    });
    let settled = false;
    const settlement = run.catch(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls[0]).toBeDefined();
      await vi.advanceTimersByTimeAsync(120);
      expect(scheduler.pause()).toBe(true);
      calls[0]?.resolve('done');
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.snapshot().state).toBe('paused');

      abortOnTimeout.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await expect(run).rejects.toThrow(CANCELLED);
    } finally {
      abortOnTimeout.abort();
      await vi.runAllTimersAsync();
      await settlement;
      vi.useRealTimers();
    }
  });

  it('settles a run cancelled mid-pausing before the post-abort drain lands', async () => {
    // A dispatch settling AFTER the abort still lands `pausing` → `paused`
    // (pump's finally). The run must be settled first: a script catching the
    // abort and hanging in ungated code used to wait out the wall clock.
    const scheduler = new WorkflowDispatchScheduler(1);
    const abortOnTimeout = new AbortController();
    const pending = pendingDispatch();
    const run = sb({
      // Route through the scheduler like the orchestrator does so the thunk
      // counts as in-flight and the pause parks in `pausing`.
      dispatch: () => scheduler.run(pending.dispatch),
      maxWallClockMs: 150,
      scheduler,
      abortOnTimeout,
    }).run(`try { await agent('a'); } catch {}\n${HANG}`);
    await sleep(20);
    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot().state).toBe('pausing');

    abortOnTimeout.abort();
    await expect(run).rejects.toThrow(CANCELLED);

    // The drain still completes its transition afterwards without
    // disturbing the settled run.
    pending.calls[0]?.resolve('late');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
  });

  it('suspends the watchdog of a sandbox created while the scheduler is already paused', async () => {
    // A nested workflow() sandbox can be created mid-pause; the state
    // subscription only sees FUTURE transitions, so the watchdog must be
    // seeded with the current state or it kills the nested run mid-pause.
    const scheduler = new WorkflowDispatchScheduler(1);
    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot().state).toBe('paused');
    const run = runIn(HANG, { maxWallClockMs: 100, scheduler });
    // Wait out the whole budget while paused — pre-fix the watchdog was
    // armed at creation and fired mid-pause.
    await sleep(150);
    await expectPending(run);

    expect(scheduler.resume()).toBe(true);
    await expect(run).rejects.toThrow(OVER_100);
  });

  it('does not run a script whose signal was already aborted before run()', async () => {
    // The registry (pre-registering the run before run() resolves) and the
    // sandbox share one controller, so a user cancel can land before run():
    // scheduler paused AND signal aborted. The run must settle as cancelled
    // without executing a line of model-authored code.
    const abortOnTimeout = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, abortOnTimeout.signal);
    expect(scheduler.pause()).toBe(true);
    abortOnTimeout.abort();
    const dispatch = vi.fn(async () => 'ignored');
    await rejects(`await agent('never'); ${HANG}`, CANCELLED, {
      dispatch,
      maxWallClockMs: 100,
      scheduler,
      abortOnTimeout,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancellation settles the run at once while the script still runs its own finally', async () => {
    // The host-side run settles immediately and the script's promise
    // finishes on its own: its dispatches reject on the aborted signal, so
    // a `finally` the author wrote still runs.
    const controller = new AbortController();
    const sandbox = sb({
      abortOnTimeout: controller,
      dispatch: () =>
        new Promise<string>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('dispatch aborted')),
            { once: true },
          );
        }),
    });
    const run = sandbox.run(
      `try { await agent('a'); }\nfinally { log('cleanup ran'); }`,
    );
    await sleep(10);
    controller.abort();
    await expect(run).rejects.toThrow(CANCELLED);
    await vi.waitFor(() =>
      expect(sandbox.getLogs().some((l) => l.includes('cleanup ran'))).toBe(
        true,
      ),
    );
  });

  // FIX-E (Round 4 Critical): `deepNullProto` kept Array.prototype on array
  // args, so `args.constructor.constructor("return process")()` returned
  // host process with .env.HOME readable.
  it('blocks args.constructor escape when args is an array', async () => {
    const result = await probeHost(
      'args.constructor.constructor',
      { args: [1, 2, 3] },
      '',
      `'threw'`,
    );
    expect(['undefined', 'threw']).toContain(result);
  });

  // FIX-E: Symbol.iterator path via array's prototype.
  it('blocks args[Symbol.iterator] realm escape when args is an array', async () => {
    const result = await sb({ args: [1, 2, 3] }).run(`try {
        const it = args[Symbol.iterator] && args[Symbol.iterator]();
        if (!it) return 'no-iterator';
        const ctor = it.next.constructor;
        const v = ctor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }`);
    expect(result).not.toMatch(HOST);
    expect(['undefined', 'threw', 'no-iterator']).toContain(result);
  });

  // FIX-F (Round 4 UP Critical): a bare sandbox (the orchestrator always
  // injects real impls) has throwing parallel/pipeline stubs, so a script
  // gets a clear "unavailable" error, not `ReferenceError: parallel is not
  // defined`, which the model would misdiagnose as a bug in its own script.
  it('parallel() throws an availability error rather than ReferenceError when not injected', () =>
    rejects(
      `return parallel([() => agent("a")]);`,
      /parallel\(\) is unavailable/,
    ));

  it('pipeline() throws an availability error rather than ReferenceError when not injected', () =>
    rejects(
      `return pipeline([1, 2], x => x, x => x);`,
      /pipeline\(\) is unavailable/,
    ));

  it('workflow() throws "unavailable" when no workflow impl is injected (bare sandbox / nesting limit)', () =>
    rejects(
      `return workflow('child', { foo: 1 });`,
      /workflow\(\) is unavailable here/,
    ));

  it('workflow() resolves through the injected host impl (single result revived)', async () => {
    const result = await runIn(`return await workflow('child', { foo: 1 });`, {
      workflow: async (nameOrRef, wfArgs) => ({
        echoedRef: nameOrRef,
        echoedArgs: wfArgs,
      }),
    });
    expect(result).toEqual({ echoedRef: 'child', echoedArgs: { foo: 1 } });
  });

  it('workflow({scriptPath}) passes the object ref through to the host impl', async () => {
    let received: unknown;
    await runIn(`return await workflow({ scriptPath: '/tmp/x.js' });`, {
      workflow: async (nameOrRef) => {
        received = nameOrRef;
        return 'ok';
      },
    });
    expect(received).toEqual({ scriptPath: '/tmp/x.js' });
  });

  it('budget.spent() / .remaining() throw with clear P1-unsupported errors', async () => {
    const sandbox = sb();
    await expect(sandbox.run(`return budget.spent();`)).rejects.toThrow(
      /budget\.spent.*not supported in P1/,
    );
    await expect(sandbox.run(`return budget.remaining();`)).rejects.toThrow(
      /budget\.remaining.*not supported in P1/,
    );
  });

  // FIX-H (Round 5 ARCH I1/I2/I3): parallel/pipeline/budget injection seams;
  // P2/P5 provide real impls via SandboxOptions without touching sandbox
  // source.
  it('opts.parallel overrides the throwing stub when provided', async () => {
    const result = await runIn(
      `return await parallel([async () => 1, async () => 2, async () => 3]);`,
      { parallel: parallelAll },
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it('opts.pipeline overrides the throwing stub when provided', async () => {
    const result = await runIn(
      `return await pipeline([1, 2, 3], async (x) => x * 10);`,
      { pipeline: pipelineSeq },
    );
    expect(result).toEqual([10, 20, 30]);
  });

  // SECURITY (PR #4732 P2): host impls resolve with a HOST-realm array that
  // vmAsync passes verbatim, so without in-realm JSON revival
  // `out.constructor.constructor('return process')()` leaks host process.
  // The pre-P2 test probed only the (vm-realm) Promise, not the array.
  it('parallel() RESOLVED array cannot reach host process (revived in-realm)', () =>
    expectSealed(
      'out.constructor.constructor',
      { dispatch: async () => 'ok', parallel: parallelAll },
      'const out = await parallel([async () => 1, async () => 2]);',
    ));

  it('parallel() revives NESTED objects in-realm (not just the outer array)', () =>
    expectSealed(
      'out[0].constructor.constructor',
      { dispatch: async () => 'ok', parallel: parallelAll },
      "const out = await parallel([async () => ({ k: 'v' })]);",
    ));

  it('pipeline() RESOLVED array cannot reach host process (revived in-realm)', () =>
    expectSealed(
      'out.constructor.constructor',
      { dispatch: async () => 'ok', pipeline: pipelineSeq },
      'const out = await pipeline([1, 2], async (x) => x * 10);',
    ));

  it('pipeline() refuses too many stages before they reach the host', async () => {
    const pipeline = vi.fn(async () => []);
    const sandbox = sb({ pipeline });
    const result = await sandbox.run(`
      const stages = Array.from({ length: 4097 }, () => (x) => x);
      try { await pipeline([1], ...stages); return 'resolved'; }
      catch (e) {
        let escaped;
        try {
          escaped = String(e.constructor.constructor('return typeof process')());
        } catch (inner) { escaped = 'threw'; }
        return [e.message, escaped];
      }
    `);
    const [message, escaped] = result as [string, string];
    expect(message).toContain('pipeline() stages: 4097 entries');
    expect(escaped).toMatch(/^undefined|^threw/);
    expect(pipeline).not.toHaveBeenCalled();

    await sandbox.run(`
      await pipeline([1], ...Array.from({ length: 4096 }, () => (x) => x));
    `);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('opts.budget overrides the throwing stub when provided', async () => {
    const result = await runIn(
      `return { total: budget.total, spent: budget.spent(), remaining: budget.remaining() };`,
      {
        budget: { total: 500_000, spent: () => 123, remaining: () => 499_877 },
      },
    );
    expect(result).toEqual({ total: 500_000, spent: 123, remaining: 499_877 });
  });

  // T15 (PR #4732 R1): with opts.budget provided, the wrapper functions must
  // also block the budget.spent.constructor host-Function escape; the other
  // constructor-escape tests only cover the default stub.
  it('opts.budget: spent/remaining constructors stay vm-realm-safe', () =>
    probeHost('budget.spent.constructor.constructor', {
      budget: { total: 100, spent: () => 10, remaining: () => 90 },
    }));

  it('budget.total is null in P1 (matches upstream "no target" sentinel)', async () =>
    expect(await runIn(`return budget.total`)).toBeNull());

  // budget.spent / remaining are built inside the vm init script, so their
  // .constructor is vm-realm Function and never reaches host Function.
  it('budget.spent.constructor cannot reach host process', () =>
    probeHost('budget.spent.constructor.constructor'));

  it('budget.remaining.constructor cannot reach host process', () =>
    probeHost('budget.remaining.constructor.constructor'));

  // FIX-G (Round 4 test Important): Date.parse was implemented but untested;
  // a refactor dropping .parse would leave host Date's parse() leaking real
  // time math.
  it('Date.parse() throws inside sandbox', () =>
    rejects(`return Date.parse("2026-01-01")`, UNAVAILABLE));

  // T6 (Round 1 review Suggestion): validateArgs must reject functions,
  // BigInts and circular references — JSON.stringify would silently drop
  // function-valued keys, and circular refs throw a generic message.
  it('rejects args with function-valued properties', () =>
    expect(() => sb({ args: { fn: () => 1 } })).toThrow(
      /JSON-serializable.*functions/i,
    ));

  it('rejects args with BigInt values', () =>
    expect(() => sb({ args: { n: BigInt(1) } })).toThrow(
      /JSON-serializable.*BigInt/i,
    ));

  it('rejects args with circular references', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => sb({ args: a })).toThrow(/JSON-serializable.*circular/i);
  });

  // Explicit max-depth cap on args nesting.
  it('rejects args with nesting beyond max depth with a clear error', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      cur['nested'] = next;
      cur = next;
    }
    expect(() => sb({ args: deep })).toThrow(/max nesting depth/);
  });

  // P3 (PR #5xxx): agentType / model / isolation pass through to dispatch.
  // Unknown isolation modes (not 'worktree' / 'remote') still throw in the
  // sandbox because no dispatch could give them meaning.
  it('agent() rejects unknown isolation mode with clear error', () =>
    rejects(
      `return agent("hi", { isolation: "not-a-real-mode" });`,
      /unknown isolation mode/,
    ));

  it('agent({isolation:"worktree"}) is passed through to dispatch in P3', async () => {
    const { result, opts } = await agentWith('isolation: "worktree"');
    expect(result).toBe('done');
    expect(opts.isolation).toBe('worktree');
  });

  it('agent({workingDir}) is passed through to dispatch', async () => {
    const { result, opts } = await agentWith(
      'workingDir: ".qwen/tmp/review-pr-7"',
    );
    expect(result).toBe('done');
    expect(opts.workingDir).toBe('.qwen/tmp/review-pr-7');
  });

  it('agent({workingDir}) rejects invalid values', async () => {
    const sandbox = sb();
    // Whitespace-only (the last) used to clear both entrance gates and was
    // refused only deep in the registration gate, with a message blaming the
    // directory instead of the argument.
    for (const value of ['7', '""', '" "']) {
      await expect(
        sandbox.run(`return agent("x", { workingDir: ${value} });`),
      ).rejects.toThrow(/workingDir.*non-empty string/);
    }
  });

  // The options make opposite claims about who owns the directory, so the
  // contradiction is named, not resolved by precedence — a silent winner
  // would leave a script thinking it was isolated when pinned, or vice versa.
  it('agent({workingDir, isolation}) rejects the combination', () =>
    rejects(
      `return agent("x", { workingDir: "wt", isolation: "worktree" });`,
      /incompatible options/,
    ));

  // The schema advertises "0 disables the watchdog", but a non-number was
  // silently dropped downstream where the DEFAULT watchdog applied — the
  // dispatch the author meant to leave unwatched got aborted + retried.
  it('agent({stallMs}) rejects non-numeric values', async () => {
    const sandbox = sb();
    for (const value of ['"0"', 'NaN', 'true']) {
      await expect(
        sandbox.run(`return agent("x", { stallMs: ${value} });`),
      ).rejects.toThrow(/stallMs.*finite number/);
    }
  });

  it('agent({stallMs: 0}) passes through and disables the watchdog', async () => {
    const { result, opts } = await agentWith('stallMs: 0');
    expect(result).toBe('done');
    expect(opts.stallMs).toBe(0);
  });

  it('agent({isolation:"remote"}) is passed through to dispatch in P3', async () =>
    expect((await agentWith('isolation: "remote"')).opts.isolation).toBe(
      'remote',
    ));

  it('agent({model}) is passed through to dispatch in P3', async () =>
    expect((await agentWith('model: "qwen3-max"')).opts.model).toBe(
      'qwen3-max',
    ));

  it('agent({agentType}) is passed through to dispatch in P3', async () =>
    expect((await agentWith('agentType: "Explore"')).opts.agentType).toBe(
      'Explore',
    ));

  // SECURITY (P3 widening): a host-realm object from dispatch (the schema
  // mode payload) is revived per call so its constructor chain stays in the
  // vm realm — the T1/T8/T14 vector closed for parallel/pipeline arrays.
  it('agent() object return cannot reach host process via constructor chain', () =>
    expectSealed(
      'out.constructor.constructor',
      { dispatch: async () => ({ ok: true, leak: 'attempt' }) },
      'const out = await agent("x", { schema: { type: "object" } });',
    ));

  // EAD-1 sibling for agent(): a non-JSON-serializable host return value
  // becomes null at the script boundary instead of throwing the wrapper.
  it('agent() object return that cannot serialize collapses to null', async () => {
    const result = await sb({
      dispatch: async () => {
        const a: { self?: unknown } = {};
        a.self = a;
        return a as unknown as object;
      },
    }).run(`return await agent("x", { schema: { type: "object" } });`);
    expect(result).toBeNull();
  });

  // FIX-C7 (TST-2-I3): the dedup branch in agent({phase}) — consecutive
  // identical opts.phase values must not produce duplicate entries.
  it('agent() opts.phase dedups consecutive identical entries', async () => {
    const { phases } = await traceWith({ dispatch: async () => 'done' })(`
      await agent("a", { phase: "Search" });
      await agent("b", { phase: "Search" });
      await agent("c", { phase: "Verify" });
      await agent("d", { phase: "Verify" });
      await agent("e", { phase: "Search" });
      return 0;`);
    // Dedup is only against the most recent entry, so a phase repeating
    // after a different one is appended again.
    expect(phases).toEqual(['Search', 'Verify', 'Search']);
  });
});

describe('createWorkflowSandbox primitives', () => {
  it('phase() pushes titles in script order', async () => {
    const { phases } = await traceWith()(
      `phase("plan"); phase("build"); return 0`,
    );
    expect(phases).toEqual(['plan', 'build']);
  });

  it('log() accumulates string and non-string arguments', async () => {
    const { logs } = await traceWith()(`log("hi"); log(42); return 0`);
    expect(logs).toEqual(['hi', '42']);
  });

  it('agent() invokes dispatch and resolves with its return value', async () => {
    const { result, calls } = await runRecording(
      `const a = await agent("write hello", { label: "h1" });
       return a;`,
      (prompt) => `echo: ${prompt}`,
    );
    expect(result).toBe('echo: write hello');
    expect(
      calls.map((c) => ({ prompt: c.prompt, label: c.opts.label })),
    ).toEqual([{ prompt: 'write hello', label: 'h1' }]);
  });

  it('agent() runs sequentially when called multiple times', async () => {
    const order: number[] = [];
    let counter = 0;
    const result = await sb({
      dispatch: async () => {
        const myOrder = ++counter;
        await sleep(5);
        order.push(myOrder);
        return String(myOrder);
      },
    }).run(`const a = await agent("first");
      const b = await agent("second");
      return [a, b];`);
    expect(result).toEqual(['1', '2']);
    expect(order).toEqual([1, 2]);
  });

  it('logs non-abort rejections of un-awaited dispatches instead of swallowing them', async () => {
    // An un-awaited agent() refused at entry or failing mid-run reaches no
    // other surface, so its rejection is mirrored into the run log — for the
    // bare call AND a derived `.then()` chain, neither as a process-level
    // unhandledRejection. Attribution differs: the bare call never attached
    // to its root; the chain's fulfillment-only handler did, so only the
    // rejection went unhandled.
    const { logs, unhandled } = await captureWith({
      dispatch: rejecting('dispatch-boom'),
    })(`agent('a'); agent('b').then((v) => 'derived:' + v); return 'done';`);
    expect(logs).toEqual([
      notConsumed('dispatch-boom'),
      notHandled('dispatch-boom'),
    ]);
    expect(unhandled).toEqual([]);
  });

  it('mirrors unconsumed rejections whose message merely contains "aborted"', async () => {
    // Teardown discrimination matches the host error NAME at the vm boundary
    // (the scheduler's DOMException 'AbortError'), never the message text: a
    // genuine 'connection aborted by peer' must still reach the run log.
    const { logs } = await traceWith({
      dispatch: rejecting('connection aborted by peer'),
    })(`agent('a'); return 'done';`);
    expect(logs).toEqual([notConsumed('connection aborted by peer')]);
  });

  it('does not report a rejection the script consumes after a later await', async () => {
    // The verdict defers to run settlement: flaky rejects while the script
    // awaits 'slow', then is consumed — logging it as unconsumed would
    // contradict the 'handled:' entry.
    const { logs } = await traceWith({
      dispatch: (prompt: string) =>
        prompt === 'flaky'
          ? Promise.reject(new Error('flaky-boom'))
          : Promise.resolve('slow-done'),
    })(CONSUME_FLAKY_LATE);
    expect(logs).toEqual(['handled: flaky-boom']);
  });

  it('attributes a fire-and-forget handler failure to the script, not the dispatch', async () => {
    // The dispatch SUCCEEDS but the script's then-handler throws: claiming a
    // dispatch failure would send operators to dispatch / budget gates
    // instead of the script.
    const { logs } = await traceWith({ dispatch: async () => 'not-json' })(
      `agent('fetch').then((r) => JSON.parse(r)); return 'done';`,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(
      /^script handler failed \(rejection not handled\): /,
    );
  });

  it('does not mirror a side branch once the script handles the root rejection', async () => {
    // The script's await-catch handles the root; only an unassigned side
    // branch's derived promise went unconsumed, and mirroring
    // '(result not consumed)' would contradict the script's 'handled:' line.
    const { logs } = await traceWith({ dispatch: rejecting('x-boom') })(`
      const p = agent('x');
      p.then(() => log('side'));
      try { await p; } catch (e) { log('handled: ' + e.message); }
      return 'done';`);
    expect(logs).toEqual(['handled: x-boom']);
  });

  it('does not log teardown abort rejections of un-awaited dispatches', async () => {
    const { teardownError } = await abortedJob();
    const { logs } = await traceWith({
      dispatch: () => Promise.reject(teardownError),
    })(`agent('a'); return 'done';`);
    expect(logs).toEqual([]);
  });

  it('observes teardown rejections of script-derived dispatch chains without unhandledRejection', async () => {
    // R8-7: the abort-noise observer must cover script-derived chains too: a
    // correctly-cancelled run with a pending `.then()` chain fires no
    // process-level unhandledRejection and logs nothing through the chain.
    const { scheduler, teardownError } = await abortedJob();
    const { logs, unhandled } = await captureWith(
      {
        // The bare dispatches stay pending until after the script settles, so
        // their derived chains are still live when the rejections land.
        dispatch: (prompt: string) =>
          prompt === 'keep'
            ? Promise.reject(teardownError)
            : new Promise((_resolve, reject) => {
                setTimeout(() => reject(teardownError), 10);
              }),
        scheduler,
      },
      30,
    )(`
        agent('inflight');
        agent('derived').then((v) => 'derived:' + v);
        try { await agent('keep'); } catch {}
        return 'done';`);
    expect(unhandled).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('does not mirror plain-Error teardown rejections of an aborted run', async () => {
    // R10-1: the dominant cancellation shape is a PLAIN Error, not an
    // 'AbortError' (abort → terminateMode=CANCELLED → dispatch rejects). Once
    // the run's signal fired, that rejection must not log, whatever its name.
    const controller = new AbortController();
    const { dispatch, calls } = pendingDispatch();
    const sandbox = sb({ abortOnTimeout: controller, dispatch });
    const runPromise = sandbox.run(`agent('inflight'); return 'done';`);
    controller.abort();
    calls[0]?.reject(new Error(TERMINATED));
    // The abort arm settles the run as cancelled even though the script had
    // returned — cancel wins a same-tick race, matching the runner, which
    // reports a cancelled registry entry over an ok outcome.
    await expect(runPromise).rejects.toThrow(CANCELLED);
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('mirrors plain-Error rejections while the run signal is not aborted', async () => {
    // Companion: with nothing aborted the same plain Error is a genuine
    // failure, so the isRunAborted teardown clause must not widen the
    // name-based suppression.
    const { logs } = await traceWith({
      abortOnTimeout: new AbortController(),
      dispatch: rejecting(TERMINATED),
    })(`agent('a'); return 'done';`);
    expect(logs).toEqual([notConsumed(TERMINATED)]);
  });

  it('mirrors an unconsumed dispatch failure behind a fire-and-forget finally', async () => {
    // R10-3: finally rethrows — it is not a rejection handler — so
    // agent(...).finally(...) with no downstream catch must still reach the
    // mirror, and not as a process-level unhandledRejection.
    const { logs, unhandled } = await captureWith({
      dispatch: rejecting('dispatch-boom'),
    })(`agent('a').finally(() => log('attempted a')); return 'done';`);
    expect(unhandled).toEqual([]);
    // finally attaches to the root (like a fulfillment-only .then chain), so
    // the attribution is '(rejection not handled)'.
    expect(logs).toEqual(['attempted a', notHandled('dispatch-boom')]);
  });

  it('does not mirror a finally-chained rejection the script consumes', async () => {
    // The finally callback runs, then the await-catch consumes the
    // propagated rejection; the mirror stays silent as for a direct one.
    const { logs } = await traceWith({ dispatch: rejecting('boom') })(`
      try { await agent('a').finally(() => log('cleaned up')); }
      catch (e) { log('handled: ' + e.message); }
      return 'done';`);
    expect(logs).toEqual(['cleaned up', 'handled: boom']);
  });

  /** Rejects the 'bad' prompt with `all-boom`; answers the rest. */
  const badAllBoom = (prompt: string) =>
    prompt === 'bad'
      ? Promise.reject(new Error('all-boom'))
      : Promise.resolve('ok:' + prompt);

  it('mirrors an unconsumed static Promise.all aggregate holding a failed dispatch', async () => {
    // R10-9: the native static's aggregate bypasses the observed then, so
    // without the static wrapper it escaped the mirror as a process-level
    // unhandledRejection (Node's default kills headless hosts). ONE line: the
    // static's attach consumes the elements; only the aggregate reports.
    const { logs, unhandled } = await captureWith({ dispatch: badAllBoom })(
      `Promise.all([agent('a'), agent('bad')]); return 'done';`,
    );
    expect(unhandled).toEqual([]);
    expect(logs).toEqual([notConsumed('all-boom')]);
  });

  it('does not mirror a static Promise.all aggregate the script consumes', async () => {
    // Consumption is tracked through the wrapped aggregate's own observed
    // then: an awaited aggregate is handled, no mirror line.
    const { logs } = await traceWith({ dispatch: badAllBoom })(`
      try { await Promise.all([agent('a'), agent('bad')]); }
      catch (e) { log('handled: ' + e.message); }
      return 'done';`);
    expect(logs).toEqual(['handled: all-boom']);
  });

  // R11-3: await / Promise.resolve adopt an ObservedPromise through the
  // observed then with the adopter's native capability pair. Adoption
  // consumes (clearing a recorded verdict) but is NOT handling: the rejection
  // moves into the unobserved adopter, and the run-level escape hook surfaces
  // forgotten transfers that would otherwise leave no log, alarm or telemetry.
  it('mirrors a forgotten dispatch failure inside an async wrapper (adoption escape)', async () => {
    const { logs, unhandled } = await captureWith({
      dispatch: rejecting('kaboom'),
    })(`async function step() { await agent('x'); } step(); return 'done';`);
    expect(logs).toEqual([notHandled('kaboom')]);
    // The escape event cannot be cancelled from inside the sandbox (the
    // adopting promise is unreachable), so a host listener still sees it;
    // capturing it keeps it out of the test runner.
    expect(unhandled.length).toBeGreaterThan(0);
  });

  it('mirrors every forgotten dispatch failure in an adoption fan-out', async () => {
    const { logs } = await captureWith({
      dispatch: (prompt: string) => Promise.reject(new Error(prompt + '-boom')),
    })(`[1, 2].map(async (i) => { await agent('x' + i); }); return 'done';`);
    expect(logs).toEqual([notHandled('x1-boom'), notHandled('x2-boom')]);
  });

  it('does not mirror a dispatch failure the script awaits at the top level', async () => {
    // Adoption moves the rejection into the script IIFE, which the run
    // observes: it surfaces as the run's own error, never as a mirror line.
    const sandbox = sb({ dispatch: rejecting('kaboom') });
    await expect(sandbox.run(`return await agent('x');`)).rejects.toThrow(
      'kaboom',
    );
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('does not mirror a dispatch failure the script catches around an await', async () => {
    const { logs } = await traceWith({ dispatch: rejecting('kaboom') })(
      `try { await agent('x'); } catch (e) { log('handled: ' + e.message); }\nreturn 'done';`,
    );
    expect(logs).toEqual(['handled: kaboom']);
  });

  it('clears a recorded verdict when the rejection is adopted late', async () => {
    // The root rejects while unconsumed (verdict recorded), then
    // Promise.resolve adopts it — adoption must clear the verdict exactly
    // like a delayed await.
    const { logs } = await traceWith({ dispatch: rejecting('kaboom') })(`
      const p = agent('x');
      const q = Promise.resolve(p);
      try { await q; } catch (e) { log('handled: ' + e.message); }
      return 'done';`);
    expect(logs).toEqual(['handled: kaboom']);
  });

  it('attributes an all-rejected Promise.any aggregate to the dispatch, not the script', async () => {
    // R11-4: the native static rejects with a fresh vm-realm AggregateError
    // carrying no markers; attribution must come from the element causes
    // instead of blaming the script.
    const { logs } = await traceWith({ dispatch: rejecting('any-boom') })(
      `Promise.any([agent('a'), agent('b')]); return 'done';`,
    );
    expect(logs).toEqual([notConsumed('All promises were rejected')]);
  });

  it('dedupes one failed dispatch fanned out into N unconsumed branches', async () => {
    // R11-11: the mirror records one entry per observed node, but one failed
    // dispatch is one failure — the flush emits exactly one line whatever
    // the fan-out.
    const { logs } = await captureWith({ dispatch: rejecting('x-boom') })(
      `const p = agent('x'); p.then(() => 1); p.then(() => 2); return 'done';`,
    );
    expect(logs).toEqual([notHandled('x-boom')]);
  });

  it('does not mirror a side branch once the script attached a rejection handler to the root', async () => {
    // R11-14: suppression keys on rejectionHandled alone — with a script
    // catch on the root, an unconsumed fulfillment-only side branch stays
    // silent even though its own entry is dispatch-failed.
    const { logs } = await captureWith({ dispatch: rejecting('x-boom') })(`
        const p = agent('x');
        p.catch(() => log('handled'));
        p.then((v) => v);
        return 'done';`);
    expect(logs).toEqual(['handled']);
  });

  it('does not mirror an unconsumed aggregate once the script handles the element rejection', async () => {
    // R11-15: aggregate roots track rejectionHandled independently of their
    // elements' roots; handling the element must transitively suppress the
    // forwarded rejection on the dangling aggregate.
    const { logs } = await traceWith({ dispatch: rejecting('x-boom') })(`
      const a = agent('x');
      Promise.all([a]);
      await a.catch((e) => log('handled: ' + e.message));
      return 'done';`);
    expect(logs).toEqual(['handled: x-boom']);
  });

  it('preserves the species contract for script-defined Promise subclasses', async () => {
    // R11-16: Promise.all/race/any on a subclass must return a subclass
    // instance; the wrappers skip observation for non-default receivers
    // instead of re-wrapping into ObservedPromise.
    const result = await sb({ dispatch: async () => 'ok' }).run(`
      class P extends Promise {}
      const x = P.all([agent('a')]);
      const y = P.race([agent('b')]);
      const z = P.any([agent('c')]);
      return [x instanceof P, y instanceof P, z instanceof P];`);
    expect(result).toEqual([true, true, true]);
  });

  it('mirrors an unconsumed static Promise.race aggregate holding a failed dispatch', async () => {
    // R11-21: race and any aggregates need the observation the all aggregate
    // has — else a fire-and-forget race holding a failed dispatch escapes as
    // a process-level unhandledRejection.
    const { logs, unhandled } = await captureWith({
      dispatch: (prompt: string) =>
        prompt === 'bad'
          ? Promise.reject(new Error('bad-boom'))
          : new Promise<string>(() => {}),
    })(`Promise.race([agent('slow'), agent('bad')]); return 'done';`);
    expect(unhandled).toEqual([]);
    expect(logs).toEqual([notConsumed('bad-boom')]);
  });

  it('does not mirror Promise.any teardown rejections of an aborted run', async () => {
    // R11-30: the AggregateError carries no abort marker, so the observer
    // must also consult the run-level abort state — a correctly-cancelled
    // run with a dangling any() stays silent.
    const controller = new AbortController();
    const { dispatch, calls } = pendingDispatch();
    const sandbox = sb({ abortOnTimeout: controller, dispatch });
    await sandbox.run(`Promise.any([agent('a'), agent('b')]); return 'done';`);
    controller.abort();
    for (const { reject } of calls) {
      reject(new Error('teardown after cancel'));
    }
    await sleep(10);
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('does not mirror a post-settlement rejection whose root the script handled', async () => {
    // R11-20: pins the suppression gate in the immediate-mirror path — a
    // slow dispatch the script caught rejects only after the flush, and the
    // rejectionHandled gate keeps the self-contradicting line out of the log.
    const { dispatch, calls } = pendingDispatch();
    const sandbox = sb({ dispatch });
    await sandbox.run(`
      const p = agent('slow');
      p.catch(() => log('handled late'));
      p.then((v) => v);
      return 'done';`);
    calls[0]?.reject(new Error('slow-boom'));
    await captureUnhandled(() => sleep(10));
    expect(sandbox.getLogs()).toEqual(['handled late']);
  });

  it('flushes mirror entries when the script throws synchronously after a fire-and-forget dispatch', async () => {
    // R11-10 companion: the flush sits in the finally around the whole run
    // body, so any throw path surfaces queued entries. (The 30s sync vm
    // timeout is the other sync-throw path, impractical in unit tests.)
    const sandbox = sb({ dispatch: rejecting('boom') });
    await expect(
      sandbox.run(`agent('a'); throw new Error('script-sync-boom');`),
    ).rejects.toThrow('script-sync-boom');
    expect(sandbox.getLogs()).toEqual([notConsumed('boom')]);
  });

  it('keeps then() native-compatible when the rejection handler is a revoked Proxy', async () => {
    // R11-26: handler introspection must be guarded — property reads on a
    // revoked Proxy wrapping a function throw, and an unguarded read made
    // .then() throw synchronously (which native then never does).
    const { result } = await captureWith({ dispatch: rejecting('kaboom') })(`
        const pair = Proxy.revocable(function () {}, {});
        pair.revoke();
        agent('x').then(undefined, pair.proxy);
        return 'done';`);
    expect(result).toBe('done');
  });

  it('mirrors an exotic rejection value whose message access throws', async () => {
    // R10-12: a script handler may throw a value whose property access throws
    // (getter / Proxy trap); an observer dying mid-body would turn the watched
    // rejection into the process-level unhandledRejection it exists to remove.
    const { logs, unhandled } = await captureWith({
      dispatch: async () => 'ok',
    })(`agent('x').then(() => {
          throw { get message() { throw new Error('getter-boom'); } };
        }); return 'done';`);
    expect(unhandled).toEqual([]);
    expect(logs).toEqual([
      'script handler failed (rejection not handled): [unserializable rejection value]',
    ]);
  });

  it('clears a recorded script-handler failure when the script consumes it late', async () => {
    // R10-5 probe gate: the dispatch succeeds, the script's handler rejects;
    // it is recorded at settlement and consumed by a later await. Without
    // wfClearUnconsumed's unconsumedRejections.delete(id) the flush would
    // still report it (the rejectionHandled skip covers dispatchFailed only).
    const { logs } = await traceWith({
      dispatch: (prompt: string) =>
        prompt === 'slow'
          ? new Promise((resolve) => setTimeout(() => resolve('slow-done'), 20))
          : Promise.resolve('fast-done'),
    })(`
      const p = agent('fast').then(() => {
        throw new Error('handler-boom');
      });
      await agent('slow');
      try { await p; } catch (e) { log('handled: ' + e.message); }
      return 'done';`);
    expect(logs).toEqual(['handled: handler-boom']);
  });

  it('gives each run() on a reused sandbox a fresh unconsumed-rejection verdict', async () => {
    // R10-6/R10-7 probe gate: bookkeeping is per-run. Run 1's entry must not
    // re-log on run 2's flush (map reset), and run 3 must still take the
    // deferred path — a latched unconsumedSettled would force the immediate
    // mirror and its self-contradicting 'dispatch failed...' + 'handled:'.
    let shouldReject = true;
    const sandbox = sb({
      dispatch: (prompt: string) => {
        if (prompt === 'flaky' && shouldReject) {
          return Promise.reject(new Error('flaky-boom'));
        }
        return Promise.resolve('ok');
      },
    });
    await sandbox.run(`agent('flaky'); return 'done';`);
    expect(sandbox.getLogs()).toEqual([notConsumed('flaky-boom')]);

    shouldReject = false;
    await sandbox.run(`agent('flaky'); return 'done';`);
    expect(sandbox.getLogs()).toEqual([notConsumed('flaky-boom')]);

    shouldReject = true;
    await sandbox.run(CONSUME_FLAKY_LATE);
    expect(sandbox.getLogs()).toEqual([
      notConsumed('flaky-boom'),
      'handled: flaky-boom',
    ]);
  });

  // T5 (Round 1 review Suggestion): console.log/warn/error must route to
  // getLogs() — dropping the routing would silently break model scripts
  // that use console for diagnostics.
  it('console.log / warn / error route to getLogs()', async () => {
    const { logs } = await traceWith()(
      `console.log("info"); console.warn("warn"); console.error("err"); return 0;`,
    );
    expect(logs).toEqual(['info', 'warn', 'err']);
  });

  it('full P1 acceptance script: phase + agent returns expected value', async () => {
    const { result, phases } = await traceWith({
      dispatch: async (prompt) => `agent-response:${prompt}`,
    })(`
      phase("plan");
      const out = await agent("write a hello", { label: "h1" });
      return out;`);
    expect(result).toBe('agent-response:write a hello');
    expect(phases).toEqual(['plan']);
  });

  // ── Compilation ──────────────────────────────────────────────────────
  describe('compileWorkflowScript', () => {
    // Issue #12217: model-authored scripts commonly start with a header
    // comment that the user did not strip by hand. The regex must allow
    // leading line and block comments without re-introducing the T33 risk
    // (no `/m`, no inner-of-template-literal false match). Exercised through
    // `compileWorkflowScript` — the production entry — so a regression
    // surfaces as a V8 syntax error, not just a wrong string.
    describe('#12217 leading comments', () => {
      it('compiles a workflow whose meta is preceded by a single-line comment', () => {
        const src = `// note\nexport const meta = { name: 'x', description: 'd' }\nreturn 1;`;
        const { meta } = compileWorkflowScript(src);
        expect(meta).toEqual({ name: 'x', description: 'd' });
      });

      it('compiles a workflow whose meta is preceded by a block comment', () => {
        const src = `/* note */\nexport const meta = { name: 'x', description: 'd' }\nreturn 1;`;
        const { meta } = compileWorkflowScript(src);
        expect(meta).toEqual({ name: 'x', description: 'd' });
      });

      it('compiles a workflow whose meta is preceded by mixed comments', () => {
        const src = `// first\n// second\n/* third */\nexport const meta = { name: 'x', description: 'd' }\nreturn 1;`;
        const { meta } = compileWorkflowScript(src);
        expect(meta).toEqual({ name: 'x', description: 'd' });
      });

      it('does not match meta inside a template literal even with a leading comment (#12217 × T33)', () => {
        const src = `// header\nconst banner = \`\nexport const meta = { name: 'fake' }\n\`;\nreturn banner;`;
        const { meta } = compileWorkflowScript(src);
        expect(meta).toBeNull();
      });

      it('does not false-match a brace inside a leading line comment', () => {
        const src = `// { what: 'fake' }\nexport const meta = { name: 'real', description: 'real' }\nreturn 1;`;
        const { meta } = compileWorkflowScript(src);
        expect(meta).toEqual({ name: 'real', description: 'real' });
      });

      it('does not false-match a meta-looking line inside a leading block comment (#12217 × T33)', () => {
        const src = `/* header with export const meta = { name: 'fake' } inside */\nexport const meta = { name: 'real', description: 'real' }\nreturn 1;`;
        const { meta } = compileWorkflowScript(src);
        expect(meta).toEqual({ name: 'real', description: 'real' });
      });

      // R1-1: all four ECMAScript LineTerminators in leading comment
      it.each([
        [
          'CR only',
          `// header\rexport const meta = { name: 'real', description: 'd' }\nreturn 1;`,
        ],
        [
          'LF only',
          `// header\nexport const meta = { name: 'real', description: 'd' }\nreturn 1;`,
        ],
        [
          'CR+LF',
          `// header\r\nexport const meta = { name: 'real', description: 'd' }\nreturn 1;`,
        ],
        [
          'LS only',
          `// header\u2028export const meta = { name: 'real', description: 'd' }\nreturn 1;`,
        ],
        [
          'PS only',
          `// header\u2029export const meta = { name: 'real', description: 'd' }\nreturn 1;`,
        ],
      ])(
        'handles all four ECMAScript line terminators in leading comment (%s)',
        (_case, src) => {
          const { meta } = compileWorkflowScript(src);
          expect(meta).toEqual({ name: 'real', description: 'd' });
        },
      );

      // #12651 R1-2: with skipTrivia the meta anchor sits past the leading
      // comment, so the stripped source must retain the comment verbatim —
      // the same `slice(0, exportIdx)` term compileWorkflowScript builds
      // its compilable copy from. Under the old ^-anchored regex that term
      // was provably '' and the comment disappeared from the compiled
      // program while all assertions on `meta` stayed green.
      it('keeps the leading comment in the stripped script (#12651)', () => {
        const src = `// note\nexport const meta = { name: 'x', description: 'd' }\nreturn 1;`;
        const { stripped, meta } = extractAndStripMeta(src);
        expect(meta).toEqual({ name: 'x', description: 'd' });
        expect(stripped.startsWith('// note\n')).toBe(true);
        expect(stripped.endsWith('\nreturn 1;')).toBe(true);
      });

      // #12651 R1-3: the brace-walker's `//` skip must also end at any
      // LineTerminator — a CR-only note inside the meta block used to scan
      // for \n to end-of-source and hit the unbalanced-brace throw.
      it('parses a meta block whose body lines and inner comment are CR-separated (#12651)', () => {
        const src = `export const meta = {\r // note\r name: 'x',\r description: 'd'\r}\rreturn 1;`;
        const { meta } = compileWorkflowScript(src);
        expect(meta).toEqual({ name: 'x', description: 'd' });
      });
    });

    it('compiles a body and hands back its meta', () => {
      const { script, meta } = compileWorkflowScript(
        "export const meta = { name: 'n', description: 'd' }\nawait agent('x');",
      );
      expect(script).toBeDefined();
      expect(meta?.name).toBe('n');
    });

    it('throws on a body that does not parse', () =>
      expect(() => compileWorkflowScript("const x: string = 'a';")).toThrow(
        SyntaxError,
      ));

    // Strict mode: an undeclared assignment throws instead of quietly
    // creating a sandbox global that outlives the statement. Asserted via a
    // real run, since the directive only matters at execution time.
    it('runs the body in strict mode', () =>
      rejects('undeclaredBinding = 1;', /not defined/, {
        dispatch: async () => 'ok',
      }));

    it('still allows a declared binding', () =>
      expect(
        runIn('const declared = 1; return declared;', {
          dispatch: async () => 'ok',
        }),
      ).resolves.toBe(1));
  });

  describe('dynamic import() refusal', () => {
    function refusal(source: string): WorkflowUnsupportedSyntaxError {
      try {
        compileWorkflowScript(source);
      } catch (e) {
        expect(e).toBeInstanceOf(WorkflowUnsupportedSyntaxError);
        return e as WorkflowUnsupportedSyntaxError;
      }
      throw new Error('expected the source to be refused');
    }

    it.each([
      ['awaited after an agent', "await agent('a');\nawait import('node:fs');"],
      ['not awaited', "import('node:fs');\nreturn 1;"],
      ['in a dead branch', "if (false) { await import('node:fs'); }"],
      [
        'in a function that is never called',
        "function load() { return import('node:fs'); }",
      ],
      ['in a template substitution', "const s = `${import('node:fs')}`;"],
      ['with a comment between the tokens', "import /* x */ ('node:fs');"],
      [
        'with a computed module name',
        "const m = 'node:' + 'fs'; await import(m);",
      ],
      ['with import options', "await import('x.json', { with: {} });"],
    ])('refuses import() %s before running', (_name, source) => {
      expect(refusal(source).message).toMatch(
        /dynamic import\(\) is not supported in workflow scripts/,
      );
    });

    it('never dispatches an agent that precedes the import', async () => {
      const dispatch = vi.fn(async () => 'ok');
      await rejects(
        "await agent('must-not-run');\nimport('node:fs');",
        /dynamic import\(\)/,
        { dispatch },
      );
      expect(dispatch).not.toHaveBeenCalled();
    });

    it.each([
      ['a string', 'return \'import("node:fs")\';'],
      ['a line comment', "// import('node:fs')\nreturn 1;"],
      ['a block comment', "/* import('node:fs') */ return 1;"],
      ['a regex literal', "return /import\\('node:fs'\\)/.source.length > 0;"],
      ['template text', "return `import('node:fs')`.length > 0;"],
      ['a member call', 'const o = { import: () => 1 }; return o.import();'],
      [
        'an object method',
        'return ({ import() { return 1; } }).import() === 1;',
      ],
      ['a property key', "return ({ 'import': 1 }).import === 1;"],
    ])('runs a script with import in %s', async (_name, source) => {
      await expect(runIn(source)).resolves.toBeTruthy();
    });

    it('reports the line the author wrote after a multiline meta block', () => {
      const source = `export const meta = {
  name: 'n',
  description: 'd',
}
await agent('a');
await import('node:fs');`;
      expect(refusal(source).message).toMatch(/^line 6: /);
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
      ['lone CR', '\r'],
      ['U+2028', '\u2028'],
    ])('counts %s line breaks like the author', (_name, separator) => {
      const source = ['const a = 1;', 'const b = 2;', "import('x');"].join(
        separator,
      );
      expect(refusal(source).message).toMatch(/^line 3: /);
    });

    it('reports the first import when there are several', () => {
      expect(
        refusal("const a = 1;\nimport('a');\nimport('b');").message,
      ).toMatch(/^line 2: /);
    });

    it.each([
      ['a class static block', "class A { static { import('node:fs'); } }"],
      ['a class field', "class A { f = import('node:fs'); }"],
      ['a private static field', "class A { static #f = import('node:fs'); }"],
      ['a parameter default', "function f(a = import('node:fs')) {}"],
    ])('refuses import() in %s', (_name, source) => {
      expect(refusal(source).message).toMatch(
        /^line 1: dynamic import\(\) is not supported/,
      );
    });

    // Newer V8 compiles `import.source()`, which the parser does not know.
    // Whichever of the two refuses it, the script must not run unchecked, and
    // a parser refusal carries its own cause rather than the syntax hint.
    it('refuses a body the parser cannot read even when V8 compiles it', () => {
      let caught: unknown;
      try {
        compileWorkflowScript("import.source('x');");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      if (!(caught instanceof SyntaxError)) {
        expect(caught).toBeInstanceOf(WorkflowUnsupportedSyntaxError);
        expect((caught as Error).message).toMatch(
          /^line 1: the script could not be checked for unsupported syntax/,
        );
      }
    });

    it('refuses with its own cause when the walk itself fails', () => {
      walkFailure.fail = true;
      try {
        expect(() => compileWorkflowScript('return 1;')).toThrow(
          WorkflowUnsupportedSyntaxError,
        );
        expect(() => compileWorkflowScript('return 1;')).toThrow(
          /could not be checked for unsupported syntax: baseVisitor/,
        );
      } finally {
        walkFailure.fail = false;
      }
    });

    it('leaves an ordinary syntax error to V8', () => {
      expect(() =>
        compileWorkflowScript("await import('x');\nconst x: string = 'a';"),
      ).toThrow(SyntaxError);
    });

    it('accepts modern syntax V8 compiles', () => {
      expect(() =>
        compileWorkflowScript(
          [
            'class A { static #n = 1; static get n() { return A.#n; } }',
            'const o = { a: { b: 1 } }; const v = o?.a?.b ?? 0;',
            'let x = 0; x ||= 1; x &&= 2; x ??= 3;',
            'const big = 1_000n; const re = /a/v;',
            'for await (const r of [Promise.resolve(1)]) {}',
            'label: { break label; }',
            'return [A.n, v, x, big, re, Object.groupBy([], () => 1)];',
          ].join('\n'),
        ),
      ).not.toThrow();
    });
  });

  describe('describeWorkflowCompileError', () => {
    function renderFor(source: string): string {
      try {
        compileWorkflowScript(source);
      } catch (e) {
        return describeWorkflowCompileError(
          e,
          source.split(/\r\n|[\n\r\u2028\u2029]/).length,
        );
      }
      throw new Error('expected the source to fail compilation');
    }

    // The wrapper shifts every body line by one, so V8's own line number is
    // one more than the author's. Reporting the raw number sends them to the
    // wrong line, which is worse than reporting none.
    it('reports the line number the author wrote, not the wrapped one', () => {
      const rendered = renderFor("await agent('a');\nconst x: string = 1;");
      expect(rendered).toContain('line 2');
      expect(rendered).not.toContain('workflow.js');
      expect(rendered).toContain(
        'SyntaxError: Missing initializer in const declaration',
      );
    });

    it('preserves author line numbers after a multiline meta block', () => {
      const rendered = renderFor(`export const meta = {
  name: 'n',
  description: 'd',
}
await agent('a');
const x: string = 1;`);
      expect(rendered.split('\n')[0]).toBe('line 6');
      expect(rendered).toContain('const x: string = 1;');
    });

    it.each([
      ['CRLF', '\r\n'],
      ['lone CR', '\r'],
    ])(
      'preserves author line numbers after a meta block with %s separators',
      (_name, separator) => {
        const rendered = renderFor(
          [
            'export const meta = {',
            "  name: 'n',",
            "  description: 'd',",
            '}',
            'const x: string = 1;',
          ].join(separator),
        );
        expect(rendered.split('\n')[0]).toBe('line 5');
        expect(rendered).toContain('const x: string = 1;');
      },
    );

    it('does not attribute a closing-wrapper error to the author', () => {
      const rendered = renderFor('await agent(');
      expect(rendered).toContain('unmatched or incomplete syntax');
      expect(rendered).toContain('braces');
      expect(rendered).not.toContain("Unexpected token '}'");
      expect(rendered).not.toContain('line 2');
      expect(rendered).not.toContain('})()');
    });

    it('carries the offending source line and a caret under it', () => {
      const rendered = renderFor('const x: string = 1;');
      const lines = rendered.split('\n');
      expect(lines[1]).toContain('const x');
      expect(lines[2]).toContain('^');
      // The caret has to sit under the source line, not float past its end.
      expect(lines[2].indexOf('^')).toBeLessThanOrEqual(lines[1].length);
    });

    it('windows a long line while keeping the caret aligned', () => {
      const padding = 'y'.repeat(300);
      const rendered = renderFor(
        `const a = '${padding}'; const x: string = 1;`,
      );
      const lines = rendered.split('\n');
      expect(lines[1].length).toBeLessThan(120);
      expect(lines[1]).toContain('…');
      expect(lines[2]).toContain('^');
      expect(lines[2].indexOf('^')).toBe(lines[1].indexOf('x: string'));
    });

    it('preserves a multi-column V8 caret on a long line', () => {
      const padding = 'y'.repeat(120);
      const rendered = renderFor(`const pad = '${padding}'; const x = 123abc;`);
      const lines = rendered.split('\n');
      expect(lines[1]).toContain('123abc');
      expect(lines[2]).toContain('^^^');
      expect(lines[2].indexOf('^^^')).toBe(lines[1].indexOf('123abc'));
    });

    it('keeps an author source line that begins with at', () => {
      const rendered = renderFor('    at work();');
      expect(rendered).toContain('line 1');
      expect(rendered).toContain('    at work();');
      expect(rendered).toContain('^^^^');
      expect(rendered).toContain("Unexpected identifier 'work'");
    });

    it('omits a long source frame when V8 provides no caret', () => {
      const rendered = renderFor(`const value = ${'a'.repeat(1100)}@;`);
      expect(rendered).toContain('line 1');
      expect(rendered).toContain('SyntaxError: Invalid or unexpected token');
      expect(rendered).not.toContain('const value');
    });

    it('falls back to the plain message when there is no source frame', () =>
      expect(
        describeWorkflowCompileError(new Error('meta must be an object'), 1),
      ).toBe('meta must be an object'));
  });
});
