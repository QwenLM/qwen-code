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

  it('allows explicit selection of a sole Managed Workspace without a primary fallback', async () => {
    const onSelectWorkspace = vi.fn();
    const element = renderSelector({
      workspaces: [
        { id: 'ws-a', cwd: 'ws-a', label: 'A', primary: false, trusted: true },
      ],
      scratchSupported: false,
      existingFolderSupported: false,
      alwaysVisible: true,
      onSelectWorkspace,
    });
    await act(async () => {
      element
        .querySelector('button')!
        .dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
    });
    const option = document.querySelector<HTMLElement>(
      '[role="menuitemradio"]',
    )!;
    expect(option.textContent).toContain('A');
    await act(async () => option.click());
    expect(onSelectWorkspace).toHaveBeenCalledExactlyOnceWith('ws-a');
  });

  it('selects an opaque Workspace ID matching the disabled standalone sentinel', async () => {
    const onSelectWorkspace = vi.fn();
    const element = renderSelector({
      workspaces: [
        {
          id: '__standalone__',
          cwd: '__standalone__',
          label: 'Managed workspace',
          primary: false,
          trusted: true,
        },
      ],
      scratchSupported: false,
      existingFolderSupported: false,
      alwaysVisible: true,
      onSelectWorkspace,
    });
    await act(async () => {
      element
        .querySelector('button')!
        .dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
    });
    const option = document.querySelector<HTMLElement>(
      '[role="menuitemradio"]',
    )!;
    expect(option.textContent).toContain('Managed workspace');
    await act(async () => option.click());
    expect(onSelectWorkspace).toHaveBeenCalledExactlyOnceWith('__standalone__');
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

  it('groups workspaces by host and routes hosted selection', async () => {
    const onSelectWorkspace = vi.fn();
    const onSelectHostedWorkspace = vi.fn();
    const element = renderSelector({
      workspaces: [
        {
          id: 'primary',
          cwd: '/primary',
          label: 'primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'remote',
          cwd: '/srv/remote',
          label: 'remote',
          primary: false,
          trusted: true,
          hostOrigin: 'https://b.example:4170',
        },
      ],
      onSelectWorkspace,
      onSelectHostedWorkspace,
    });
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    const headers = [
      ...document.querySelectorAll('[data-slot="dropdown-menu-label"]'),
    ];
    expect(headers.map((header) => header.textContent)).toEqual([
      'Local',
      'b.example:4170',
    ]);

    const remoteEntry = [
      ...document.querySelectorAll('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('remote'));
    await act(async () => {
      remoteEntry?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      remoteEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectHostedWorkspace).toHaveBeenCalledWith(
      'https://b.example:4170',
      '/srv/remote',
    );
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('marks remote options with their host and disambiguates the tooltip', async () => {
    const element = renderSelector({
      workspaces: [
        {
          id: 'local-one',
          cwd: '/primary',
          label: 'qwen-code',
          primary: true,
          trusted: true,
        },
        {
          id: 'remote-one',
          cwd: '/srv/remote',
          label: 'qwen-code',
          primary: false,
          trusted: true,
          hostOrigin: 'https://b.example:4170',
        },
      ],
      onSelectHostedWorkspace: vi.fn(),
    });
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    const localEntry = items.find((entry) =>
      entry.textContent?.includes('qwen-code'),
    )!;
    const remoteEntry = items.find((entry) =>
      entry.textContent?.includes('b.example:4170'),
    )!;
    // A remote option shows its host next to the label…
    expect(remoteEntry.textContent).toContain('b.example:4170');
    expect(remoteEntry.getAttribute('title')).toBe(
      'https://b.example:4170 — /srv/remote',
    );
    // …while a same-page option stays unadorned, so identical basenames
    // across hosts stay tell-apart.
    expect(localEntry.getAttribute('title')).toBe('/primary');
    expect(
      items.some(
        (entry) =>
          entry !== remoteEntry &&
          entry.textContent?.includes('b.example:4170'),
      ),
    ).toBe(false);
  });

  it('keeps the same-host menu flat without host headers', async () => {
    const element = renderSelector();
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    expect(
      document.querySelector('[data-slot="dropdown-menu-label"]'),
    ).toBeNull();
    expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(2);
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

describe('WorkspaceSelector composer focus', () => {
  function renderInPanes(
    markup: string,
    overrides: Partial<React.ComponentProps<typeof WorkspaceSelector>> = {},
  ) {
    container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = markup;
    const slot = container.querySelector<HTMLElement>('#fixture-slot')!;
    root = createRoot(slot);
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
                id: 'second',
                cwd: '/second',
                label: 'second',
                primary: false,
                trusted: true,
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

  async function openAndSelect(element: HTMLElement, label: string) {
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes(label))!;
    await act(async () => {
      option.click();
    });
  }

  // While the menu is closing, the open menu's focus scope still claims
  // focus; the selection's focus handling reclaims it on its 150 ms
  // retry, so wait that window out instead of asserting synchronously.
  async function waitForFocus(target: Element | null) {
    for (let i = 0; i < 25 && document.activeElement !== target; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }

  it('moves focus to the composer editor after a workspace selection', async () => {
    const onSelectWorkspace = vi.fn();
    const element = renderInPanes(
      '<div data-pane-session-id="fixture-pane"><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
      { onSelectWorkspace },
    );
    const composer = element.querySelector<HTMLTextAreaElement>(
      '[data-web-shell-composer-editor]',
    )!;
    await openAndSelect(element, 'second');
    expect(onSelectWorkspace).toHaveBeenCalledExactlyOnceWith('/second');
    await waitForFocus(composer);
    expect(document.activeElement).toBe(composer);
  });

  it('scopes the focus to the composer of the pane that made the selection', async () => {
    const element = renderInPanes(
      '<div data-pane-session-id="pane-a"><textarea id="composer-a" data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>' +
        '<div data-pane-session-id="pane-b"><textarea id="composer-b" data-web-shell-composer-editor></textarea></div>',
    );
    await openAndSelect(element, 'second');
    await waitForFocus(element.querySelector('#composer-a'));
    expect(document.activeElement).toBe(element.querySelector('#composer-a'));
  });

  it('recovers from a pane remount via the document scope', async () => {
    const element = renderInPanes(
      '<div data-pane-session-id="pane-a"><textarea id="composer-a" data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
    );
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('second'))!;
    // The selection switches sessions: SplitView remounts the pane, so the
    // captured pane goes away before the click lands and a fresh composer
    // comes up in the replacement pane.
    await act(async () => {
      element.querySelector('[data-pane-session-id="pane-a"]')!.remove();
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div data-pane-session-id="pane-a2"><textarea id="composer-a2" data-web-shell-composer-editor></textarea></div>',
      );
      option.click();
    });
    await waitForFocus(document.querySelector('#composer-a2'));
    expect(document.activeElement).toBe(document.querySelector('#composer-a2'));
  });

  it('moves focus to the composer after a standalone selection', async () => {
    const onSelectStandalone = vi.fn();
    const element = renderInPanes(
      '<div data-pane-session-id="fixture-pane"><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
      { standaloneSupported: true, onSelectStandalone },
    );
    await openAndSelect(element, 'No workspace');
    expect(onSelectStandalone).toHaveBeenCalledOnce();
    const composer = element.querySelector('[data-web-shell-composer-editor]');
    await waitForFocus(composer);
    expect(document.activeElement).toBe(composer);
  });
});
