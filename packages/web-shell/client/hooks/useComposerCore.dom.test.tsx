// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';
import type {
  UserMessageContentParser,
  WebShellComposerInput,
} from '../customization';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

function Harness({
  composerInput,
  onSubmit,
  renderComposerTag,
  renderComposerTagTooltip,
  parseUserMessageContent,
  followupState,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit: ReturnType<typeof vi.fn>;
  renderComposerTag?: () => ReactNode;
  renderComposerTagTooltip?: () => ReactNode;
  parseUserMessageContent?: UserMessageContentParser;
  followupState?: {
    isVisible: boolean;
    shownAt: number;
    suggestion: string | null;
  };
}) {
  const composer = useComposerCore({
    onSubmit,
    commands: [],
    editorTheme: {},
    renderComposerTag,
    renderComposerTagTooltip,
    parseUserMessageContent,
    followupState,
    composerInput,
    composerInputVersion: composerInput ? 1 : undefined,
  });
  latest = composer;

  return <div ref={composer.containerRef} />;
}

async function mount({
  composerInput,
  onSubmit = vi.fn(),
  renderComposerTag,
  renderComposerTagTooltip,
  parseUserMessageContent,
  followupState,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit?: ReturnType<typeof vi.fn>;
  renderComposerTag?: () => ReactNode;
  renderComposerTagTooltip?: () => ReactNode;
  parseUserMessageContent?: UserMessageContentParser;
  followupState?: {
    isVisible: boolean;
    shownAt: number;
    suggestion: string | null;
  };
} = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  const render = (portalRoot: HTMLElement | null) => {
    root!.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <I18nProvider language="en">
          <Harness
            composerInput={composerInput}
            onSubmit={onSubmit}
            renderComposerTag={renderComposerTag}
            renderComposerTagTooltip={renderComposerTagTooltip}
            parseUserMessageContent={parseUserMessageContent}
            followupState={followupState}
          />
        </I18nProvider>
      </WebShellPortalRootContext.Provider>,
    );
  };

  await act(async () => {
    render(null);
  });
  return {
    onSubmit,
    setPortalRoot(portalRoot: HTMLElement | null) {
      act(() => render(portalRoot));
    },
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.removeItem('qwen-web-shell-history');
  localStorage.removeItem('qwen-web-shell-command-history');
  document.getElementById('web-shell-tooltip-styles')?.remove();
  root = null;
  container = null;
  latest = null;
});

describe('useComposerCore tooltip portal', () => {
  it('moves the CodeMirror tooltip portal and styles into the shared shadow root', async () => {
    const { setPortalRoot } = await mount();
    const tooltipPortal = document.querySelector(
      '[data-web-shell-tooltip-portal]',
    );
    expect(tooltipPortal?.parentElement).toBe(document.body);

    const host = document.createElement('div');
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const portalRoot = document.createElement('div');
    shadowRoot.append(portalRoot);

    setPortalRoot(portalRoot);

    expect(tooltipPortal?.parentElement).toBe(portalRoot);
    expect(
      shadowRoot.getElementById('web-shell-tooltip-styles'),
    ).not.toBeNull();
    host.remove();
  });
});

