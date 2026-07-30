/**
 * Scripted assertions over the two A/B arms.
 * Control cells are encoded as expectations that BASE fails the protection —
 * a base arm that respected the lease would be an UNEXPECTED result and count
 * as a fail, because it would mean the PR is not load-bearing.
 */
import fs from 'node:fs';

const head = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const rows = [];
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  rows.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
}

const CONFLICT = 'This session is already open in another Qwen process.';
const errIds = (r) => (r.json.errors ?? []).map((e) => e.sessionId);
const errMsg = (r, id) =>
  (r.json.errors ?? []).find((e) => e.sessionId === id)?.error;

// --- head arm: the lease must be honoured -------------------------------
for (const [op, heldKey, freeKey, okList] of [
  ['delete', 'heldDelete', 'freeDelete', 'removed'],
  ['archive', 'heldArchive', 'freeArchive', 'archived'],
  ['unarchive', 'heldUnarchive', 'freeUnarchive', 'unarchived'],
]) {
  const heldId = head.ids[heldKey];
  const freeId = head.ids[freeKey];
  const r = head.contended[op];

  check(
    `head/${op}: contended session reported in errors[] as writer conflict`,
    errIds(r).includes(heldId) && errMsg(r, heldId) === CONFLICT,
    JSON.stringify(r.json.errors),
  );
  check(
    `head/${op}: contended transcript NOT mutated (same inode, same location)`,
    JSON.stringify(head.afterContended[heldId]) ===
      JSON.stringify(head.before[heldId]),
    `before=${JSON.stringify(head.before[heldId])} after=${JSON.stringify(head.afterContended[heldId])}`,
  );
  check(
    `head/${op}: uncontended session in the SAME batch still completed`,
    (r.json[okList] ?? []).includes(freeId),
    JSON.stringify(r.json[okList]),
  );
  check(
    `head/${op}: request still returns 200 (per-session error, not request-level)`,
    r.status === 200,
    String(r.status),
  );
  check(
    `head/${op}: succeeds after the foreign lease is released`,
    (head.retried[op].json[okList] ?? []).includes(heldId) &&
      (head.retried[op].json.errors ?? []).length === 0,
    JSON.stringify(head.retried[op].json),
  );
  check(
    `head/${op}: transcript actually moved/removed on the retry`,
    JSON.stringify(head.afterRetry[heldId]) !==
      JSON.stringify(head.before[heldId]),
    `before=${JSON.stringify(head.before[heldId])} afterRetry=${JSON.stringify(head.afterRetry[heldId])}`,
  );

  // --- base control: EXPECTED to mutate under the foreign lease ---------
  const b = base.contended[op];
  const bHeld = base.ids[heldKey];
  check(
    `base/${op}: CONTROL — base mutates the transcript despite the live lease (expected red)`,
    JSON.stringify(base.afterContended[bHeld]) !==
      JSON.stringify(base.before[bHeld]) &&
      (b.json.errors ?? []).length === 0 &&
      (b.json[okList] ?? []).includes(bHeld),
    `base reported ${JSON.stringify(b.json)} and file went ${JSON.stringify(base.before[bHeld])} -> ${JSON.stringify(base.afterContended[bHeld])}`,
  );
}

// --- both arms saw a real lock file on disk ------------------------------
check(
  'both arms: foreign writer produced real lock files under <runtime>/tmp/session-writer-locks',
  head.lockFilesHeld.length === 3 && base.lockFilesHeld.length === 3,
  `head=${head.lockFilesHeld.length} base=${base.lockFilesHeld.length}`,
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
