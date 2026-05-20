#!/usr/bin/env node
/**
 * Direct simulation of the listener-accumulation pattern the agent runtime
 * exhibits in long sessions. Builds a deep parent → child chain to a depth
 * the user observed (>1500 listeners) and asserts:
 *
 * 1. The OLD pattern (plain new AbortController + manual addEventListener
 *    without {once:true} or reverse cleanup) accumulates listeners on the
 *    long-lived parent — reproducing the warning.
 *
 * 2. The NEW pattern (createChildAbortController from the helper) keeps the
 *    parent listener count bounded by 1, regardless of how many short-lived
 *    children come and go.
 *
 * Run:
 *   node docs/verification/abort-controller-refactor/listener-accumulation-repro.mjs
 */

import { getEventListeners, setMaxListeners } from 'node:events';

// Inline copy of the production helper so this script has no build-step
// dependency on the @qwen-code/qwen-code-core package.
function createAbortController(maxListeners = 50) {
  const c = new AbortController();
  setMaxListeners(maxListeners, c.signal);
  return c;
}
function propagateAbort(weakChild) {
  const parent = this.deref();
  weakChild.deref()?.abort(parent?.reason);
}
function removeAbortHandler(weakHandler) {
  const parent = this.deref();
  const handler = weakHandler.deref();
  if (parent && handler) parent.removeEventListener('abort', handler);
}
function createChildAbortController(parent) {
  const child = createAbortController();
  if (!parent) return child;
  const parentSignal = parent.signal ?? parent;
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason);
    return child;
  }
  const weakChild = new WeakRef(child);
  const weakParent = new WeakRef(parentSignal);
  const handler = propagateAbort.bind(weakParent, weakChild);
  parentSignal.addEventListener('abort', handler, { once: true });
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  );
  return child;
}

const ROUNDS = 2000;

console.log(`Simulating ${ROUNDS} rounds for each pattern.\n`);

// ─── OLD pattern: plain new AbortController + manual addEventListener ───
const oldParent = new AbortController();
setMaxListeners(0, oldParent.signal); // disable warning so we can measure cleanly
for (let i = 0; i < ROUNDS; i++) {
  const child = new AbortController();
  // No {once:true}, no reverse cleanup — accumulates on oldParent.
  oldParent.signal.addEventListener('abort', () => child.abort());
}
const oldCount = getEventListeners(oldParent.signal, 'abort').length;

// ─── NEW pattern: createChildAbortController ───
const newParent = createAbortController();
for (let i = 0; i < ROUNDS; i++) {
  const child = createChildAbortController(newParent);
  child.abort(); // simulate end-of-round cleanup via try/finally
}
const newCount = getEventListeners(newParent.signal, 'abort').length;

console.log(`OLD pattern listener count on long-lived parent: ${oldCount}`);
console.log(`NEW pattern listener count on long-lived parent: ${newCount}`);

const expectations = {
  oldShouldExceed: 1500,
  newMustBe: 0,
};

let pass = true;
if (oldCount <= expectations.oldShouldExceed) {
  console.error(
    `FAIL: OLD pattern should accumulate >${expectations.oldShouldExceed} listeners; got ${oldCount}`,
  );
  pass = false;
} else {
  console.log(
    `PASS: OLD pattern accumulated >${expectations.oldShouldExceed} listeners (reproduces the bug).`,
  );
}
if (newCount !== expectations.newMustBe) {
  console.error(
    `FAIL: NEW pattern must have exactly ${expectations.newMustBe} listeners; got ${newCount}`,
  );
  pass = false;
} else {
  console.log(
    `PASS: NEW pattern kept listener count at ${expectations.newMustBe} — the helper prevents accumulation.`,
  );
}

process.exit(pass ? 0 : 1);
