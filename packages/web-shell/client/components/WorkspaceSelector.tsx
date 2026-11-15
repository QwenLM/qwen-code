import { Fragment, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CircleDashedIcon,
  FolderClosedIcon,
  FolderPlusIcon,
  Globe2Icon,
  LockIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { isCoarsePointerDevice } from '../hooks/useIsTouchComposer';
import { getShadowAwareActiveElement } from '../utils/dom';
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
 * Composer focus target inside the owning pane: CodeMirror's
 * contenteditable on desktop, the textarea itself on the mobile composer.
 */
function findComposerFocusTarget(scope: ParentNode): HTMLElement | null {
  const editor = scope.querySelector<HTMLElement>(
    '[data-web-shell-composer-editor]',
  );
  return editor?.querySelector<HTMLElement>('.cm-content') ?? editor;
}

/**
 * Moves focus into the prompt composer after a workspace is picked.
 *
 * The lookup is scoped to the element that owns both the trigger and its
 * composer: the captured split-view pane when one exists, else the
 * composer shell (`data-web-shell-composer`, the ChatEditor root) around
 * the trigger. The document is a last resort and only when exactly one
 * composer exists in it — a document-wide first-match against a page with
 * a hidden managed-home composer (or a second Web Shell) would focus the
 * wrong instance, or a hidden one. The active-element check resolves from
 * the target's own root so shells mounted in a shadow root see the real
 * focus (document.activeElement retargets to the shadow host).
 *
 * The focus is taken in 150 ms steps instead of once: while the menu
 * closes its trapped focus scope still claims focus, and a selection from
 * the active session remounts the owning pane (SplitView keys panes by
 * session and workspace) AFTER the synchronous attempt has landed,
 * detaching the focused node. A `focusin` listener (registered for the
 * watch only, so the menu's own focus movement never counts) stops the
 * watch when the user moves focus into their own field — never steal it
 * back. Each step re-resolves the target from the still-connected scope.
 * `onCloseAutoFocus` suppresses Radix's restore to the trigger for a
 * selection, so the composer keeps focus once it lands.
 */
function scheduleComposerFocus(
  trigger: HTMLElement | null,
  pane: Element | null,
): void {
  // Programmatic focus on a coarse pointer claims the active element
  // without opening the keyboard, and later taps may then raise no
  // keyboard at all (#5958) — the same gate the toolbar controls use.
  if (isCoarsePointerDevice()) return;
  const shell = trigger?.closest('[data-web-shell-composer]') ?? null;
  let attemptsLeft = 3;
  let timer: number | undefined;
  let currentTarget: HTMLElement | null = null;
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    if (timer !== undefined) window.clearTimeout(timer);
    document.removeEventListener('focusin', onUserFocus);
  };
  const onUserFocus = (event: Event): void => {
    // composedPath resolves inside shadow roots; event.target retargets
    // to the shadow host. The menu trigger, body, and the composer we
    // are claiming are ours, not the user's. Focus inside the open menu
    // is the trap's own (our focus() re-triggers it on the way) — not a
    // user move either.
    const el = event.composedPath()[0] as Element | null;
    if (!el || el === document.body || el === trigger) return;
    if (el.closest('[role="menu"], [data-radix-popper-content-wrapper]')) {
      return;
    }
    if (currentTarget && (el === currentTarget || currentTarget.contains(el)))
      return;
    stop();
  };
  document.addEventListener('focusin', onUserFocus);
  const attempt = (): void => {
    timer = undefined;
    if (done) return;
    // A scope that remounts drops one level: pane -> shell -> document.
    let scope: ParentNode | null = null;
    if (pane?.isConnected) {
      scope = pane;
    } else if (shell?.isConnected) {
      scope = shell;
    } else if (
      document.querySelectorAll('[data-web-shell-composer-editor]').length === 1
    ) {
      scope = document;
    }
    if (!scope) {
      stop();
      return;
    }
    const target = findComposerFocusTarget(scope);
    if (target) {
      currentTarget = target;
    }
    if (!target) {
      if (attemptsLeft > 0) {
        attemptsLeft -= 1;
        timer = window.setTimeout(attempt, 150);
      } else {
        stop();
      }
      return;
    }
    try {
      target.focus({ preventScroll: true });
      const landed = getShadowAwareActiveElement(target);
      if (landed === target || target.contains(landed)) {
        // Still watch once more: the selection may remount the owning
        // pane after this lands, detaching the focused node.
        if (attemptsLeft > 0) {
          attemptsLeft -= 1;
          timer = window.setTimeout(attempt, 150);
        } else {
          stop();
        }
        return;
      }
    } catch {
      // focus() can throw in exotic hosts; keep retrying.
    }
    if (attemptsLeft > 0) {
      attemptsLeft -= 1;
      timer = window.setTimeout(attempt, 150);
    } else {
      stop();
    }
  };
  attempt();
}

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
  const menuOpenRef = useRef(false);
  const suppressTooltipRef = useRef(false);
  const pointerDismissedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // A radio selection was dispatched for the in-flight close; the composer
  // takes focus, so Radix must not restore it to the trigger.
  const selectedRef = useRef(false);
  const selected = workspaces.find((workspace) =>
    selectedWorkspaceCwd
      ? workspace.cwd === selectedWorkspaceCwd
      : workspace.primary,
  );
  const canCreate = scratchSupported || existingFolderSupported;
  const standaloneSelectable = Boolean(
    standaloneSupported && onSelectStandalone,
  );
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
    : (selected?.label ?? t('sidebar.workspaceSelectLabel'));

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
                ref={triggerRef}
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
            // Suppress Radix's restore to the trigger after a selection
            // (the composer takes focus) and after a pointer dismissal
            // (the existing behaviour); only escape keeps the restore.
            if (pointerDismissedRef.current || selectedRef.current) {
              event.preventDefault();
            }
            pointerDismissedRef.current = false;
            selectedRef.current = false;
          }}
        >
          <DropdownMenuRadioGroup
            value={selectedStandalone ? STANDALONE_OPTION_ID : selected?.id}
            onValueChange={(id) => {
              // Every accepted selection ends with the prompt composer in
              // focus; the trigger and its pane are captured before
              // dispatch so the lookup still identifies the right composer
              // if the selection remounts the owning pane.
              const focusComposerAfterSelect = (): void => {
                selectedRef.current = true;
                scheduleComposerFocus(
                  triggerRef.current,
                  triggerRef.current?.closest('[data-pane-session-id]') ?? null,
                );
              };
              if (standaloneSelectable && id === STANDALONE_OPTION_ID) {
                onSelectStandalone?.();
                focusComposerAfterSelect();
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
              focusComposerAfterSelect();
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
