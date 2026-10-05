#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token / tool-recall profile for one or two qwen-code configurations.
 *
 * Reads the telemetry outfile produced by `telemetry.outfile` (or
 * QWEN_TELEMETRY_OUTFILE / --telemetry-outfile) and reports the four
 * per-configuration numbers that decide whether a context saving is real:
 *
 *   - idle cost              input tokens of a session that calls no tool
 *   - input tokens per task  mean / p50 / p95 over sessions
 *   - tool_search per session mean, plus the share of sessions above 2
 *   - bad-call rate          tool calls ending in error, by error_type
 *
 * Every number here is aggregated from telemetry that already exists; no new
 * instrumentation is added and no production code is touched.
 *
 * ATTRIBUTION RULE (the load-bearing part). A single session emits model
 * traffic that is not the user's task: memory-recall side queries and managed
 * subagents run their own requests on their own models. Those are separated by
 * the `llm_request.context` and `subagent_name` span attributes and reported
 * apart, never folded into task cost. Summing every request in a file
 * overstates a no-tool session by roughly 2.3x on a default configuration,
 * which is enough to invert an A/B conclusion.
 *
 * Usage:
 *   node scripts/token-profile.mjs baseline.jsonl
 *   node scripts/token-profile.mjs baseline=a.jsonl eager=b.jsonl
 *   node scripts/token-profile.mjs --json eager=b.jsonl
 *
 * Capture a file with:
 *   QWEN_TELEMETRY_ENABLED=true QWEN_TELEMETRY_OUTFILE=out.jsonl qwen -p "..."
 * Setting an outfile disables the OTLP exporters, so nothing leaves the machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LLM_REQUEST_SPAN = 'qwen-code.llm_request';

/**
 * Split a telemetry outfile into documents.
 *
 * The file exporters write `safeJsonStringify(record, 2) + '\n'`, so the file
 * is a sequence of pretty-printed JSON documents, not JSONL: a single record
 * spans many lines. Split on brace depth, skipping string contents so a brace
 * inside a prompt or a tool result cannot move the counter.
 */
export function splitTelemetryDocuments(text) {
  const docs = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        docs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return docs;
}

/** Parse an outfile into { spans, logs }, dropping records that fail to parse. */
export function parseTelemetryFile(text) {
  const spans = [];
  const logs = [];
  for (const doc of splitTelemetryDocuments(text)) {
    let record;
    try {
      record = JSON.parse(doc);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record))
      continue;
    // A log record also carries `_spanContext` (its correlation to the active
    // span), so `_body` must be tested first or events are misfiled as spans.
    if (record._body !== undefined) logs.push(record);
    else if (record._spanContext) spans.push(record);
  }
  return { spans, logs };
}

/** `qwen-code.tool_call` and `tool_call` are the same event; compare bare. */
function eventName(attributes) {
  return String(attributes['event.name'] ?? '').replace(/^qwen-code\./, '');
}

/** Span ordering key: `_hrTime` is [seconds, nanoseconds] when present. */
function spanTime(span, index) {
  const hr = span._hrTime;
  if (Array.isArray(hr) && typeof hr[0] === 'number')
    return hr[0] * 1e3 + hr[1] / 1e6;
  return index;
}

/**
 * Classify one model request. `interaction` is the user's task; anything else
 * is telemetry the task did not ask for and must not be billed to it.
 */
export function classifyRequest(attributes) {
  if (attributes['llm_request.context'] === 'interaction') return 'task';
  if (attributes.subagent_name) return 'subagent';
  return 'side-query';
}

function addSession(sessions, id) {
  let session = sessions.get(id);
  if (!session) {
    session = {
      sessionId: id,
      taskRequests: [],
      taskInputTokens: 0,
      taskUncachedInputTokens: 0,
      taskOutputTokens: 0,
      sideQueryInputTokens: 0,
      subagentInputTokens: 0,
      toolCalls: 0,
      toolSearchCalls: 0,
      badCalls: 0,
      badCallTypes: new Map(),
      failedRequests: 0,
    };
    sessions.set(id, session);
  }
  return session;
}

/**
 * Fold parsed telemetry into per-session records.
 *
 * Token figures come from the `qwen-code.llm_request` spans: they are the only
 * records carrying `llm_request.context`, which is what separates task traffic
 * from side queries. Tool calls come from the `qwen-code.tool_call` log
 * records; no span is emitted for them.
 */
