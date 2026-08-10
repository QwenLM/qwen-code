// @vitest-environment jsdom

import { act, createRef } from 'react';
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
import type {
  MobileComposerBackend,
  SlashMenuState,
} from '../hooks/useComposerCore';
import type { UseDaemonFollowupSuggestionReturn } from '@qwen-code/webui/daemon-react-sdk';
import { ChatEditor, type ComposerToolbarAction } from './ChatEditor';
import { WebShellPortalRootContext } from '../portalRoot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

Element.prototype.scrollIntoView = vi.fn();

const mockComposerCoreState = vi.hoisted(() => ({
  composerTags: [] as WebShellComposerTag[],
  pastedImages: [] as Array<{ data: string; media_type: string }>,
  removeTopTag: vi.fn(),
}));

// Mock useWorkspace so BranchPickerPopover can render without a real provider.
vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({
      client: {
        workspaceGitBranches: vi.fn().mockResolvedValue({
          v: 1,
          local: [],
          remote: [],
          tags: [],
          recent: [],
          head: 'main',
          detached: false,
        }),
        workspaceGitCheckout: vi.fn().mockResolvedValue(undefined),
        workspaceGitCreateBranch: vi.fn().mockResolvedValue(undefined),
        workspaceGitPush: vi
          .fn()
          .mockResolvedValue({ success: true, output: '' }),
        workspaceGitPull: vi
          .fn()
          .mockResolvedValue({ success: true, output: '' }),
        workspaceByCwd: () => ({
          workspaceGit: vi.fn().mockResolvedValue({
            v: 2,
            branch: 'main',
            detached: false,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            hasUpstream: false,
            ahead: 0,
            behind: 0,
            stashCount: 0,
            operation: null,
            computedAt: 0,
          }),
          workspaceGitBranches: vi.fn().mockResolvedValue({
            v: 1,
            local: [],
            remote: [],
            tags: [],
            recent: [],
            head: 'main',
            detached: false,
          }),
          workspaceGitCheckout: vi.fn().mockResolvedValue(undefined),
          workspaceGitCreateBranch: vi.fn().mockResolvedValue(undefined),
          workspaceGitPush: vi
            .fn()
            .mockResolvedValue({ success: true, output: '' }),
          workspaceGitPull: vi
            .fn()
            .mockResolvedValue({ success: true, output: '' }),
          listWorkspaceSessions: vi.fn().mockResolvedValue([]),
        }),
      },
      capabilities: { features: [] },
    }),
  };
});

const composerCoreState = vi.hoisted(() => ({
  slashMenu: null as SlashMenuState | null,
  focus: vi.fn(),
  closeSlashMenu: vi.fn(),
  mobileComposer: null as unknown,
  openHistorySearch: vi.fn(),
  shellMode: false,
}));

