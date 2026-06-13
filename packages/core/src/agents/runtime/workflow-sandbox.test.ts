/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { stripExportMeta, createWorkflowSandbox } from './workflow-sandbox.js';

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

  // T16 (Round 1 review Suggestion): line comments must skip their contents
  // including stray quotes and braces, otherwise an `it's a plan` comment
  // opens a phantom string literal that walks to EOF.
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

  // T9 / T17 (Round 1 review Critical): refuse to silently delete the script
  // when the meta block has unmatched braces — previously returned `""`
  // which made the workflow appear to succeed while returning nothing.
  it('throws on unbalanced meta braces (does not silently delete script)', () => {
    expect(() => stripExportMeta(`export const meta = { name: 'x'`)).toThrow(
      /unbalanced/i,
    );
  });

  it('throws on meta with unterminated string', () => {
    expect(() =>
      stripExportMeta(`export const meta = { name: 'foo }\nreturn 1`),
    ).toThrow(/unbalanced/i);
  });

  // T33 (PR #4732 R4): the regex must anchor at file start, not at every
  // line start. Without that, a template literal containing
  // `\nexport const meta = {\n` triggers a false match and the brace-walker
  // strips content out of the string body, corrupting the script.
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
});

describe('createWorkflowSandbox', () => {
  it('exposes args verbatim', async () => {
    const sandbox = createWorkflowSandbox({
      args: { question: 'why?' },
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return args.question`);
    expect(result).toBe('why?');
  });

  // FIX-C6 (UP-2-I1): Date.now() throws (matches binary's static-reject
  // intent + matches Math.random treatment). Previously it returned a
  // sentinel which let scripts compute wrong durations silently.
  it('Date.now() throws inside sandbox', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`return Date.now()`)).rejects.toThrow(/Date\.now/);
  });

  it('Math.random() throws inside sandbox', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`return Math.random()`)).rejects.toThrow(
      /Math\.random/,
    );
  });

  it('return statement at top level captures the script result', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return 1 + 2`);
    expect(result).toBe(3);
  });
});

// Security PoC tests — verify that every known realm-escape vector returns
// 'undefined' / safe values rather than the host `process` object.
describe('createWorkflowSandbox security', () => {
  // Round 1 (PR #4732) approach: all globals are built in the vm-realm via
  // an init script. `args.constructor` therefore points at vm-realm Object,
  // `.constructor.constructor` at vm-realm Function, which when invoked
  // runs in the vm realm where `process` is not defined → returns
  // 'undefined' rather than the host process object.
  it('args.constructor.constructor cannot reach host process', async () => {
    const sandbox = createWorkflowSandbox({
      args: { x: 1 },
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const v = args.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 60); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(String(result)).toMatch(/^undefined|^threw/);
  });

  // T1 (Round 1 review Critical): `try { throw } catch(e) { e.constructor }`
  // previously reached the host Function constructor because injected
  // closures threw host-realm Error objects. The vm-realm wrapper now
  // converts every rejection into `new Error(msg)` inside the vm context,
  // so `e.constructor` stays in the vm realm.
  //
  // PR #4947+ note: the schema/model/agentType/isolation opts that used to
  // throw at sandbox level in P1 are wired through to the dispatch in P3.
  // The still-thrown path used here is an INVALID isolation value, which
  // the sandbox refuses with "unknown isolation mode" before reaching
  // dispatch — the throw point this test cares about for the T1 regression.
  it('thrown Error from agent() options validation cannot reach host process', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        await agent("x", { isolation: "not-a-real-mode" });
        return 'no-throw';
      } catch (e) {
        try {
          const v = e.constructor.constructor("return typeof process")();
          return String(v);
        } catch (err) { return 'inner-threw:' + String(err.message).slice(0, 40); }
      }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(String(result)).toMatch(/^undefined|^inner-threw/);
  });

  // T8 / T14 (Round 1 review Critical): the Promise returned by agent() used
  // to be a host-realm Promise; its constructor chain reached host Function.
  // The vm-realm wrapper now returns a vm-realm Promise built via
  // `new Promise(...)` inside the init script.
  it('agent() success-path Promise constructor cannot reach host process', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ok',
    });
    const result = await sandbox.run(`
      const p = agent("x");
      try {
        const v = p.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(String(result)).toMatch(/^undefined|^threw/);
  });

  // Same vector via parallel / pipeline / workflow stubs — they all return
  // vm-realm Promises now.
  it('parallel() Promise constructor cannot reach host process', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ok',
    });
    const result = await sandbox.run(`
      const p = parallel([async () => 1]).catch(() => 0);
      try {
        const v = p.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
  });

  // T13 (Round 1 review Suggestion): the `[key: string]: unknown` index
  // signature lets typos like `scema` past TypeScript. The runtime
  // allowlist throws on any opt name not in the known set.
  it('agent() rejects unknown opts (typo guard)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return agent("hi", { scema: { type: 'object' } });`),
    ).rejects.toThrow(/scema.*unknown option/);
  });

  // T2 (Round 1 review Critical): `Object.setPrototypeOf(out, null)` used to
  // remove Array.prototype, so `for...of`, `.map`, `.forEach`, spread, and
  // destructuring all threw `TypeError: args is not iterable`. The vm-realm
  // approach builds args from vm-realm `JSON.parse`, so they retain
  // vm-realm Array.prototype.
  it('array args support for...of iteration', async () => {
    const sandbox = createWorkflowSandbox({
      args: [1, 2, 3],
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      let sum = 0;
      for (const x of args) sum += x;
      return sum;
    `);
    expect(result).toBe(6);
  });

  it('array args support .map / .filter / spread / destructuring', async () => {
    const sandbox = createWorkflowSandbox({
      args: [1, 2, 3, 4],
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      const doubled = args.map(x => x * 2);
      const evens = args.filter(x => x % 2 === 0);
      const spread = [0, ...args, 5];
      const [first, ...rest] = args;
      return { doubled, evens, spread, first, rest };
    `);
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
    const sandbox = createWorkflowSandbox({
      args: { a: 1, b: 2, c: 3 },
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      const keys = Object.keys(args);
      const vals = Object.values(args);
      const ents = Object.entries(args);
      const spread = { ...args, d: 4 };
      return { keys, vals, ents, spread };
    `);
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
  it('phase global is a vm-realm function (constructor cannot reach host)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const v = phase.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
  });

  // SEC-C2: vm timeout kills a synchronous infinite loop within 30s.
  it('synchronous infinite loop is aborted by vm timeout', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`while(true){}`)).rejects.toThrow(
      /Script execution timed out/i,
    );
  }, 35_000); // wall clock for the test itself

  // P3 (PR #5xxx): schema / model / agentType / isolation are passed through
  // to the dispatch in P3. The sandbox no longer rejects them — the dispatch
  // is responsible for surfacing "agent type not found", "isolation:'remote'
  // is not available in this build", and the StructuredOutput contract.
  // Sandbox-level rejection only remains for invalid isolation modes (not
  // 'worktree' / 'remote'), which is covered by the security regression
  // test above.
  it('agent({schema}) is passed through to dispatch in P3', async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, opts });
        return { ok: true, echoed: prompt };
      },
    });
    const result = await sandbox.run(
      `return await agent("hi", { schema: { type: "object", properties: { ok: { type: "boolean" } } } });`,
    );
    expect(seen).toHaveLength(1);
    expect((seen[0].opts as { schema?: unknown }).schema).toBeDefined();
    // Result is the revived object payload.
    expect(result).toEqual({ ok: true, echoed: 'hi' });
  });

  // UP-C1: agent({phase}) is honored — pushed to the phases array.
  it('agent() honors opts.phase by appending to phases', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (_p, opts) => `done:${opts.phase ?? 'no-phase'}`,
    });
    const result = await sandbox.run(`
      return await agent("x", { phase: "Search" });
    `);
    expect(result).toBe('done:Search');
    expect(sandbox.getPhases()).toEqual(['Search']);
  });

  // SEC-I2: log() must cap at MAX_LOG_LINES and add a truncation marker.
  it('log() caps at MAX_LOG_LINES with a truncation marker', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(`for (let i = 0; i < 10100; i++) log(i); return 0;`);
    const logs = sandbox.getLogs();
    expect(logs.length).toBe(10_001); // 10_000 entries + 1 truncation marker
    expect(logs[10_000]).toMatch(/truncated/);
  });

  // FIX-C5 (SEC-2-I1): same cap pattern for phases array — protects host
  // from `for(let i=0;i<1e6;i++) phase("p"+i)` style memory bombs.
  it('phase() caps at MAX_PHASE_ENTRIES with a truncation marker', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(
      `for (let i = 0; i < 10100; i++) phase("p"+i); return 0;`,
    );
    const phases = sandbox.getPhases();
    expect(phases.length).toBe(10_001);
    expect(phases[10_000]).toMatch(/truncated/);
  });

  // FIX-C1 (SEC-2-C1): Round 2 PoC — `Math.constructor.constructor("return process")()`
  // reaches host realm because Math is the host realm's Math object. The Proxy
  // `get` trap on `constructor` blocks the chain.
  it('blocks Math.constructor realm escape', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      const ctor = Math.constructor;
      return ctor === undefined ? 'blocked' : 'leaked:' + typeof ctor;
    `);
    expect(result).toBe('blocked');
  });

  // FIX-D (Round 3 SEC C1): Math is now constructed in vm realm as a
  // null-proto object. getOwnPropertyDescriptor returns a real descriptor,
  // but invoking `.value()` still throws the "Math.random unavailable"
  // error — the original goal (preventing real-random leakage) is preserved.
  it('Math.random descriptor.value() still throws the unavailable error', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`
        const d = Object.getOwnPropertyDescriptor(Math, 'random');
        return d.value();
      `),
    ).rejects.toThrow(/Math\.random/);
  });

  // FIX-D (Round 3 SEC-C1 PoC): Round 3 adversarial reviewer confirmed PoC
  // that `Math.__proto__.constructor.constructor("return process")()` reached
  // the host `process` object (returned darwin:pid). After Fix D, Math is
  // a null-proto vm-realm object, so __proto__ is undefined.
  it('Math.__proto__ is undefined (blocks proto-chain escape)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return Math.__proto__`);
    expect([null, undefined]).toContain(result);
  });

  // FIX-D (Round 3 SEC-C2): Math.toString used to reach host
  // Function.prototype.toString, whose .constructor is host Function.
  // After Fix D, Math has no inherited toString (null-proto).
  it('Math.toString is undefined (blocks inherited-method escape)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return typeof Math.toString`);
    expect(result).toBe('undefined');
  });

  // FIX-D (Round 3 TST-C1): Math.abs.constructor used to reach host Function.
  // After Fix D, Math.abs is a vm-realm function. Its constructor is vm-realm
  // Function — invoking it cannot access host process (process is undefined
  // in vm globals).
  it('Math.abs.constructor cannot reach host process', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const v = Math.abs.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }
    `);
    // process is not in vm globals → typeof process === 'undefined'.
    // Either way (caught or undefined), no host info leaks.
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(['undefined', 'threw']).toContain(result);
  });

  // FIX-D (Round 3 SEC-C3): Date.constructor used to reach host Object,
  // whose .constructor is host Function. After Fix D, Date is a vm-realm
  // function with null prototype; .constructor is undefined.
  it('Date.constructor is undefined (blocks Date-object escape)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return Date.constructor`);
    expect(result).toBeUndefined();
  });

  // FIX-D (Round 3 UP-C1): new Date() previously fell through to the host
  // Date constructor and leaked real wall-clock time. After Fix D, the Date
  // stub is itself a throwing function; `new Date()` triggers [[Construct]]
  // which invokes [[Call]] → throws.
  it('new Date() throws inside sandbox', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`return new Date()`)).rejects.toThrow(
      /unavailable in workflow scripts/i,
    );
  });

  it('Date() (bare call) throws inside sandbox', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`return Date()`)).rejects.toThrow(
      /unavailable in workflow scripts/i,
    );
  });

  it('Date.UTC() throws inside sandbox', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`return Date.UTC(2026, 0, 1)`)).rejects.toThrow(
      /unavailable in workflow scripts/i,
    );
  });

  // FIX-D: console object itself is hardened (null proto + .constructor
  // undefined), blocking `console.constructor.constructor` escape.
  it('console.constructor is undefined (blocks container-object escape)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return console.constructor`);
    expect(result).toBeUndefined();
  });

  // T22 (PR #4732 R2): `globalThis` itself used to be a host-realm plain
  // object literal whose `.constructor` reached the host Object → host
  // Function → host process. PoC: `globalThis.constructor.constructor(
  // "return process")()` returned host process with .env/.platform/.pid
  // readable. Fix severs sandboxGlobals's prototype before createContext.
  it('blocks globalThis.constructor host-realm escape', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const Obj = globalThis.constructor;
        if (!Obj) return 'no-ctor';
        const Fn = Obj.constructor;
        if (!Fn) return 'no-inner-ctor';
        const v = Fn("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(['no-ctor', 'no-inner-ctor', 'undefined', 'threw']).toContain(
      result,
    );
  });

  // T22: same root via implicit `this` (== globalThis at top level).
  it('blocks implicit globalThis (this) host-realm escape', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const t = (function(){ return this; })();
        if (!t || !t.constructor || !t.constructor.constructor) return 'blocked';
        const v = t.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
  });

  // T23 (PR #4732 R2): the vm `timeout` option only covers synchronous
  // execution. `return new Promise(() => {})` hits the first `await`,
  // disarms the watchdog, and hangs forever. Wall-clock timeout via
  // Promise.race rejects after maxWallClockMs.
  it('rejects an async never-resolving Promise via wall-clock timeout', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      maxWallClockMs: 100, // tiny override for fast test
    });
    await expect(sandbox.run(`return new Promise(() => {});`)).rejects.toThrow(
      /timed out after 100 ms wall clock/,
    );
  });

  // NOTE: we explicitly do NOT test an in-script async microtask loop
  // (`(async () => { while(true) await Promise.resolve(); })()`). Once such
  // a loop starts inside the vm context, Node provides no way to halt it —
  // our wall-clock timeout rejects the outer Promise.race but the loop
  // keeps consuming microtasks, hanging the test runner. In production
  // this is still acceptable: the workflow surface returns the timeout
  // error and the vm context becomes unreferenced (GC eventually reclaims
  // it). Documented as a limitation of node:vm.

  // T40 (PR #4732 R4): completing R2's wall-clock defense. When the timer
  // fires the sandbox rejects, but in-flight subagents (closed over the
  // dispatch signal) keep running until their internal max_time_minutes
  // limit. Threading an AbortController through `abortOnTimeout` lets the
  // caller link wall-clock fires to dispatch-signal aborts.
  it('aborts the abortOnTimeout controller when wall-clock timeout fires (T40)', async () => {
    const abortOnTimeout = new AbortController();
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      maxWallClockMs: 100,
      abortOnTimeout,
    });
    expect(abortOnTimeout.signal.aborted).toBe(false);
    await expect(sandbox.run(`return new Promise(() => {});`)).rejects.toThrow(
      /timed out after 100 ms wall clock/,
    );
    expect(abortOnTimeout.signal.aborted).toBe(true);
  });

  // T40 sibling: a normal completion must NOT abort the controller — the
  // caller is responsible for cleanup in its finally block.
  it('does not abort the abortOnTimeout controller on normal completion (T40)', async () => {
    const abortOnTimeout = new AbortController();
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      maxWallClockMs: 5000,
      abortOnTimeout,
    });
    const result = await sandbox.run(`return 42`);
    expect(result).toBe(42);
    expect(abortOnTimeout.signal.aborted).toBe(false);
  });

  // T23: env var override is honored when no explicit opt is passed.
  it('QWEN_CODE_MAX_WORKFLOW_SECONDS env var sets the wall-clock cap', async () => {
    process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = '0.1';
    try {
      const sandbox = createWorkflowSandbox({
        args: undefined,
        dispatch: async () => 'ignored',
      });
      await expect(
        sandbox.run(`return new Promise(() => {});`),
      ).rejects.toThrow(/timed out after 100 ms wall clock/);
    } finally {
      delete process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
    }
  });

  // FIX-E (Round 4 Critical): Array args used to leak host process because
  // `deepNullProto` recursed into elements but left Array.prototype intact
  // on the array body. PoC: `args.constructor.constructor("return process")()`
  // returned host process with .env.HOME readable.
  it('blocks args.constructor escape when args is an array', async () => {
    const sandbox = createWorkflowSandbox({
      args: [1, 2, 3],
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const v = args.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }
    `);
    expect(result).not.toMatch(/object|darwin|linux/i);
    expect(['undefined', 'threw']).toContain(result);
  });

  // FIX-E: Symbol.iterator path via array's prototype.
  it('blocks args[Symbol.iterator] realm escape when args is an array', async () => {
    const sandbox = createWorkflowSandbox({
      args: [1, 2, 3],
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const it = args[Symbol.iterator] && args[Symbol.iterator]();
        if (!it) return 'no-iterator';
        const ctor = it.next.constructor;
        const v = ctor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw'; }
    `);
    expect(result).not.toMatch(/object|darwin|linux/i);
    expect(['undefined', 'threw', 'no-iterator']).toContain(result);
  });

  // FIX-F (Round 4 UP Critical): an un-injected sandbox exposes stub-throwing
  // parallel/pipeline globals so a model-authored script gets a clear
  // "unavailable" error rather than `ReferenceError: parallel is not defined`
  // (which the model would misdiagnose as a bug in its own script). In
  // production the orchestrator always injects real impls; these stubs only
  // fire for a bare sandbox constructed without them.
  it('parallel() throws an availability error rather than ReferenceError when not injected', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return parallel([() => agent("a")]);`),
    ).rejects.toThrow(/parallel\(\) is unavailable/);
  });

  it('pipeline() throws an availability error rather than ReferenceError when not injected', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return pipeline([1, 2], x => x, x => x);`),
    ).rejects.toThrow(/pipeline\(\) is unavailable/);
  });

  it('workflow() throws a P1-unsupported error rather than ReferenceError', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return workflow('child', { foo: 1 });`),
    ).rejects.toThrow(/workflow\(\).*not supported in P1/);
  });

  it('budget.spent() / .remaining() throw with clear P1-unsupported errors', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`return budget.spent();`)).rejects.toThrow(
      /budget\.spent.*not supported in P1/,
    );
    await expect(sandbox.run(`return budget.remaining();`)).rejects.toThrow(
      /budget\.remaining.*not supported in P1/,
    );
  });

  // FIX-H (Round 5 ARCH I1/I2/I3): injection seams for parallel/pipeline/
  // budget. These regression tests guard the contract: P2/P5 will provide
  // real implementations via SandboxOptions without modifying sandbox source.
  it('opts.parallel overrides the throwing stub when provided', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    });
    const result = await sandbox.run(`
      return await parallel([async () => 1, async () => 2, async () => 3]);
    `);
    expect(result).toEqual([1, 2, 3]);
  });

  it('opts.pipeline overrides the throwing stub when provided', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      pipeline: async (items, ...stages) => {
        const out: unknown[] = [];
        for (let i = 0; i < items.length; i++) {
          let cur: unknown = items[i];
          for (const stage of stages) {
            cur = await stage(cur, items[i], i);
          }
          out.push(cur);
        }
        return out;
      },
    });
    const result = await sandbox.run(`
      return await pipeline([1, 2, 3], async (x) => x * 10);
    `);
    expect(result).toEqual([10, 20, 30]);
  });

  // SECURITY (PR #4732 P2): the host parallel/pipeline impl resolves with a
  // HOST-realm array. vmAsync's resolve path is verbatim, so without the
  // in-realm JSON revival the RESOLVED array's prototype chain reaches the
  // host Function constructor — `out.constructor.constructor('return process')()`
  // would leak host process. The pre-P2 escape test only probed the *Promise*
  // (vm-realm via vmAsync), NOT the resolved array — this is the uncovered gap.
  // These tests FAIL against a verbatim wrapper and PASS with revival.
  it('parallel() RESOLVED array cannot reach host process (revived in-realm)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ok',
      // host impl returns a plain HOST array on purpose.
      parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    });
    const result = await sandbox.run(`
      const out = await parallel([async () => 1, async () => 2]);
      try {
        const v = out.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(String(result)).toMatch(/^undefined|^threw/);
  });

  it('parallel() revives NESTED objects in-realm (not just the outer array)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ok',
      parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    });
    const result = await sandbox.run(`
      const out = await parallel([async () => ({ k: 'v' })]);
      try {
        const v = out[0].constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(String(result)).toMatch(/^undefined|^threw/);
  });

  it('pipeline() RESOLVED array cannot reach host process (revived in-realm)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ok',
      pipeline: async (items, ...stages) => {
        const out: unknown[] = [];
        for (let i = 0; i < items.length; i++) {
          let cur: unknown = items[i];
          for (const stage of stages) {
            cur = await stage(cur, items[i], i);
          }
          out.push(cur);
        }
        return out;
      },
    });
    const result = await sandbox.run(`
      const out = await pipeline([1, 2], async (x) => x * 10);
      try {
        const v = out.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(String(result)).toMatch(/^undefined|^threw/);
  });

  it('opts.budget overrides the throwing stub when provided', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      budget: {
        total: 500_000,
        spent: () => 123,
        remaining: () => 499_877,
      },
    });
    const result = await sandbox.run(`
      return { total: budget.total, spent: budget.spent(), remaining: budget.remaining() };
    `);
    expect(result).toEqual({ total: 500_000, spent: 123, remaining: 499_877 });
  });

  // T15 (PR #4732 R1): when opts.budget IS provided, the wrapper functions
  // must also block the budget.spent.constructor host-Function escape. The
  // existing constructor-escape tests only run against the default stub.
  it('opts.budget: spent/remaining constructors stay vm-realm-safe', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      budget: { total: 100, spent: () => 10, remaining: () => 90 },
    });
    const result = await sandbox.run(`
      try {
        const v = budget.spent.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
  });

  it('budget.total is null in P1 (matches upstream "no target" sentinel)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return budget.total`);
    expect(result).toBeNull();
  });

  // budget.spent / remaining are vm-realm functions whose .constructor is
  // vm-realm Function. The escape would only matter if that chain reached
  // host Function — it doesn't, because the entire budget object is built
  // inside the vm init script.
  it('budget.spent.constructor cannot reach host process', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const v = budget.spent.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
  });

  it('budget.remaining.constructor cannot reach host process', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`
      try {
        const v = budget.remaining.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
  });

  // FIX-G (Round 4 test Important): Date.parse is implemented but was
  // previously untested. Refactors that drop .parse would silently leave a
  // gap where parse() works (legacy host Date) and leaks real time math.
  it('Date.parse() throws inside sandbox', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return Date.parse("2026-01-01")`),
    ).rejects.toThrow(/unavailable in workflow scripts/i);
  });

  // T6 (Round 1 review Suggestion): validateArgs must reject functions,
  // BigInts, and circular references — without it, JSON.stringify silently
  // drops function-valued keys, and circular refs throw a generic message.
  it('rejects args with function-valued properties', () => {
    expect(() =>
      createWorkflowSandbox({
        args: { fn: () => 1 },
        dispatch: async () => 'ignored',
      }),
    ).toThrow(/JSON-serializable.*functions/i);
  });

  it('rejects args with BigInt values', () => {
    expect(() =>
      createWorkflowSandbox({
        args: { n: BigInt(1) },
        dispatch: async () => 'ignored',
      }),
    ).toThrow(/JSON-serializable.*BigInt/i);
  });

  it('rejects args with circular references', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() =>
      createWorkflowSandbox({
        args: a,
        dispatch: async () => 'ignored',
      }),
    ).toThrow(/JSON-serializable.*circular/i);
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
    expect(() =>
      createWorkflowSandbox({
        args: deep,
        dispatch: async () => 'ignored',
      }),
    ).toThrow(/max nesting depth/);
  });

  // P3 (PR #5xxx): agentType / model / isolation are passed through to the
  // dispatch — the sandbox no longer rejects them. Unknown isolation modes
  // (anything other than 'worktree' / 'remote') still throw at sandbox level
  // because those values cannot be meaningful to any dispatch.
  it('agent() rejects unknown isolation mode with clear error', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return agent("hi", { isolation: "not-a-real-mode" });`),
    ).rejects.toThrow(/unknown isolation mode/);
  });

  it('agent({isolation:"worktree"}) is passed through to dispatch in P3', async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, opts });
        return 'done';
      },
    });
    const result = await sandbox.run(
      `return await agent("x", { isolation: "worktree" });`,
    );
    expect(result).toBe('done');
    expect((seen[0].opts as { isolation?: unknown }).isolation).toBe(
      'worktree',
    );
  });

  it('agent({isolation:"remote"}) is passed through to dispatch in P3', async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, opts });
        return 'done';
      },
    });
    await sandbox.run(`return await agent("x", { isolation: "remote" });`);
    expect((seen[0].opts as { isolation?: unknown }).isolation).toBe('remote');
  });

  it('agent({model}) is passed through to dispatch in P3', async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, opts });
        return 'done';
      },
    });
    await sandbox.run(`return await agent("x", { model: "qwen3-max" });`);
    expect((seen[0].opts as { model?: unknown }).model).toBe('qwen3-max');
  });

  it('agent({agentType}) is passed through to dispatch in P3', async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, opts });
        return 'done';
      },
    });
    await sandbox.run(`return await agent("x", { agentType: "Explore" });`);
    expect((seen[0].opts as { agentType?: unknown }).agentType).toBe('Explore');
  });

  // SECURITY (P3 widening): when dispatch returns a host-realm object (the
  // structured payload in schema mode), the agent() wrapper revives per-call
  // so the constructor chain stays in the vm realm. The same T1/T8/T14
  // vector closed for parallel/pipeline's array result must be closed here.
  it('agent() object return cannot reach host process via constructor chain', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => ({ ok: true, leak: 'attempt' }),
    });
    const result = await sandbox.run(`
      const out = await agent("x", { schema: { type: "object" } });
      try {
        const v = out.constructor.constructor("return typeof process")();
        return String(v);
      } catch (e) { return 'threw:' + String(e.message).slice(0, 40); }
    `);
    expect(result).not.toMatch(/object|darwin|linux|win32/i);
    expect(String(result)).toMatch(/^undefined|^threw/);
  });

  // EAD-1 sibling for agent(): a non-JSON-serializable host return value
  // becomes null at the script boundary instead of throwing the wrapper.
  it('agent() object return that cannot serialize collapses to null', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => {
        const a: { self?: unknown } = {};
        a.self = a;
        return a as unknown as object;
      },
    });
    const result = await sandbox.run(
      `return await agent("x", { schema: { type: "object" } });`,
    );
    expect(result).toBeNull();
  });

  // FIX-C7 (TST-2-I3): the dedup branch in agent({phase}) — consecutive
  // identical opts.phase values must not produce duplicate entries.
  it('agent() opts.phase dedups consecutive identical entries', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'done',
    });
    await sandbox.run(`
      await agent("a", { phase: "Search" });
      await agent("b", { phase: "Search" });
      await agent("c", { phase: "Verify" });
      await agent("d", { phase: "Verify" });
      await agent("e", { phase: "Search" });
      return 0;
    `);
    // The implementation only dedups against the most recent entry, so a
    // phase repeating after a different one is appended again.
    expect(sandbox.getPhases()).toEqual(['Search', 'Verify', 'Search']);
  });
});

describe('createWorkflowSandbox primitives', () => {
  it('phase() pushes titles in script order', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(`phase("plan"); phase("build"); return 0`);
    expect(sandbox.getPhases()).toEqual(['plan', 'build']);
  });

  it('log() accumulates string and non-string arguments', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(`log("hi"); log(42); return 0`);
    expect(sandbox.getLogs()).toEqual(['hi', '42']);
  });

  it('agent() invokes dispatch and resolves with its return value', async () => {
    const seen: Array<{ prompt: string; label?: string }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, label: opts.label });
        return `echo: ${prompt}`;
      },
    });
    const result = await sandbox.run(
      `const a = await agent("write hello", { label: "h1" });
       return a;`,
    );
    expect(result).toBe('echo: write hello');
    expect(seen).toEqual([{ prompt: 'write hello', label: 'h1' }]);
  });

  it('agent() runs sequentially when called multiple times', async () => {
    const order: number[] = [];
    let counter = 0;
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => {
        const myOrder = ++counter;
        await new Promise((r) => setTimeout(r, 5));
        order.push(myOrder);
        return String(myOrder);
      },
    });
    const result = await sandbox.run(`
      const a = await agent("first");
      const b = await agent("second");
      return [a, b];
    `);
    expect(result).toEqual(['1', '2']);
    expect(order).toEqual([1, 2]);
  });

  // T5 (Round 1 review Suggestion): console.log/warn/error must route to
  // getLogs() — a refactor removing the routing would silently break
  // model scripts that use console for diagnostics.
  it('console.log / warn / error route to getLogs()', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(`
      console.log("info");
      console.warn("warn");
      console.error("err");
      return 0;
    `);
    expect(sandbox.getLogs()).toEqual(['info', 'warn', 'err']);
  });

  it('full P1 acceptance script: phase + agent returns expected value', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt) => `agent-response:${prompt}`,
    });
    const result = await sandbox.run(`
      phase("plan");
      const out = await agent("write a hello", { label: "h1" });
      return out;
    `);
    expect(result).toBe('agent-response:write a hello');
    expect(sandbox.getPhases()).toEqual(['plan']);
  });
});
