import { useRef, useState } from 'react';
import {
  FolderClosedIcon,
  FolderPlusIcon,
  LockIcon,
  MessageCircleIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
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
} from './ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

const NO_WORKSPACE_VALUE = 'qwen-code:no-workspace';

export interface WorkspaceSelectorOption {
  id: string;
  cwd: string;
  label: string;
  primary: boolean;
  trusted: boolean;
}

interface WorkspaceSelectorProps {
  workspaces: WorkspaceSelectorOption[];
  selectedWorkspaceCwd?: string;
  noWorkspaceSupported?: boolean;
  noWorkspaceSelected?: boolean;
  disabled?: boolean;
  busy?: boolean;
  scratchSupported: boolean;
  existingFolderSupported: boolean;
  className?: string;
  onSelectWorkspace: (cwd: string | undefined) => void;
  onSelectNoWorkspace?: () => void;
  onCreateScratch: () => void;
  onOpenExistingFolder: () => void;
}

/**
 * Composer workspace menu. Capability-gated creation actions and disabled
 * untrusted entries keep presentation aligned with daemon authorization.
 */
export function WorkspaceSelector({
  workspaces,
  selectedWorkspaceCwd,
  noWorkspaceSupported = false,
  noWorkspaceSelected = false,
  disabled,
  busy,
  scratchSupported,
  existingFolderSupported,
  className,
  onSelectWorkspace,
  onSelectNoWorkspace,
  onCreateScratch,
  onOpenExistingFolder,
}: WorkspaceSelectorProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const suppressTooltipRef = useRef(false);
  const selected = workspaces.find((workspace) =>
    !noWorkspaceSelected && selectedWorkspaceCwd
      ? workspace.cwd === selectedWorkspaceCwd
      : !noWorkspaceSelected && workspace.primary,
  );
  const selectedLabel = noWorkspaceSelected
    ? t('sidebar.noWorkspace')
    : (selected?.label ?? '');
  const canCreate = scratchSupported || existingFolderSupported;
  if (workspaces.length <= 1 && !noWorkspaceSupported && !canCreate) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          menuOpenRef.current = open;
          setMenuOpen(open);
          if (open) {
            suppressTooltipRef.current = true;
            setTooltipOpen(false);
          }
        }}
      >
        <Tooltip
          open={tooltipOpen}
          onOpenChange={(open) => {
            if (open && (menuOpen || suppressTooltipRef.current)) {
              return;
            }
            setTooltipOpen(open);
          }}
        >
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild disabled={disabled || busy}>
              <button
                type="button"
                className={className}
                aria-label={t('sidebar.workspaceSelectLabel')}
                onPointerEnter={() => {
                  if (!menuOpenRef.current) {
                    suppressTooltipRef.current = false;
                  }
                }}
                onPointerLeave={() => {
                  suppressTooltipRef.current = false;
                  setTooltipOpen(false);
                }}
                onBlur={() => {
                  if (!menuOpenRef.current) {
                    suppressTooltipRef.current = false;
                    setTooltipOpen(false);
                  }
                }}
              >
                {noWorkspaceSelected ? (
                  <MessageCircleIcon size={16} strokeWidth={1.2} />
                ) : (
                  <FolderClosedIcon size={16} strokeWidth={1.2} />
                )}
                <span data-slot="select-value">{selectedLabel}</span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{selectedLabel}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuRadioGroup
            value={noWorkspaceSelected ? NO_WORKSPACE_VALUE : selected?.id}
            onValueChange={(id) => {
              if (id === NO_WORKSPACE_VALUE) {
                onSelectNoWorkspace?.();
                return;
              }
              const next = workspaces.find((workspace) => workspace.id === id);
              if (!next?.trusted) return;
              onSelectWorkspace(next.primary ? undefined : next.cwd);
            }}
          >
            {workspaces.map((workspace) => (
              <DropdownMenuRadioItem
                key={workspace.id}
                value={workspace.id}
                disabled={!workspace.trusted}
                title={workspace.cwd}
              >
                <span className="min-w-0 flex-1 truncate">
                  {workspace.label}
                </span>
                {!workspace.trusted && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <LockIcon />
                    {t('sidebar.workspaceUntrusted')}
                  </span>
                )}
              </DropdownMenuRadioItem>
            ))}
            {noWorkspaceSupported && onSelectNoWorkspace && (
              <DropdownMenuRadioItem value={NO_WORKSPACE_VALUE}>
                <MessageCircleIcon />
                {t('sidebar.noWorkspace')}
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
          {canCreate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={busy}>
                  <FolderPlusIcon />
                  {t('sidebar.newWorkspace')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {scratchSupported && (
                    <DropdownMenuItem onSelect={onCreateScratch}>
                      {t('sidebar.startFromScratch')}
                    </DropdownMenuItem>
                  )}
                  {existingFolderSupported && (
                    <DropdownMenuItem onSelect={onOpenExistingFolder}>
                      {t('sidebar.useExistingFolder')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}
