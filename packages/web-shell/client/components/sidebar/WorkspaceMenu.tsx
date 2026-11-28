/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useEffect,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BlocksIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  PencilIcon,
  PlusIcon,
  PlugIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquarePenIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  formatOverviewValue,
  type WorkspaceMenuManagementTarget,
  type WorkspaceOverviewSnapshot,
} from './workspaceOverviewModel';

/**
 * Every action is optional: the sidebar passes only what the workspace's
 * trust, lock and registration state allows, and the menu lays out whatever
 * it gets. An empty action set renders nothing.
 */
export interface WorkspaceMenuActions {
  trust?: () => void;
  trustPending?: boolean;
  rename?: () => void;
  copyPath?: () => void;
  openFolder?: () => void;
  openTerminal?: () => void;
  newSession?: () => void;
  newWorktreeSession?: () => void;
  createGroup?: () => void;
  moveUp?: () => void;
  moveDown?: () => void;
  openManagement?: (target: WorkspaceMenuManagementTarget) => void;
  /**
   * Subset of menu management targets offered for this workspace. When
   * omitted, all five targets are offered whenever `openManagement` is set.
   */
  managementTargets?: readonly WorkspaceMenuManagementTarget[];
  reload?: () => void;
  remove?: () => void;
}

type ContentProps = ComponentProps<typeof DropdownMenuContent>;

export interface WorkspaceMenuSummary {
  path: string;
  branch?: string | null;
  gitSummary?: string;
}

export interface WorkspaceMenuProps {
  workspace: DaemonWorkspaceCapability;
  actions: WorkspaceMenuActions;
  /** Live counts shown next to the management entries. */
  overview?: WorkspaceOverviewSnapshot;
  /** Optional read-only path/branch summary shown at the top on touch devices. */
  summary?: WorkspaceMenuSummary;
  /** Enlarges menu item rows for coarse touch pointers. */
  touchFriendly?: boolean;
  disabled?: boolean;
  triggerClassName?: string;
  contentStyle?: CSSProperties;
  onOpenChange?: (open: boolean) => void;
  onPointerDownOutside?: ContentProps['onPointerDownOutside'];
  onCloseAutoFocus?: ContentProps['onCloseAutoFocus'];
}

const MANAGEMENT_ENTRIES: ReadonlyArray<{
  target: WorkspaceMenuManagementTarget;
  Icon: typeof PlugIcon;
}> = [
  { target: 'mcp', Icon: PlugIcon },
  { target: 'skills', Icon: SparklesIcon },
  { target: 'extensions', Icon: BlocksIcon },
  { target: 'channels', Icon: RadioTowerIcon },
  { target: 'settings', Icon: SettingsIcon },
];

function visibleManagementEntries(actions: WorkspaceMenuActions) {
  if (!actions.openManagement) return [];
  if (!actions.managementTargets) return MANAGEMENT_ENTRIES;
  const allowed = new Set(actions.managementTargets);
  return MANAGEMENT_ENTRIES.filter((entry) => allowed.has(entry.target));
}

export function hasWorkspaceMenuActions(
  actions: WorkspaceMenuActions,
): boolean {
  return Boolean(
    actions.trust ||
      actions.rename ||
      actions.copyPath ||
      actions.openFolder ||
      actions.openTerminal ||
      actions.newSession ||
      actions.newWorktreeSession ||
      actions.createGroup ||
      actions.moveUp ||
      actions.moveDown ||
      visibleManagementEntries(actions).length > 0 ||
      actions.reload ||
      actions.remove,
  );
}

