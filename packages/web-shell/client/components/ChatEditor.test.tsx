// @vitest-environment jsdom

import { act, createRef, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonWorkspaceGitStatus,
  ReasoningSelection,
} from '@qwen-code/sdk/daemon';
import type { DaemonReasoningControls } from '@qwen-code/web-shell/daemon-react-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebShellCustomizationProvider,
  type ComposerTagClickHandler,
  type ComposerTagRenderer,
  type WebShellComposerTag,
  type WebShellCustomization,
} from '../customization';
import { I18nProvider, type WebShellLanguage } from '../i18n';
import type {
  MobileComposerBackend,
  SlashMenuState,
} from '../hooks/useComposerCore';
import type { AtMentionWorkspaceActions } from '../hooks/useAtMentionSources';
import { ChatEditor, type ComposerToolbarAction } from './ChatEditor';
import { WebShellPortalRootContext } from '../portalRoot';
import { PASTE_TITLE_MAX_CHARS } from '../utils/largePaste';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

Element.prototype.scrollIntoView = vi.fn();

const mockComposerCoreState = vi.hoisted(() => ({
  composerTags: [] as WebShellComposerTag[],
  pastedImages: [] as Array<{ data: string; media_type: string }>,
  pastedFiles: [] as Array<{
    name: string;
    media_type: string;
    text: string;
    size?: number;
  }>,
  removeTopTag: vi.fn(),
}));

// Stand in for the branch picker so the tests can assert what the composer
// hands it (the git status behind its action hints) without driving Radix.
vi.mock('./BranchPickerPopover', async () => {
  const { createElement } = await import('react');
  return {
    BranchPickerPopover: ({
      children,
      status,
    }: {
      children?: unknown;
      status?: { operation?: string; unstaged?: number };
    }) =>
      createElement(
        'div',
        {
          'data-testid': 'branch-picker',
          'data-status-operation': status?.operation ?? undefined,
          'data-status-unstaged': status?.unstaged ?? undefined,
        },
        children,
      ),
  };
});

// Mock useWorkspace so BranchPickerPopover can render without a real provider.
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
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
  viewRef: { current: null } as { current: unknown },
  workspaceActionsRef: { current: undefined } as {
    current: AtMentionWorkspaceActions | undefined;
  },
  getText: vi.fn(() => ''),
  setText: vi.fn(),
  insertText: vi.fn(),
  expandPastedText: vi.fn(),
  slashMenu: null as SlashMenuState | null,
  focus: vi.fn(),
  closeSlashMenu: vi.fn(),
  mobileComposer: null as unknown,
  openHistorySearch: vi.fn(),
  imageDropCapture: vi.fn(),
  ingestFiles: vi.fn(),
  clearImageDragState: vi.fn(),
  addTags: vi.fn(),
  imageDragActive: false,
  navigatePrevHistory: vi.fn(),
  navigateNextHistory: vi.fn(),
  hasContent: false,
  shellMode: false,
  setShellMode: vi.fn(),
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

