import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type {
  DaemonSessionGroupColor,
  DaemonSessionGroupPresetColor,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  Columns2Icon,
  DownloadIcon,
  FolderInputIcon,
  GitPullRequestIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Drawer, DrawerContent, DrawerTitle } from '../ui/drawer';
import { SessionDetailsContent } from './SessionDetailsTooltip';
import styles from './WebShellSidebar.module.css';

export type SessionActionSheetItemId =
  | 'pin'
  | 'rename'
  | 'bindPr'
  | 'group'
  | 'archive'
  | 'unarchive'
  | 'export'
  | 'split'
  | 'delete';

export interface SessionActionSheetItem {
  id: SessionActionSheetItemId;
  label: string;
  disabled?: boolean;
  disabledTitle?: string;
  destructive?: boolean;
  opensDialog?: boolean;
  opensGroupSubpage?: boolean;
  trailingLabel?: string;
  onSelect: () => void;
}

export interface SessionActionSheetGroupItem {
  id: string;
  name: string;
  color: DaemonSessionGroupColor;
}

export interface SessionActionSheetGroupPicker {
  loading: boolean;
  groups: readonly SessionActionSheetGroupItem[];
  colorOptions: readonly DaemonSessionGroupPresetColor[];
  selectedGroupId: string | null;
  selectedColor: DaemonSessionGroupPresetColor | null;
  onLoad: () => Promise<boolean>;
  onAssignGroup: (groupId: string | null) => void;
  onAssignColor: (color: DaemonSessionGroupPresetColor) => void;
  onCreateGroup: () => void;
}

export interface SessionActionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: DaemonSessionSummary | null;
  label: string;
  time: string;
  completedUnread: boolean;
  statusLabel?: string;
  workspaceLabel?: string;
  showDetails: boolean;
  actions: readonly SessionActionSheetItem[];
  groupPicker?: SessionActionSheetGroupPicker;
  returnFocusEl?: HTMLElement | null;
}

type SheetPage = 'root' | 'group';

const ACTION_SHEET_Z_CLASS =
  'z-[calc(var(--web-shell-dialog-backdrop-z-index,50)+2)]';

function getGroupDotClass(color: DaemonSessionGroupColor): string | undefined {
  if (color.startsWith('#')) return styles.groupColorCustom;
  switch (color) {
    case 'red':
      return styles.groupColorRed;
    case 'orange':
      return styles.groupColorOrange;
    case 'yellow':
      return styles.groupColorYellow;
    case 'green':
      return styles.groupColorGreen;
    case 'blue':
      return styles.groupColorBlue;
    case 'purple':
      return styles.groupColorPurple;
    default:
      return undefined;
  }
}

function getGroupDotStyle(
  color: DaemonSessionGroupColor,
): CSSProperties | undefined {
  return color.startsWith('#') ? { backgroundColor: color } : undefined;
}

function ActionIcon({ id }: { id: SessionActionSheetItemId }) {
  switch (id) {
    case 'pin':
      return <PinIcon className="size-4 shrink-0" aria-hidden="true" />;
    case 'rename':
      return <PencilIcon className="size-4 shrink-0" aria-hidden="true" />;
    case 'bindPr':
      return (
        <GitPullRequestIcon className="size-4 shrink-0" aria-hidden="true" />
      );
    case 'group':
      return <FolderInputIcon className="size-4 shrink-0" aria-hidden="true" />;
    case 'archive':
      return <ArchiveIcon className="size-4 shrink-0" aria-hidden="true" />;
    case 'unarchive':
      return (
        <ArchiveRestoreIcon className="size-4 shrink-0" aria-hidden="true" />
      );
    case 'export':
      return <DownloadIcon className="size-4 shrink-0" aria-hidden="true" />;
    case 'split':
      return <Columns2Icon className="size-4 shrink-0" aria-hidden="true" />;
    case 'delete':
      return <Trash2Icon className="size-4 shrink-0" aria-hidden="true" />;
  }
}