const voiceButtonState = vi.hoisted(() => ({
  onActiveChange: undefined as ((active: boolean) => void) | undefined,
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
      mobileComposer: composerCoreState.mobileComposer,
      focus: composerCoreState.focus,
      submitText: vi.fn(),
      clearText: vi.fn(),
      getText: vi.fn(() => ''),
      hasInput: vi.fn(() => false),
      hasAttachments:
        mockComposerCoreState.pastedImages.length > 0 ||
        mockComposerCoreState.composerTags.length > 0,
      hasContent: false,
      canSubmit: false,
      pendingImageBatchCount: 0,
      imageDragActive: false,
      imageTransferHandlers: {},
      handle: {
        focus: vi.fn(),
        insertText: vi.fn(),
        setText: vi.fn(),
        clear: vi.fn(),
        retryLast: vi.fn(),
        addTags: vi.fn(),
        removeInlineTags: vi.fn(),
        submit: vi.fn(),
        hasAttachments: () =>
          mockComposerCoreState.pastedImages.length > 0 ||
          mockComposerCoreState.composerTags.length > 0,
      },
      pastedImages: mockComposerCoreState.pastedImages,
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
      shellMode: composerCoreState.shellMode,
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
        openHistorySearch: composerCoreState.openHistorySearch,
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

vi.mock('../voice/VoiceButton', () => ({
  VoiceButton: ({
    onActiveChange,
  }: {
    onActiveChange?: (active: boolean) => void;
  }) => {
    voiceButtonState.onActiveChange = onActiveChange;
    return <span data-testid="voice-button" />;
  },
}));

vi.mock('../live/LiveVoiceButton', () => ({
  LiveVoiceButton: () => <span data-testid="live-voice-button" />,
}));

vi.mock('./SpecularComposerEffect', () => ({
  SpecularComposerEffect: () => (
    <span data-web-shell-composer-specular aria-hidden="true" />
  ),
}));

const mounted: Array<{
  root: Root;
  container: HTMLDivElement;
  portalRoot: HTMLDivElement;
}> = [];

afterEach(() => {
  composerCoreState.slashMenu = null;
  composerCoreState.shellMode = false;
  composerCoreState.focus.mockReset();
  composerCoreState.closeSlashMenu.mockReset();
  composerCoreState.mobileComposer = null;
  composerCoreState.openHistorySearch.mockReset();
  voiceButtonState.onActiveChange = undefined;
  for (const { root, container, portalRoot } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
    portalRoot.remove();
  }
  mockComposerCoreState.composerTags = [];
  mockComposerCoreState.pastedImages = [];
  mockComposerCoreState.removeTopTag.mockReset();
  vi.useRealTimers();
});

function renderChatEditor(props: {
  composerTags?: WebShellComposerTag[];
  pastedImages?: Array<{ data: string; media_type: string }>;
  gitBranch?: string;
  workspaceName?: string;
  workspaceTitle?: string;
  visibleToolbarActions?: readonly ComposerToolbarAction[];
  renderComposerTagTooltip?: ComposerTagRenderer;
  onComposerTagClick?: ComposerTagClickHandler;
  currentMode?: string;
  currentModel?: string;
  availableModels?: Array<{ id: string; label?: string }>;
  sessionWorkflowEnabled?: boolean;
  onSelectMode?: (mode: string) => void;
  onSelectModel?: (model: string) => void;
  reasoningControlsSupported?: boolean;
  reasoningState?: {
    thinking?: { enabled: boolean };
    effort?: {
      value: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      options: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
    };
  };
  reasoningBusy?: Partial<Record<'thinking' | 'effort', boolean>>;
  onSelectReasoningOption?: (
    configId: 'thinking' | 'effort',
    value: string,
  ) => void;
  onAttachmentsChange?: (hasAttachments: boolean) => void;
  tokenCount?: number;
  contextWindow?: number;
  onShowContextUsage?: () => void;
  placeholderText?: string;
  animatePlaceholder?: boolean;
  disabled?: boolean;
  followupState?: UseDaemonFollowupSuggestionReturn['followupState'];
  customization?: WebShellCustomization;
}) {
  const {
    composerTags,
    pastedImages,
    customization,
    renderComposerTagTooltip,
    onComposerTagClick,
    ...chatEditorProps
  } = props;
  if (composerTags) {
    mockComposerCoreState.composerTags = composerTags;
  }
  if (pastedImages) {
    mockComposerCoreState.pastedImages = pastedImages;
  }
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

describe('ChatEditor voice toolbar integration', () => {
  it('keeps dictation and Live together when the host toolbar allows voice', () => {
    const defaults = renderChatEditor({});
    const voiceOnly = renderChatEditor({ visibleToolbarActions: ['voice'] });
    const hidden = renderChatEditor({ visibleToolbarActions: [] });

    for (const container of [defaults, voiceOnly]) {
      expect(
        container.querySelector('[data-testid="voice-button"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="live-voice-button"]'),
      ).not.toBeNull();
    }
    expect(hidden.querySelector('[data-testid="voice-button"]')).toBeNull();
    expect(
      hidden.querySelector('[data-testid="live-voice-button"]'),
    ).toBeNull();
  });
});

describe('ChatEditor context usage ring', () => {
  const ring = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(
      '[data-web-shell-context-usage]',
    );

  it('renders in toolbarRight before the voice actions', () => {
    const container = renderChatEditor({
      tokenCount: 34_298,
      contextWindow: 100_000,
      onShowContextUsage: vi.fn(),
    });

    const button = ring(container)!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe('34.3% context used');
    const liveVoice = container.querySelector(
      '[data-testid="live-voice-button"]',
    )!;
    // The ring sits immediately left of the voice cluster.
    expect(
      button.compareDocumentPosition(liveVoice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('is controlled by the contextUsage toolbar action', () => {
    const shown = renderChatEditor({
      tokenCount: 100,
      contextWindow: 1000,
      visibleToolbarActions: ['contextUsage'],
    });
    const hidden = renderChatEditor({
      tokenCount: 100,
      contextWindow: 1000,
      visibleToolbarActions: ['voice'],
    });

    expect(ring(shown)).not.toBeNull();
    expect(ring(hidden)).toBeNull();
  });

  it('stays hidden while usage or the context window is unknown', () => {
    const noUsage = renderChatEditor({ tokenCount: 0, contextWindow: 1000 });
    const noWindow = renderChatEditor({ tokenCount: 100, contextWindow: 0 });

    expect(ring(noUsage)).toBeNull();
    expect(ring(noWindow)).toBeNull();
  });

  it('opens the context breakdown when clicked', () => {
    const onShowContextUsage = vi.fn();
    const container = renderChatEditor({
      tokenCount: 100,
      contextWindow: 1000,
      onShowContextUsage,
    });

    act(() => {
      ring(container)!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onShowContextUsage).toHaveBeenCalledTimes(1);
  });

  it('shows the used/total detail in a tooltip on focus', async () => {
    const container = renderChatEditor({
      tokenCount: 53_600,
      contextWindow: 1_000_000,
      onShowContextUsage: vi.fn(),
    });

    await act(async () => {
      ring(container)!.focus();
    });

    expect(document.body.textContent).toContain('53.6k / 1.0M tokens (5.4%)');
    // The arrow must be the Radix-positioned element: a pseudo-element pinned
    // to the content center stops pointing at the trigger once collision
    // avoidance shifts the content near the viewport edge. jsdom has no
    // layout, so pin the positioning classes the rendered arrow depends on —
    // a shadcn regeneration that drops them would detach the arrow visually
    // while an existence check stayed green.
    const arrowClass = document
      .querySelector('[data-slot="tooltip-arrow"]')
      ?.getAttribute('class');
    expect(arrowClass).toContain('rotate-45');
    expect(arrowClass).toContain('translate-y-[calc(-50%_-_2px)]');
  });

  it('escalates the arc color at the /context panel thresholds', () => {
    const arcClass = (container: HTMLElement) =>
      ring(container)!.querySelectorAll('circle')[1].getAttribute('class') ??
      '';

    const warn = renderChatEditor({ tokenCount: 61, contextWindow: 100 });
    const error = renderChatEditor({ tokenCount: 81, contextWindow: 100 });
    const normal = renderChatEditor({ tokenCount: 60, contextWindow: 100 });
    // Both thresholds are strict: exactly 80% is still warning, matching the
    // /context panel.
    const atError = renderChatEditor({ tokenCount: 80, contextWindow: 100 });

    expect(arcClass(warn)).toContain('contextRingValueWarning');
    expect(arcClass(error)).toContain('contextRingValueError');
    expect(arcClass(normal)).not.toContain('Warning');
    expect(arcClass(normal)).not.toContain('Error');
    expect(arcClass(atError)).toContain('contextRingValueWarning');
    expect(arcClass(atError)).not.toContain('contextRingValueError');
  });

  it('caps the arc at 100% while the label keeps the real overflow', () => {
    const container = renderChatEditor({
      tokenCount: 150,
      contextWindow: 100,
    });

    const button = ring(container)!;
    expect(button.getAttribute('aria-label')).toBe('150.0% context used');
    const arc = button.querySelectorAll('circle')[1];
    expect(arc.getAttribute('stroke-dashoffset')).toBe('0');
  });
});

describe('ChatEditor animation layers', () => {
  it('mounts the inert specular layer without replacing composer controls', () => {
    const container = renderChatEditor({});

    expect(
      container.querySelector('[data-web-shell-composer-specular]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-web-shell-composer-editor]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-web-shell-composer-submit]'),
    ).not.toBeNull();
  });

  it('keeps the typewriter visible through automatic focus', () => {
    const container = renderChatEditor({});
    const editor = container.querySelector<HTMLElement>(
      '[data-web-shell-composer-editor]',
    );
    const outside = document.createElement('button');
    container.appendChild(outside);
    editor!.tabIndex = 0;

    act(() => editor!.focus());
    expect(container.querySelector('[data-typewriter-visible]')).not.toBeNull();

    act(() => {
      editor!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[data-typewriter-visible]')).toBeNull();

    act(() => outside.focus());
    expect(container.querySelector('[data-typewriter-visible]')).not.toBeNull();
  });

  it('plays the typewriter twice and then keeps the completed text', () => {
    vi.useFakeTimers();
    const container = renderChatEditor({ placeholderText: 'abc' });
    const typewriter = () =>
      container.querySelector('[data-web-shell-composer-typewriter]');

    expect(typewriter()?.textContent).toBe('_');

    act(() => vi.advanceTimersByTime(3 * 45));
    expect(typewriter()?.textContent).toBe('abc_');

    act(() => vi.advanceTimersByTime(3000));
    expect(typewriter()?.textContent).toBe('_');

    act(() => vi.advanceTimersByTime(3 * 45));
    expect(typewriter()?.textContent).toBe('abc_');

    act(() => vi.advanceTimersByTime(3001));
    expect(typewriter()?.textContent).toBe('abc_');
  });

  it('does not mount the typewriter for an empty placeholder', () => {
    const container = renderChatEditor({ placeholderText: '' });

    expect(
      container.querySelector('[data-web-shell-composer-typewriter]'),
    ).toBeNull();
    expect(container.querySelector('[data-typewriter-visible]')).toBeNull();
  });

  it('does not mount the typewriter when placeholder animation is disabled', () => {
    const container = renderChatEditor({
      placeholderText: 'abc',
      animatePlaceholder: false,
    });

    expect(
      container.querySelector('[data-web-shell-composer-typewriter]'),
    ).toBeNull();
    expect(container.querySelector('[data-typewriter-visible]')).toBeNull();
  });

  it('shows the full placeholder without a caret under prefers-reduced-motion', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as MediaQueryList,
    );
    try {
      const container = renderChatEditor({ placeholderText: 'abc' });
      const typewriter = container.querySelector(
        '[data-web-shell-composer-typewriter]',
      );

      expect(typewriter?.textContent).toBe('abc');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('replays the typewriter sequence after the empty editor loses focus', () => {
    vi.useFakeTimers();
    const container = renderChatEditor({ placeholderText: 'abc' });
    const editor = container.querySelector<HTMLElement>(
      '[data-web-shell-composer-editor]',
    );
    const outside = document.createElement('button');
    container.appendChild(outside);
    editor!.tabIndex = 0;
    const typewriter = () =>
      container.querySelector('[data-web-shell-composer-typewriter]');

    act(() => editor!.focus());
    act(() => {
      editor!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(typewriter()).toBeNull();

    act(() => outside.focus());
    expect(typewriter()?.textContent).toBe('_');

    act(() => vi.advanceTimersByTime(3 * 45));
    expect(typewriter()?.textContent).toBe('abc_');
  });

  it('hides the typewriter when disabled, in shell mode, or during a followup', () => {
    const typewriterOf = (container: HTMLElement) =>
      container.querySelector('[data-web-shell-composer-typewriter]');

    expect(
      typewriterOf(renderChatEditor({ placeholderText: 'abc' })),
    ).not.toBeNull();

    expect(
      typewriterOf(
        renderChatEditor({ placeholderText: 'abc', disabled: true }),
      ),
    ).toBeNull();

    composerCoreState.shellMode = true;
    expect(
      typewriterOf(renderChatEditor({ placeholderText: 'abc' })),
    ).toBeNull();
    composerCoreState.shellMode = false;

    expect(
      typewriterOf(
        renderChatEditor({
          placeholderText: 'abc',
          followupState: { suggestion: 'next', isVisible: true, shownAt: 0 },
        }),
      ),
    ).toBeNull();
  });
});

describe('ChatEditor attachment reporting', () => {
  it('reports whether the composer has tags or pasted images', () => {
    const onEmptyAttachmentsChange = vi.fn();
    renderChatEditor({
      onAttachmentsChange: onEmptyAttachmentsChange,
    });
    expect(onEmptyAttachmentsChange).toHaveBeenLastCalledWith(false);

    const onTaggedAttachmentsChange = vi.fn();
    renderChatEditor({
      composerTags: [
        {
          id: 'file:reference',
          kind: 'file',
          value: 'reference',
        },
      ],
      onAttachmentsChange: onTaggedAttachmentsChange,
    });
    expect(onTaggedAttachmentsChange).toHaveBeenLastCalledWith(true);

    const onImageAttachmentsChange = vi.fn();
    renderChatEditor({
      pastedImages: [{ data: 'abc', media_type: 'image/png' }],
      onAttachmentsChange: onImageAttachmentsChange,
    });
    expect(onImageAttachmentsChange).toHaveBeenLastCalledWith(true);

    const disabled = renderChatEditor({
      disabled: true,
      pastedImages: [{ data: 'abc', media_type: 'image/png' }],
    });
    expect(disabled.querySelector('img')?.nextElementSibling).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('ChatEditor composer tag icons', () => {
  it('renders built-in icons for top composer tags', () => {
    const kinds = ['extension', 'file', 'mcp', 'skill'] as const;
    const container = renderChatEditor({
      visibleToolbarActions: [],
      composerTags: kinds.map((kind) => ({
        id: `${kind}:reference`,
        kind,
        value: kind,
      })),
    });

    expect(
      container.querySelectorAll('[style*="--composer-tag-icon-url"]'),
    ).toHaveLength(kinds.length);
  });

  it('rejects unsafe custom icon URLs for top composer tags', () => {
    const container = renderChatEditor({
      visibleToolbarActions: [],
      composerTags: [
        {
          id: 'custom:reference',
          value: 'reference',
          icon: 'javascript:alert(1)',
        },
      ],
    });

    expect(container.innerHTML).not.toContain('javascript:alert');
    expect(
      container.querySelector('[style*="--composer-tag-icon-url"]'),
    ).toBeNull();
  });
});

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

describe('ChatEditor Session Workflow mode rename', () => {
  it('renames only the plan entry in the mode dropdown while enabled', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['approvalMode'],
      sessionWorkflowEnabled: true,
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-mode-button]')
        ?.click();
    });

    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    expect(popover).not.toBeNull();
    const labels = Array.from(popover?.querySelectorAll('button') ?? []).map(
      (button) => button.textContent ?? '',
    );
    expect(labels.some((label) => label.includes('Plan & Review (plan)'))).toBe(
      true,
    );
    expect(
      labels.some((label) => label.includes('Ask Approval (default)')),
    ).toBe(true);
    expect(labels.some((label) => label.includes('Plan (plan)'))).toBe(false);
  });

  it('renames the active plan mode chip while enabled', () => {
    const withWorkflow = renderChatEditor({
      currentMode: 'plan',
      sessionWorkflowEnabled: true,
    });
    expect(
      withWorkflow
        .querySelector('[data-toolbar-measure="mode:expanded"]')
        ?.textContent?.includes('Plan & Review'),
    ).toBe(true);

    const withoutWorkflow = renderChatEditor({ currentMode: 'plan' });
    expect(
      withoutWorkflow
        .querySelector('[data-toolbar-measure="mode:expanded"]')
        ?.textContent?.includes('Plan & Review'),
    ).toBe(false);
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

  it('shows qwen3.8-max thinking and three effort options in the model popover', () => {
    const routeId = 'qwen-route:v1:qwen38max';
    const onSelectReasoningOption = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: routeId,
      availableModels: [{ id: routeId, label: 'Qwen 3.8 Max' }],
      reasoningControlsSupported: true,
      reasoningState: {
        thinking: { enabled: true },
        effort: { value: 'xhigh', options: ['low', 'medium', 'xhigh'] },
      },
      onSelectReasoningOption,
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    expect(trigger?.textContent).toContain('Qwen 3.8 Max · Extra High');
    act(() => trigger?.click());

    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    expect(popover?.textContent).toContain('Thinking');
    expect(popover?.textContent).toContain('Low');
    expect(popover?.textContent).toContain('Medium');
    expect(popover?.textContent).toContain('Extra High');
    expect(
      popover?.querySelector('[data-web-shell-model-submenu-trigger]')
        ?.textContent,
    ).toContain('Qwen 3.8 Max');
    expect(popover?.querySelector('input[type="search"]')).toBeNull();

    const medium = Array.from(
      popover?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.trim() === 'Medium');
    act(() => medium?.click());
    expect(onSelectReasoningOption).toHaveBeenCalledWith('effort', 'medium');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });

  it('turns thinking off through the popover switch', () => {
    const onSelectReasoningOption = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'qwen-max',
      availableModels: [{ id: 'qwen-max', label: 'Qwen 3.8 Max' }],
      reasoningControlsSupported: true,
      reasoningState: {
        thinking: { enabled: true },
        effort: { value: 'xhigh', options: ['low', 'medium', 'xhigh'] },
      },
      onSelectReasoningOption,
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    act(() => trigger?.click());

    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    const thinkingSwitch =
      popover?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(thinkingSwitch).not.toBeNull();
    act(() => thinkingSwitch?.click());
    expect(onSelectReasoningOption).toHaveBeenCalledWith('thinking', 'off');
    // Changing an option keeps the popover open so an effort tier can be
    // picked in the same interaction.
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps effort rows visible but disabled while thinking is off', () => {
    const onSelectReasoningOption = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'qwen-max',
      availableModels: [{ id: 'qwen-max', label: 'Qwen 3.8 Max' }],
      reasoningControlsSupported: true,
      reasoningState: {
        thinking: { enabled: false },
        effort: { value: 'xhigh', options: ['low', 'medium', 'xhigh'] },
      },
      onSelectReasoningOption,
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    act(() => trigger?.click());

    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    const effortRows = Array.from(
      popover?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).filter((button) =>
      ['Low', 'Medium', 'Extra High'].includes(
        button.textContent?.trim() ?? '',
      ),
    );
    expect(effortRows).toHaveLength(3);
    for (const row of effortRows) {
      expect(row.disabled).toBe(true);
    }
    act(() => effortRows[0]?.click());
    expect(onSelectReasoningOption).not.toHaveBeenCalled();
  });

  it('disables the thinking switch and effort rows while busy', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'qwen-max',
      availableModels: [{ id: 'qwen-max', label: 'Qwen 3.8 Max' }],
      reasoningControlsSupported: true,
      reasoningState: {
        thinking: { enabled: true },
        effort: { value: 'xhigh', options: ['low', 'medium', 'xhigh'] },
      },
      reasoningBusy: { thinking: true, effort: true },
      onSelectReasoningOption: vi.fn(),
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    act(() => trigger?.click());

    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    const thinkingSwitch =
      popover?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(thinkingSwitch?.disabled).toBe(true);
    const effortRows = Array.from(
      popover?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).filter((button) =>
      ['Low', 'Medium', 'Extra High'].includes(
        button.textContent?.trim() ?? '',
      ),
    );
    expect(effortRows).toHaveLength(3);
    for (const row of effortRows) {
      expect(row.disabled).toBe(true);
    }
  });

  it('shows the thinking-off state on the model chip', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'qwen-max',
      availableModels: [{ id: 'qwen-max', label: 'Qwen 3.8 Max' }],
      reasoningControlsSupported: true,
      reasoningState: {
        thinking: { enabled: false },
        effort: { value: 'xhigh', options: ['low', 'medium', 'xhigh'] },
      },
      onSelectReasoningOption: vi.fn(),
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    expect(trigger?.textContent).toContain('Qwen 3.8 Max · Thinking Off');
  });

  it('opens model search as a second-level menu for reasoning models', () => {
    const onSelectModel = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'qwen-max',
      availableModels: [
        { id: 'qwen-max', label: 'Qwen Max' },
        { id: 'qwen-plus', label: 'Qwen Plus' },
      ],
      reasoningControlsSupported: true,
      reasoningState: {
        thinking: { enabled: true },
        effort: { value: 'xhigh', options: ['low', 'medium', 'xhigh'] },
      },
      onSelectReasoningOption: vi.fn(),
      onSelectModel,
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-model-button]')
        ?.click(),
    );
    const submenuTrigger = document.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-submenu-trigger]',
    );
    expect(submenuTrigger).not.toBeNull();
    expect(document.querySelector('input[type="search"]')).toBeNull();

    act(() => {
      submenuTrigger?.focus();
      submenuTrigger?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const search = document.querySelector<HTMLInputElement>(
      '[data-web-shell-model-submenu] input[type="search"]',
    );
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]')?.textContent,
    ).toContain('Thinking');
    expect(
      document.querySelector('[data-web-shell-model-submenu-back]'),
    ).toBeNull();

    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const reopenedSubmenuTrigger = document.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-submenu-trigger]',
    );
    expect(document.querySelector('[data-web-shell-model-submenu]')).toBeNull();
    expect(document.activeElement).toBe(reopenedSubmenuTrigger);
    act(() => reopenedSubmenuTrigger?.click());

    const plus = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-web-shell-model-submenu] button',
      ),
    ).find((button) => button.textContent?.trim() === 'Qwen Plus');
    act(() => plus?.click());
    expect(onSelectModel).toHaveBeenCalledWith('qwen-plus');
  });

  it('renders a thinking-only registered model without an effort section', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'thinking-only',
      availableModels: [{ id: 'thinking-only', label: 'Thinking Only' }],
      reasoningControlsSupported: true,
      reasoningState: { thinking: { enabled: true } },
      onSelectReasoningOption: vi.fn(),
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    expect(trigger?.textContent?.trim()).toBe('Thinking Only');
    act(() => trigger?.click());
    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    expect(popover?.querySelector('[role="switch"]')).not.toBeNull();
    expect(popover?.textContent).not.toContain('Effort');
  });

  it('renders an effort-only model using the daemon-provided tiers', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'effort-only',
      availableModels: [{ id: 'effort-only', label: 'Effort Only' }],
      reasoningControlsSupported: true,
      reasoningState: {
        effort: { value: 'max', options: ['high', 'max'] },
      },
      onSelectReasoningOption: vi.fn(),
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    expect(trigger?.textContent).toContain('Effort Only · Max');
    act(() => trigger?.click());
    const popover = document.querySelector('[data-web-shell-toolbar-popover]');
    expect(popover?.querySelector('[role="switch"]')).toBeNull();
    expect(popover?.textContent).toContain('High');
    expect(popover?.textContent).toContain('Max');
  });

  it('does not expose reasoning options for qwen3.8-max-preview', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'preview-route',
      availableModels: [{ id: 'preview-route', label: 'Qwen 3.8 Max Preview' }],
      reasoningControlsSupported: true,
      onSelectReasoningOption: vi.fn(),
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-model-button]')
        ?.click(),
    );
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]')?.textContent,
    ).not.toContain('Thinking');
  });

  it('exposes the complete model name on dropdown items for hover', () => {
    const modelLabel =
      'Qwen Very Long Model Name For Web Shell Reproduction 2026';
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'long-model',
      availableModels: [{ id: 'long-model', label: modelLabel }],
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-model-button]')
        ?.click();
    });

    const option = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-web-shell-toolbar-popover] button',
      ),
    ).find((button) => button.textContent?.includes(modelLabel));
    expect(option).not.toBeUndefined();
    expect(option?.title).toBe(modelLabel);
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

