// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { AddMenu, type AddMenuProps } from './AddMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let portalRoot: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  portalRoot?.remove();
  root = null;
  container = null;
  portalRoot = null;
});

function baseProps(overrides: Partial<AddMenuProps> = {}): AddMenuProps {
  return {
    availabilityKey: 'default',
    addFileAvailable: true,
    uploadAvailable: false,
    onAddFiles: vi.fn(),
    onFilePickerCancel: vi.fn(),
    onInsertReference: vi.fn(),
    onPrependSkill: vi.fn(),
    getWorkspaceActions: () => undefined,
    skills: [],
    ...overrides,
  };
}

function render(ui?: ReactNode): AddMenuProps {
  const props = baseProps();
  container = document.createElement('div');
  portalRoot = document.createElement('div');
  portalRoot.dataset.webShellPortalRoot = '';
  document.body.appendChild(container);
  document.body.appendChild(portalRoot);
  root = createRoot(container);
  act(() =>
    root!.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <I18nProvider language="en">
          {ui ?? <AddMenu {...props} />}
        </I18nProvider>
      </WebShellPortalRootContext.Provider>,
    ),
  );
  return props;
}

function renderWith(props: AddMenuProps): void {
  container = document.createElement('div');
  portalRoot = document.createElement('div');
  portalRoot.dataset.webShellPortalRoot = '';
  document.body.appendChild(container);
  document.body.appendChild(portalRoot);
  root = createRoot(container);
  act(() =>
    root!.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <I18nProvider language="en">
          <AddMenu {...props} />
        </I18nProvider>
      </WebShellPortalRootContext.Provider>,
    ),
  );
}

function rerenderWith(props: AddMenuProps): void {
  act(() =>
    root!.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <I18nProvider language="en">
          <AddMenu {...props} />
        </I18nProvider>
      </WebShellPortalRootContext.Provider>,
    ),
  );
}

async function openMenu(): Promise<void> {
  const trigger = container!.querySelector(
    '[data-testid="composer-add-menu-trigger"]',
  ) as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    trigger.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0 }),
    );
  });
}

function menuItem(testId: string): HTMLElement | null {
  return portalRoot!.querySelector(`[data-testid="${testId}"]`);
}

async function openSubmenu(triggerTestId: string): Promise<void> {
  const subTrigger = menuItem(triggerTestId);
  expect(subTrigger).not.toBeNull();
  await act(async () => {
    subTrigger!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0 }),
    );
  });
}

