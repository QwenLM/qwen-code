/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';

/** Hard cap on script source size (design: "Script source capped at 512 KB"). */
export const SOURCE_MAX_BYTES = 512 * 1024;

/**
 * Default ceiling passed to vm.runInContext's `timeout`. NOTE: this bounds ONLY
 * synchronous execution up to the first `await`. It is NOT the wall-clock
 * ceiling — that is enforced by the agent bridge's deadline check
 * (scriptRunner.ts). See the design doc's threat-model honesty note.
 */
export const SYNC_CPU_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Host-side callbacks the sandbox bridges out to. CRITICAL: every value crossing
 * the boundary in EITHER direction is a primitive string. The host MUST NOT
 * return, resolve, or throw a host object/array/promise/Error to the sandbox —
 * doing so exposes host intrinsics via `.constructor.constructor` and defeats the
 * sandbox. `agent` is callback-style (not promise-returning) so no host Promise
 * ever reaches the context.
 */
export interface SandboxBridges {
  agent(
    promptJson: string,
    optsJson: string,
    resolve: (envelopeJson: string) => void,
    reject: (message: string) => void,
  ): void;
  log(message: string): void;
  phase(title: string): void;
  budgetTotal(): number;
  budgetSpent(): number;
}

export interface RunSandboxOptions {
  /** JSON string of the caller-supplied `args` value (or undefined). */
  argsJson?: string;
  /** Synchronous-CPU timeout (ms). Default SYNC_CPU_TIMEOUT_MS. */
  syncTimeoutMs?: number;
  /** Filename for stack traces. */
  filename?: string;
}

/** Thrown when the sandboxed script rejects or throws uncaught. */
export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowScriptError';
  }
}

/**
 * In-context bootstrap: installs determinism guards + the allowlisted primitive
 * surface, then freezes intrinsics. Compiled WITH the context so its
 * Promise/JSON/Object/Error/Reflect are context intrinsics, and closes over the
 * host bridges via parameters (never global properties) so the script cannot
 * reach them.
 *
 * SECURITY (Opus, task 5): `Promise` and `Promise.prototype` are frozen here.
 * This is not merely defense-in-depth — it closes a real, empirically verified
 * escape. `runInSandbox` marshals the script result out by `await`-ing the
 * context result promise, and `await`/`Promise.resolve` invoke that promise's
 * `then`. If the script could reassign `Promise.prototype.then`, the HOST would
 * pass its own resolve/reject callbacks (host-realm functions) into
 * script-controlled code, and `onFulfilled.constructor.constructor('return
 * process')()` would return the real host `process`. Freezing the prototype
 * makes the reassignment throw before any substitution can occur; freezing the
 * `Promise` constructor (and thus its `@@species`/`prototype.constructor` chain)
 * guarantees the result promise the host awaits is always a genuine, native
 * context promise the script cannot substitute with a foreign thenable.
 */
