// Test 2 — does context cache hit inside a batch? Answers plan §6 question 2
// and settles the §2 cost math. Three arms share one ~4k-token system prompt:
//   a) batch, implicit cache          b) batch, explicit cache_control
//   c) realtime control (proves the prefix caches at all)
//   node docs/verification/batch-api/02-cache.mjs
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
      { role: 'system', content: longSystem },
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
            text: longSystem,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: q },
    ],
  }),
);

// Submit both batch arms first, run the realtime control while they queue.
const [subA, subB] = await Promise.all([
  submit(oa, writeJsonl('02-cache-implicit.jsonl', implicitLines)),
  submit(oa, writeJsonl('02-cache-explicit.jsonl', explicitLines)),
]);

const realtime = [];
for (const [i, q] of questions.entries()) {
  const r = await oa.chat.completions.create({
    ...common,
    messages: [
      { role: 'system', content: longSystem },
      { role: 'user', content: q },
    ],
  });
  realtime.push({ custom_id: `c${i}`, response: { body: r } });
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
    per,
  };
}

const a = summarize(A.ok, BATCH);
const b = summarize(B.ok, BATCH);
const c = summarize(realtime, 1);
const verdict = {
  model: MODEL,
  assumptions: { P_OUT, CACHE_RATIO: CACHE, BATCH_RATIO: BATCH },
  control_realtime_caches: c.lines_with_cache_hit > 1,
  batch_implicit_caches: a.lines_with_cache_hit > 1,
  batch_explicit_caches: b.lines_with_cache_hit > 1,
  // Ratio < 1 means that arm is cheaper than realtime+cache.
  cost_vs_realtime: {
    batch_implicit: +(a.relative_cost / c.relative_cost).toFixed(2),
    batch_explicit: +(b.relative_cost / c.relative_cost).toFixed(2),
  },
  errors: { implicit: A.err.length, explicit: B.err.length },
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
  errors: { A: A.err, B: B.err },
});
await Promise.all([cleanup(oa, batchA), cleanup(oa, batchB)]);
console.log(JSON.stringify(verdict, null, 2));
