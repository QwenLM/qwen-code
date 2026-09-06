// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HotkeySetter, formatAccelerator } from './HotkeySetter';

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(onChange: (accelerator: string) => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <HotkeySetter
        accelerator="Command+E"
        disabled={false}
        captureLabel="Press shortcut"
        clearLabel="Clear"
        offLabel="Off"
        onChange={onChange}
      />,
    );
  });
  return container;
}

describe('HotkeySetter', () => {
  it('captures an ordinary Electron accelerator', async () => {
    const onChange = vi.fn(async () => {});
    const container = render(onChange);
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Press shortcut"]',
    );
    act(() => button?.click());
    const input = container.querySelector('input');

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          code: 'KeyK',
          key: 'k',
          metaKey: true,
          shiftKey: true,
        }),
      );
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith('Command+Shift+K');
  });

  it('cancels capture with Escape and clears to Off explicitly', async () => {
    const onChange = vi.fn(async () => {});
    const container = render(onChange);
    const capture = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Press shortcut"]',
    );
    act(() => capture?.click());
    act(() => {
      container.querySelector('input')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          code: 'Escape',
          key: 'Escape',
        }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();

    const clear = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Clear',
    );
    await act(async () => {
      clear?.click();
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('shows a mutation error without changing the displayed shortcut', async () => {
    const container = render(async () => {
      throw new Error('That shortcut is already in use.');
    });
    const capture = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Press shortcut"]',
    );
    act(() => capture?.click());

    await act(async () => {
      container.querySelector('input')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          code: 'KeyQ',
          key: 'q',
          metaKey: true,
        }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('That shortcut is already in use.');
    expect(container.textContent).toContain('⌘E');
  });

  it('formats Electron modifiers like Codex hotkey labels', () => {
    expect(formatAccelerator('Command+Control+Alt+Shift+E')).toBe('⌘⌃⌥⇧E');
  });
});
