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

  it('offers and selects No workspace when standalone is supported', async () => {
    const onSelectNoWorkspace = vi.fn();
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
      noWorkspaceSupported: true,
      onSelectNoWorkspace,
    });
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    const noWorkspace = [
      ...document.querySelectorAll('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('No workspace'));
    expect(noWorkspace).toBeDefined();
    await act(async () => {
      noWorkspace?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectNoWorkspace).toHaveBeenCalledOnce();
  });

  it('shows No workspace as the selected scope', () => {
    const element = renderSelector({
      noWorkspaceSupported: true,
      noWorkspaceSelected: true,
    });
    expect(
      element.querySelector('[data-slot="select-value"]')?.textContent,
    ).toBe('No workspace');
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
});
