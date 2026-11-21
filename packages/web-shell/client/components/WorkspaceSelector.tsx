import { Fragment, useEffect, useRef, useState } from 'react';
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
 * Composer focus target inside the owning composer shell: CodeMirror's
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
 * composer: the composer shell (`data-web-shell-composer`, the
 * ChatEditor root) around the trigger. The selector renders inside that
 * same shell, so a remount of the shell unmounts the selector and its
 * cleanup stops the watch — the watch can never outlive its shell, and a
 * document-wide lookup is deliberately off the table (a first-match
 * against a page with a hidden managed-home composer, or a second Web
 * Shell, would focus the wrong instance, or a hidden one).
 *
 * The focus is taken in 150 ms steps instead of once: while the menu
 * closes its trapped focus scope still claims focus, and a selection from
 * the active session can remount the owning pane (SplitView keys panes by
 * session and workspace) AFTER the synchronous attempt has landed,
 * detaching the shell and the focused node. Each step re-resolves the
 * target from the still-connected shell; a step that finds the shell
 * disconnected stops instead.
 *
 * The watch stops when the user takes over: a `focusin` into their own
 * field (registered for the watch only, so the closing menu's own focus
 * movement never counts), or — once a step has actually landed — a blur
 * of the claimed composer to nowhere: a click on an unfocusable area
 * drops the caret to <body>, which fires no focusin at all, and the next
 * step would pull it back. The active-element check resolves from the
 * target's own root so shells mounted in a shadow root see the real
 * focus (document.activeElement retargets to the shadow host).
 *
 * Returns the stop handle: the watch cannot see its own owner, so the
 * caller must call it when the selector unmounts or the menu re-opens.
 */
function scheduleComposerFocus(trigger: HTMLElement | null): () => void {
  const shell = trigger?.closest('[data-web-shell-composer]') ?? null;
  let attemptsLeft = 3;
  let timer: number | undefined;
  let currentTarget: HTMLElement | null = null;
  let settled = false;
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    if (timer !== undefined) window.clearTimeout(timer);
    document.removeEventListener('focusin', onUserFocus);
    document.removeEventListener('focusout', onUserBlur);
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
  const onUserBlur = (event: FocusEvent): void => {
    // Armed only after a landing: the close sequence blurs to <body>
    // while the menu tears down, and that is not the user taking over.
    // The claimed element must still be connected: a remount detaches it
    // before the next step can stop the watch, and its implicit blur is
    // the remount, not a user blur.
    if (!settled || !currentTarget || !currentTarget.isConnected) return;
    const from = event.composedPath()[0] as Element | null;
    if (!from || (from !== currentTarget && !currentTarget.contains(from)))
      return;
    const related = event.relatedTarget;
    if (related && related !== document.body) return;
    stop();
  };
  document.addEventListener('focusin', onUserFocus);
  document.addEventListener('focusout', onUserBlur);
  const attempt = (): void => {
    timer = undefined;
    if (done) return;
    // A remount of the shell unmounts the selector with it and runs the
    // unmount cleanup; a step that finds the shell disconnected stops
    // instead of falling back to a document-wide lookup (the selector can
    // only ever see its own shell, which is the one that remounts).
    if (!shell?.isConnected) {
      stop();
      return;
    }
    const target = findComposerFocusTarget(shell);
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
        settled = true;
      }
    } catch {
      // focus() can throw in exotic hosts; keep retrying.
    }
    // Still watch once more: the selection may remount the owning shell
    // after this lands, detaching the focused node.
    if (attemptsLeft > 0) {
      attemptsLeft -= 1;
      timer = window.setTimeout(attempt, 150);
    } else {
      stop();
    }
  };
  attempt();
  return stop;
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
  // Stop handle of the focus watch started by the last selection.
  const focusStopRef = useRef<(() => void) | null>(null);
  // The watch's timers and document listeners outlive this component
  // unless cancelled: a pending step would otherwise re-focus a composer
  // after the selector is gone.
  useEffect(
    () => () => {
      focusStopRef.current?.();
    },
    [],
  );
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
          if (open) {
            pointerDismissedRef.current = false;
            // A reopened menu takes the user's focus back; the pending
            // step would pull it out again behind the open menu.
            focusStopRef.current?.();
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
            // (the existing behaviour); only escape — or a coarse-pointer
            // keyboard selection — keeps the restore.
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
              // focus; the trigger is captured before dispatch so the
              // lookup still identifies the right composer if the
              // selection remounts it.
              const focusComposerAfterSelect = (): void => {
                // Programmatic focus on a coarse pointer claims the active
                // element without opening the keyboard, and later taps may
                // then raise no keyboard at all (#5958) — the same gate the
                // toolbar controls use. Gate BEFORE arming `selectedRef`:
                // a keyboard selection on a coarse device must keep
                // Radix's restore to the trigger.
                if (isCoarsePointerDevice()) return;
                selectedRef.current = true;
                focusStopRef.current = scheduleComposerFocus(
                  triggerRef.current,
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
