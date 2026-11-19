import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFilterInput } from '../hooks/useFilterInput';
import {
  CircleDashedIcon,
  FolderClosedIcon,
  FolderPlusIcon,
  Globe2Icon,
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
import { getShadowAwareActiveElement } from '../utils/dom';
import { matchesWorkspaceQuery } from '../utils/workspaceFilter';

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
  alwaysVisible?: boolean;
  menuItems?: ReactNode;
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
  alwaysVisible = false,
  menuItems,
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
  // Committed filter: intermediate IME preedit never refilters the list.
  const {
    filterValue,
    inputProps: filterInputProps,
    reset: resetFilter,
  } = useFilterInput();
  const radioGroupId = useId();
  const menuOpenRef = useRef(false);
  const suppressTooltipRef = useRef(false);
  const pointerDismissedRef = useRef(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const selected = workspaces.find((workspace) =>
    selectedWorkspaceCwd
      ? workspace.cwd === selectedWorkspaceCwd
      : workspace.primary,
  );
  const canCreate = scratchSupported || existingFolderSupported;
  const standaloneSelectable = Boolean(
    standaloneSupported && onSelectStandalone,
  );
  useEffect(() => {
    if (!menuOpen) return;
    // Radix dismisses on document capture and prevents the native IME
    // cancellation. Hide a composing Escape from that listener only, then
    // restore it before the event reaches the focused input (the same shape as
    // DialogShell's preserveImeEscape).
    const preserveImeEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        (!event.isComposing && event.keyCode !== 229)
      ) {
        return;
      }
      Object.defineProperty(event, 'key', {
        configurable: true,
        value: 'Process',
      });
      document.addEventListener(
        'keydown',
        (currentEvent) => {
          if (currentEvent === event) Reflect.deleteProperty(event, 'key');
        },
        { capture: true, once: true },
      );
    };
    window.addEventListener('keydown', preserveImeEscape, { capture: true });
    return () =>
      window.removeEventListener('keydown', preserveImeEscape, {
        capture: true,
      });
  }, [menuOpen]);
  if (
    !alwaysVisible &&
    !menuItems &&
    workspaces.length <= 1 &&
    !canCreate &&
    !standaloneSelectable
  ) {
    return null;
  }
  // Group by host in first-appearance order; a single-host list keeps the
  // historic flat rendering (no group headers).
  const pageOrigin =
    typeof window === 'undefined' ? '' : window.location.origin;
  const groups: { hostOrigin: string; items: WorkspaceSelectorOption[] }[] = [];
  for (const workspace of workspaces) {
    // Match every string the row shows: the label, the path in its title,
    // and the host chip for remote rows.
    let hostText: string | undefined;
    if (workspace.hostOrigin) {
      try {
        hostText = new URL(workspace.hostOrigin).host;
      } catch {
        hostText = undefined;
      }
    }
    if (
      !matchesWorkspaceQuery(
        [workspace.label, workspace.cwd, hostText],
        filterValue,
      )
    ) {
      continue;
    }
    const hostOrigin = workspace.hostOrigin ?? pageOrigin;
    const group = groups.find((entry) => entry.hostOrigin === hostOrigin);
    if (group) {
      group.items.push(workspace);
    } else {
      groups.push({ hostOrigin, items: [workspace] });
    }
  }
  const groupedByHost = groups.length > 1;
  const noWorkspaceMatches = filterValue.trim() !== '' && groups.length === 0;
  const triggerLabel = selectedStandalone
    ? t('sidebar.noWorkspace')
    : (selected?.label ?? t('sidebar.workspaceSelectLabel'));

  return (
    <TooltipProvider delayDuration={300}>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) {
            pointerDismissedRef.current = false;
            // Reset on open, not close: Radix keeps the content mounted for
            // the exit animation, and clearing here would re-render the full
            // list into the still-visible popup (height jump) on every close.
            // The content unmounts after the animation, so the next open
            // starts empty anyway.
            resetFilter();
          }
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
          // Radix focuses the hovered row on pointermove; while the filter
          // owns focus that would pull typing out of the field. Keep the
          // pointer event local so the row is not focused instead.
          // document.activeElement retargets to the shadow host in the
          // portalled (shadow root) mode, so resolve from the input's own
          // root.
          onPointerMoveCapture={(event) => {
            if (
              getShadowAwareActiveElement(filterInputRef.current) ===
              filterInputRef.current
            ) {
              event.stopPropagation();
            }
          }}
          onKeyDownCapture={(event) => {
            pointerDismissedRef.current = false;
            // There is no item above the first one, so ArrowUp on the first
            // enabled item goes back to the filter field. Modified combos
            // (Cmd/Ctrl/Alt/Shift+arrow) are text gestures and stay with the
            // focused element, as does an IME composition.
            if (
              event.key === 'ArrowUp' &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              const content = event.currentTarget;
              const items = Array.from(
                content.querySelectorAll<HTMLElement>(
                  '[role="menuitem"], [role="menuitemradio"]',
                ),
              ).filter((item) => !item.hasAttribute('data-disabled'));
              const target =
                event.target instanceof Element
                  ? event.target.closest(
                      '[role="menuitem"], [role="menuitemradio"]',
                    )
                  : null;
              if (items.length > 0 && target === items[0]) {
                event.preventDefault();
                event.stopPropagation();
                filterInputRef.current?.focus();
              }
            }
          }}
          onPointerDownOutside={() => {
            pointerDismissedRef.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (pointerDismissedRef.current) event.preventDefault();
            pointerDismissedRef.current = false;
          }}
        >
          <div data-web-shell-ws-filter className="p-1.5">
            <input
              type="text"
              ref={filterInputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={radioGroupId}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                // Plain, non-composing arrows hand focus into the list.
                // Modified combos and IME composition are text gestures and
                // must reach the input untouched.
                const plainArrow =
                  (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.shiftKey;
                if (plainArrow) {
                  const content = event.currentTarget.closest(
                    '[data-radix-menu-content]',
                  );
                  const items = content
                    ? Array.from(
                        content.querySelectorAll<HTMLElement>(
                          '[role="menuitem"], [role="menuitemradio"]',
                        ),
                      ).filter((item) => !item.hasAttribute('data-disabled'))
                    : [];
                  if (items.length > 0) {
                    event.preventDefault();
                    const target =
                      event.key === 'ArrowDown'
                        ? items[0]
                        : items[items.length - 1];
                    target.focus();
                  }
                  return;
                }
                if (event.key !== 'Escape') event.stopPropagation();
              }}
              placeholder={t('sidebar.filterWorkspaces')}
              aria-label={t('sidebar.filterWorkspaces')}
              autoFocus
              {...filterInputProps}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none"
            />
          </div>
          {noWorkspaceMatches && (
            <div
              role="status"
              aria-live="polite"
              className="px-2 py-1.5 text-xs text-muted-foreground"
            >
              {t('sidebar.noWorkspacesMatch')}
            </div>
          )}
          <DropdownMenuRadioGroup
            id={radioGroupId}
            value={selectedStandalone ? STANDALONE_OPTION_ID : selected?.id}
            onValueChange={(id) => {
              if (standaloneSelectable && id === STANDALONE_OPTION_ID) {
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
                      // Row highlight is focus-based (no hover variant in the
                      // base item); while the filter input owns focus, hover
                      // is the only cue left for the row under the pointer.
                      className="hover:bg-accent/60"
                      title={
                        remoteHost
                          ? `${remoteHost} — ${workspace.cwd}`
                          : workspace.cwd
                      }
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
                        {remoteHost && (
                          <span
                            className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
                            data-testid="remote-workspace-folder-icon"
                          >
                            <FolderClosedIcon
                              className="size-3.5"
                              strokeWidth={1.4}
                              aria-hidden="true"
                            />
                            <Globe2Icon
                              className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-popover text-[var(--agent-blue-500)]"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          </span>
                        )}
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
              <DropdownMenuRadioItem
                value={STANDALONE_OPTION_ID}
                className="hover:bg-accent/60"
              >
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
          {menuItems && (
            <>
              <DropdownMenuSeparator />
              {menuItems}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}
