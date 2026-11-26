import type { CSSProperties, ReactNode } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  ChevronDownIcon,
  FolderClosedIcon,
  ListFilterIcon,
  LoaderCircleIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import type {
  ArchivedConversationType,
  ArchivedSessionSort,
} from './archived-session-sort';

export interface ArchivedTypeOption {
  value: ArchivedConversationType;
  label: string;
}

export interface ArchivedSortOption {
  value: ArchivedSessionSort;
  label: string;
}

export interface ArchivedWorkspaceOption {
  value: string;
  label: string;
  count?: number;
}

export interface ArchivedWorkspaceGroup {
  cwd: string;
  label: string;
  sessions: DaemonSessionSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError?: string;
}

export type ArchivedEmptyState =
  | 'none'
  | 'retry'
  | 'filtered'
  | 'workspace'
  | 'empty';

interface ArchivedSessionsPanelProps {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  typeFilter: ArchivedConversationType;
  onTypeFilterChange: (value: ArchivedConversationType) => void;
  typeOptions: ArchivedTypeOption[];
  sortBy: ArchivedSessionSort;
  onSortByChange: (value: ArchivedSessionSort) => void;
  sortOptions: ArchivedSortOption[];
  workspaceFilter: string;
  onWorkspaceFilterChange: (value: string) => void;
  workspaceOptions: ArchivedWorkspaceOption[];
  showWorkspaceFilter: boolean;
  workspaceGroups: ArchivedWorkspaceGroup[];
  renderSession: (session: DaemonSessionSummary) => ReactNode;
  onLoadMoreWorkspace: (cwd: string) => void;
  managedContent?: ReactNode;
  standaloneContent?: ReactNode;
  showPaginationSortHint: boolean;
  emptyState: ArchivedEmptyState;
  showFooterRetry: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
  onShowAllWorkspaces: () => void;
  formatGroupCount: (count: number, hasMore: boolean) => string;
}

const POPOVER_PORTAL_STYLE: CSSProperties = {
  zIndex: 'calc(var(--web-shell-popover-z-index, 1000) + 1)',
};