const latestComposerCoreOptions = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock('../hooks/useComposerCore', async (importOriginal) => {
  const React = await import('react');
  const actual =
    await importOriginal<typeof import('../hooks/useComposerCore')>();
  return {
    ...actual,
    useComposerCore: (
      options?: Record<string, unknown> & {
        onFileUploadRequest?: (
          targetDir: string,
          restoreQuery?: () => void,
        ) => void;
        workspaceUploadBusy?: boolean;
      },
    ) => {
      latestComposerCoreOptions.current = options ?? null;
      composerCoreState.onFileUploadRequest = options?.onFileUploadRequest;
      composerCoreState.workspaceUploadBusy =
        options?.workspaceUploadBusy ?? false;
      return {
        containerRef: React.createRef<HTMLDivElement>(),
        viewRef: composerCoreState.viewRef,
        workspaceActionsRef: composerCoreState.workspaceActionsRef,
        mobileComposer: composerCoreState.mobileComposer,
        focus: composerCoreState.focus,
        submitText: vi.fn(),
        clearText: vi.fn(),
        getText: composerCoreState.getText,
        hasInput: vi.fn(() => false),
        hasAttachments:
          mockComposerCoreState.pastedImages.length > 0 ||
          mockComposerCoreState.pastedFiles.length > 0 ||
          mockComposerCoreState.composerTags.length > 0,
        hasContent: composerCoreState.hasContent,
        canSubmit: composerCoreState.hasContent,
        pendingImageBatchCount: 0,
        imageDragActive: composerCoreState.imageDragActive,
        clearImageDragState: composerCoreState.clearImageDragState,
        ingestFiles: composerCoreState.ingestFiles,
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
            mockComposerCoreState.pastedFiles.length > 0 ||
            mockComposerCoreState.composerTags.length > 0,
        },
        pastedImages: mockComposerCoreState.pastedImages,
        removeImage: vi.fn(),
        pastedFiles: mockComposerCoreState.pastedFiles,
        removeFile: vi.fn(),
        expandPastedText: composerCoreState.expandPastedText,
        composerTags: mockComposerCoreState.composerTags,
        removeTopTag: mockComposerCoreState.removeTopTag,
        addTags: composerCoreState.addTags,
        removeInlineTags: vi.fn(),
        insertText: composerCoreState.insertText,
        setText: composerCoreState.setText,
        submit: vi.fn(),
        clear: vi.fn(),
        retryLast: vi.fn(),
        replaceEditorText: vi.fn(),
        shellMode: composerCoreState.shellMode,
        setShellMode: composerCoreState.setShellMode,
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
        navigatePrevHistory: composerCoreState.navigatePrevHistory,
        navigateNextHistory: composerCoreState.navigateNextHistory,
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

const mounted: Array<{
  root: Root;
  container: HTMLDivElement;
  portalRoot: HTMLDivElement;
}> = [];

afterEach(() => {
  composerCoreState.slashMenu = null;
  composerCoreState.viewRef.current = null;
  composerCoreState.getText.mockReset().mockReturnValue('');
  composerCoreState.setText.mockReset();
  composerCoreState.insertText.mockReset();
  composerCoreState.expandPastedText.mockReset();
  composerCoreState.focus.mockReset();
  composerCoreState.closeSlashMenu.mockReset();
  composerCoreState.mobileComposer = null;
  composerCoreState.openHistorySearch.mockReset();
  composerCoreState.imageDropCapture.mockReset();
  composerCoreState.ingestFiles.mockReset();
  composerCoreState.clearImageDragState.mockReset();
  composerCoreState.addTags.mockReset();
  composerCoreState.navigatePrevHistory.mockReset();
  composerCoreState.navigateNextHistory.mockReset();
  composerCoreState.setShellMode.mockReset();
  composerCoreState.shellMode = false;
  composerCoreState.hasContent = false;
  composerCoreState.workspaceActionsRef.current = undefined;
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
  mockComposerCoreState.pastedFiles = [];
  mockComposerCoreState.removeTopTag.mockReset();
  latestComposerCoreOptions.current = null;
});

interface ChatEditorRenderProps
  extends Pick<
    ComponentProps<typeof ChatEditor>,
    'contextUsageAlwaysVisible' | 'contextUsageControls' | 'onOpenContextUsage'
  > {
  composerTags?: WebShellComposerTag[];
  pastedImages?: Array<{ data: string; media_type: string }>;
  pastedFiles?: Array<{
    name: string;
    media_type: string;
    text?: string;
    size?: number;
  }>;
  gitBranch?: string;
  gitStatus?: DaemonWorkspaceGitStatus;
  workspaceName?: string;
  workspaceTitle?: string;
  visibleToolbarActions?: readonly ComposerToolbarAction[];
  renderComposerTagTooltip?: ComposerTagRenderer;
  onComposerTagClick?: ComposerTagClickHandler;
  currentMode?: string;
  planMode?: boolean;
  modeControlsDisabled?: boolean;
  onTogglePlan?: () => void;
  isRunning?: boolean;
  onSubmit?: ComponentProps<typeof ChatEditor>['onSubmit'];
  onCancel?: () => void;
  currentModel?: string;
  availableModels?: Array<{ id: string; label?: string }>;
  sessionWorkflowEnabled?: boolean;
  onSelectMode?: (mode: string) => void;
  onSelectModel?: (model: string) => void;
  onAttachmentsChange?: (hasAttachments: boolean) => void;
  onImagePreview?: (src: string, alt?: string) => void;
  onAttachmentPreview?: (file: {
    name: string;
    text?: string;
    workspacePath?: string;
  }) => void;
  tokenCount?: number;
  contextWindow?: number;
  onShowContextUsage?: () => void;
  disabled?: boolean;
  atWorkspaceCwd?: string;
  composerScopeKey?: string;
  workspaceFeaturesEnabled?: boolean;
  attachmentsEnabled?: boolean;
  sessionId?: string;
  customization?: WebShellCustomization;
  language?: WebShellLanguage;
  builtinAtProviders?: WebShellCustomization['builtinAtProviders'];
  atProviders?: WebShellCustomization['atProviders'];
  skills?: Array<{ name: string; description: string }>;
  onSkillsOpenChange?: (open: boolean) => void;
  skillsLoading?: boolean;
  skillsLoadError?: boolean;
  skillsLoaded?: boolean;
  reasoning?: DaemonReasoningControls;
  onSelectReasoningEffort?: (value: ReasoningSelection) => Promise<void> | void;
}

function renderChatEditorInto(
  root: Root,
  portalRoot: HTMLDivElement,
  props: ChatEditorRenderProps,
) {
  const {
    composerTags,
    pastedImages,
    pastedFiles,
    customization,
    language = 'en',
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
  if (pastedFiles) {
    mockComposerCoreState.pastedFiles = pastedFiles;
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
          <I18nProvider language={language}>
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

describe('ChatEditor add menu (+)', () => {
  const trigger = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-add-menu-trigger"]',
    );

  it('renders at the front of the toolbar when addMenu is opted in', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu', 'approvalMode', 'voice'],
    });
    const button = trigger(container);
    expect(button).not.toBeNull();
    const leading = container.querySelector(
      '[data-web-shell-toolbar-leading]',
    )!;
    expect(leading.contains(button)).toBe(true);
    const modeButton = container.querySelector('[data-web-shell-mode-button]')!;
    expect(
      button!.compareDocumentPosition(modeButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('does not render when addMenu is not in the toolbar list', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['approvalMode', 'voice'],
    });
    expect(trigger(container)).toBeNull();
  });

  it('keeps session attachments available without workspace actions', async () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
      workspaceFeaturesEnabled: false,
      attachmentsEnabled: true,
    });
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-file',
    );

    expect(
      portalRoot.querySelector('[data-testid="composer-add-menu-file-attach"]'),
    ).not.toBeNull();
    expect(
      portalRoot.querySelector(
        '[data-testid="composer-add-menu-file-upload"]:not([data-disabled])',
      ),
    ).toBeNull();
  });

  it('stays off by default when the host passes no toolbar list', () => {
    const container = renderChatEditor({});
    expect(trigger(container)).toBeNull();
  });

  it('discards a pending file picker when the composer owner changes', async () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
      sessionId: 'session-a',
    });
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-file',
    );
    await act(async () => {
      portalRoot
        .querySelector<HTMLElement>(
          '[data-testid="composer-add-menu-file-attach"]',
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const staleInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]:not([data-web-shell-upload-input])',
    )!;

    rerenderChatEditor(container, {
      visibleToolbarActions: ['addMenu'],
      sessionId: 'session-b',
    });
    expect(staleInput.isConnected).toBe(false);

    Object.defineProperty(staleInput, 'files', {
      value: [new File(['hello'], 'note.txt', { type: 'text/plain' })],
      configurable: true,
    });
    await act(async () => {
      staleInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
  });

  it('discards a pending file picker when file ingestion is disabled', async () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
      customization: { fileUploadEnabled: true },
    });
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-file',
    );
    await act(async () => {
      portalRoot
        .querySelector<HTMLElement>(
          '[data-testid="composer-add-menu-file-attach"]',
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const staleInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]:not([data-web-shell-upload-input])',
    )!;

    composerCoreState.focus.mockClear();
    rerenderChatEditor(container, {
      visibleToolbarActions: ['addMenu'],
      customization: { fileUploadEnabled: false },
    });
    expect(staleInput.isConnected).toBe(false);
    expect(composerCoreState.focus).toHaveBeenCalled();

    Object.defineProperty(staleInput, 'files', {
      value: [new File(['hello'], 'note.txt', { type: 'text/plain' })],
      configurable: true,
    });
    await act(async () => {
      staleInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
  });

  it('closes an open add menu when the composer becomes disabled', async () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
    });
    await openAddSubmenu(container, 'composer-add-menu-file');

    rerenderChatEditor(container, {
      visibleToolbarActions: ['addMenu'],
      disabled: true,
    });

    const portalRoot = mounted.find(
      (entry) => entry.container === container,
    )!.portalRoot;
    expect(
      portalRoot.querySelector('[data-testid="composer-add-menu-file"]'),
    ).toBeNull();
  });

  it('closes an open add menu when a workspace capability disappears', async () => {
    composerCoreState.workspaceActionsRef.current = {
      loadExtensionsStatus: vi.fn().mockResolvedValue({
        extensions: [
          {
            name: 'reviewer',
            description: 'Reviews code',
            isActive: true,
          },
        ],
      }),
    };
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
    });
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-extensions',
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      portalRoot.querySelector(
        '[data-testid="composer-add-menu-extensions-item"]',
      ),
    ).not.toBeNull();

    composerCoreState.workspaceActionsRef.current = undefined;
    composerCoreState.focus.mockClear();
    rerenderChatEditor(container, { visibleToolbarActions: ['addMenu'] });

    expect(
      portalRoot.querySelector(
        '[data-testid="composer-add-menu-extensions-item"]',
      ),
    ).toBeNull();
    expect(composerCoreState.focus).toHaveBeenCalled();
  });

  async function openAddSubmenu(container: HTMLDivElement, testId: string) {
    const portalRoot = mounted.find(
      (entry) => entry.container === container,
    )!.portalRoot;
    await act(async () => {
      trigger(container)!.dispatchEvent(
        new MouseEvent(
          composerCoreState.mobileComposer ? 'click' : 'pointerdown',
          { bubbles: true, button: 0 },
        ),
      );
    });
    await act(async () => {
      portalRoot
        .querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    return portalRoot;
  }

  it('routes add-menu attachments through the composer file lane', async () => {
    const container = renderChatEditor({ visibleToolbarActions: ['addMenu'] });
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-file',
    );
    await act(async () => {
      portalRoot
        .querySelector<HTMLElement>(
          '[data-testid="composer-add-menu-file-attach"]',
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const input =
      container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(composerCoreState.ingestFiles).toHaveBeenCalledWith([file]);
    expect(composerCoreState.focus).toHaveBeenCalled();
  });

  it('refocuses the composer when the add-menu file picker is canceled', async () => {
    const container = renderChatEditor({ visibleToolbarActions: ['addMenu'] });
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-file',
    );
    await act(async () => {
      portalRoot
        .querySelector<HTMLElement>(
          '[data-testid="composer-add-menu-file-attach"]',
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const input =
      container.querySelector<HTMLInputElement>('input[type=file]')!;
    composerCoreState.focus.mockClear();
    await act(async () => {
      input.dispatchEvent(new Event('cancel'));
    });

    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
    expect(composerCoreState.focus).toHaveBeenCalled();
  });

  it('routes add-menu references through the inline tag lane', async () => {
    let docLength = 0;
    const dispatch = vi.fn();
    composerCoreState.viewRef.current = {
      state: {
        doc: {
          get length() {
            return docLength;
          },
        },
      },
      dispatch,
    };
    composerCoreState.addTags.mockImplementation(() => {
      docLength = 14;
    });
    composerCoreState.workspaceActionsRef.current = {
      globWorkspace: vi.fn().mockResolvedValue({ matches: ['src/index.ts'] }),
    };
    const container = renderChatEditor({ visibleToolbarActions: ['addMenu'] });
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-reference-file',
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await act(async () => {
      portalRoot
        .querySelector<HTMLElement>(
          '[data-testid="composer-add-menu-reference-file-item"]',
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(composerCoreState.addTags).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'file', serialized: '@src/index.ts' })],
      { placement: 'inline', position: 'end' },
    );
    expect(dispatch).toHaveBeenCalledWith({
      selection: { anchor: 14 },
      scrollIntoView: true,
    });
    expect(composerCoreState.focus).toHaveBeenCalled();
  });

  async function selectReviewSkill(container: HTMLDivElement) {
    const portalRoot = await openAddSubmenu(
      container,
      'composer-add-menu-skills',
    );
    const skill = portalRoot.querySelector<HTMLElement>(
      '[data-testid="composer-add-menu-skills-item"]',
    )!;
    await act(async () => {
      skill.dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  it('prepends a skill without replacing the desktop draft', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    composerCoreState.viewRef.current = {
      state: { doc: { toString: () => 'existing draft' } },
      dispatch,
      focus,
    };
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
      skills: [{ name: 'review', description: '' }],
    });

    await selectReviewSkill(container);

    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 0, insert: '/review ' },
      selection: { anchor: 8 },
      scrollIntoView: true,
    });
    expect(focus).toHaveBeenCalled();
  });

  it('refocuses the desktop editor when the skill is already prepended', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    composerCoreState.viewRef.current = {
      state: { doc: { toString: () => '/review existing draft' } },
      dispatch,
      focus,
    };
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
      skills: [{ name: 'review', description: '' }],
    });

    await selectReviewSkill(container);

    expect(dispatch).not.toHaveBeenCalled();
    expect(composerCoreState.focus).toHaveBeenCalled();
  });

  it('prepends a skill through the textarea backend on touch', async () => {
    composerCoreState.mobileComposer = {
      textareaRef: createRef<HTMLTextAreaElement>(),
      value: 'existing draft',
      onChange: vi.fn(),
      onBlur: vi.fn(),
      placeholder: '',
    } satisfies MobileComposerBackend;
    composerCoreState.getText.mockReturnValue('existing draft');
    const container = renderChatEditor({
      visibleToolbarActions: ['addMenu'],
      skills: [{ name: 'review', description: '' }],
    });

    await selectReviewSkill(container);

    expect(composerCoreState.insertText).toHaveBeenCalledWith('/review ');
    expect(composerCoreState.setText).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea')!.selectionStart,
    ).toBe(0);
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
    expect(button.textContent).toBe('34.3%');
    expect(
      button.querySelector('[data-level]')?.getAttribute('data-level'),
    ).toBe('normal');
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

  it('discards a pending hover when the owning session changes', async () => {
    vi.useFakeTimers();
    try {
      const props = {
        sessionId: 'session-a',
        tokenCount: 100,
        contextWindow: 1000,
        onShowContextUsage: vi.fn(),
      };
      const container = renderChatEditor(props);
      act(() =>
        ring(container)!.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true }),
        ),
      );
      rerenderChatEditor(container, { ...props, sessionId: 'session-b' });
      expect(ring(container)).not.toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(
        document.querySelector('[data-web-shell-context-popover]'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps live hover actions available for an always-visible ring with unknown counts', async () => {
    const compress = vi.fn().mockResolvedValue(undefined);
    const onOpenContextUsage = vi.fn();
    const onShowContextUsage = vi.fn();
    const getContextUsage = vi.fn();
    const container = renderChatEditor({
      contextUsageAlwaysVisible: true,
      onOpenContextUsage,
      onShowContextUsage,
      contextUsageControls: {
        sessionId: 'session-1',
        captureOwner: () => ({ isCurrent: () => true }),
        canCompress: true,
        compressing: false,
        compress,
        getContextUsage,
      },
    });
    await act(async () => ring(container)!.focus());
    const card = document.querySelector('[data-web-shell-context-popover]')!;
    expect(card.querySelector('dl')).toBeNull();
    expect(ring(container)!.hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('[id$="-description"]')).toBeNull();
    const buttons = Array.from(card.querySelectorAll('button'));
    const compression = buttons.find(
      (button) => button.textContent === 'Compress context',
    )!;
    expect(compression.disabled).toBe(false);
    await act(async () => compression.click());
    expect(compress).toHaveBeenCalledOnce();
    await act(async () =>
      buttons.find((button) => button.textContent === 'View details')!.click(),
    );
    expect(onOpenContextUsage).toHaveBeenCalledOnce();
    expect(onShowContextUsage).not.toHaveBeenCalled();
    expect(getContextUsage).not.toHaveBeenCalled();
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

  it('shows the used/total detail in the hover card on focus', async () => {
    const container = renderChatEditor({
      tokenCount: 53_600,
      contextWindow: 1_000_000,
      onShowContextUsage: vi.fn(),
    });

    await act(async () => {
      ring(container)!.focus();
    });

    const tooltip = document.querySelector('[data-web-shell-context-popover]')!;
    expect(tooltip.textContent).toContain('Context Usage');
    expect(tooltip.textContent).toContain('5.4%');
    expect(tooltip.textContent).toContain('53,600 tokens');
    expect(tooltip.textContent).toContain('1,000,000 tokens');
    expect(tooltip.textContent).toContain('Remaining946,400 tokens');
    expect(tooltip.textContent).toContain(
      'Click to view the breakdown in the conversation.',
    );
    expect(
      tooltip.querySelector<HTMLElement>('[data-level]')?.style.width,
    ).toBe('5.36%');
    expect(
      document
        .getElementById(ring(container)!.getAttribute('aria-controls')!)
        ?.getAttribute('aria-label'),
    ).toBe('Context Usage');
    expect(
      document.getElementById(
        ring(container)!.getAttribute('aria-describedby')!,
      )?.textContent,
    ).toBe('53,600 of 1,000,000 tokens used');
  });

  it('shows zero remaining capacity when usage exceeds the context window', async () => {
    const container = renderChatEditor({
      tokenCount: 120_000,
      contextWindow: 100_000,
      onShowContextUsage: vi.fn(),
    });
    await act(async () => {
      ring(container)!.focus();
    });
    expect(
      document.querySelector('[data-web-shell-context-popover]')?.textContent,
    ).toContain('Remaining0 tokens');
  });

  it.each([
    [60, 'normal'],
    [61, 'warning'],
    [80, 'warning'],
    [81, 'error'],
  ] as const)(
    'uses %s percent severity in the visible label and focused tooltip',
    async (tokenCount, level) => {
      const container = renderChatEditor({
        tokenCount,
        contextWindow: 100,
        onShowContextUsage: vi.fn(),
      });
      await act(async () => {
        ring(container)!.focus();
      });
      expect(
        ring(container)!
          .querySelector('[data-level]')
          ?.getAttribute('data-level'),
      ).toBe(level);
      expect(
        document
          .querySelector('[data-web-shell-context-popover] [data-level]')
          ?.getAttribute('data-level'),
      ).toBe(level);
    },
  );

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
    expect(button.textContent).toBe('150.0%');
    expect(
      button.querySelector('[data-level]')?.getAttribute('data-level'),
    ).toBe('error');
    const arc = button.querySelectorAll('circle')[1];
    expect(arc.getAttribute('stroke-dashoffset')).toBe('0');
  });
});

