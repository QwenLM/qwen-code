// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { WebShellAtProvider } from '../customization';
import {
  useAtMentionMenu,
  type AtMentionWorkspaceActions,
} from './useAtMentionMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type HookResult = ReturnType<typeof useAtMentionMenu>;

let latest: HookResult | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function makeView(doc: string): EditorView {
  return {
    state: EditorState.create({ doc, selection: { anchor: doc.length } }),
    dispatch: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorView;
}

function makeViewAt(doc: string, anchor: number): EditorView {
  return {
    state: EditorState.create({ doc, selection: { anchor } }),
    dispatch: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorView;
}

function Harness({
  actions,
  providers,
  view,
}: {
  actions?: AtMentionWorkspaceActions;
  providers?: readonly WebShellAtProvider[];
  view?: EditorView | null;
}) {
  latest = useAtMentionMenu({
    viewRef: { current: view ?? null },
    disabledRef: { current: false },
    shellModeRef: { current: false },
    workspaceActionsRef: { current: actions },
    providers,
  });
  return null;
}

function mount({
  actions,
  providers,
  view,
}: {
  actions?: AtMentionWorkspaceActions;
  providers?: readonly WebShellAtProvider[];
  view?: EditorView | null;
} = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <Harness actions={actions} providers={providers} view={view} />,
    );
  });
}

async function runDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(150);
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.useRealTimers();
});