export function ArchivedSessionsPanel({
  searchQuery,
  onSearchQueryChange,
  typeFilter,
  onTypeFilterChange,
  typeOptions,
  sortBy,
  onSortByChange,
  sortOptions,
  workspaceFilter,
  onWorkspaceFilterChange,
  workspaceOptions,
  showWorkspaceFilter,
  workspaceGroups,
  renderSession,
  onLoadMoreWorkspace,
  managedContent,
  standaloneContent,
  showPaginationSortHint,
  emptyState,
  showFooterRetry,
  onRetry,
  onClearFilters,
  onShowAllWorkspaces,
  formatGroupCount,
}: ArchivedSessionsPanelProps) {
  const { t } = useI18n();
  const activeTypeOption =
    typeOptions.find((option) => option.value === typeFilter) ?? typeOptions[0];
  const activeSortOption =
    sortOptions.find((option) => option.value === sortBy) ?? sortOptions[0];
  const filterTriggerLabel =
    typeOptions.length > 1
      ? (activeTypeOption?.label ?? '')
      : (activeSortOption?.label ?? '');
  const selectedWorkspaceLabel =
    workspaceFilter === 'all'
      ? t('sidebar.allWorkspaces')
      : (workspaceOptions.find((option) => option.value === workspaceFilter)
          ?.label ?? t('sidebar.allWorkspaces'));

  return (
    <div data-web-shell-archived-panel>
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="relative min-w-[180px] flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="text"
            className="h-9 rounded-full pr-8 pl-9 text-sm"
            value={searchQuery}
            placeholder={t('sidebar.archivedSearchPlaceholder')}
            aria-label={t('sidebar.archivedSearchPlaceholder')}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchQuery.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                onSearchQueryChange('');
              }
            }}
          />
          {searchQuery.length > 0 && (
            <button
              type="button"
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={t('sidebar.clearSearch')}
              title={t('sidebar.clearSearch')}
              onClick={() => onSearchQueryChange('')}
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-1.5 rounded-full px-3 font-normal"
              aria-label={t('sidebar.archiveFilterAndSort')}
            >
              <ListFilterIcon
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="max-w-36 truncate">{filterTriggerLabel}</span>
              <ChevronDownIcon
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-48"
            style={POPOVER_PORTAL_STYLE}
          >
            {typeOptions.length > 1 && (
              <>
                <DropdownMenuLabel>
                  {t('sidebar.archiveType')}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={typeFilter}
                  onValueChange={(value) =>
                    onTypeFilterChange(value as ArchivedConversationType)
                  }
                >
                  {typeOptions.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuLabel>{t('sidebar.sortBy')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sortBy}
              onValueChange={(value) =>
                onSortByChange(value as ArchivedSessionSort)
              }
            >
              {sortOptions.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {showWorkspaceFilter && (
          <Select
            value={workspaceFilter}
            onValueChange={onWorkspaceFilterChange}
          >
            <SelectTrigger
              size="sm"
              className="h-9 max-w-[220px] shrink-0 gap-1.5 rounded-full px-3 font-normal data-[size=sm]:h-9 data-[size=sm]:rounded-full"
              aria-label={t('sidebar.allWorkspaces')}
            >
              <FolderClosedIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <SelectValue>{selectedWorkspaceLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="end"
              style={POPOVER_PORTAL_STYLE}
            >
              <SelectGroup>
                <SelectItem value="all">
                  {t('sidebar.allWorkspaces')}
                </SelectItem>
                {workspaceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="min-w-0 truncate">{option.label}</span>
                      {option.count !== undefined && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {option.count}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>

      {showPaginationSortHint && (
        <p className="px-1 pb-2 text-xs text-muted-foreground">
          {t('sidebar.archivedPaginationHint')}
        </p>
      )}

      {managedContent}
      {standaloneContent}

      {workspaceGroups.map((group) => (
        <section
          key={group.cwd}
          className="mb-4"
          aria-label={`${t('sidebar.archivedTitle')}: ${group.label}`}
        >
          <div className="mb-1.5 flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <FolderClosedIcon
              size={15}
              strokeWidth={1.4}
              className="shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
              {group.label}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatGroupCount(group.sessions.length, group.hasMore)}
            </span>
          </div>
          {group.sessions.length > 0 && (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {group.sessions.map(renderSession)}
            </div>
          )}
          {group.loadMoreError && (
            <div
              role="alert"
              className="mt-1.5 flex items-center gap-2 px-1 text-xs text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate">
                {group.loadMoreError}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={group.loadingMore}
                onClick={() => onLoadMoreWorkspace(group.cwd)}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {group.hasMore && (
            <div className="mt-2 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={group.loadingMore}
                onClick={() => onLoadMoreWorkspace(group.cwd)}
              >
                {group.loadingMore && (
                  <LoaderCircleIcon
                    className="animate-spin"
                    size={14}
                    aria-hidden="true"
                  />
                )}
                {t('sidebar.archivedLoadMore')}
              </Button>
            </div>
          )}
        </section>
      ))}

      {emptyState === 'retry' && (
        <div className="px-1 py-4">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t('sidebar.loadFailed')}
          </Button>
        </div>
      )}
      {emptyState === 'filtered' && (
        <div className="flex flex-col items-center gap-2 px-1 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('sidebar.archivedFilteredEmpty')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClearFilters}
          >
            {t('sidebar.clearFilters')}
          </Button>
        </div>
      )}
      {emptyState === 'workspace' && (
        <div className="flex flex-col items-center gap-2 px-1 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('sidebar.archivedWorkspaceEmpty')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onShowAllWorkspaces}
          >
            {t('sidebar.showAllWorkspaces')}
          </Button>
        </div>
      )}
      {emptyState === 'empty' && (
        <div className="px-1 py-6 text-center text-sm text-muted-foreground">
          {t('sidebar.archivedEmpty')}
        </div>
      )}

      {showFooterRetry && (
        <div className="mt-2 px-1">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t('sidebar.loadFailed')}
          </Button>
        </div>
      )}
    </div>
  );
}
