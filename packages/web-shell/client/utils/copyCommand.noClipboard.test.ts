// @vitest-environment jsdom
/**
 * Regression tests for issue #9485: pages served over plain HTTP from a
 * non-loopback host are not secure contexts, so `navigator.clipboard` is
 * undefined and every copy entry point failed. The default writer must fall
 * back to the legacy `document.execCommand('copy')` path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../adapters/types';
import { copyFromLastAssistantMessage } from './copyCommand';

function assistant(content: string): Message {
  return {
    id: `assistant-${content.length}`,
    role: 'assistant',
    content,
  };
}

describe('copyFromLastAssistantMessage without the async Clipboard API (issue #9485)', () => {
  let restoreClipboard: () => void;
  let execCommandMock: ReturnType<typeof vi.fn>;
  let originalExecCommand: Document['execCommand'] | undefined;
  let copiedValue: string | null = null;

  beforeEach(() => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    restoreClipboard = () => {
      if (descriptor) {
        Object.defineProperty(navigator, 'clipboard', descriptor);
      }
    };
    originalExecCommand = document.execCommand;
    execCommandMock = vi.fn().mockImplementation((command: string) => {
      // Capture the fallback textarea's value so the test pins text
      // fidelity, not just that execCommand ran.
      if (command === 'copy') {
        copiedValue = document.querySelector('textarea')?.value ?? null;
      }
      return true;
    });
    document.execCommand = execCommandMock;
  });

  afterEach(() => {
    restoreClipboard();
    document.execCommand = originalExecCommand!;
    copiedValue = null;
  });

  it('falls back to a legacy execCommand copy for /copy', async () => {
    const result = await copyFromLastAssistantMessage(
      [assistant('hello fallback')],
      '',
    );

    expect(execCommandMock).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe('hello fallback');
    expect(result).toEqual({
      status: 'info',
      message: 'Last output copied to the clipboard',
    });
  });

  it('reports an error when no clipboard mechanism is available', async () => {
    execCommandMock.mockReturnValue(false);

    const result = await copyFromLastAssistantMessage(
      [assistant('hello fallback')],
      '',
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('Failed to copy to the clipboard.');
  });
});
