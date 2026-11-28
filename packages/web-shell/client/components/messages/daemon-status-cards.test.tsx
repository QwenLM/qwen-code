// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, isValidElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useMcp: () => ({
    status: null,
    loading: false,
    error: undefined,
    reload: vi.fn(),
    loadTools: vi.fn(),
    loadResources: vi.fn(),
    restartServer: vi.fn(),
    manageServer: vi.fn(),
  }),
  useActions: () => ({
    getTasks: vi.fn().mockResolvedValue({ sessionId: 's1', tasks: [] }),
    getWorkflowTasks: vi.fn().mockResolvedValue({ sessionId: 's1', tasks: [] }),
    cancelTask: vi.fn().mockResolvedValue({}),
  }),
  useConnection: () => ({
    sessionId: 's1',
    status: 'connected',
  }),
}));

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
import { SystemMessage } from './SystemMessage';
import { DaemonStatusCardsContext } from './daemon-status-cards-context';
import { DAEMON_STATUS_CARD_RENDERERS } from './daemon-status-cards';

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('DAEMON_STATUS_CARD_RENDERERS', () => {
  const mcpMessage: SerializedMcpStatusMessage = {
    status: {
      servers: [],
    } as SerializedMcpStatusMessage['status'],
    toolsByServer: {},
    showDescriptions: false,
    showSchema: false,
    showTips: false,
  };

  const tasksMessage: SerializedTasksMessage = {
    snapshot: {
      sessionId: 'session-1',
      tasks: [],
    } as unknown as SerializedTasksMessage['snapshot'],
  };

  it('parses serialized MCP status payloads into McpStatusMessage elements and ignores plain text', () => {
    expect(DAEMON_STATUS_CARD_RENDERERS.renderMcpStatus('plain text')).toBe(
      null,
    );
    const payload = serializeMcpStatusMessage(mcpMessage);
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
    const payload = serializeTasksStatusMessage(tasksMessage);
    const element = DAEMON_STATUS_CARD_RENDERERS.renderTasksStatus(payload);
    expect(isValidElement(element)).toBe(true);
    if (isValidElement(element)) {
      expect(element.type).toBe(TasksStatusMessage);
    }
  });

  it('renders real MCP and Tasks status cards through SystemMessage when provided via DaemonStatusCardsContext', () => {
    const mcpPayload = serializeMcpStatusMessage(mcpMessage);
    const tasksPayload = serializeTasksStatusMessage(tasksMessage);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        <I18nProvider language="en">
          <DaemonStatusCardsContext.Provider
            value={DAEMON_STATUS_CARD_RENDERERS}
          >
            <SystemMessage content={mcpPayload} variant="info" />
            <SystemMessage content={tasksPayload} variant="info" />
          </DaemonStatusCardsContext.Provider>
        </I18nProvider>,
      ),
    );

    expect(container.textContent).not.toContain('web-shell:mcp-status:v1:');
    expect(container.textContent).not.toContain('web-shell:tasks-status:v1:');
    expect(container.textContent).toContain('Manage MCP servers');
    expect(container.textContent).toContain('Background tasks');
  });
});
