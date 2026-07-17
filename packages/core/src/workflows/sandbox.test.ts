/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  runInSandbox,
  WorkflowScriptError,
  type SandboxBridges,
} from './sandbox.js';

/** A bridge whose agent() always resolves a text envelope. */
function okBridges(over: Partial<SandboxBridges> = {}): SandboxBridges {
  return {
    agent: (_p, _o, resolve) =>
      resolve(JSON.stringify({ kind: 'text', text: 'ok' })),
    log: () => {},
    phase: () => {},
    budgetTotal: () => 1000,
    budgetSpent: () => 0,
    ...over,
  };
}

describe('sandbox escape attempts (SECURITY)', () => {
  it('has no require / import / process / Buffer / fetch', async () => {
    const r = await runInSandbox(
      `return {
        req: typeof require,
        proc: typeof process,
        buf: typeof Buffer,
        fetch: typeof fetch,
        gt: typeof globalThis.process,
      };`,
      okBridges(),
    );
    expect(r).toEqual({
      req: 'undefined',
      proc: 'undefined',
      buf: 'undefined',
      fetch: 'undefined',
      gt: 'undefined',
    });
  });

  it('HEADLINE: a primitive constructor chain cannot reach host process', async () => {
    // If someone "simplifies" by injecting the host function directly, this
    // returns the host process and the test fails — that is the point.
    const r = await runInSandbox(
      `return agent.constructor.constructor('return typeof process')();`,
      okBridges(),
    );
    expect(r).toBe('undefined');
  });

  it('this/Function constructor chains stay in-realm', async () => {
    const r = await runInSandbox(
      `const a = (function(){ return this; })();
       const viaThis = ({}).constructor.constructor('return typeof process')();
       const viaFn = (new Function('return typeof process'))();
       return { viaThis, viaFn };`,
      okBridges(),
    );
    expect(r).toEqual({ viaThis: 'undefined', viaFn: 'undefined' });
  });

  it('a caught agent rejection exposes only a context Error', async () => {
    const r = await runInSandbox(
      `try { await agent('x'); return 'no-throw'; }
       catch (e) { return e.constructor.constructor('return typeof process')(); }`,
      okBridges({ agent: (_p, _o, _res, reject) => reject('boom') }),
    );
    expect(r).toBe('undefined');
  });

  it('dynamic import() is unavailable', async () => {
    const r = await runInSandbox(
      `try { await import('node:fs'); return 'imported'; }
       catch (e) { return 'blocked'; }`,
      okBridges(),
    );
    expect(r).toBe('blocked');
  });

  it('prototype pollution inside the context cannot touch host objects', async () => {
    await runInSandbox(
      `try { Object.prototype.polluted = 'x'; } catch (e) {} return 1;`,
      okBridges(),
    );
    // Host Object.prototype is a different realm intrinsic — untouched.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  // REGRESSION (Opus, task 5 review): the host `await`s the context result
  // promise, which invokes its `then`. If the script could reassign
  // `Promise.prototype.then`, the host would hand its OWN resolve/reject
  // callbacks (host-realm functions) into script code, and
  // `onF.constructor.constructor('return process')()` would return the real
  // host `process` — a full escape. This was empirically reproducible before
  // `Promise` / `Promise.prototype` were frozen. These two tests prove the
  // hatch is sealed.
  it('Promise and Promise.prototype are frozen', async () => {
    const r = await runInSandbox(
      `return {
        p: Object.isFrozen(Promise),
        pp: Object.isFrozen(Promise.prototype),
      };`,
      okBridges(),
    );
    expect(r).toEqual({ p: true, pp: true });
  });

  it('reassigning Promise.prototype.then is denied (closes the host-await leak)', async () => {
    // On the unfixed sandbox this assignment succeeds and the host `await`
    // leaks host-realm callbacks to `evil`. With the prototype frozen, the
    // strict-mode assignment throws before `then` can ever be substituted.
    const r = await runInSandbox(
      `let leaked = 'sealed';
       try {
         Promise.prototype.then = function (onF) {
           try { leaked = 'reached:' + typeof onF.constructor.constructor('return process')(); } catch (e) {}
           return { then: () => {} };
         };
         leaked = 'mutated';
       } catch (e) { leaked = 'frozen'; }
       return leaked;`,
      okBridges(),
    );
    expect(r).toBe('frozen');
  });
});

describe('sandbox determinism guards', () => {
  it('Date.now(), argless new Date(), Math.random() throw; new Date(arg) works', async () => {
    const r = await runInSandbox(
      `const out = {};
       for (const [k, fn] of [
         ['now', () => Date.now()],
         ['date', () => new Date()],
         ['rand', () => Math.random()],
       ]) { try { fn(); out[k] = 'no-throw'; } catch (e) { out[k] = e.message.includes('deterministic') ? 'threw' : 'wrong-msg'; } }
       out.withArg = new Date(0).getTime();
       return out;`,
      okBridges(),
    );
    expect(r).toEqual({
      now: 'threw',
      date: 'threw',
      rand: 'threw',
      withArg: 0,
    });
  });

  // REGRESSION (Opus, task 5 review): the determinism guard must not be
  // reachable around. Before the fix, `new Date(0).constructor` was the real
  // Date (so `.now()` returned a live timestamp) and `Date.now` was writable
  // (so `Date.now = () => 5` silently replaced the guard). Both defeat
  // journaled-replay determinism (design requirement #5).
  it('the determinism guard cannot be bypassed via constructor or reassignment', async () => {
    const r = await runInSandbox(
      `const out = {};
       try { new Date(0).constructor.now(); out.viaCtor = 'no-throw'; }
       catch (e) { out.viaCtor = e.message.includes('deterministic') ? 'threw' : 'wrong-msg'; }
       try { Date.now = () => 5; out.reassign = (Date.now() === 5) ? 'bypassed' : 'no-effect'; }
       catch (e) { out.reassign = 'frozen'; }
       return out;`,
      okBridges(),
    );
    expect(r).toEqual({ viaCtor: 'threw', reassign: 'frozen' });
  });
});

describe('sandbox primitives + result marshalling', () => {
  it('agent() returns the envelope value; args parse in-context', async () => {
    const r = await runInSandbox(
      `const t = await agent('hi'); return { t, a: args.n + 1 };`,
      okBridges(),
      { argsJson: JSON.stringify({ n: 41 }) },
    );
    expect(r).toEqual({ t: 'ok', a: 42 });
  });

  it('parallel settles all and nulls a thrown thunk', async () => {
    const r = await runInSandbox(
      `return await parallel([
         () => agent('a'),
         () => { throw new Error('nope'); },
         () => agent('c'),
       ]);`,
      okBridges(),
    );
    expect(r).toEqual(['ok', null, 'ok']);
  });

  it('an uncaught throw becomes a WorkflowScriptError', async () => {
    await expect(
      runInSandbox(`throw new Error('kaboom'); `, okBridges()),
    ).rejects.toBeInstanceOf(WorkflowScriptError);
  });
});