describe('useComposerCore tags', () => {
  it('keeps the composer API stable across tag updates', async () => {
    await mount();
    const api = latest!.handle;

    act(() => {
      api.addTags([{ id: 'orders', value: 'orders' }]);
    });

    expect(latest!.handle).toBe(api);
  });

  it('does not rerender when removing a missing tag', async () => {
    await mount();
    const render = latest;
    const dispatch = vi.spyOn(latest!.viewRef.current!, 'dispatch');

    act(() => {
      latest!.handle.removeTag('missing');
    });

    expect(latest).toBe(render);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('falls back when inline custom tag rendering throws', async () => {
    const error = new Error('boom');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTag: () => {
        throw error;
      },
    });

    expect(warn).toHaveBeenCalledWith(
      '[WebShell] inline tag renderContent failed',
      error,
    );
    expect(document.body.textContent).toContain('orders');

    warn.mockRestore();
  });

  it('falls back when inline custom tag tooltip rendering throws', async () => {
    const error = new Error('bad tooltip');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTagTooltip: () => {
        throw error;
      },
    });

    expect(warn).toHaveBeenCalledWith(
      '[WebShell] inline tag tooltip render failed',
      error,
    );
    expect(document.body.textContent).toContain('orders');

    warn.mockRestore();
  });

  it('uses a custom inline tooltip without a native title', async () => {
    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTagTooltip: () => 'Details',
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Details');
    expect(tooltip?.parentElement?.getAttribute('title')).toBeNull();
    expect(tooltip?.id).toBeTruthy();
    expect(tooltip?.parentElement?.getAttribute('aria-describedby')).toBe(
      tooltip?.id,
    );
  });

  it('falls back to a native title when attaching an inline tooltip fails', async () => {
    const error = new Error('append failed');
    const appendChild = HTMLElement.prototype.appendChild;
    let failingTooltip: HTMLElement | null = null;
    let readFailingChipTitle: (() => string) | null = null;
    let dispatchOnFailingChip: ((event: Event) => boolean) | null = null;
    const appendChildSpy = vi
      .spyOn(HTMLElement.prototype, 'appendChild')
      .mockImplementation(function (child) {
        if (
          child instanceof HTMLElement &&
          child.getAttribute('role') === 'tooltip'
        ) {
          failingTooltip = child;
          readFailingChipTitle = () => this.title;
          dispatchOnFailingChip = (event) => this.dispatchEvent(event);
          throw error;
        }
        return appendChild.call(this, child);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      expect(readFailingChipTitle?.()).toBe('Details');
    });

    try {
      await mount({
        composerInput: {
          tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
          tagPlacement: 'inline',
        },
        renderComposerTagTooltip: () => 'Details',
      });

      expect(warn).toHaveBeenCalledWith(
        '[WebShell] inline tag tooltip render failed',
        error,
      );
      const chip = document.body.querySelector('[title="Details"]');
      expect(chip).not.toBeNull();
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      dispatchOnFailingChip?.(new MouseEvent('mouseenter'));
      expect(failingTooltip?.style.display).toBe('none');
    } finally {
      warn.mockRestore();
      appendChildSpy.mockRestore();
    }
  });

  it('guards inline mask icon sources', async () => {
    await mount({
      composerInput: {
        tags: [
          {
            id: 'orders',
            label: 'Table',
            value: 'orders',
            icon: 'javascript:alert(1)',
          },
        ],
        tagPlacement: 'inline',
      },
    });

    expect(document.body.innerHTML).not.toContain('javascript:alert');
    expect(
      document.body.querySelector('[style*="--composer-tag-icon-url"]'),
    ).toBeNull();
  });

  it('renders built-in icons for inline composer tags', async () => {
    const kinds = ['extension', 'file', 'mcp', 'skill'] as const;
    await mount({
      composerInput: {
        tags: kinds.map((kind) => ({
          id: `${kind}:reference`,
          kind,
          value: kind,
          serialized: `@${kind}:reference`,
        })),
        tagPlacement: 'inline',
      },
    });

    expect(
      document.body.querySelectorAll('[style*="--composer-tag-icon-url"]'),
    ).toHaveLength(kinds.length);
  });

  it('keeps inline tags after trimming leading whitespace on submit', async () => {
    const { onSubmit } = await mount();

    act(() => {
      latest!.setText('  ');
      latest!.addTags(
        [{ id: 'orders', value: 'orders', serialized: '<table />' }],
        { placement: 'inline' },
      );
      latest!.insertText('explain');
      latest!.submitText();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      '<table /> explain',
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          {
            end: 9,
            reference: {
              id: 'orders',
              serialized: '<table />',
              value: 'orders',
            },
            start: 0,
            text: '<table />',
            type: 'reference',
          },
        ],
      },
    );
  });

  it('restores parsed inline tags when arrow keys browse prompt history', async () => {
    const serialized = '<context id="orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) => {
      if (content !== prompt) return undefined;
      return [
        { type: 'text', text: 'inspect ' },
        {
          type: 'tag',
          tag: { id: 'orders', value: 'orders', serialized },
        },
        { type: 'text', text: ' now' },
      ];
    };
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.setText('draft');
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(editor.textContent).toContain('inspect');
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);

    act(() => latest!.submitText());
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );

    act(() => {
      latest!.setText('draft');
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          code: 'ArrowDown',
          bubbles: true,
        }),
      );
    });
    expect(latest!.getText()).toBe('draft');
    expect(editor.textContent).not.toContain('orders');
  });

  it('restores shell history as raw command text without parsing tags', async () => {
    const serialized = '<context id="orders">orders</context>';
    const command = `echo ${serialized}`;
    const parseUserMessageContent = vi.fn<UserMessageContentParser>(
      (content) =>
        content === command
          ? [
              { type: 'text', text: 'echo ' },
              {
                type: 'tag',
                tag: { id: 'orders', value: 'orders', serialized },
              },
            ]
          : undefined,
    );
    await mount({ parseUserMessageContent });

    act(() => {
      latest!.setShellMode(true);
    });
    act(() => {
      latest!.setText(command);
      latest!.submitText();
      latest!.setText('draft');
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(latest!.getText()).toBe(command);
    expect(editor.textContent).toBe(command);
    expect(
      editor.querySelectorAll('button[aria-label^="Remove "]'),
    ).toHaveLength(0);
    expect(parseUserMessageContent).not.toHaveBeenCalled();
  });

  it('restores draft top tags after ArrowDown exits prompt history', async () => {
    const historyText = 'previous prompt';
    const draftText = 'draft prompt';
    const draftTag = {
      id: 'file:draft.txt',
      value: 'draft.txt',
      serialized: '@draft.txt',
    };
    await mount();

    act(() => {
      latest!.setText(historyText);
      latest!.submitText();
      latest!.setText(draftText);
      latest!.addTags([draftTag]);
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(latest!.getText()).toBe(historyText);
    expect(latest!.composerTags).toEqual([]);

    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          code: 'ArrowDown',
          bubbles: true,
        }),
      );
    });

    expect(latest!.getText()).toBe(draftText);
    expect(latest!.composerTags).toEqual([draftTag]);
  });

  it('restores tags when Tab or a search-result selection recalls history', async () => {
    const serialized = '<context id="search-orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            { type: 'text', text: 'inspect ' },
            {
              type: 'tag',
              tag: { id: 'orders', value: 'orders', serialized },
            },
            { type: 'text', text: ' now' },
          ]
        : undefined;
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
    });

    const preventDefault = vi.fn();
    act(() => {
      latest!.searchState.handleSearchKeyDown({
        key: 'Tab',
        nativeEvent: { isComposing: false },
        preventDefault,
      } as unknown as React.KeyboardEvent<HTMLInputElement>);
    });

    const editor = container!.querySelector('.cm-content')!;
    expect(preventDefault).toHaveBeenCalled();
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);

    act(() => latest!.searchState.restoreSearchMatch?.(prompt));
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);

    act(() => {
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
    });
    act(() => {
      latest!.searchState.handleSearchKeyDown({
        key: 'Enter',
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLInputElement>);
    });
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );
  });

  it('does not prepend stale top tags when Ctrl-R submits a recalled inline tag', async () => {
    const serialized = '<context id="search-stale-orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            { type: 'text', text: 'inspect ' },
            {
              type: 'tag',
              tag: { id: 'orders', value: 'orders', serialized },
            },
            { type: 'text', text: ' now' },
          ]
        : undefined;
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
    });
    act(() => {
      latest!.addTags([
        {
          id: 'stale',
          value: 'stale',
          serialized: '<context id="stale">stale</context>',
        },
      ]);
    });
    expect(latest!.composerTags).toHaveLength(1);

    act(() => {
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
    });
    act(() => {
      latest!.searchState.handleSearchKeyDown({
        key: 'Enter',
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLInputElement>);
    });

    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );
  });

  it('submits the selected plain Ctrl-R history text instead of a visible followup', async () => {
    const historyText = 'inspect the orders';
    localStorage.setItem(
      'qwen-web-shell-history',
      JSON.stringify([historyText]),
    );
    const { onSubmit } = await mount({
      followupState: {
        isVisible: true,
        shownAt: Date.now(),
        suggestion: 'inspect the orders table and summarize',
      },
    });

    act(() => {
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
      latest!.searchState.submitSearchMatch(historyText);
    });

    expect(onSubmit).toHaveBeenLastCalledWith(
      historyText,
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it('keeps history source text and skips annotations for mismatched parser output', async () => {
    const prompt = '<context id="orders">orders</context>';
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            {
              type: 'tag',
              tag: {
                id: 'orders',
                value: 'orders',
                serialized: '<context id="other">other</context>',
              },
            },
          ]
        : undefined;
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.setText('draft');
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(editor.textContent).toContain(prompt);
    act(() => latest!.submitText());
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it('restores tags when a history search submission is rejected', async () => {
    const serialized = '<context id="rejected-orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            { type: 'text', text: 'inspect ' },
            {
              type: 'tag',
              tag: { id: 'orders', value: 'orders', serialized },
            },
            { type: 'text', text: ' now' },
          ]
        : undefined;
    const onSubmit = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(false);
    await mount({ onSubmit, parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.searchState.submitSearchMatch(prompt);
    });

    const editor = container!.querySelector('.cm-content')!;
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);
  });
});
