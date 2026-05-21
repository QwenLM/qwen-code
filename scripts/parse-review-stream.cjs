#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * parse-review-stream.cjs
 *
 * Streaming JSON-Lines parser for `qwen --output-format stream-json
 * --include-partial-messages` review output.
 *
 * Filename uses .cjs (not .js) because the repo's root package.json sets
 * "type": "module"; a plain .js would be loaded as ESM and `require()`
 * would throw at runtime. We want CommonJS here to keep the script
 * runnable directly via `node` without an `import` rewrite.
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
 *   parse-review-stream.cjs <input.jsonl> <output.md> [tier] [status]
 *
 * Args:
 *   input.jsonl   Path to the stream-json file written by `qwen ... | tee`.
 *   output.md     Path to write the accumulated review markdown to.
 *   tier          Optional tier label (UL/LIGHT/STANDARD/DEEP), embedded
 *                 in a HTML comment header. Used by maintainers to filter
 *                 review comments by tier in retrospective analysis.
 *   status        Optional status label, expected values: 'complete',
 *                 'timeout', or 'error'. Embedded in the same header.
 *
 * Exit codes:
 *   0  success (file written, even with placeholder body)
 *   1  IO error reading input
 *   2  bad arguments
 */

'use strict';

const fs = require('fs');

/**
 * Parse one assistant-text segment from a single JSONL event.
 * Returns the joined text (possibly empty string) or null if the
 * event doesn't carry an assistant message.
 *
 * Exposed for unit tests.
 */
function extractSegmentFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'assistant' && event.type !== 'message') return null;
  const content = event?.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  return text;
}

/**
 * Accumulate all assistant text segments from a JSONL stream string.
 * Malformed lines are skipped (the final line of a truncated stream
 * is the common case). Whitespace-only segments are rejected so the
 * `segments=N` header doesn't lie.
 *
 * Exposed for unit tests.
 */
function accumulateSegments(raw) {
  const segments = [];
  if (typeof raw !== 'string') return segments;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text = extractSegmentFromEvent(event);
    if (text && text.trim()) segments.push(text);
  }
  return segments;
}

/**
 * Build the final on-disk markdown body from accumulated segments.
 *
 * Tier matters here. Single-shot tiers (LIGHT/STANDARD) emit the review
 * as their whole output, so every segment is review content and they are
 * joined as-is. DEEP runs the bundled multi-agent skill: its stream
 * carries many short orchestrator-narration segments ("Launching 6
 * agents…", "Let me compile the review…", "All agents unanimous") plus
 * ONE large segment that is the actual consolidated review. Joining them
 * all would sandwich the review in narration noise, so for DEEP we emit
 * only the largest segment.
 *
 * Empty input gets a placeholder so downstream `gh pr comment
 * --body-file` always has a non-empty body to post.
 *
 * Exposed for unit tests.
 */
function buildOutput(segments, tier, status) {
  let body;
  let emitted;
  if (tier === 'DEEP' && segments.length > 1) {
    body = segments.reduce((a, b) => (b.length > a.length ? b : a));
    emitted = 1;
  } else if (segments.length > 0) {
    body = segments.join('\n\n');
    emitted = segments.length;
  } else {
    body = '(no assistant text parsed; see the raw stream in the job log)';
    emitted = 0;
  }
  const header =
    `<!-- tier=${tier}; status=${status}; ` +
    `segments=${segments.length}; emitted=${emitted} -->\n`;
  return { header, body, full: header + body };
}

function main() {
  const [, , inputPath, outputPath, tier = 'UNKNOWN', status = 'complete'] =
    process.argv;

  if (!inputPath || !outputPath) {
    console.error(
      'Usage: parse-review-stream.cjs <input.jsonl> <output.md> [tier] [status]'
    );
    process.exit(2);
  }

  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error(
      `parse-review-stream: failed to read ${inputPath}: ${err.message}`
    );
    process.exit(1);
  }

  const segments = accumulateSegments(raw);
  const { full, body } = buildOutput(segments, tier, status);

  try {
    fs.writeFileSync(outputPath, full);
  } catch (err) {
    console.error(
      `parse-review-stream: failed to write ${outputPath}: ${err.message}`
    );
    process.exit(1);
  }

  console.error(
    `parse-review-stream: ${segments.length} segment(s), ${body.length} char(s) written to ${outputPath}`
  );
}

module.exports = { extractSegmentFromEvent, accumulateSegments, buildOutput };

if (require.main === module) {
  main();
}