describe('ChatEditor attachment reporting', () => {
  it('renders attachments with a file icon, title, and type', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'report.html',
          media_type: 'text/html',
        },
      ],
    });
    const attachments = container.querySelector(
      '[data-web-shell-composer-attachments]',
    );
    expect(
      attachments?.querySelector('[data-file-type-icon="html"]'),
    ).not.toBeNull();
    expect(
      attachments?.querySelector('[title="report.html"]')?.textContent,
    ).toBe('report.html');
    expect(attachments?.querySelector('[title="HTML"]')?.textContent).toBe(
      'HTML',
    );
    expect(
      attachments?.querySelector('button[aria-label="Remove report.html"]'),
    ).not.toBeNull();
  });

  it('shows a folded paste with its size and expands it on request', () => {
    const text = `${'line\n'.repeat(199)}line`;
    const onAttachmentPreview = vi.fn();
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text,
          size: 1000,
        },
      ],
      onAttachmentPreview,
    });
    const attachments = container.querySelector(
      '[data-web-shell-composer-attachments]',
    );
    expect(attachments?.textContent).toContain('1000 B');
    expect(attachments?.textContent).not.toContain('lines');

    // The action leads the second line and the size follows it.
    const meta = container.querySelector<HTMLElement>(
      '[class*="fileChipMeta"]',
    );
    expect(meta?.firstElementChild?.className).toContain('fileChipExpand');
    expect(meta?.lastElementChild?.textContent).toBe('1000 B');

    const buttons = Array.from(attachments?.querySelectorAll('button') ?? []);
    expect(buttons).toHaveLength(3);
    act(() => {
      buttons
        .find((button) => button.className.includes('fileChipTitle'))!
        .click();
    });
    expect(onAttachmentPreview).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pasted-text.txt', text }),
    );

    const expand = buttons.find((button) =>
      button.textContent?.includes('Show inline'),
    )!;
    expect(expand).toBeDefined();
    act(() => {
      expand.click();
    });
    expect(composerCoreState.expandPastedText).toHaveBeenCalledWith(0);
  });

  it('titles a folded paste with its first line instead of the file name', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text: 'ERROR connection refused\nstack line\n'.repeat(100),
          size: 4000,
        },
      ],
    });
    const attachments = container.querySelector(
      '[data-web-shell-composer-attachments]',
    );
    const title = container.querySelector<HTMLElement>(
      '[class*="fileChipTitle"]',
    );
    expect(title?.textContent?.replace(/…$/, '')).toBe(
      'ERROR connection refused stack line'.slice(0, PASTE_TITLE_MAX_CHARS),
    );
    expect(title?.getAttribute('title')).toBe(title?.textContent);
    expect(attachments?.textContent).not.toContain('pasted-text.txt');
  });

  it('fills the title past a one-word first line', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text: 'import\n  { spawn }\n  from child_process;\n'.repeat(50),
          size: 2000,
        },
      ],
    });
    const title =
      container.querySelector<HTMLElement>('[class*="fileChipTitle"]')
        ?.textContent ?? '';
    // The one-word first line is not the whole title: it runs into the next.
    expect(title).toContain('import {');
    expect(title.length).toBeLessThanOrEqual(PASTE_TITLE_MAX_CHARS + 1);
  });

  it('clips the title to a single line of bounded length', () => {
    const firstLine = `head ${'x'.repeat(200)}`;
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text: `${firstLine}\n${'tail\n'.repeat(200)}`,
          size: 4000,
        },
      ],
    });
    const title = container.querySelector<HTMLElement>(
      '[class*="fileChipTitle"]',
    );
    expect(title?.textContent?.endsWith('…')).toBe(true);
    expect(title?.textContent).not.toContain('tail');
    expect(title?.textContent?.length ?? 0).toBeLessThanOrEqual(
      PASTE_TITLE_MAX_CHARS + 1,
    );
  });

  it('falls back to the file name when there is no content to show', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text: '\n\n   \n'.repeat(100),
          size: 1200,
        },
      ],
    });
    const attachments = container.querySelector(
      '[data-web-shell-composer-attachments]',
    );
    expect(attachments?.textContent).toContain('pasted-text.txt');
  });

  it('leaves a pasted file without inline text without an expand action', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'photo.png',
          media_type: 'image/png',
          size: 2048,
        },
      ],
    });
    const attachments = container.querySelector(
      '[data-web-shell-composer-attachments]',
    );
    expect(attachments?.textContent).not.toContain('Show inline');
    expect(attachments?.textContent).not.toContain('lines');
  });

  it('shows only the size, with no line count', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text: 'x'.repeat(8000),
          size: 8000,
        },
      ],
    });
    const attachments = container.querySelector(
      '[data-web-shell-composer-attachments]',
    );
    expect(attachments?.textContent).toContain('7.8 KB');
    expect(attachments?.textContent).not.toContain('lines');
  });

  it('omits the size for a text card that carries none', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text: '中文'.repeat(100),
        },
      ],
    });
    const meta = container.querySelector<HTMLElement>(
      '[class*="fileChipMeta"]',
    );
    expect(meta?.textContent).not.toContain(' B');
    // The action survives on its own when there is no size to show.
    expect(meta?.lastElementChild?.textContent).toBe('Show inline');
  });

  it('expands the card whose action was clicked', () => {
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'pasted-text.txt',
          media_type: 'text/plain',
          text: 'first\n'.repeat(200),
        },
        {
          name: 'pasted-text (1).txt',
          media_type: 'text/plain',
          text: 'second\n'.repeat(200),
        },
      ],
    });
    const expandButtons = Array.from(
      container.querySelectorAll('button'),
    ).filter((button) => button.textContent?.includes('Show inline'));
    expect(expandButtons).toHaveLength(2);

    act(() => {
      expandButtons[1]!.click();
    });

    expect(composerCoreState.expandPastedText).toHaveBeenCalledWith(1);
  });

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
    const imageStrip = container.querySelector(
      '[data-web-shell-composer-images]',
    );
    const editor = container.querySelector('[data-web-shell-composer-editor]');
    expect(imageStrip?.parentElement).toBe(
      editor?.parentElement?.parentElement,
    );
    act(() => img!.click());
    expect(onImagePreview).toHaveBeenCalledWith('data:image/png;base64,abc');
  });

  it('opens the preview when a chip without inline text is clicked', () => {
    const onAttachmentPreview = vi.fn();
    const container = renderChatEditor({
      pastedFiles: [
        {
          name: 'notes.txt',
          media_type: 'text/plain',
          size: 16,
        },
      ],
      onAttachmentPreview,
    });

    act(() => {
      (
        container.querySelector(
          'button[class*="fileChipPreview"]',
        ) as HTMLElement
      ).click();
    });

    expect(onAttachmentPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'notes.txt',
      }),
    );
    expect(container.textContent).not.toContain('16 B');
    expect(
      container
        .querySelector('[class*="fileChip"]')
        ?.querySelectorAll('button'),
    ).toHaveLength(2);
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
    ).toHaveLength(kinds.length - 1);
    expect(
      container.querySelector('[data-file-type-icon="file"]'),
    ).not.toBeNull();
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

  it('hands the workspace git status to the branch picker for its action hints', () => {
    const container = renderChatEditor({
      gitBranch: 'feature/web-shell',
      gitStatus: {
        v: 2,
        workspaceCwd: '/repo',
        branch: 'feature/web-shell',
        operation: 'rebase',
        unstaged: 4,
        computedAt: 1,
      },
      visibleToolbarActions: ['gitBranch'],
    });

    const picker = container.querySelector('[data-testid="branch-picker"]');
    expect(picker?.getAttribute('data-status-operation')).toBe('rebase');
    expect(picker?.getAttribute('data-status-unstaged')).toBe('4');
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
  it('controls the workspace selector with the workspace action', () => {
    const props = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/main',
          label: 'main',
          primary: true,
          trusted: true,
        },
        {
          id: 'api',
          cwd: '/work/api',
          label: 'api',
          primary: false,
          trusted: true,
        },
      ],
      onSelectWorkspace: vi.fn(),
    };

    expect(
      renderChatEditor({
        ...props,
        visibleToolbarActions: ['workspace'],
      }).querySelector('button[aria-label="Workspace"]'),
    ).not.toBeNull();
    expect(
      renderChatEditor({
        ...props,
        visibleToolbarActions: [],
      }).querySelector('button[aria-label="Workspace"]'),
    ).toBeNull();
  });

  it('keeps legacy history fallback for Live but isolates standalone drafts', () => {
    renderChatEditor({
      composerScopeKey: 'live',
      workspaceFeaturesEnabled: false,
    });
    expect(
      latestComposerCoreOptions.current?.disableLegacyHistoryFallback,
    ).toBe(false);

    renderChatEditor({
      composerScopeKey: 'standalone',
      workspaceFeaturesEnabled: false,
    });
    expect(
      latestComposerCoreOptions.current?.disableLegacyHistoryFallback,
    ).toBe(true);
  });

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

