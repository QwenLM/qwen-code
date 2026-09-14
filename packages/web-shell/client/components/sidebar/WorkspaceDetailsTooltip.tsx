import type { DaemonWorkspaceGitStatus } from '@qwen-code/sdk/daemon';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
} from 'react';
import {
  BlocksIcon,
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlugIcon,
  RadioTowerIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WebhookIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { BranchPickerPopover } from '../BranchPickerPopover';
import {
  deriveStatus,
  gitBranchAriaLabel,
  gitBranchBadgeTone,
  gitStatusPhrases,
  hasComputedTreeSummary,
} from '../GitBranchIndicator';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import {
  formatOverviewValue,
  overviewDetail,
  overviewFacetHasIssue,
  type WorkspaceOverviewItem,
  type WorkspaceOverviewSnapshot,
  type WorkspaceSessionStats,
} from './workspaceOverviewModel';
import { resolveSessionDetailsCollisionBoundary } from './sessionDetailsCollisionBoundary';
import sidebarStyles from './WebShellSidebar.module.css';

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const ICONS: Record<WorkspaceOverviewItem, ComponentType<{ size?: number }>> = {
  mcp: PlugIcon,
  skills: SparklesIcon,
  extensions: BlocksIcon,
  channels: RadioTowerIcon,
  context: FileTextIcon,
  hooks: WebhookIcon,
};

interface WorkspaceDetailsTooltipProps {
  label: string;
  /** Real filesystem path; undefined for a synthetic fallback workspace. */
  cwd?: string;
  branch?: string | null;
  gitStatus?: DaemonWorkspaceGitStatus;
  /** Session counts lifted out of the header into this popover. */
  sessions?: WorkspaceSessionStats;
  overview: WorkspaceOverviewSnapshot | undefined;
  items: readonly WorkspaceOverviewItem[];
  /**
   * Open the workspace folder in the daemon host's file manager. Only wired
   * when the daemon advertises `workspace_local_open` and the browser is on
   * the same machine; rejects when the host could not open it.
   */
  onOpenPathLocally?: () => Promise<void>;
  /**
   * Open a terminal at the workspace path on the daemon host. Only wired
   * when the daemon advertises `workspace_local_terminal` and the browser is
   * on the same machine; rejects when the host could not open it.
   */
  onOpenTerminalLocally?: () => Promise<void>;
  /**
   * Interactive Git for this workspace's branch row. Wired only for trusted
   * workspaces with a real cwd and a known branch; a row without it keeps the
   * plain-text summary the demand-loading pass left behind.
   */
  gitActions?: {
    workspaceCwd: string;
    onOpenDiff: () => void;
    onOpenCommit?: () => void;
    onStatusRefreshed: (status: DaemonWorkspaceGitStatus) => void;
    /** A checkout creates no SSE event, so the row must re-read the branch. */
    onBranchChanged: () => void;
  };
  onOpenChange?: (open: boolean) => void;
  children: ReactElement;
}

/** Icon button with a 2 s check confirmation, for the local-open actions. */
function OpenLocallyButton({
  label,
  announcement,
  icon: Icon,
  onOpen,
  testId,
}: {
  label: string;
  /** Spoken via the live region on success; failures toast via onError. */
  announcement: string;
  icon: ComponentType<{ size?: number }>;
  onOpen: () => Promise<void>;
  testId: string;
}) {
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState(false);
  const [announced, setAnnounced] = useState(false);
  const resetTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimerRef.current), []);
  return (
    <>
      <button
        type="button"
        className={sidebarStyles.sessionDetailsCopyButton}
        aria-label={label}
        title={label}
        disabled={pending}
        {...{ [`data-web-shell-open-workspace-${testId}`]: true }}
        onClick={(event) => {
          event.stopPropagation();
          // One window per click: the daemon spawns unconditionally per call.
          if (pending) return;
          setPending(true);
          void onOpen()
            .then(() => {
              setOpened(true);
              setAnnounced(true);
              window.clearTimeout(resetTimerRef.current);
              resetTimerRef.current = window.setTimeout(() => {
                setOpened(false);
                setAnnounced(false);
              }, 2000);
            })
            // The sidebar already surfaces the failure via onError; the
            // button simply keeps its idle icon.
            .catch(() => undefined)
            .finally(() => setPending(false));
        }}
      >
        {opened ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <Icon aria-hidden="true" />
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {announced ? announcement : ''}
      </span>
    </>
  );
}

