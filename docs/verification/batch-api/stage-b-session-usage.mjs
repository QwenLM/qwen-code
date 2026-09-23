// Stage B helper: sum the token usage an interactive qwen-code session
// recorded, so the preparation (or a realtime baseline) is measured instead
// of guessed. The `qwen batch` executor cannot see session usage — this is
// the only place that number comes from.
//
//   node docs/verification/batch-api/stage-b-session-usage.mjs \
//     ~/.qwen/projects/<project>/chats/<session-id>.jsonl \
//     [--from 2026-09-24T01:00:00Z] [--to 2026-09-24T01:20:00Z]
//
// Several session files may be given; subagent (sidechain) records live in
// the parent session's file and are counted with it. Prints one JSON object.
import fs from 'node:fs';

const args = process.argv.slice(2);
const files = [];
let from;
let to;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--from') from = Date.parse(args[++i]);
  else if (args[i] === '--to') to = Date.parse(args[++i]);
  else files.push(args[i]);
}
if (files.length === 0) {
  console.error(
    'usage: stage-b-session-usage.mjs <session.jsonl>... [--from ISO] [--to ISO]',
  );
  process.exit(2);
}

const total = {
  responses: 0,
  missingUsage: 0,
  promptTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  models: {},
};
for (const file of files) {
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (record.type !== 'assistant') continue;
    const at = Date.parse(record.timestamp);
    if (from !== undefined && at < from) continue;
    if (to !== undefined && at > to) continue;
    total.responses += 1;
    const usage = record.usageMetadata;
    if (!usage) {
      total.missingUsage += 1;
      continue;
    }
    total.promptTokens += usage.promptTokenCount ?? 0;
    total.cachedTokens += usage.cachedContentTokenCount ?? 0;
    total.outputTokens += usage.candidatesTokenCount ?? 0;
    total.thoughtTokens += usage.thoughtsTokenCount ?? 0;
    const model = record.model ?? 'unknown';
    total.models[model] = (total.models[model] ?? 0) + 1;
  }
}
total.cacheHitRate =
  total.promptTokens > 0
    ? Number((total.cachedTokens / total.promptTokens).toFixed(4))
    : null;
console.log(JSON.stringify(total, null, 2));
if (total.missingUsage > 0) {
  console.error(
    `warning: ${total.missingUsage} response(s) carried no usage; totals are a lower bound — cross-check with /stats`,
  );
}
