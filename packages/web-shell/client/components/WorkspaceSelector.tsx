import { Fragment, useRef, useState } from 'react';
import {
  CircleDashedIcon,
  FolderClosedIcon,
  FolderPlusIcon,
  LockIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { HostLabel } from './workspaces/HostLabel';

export interface WorkspaceSelectorOption {
  id: string;
  cwd: string;
  label: string;
  primary: boolean;
  trusted: boolean;
  /** Daemon host this workspace lives on; defaults to the page origin. */
  hostOrigin?: string;
}

interface WorkspaceSelectorProps {
  workspaces: WorkspaceSelectorOption[];
  selectedWorkspaceCwd?: string;
  disabled?: boolean;
  busy?: boolean;
  scratchSupported: boolean;
  existingFolderSupported: boolean;
  /** Offer a projectless (standalone) target alongside the workspaces. */
  standaloneSupported?: boolean;
  selectedStandalone?: boolean;
  className?: string;
  onSelectWorkspace: (cwd: string | undefined) => void;
  /**
   * Host-aware selection for multi-daemon pages. When provided it fires
   * INSTEAD of `onSelectWorkspace`, with the option's host (page origin when
   * unset); `undefined` cwd keeps marking the host's primary workspace.
   */
  onSelectHostedWorkspace?: (
    hostOrigin: string,
    cwd: string | undefined,
  ) => void;
  onSelectStandalone?: () => void;
  onCreateScratch: () => void;
  onOpenExistingFolder: () => void;
}

/** Radio-group value that stands for the projectless target. */
const STANDALONE_OPTION_ID = '__standalone__';

/**
 * Composer workspace menu. Capability-gated creation actions and disabled
 * untrusted entries keep presentation aligned with daemon authorization.
 */
export function WorkspaceSelector({
  workspaces,
  selectedWorkspaceCwd,
  disabled,
  busy,
  scratchSupported,
  existingFolderSupported,
  standaloneSupported,
  selectedStandalone,
  className,
  onSelectWorkspace,
  onSelectHostedWorkspace,
  onSelectStandalone,
  onCreateScratch,
  onOpenExistingFolder,
}: WorkspaceSelectorProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const suppressTooltipRef = useRef(false);
  const pointerDismissedRef = useRef(false);
  const selected = workspaces.find((workspace) =>
    selectedWorkspaceCwd
      ? workspace.cwd === selectedWorkspaceCwd
      : workspace.primary,
  );
  const canCreate = scratchSupported || existingFolderSupported;
  const standaloneSelectable = Boolean(
    standaloneSupported && onSelectStandalone,
  );
  if (workspaces.length <= 1 && !canCreate && !standaloneSelectable) {
    return null;
  }
  // Group by host in first-appearance order; a single-host list keeps the
  // historic flat rendering (no group headers).
  const pageOrigin =
    typeof window === 'undefined' ? '' : window.location.origin;
  const groups: { hostOrigin: string; items: WorkspaceSelectorOption[] }[] = [];
  for (const workspace of workspaces) {
    const hostOrigin = workspace.hostOrigin ?? pageOrigin;
    const group = groups.find((entry) => entry.hostOrigin === hostOrigin);
    if (group) {
      group.items.push(workspace);
    } else {
      groups.push({ hostOrigin, items: [workspace] });
    }
  }
  const groupedByHost = groups.length > 1;
  const triggerLabel = selectedStandalone
    ? t('sidebar.noWorkspace')
    : (selected?.label ?? '');

  return (
    <TooltipProvider delayDuration={300}>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) pointerDismissedRef.current = false;
          menuOpenRef.current = open;
          setMenuOpen(open);
          suppressTooltipRef.current = true;
          setTooltipOpen(false);
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
                  setTooltipOpen(false);
                }}
                onBlur={() => {
                  if (!menuOpenRef.current) {
                    suppressTooltipRef.current = false;
                    setTooltipOpen(false);
                  }
                }}
              >
                {selectedStandalone ? (
                  <CircleDashedIcon size={16} strokeWidth={1.2} />
                ) : (
                  <FolderClosedIcon size={16} strokeWidth={1.2} />
                )}
                <span data-slot="select-value">{triggerLabel}</span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{triggerLabel}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="top"
          align="start"
          className="min-w-56"
          onPointerDownCapture={() => {
            pointerDismissedRef.current = true;
          }}
          onKeyDownCapture={() => {
            pointerDismissedRef.current = false;
          }}
          onPointerDownOutside={() => {
            pointerDismissedRef.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (pointerDismissedRef.current) event.preventDefault();
            pointerDismissedRef.current = false;
          }}
        >
          <DropdownMenuRadioGroup
            value={selectedStandalone ? STANDALONE_OPTION_ID : selected?.id}
            onValueChange={(id) => {
              if (id === STANDALONE_OPTION_ID) {
                onSelectStandalone?.();
                return;
              }
              const next = workspaces.find((workspace) => workspace.id === id);
              if (!next?.trusted) return;
              const cwd = next.primary ? undefined : next.cwd;
              if (onSelectHostedWorkspace) {
                onSelectHostedWorkspace(next.hostOrigin ?? pageOrigin, cwd);
              } else {
                onSelectWorkspace(cwd);
              }
            }}
          >
            {groups.map((group) => (
              <Fragment key={group.hostOrigin}>
                {groupedByHost && (
                  <DropdownMenuLabel
                    className="flex items-center gap-1.5 text-[11px]"
                    title={group.hostOrigin}
                  >
                    <HostLabel origin={group.hostOrigin} />
                  </DropdownMenuLabel>
                )}
                {group.items.map((workspace) => {
                  const remoteHost =
                    workspace.hostOrigin && workspace.hostOrigin !== pageOrigin
                      ? workspace.hostOrigin
                      : undefined;
                  return (
                    <DropdownMenuRadioItem
                      key={workspace.id}
                      value={workspace.id}
                      disabled={!workspace.trusted}
                      title={
                        remoteHost
                          ? `${remoteHost} — ${workspace.cwd}`
                          : workspace.cwd
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {workspace.label}
                      </span>
                      {remoteHost && (
                        <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                          {new URL(remoteHost).host}
                        </span>
                      )}
                      {!workspace.trusted && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <LockIcon />
                          {t('sidebar.workspaceUntrusted')}
                        </span>
                      )}
                    </DropdownMenuRadioItem>
                  );
                })}
              </Fragment>
            ))}
            {standaloneSelectable && (
              <DropdownMenuRadioItem value={STANDALONE_OPTION_ID}>
                <span className="min-w-0 flex-1 truncate">
                  {t('sidebar.noWorkspace')}
                </span>
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
                <DropdownMenuSubContent
                  onPointerDownCapture={() => {
                    pointerDismissedRef.current = true;
                  }}
                  onKeyDownCapture={() => {
                    pointerDismissedRef.current = false;
                  }}
                >
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
