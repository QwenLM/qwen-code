// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  ArchivedSessionsPanel,
  type ArchivedEmptyState,
  type ArchivedWorkspaceGroup,
} from './ArchivedSessionsPanel';
import type {
  ArchivedConversationType,
  ArchivedSessionSort,
} from './archived-session-sort';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function pointerClick(element: HTMLElement): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.click();
}

function makeSession(
  sessionId: string,
  displayName: string,
): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/tmp/project',
    displayName,
    isArchived: true,
    updatedAt: '2026-11-20T10:00:00Z',
  };
}

function makeGroups(): ArchivedWorkspaceGroup[] {
  return [
    {
      cwd: '/tmp/qwen',
      label: 'qwen-code',
      sessions: [
        makeSession('s1', 'Fix archived search'),
        makeSession('s2', 'Add sort menu'),
      ],
      hasMore: true,
      loadingMore: false,
    },
  ];
}

async function renderPanel(
  overrides: Partial<{
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    typeFilter: ArchivedConversationType;
    onTypeFilterChange: (value: ArchivedConversationType) => void;
    typeOptions: Array<{ value: ArchivedConversationType; label: string }>;
    sortBy: ArchivedSessionSort;
    onSortByChange: (value: ArchivedSessionSort) => void;
    workspaceFilter: string;
    onWorkspaceFilterChange: (value: string) => void;
    showWorkspaceFilter: boolean;
    workspaceGroups: ArchivedWorkspaceGroup[];
    onLoadMoreWorkspace: (cwd: string) => void;
    managedContent: React.ReactNode;
    standaloneContent: React.ReactNode;
    showPaginationSortHint: boolean;
    emptyState: ArchivedEmptyState;
    showFooterRetry: boolean;
    onRetry: () => void;
    onClearFilters: () => void;
    onShowAllWorkspaces: () => void;
  }> = {},
) {
  const onSearchQueryChange = overrides.onSearchQueryChange ?? vi.fn();
  const onTypeFilterChange = overrides.onTypeFilterChange ?? vi.fn();
  const onSortByChange = overrides.onSortByChange ?? vi.fn();
  const onWorkspaceFilterChange = overrides.onWorkspaceFilterChange ?? vi.fn();
  const onLoadMoreWorkspace = overrides.onLoadMoreWorkspace ?? vi.fn();
  const onRetry = overrides.onRetry ?? vi.fn();
  const onClearFilters = overrides.onClearFilters ?? vi.fn();
  const onShowAllWorkspaces = overrides.onShowAllWorkspaces ?? vi.fn();

  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ArchivedSessionsPanel
          searchQuery={overrides.searchQuery ?? ''}
          onSearchQueryChange={onSearchQueryChange}
          typeFilter={overrides.typeFilter ?? 'all'}
          onTypeFilterChange={onTypeFilterChange}
          typeOptions={
            overrides.typeOptions ?? [
              { value: 'all', label: 'All conversations' },
              { value: 'tasks', label: 'Tasks' },
              { value: 'channels', label: 'Channels' },
            ]
          }
          sortBy={overrides.sortBy ?? 'updatedAt'}
          onSortByChange={onSortByChange}
          sortOptions={[
            { value: 'updatedAt', label: 'Updated' },
            { value: 'lastUserPromptAt', label: 'Last question' },
            { value: 'createdAt', label: 'Created' },
            { value: 'alphabetical', label: 'Alphabetical' },
          ]}
          workspaceFilter={overrides.workspaceFilter ?? 'all'}
          onWorkspaceFilterChange={onWorkspaceFilterChange}
          workspaceOptions={[
            { value: '/tmp/qwen', label: 'qwen-code', count: 2 },
            { value: '/tmp/other', label: 'other-repo', count: 1 },
          ]}
          showWorkspaceFilter={overrides.showWorkspaceFilter ?? true}
          workspaceGroups={overrides.workspaceGroups ?? makeGroups()}
          renderSession={(session) => (
            <div key={session.sessionId} data-testid="archived-card-row">
              {session.displayName}
            </div>
          )}
          onLoadMoreWorkspace={onLoadMoreWorkspace}
          managedContent={overrides.managedContent}
          standaloneContent={overrides.standaloneContent}
          showPaginationSortHint={overrides.showPaginationSortHint ?? false}
          emptyState={overrides.emptyState ?? 'none'}
          showFooterRetry={overrides.showFooterRetry ?? false}
          onRetry={onRetry}
          onClearFilters={onClearFilters}
          onShowAllWorkspaces={onShowAllWorkspaces}
          formatGroupCount={(count, hasMore) =>
            hasMore ? `${count}+ conversations` : `${count} conversations`
          }
        />
      </I18nProvider>,
    ),
  );

  return {
    onSearchQueryChange,
    onTypeFilterChange,
    onSortByChange,
    onWorkspaceFilterChange,
    onLoadMoreWorkspace,
    onRetry,
    onClearFilters,
    onShowAllWorkspaces,
  };
}

