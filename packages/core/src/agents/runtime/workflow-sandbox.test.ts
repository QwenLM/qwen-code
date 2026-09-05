/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  stripExportMeta,
  extractAndStripMeta,
  createWorkflowSandbox,
  compileWorkflowScript,
  describeWorkflowCompileError,
} from './workflow-sandbox.js';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';
import { expectWithinLatencyBudget } from '../../test-utils/latency-budget.js';

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

describe('extractAndStripMeta', () => {
  // P4: extracts the `export const meta = {...}` declaration into a typed
  // object AND strips it from the script source (delegates to the same
  // brace-walker stripExportMeta uses). `meta: null` when the script has no
  // declaration; throws when the declaration is present but malformed.
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

  it('extracts optional whenToUse + phases array', () => {
    const src = `export const meta = {
      name: 'multi',
      description: 'multi-phase',
      whenToUse: 'when the user needs a multi-phase report',
      phases: [
        { title: 'collect' },
        { title: 'analyse', detail: 'aggregate findings', model: 'qwen3-coder-plus' },
      ],
    }
    return 1;`;
    const { meta } = extractAndStripMeta(src);
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

  it('throws upstream-verbatim error when name is missing', () => {
    const src = `export const meta = { description: 'no name' }\nreturn 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /^meta\.name must be a non-empty string$/,
    );
  });

  it('throws upstream-verbatim error when description is missing', () => {
    const src = `export const meta = { name: 'x' }\nreturn 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /^meta\.description must be a non-empty string$/,
    );
  });

  it('throws when name is empty string', () => {
    const src = `export const meta = { name: '', description: 'd' }\nreturn 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /^meta\.name must be a non-empty string$/,
    );
  });

  it('throws when phases is not an array', () => {
    const src = `export const meta = { name: 'n', description: 'd', phases: 'oops' }\nreturn 1`;
    expect(() => extractAndStripMeta(src)).toThrow(/phases must be an array/);
  });

  it('throws when a phase is missing its title', () => {
    const src = `export const meta = { name: 'n', description: 'd', phases: [{ detail: 'no title here' }] }\nreturn 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /phases\[\]\.title must be a non-empty string/,
    );
  });

  // Security regression: the meta-eval vm context has no globals at all
  // meta is parsed, not executed, so an identifier is not "resolved to
  // undefined" or "looked up and not found" — it is simply not a value the
  // grammar admits. Two shapes pinned: a truly unknown identifier and
  // explicit `args` bridge-global access.
  it('rejects meta that references an unknown identifier', () => {
    const src = `export const meta = { name: totallyUnknown, description: 'd' }\nreturn 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /invalid meta object literal/,
    );
  });

  // Security regression: there is no evaluation, so there is no scope to
  // reach out of — neither the workflow-sandbox bridge globals
  // (`args` / `agent` / `phase` / `log` / …) nor host primitives like
  // `process` and `require` are reachable, because no identifier is.
  it('meta source cannot reference a workflow-sandbox bridge global (args)', () => {
    const src = `export const meta = { name: args.x, description: 'd' }\nreturn 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /invalid meta object literal/,
    );
  });

  it('meta source cannot reach the host process / require / fs', () => {
    const src1 = `export const meta = { name: process.version, description: 'd' }\nreturn 1`;
    expect(() => extractAndStripMeta(src1)).toThrow(
      /invalid meta object literal/,
    );
    const src2 = `export const meta = { name: 'x', description: require('fs').readFileSync('/etc/passwd', 'utf8') }\nreturn 1`;
    expect(() => extractAndStripMeta(src2)).toThrow(
      /invalid meta object literal/,
    );
  });

  it('unbalanced braces still throw the stripExportMeta error', () => {
    const src = `export const meta = { name: 'x'`;
    expect(() => extractAndStripMeta(src)).toThrow(/unbalanced/i);
  });

  // P4a adversarial review (HIGH × 3 lenses): the docstring at
  // workflow-sandbox.ts:283-294 promises the returned meta is HOST-realm —
  // a per-field copy that defends against T1/T8/T14-style vm-realm escape
  // via `outcome.meta.constructor.constructor('return process')()`. Verify
  // the contract: returned meta + its nested phases array + each phase
  // entry must all sit on the host-realm prototype chain so
  // `.constructor` reaches host `Object` / `Array`, not a vm-realm peer.
  // Without this, a regression that returns the vm-eval'd value directly
  // would silently pass every structural `toEqual` check in the suite.
  it('returned meta + phases array + phase entries are all host-realm objects', () => {
    const src = `export const meta = {
      name: 'realm',
      description: 'realm-identity check',
      whenToUse: 'tests',
      phases: [
        { title: 'a' },
        { title: 'b', detail: 'has detail', model: 'qwen3' },
      ],
    }
    return 1`;
    const { meta } = extractAndStripMeta(src);
    expect(meta).not.toBeNull();
    expect(Object.getPrototypeOf(meta as object)).toBe(Object.prototype);
    const phases = (meta as { phases: object[] }).phases;
    expect(Object.getPrototypeOf(phases)).toBe(Array.prototype);
    for (const p of phases) {
      expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    }
  });

  // P4a Round 3 (wenshao): a Promise (e.g. `import('node:fs')`) used as a
  // value in the meta literal used to crash the host process — evaluation
  // returned normally with a dangling rejection scheduled for the next tick,
  // validateMeta dropped the non-contract field, the workflow returned its
  // result, and only THEN did the unhandled rejection terminate the process
  // under Node's default `--unhandled-rejections=throw`. That hazard was
  // handled by walking the evaluated value and neutralising thenables.
  //
  // Nothing is evaluated now, so no Promise is ever constructed and there is
  // no rejection to neutralise. The literal is rejected on syntax instead.
  // These tests assert both halves: the call throws, AND the process records
  // no unhandled rejection — the second is the property users actually cared
  // about, and it is now guaranteed structurally rather than by a walker.
  it('rejects a Promise-valued meta field (dynamic import) with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const src = `export const meta = { name: 'x', description: 'd', extra: import('node:fs') }\nreturn 1`;
      expect(() => extractAndStripMeta(src)).toThrow(
        /invalid meta object literal/,
      );
      // Let any rejection that a previous implementation would have scheduled
      // reach the handler before asserting none arrived.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects a Promise-valued meta field nested inside a phases entry', () => {
    const src = `export const meta = {
      name: 'x',
      description: 'd',
      phases: [{ title: 't', extra: import('node:fs') }],
    }
    return 1`;
    expect(() => extractAndStripMeta(src)).toThrow(
      /invalid meta object literal/,
    );
  });

  // P4 Round 7 (wenshao): `phase('X'); phase('X')` previously yielded
  // `outcome.phases = ['X','X']` (sandbox unconditional push) while the
  // registry's onPhaseStarted deduped to `entry.phases = ['X']`. The
  // two arrays diverged on the same run — terminal display vs live UI
  // showed different phase lists. Fix at the sandbox layer so the
  // sandbox is the single source of truth; the docstring on safePhase
  // / phase() can then promise dedup without lying.
  it('consecutive identical phase titles dedup at the sandbox layer', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(
      `phase('X'); phase('X'); phase('Y'); phase('X'); return 1`,
    );
    expect(sandbox.getPhases()).toEqual(['X', 'Y', 'X']);
  });

  // P4 Round 4 (wenshao): a meta literal that built a cyclic object via
  // spread used to overflow the walker's stack. Both fixtures below used to
  // SUCCEED — the cyclic field was not a contract field, so validateMeta
  // dropped it and the run continued.
  //
  // They are now refused, and that is a deliberate narrowing of the contract
  // rather than a regression: a spread means "evaluate this expression and
  // merge the result", which is exactly what meta no longer does. A literal
  // cannot be cyclic, so the whole class of cycle-walking concerns is gone
  // with it. The message names the rule so the author knows what to write
  // instead.
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

  // P4: meta declaration in the script is extracted before the body runs
  // and exposed via getMeta(). The script body sees the stripped source.
  it('getMeta() returns null when no export const meta declaration', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(`return 42`);
    expect(sandbox.getMeta()).toBeNull();
  });

  it('getMeta() returns the parsed meta when present', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
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

  it('getMeta() failure on malformed meta propagates as the run rejection', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`export const meta = { name: 'x' }\nreturn 1`),
    ).rejects.toThrow(/^meta\.description must be a non-empty string$/);
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
    const emitted: string[] = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      emitter: { logAppended: (line) => emitted.push(line) },
    });
    await sandbox.run(`for (let i = 0; i < 10100; i++) log(i); return 0;`);
    const logs = sandbox.getLogs();
    expect(logs.length).toBe(10_001); // 10_000 entries + 1 truncation marker
    expect(logs[10_000]).toMatch(/truncated/);
    expect(emitted.at(-1)).toBe(logs[10_000]);
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
      /exceeded 100 ms of active time/,
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
      /exceeded 100 ms of active time/,
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
      ).rejects.toThrow(/exceeded 100 ms of active time/);
    } finally {
      delete process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
    }
  });

  // Pause-aware watchdog: once the scheduler is `paused` no dispatch is
  // in flight or being issued, so paused time must neither burn the
  // wall-clock budget nor let the timer kill the run mid-pause (resume
  // would then be impossible while the UI promises "press p to resume").
  it('suspends the wall-clock watchdog while the scheduler is paused', async () => {
    const scheduler = new WorkflowDispatchScheduler(1);
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      maxWallClockMs: 100,
      scheduler,
    });
    const run = sandbox.run(`return new Promise(() => {});`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.pause()).toBe(true);
    // Wait out the entire budget while paused — pre-fix the watchdog
    // fired mid-pause and rejected the run.
    await new Promise((resolve) => setTimeout(resolve, 150));
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    expect(scheduler.resume()).toBe(true);
    await expect(run).rejects.toThrow(/exceeded 100 ms of active time/);
  });

  it('re-arms with the banked remainder on resume, not a fresh budget', async () => {
    const scheduler = new WorkflowDispatchScheduler(1);
    let finish: ((value: string) => void) | undefined;
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      maxWallClockMs: 200,
      scheduler,
    });
    // Consume most of the budget BEFORE pausing; only the banked
    // remainder may fire after resume.
    const run = sandbox.run(`await agent('a'); return new Promise(() => {});`);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(scheduler.pause()).toBe(true);
    finish?.('done');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    let settled = false;
    void run.catch(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

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
    // R11-19: every other watchdog test exercises at most one
    // pause→resume cycle. The multi-cycle guarantee hangs on
    // resume() clearing the paused flag (pause() early-returns while
    // it is set) — a pause→resume→pause must suspend again, and the
    // run must not settle mid-second-pause.
    const scheduler = new WorkflowDispatchScheduler(1);
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      maxWallClockMs: 100,
      scheduler,
    });
    const run = sandbox.run(`return new Promise(() => {});`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(scheduler.pause()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    expect(scheduler.resume()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(scheduler.pause()).toBe(true);
    // Wait out the entire (remaining) budget inside the SECOND pause —
    // pre-fix the watchdog stayed armed and killed the run mid-pause.
    await new Promise((resolve) => setTimeout(resolve, 200));
    settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    expect(scheduler.resume()).toBe(true);
    await expect(run).rejects.toThrow(/exceeded 100 ms of active time/);
  });

  it('keeps the wall-clock watchdog armed while an in-flight dispatch drains a pause', async () => {
    // `pausing` means a dispatch is still executing real work — the exact
    // hang the backstop exists for. Suspending the watchdog on `pausing`
    // would leave a hung in-flight subagent unbounded (and resume()
    // returns false while stuck in `pausing`, so the backstop could not
    // re-arm from that state).
    const scheduler = new WorkflowDispatchScheduler(1);
    const sandbox = createWorkflowSandbox({
      args: undefined,
      // Route through the scheduler like the orchestrator does so the
      // hung thunk counts as in-flight and the pause parks in `pausing`.
      dispatch: () => scheduler.run(() => new Promise<string>(() => {})),
      maxWallClockMs: 100,
      scheduler,
    });
    const run = sandbox.run(`await agent('a');`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot().state).toBe('pausing');
    await expect(run).rejects.toThrow(/exceeded 100 ms of active time/);
  });

  it('settles a cancelled paused run at once, not on the banked wall-clock remainder', async () => {
    // Cancelling a paused run aborts the controller, but abortPending()
    // emits no scheduler transition. Before the abort arm, settlement
    // depended on the watchdog re-arming with its banked remainder — the
    // user watched a cancelled run refuse to end for up to that long. Now
    // the abort settles the run immediately; the re-arm stays as a backstop.
    vi.useFakeTimers();
    const scheduler = new WorkflowDispatchScheduler(1);
    const abortOnTimeout = new AbortController();
    let finish: ((value: string) => void) | undefined;
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      maxWallClockMs: 200,
      scheduler,
      abortOnTimeout,
    });
    const run = sandbox.run(`await agent('a'); return new Promise(() => {});`);
    let settled = false;
    const settlement = run.catch(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(finish).toBeDefined();
      await vi.advanceTimersByTimeAsync(120);
      expect(scheduler.pause()).toBe(true);
      finish?.('done');
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.snapshot().state).toBe('paused');

      abortOnTimeout.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await expect(run).rejects.toThrow(/aborted \(cancelled\)/);
    } finally {
      abortOnTimeout.abort();
      await vi.runAllTimersAsync();
      await settlement;
      vi.useRealTimers();
    }
  });

  it('settles a run cancelled mid-pausing before the post-abort drain lands', async () => {
    // An in-flight dispatch that settles AFTER the abort still lands the
    // scheduler's `pausing` → `paused` transition (pump's finally). The run
    // must already be settled by then: a script that catches the abort and
    // hangs in ungated code used to be orphaned until the wall clock.
    const scheduler = new WorkflowDispatchScheduler(1);
    const abortOnTimeout = new AbortController();
    let finishDispatch: ((value: string) => void) | undefined;
    const sandbox = createWorkflowSandbox({
      args: undefined,
      // Route through the scheduler like the orchestrator does so the
      // thunk counts as in-flight and the pause parks in `pausing`.
      dispatch: () =>
        scheduler.run(
          () =>
            new Promise<string>((resolve) => {
              finishDispatch = resolve;
            }),
        ),
      maxWallClockMs: 150,
      scheduler,
      abortOnTimeout,
    });
    const run = sandbox.run(`
      try { await agent('a'); } catch {}
      return new Promise(() => {});
    `);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot().state).toBe('pausing');

    abortOnTimeout.abort();
    await expect(run).rejects.toThrow(/aborted \(cancelled\)/);

    // The drain still completes its transition afterwards; nothing about a
    // settled run is disturbed by it.
    finishDispatch?.('late');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
  });

  it('suspends the watchdog of a sandbox created while the scheduler is already paused', async () => {
    // A nested workflow() sandbox can be created mid-pause; the state
    // subscription only sees FUTURE transitions, so the watchdog must be
    // seeded with the current state or it kills the nested run mid-pause.
    const scheduler = new WorkflowDispatchScheduler(1);
    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot().state).toBe('paused');
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      maxWallClockMs: 100,
      scheduler,
    });
    const run = sandbox.run(`return new Promise(() => {});`);
    // Wait out the entire budget while paused — pre-fix the watchdog was
    // armed at creation and fired mid-pause.
    await new Promise((resolve) => setTimeout(resolve, 150));
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    expect(scheduler.resume()).toBe(true);
    await expect(run).rejects.toThrow(/exceeded 100 ms of active time/);
  });

  it('does not run a script whose signal was already aborted before run()', async () => {
    // Production shares one controller between the registry (which
    // pre-registers the run before run() resolves) and the sandbox, so a
    // user cancel can land before run() begins: the scheduler is already
    // paused AND the signal is already aborted. The run must settle as
    // cancelled without executing a line of model-authored code.
    const abortOnTimeout = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, abortOnTimeout.signal);
    expect(scheduler.pause()).toBe(true);
    abortOnTimeout.abort();
    const dispatch = vi.fn(async () => 'ignored');
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch,
      maxWallClockMs: 100,
      scheduler,
      abortOnTimeout,
    });
    await expect(
      sandbox.run(`await agent('never'); return new Promise(() => {});`),
    ).rejects.toThrow(/aborted \(cancelled\)/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancellation settles the run at once while the script still runs its own finally', async () => {
    // The host-side run settles immediately; the script's promise is left
    // to finish on its own. Its dispatches reject on the aborted signal, so
    // a `finally` inside the script still executes — cleanup the author
    // wrote is not skipped just because the user stopped waiting.
    const controller = new AbortController();
    const sandbox = createWorkflowSandbox({
      args: undefined,
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
    const run = sandbox.run(`
      try { await agent('a'); }
      finally { log('cleanup ran'); }
    `);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(run).rejects.toThrow(/aborted \(cancelled\)/);
    await vi.waitFor(() =>
      expect(sandbox.getLogs().some((l) => l.includes('cleanup ran'))).toBe(
        true,
      ),
    );
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

  it('workflow() throws "unavailable" when no workflow impl is injected (bare sandbox / nesting limit)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return workflow('child', { foo: 1 });`),
    ).rejects.toThrow(/workflow\(\) is unavailable here/);
  });

  it('workflow() resolves through the injected host impl (single result revived)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      workflow: async (nameOrRef, wfArgs) => ({
        echoedRef: nameOrRef,
        echoedArgs: wfArgs,
      }),
    });
    const result = await sandbox.run(
      `return await workflow('child', { foo: 1 });`,
    );
    expect(result).toEqual({
      echoedRef: 'child',
      echoedArgs: { foo: 1 },
    });
  });

  it('workflow({scriptPath}) passes the object ref through to the host impl', async () => {
    let received: unknown;
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
      workflow: async (nameOrRef) => {
        received = nameOrRef;
        return 'ok';
      },
    });
    await sandbox.run(`return await workflow({ scriptPath: '/tmp/x.js' });`);
    expect(received).toEqual({ scriptPath: '/tmp/x.js' });
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

  it('agent({workingDir}) is passed through to dispatch', async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, opts });
        return 'done';
      },
    });
    const result = await sandbox.run(
      `return await agent("x", { workingDir: ".qwen/tmp/review-pr-7" });`,
    );
    expect(result).toBe('done');
    expect((seen[0].opts as { workingDir?: unknown }).workingDir).toBe(
      '.qwen/tmp/review-pr-7',
    );
  });

  it('agent({workingDir}) rejects invalid values', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return agent("x", { workingDir: 7 });`),
    ).rejects.toThrow(/workingDir.*non-empty string/);
    await expect(
      sandbox.run(`return agent("x", { workingDir: "" });`),
    ).rejects.toThrow(/workingDir.*non-empty string/);
    // Whitespace-only used to clear both entrance gates and was refused only
    // deep in the registration gate with a message blaming the directory
    // instead of the argument.
    await expect(
      sandbox.run(`return agent("x", { workingDir: " " });`),
    ).rejects.toThrow(/workingDir.*non-empty string/);
  });

  // The two options make opposite claims about who owns the directory's
  // lifetime, so the contradiction is named rather than resolved by
  // precedence — a script that got a silent winner would believe it was
  // isolated when it was pinned, or vice versa.
  it('agent({workingDir, isolation}) rejects the combination', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(
        `return agent("x", { workingDir: "wt", isolation: "worktree" });`,
      ),
    ).rejects.toThrow(/incompatible options/);
  });

  // The schema advertises "0 disables the watchdog", but a non-number used
  // to be silently dropped downstream where the DEFAULT watchdog applied —
  // the dispatch the author meant to leave unwatched got aborted + retried.
  it('agent({stallMs}) rejects non-numeric values', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ignored',
    });
    await expect(
      sandbox.run(`return agent("x", { stallMs: "0" });`),
    ).rejects.toThrow(/stallMs.*finite number/);
    await expect(
      sandbox.run(`return agent("x", { stallMs: NaN });`),
    ).rejects.toThrow(/stallMs.*finite number/);
    await expect(
      sandbox.run(`return agent("x", { stallMs: true });`),
    ).rejects.toThrow(/stallMs.*finite number/);
  });

  it('agent({stallMs: 0}) passes through and disables the watchdog', async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, opts });
        return 'done';
      },
    });
    const result = await sandbox.run(
      `return await agent("x", { stallMs: 0 });`,
    );
    expect(result).toBe('done');
    expect((seen[0].opts as { stallMs?: unknown }).stallMs).toBe(0);
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

  it('logs non-abort rejections of un-awaited dispatches instead of swallowing them', async () => {
    // An un-awaited agent() refused at the entry gate or failing mid-run
    // reaches no other surface — the rejection must be mirrored into the
    // run log rather than silently observed. Covers the bare call AND a
    // script-derived `.then()` chain; neither shape may surface the
    // rejection as a process-level unhandledRejection. The wordings
    // differ by attribution: the bare call never attached to its root,
    // while the chain attached a fulfillment-only handler, so its root
    // WAS attached and only the rejection went unhandled.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('dispatch-boom')),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(
        `agent('a'); agent('b').then((v) => 'derived:' + v); return 'done';`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): dispatch-boom',
      'dispatch failed (rejection not handled): dispatch-boom',
    ]);
    expect(unhandled).toEqual([]);
  });

  it('mirrors unconsumed rejections whose message merely contains "aborted"', async () => {
    // Teardown discrimination matches the host error NAME at the vm
    // boundary (the scheduler's DOMException 'AbortError'), never the
    // message text: a genuine failure like a network-layer
    // 'connection aborted by peer' must still reach the run log.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('connection aborted by peer')),
    });
    await sandbox.run(`agent('a'); return 'done';`);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): connection aborted by peer',
    ]);
  });

  it('does not report a rejection the script consumes after a later await', async () => {
    // The unconsumed verdict defers to run settlement: flaky rejects while
    // the script is still suspended in the second await, but the script
    // consumes the rejection afterwards — the run log must not claim it
    // went unconsumed (a self-contradicting entry next to 'handled:').
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: (prompt: string) =>
        prompt === 'flaky'
          ? Promise.reject(new Error('flaky-boom'))
          : Promise.resolve('slow-done'),
    });
    await sandbox.run(`
      const p = agent('flaky');
      await agent('slow');
      try { await p; } catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['handled: flaky-boom']);
  });

  it('attributes a fire-and-forget handler failure to the script, not the dispatch', async () => {
    // The dispatch SUCCEEDS but the script's own then-handler throws: the
    // mirror must not claim a dispatch failure and send operators
    // investigating dispatch / budget gates instead of the script.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'not-json',
    });
    await sandbox.run(
      `agent('fetch').then((r) => JSON.parse(r)); return 'done';`,
    );
    const logs = sandbox.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(
      /^script handler failed \(rejection not handled\): /,
    );
  });

  it('does not mirror a side branch once the script handles the root rejection', async () => {
    // The root rejection IS handled by the script's await-catch; only an
    // unassigned side branch's derived promise went unconsumed. Mirroring
    // '(result not consumed)' there is contradicted by the script's own
    // 'handled:' line.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('x-boom')),
    });
    await sandbox.run(`
      const p = agent('x');
      p.then(() => log('side'));
      try { await p; } catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['handled: x-boom']);
  });

  it('does not log teardown abort rejections of un-awaited dispatches', async () => {
    // Derive the teardown error from a real aborted scheduler job — the
    // production producer — instead of fabricating the literal, so a
    // change to abortError()'s message turns this test red.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    const queued = scheduler.run(async () => 'never');
    controller.abort();
    const teardownError: unknown = await queued.catch(
      (error: unknown) => error,
    );
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(teardownError),
    });
    await sandbox.run(`agent('a'); return 'done';`);
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('observes teardown rejections of script-derived dispatch chains without unhandledRejection', async () => {
    // R8-7: the abort-noise observer must cover script-derived chains,
    // not just the bare dispatch promise. A correctly-cancelled run
    // holding a pending `.then()` chain must not fire a process-level
    // unhandledRejection, and the teardown rejection must not reach the
    // run log through the derived chain either.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    const queued = scheduler.run(async () => 'never');
    controller.abort();
    const teardownError: unknown = await queued.catch(
      (error: unknown) => error,
    );
    const sandbox = createWorkflowSandbox({
      args: undefined,
      // The bare dispatches stay pending until after the script settles
      // so their derived chains are still live when the teardown-style
      // rejections land.
      dispatch: (prompt: string) =>
        prompt === 'keep'
          ? Promise.reject(teardownError)
          : new Promise((_resolve, reject) => {
              setTimeout(() => reject(teardownError), 10);
            }),
      scheduler,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(`
        agent('inflight');
        agent('derived').then((v) => 'derived:' + v);
        try { await agent('keep'); } catch {}
        return 'done';
      `);
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('does not mirror plain-Error teardown rejections of an aborted run', async () => {
    // R10-1: the dominant cancellation shape is NOT an 'AbortError'.
    // controller.abort() → the subagent returns terminateMode=CANCELLED →
    // the dispatch rejects with a PLAIN Error ('did not complete
    // (terminate mode: CANCELLED).'). Once the run's abort signal has
    // fired, a correctly-cancelled run must not log a spurious dispatch
    // failure for that in-flight rejection regardless of its name.
    const controller = new AbortController();
    let rejectDispatch: (err: Error) => void = () => {};
    const sandbox = createWorkflowSandbox({
      args: undefined,
      abortOnTimeout: controller,
      dispatch: () =>
        new Promise((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    const runPromise = sandbox.run(`agent('inflight'); return 'done';`);
    controller.abort();
    rejectDispatch(
      new Error(
        'Workflow subagent x did not complete (terminate mode: CANCELLED).',
      ),
    );
    // The abort arm settles the run as cancelled even though the script had
    // already returned — cancel wins a same-tick race, matching the runner,
    // which reports a cancelled registry entry over an ok outcome.
    await expect(runPromise).rejects.toThrow(/aborted \(cancelled\)/);
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('mirrors plain-Error rejections while the run signal is not aborted', async () => {
    // Companion to the aborted-run case: the same plain-Error shape is a
    // genuine failure when nothing was aborted, so the isRunAborted
    // teardown clause must not widen the name-based suppression.
    const controller = new AbortController();
    const sandbox = createWorkflowSandbox({
      args: undefined,
      abortOnTimeout: controller,
      dispatch: () =>
        Promise.reject(
          new Error(
            'Workflow subagent x did not complete (terminate mode: CANCELLED).',
          ),
        ),
    });
    await sandbox.run(`agent('a'); return 'done';`);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): Workflow subagent x did not complete (terminate mode: CANCELLED).',
    ]);
  });

  it('mirrors an unconsumed dispatch failure behind a fire-and-forget finally', async () => {
    // R10-3: finally rethrows the rejection — it is not a rejection
    // handler. agent(...).finally(...) without a downstream catch must
    // still reach the mirror (and must not surface as a process-level
    // unhandledRejection).
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('dispatch-boom')),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(
        `agent('a').finally(() => log('attempted a')); return 'done';`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    // The finally call attaches to the root (same shape as a fulfillment-
    // only .then chain), so the attribution is '(rejection not handled)'.
    expect(sandbox.getLogs()).toEqual([
      'attempted a',
      'dispatch failed (rejection not handled): dispatch-boom',
    ]);
  });

  it('does not mirror a finally-chained rejection the script consumes', async () => {
    // The finally callback runs, then the script's await-catch consumes
    // the propagated rejection — the mirror stays silent exactly as for
    // a direct await-catch.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('boom')),
    });
    await sandbox.run(`
      try { await agent('a').finally(() => log('cleaned up')); }
      catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['cleaned up', 'handled: boom']);
  });

  it('mirrors an unconsumed static Promise.all aggregate holding a failed dispatch', async () => {
    // R10-9: the aggregate built by the native static never passes
    // through the observed then, so without the static wrapper this
    // shape escaped the mirror entirely and fired a process-level
    // unhandledRejection (Node's default terminates headless hosts).
    // Exactly ONE line is expected: the elements are consumed by the
    // static's internal attach, only the aggregate reports.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: (prompt: string) =>
        prompt === 'bad'
          ? Promise.reject(new Error('all-boom'))
          : Promise.resolve('ok:' + prompt),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(
        `Promise.all([agent('a'), agent('bad')]); return 'done';`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): all-boom',
    ]);
  });

  it('does not mirror a static Promise.all aggregate the script consumes', async () => {
    // Consumption tracking works through the wrapped aggregate's own
    // observed then — an awaited aggregate is handled, no mirror line.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: (prompt: string) =>
        prompt === 'bad'
          ? Promise.reject(new Error('all-boom'))
          : Promise.resolve('ok:' + prompt),
    });
    await sandbox.run(`
      try { await Promise.all([agent('a'), agent('bad')]); }
      catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['handled: all-boom']);
  });

  // R11-3: await / Promise.resolve adoption of an ObservedPromise
  // attaches through the observed then with the adopting promise's
  // native capability pair. Adoption consumes (clearing a recorded
  // verdict) but is NOT handling: the rejection transfers into the
  // (unobserved) adopting promise, and the run-level escape hook
  // surfaces forgotten transfers instead of letting them escape with
  // no log, alarm, or telemetry.
  it('mirrors a forgotten dispatch failure inside an async wrapper (adoption escape)', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('kaboom')),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(
        `async function step() { await agent('x'); } step(); return 'done';`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (rejection not handled): kaboom',
    ]);
    // The escape event itself cannot be cancelled from inside the
    // sandbox (the adopting promise is unreachable), so a host-level
    // listener still observes it — capture it here so it cannot leak
    // into the test runner.
    expect(unhandled.length).toBeGreaterThan(0);
  });

  it('mirrors every forgotten dispatch failure in an adoption fan-out', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: (prompt: string) => Promise.reject(new Error(prompt + '-boom')),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(
        `[1, 2].map(async (i) => { await agent('x' + i); }); return 'done';`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (rejection not handled): x1-boom',
      'dispatch failed (rejection not handled): x2-boom',
    ]);
  });

  it('does not mirror a dispatch failure the script awaits at the top level', async () => {
    // The adoption transfers the rejection into the script IIFE, which
    // the run observes — the failure surfaces as the run's own error,
    // never as a mirror line.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('kaboom')),
    });
    await expect(sandbox.run(`return await agent('x');`)).rejects.toThrow(
      'kaboom',
    );
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('does not mirror a dispatch failure the script catches around an await', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('kaboom')),
    });
    await sandbox.run(`
      try { await agent('x'); } catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['handled: kaboom']);
  });

  it('clears a recorded verdict when the rejection is adopted late', async () => {
    // The root rejects while still unconsumed (verdict recorded), then
    // Promise.resolve adopts it — consumption via adoption must clear
    // the verdict exactly like a delayed await.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('kaboom')),
    });
    await sandbox.run(`
      const p = agent('x');
      const q = Promise.resolve(p);
      try { await q; } catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['handled: kaboom']);
  });

  it('attributes an all-rejected Promise.any aggregate to the dispatch, not the script', async () => {
    // R11-4: the native static rejects with a fresh vm-realm
    // AggregateError carrying no markers; the attribution must be
    // derived from the element causes instead of blaming the script.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('any-boom')),
    });
    await sandbox.run(`Promise.any([agent('a'), agent('b')]); return 'done';`);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): All promises were rejected',
    ]);
  });

  it('dedupes one failed dispatch fanned out into N unconsumed branches', async () => {
    // R11-11: the mirror records one entry per observed node, but one
    // failed dispatch is one failure — the flush must emit exactly one
    // line regardless of the fan-out.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('x-boom')),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(`
        const p = agent('x');
        p.then(() => 1);
        p.then(() => 2);
        return 'done';
      `);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (rejection not handled): x-boom',
    ]);
  });

  it('does not mirror a side branch once the script attached a rejection handler to the root', async () => {
    // R11-14: the suppression keys on rejectionHandled alone — with a
    // script catch on the root, an unconsumed fulfillment-only side
    // branch stays silent even though its own entry is dispatch-failed.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('x-boom')),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(`
        const p = agent('x');
        p.catch(() => log('handled'));
        p.then((v) => v);
        return 'done';
      `);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(sandbox.getLogs()).toEqual(['handled']);
  });

  it('does not mirror an unconsumed aggregate once the script handles the element rejection', async () => {
    // R11-15: aggregate roots track rejectionHandled independently of
    // their elements' roots; handling the element must transitively
    // suppress the forwarded rejection on the dangling aggregate.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('x-boom')),
    });
    await sandbox.run(`
      const a = agent('x');
      Promise.all([a]);
      await a.catch((e) => log('handled: ' + e.message));
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['handled: x-boom']);
  });

  it('preserves the species contract for script-defined Promise subclasses', async () => {
    // R11-16: Promise.all/race/any called on a subclass must return a
    // subclass instance; the wrappers bypass observation for
    // non-default receivers instead of re-wrapping into ObservedPromise.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ok',
    });
    const result = await sandbox.run(`
      class P extends Promise {}
      const x = P.all([agent('a')]);
      const y = P.race([agent('b')]);
      const z = P.any([agent('c')]);
      return [x instanceof P, y instanceof P, z instanceof P];
    `);
    expect(result).toEqual([true, true, true]);
  });

  it('mirrors an unconsumed static Promise.race aggregate holding a failed dispatch', async () => {
    // R11-21: race and any aggregates need the same observation the
    // all aggregate has — without it a fire-and-forget race holding a
    // failed dispatch escapes as a process-level unhandledRejection.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: (prompt: string) =>
        prompt === 'bad'
          ? Promise.reject(new Error('bad-boom'))
          : new Promise<string>(() => {}),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(
        `Promise.race([agent('slow'), agent('bad')]); return 'done';`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): bad-boom',
    ]);
  });

  it('does not mirror Promise.any teardown rejections of an aborted run', async () => {
    // R11-30: the AggregateError carries no abort marker, so the
    // observer must also consult the run-level abort state — a
    // correctly-cancelled run with a dangling any() must stay silent.
    const controller = new AbortController();
    const rejectors: Array<(err: Error) => void> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      abortOnTimeout: controller,
      dispatch: () =>
        new Promise((_resolve, reject) => {
          rejectors.push(reject);
        }),
    });
    const runPromise = sandbox.run(
      `Promise.any([agent('a'), agent('b')]); return 'done';`,
    );
    await runPromise;
    controller.abort();
    for (const reject of rejectors) {
      reject(new Error('teardown after cancel'));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sandbox.getLogs()).toEqual([]);
  });

  it('does not mirror a post-settlement rejection whose root the script handled', async () => {
    // R11-20: pins the suppression gate in the immediate-mirror path —
    // a slow dispatch the script caught rejects only after the flush;
    // the gate keyed on rejectionHandled keeps the log free of the
    // self-contradicting mirror line.
    let rejectSlow: (err: Error) => void = () => {};
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectSlow = reject;
        }),
    });
    const runPromise = sandbox.run(`
      const p = agent('slow');
      p.catch(() => log('handled late'));
      p.then((v) => v);
      return 'done';
    `);
    await runPromise;
    rejectSlow(new Error('slow-boom'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(sandbox.getLogs()).toEqual(['handled late']);
  });

  it('flushes mirror entries when the script throws synchronously after a fire-and-forget dispatch', async () => {
    // R11-10 companion: the flush lives in the finally that wraps the
    // whole run body, so any throw path still surfaces queued entries.
    // (The 30s sync vm timeout is the other sync-throw member of this
    // path but is impractical to exercise in unit tests.)
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('boom')),
    });
    await expect(
      sandbox.run(`agent('a'); throw new Error('script-sync-boom');`),
    ).rejects.toThrow('script-sync-boom');
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): boom',
    ]);
  });

  it('keeps then() native-compatible when the rejection handler is a revoked Proxy', async () => {
    // R11-26: the handler introspection must be guarded — a revoked
    // Proxy wrapping a function makes property reads throw, and an
    // unguarded read made .then() throw synchronously (something
    // native then never does).
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: () => Promise.reject(new Error('kaboom')),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await sandbox.run(`
        const pair = Proxy.revocable(function () {}, {});
        pair.revoke();
        agent('x').then(undefined, pair.proxy);
        return 'done';
      `);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(result).toBe('done');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('mirrors an exotic rejection value whose message access throws', async () => {
    // R10-12: a script handler can throw a value whose property access
    // throws (getter / Proxy trap). The observer must survive it —
    // dying mid-body would turn the watched rejection into a
    // process-level unhandledRejection, the exact failure class the
    // observer exists to remove.
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: async () => 'ok',
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await sandbox.run(
        `agent('x').then(() => {
          throw { get message() { throw new Error('getter-boom'); } };
        }); return 'done';`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(sandbox.getLogs()).toEqual([
      'script handler failed (rejection not handled): [unserializable rejection value]',
    ]);
  });

  it('clears a recorded script-handler failure when the script consumes it late', async () => {
    // R10-5 probe gate: the dispatch succeeds and the script's own
    // handler rejects; the rejection is recorded at settlement time and
    // consumed by a later await. Without wfClearUnconsumed's
    // unconsumedRejections.delete(id) the flush would still report the
    // consumed failure (the rejectionHandled skip only covers
    // dispatchFailed entries).
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: (prompt: string) =>
        prompt === 'slow'
          ? new Promise((resolve) => setTimeout(() => resolve('slow-done'), 20))
          : Promise.resolve('fast-done'),
    });
    await sandbox.run(`
      const p = agent('fast').then(() => {
        throw new Error('handler-boom');
      });
      await agent('slow');
      try { await p; } catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual(['handled: handler-boom']);
  });

  it('gives each run() on a reused sandbox a fresh unconsumed-rejection verdict', async () => {
    // R10-6/R10-7 probe gate: the bookkeeping is per-run. Run 1's
    // mirrored entry must not re-log on run 2's flush (the map is
    // reset), and run 3's rejection must still take the deferred path —
    // a latched unconsumedSettled would force it through the immediate
    // mirror and produce the self-contradicting
    // 'dispatch failed...' + 'handled:' pair.
    let shouldReject = true;
    const sandbox = createWorkflowSandbox({
      args: undefined,
      dispatch: (prompt: string) => {
        if (prompt === 'flaky' && shouldReject) {
          return Promise.reject(new Error('flaky-boom'));
        }
        return Promise.resolve('ok');
      },
    });
    await sandbox.run(`agent('flaky'); return 'done';`);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): flaky-boom',
    ]);

    shouldReject = false;
    await sandbox.run(`agent('flaky'); return 'done';`);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): flaky-boom',
    ]);

    shouldReject = true;
    await sandbox.run(`
      const p = agent('flaky');
      await agent('slow');
      try { await p; } catch (e) { log('handled: ' + e.message); }
      return 'done';
    `);
    expect(sandbox.getLogs()).toEqual([
      'dispatch failed (result not consumed): flaky-boom',
      'handled: flaky-boom',
    ]);
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

  // ── Compilation ──────────────────────────────────────────────────────
  describe('compileWorkflowScript', () => {
    it('compiles a body and hands back its meta', () => {
      const { script, meta } = compileWorkflowScript(
        "export const meta = { name: 'n', description: 'd' }\nawait agent('x');",
      );
      expect(script).toBeDefined();
      expect(meta?.name).toBe('n');
    });

    it('throws on a body that does not parse', () => {
      expect(() => compileWorkflowScript("const x: string = 'a';")).toThrow(
        SyntaxError,
      );
    });

    // The body runs in strict mode, so an undeclared assignment throws
    // instead of quietly creating a sandbox global that outlives the
    // statement. Asserted through a real run, because the directive only
    // matters at execution time.
    it('runs the body in strict mode', async () => {
      const sandbox = createWorkflowSandbox({
        args: undefined,
        dispatch: async () => 'ok',
      });
      await expect(sandbox.run('undeclaredBinding = 1;')).rejects.toThrow(
        /not defined/,
      );
    });

    it('still allows a declared binding', async () => {
      const sandbox = createWorkflowSandbox({
        args: undefined,
        dispatch: async () => 'ok',
      });
      await expect(
        sandbox.run('const declared = 1; return declared;'),
      ).resolves.toBe(1);
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

    it('falls back to the plain message when there is no source frame', () => {
      expect(
        describeWorkflowCompileError(new Error('meta must be an object'), 1),
      ).toBe('meta must be an object');
    });
  });
});
