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

  it('mounts in the Web Shell portal and locks actions while saving', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ThemeProvider value="dark">
            <WebShellPortalRootContext.Provider value={portalRoot}>
              <GoalEditDialog
                objective="ship every surface"
                saving
                onSave={onSave}
                onClose={onClose}
              />
            </WebShellPortalRootContext.Provider>
          </ThemeProvider>
        </I18nProvider>,
      );
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const dialog = portalRoot.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Edit goal');
    expect(dialog.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'ship every surface',
    );
    expect(
      Array.from(dialog.querySelectorAll('button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
  });

  const renderDialog = (objective: string, onSave = vi.fn()) => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ThemeProvider value="dark">
            <WebShellPortalRootContext.Provider value={portalRoot}>
              <GoalEditDialog
                objective={objective}
                saving={false}
                onSave={onSave}
                onClose={vi.fn()}
              />
            </WebShellPortalRootContext.Provider>
          </ThemeProvider>
        </I18nProvider>,
      );
    });
    return portalRoot.querySelector<HTMLTextAreaElement>(
      '[role="dialog"] textarea',
    )!;
  };

  const type = (textarea: HTMLTextAreaElement, text: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('keeps a typed draft when the Goal objective changes underneath', () => {
    // The parents pass live Goal state, so a concurrent edit from another
    // client (or the refresh a failed save triggers) arrives as a new prop
    // while the user is editing — the textarea holds the only copy.
    const textarea = renderDialog('ship every surface');
    type(textarea, 'my typed edit');

    renderDialog('concurrent edit from another client');

    expect(
      portalRoot.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
        ?.value,
    ).toBe('my typed edit');
  });

  it('adopts a Goal objective change while the field is pristine', () => {
    renderDialog('ship every surface');

    renderDialog('concurrent edit from another client');

    expect(
      portalRoot.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
        ?.value,
    ).toBe('concurrent edit from another client');
  });

  it('saves the typed draft, not the refreshed objective', () => {
    const onSave = vi.fn();
    const textarea = renderDialog('ship every surface', onSave);
    type(textarea, 'my typed edit');
    renderDialog('concurrent edit from another client', onSave);

    const save = Array.from(
      portalRoot.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((button) => button.textContent === 'Save')!;
    act(() => save.click());

    expect(onSave).toHaveBeenCalledWith('my typed edit');
  });
});
