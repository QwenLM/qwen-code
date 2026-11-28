/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  McpStatusMessage,
  serializeMcpStatusMessage,
  type SerializedMcpStatusMessage,
} from './McpStatusMessage';
import {
  TasksStatusMessage,
  serializeTasksStatusMessage,
  type SerializedTasksMessage,
} from './TasksStatusMessage';
import { DAEMON_STATUS_CARD_RENDERERS } from './daemon-status-cards';

describe('DAEMON_STATUS_CARD_RENDERERS', () => {
  it('parses serialized MCP status payloads into McpStatusMessage elements and ignores plain text', () => {
    expect(DAEMON_STATUS_CARD_RENDERERS.renderMcpStatus('plain text')).toBe(
      null,
    );
    const message: SerializedMcpStatusMessage = {
      status: {
        servers: [],
      } as SerializedMcpStatusMessage['status'],
      toolsByServer: {},
      showDescriptions: false,
      showSchema: false,
      showTips: false,
    };
    const payload = serializeMcpStatusMessage(message);
    const element = DAEMON_STATUS_CARD_RENDERERS.renderMcpStatus(payload);
    expect(isValidElement(element)).toBe(true);
    if (isValidElement(element)) {
      expect(element.type).toBe(McpStatusMessage);
    }
  });

  it('parses serialized Tasks status payloads into TasksStatusMessage elements and ignores plain text', () => {
    expect(DAEMON_STATUS_CARD_RENDERERS.renderTasksStatus('plain text')).toBe(
      null,
    );
    const message: SerializedTasksMessage = {
      snapshot: {
        sessionId: 'session-1',
        tasks: [],
      } as unknown as SerializedTasksMessage['snapshot'],
    };
    const payload = serializeTasksStatusMessage(message);
    const element = DAEMON_STATUS_CARD_RENDERERS.renderTasksStatus(payload);
    expect(isValidElement(element)).toBe(true);
    if (isValidElement(element)) {
      expect(element.type).toBe(TasksStatusMessage);
    }
  });
});
