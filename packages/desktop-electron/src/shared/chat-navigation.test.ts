/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readChatNavigation, writeChatNavigation } from './chat-navigation';

describe('chat window navigation', () => {
  it('round-trips a session while preserving other surface parameters', () => {
    const url = writeChatNavigation(
      'qwen-desktop://app/index.html?theme=dark',
      { sessionId: 'session-1', workspaceId: 'workspace-1' },
    );
    expect(url).toBe(
      'qwen-desktop://app/index.html?theme=dark&session=session-1&workspace=workspace-1',
    );
    expect(readChatNavigation(url)).toEqual({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    });
  });

  it('removes cleared session state and rejects unbounded values', () => {
    expect(
      writeChatNavigation(
        'qwen-desktop://app/index.html?session=old&workspace=old',
        {},
      ),
    ).toBe('qwen-desktop://app/index.html');
    expect(
      readChatNavigation(
        `qwen-desktop://app/index.html?session=${'x'.repeat(1_025)}`,
      ),
    ).toEqual({ sessionId: undefined, workspaceId: undefined });
  });
});