/**
 * Hover details for a workspace header row: full path, git branch and the
 * facet counts that used to sit as chips under the expanded row. The popover
 * takes no persistent space, so known facets show even when their count is
 * zero; only unknown (unreported) facets stay hidden.
 */
export function WorkspaceDetailsTooltip({
  label,
  cwd,
  branch,
  gitStatus,
  sessions,
  overview,
  items,
  onOpenPathLocally,
  onOpenTerminalLocally,
  gitActions,
  onOpenChange,
  children,
}: WorkspaceDetailsTooltipProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The picker's state is mirrored in a ref because Radix focuses the picker
  // as it opens: the focus/blur handlers that follow must already see it as
  // open, or they close the details out from under the picker.
  const pickerOpenRef = useRef(false);
  // Hover is read from the row button, not from this popover's content. The
  // picker's content is portaled out of the DOM but stays a *React* child of
  // this content, and React computes enter/leave over the React tree — so a
  // pointer crossing onto the picker fires no leave here, while a crossing
  // from anywhere into the picker fires an enter. The row button and the
  // picker content are siblings in that tree, so its own leave does fire.
  const rowHoverRef = useRef(false);
  const collisionBoundary = open
    ? resolveSessionDetailsCollisionBoundary(
        anchorRef.current?.closest<HTMLElement>('aside') ?? null,
      )
    : null;

  useEffect(() => {
    return () => {
      window.clearTimeout(openTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  const gitSummary =
    gitStatusPhrases(deriveStatus(gitStatus), t).join(' · ') ||
    (hasComputedTreeSummary(gitStatus) ? t('git.clean') : '');
  // The compact chip's badge dot, lifted beside the branch name: the same
  // blue/amber/red severity read at a glance, without the icon overlay.
  const gitDotTone = gitBranchBadgeTone(deriveStatus(gitStatus));
  const branchRowContent = (
    <>
      <GitBranchIcon aria-hidden="true" />
      <span className={sidebarStyles.sessionDetailsBranch}>
        <span title={branch ?? undefined}>{branch}</span>
        {gitDotTone && (
          <span
            className={sidebarStyles.sessionDetailsGitDot}
            data-tone={gitDotTone}
            aria-hidden="true"
          />
        )}
      </span>
      <span
        className={sidebarStyles.sessionDetailsRowValue}
        title={gitSummary || undefined}
      >
        {gitSummary}
      </span>
    </>
  );

  const cancelClose = () => window.clearTimeout(closeTimerRef.current);
  const openAfterDelay = () => {
    cancelClose();
    if (open) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => setOpen(true), 300);
  };
  const close = () => {
    window.clearTimeout(openTimerRef.current);
    cancelClose();
    // This popover is anchored, not triggered, so Radix has no triggerRef to
    // restore to and suppresses its own fallback restore. Anything focused
    // inside either layer — the row, or the picker's own field — is about to
    // unmount with the content, so hand focus to the folder row rather than
    // let it fall to <body>. Focus anywhere else (a pointer user's composer)
    // is left alone.
    const active = document.activeElement;
    const focusInsideLayers =
      active instanceof HTMLElement &&
      (contentRef.current?.contains(active) === true ||
        active.closest('[data-slot="popover-content"]') !== null);
    pickerOpenRef.current = false;
    rowHoverRef.current = false;
    setPickerOpen(false);
    setOpen(false);
    if (focusInsideLayers) {
      anchorRef.current?.querySelector<HTMLElement>('button')?.focus();
    }
  };
  const closeAfterDelay = () => {
    window.clearTimeout(openTimerRef.current);
    cancelClose();
    // Pinned: the branch picker is a separate layer the pointer reaches by
    // crossing out of this popover, so leaving must not tear it down.
    if (pickerOpenRef.current) return;
    closeTimerRef.current = window.setTimeout(close, 100);
  };
  // Closing the picker collapses the details, with one exception: the pointer
  // is still on the row that opened it. The collapse is not deferred — Radix
  // returns focus to the row as the picker unmounts, and that focus event
  // cancels a pending close, stranding the details after View Changes, Commit
  // or a checkout.
  const handlePickerOpenChange = (nextOpen: boolean) => {
    pickerOpenRef.current = nextOpen;
    setPickerOpen(nextOpen);
    if (nextOpen) cancelClose();
    else if (!rowHoverRef.current) close();
  };
  // The picker unmounts with `branch` or `gitActions` going away, which Radix
  // reports to no one: a controlled `open` has no unmount callback. The row
  // can go the same way, and neither reports the leave it owed. Without this,
  // a stale `pickerOpenRef` pins the details open for good and a stale
  // `rowHoverRef` swallows the next collapse.
  const pickerAvailable = Boolean(branch && gitActions);
  useEffect(() => {
    if (pickerAvailable) return;
    pickerOpenRef.current = false;
    rowHoverRef.current = false;
    setPickerOpen(false);
  }, [pickerAvailable]);
  // The content is portaled, so "focus stayed inside" spans two trees: the
  // anchor (header row) and the popover content.
  const containsFocusTarget = (node: EventTarget | null): boolean =>
    node instanceof Node &&
    (anchorRef.current?.contains(node) === true ||
      contentRef.current?.contains(node) === true);

  const sessionsBreakdown =
    sessions && sessions.total > 0
      ? [
          sessions.attention > 0
            ? t('sidebar.sessionsAttention', { count: sessions.attention })
            : undefined,
          sessions.running > 0
            ? t('sidebar.sessionsRunning', { count: sessions.running })
            : undefined,
          t('sidebar.sessionsTotal', {
            count: sessions.total,
            truncated: sessions.truncated ? 1 : 0,
          }),
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}
    >
      <PopoverAnchor
        ref={anchorRef}
        asChild
        onPointerEnter={(event) => {
          if (event.currentTarget.contains(event.target as Node)) {
            openAfterDelay();
          }
        }}
        onPointerLeave={() => {
          if (!containsFocusTarget(document.activeElement)) {
            closeAfterDelay();
          }
        }}
        // Keyboard parity with hover: focusing the header button opens the
        // details after the same delay; moving focus out closes them.
        onFocus={(event) => {
          if (event.currentTarget.contains(event.target as Node)) {
            openAfterDelay();
          }
        }}
        onBlur={(event) => {
          if (!containsFocusTarget(event.relatedTarget)) {
            closeAfterDelay();
          }
        }}
        onPointerDownCapture={close}
        onClick={() => close()}
      >
        {children}
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        side="right"
        align="start"
        sideOffset={0}
        collisionBoundary={collisionBoundary ?? undefined}
        collisionPadding={8}
        updatePositionStrategy="always"
        showArrow
        role="dialog"
        aria-label={label}
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Belt-and-braces for the nested picker. Radix already keeps a press
        // inside a React descendant off this layer's own outside path, so this
        // covers a dismissal arriving by some other route (a focus move) while
        // the picker is open.
        onInteractOutside={(event) => {
          if (pickerOpenRef.current) event.preventDefault();
        }}
        onPointerEnter={() => {
          cancelClose();
        }}
        onPointerLeave={() => {
          // Keyboard parity: while focus lives inside the content the
          // pointer leaving is not a dismiss signal.
          if (!containsFocusTarget(document.activeElement)) {
            closeAfterDelay();
          }
        }}
        onFocus={cancelClose}
        onBlur={(event) => {
          if (!containsFocusTarget(event.relatedTarget)) {
            closeAfterDelay();
          }
        }}
        className={sidebarStyles.sessionDetailsTooltip}
      >
        <div className={sidebarStyles.sessionDetailsHeader}>
          <span className={sidebarStyles.sessionDetailsTitle} title={label}>
            {label}
          </span>
        </div>
        {cwd && (
          <div className={sidebarStyles.sessionDetailsRow}>
            <FolderClosedIcon aria-hidden="true" />
            <span
              className={sidebarStyles.sessionDetailsPath}
              title={cwd}
              data-web-shell-workspace-path
            >
              {cwd}
            </span>
            {(onOpenPathLocally || onOpenTerminalLocally) && (
              <span className={sidebarStyles.sessionDetailsRowActions}>
                {onOpenPathLocally && (
                  <OpenLocallyButton
                    label={t('sidebar.openWorkspaceFolder')}
                    announcement={t('sidebar.openWorkspaceFolderOpened')}
                    icon={FolderOpenIcon}
                    onOpen={onOpenPathLocally}
                    testId="folder"
                  />
                )}
                {onOpenTerminalLocally && (
                  <OpenLocallyButton
                    label={t('sidebar.openWorkspaceTerminal')}
                    announcement={t('sidebar.openWorkspaceTerminalOpened')}
                    icon={SquareTerminalIcon}
                    onOpen={onOpenTerminalLocally}
                    testId="terminal"
                  />
                )}
              </span>
            )}
          </div>
        )}
        {branch &&
          (gitActions ? (
            // Nested layer: both contents carry the same popover z-index, and
            // the picker's portal mounts after this popover's, so it paints on
            // top by document order alone. Portal something between the two
            // and that order no longer holds.
            <BranchPickerPopover
              open={pickerOpen}
              onOpenChange={handlePickerOpenChange}
              workspaceCwd={gitActions.workspaceCwd}
              side="right"
              status={gitStatus}
              onBranchChanged={gitActions.onBranchChanged}
              onStatusRefreshed={gitActions.onStatusRefreshed}
              onOpenDiff={gitActions.onOpenDiff}
              onOpenCommit={gitActions.onOpenCommit}
            >
              <button
                type="button"
                className={cx(
                  sidebarStyles.sessionDetailsRow,
                  sidebarStyles.sessionDetailsRowButton,
                )}
                aria-label={gitBranchAriaLabel(branch, gitStatus, t)}
                data-web-shell-workspace-git
                onPointerEnter={() => {
                  rowHoverRef.current = true;
                }}
                onPointerLeave={() => {
                  rowHoverRef.current = false;
                }}
              >
                {branchRowContent}
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </BranchPickerPopover>
          ) : (
            <div className={sidebarStyles.sessionDetailsRow}>
              {branchRowContent}
            </div>
          ))}
        {sessions && sessions.total > 0 && (
          <div
            className={sidebarStyles.sessionDetailsRow}
            title={sessionsBreakdown}
            aria-label={sessionsBreakdown}
            data-web-shell-workspace-sessions
          >
            <MessageSquareIcon size={14} aria-hidden="true" />
            <span>{t('sidebar.overview.sessions')}</span>
            <span className={sidebarStyles.sessionDetailsSessionCounts}>
              {sessions.attention > 0 && (
                <span
                  className={cx(
                    sidebarStyles.sessionDetailsSessionCount,
                    sidebarStyles.sessionDetailsSessionCountAttention,
                  )}
                >
                  {sessions.attention}
                </span>
              )}
              {sessions.running > 0 && (
                <span
                  className={cx(
                    sidebarStyles.sessionDetailsSessionCount,
                    sidebarStyles.sessionDetailsSessionCountRunning,
                  )}
                >
                  {sessions.running}
                </span>
              )}
              <span
                className={cx(
                  sidebarStyles.sessionDetailsSessionCount,
                  sidebarStyles.sessionDetailsSessionCountTotal,
                )}
              >
                {sessions.total}
                {sessions.truncated ? '+' : ''}
              </span>
            </span>
          </div>
        )}
        {overview &&
          items.map((item) => {
            const value = formatOverviewValue(overview, item);
            const issue = overviewFacetHasIssue(overview, item);
            // Only an unknown facet (not reported yet, or unavailable on
            // this daemon) earns no row; a known zero is real information.
            if (value === undefined) return null;
            const Icon = ICONS[item];
            const facetLabel = t(`sidebar.overview.${item}`);
            const detail = overviewDetail(t, overview, item);
            const title = `${facetLabel}: ${detail}`;
            return (
              <div
                key={item}
                className={cx(
                  sidebarStyles.sessionDetailsRow,
                  issue && sidebarStyles.sessionDetailsRowIssue,
                )}
                title={title}
                aria-label={title}
                data-web-shell-workspace-overview={item}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{facetLabel}</span>
                <span className={sidebarStyles.sessionDetailsRowValue}>
                  {value}
                </span>
              </div>
            );
          })}
      </PopoverContent>
    </Popover>
  );
}
