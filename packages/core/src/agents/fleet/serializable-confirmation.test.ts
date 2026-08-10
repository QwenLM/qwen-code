/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolCallConfirmationDetails } from '../../tools/tools.js';
import { serializeConfirmationDetails } from './serializable-confirmation.js';

describe('serializeConfirmationDetails', () => {
  it.each<ToolCallConfirmationDetails>([
    { type: 'info', title: 'Info', prompt: 'Continue?', onConfirm: vi.fn() },
    {
      type: 'edit',
      title: 'Edit',
      fileName: 'a.ts',
      filePath: '/tmp/a.ts',
      fileDiff: '+x',
      originalContent: '',
      newContent: 'x',
      onConfirm: vi.fn(),
    },
    {
      type: 'exec',
      title: 'Execute',
      command: 'pwd',
      rootCommand: 'pwd',
      onConfirm: vi.fn(),
    },
    {
      type: 'mcp',
      title: 'MCP',
      serverName: 'server',
      toolName: 'tool',
      toolDisplayName: 'Tool',
      onConfirm: vi.fn(),
    },
    { type: 'plan', title: 'Plan', plan: 'Do it', onConfirm: vi.fn() },
    {
      type: 'ask_user_question',
      title: 'Question',
      questions: [
        {
          question: 'Proceed?',
          header: 'Choice',
          options: [{ label: 'Yes', description: 'Continue' }],
        },
      ],
      onConfirm: vi.fn(),
    },
  ])('removes the callback from $type details', (details) => {
    const serialized = serializeConfirmationDetails(details);
    expect(serialized).not.toHaveProperty('onConfirm');
    expect(() => JSON.stringify(serialized)).not.toThrow();
    expect(serialized.type).toBe(details.type);
  });
});
