#!/usr/bin/env node
// Probe the qwen3.7-max stream timing pattern for parallel tool calls.
// Streams the raw SSE response and records, per chunk, the relative
// timestamp + whether it carried text, a tool_call delta, or
// finish_reason. The output answers the empirical question that
// determines whether streaming-tool-dispatch can deliver wall-time
// speedup on this provider:
//
//   "How wide is the spread between when the first tool_call's args
//    finish streaming and when finish_reason arrives?"
//
// That spread is the only window early-dispatch can exploit within a
// single response. RFC §4 assumes Anthropic-style mid-stream emission
// (text + tool_use interleaved); OpenAI parallel function calling
// typically batches all tool_calls at the tail. This probe tells us
// which side the qwen3.7-max endpoint sits on.

import * as fs from 'node:fs';

const settings = JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.qwen/settings.json`, 'utf8'),
);
const provider = settings.modelProviders?.openai?.[0];
const baseUrl = provider?.baseUrl;
const envKey = provider?.envKey;
const apiKey = settings.env?.[envKey];
const model = provider?.id ?? settings.model?.name;

if (!baseUrl || !apiKey || !model) {
  console.error('Missing baseUrl/key/model in ~/.qwen/settings.json');
  process.exit(2);
}

const prompt = `You are running a benchmark. Issue these FOUR independent read-only shell commands IN A SINGLE RESPONSE — fire all four at once via the shell tool, do not wait for results between them, do not explain anything before issuing them:

1. find packages -type f -name "*.ts" -not -path "*/node_modules/*" | xargs wc -l 2>/dev/null | tail -1
2. du -sk node_modules 2>/dev/null
3. find . -maxdepth 6 -type f -name "*.ts" 2>/dev/null | wc -l
4. grep -r --include="*.ts" "StreamingTool" packages/core/src 2>/dev/null | wc -l

After all four return, output ONLY a single line in the form:
ts_lines=A node_modules_kb=B all_ts=C streaming_refs=D

Do not call any other tool. Do not explain. Do not narrate.`;

const body = {
  model,
  stream: true,
  messages: [{ role: 'user', content: prompt }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'run_shell_command',
        description: 'Run a shell command and return stdout.',
        parameters: {
          type: 'object',
          required: ['command'],
          properties: {
            command: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
  ],
  tool_choice: 'auto',
};

const t0 = Date.now();
const resp = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});

if (!resp.ok) {
  console.error('HTTP', resp.status, await resp.text());
  process.exit(1);
}

// Track per-index tool_call args buffer + brace depth so we can mark
// "args closed" precisely. This mirrors what
// StreamingToolCallParser.addChunk would conclude during real streaming.
const toolBuffers = new Map(); // index -> { buf: '', depth: 0, inString: false, escape: false, closedAt: null, name: null, id: null, firstChunkAt: null }
let firstByteAt = null;
let firstTextAt = null;
let finishAt = null;
let chunkCount = 0;

const events = [];

function noteArgsChunk(idx, chunk) {
  let st = toolBuffers.get(idx);
  if (!st) {
    st = { buf: '', depth: 0, inString: false, escape: false, closedAt: null, name: null, id: null, firstChunkAt: Date.now() };
    toolBuffers.set(idx, st);
  }
  if (st.closedAt !== null) return st;
  for (const ch of chunk) {
    if (!st.inString) {
      if (ch === '{' || ch === '[') st.depth++;
      else if (ch === '}' || ch === ']') st.depth--;
    }
    if (ch === '"' && !st.escape) st.inString = !st.inString;
    st.escape = ch === '\\' && !st.escape;
    st.buf += ch;
  }
  if (st.depth === 0 && st.buf.trim().length > 0) {
    try {
      JSON.parse(st.buf);
      st.closedAt = Date.now();
    } catch {
      // Expected: buffer briefly reaches depth 0 mid-args while still
      // not valid JSON (e.g. a string fragment that happens to balance
      // brackets). Keep accumulating; subsequent chunks will arrive.
    }
  }
  return st;
}

const reader = resp.body
  .pipeThrough(new TextDecoderStream())
  .getReader();
let leftover = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (firstByteAt === null) firstByteAt = Date.now();
  const text = leftover + value;
  const lines = text.split('\n');
  leftover = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    chunkCount++;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const ch0 = obj.choices?.[0];
    if (!ch0) continue;
    const delta = ch0.delta || {};
    const tNow = Date.now() - t0;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (firstTextAt === null) firstTextAt = tNow;
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let st = toolBuffers.get(idx);
        if (!st) {
          st = { buf: '', depth: 0, inString: false, escape: false, closedAt: null, name: null, id: null, firstChunkAt: tNow };
          toolBuffers.set(idx, st);
        }
        if (tc.id) st.id = tc.id;
        if (tc.function?.name) st.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') {
          const before = st.closedAt;
          noteArgsChunk(idx, tc.function.arguments);
          if (before === null && st.closedAt !== null) {
            events.push({ at: tNow, kind: 'tool_call_closed', index: idx, id: st.id, name: st.name });
          }
        }
      }
    }
    if (ch0.finish_reason) {
      finishAt = tNow;
      events.push({ at: tNow, kind: 'finish_reason', reason: ch0.finish_reason });
    }
  }
}

console.log('\nStream timing (ms from request send):');
console.log(`  first byte:     ${firstByteAt - t0}`);
console.log(`  first text:     ${firstTextAt ?? 'n/a'}`);
for (const [idx, st] of [...toolBuffers.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  tool[${idx}] first chunk: ${st.firstChunkAt}  args_closed: ${st.closedAt - t0}  name: ${st.name}`);
}
console.log(`  finish_reason:  ${finishAt}`);
console.log(`  total chunks:   ${chunkCount}`);

// Compute the early-dispatch window per tool.
console.log('\nEarly-dispatch window per tool (ms before finish_reason):');
const finish = finishAt;
const closedTimes = [];
for (const [idx, st] of [...toolBuffers.entries()].sort((a, b) => a[0] - b[0])) {
  const closedRel = st.closedAt - t0;
  closedTimes.push(closedRel);
  console.log(`  tool[${idx}]: ${finish - closedRel} ms head-start`);
}
const earliest = Math.min(...closedTimes);
console.log(`\nFirst→last tool args spread: ${Math.max(...closedTimes) - earliest} ms`);
console.log(`Earliest tool's lead over finish_reason: ${finish - earliest} ms`);
