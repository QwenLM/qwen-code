// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ChatEditor, type ComposerToolbarAction } from './ChatEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
      focus: vi.fn(),
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
      composerTags: [],
      removeTopTag: vi.fn(),
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
      slashMenu: null,
      closeSlashMenu: vi.fn(),
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

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function renderChatEditor(props: {
  gitBranch?: string;
  workspaceName?: string;
  workspaceTitle?: string;
  visibleToolbarActions?: readonly ComposerToolbarAction[];
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  act(() => {
    root.render(
      <I18nProvider language="en">
        <ChatEditor
          onSubmit={() => undefined}
          commands={[]}
          showChatWidthToggle={false}
          currentMode="default"
          currentModel="qwen"
          {...props}
        />
      </I18nProvider>,
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
    expect(chip?.getAttribute('title')).toBe('/work/api');
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
        ?.getAttribute('title'),
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