describe('ChatEditor file tag preview', () => {
  it('opens an inserted file tag in the attachment preview', () => {
    const onAttachmentPreview = vi.fn();
    const onComposerTagClick = vi.fn();
    renderChatEditor({ onAttachmentPreview, onComposerTagClick });
    const onFileTagClick = latestComposerCoreOptions.current?.[
      'onFileTagClick'
    ] as ((info: { tag: WebShellComposerTag }) => void) | undefined;
    const info = {
      tag: {
        id: 'file:docs/notes.md',
        kind: 'file',
        value: 'docs/notes.md',
        serialized: '@docs/notes.md',
      } satisfies WebShellComposerTag,
    };

    act(() => onFileTagClick?.(info));

    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'notes.md',
      workspacePath: 'docs/notes.md',
    });
    expect(onComposerTagClick).toHaveBeenCalledWith(info);
  });

  it('does not preview an inserted directory tag', () => {
    const onAttachmentPreview = vi.fn();
    renderChatEditor({ onAttachmentPreview });
    const onFileTagClick = latestComposerCoreOptions.current?.[
      'onFileTagClick'
    ] as ((info: { tag: WebShellComposerTag }) => void) | undefined;

    act(() =>
      onFileTagClick?.({
        tag: {
          id: 'file:@docs/',
          kind: 'file',
          value: 'docs',
          metadata: { fileKind: 'directory' },
          serialized: '@docs/',
        },
      }),
    );

    expect(onAttachmentPreview).not.toHaveBeenCalled();
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

describe('ChatEditor Plan in the add menu', () => {
  const actions = ['addMenu', 'approvalMode', 'plan', 'model'] as const;
  const planButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-web-shell-plan-button]');

  async function openPlanMenuItem(container: HTMLDivElement) {
    const portalRoot = mounted.find(
      (entry) => entry.container === container,
    )!.portalRoot;
    await act(async () => {
      container
        .querySelector('[data-testid="composer-add-menu-trigger"]')!
        .dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
    });
    // A missing entry only means something once the menu is known to be open.
    const menu = portalRoot.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const entry = portalRoot.querySelector<HTMLElement>(
      '[data-testid="composer-add-menu-plan"]',
    );
    if (entry) {
      const rows = menu!.querySelectorAll('[role^="menuitem"]');
      expect(rows[rows.length - 1]).toBe(entry);
    }
    return entry;
  }

  it('keeps Plan off the toolbar until it is on and enables it from the menu', async () => {
    const onTogglePlan = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: actions,
      onTogglePlan,
    });
    expect(planButton(container)).toBeNull();
    expect(container.querySelector('[data-web-shell-plan-control]')).toBeNull();
    expect(
      container.querySelector('[data-toolbar-measure^="plan:"]'),
    ).toBeNull();

    const item = (await openPlanMenuItem(container))!;
    expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect(item.textContent).toBe('Plan modePlan first, run after you approve');
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      // The menu runs the choice once it has closed.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onTogglePlan).toHaveBeenCalledOnce();
    expect(composerCoreState.focus).toHaveBeenCalledOnce();
  });

  it('reports an enabled Plan as a dismissible chip after the permission control', async () => {
    const onTogglePlan = vi.fn();
    const props = {
      visibleToolbarActions: actions,
      planMode: true,
      currentMode: 'yolo',
      isRunning: true,
      onTogglePlan,
    };
    const container = renderChatEditor(props);
    const chip = planButton(container)!;
    expect(
      container.querySelectorAll('[data-web-shell-plan-button]'),
    ).toHaveLength(1);
    expect(chip.hasAttribute('data-web-shell-plan-chip')).toBe(true);
    // The close mark is what makes the chip dismissible. It sits inside the
    // icon slot, which it takes over on hover, rather than trailing the label
    // where revealing it would widen the chip.
    const iconSlot = chip.querySelector('[class*="planChipIcon"]')!;
    const closeMarks = chip.querySelectorAll('[class*="planChipClose"]');
    expect(closeMarks).toHaveLength(1);
    // The stylesheet reaches both through a child combinator: the Plan icon
    // first, then the mark stacked over it.
    expect(Array.from(iconSlot.children)).toEqual([
      iconSlot.querySelector('[style*="mode-icon-url"]'),
      closeMarks[0],
    ]);
    expect(closeMarks[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(closeMarks[0]!.querySelector('svg')).not.toBeNull();
    // The slot the mark fills is the fixed icon box, which is why revealing
    // it cannot change the width of the chip; and the forced-colours repaint
    // is written for the icon being a span.
    expect(iconSlot.className).toContain('toolBtnModeIcon');
    expect(iconSlot.firstElementChild?.tagName).toBe('SPAN');
    // Hosts that select the Plan control by this hook still find it.
    expect(chip.hasAttribute('data-web-shell-plan-control')).toBe(true);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.getAttribute('aria-label')).toBe('Plan');
    expect(
      document.getElementById(chip.getAttribute('aria-describedby')!)
        ?.textContent,
    ).toBe(
      'Planning; execute with Full Access after approval. Click to exit planning.',
    );
    const controls = Array.from(
      container.querySelectorAll('[data-web-shell-toolbar-leading] button'),
    );
    expect(controls.indexOf(chip)).toBe(
      controls.indexOf(
        container.querySelector('[data-web-shell-mode-button]')!,
      ) + 1,
    );
    expect(
      (await openPlanMenuItem(container))!.getAttribute('aria-checked'),
    ).toBe('true');

    // Propagation is what closes a menu the chip was clicked on top of.
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-mode-button]')!
        .click(),
    );
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]'),
    ).not.toBeNull();
    act(() => chip.click());
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]'),
    ).toBeNull();
    expect(onTogglePlan).toHaveBeenCalledOnce();
    expect(composerCoreState.focus).toHaveBeenCalled();
    // Controlled: the chip stays until the host reports Plan off.
    expect(planButton(container)).not.toBeNull();
    rerenderChatEditor(container, { ...props, planMode: false });
    expect(planButton(container)).toBeNull();
  });

  it('keeps the chip operable while approval disables input', () => {
    const onTogglePlan = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: actions,
      disabled: true,
      planMode: true,
      onTogglePlan,
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="composer-add-menu-trigger"]',
      )!.disabled,
    ).toBe(true);
    act(() => planButton(container)!.click());
    expect(onTogglePlan).toHaveBeenCalledOnce();
  });

  it('disables the menu entry and the chip during a plan handoff', async () => {
    const onTogglePlan = vi.fn();
    const props = {
      visibleToolbarActions: actions,
      planMode: true,
      modeControlsDisabled: true,
      onTogglePlan,
    };
    const container = renderChatEditor(props);
    const chip = planButton(container)!;
    expect(chip.disabled).toBe(true);
    act(() => chip.click());
    const item = (await openPlanMenuItem(container))!;
    expect(item.hasAttribute('data-disabled')).toBe(true);
    // The add menu never disables a row without saying why.
    expect(item.textContent).toContain('Switching mode');
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onTogglePlan).not.toHaveBeenCalled();

    rerenderChatEditor(container, { ...props, modeControlsDisabled: false });
    expect(chip.disabled).toBe(false);
    act(() => chip.click());
    expect(onTogglePlan).toHaveBeenCalledOnce();
  });

  it.each([
    { width: 0, label: '' },
    { width: 300, label: 'Plan' },
  ])(
    'fits the chip label to available toolbar width $width',
    ({ width, label }) => {
      const bounds = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function () {
          if (this.matches('[data-toolbar-measure="plan:expanded"]'))
            return { width: 72 } as DOMRect;
          if (this.matches('[data-toolbar-measure="plan:collapsed"]'))
            return { width: 44 } as DOMRect;
          if (this.querySelector(':scope > [data-web-shell-toolbar-leading]'))
            return { width } as DOMRect;
          return { width: 0 } as DOMRect;
        });
      try {
        const container = renderChatEditor({
          visibleToolbarActions: actions,
          planMode: true,
          onTogglePlan: vi.fn(),
        });
        expect(planButton(container)!.textContent).toBe(label);
        // Where nothing can hover, the close mark replaces the icon only on a
        // chip that still names itself.
        expect(planButton(container)!.hasAttribute('data-labelled')).toBe(
          label !== '',
        );
        // The budget is only right if the replicas stand in for the real chip,
        // and the mark, being stacked over the icon, takes no room in either.
        expect(
          container.querySelector(
            '[data-toolbar-measure^="plan:"] [class*="planChipClose"]',
          ),
        ).toBeNull();
        expect(
          container.querySelector('[data-toolbar-measure="plan:collapsed"]')
            ?.textContent,
        ).toBe('');
        expect(
          container.querySelector('[data-toolbar-measure="plan:expanded"]')
            ?.textContent,
        ).toBe('Plan');
      } finally {
        bounds.mockRestore();
      }
    },
  );

  it('measures the chip when Plan turns on after mount', () => {
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if (this.matches('[data-toolbar-measure="plan:expanded"]'))
          return { width: 72 } as DOMRect;
        if (this.matches('[data-toolbar-measure="plan:collapsed"]'))
          return { width: 44 } as DOMRect;
        if (this.querySelector(':scope > [data-web-shell-toolbar-leading]'))
          return { width: 300 } as DOMRect;
        return { width: 0 } as DOMRect;
      });
    try {
      const props = { visibleToolbarActions: actions, onTogglePlan: vi.fn() };
      const container = renderChatEditor(props);
      expect(planButton(container)).toBeNull();
      rerenderChatEditor(container, { ...props, planMode: true });
      expect(planButton(container)!.textContent).toBe('Plan');
    } finally {
      bounds.mockRestore();
    }
  });

  it.each([
    { visibleToolbarActions: ['addMenu'] as const, onTogglePlan: vi.fn() },
    { visibleToolbarActions: ['addMenu', 'plan'] as const },
  ])(
    'requires both the plan action and a toggle handler: %j',
    async (props) => {
      const container = renderChatEditor({ ...props, planMode: true });
      expect(planButton(container)).toBeNull();
      expect(await openPlanMenuItem(container)).toBeNull();
    },
  );
});

