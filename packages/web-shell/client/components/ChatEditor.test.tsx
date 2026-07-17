// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebShellCustomizationProvider,
  type ComposerTagClickHandler,
  type ComposerTagRenderer,
  type WebShellComposerTag,
  type WebShellCustomization,
} from '../customization';
import { I18nProvider } from '../i18n';
import type { SlashMenuState } from '../hooks/useComposerCore';
import { ChatEditor, type ComposerToolbarAction } from './ChatEditor';
import { WebShellPortalRootContext } from '../portalRoot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

Element.prototype.scrollIntoView = vi.fn();

const mockComposerCoreState = vi.hoisted(() => ({
  composerTags: [] as WebShellComposerTag[],
  removeTopTag: vi.fn(),
}));

const composerCoreState = vi.hoisted(() => ({
  slashMenu: null as SlashMenuState | null,
  focus: vi.fn(),
  closeSlashMenu: vi.fn(),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

vi.mock('../hooks/useComposerCore', async (importOriginal) => {
  const React = await import('react');
  const actual =
    await importOriginal<typeof import('../hooks/useComposerCore')>();
  return {
    ...actual,
    useComposerCore: () => ({
      containerRef: React.createRef<HTMLDivElement>(),
      viewRef: { current: null },
      focus: composerCoreState.focus,
      submitText: vi.fn(),
      clearText: vi.fn(),
      getText: vi.fn(() => ''),
      hasInput: vi.fn(() => false),
      hasContent: false,
      handle: {
        focus: vi.fn(),
        insertText: vi.fn(),
        setText: vi.fn(),
        clear: vi.fn(),
        retryLast: vi.fn(),
        addTags: vi.fn(),
        removeInlineTags: vi.fn(),
        submit: vi.fn(),
      },
      pastedImages: [],
      removeImage: vi.fn(),
      composerTags: mockComposerCoreState.composerTags,
      removeTopTag: mockComposerCoreState.removeTopTag,
      addTags: vi.fn(),
      removeInlineTags: vi.fn(),
      insertText: vi.fn(),
      setText: vi.fn(),
      submit: vi.fn(),
      clear: vi.fn(),
      retryLast: vi.fn(),
      replaceEditorText: vi.fn(),
      shellMode: false,
      setShellMode: vi.fn(),
      toggleShellMode: vi.fn(),
      currentMode: 'default',
      sessionName: undefined,
      searchState: {
        searchMode: false,
        searchQuery: '',
        searchMatches: [],
        searchActiveIndex: 0,
        searchInputRef: React.createRef<HTMLInputElement>(),
        searchUiRef: React.createRef<HTMLDivElement>(),
        openHistorySearch: vi.fn(),
        closeSearch: vi.fn(),
        submitSearchMatch: vi.fn(),
        handleSearchKeyDown: vi.fn(),
        handleSearchInput: vi.fn(),
        handleSearchCompositionEnd: vi.fn(),
      },
      navigatePrevHistory: vi.fn(),
      navigateNextHistory: vi.fn(),
      showShortcutHints: false,
      followupState: { isVisible: false, suggestion: '' },
      disabled: false,
      onAcceptFollowup: vi.fn(),
      onDismissFollowup: vi.fn(),
      slashMenu: composerCoreState.slashMenu,
      closeSlashMenu: composerCoreState.closeSlashMenu,
      selectSlashCompletion: vi.fn(),
      acceptSlashCompletion: vi.fn(),
      atMenu: null,
      closeAtMenu: vi.fn(),
      selectAtCompletion: vi.fn(),
      acceptAtCompletion: vi.fn(),
      enterAtCategory: vi.fn(),
      backAtCategories: vi.fn(),
      updateAtSearch: vi.fn(),
      selectAtTab: vi.fn(),
    }),
  };
});

const mounted: Array<{
  root: Root;
  container: HTMLDivElement;
  portalRoot: HTMLDivElement;
}> = [];

afterEach(() => {
  composerCoreState.slashMenu = null;
  composerCoreState.focus.mockReset();
  composerCoreState.closeSlashMenu.mockReset();
  for (const { root, container, portalRoot } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
    portalRoot.remove();
  }
  mockComposerCoreState.composerTags = [];
  mockComposerCoreState.removeTopTag.mockReset();
});

function renderChatEditor(props: {
  gitBranch?: string;
  workspaceName?: string;
  workspaceTitle?: string;
  visibleToolbarActions?: readonly ComposerToolbarAction[];
  renderComposerTagTooltip?: ComposerTagRenderer;
  onComposerTagClick?: ComposerTagClickHandler;
  currentMode?: string;
  currentModel?: string;
  availableModels?: Array<{ id: string; label?: string }>;
  onSelectMode?: (mode: string) => void;
  onSelectModel?: (model: string) => void;
  customization?: WebShellCustomization;
}) {
  const {
    customization,
    renderComposerTagTooltip,
    onComposerTagClick,
    ...chatEditorProps
  } = props;
  const container = document.createElement('div');
  container.dataset.webShellRoot = '';
  const portalRoot = document.createElement('div');
  portalRoot.dataset.webShellPortalRoot = '';
  document.body.appendChild(container);
  document.body.appendChild(portalRoot);
  const root = createRoot(container);
  mounted.push({ root, container, portalRoot });

  act(() => {
    root.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <WebShellCustomizationProvider
          value={{
            ...customization,
            renderComposerTagTooltip,
            onComposerTagClick,
          }}
        >
          <I18nProvider language="en">
            <ChatEditor
              onSubmit={() => undefined}
              commands={[]}
              showChatWidthToggle={false}
              currentMode="default"
              currentModel="qwen"
              {...chatEditorProps}
            />
          </I18nProvider>
        </WebShellCustomizationProvider>
      </WebShellPortalRootContext.Provider>,
    );
  });

  return container;
}

describe('ChatEditor git branch toolbar integration', () => {
  it('shows the git branch indicator when the branch action is visible', () => {
    const container = renderChatEditor({
      gitBranch: 'feature/web-shell',
      visibleToolbarActions: ['gitBranch'],
    });

    expect(
      container.querySelector(
        '[aria-label="Current Git branch: feature/web-shell"]',
      ),
    ).not.toBeNull();
  });

  it('hides the git branch indicator without a branch or visible action', () => {
    expect(
      renderChatEditor({
        visibleToolbarActions: ['gitBranch'],
      }).querySelector('[aria-label^="Current Git branch:"]'),
    ).toBeNull();
    expect(
      renderChatEditor({
        gitBranch: 'main',
        visibleToolbarActions: [],
      }).querySelector('[aria-label^="Current Git branch:"]'),
    ).toBeNull();
  });
});

describe('ChatEditor workspace toolbar integration', () => {
  it('shows the workspace indicator when the workspace action is visible', () => {
    const container = renderChatEditor({
      workspaceName: 'api',
      workspaceTitle: '/work/api',
      visibleToolbarActions: ['workspace'],
    });
    const chip = container.querySelector('[aria-label="Workspace: api"]');
    expect(chip).not.toBeNull();
    // The full cwd is surfaced via the hover tooltip (mirroring the git branch
    // chip), not a native `title` attribute.
    expect(chip?.getAttribute('data-web-shell-workspace-title')).toBe(
      '/work/api',
    );
    expect(chip?.getAttribute('title')).toBeNull();
    expect(
      container.querySelector('[data-web-shell-workspace]'),
    ).not.toBeNull();
  });

  it('falls back to the workspace name for the tooltip when no title is given', () => {
    const container = renderChatEditor({
      workspaceName: 'api',
      visibleToolbarActions: ['workspace'],
    });
    // No `workspaceTitle` → the chip's tooltip uses the name itself.
    expect(
      container
        .querySelector('[data-web-shell-workspace]')
        ?.getAttribute('data-web-shell-workspace-title'),
    ).toBe('api');
  });

  it('hides the workspace indicator without a name or visible action', () => {
    expect(
      renderChatEditor({
        visibleToolbarActions: ['workspace'],
      }).querySelector('[aria-label^="Workspace:"]'),
    ).toBeNull();
    expect(
      renderChatEditor({
        workspaceName: 'api',
        visibleToolbarActions: [],
      }).querySelector('[aria-label^="Workspace:"]'),
    ).toBeNull();
  });

  it('renders the workspace chip before the git branch chip', () => {
    const container = renderChatEditor({
      gitBranch: 'main',
      workspaceName: 'api',
      workspaceTitle: '/work/api',
      visibleToolbarActions: ['workspace', 'gitBranch'],
    });
    const ws = container.querySelector('[data-web-shell-workspace]');
    const git = container.querySelector('[data-web-shell-git-branch]');
    expect(ws).not.toBeNull();
    expect(git).not.toBeNull();
    // The workspace chip must precede the git-branch chip in document order.
    expect(
      ws!.compareDocumentPosition(git!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('ChatEditor top composer tag tooltip', () => {
  it('activates the plain tag from click and keyboard with the outer tag rect', () => {
    mockComposerCoreState.composerTags = [
      { id: 'orders', label: 'Table', value: 'orders', removable: false },
    ];
    const onComposerTagClick = vi.fn();
    const container = renderChatEditor({
      onComposerTagClick,
      visibleToolbarActions: [],
    });
    const tag = container.querySelector<HTMLElement>(
      '[data-web-shell-composer-tag]',
    )!;
    const trigger = tag.querySelector<HTMLElement>(
      '[data-web-shell-composer-tag-trigger]',
    )!;
    const outerRect = { width: 200 } as DOMRect;
    const innerRect = { width: 120 } as DOMRect;
    tag.getBoundingClientRect = vi.fn(() => outerRect);
    trigger.getBoundingClientRect = vi.fn(() => innerRect);

    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });

    expect(onComposerTagClick).toHaveBeenCalledTimes(3);
    for (const [info] of onComposerTagClick.mock.calls) {
      expect(info).toMatchObject({
        tag: mockComposerCoreState.composerTags[0],
        placement: 'composer',
        readonly: false,
        anchorRect: outerRect,
      });
    }
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('removes a tag without activating it', () => {
    mockComposerCoreState.composerTags = [
      { id: 'orders', label: 'Table', value: 'orders' },
    ];
    const onComposerTagClick = vi.fn();
    const container = renderChatEditor({
      onComposerTagClick,
      visibleToolbarActions: [],
    });
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove orders"]',
    )!;

    act(() => {
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      remove.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
      );
      remove.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
      );
    });

    expect(mockComposerCoreState.removeTopTag).toHaveBeenCalledTimes(3);
    expect(mockComposerCoreState.removeTopTag).toHaveBeenCalledWith('orders');
    expect(onComposerTagClick).not.toHaveBeenCalled();
  });

  it('falls back to a plain tag when custom tooltip rendering throws', () => {
    mockComposerCoreState.composerTags = [
      { id: 'orders', label: 'Table', value: 'orders' },
    ];
    const error = new Error('bad composer tooltip');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = renderChatEditor({
      renderComposerTagTooltip: () => {
        throw error;
      },
      visibleToolbarActions: [],
    });

    expect(container.textContent).toContain('Table');
    expect(container.textContent).toContain('orders');
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] composer tag tooltip render failed',
      error,
    );
    warn.mockRestore();
  });

  it('opens custom content from a top tag in the configured portal root', () => {
    mockComposerCoreState.composerTags = [
      { id: 'orders', label: 'Table', value: 'orders' },
    ];
    const container = renderChatEditor({
      renderComposerTagTooltip: () => 'Table details',
      visibleToolbarActions: [],
    });
    const portalRoot = document.body.querySelector<HTMLElement>(
      '[data-web-shell-portal-root]',
    );
    const tag = container.querySelector<HTMLElement>(
      '[data-web-shell-composer-tag]',
    );
    const trigger = tag?.querySelector<HTMLElement>(
      '[data-web-shell-composer-tag-trigger]',
    );
    const removeButton = tag?.querySelector<HTMLButtonElement>('button');

    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('role')).toBeNull();
    expect(trigger?.tabIndex).toBe(0);
    expect(removeButton).not.toBeNull();
    expect(trigger?.contains(removeButton ?? null)).toBe(false);
    act(() => trigger?.focus());

    const content = portalRoot?.querySelector<HTMLElement>(
      '[data-web-shell-composer-tag-tooltip]',
    );
    const accessibleTooltip =
      portalRoot?.querySelector<HTMLElement>('[role="tooltip"]');
    expect(content).not.toBeNull();
    expect(content?.textContent).toContain('Table details');
    expect(container.contains(content ?? null)).toBe(false);
    expect(portalRoot?.contains(content ?? null)).toBe(true);
    expect(accessibleTooltip).not.toBeNull();
    expect(trigger?.getAttribute('aria-describedby')).toBe(
      accessibleTooltip?.id,
    );
    expect(tag?.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('ChatEditor toolbar popovers', () => {
  it('opens the approval mode popover and restores editor focus after selection', async () => {
    const onSelectMode = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['approvalMode'],
      onSelectMode,
    });
    const focusTarget = document.createElement('input');
    container.appendChild(focusTarget);
    composerCoreState.focus.mockImplementation(() => focusTarget.focus());

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-mode-button]')
        ?.click();
    });

    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    expect(popover).not.toBeNull();
    expect(popover?.getAttribute('data-side')).toBe('top');

    const yolo = Array.from(popover?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.includes('(yolo)'),
    );
    await act(async () => {
      yolo?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onSelectMode).toHaveBeenCalledWith('yolo');
    expect(document.activeElement).toBe(focusTarget);
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]'),
    ).toBeNull();
  });

  it('observes custom toolbar render roots when measuring available width', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const observed = new Set<Element>();
    globalThis.ResizeObserver = class ResizeObserverMock {
      constructor(_callback: ResizeObserverCallback) {}

      observe(element: Element) {
        observed.add(element);
      }

      unobserve() {}

      disconnect() {}
    };

    try {
      renderChatEditor({
        visibleToolbarActions: [],
        customization: {
          renderComposerToolbarStart: () => (
            <span data-test-toolbar-start>start</span>
          ),
          renderComposerToolbarEnd: () => (
            <span data-test-toolbar-end>end</span>
          ),
          renderComposerToolbarRight: () => (
            <span data-test-toolbar-right>right</span>
          ),
        },
      });

      expect(
        observed.has(document.querySelector('[data-test-toolbar-start]')!),
      ).toBe(true);
      expect(
        observed.has(document.querySelector('[data-test-toolbar-end]')!),
      ).toBe(true);
      expect(
        observed.has(document.querySelector('[data-test-toolbar-right]')!),
      ).toBe(true);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('opens a searchable model popover and selects the filtered model', () => {
    const onSelectModel = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      availableModels: [
        { id: 'qwen-plus', label: 'Qwen Plus' },
        { id: 'qwen-max', label: 'Qwen Max' },
      ],
      onSelectModel,
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-model-button]')
        ?.click();
    });

    const search = document.querySelector<HTMLInputElement>(
      '[data-web-shell-toolbar-popover] input[type="search"]',
    );
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);
    expect(search?.getAttribute('data-slot')).toBe('input');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(search, 'max');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-web-shell-toolbar-popover] button',
      ),
    );
    expect(options.map((option) => option.textContent)).toEqual(['Qwen Max']);
    act(() => options[0]?.click());

    expect(onSelectModel).toHaveBeenCalledWith('qwen-max');
  });

  it('displays the model label instead of an opaque route id', () => {
    const routeId = 'qwen-route:v1:abcdefghijklmnop';
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: routeId,
      availableModels: [{ id: routeId, label: 'Provider One' }],
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    expect(button?.textContent).toContain('Provider One');
    expect(button?.textContent).not.toContain(routeId);
  });

  it('switches between sibling toolbar popovers without dismissing the target', async () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['approvalMode', 'model'],
      currentModel: 'qwen-plus',
      availableModels: [{ id: 'qwen-plus', label: 'Qwen Plus' }],
    });
    const modeButton = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-mode-button]',
    );
    const modelButton = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );

    act(() => modeButton?.click());
    expect(modeButton?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      modelButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modelButton?.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelector(
        '[data-web-shell-toolbar-popover] input[type="search"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      modeButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modeButton?.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelector(
        '[data-web-shell-toolbar-popover] input[type="search"]',
      ),
    ).toBeNull();
  });
});

