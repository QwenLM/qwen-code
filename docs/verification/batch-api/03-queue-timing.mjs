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
  cleanup,
  download,
  OUT,
  MODEL,
} from './lib.mjs';

const argv = process.argv.slice(2);
// Strict argv: a value-less `--lines` must fail loudly, not silently probe
// with 1 line (Number(true) === 1), and a typo must not run with defaults.
const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(2);
};
const BOOLEAN_FLAGS = new Set(['once', 'summarize']);
const NUMERIC_FLAGS = new Set(['hours', 'interval', 'lines']);
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) fail(`unexpected argument ${JSON.stringify(a)}`);
  const name = a.slice(2);
  if (BOOLEAN_FLAGS.has(name)) {
    args[name] = true;
    continue;
  }
  if (NUMERIC_FLAGS.has(name)) {
    const v = argv[(i += 1)];
    if (v === undefined || v.startsWith('--') || !Number.isFinite(Number(v))) {
      fail(`--${name} needs a number, got ${JSON.stringify(v)}`);
    }
    args[name] = Number(v);
    continue;
  }
  fail(`unknown option --${name}`);
}
const HOURS = args.hours ?? 24;
const INTERVAL = (args.interval ?? 3600) * 1000;
const LINES = args.lines ?? 1;
const POLL = 60_000;
const SETTLED = new Set(['completed', 'failed', 'expired', 'cancelled']);

const LOG = path.join(OUT, '03-queue-timing.jsonl');
const PENDING = path.join(OUT, '03-pending.json');
const readPending = () =>
  fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, 'utf8')) : [];
// Write via a temp file + rename so a concurrent reader never sees a torn
// file (the README documents up to three parallel invocations).
const writePending = (p) => {
  const tmp = `${PENDING}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, PENDING);
};

if (args.summarize) {
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

// Consecutive failed polls; the --once loop gives up (leaving ids pending)
// when the endpoint is persistently unreachable rather than dying or
// spinning forever.
let pollErrorStreak = 0;
const MAX_POLL_ERROR_STREAK = 10;

async function drain() {
  const pending = readPending();
  const settled = new Set();
  for (const p of pending) {
    let b;
    try {
      b = await oa.batches.retrieve(p.id);
    } catch (error) {
      pollErrorStreak += 1;
      console.warn(
        ts(),
        'poll failed, keeping pending',
        p.id,
        error?.message ?? String(error),
      );
      continue;
    }
    pollErrorStreak = 0;
    if (!SETTLED.has(b.status)) continue;
    settled.add(p.id);
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
    // Read the failure reason before cleanup deletes the error file, or an
    // unattended run leaves no recoverable explanation for a failed batch.
    if (b.status !== 'completed' || b.error_file_id) {
      try {
        const [errLine] = await download(oa, b.error_file_id);
        rec.error =
          errLine?.error?.message ??
          errLine?.response?.body?.error?.message ??
          undefined;
      } catch {
        // Best effort: the status itself is still recorded.
      }
    }
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    console.log(
      ts(),
      'settled',
      p.id,
      b.status,
      `queue=${rec.queue_s}s run=${rec.run_s}s total=${rec.total_s}s`,
    );
    // Result content is irrelevant here; free the files. Awaited: the
    // --once branch exits right after drain, and fire-and-forget deletes
    // never reach the server (lib cleanup stays non-fatal per file).
    await cleanup(oa, b);
  }
  if (settled.size > 0) {
    // Re-read right before writing and drop only the ids this pass settled,
    // so ids a concurrent invocation submitted after our snapshot survive.
    const current = readPending();
    writePending(current.filter((p) => !settled.has(p.id)));
  }
  return readPending().length;
}

if (args.once) {
  await submitOne();
  while ((await drain()) > 0) {
    if (pollErrorStreak > MAX_POLL_ERROR_STREAK) {
      console.warn(
        ts(),
        `polling failed ${pollErrorStreak} times in a row; leaving the ids pending for a later run`,
      );
      break;
    }
    await sleep(POLL);
  }
  summarize();
  process.exit(0);
}

const end = Date.now() + HOURS * 3600 * 1000;
let nextSubmit = 0;
for (;;) {
  const now = Date.now();
  if (now < end && now >= nextSubmit) {
    try {
      await submitOne();
    } catch (error) {
      // One failed submission must not end the day-long sampling run.
      console.warn(ts(), 'submit failed', error?.message ?? String(error));
    }
    nextSubmit = now + INTERVAL;
  }
  const left = await drain();
  if (now >= end && left === 0) break;
  await sleep(POLL);
}
summarize();

function summarize() {
  if (!fs.existsSync(LOG)) return console.log('no records yet');
  // Dedupe by batch id: a crash between the LOG append and the pending
  // rewrite re-appends a settled batch on the rerun, and the percentiles
  // must not count it twice.
  const seen = new Set();
  const rows = fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => !seen.has(r.id) && seen.add(r.id));
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
    // Durations are computed over completed batches only: a failed/expired
    // one contributes a timeout-length duration, not a queue measurement.
    const done = rs.filter((r) => r.status === 'completed');
    const failed = rs.filter((r) => r.status !== 'completed');
    const pick = (f) => done.map((r) => r[f]).filter((x) => x !== null);
    out[k] = {
      n: rs.length,
      completed: done.length,
      not_completed: Object.fromEntries(
        failed.map((r) => [r.id, r.error ?? r.status]),
      ),
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
