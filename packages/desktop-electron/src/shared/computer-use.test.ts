/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ComputerUseActivityTracker,
  extractComputerUseTarget,
  formatComputerUseAction,
  parseSseMessage,
  projectComputerUseDaemonEvent,
  sessionIdFromUrl,
  takeSseMessages,
} from './computer-use';

describe('Electron Computer Use surfaces', () => {
  it('extracts the final standalone session path segment', () => {
    expect(sessionIdFromUrl('http://127.0.0.1/app/session/a%20b')).toBe('a b');
    expect(sessionIdFromUrl('http://127.0.0.1/settings')).toBeUndefined();
  });

  it('projects wrapped and direct Computer Use tool events', () => {
    expect(
      projectComputerUseDaemonEvent({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            status: 'in_progress',
            rawInput: { window_id: 42 },
            _meta: { toolName: 'computer_use__click' },
          },
        },
      }),
    ).toEqual({
      kind: 'tool',
      args: { window_id: 42 },
      callId: 'call-1',
      status: 'in_progress',
      toolName: 'computer_use__click',
    });
    expect(
      projectComputerUseDaemonEvent({
        type: 'tool_call_update',
        data: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-2',
          status: 'completed',
          toolName: 'computer_use__scroll',
        },
      }),
    ).toMatchObject({ kind: 'tool', callId: 'call-2' });
  });

  it('ignores non-Computer-Use tools and ends activity at a turn boundary', () => {
    const tracker = new ComputerUseActivityTracker();
    expect(
      tracker.consume({
        type: 'tool_call',
        data: {
          toolCallId: 'call-read',
          status: 'in_progress',
          toolName: 'read_file',
        },
      }),
    ).toMatchObject({ active: false });
    expect(
      tracker.consume({
        type: 'tool_call',
        data: {
          toolCallId: 'call-click',
          status: 'in_progress',
          rawInput: { window_id: '123' },
          _meta: { toolName: 'computer_use__click' },
        },
      }),
    ).toMatchObject({
      active: true,
      toolName: 'computer_use__click',
    });
    expect(
      tracker.consume({
        type: 'tool_call_update',
        data: {
          toolCallId: 'call-click',
          status: 'completed',
          _meta: { toolName: 'computer_use__click' },
        },
      }),
    ).toMatchObject({
      active: true,
      toolName: 'computer_use__click',
    });
    expect(tracker.consume({ type: 'turn_complete', data: {} })).toMatchObject({
      active: false,
    });
  });

  it('starts only after a Computer Use permission is approved', () => {
    const tracker = new ComputerUseActivityTracker();
    expect(
      tracker.consume({
        type: 'permission_request',
        data: {
          requestId: 'permission-1',
          options: [
            {
              optionId: 'proceed_once',
              name: 'Allow',
              kind: 'allow_once',
            },
            { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
          ],
          toolCall: {
            toolCallId: 'call-click',
            rawInput: { window_id: 123 },
            _meta: { toolName: 'computer_use__click' },
          },
        },
      }),
    ).toMatchObject({ active: false });
    expect(
      tracker.consume({
        type: 'permission_resolved',
        data: {
          requestId: 'permission-1',
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        },
      }),
    ).toMatchObject({
      active: true,
      toolName: 'computer_use__click',
    });
  });

  it('does not start when a Computer Use permission is cancelled', () => {
    const tracker = new ComputerUseActivityTracker();
    tracker.consume({
      type: 'permission_request',
      data: {
        requestId: 'permission-1',
        options: [
          { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
        ],
        toolCall: {
          toolCallId: 'call-click',
          _meta: { toolName: 'computer_use__click' },
        },
      },
    });
    tracker.consume({
      type: 'permission_resolved',
      data: {
        requestId: 'permission-1',
        outcome: { outcome: 'selected', optionId: 'cancel' },
      },
    });
    expect(
      tracker.consume({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-click',
            status: 'failed',
            _meta: { toolName: 'computer_use__click' },
          },
        },
      }),
    ).toMatchObject({ active: false });
  });

  it('parses incremental SSE frames', () => {
    const first = 'event: session_update\ndata: {"type":"tool_call"}\n\n';
    const { messages, rest } = takeSseMessages(`${first}event: partial`);
    expect(messages).toHaveLength(1);
    expect(rest).toBe('event: partial');
    expect(parseSseMessage(messages[0]!)).toEqual({ type: 'tool_call' });
  });

  it('normalizes target metadata and localized action labels', () => {
    expect(extractComputerUseTarget({ app_name: 'Safari' })).toBe('Safari');
    expect(formatComputerUseAction('computer_use__type_text', 'zh-CN')).toBe(
      '输入文字',
    );
    expect(formatComputerUseAction('computer_use__scroll', 'en-US')).toBe(
      'Scrolling',
    );
  });
});
