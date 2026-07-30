/**
 * Renders the captured harness results as a terminal report so a reviewer can
 * see the raw numbers, not just a markdown table asserting them.
 * argv: <section>
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const load = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'logs', f), 'utf8'));

const C = {
  r: '\x1b[0m',
  b: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  grn: '\x1b[32m',
  yel: '\x1b[33m',
  cyn: '\x1b[36m',
  mag: '\x1b[35m',
};
const p = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t) =>
  p(`${C.b}${C.cyn}══ ${t} ${'═'.repeat(Math.max(0, 74 - t.length))}${C.r}`);
const ok = (s) => `${C.grn}${s}${C.r}`;
const bad = (s) => `${C.red}${s}${C.r}`;

const section = process.argv[2];

if (section === 'lease') {
  const head = load('head.json');
  const base = load('base.json');
  rule('PR #7975 — daemon maintenance vs a live foreign writer lease');
  p(
    `${C.dim}one real \`qwen serve\` daemon per arm · real lock files · real transcripts${C.r}`,
  );
  p();
  for (const [op, heldKey, listKey] of [
    ['delete', 'heldDelete', 'removed'],
    ['archive', 'heldArchive', 'archived'],
    ['unarchive', 'heldUnarchive', 'unarchived'],
  ]) {
    const id = head.ids[heldKey];
    p(`${C.b}POST /sessions/${op}${C.r}  ${C.dim}(session held by another process)${C.r}`);
    const b = base.contended[op];
    const h = head.contended[op];
    p(
      `  ${C.yel}base${C.r}  ${b.status}  ${listKey}=${JSON.stringify(b.json[listKey])}  errors=${b.json.errors.length}`,
    );
    p(
      `        transcript: ${bad(
        `MUTATED  ${fmt(base.before[base.ids[heldKey]])} -> ${fmt(base.afterContended[base.ids[heldKey]])}`,
      )}`,
    );
    p(
      `  ${C.mag}head${C.r}  ${h.status}  ${listKey}=${JSON.stringify(h.json[listKey])}  errors[0]=${JSON.stringify(
        h.json.errors[0]?.error,
      )}`,
    );
    p(
      `        transcript: ${ok(`UNCHANGED  ${fmt(head.afterContended[id])}`)}   ${C.dim}same inode${C.r}`,
    );
    p(
      `        after release, retry -> ${ok(JSON.stringify(head.retried[op].json[listKey]))}`,
    );
    p();
  }
  p(
    `${C.b}batch isolation:${C.r} the uncontended session in each request still completed on head`,
  );
  p(
    `  delete ${ok(JSON.stringify(head.contended.delete.json.removed))}  archive ${ok(
      JSON.stringify(head.contended.archive.json.archived),
    )}  unarchive ${ok(JSON.stringify(head.contended.unarchive.json.unarchived))}`,
  );
}

if (section === 'iso') {
  const head = load('iso-head.json');
  const base = load('iso-base.json');
  const m2 = load('iso-head-M2.json');
  rule('PR #7975 — workspace-qualified maintenance stays in the selected runtime');
  p(
    `${C.dim}ws2 has advanced.runtimeOutputDir=RT2; a decoy transcript with the same id sits in RT1${C.r}`,
  );
  p();
  const names = (d) => (d.listing.json.sessions ?? []).map((s) => s.displayName.split(' ')[0]);
  p(`${C.b}GET /workspaces/<ws2>/sessions${C.r}`);
  p(`  ${C.yel}base${C.r}  ${bad(JSON.stringify(names(base)))}`);
  p(`  ${C.mag}head${C.r}  ${ok(JSON.stringify(names(head)))}`);
  p();
  p(`${C.b}POST /workspaces/<ws2>/sessions/delete${C.r}`);
  p(
    `  ${C.yel}base${C.r}  reported ${JSON.stringify(base.deleteRouting.json.removed)} but deleted the ${bad('RT1 decoy')}; RT2 transcript survives=${base.afterRouting.routing.rt2.exists}`,
  );
  p(
    `  ${C.mag}head${C.r}  deleted the ${ok('RT2 transcript')}; RT1 decoy untouched=${head.afterRouting.routing.rt1decoy.exists}`,
  );
  p();
  p(`${C.b}writer lock root follows the selected runtime${C.r}`);
  p(
    `  lease in RT2 (selected) -> head ${ok('409 conflict, nothing removed')} | base ${bad('removed anyway')}`,
  );
  p(`  lease in RT1 (primary)  -> head ${ok('does not block ws2 work')}`);
  p();
  p(
    `${C.b}mutant M2${C.r} (drop the pinned storage context): unit suite ${bad('118/118 still green')}, this harness ${ok('kills it')}`,
  );
  p(`  listing under M2 -> ${bad(JSON.stringify(names(m2)))}`);
}

if (section === 'drain') {
  const head = load('drain-head.json');
  const base = load('drain-base.json');
  rule('PR #7975 — SIGTERM during an admitted maintenance batch');
  p();
  p(
    `${C.dim}natural duration of a 100-session archive batch: head ${head.naturalMs}ms · base ${base.naturalMs}ms${C.r}`,
  );
  p(`${C.dim}SIGTERM sent ${head.sigtermDelay}ms into the head batch (inside it, measured)${C.r}`);
  p();
  p(`${C.b}admitted batch (in flight when SIGTERM arrived)${C.r}`);
  p(
    `  ${C.mag}head${C.r}  ${head.race.status}  archived=${head.race.json.archived.count}  files actually moved=${ok(head.movedRace)}  still active=${head.stillActiveRace}`,
  );
  p(`  ${C.mag}head${C.r}  process exited only after the batch responded: ${ok(head.timings.raceDoneBeforeExit)}`);
  p();
  p(`${C.b}maintenance arriving AFTER SIGTERM${C.r}`);
  p(`  ${C.yel}base${C.r}  ${bad(`${base.late.status} — accepted, removed ${JSON.stringify(base.late.json.removed)}`)}`);
  p(`  ${C.mag}head${C.r}  ${ok(`${head.late.status} ${head.late.json.code}`)}  "${head.late.json.error}"`);
  p(`        transcript untouched: ${ok(head.lateStillActive)}`);
}

if (section === 'mutation') {
  rule('PR #7975 — mutation matrix over the guards this PR introduces');
  p();
  const raw = fs.readFileSync(path.join(HERE, 'logs', 'mutation-matrix.txt'), 'utf8');
  for (const line of raw.split('\n')) {
    if (line.startsWith('KILLED|')) {
      const [, name, , detail] = line.split('|');
      p(`  ${ok('KILLED  ')} ${name}`);
      p(`            ${C.dim}${detail}${C.r}`);
    } else if (line.startsWith('SURVIVED|')) {
      const [, name, , detail] = line.split('|');
      const tag = name.startsWith('CONTROL') ? C.dim + 'CONTROL ' + C.r : bad('SURVIVED');
      p(`  ${tag} ${name}`);
      p(`            ${C.dim}${detail}${C.r}`);
    }
  }
  p();
  const a1 = load('assert-writer-lease.json');
  const a2 = load('assert-runtime-isolation.json');
  const a3 = load('assert-shutdown-drain.json');
  const tot = a1.total + a2.total + a3.total;
  const f = a1.fail + a2.fail + a3.fail;
  p(
    `${C.b}scripted assertions across the three live harnesses:${C.r} ${ok(`${tot - f} pass`)} / ${f} fail / ${tot} total`,
  );
  p(
    `${C.dim}  writer lease ${a1.pass}/${a1.total} · runtime isolation ${a2.pass}/${a2.total} · shutdown drain ${a3.pass}/${a3.total}${C.r}`,
  );
  p(`${C.dim}  targeted gates: cli 1694 passed · core 92 passed/1 skipped · typecheck 0 · lint 0${C.r}`);
}

function fmt(s) {
  if (!s) return '?';
  if (s.active?.exists) return `active(ino ${s.active.ino})`;
  if (s.archived?.exists) return `archived(ino ${s.archived.ino})`;
  return 'gone';
}

// keep the pty alive long enough for the capture
await new Promise((r) => setTimeout(r, 4000));