describe('ArchivedSessionsPanel', () => {
  it('clears non-empty search on clear button or Escape without propagating', async () => {
    const onSearchQueryChange = vi.fn();
    const outerKeyDown = vi.fn();
    document.body.addEventListener('keydown', outerKeyDown);

    try {
      await renderPanel({
        searchQuery: 'archive',
        onSearchQueryChange,
      });

      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Search archived conversations"]',
      )!;
      expect(input).not.toBeNull();

      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(onSearchQueryChange).toHaveBeenCalledWith('');
      expect(outerKeyDown).not.toHaveBeenCalled();

      onSearchQueryChange.mockClear();
      const clearButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear search"]',
      )!;
      expect(clearButton).not.toBeNull();
      await act(async () => {
        clearButton.click();
      });
      expect(onSearchQueryChange).toHaveBeenCalledWith('');

      await renderPanel({
        searchQuery: '',
        onSearchQueryChange,
      });
      expect(
        container.querySelector('button[aria-label="Clear search"]'),
      ).toBeNull();
      const emptyInput = container.querySelector<HTMLInputElement>(
        'input[aria-label="Search archived conversations"]',
      )!;
      await act(async () => {
        emptyInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(outerKeyDown).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeEventListener('keydown', outerKeyDown);
    }
  });

  it('omits Type section when only one type exists and switches Type/Sort when populated', async () => {
    await renderPanel({
      typeOptions: [{ value: 'all', label: 'All conversations' }],
    });
    const singleTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Filter and sort archived conversations"]',
    )!;
    expect(singleTrigger.textContent).toContain('Updated');
    await act(async () => {
      pointerClick(singleTrigger);
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain('All conversations');
    expect(
      Array.from(document.body.querySelectorAll('[role="menuitemradio"]')).map(
        (item) => item.textContent,
      ),
    ).toEqual(['Updated', 'Last question', 'Created', 'Alphabetical']);
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });

    const onTypeFilterChange = vi.fn();
    const onSortByChange = vi.fn();
    await renderPanel({ onTypeFilterChange, onSortByChange });
    const fullTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Filter and sort archived conversations"]',
    )!;
    expect(fullTrigger.textContent).toContain('All conversations');
    await act(async () => {
      pointerClick(fullTrigger);
      await Promise.resolve();
    });
    const radios = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    expect(radios.map((item) => item.textContent)).toEqual([
      'All conversations',
      'Tasks',
      'Channels',
      'Updated',
      'Last question',
      'Created',
      'Alphabetical',
    ]);
    await act(async () => {
      pointerClick(radios.find((item) => item.textContent === 'Channels')!);
      await Promise.resolve();
    });
    expect(onTypeFilterChange).toHaveBeenCalledWith('channels');

    await act(async () => {
      pointerClick(fullTrigger);
      await Promise.resolve();
    });
    const radiosReopened = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    await act(async () => {
      pointerClick(
        radiosReopened.find((item) => item.textContent === 'Alphabetical')!,
      );
      await Promise.resolve();
    });
    expect(onSortByChange).toHaveBeenCalledWith('alphabetical');
  });

  it('toggles workspace selector visibility and handles group cards, Load more, errors, and empty states', async () => {
    const onLoadMoreWorkspace = vi.fn();
    await renderPanel({
      showWorkspaceFilter: false,
      showPaginationSortHint: true,
      onLoadMoreWorkspace,
      workspaceGroups: [
        {
          cwd: '/tmp/qwen',
          label: 'qwen-code',
          sessions: [makeSession('s1', 'Row 1')],
          hasMore: true,
          loadingMore: false,
          loadMoreError: 'Cursor expired',
        },
      ],
    });

    expect(container.querySelector('[aria-label="All workspaces"]')).toBeNull();
    expect(container.textContent).toContain('1+ conversations');
    expect(container.textContent).toContain(
      'Sorting applies to loaded conversations in each workspace.',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Cursor expired',
    );

    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Load more',
    )!;
    await act(async () => loadMoreBtn.click());
    expect(onLoadMoreWorkspace).toHaveBeenCalledWith('/tmp/qwen');

    const { onClearFilters } = await renderPanel({
      workspaceGroups: [],
      emptyState: 'filtered',
    });
    expect(container.textContent).toContain(
      'No matching archived conversations.',
    );
    const clearFiltersBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((btn) => btn.textContent === 'Clear filters')!;
    await act(async () => clearFiltersBtn.click());
    expect(onClearFilters).toHaveBeenCalledOnce();

    const { onShowAllWorkspaces } = await renderPanel({
      workspaceGroups: [],
      emptyState: 'workspace',
    });
    expect(container.textContent).toContain(
      'No archived conversations in this workspace.',
    );
    const showAllBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Show all workspaces',
    )!;
    await act(async () => showAllBtn.click());
    expect(onShowAllWorkspaces).toHaveBeenCalledOnce();

    const { onRetry } = await renderPanel({
      workspaceGroups: [],
      emptyState: 'retry',
      showFooterRetry: true,
    });
    const retryButtons = Array.from(
      container.querySelectorAll('button'),
    ).filter((btn) => btn.textContent?.includes('Failed to load'));
    expect(retryButtons).toHaveLength(2);
    await act(async () => retryButtons[0]!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
