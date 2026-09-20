// Test 2 — does context cache hit inside a batch? Answers plan §6 question 2
// and settles the §2 cost math. Three arms share one ~4k-token system prompt
// plus a distinct 3-char arm tag (so one arm's cache hit can only be produced
// by that arm's own traffic — the vendor's cache scoping is undocumented):
//   a) batch, implicit cache          b) batch, explicit cache_control
//   c) realtime control (proves the prefix caches at all)
//   node docs/verification/batch-api/02-cache.mjs
// The wait blocks for the whole completion window; both batch ids are
// persisted to out/02-pending.json right after submission and a rerun
// resumes them, so an interrupted run loses nothing.
import fs from 'node:fs';
import path from 'node:path';
import {
  client,
  line,
  writeJsonl,
  submit,
  waitFor,
  collect,
  save,
  cleanup,
  usageOf,
  cachedOf,
  ts,
  OUT,
  MODEL,
} from './lib.mjs';

const N = Number(process.env.N ?? 20);
// Relative prices, all in units of the realtime input price. Override from the
// Bailian pricing page if the model differs.
const P_OUT = Number(process.env.P_OUT ?? 2.5); // output / input price
const CACHE = Number(process.env.CACHE_RATIO ?? 0.2); // cached_token / input
const BATCH = Number(process.env.BATCH_RATIO ?? 0.5);

const oa = client();

// Deterministic ~16k chars ≈ 4k tokens, far above any implicit-cache minimum.
const para =
  'This system prompt exists only to be long and identical across every request so that the prefix cache has something to hit. It describes a fictional internal style guide: prefer short sentences, cite file paths, never speculate, and answer in the language of the question. ';
const longSystem = Array.from({ length: 60 }, (_, i) => `[${i}] ${para}`).join(
  '\n',
);
// Same length per arm, so the cost comparison stays apples-to-apples.
const ARM_SYSTEM = {
  implicit: `[a] ${longSystem}`,
  explicit: `[b] ${longSystem}`,
  control: `[c] ${longSystem}`,
};

const questions = Array.from(
  { length: N },
  (_, i) =>
    `Question ${i + 1}: what is ${i + 1} squared? Answer with the number only.`,
);
const common = {
  model: MODEL,
  enable_thinking: false,
  temperature: 0,
  max_tokens: 16,
};

const implicitLines = questions.map((q, i) =>
  line(`a${i}`, {
    ...common,
    messages: [
      { role: 'system', content: ARM_SYSTEM.implicit },
      { role: 'user', content: q },
    ],
  }),
);
const explicitLines = questions.map((q, i) =>
  line(`b${i}`, {
    ...common,
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: ARM_SYSTEM.explicit,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: q },
    ],
  }),
);

// Submit both batch arms first, run the realtime control while they queue.
// Each id goes to disk the moment its own submit resolves: `Promise.all`
// rejects as soon as either arm throws, so writing the file only after both
// would drop the surviving arm's id — a live, billing job that the documented
// rerun then submits a second time, contaminating the very cache measurement
// this probe exists to make.
const PENDING = path.join(OUT, '02-pending.json');
const readPending = () =>
  fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, 'utf8')) : {};
// Sync read + write, no await between: two arms resolving concurrently cannot
// clobber each other's key.
const writePending = (patch) =>
  fs.writeFileSync(PENDING, JSON.stringify({ ...readPending(), ...patch }));

const submitArm = async (key, name, lines) => {
  const saved = readPending()[key];
  if (saved) {
    console.log(ts(), `resuming arm ${key} from pending batch id ${saved}`);
    return { id: saved };
  }
  const sub = await submit(oa, writeJsonl(name, lines));
  writePending({ [key]: sub.id });
  return sub;
};

const [subA, subB] = await Promise.all([
  submitArm('A', '02-cache-implicit.jsonl', implicitLines),
  submitArm('B', '02-cache-explicit.jsonl', explicitLines),
]);

