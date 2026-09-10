// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { WorkspaceSelector } from './WorkspaceSelector';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

function renderSelector(
  overrides: Partial<React.ComponentProps<typeof WorkspaceSelector>> = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <I18nProvider language="en">
        <WorkspaceSelector
          workspaces={[
            {
              id: 'primary',
              cwd: '/primary',
              label: 'primary',
              primary: true,
              trusted: true,
            },
            {
              id: 'locked',
              cwd: '/locked',
              label: 'locked',
              primary: false,
              trusted: false,
            },
          ]}
          scratchSupported
          existingFolderSupported
          onSelectWorkspace={vi.fn()}
          onCreateScratch={vi.fn()}
          onOpenExistingFolder={vi.fn()}
          {...overrides}
        />
      </I18nProvider>,
    );
  });
  return container;
}

describe('WorkspaceSelector', () => {
  it('hides for a single workspace without creation capabilities', () => {
    const element = renderSelector({
      workspaces: [
        {
          id: 'primary',
          cwd: '/primary',
          label: 'primary',
          primary: true,
          trusted: true,
        },
      ],
      scratchSupported: false,
      existingFolderSupported: false,
    });
    expect(element.querySelector('button')).toBeNull();
  });

  it('gates creation actions and disables untrusted workspaces', async () => {
    const onCreateScratch = vi.fn();
    const element = renderSelector({ onCreateScratch });
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    expect(document.body.textContent).toContain('New workspace');
    expect(document.body.textContent).toContain('untrusted');
    const newWorkspace = document.querySelector(
      '[data-slot="dropdown-menu-sub-trigger"]',
    )!;
    await act(async () => {
      newWorkspace.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(document.body.textContent).toContain('Start from scratch');
    expect(document.body.textContent).toContain('Use an existing folder');
    const locked = [
      ...document.querySelectorAll('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('locked'));
    expect(locked?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('offers the projectless target and reports selecting it', async () => {
    const onSelectStandalone = vi.fn();
    const element = renderSelector({
      workspaces: [
        {
          id: 'primary',
          cwd: '/primary',
          label: 'primary',
          primary: true,
          trusted: true,
        },
      ],
      scratchSupported: false,
      existingFolderSupported: false,
      standaloneSupported: true,
      onSelectStandalone,
    });
    // A single workspace hides the selector unless the projectless target
    // gives it a second choice.
    const trigger = element.querySelector('button')!;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    const standaloneEntry = [
      ...document.querySelectorAll('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('No workspace'));
    expect(standaloneEntry).toBeDefined();
    await act(async () => {
      standaloneEntry?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      standaloneEntry?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(onSelectStandalone).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(trigger);
  });

  it('labels the trigger with the projectless target when selected', () => {
    const element = renderSelector({
      standaloneSupported: true,
      selectedStandalone: true,
      onSelectStandalone: vi.fn(),
    });
    expect(element.querySelector('button')?.textContent).toContain(
      'No workspace',
    );
  });

  it('keeps the trigger tooltip closed after dismissing the menu', async () => {
    const element = renderSelector();
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });
});
