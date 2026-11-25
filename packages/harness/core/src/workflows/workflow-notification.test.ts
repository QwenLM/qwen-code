/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractXmlTagContent,
  parseTaskNotificationXml,
} from '../services/taskNotification.js';
import {
  buildWorkflowResumePrompt,
  buildWorkflowTaskNotificationXml,
  summarizeWorkflowAgentProgress,
  WORKFLOW_NOTIFICATION_RESULT_LIMIT,
} from './workflow-notification.js';

describe('workflow-notification', () => {
  it('summarizes final agent state, cache, retries, and empty results once', () => {
    expect(
      summarizeWorkflowAgentProgress([
        {
          type: 'workflow_agent',
          index: 1,
          label: 'cached',
          state: 'done',
          cached: true,
          attempt: 1,
          resultPreview: '[]',
        },
        {
          type: 'workflow_agent',
          index: 2,
          label: 'retried',
          state: 'done',
          attempt: 3,
          resultPreview: 'ok',
        },
        {
          type: 'workflow_agent',
          index: 3,
          label: 'skipped',
          state: 'skipped',
          skipped: true,
        },
      ]),
    ).toEqual({
      total: 3,
      done: 2,
      error: 0,
      skipped: 1,
      cached: 1,
      retry: 2,
      emptyResult: 1,
    });
  });

  it('builds the model-facing resume instruction with the cached run id', () => {
    expect(
      buildWorkflowResumePrompt({
        scriptPath: '/tmp/audit.js',
        runId: 'wf_123456',
        args: { scope: 'src' },
      }),
    ).toBe(
      "Resume the paused workflow by calling: Workflow({scriptPath: '/tmp/audit.js', resumeFromRunId: 'wf_123456', args: {\"scope\":\"src\"}}) — completed agents return cached results.",
    );
  });

  it('includes status-specific failure and recovery guidance', () => {
    const xml = buildWorkflowTaskNotificationXml({
      taskId: 'wf-1',
      outputPath: '/tmp/output.json',
      status: 'failed',
      summary: 'Audit workflow',
      scriptPath: '/tmp/workflow.js',
      transcriptDir: '/tmp/transcripts',
      runId: 'wf_123456',
      args: { question: 'Why?' },
      result: {
        result: null,
        logs: [],
        failures: ['agent failed'],
        phaseCount: 1,
        agentCount: 1,
        totalTokens: 12,
        totalToolCalls: 3,
        durationMs: 10,
        error: 'boom',
      },
    });

    const parsed = parseTaskNotificationXml(xml);

    expect(parsed?.status).toBe('failed');
    expect(parsed?.summary).toBe(
      'Dynamic workflow "Audit workflow" failed: boom',
    );
    expect(extractXmlTagContent(xml, 'recovery')).toContain(
      'resumeFromRunId',
    );
    expect(extractXmlTagContent(xml, 'recovery')).toContain(
      'args: {"question":"Why?"}',
    );
    expect(extractXmlTagContent(xml, 'recovery')).toContain(
      'Agent transcripts: /tmp/transcripts',
    );
    expect(extractXmlTagContent(xml, 'failures')).toBe('agent failed');
    expect(extractXmlTagContent(xml, 'output-file')).toBe('/tmp/output.json');
    expect(extractXmlTagContent(xml, 'tool_uses')).toBe('3');
    expect(extractXmlTagContent(xml, 'duration_ms')).toBe('10');
    expect(xml).not.toContain('tokens=12');
    expect(xml).not.toContain('subagent_tokens');
  });

  it('truncates only the result and preserves diagnostics, failures, and usage', () => {
    const xml = buildWorkflowTaskNotificationXml({
      taskId: 'wf-1',
      outputPath: '/tmp/output.json',
      status: 'completed',
      summary: 'Audit workflow',
      scriptPath: '/tmp/workflow.js',
      transcriptDir: '/tmp/transcripts',
      runId: 'wf_123456',
      args: 'research question',
      result: {
        // The wire limit is applied after XML escaping, matching the actual
        // number of characters placed inside <result>.
        result: '<'.repeat(WORKFLOW_NOTIFICATION_RESULT_LIMIT / 4 + 25),
        logs: [],
        failures: ['late non-fatal failure'],
        phaseCount: 1,
        agentCount: 1,
        totalTokens: 0,
        totalToolCalls: 7,
        durationMs: 90_000,
      },
    });

    const result = extractXmlTagContent(xml, 'result');
    expect(result).toContain('truncated 100 chars');
    expect(result).toContain('full result in /tmp/output.json');
    expect(extractXmlTagContent(xml, 'diagnostics')).toContain(
      '/tmp/transcripts/journal.jsonl',
    );
    expect(extractXmlTagContent(xml, 'diagnostics')).toContain(
      'args: "research question"',
    );
    expect(extractXmlTagContent(xml, 'failures')).toBe(
      'late non-fatal failure',
    );
    expect(extractXmlTagContent(xml, 'tool_uses')).toBe('7');
    expect(extractXmlTagContent(xml, 'duration_ms')).toBe('90000');
  });

  it('does not split an escaped XML entity at the result limit', () => {
    const safePrefix = 'x'.repeat(WORKFLOW_NOTIFICATION_RESULT_LIMIT - 2);
    const xml = buildWorkflowTaskNotificationXml({
      taskId: 'wf-1',
      outputPath: '/tmp/output.json',
      status: 'completed',
      summary: 'Audit workflow',
      scriptPath: '/tmp/workflow.js',
      transcriptDir: '/tmp/transcripts',
      runId: 'wf_123456',
      result: {
        result: `${safePrefix}&tail`,
        logs: [],
        failures: [],
        phaseCount: 1,
        agentCount: 1,
        totalTokens: 0,
        totalToolCalls: 0,
        durationMs: 1,
      },
    });

    const inlineResult = xml.match(
      /<result>([\s\S]*?)\n\.\.\. \(truncated/,
    )?.[1];
    expect(inlineResult).toBe(safePrefix);
    expect(xml).toContain('truncated 9 chars');
  });

  it('reports terminal agent counts without exposing token usage', () => {
    const xml = buildWorkflowTaskNotificationXml({
      taskId: 'wf-1',
      outputPath: '/tmp/output.json',
      status: 'completed',
      summary: 'Deep research harness',
      scriptPath: '/tmp/workflow.js',
      transcriptDir: '/tmp/transcripts',
      runId: 'wf_123456',
      result: {
        result: { ok: true },
        logs: [],
        failures: [],
        phaseCount: 2,
        agentCount: 4,
        totalTokens: 123,
        totalToolCalls: 9,
        durationMs: 125_000,
      },
      workflowProgress: [
        {
          type: 'workflow_agent',
          index: 1,
          label: 'done',
          state: 'done',
          resultPreview: '{"ok":true}',
        },
        {
          type: 'workflow_agent',
          index: 2,
          label: 'empty',
          state: 'done',
          resultPreview: '[]',
        },
        {
          type: 'workflow_agent',
          index: 3,
          label: 'failed',
          state: 'error',
        },
        {
          type: 'workflow_agent',
          index: 4,
          label: 'skipped',
          state: 'skipped',
          skipped: true,
        },
      ],
    });

    expect(extractXmlTagContent(xml, 'summary')).toBe(
      'Dynamic workflow "Deep research harness" completed',
    );
    expect(extractXmlTagContent(xml, 'agent_count')).toBe('4');
    expect(extractXmlTagContent(xml, 'agents_done')).toBe('2');
    expect(extractXmlTagContent(xml, 'agents_error')).toBe('1');
    expect(extractXmlTagContent(xml, 'agents_skipped')).toBe('1');
    expect(extractXmlTagContent(xml, 'agents_empty_result')).toBe('1');
    expect(extractXmlTagContent(xml, 'duration_ms')).toBe('125000');
    expect(xml).not.toContain('totalTokens');
    expect(xml).not.toContain('subagent_tokens');
  });
});
