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

const fs = require('fs');

/**
 * Parse one assistant-text segment from a single JSONL event.
 * Returns the joined text (possibly empty string) or null if the
 * event doesn't carry an assistant message.
 *
 * Messages whose content[] includes a tool_use part are pre-tool
 * preamble ("Let me verify…") — skip them entirely since the real
 * review text comes in subsequent tool-free messages.
 *
 * Exposed for unit tests.
 */
function extractSegmentFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'assistant' && event.type !== 'message') return null;
  const content = event?.message?.content;
  if (!Array.isArray(content)) return null;
  const hasToolUse = content.some((part) => part?.type === 'tool_use');
  if (hasToolUse) return null;
  // Partial/intermediate messages emitted between tool calls have
  // usage.input_tokens === 0. These are transition narration ("Now I
  // have a thorough understanding...", "Inline comment posted...") not
  // final review content. Skip them structurally rather than relying
  // solely on regex heuristics.
  const usage = event?.message?.usage;
  if (usage && usage.input_tokens === 0 && usage.output_tokens === 0) return null;
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
    if (text && text.trim()) {
      segments.push(text);
    }
  }
  return segments;
}

/**
 * Strip preamble text that precedes the actual review content.
 * The model sometimes emits "Let me read...", "I'll check...", etc.
 * before starting the real review (marked by a `## ` heading or a
 * severity/findings line). If we find such a marker, drop everything
 * before it.
 *
 * If no review marker is found at all and the text looks like
 * repetitive stalling (the model stuck in a "let me read" loop),
 * return empty string so the segment gets discarded upstream.
 */
function stripPreamble(text) {
  const marker = text.match(
    /^(## |### |[-*] \*\*P[0-3]|[-*] \*\*`|[-*] \[?(Critical|High|Medium|Low|Suggestion)|No (?:correctness|maintainability|issues|additional))/m,
  );
  if (marker && marker.index > 0) {
    return text.slice(marker.index);
  }
  if (!marker && isRepetitiveStalling(text)) {
    return '';
  }
  if (!marker && isPreambleFragment(text)) {
    return '';
  }
  return text;
}

/**
 * Detect short standalone preamble fragments — the model emits a
 * text-only "thinking aloud" message (no tool_use) before starting
 * the actual review. These are short, lack any review structure, and
 * typically start with filler phrases.
 */
function isPreambleFragment(text) {
  if (text.length > 400) return false;
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length > 5) return false;
  return /^(Let me|I'll |I need to|I should|I want to|I'm going to|Looking at|Reviewing|Checking|Examining|Now I have|Now let me|I now have|I've now|Based on my)/i.test(
    text.trim(),
  );
}

/**
 * Detect repetitive model stalling — the model gets stuck in a loop
 * requesting to read files but unable to, producing the same sentence
 * dozens of times.
 */
function isRepetitiveStalling(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 5) return false;
  const seen = new Map();
  for (const line of lines) {
    const normalized = line.trim().toLowerCase();
    seen.set(normalized, (seen.get(normalized) || 0) + 1);
  }
  const maxRepeat = Math.max(...seen.values());
  return maxRepeat >= 3 && maxRepeat / lines.length > 0.3;
}

/**
 * Build the final on-disk markdown body from accumulated segments.
 *
 * Every assistant text segment is review content (including partial text
 * captured before a timeout), so segments are joined in stream order.
 *
 * Empty input gets a placeholder so downstream `gh pr comment
 * --body-file` always has a non-empty body to post.
 *
 * Exposed for unit tests.
 */
function buildOutput(segments, tier, status) {
  let body;
  let emitted;
  const cleaned = segments.map(stripPreamble).filter((s) => s.trim());
  if (cleaned.length > 0) {
    body = cleaned.join('\n\n');
    emitted = cleaned.length;
  } else {
    body = '(no assistant text parsed; see the raw stream in the job log)';
    emitted = 0;
  }
  const header =
    `<!-- tier=${tier}; status=${status}; ` +
    `segments=${segments.length}; emitted=${emitted} -->\n`;
  return { header, body, emitted, full: header + body };
}

function main() {
  const [, , inputPath, outputPath, tier = 'UNKNOWN', status = 'complete'] =
    process.argv;

  if (!inputPath || !outputPath) {
    process.stderr.write(
      'Usage: parse-review-stream.cjs <input.jsonl> <output.md> [tier] [status]\n',
    );
    process.exit(2);
  }

  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `parse-review-stream: failed to read ${inputPath}: ${err.message}\n`,
    );
    process.exit(1);
  }

  const segments = accumulateSegments(raw);
  const { full, body, emitted } = buildOutput(segments, tier, status);

  try {
    fs.writeFileSync(outputPath, full);
  } catch (err) {
    process.stderr.write(
      `parse-review-stream: failed to write ${outputPath}: ${err.message}\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `parse-review-stream: ${segments.length} segment(s) parsed, ${emitted} emitted, ${body.length} char(s) written to ${outputPath}\n`,
  );
}

module.exports = {
  extractSegmentFromEvent,
  accumulateSegments,
  buildOutput,
  stripPreamble,
  isRepetitiveStalling,
  isPreambleFragment,
};

if (require.main === module) {
  main();
}