describe('ChatEditor mobile composer quick actions', () => {
  const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    'maxTouchPoints',
  );

  function withTouchDevice(run: () => void) {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 5,
      configurable: true,
    });
    try {
      run();
    } finally {
      if (originalMaxTouchPoints) {
        Object.defineProperty(
          Navigator.prototype,
          'maxTouchPoints',
          originalMaxTouchPoints,
        );
      } else {
        delete (navigator as unknown as Record<string, unknown>)[
          'maxTouchPoints'
        ];
      }
    }
  }

  function mobileComposerStub(): MobileComposerBackend {
    return {
      textareaRef: createRef<HTMLTextAreaElement>(),
      value: '',
      onChange: vi.fn(),
      onPaste: vi.fn(),
      placeholder: '',
    };
  }

  function openQuickActions(container: HTMLElement) {
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="more actions"]',
    );
    expect(toggle).not.toBeNull();
    act(() => toggle!.click());
  }

  it('maps the history quick action to the search UI on the mobile composer', () => {
    withTouchDevice(() => {
      composerCoreState.mobileComposer = mobileComposerStub();
      const container = renderChatEditor({});
      openQuickActions(container);

      const historyButton = Array.from(
        container.querySelectorAll('button'),
      ).find((button) => button.textContent === 'Question history');
      expect(historyButton).not.toBeUndefined();
      act(() => historyButton!.click());

      expect(composerCoreState.openHistorySearch).toHaveBeenCalledTimes(1);
    });
  });

  it('hides the keyboard shortcut hints grid on the mobile composer', () => {
    withTouchDevice(() => {
      composerCoreState.mobileComposer = mobileComposerStub();
      const mobileContainer = renderChatEditor({});
      openQuickActions(mobileContainer);
      expect(
        Array.from(mobileContainer.querySelectorAll('button')).some(
          (button) => button.textContent === 'Tab',
        ),
      ).toBe(false);

      composerCoreState.mobileComposer = null;
      const desktopContainer = renderChatEditor({});
      openQuickActions(desktopContainer);
      expect(
        Array.from(desktopContainer.querySelectorAll('button')).some(
          (button) => button.textContent === 'Tab',
        ),
      ).toBe(true);
    });
  });

  it('hides other toolbar actions while mobile voice capture is active', () => {
    withTouchDevice(() => {
      const container = renderChatEditor({
        currentModel: 'qwen-test',
        availableModels: [{ id: 'qwen-test' }],
      });

      expect(
        container.querySelector('[data-web-shell-toolbar-leading]'),
      ).toBeTruthy();
      expect(
        container.querySelector(
          'button[aria-label="more actions"][data-hide-during-mobile-voice]',
        ),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-web-shell-composer-submit]'),
      ).toBeTruthy();

      act(() => {
        voiceButtonState.onActiveChange?.(true);
      });

      expect(
        container.querySelector('[data-mobile-voice-active="true"]'),
      ).toBeTruthy();

      act(() => {
        voiceButtonState.onActiveChange?.(false);
      });

      expect(
        container.querySelector('[data-mobile-voice-active="true"]'),
      ).toBeFalsy();
    });
  });
});
