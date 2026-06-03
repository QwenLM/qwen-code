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

// TST-C1/C2/C3 security PoC tests (FIX-1 through FIX-4, FIX-9)
describe('createWorkflowSandbox security', () => {
  // SEC-C1: args JSON-roundtrip severs prototype chain → realm escape returns
  // undefined or throws rather than reaching host process.
  it('blocks args.constructor.constructor realm escape', async () => {
    const sandbox = createWorkflowSandbox({
      args: { x: 1 },
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`
        const ctor = args.constructor && args.constructor.constructor;
        if (ctor) {
          try {
            return ctor("return typeof process")();
          } catch (e) { return 'blocked-via-throw'; }
        }
        return 'blocked-via-undefined';
      `),
    ).resolves.toMatch(/blocked-via-/);
  });

  // SEC-C1: hardenClosure on phase blocks fn.constructor.constructor escape.
  it('hardens phase global against constructor escape', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return phase.constructor`);
    expect(result).toBeUndefined();
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

  // UP-C1: agent({schema}) must throw a clear error, not silently drop the opt.
  it('agent() rejects unsupported schema opt with a clear error', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`
        return agent("hi", { schema: { type: "object" } });
      `),
    ).rejects.toThrow(/schema.*P3/);
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

  // FIX-C7 (TST-2-I1): each of the four unsupported-opts throw branches must
  // have its own test. A refactor that deletes any branch passes the others.
  it('agent() rejects isolation opt with clear error', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return agent("hi", { isolation: "worktree" });`),
    ).rejects.toThrow(/isolation.*not supported in P1/);
  });

  it('agent() rejects model opt with clear error', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return agent("hi", { model: "gpt-4" });`),
    ).rejects.toThrow(/model.*not supported in P1/);
  });

  it('agent() rejects agentType opt with clear error', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return agent("hi", { agentType: "Explore" });`),
    ).rejects.toThrow(/agentType.*not supported in P1/);
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
