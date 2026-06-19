/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { copyCommand } from './copyCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { copyToClipboard } from '../utils/commandUtils.js';

vi.mock('../utils/commandUtils.js', () => ({
  copyToClipboard: vi.fn(),
}));

describe('copyCommand', () => {
  let mockContext: CommandContext;
  let mockCopyToClipboard: Mock;
  let mockGetChat: Mock;
  let mockGetHistory: Mock;
  let mockGetHistoryShallow: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    mockCopyToClipboard = vi.mocked(copyToClipboard);
    mockGetChat = vi.fn();
    mockGetHistory = vi.fn();
    mockGetHistoryShallow = vi.fn();

    mockContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () => ({
            getChat: mockGetChat,
          }),
          getDebugLogger: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          }),
        },
      },
    });

    mockGetChat.mockReturnValue({
      getHistory: mockGetHistory,
      getHistoryShallow: mockGetHistoryShallow,
    });
  });

  it('should return info message when no history is available', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetChat.mockReturnValue(undefined);

    const result = await copyCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No output in history',
    });

    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should return info message when history is empty', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([]);

    const result = await copyCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No output in history',
    });

    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should return info message when no AI messages are found in history', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithUserOnly = [
      {
        role: 'user',
        parts: [{ text: 'Hello' }],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithUserOnly);

    const result = await copyCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No output in history',
    });

    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should copy last AI message to clipboard successfully', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithAiMessage = [
      {
        role: 'user',
        parts: [{ text: 'Hello' }],
      },
      {
        role: 'model',
        parts: [{ text: 'Hi there! How can I help you?' }],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithAiMessage);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Last output copied to the clipboard',
    });

    expect(mockCopyToClipboard).toHaveBeenCalledWith(
      'Hi there! How can I help you?',
    );
  });

  it('should handle multiple text parts in AI message', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithMultipleParts = [
      {
        role: 'model',
        parts: [{ text: 'Part 1: ' }, { text: 'Part 2: ' }, { text: 'Part 3' }],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithMultipleParts);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('Part 1: Part 2: Part 3');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Last output copied to the clipboard',
    });
  });

  it('should not copy thought parts from the last AI message', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithThoughtPart = [
      {
        role: 'model',
        parts: [
          { text: 'internal reasoning', thought: true },
          { text: 'Visible report' },
        ],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithThoughtPart);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('Visible report');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Last output copied to the clipboard',
    });
  });

  it('should filter out non-text parts', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithMixedParts = [
      {
        role: 'model',
        parts: [
          { text: 'Text part' },
          { image: 'base64data' }, // Non-text part
          { text: ' more text' },
        ],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithMixedParts);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('Text part more text');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Last output copied to the clipboard',
    });
  });

  it('should get the last AI message when multiple AI messages exist', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithMultipleAiMessages = [
      {
        role: 'model',
        parts: [{ text: 'First AI response' }],
      },
      {
        role: 'user',
        parts: [{ text: 'User message' }],
      },
      {
        role: 'model',
        parts: [{ text: 'Second AI response' }],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithMultipleAiMessages);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('Second AI response');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Last output copied to the clipboard',
    });
  });

  it('should copy the last fenced code block with /copy code', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              'Example:',
              '```js',
              'const first = true;',
              '```',
              '```mermaid',
              'flowchart TD',
              '  A --> B',
              '```',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'code');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('flowchart TD\n  A --> B');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Code block 2 copied to the clipboard',
    });
  });

  it('should copy a numbered fenced code block with /copy code 2', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '```ts',
              'const first = 1;',
              '```',
              '```json',
              '{"second": true}',
              '```',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'code 2');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('{"second": true}');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Code block 2 copied to the clipboard',
    });
  });

  it('should copy the last matching language code block with /copy code mermaid', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '```mermaid title="First"',
              'flowchart LR',
              '  A --> B',
              '```',
              '```mermaid',
              'sequenceDiagram',
              '  A->>B: hello',
              '```',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'code mermaid');

    expect(mockCopyToClipboard).toHaveBeenCalledWith(
      'sequenceDiagram\n  A->>B: hello',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'mermaid code block 2 copied to the clipboard',
    });
  });

  it('should copy a numbered matching language block with /copy code mermaid 1', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '```mermaid',
              'flowchart LR',
              '  A --> B',
              '```',
              '```mermaid',
              'flowchart TD',
              '  C --> D',
              '```',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'code mermaid 1');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('flowchart LR\n  A --> B');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'mermaid code block 1 copied to the clipboard',
    });
  });

  it('should copy a numbered matching language block with /copy mermaid 1', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '```ts',
              'const before = true;',
              '```',
              '```mermaid',
              'flowchart LR',
              '  A --> B',
              '```',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'mermaid 1');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('flowchart LR\n  A --> B');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'mermaid code block 1 copied to the clipboard',
    });
  });

  it('should copy the last LaTeX block with /copy latex', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '$$',
              '\\alpha + \\beta',
              '$$',
              '$$',
              '\\sum_{i=1}^{n} x_i',
              '$$',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'latex');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('\\sum_{i=1}^{n} x_i');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'LaTeX block 2 copied to the clipboard',
    });
  });

  it('should copy a numbered LaTeX block with /copy latex 1', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '$$',
              '\\alpha + \\beta',
              '$$',
              '$$',
              '\\gamma + \\delta',
              '$$',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'latex 1');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('\\alpha + \\beta');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'LaTeX block 1 copied to the clipboard',
    });
  });

  it('should not copy LaTeX blocks from fenced code blocks', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '```md',
              '$$',
              'ignored_code_math',
              '$$',
              '```',
              '$$',
              '\\alpha + \\beta',
              '$$',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'latex 1');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('\\alpha + \\beta');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'LaTeX block 1 copied to the clipboard',
    });
  });

  it('should copy the last inline LaTeX expression with /copy latex inline', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              'Inline math: $x^2 + \\alpha$ and $e^{i\\pi} + 1 = 0$',
              '$$',
              '\\sum_{i=1}^{n} x_i',
              '$$',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'latex inline');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('e^{i\\pi} + 1 = 0');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Inline LaTeX expression 2 copied to the clipboard',
    });
  });

  it('should copy a numbered inline LaTeX expression with /copy latex inline 1', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              'Formula $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$',
              'Identity $e^{i\\pi} + 1 = 0$',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'latex inline 1');

    expect(mockCopyToClipboard).toHaveBeenCalledWith(
      'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Inline LaTeX expression 1 copied to the clipboard',
    });
  });

  it('should copy inline LaTeX with the /copy inline-latex alias', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [{ text: 'Inline math: $\\alpha + \\beta$' }],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'inline-latex 1');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('\\alpha + \\beta');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Inline LaTeX expression 1 copied to the clipboard',
    });
  });

  it('should not copy inline LaTeX from code fences or display math blocks', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '```md',
              'Ignored $x^2$',
              '```',
              '$$',
              '\\alpha + \\beta',
              '$$',
            ].join('\n'),
          },
        ],
      },
    ]);

    const result = await copyCommand.action(mockContext, 'latex inline');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'No matching inline LaTeX expression found in the last AI output.',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should report when /copy latex has no matching LaTeX block', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [{ text: 'No math block here.' }],
      },
    ]);

    const result = await copyCommand.action(mockContext, 'latex');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No matching LaTeX block found in the last AI output.',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should report when /copy code has no matching code block', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [{ text: 'No code here.' }],
      },
    ]);

    const result = await copyCommand.action(mockContext, 'code');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No matching code block found in the last AI output.',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should handle clipboard copy error', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithAiMessage = [
      {
        role: 'model',
        parts: [{ text: 'AI response' }],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithAiMessage);
    const clipboardError = new Error('Clipboard access denied');
    mockCopyToClipboard.mockRejectedValue(clipboardError);

    const result = await copyCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: `Failed to copy to the clipboard. ${clipboardError.message}`,
    });
  });

  it('should handle non-Error clipboard errors', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithAiMessage = [
      {
        role: 'model',
        parts: [{ text: 'AI response' }],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithAiMessage);
    const rejectedValue = 'String error';
    mockCopyToClipboard.mockRejectedValue(rejectedValue);

    const result = await copyCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: `Failed to copy to the clipboard. ${rejectedValue}`,
    });
  });

  it('should return info message when no text parts found in AI message', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const historyWithEmptyParts = [
      {
        role: 'model',
        parts: [{ image: 'base64data' }], // No text parts
      },
    ];

    mockGetHistoryShallow.mockReturnValue(historyWithEmptyParts);

    const result = await copyCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Last AI output contains no text to copy.',
    });

    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should copy the Nth-last AI message with /copy N', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const history = [
      { role: 'model', parts: [{ text: 'oldest AI reply' }] },
      { role: 'user', parts: [{ text: 'user 1' }] },
      { role: 'model', parts: [{ text: 'middle AI reply' }] },
      { role: 'user', parts: [{ text: 'user 2' }] },
      { role: 'model', parts: [{ text: 'newest AI reply' }] },
    ];

    mockGetHistoryShallow.mockReturnValue(history);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '2');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('middle AI reply');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'AI message 2 copied to the clipboard',
    });
  });

  it('should label the error with AI message N when /copy N has no text', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const history = [
      { role: 'model', parts: [{ image: 'base64data' }] },
      { role: 'user', parts: [{ text: 'user' }] },
      { role: 'model', parts: [{ text: 'newest reply with text' }] },
    ];

    mockGetHistoryShallow.mockReturnValue(history);

    const result = await copyCommand.action(mockContext, '2');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'AI message 2 contains no text to copy.',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should label the error with AI message N when /copy N <selector> misses', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const history = [
      { role: 'model', parts: [{ text: 'no code blocks here' }] },
      { role: 'user', parts: [{ text: 'user' }] },
      { role: 'model', parts: [{ text: 'newest reply' }] },
    ];

    mockGetHistoryShallow.mockReturnValue(history);

    const result = await copyCommand.action(mockContext, '2 code');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No matching code block found in AI message 2.',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should treat /copy 1 the same as /copy (last AI message)', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const history = [
      { role: 'model', parts: [{ text: 'earlier reply' }] },
      { role: 'model', parts: [{ text: 'latest reply' }] },
    ];

    mockGetHistoryShallow.mockReturnValue(history);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '1');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('latest reply');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Last output copied to the clipboard',
    });
  });

  it('should combine /copy N with a code sub-selector', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const history = [
      {
        role: 'model',
        parts: [
          {
            text: [
              '```python',
              'print("from older")',
              '```',
              '```js',
              'console.log("from older js")',
              '```',
            ].join('\n'),
          },
        ],
      },
      { role: 'user', parts: [{ text: 'newer prompt' }] },
      {
        role: 'model',
        parts: [{ text: 'newer reply (no code)' }],
      },
    ];

    mockGetHistoryShallow.mockReturnValue(history);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '2 code python');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('print("from older")');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'python code block 1 copied to the clipboard',
    });
  });

  it('should resolve /copy N code <lang> M to the Mth lang block in Nth-last message', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const history = [
      {
        role: 'model',
        parts: [
          {
            text: [
              '```python',
              'first_in_oldest = 1',
              '```',
              '```python',
              'second_in_oldest = 2',
              '```',
            ].join('\n'),
          },
        ],
      },
      { role: 'user', parts: [{ text: 'next' }] },
      {
        role: 'model',
        parts: [
          {
            text: ['```python', 'middle_only = 1', '```'].join('\n'),
          },
        ],
      },
      { role: 'user', parts: [{ text: 'and then' }] },
      { role: 'model', parts: [{ text: 'newest plain reply' }] },
    ];

    mockGetHistoryShallow.mockReturnValue(history);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '3 code python 2');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('second_in_oldest = 2');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'python code block 2 copied to the clipboard',
    });
  });

  it('should combine /copy N with a latex sub-selector', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const history = [
      {
        role: 'model',
        parts: [
          {
            text: ['$$', '\\alpha + \\beta', '$$'].join('\n'),
          },
        ],
      },
      { role: 'user', parts: [{ text: 'next prompt' }] },
      { role: 'model', parts: [{ text: 'plain newer reply' }] },
    ];

    mockGetHistoryShallow.mockReturnValue(history);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, '2 latex');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('\\alpha + \\beta');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'LaTeX block 1 copied to the clipboard',
    });
  });

  it('should reject /copy 0 with a friendly error', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      { role: 'model', parts: [{ text: 'reply' }] },
    ]);

    const result = await copyCommand.action(mockContext, '0');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Message index must be a positive integer (1 = last AI message).',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should report when /copy N exceeds the AI message count', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      { role: 'model', parts: [{ text: 'only reply' }] },
    ]);

    const result = await copyCommand.action(mockContext, '5');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Only 1 AI message in this session.',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should pluralize the out-of-range message when multiple AI messages exist', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      { role: 'model', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'second' }] },
      { role: 'model', parts: [{ text: 'third' }] },
    ]);

    const result = await copyCommand.action(mockContext, '99');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Only 3 AI messages in this session.',
    });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });

  it('should preserve /copy code <lang> N as a code-block index, not message index', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    mockGetHistoryShallow.mockReturnValue([
      {
        role: 'model',
        parts: [
          {
            text: [
              '```python',
              'first = 1',
              '```',
              '```python',
              'second = 2',
              '```',
            ].join('\n'),
          },
        ],
      },
    ]);
    mockCopyToClipboard.mockResolvedValue(undefined);

    const result = await copyCommand.action(mockContext, 'code python 2');

    expect(mockCopyToClipboard).toHaveBeenCalledWith('second = 2');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'python code block 2 copied to the clipboard',
    });
  });

  it('should handle unavailable config service', async () => {
    if (!copyCommand.action) throw new Error('Command has no action');

    const nullConfigContext = createMockCommandContext({
      services: { config: null },
    });

    const result = await copyCommand.action(nullConfigContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No output in history',
    });

    expect(mockCopyToClipboard).not.toHaveBeenCalled();
  });
});
