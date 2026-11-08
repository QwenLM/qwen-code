// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SessionRenameDialog } from './SessionRenameDialog';

describe('SessionRenameDialog', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(value: string, busy = false, error?: string) {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <SessionRenameDialog
            value={value}
            busy={busy}
            error={error}
            onChange={vi.fn()}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        </I18nProvider>,
      );
    });
    return { onSubmit, onClose };
  }

  function input() {
    return document.querySelector<HTMLInputElement>(
      'input[aria-label="Rename"]',
    )!;
  }

  async function submit() {
    await act(async () => {
      input().form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
  }

  it('focuses the forwarded input and submits a trimmed name through the form', async () => {
    const { onSubmit } = await render('  New name  ');
    expect(document.activeElement).toBe(input());
    expect(input().maxLength).toBe(256);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith('New name');
  });

  it.each(['   ', 'x'.repeat(257)])(
    'does not submit an invalid name',
    async (value) => {
      const { onSubmit } = await render(value);
      await submit();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(
        document.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled,
      ).toBe(true);
    },
  );

  it('keeps failure text visible and prevents resubmission while busy', async () => {
    const { onSubmit } = await render('Name', true, 'Outcome unknown');
    await submit();
    expect(input().disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Outcome unknown',
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cancels with Escape without submitting', async () => {
    const { onSubmit, onClose } = await render('Unsubmitted');
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cancels with the Cancel button without submitting', async () => {
    const { onSubmit, onClose } = await render('Unsubmitted');
    await act(async () => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'cancel')!
        .click();
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'does not submit an IME confirmation Enter (%j)',
    async (composition) => {
      const { onSubmit } = await render('输入中');
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        ...composition,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        input().dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );
});
