// PR 7816 A/B repro — mirrors qwen-code's real trigger path:
// AppContainer.tsx:4551 `{transcriptFreeze ? <TranscriptView/> : <App/>}` unmounts
// <App/> whose descendant MainContent.tsx renders <Static> (ancestor removal).
// Oracle: ink's own render pipeline (renderer.js:30-33 `node.staticNode?.yogaNode`
// -> getComputedWidth()) — the exact frame in issue #6820's crash stack.
import React from 'react';
import { render, Box, Text, Static } from 'ink';
import Yoga from 'yoga-layout';
import instances from './node_modules/ink/build/instances.js';
import { EventEmitter } from 'node:events';

const label = process.argv[2] ?? 'arm';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = React.createElement;

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 40;
  writes = [];
  write(s) {
    this.writes.push(s);
    return true;
  }
  hasColors() {
    return false;
  }
}
const stdout = new FakeStdout();
const stdin = Object.assign(new EventEmitter(), {
  isTTY: false,
  setEncoding() {},
  setRawMode() {},
  read: () => null,
  unref() {},
  ref() {},
  pause() {},
  resume() {},
});

// Shell = AppContainer, AppLike = <App/>, MainContentLike = MainContent(<Static>)
function MainContentLike() {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { items: ['h1', 'h2', 'h3'] }, (item) =>
      h(Text, { key: item }, `history-${item}`),
    ),
    h(Text, null, 'main-live-area'),
  );
}
function AppLike() {
  return h(Box, { flexDirection: 'column' }, h(MainContentLike));
}
function Shell({ show, tick }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, `shell tick=${tick}`),
    show ? h(AppLike) : h(Text, null, 'transcript-view'),
  );
}

const report = { label };
const inst = render(h(Shell, { show: true, tick: 0 }), {
  stdout,
  stdin,
  debug: true, // unthrottled: onRender runs synchronously per commit
  exitOnCtrlC: false,
  patchConsole: false,
});
await sleep(80);

const ink = instances.get(stdout);
const root = ink.rootNode;
report.staticRegisteredAfterMount = Boolean(root.staticNode);
const staticDomNode = root.staticNode;
const staticYoga = staticDomNode?.yogaNode;
report.staticWidthBeforeUnmount = staticYoga
  ? staticYoga.getComputedWidth()
  : null;

// the ancestor Box that React will remove when `show` flips to false
const shellBox = root.childNodes[0];
const appBox = shellBox?.childNodes?.[1];
report.removedAncestorNodeName = appBox?.nodeName;
report.ancestorContainsStatic = (() => {
  let cur = staticDomNode;
  while (cur) {
    if (cur === appBox) return true;
    cur = cur.parentNode;
  }
  return false;
})();

// Spy on the EXACT wasm-wrapper method ink's renderer calls at renderer.js:32.
// Records every access ink's own pipeline makes to this yoga node after it is freed.
const spyCalls = [];
if (staticYoga) {
  const real = staticYoga.getComputedWidth.bind(staticYoga);
  staticYoga.getComputedWidth = function () {
    let v;
    try {
      v = real();
    } catch (e) {
      spyCalls.push(`TRAP:${e.constructor.name}:${e.message}`);
      throw e;
    }
    spyCalls.push(v);
    return v;
  };
}

// ---- unmount the ANCESTOR of <Static> (the transcriptFreeze pattern) ----
const renderErrors = [];
try {
  inst.rerender(h(Shell, { show: false, tick: 1 }));
  await sleep(80);
} catch (e) {
  renderErrors.push(`rerender-unmount: ${e.constructor?.name}: ${e.message}`);
}

report.staticNodeAfterAncestorUnmount =
  root.staticNode === undefined
    ? 'CLEARED (undefined)'
    : root.staticNode === staticDomNode
      ? 'DANGLING — still points at the freed node'
      : 'points at a different node';
report.removedAncestorYogaNode = appBox
  ? appBox.yogaNode === undefined
    ? 'NULLED (undefined)'
    : 'STILL SET (stale wrapper over freed WASM memory)'
  : 'n/a';

// ---- keep rendering while (potentially) dangling — the #6820 crash window ----
for (let t = 2; t <= 4; t++) {
  try {
    inst.rerender(h(Shell, { show: false, tick: t }));
    await sleep(30);
  } catch (e) {
    renderErrors.push(`rerender-tick${t}: ${e.constructor?.name}: ${e.message}`);
  }
}
report.freedNodeAccessesByInkRenderPipeline = spyCalls.slice();

// ---- allocator churn: force the freed WASM memory to be reused, then let
// ink render once more. If the render pipeline still reads the freed node,
// the value it gets is now whatever occupies that memory (#6820's mode). ----
const before = spyCalls.length;
const churn = [];
for (let i = 0; i < 2000; i++) {
  const n = Yoga.Node.create();
  n.setWidth(i % 500);
  churn.push(n);
}
try {
  inst.rerender(h(Shell, { show: false, tick: 5 }));
  await sleep(30);
} catch (e) {
  renderErrors.push(`rerender-churn: ${e.constructor?.name}: ${e.message}`);
}
report.freedNodeReadAfterAllocatorChurn =
  spyCalls.length > before
    ? spyCalls.slice(before)
    : 'NO ACCESS — render pipeline never touched the freed node';
for (const n of churn) n.free();
report.renderErrors = renderErrors;

// direct probe of the guard at renderer.js:30 as of NOW
if (root.staticNode?.yogaNode) {
  try {
    report.rendererGuardOutcome = `guard PASSES -> getComputedWidth() on freed node returns ${root.staticNode.yogaNode.getComputedWidth()} (undefined behavior)`;
  } catch (e) {
    report.rendererGuardOutcome = `guard PASSES -> getComputedWidth() TRAPS: ${e.message}`;
  }
} else {
  report.rendererGuardOutcome =
    'guard SHORT-CIRCUITS (staticNode cleared) — freed memory never touched';
}

inst.unmount();
await sleep(30);
console.log(JSON.stringify(report, null, 2));
