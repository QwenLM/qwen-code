/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  workspace: {},
  commands: { executeCommand: vi.fn() },
}));

describe('QwenAgentManager stored message expansion', () => {
  it('expands assistant thoughts before assistant content', async () => {
    const { QwenAgentManager } = await import('./qwenAgentManager.js');
    const manager = new QwenAgentManager();
    const messages = (
      manager as unknown as {
        expandStoredMessages(input: Array<{ type: string; content: string; timestamp: string; thoughts?: unknown[] }>): Array<{ role: string; content: string }>;
      }
    ).expandStoredMessages([
      {
        type: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-06T12:00:01.000Z',
        thoughts: ['thinking step'],
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({ role: 'thinking', content: 'thinking step' }),
      expect.objectContaining({ role: 'assistant', content: 'final answer' }),
    ]);
  });
});
