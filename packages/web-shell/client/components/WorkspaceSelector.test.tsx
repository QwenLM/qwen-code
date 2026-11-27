// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { TOUCH_COMPOSER_QUERY } from '../hooks/useIsTouchComposer';
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

  it('re-enables the trigger tooltip after a controlled close from the host', async () => {
    const onOpenChange = vi.fn();
    let currentOpen = false;
    const renderControlled = (open: boolean) => {
      currentOpen = open;
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
                  id: 'other',
                  cwd: '/other',
                  label: 'other',
                  primary: false,
                  trusted: true,
                },
              ]}
              scratchSupported={false}
              existingFolderSupported={false}
              open={currentOpen}
              onOpenChange={(next) => {
                onOpenChange(next);
                renderControlled(next);
              }}
              onSelectWorkspace={vi.fn()}
              onCreateScratch={vi.fn()}
              onOpenExistingFolder={vi.fn()}
            />
          </I18nProvider>,
        );
      });
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderControlled(false);

    const trigger = container.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // While the menu stays open, hovering the trigger keeps the tooltip suppressed.
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      trigger.dispatchEvent(new Event('pointermove', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    // Host switches to another menu by setting open=false without onOpenChange.
    renderControlled(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      trigger.dispatchEvent(new Event('pointermove', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it.each([
    { contentSide: undefined, expectedSide: 'top' },
    { contentSide: 'bottom' as const, expectedSide: 'bottom' },
  ])('places the menu $expectedSide', async ({ contentSide, expectedSide }) => {
    const element = renderSelector({ contentSide });
    await act(async () => {
      element
        .querySelector('button')!
        .dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
    });
    expect(
      document
        .querySelector('[data-slot="dropdown-menu-content"]')
        ?.getAttribute('data-side'),
    ).toBe(expectedSide);
  });
});

describe('WorkspaceSelector composer focus', () => {
  beforeEach(() => {
    // A case that leaks a composer into the document means its fixture
    // cleanup is broken and would shadow the scoped lookups of later
    // cases; fail the case that leaked, not the next one.
    expect(
      document.querySelectorAll('[data-web-shell-composer-editor]').length,
    ).toBe(0);
  });

  function renderInShell(
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
    const element = renderInShell(
      '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
      { onSelectWorkspace },
    );
    const composer = element.querySelector<HTMLTextAreaElement>(
      '[data-web-shell-composer-editor]',
    )!;
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('second'))!;
    await act(async () => {
      option.click();
    });
    // Radix restores focus to the trigger when the menu closes unless the
    // selection guard suppresses the restore — check it immediately,
    // before any focus step could hide the restore under a re-focus.
    expect(document.activeElement).not.toBe(trigger);
    expect(onSelectWorkspace).toHaveBeenCalledExactlyOnceWith('/second');
    await waitForFocus(composer);
    expect(document.activeElement).toBe(composer);
  });

  it('scopes the focus to the composer shell around the trigger', async () => {
    // The competing composer comes FIRST in tree order: a document-wide
    // first-match would pick it, so only the trigger's own composer shell
    // can resolve the right one.
    const element = renderInShell(
      '<div data-web-shell-composer><textarea id="composer-first" data-web-shell-composer-editor></textarea></div>' +
        '<div data-web-shell-composer><textarea id="composer-second" data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
    );
    await openAndSelect(element, 'second');
    await waitForFocus(element.querySelector('#composer-second'));
    expect(document.activeElement).toBe(
      element.querySelector('#composer-second'),
    );
  });

  it('focuses the composer when the shell is mounted in a shadow root', async () => {
    // Registered as the container so afterEach removes the host.
    const host = document.createElement('div');
    container = host;
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>';
    const slot = shadow.querySelector<HTMLElement>('#fixture-slot')!;
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
          />
        </I18nProvider>,
      );
    });
    const trigger = shadow.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('second'))!;
    await act(async () => {
      option.click();
    });
    const composer = shadow.querySelector('[data-web-shell-composer-editor]')!;
    // document.activeElement retargets to the shadow host, so poll the
    // shadow root's own active element.
    for (let i = 0; i < 25 && shadow.activeElement !== composer; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(shadow.activeElement).toBe(composer);
    // The shadow-aware landed check is what arms the blur stop: after a
    // real user blur to the background, no pending step may pull the
    // caret back. With a shadow-host-retargeted active element the check
    // would never settle and the pull-back would return.
    await act(async () => {
      composer.blur();
    });
    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }
    expect(shadow.activeElement).not.toBe(composer);
  });

  it('focuses CodeMirror content on the desktop editor', async () => {
    const element = renderInShell(
      '<div data-web-shell-composer><div data-web-shell-composer-editor><div class="cm-content" tabindex="-1"></div></div><div id="fixture-slot"></div></div>',
    );
    await openAndSelect(element, 'second');
    const content = element.querySelector('.cm-content');
    await waitForFocus(content);
    expect(document.activeElement).toBe(content);
  });

  it('stops the watch when a keyed parent remounts the shell after the selection', async () => {
    // The shape React actually produces on a session switch: the keyed
    // parent remounts the whole shell, the selector unmounts with it, and
    // its cleanup stops the watch. A step that would otherwise fire must
    // not reach the replacement composer after teardown — recovery across
    // a real remount belongs to the mount site, not to a detached watch.
    let selection = 0;
    function RemountingShell() {
      const [key, setKey] = useState(1);
      return (
        <div key={key} id={`shell-${key}`} data-web-shell-composer>
          <textarea
            id={`composer-${key}`}
            data-web-shell-composer-editor
          ></textarea>
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
              onSelectWorkspace={() => {
                selection += 1;
                setKey((current) => current + 1);
              }}
              onCreateScratch={vi.fn()}
              onOpenExistingFolder={vi.fn()}
            />
          </I18nProvider>
        </div>
      );
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<RemountingShell />);
    });
    const trigger = container.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('second'))!;
    await act(async () => {
      option.click();
    });
    expect(selection).toBe(1);
    const replacement = container.querySelector('#composer-2')!;
    // Wait through every step the old watch could still have scheduled
    // (3 x 150 ms plus margin).
    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }
    expect(document.activeElement).not.toBe(replacement);
    expect(document.activeElement).toBe(document.body);
  });

  it('does not steal focus back once the user has moved it elsewhere', async () => {
    const element = renderInShell(
      '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div><input id="other-field" /></div>',
    );
    const other = element.querySelector<HTMLInputElement>('#other-field')!;
    await openAndSelect(element, 'second');
    // Move focus into the user's own field while a focus step is still
    // pending; the pending step must not pull it back to the composer.
    await act(async () => {
      other.focus();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(document.activeElement).toBe(other);
  });

  it('keeps Radix trigger restore for a keyboard selection on a coarse pointer', async () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === TOUCH_COMPOSER_QUERY,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );
    try {
      const element = renderInShell(
        '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
      );
      const composer = element.querySelector(
        '[data-web-shell-composer-editor]',
      )!;
      const trigger = element.querySelector('button')!;
      await act(async () => {
        trigger.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
      });
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ].find((entry) => entry.textContent?.includes('second'))!;
      // Select from the keyboard: Enter on the focused item, so no
      // pointerdown reaches the content and no pointer dismissal
      // suppresses the restore. The selection must then leave focus on
      // the trigger, never on <body> or the composer.
      await act(async () => {
        option.focus();
        option.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      expect(document.activeElement).toBe(trigger);
      expect(document.activeElement).not.toBe(composer);
    } finally {
      matchMedia.mockRestore();
    }
  });

  it('cancels the pending focus watch when the menu reopens', async () => {
    const element = renderInShell(
      '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
    );
    const composer = element.querySelector('[data-web-shell-composer-editor]')!;
    await openAndSelect(element, 'second');
    // Reopen the picker inside the retry window: a pending step would
    // focus the composer BEHIND the open menu (a focus fight the trap
    // then yanks back), so pin the composer itself, not the final state.
    const trigger = element.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const pulledOut = vi.fn();
    composer.addEventListener('focusin', pulledOut);
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes('second'))!;
    await act(async () => {
      option.focus();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    composer.removeEventListener('focusin', pulledOut);
    expect(pulledOut).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(option);
    expect(document.activeElement).not.toBe(composer);
  });

  it('stops the watch when the claimed composer is blurred to the background', async () => {
    const element = renderInShell(
      '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
    );
    const composer = element.querySelector<HTMLTextAreaElement>(
      '[data-web-shell-composer-editor]',
    )!;
    await openAndSelect(element, 'second');
    // Wait for the focus to land, then drop it the way a click on an
    // unfocusable area of the transcript does: no focusin anywhere.
    await waitForFocus(composer);
    await act(async () => {
      composer.blur();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(document.activeElement).not.toBe(composer);
  });

  it('cancels the focus watch when the selector unmounts', async () => {
    renderInShell(
      '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
    );
    await openAndSelect(container!, 'second');
    const probe = vi.spyOn(document, 'querySelectorAll');
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    probe.mockClear();
    // Let the environment go away the way afterEach does; a surviving
    // retry would fall through to the document rung and probe it.
    container?.remove();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('moves focus to the composer after a standalone selection', async () => {
    const onSelectStandalone = vi.fn();
    const element = renderInShell(
      '<div data-web-shell-composer><textarea data-web-shell-composer-editor></textarea><div id="fixture-slot"></div></div>',
      { standaloneSupported: true, onSelectStandalone },
    );
    await openAndSelect(element, 'No workspace');
    expect(onSelectStandalone).toHaveBeenCalledOnce();
    const composer = element.querySelector('[data-web-shell-composer-editor]');
    await waitForFocus(composer);
    expect(document.activeElement).toBe(composer);
  });
});