export function WorkspaceMenu({
  workspace,
  actions,
  overview,
  summary,
  touchFriendly = false,
  disabled = false,
  triggerClassName,
  contentStyle,
  onOpenChange,
  onPointerDownOutside,
  onCloseAutoFocus,
}: WorkspaceMenuProps) {
  const { t } = useI18n();
  const openRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(
    () => () => {
      // Radix emits no onOpenChange(false) when an open menu unmounts (its
      // row removed by a capabilities refresh); without the close signal the
      // collapsed surface's dismissal guards stay blocked forever.
      if (openRef.current) onOpenChangeRef.current?.(false);
    },
    [],
  );
  if (!hasWorkspaceMenuActions(actions)) return null;

  const itemClass = touchFriendly ? 'min-h-11 gap-2 px-3 py-2' : undefined;
  const sections: ReactNode[][] = [];
  if (actions.trust) {
    sections.push([
      <DropdownMenuItem
        key="trust"
        className={itemClass}
        disabled={actions.trustPending}
        onSelect={actions.trust}
      >
        <ShieldCheckIcon />
        {actions.trustPending
          ? t('sidebar.trustingWorkspace')
          : t('sidebar.trustWorkspace')}
      </DropdownMenuItem>,
    ]);
  }
  const primary: ReactNode[] = [];
  if (actions.rename) {
    primary.push(
      <DropdownMenuItem
        key="rename"
        className={itemClass}
        onSelect={actions.rename}
      >
        <PencilIcon />
        {t('sidebar.renameWorkspace')}
      </DropdownMenuItem>,
    );
  }
  if (actions.copyPath) {
    primary.push(
      <DropdownMenuItem
        key="copy"
        className={itemClass}
        onSelect={actions.copyPath}
      >
        <CopyIcon />
        {t('sidebar.copyWorkspacePath')}
      </DropdownMenuItem>,
    );
  }
  if (actions.openFolder) {
    primary.push(
      <DropdownMenuItem
        key="open-folder"
        className={itemClass}
        onSelect={actions.openFolder}
      >
        <FolderOpenIcon />
        {t('sidebar.openWorkspaceFolder')}
      </DropdownMenuItem>,
    );
  }
  if (actions.openTerminal) {
    primary.push(
      <DropdownMenuItem
        key="open-terminal"
        className={itemClass}
        onSelect={actions.openTerminal}
      >
        <TerminalIcon />
        {t('sidebar.openWorkspaceTerminal')}
      </DropdownMenuItem>,
    );
  }
  if (actions.newSession) {
    primary.push(
      <DropdownMenuItem
        key="new"
        className={itemClass}
        onSelect={actions.newSession}
      >
        <SquarePenIcon />
        {t('sidebar.newTask')}
      </DropdownMenuItem>,
    );
  }
  if (actions.newWorktreeSession) {
    primary.push(
      <DropdownMenuItem
        key="worktree"
        className={itemClass}
        onSelect={actions.newWorktreeSession}
      >
        <GitForkIcon />
        {t('sidebar.newWorktreeTask')}
      </DropdownMenuItem>,
    );
  }
  if (actions.createGroup) {
    primary.push(
      <DropdownMenuItem
        key="create-group"
        className={itemClass}
        onSelect={actions.createGroup}
      >
        <PlusIcon />
        {t('sidebar.groupCreate')}
      </DropdownMenuItem>,
    );
  }
  if (actions.moveUp) {
    primary.push(
      <DropdownMenuItem
        key="move-up"
        className={itemClass}
        onSelect={actions.moveUp}
      >
        <ArrowUpIcon />
        {t('sidebar.moveWorkspaceUp')}
      </DropdownMenuItem>,
    );
  }
  if (actions.moveDown) {
    primary.push(
      <DropdownMenuItem
        key="move-down"
        className={itemClass}
        onSelect={actions.moveDown}
      >
        <ArrowDownIcon />
        {t('sidebar.moveWorkspaceDown')}
      </DropdownMenuItem>,
    );
  }
  if (primary.length > 0) sections.push(primary);

  const openManagement = actions.openManagement;
  const managementEntries = visibleManagementEntries(actions);
  if (openManagement && managementEntries.length > 0) {
    // The section wrapper below supplies the group role; a nested group here
    // would only add an unlabeled boundary for assistive tech.
    sections.push([
      <DropdownMenuLabel key="manage-label">
        {t('sidebar.manageWorkspace')}
      </DropdownMenuLabel>,
      ...managementEntries.map(({ target, Icon }) => {
        const count =
          target === 'settings'
            ? undefined
            : formatOverviewValue(overview, target);
        return (
          <DropdownMenuItem
            key={target}
            className={itemClass}
            onSelect={() => openManagement(target)}
          >
            <Icon />
            {t(
              `sidebar.overview.${target === 'settings' ? 'settings' : target}`,
            )}
            {count !== undefined && (
              <span className="text-muted-foreground ml-auto pl-3 text-xs tabular-nums">
                {count}
              </span>
            )}
          </DropdownMenuItem>
        );
      }),
    ]);
  }

  if (actions.reload) {
    sections.push([
      <DropdownMenuItem
        key="reload"
        className={itemClass}
        onSelect={actions.reload}
      >
        <RefreshCwIcon />
        {t('sidebar.reloadWorkspace')}
      </DropdownMenuItem>,
    ]);
  }

  if (actions.remove) {
    sections.push([
      <DropdownMenuItem
        key="remove"
        variant="destructive"
        className={itemClass}
        aria-label={`${t('sidebar.removeWorkspace')}: ${workspace.cwd}`}
        onSelect={actions.remove}
      >
        <Trash2Icon />
        {t('sidebar.removeWorkspace')}
      </DropdownMenuItem>,
    ]);
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        openRef.current = open;
        onOpenChange?.(open);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          className={triggerClassName}
          type="button"
          aria-label={t('sidebar.workspaceActions')}
          title={t('sidebar.workspaceActions')}
          disabled={disabled}
        >
          <EllipsisVerticalIcon size={16} strokeWidth={1.2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={
          summary ? 'w-64 max-w-[calc(100vw-1rem)]' : 'w-auto min-w-40'
        }
        style={contentStyle}
        onPointerDownOutside={onPointerDownOutside}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {summary && (
          <>
            <div
              className="flex flex-col gap-1 px-2.5 py-2 text-xs text-muted-foreground"
              data-web-shell-workspace-menu-summary
            >
              <div className="flex items-start gap-1.5">
                <FolderClosedIcon
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span className="min-w-0 break-all" title={summary.path}>
                  {summary.path}
                </span>
              </div>
              {summary.branch && (
                <div className="flex items-center gap-1.5">
                  <GitBranchIcon
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate" title={summary.branch}>
                    {summary.branch}
                    {summary.gitSummary ? ` · ${summary.gitSummary}` : ''}
                  </span>
                </div>
              )}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {sections.map((section, index) => (
          <DropdownMenuGroup key={index}>
            {index > 0 && <DropdownMenuSeparator />}
            {section}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