describe('ChatEditor slash command popovers', () => {
  it('uses shadcn popovers for the command panel and hover detail', () => {
    composerCoreState.slashMenu = {
      kind: 'command',
      from: 0,
      to: 1,
      query: '',
      selectedIndex: 0,
      items: [
        {
          id: 'help',
          label: '/help',
          apply: '/help',
          detail: 'Show available commands',
          section: 'Commands',
        },
        {
          id: 'history-collapse',
          label: '/history collapse-on-resume',
          apply: '/history collapse-on-resume',
          section: 'Commands',
        },
      ],
    };

    renderChatEditor({ visibleToolbarActions: [] });

    const panel = document.querySelector('[data-web-shell-slash-menu]');
    expect(panel?.getAttribute('data-slot')).toBe('popover-content');
    expect(
      panel
        ?.querySelectorAll('[role="option"]')[1]
        ?.hasAttribute('data-has-description'),
    ).toBe(false);

    const composingEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => document.body.dispatchEvent(composingEscape));
    expect(composingEscape.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-web-shell-slash-menu]')).toBe(panel);

    const command = panel?.querySelector<HTMLButtonElement>('[role="option"]');
    act(() => {
      command?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const detail = document.querySelector('[data-web-shell-slash-detail]');
    expect(detail?.getAttribute('data-slot')).toBe('popover-content');
    expect(detail?.textContent).toContain('Show available commands');

    act(() => {
      detail?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(composerCoreState.closeSlashMenu).not.toHaveBeenCalled();
  });
});
