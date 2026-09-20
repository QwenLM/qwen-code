// Step 0 — does the pipe work at all? Uses Bailian's free batch-test-model so
// this only exercises JSONL shape, status flow, and result download.
//   node docs/verification/batch-api/00-plumbing.mjs
import {
  client,
  line,
  writeJsonl,
  submit,
  waitFor,
  collect,
  save,
  cleanup,
  bodyOf,
} from './lib.mjs';

const oa = client();
const model = process.env.BATCH_MODEL ?? 'batch-test-model';
const path = writeJsonl(
  '00-plumbing.jsonl',
  [1, 2, 3].map((i) =>
    line(`p${i}`, {
      model,
      messages: [{ role: 'user', content: `Reply with the number ${i}.` }],
    }),
  ),
);
const submitted = await submit(oa, path);
const batch = await waitFor(oa, submitted.id, { every: 10_000 });
const { ok, failed, err, byId } = await collect(oa, batch);

const verdict = {
  status: batch.status,
  request_counts: batch.request_counts,
  timestamps: {
    created_at: batch.created_at,
    in_progress_at: batch.in_progress_at,
    finalizing_at: batch.finalizing_at,
    completed_at: batch.completed_at,
    expires_at: batch.expires_at,
  },
  ok_lines: ok.length,
  // A line can fail inside the output file while request_counts.failed stays
  // 0, so the gate has to look at the status codes, not just the row count.
  failed_lines: failed,
  err_lines: err.length,
  sample: bodyOf(byId['p1'])?.choices?.[0]?.message?.content ?? null,
  pass:
    batch.status === 'completed' &&
    ok.length === 3 &&
    failed === 0 &&
    err.length === 0,
};
save('00-plumbing.result.json', { verdict, batch, err });
await cleanup(oa, batch);
console.log(verdict.pass ? 'PASS' : 'FAIL', JSON.stringify(verdict, null, 2));
