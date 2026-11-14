import { ArrowDownWideNarrowIcon } from 'lucide-react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { workspaceLabel } from '../../utils/workspace';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export type SessionSort = 'updatedAt' | 'lastUserPromptAt';
export type WorkspaceFilter = 'all' | 'standalone' | `workspace:${string}`;

export function readSessionSort(host: string): SessionSort {
  try {
    return localStorage.getItem(`web-shell:session-sort:${host}`) ===
      'lastUserPromptAt'
      ? 'lastUserPromptAt'
      : 'updatedAt';
  } catch {
    return 'updatedAt';
  }
}

export function writeSessionSort(host: string, sort: SessionSort): void {
  try {
    localStorage.setItem(`web-shell:session-sort:${host}`, sort);
  } catch {
    // Storage may be disabled by an embedding host.
  }
}

export function readWorkspaceFilter(host: string): WorkspaceFilter {
  try {
    const value = localStorage.getItem(`web-shell:workspace-filter:${host}`);
    return value === 'standalone' ||
      (value?.startsWith('workspace:') && value.length > 'workspace:'.length)
      ? (value as WorkspaceFilter)
      : 'all';
  } catch {
    return 'all';
  }
}

export function writeWorkspaceFilter(
  host: string,
  filter: WorkspaceFilter,
): void {
  try {
    localStorage.setItem(`web-shell:workspace-filter:${host}`, filter);
  } catch {
    // Storage may be disabled by an embedding host.
  }
}

export function SessionSortMenu({
  value,
  onChange,
  workspaceValue,
  onWorkspaceChange,
  workspaces,
  sortEnabled = true,
  triggerClassName = 'rounded-lg p-2 hover:bg-accent',
}: {
  value: SessionSort;
  onChange: (value: SessionSort) => void;
  workspaceValue: WorkspaceFilter;
  onWorkspaceChange: (value: WorkspaceFilter) => void;
  workspaces: readonly DaemonWorkspaceCapability[];
  sortEnabled?: boolean;
  triggerClassName?: string;
}) {
  const { t } = useI18n();
  const sortLabel = t(
    value === 'lastUserPromptAt'
      ? 'sidebar.sortQuestion'
      : 'sidebar.sortActivity',
  );
  const selectedWorkspaceCwd = workspaceValue.startsWith('workspace:')
    ? workspaceValue.slice('workspace:'.length)
    : undefined;
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.cwd === selectedWorkspaceCwd,
  );
  const currentWorkspaceLabel =
    workspaceValue === 'all'
      ? t('sidebar.filterAll')
      : workspaceValue === 'standalone'
        ? t('sidebar.noWorkspace')
        : selectedWorkspace
          ? workspaceLabel(selectedWorkspace)
          : (selectedWorkspaceCwd ?? t('sidebar.filterAll'));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={t('sidebar.sessionDisplay')}
          title={t('sidebar.sessionDisplay')}
        >
          <ArrowDownWideNarrowIcon size={18} strokeWidth={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {sortEnabled && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span>{t('sidebar.sortBy')}</span>
                <span className="ml-auto min-w-0 truncate text-muted-foreground">
                  {sortLabel}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuRadioGroup
                value={value}
                onValueChange={(next) => {
                  if (next === 'updatedAt' || next === 'lastUserPromptAt')
                    onChange(next);
                }}
              >
                <DropdownMenuRadioItem value="updatedAt">
                  {t('sidebar.sortActivity')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="lastUserPromptAt">
                  {t('sidebar.sortQuestion')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span>{t('sidebar.workspaceFilter')}</span>
              <span
                className="ml-auto min-w-0 truncate text-muted-foreground"
                title={currentWorkspaceLabel}
              >
                {currentWorkspaceLabel}
              </span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
            <DropdownMenuRadioGroup
              value={workspaceValue}
              onValueChange={(next) => {
                if (
                  next === 'all' ||
                  next === 'standalone' ||
                  next.startsWith('workspace:')
                )
                  onWorkspaceChange(next as WorkspaceFilter);
              }}
            >
              <DropdownMenuRadioItem value="all">
                {t('sidebar.filterAll')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="standalone">
                {t('sidebar.noWorkspace')}
              </DropdownMenuRadioItem>
              {workspaces.length > 0 && <DropdownMenuSeparator />}
              {workspaces.map((workspace) => {
                const label = workspaceLabel(workspace);
                return (
                  <DropdownMenuRadioItem
                    key={workspace.id}
                    value={`workspace:${workspace.cwd}`}
                  >
                    <span className="min-w-0 truncate" title={label}>
                      {label}
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onWorkspaceChange('all');
            onChange('updatedAt');
          }}
        >
          {t('sidebar.restoreDefaults')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
