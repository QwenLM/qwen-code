// @vitest-environment jsdom
/**
 * Regression tests for issue #9485: the Web Shell can be served over plain
 * HTTP from a non-loopback host, where the async Clipboard API is not
 * exposed. writeClipboardText must fall back to the legacy execCommand path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeClipboardText } from './clipboard';

describe('writeClipboardText (issue #9485)', () => {
  let clipboardDescriptor: PropertyDescriptor | undefined;
  let originalExecCommand: Document['execCommand'] | undefined;
  let copiedValue: string | null = null;

  afterEach(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      clipboardDescriptor = undefined;
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
    if (originalExecCommand !== undefined) {
      document.execCommand = originalExecCommand;
      originalExecCommand = undefined;
    }
    copiedValue = null;
    document.body.innerHTML = '';
  });

  const captureClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  };

  const captureExecCommand = () => {
    const execCommand = vi.fn().mockImplementation((command: string) => {
      // Mirror a real copy: the fallback selects a temporary textarea that
      // must hold the requested text — capture it so tests can assert the
      // value assignment itself, not just that execCommand ran.
      if (command === 'copy') {
        copiedValue = document.querySelector('textarea')?.value ?? null;
      }
      return command === 'copy' && copiedValue !== null;
    });
    originalExecCommand = document.execCommand;
    document.execCommand = execCommand;
    return execCommand;
  };

  it('prefers the async Clipboard API when available', async () => {
    const writeText = captureClipboard();
    const execCommand = captureExecCommand();

    await writeClipboardText('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('invokes writeText synchronously in the caller tick', () => {
    const writeText = captureClipboard();

    // Deliberately not awaited: click handlers and the table copy tests
    // assert on the spy in the same tick as the click, so writeText must be
    // called before any async deferral (no permission pre-query).
    void writeClipboardText('sync dispatch');

    expect(writeText).toHaveBeenCalledWith('sync dispatch');
  });

  it('falls back to execCommand when the Clipboard API is missing', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    const execCommand = captureExecCommand();

    await writeClipboardText('hello fallback');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe('hello fallback');
  });

  it('appends the fallback textarea inside a focused Radix layer', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const copyButton = document.createElement('button');
    dialog.appendChild(copyButton);
    document.body.appendChild(dialog);
    copyButton.focus();

    let textareaParent: string | null = null;
    originalExecCommand = document.execCommand;
    document.execCommand = vi.fn().mockImplementation((command: string) => {
      const textarea = document.querySelector('textarea');
      textareaParent = textarea?.parentElement?.getAttribute('role') ?? null;
      return command === 'copy' && textarea !== null;
    });

    await writeClipboardText('inside dialog');

    expect(textareaParent).toBe('dialog');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('restores focus to the previously focused element after the fallback', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    captureExecCommand();
    const composer = document.createElement('textarea');
    composer.setAttribute('data-testid', 'composer');
    document.body.appendChild(composer);
    composer.focus();

    await writeClipboardText('hello fallback');

    expect(document.activeElement).toBe(composer);
  });

  it('cleans up the temporary textarea after a fallback copy', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    captureExecCommand();

    await writeClipboardText('hello fallback');

    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    const execCommand = captureExecCommand();

    await writeClipboardText('hello fallback');

    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('rejects with an actionable error when no mechanism works', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    originalExecCommand = document.execCommand;
    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(writeClipboardText('hello')).rejects.toThrow(
      /secure context/i,
    );
  });
});
