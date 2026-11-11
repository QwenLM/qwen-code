/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@qwen-code/core';
import {
  type Config,
  type SDKMessage,
  OutputFormat,
  runLogger,
} from '@qwen-code/core';
import { ReadFileTool } from '../../../core/src/tools/read-file.js';
import { createToolFileStateCache } from '../../../core/src/utils/fileStateCache.js';
import { initializeShellSession } from '../../../core/src/utils/Shell.js';
import { ToolFailureLog } from './toolFailureLog.js';
import {
  HeadlessSession,
  type HeadlessSessionParams,
} from './headlessSession.js';

function toolUse(id: string, name: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
    session_id: 'session-1',
    uuid: `assistant-${id}`,
  } as SDKMessage;
}

function toolResult(id: string, content: unknown, isError = true): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, is_error: isError },
      ],
    },
    session_id: 'session-1',
    uuid: `user-${id}`,
  } as SDKMessage;
}

function childMessage(message: SDKMessage, parentId = 'agent-1'): SDKMessage {
  return { ...message, parent_tool_use_id: parentId } as SDKMessage;
}

function spyOnWarn() {
  return vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
}

function createSession(outputFormat = OutputFormat.TEXT) {
  const session = new HeadlessSession({
    settings: { merged: {} },
    cliArgs: { outputFormat },
    threadManager: {},
    workspaceRoot: '/workspace',
  } as unknown as HeadlessSessionParams);
  session['openedSessionId'] = 'session-1';
  return session;
}

afterEach(() => vi.restoreAllMocks());

describe('ToolFailureLog', () => {
  it('isolates equal tool IDs in the main agent and different subagents', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(toolUse('same-id', 'Read'));
    log.observe(childMessage(toolUse('same-id', 'Bash')));
    log.observe(childMessage(toolUse('same-id', 'Grep'), 'agent-2'));
    log.observe(childMessage(toolResult('same-id', 'bash failed')));
    log.observe(toolResult('same-id', 'read failed'));
    log.observe(childMessage(toolResult('same-id', 'grep failed'), 'agent-2'));
    expect(warn.mock.calls).toEqual([
      ['Error executing tool Bash: bash failed'],
      ['Error executing tool Read: read failed'],
      ['Error executing tool Grep: grep failed'],
    ]);
  });

  it('preserves background names and dedupe state across main turn completion', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(childMessage(toolUse('pending', 'Read')));
    log.observe(childMessage(toolUse('settled', 'Bash')));
    log.observe(childMessage(toolResult('settled', 'bash failed')));
    log.clearTurn();
    log.observe(childMessage(toolResult('settled', 'bash failed')));
    log.observe(childMessage(toolResult('pending', 'read failed')));
    expect(warn.mock.calls).toEqual([
      ['Error executing tool Bash: bash failed'],
      ['Error executing tool Read: read failed'],
    ]);
  });

  it.each(['completed', 'failed', 'killed'] as const)(
    'releases background state on task_updated status %s',
    (status) => {
      const log = new ToolFailureLog();
      log.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'agent-1',
      } as SDKMessage);
      log.observe(childMessage(toolUse('pending', 'Read')));
      log.clearTurn();
      expect(log['childScopes'].size).toBe(1);
      log.observe({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: { status },
      } as SDKMessage);
      expect(log['childScopes'].size).toBe(0);
      expect(log['taskScopes'].size).toBe(0);
    },
  );

  it('releases foreground state on task_notification and all state on exit', () => {
    const log = new ToolFailureLog();
    log.observe(childMessage(toolUse('pending', 'Read')));
    log.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'agent-1',
      status: 'completed',
    } as SDKMessage);
    expect(log['childScopes'].size).toBe(0);
    log.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-2',
      tool_use_id: 'agent-2',
    } as SDKMessage);
    log.observe(childMessage(toolUse('pending', 'Read'), 'agent-2'));
    log.clear();
    expect(log['childScopes'].size).toBe(0);
    expect(log['taskScopes'].size).toBe(0);
  });

  it('associates out-of-order parallel results with their own names', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(toolUse('read', 'Read'));
    log.observe(toolUse('bash', 'Bash'));
    log.observe(toolResult('bash', 'command failed'));
    log.observe(toolResult('read', 'File does not exist.'));
    expect(warn.mock.calls).toEqual([
      ['Error executing tool Bash: command failed'],
      ['Error executing tool Read: File does not exist.'],
    ]);
  });

  it('preserves a failed result and its call ID when the name is unavailable', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(toolResult('unmatched-call', 'File does not exist.'));
    log.observe(toolResult('unmatched-call', 'File does not exist.'));
    expect(warn.mock.calls).toEqual([
      [
        'Error executing tool (name unavailable; tool_use_id=unmatched-call): File does not exist.',
      ],
    ]);
  });

  it('releases successful calls without logging or retaining their names', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(toolUse('read', 'Read'));
    log.observe(toolResult('read', 'file content', false));
    expect(warn).not.toHaveBeenCalled();
    expect(log['toolNames'].size).toBe(0);
  });

  it('deduplicates both repeated results and replayed call/result pairs', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(toolUse('read', 'Read'));
    log.observe(toolResult('read', 'missing file'));
    log.observe(toolResult('read', 'missing file'));
    log.observe(toolUse('read', 'Read'));
    log.observe(toolResult('read', 'missing file'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log['toolNames'].size).toBe(0);
  });

  it.each([
    {
      content: [{ type: 'text', text: 'missing file' }],
      expected: '[{"type":"text","text":"missing file"}]',
    },
    { content: undefined, expected: 'Tool execution failed' },
    { content: null, expected: 'Tool execution failed' },
    { content: '', expected: 'Tool execution failed' },
  ])('formats result content: $expected', ({ content, expected }) => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(toolUse('read', 'Read'));
    log.observe(toolResult('read', content));
    expect(warn).toHaveBeenCalledWith(`Error executing tool Read: ${expected}`);
  });

  it('clears unfinished calls and dedupe state between turns', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe(toolUse('unfinished', 'Read'));
    log.observe(toolUse('settled', 'Bash'));
    log.observe(toolResult('settled', 'ok', false));
    log.clear();
    expect(log['toolNames'].size).toBe(0);
    expect(log['settledToolIds'].size).toBe(0);
    log.observe(toolUse('settled', 'Read'));
    log.observe(toolResult('settled', 'missing file'));
    expect(warn).toHaveBeenCalledWith(
      'Error executing tool Read: missing file',
    );
  });

  it('ignores ordinary messages and non-tool content', () => {
    const warn = spyOnWarn();
    const log = new ToolFailureLog();
    log.observe({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    } as SDKMessage);
    log.observe({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [null, { type: 'text', text: 'hello' }],
      },
    } as unknown as SDKMessage);
    log.observe({ type: 'system', subtype: 'init' } as SDKMessage);
    expect(warn).not.toHaveBeenCalled();
    expect(log['toolNames'].size).toBe(0);
  });
});

