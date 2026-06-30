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

function Harness({
  actions,
  providers,
}: {
  actions?: AtMentionWorkspaceActions;
  providers?: readonly WebShellAtProvider[];
}) {
  latest = useAtMentionMenu({
    viewRef: { current: null },
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
}: {
  actions?: AtMentionWorkspaceActions;
  providers?: readonly WebShellAtProvider[];
} = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness actions={actions} providers={providers} />);
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

  it('refreshes extension provider data on each search', async () => {
    vi.useFakeTimers();
    const loadExtensionsStatus = vi
      .fn()
      .mockResolvedValueOnce({
        extensions: [
          {
            name: 'first',
            isActive: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        extensions: [
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
    expect(latest!.state?.items.map((item) => item.label)).toEqual(['first']);

    act(() => latest!.updateSearch('second'));
    await runDebounce();
    expect(loadExtensionsStatus).toHaveBeenCalledTimes(2);
    expect(latest!.state?.items.map((item) => item.label)).toEqual(['second']);
  });

  it('opens extension items without the inserted ref prefix as search text', async () => {
    vi.useFakeTimers();
    mount({
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
      query: '',
    });
    expect(latest!.state?.items.map((item) => item.label)).toEqual(['review']);
  });

  it('opens MCP resource items without the inserted ref as search text', async () => {
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

    expect(loadMcpResources).toHaveBeenLastCalledWith('docs', {
      signal: expect.any(AbortSignal),
    });
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
      query: '',
    });
    expect(latest!.state?.items.map((item) => item.label)).toEqual(['Docs']);
  });

  it('opens file items without the inserted ref as search text', async () => {
    vi.useFakeTimers();
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
    mount({ actions: { listDirectory } });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => latest!.closeIfOpen());
    act(() => latest!.refreshForView(makeView('@src/foo')));
    await runDebounce();

    expect(listDirectory).toHaveBeenLastCalledWith('.', {
      signal: expect.any(AbortSignal),
    });
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      query: '',
    });
    expect(latest!.state?.items.map((item) => item.label)).toContain(
      'README.md',
    );
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

  it('keeps arrow keys owned when the active list is empty', () => {
    mount();

    act(() => latest!.refreshForView(makeView('@zzzz')));

    expect(latest!.state?.providers).toEqual([]);
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
    act(() =>
      latest!.refreshForView(makeView('@../secret'), { userEdited: true }),
    );
    await runDebounce();

    expect(listDirectory).toHaveBeenCalledWith('.', {
      signal: expect.any(AbortSignal),
    });
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
});
