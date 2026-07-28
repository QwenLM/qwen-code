// Establishes the oracle semantics: what does calling getComputedWidth() on a
// yoga node AFTER its parent was freeRecursive()'d actually do in yoga-layout 3.2.x?
import Yoga from 'yoga-layout';

const parent = Yoga.Node.create();
const child = Yoga.Node.create();
child.setWidth(42);
child.setHeight(7);
parent.insertChild(child, 0);
parent.calculateLayout(100, 100);

console.log('child width BEFORE free:', child.getComputedWidth());
console.log(
  'embind wrapper identity (parent.getChild(0) === child):',
  parent.getChild(0) === child,
);

parent.freeRecursive();

try {
  console.log(
    'child width AFTER parent.freeRecursive():',
    child.getComputedWidth(),
  );
} catch (e) {
  console.log('THROWS:', e.constructor.name, '-', e.message);
}

// negative control: freshly created, never freed, never laid out
const orphan = Yoga.Node.create();
console.log('orphan (live, no layout) width:', orphan.getComputedWidth());
orphan.free();

// second probe: does repeated use-after-free stay silent?
const p2 = Yoga.Node.create();
const c2 = Yoga.Node.create();
c2.setWidth(42);
p2.insertChild(c2, 0);
p2.calculateLayout(100, 100);
console.log('c2 width before free:', c2.getComputedWidth());
p2.freeRecursive();
const reads = [];
for (let i = 0; i < 5; i++) {
  try {
    reads.push(c2.getComputedWidth());
  } catch (e) {
    reads.push(`TRAP:${e.message}`);
  }
}
console.log('c2 reads after free:', JSON.stringify(reads));

// churn the allocator, then read the freed node again — freed memory can be
// reused and rewritten, which is exactly the #6820 failure mode
const churn = [];
for (let i = 0; i < 2000; i++) {
  const n = Yoga.Node.create();
  n.setWidth(i % 500);
  churn.push(n);
}
try {
  console.log('c2 width after allocator churn:', c2.getComputedWidth());
} catch (e) {
  console.log('c2 TRAPS after churn:', e.constructor.name, '-', e.message);
}
for (const n of churn) n.free();
