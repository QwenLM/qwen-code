/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  classifyRequest,
  collectSessions,
  formatReport,
  parseTelemetryFile,
  splitTelemetryDocuments,
  summarize,
} from '../token-profile.mjs';

// The exporters write `safeJsonStringify(record, 2) + '\n'`, so a fixture has
// to be pretty-printed to reproduce the real file: one record per many lines.
function outfile(...records) {
  return records.map((r) => JSON.stringify(r, null, 2) + '\n').join('');
}

function llmRequest(attributes) {
  return {
    name: 'qwen-code.llm_request',
    _spanContext: { traceId: 't', spanId: 's' },
    _hrTime: [1, 0],
    attributes,
  };
}

function toolCall(attributes) {
  return {
    // A log record carries `_spanContext` too — that is what makes the
    // span/log discriminator non-obvious, so every fixture keeps it.
    _body: 'Tool call.',
    _spanContext: { traceId: 't', spanId: 's' },
    attributes: { 'event.name': 'qwen-code.tool_call', ...attributes },
  };
}

const SESSION = 'session-1';

describe('scripts/token-profile.mjs', () => {
  it('splits pretty-printed records without being fooled by braces in strings', () => {
    const text = outfile(
      { _body: 'prompt with } and { braces', attributes: { a: 1 } },
      { _body: 'second', attributes: {} },
    );
    expect(splitTelemetryDocuments(text)).toHaveLength(2);
    expect(parseTelemetryFile(text).logs).toHaveLength(2);
  });

  it('files a record by _body before _spanContext, because log records carry both', () => {
    const { spans, logs } = parseTelemetryFile(
      outfile(
        toolCall({ 'session.id': SESSION }),
        llmRequest({ 'session.id': SESSION }),
      ),
    );
    expect(logs).toHaveLength(1);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('qwen-code.llm_request');
  });

  it('separates task traffic from side queries and subagents', () => {
    expect(classifyRequest({ 'llm_request.context': 'interaction' })).toBe(
      'task',
    );
    expect(classifyRequest({ 'llm_request.context': 'standalone' })).toBe(
      'side-query',
    );
    expect(
      classifyRequest({
        'llm_request.context': 'standalone',
        subagent_name: 'extractor',
      }),
    ).toBe('subagent');

    const [session] = collectSessions(
      parseTelemetryFile(
        outfile(
          llmRequest({
            'session.id': SESSION,
            'llm_request.context': 'interaction',
            'gen_ai.usage.input_tokens': 1000,
            'gen_ai.usage.cache_read.input_tokens': 400,
            'gen_ai.usage.output_tokens': 10,
            success: true,
          }),
          llmRequest({
            'session.id': SESSION,
            'llm_request.context': 'standalone',
            'gen_ai.usage.input_tokens': 500,
          }),
          llmRequest({
            'session.id': SESSION,
            'llm_request.context': 'standalone',
            subagent_name: 'extractor',
            'gen_ai.usage.input_tokens': 700,
          }),
        ),
      ),
    );

    expect(session.taskInputTokens).toBe(1000);
    expect(session.taskUncachedInputTokens).toBe(600);
    expect(session.sideQueryInputTokens).toBe(500);
    expect(session.subagentInputTokens).toBe(700);

    const summary = summarize([session]);
    // Folding the excluded traffic in would report 2200 — more than double.
    expect(summary.inputTokensPerTask.mean).toBe(1000);
    expect(summary.excludedFromTaskCost).toEqual({
      sideQueryInputTokens: 500,
      subagentInputTokens: 700,
    });
  });

  it('counts tool_search calls and the bad-call rate by error_type', () => {
    const sessions = collectSessions(
      parseTelemetryFile(
        outfile(
          llmRequest({
            'session.id': SESSION,
            'llm_request.context': 'interaction',
            'gen_ai.usage.input_tokens': 10,
          }),
          toolCall({
            'session.id': SESSION,
            function_name: 'read_file',
            status: 'success',
          }),
          toolCall({
            'session.id': SESSION,
            function_name: 'tool_search',
            status: 'success',
          }),
          toolCall({
            'session.id': SESSION,
            function_name: 'read_file',
            status: 'error',
            error_type: 'invalid_tool_params',
          }),
        ),
      ),
    );
    const summary = summarize(sessions);
    expect(summary.badCallRate).toMatchObject({
      toolCalls: 3,
      badCalls: 1,
      byErrorType: { invalid_tool_params: 1 },
    });
    expect(summary.toolSearchPerSession.mean).toBe(1);
    // A session that reached a tool has no idle cost by definition.
    expect(summary.idleInputTokens).toBeNull();
  });

  it('reports idle cost only for a session that never called a tool', () => {
    const sessions = collectSessions(
      parseTelemetryFile(
        outfile(
          llmRequest({
            'session.id': 'idle-session',
            'llm_request.context': 'interaction',
            'gen_ai.usage.input_tokens': 29347,
            'gen_ai.usage.cache_read.input_tokens': 14336,
          }),
          llmRequest({
            'session.id': 'busy-session',
            'llm_request.context': 'interaction',
            'gen_ai.usage.input_tokens': 5000,
          }),
          toolCall({
            'session.id': 'busy-session',
            function_name: 'read_file',
            status: 'success',
          }),
        ),
      ),
    );
    const summary = summarize(sessions);
    expect(summary.idleSessions).toBe(1);
    expect(summary.idleInputTokens).toBe(29347);
    expect(summary.inputTokensPerTask.p50).toBe(5000);
  });

  it('spreads p50/p95 across sessions instead of repeating one value', () => {
    const sessions = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]
      .map((tokens, i) =>
        collectSessions(
          parseTelemetryFile(
            outfile(
              llmRequest({
                'session.id': `s${i}`,
                'llm_request.context': 'interaction',
                'gen_ai.usage.input_tokens': tokens,
              }),
            ),
          ),
        ),
      )
      .flat();
    const summary = summarize(sessions);
    expect(summary.sessions).toBe(10);
    expect(summary.inputTokensPerTask.p50).toBe(50);
    expect(summary.inputTokensPerTask.p95).toBe(1000);
  });

  it('renders one column per configuration and a delta for exactly two', () => {
    const profile = (label, tokens) => ({
      label,
      file: `${label}.jsonl`,
      summary: summarize(
        collectSessions(
          parseTelemetryFile(
            outfile(
              llmRequest({
                'session.id': SESSION,
                'llm_request.context': 'interaction',
                'gen_ai.usage.input_tokens': tokens,
              }),
            ),
          ),
        ),
      ),
    });

    const single = formatReport([profile('baseline', 20000)]);
    expect(single).toContain('idle cost (input tok, no-tool session)  20,000');
    expect(single).not.toContain('vs baseline');

    const paired = formatReport([
      profile('baseline', 20000),
      profile('eager', 14000),
    ]);
    expect(paired).toContain('eager vs baseline:');
    expect(paired).toContain('-6,000 (-30.0%)');
  });
});
