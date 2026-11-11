/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildMonitorEventNotificationXml,
  buildMonitorCompletionSummary,
  buildTaskNotificationXml,
  buildCompletionSummary,
  parseTaskNotificationXml,
} from './taskNotification.js';

describe('taskNotification', () => {
  describe('buildMonitorEventNotificationXml', () => {
    it('matches the monitor event envelope exactly', () => {
      expect(
        buildMonitorEventNotificationXml({
          taskId: 'b123&unsafe',
          description: 'deployment <ready>',
          event: 'healthy </event> & serving',
        }),
      ).toBe(`<task-notification>
<task-id>b123&amp;unsafe</task-id>
<summary>Monitor event: "deployment &lt;ready&gt;"</summary>
<event>healthy &lt;/event&gt; &amp; serving</event>
</task-notification>`);
    });

  });

  describe('buildTaskNotificationXml', () => {
    it('should produce valid XML for a completed task', () => {
      const xml = buildTaskNotificationXml({
        taskId: 12345,
        outputPath: '/tmp/tasks/task-12345.output',
        status: 'completed',
        summary: 'Background command "ls -la" completed (exit code 0)',
      });

      expect(xml).toContain('<task-notification>');
      expect(xml).toContain('<task-id>12345</task-id>');
      expect(xml).toContain(
        '<output-file>/tmp/tasks/task-12345.output</output-file>',
      );
      expect(xml).toContain('<status>completed</status>');
      expect(xml).toContain(
        '<summary>Background command "ls -la" completed (exit code 0)</summary>',
      );
      expect(xml).toContain('</task-notification>');
    });

    it('should include tool-use-id when provided', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'task-1',
        outputPath: '/tmp/out.txt',
        status: 'failed',
        summary: 'failed',
        toolUseId: 'tool_abc123',
      });

      expect(xml).toContain('<tool-use-id>tool_abc123</tool-use-id>');
    });

    it('should omit tool-use-id when not provided', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'task-1',
        outputPath: '/tmp/out.txt',
        status: 'completed',
        summary: 'done',
      });

      expect(xml).not.toContain('<tool-use-id>');
    });

    it('should escape XML special characters in outputPath and summary', () => {
      const xml = buildTaskNotificationXml({
        taskId: 1,
        outputPath: '/tmp/<test>&path',
        status: 'completed',
        summary: 'Command with <special> & "chars"',
      });

      expect(xml).toContain(
        '<output-file>/tmp/&lt;test&gt;&amp;path</output-file>',
      );
      expect(xml).toContain('Command with &lt;special&gt; &amp; "chars"');
    });

    it('should match expected format exactly (multiline with newlines)', () => {
      const xml = buildTaskNotificationXml({
        taskId: 99,
        outputPath: '/tmp/out',
        status: 'killed',
        summary: 'was stopped',
      });

      const lines = xml.split('\n');
      expect(lines[0]).toBe('<task-notification>');
      expect(lines[1]).toBe('<task-id>99</task-id>');
      expect(lines[2]).toBe('<output-file>/tmp/out</output-file>');
      expect(lines[3]).toBe('<status>killed</status>');
      expect(lines[4]).toBe('<summary>was stopped</summary>');
      expect(lines[5]).toBe('</task-notification>');
    });

    it('should include escaped result when provided', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'agent-1',
        outputPath: '/tmp/agent.jsonl',
        status: 'completed',
        summary: 'Agent finished',
        result: 'Done <ok> & ready',
      });

      expect(xml).toContain('<result>Done &lt;ok&gt; &amp; ready</result>');
    });

    it('should include subagent usage in the reference layout', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'agent-1',
        outputPath: '/tmp/agent.jsonl',
        status: 'completed',
        summary: 'Agent finished',
        usage: { totalTokens: 321, toolUses: 4, durationMs: 1_500 },
      });

      expect(xml).toContain(
        '<usage><subagent_tokens>321</subagent_tokens><tool_uses>4</tool_uses><duration_ms>1500</duration_ms></usage>',
      );
      expect(parseTaskNotificationXml(xml)).toMatchObject({
        usage: { total_tokens: 321, tool_uses: 4, duration_ms: 1_500 },
      });
    });
  });

  describe('parseTaskNotificationXml', () => {
    it('parses terminal task notification fields', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'task-1',
        outputPath: '/tmp/out.txt',
        status: 'completed',
        summary: 'Task finished',
        toolUseId: 'toolu-1',
      });

      expect(parseTaskNotificationXml(xml)).toEqual({
        taskId: 'task-1',
        outputFile: '/tmp/out.txt',
        status: 'completed',
        summary: 'Task finished',
        toolUseId: 'toolu-1',
      });
    });

    it('keeps statusless task notifications non-terminal', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'task-1',
        outputPath: '/tmp/out.txt',
        summary: 'Still running',
      });

      expect(parseTaskNotificationXml(xml)).toMatchObject({
        taskId: 'task-1',
        outputFile: '/tmp/out.txt',
        summary: 'Still running',
        status: undefined,
      });
    });

    it('preserves empty output file fields', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'task-1',
        outputPath: '',
        status: 'completed',
        summary: 'Task finished',
      });

      expect(parseTaskNotificationXml(xml)).toEqual({
        taskId: 'task-1',
        outputFile: '',
        status: 'completed',
        summary: 'Task finished',
        toolUseId: undefined,
      });
    });

    it('parses stopped task notifications', () => {
      const xml = buildTaskNotificationXml({
        taskId: 'agent-1',
        outputPath: '/tmp/agent.jsonl',
        status: 'stopped',
        summary: 'Agent was stopped',
      });

      expect(parseTaskNotificationXml(xml)).toMatchObject({
        taskId: 'agent-1',
        outputFile: '/tmp/agent.jsonl',
        status: 'stopped',
        summary: 'Agent was stopped',
      });
    });
  });

  describe('buildCompletionSummary', () => {
    it('should build completed summary with exit code', () => {
      expect(buildCompletionSummary('npm test', 'completed', 0)).toBe(
        'Background command "npm test" completed (exit code 0)',
      );
    });

    it('should build completed summary without exit code', () => {
      expect(buildCompletionSummary('npm test', 'completed')).toBe(
        'Background command "npm test" completed',
      );
    });

    it('should build failed summary with exit code', () => {
      expect(buildCompletionSummary('npm test', 'failed', 1)).toBe(
        'Background command "npm test" failed with exit code 1',
      );
    });

    it('should build failed summary without exit code', () => {
      expect(buildCompletionSummary('npm test', 'failed')).toBe(
        'Background command "npm test" failed',
      );
    });

    it('should build killed summary (ignores exit code)', () => {
      expect(buildCompletionSummary('npm test', 'killed', 137)).toBe(
        'Background command "npm test" was stopped',
      );
    });
  });

  describe('buildMonitorCompletionSummary', () => {
    it('builds the reference terminal summaries', () => {
      expect(
        buildMonitorCompletionSummary('service readiness', 'completed', 0),
      ).toBe('Monitor "service readiness" stream ended');
      expect(
        buildMonitorCompletionSummary('service readiness', 'failed', 2),
      ).toBe('Monitor "service readiness" script failed (exit 2)');
      expect(
        buildMonitorCompletionSummary('service readiness', 'killed', 130),
      ).toBe('Monitor "service readiness" stopped');
    });
  });
});
