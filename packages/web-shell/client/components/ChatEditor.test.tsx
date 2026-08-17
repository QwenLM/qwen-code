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
    useOptionalWorkspace: () => uploadWorkspaceState.current,
  };
});

const composerCoreState = vi.hoisted(() => ({
  slashMenu: null as SlashMenuState | null,
  focus: vi.fn(),
  closeSlashMenu: vi.fn(),
  mobileComposer: null as unknown,
  openHistorySearch: vi.fn(),
  imageDropCapture: vi.fn(),
  clearImageDragState: vi.fn(),
  addTags: vi.fn(),
  shellMode: false,
  imageDragActive: false,
  onFileUploadRequest: undefined as
    | ((targetDir: string, restoreQuery?: () => void) => void)
    | undefined,
  workspaceUploadBusy: false,
}));

// Controllable `useOptionalWorkspace()` value for file-upload gating tests.
// Defaults to undefined (upload disabled) so existing tests are unaffected.
const uploadWorkspaceState = vi.hoisted(() => ({
  current: undefined as
    | {
        client: {
          uploadWorkspaceFile: ReturnType<typeof vi.fn>;
          workspaceByCwd?: (cwd: string) => {
            uploadWorkspaceFile: ReturnType<typeof vi.fn>;
          };
        };
        capabilities: {
          features: string[];
          limits?: { maxWorkspaceFileUploadBytes: number };
          workspaces?: Array<{
            cwd: string;
            primary: boolean;
            trusted: boolean;
          }>;
        };
      }
    | undefined,
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
    useComposerCore: (options?: {
      onFileUploadRequest?: (
        targetDir: string,
        restoreQuery?: () => void,
      ) => void;
      workspaceUploadBusy?: boolean;
    }) => {
      composerCoreState.onFileUploadRequest = options?.onFileUploadRequest;
      composerCoreState.workspaceUploadBusy =
        options?.workspaceUploadBusy ?? false;
      return {
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
        imageDragActive: composerCoreState.imageDragActive,
        clearImageDragState: composerCoreState.clearImageDragState,
        imageTransferHandlers: {
          onDropCapture: composerCoreState.imageDropCapture,
        },
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
        addTags: composerCoreState.addTags,
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
      };
    },
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
  composerCoreState.imageDropCapture.mockReset();
  composerCoreState.clearImageDragState.mockReset();
  composerCoreState.addTags.mockReset();
  composerCoreState.imageDragActive = false;
  composerCoreState.onFileUploadRequest = undefined;
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

interface ChatEditorRenderProps {
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
  onAttachmentsChange?: (hasAttachments: boolean) => void;
  onImagePreview?: (src: string, alt?: string) => void;
  tokenCount?: number;
  contextWindow?: number;
  onShowContextUsage?: () => void;
  placeholderText?: string;
  animatePlaceholder?: boolean;
  disabled?: boolean;
  atWorkspaceCwd?: string;
  sessionId?: string;
  followupState?: UseDaemonFollowupSuggestionReturn['followupState'];
  customization?: WebShellCustomization;
}

function renderChatEditorInto(
  root: Root,
  portalRoot: HTMLDivElement,
  props: ChatEditorRenderProps,
) {
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
}

function renderChatEditor(props: ChatEditorRenderProps) {
  const container = document.createElement('div');
  container.dataset.webShellRoot = '';
  const portalRoot = document.createElement('div');
  portalRoot.dataset.webShellPortalRoot = '';
  document.body.appendChild(container);
  document.body.appendChild(portalRoot);
  const root = createRoot(container);
  mounted.push({ root, container, portalRoot });
  renderChatEditorInto(root, portalRoot, props);

  return container;
}

// Re-render an already-mounted editor with new props (e.g. to switch the
// upload target while a picker session is conceptually open).
function rerenderChatEditor(
  container: HTMLDivElement,
  props: ChatEditorRenderProps,
) {
  const entry = mounted.find((m) => m.container === container);
  if (!entry) throw new Error('container is not mounted by renderChatEditor');
  renderChatEditorInto(entry.root, entry.portalRoot, props);
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

  it('opens the image preview when a pasted image is clicked', () => {
    const onImagePreview = vi.fn();
    const container = renderChatEditor({
      pastedImages: [{ data: 'abc', media_type: 'image/png' }],
      onImagePreview,
    });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    act(() => img!.click());
    expect(onImagePreview).toHaveBeenCalledWith('data:image/png;base64,abc');
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

describe('ChatEditor file upload gating', () => {
  const makeWorkspace = (
    features: string[],
    trusted = true,
    maxUploadBytes = 50 * 1024 * 1024,
  ) => ({
    client: { uploadWorkspaceFile: vi.fn() },
    capabilities: {
      features,
      limits: { maxWorkspaceFileUploadBytes: maxUploadBytes },
      workspaces: [{ cwd: '/workspace', primary: true, trusted }],
    },
  });

  const dispatchDrag = (
    target: Element,
    type: string,
    types: string[],
    files: File[] = [],
    items?: Array<{ file: File; isDirectory?: boolean }>,
  ) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    // When `items` is provided it mimics the DataTransfer items API (how
    // browsers expose dropped folders); without it the handler falls back to
    // `dataTransfer.files`.
    const transferItems = items?.map(({ file, isDirectory }) => ({
      kind: 'file',
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory: isDirectory === true }),
    }));
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types,
        files,
        ...(transferItems ? { items: transferItems } : {}),
      },
    });
    act(() => target.dispatchEvent(event));
    return event;
  };

  afterEach(() => {
    uploadWorkspaceState.current = undefined;
  });

  it('enables the upload entry point when the capability is present', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({});
    expect(
      container.querySelector('[data-web-shell-upload-input]'),
    ).not.toBeNull();
  });

  it('fileUploadEnabled={false} force-disables even with the capability', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({
      customization: { fileUploadEnabled: false },
    });
    expect(container.querySelector('[data-web-shell-upload-input]')).toBeNull();
    expect(composerCoreState.onFileUploadRequest).toBeUndefined();
  });

  it('fileUploadEnabled={true} still requires the capability (AND, not override)', () => {
    // No workspace_file_upload capability: upload stays disabled even though
    // the host prop opts in — the prop does not bypass the capability check.
    uploadWorkspaceState.current = makeWorkspace([]);
    const container = renderChatEditor({
      customization: { fileUploadEnabled: true },
    });
    expect(container.querySelector('[data-web-shell-upload-input]')).toBeNull();
    expect(composerCoreState.onFileUploadRequest).toBeUndefined();
  });

  it('stays disabled without the capability and without the prop', () => {
    uploadWorkspaceState.current = makeWorkspace([]);
    const container = renderChatEditor({});
    expect(container.querySelector('[data-web-shell-upload-input]')).toBeNull();
    expect(composerCoreState.onFileUploadRequest).toBeUndefined();
  });

  it('stays disabled for an untrusted legacy-primary workspace', () => {
    uploadWorkspaceState.current = makeWorkspace(
      ['workspace_file_upload'],
      false,
    );
    const container = renderChatEditor({});
    expect(container.querySelector('[data-web-shell-upload-input]')).toBeNull();
    expect(composerCoreState.onFileUploadRequest).toBeUndefined();
  });

  it('does not intercept non-file drops', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({});
    const surface = container.querySelector(
      '[data-web-shell-composer-surface]',
    )!;
    const event = dispatchDrag(surface, 'drop', ['text/plain']);
    expect(event.defaultPrevented).toBe(false);
  });

  it('clears the file-drop overlay when dragleave omits data-transfer types', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({});
    const surface = container.querySelector(
      '[data-web-shell-composer-surface]',
    )!;
    dispatchDrag(surface, 'dragenter', ['Files']);
    expect(
      container.querySelector('[data-web-shell-upload-drop-overlay]'),
    ).not.toBeNull();

    dispatchDrag(surface, 'dragleave', []);
    expect(
      container.querySelector('[data-web-shell-upload-drop-overlay]'),
    ).toBeNull();
  });

  it('keeps the overlay until nested dragenter depth fully drains', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({});
    const surface = container.querySelector(
      '[data-web-shell-composer-surface]',
    )!;
    dispatchDrag(surface, 'dragenter', ['Files']);
    dispatchDrag(surface, 'dragenter', ['Files']);
    dispatchDrag(surface, 'dragleave', ['Files']);
    expect(
      container.querySelector('[data-web-shell-upload-drop-overlay]'),
    ).not.toBeNull();
    dispatchDrag(surface, 'dragleave', ['Files']);
    expect(
      container.querySelector('[data-web-shell-upload-drop-overlay]'),
    ).toBeNull();
  });

  it('clears the upload drag state on window dragend and blur', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({});
    const surface = container.querySelector(
      '[data-web-shell-composer-surface]',
    )!;
    for (const type of ['dragend', 'blur']) {
      dispatchDrag(surface, 'dragenter', ['Files']);
      expect(
        container.querySelector('[data-web-shell-upload-drop-overlay]'),
      ).not.toBeNull();
      act(() => {
        window.dispatchEvent(new Event(type));
      });
      expect(
        container.querySelector('[data-web-shell-upload-drop-overlay]'),
      ).toBeNull();
    }
  });

  it('suppresses the image-drag highlight while an upload drag is active', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    composerCoreState.imageDragActive = true;
    const container = renderChatEditor({});
    const surface = container.querySelector(
      '[data-web-shell-composer-surface]',
    )!;
    expect(surface.getAttribute('data-image-drag-active')).toBe('true');

    dispatchDrag(surface, 'dragenter', ['Files']);
    expect(surface.getAttribute('data-upload-drag-active')).toBe('true');
    expect(surface.hasAttribute('data-image-drag-active')).toBe(false);

    dispatchDrag(surface, 'dragleave', ['Files']);
    expect(surface.hasAttribute('data-upload-drag-active')).toBe(false);
    expect(surface.getAttribute('data-image-drag-active')).toBe('true');
  });

  it('ignores file drag-and-drop while the composer is disabled', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({ disabled: true });
    const surface = container.querySelector(
      '[data-web-shell-composer-surface]',
    )!;
    const editor = surface.querySelector('[data-web-shell-composer-editor]')!;

    dispatchDrag(editor, 'dragenter', ['Files']);
    expect(
      container.querySelector('[data-web-shell-upload-drop-overlay]'),
    ).toBeNull();

    const drop = dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [new File(['abc'], 'report.txt')],
    );
    // Cancelled so the browser cannot navigate to the dropped file, but
    // nothing is ingested on any lane.
    expect(drop.defaultPrevented).toBe(true);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(composerCoreState.addTags).not.toHaveBeenCalled();
    expect(composerCoreState.imageDropCapture).not.toHaveBeenCalled();
  });

  it('keeps capability-off file drops on the legacy image lane', () => {
    const workspace = makeWorkspace([]);
    uploadWorkspaceState.current = workspace;
    composerCoreState.imageDropCapture.mockImplementation((event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const drop = dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [new File(['x'], 'notes.txt')],
    );
    expect(drop.defaultPrevented).toBe(true);
    expect(composerCoreState.imageDropCapture).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(composerCoreState.addTags).not.toHaveBeenCalled();
    expect(container.querySelector('[data-web-shell-upload-strip]')).toBeNull();
  });

  it('routes mixed image-and-file drops to the upload path', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const drop = dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [
        new File(['png'], 'photo.png', { type: 'image/png' }),
        new File(['csv'], 'data.csv', { type: 'text/csv' }),
      ],
    );
    expect(drop.defaultPrevented).toBe(true);
    expect(composerCoreState.imageDropCapture).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-web-shell-upload-strip]'),
    ).not.toBeNull();
    await act(async () => {});
    // Both dropped files enter the upload batch — image-media files are not
    // filtered out of mixed drops.
    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it('intercepts file drops before the editor and renders status above it', () => {
    const workspace = makeWorkspace(['workspace_file_upload'], true, 1);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const surface = container.querySelector(
      '[data-web-shell-composer-surface]',
    )!;
    const editor = surface.querySelector('[data-web-shell-composer-editor]')!;
    const editorDrop = vi.fn();
    editor.addEventListener('drop', editorDrop);
    const drop = dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [new File(['xx'], 'large.txt')],
    );

    const strip = container.querySelector('[data-web-shell-upload-strip]');
    expect(drop.defaultPrevented).toBe(true);
    expect(editorDrop).not.toHaveBeenCalled();
    expect(composerCoreState.imageDropCapture).not.toHaveBeenCalled();
    expect(composerCoreState.clearImageDragState).toHaveBeenCalledTimes(1);
    expect(strip).not.toBeNull();
    expect(strip?.nextElementSibling).toBe(surface);
    expect(surface.contains(strip)).toBe(false);
    // The daemon-advertised 1-byte cap must reach the size pre-check: the
    // 2-byte file fails locally and is never sent.
    expect(strip?.querySelector('[data-status="error"]')).not.toBeNull();
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('cancels file drops on the upload strip so the tab cannot navigate', () => {
    // The 1-byte cap yields a persistent error row without any HTTP call, so
    // the strip — which renders outside the drop-handling surface — exists.
    const workspace = makeWorkspace(['workspace_file_upload'], true, 1);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    dispatchDrag(editor, 'drop', ['Files'], [new File(['xx'], 'large.txt')]);
    const strip = container.querySelector('[data-web-shell-upload-strip]')!;
    expect(strip).not.toBeNull();

    // Without the shell-level guard the browser navigates the tab to a file
    // released over the strip, tearing down the SPA mid-turn.
    const dragOver = dispatchDrag(strip, 'dragover', ['Files']);
    expect(dragOver.defaultPrevented).toBe(true);
    const drop = dispatchDrag(
      strip,
      'drop',
      ['Files'],
      [new File(['yy'], 'other.txt')],
    );
    expect(drop.defaultPrevented).toBe(true);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('uploads picker selections into the captured directory and inserts a tag', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'docs/notes.txt',
      sizeBytes: 3,
      hash: `sha256:${'a'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const input = container.querySelector<HTMLInputElement>(
      '[data-web-shell-upload-input]',
    )!;

    // The @ panel's Upload item captures the browsed directory, then clicks
    // the hidden input.
    act(() => {
      composerCoreState.onFileUploadRequest?.('docs');
    });
    Object.defineProperty(input, 'files', {
      value: [new File(['abc'], 'notes.txt')],
      configurable: true,
    });
    // jsdom (like browsers) rejects non-empty programmatic values on file
    // inputs, so shadow the accessor to observe the handler's reset.
    let inputValue = 'C:\\fakepath\\notes.txt';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => inputValue,
      set: (next: string) => {
        inputValue = next;
      },
    });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});

    // Clearing the input lets re-selecting the same file fire a new change
    // event in real browsers.
    expect(input.value).toBe('');

    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile.mock.calls[0][0].path).toBe(
      'docs/notes.txt',
    );
    expect(composerCoreState.addTags).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          kind: 'file',
          value: 'docs/notes.txt',
        }),
      ],
      { placement: 'inline', position: 'end' },
    );
  });

  it('restores the removed mention when the upload picker is canceled', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({});
    const input = container.querySelector<HTMLInputElement>(
      '[data-web-shell-upload-input]',
    )!;

    // The @ panel passes a restore callback for the mention it deleted
    // before opening the picker; a canceled picker must invoke it exactly
    // once (one picker session, one undo).
    const restore = vi.fn();
    act(() => {
      composerCoreState.onFileUploadRequest?.('docs', restore);
    });
    act(() => {
      input.dispatchEvent(new Event('cancel'));
    });
    expect(restore).toHaveBeenCalledTimes(1);

    act(() => {
      input.dispatchEvent(new Event('cancel'));
    });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('does not restore the mention once the picker produced a change', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'notes.txt',
      sizeBytes: 3,
      hash: `sha256:${'a'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const input = container.querySelector<HTMLInputElement>(
      '[data-web-shell-upload-input]',
    )!;

    const restore = vi.fn();
    act(() => {
      composerCoreState.onFileUploadRequest?.('docs', restore);
    });
    Object.defineProperty(input, 'files', {
      value: [new File(['abc'], 'notes.txt')],
      configurable: true,
    });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Flush the upload this change started: without it the pending promise
    // resolves after the test body (state updates outside act, a dismiss
    // timer firing into a later test), and every sibling test flushes too.
    await act(async () => {});
    act(() => {
      input.dispatchEvent(new Event('cancel'));
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it('ignores picker changes whose captured target no longer matches', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const input = container.querySelector<HTMLInputElement>(
      '[data-web-shell-upload-input]',
    )!;

    // The captured key never matches the current target when the picker was
    // not opened for it (e.g. the workspace switched while the OS picker
    // was open): the stale-target guard must block the upload.
    Object.defineProperty(input, 'files', {
      value: [new File(['abc'], 'notes.txt')],
      configurable: true,
    });
    let inputValue = 'C:\\fakepath\\notes.txt';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => inputValue,
      set: (next: string) => {
        inputValue = next;
      },
    });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Positive control: the handler ran (it always clears the input), so
    // the negative assertion proves the stale-target guard blocked it.
    expect(input.value).toBe('');
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('keeps supported image drops on the image attachment path', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    composerCoreState.imageDropCapture.mockImplementation((event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const drop = dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [new File(['png'], 'photo.png', { type: 'image/png' })],
    );

    expect(drop.defaultPrevented).toBe(true);
    expect(composerCoreState.imageDropCapture).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('inserts a successful upload as an inline file tag', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'report (1).txt',
      sizeBytes: 3,
      hash: `sha256:${'c'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;

    dispatchDrag(editor, 'drop', ['Files'], [new File(['abc'], 'report.txt')]);
    await act(async () => {});

    expect(composerCoreState.addTags).toHaveBeenCalledWith(
      [
        {
          id: 'file:@report\\ \\(1\\).txt',
          kind: 'file',
          value: 'report (1).txt',
          serialized: '@report\\ \\(1\\).txt',
        },
      ],
      { placement: 'inline', position: 'end' },
    );
    // The strip must explain why the final name differs from the drop.
    const row = container.querySelector(
      '[data-web-shell-upload-strip] [data-status="done"]',
    );
    expect(row?.textContent).toContain('Saved as report (1).txt');
  });

  it('shows the plain Uploaded copy when the file kept its name', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'report.txt',
      sizeBytes: 3,
      hash: `sha256:${'e'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;

    dispatchDrag(editor, 'drop', ['Files'], [new File(['abc'], 'report.txt')]);
    await act(async () => {});

    const row = container.querySelector(
      '[data-web-shell-upload-strip] [data-status="done"]',
    );
    expect(row?.textContent).toContain('Uploaded');
    expect(row?.textContent).not.toContain('Saved as');
  });

  it('falls back to the 50 MiB default when a capable daemon omits the limit', async () => {
    const workspace = {
      client: { uploadWorkspaceFile: vi.fn() },
      capabilities: {
        features: ['workspace_file_upload'],
        workspaces: [{ cwd: '/workspace', primary: true, trusted: true }],
      },
    };
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'small.txt',
      sizeBytes: 2,
      hash: `sha256:${'a'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;

    const oversized = new File(['x'], 'big.bin');
    Object.defineProperty(oversized, 'size', {
      value: 50 * 1024 * 1024 + 1,
    });
    dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [oversized, new File(['ok'], 'small.txt')],
    );
    await act(async () => {});

    const strip = container.querySelector('[data-web-shell-upload-strip]');
    expect(strip?.textContent).toContain(
      'File exceeds the 50 MiB upload limit',
    );
    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile.mock.calls[0][0].path).toBe(
      'small.txt',
    );
  });

  it('skips dropped folders instead of publishing phantom files', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'data.csv',
      sizeBytes: 3,
      hash: `sha256:${'a'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const folder = new File([], 'myfolder');
    const file = new File(['csv'], 'data.csv', { type: 'text/csv' });
    const drop = dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [folder, file],
      [{ file: folder, isDirectory: true }, { file }],
    );
    await act(async () => {});

    expect(drop.defaultPrevented).toBe(true);
    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile.mock.calls[0][0].path).toBe(
      'data.csv',
    );
    expect(composerCoreState.addTags).toHaveBeenCalledTimes(1);
  });

  it('routes folder-only drops to the image lane without uploading', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const folder = new File([], 'myfolder');
    dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [folder],
      [{ file: folder, isDirectory: true }],
    );

    expect(composerCoreState.imageDropCapture).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('gates the composer submit while an upload is in flight', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    let resolveUpload!: (
      value: Awaited<ReturnType<typeof workspace.client.uploadWorkspaceFile>>,
    ) => void;
    workspace.client.uploadWorkspaceFile.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    expect(composerCoreState.workspaceUploadBusy).toBe(false);

    dispatchDrag(editor, 'drop', ['Files'], [new File(['abc'], 'notes.txt')]);
    await act(async () => {});
    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(composerCoreState.workspaceUploadBusy).toBe(true);

    await act(async () => {
      resolveUpload({
        kind: 'file_upload',
        path: 'notes.txt',
        sizeBytes: 3,
        hash: `sha256:${'a'.repeat(64)}`,
      });
    });
    expect(composerCoreState.workspaceUploadBusy).toBe(false);
  });

  it('cancels an in-flight upload when the session switches', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    let signal: AbortSignal | undefined;
    workspace.client.uploadWorkspaceFile.mockImplementation((req) => {
      signal = req.signal;
      return new Promise(() => {});
    });
    uploadWorkspaceState.current = workspace;
    composerCoreState.addTags.mockClear();
    const container = renderChatEditor({ sessionId: 'session-a' });
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;

    dispatchDrag(editor, 'drop', ['Files'], [new File(['abc'], 'notes.txt')]);
    await act(async () => {});
    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-web-shell-upload-strip]'),
    ).not.toBeNull();

    // Same workspace, different session: the shared ChatEditor now shows
    // session B's draft, so session A's upload must be canceled instead of
    // appending its @file reference to session B's draft on completion.
    rerenderChatEditor(container, { sessionId: 'session-b' });
    await act(async () => {});
    expect(signal?.aborted).toBe(true);
    expect(container.querySelector('[data-web-shell-upload-strip]')).toBeNull();

    await act(async () => {});
    expect(composerCoreState.addTags).not.toHaveBeenCalled();
  });

  it('blocks a picker selection after switching sessions', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({ sessionId: 'session-a' });
    const input = container.querySelector<HTMLInputElement>(
      '[data-web-shell-upload-input]',
    )!;
    const restore = vi.fn();
    act(() => {
      composerCoreState.onFileUploadRequest?.('docs', restore);
    });

    rerenderChatEditor(container, { sessionId: 'session-b' });
    // The target switch flushed the pending restore synchronously, handing
    // the typed query back to session A's draft BEFORE the swap persists it;
    // the later picker event must find nothing left to restore.
    expect(restore).toHaveBeenCalledOnce();

    Object.defineProperty(input, 'files', {
      value: [new File(['abc'], 'notes.txt')],
      configurable: true,
    });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});

    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
  });

  it('restores the mention when every picker selection is locally rejected', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const input = container.querySelector<HTMLInputElement>(
      '[data-web-shell-upload-input]',
    )!;

    const restore = vi.fn();
    act(() => {
      composerCoreState.onFileUploadRequest?.('docs', restore);
    });
    const oversized = new File(['x'], 'big.bin');
    Object.defineProperty(oversized, 'size', {
      value: 50 * 1024 * 1024 + 1,
    });
    Object.defineProperty(input, 'files', {
      value: [oversized],
      configurable: true,
    });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});

    // Nothing was queued, so the picker closed without any upload and the
    // consumed restore must give the typed query back.
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  describe('qualified upload targeting', () => {
    const makeQualifiedWorkspace = (
      features: string[],
      workspaces: Array<{ cwd: string; primary: boolean; trusted: boolean }>,
    ) => {
      const qualifiedClient = { uploadWorkspaceFile: vi.fn() };
      qualifiedClient.uploadWorkspaceFile.mockResolvedValue({
        kind: 'file_upload',
        path: 'report.txt',
        sizeBytes: 3,
        hash: `sha256:${'a'.repeat(64)}`,
      });
      const workspaceByCwd = vi.fn(() => qualifiedClient);
      const workspace = {
        client: { uploadWorkspaceFile: vi.fn(), workspaceByCwd },
        capabilities: {
          features,
          limits: { maxWorkspaceFileUploadBytes: 50 * 1024 * 1024 },
          workspaces,
        },
      };
      return { workspace, qualifiedClient, workspaceByCwd };
    };
    const qualifiedFeatures = [
      'workspace_file_upload',
      'workspace_qualified_rest_core',
    ];
    const primaryAndSecondary = [
      { cwd: '/workspace', primary: true, trusted: true },
      { cwd: '/secondary', primary: false, trusted: true },
    ];

    it('routes the upload through the qualified client for a trusted cwd match', async () => {
      const { workspace, qualifiedClient, workspaceByCwd } =
        makeQualifiedWorkspace(qualifiedFeatures, primaryAndSecondary);
      uploadWorkspaceState.current = workspace;
      const container = renderChatEditor({ atWorkspaceCwd: '/secondary' });
      expect(
        container.querySelector('[data-web-shell-upload-input]'),
      ).not.toBeNull();
      const editor = container.querySelector(
        '[data-web-shell-composer-editor]',
      )!;

      dispatchDrag(
        editor,
        'drop',
        ['Files'],
        [new File(['abc'], 'report.txt')],
      );
      await act(async () => {});

      expect(workspaceByCwd).toHaveBeenCalledWith('/secondary');
      expect(qualifiedClient.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
      expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
    });

    it('stays disabled without the qualified-rest capability', () => {
      const { workspace } = makeQualifiedWorkspace(
        ['workspace_file_upload'],
        primaryAndSecondary,
      );
      uploadWorkspaceState.current = workspace;
      const container = renderChatEditor({ atWorkspaceCwd: '/secondary' });
      expect(
        container.querySelector('[data-web-shell-upload-input]'),
      ).toBeNull();
    });

    it('stays disabled when the cwd matches more than one workspace', () => {
      const { workspace } = makeQualifiedWorkspace(qualifiedFeatures, [
        { cwd: '/secondary', primary: false, trusted: true },
        { cwd: '/secondary', primary: false, trusted: true },
      ]);
      uploadWorkspaceState.current = workspace;
      const container = renderChatEditor({ atWorkspaceCwd: '/secondary' });
      expect(
        container.querySelector('[data-web-shell-upload-input]'),
      ).toBeNull();
    });

    it('stays disabled when the matching workspace is untrusted', () => {
      const { workspace } = makeQualifiedWorkspace(qualifiedFeatures, [
        { cwd: '/workspace', primary: true, trusted: true },
        { cwd: '/secondary', primary: false, trusted: false },
      ]);
      uploadWorkspaceState.current = workspace;
      const container = renderChatEditor({ atWorkspaceCwd: '/secondary' });
      expect(
        container.querySelector('[data-web-shell-upload-input]'),
      ).toBeNull();
    });

    it('blocks a picker upload after the target workspace switched', async () => {
      const { workspace, qualifiedClient } = makeQualifiedWorkspace(
        qualifiedFeatures,
        primaryAndSecondary,
      );
      uploadWorkspaceState.current = workspace;
      const container = renderChatEditor({});
      const input = container.querySelector<HTMLInputElement>(
        '[data-web-shell-upload-input]',
      )!;

      // The picker opens against the primary target, then the workspace
      // selection switches while the OS picker (which does not block the
      // page) is still open.
      act(() => {
        composerCoreState.onFileUploadRequest?.('docs');
      });
      rerenderChatEditor(container, { atWorkspaceCwd: '/secondary' });
      // Premise pin: the switched-to target keeps the input mounted; an
      // unmounted input would make the dispatch below vacuous.
      expect(
        container.querySelector('[data-web-shell-upload-input]'),
      ).not.toBeNull();

      Object.defineProperty(input, 'files', {
        value: [new File(['abc'], 'notes.txt')],
        configurable: true,
      });
      let inputValue = 'C:\\fakepath\\notes.txt';
      Object.defineProperty(input, 'value', {
        configurable: true,
        get: () => inputValue,
        set: (next: string) => {
          inputValue = next;
        },
      });
      act(() => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => {});

      // Positive control: the handler ran (it always clears the input), so
      // the negative assertions prove the stale-target guard blocked it.
      expect(input.value).toBe('');
      expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
      expect(qualifiedClient.uploadWorkspaceFile).not.toHaveBeenCalled();
    });

    it('restores the mention query when the stale-target guard blocks the picker', async () => {
      const { workspace, qualifiedClient } = makeQualifiedWorkspace(
        qualifiedFeatures,
        primaryAndSecondary,
      );
      uploadWorkspaceState.current = workspace;
      const container = renderChatEditor({});
      const input = container.querySelector<HTMLInputElement>(
        '[data-web-shell-upload-input]',
      )!;

      const restore = vi.fn();
      act(() => {
        composerCoreState.onFileUploadRequest?.('docs', restore);
      });
      rerenderChatEditor(container, { atWorkspaceCwd: '/secondary' });

      Object.defineProperty(input, 'files', {
        value: [new File(['abc'], 'notes.txt')],
        configurable: true,
      });
      let inputValue = 'C:\\fakepath\\notes.txt';
      Object.defineProperty(input, 'value', {
        configurable: true,
        get: () => inputValue,
        set: (next: string) => {
          inputValue = next;
        },
      });
      act(() => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => {});

      expect(qualifiedClient.uploadWorkspaceFile).not.toHaveBeenCalled();
      // The guard blocked the upload, but the deleted mention query must
      // come back instead of vanishing silently.
      expect(restore).toHaveBeenCalledTimes(1);
    });
  });
});
