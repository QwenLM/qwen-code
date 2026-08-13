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
});