async function typeIntoSearch(testId: string, value: string): Promise<void> {
  const input = menuItem(testId) as HTMLInputElement;
  expect(input).not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Let the search debounce and the provider promise settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

// Wait for an immediate (zero-debounce) provider search to settle.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('AddMenu', () => {
  it('renders a "+" trigger with an add-to-message label', () => {
    render();
    const trigger = container!.querySelector(
      '[data-testid="composer-add-menu-trigger"]',
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('aria-label')).toBe('Add to message');
    expect(trigger!.hasAttribute('data-tooltip')).toBe(false);
  });

  it('is disabled when the composer is disabled', () => {
    renderWith(baseProps({ disabled: true }));
    const trigger = container!.querySelector(
      '[data-testid="composer-add-menu-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it('lets an outside editor click close the menu without restoring trigger focus', async () => {
    render(
      <>
        <textarea data-editor />
        <AddMenu {...baseProps()} />
      </>,
    );
    await openMenu();
    const editor = container!.querySelector<HTMLElement>('[data-editor]')!;
    const trigger = container!.querySelector<HTMLElement>(
      '[data-testid="composer-add-menu-trigger"]',
    )!;
    await act(async () => {
      editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      editor.focus();
      editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(editor);
  });

  it('opens to an empty-state row when no inner capability is available', async () => {
    renderWith(
      baseProps({
        addFileAvailable: false,
        getWorkspaceActions: () => undefined,
        skills: [],
      }),
    );
    await openMenu();
    const empty = menuItem('composer-add-menu-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe('No add actions are available here');
  });

  it('lists all five items when capabilities are available', async () => {
    renderWith(
      baseProps({
        getWorkspaceActions: () => ({
          globWorkspace: async () => ({ matches: [] }),
          loadExtensionsStatus: async () => ({ extensions: [] }),
          loadMcpStatus: async () => ({ servers: [] }),
        }),
        skills: [{ name: 'review', description: '' }],
      }),
    );
    await openMenu();
    expect(menuItem('composer-add-menu-file')).not.toBeNull();
    expect(menuItem('composer-add-menu-reference-file')).not.toBeNull();
    expect(menuItem('composer-add-menu-extensions')).not.toBeNull();
    expect(menuItem('composer-add-menu-mcp')).not.toBeNull();
    expect(menuItem('composer-add-menu-skills')).not.toBeNull();
    expect(menuItem('composer-add-menu-empty')).toBeNull();
  });

  it('picks files through the hidden input and reports them', async () => {
    const props = baseProps();
    renderWith(props);
    await openMenu();
    await openSubmenu('composer-add-menu-file');
    const item = menuItem('composer-add-menu-file-attach') as HTMLElement;
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const input = container!.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(props.onAddFiles).toHaveBeenCalledWith([file], 'attach');
  });

  it('routes the upload submenu choice separately', async () => {
    const props = baseProps({ uploadAvailable: true });
    renderWith(props);
    await openMenu();
    await openSubmenu('composer-add-menu-file');
    const item = menuItem('composer-add-menu-file-upload') as HTMLElement;
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const input = container!.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(props.onAddFiles).toHaveBeenCalledWith([file], 'upload');
  });

  it('drops a pending attachment when its capability becomes unavailable', async () => {
    const props = baseProps();
    renderWith(props);
    await openMenu();
    await openSubmenu('composer-add-menu-file');
    await act(async () => {
      menuItem('composer-add-menu-file-attach')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }),
      );
    });
    const input =
      container!.querySelector<HTMLInputElement>('input[type="file"]')!;

    rerenderWith({ ...props, addFileAvailable: false });
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(props.onAddFiles).not.toHaveBeenCalled();
  });

  it('replaces a pending picker and keeps cancel handling after availability changes', async () => {
    const props = baseProps({ availabilityKey: 'available' });
    renderWith(props);
    await openMenu();
    await openSubmenu('composer-add-menu-file');
    await act(async () => {
      menuItem('composer-add-menu-file-attach')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }),
      );
    });
    const staleInput =
      container!.querySelector<HTMLInputElement>('input[type="file"]')!;

    rerenderWith({ ...props, availabilityKey: 'unavailable' });
    expect(staleInput.isConnected).toBe(false);
    expect(props.onFilePickerCancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    await openMenu();
    await openSubmenu('composer-add-menu-file');
    await act(async () => {
      menuItem('composer-add-menu-file-attach')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }),
      );
    });
    const currentInput =
      container!.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      currentInput.dispatchEvent(new Event('cancel'));
    });
    expect(props.onFilePickerCancel).toHaveBeenCalledTimes(2);
  });

  describe('reference-file submenu', () => {
    function renderWithGlob(matches: string[]) {
      const globWorkspace = vi.fn(async () => ({ matches }));
      renderWith(
        baseProps({
          getWorkspaceActions: () => ({ globWorkspace }),
        }),
      );
      return globWorkspace;
    }

    it('keeps the search input mounted while loading the root listing', async () => {
      const focusEditor = vi.fn(() => {
        container!.querySelector<HTMLElement>('[data-editor]')?.focus();
      });
      const props = baseProps({
        getWorkspaceActions: () => ({
          globWorkspace: async () => ({ matches: [] }),
        }),
      });
      render(
        <div onClick={focusEditor}>
          <textarea data-editor />
          <AddMenu {...props} />
        </div>,
      );
      await openMenu();
      expect(focusEditor).not.toHaveBeenCalled();
      await openSubmenu('composer-add-menu-reference-file');
      const search = menuItem(
        'composer-add-menu-reference-file-search',
      ) as HTMLInputElement;
      expect(search.getAttribute('aria-label')).toBe('Search workspace files');
      expect(document.activeElement).toBe(search);
      focusEditor.mockClear();
      await act(async () => {
        search.focus();
        search.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(focusEditor).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(search);
      expect(search.isConnected).toBe(true);
      await settle();
    });

    it('does not focus the search input when the submenu opens on hover', async () => {
      renderWithGlob([]);
      await openMenu();
      const trigger = menuItem('composer-add-menu-reference-file')!;
      const pointerMove = new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      });
      Object.defineProperty(pointerMove, 'pointerType', { value: 'mouse' });
      await act(async () => {
        trigger.dispatchEvent(pointerMove);
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      const search = menuItem(
        'composer-add-menu-reference-file-search',
      ) as HTMLInputElement;
      expect(search).not.toBeNull();
      expect(document.activeElement).not.toBe(search);
    });

    it('shows the root listing and browses into folders without closing', async () => {
      const listDirectory = vi.fn(async (path: string) => ({
        kind: 'list' as const,
        path,
        entries:
          path === '.'
            ? [
                {
                  name: 'src',
                  kind: 'directory' as const,
                  ignored: false,
                },
              ]
            : [
                {
                  name: 'index.ts',
                  kind: 'file' as const,
                  ignored: false,
                },
              ],
        truncated: false,
      }));
      renderWith(
        baseProps({
          getWorkspaceActions: () => ({
            listDirectory,
            globWorkspace: async () => ({ matches: [] }),
          }),
        }),
      );
      await openMenu();
      await openSubmenu('composer-add-menu-reference-file');
      await settle();
      const folder = Array.from(
        portalRoot!.querySelectorAll<HTMLElement>(
          '[data-testid="composer-add-menu-reference-file-item"]',
        ),
      ).find((item) => item.textContent?.includes('src/'))!;
      expect(folder.textContent).toBe('src/');
      await act(async () => {
        folder.dispatchEvent(
          new MouseEvent('click', { bubbles: true, button: 0 }),
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      expect(
        menuItem('composer-add-menu-reference-file-search'),
      ).not.toBeNull();
      expect(
        Array.from(
          portalRoot!.querySelectorAll<HTMLElement>(
            '[data-testid="composer-add-menu-reference-file-item"]',
          ),
        ).some((item) => item.textContent?.includes('index.ts')),
      ).toBe(true);
      expect(listDirectory).toHaveBeenLastCalledWith(
        'src',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('searches the workspace and inserts a file reference on select', async () => {
      const globWorkspace = vi.fn(async () => ({ matches: ['src/foo.ts'] }));
      const props = baseProps({
        getWorkspaceActions: () => ({ globWorkspace }),
        onInsertReference: vi.fn(() => {
          container!.querySelector<HTMLElement>('[data-editor]')!.focus();
        }),
      });
      render(
        <>
          <textarea data-editor />
          <AddMenu {...props} />
        </>,
      );
      await openMenu();
      await openSubmenu('composer-add-menu-reference-file');
      await typeIntoSearch('composer-add-menu-reference-file-search', 'foo');
      expect(globWorkspace).toHaveBeenCalledWith(
        '**/*[fF][oO][oO]*',
        expect.objectContaining({ maxResults: 50 }),
      );
      const item = menuItem('composer-add-menu-reference-file-item');
      expect(item).not.toBeNull();
      expect(item!.textContent).toContain('src/foo.ts');
      await act(async () => {
        item!.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
        item!.dispatchEvent(
          new MouseEvent('click', { bubbles: true, button: 0 }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(props.onInsertReference).toHaveBeenCalledTimes(1);
      const tag = props.onInsertReference.mock.calls[0][0];
      expect(tag.serialized).toBe('@src/foo.ts');
      expect(tag.kind).toBe('file');
      expect(document.activeElement).toBe(
        container!.querySelector('[data-editor]'),
      );
    });

    it('shows a no-results row when nothing matches', async () => {
      renderWithGlob([]);
      await openMenu();
      await openSubmenu('composer-add-menu-reference-file');
      await typeIntoSearch('composer-add-menu-reference-file-search', 'zzz');
      expect(menuItem('composer-add-menu-reference-file-none')).not.toBeNull();
      expect(menuItem('composer-add-menu-reference-file-item')).toBeNull();
    });

    it('shows a load error instead of an empty result', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderWith(
        baseProps({
          getWorkspaceActions: () => ({
            globWorkspace: vi.fn().mockRejectedValue(new Error('boom')),
          }),
        }),
      );
      await openMenu();
      await openSubmenu('composer-add-menu-reference-file');
      await typeIntoSearch('composer-add-menu-reference-file-search', 'foo');
      expect(portalRoot!.textContent).toContain('Failed to load results');
      expect(menuItem('composer-add-menu-reference-file-none')).toBeNull();
      warn.mockRestore();
    });
  });

  describe('extensions submenu', () => {
    it('lists enabled extensions immediately and inserts @ext: on select', async () => {
      const props = baseProps({
        getWorkspaceActions: () => ({
          loadExtensionsStatus: vi.fn(async () => ({
            extensions: [
              {
                name: 'my-ext',
                displayName: 'My Extension',
                description: 'Reviews code',
                isActive: true,
              },
              { name: 'off-ext', isActive: false },
            ],
          })),
        }),
      });
      renderWith(props);
      await openMenu();
      await openSubmenu('composer-add-menu-extensions');
      await settle();
      expect(menuItem('composer-add-menu-extensions-search')).toBeNull();
      const items = portalRoot!.querySelectorAll(
        '[data-testid="composer-add-menu-extensions-item"]',
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.textContent).toContain('my-ext');
      expect(items[0]!.textContent).toContain('My Extension - Reviews code');
      await act(async () => {
        items[0]!.dispatchEvent(
          new MouseEvent('click', { bubbles: true, button: 0 }),
        );
      });
      await settle();
      expect(props.onInsertReference).toHaveBeenCalledTimes(1);
      const tag = props.onInsertReference.mock.calls[0][0];
      expect(tag.serialized).toBe('@ext:my-ext');
      expect(tag.kind).toBe('extension');
    });

    it('shows the empty message when no extension is enabled', async () => {
      renderWith(
        baseProps({
          getWorkspaceActions: () => ({
            loadExtensionsStatus: vi.fn(async () => ({ extensions: [] })),
          }),
        }),
      );
      await openMenu();
      await openSubmenu('composer-add-menu-extensions');
      await settle();
      const empty = menuItem('composer-add-menu-extensions-none');
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toBe('No extensions are enabled');
    });

    it('lists every enabled extension without a filter', async () => {
      renderWith(
        baseProps({
          getWorkspaceActions: () => ({
            loadExtensionsStatus: vi.fn().mockResolvedValue({
              extensions: Array.from({ length: 51 }, (_, index) => ({
                name: `extension-${index}`,
                isActive: true,
              })),
            }),
          }),
        }),
      );
      await openMenu();
      await openSubmenu('composer-add-menu-extensions');
      await settle();

      expect(
        portalRoot!.querySelectorAll(
          '[data-testid="composer-add-menu-extensions-item"]',
        ),
      ).toHaveLength(51);
    });
  });

  describe('MCP submenu', () => {
    it('inserts a server-level reference even for servers with resources', async () => {
      const props = baseProps({
        getWorkspaceActions: () => ({
          loadMcpStatus: vi.fn(async () => ({
            servers: [
              {
                kind: 'mcp_server',
                name: 'with-resources',
                disabled: false,
                resourceCount: 3,
              },
              {
                kind: 'mcp_server',
                name: 'plain',
                disabled: false,
                resourceCount: 0,
              },
            ],
          })),
        }),
      });
      renderWith(props);
      await openMenu();
      await openSubmenu('composer-add-menu-mcp');
      await settle();
      expect(menuItem('composer-add-menu-mcp-search')).toBeNull();
      const items = portalRoot!.querySelectorAll(
        '[data-testid="composer-add-menu-mcp-item"]',
      );
      expect(items).toHaveLength(2);
      await act(async () => {
        items[0]!.dispatchEvent(
          new MouseEvent('click', { bubbles: true, button: 0 }),
        );
      });
      await settle();
      expect(props.onInsertReference).toHaveBeenCalledTimes(1);
      const firstTag = props.onInsertReference.mock.calls[0][0];
      expect(firstTag.serialized).toBe('@mcp:plain');
      expect(firstTag.kind).toBe('mcp');
      await settle();
      await openMenu();
      await openSubmenu('composer-add-menu-mcp');
      await settle();
      const secondItem = Array.from(
        portalRoot!.querySelectorAll(
          '[data-testid="composer-add-menu-mcp-item"]',
        ),
      ).find((node) => node.textContent?.includes('with-resources'));
      expect(secondItem).toBeDefined();
      await act(async () => {
        secondItem!.dispatchEvent(
          new MouseEvent('click', { bubbles: true, button: 0 }),
        );
      });
      await settle();
      expect(props.onInsertReference).toHaveBeenCalledTimes(2);
      const secondTag = props.onInsertReference.mock.calls[1][0];
      expect(secondTag.serialized).toBe('@mcp:with-resources');
      expect(secondTag.kind).toBe('mcp');
    });

    it('lists every MCP server without a filter', async () => {
      renderWith(
        baseProps({
          getWorkspaceActions: () => ({
            loadMcpStatus: vi.fn().mockResolvedValue({
              servers: Array.from({ length: 51 }, (_, index) => ({
                kind: 'mcp_server' as const,
                name: `server-${index}`,
                disabled: false,
                resourceCount: 0,
              })),
            }),
          }),
        }),
      );
      await openMenu();
      await openSubmenu('composer-add-menu-mcp');
      await settle();

      expect(
        portalRoot!.querySelectorAll(
          '[data-testid="composer-add-menu-mcp-item"]',
        ),
      ).toHaveLength(51);
    });
  });

  describe('skills submenu', () => {
    it('lists skills and prepends the invocation on select', async () => {
      const props = baseProps({
        skills: [
          { name: 'review', description: 'Review code' },
          { name: 'brainstorm', description: '' },
        ],
        onPrependSkill: vi.fn(() => {
          container!.querySelector<HTMLElement>('[data-editor]')!.focus();
        }),
      });
      render(
        <>
          <textarea data-editor />
          <AddMenu {...props} />
        </>,
      );
      await openMenu();
      await openSubmenu('composer-add-menu-skills');
      const items = portalRoot!.querySelectorAll(
        '[data-testid="composer-add-menu-skills-item"]',
      );
      expect(items).toHaveLength(2);
      expect(items[0]!.textContent).toContain('/review');
      expect(items[0]!.querySelector('.sm\\:block')).not.toBeNull();
      await act(async () => {
        items[0]!.dispatchEvent(
          new MouseEvent('click', { bubbles: true, button: 0 }),
        );
      });
      await settle();
      expect(props.onPrependSkill).toHaveBeenCalledWith('/review');
      expect(document.activeElement).toBe(
        container!.querySelector('[data-editor]'),
      );
    });

    it('disables the skills entry when there are no skills', async () => {
      renderWith(baseProps({ skills: [] }));
      await openMenu();
      const subTrigger = menuItem('composer-add-menu-skills');
      expect(subTrigger).not.toBeNull();
      expect(subTrigger!.getAttribute('data-disabled')).toBe('');
    });
  });
});