const BOOTSTRAP_SRC = String.raw`
'use strict';
const g = globalThis;

// DETERMINISM: delete the ECMA-402 Intl intrinsic. Unlike process/Buffer it is
// a realm global present even with an Object.create(null) context object, and it
// reads %Date.now% directly — new Intl.DateTimeFormat().format() returns live
// wall-clock and .resolvedOptions().timeZone leaks the host timezone, both
// bypassing the GuardedDate guards and defeating journaled-replay determinism.
// Workflow scripts have no legitimate need for locale formatting, so remove it
// entirely. (Its property is spec-configurable; delete succeeds.)
delete g.Intl;

function determinismMessage(api) {
  return api + ' is disabled: workflow scripts must be deterministic so a ' +
    'journaled run can be replayed on resume. Derive values from agent ' +
    'results or the injected args instead.';
}

Math.random = function random() {
  throw new Error(determinismMessage('Math.random()'));
};

const RealDate = Date;

// DETERMINISM: a string argument is parsed by the engine, and tz-less datetime
// strings (plus legacy/locale strings) are interpreted in HOST-LOCAL time — so
// the resulting instant, and every downstream getTime()/toISOString() read,
// varies by host timezone even though no live clock is involved. Multi-arg
// new Date(y, m, d, ...) is likewise LOCAL-time construction. Both silently
// break journaled replay across hosts. Accept ONLY host-independent inputs:
//   * a numeric epoch (or a Date clone / other non-string coercions)
//   * a date-only string  YYYY | YYYY-MM | YYYY-MM-DD   (spec: parsed as UTC)
//   * a date-time string carrying an explicit Z or +/-HH:MM offset
// Everything else throws (fail-loud, matching Date.now()/argless-new-Date), so a
// nondeterministic instant can never be constructed silently.
const DETERMINISTIC_DATE_STRING =
  /^[0-9]{4}(-[0-9]{2}(-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?(Z|[+-][0-9]{2}:[0-9]{2}))?)?)?$/;
function GuardedDate(...a) {
  if (a.length === 0) {
    throw new Error(determinismMessage('new Date() with no arguments'));
  }
  if (a.length > 1) {
    throw new Error(
      determinismMessage('new Date(year, month, ...) local-time construction'),
    );
  }
  if (typeof a[0] === 'string' && !DETERMINISTIC_DATE_STRING.test(a[0])) {
    throw new Error(
      determinismMessage(
        'new Date(string) without an explicit Z/offset (host-local parsing)',
      ),
    );
  }
  return Reflect.construct(RealDate, a, new.target || GuardedDate);
}
GuardedDate.prototype = RealDate.prototype;
// Route instance.constructor back to the guard so real Date.now() is not
// reachable via new Date(0).constructor.now().
Object.defineProperty(GuardedDate.prototype, 'constructor', {
  value: GuardedDate,
  writable: false,
  enumerable: false,
  configurable: false,
});

// DETERMINISM: even from a FIXED instant, the LOCAL Date accessors leak the host
// timezone/locale — new Date(0).getHours()/.getDay()/.getTimezoneOffset()/
// .toString()/.toLocaleString() all differ by host with no live clock involved,
// breaking journaled replay across hosts in different zones. Neutralize the
// entire host-local surface: every host-TZ/locale-dependent getter, setter
// (setters interpret their args in LOCAL time, so an un-guarded setter would
// poison the retained getTime()/toISOString() path), and formatter throws;
// getTimezoneOffset returns 0 (the realm behaves as UTC). Overwriting drops the
// only reference to each native method — there is no recovery path. The
// UTC/epoch surface (getTime, valueOf, getUTC*, setTime, setUTC*, toISOString,
// toUTCString, toJSON) stays native so deterministic time math still works.
const dateProto = GuardedDate.prototype;
function throwsLocaleOrTz(api) {
  return function () {
    throw new Error(determinismMessage(api));
  };
}
for (const m of [
  'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes',
  'getSeconds', 'getMilliseconds', 'getYear',
  'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds',
  'setMilliseconds', 'setYear',
  'toString', 'toDateString', 'toTimeString',
  'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
]) {
  dateProto[m] = throwsLocaleOrTz('Date.prototype.' + m + '()');
}
dateProto.getTimezoneOffset = function getTimezoneOffset() {
  return 0;
};

// DETERMINISM: these remain ICU/host-locale-backed even after Intl is deleted,
// so their output varies by host locale (grouping separators, collation, locale
// case-folding). Override to throw. Array.prototype.toLocaleString delegates to
// each element's toLocaleString, so it inherits the guard for numbers/dates.
Number.prototype.toLocaleString = throwsLocaleOrTz(
  'Number.prototype.toLocaleString()',
);
BigInt.prototype.toLocaleString = throwsLocaleOrTz(
  'BigInt.prototype.toLocaleString()',
);
String.prototype.localeCompare = throwsLocaleOrTz(
  'String.prototype.localeCompare()',
);
String.prototype.toLocaleLowerCase = throwsLocaleOrTz(
  'String.prototype.toLocaleLowerCase()',
);
String.prototype.toLocaleUpperCase = throwsLocaleOrTz(
  'String.prototype.toLocaleUpperCase()',
);

GuardedDate.now = function now() {
  throw new Error(determinismMessage('Date.now()'));
};
GuardedDate.parse = function parse(s) {
  const str = String(s);
  if (!DETERMINISTIC_DATE_STRING.test(str)) {
    throw new Error(
      determinismMessage(
        'Date.parse(string) without an explicit Z/offset (host-local parsing)',
      ),
    );
  }
  return RealDate.parse(str);
};
GuardedDate.UTC = RealDate.UTC;
// Freeze so Date.now cannot be silently reassigned to defeat the guard.
Object.freeze(GuardedDate);
Object.defineProperty(g, 'Date', {
  value: GuardedDate,
  writable: false,
  enumerable: true,
  configurable: false,
});

const args = __argsJson === undefined ? undefined : JSON.parse(__argsJson);

const budget = Object.freeze({
  get total() { return __bridges.budgetTotal(); },
  spent() { return __bridges.budgetSpent(); },
  remaining() { return __bridges.budgetTotal() - __bridges.budgetSpent(); },
});

function agent(prompt, opts) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const ok = function (envelopeJson) {
      if (settled) return; settled = true;
      let env;
      try { env = JSON.parse(envelopeJson); }
      catch (e) { reject(new Error('workflow: malformed agent envelope')); return; }
      if (!env || env.kind === 'null') resolve(null);
      else if (env.kind === 'text') resolve(env.text);
      else resolve(env.value);
    };
    const fail = function (message) {
      if (settled) return; settled = true;
      reject(new Error(String(message)));
    };
    __bridges.agent(
      JSON.stringify(prompt === undefined ? null : prompt),
      JSON.stringify(opts === undefined ? {} : opts),
      ok,
      fail,
    );
  });
}

function parallel(thunks) {
  const arr = Array.from(thunks);
  return Promise.all(arr.map(function (t) {
    let p;
    try { p = t(); } catch (e) { return null; }
    return Promise.resolve(p).then(function (v) { return v; }, function () { return null; });
  }));
}

function pipeline(items) {
  const stages = Array.prototype.slice.call(arguments, 1);
  const arr = Array.from(items);
  return Promise.all(arr.map(async function (item, index) {
    let prev = item;
    for (let s = 0; s < stages.length; s++) {
      try { prev = await stages[s](prev, item, index); }
      catch (e) { return null; }
    }
    return prev;
  }));
}

function phase(title) { __bridges.phase(String(title)); }
function log(message) { __bridges.log(String(message)); }

g.agent = agent;
g.parallel = parallel;
g.pipeline = pipeline;
g.phase = phase;
g.log = log;
g.budget = budget;
Object.defineProperty(g, 'args', {
  value: args, writable: false, configurable: false, enumerable: true,
});

// Freeze intrinsics + primitives (defense-in-depth; stops the script tampering
// with its own primitives). Pollution within this realm cannot reach host
// objects (separate intrinsics) but is denied anyway.
//
// Promise / Promise.prototype are MANDATORY here (not merely hardening): they
// close the host-await then-substitution escape documented above.
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
Object.freeze(Function.prototype);
Object.freeze(Object);
Object.freeze(Function);
Object.freeze(Math);
Object.freeze(JSON);
Object.freeze(Reflect);
Object.freeze(Promise);
Object.freeze(Promise.prototype);
Object.freeze(Error);
Object.freeze(Error.prototype);
Object.freeze(agent);
Object.freeze(parallel);
Object.freeze(pipeline);
Object.freeze(phase);
Object.freeze(log);
`;