export function collectSessions({ spans, logs }) {
  const sessions = new Map();

  const requests = spans
    .filter((span) => span.name === LLM_REQUEST_SPAN)
    .map((span, index) => ({ span, index }))
    .sort((a, b) => spanTime(a.span, a.index) - spanTime(b.span, b.index));

  for (const { span } of requests) {
    const attributes = span.attributes ?? {};
    const session = addSession(
      sessions,
      String(attributes['session.id'] ?? '(unknown)'),
    );
    const input = Number(attributes['gen_ai.usage.input_tokens'] ?? 0);
    const cached = Number(
      attributes['gen_ai.usage.cache_read.input_tokens'] ?? 0,
    );
    const output = Number(attributes['gen_ai.usage.output_tokens'] ?? 0);
    if (attributes.success === false) session.failedRequests++;

    switch (classifyRequest(attributes)) {
      case 'task':
        session.taskRequests.push({ input, cached, output });
        session.taskInputTokens += input;
        session.taskUncachedInputTokens += Math.max(0, input - cached);
        session.taskOutputTokens += output;
        break;
      case 'subagent':
        session.subagentInputTokens += input;
        break;
      default:
        session.sideQueryInputTokens += input;
        break;
    }
  }

  for (const log of logs) {
    const attributes = log.attributes ?? {};
    if (eventName(attributes) !== 'tool_call') continue;
    const session = addSession(
      sessions,
      String(attributes['session.id'] ?? '(unknown)'),
    );
    session.toolCalls++;
    if (attributes.function_name === 'tool_search') session.toolSearchCalls++;
    if (attributes.status === 'error' || attributes.success === false) {
      session.badCalls++;
      const type = String(attributes.error_type ?? 'unspecified');
      session.badCallTypes.set(type, (session.badCallTypes.get(type) ?? 0) + 1);
    }
  }

  return [...sessions.values()];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Reduce per-session records to the numbers in #12333's acceptance table. */
export function summarize(sessions) {
  const withTask = sessions.filter((s) => s.taskRequests.length > 0);
  const taskTotals = withTask
    .map((s) => s.taskInputTokens)
    .sort((a, b) => a - b);
  const uncachedTotals = withTask
    .map((s) => s.taskUncachedInputTokens)
    .sort((a, b) => a - b);
  // The issue defines idle cost as a session that asks one question and calls
  // no tool, so it is only defined for sessions that never reached a tool.
  const idle = withTask.filter((s) => s.toolCalls === 0);

  const toolCalls = sessions.reduce((a, s) => a + s.toolCalls, 0);
  const badCalls = sessions.reduce((a, s) => a + s.badCalls, 0);
  const badCallTypes = new Map();
  for (const s of sessions) {
    for (const [type, n] of s.badCallTypes)
      badCallTypes.set(type, (badCallTypes.get(type) ?? 0) + n);
  }
  const searchSessions = sessions.filter((s) => s.toolSearchCalls > 2).length;

  return {
    sessions: sessions.length,
    idleSessions: idle.length,
    idleInputTokens: idle.length
      ? Math.round(mean(idle.map((s) => s.taskRequests[0].input)))
      : null,
    inputTokensPerTask: {
      mean: Math.round(mean(taskTotals)),
      p50: percentile(taskTotals, 50),
      p95: percentile(taskTotals, 95),
    },
    uncachedInputTokensPerTask: {
      mean: Math.round(mean(uncachedTotals)),
      p50: percentile(uncachedTotals, 50),
      p95: percentile(uncachedTotals, 95),
    },
    toolSearchPerSession: {
      mean: Number(mean(sessions.map((s) => s.toolSearchCalls)).toFixed(2)),
      sessionsAboveTwo: searchSessions,
      sessionsAboveTwoShare: sessions.length
        ? searchSessions / sessions.length
        : 0,
    },
    badCallRate: {
      toolCalls,
      badCalls,
      rate: toolCalls ? badCalls / toolCalls : 0,
      byErrorType: Object.fromEntries(
        [...badCallTypes].sort((a, b) => b[1] - a[1]),
      ),
    },
    excludedFromTaskCost: {
      sideQueryInputTokens: sessions.reduce(
        (a, s) => a + s.sideQueryInputTokens,
        0,
      ),
      subagentInputTokens: sessions.reduce(
        (a, s) => a + s.subagentInputTokens,
        0,
      ),
    },
    failedRequests: sessions.reduce((a, s) => a + s.failedRequests, 0),
  };
}

/** Read one outfile into a summary, tagged with the label the caller gave it. */
export function profileFile(label, file) {
  const text = fs.readFileSync(file, 'utf8');
  const sessions = collectSessions(parseTelemetryFile(text));
  return { label, file, summary: summarize(sessions), sessions };
}

const TOKEN_COLUMNS = ['mean', 'p50', 'p95'];

function formatTokens(value) {
  return value === null ? 'n/a' : value.toLocaleString('en-US');
}

/** Render the acceptance table for one or two configurations. */
export function formatReport(profiles) {
  const lines = [];
  const header = ['metric', ...profiles.map((p) => p.label)];
  const rows = [];

  rows.push(['sessions', ...profiles.map((p) => String(p.summary.sessions))]);
  rows.push([
    'idle cost (input tok, no-tool session)',
    ...profiles.map((p) => formatTokens(p.summary.idleInputTokens)),
  ]);
  for (const column of TOKEN_COLUMNS) {
    rows.push([
      `input tok / task (${column})`,
      ...profiles.map((p) =>
        formatTokens(p.summary.inputTokensPerTask[column]),
      ),
    ]);
  }
  for (const column of TOKEN_COLUMNS) {
    rows.push([
      `uncached input tok / task (${column})`,
      ...profiles.map((p) =>
        formatTokens(p.summary.uncachedInputTokensPerTask[column]),
      ),
    ]);
  }
  rows.push([
    'tool_search / session (mean)',
    ...profiles.map((p) => String(p.summary.toolSearchPerSession.mean)),
  ]);
  rows.push([
    'sessions above 2 tool_search',
    ...profiles.map(
      (p) =>
        `${p.summary.toolSearchPerSession.sessionsAboveTwo}/${p.summary.sessions}` +
        ` (${(p.summary.toolSearchPerSession.sessionsAboveTwoShare * 100).toFixed(0)}%)`,
    ),
  ]);
  rows.push([
    'bad-call rate',
    ...profiles.map((p) => {
      const { badCalls, toolCalls, rate } = p.summary.badCallRate;
      return toolCalls
        ? `${badCalls}/${toolCalls} (${(rate * 100).toFixed(1)}%)`
        : 'no tool calls';
    }),
  ]);

  const width = (row) => row.map((cell) => String(cell).length);
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => width(row)[column] ?? 0)),
  );
  const line = (cells) =>
    cells
      .map((cell, i) => String(cell).padEnd(widths[i]))
      .join('  ')
      .trimEnd();

  lines.push(line(header));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) lines.push(line(row));

  // Everything below the rule is what the table deliberately did not count.
  lines.push('');
  lines.push(
    'excluded from task cost (reported so the exclusion is auditable):',
  );
  for (const p of profiles) {
    const excluded = p.summary.excludedFromTaskCost;
    lines.push(
      `  ${p.label}: side-query ${excluded.sideQueryInputTokens.toLocaleString('en-US')}` +
        ` + subagent ${excluded.subagentInputTokens.toLocaleString('en-US')} input tok`,
    );
  }

  for (const p of profiles) {
    const types = Object.entries(p.summary.badCallRate.byErrorType);
    if (types.length)
      lines.push(
        `  ${p.label} bad calls by error_type: ${types.map(([t, n]) => `${t}=${n}`).join(', ')}`,
      );
    if (p.summary.failedRequests) {
      lines.push(
        `  ${p.label}: ${p.summary.failedRequests} model request(s) reported success=false` +
          ' — token totals for those attempts are still counted, so a retry storm inflates them.',
      );
    }
  }

  if (profiles.length === 2) {
    const [a, b] = profiles;
    const delta = (x, y) =>
      x === null || y === null
        ? 'n/a'
        : `${y - x >= 0 ? '+' : ''}${(y - x).toLocaleString('en-US')}`;
    const pct = (x, y) => (x ? `${(((y - x) / x) * 100).toFixed(1)}%` : 'n/a');
    lines.push('');
    lines.push(`${b.label} vs ${a.label}:`);
    lines.push(
      `  idle cost ${delta(a.summary.idleInputTokens, b.summary.idleInputTokens)}` +
        (a.summary.idleInputTokens !== null &&
        b.summary.idleInputTokens !== null
          ? ` (${pct(a.summary.idleInputTokens, b.summary.idleInputTokens)})`
          : ''),
    );
    for (const column of TOKEN_COLUMNS) {
      const x = a.summary.inputTokensPerTask[column];
      const y = b.summary.inputTokensPerTask[column];
      lines.push(
        `  input tok / task (${column}) ${delta(x, y)} (${pct(x, y)})`,
      );
    }
    lines.push(
      `  bad-call rate ${delta(a.summary.badCallRate.badCalls, b.summary.badCallRate.badCalls)}` +
        ` failures over ${delta(a.summary.badCallRate.toolCalls, b.summary.badCallRate.toolCalls)} calls`,
    );
  }

  return lines.join('\n');
}

function parseArg(arg) {
  const eq = arg.indexOf('=');
  if (eq > 0) return { label: arg.slice(0, eq), file: arg.slice(eq + 1) };
  return {
    label: path.basename(arg).replace(/\.(jsonl|json|log)$/, ''),
    file: arg,
  };
}

function main(argv) {
  const asJson = argv.includes('--json');
  const targets = argv.filter((a) => a !== '--json').map(parseArg);
  if (targets.length === 0 || targets.length > 2) {
    process.stderr.write(
      'usage: node scripts/token-profile.mjs [--json] <[label=]telemetry-outfile> [<[label=]telemetry-outfile>]\n',
    );
    return 2;
  }
  const profiles = targets.map((t) => profileFile(t.label, t.file));
  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        profiles.map((p) => ({
          label: p.label,
          file: p.file,
          summary: p.summary,
        })),
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  process.stdout.write(formatReport(profiles) + '\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