describe('headless tool failure logs', () => {
  it.each(['result', 'turnFailed'] as const)(
    'preserves a background call when the main turn emits %s',
    (terminal) => {
      const warn = spyOnWarn();
      const session = createSession();
      const host = session.createThreadHost();
      host.events.emit({
        kind: 'threadMessage',
        message: childMessage(toolUse('read', 'Read')),
      });
      if (terminal === 'result') {
        host.events.emit({
          kind: 'threadMessage',
          message: { type: 'result', subtype: 'success' } as SDKMessage,
        });
      } else {
        host.events.emit({
          kind: 'turnFailed',
          error: new Error('main turn failed'),
        });
      }
      host.events.emit({
        kind: 'threadMessage',
        message: childMessage(toolResult('read', 'File does not exist.')),
      });
      expect(warn).toHaveBeenCalledWith(
        'Error executing tool Read: File does not exist.',
      );
    },
  );

  it('reports a real missing-file Read failure through the headless host', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'headless-read-failure-'),
    );
    const warn = spyOnWarn();
    try {
      const config = {
        getTargetDir: () => directory,
        fileReadState: createToolFileStateCache(),
        getSkillManager: () => ({
          activateConditionalSkillsForPaths: () => [],
        }),
      } as unknown as Config;
      initializeShellSession(config, directory);
      const tool = new ReadFileTool(config);
      const result = await tool
        .build({ file_path: path.join(directory, 'missing.txt') })
        .execute(new AbortController().signal);
      expect(result.error?.message).toContain('File does not exist.');
      const host = createSession().createThreadHost();
      host.events.emit({
        kind: 'threadMessage',
        message: toolUse('read', tool.name),
      });
      host.events.emit({
        kind: 'threadMessage',
        message: toolResult('read', result.llmContent, !!result.error),
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Error executing tool Read: File does not exist.',
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([OutputFormat.TEXT, OutputFormat.JSON, OutputFormat.STREAM_JSON])(
    'logs the name in %s mode without adding stdout/stderr data',
    (format) => {
      const warn = spyOnWarn();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      vi.spyOn(core, 'createWorkingStdio').mockReturnValue({
        stdout,
        stderr,
      } as unknown as ReturnType<typeof core.createWorkingStdio>);
      const session = createSession(format);
      const host = session.createThreadHost();
      const messages = [
        toolUse('read', 'Read'),
        toolResult('read', 'File does not exist.'),
      ];
      for (const message of messages)
        host.events.emit({ kind: 'threadMessage', message });
      expect(warn).toHaveBeenCalledWith(
        'Error executing tool Read: File does not exist.',
      );
      expect(stderr.read()).toBeNull();
      if (format === OutputFormat.STREAM_JSON) {
        const frames = String(stdout.read())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(frames).toEqual(messages);
      } else {
        expect(stdout.read()).toBeNull();
      }
    },
  );

  it.each(['result', 'turnFailed'] as const)(
    'clears pending state on %s',
    (terminal) => {
      spyOnWarn();
      const session = createSession();
      const host = session.createThreadHost();
      host.events.emit({
        kind: 'threadMessage',
        message: toolUse('unfinished', 'Read'),
      });
      host.events.emit({
        kind: 'threadMessage',
        message: toolResult('settled', 'failed'),
      });
      if (terminal === 'result') {
        host.events.emit({
          kind: 'threadMessage',
          message: { type: 'result', subtype: 'success' } as SDKMessage,
        });
      } else {
        host.events.emit({
          kind: 'turnFailed',
          error: new Error('query failed'),
        });
      }
      expect(session['toolFailureLog']['toolNames'].size).toBe(0);
      expect(session['toolFailureLog']['settledToolIds'].size).toBe(0);
    },
  );
});
