// Test 3 — how long does a 1-line batch (the "swap" shape) actually sit in the
// queue, across a day? Answers plan §6 question 3 and seeds §7's empirical ETA.
//
//   # submit one 1-line batch every hour for 24h, poll pending ones every 60s
//   nohup node docs/verification/batch-api/03-queue-timing.mjs --hours 24 > out/03.log 2>&1 &
//   # scale probe: one 1000-line batch, wait for it
//   node docs/verification/batch-api/03-queue-timing.mjs --once --lines 1000
//   # stats over everything recorded so far (safe to run while the loop runs)
//   node docs/verification/batch-api/03-queue-timing.mjs --summarize
//
// Records append to out/03-queue-timing.jsonl; rerunning resumes pending ids
// from out/03-pending.json, so a crash mid-day loses nothing.
import fs from 'node:fs';
import path from 'node:path';
import {
  client,
  line,
  writeJsonl,
  submit,
  sleep,
  ts,
  OUT,
  MODEL,
} from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const HOURS = Number(flag('hours') ?? 24);
const INTERVAL = Number(flag('interval') ?? 3600) * 1000;
const LINES = Number(flag('lines') ?? 1);
const POLL = 60_000;

const LOG = path.join(OUT, '03-queue-timing.jsonl');
const PENDING = path.join(OUT, '03-pending.json');
const readPending = () =>
  fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, 'utf8')) : [];
const writePending = (p) =>
  fs.writeFileSync(PENDING, JSON.stringify(p, null, 2));

if (flag('summarize')) {
  summarize();
  process.exit(0);
}

const oa = client();

async function submitOne() {
  const lines = Array.from({ length: LINES }, (_, i) =>
    line(`q${i}`, {
      model: MODEL,
      enable_thinking: false,
      max_tokens: 4,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    }),
  );
  const b = await submit(oa, writeJsonl(`03-${Date.now()}.jsonl`, lines));
  const p = readPending();
  p.push({ id: b.id, model: MODEL, lines: LINES, submitted_local: ts() });
  writePending(p);
}

async function drain() {
  const pending = readPending();
  const still = [];
  for (const p of pending) {
    const b = await oa.batches.retrieve(p.id);
    if (!['completed', 'failed', 'expired', 'cancelled'].includes(b.status)) {
      still.push(p);
      continue;
    }
    const rec = {
      ...p,
      status: b.status,
      request_counts: b.request_counts,
      created_at: b.created_at,
      in_progress_at: b.in_progress_at ?? null,
      finalizing_at: b.finalizing_at ?? null,
      completed_at:
        b.completed_at ?? b.failed_at ?? b.expired_at ?? b.cancelled_at ?? null,
    };
    rec.queue_s = rec.in_progress_at
      ? rec.in_progress_at - rec.created_at
      : null;
    rec.run_s =
      rec.in_progress_at && rec.completed_at
        ? rec.completed_at - rec.in_progress_at
        : null;
    rec.total_s = rec.completed_at ? rec.completed_at - rec.created_at : null;
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    console.log(
      ts(),
      'settled',
      p.id,
      b.status,
      `queue=${rec.queue_s}s run=${rec.run_s}s total=${rec.total_s}s`,
    );
    // Result content is irrelevant here; free the files.
    for (const id of [b.input_file_id, b.output_file_id, b.error_file_id])
      if (id) oa.files.delete(id).catch(() => {});
  }
  writePending(still);
  return still.length;
}

if (flag('once')) {
  await submitOne();
  while ((await drain()) > 0) await sleep(POLL);
  summarize();
  process.exit(0);
}

const end = Date.now() + HOURS * 3600 * 1000;
let nextSubmit = 0;
for (;;) {
  const now = Date.now();
  if (now < end && now >= nextSubmit) {
    await submitOne();
    nextSubmit = now + INTERVAL;
  }
  const left = await drain();
  if (now >= end && left === 0) break;
  await sleep(POLL);
}
summarize();

function summarize() {
  if (!fs.existsSync(LOG)) return console.log('no records yet');
  const rows = fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const groups = {};
  for (const r of rows) (groups[`${r.model}/${r.lines}-line`] ??= []).push(r);
  const q = (xs, p) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length
      ? s[Math.min(s.length - 1, Math.floor(p * s.length))]
      : null;
  };
  const out = {};
  for (const [k, rs] of Object.entries(groups)) {
    const pick = (f) => rs.map((r) => r[f]).filter((x) => x !== null);
    out[k] = {
      n: rs.length,
      completed: rs.filter((r) => r.status === 'completed').length,
      queue_s: {
        p50: q(pick('queue_s'), 0.5),
        p90: q(pick('queue_s'), 0.9),
        max: q(pick('queue_s'), 1),
      },
      run_s: {
        p50: q(pick('run_s'), 0.5),
        p90: q(pick('run_s'), 0.9),
        max: q(pick('run_s'), 1),
      },
      total_s: {
        p50: q(pick('total_s'), 0.5),
        p90: q(pick('total_s'), 0.9),
        max: q(pick('total_s'), 1),
      },
    };
  }
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(
    path.join(OUT, '03-queue-timing.summary.json'),
    JSON.stringify({ generated: ts(), ...out }, null, 2),
  );
}
