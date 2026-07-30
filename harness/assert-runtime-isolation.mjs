import fs from 'node:fs';

const head = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const rows = [];
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  ok ? pass++ : fail++;
};

const CONFLICT = 'This session is already open in another Qwen process.';
const names = (r) => (r.json.sessions ?? []).map((s) => s.displayName);

// ---- head: everything stays inside the selected runtime (RT2) -----------
check(
  'head/list: workspace-qualified listing reads the SELECTED runtime root',
  names(head.listing).length > 0 &&
    names(head.listing).every((n) => n.startsWith('SELECTED-RUNTIME rt2')),
  JSON.stringify(names(head.listing)),
);
check(
  'head/delete: removes the transcript in the selected runtime root',
  head.deleteRouting.json.removed?.includes(head.ids.routing) &&
    head.afterRouting.routing.rt2.exists === false,
  JSON.stringify(head.afterRouting.routing),
);
check(
  'head/delete: leaves the primary-runtime decoy untouched',
  head.afterRouting.routing.rt1decoy.exists === true &&
    head.afterRouting.routing.rt1decoy.ino === head.before.routing.rt1decoy.ino,
  JSON.stringify(head.afterRouting.routing.rt1decoy),
);
check(
  'head/lock: a lease held in the SELECTED runtime root blocks the delete',
  head.deleteLockRight.json.errors?.[0]?.error === CONFLICT &&
    head.afterLocks.lockRight.rt2.exists === true,
  JSON.stringify(head.deleteLockRight.json),
);
check(
  'head/lock: a lease held in the PRIMARY runtime root does not block ws2 work',
  head.deleteLockWrong.json.removed?.includes(head.ids.lockWrong) &&
    head.afterLocks.lockWrong.rt2.exists === false,
  JSON.stringify(head.deleteLockWrong.json),
);
check(
  'head: lock files landed in both roots, so the two roots were genuinely distinct',
  head.lockDirs.rt2.length === 1 && head.lockDirs.rt1.length === 1,
  JSON.stringify(head.lockDirs),
);

// ---- base control: expected to resolve through the primary runtime ------
check(
  'base/list: CONTROL — base listing reads the PRIMARY runtime root (expected red)',
  names(base.listing).length > 0 &&
    names(base.listing).every((n) => n.startsWith('PRIMARY-RUNTIME-DECOY rt1')),
  JSON.stringify(names(base.listing)),
);
check(
  'base/delete: CONTROL — base deletes the decoy and reports success while the real transcript survives (expected red)',
  base.deleteRouting.json.removed?.includes(base.ids.routing) &&
    base.afterRouting.routing.rt1decoy.exists === false &&
    base.afterRouting.routing.rt2.exists === true,
  JSON.stringify(base.afterRouting.routing),
);
check(
  'base/lock: CONTROL — a lease in the selected runtime root does not protect anything on base (expected red)',
  (base.deleteLockRight.json.errors ?? []).length === 0 &&
    base.deleteLockRight.json.removed?.includes(base.ids.lockRight),
  JSON.stringify(base.deleteLockRight.json),
);

for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`      ${r.detail}`);
}
console.log(`\npass=${pass} fail=${fail} total=${pass + fail}`);
fs.writeFileSync(
  process.argv[4],
  JSON.stringify({ pass, fail, total: pass + fail, rows }, null, 2),
);
process.exit(fail === 0 ? 0 : 1);