// The control is a convenience baseline, not a gate worth losing the paid
// arms over: a failed control request is counted, not fatal.
const realtime = [];
const realtimeFailures = [];
for (const [i, q] of questions.entries()) {
  try {
    const r = await oa.chat.completions.create({
      ...common,
      messages: [
        { role: 'system', content: ARM_SYSTEM.control },
        { role: 'user', content: q },
      ],
    });
    realtime.push({ custom_id: `c${i}`, response: { body: r } });
  } catch (error) {
    realtimeFailures.push(`c${i}: ${error?.message ?? String(error)}`);
    console.warn(
      ts(),
      `realtime control c${i} failed:`,
      error?.message ?? error,
    );
  }
}

const [batchA, batchB] = await Promise.all([
  waitFor(oa, subA.id),
  waitFor(oa, subB.id),
]);
const A = await collect(oa, batchA);
const B = await collect(oa, batchB);

function summarize(rows, multiplier) {
  const per = rows.map((r) => {
    const u = usageOf(r) ?? {};
    return {
      id: r.custom_id,
      prompt: u.prompt_tokens ?? 0,
      cached: cachedOf(r),
      completion: u.completion_tokens ?? 0,
    };
  });
  const sum = (k) => per.reduce((s, x) => s + x[k], 0);
  const prompt = sum('prompt'),
    cached = sum('cached'),
    completion = sum('completion');
  // cost in realtime-input-price units
  const cost =
    ((prompt - cached) * 1 + cached * CACHE + completion * P_OUT) * multiplier;
  return {
    lines: per.length,
    lines_with_cache_hit: per.filter((x) => x.cached > 0).length,
    first_line_cached: per[0]?.cached ?? null,
    prompt_tokens: prompt,
    cached_tokens: cached,
    completion_tokens: completion,
    hit_rate: prompt ? +(cached / prompt).toFixed(3) : 0,
    relative_cost: +cost.toFixed(1),
    cost_per_line: per.length ? +(cost / per.length).toFixed(3) : null,
    per,
  };
}

// Summarise every output row, not just the successful ones: a failed line
// comes back inside the OUTPUT file as response.status_code !== 200 (a
// zero-token row), and `complete()` below needs the true line count to tell a
// full arm from one that lost requests. `collect()` reports those rows as
// `failed`, so the pass gate still refuses to publish a ratio over them.
const a = summarize(A.rows, BATCH);
const b = summarize(B.rows, BATCH);
const c = summarize(realtime, 1);
const aFailed = A.failed + A.err.length;
const bFailed = B.failed + B.err.length;
const cFailed = realtimeFailures.length;
// The headline ratio is the probe's pass criterion, so publish it only when
// the comparison is complete on both sides: an arm that lost requests looks
// proportionally cheaper on a raw total (a fully rejected arm reads as a
// perfect 0), and the control side must be all-N to keep the units equal.
const complete = (s, failed) => s.lines === N && failed === 0;
const ratio = (arm, failed) =>
  complete(arm, failed) && complete(c, cFailed)
    ? +(arm.cost_per_line / c.cost_per_line).toFixed(2)
    : null;
const verdict = {
  model: MODEL,
  assumptions: { P_OUT, CACHE_RATIO: CACHE, BATCH_RATIO: BATCH },
  control_realtime_caches: c.lines_with_cache_hit > 1,
  batch_implicit_caches: a.lines_with_cache_hit > 1,
  batch_explicit_caches: b.lines_with_cache_hit > 1,
  // Ratio < 1 means that arm is cheaper than realtime+cache; null when
  // either side is incomplete — never a number computed over missing lines.
  cost_vs_realtime: {
    batch_implicit: ratio(a, aFailed),
    batch_explicit: ratio(b, bFailed),
  },
  errors: { implicit: aFailed, explicit: bFailed, realtime: cFailed },
  arms: {
    batch_implicit: { ...a, per: undefined },
    batch_explicit: { ...b, per: undefined },
    realtime: { ...c, per: undefined },
  },
};
save('02-cache.result.json', {
  verdict,
  arms: { a, b, c },
  batches: { A: batchA, B: batchB },
  errors: { A: A.err, B: B.err, realtime: realtimeFailures },
});
await Promise.all([cleanup(oa, batchA), cleanup(oa, batchB)]);
fs.rmSync(PENDING, { force: true });
console.log(JSON.stringify(verdict, null, 2));
