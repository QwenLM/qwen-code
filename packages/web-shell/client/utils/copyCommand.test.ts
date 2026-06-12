import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../adapters/types';
import { copyFromLastAssistantMessage } from './copyCommand';

function assistant(content: string): Message {
  return {
    id: `assistant-${content.length}`,
    role: 'assistant',
    content,
  };
}

function user(content: string): Message {
  return {
    id: `user-${content.length}`,
    role: 'user',
    content,
  };
}

describe('copyFromLastAssistantMessage', () => {
  it('returns an info message when there is no assistant output', async () => {
    const writeText = vi.fn();

    const result = await copyFromLastAssistantMessage(
      [user('hello')],
      '',
      writeText,
    );

    expect(result).toEqual({
      status: 'info',
      message: 'No output in history',
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies the last assistant text by default', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    const result = await copyFromLastAssistantMessage(
      [assistant('first'), user('again'), assistant('second')],
      '',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith('second');
    expect(result).toEqual({
      status: 'info',
      message: 'Last output copied to the clipboard',
    });
  });

  it('copies the last fenced code block with /copy code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const content = [
      'Example:',
      '```js',
      'const first = true;',
      '```',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
    ].join('\n');

    const result = await copyFromLastAssistantMessage(
      [assistant(content)],
      'code',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith('flowchart TD\n  A --> B');
    expect(result).toEqual({
      status: 'info',
      message: 'Code block 2 copied to the clipboard',
    });
  });

  it('copies a numbered fenced code block with /copy code 2', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const content = [
      '```ts',
      'const first = 1;',
      '```',
      '```json',
      '{"second": true}',
      '```',
    ].join('\n');

    const result = await copyFromLastAssistantMessage(
      [assistant(content)],
      'code 2',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith('{"second": true}');
    expect(result.message).toBe('Code block 2 copied to the clipboard');
  });

  it('copies the last matching language code block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const content = [
      '```mermaid title="First"',
      'flowchart LR',
      '  A --> B',
      '```',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hello',
      '```',
    ].join('\n');

    const result = await copyFromLastAssistantMessage(
      [assistant(content)],
      'code mermaid',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith('sequenceDiagram\n  A->>B: hello');
    expect(result.message).toBe('mermaid code block 2 copied to the clipboard');
  });

  it('copies a numbered matching language block without the code token', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const content = [
      '```ts',
      'const before = true;',
      '```',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
    ].join('\n');

    const result = await copyFromLastAssistantMessage(
      [assistant(content)],
      'mermaid 1',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith('flowchart LR\n  A --> B');
    expect(result.message).toBe('mermaid code block 1 copied to the clipboard');
  });

  it('copies display LaTeX blocks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const content = [
      '$$',
      '\\alpha + \\beta',
      '$$',
      '$$',
      '\\gamma',
      '$$',
    ].join('\n');

    const result = await copyFromLastAssistantMessage(
      [assistant(content)],
      'latex 1',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith('\\alpha + \\beta');
    expect(result.message).toBe('LaTeX block 1 copied to the clipboard');
  });

  it('copies inline LaTeX expressions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const content = [
      'Formula $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$',
      'Identity $e^{i\\pi} + 1 = 0$',
    ].join('\n');

    const result = await copyFromLastAssistantMessage(
      [assistant(content)],
      'inline-latex 1',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith(
      'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
    );
    expect(result.message).toBe(
      'Inline LaTeX expression 1 copied to the clipboard',
    );
  });

  it('does not select LaTeX from fenced code blocks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const content = [
      '```md',
      '$$',
      'ignored_code_math',
      '$$',
      '```',
      '$$',
      '\\alpha + \\beta',
      '$$',
    ].join('\n');

    const result = await copyFromLastAssistantMessage(
      [assistant(content)],
      'latex 1',
      writeText,
    );

    expect(writeText).toHaveBeenCalledWith('\\alpha + \\beta');
    expect(result.message).toBe('LaTeX block 1 copied to the clipboard');
  });

  it('reports missing code blocks', async () => {
    const writeText = vi.fn();

    const result = await copyFromLastAssistantMessage(
      [assistant('No code here.')],
      'code',
      writeText,
    );

    expect(result).toEqual({
      status: 'info',
      message: 'No matching code block found in the last AI output.',
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports clipboard copy failures', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));

    const result = await copyFromLastAssistantMessage(
      [assistant('copy me')],
      '',
      writeText,
    );

    expect(result).toEqual({
      status: 'error',
      message: 'Failed to copy to the clipboard. denied',
    });
  });
});
