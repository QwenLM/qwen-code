/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  runInSandbox,
  SOURCE_MAX_BYTES,
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

  // REGRESSION (Opus review): the ECMA-402 `Intl` intrinsic is a realm global
  // that reads %Date.now% directly, bypassing GuardedDate.
  // `new Intl.DateTimeFormat(...).format()` returns live wall-clock and
  // `.resolvedOptions().timeZone` leaks the host timezone — both defeat
  // journaled-replay determinism. It is deleted from the context entirely.
  it('Intl is removed so wall-clock/timezone cannot leak past the Date guard', async () => {
    const r = await runInSandbox(
      `const out = { present: typeof Intl };
       try {
         new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long' }).format();
         out.format = 'no-throw';
       } catch (e) { out.format = 'threw'; }
       try {
         const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
         out.tz = 'leaked:' + tz;
       } catch (e) { out.tz = 'threw'; }
       return out;`,
      okBridges(),
    );
    expect(r).toEqual({ present: 'undefined', format: 'threw', tz: 'threw' });
  });

  // REGRESSION (Opus re-review): even with Intl deleted and the live clock
  // blocked, a FIXED epoch still leaked the host timezone/locale through the
  // LOCAL Date accessors — new Date(0).getTimezoneOffset()/.getHours()/
  // .getDay()/.toString()/.toLocaleString() all vary by host TZ with no live
  // clock, and Number.prototype.toLocaleString varies by host locale. All of
  // that breaks journaled replay across hosts in different zones. The whole
  // host-local surface now throws the determinism error; getTimezoneOffset
  // returns 0; and the UTC/epoch surface stays intact.
  it('fixed-epoch host-local Date/locale reads throw; UTC surface stays intact', async () => {
    const r = await runInSandbox(
      `const d = new Date(0);
       const probe = (fn) => {
         try { const v = fn(); return 'no-throw:' + v; }
         catch (e) { return e.message.includes('deterministic') ? 'threw' : 'wrong-msg'; }
       };
       return {
         // getTimezoneOffset is the one host-local reader that returns (0), not throws.
         tzOffset: new Date(0).getTimezoneOffset(),
         // Local getters must all throw (getMilliseconds included: sub-minute
         // historical offsets, e.g. Kolkata's pre-1906 +05:53:28, make it leak).
         getHours: probe(() => d.getHours()),
         getDay: probe(() => d.getDay()),
         getFullYear: probe(() => d.getFullYear()),
         getMinutes: probe(() => d.getMinutes()),
         getSeconds: probe(() => d.getSeconds()),
         getMilliseconds: probe(() => d.getMilliseconds()),
         // Local setters poison the retained getTime()/toISOString() path.
         setHours: probe(() => { const x = new Date(0); x.setHours(5); return x.getTime(); }),
         setFullYear: probe(() => { const x = new Date(0); x.setFullYear(2000); return x.getTime(); }),
         // String/locale formatters.
         toString: probe(() => d.toString()),
         toDateString: probe(() => d.toDateString()),
         toTimeString: probe(() => d.toTimeString()),
         toLocaleString: probe(() => d.toLocaleString()),
         toLocaleDateString: probe(() => d.toLocaleDateString()),
         toLocaleTimeString: probe(() => d.toLocaleTimeString()),
         numLocale: probe(() => (1234.5).toLocaleString()),
         bigintLocale: probe(() => (1234n).toLocaleString()),
         strCompare: probe(() => 'a'.localeCompare('b')),
         strLower: probe(() => 'A'.toLocaleLowerCase()),
         // UTC/epoch surface must still work and be host-independent.
         getTime: new Date(0).getTime(),
         iso: new Date(0).toISOString(),
         utc: new Date(0).toUTCString(),
         utcHours: new Date(0).getUTCHours(),
         utcDay: new Date(0).getUTCDay(),
         json: JSON.stringify(new Date(0)),
       };`,
      okBridges(),
    );
    expect(r).toEqual({
      tzOffset: 0,
      getHours: 'threw',
      getDay: 'threw',
      getFullYear: 'threw',
      getMinutes: 'threw',
      getSeconds: 'threw',
      getMilliseconds: 'threw',
      setHours: 'threw',
      setFullYear: 'threw',
      toString: 'threw',
      toDateString: 'threw',
      toTimeString: 'threw',
      toLocaleString: 'threw',
      toLocaleDateString: 'threw',
      toLocaleTimeString: 'threw',
      numLocale: 'threw',
      bigintLocale: 'threw',
      strCompare: 'threw',
      strLower: 'threw',
      getTime: 0,
      iso: '1970-01-01T00:00:00.000Z',
      utc: 'Thu, 01 Jan 1970 00:00:00 GMT',
      utcHours: 0,
      utcDay: 4,
      json: '"1970-01-01T00:00:00.000Z"',
    });
  });

  // REGRESSION (Opus re-review): host-local INSTANT construction. A tz-less
  // datetime string and multi-arg `new Date(y, m, d, ...)` are interpreted in
  // host-local time, so getTime()/toISOString() diverge across hosts before any
  // accessor runs. These now throw; host-independent inputs (numeric epoch,
  // date-only, and Z/offset strings) are still accepted and exact.
  it('host-local Date construction throws; host-independent inputs are exact', async () => {
    const r = await runInSandbox(
      `const probe = (fn) => {
         try { return 'ok:' + fn(); }
         catch (e) { return e.message.includes('deterministic') ? 'threw' : 'wrong-msg'; }
       };
       return {
         tzlessString: probe(() => new Date('2020-06-01T12:00:00').getTime()),
         legacyString: probe(() => new Date('June 1, 2020 12:00:00').getTime()),
         multiArg: probe(() => new Date(2020, 0, 1).getTime()),
         parseTzless: probe(() => Date.parse('2020-06-01T12:00:00')),
         // Host-independent inputs stay usable and exact.
         epoch: new Date(1591012800000).getTime(),
         withZ: new Date('2020-06-01T12:00:00Z').getTime(),
         withOffset: new Date('2020-06-01T12:00:00+00:00').getTime(),
         dateOnly: new Date('2020-06-01').getTime(),
         parseZ: Date.parse('2020-06-01T12:00:00Z'),
       };`,
      okBridges(),
    );
    expect(r).toEqual({
      tzlessString: 'threw',
      legacyString: 'threw',
      multiArg: 'threw',
      parseTzless: 'threw',
      epoch: 1591012800000,
      withZ: 1591012800000,
      withOffset: 1591012800000,
      dateOnly: 1590969600000,
      parseZ: 1591012800000,
    });
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

  it('a script body over SOURCE_MAX_BYTES is rejected before compilation', async () => {
    // The size check is the first line of runInSandbox, before any compile, so
    // the body need not be valid JS. One byte over the 512 KB cap must reject.
    const oversized = 'x'.repeat(SOURCE_MAX_BYTES + 1);
    await expect(runInSandbox(oversized, okBridges())).rejects.toBeInstanceOf(
      WorkflowScriptError,
    );
  });
});