export function SessionActionSheet({
  open,
  onOpenChange,
  session,
  label,
  time,
  completedUnread,
  statusLabel,
  workspaceLabel,
  showDetails,
  actions,
  groupPicker,
  returnFocusEl,
}: SessionActionSheetProps) {
  const { t } = useI18n();
  const [page, setPage] = useState<SheetPage>('root');
  const [loadingGroups, setLoadingGroups] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingCloseActionRef = useRef<(() => void) | null>(null);
  const returnFocusOnCloseRef = useRef(true);
  const lastReturnFocusElRef = useRef<HTMLElement | null>(null);
  const loadRequestRef = useRef(0);

  const finishClose = useCallback(() => {
    const action = pendingCloseActionRef.current;
    const focusTarget = lastReturnFocusElRef.current;
    pendingCloseActionRef.current = null;
    lastReturnFocusElRef.current = null;
    if (action) {
      action();
      return;
    }
    if (returnFocusOnCloseRef.current && focusTarget?.isConnected) {
      focusTarget.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    if (open) {
      returnFocusOnCloseRef.current = true;
      lastReturnFocusElRef.current = returnFocusEl ?? null;
      return undefined;
    }
    loadRequestRef.current += 1;
    setPage('root');
    setLoadingGroups(false);
    if (pendingCloseActionRef.current || lastReturnFocusElRef.current) {
      const timer = window.setTimeout(finishClose, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [finishClose, open, returnFocusEl]);

  useEffect(() => {
    if (!open || page !== 'group') return;
    const raf = window.requestAnimationFrame(() => {
      const firstItem = contentRef.current?.querySelector<HTMLElement>(
        '[role="menuitemradio"]',
      );
      firstItem?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open, page]);

  useEffect(() => {
    loadRequestRef.current += 1;
    setPage('root');
    setLoadingGroups(false);
  }, [session?.sessionId]);

  const closeAndRun = useCallback(
    (action: () => void) => {
      pendingCloseActionRef.current = action;
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        loadRequestRef.current += 1;
        setPage('root');
        setLoadingGroups(false);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleActionClick = (item: SessionActionSheetItem) => {
    if (item.disabled) return;
    if (item.opensGroupSubpage && groupPicker) {
      const requestId = ++loadRequestRef.current;
      setLoadingGroups(true);
      void groupPicker
        .onLoad()
        .then((loaded) => {
          if (loadRequestRef.current !== requestId) return;
          setLoadingGroups(false);
          if (loaded) setPage('group');
        })
        .catch(() => {
          if (loadRequestRef.current === requestId) {
            setLoadingGroups(false);
          }
        });
      return;
    }
    if (item.opensDialog) {
      closeAndRun(item.onSelect);
      return;
    }
    onOpenChange(false);
    item.onSelect();
  };

  const standardActions = actions.filter((item) => !item.destructive);
  const destructiveActions = actions.filter((item) => item.destructive);
  const ungroupedSelected =
    groupPicker !== undefined &&
    groupPicker.selectedGroupId === null &&
    groupPicker.selectedColor === null;

  return (
    <Drawer
      open={open && session !== null}
      onOpenChange={handleOpenChange}
      shouldScaleBackground={false}
    >
      <DrawerContent
        ref={contentRef}
        tabIndex={-1}
        aria-describedby={undefined}
        data-web-shell-session-action-sheet=""
        overlayProps={{ className: ACTION_SHEET_Z_CLASS }}
        // Override vaul's runtime-injected unlayered `[data-vaul-drawer]{touch-action:none}`
        // so native vertical touch scrolling works inside the sheet on iOS/Android.
        style={{ touchAction: 'pan-y' }}
        className={`${ACTION_SHEET_Z_CLASS} max-h-[85dvh] pb-[max(1rem,env(safe-area-inset-bottom))] outline-none sm:mx-auto sm:max-w-md sm:rounded-t-2xl`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
        onPointerDownOutside={() => {
          returnFocusOnCloseRef.current = false;
        }}
        onInteractOutside={() => {
          returnFocusOnCloseRef.current = false;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          finishClose();
        }}
      >
        <div className="flex items-start gap-2 px-3 pt-1 pb-2">
          {page === 'group' && (
            <Button
              type="button"
              variant="ghost"
              className="size-11 shrink-0"
              aria-label={t('common.back')}
              onClick={() => setPage('root')}
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <DrawerTitle className="min-w-0 flex-1 self-center break-words text-base font-medium leading-snug">
            {page === 'group' ? t('sidebar.sessionGroup') : label}
          </DrawerTitle>
          <Button
            type="button"
            variant="ghost"
            className="size-11 shrink-0"
            aria-label={t('common.close')}
            onClick={() => handleOpenChange(false)}
          >
            <XIcon />
          </Button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 touch-pan-y"
          data-vaul-no-drag
          data-web-shell-session-action-sheet-scroll=""
        >
          {page === 'root' && session && (
            <div className="flex flex-col gap-2">
              {showDetails && (
                <SessionDetailsContent
                  session={session}
                  label={label}
                  time={time}
                  completedUnread={completedUnread}
                  statusLabel={statusLabel}
                  workspaceLabel={workspaceLabel}
                  variant="sheet"
                  resetSignal={open}
                />
              )}
              {standardActions.length > 0 && (
                <div className="flex flex-col gap-0.5" role="group">
                  {standardActions.map((item) => {
                    const isDisabled =
                      Boolean(item.disabled) ||
                      (Boolean(item.opensGroupSubpage) &&
                        (loadingGroups || Boolean(groupPicker?.loading)));
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={isDisabled}
                        title={item.disabledTitle}
                        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-normal text-popover-foreground transition-colors active:bg-accent disabled:pointer-events-none disabled:opacity-50"
                        onClick={() => handleActionClick(item)}
                      >
                        <ActionIcon id={item.id} />
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                        {item.trailingLabel && (
                          <span className="max-w-28 truncate text-xs text-muted-foreground">
                            {item.trailingLabel}
                          </span>
                        )}
                        {item.opensGroupSubpage && (
                          <ChevronRightIcon
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {destructiveActions.length > 0 && (
                <>
                  {standardActions.length > 0 && (
                    <div className="my-1 h-px bg-border" role="separator" />
                  )}
                  <div className="flex flex-col gap-0.5" role="group">
                    {destructiveActions.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={item.disabled}
                        title={item.disabledTitle}
                        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-normal text-destructive transition-colors active:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                        onClick={() => handleActionClick(item)}
                      >
                        <ActionIcon id={item.id} />
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {page === 'group' && groupPicker && (
            <div
              className="flex flex-col gap-0.5"
              role="menu"
              aria-label={t('sidebar.sessionGroup')}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={ungroupedSelected}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-popover-foreground transition-colors active:bg-accent"
                onClick={() => {
                  onOpenChange(false);
                  groupPicker.onAssignGroup(null);
                }}
              >
                <span className={styles.groupMenuEmptyDot} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {t('sidebar.groupUngrouped')}
                </span>
                {ungroupedSelected && (
                  <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
                )}
              </button>
              {groupPicker.colorOptions.map((color) => {
                const selected = groupPicker.selectedColor === color;
                return (
                  <button
                    key={`color:${color}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-popover-foreground transition-colors active:bg-accent"
                    onClick={() => {
                      onOpenChange(false);
                      groupPicker.onAssignColor(color);
                    }}
                  >
                    <span
                      className={`${styles.groupMenuDot} ${getGroupDotClass(color) ?? ''}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t(`sidebar.groupColor.${color}`)}
                    </span>
                    {selected && (
                      <CheckIcon
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
              {groupPicker.groups.map((group) => {
                const selected = groupPicker.selectedGroupId === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-popover-foreground transition-colors active:bg-accent"
                    onClick={() => {
                      onOpenChange(false);
                      groupPicker.onAssignGroup(group.id);
                    }}
                  >
                    <span
                      className={`${styles.groupMenuDot} ${getGroupDotClass(group.color) ?? ''}`}
                      style={getGroupDotStyle(group.color)}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {group.name}
                    </span>
                    {selected && (
                      <CheckIcon
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
              <div className="my-1 h-px bg-border" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-popover-foreground transition-colors active:bg-accent"
                onClick={() => closeAndRun(groupPicker.onCreateGroup)}
              >
                <PlusIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {t('sidebar.groupCreate')}
                </span>
              </button>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
