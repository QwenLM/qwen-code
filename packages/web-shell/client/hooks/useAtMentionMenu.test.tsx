// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { WebShellAtProvider, WebShellComposerTag } from '../customization';
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

function setViewState(view: EditorView, doc: string, anchor = doc.length) {
  Object.defineProperty(view, 'state', {
    value: EditorState.create({ doc, selection: { anchor } }),
    configurable: true,
  });
}

function Harness({
  actions,
  disabled = false,
  providers,
  shellMode = false,
  view,
  createInlineTagEffect,
}: {
  actions?: AtMentionWorkspaceActions;
  disabled?: boolean;
  providers?: readonly WebShellAtProvider[];
  shellMode?: boolean;
  view?: EditorView | null;
  createInlineTagEffect?: (range: {
    from: number;
    to: number;
    tag: WebShellComposerTag;
  }) => StateEffect<unknown>;
}) {
  latest = useAtMentionMenu({
    viewRef: { current: view ?? null },
    disabledRef: { current: disabled },
    shellModeRef: { current: shellMode },
    workspaceActionsRef: { current: actions },
    providers,
    createInlineTagEffect,
  });
  return null;
}

function mount({
  actions,
  disabled,
  providers,
  shellMode,
  view,
  createInlineTagEffect,
}: {
  actions?: AtMentionWorkspaceActions;
  disabled?: boolean;
  providers?: readonly WebShellAtProvider[];
  shellMode?: boolean;
  view?: EditorView | null;
  createInlineTagEffect?: (range: {
    from: number;
    to: number;
    tag: WebShellComposerTag;
  }) => StateEffect<unknown>;
} = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <Harness
        actions={actions}
        disabled={disabled}
        providers={providers}
        shellMode={shellMode}
        view={view}
        createInlineTagEffect={createInlineTagEffect}
      />,
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
  it('does not open while disabled', () => {
    mount({ disabled: true });

    act(() => {
      expect(latest!.refreshForView(makeView('@'))).toBe(false);
    });

    expect(latest!.state).toBeNull();
  });

  it('does not open in shell mode', () => {
    mount({ shellMode: true });

    act(() => {
      expect(latest!.refreshForView(makeView('@'))).toBe(false);
    });

    expect(latest!.state).toBeNull();
  });

  it('strips ANSI, BiDi, and control characters from extension display text', async () => {
    vi.useFakeTimers();
    mount({
      view: makeView('@'),
      actions: {
        loadExtensionsStatus: vi.fn().mockResolvedValue({
          extensions: [
            {
              name: 'review',
              displayName: '\u001b[31mReview\u001b[0m\u202E\u0085txt\u0007中文',
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

    expect(latest!.state?.items[0]?.description).toBe('Reviewtxt中文');
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

  it('ranks extension name matches before description-only matches', async () => {
    vi.useFakeTimers();
    mount({
      actions: {
        loadExtensionsStatus: vi.fn().mockResolvedValue({
          extensions: [
            {
              name: 'zeta',
              displayName: 'alpha helper',
              isActive: true,
            },
            {
              name: 'alpha',
              isActive: true,
            },
          ],
        }),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(1));
    await runDebounce();
    act(() => latest!.updateSearch('alpha'));
    await runDebounce();

    expect(latest!.state?.items.map((item) => item.label)).toEqual([
      'alpha',
      'zeta',
    ]);
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

  it('routes custom provider id prefixes back to that provider', async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue([
      {
        id: 'one',
        label: 'one',
      },
    ]);
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

    act(() => latest!.refreshForView(makeView('@custom:one')));
    await runDebounce();

    expect(search).toHaveBeenCalledWith({
      query: 'one',
      signal: expect.any(AbortSignal),
    });
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'custom',
      query: 'one',
    });

    act(() => latest!.refreshForView(makeView('@custom:on')));
    await runDebounce();

    expect(search).toHaveBeenLastCalledWith({
      query: 'on',
      signal: expect.any(AbortSignal),
    });
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'custom',
      query: 'on',
    });
  });

  it('strips the mcp prefix while refreshing MCP server searches', async () => {
    vi.useFakeTimers();
    const loadMcpStatus = vi.fn().mockResolvedValue({
      servers: [
        {
          kind: 'mcp_server',
          name: 'docs',
          disabled: false,
          resourceCount: 1,
        },
      ],
    });
    mount({
      actions: {
        loadMcpStatus,
      },
    });

    act(() => latest!.refreshForView(makeView('@mcp:do')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      query: 'do',
    });

    act(() => latest!.refreshForView(makeView('@mcp:d')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      query: 'd',
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
    act(() => latest!.accept());
    await runDebounce();
    act(() => latest!.accept());
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

    expect(listDirectory).toHaveBeenLastCalledWith('src', {
      signal: expect.any(AbortSignal),
    });
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

  it('preserves provider selection when accept dispatch triggers a synchronous refresh', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    mount({
      view,
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
    view.dispatch = vi.fn((spec) => {
      if ('changes' in spec) {
        setViewState(view, '@ext:review ');
        act(() => latest!.refreshForView(view));
      }
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(1));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });
    setViewState(view, '@ext:revie');
    act(() => latest!.refreshForView(view));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'extensions',
      query: 'revie',
    });
  });

  it('decorates accepted extension refs as inline composer tags', async () => {
    vi.useFakeTimers();
    const inlineTagEffect = StateEffect.define<{
      from: number;
      to: number;
      tag: WebShellComposerTag;
    }>();
    const view = makeView('@');
    mount({
      view,
      createInlineTagEffect: (range) => inlineTagEffect.of(range),
      actions: {
        loadExtensionsStatus: vi.fn().mockResolvedValue({
          extensions: [
            {
              name: 'review',
              displayName: 'Review',
              isActive: true,
            },
          ],
        }),
      },
    });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(1));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });

    const spec = vi.mocked(view.dispatch).mock.calls[0]?.[0];
    expect(spec).toMatchObject({
      changes: { from: 0, to: 1, insert: '@ext:review ' },
      selection: { anchor: 12 },
      scrollIntoView: true,
    });
    expect(Array.isArray(spec?.effects)).toBe(true);
    const effect = Array.isArray(spec?.effects) ? spec.effects[0] : undefined;
    expect(effect?.is(inlineTagEffect)).toBe(true);
    expect(effect?.value).toEqual({
      from: 0,
      to: 11,
      tag: {
        id: 'extension:@ext:review',
        kind: 'extension',
        value: 'review',
        serialized: '@ext:review',
      },
    });
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

  it('opens after bracket punctuation', () => {
    mount();

    act(() => latest!.refreshForView(makeView('(@foo')));

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      query: 'foo',
    });
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

  it('keeps the current directory item plus fifty file entries', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: Array.from({ length: 55 }, (_, index) => ({
        name: `file-${String(index).padStart(2, '0')}.ts`,
        kind: 'file',
        ignored: false,
      })),
      truncated: false,
    });
    mount({
      actions: { listDirectory },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state?.items).toHaveLength(51);
    expect(latest!.state?.items[0]?.id).toBe('current:.');
    expect(latest!.state?.items[50]?.label).toBe('file-49.ts');
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

  it('decorates custom items when they provide composer tags', async () => {
    vi.useFakeTimers();
    const inlineTagEffect = StateEffect.define<{
      from: number;
      to: number;
      tag: WebShellComposerTag;
    }>();
    const view = makeView('@');
    mount({
      view,
      createInlineTagEffect: (range) => inlineTagEffect.of(range),
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search: vi.fn().mockResolvedValue([
            {
              id: 'ticket-123',
              label: 'TICKET-123',
              insertText: '@ticket:TICKET-123 ',
              composerTag: {
                id: 'ticket-123',
                kind: 'table',
                value: 'TICKET-123',
              },
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

    const spec = vi.mocked(view.dispatch).mock.calls[0]?.[0];
    expect(spec).toMatchObject({
      changes: { from: 0, to: 1, insert: '@ticket:TICKET-123 ' },
      selection: { anchor: 19 },
      scrollIntoView: true,
    });
    const effect = Array.isArray(spec?.effects) ? spec.effects[0] : undefined;
    expect(effect?.is(inlineTagEffect)).toBe(true);
    expect(effect?.value).toEqual({
      from: 0,
      to: 18,
      tag: {
        id: 'ticket-123',
        kind: 'table',
        value: 'TICKET-123',
        serialized: '@ticket:TICKET-123',
      },
    });
  });

  it('sanitizes custom item label fallbacks before insertion', async () => {
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
              label: 'snip\u0001pet',
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
  });

  it('does not accept stale items while a provider search is loading', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    let resolveSecond!: (items: []) => void;
    const secondSearch = new Promise<[]>((resolve) => {
      resolveSecond = resolve;
    });
    const search = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'old',
          label: 'old',
          insertText: '@old ',
        },
      ])
      .mockReturnValueOnce(secondSearch);
    mount({
      view,
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          order: 0,
          search,
        },
      ],
    });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    act(() => latest!.updateSearch('new'));
    await runDebounce();
    act(() => {
      expect(latest!.accept(0)).toBe(true);
    });

    expect(view.dispatch).not.toHaveBeenCalled();
    act(() => resolveSecond([]));
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('closes without dispatching when accept no longer targets an @ mention', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
              insertText: '@snippet ',
            },
          ]),
        },
      ],
    });

    act(() => latest!.refreshForView(view));
    act(() => latest!.enterCategory(0));
    await runDebounce();
    setViewState(view, 'x', 1);
    act(() => {
      expect(latest!.accept()).toBe(true);
    });

    expect(view.dispatch).not.toHaveBeenCalled();
    expect(latest!.state).toBeNull();
    warn.mockRestore();
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

    expect(listDirectory).toHaveBeenLastCalledWith('src', {
      signal: expect.any(AbortSignal),
    });
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

    expect(loadMcpResources).toHaveBeenCalledWith('docs', {
      signal: expect.any(AbortSignal),
    });
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
    });
  });

  it('shows an empty MCP resource list when resource loading is unavailable', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });
    await runDebounce();

    expect(warn).toHaveBeenCalledWith(
      '[@mention] loadMcpResources not available for server="docs"',
    );
    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
      items: [],
      loading: false,
    });
    warn.mockRestore();
  });

  it('accepts a tools-only MCP server item as a server reference', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    mount({
      view,
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'tools',
              disabled: false,
              resourceCount: 0,
            },
          ],
        }),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    act(() => {
      expect(latest!.accept()).toBe(true);
    });

    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 1, insert: '@mcp:tools ' },
      selection: { anchor: 11 },
      scrollIntoView: true,
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
      signal: expect.any(AbortSignal),
    });
  });

  it('recovers from file provider list failures', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listDirectory = vi.fn().mockRejectedValue(new Error('boom'));
    mount({ actions: { listDirectory } });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      loading: false,
      items: [],
    });
    expect(warn).toHaveBeenCalledWith(
      'Failed to load @ file suggestions',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('recovers from fallback file glob failures', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const globWorkspace = vi.fn().mockRejectedValue(new Error('boom'));
    mount({ actions: { globWorkspace } });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      loading: false,
      items: [],
    });
    expect(warn).toHaveBeenCalledWith(
      'Failed to load @ file suggestions',
      expect.any(Error),
    );
    warn.mockRestore();
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

  it('does not allow custom items to masquerade as navigable directories', async () => {
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
              label: 'Custom item',
              kind: 'directory',
              targetPath: 'src',
            },
          ]),
        },
      ],
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(0));
    await runDebounce();

    expect(latest!.state?.items[0]).toMatchObject({
      label: 'Custom item',
      kind: 'insert',
    });
    expect(latest!.state?.items[0]?.targetPath).toBeUndefined();
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
              insertText: '@\u001b[31mName\u001b[0m\u202E\u0085中文 ',
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
      changes: { from: 0, to: 1, insert: '@Name中文 ' },
      selection: { anchor: 8 },
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
          name: 'safe\u202E\u0085中文.md',
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
      changes: { from: 0, to: 1, insert: '@safe中文.md ' },
      selection: { anchor: 11 },
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
          name: 'space name(1)#plus+.md',
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

    const expectedInsert = '@space\\ name\\(1\\)\\#plus\\+.md ';
    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 1, insert: expectedInsert },
      selection: { anchor: expectedInsert.length },
      scrollIntoView: true,
    });
  });

  it('escapes @ characters in file insert paths', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'user@example.ts',
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
      changes: { from: 0, to: 1, insert: '@user\\@example.ts ' },
      selection: { anchor: 18 },
      scrollIntoView: true,
    });
  });

  it('escapes provider-prefix delimiters in file insert paths', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'ext:config.json',
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
      changes: { from: 0, to: 1, insert: '@ext\\:config.json ' },
      selection: { anchor: 18 },
      scrollIntoView: true,
    });
  });

  it('unescapes parser delimiters when reopening a file mention', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'space name(1)#plus+.md',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({ actions: { listDirectory } });

    act(() =>
      latest!.refreshForView(makeView('@space\\ name\\(1\\)\\#plus\\+.md')),
    );
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      items: [expect.objectContaining({ label: 'space name(1)#plus+.md' })],
    });
  });

  it('reopens escaped provider-prefix file mentions as files', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({
      kind: 'list',
      path: '.',
      entries: [
        {
          name: 'ext:config.json',
          kind: 'file',
          ignored: false,
        },
      ],
      truncated: false,
    });
    mount({ actions: { listDirectory } });

    act(() => latest!.refreshForView(makeView('@ext\\:config.json')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'files',
      items: [expect.objectContaining({ label: 'ext:config.json' })],
    });
  });

  it('inserts MCP resources with parser-safe escaping', async () => {
    vi.useFakeTimers();
    const view = makeView('@');
    const loadMcpResources = vi.fn().mockResolvedValue({
      resources: [
        {
          uri: 'res://doc?version=1&tag=a+b path@x.',
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

    const expectedInsert =
      '@docs\\:res\\://doc\\?version\\=1\\&tag\\=a\\+b\\ path\\@x. ';
    expect(view.dispatch).toHaveBeenCalledWith({
      changes: {
        from: 0,
        to: 1,
        insert: expectedInsert,
      },
      selection: { anchor: expectedInsert.length },
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

  it('recovers from MCP resource load failures', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
        loadMcpResources: vi.fn().mockRejectedValue(new Error('boom')),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(2));
    await runDebounce();
    act(() => latest!.accept());
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
      loading: false,
      items: [],
    });
    expect(warn).toHaveBeenCalledWith(
      'Failed to load @ MCP resources',
      expect.any(Error),
    );
    warn.mockRestore();
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
    act(() => latest!.refreshForView(makeView('@my\\:server\\:res\\://doc')));
    await runDebounce();

    expect(loadMcpResources).toHaveBeenLastCalledWith('my:server', {
      signal: expect.any(AbortSignal),
    });
    expect(latest!.state).toMatchObject({
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'my:server',
      query: '',
    });
  });

  it('updates MCP resource search from escaped editor text', async () => {
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
    act(() => latest!.accept());
    await runDebounce();
    act(() => latest!.close({ preserveProviderSelection: true }));
    act(() => latest!.refreshForView(makeView('@docs\\:')));
    await runDebounce();
    act(() => latest!.refreshForView(makeView('@docs\\:res\\://two')));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'docs',
      query: 'res://two',
      items: [expect.objectContaining({ label: 'Two' })],
    });
    expect(loadMcpResources).toHaveBeenLastCalledWith('docs', {
      signal: expect.any(AbortSignal),
    });
  });

  it('prefers the selected MCP server name over generic provider prefixes', async () => {
    vi.useFakeTimers();
    const loadMcpResources = vi.fn().mockResolvedValue({ resources: [] });
    mount({
      view: makeView('@'),
      actions: {
        loadMcpStatus: vi.fn().mockResolvedValue({
          servers: [
            {
              kind: 'mcp_server',
              name: 'ext',
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
    act(() => latest!.accept());
    await runDebounce();
    act(() => latest!.closeIfOpen());
    act(() => latest!.refreshForView(makeView('@ext:resource')));
    await runDebounce();

    expect(loadMcpResources).toHaveBeenLastCalledWith('ext', {
      signal: expect.any(AbortSignal),
    });
    expect(latest!.state).toMatchObject({
      selectedProviderId: 'mcp-resources',
      itemMode: 'mcpResources',
      mcpServerName: 'ext',
      query: 'resource',
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
      selectedProviderId: 'files',
      itemMode: 'default',
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

  it('recovers from built-in provider search failures', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({
      actions: {
        loadExtensionsStatus: vi.fn().mockRejectedValue(new Error('boom')),
      },
    });

    act(() => latest!.refreshForView(makeView('@')));
    act(() => latest!.enterCategory(1));
    await runDebounce();

    expect(latest!.state).toMatchObject({
      level: 'items',
      selectedProviderId: 'extensions',
      loading: false,
      items: [],
    });
    expect(warn).toHaveBeenCalledWith(
      'Failed to load @ extension suggestions',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('recovers from synchronous provider search failures', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({
      providers: [
        {
          id: 'broken',
          label: 'Broken',
          search: vi.fn(() => {
            throw new Error('boom');
          }),
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
