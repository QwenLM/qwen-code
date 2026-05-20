#!/usr/bin/env node
/**
 * parse-review-stream.js
 *
 * Streaming JSON-Lines parser for `qwen --output-format stream-json
 * --include-partial-messages` review output.
 *
 * Phase 1-3 used an inline node script in the workflow yml that only kept
 * the LAST assistant text segment. That worked for the happy path but
 * meant a 50-min step timeout left no partial review on the PR (violating
 * the G3 "always-emit" goal of the preflight design).
 *
 * This parser ACCUMULATES every assistant/message text segment as it
 * encounters them in the stream, so when the qwen process is killed mid-
 * generation (timeout, OOM, SIGTERM), the on-disk markdown still contains
 * everything the model emitted up to that moment. A `⚠️ time-capped`
 * warning header can then be prepended by the caller (workflow shell)
 * before the file is posted as a PR comment.
 *
 * Design choices:
 *  - Pure stdlib (no deps): runs on the runner without extra `npm install`.
 *  - Defensive: malformed JSON lines are skipped, not fatal — partial
 *    streams (which can have a truncated final line if killed) must still
 *    produce useful output.
 *  - Empty-input safe: writes a fallback placeholder so the downstream
 *    `gh pr comment --body-file` step always has a non-empty body.
 *
 * Usage:
 *   parse-review-stream.js <input.jsonl> <output.md> [tier] [status]
 *
 * Args:
 *   input.jsonl   Path to the stream-json file written by `qwen ... | tee`.
 *   output.md     Path to write the accumulated review markdown to.
 *   tier          Optional tier label (UL/LIGHT/STANDARD/DEEP), embedded
 *                 in a HTML comment header. Used by maintainers to filter
 *                 review comments by tier in retrospective analysis.
 *   status        Optional status label, expected values: 'complete' or
 *                 'timeout'. Embedded in the same header.
 *
 * Exit codes:
 *   0  success (file written, even with placeholder body)
 *   1  IO error reading input
 *   2  bad arguments
 */

'use strict';

const fs = require('fs');

const [, , inputPath, outputPath, tier = 'UNKNOWN', status = 'complete'] =
  process.argv;

if (!inputPath || !outputPath) {
  console.error(
    'Usage: parse-review-stream.js <input.jsonl> <output.md> [tier] [status]'
  );
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(inputPath, 'utf8');
} catch (err) {
  console.error(`parse-review-stream: failed to read ${inputPath}: ${err.message}`);
  process.exit(1);
}

const segments = [];
const lines = raw.split(/\r?\n/);

for (const line of lines) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Malformed line — most commonly the final line of a truncated stream
    // when qwen was killed mid-write. Skip and continue.
    continue;
  }
  const content = event?.message?.content;
  if (
    (event.type === 'assistant' || event.type === 'message') &&
    Array.isArray(content)
  ) {
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text) segments.push(text);
  }
}

const header = `<!-- tier=${tier}; status=${status}; segments=${segments.length} -->\n`;
const body =
  segments.length > 0
    ? segments.join('\n\n')
    : '(no assistant text parsed; see the raw stream in the job log)';

try {
  fs.writeFileSync(outputPath, header + body);
} catch (err) {
  console.error(`parse-review-stream: failed to write ${outputPath}: ${err.message}`);
  process.exit(1);
}

console.error(
  `parse-review-stream: ${segments.length} segment(s), ${body.length} char(s) written to ${outputPath}`
);
