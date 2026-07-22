// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { ThemeProvider } from '../../themeContext';
import { GoalEditDialog } from './GoalEditDialog';

describe('GoalEditDialog', () => {
  let container: HTMLDivElement;
  let portalRoot: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    portalRoot = document.createElement('div');
    document.body.append(container, portalRoot);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    portalRoot.remove();
  });

  function render(saving: boolean, onClose = vi.fn()) {
    const onSave = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ThemeProvider value="dark">
            <WebShellPortalRootContext.Provider value={portalRoot}>
              <GoalEditDialog
                objective="ship every surface"
                saving={saving}
                onSave={onSave}
                onClose={onClose}
              />
            </WebShellPortalRootContext.Provider>
          </ThemeProvider>
        </I18nProvider>,
      );
    });
    return { onClose, onSave };
  }

  it('mounts an accessible dialog in the Web Shell portal root', () => {
    render(false);

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const dialog = portalRoot.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Edit goal');
    expect(dialog?.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'ship every surface',
    );
  });

  it('disables editing and refuses close/save actions while saving', () => {
    const { onClose, onSave } = render(true);
    const dialog = portalRoot.querySelector('[role="dialog"]')!;
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    const cancel = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel',
    )!;
    const save = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'Saving…',
    )!;
    const close = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="close"]',
    )!;

    expect(textarea.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    act(() => {
      close.click();
      save.click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
