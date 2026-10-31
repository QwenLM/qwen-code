// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ChatContextHeader } from './ChatContextHeader';

// The QR entry reads the workspace connection from context.
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useWorkspace: () => ({
      baseUrl: 'http://127.0.0.1:8080/',
      token: 'test-token',
    }),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

function mount(
  props: Partial<Parameters<typeof ChatContextHeader>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ChatContextHeader
          content="Session title"
          environmentOpen={false}
          environmentAvailable
          rightPanelOpen={false}
          rightPanelAvailable={false}
          onToggleEnvironment={vi.fn()}
          onToggleRightPanel={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
}

describe('ChatContextHeader', () => {
  it('renders custom content inside the persistent action shell', () => {
    const view = mount({ content: <span>Custom header</span> });

    expect(view.textContent).toContain('Custom header');
    expect(view.querySelectorAll('button')).toHaveLength(1);
  });

  it('renders the location slot only when provided', () => {
    const withLocation = mount({
      location: <span data-testid="fake-location">Remote · host</span>,
    });
    expect(
      withLocation.querySelector('[data-testid="fake-location"]')?.textContent,
    ).toBe('Remote · host');

    const withoutLocation = mount();
    expect(
      withoutLocation.querySelector('[data-testid="fake-location"]'),
    ).toBeNull();
  });

  it('hides the right-panel action until content exists', () => {
    const view = mount();

    expect(
      view.querySelector('button[aria-label="Toggle right panel"]'),
    ).toBeNull();
  });

  it('hides the environment action until content exists', () => {
    const view = mount({ environmentAvailable: false });

    expect(
      view.querySelector('button[aria-label="Toggle environment information"]'),
    ).toBeNull();
  });

  it('lights the environment activity dot only while work is in progress', () => {
    const idle = mount();
    expect(
      idle.querySelector('[data-testid="chat-header-environment-activity"]'),
    ).toBeNull();

    const running = mount({ environmentRunning: true });
    const dot = running
      .querySelector('button[aria-label="Toggle environment information"]')
      ?.querySelector('[data-testid="chat-header-environment-activity"]');
    expect(dot).not.toBeNull();
    expect(
      running.querySelectorAll(
        '[data-testid="chat-header-environment-activity"]',
      ),
    ).toHaveLength(1);
    // Decorative: the button keeps its own stable accessible name.
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('toggles each available panel independently', () => {
    const onToggleEnvironment = vi.fn();
    const onToggleRightPanel = vi.fn();
    const view = mount({
      rightPanelAvailable: true,
      onToggleEnvironment,
      onToggleRightPanel,
    });

    act(() => {
      view
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
      view
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });

    expect(onToggleEnvironment).toHaveBeenCalledOnce();
    expect(onToggleRightPanel).toHaveBeenCalledOnce();
  });

  it('keeps the right-panel action to the right of the environment action', () => {
    const view = mount({ rightPanelAvailable: true });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Toggle environment information',
      'Toggle right panel',
    ]);
  });

  it('opens the token usage panel from the trailing header action', () => {
    const onOpenTokenUsage = vi.fn();
    const view = mount({ rightPanelAvailable: true, onOpenTokenUsage });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Toggle environment information',
      'Session token usage',
      'Toggle right panel',
    ]);
    act(() => actions[1]!.click());
    expect(onOpenTokenUsage).toHaveBeenCalledOnce();
  });

  it('hides the token usage action when no session is available', () => {
    const view = mount();
    expect(
      view.querySelector('button[aria-label="Session token usage"]'),
    ).toBeNull();
  });

  it('opens context usage independently of token usage', () => {
    const onOpenContextUsage = vi.fn();
    const onOpenTokenUsage = vi.fn();
    const view = mount({ onOpenContextUsage, onOpenTokenUsage });
    act(() => {
      view
        .querySelector<HTMLButtonElement>('[aria-label="Context Usage"]')!
        .click();
    });
    expect(onOpenContextUsage).toHaveBeenCalledOnce();
    expect(onOpenTokenUsage).not.toHaveBeenCalled();
  });

  it('hides context usage when its callback is omitted', () => {
    const view = mount({ onOpenTokenUsage: vi.fn() });
    expect(view.querySelector('[aria-label="Context Usage"]')).toBeNull();
  });

  it('shows the Local Control QR entry ahead of the other actions', () => {
    const view = mount({
      rightPanelAvailable: true,
      onOpenLocalControlSettings: vi.fn(),
    });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Mobile access',
      'Toggle environment information',
      'Toggle right panel',
    ]);
  });

  it.each([
    [
      { workspaceName: 'api', workspacePath: '/work/api' },
      'Workspace: api',
      'api/work/api',
    ],
    [{ workspaceName: 'api' }, 'Workspace: api', 'api'],
    [{}, 'No workspace', 'No workspace'],
  ])('reveals the workspace details on hover: %j', (props, label, text) => {
    vi.useFakeTimers();
    const view = mount(props);
    const icon = view.querySelector<HTMLElement>(
      '[data-testid="chat-header-workspace"]',
    )!;
    expect(icon.getAttribute('aria-label')).toBe(label);
    expect(icon.querySelector('.lucide-folder-closed')).not.toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      icon.dispatchEvent(new Event('pointermove', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(text);
  });

  it('opens workspace files from a button while retaining the tooltip', () => {
    vi.useFakeTimers();
    const onOpenFiles = vi.fn();
    const view = mount({
      workspaceName: 'api',
      workspacePath: '/work/api',
      onOpenFiles,
    });
    const button = view.querySelector<HTMLButtonElement>(
      'button[data-testid="chat-header-workspace"]',
    )!;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe(
      'Browse workspace files: Workspace: api',
    );
    act(() => {
      button.dispatchEvent(new Event('pointermove', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'api/work/api',
    );
    act(() => button.click());
    expect(onOpenFiles).toHaveBeenCalledOnce();
  });

  it('keeps the workspace icon informational when files are unavailable', () => {
    const view = mount({ workspaceName: 'api', workspacePath: '/work/api' });

    expect(view.querySelectorAll('button')).toHaveLength(1);
    expect(
      view.querySelector('[data-testid="chat-header-workspace"]')?.tagName,
    ).toBe('SPAN');
  });
});

describe('ChatContextHeader session title single-click rename', () => {
  afterEach(() => {
    // The jsdom document outlives the test: drop any text selection so a
    // selection-guard case cannot leak into the next one.
    window.getSelection()?.removeAllRanges();
  });

  function headerProps(
    rename: (displayName: string) => Promise<unknown>,
    overrides: Partial<Parameters<typeof ChatContextHeader>[0]> = {},
    sessionId = 'sess-1',
  ): Partial<Parameters<typeof ChatContextHeader>[0]> {
    return {
      content: 'Session title',
      titleRename: { sessionId, rename },
      ...overrides,
    };
  }

  function rerender(
    props: Partial<Parameters<typeof ChatContextHeader>[0]>,
  ): void {
    act(() => {
      root!.render(
        <I18nProvider language="en">
          <ChatContextHeader
            content="Session title"
            environmentOpen={false}
            environmentAvailable
            rightPanelOpen={false}
            rightPanelAvailable={false}
            onToggleEnvironment={vi.fn()}
            onToggleRightPanel={vi.fn()}
            {...props}
          />
        </I18nProvider>,
      );
    });
  }

  function findTitle(): HTMLElement {
    const title = container!.querySelector<HTMLElement>(
      '[data-web-shell-pane-title]',
    );
    expect(title).not.toBeNull();
    return title as HTMLElement;
  }

  function findRenameInput(): HTMLInputElement | null {
    return container!.querySelector<HTMLInputElement>(
      '[data-web-shell-pane-title-input]',
    );
  }

  async function openRename(): Promise<void> {
    await act(async () => {
      findTitle().dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    });
  }

  function setRenameValue(value: string): void {
    const input = findRenameInput() as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function pressKey(
    target: HTMLElement,
    init: KeyboardEventInit,
  ): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      target.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return event;
  }

  function pressRenameKey(
    key: string,
    init: KeyboardEventInit = {},
  ): Promise<KeyboardEvent> {
    return pressKey(findRenameInput() as HTMLInputElement, { key, ...init });
  }

  function selectTitleText(): void {
    const range = document.createRange();
    range.selectNodeContents(findTitle());
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }

  it('opens the inline rename input on a single title click, prefilled and focused', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    await openRename();
    const input = findRenameInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe('Session title');
    expect(input?.maxLength).toBe(256);
    expect(input?.getAttribute('aria-label')).toBe('Rename: Session title');
    expect(document.activeElement).toBe(input);
    expect(rename).not.toHaveBeenCalled();
  });

  it('saves the trimmed name on Enter and hands focus back to the title', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    await openRename();
    setRenameValue('  Header renamed  ');
    await pressRenameKey('Enter');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('Header renamed');
    expect(findRenameInput()).toBeNull();
    expect(document.activeElement).toBe(findTitle());
  });

  it('bails on Enter without editing: no write, form closes', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    await openRename();
    await pressRenameKey('Enter');
    expect(rename).not.toHaveBeenCalled();
    expect(findRenameInput()).toBeNull();
  });

  it('does not write the stale prefill when the title moves under an open editor', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename, { content: 'New session' }));
    await openRename();
    expect(findRenameInput()?.value).toBe('New session');
    // The real name arrives while the editor is open; Enter only dismisses.
    rerender(headerProps(rename, { content: 'Real title' }));
    await pressRenameKey('Enter');
    expect(rename).not.toHaveBeenCalled();
    expect(findRenameInput()).toBeNull();
  });

  it('cancels on Escape without saving and hands focus back to the title', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    await openRename();
    setRenameValue('Whatever');
    await pressRenameKey('Escape');
    expect(findRenameInput()).toBeNull();
    expect(rename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(findTitle());
  });

  it('cancels on blur without saving', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    await openRename();
    setRenameValue('Whatever');
    await act(async () => {
      (findRenameInput() as HTMLInputElement).blur();
    });
    expect(findRenameInput()).toBeNull();
    expect(rename).not.toHaveBeenCalled();
  });

  it('closes without saving when the name is empty', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    await openRename();
    setRenameValue('   ');
    await pressRenameKey('Enter');
    expect(findRenameInput()).toBeNull();
    expect(rename).not.toHaveBeenCalled();
  });

  it('ignores the Enter that commits an IME composition', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    await openRename();
    setRenameValue('huiyijilu');
    await pressRenameKey('Enter', { keyCode: 229 });
    await pressRenameKey('Enter', { isComposing: true });
    expect(rename).not.toHaveBeenCalled();
    expect(findRenameInput()?.value).toBe('huiyijilu');
  });

  it('does not open the rename on a click that follows a text selection', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    selectTitleText();
    await openRename();
    expect(findRenameInput()).toBeNull();
  });

  it('opens from the keyboard with Enter or Space on the focused title, even with a live selection', async () => {
    const rename = vi.fn(async () => {});
    mount(headerProps(rename));
    selectTitleText();
    const enter = await pressKey(findTitle(), { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(true);
    expect(findRenameInput()?.value).toBe('Session title');
    await pressRenameKey('Escape');
    const space = await pressKey(findTitle(), { key: ' ' });
    expect(space.defaultPrevented).toBe(true);
    expect(findRenameInput()).not.toBeNull();
  });

  it('closes the editor after a failed save and lets the user retry', async () => {
    const rename = vi.fn(async () => {
      throw new Error('refused');
    });
    mount(headerProps(rename));
    await openRename();
    setRenameValue('New name');
    await pressRenameKey('Enter');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(findRenameInput()).toBeNull();
    await openRename();
    expect(findRenameInput()).not.toBeNull();
  });

  it('ignores a second Enter while the write is in flight', async () => {
    let settle!: () => void;
    const rename = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    mount(headerProps(rename));
    await openRename();
    setRenameValue('First');
    await pressRenameKey('Enter');
    const input = findRenameInput();
    expect(input).not.toBeNull();
    expect(input?.readOnly).toBe(true);
    await pressRenameKey('Enter');
    expect(findRenameInput()).not.toBeNull();
    expect(rename).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(findRenameInput()).toBeNull();
  });

  it('keeps the title inert after a blur until the in-flight write settles', async () => {
    let settle!: () => void;
    const rename = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    mount(headerProps(rename));
    await openRename();
    setRenameValue('First');
    await pressRenameKey('Enter');
    await act(async () => {
      (findRenameInput() as HTMLInputElement).blur();
    });
    expect(findRenameInput()).toBeNull();
    await openRename();
    expect(findRenameInput()).toBeNull();
    await act(async () => {
      settle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await openRename();
    expect(findRenameInput()).not.toBeNull();
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('drops the draft on a session swap and keeps a late settle out of the next editor', async () => {
    let settleA!: () => void;
    const renameA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleA = resolve;
        }),
    );
    const renameB = vi.fn(async () => {});
    mount(headerProps(renameA, { content: 'Title A' }, 'sess-A'));
    await openRename();
    setRenameValue('Renamed A');
    await pressRenameKey('Enter');
    expect(renameA).toHaveBeenCalledWith('Renamed A');
    rerender(headerProps(renameB, { content: 'Title B' }, 'sess-B'));
    expect(findRenameInput()).toBeNull();
    await openRename();
    expect(findRenameInput()?.value).toBe('Title B');
    setRenameValue('Draft for B');
    await act(async () => {
      settleA();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(findRenameInput()?.value).toBe('Draft for B');
    expect(renameB).not.toHaveBeenCalled();
  });

  it('does not write a stale draft to the session swapped in under the editor', async () => {
    const renameA = vi.fn(async () => {});
    const renameB = vi.fn(async () => {});
    mount(headerProps(renameA, { content: 'Title A' }, 'sess-A'));
    await openRename();
    setRenameValue('Stale draft');
    rerender(headerProps(renameB, { content: 'Title B' }, 'sess-B'));
    expect(findRenameInput()).toBeNull();
    expect(renameA).not.toHaveBeenCalled();
    expect(renameB).not.toHaveBeenCalled();
  });

  it('leaves the title inert without a titleRename target', async () => {
    mount({ content: 'Session title' });
    expect(container!.querySelector('[data-web-shell-pane-title]')).toBeNull();
    const title = Array.from(container!.querySelectorAll('*')).find(
      (element) =>
        element.textContent === 'Session title' &&
        element.children.length === 0,
    );
    expect(title).toBeDefined();
    await act(async () => {
      (title as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    });
    expect(findRenameInput()).toBeNull();
  });

  it('leaves non-string content inert even with a titleRename target', async () => {
    const rename = vi.fn(async () => {});
    const view = mount(
      headerProps(rename, {
        content: <span data-testid="custom-title">Custom header</span>,
      }),
    );
    expect(view.querySelector('[data-web-shell-pane-title]')).toBeNull();
    await act(async () => {
      view
        .querySelector<HTMLElement>('[data-testid="custom-title"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(findRenameInput()).toBeNull();
    expect(rename).not.toHaveBeenCalled();
  });
});
