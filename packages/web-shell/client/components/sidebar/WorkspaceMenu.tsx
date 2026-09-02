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
  BlocksIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  FolderOpenIcon,
  GitForkIcon,
  PencilIcon,
  PlugIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SettingsIcon,
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
  type WorkspaceManagementTarget,
  type WorkspaceOverviewSnapshot,
} from './workspaceOverviewModel';

/**
 * Every action is optional: the sidebar passes only what the workspace's
 * trust, lock and registration state allows, and the menu lays out whatever
 * it gets. An empty action set renders nothing.
 */
export interface WorkspaceMenuActions {
  rename?: () => void;
  copyPath?: () => void;
  openFolder?: () => void;
  openTerminal?: () => void;
  newSession?: () => void;
  newWorktreeSession?: () => void;
  openManagement?: (target: WorkspaceManagementTarget) => void;
  reload?: () => void;
  remove?: () => void;
}

type ContentProps = ComponentProps<typeof DropdownMenuContent>;

export interface WorkspaceMenuProps {
  workspace: DaemonWorkspaceCapability;
  actions: WorkspaceMenuActions;
  /** Live counts shown next to the management entries. */
  overview?: WorkspaceOverviewSnapshot;
  disabled?: boolean;
  triggerClassName?: string;
  contentStyle?: CSSProperties;
  onOpenChange?: (open: boolean) => void;
  onPointerDownOutside?: ContentProps['onPointerDownOutside'];
  onCloseAutoFocus?: ContentProps['onCloseAutoFocus'];
}

const MANAGEMENT_ENTRIES: ReadonlyArray<{
  target: WorkspaceManagementTarget;
  Icon: typeof PlugIcon;
}> = [
  { target: 'mcp', Icon: PlugIcon },
  { target: 'skills', Icon: SparklesIcon },
  { target: 'extensions', Icon: BlocksIcon },
  { target: 'channels', Icon: RadioTowerIcon },
  { target: 'settings', Icon: SettingsIcon },
];

export function hasWorkspaceMenuActions(
  actions: WorkspaceMenuActions,
): boolean {
  return Object.values(actions).some(Boolean);
}

export function WorkspaceMenu({
  workspace,
  actions,
  overview,
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

  const sections: ReactNode[][] = [];
  const primary: ReactNode[] = [];
  if (actions.rename) {
    primary.push(
      <DropdownMenuItem key="rename" onSelect={actions.rename}>
        <PencilIcon />
        {t('sidebar.renameWorkspace')}
      </DropdownMenuItem>,
    );
  }
  if (actions.copyPath) {
    primary.push(
      <DropdownMenuItem key="copy" onSelect={actions.copyPath}>
        <CopyIcon />
        {t('sidebar.copyWorkspacePath')}
      </DropdownMenuItem>,
    );
  }
  if (actions.openFolder) {
    primary.push(
      <DropdownMenuItem key="open-folder" onSelect={actions.openFolder}>
        <FolderOpenIcon />
        {t('sidebar.openWorkspaceFolder')}
      </DropdownMenuItem>,
    );
  }
  if (actions.openTerminal) {
    primary.push(
      <DropdownMenuItem key="open-terminal" onSelect={actions.openTerminal}>
        <TerminalIcon />
        {t('sidebar.openWorkspaceTerminal')}
      </DropdownMenuItem>,
    );
  }
  if (actions.newSession) {
    primary.push(
      <DropdownMenuItem key="new" onSelect={actions.newSession}>
        <SquarePenIcon />
        {t('sidebar.newTask')}
      </DropdownMenuItem>,
    );
  }
  if (actions.newWorktreeSession) {
    primary.push(
      <DropdownMenuItem key="worktree" onSelect={actions.newWorktreeSession}>
        <GitForkIcon />
        {t('sidebar.newWorktreeTask')}
      </DropdownMenuItem>,
    );
  }
  if (primary.length > 0) sections.push(primary);

  const openManagement = actions.openManagement;
  if (openManagement) {
    // The section wrapper below supplies the group role; a nested group here
    // would only add an unlabeled boundary for assistive tech.
    sections.push([
      <DropdownMenuLabel key="manage-label">
        {t('sidebar.manageWorkspace')}
      </DropdownMenuLabel>,
      ...MANAGEMENT_ENTRIES.map(({ target, Icon }) => {
        const count =
          target === 'settings'
            ? undefined
            : formatOverviewValue(overview, target);
        return (
          <DropdownMenuItem
            key={target}
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
      <DropdownMenuItem key="reload" onSelect={actions.reload}>
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
        className="w-auto min-w-40"
        style={contentStyle}
        onPointerDownOutside={onPointerDownOutside}
        onCloseAutoFocus={onCloseAutoFocus}
      >
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
