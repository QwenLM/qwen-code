// Stage B helper, layer 1 of design §5.2: send the exact requests a
// `/batch-api` attempt submitted through the realtime API, so the API price
// difference is measured on identical input. Reads the attempt's frozen
// `input.jsonl`, streams each body through chat completions (streaming
// works for thinking-enabled models too), and records usage and output.
//
//   DASHSCOPE_API_KEY=sk-... node docs/verification/batch-api/stage-b-realtime-replay.mjs \
//     ~/.qwen/batch/tasks/<task-id>/attempt-001/input.jsonl [--concurrency 4]
//
// Each output is written under out/stage-b-realtime/ at the item's target
// path (read from the task's task.json next to the attempt directory), so
// stage-b-structure-check.mjs can score it exactly like the Batch arm. Also
// writes out/stage-b-realtime/summary.json. This spends real money.
import fs from 'node:fs';
import path from 'node:path';
import { client, OUT } from './lib.mjs';

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith('--'));
const concurrencyFlag = args.indexOf('--concurrency');
const concurrency =
  concurrencyFlag >= 0 ? Number(args[concurrencyFlag + 1]) : 4;
if (!input || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error(
    'usage: stage-b-realtime-replay.mjs <attempt input.jsonl> [--concurrency N]',
  );
  process.exit(2);
}

const lines = fs
  .readFileSync(input, 'utf8')
  .split('\n')
  .filter((raw) => raw.trim())
  .map((raw) => JSON.parse(raw));
const dir = path.join(OUT, 'stage-b-realtime');
fs.mkdirSync(dir, { recursive: true });
// custom_id is `<itemId>#<attempt>`; the task file maps items to targets.
const taskFile = path.join(path.dirname(input), '..', 'task.json');
const targetOf = new Map(
  fs.existsSync(taskFile)
    ? JSON.parse(fs.readFileSync(taskFile, 'utf8')).items.map((item) => [
        item.id,
        item.target,
      ])
    : [],
);
const outputPathOf = (customId) => {
  const itemId = customId.replace(/#\d+$/, '');
  const target = targetOf.get(itemId) ?? `${itemId}.md`;
  const resolved = path.resolve(dir, target);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error(`target ${target} escapes ${dir}`);
  }
  return resolved;
};
const oa = client();

async function replay(line) {
  const started = Date.now();
  const stream = await oa.chat.completions.create({
    ...line.body,
    stream: true,
    stream_options: { include_usage: true },
  });
  let content = '';
  let finishReason = null;
  let usage;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  const outputPath = outputPathOf(line.custom_id);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content.trim());
  return {
    customId: line.custom_id,
    finishReason,
    seconds: (Date.now() - started) / 1000,
    promptTokens: usage?.prompt_tokens ?? null,
    cachedTokens:
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.cached_tokens ??
      null,
    completionTokens: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

const results = [];
let next = 0;
async function worker() {
  while (next < lines.length) {
    const line = lines[next++];
    try {
      results.push(await replay(line));
    } catch (error) {
      results.push({ customId: line.custom_id, error: String(error) });
    }
    console.error(`${results.length}/${lines.length} ${line.custom_id}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const sum = (key) =>
  results.reduce((acc, result) => acc + (result[key] ?? 0), 0);
const summary = {
  input,
  requests: lines.length,
  errors: results.filter((result) => result.error).length,
  truncated: results.filter((result) => result.finishReason === 'length')
    .length,
  missingUsage: results.filter(
    (result) => !result.error && result.promptTokens === null,
  ).length,
  promptTokens: sum('promptTokens'),
  cachedTokens: sum('cachedTokens'),
  completionTokens: sum('completionTokens'),
  reasoningTokens: sum('reasoningTokens'),
  results,
};
summary.cacheHitRate =
  summary.promptTokens > 0
    ? Number((summary.cachedTokens / summary.promptTokens).toFixed(4))
    : null;
fs.writeFileSync(
  path.join(dir, 'summary.json'),
  JSON.stringify(summary, null, 2),
);
const { results: _results, ...headline } = summary;
console.log(JSON.stringify(headline, null, 2));
