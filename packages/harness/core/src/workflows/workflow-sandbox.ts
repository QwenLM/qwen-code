/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';

export const DEFAULT_WORKFLOW_SYNC_TIMEOUT_MS = 30_000;

type WorkflowTimeout = ReturnType<typeof setTimeout>;
type WorkflowTimerHandler = (...args: unknown[]) => void;

export interface WorkflowTimerGlobals {
  setTimeout: (
    handler: WorkflowTimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => WorkflowTimeout;
  clearTimeout: (timer?: WorkflowTimeout) => void;
}

export interface WorkflowVmContext {
  context: vm.Context;
  cleanup: () => void;
}

export function compileWorkflowScript(scriptBody: string): vm.Script {
  const wrapped = `(async () => {\n${scriptBody}\n})()`;
  // Fast syntax check for clearer compile errors before creating vm.Script.
  Function(`async function __workflow_check__(){\n${scriptBody}\n}`);
  return new vm.Script(wrapped, { filename: 'workflow.js' });
}

export function createWorkflowVmContext(
  globals: Record<string, unknown>,
  signal?: AbortSignal,
): WorkflowVmContext {
  const timers = createWorkflowTimers(signal);
  const context = vm.createContext(
    {
      ...globals,
      ...timers.globals,
    },
    {
      codeGeneration: { strings: false, wasm: false },
    },
  );
  installDeterministicGlobals(context);
  hardenWorkflowContext(context);
  return {
    context,
    cleanup: timers.cleanup,
  };
}

function createWorkflowTimers(signal?: AbortSignal): {
  globals: WorkflowTimerGlobals;
  cleanup: () => void;
} {
  const timers = new Set<WorkflowTimeout>();
  const clearAll = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  signal?.addEventListener('abort', clearAll, { once: true });
  return {
    globals: {
      setTimeout: (
        handler: WorkflowTimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          handler(...args);
        }, timeout);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer?: WorkflowTimeout) => {
        if (timer) timers.delete(timer);
        clearTimeout(timer);
      },
    },
    cleanup: () => {
      signal?.removeEventListener('abort', clearAll);
      clearAll();
    },
  };
}

function installDeterministicGlobals(context: vm.Context): void {
  vm.runInContext(
    `
// Compatibility for workflows authored by the previous product guide, which
// taught callers to read the final text from result.content. The current
// runtime returns a real string; keeping this alias on the isolated VM's
// String prototype lets both forms work without rewriting user scripts or
// wrapping strings in objects that would break typeof/strict equality. A
// successful text result is always in the done state; skipped/terminal API
// outcomes still return null before reaching these aliases.
Object.defineProperty(String.prototype, "content", {
  get() { return this.valueOf(); },
  configurable: false,
  enumerable: false,
});
Object.defineProperty(String.prototype, "state", {
  get() { return "done"; },
  configurable: false,
  enumerable: false,
});

const __RealDate = Date;
function __WorkflowDate(...args) {
  if (!(this instanceof __WorkflowDate)) {
    throw new Error("Date() is unavailable in workflow scripts; pass timestamps via args.");
  }
  if (args.length === 0) {
    throw new Error("new Date() is unavailable in workflow scripts; pass timestamps via args.");
  }
  return new __RealDate(...args);
}
Object.setPrototypeOf(__WorkflowDate, __RealDate);
__WorkflowDate.prototype = __RealDate.prototype;
Object.defineProperty(__WorkflowDate.prototype, "constructor", {
  value: __WorkflowDate,
  configurable: false,
  writable: false,
});
__WorkflowDate.now = () => {
  throw new Error("Date.now() is unavailable in workflow scripts; pass timestamps via args.");
};
__WorkflowDate.parse = __RealDate.parse.bind(__RealDate);
__WorkflowDate.UTC = __RealDate.UTC.bind(__RealDate);
Date = __WorkflowDate;
Math.random = () => {
  throw new Error("Math.random() is unavailable in workflow scripts; pass deterministic values via args.");
};
`,
    context,
  );
}

function hardenWorkflowContext(context: vm.Context): void {
  vm.runInContext(
    `
delete globalThis.WebAssembly;
delete globalThis.ShadowRealm;
for (const name of [
  "Object", "Array", "Function", "Promise", "Error", "TypeError",
  "SyntaxError", "RangeError", "ReferenceError", "Map", "Set", "WeakMap",
  "WeakSet", "RegExp", "ArrayBuffer", "DataView", "Int8Array", "Uint8Array",
  "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array",
  "BigUint64Array", "URL"
]) {
  const value = globalThis[name];
  if (!value) continue;
  try { Object.freeze(value.prototype); } catch {}
  try { Object.freeze(value); } catch {}
}
try { Object.freeze(Math); } catch {}
`,
    context,
  );
}
