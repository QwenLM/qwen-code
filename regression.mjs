// PR 7816 regression suite — proves the new clearStaticNodeIfContained walk
// preserves every behavior the old identity-check code handled:
//   REG1: normal <Static> usage (items append, rendered once)
//   REG2: DIRECT removal of <Static> still clears staticNode (old check's case)
//   REG3: key-driven remount of <Static> does NOT clear the newly-registered
//         node (the case the old code's comment explicitly protected)
//   REG4: key-driven remount of an ANCESTOR of <Static> — same protection
//   REG5: recovery — ancestor unmount, then remount: staticNode re-registers
//         and new static items render
import React from 'react';
import { render, Box, Text, Static } from 'ink';
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
const makeStdin = () =>
  Object.assign(new EventEmitter(), {
    isTTY: false,
    setEncoding() {},
    setRawMode() {},
    read: () => null,
    unref() {},
    ref() {},
    pause() {},
    resume() {},
  });

async function scenario(name, element, steps, inspect) {
  const stdout = new FakeStdout();
  const inst = render(element, {
    stdout,
    stdin: makeStdin(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await sleep(60);
  const root = instances.get(stdout).rootNode;
  const ctx = { inst, root, stdout, checkpoints: {} };
  for (const step of steps) {
    await step(ctx);
    await sleep(60);
  }
  const result = inspect(ctx);
  inst.unmount();
  await sleep(20);
  return { name, ...result };
}

const results = { label, scenarios: [] };
const count = (haystack, needle) => haystack.split(needle).length - 1;

// REG1 — normal Static append
function ListApp({ items }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { items }, (it) => h(Text, { key: it }, `history-${it}`)),
    h(Text, null, 'live'),
  );
}
results.scenarios.push(
  await scenario(
    'REG1 normal Static append',
    h(ListApp, { items: ['a'] }),
    [
      ({ inst }) => inst.rerender(h(ListApp, { items: ['a', 'b'] })),
      ({ inst }) => inst.rerender(h(ListApp, { items: ['a', 'b', 'c'] })),
    ],
    ({ root, stdout }) => {
      const last = stdout.writes.at(-1) ?? '';
      return {
        staticNodeSet: Boolean(root.staticNode),
        lastFrameCounts: {
          a: count(last, 'history-a'),
          b: count(last, 'history-b'),
          c: count(last, 'history-c'),
        },
        pass:
          Boolean(root.staticNode) &&
          count(last, 'history-a') === 1 &&
          count(last, 'history-b') === 1 &&
          count(last, 'history-c') === 1,
      };
    },
  ),
);

// REG2 — direct removal of <Static> itself
function DirectRemove({ keep }) {
  return h(
    Box,
    { flexDirection: 'column' },
    keep
      ? h(Static, { items: ['x'] }, (it) => h(Text, { key: it }, `s-${it}`))
      : null,
    h(Text, null, 'live'),
  );
}
results.scenarios.push(
  await scenario(
    'REG2 direct <Static> removal clears staticNode',
    h(DirectRemove, { keep: true }),
    [
      ({ root, checkpoints }) => {
        checkpoints.staticBefore = root.staticNode;
      },
      ({ inst }) => inst.rerender(h(DirectRemove, { keep: false })),
    ],
    ({ root, checkpoints }) => ({
      staticNodeWasSet: Boolean(checkpoints.staticBefore),
      staticNodeAfterDirectRemoval:
        root.staticNode === undefined ? 'CLEARED' : 'STILL SET',
      pass: Boolean(checkpoints.staticBefore) && root.staticNode === undefined,
    }),
  ),
);

// REG3 — key-driven remount of <Static>
function KeyedStatic({ k }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { key: `st-${k}`, items: [`k${k}`] }, (it) =>
      h(Text, { key: it }, `keyed-${it}`),
    ),
    h(Text, null, 'live'),
  );
}
results.scenarios.push(
  await scenario(
    'REG3 <Static key> remount keeps new registration',
    h(KeyedStatic, { k: 1 }),
    [
      ({ root, checkpoints }) => {
        checkpoints.staticBefore = root.staticNode;
      },
      ({ inst }) => inst.rerender(h(KeyedStatic, { k: 2 })),
    ],
    ({ root, checkpoints, stdout }) => ({
      staticNodeAfterRemount:
        root.staticNode === undefined
          ? 'CLEARED (regression!)'
          : root.staticNode === checkpoints.staticBefore
            ? 'same node (unexpected)'
            : 'NEW node registered',
      newItemsRendered: count(stdout.writes.at(-1) ?? '', 'keyed-k2') === 1,
      pass:
        root.staticNode !== undefined &&
        root.staticNode !== checkpoints.staticBefore &&
        count(stdout.writes.at(-1) ?? '', 'keyed-k2') === 1,
    }),
  ),
);

// REG4 — key-driven remount of an ANCESTOR of <Static>
function AncestorKeyed({ k }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { key: `wrap-${k}`, flexDirection: 'column' },
      h(Static, { items: [`w${k}`] }, (it) =>
        h(Text, { key: it }, `wrapped-${it}`),
      ),
      h(Text, null, 'inner'),
    ),
  );
}
results.scenarios.push(
  await scenario(
    'REG4 ancestor key remount keeps new registration',
    h(AncestorKeyed, { k: 1 }),
    [
      ({ root, checkpoints }) => {
        checkpoints.staticBefore = root.staticNode;
      },
      ({ inst }) => inst.rerender(h(AncestorKeyed, { k: 2 })),
    ],
    ({ root, checkpoints, stdout }) => ({
      staticNodeAfterAncestorRemount:
        root.staticNode === undefined
          ? 'CLEARED (regression!)'
          : root.staticNode === checkpoints.staticBefore
            ? 'same node (unexpected)'
            : 'NEW node registered',
      newItemsRendered: count(stdout.writes.at(-1) ?? '', 'wrapped-w2') === 1,
      pass:
        root.staticNode !== undefined &&
        root.staticNode !== checkpoints.staticBefore &&
        count(stdout.writes.at(-1) ?? '', 'wrapped-w2') === 1,
    }),
  ),
);

// REG5 — recovery: ancestor unmount then remount (transcript close)
function Toggle({ show, gen }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'shell'),
    show
      ? h(
          Box,
          { flexDirection: 'column' },
          h(Static, { items: [`g${gen}`] }, (it) =>
            h(Text, { key: it }, `gen-${it}`),
          ),
          h(Text, null, 'app'),
        )
      : h(Text, null, 'transcript'),
  );
}
results.scenarios.push(
  await scenario(
    'REG5 recovery after unmount->remount',
    h(Toggle, { show: true, gen: 1 }),
    [
      ({ inst }) => inst.rerender(h(Toggle, { show: false, gen: 1 })),
      ({ root, checkpoints }) => {
        checkpoints.staticWhileHidden = root.staticNode;
      },
      ({ inst }) => inst.rerender(h(Toggle, { show: true, gen: 2 })),
    ],
    ({ root, checkpoints, stdout }) => ({
      staticNodeWhileHidden:
        checkpoints.staticWhileHidden === undefined ? 'cleared' : 'dangling',
      staticNodeAfterRemount: root.staticNode ? 'REGISTERED' : 'missing',
      newItemsRendered: count(stdout.writes.at(-1) ?? '', 'gen-g2') === 1,
      pass:
        Boolean(root.staticNode) &&
        count(stdout.writes.at(-1) ?? '', 'gen-g2') === 1,
    }),
  ),
);

results.allPass = results.scenarios.every((s) => s.pass);
console.log(JSON.stringify(results, null, 2));