// A host that lists `plan` without `addMenu` has no menu to hold the entry.
describe('ChatEditor Plan toolbar switch fallback', () => {
  it('associates the Plan switch with its changing accessible description', () => {
    const props = {
      visibleToolbarActions: ['plan'] as const,
      onTogglePlan: vi.fn(),
    };
    const container = renderChatEditor(props);
    for (const state of [
      {
        planMode: false,
        currentMode: 'yolo',
        description: 'Plan before executing',
      },
      {
        planMode: true,
        currentMode: 'yolo',
        description:
          'Planning; execute with Full Access after approval. Click to exit planning.',
      },
      {
        planMode: true,
        currentMode: 'auto-edit',
        description:
          'Planning; execute with Auto Edit after approval. Click to exit planning.',
      },
      {
        planMode: false,
        currentMode: 'auto-edit',
        description: 'Plan before executing',
      },
    ]) {
      rerenderChatEditor(container, { ...props, ...state });
      const button = container.querySelector<HTMLButtonElement>(
        '[data-web-shell-plan-button]',
      )!;
      act(() => button.focus());
      expect(button.getAttribute('aria-label')).toBe('Plan');
      const descriptionIds = button.getAttribute('aria-describedby');
      expect(descriptionIds).toBeTruthy();
      const description = descriptionIds!
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      expect(description).toBe(state.description);
    }
  });

  it('closes an open permission dropdown when mode controls become disabled', () => {
    const props = {
      visibleToolbarActions: ['approvalMode', 'plan'] as const,
      onSelectMode: vi.fn(),
      onTogglePlan: vi.fn(),
    };
    const container = renderChatEditor(props);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-mode-button]')
        ?.click(),
    );
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]'),
    ).not.toBeNull();
    rerenderChatEditor(container, { ...props, modeControlsDisabled: true });
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]'),
    ).toBeNull();
  });

  it('omits Plan from permissions and retains every execution policy', () => {
    const onSelectMode = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['approvalMode', 'plan'],
      planMode: true,
      currentMode: 'yolo',
      onTogglePlan: vi.fn(),
      onSelectMode,
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-mode-button]')
        ?.click(),
    );
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-web-shell-toolbar-popover] button',
      ),
    );
    const labels = buttons.map((button) => button.textContent ?? '');
    expect(labels.some((label) => label.includes('(plan)'))).toBe(false);
    for (const mode of ['default', 'auto-edit', 'auto', 'yolo']) {
      expect(labels.some((label) => label.includes(`(${mode})`))).toBe(true);
    }
    act(() =>
      buttons
        .find((button) => button.textContent?.includes('(auto-edit)'))
        ?.click(),
    );
    expect(onSelectMode).toHaveBeenCalledWith('auto-edit');
    expect(
      container
        .querySelector('[data-web-shell-plan-button]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps permission and Plan controls operable while approval disables input', () => {
    const onSelectMode = vi.fn();
    const onTogglePlan = vi.fn();
    const container = renderChatEditor({
      visibleToolbarActions: ['approvalMode', 'plan'],
      disabled: true,
      planMode: true,
      currentMode: 'default',
      onSelectMode,
      onTogglePlan,
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-mode-button]')
        ?.click(),
    );
    const option = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-web-shell-toolbar-popover] button',
      ),
    ).find((button) => button.textContent?.includes('(yolo)'));
    expect(option).toBeDefined();
    act(() => option!.click());
    expect(onSelectMode).toHaveBeenCalledWith('yolo');
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-plan-button]')
        ?.click(),
    );
    expect(onTogglePlan).toHaveBeenCalledOnce();
  });

  it('disables both controls during a plan handoff and restores them afterward', () => {
    const onSelectMode = vi.fn();
    const onTogglePlan = vi.fn();
    const props = {
      visibleToolbarActions: ['approvalMode', 'plan'] as const,
      planMode: true,
      modeControlsDisabled: true,
      onSelectMode,
      onTogglePlan,
    };
    const container = renderChatEditor(props);
    const mode = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-mode-button]',
    )!;
    const plan = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-plan-button]',
    )!;
    expect(mode.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    const planControl = plan.closest('[data-web-shell-plan-control]')!;
    expect(planControl.hasAttribute('data-disabled')).toBe(true);
    act(() => {
      mode.click();
      plan.click();
    });
    expect(onTogglePlan).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-web-shell-toolbar-popover]'),
    ).toBeNull();
    rerenderChatEditor(container, { ...props, modeControlsDisabled: false });
    expect(mode.disabled).toBe(false);
    expect(plan.disabled).toBe(false);
    expect(planControl.hasAttribute('data-disabled')).toBe(false);
    act(() => plan.click());
    expect(onTogglePlan).toHaveBeenCalledOnce();
  });

  it('places the controlled toggle immediately after permission and allows use while running', () => {
    const onTogglePlan = vi.fn();
    const props = {
      visibleToolbarActions: ['approvalMode', 'plan', 'model'] as const,
      currentMode: 'yolo',
      onTogglePlan,
      isRunning: true,
    };
    const container = renderChatEditor(props);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-plan-button]',
    )!;
    const controls = Array.from(
      container.querySelectorAll('[data-web-shell-toolbar-leading] button'),
    );
    expect(controls.indexOf(button)).toBe(
      controls.indexOf(
        container.querySelector('[data-web-shell-mode-button]')!,
      ) + 1,
    );
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-label')).toBe('Plan');
    expect(button.getAttribute('aria-checked')).toBe('false');
    act(() => button.click());
    expect(onTogglePlan).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-checked')).toBe('false');
    rerenderChatEditor(container, { ...props, planMode: true });
    expect(button.getAttribute('aria-checked')).toBe('true');
    rerenderChatEditor(container, { ...props, planMode: false });
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(
      container.querySelector('[data-toolbar-measure="mode:expanded"]')
        ?.textContent,
    ).toContain('Full Access');
  });

  it.each([
    { width: 0, label: '' },
    { width: 300, label: 'Plan' },
  ])(
    'fits the Plan label to available toolbar width $width',
    ({ width, label }) => {
      const bounds = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function () {
          if (this.matches('[data-toolbar-measure="plan:expanded"]'))
            return { width: 72 } as DOMRect;
          if (this.matches('[data-toolbar-measure="plan:collapsed"]'))
            return { width: 54 } as DOMRect;
          if (this.querySelector(':scope > [data-web-shell-toolbar-leading]'))
            return { width } as DOMRect;
          return { width: 0 } as DOMRect;
        });
      try {
        const container = renderChatEditor({
          visibleToolbarActions: ['approvalMode', 'plan'],
          onTogglePlan: vi.fn(),
        });
        const button = container.querySelector('[data-web-shell-plan-button]')!;
        const control = container.querySelector(
          '[data-web-shell-plan-control]',
        )!;
        expect(control.textContent).toBe(label);
        expect(control.querySelector('[aria-hidden="true"]') !== null).toBe(
          label === '',
        );
        expect(
          button.querySelector('[data-slot="switch-thumb"]'),
        ).not.toBeNull();
        expect(button.getAttribute('role')).toBe('switch');
        expect(button.getAttribute('aria-label')).toBe('Plan');
      } finally {
        bounds.mockRestore();
      }
    },
  );

  it.each([undefined, [], ['approvalMode']] as const)(
    'requires an explicit Plan toolbar action: %j',
    (visibleToolbarActions) => {
      const container = renderChatEditor({
        visibleToolbarActions,
        onTogglePlan: vi.fn(),
      });
      expect(
        container.querySelector('[data-web-shell-plan-button]'),
      ).toBeNull();
    },
  );
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
      // Long enough to catch a focus restore that arrives from the popover's
      // post-unmount timeout, which is what this asserts does not happen.
      await new Promise((resolve) => setTimeout(resolve, 50));
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

      const toolbarLeading = document.querySelector(
        '[data-web-shell-toolbar-leading]',
      )!;
      expect(observed.has(toolbarLeading)).toBe(false);
      expect(observed.has(toolbarLeading.parentElement!)).toBe(true);
      for (const measurement of document.querySelectorAll(
        '[data-toolbar-measure]',
      )) {
        expect(observed.has(measurement)).toBe(true);
      }

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

  it('remeasures the toolbar when addMenu visibility changes', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let observers = 0;
    globalThis.ResizeObserver = class ResizeObserverMock {
      constructor(_callback: ResizeObserverCallback) {
        observers += 1;
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    };

    try {
      const container = renderChatEditor({
        visibleToolbarActions: ['approvalMode'],
      });
      const before = observers;
      rerenderChatEditor(container, {
        visibleToolbarActions: ['addMenu', 'approvalMode'],
      });
      expect(observers).toBeGreaterThan(before);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('does not synchronously loop when toolbar measurements alternate', () => {
    let leadingWidthReads = 0;
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if (this.matches('[data-toolbar-measure="mode:expanded"]')) {
          return { width: 50 } as DOMRect;
        }
        if (this.matches('[data-toolbar-measure="mode:collapsed"]')) {
          return { width: 10 } as DOMRect;
        }
        if (
          !this.hasAttribute('data-web-shell-toolbar-leading') &&
          this.querySelector('[data-web-shell-toolbar-leading]')
        ) {
          return { width: 100 } as DOMRect;
        }
        return { width: 0 } as DOMRect;
      });
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(function () {
        if (!this.hasAttribute('data-web-shell-toolbar-leading')) return 0;
        leadingWidthReads += 1;
        const modeButton = this.querySelector('[data-web-shell-mode-button]');
        const expanded = Array.from(
          modeButton?.querySelectorAll('span') ?? [],
        ).some((span) => Boolean(span.textContent?.trim()));
        return expanded ? 101 : 50;
      });

    try {
      expect(() =>
        renderChatEditor({ visibleToolbarActions: ['approvalMode'] }),
      ).not.toThrow();
      expect(leadingWidthReads).toBe(1);
    } finally {
      bounds.mockRestore();
      scrollWidth.mockRestore();
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

  it.each([
    [
      {
        enabled: false,
        effort: 'medium',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh'],
      },
      'medium',
    ],
    [{ enabled: false, effort: 'default', efforts: [] }, 'default'],
    [
      {
        enabled: false,
        effort: 'default',
        efforts: ['low', 'high'],
        canEnable: false,
      },
      undefined,
    ],
    [
      { enabled: false, effort: 'default', efforts: [], canEnable: false },
      undefined,
    ],
    [
      {
        enabled: true,
        effort: 'high',
        efforts: ['low', 'high'],
        canEnable: false,
      },
      'none',
    ],
    [
      {
        enabled: false,
        effort: 'medium',
        defaultEffort: 'medium',
        enableValue: 'default',
        efforts: ['medium'],
      },
      'default',
    ],
    [
      {
        enabled: true,
        effort: 'medium',
        defaultEffort: 'medium',
        efforts: ['medium'],
      },
      'none',
    ],
  ] as const)(
    'toggles thinking only when the requested direction is available for %j',
    async (reasoning, expected) => {
      const onSelectReasoningEffort = vi.fn();
      const container = renderChatEditor({
        visibleToolbarActions: ['model'],
        currentModel: 'gpt-5.4',
        availableModels: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
        reasoning: { ...reasoning, efforts: [...reasoning.efforts] },
        onSelectReasoningEffort,
      });
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[data-web-shell-model-button]')
          ?.click(),
      );
      const toggle = document.querySelector<HTMLButtonElement>(
        '[data-web-shell-thinking-toggle]',
      );
      expect(toggle).not.toBeNull();
      await act(async () => toggle?.click());
      expect(toggle?.disabled).toBe(expected === undefined);
      if (expected === undefined) {
        expect(onSelectReasoningEffort).not.toHaveBeenCalled();
      } else {
        expect(onSelectReasoningEffort).toHaveBeenCalledWith(
          expected,
          'toggle',
        );
      }
    },
  );

  it('localizes every fixed effort tier after a runtime language change', () => {
    const props: ChatEditorRenderProps = {
      visibleToolbarActions: ['model'],
      currentModel: 'reasoning-model',
      availableModels: [{ id: 'reasoning-model', label: 'Reasoning Model' }],
      reasoning: {
        enabled: true,
        effort: 'max',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    };
    const container = renderChatEditor(props);

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-model-button]')
        ?.click();
    });
    let controls = document.querySelector('[data-web-shell-model-reasoning]');
    expect(controls?.textContent).toContain('High');
    expect(controls?.textContent).toContain('Max');
    expect(controls?.textContent).not.toContain('reasoning.effort.');

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    rerenderChatEditor(container, { ...props, language: 'zh-CN' });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-web-shell-model-button]')
        ?.click();
    });
    controls = document.querySelector('[data-web-shell-model-reasoning]');
    expect(controls?.textContent).toContain('高');
    expect(controls?.textContent).toContain('最高');
    expect(controls?.textContent).not.toContain('High');
    expect(controls?.textContent).not.toContain('reasoning.effort.');
  });

  it('renders an unknown provider default as Thinking without a Default effort', () => {
    const container = renderChatEditor({
      visibleToolbarActions: ['model'],
      currentModel: 'reasoning-model',
      availableModels: [{ id: 'reasoning-model', label: 'Reasoning Model' }],
      reasoning: {
        enabled: true,
        effort: 'default',
        efforts: ['low', 'max'],
      },
    });

    const modelButton = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-model-button]',
    );
    expect(modelButton?.textContent).toContain('Thinking');
    expect(modelButton?.textContent).not.toContain('Default');
    expect(modelButton?.textContent).not.toContain('reasoning.effort.');

    act(() => modelButton?.click());
    const controls = document.querySelector('[data-web-shell-model-reasoning]');
    expect(controls?.textContent).not.toContain('Default');
    expect(
      Array.from(
        controls?.querySelectorAll('[data-web-shell-effort]') ?? [],
      ).every((button) => button.getAttribute('aria-pressed') === 'false'),
    ).toBe(true);
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

  it('localizes the approval-mode button accessible name', () => {
    const english = renderChatEditor({
      visibleToolbarActions: ['approvalMode'],
      language: 'en',
    });
    const chinese = renderChatEditor({
      visibleToolbarActions: ['approvalMode'],
      language: 'zh-CN',
    });

    expect(
      english
        .querySelector('[data-web-shell-mode-button]')
        ?.getAttribute('aria-label'),
    ).toBe('Approval mode');
    expect(
      chinese
        .querySelector('[data-web-shell-mode-button]')
        ?.getAttribute('aria-label'),
    ).toBe('审批模式');
  });
});