describe('useAtMentionMenu', () => {
  it('strips ANSI and BiDi controls from extension display text', async () => {
    vi.useFakeTimers();
    mount({
      view: makeView('@'),
      actions: {
        loadExtensionsStatus: vi.fn().mockResolvedValue({
          extensions: [
            {
              name: 'review',
              displayName: '\u001b[31mReview\u001b[0m\u202Etxt',
              description: 'safe',
              isActive: true,
            },
          ],
        }),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(1));
    await runDebounce();

    expect(latest!.state?.items[0]?.description).toBe('Reviewtxt');
  });

  it('filters cached extension provider data while searching', async () => {
    vi.useFakeTimers();
    const loadExtensionsStatus = vi.fn().mockResolvedValue({
      extensions: [
        {
          name: 'first',
          isActive: true,
        },
        {
          name: 'second',
          isActive: true,
        },
      ],
    });
    mount({ actions: { loadExtensionsStatus } });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(1));
    await runDebounce();
    expect(latest!.state?.items.map((item) => item.label)).toEqual([
      'first',
      'second',
    ]);

    act(() => latest!.updateSearch('second'));
    await runDebounce();
    expect(loadExtensionsStatus).toHaveBeenCalledTimes(1);
    expect(latest!.state?.items.map((item) => item.label)).toEqual(['second']);
  });

  it('opens extension items using the inserted ref suffix as search text', async () => {
    vi.useFakeTimers();
    mount({
      view: makeView('@'),
      actions: {
        loadExtensionsStatus: vi.fn().mockResolvedValue({
          extensions: [
            {
              name: 'review',
              isActive: true,
            },
          ],
        }),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(1));
    await runDebounce();
    act(() => latest!.close());
    act(() => latest!.refreshForView(makeView('@ext:revie')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'extensions',
      query: 'revie',
    });
    expect(latest!.state?.items.map((item) => item.label)).toEqual(['review']);

    act(() => latest!.refreshForView(makeView('@ext:revie')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'extensions',
      query: 'revie',
    });

    act(() => latest!.refreshForView(makeView('@ext:revi')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'extensions',
      query: 'revi',
    });

    act(() => {
      latest!.updateSearch('rev');
    });
    await runDebounce();
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'extensions',
      query: 'rev',
      inputMode: 'search',
    });

    act(() => latest!.refreshForView(makeView('@ext:review')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'extensions',
      query: 'rev',
      inputMode: 'search',
    });
  });

  it('opens MCP resource items using the inserted ref suffix as search text', async () => {
    vi.useFakeTimers();
    const loadMcpResources = vi.fn().mockResolvedValue({
      resources: [
        {
          uri: 'https://example.com/docs',
          name: 'Docs',
        },
      ],
    });
    mount({
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'docs',
              disabled: false,
              resourceCount: 1,
            },
          ],
        }),
        loadMcpResources,
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    act(() => latest!.close());
    act(() =>
      latest!.refreshForView(makeView('@docs:https://example.com/doc')),
    );
    await runDebounce();

    expect(loadMcpResources).toHaveBeenLastCalledWith('docs');
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
      query: 'https://example.com/doc',
    });
    expect(latest!.state?.items.map((item) => item.label)).toEqual(['Docs']);

    act(() =>
      latest!.refreshForView(makeView('@docs:https://example.com/doc')),
    );
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
      query: 'https://example.com/doc',
    });

    act(() => latest!.refreshForView(makeView('@docs:https://example.com/do')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
      query: 'https://example.com/do',
    });
  });

  it('opens file items using the typed mention text as search text', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'foo.ts',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({ actions: { listDirectory } });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => latest!.closeIfOpen());
    act(() => latest!.refreshForView(makeView('@src/foo')));
    await runDebounce();

    expect(listDirectory).toHaveBeenLastCalledWith('src');
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      query: 'src/foo',
    });
    expect(latest!.state?.items.map((item) => item.label)).toContain('foo.ts');

    act(() => latest!.refreshForView(makeView('@src/foo')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      query: 'src/foo',
    });

    act(() => latest!.refreshForView(makeView('@src/fo')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      query: 'src/fo',
    });
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it('opens typed file queries without provider history', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'package.json',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({ actions: { listDirectory } });

    act(() => latest!.refreshForView(makeView('@pac')));
    await runDebounce();

    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      query: 'pac',
      inputMode: 'context',
    });
    expect(latest!.state?.items.map((item) => item.label)).toEqual([
      'package.json',
    ]);
  });

  it('clears a pending provider search when closing from items', async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue([]);
    mount({
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search,
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    act(() => latest!.closeIfOpen());
    await runDebounce();

    expect(search).not.toHaveBeenCalled();
    expect(latest!.state?.level).toBe('categories');
  });

  it('clears a pending provider search when backing to categories', async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue([]);
    mount({
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search,
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    act(() => latest!.backToCategories());
    await runDebounce();

    expect(search).not.toHaveBeenCalled();
    expect(latest!.state?.level).toBe('categories');
  });

  it('keeps arrow keys owned when the active list is empty', async () => {
    vi.useFakeTimers();
    mount();

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(1));
    await runDebounce();

    expect(latest!.state?.items).toEqual([]);
    expect(latest!.moveSelection('down')).toBe(true);
  });

  it('does not open for email-style @ mentions inside a word', () => {
    mount();

    act(() => latest!.refreshForView(makeView('hello@example.com')));

    expect(latest!.state).toBeNull();
  });

  it('caps custom provider results', async () => {
    vi.useFakeTimers();
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: `${index}`,
      label: `item-${index}`,
    }));
    mount({
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue(items),
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state?.items).toHaveLength(50);
  });

  it('keeps built-in providers when custom provider ids collide', () => {
    const search = vi.fn().mockResolvedValue([]);
    mount({
      providers: [
        {
          id: 'files',
          label: 'Custom Files',
          search,
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));

    expect(latest!.state?.providers.map((provider) => provider.id)).toEqual([
      'files',
      'extensions',
      'mcp-resources',
    ]);
  });

  it('accepts a custom item by inserting its label fallback', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    mount({
      view,
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue([
            {
              id: 'item',
              label: 'snippet',
            },
          ]),
        },
      ],
    });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });

    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 1, insert: '@snippet ' },
      selection: { anchor: 9 },
      scrollIntoView: true,
    });
    expect(latest!.state).toBeNull();
  });

  it('accepts a directory item by drilling into that directory', async () => {
    vi.useFakeTimers();
    const listDirectory = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'list',
        path: '.',
        entries: [
          {
            name: 'src',
            kind: 'directory',
            ignored: false,
          },
        ],
        truncated: false,
      })
      .mockResolvedValue({
        kind: 'list',
        path: 'src',
        entries: [],
        truncated: false,
      });
    mount({ actions: { listDirectory }, view: makeView('@') });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => {
      expect(latest!.accept(1)).toBe(true);
    });
    await runDebounce();

    expect(listDirectory).toHaveBeenLastCalledWith('src');
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      query: '',
    });
    act(() => {
      expect(latest!.backToCategories()).toBe('items');
    });
    await runDebounce();
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it('accepts an MCP server item by drilling into its resources', async () => {
    vi.useFakeTimers();
    const loadMcpResources = vi.fn().mockResolvedValue({ resources: [] });
    mount({
      view: makeView('@'),
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'docs',
              disabled: false,
              resourceCount: 1,
            },
          ],
        }),
        loadMcpResources,
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });
    await runDebounce();

    expect(loadMcpResources).toHaveBeenCalledWith('docs');
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
    });
  });

  it('backs from MCP resources to the MCP server list', async () => {
    vi.useFakeTimers();
    mount({
      view: makeView('@'),
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'docs',
              disabled: false,
              resourceCount: 1,
            },
          ],
        }),
        loadMcpResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'res://doc', name: 'Doc' }],
        }),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => latest!.accept(0));
    await runDebounce();
    act(() => {
      expect(latest!.backToCategories()).toBe('items');
    });

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpServers',
      mcpServerName: undefined,
      items: [],
    });
  });

  it('closes without dispatching when accept uses stale document positions', async () => {
    vi.useFakeTimers();
    const view = makeView('');
    mount({
      view,
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue([
            {
              id: 'item',
              label: 'snippet',
            },
          ]),
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });

    expect(view.dispatch).not.toHaveBeenCalled();
    expect(latest!.state).toBeNull();
  });

  it('normalizes parent directory segments before listing files', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [],
      truncated: false,
    });
    mount({ actions: { listDirectory } });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    act(() => latest!.updateSearch('../secret'));
    await runDebounce();

    expect(listDirectory).toHaveBeenCalledWith('.');
  });

  it('escapes glob metacharacters in the fallback file search', async () => {
    vi.useFakeTimers();
    const globWorkspace = vi.fn().mockResolvedValue({ matches: [] });
    mount({ actions: { globWorkspace } });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    act(() => latest!.updateSearch('foo*bar?'));
    await runDebounce();

    expect(globWorkspace).toHaveBeenCalledWith('foo\\*bar\\?*', {
      maxResults: 50,
    });
  });

  it('sanitizes custom provider item display text', async () => {
    vi.useFakeTimers();
    mount({
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue([
            {
              id: 'custom-item',
              label: '\u001b[31mName\u001b[0m\u202E',
              description: 'Desc\u202E',
              detail: 'Detail\u202E',
            },
          ]),
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state?.items[0]).toMatchObject({
      label: 'Name',
      description: 'Desc',
      detail: 'Detail',
    });
  });

  it('sanitizes custom provider category display text', () => {
    mount({
      providers: [
        {
          id: 'custom',
          label: '\u001b[31mCustom\u001b[0m\u202E',
          description: 'Desc\u202E',
          order: 0,
          search: vi.fn().mockResolvedValue([]),
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));

    expect(latest!.state?.providers[0]).toMatchObject({
      label: 'Custom',
      description: 'Desc',
    });
  });

  it('strips unsafe controls from custom provider insert text', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    mount({
      view,
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue([
            {
              id: 'custom-item',
              label: 'Name',
              insertText: '@\u001b[31mName\u001b[0m\u202E ',
            },
          ]),
        },
      ],
    });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });

    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 1, insert: '@Name ' },
      selection: { anchor: 6 },
      scrollIntoView: true,
    });
  });

  it('uses a safe label fallback when display text strips to empty', async () => {
    vi.useFakeTimers();
    mount({
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue([
            {
              id: 'safe-id',
              label: '\u202E',
            },
          ]),
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state?.items[0]?.label).toBe('safe-id');
  });

  it('selects valid indices and rejects out-of-range indices', async () => {
    vi.useFakeTimers();
    mount({
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue([
            { id: 'first', label: 'First' },
            { id: 'second', label: 'Second' },
          ]),
        },
      ],
    });

    expect(latest!.select(0)).toBe(false);
    act(() => latest!.refreshForView(makeView('@')));
    act(() => {
      expect(latest!.select(-1)).toBe(false);
      expect(latest!.select(99)).toBe(false);
      expect(latest!.select(1)).toBe(true);
    });
    expect(latest!.state?.selectedIndex).toBe(1);

    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => {
      expect(latest!.select(1)).toBe(true);
    });
    expect(latest!.state?.selectedIndex).toBe(1);
  });

  it('prefers the first matching file over the current-directory item', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'README.md',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({ actions: { listDirectory }, view });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => latest!.updateSearch('read'));
    await runDebounce();

    expect(latest!.state?.items[0]?.label).toBe('README.md');
    act(() => {
      expect(latest!.accept()).toBe(true);
    });
    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 1, insert: '@README.md ' },
      selection: { anchor: 11 },
      scrollIntoView: true,
    });
  });

  it('strips unsafe controls from file insert paths', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'safe\u202E.md',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({ actions: { listDirectory }, view });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => {
      expect(latest!.accept(1)).toBe(true);
    });

    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 1, insert: '@safe.md ' },
      selection: { anchor: 9 },
      scrollIntoView: true,
    });
  });

  it('escapes parser delimiters in file insert paths', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'space name(1)?.md',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({ actions: { listDirectory }, view });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => {
      expect(latest!.accept(1)).toBe(true);
    });

    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 1, insert: '@space\\ name\\(1\\)\\?.md ' },
      selection: { anchor: 23 },
      scrollIntoView: true,
    });
  });

  it('inserts MCP resources with parser-safe escaping', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    const loadMcpResources = vi.fn().mockResolvedValue({
      resources: [
        {
          uri: 'res://doc?version=1 path@x.',
          name: 'Doc',
        },
      ],
    });
    mount({
      view,
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'docs',
              disabled: false,
              resourceCount: 1,
            },
          ],
        }),
        loadMcpResources,
      },
    });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    act(() => latest!.accept(0));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });

    expect(view.dispatch).toHaveBeenCalledWith({
      changes: {
        from: 0,
        to: 1,
        insert: '@docs:res://doc\\?version=1\\ path@x. ',
      },
      selection: { anchor: 36 },
      scrollIntoView: true,
    });
  });

  it('sanitizes MCP resource mime type fallbacks', async () => {
    vi.useFakeTimers();
    mount({
      view: makeView('@'),
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'docs',
              disabled: false,
              resourceCount: 1,
            },
          ],
        }),
        loadMcpResources: vi.fn().mockResolvedValue({
          resources: [
            {
              uri: 'res://doc',
              name: 'Doc',
              mimeType: 'text/plain\u202E',
            },
          ],
        }),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => latest!.accept());
    await runDebounce();

    expect(latest!.state?.items[0]?.description).toBe('text/plain');
  });

  it('reopens MCP resources with the last selected colon-containing server name', async () => {
    vi.useFakeTimers();
    const loadMcpResources = vi.fn().mockResolvedValue({ resources: [] });
    mount({
      view: makeView('@'),
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'my:server',
              disabled: false,
              resourceCount: 1,
            },
          ],
        }),
        loadMcpResources,
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => latest!.accept());
    await runDebounce();
    act(() => latest!.close());
    act(() => latest!.refreshForView(makeView('@my:server:res://doc')));
    await runDebounce();

    expect(loadMcpResources).toHaveBeenLastCalledWith('my:server');
    expect(latest!.state).toMatchObject({
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'my:server',
      query: 'res://doc',
    });
  });

  it('does not load resources when reopening a disabled MCP server ref', async () => {
    vi.useFakeTimers();
    const loadMcpResources = vi.fn().mockResolvedValue({
      resources: [{ uri: 'res://doc', name: 'Doc' }],
    });
    mount({
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'docs',
              disabled: true,
              resourceCount: 1,
            },
          ],
        }),
        loadMcpResources,
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    act(() => latest!.close());
    act(() => latest!.refreshForView(makeView('@docs:res://doc')));
    await runDebounce();

    expect(loadMcpResources).not.toHaveBeenCalled();
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      items: [],
      loading: false,
    });
  });

  it('recovers from provider search failures', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({
      providers: [
        {
          id: 'broken',
          label: 'Broken',
          search: vi.fn().mockRejectedValue(new Error('boom')),
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      loading: false,
      items: [],
    });
    expect(warn).toHaveBeenCalledWith(
      '[@mention] provider="broken" query=<redacted> failed',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('discards stale provider responses', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (items: []) => void;
    const first = new Promise<[]>((resolve) => {
      resolveFirst = resolve;
    });
    const search = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([{ id: 'new', label: 'newer' }]);
    mount({
      providers: [{ id: 'custom', label: 'Custom', search }],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => latest!.updateSearch('n'));
    await runDebounce();
    await act(async () => {
      resolveFirst([]);
      await Promise.resolve();
    });

    expect(latest!.state?.items).toEqual([
      expect.objectContaining({ id: 'new', label: 'newer' }),
    ]);
  });

  it('updates MCP resource search from the item search box', async () => {
    vi.useFakeTimers();
    const loadMcpResources = vi.fn().mockResolvedValue({
      resources: [
        { uri: 'res://one', name: 'One' },
        { uri: 'res://two', name: 'Two' },
      ],
    });
    mount({
      view: makeView('@'),
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'docs',
              disabled: false,
              resourceCount: 2,
            },
          ],
        }),
        loadMcpResources,
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => latest!.accept(0));
    await runDebounce();
    act(() => latest!.updateSearch('two'));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      itemMode: 'mcpResources',
      query: 'two',
      items: [expect.objectContaining({ label: 'Two' })],
    });
    expect(loadMcpResources).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an items-level panel after the cursor moves inside the reference', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'item',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({
      actions: { listDirectory },
    });

    act(() => latest!.refreshForView(makeView('@item')));
    await runDebounce();
    act(() => latest!.refreshForView(makeViewAt('@item', 3)));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      from: 0,
      to: 3,
      query: 'it',
    });
  });
});
