/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  extractSessionListItems,
  QwenAgentManager,
} from './qwenAgentManager.js';

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

describe('extractSessionListItems', () => {
  it('reads ACP session arrays from the sessions field', () => {
    const items = extractSessionListItems({
      sessions: [{ sessionId: 'session-1' }],
    });

    expect(items).toEqual([{ sessionId: 'session-1' }]);
  });

  it('reads ACP session arrays from the legacy items field', () => {
    const items = extractSessionListItems({
      items: [{ sessionId: 'session-2' }],
    });

    expect(items).toEqual([{ sessionId: 'session-2' }]);
  });
});

describe('QwenAgentManager session list compatibility', () => {
  it('maps paged ACP session lists returned via items', async () => {
    const manager = new QwenAgentManager();
    const listSessions = vi.fn().mockResolvedValue({
      items: [
        {
          sessionId: 'session-3',
          prompt: 'Fix sidebar history',
          mtime: 1772114825468.5825,
          cwd: 'e:\\Qwen\\qwen-code',
        },
      ],
    });

    (
      manager as unknown as {
        connection: { listSessions: typeof listSessions };
      }
    ).connection = { listSessions };

    const page = await manager.getSessionListPaged({ size: 20 });

    expect(listSessions).toHaveBeenCalledWith({ size: 20 });
    expect(page).toEqual({
      sessions: [
        {
          id: 'session-3',
          sessionId: 'session-3',
          title: 'Fix sidebar history',
          name: 'Fix sidebar history',
          startTime: undefined,
          lastUpdated: 1772114825468.5825,
          messageCount: 0,
          projectHash: undefined,
          filePath: undefined,
          cwd: 'e:\\Qwen\\qwen-code',
        },
      ],
      nextCursor: undefined,
      hasMore: false,
    });
  });
});