describe('ChatEditor slash command popovers', () => {
  it('keeps Skill status messages out of populated local command menus', () => {
    composerCoreState.slashMenu = {
      kind: 'command',
      from: 0,
      to: 3,
      query: 'th',
      selectedIndex: 0,
      items: [{ id: 'theme', label: '/theme', apply: '/theme ' }],
    };
    const container = renderChatEditor({ skillsLoading: true });
    expect(
      document.querySelector('[data-web-shell-slash-menu]')?.textContent,
    ).toContain('/theme');
    expect(
      document.querySelector('[data-web-shell-slash-menu]')?.textContent,
    ).not.toContain('Loading skills...');
    rerenderChatEditor(container, { skillsLoadError: true });
    expect(
      document.querySelector('[data-web-shell-slash-menu]')?.textContent,
    ).not.toContain('Failed to load results');
  });

  it('requests Skills when slash suggestions open and shows loading and failure states', () => {
    const onSkillsOpenChange = vi.fn();
    const props = { onSkillsOpenChange, skillsLoading: true };
    const container = renderChatEditor(props);
    expect(onSkillsOpenChange).not.toHaveBeenCalledWith(true);
    composerCoreState.slashMenu = {
      kind: 'command',
      from: 0,
      to: 7,
      query: 'review',
      selectedIndex: 0,
      items: [],
    };
    rerenderChatEditor(container, props);
    expect(onSkillsOpenChange).toHaveBeenLastCalledWith(true);
    expect(
      document.querySelector('[data-web-shell-slash-menu]')?.textContent,
    ).toContain('Loading...');
    expect(
      document
        .querySelector('[data-web-shell-slash-menu]')
        ?.getAttribute('role'),
    ).toBeNull();
    rerenderChatEditor(container, {
      ...props,
      skillsLoading: false,
      skillsLoadError: true,
    });
    expect(
      document.querySelector('[data-web-shell-slash-menu]')?.textContent,
    ).toContain('Failed to load results');
    rerenderChatEditor(container, { onSkillsOpenChange, skillsLoaded: false });
    expect(
      document.querySelector('[data-web-shell-slash-menu] [role="status"]'),
    ).toBeNull();
    // A settled catalog renders no status row: the composed app closes an
    // empty panel via allowEmptySlashMenu, so a "no results" arm would only
    // ever flash for one frame.
    rerenderChatEditor(container, { onSkillsOpenChange, skillsLoaded: true });
    expect(
      document.querySelector('[data-web-shell-slash-menu] [role="status"]'),
    ).toBeNull();
    composerCoreState.slashMenu = null;
    rerenderChatEditor(container, props);
    expect(onSkillsOpenChange).toHaveBeenLastCalledWith(false);
  });

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

describe('ChatEditor mobile composer actions', () => {
  function mobileComposer(value = ''): MobileComposerBackend {
    const backend = {
      textareaRef: createRef<HTMLTextAreaElement>(),
      value,
      onChange: vi.fn(),
      onBlur: vi.fn(),
      placeholder: '',
    };
    composerCoreState.mobileComposer = backend;
    return backend;
  }

  async function clickButton(label: string) {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent === label ||
        candidate.getAttribute('aria-label') === label,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  it('opens history from the add drawer without simulated keyboard keys', async () => {
    mobileComposer();
    renderChatEditor({ visibleToolbarActions: ['addMenu'] });
    await clickButton('Add to message');
    expect(
      document.querySelector('[data-web-shell-mobile-add-menu]'),
    ).not.toBeNull();
    expect(document.querySelector('[aria-label="more actions"]')).toBeNull();
    expect(
      Array.from(document.querySelectorAll('button')).some((button) =>
        ['Tab', 'Esc', '←', '→'].includes(button.textContent ?? ''),
      ),
    ).toBe(false);
    await clickButton('Input history');
    expect(composerCoreState.openHistorySearch).toHaveBeenCalledOnce();
  });

  it('calls history navigation directly without submitting or moving focus', async () => {
    const backend = mobileComposer('working draft');
    const onSubmit = vi.fn();
    const container = renderChatEditor({ onSubmit });
    act(() => backend.textareaRef.current!.focus());
    const previous = container.querySelector<HTMLButtonElement>(
      '[aria-label="Previous input"]',
    )!;
    const pointerDown = new Event('pointerdown', {
      bubbles: true,
      cancelable: true,
    });
    previous.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    composerCoreState.focus.mockClear();
    await clickButton('Previous input');
    await clickButton('Next input');
    expect(composerCoreState.navigatePrevHistory).toHaveBeenCalledOnce();
    expect(composerCoreState.navigateNextHistory).toHaveBeenCalledOnce();
    expect(composerCoreState.focus).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(backend.textareaRef.current);
  });

  it('disables both history buttons when the composer is disabled', () => {
    mobileComposer('draft');
    const container = renderChatEditor({ disabled: true });
    for (const label of ['Previous input', 'Next input']) {
      const button = container.querySelector<HTMLButtonElement>(
        `[aria-label="${label}"]`,
      )!;
      expect(button.disabled).toBe(true);
      act(() => button.click());
    }
    expect(composerCoreState.navigatePrevHistory).not.toHaveBeenCalled();
    expect(composerCoreState.navigateNextHistory).not.toHaveBeenCalled();
  });

  it('keeps the history arrow controls out of the desktop composer', () => {
    const container = renderChatEditor({});
    expect(container.querySelector('[aria-label="Previous input"]')).toBeNull();
    expect(container.querySelector('[aria-label="Next input"]')).toBeNull();
  });

  it('keeps stop and send reachable with a draft without clearing it', async () => {
    const backend = mobileComposer('keep this draft');
    composerCoreState.hasContent = true;
    const onCancel = vi.fn();
    const container = renderChatEditor({ isRunning: true, onCancel });
    const stop = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-composer-stop]',
    )!;
    expect(stop.disabled).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-web-shell-composer-submit]',
      )!.disabled,
    ).toBe(false);
    act(() => stop.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(backend.textareaRef.current!.value).toBe('keep this draft');
    expect(composerCoreState.setText).not.toHaveBeenCalled();
  });

  it('blurs the textarea without bubbling back into composer focus', async () => {
    const backend = mobileComposer('draft');
    renderChatEditor({});
    act(() => backend.textareaRef.current!.focus());
    composerCoreState.focus.mockClear();
    await clickButton('Hide keyboard');
    expect(document.activeElement).not.toBe(backend.textareaRef.current);
    expect(composerCoreState.focus).not.toHaveBeenCalled();
    expect(backend.textareaRef.current!.value).toBe('draft');
  });

  it('expands the same draft and restores selection without dropping attachments', async () => {
    const backend = mobileComposer('hello world');
    const container = renderChatEditor({
      pastedFiles: [
        { name: 'notes.txt', media_type: 'text/plain', text: 'notes' },
      ],
    });
    backend.textareaRef.current!.setSelectionRange(2, 5);
    await clickButton('Expand editor');
    const expanded = document.querySelector<HTMLTextAreaElement>(
      '[data-web-shell-expanded-editor] textarea',
    )!;
    expect(expanded.value).toBe('hello world');
    expect([expanded.selectionStart, expanded.selectionEnd]).toEqual([2, 5]);
    await clickButton('Done');
    expect(backend.textareaRef.current!.value).toBe('hello world');
    expect([
      backend.textareaRef.current!.selectionStart,
      backend.textareaRef.current!.selectionEnd,
    ]).toEqual([2, 5]);
    expect(
      container.querySelector('[data-web-shell-composer-attachments]')!
        .textContent,
    ).toContain('notes');
    expect(mockComposerCoreState.pastedFiles).toHaveLength(1);
  });

  it('closes expanded editing when the owning session changes', async () => {
    mobileComposer('draft');
    const container = renderChatEditor({ sessionId: 'a' });
    await clickButton('Expand editor');
    rerenderChatEditor(container, { sessionId: 'b' });
    expect(
      document.querySelector('[data-web-shell-expanded-editor]'),
    ).toBeNull();
  });

  it('offers explicit shell exit without canceling a turn', async () => {
    mobileComposer();
    composerCoreState.shellMode = true;
    const onCancel = vi.fn();
    renderChatEditor({ isRunning: true, onCancel });
    await clickButton('Exit Shell');
    expect(composerCoreState.setShellMode).toHaveBeenCalledWith(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('retains the reduced toolbar during mobile voice capture', () => {
    mobileComposer();
    const container = renderChatEditor({
      currentModel: 'qwen-test',
      availableModels: [{ id: 'qwen-test' }],
    });
    act(() => voiceButtonState.onActiveChange?.(true));
    expect(
      container.querySelector('[data-mobile-voice-active="true"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-web-shell-composer-submit]'),
    ).not.toBeNull();
    act(() => voiceButtonState.onActiveChange?.(false));
    expect(
      container.querySelector('[data-mobile-voice-active="true"]'),
    ).toBeNull();
  });
});

describe('ChatEditor at mention context fallback', () => {
  const tablesProvider = {
    id: 'tables',
    label: 'Tables',
    async search() {
      return [];
    },
  };
  const hostFilesProvider = {
    id: 'files-host',
    label: 'Host files',
    async search() {
      return [];
    },
  };

  it('uses customization atProviders when ChatEditor props omit them', () => {
    const contextProviders = [tablesProvider];
    renderChatEditor({
      customization: { atProviders: contextProviders },
    });
    expect(latestComposerCoreOptions.current?.atProviders).toBe(
      contextProviders,
    );
  });

  it('prefers explicit atProviders props over customization', () => {
    const contextProviders = [tablesProvider];
    const propProviders = [hostFilesProvider];
    renderChatEditor({
      customization: { atProviders: contextProviders },
      atProviders: propProviders,
    });
    expect(latestComposerCoreOptions.current?.atProviders).toBe(propProviders);
  });

  it('uses customization builtinAtProviders when ChatEditor props omit them', () => {
    const builtinAtProviders = { exclude: ['extensions'] as const };
    renderChatEditor({
      customization: { builtinAtProviders },
    });
    expect(latestComposerCoreOptions.current?.builtinAtProviders).toBe(
      builtinAtProviders,
    );
  });

  it('prefers explicit builtinAtProviders props over customization', () => {
    renderChatEditor({
      customization: { builtinAtProviders: { exclude: ['extensions'] } },
      builtinAtProviders: { exclude: ['files'] },
    });
    expect(latestComposerCoreOptions.current?.builtinAtProviders).toEqual({
      exclude: ['files'],
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

  const chooseDropAction = (action: 'cancel' | 'reference' | 'upload') => {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-web-shell-drop-choice-dialog] [data-drop-action="${action}"]`,
    );
    expect(button).not.toBeNull();
    act(() => button?.click());
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

  it('fileUploadEnabled={false} keeps attachment drag-and-drop enabled', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    renderChatEditor({ customization: { fileUploadEnabled: false } });
    expect(latestComposerCoreOptions.current?.fileDragEnabled).toBe(true);
  });

  it('disables attachment drag feedback when attachments are disabled', () => {
    renderChatEditor({ attachmentsEnabled: false });
    expect(latestComposerCoreOptions.current?.fileDragEnabled).toBe(false);
  });

  it('does not advertise upload for an attach-only drop preference', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    const container = renderChatEditor({
      customization: { fileDropAction: 'attach' },
    });
    dispatchDrag(
      container.querySelector('[data-web-shell-composer-editor]')!,
      'dragenter',
      ['Files'],
    );
    expect(container.querySelector('[data-upload-drag-active]')).toBeNull();
  });

  it('enables file drag-and-drop in the composer core by default', () => {
    uploadWorkspaceState.current = makeWorkspace(['workspace_file_upload']);
    renderChatEditor({});
    expect(latestComposerCoreOptions.current?.fileDragEnabled).toBe(true);
  });

  it('fileUploadEnabled={false} routes drops to attachments without asking', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    composerCoreState.imageDropCapture.mockImplementation((event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const container = renderChatEditor({
      customization: { fileUploadEnabled: false },
    });
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const drop = dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [new File(['abc'], 'notes.txt')],
    );
    expect(drop.defaultPrevented).toBe(true);
    expect(composerCoreState.imageDropCapture).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).toBeNull();
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(composerCoreState.addTags).not.toHaveBeenCalled();
    expect(container.querySelector('[data-web-shell-upload-strip]')).toBeNull();
  });

  it.each([
    ['upload', true],
    ['attach', true],
    [undefined, false],
    ['attach', false],
  ] as const)(
    'routes default %s with attachments %s without asking',
    async (fileDropAction, attachmentsEnabled) => {
      const workspace = makeWorkspace(['workspace_file_upload']);
      workspace.client.uploadWorkspaceFile.mockResolvedValue({
        kind: 'file_upload',
        path: 'uploads/notes.txt',
        sizeBytes: 3,
        hash: `sha256:${'a'.repeat(64)}`,
      });
      uploadWorkspaceState.current = workspace;
      const container = renderChatEditor({
        attachmentsEnabled,
        customization: { fileDropAction, fileUploadDirectory: 'uploads' },
      });
      const files = [new File(['abc'], 'notes.txt')];
      const drop = dispatchDrag(
        container.querySelector('[data-web-shell-composer-editor]')!,
        'drop',
        ['Files'],
        files,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(drop.defaultPrevented).toBe(true);
      expect(
        document.querySelector('[data-web-shell-drop-choice-dialog]'),
      ).toBeNull();
      expect(composerCoreState.focus).toHaveBeenCalled();
      if (fileDropAction === 'attach' && attachmentsEnabled) {
        expect(composerCoreState.ingestFiles).toHaveBeenCalledWith(files);
        expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
      } else {
        expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
        expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledWith(
          expect.objectContaining({
            path: 'uploads/notes.txt',
            data: files[0],
          }),
        );
        expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
      }
    },
  );

  it('falls back to attachments when the preferred upload is unavailable', () => {
    uploadWorkspaceState.current = makeWorkspace([]);
    const container = renderChatEditor({
      customization: { fileDropAction: 'upload' },
    });
    dispatchDrag(
      container.querySelector('[data-web-shell-composer-editor]')!,
      'drop',
      ['Files'],
      [new File(['abc'], 'notes.txt')],
    );
    expect(composerCoreState.imageDropCapture).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).toBeNull();
  });

  it('cancels drops when neither destination is available', () => {
    const workspace = makeWorkspace([]);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({
      attachmentsEnabled: false,
      customization: { fileDropAction: 'upload' },
    });
    const onDrop = vi.fn();
    container.addEventListener('drop', onDrop);
    const drop = dispatchDrag(
      container.querySelector('[data-web-shell-composer-editor]')!,
      'drop',
      ['Files'],
      [new File(['abc'], 'notes.txt')],
    );
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(drop.defaultPrevented).toBe(true);
    expect(composerCoreState.imageDropCapture).not.toHaveBeenCalled();
    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).toBeNull();
  });

  it.each([
    { attachmentsEnabled: false },
    { customization: { fileDropAction: 'attach' as const } },
  ])('closes a pending choice when routing changes: %j', (props) => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    dispatchDrag(
      container.querySelector('[data-web-shell-composer-editor]')!,
      'drop',
      ['Files'],
      [new File(['abc'], 'notes.txt')],
    );
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).not.toBeNull();
    rerenderChatEditor(container, props);
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).toBeNull();
    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('asks whether dropped files should be referenced or uploaded', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const files = [new File(['png'], 'photo.png', { type: 'image/png' })];

    dispatchDrag(editor, 'drop', ['Files'], files);

    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).not.toBeNull();
    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();

    chooseDropAction('reference');
    expect(composerCoreState.ingestFiles).toHaveBeenCalledWith(files);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('keeps the first drop while its choice dialog is open', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const firstFiles = [new File(['a'], 'first.txt')];

    dispatchDrag(editor, 'drop', ['Files'], firstFiles);
    dispatchDrag(editor, 'drop', ['Files'], [new File(['b'], 'second.txt')]);
    chooseDropAction('reference');

    expect(composerCoreState.ingestFiles).toHaveBeenCalledTimes(1);
    expect(composerCoreState.ingestFiles).toHaveBeenCalledWith(firstFiles);
  });

  it('cancels a dropped-file choice without ingesting or uploading', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;

    dispatchDrag(editor, 'drop', ['Files'], [new File(['x'], 'notes.txt')]);
    chooseDropAction('cancel');

    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('closes a dropped-file choice when the session target changes', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({ sessionId: 'session-a' });
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;

    dispatchDrag(editor, 'drop', ['Files'], [new File(['x'], 'notes.txt')]);
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).not.toBeNull();

    rerenderChatEditor(container, { sessionId: 'session-b' });

    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).toBeNull();
    expect(composerCoreState.ingestFiles).not.toHaveBeenCalled();
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('lets an arbitrary file be referenced', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'uploaded-file',
      sizeBytes: 3,
      hash: `sha256:${'a'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;

    dispatchDrag(
      editor,
      'drop',
      ['Files'],
      [new File(['pdf'], 'report.pdf', { type: 'application/pdf' })],
    );

    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).not.toBeNull();
    chooseDropAction('reference');
    expect(composerCoreState.ingestFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'report.pdf' }),
    ]);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('lets the attachment ingestion path decide whether a large file can be referenced', () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    const files = [
      new File([new Uint8Array(512 * 1024 + 1)], 'large.txt', {
        type: 'text/plain',
      }),
    ];

    dispatchDrag(editor, 'drop', ['Files'], files);

    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-drop-action="reference"]',
      )?.disabled,
    ).toBe(false);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();

    chooseDropAction('reference');
    expect(composerCoreState.ingestFiles).toHaveBeenCalledWith(files);
  });

  it('uploads dropped files into the configured directory', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'uploads/notes.txt',
      sizeBytes: 3,
      hash: `sha256:${'b'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({
      customization: { fileUploadDirectory: 'uploads' },
    });
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    dispatchDrag(editor, 'drop', ['Files'], [new File(['abc'], 'notes.txt')]);
    chooseDropAction('upload');
    await act(async () => {});

    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile.mock.calls[0][0].path).toBe(
      'uploads/notes.txt',
    );
    // The directory flows through the whole chain: request path, server
    // response, and the inserted @reference.
    expect(composerCoreState.addTags).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          kind: 'file',
          value: 'uploads/notes.txt',
        }),
      ],
      { placement: 'inline', position: 'end' },
    );
  });

  it('uploads dropped files to the workspace root by default', async () => {
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'notes.txt',
      sizeBytes: 3,
      hash: `sha256:${'d'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({});
    const editor = container.querySelector('[data-web-shell-composer-editor]')!;
    dispatchDrag(editor, 'drop', ['Files'], [new File(['abc'], 'notes.txt')]);
    chooseDropAction('upload');
    await act(async () => {});

    expect(workspace.client.uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(workspace.client.uploadWorkspaceFile.mock.calls[0][0].path).toBe(
      'notes.txt',
    );
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

  it('lets every file in a mixed batch be referenced', () => {
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
        new File(['pdf'], 'report.pdf', { type: 'application/pdf' }),
      ],
    );
    expect(drop.defaultPrevented).toBe(true);
    expect(composerCoreState.imageDropCapture).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).not.toBeNull();
    chooseDropAction('reference');
    expect(composerCoreState.ingestFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'photo.png' }),
      expect.objectContaining({ name: 'data.csv' }),
      expect.objectContaining({ name: 'report.pdf' }),
    ]);
    expect(workspace.client.uploadWorkspaceFile).not.toHaveBeenCalled();
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
    chooseDropAction('upload');

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
    chooseDropAction('upload');
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
    const onAttachmentPreview = vi.fn();
    const workspace = makeWorkspace(['workspace_file_upload']);
    workspace.client.uploadWorkspaceFile.mockResolvedValue({
      kind: 'file_upload',
      path: 'docs/notes.txt',
      sizeBytes: 3,
      hash: `sha256:${'a'.repeat(64)}`,
    });
    uploadWorkspaceState.current = workspace;
    const container = renderChatEditor({ onAttachmentPreview });
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
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-status="done"] button[class*="uploadRowPreview"]',
        )
        ?.click();
    });
    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'notes.txt',
      workspacePath: 'docs/notes.txt',
    });
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

  it('does not infer reference intent from an image file type', () => {
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
    expect(composerCoreState.imageDropCapture).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-web-shell-drop-choice-dialog]'),
    ).not.toBeNull();
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
    chooseDropAction('upload');
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
    expect(
      row?.querySelector('[title="Saved as report (1).txt"]'),
    ).not.toBeNull();
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
    chooseDropAction('upload');
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
    chooseDropAction('upload');
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
    chooseDropAction('upload');
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
    chooseDropAction('upload');
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
    chooseDropAction('upload');
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
      chooseDropAction('upload');
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