/**
 * Execute a meta-stripped script body inside a locked-down vm context. The
 * body may use top-level `await` and `return`. Returns the script's return
 * value (marshalled to the host as a JSON string — no context object crosses).
 */
export async function runInSandbox(
  body: string,
  bridges: SandboxBridges,
  opts: RunSandboxOptions = {},
): Promise<unknown> {
  if (Buffer.byteLength(body, 'utf8') > SOURCE_MAX_BYTES) {
    throw new WorkflowScriptError(
      `workflow script source exceeds ${SOURCE_MAX_BYTES} bytes`,
    );
  }

  const context = vm.createContext(Object.create(null), {
    // Allow in-context codegen so the HEADLINE escape test proves the wrapper
    // holds even when Function() executes (returns the CONTEXT global, not host).
    codeGeneration: { strings: true, wasm: false },
  });

  const bootstrap = vm.compileFunction(
    BOOTSTRAP_SRC,
    ['__bridges', '__argsJson'],
    {
      parsingContext: context,
    },
  );
  bootstrap(bridges, opts.argsJson);

  // Marshal the result back as a JSON string; never reject across the boundary.
  const runner =
    'Promise.resolve((async () => {\n"use strict";\n' +
    body +
    '\n})()).then(' +
    '__v => JSON.stringify({ ok: true, value: __v === undefined ? null : __v }),' +
    '__e => JSON.stringify({ ok: false, error: String((__e && __e.message) || __e) })' +
    ')';

  let resultJson: string;
  try {
    const resultPromise = vm.runInContext(runner, context, {
      timeout: opts.syncTimeoutMs ?? SYNC_CPU_TIMEOUT_MS,
      filename: opts.filename ?? 'workflow-script.js',
    }) as Promise<string>;
    resultJson = await resultPromise;
  } catch (err) {
    // Synchronous-CPU timeout, or a throw in the synchronous prologue. `err` may
    // be a CONTEXT-realm value (not a host Error, so `instanceof Error` is
    // false) carrying an adversarial Symbol.toPrimitive/toString — coercing it
    // could throw a host TypeError that escapes as a non-WorkflowScriptError, or
    // yield a non-string that `new Error(msg)` would then re-coerce and throw
    // on. Marshal to a guaranteed string BEFORE the constructor so any failure
    // still surfaces as a WorkflowScriptError (no host object reaches the caller).
    let message: string;
    try {
      message = err instanceof Error ? err.message : String(err);
    } catch {
      message = 'workflow script execution failed';
    }
    if (typeof message !== 'string')
      message = 'workflow script execution failed';
    throw new WorkflowScriptError(message);
  }

  const parsed = JSON.parse(resultJson) as
    | { ok: true; value: unknown }
    | { ok: false; error: string };
  if (!parsed.ok) throw new WorkflowScriptError(parsed.error);
  return parsed.value;
}
