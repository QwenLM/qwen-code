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
  FileTextIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlugIcon,
  RadioTowerIcon,
  SparklesIcon,
  TerminalIcon,
  WebhookIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
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
  sessions,
  overview,
  items,
  onOpenPathLocally,
  onOpenTerminalLocally,
  children,
}: WorkspaceDetailsTooltipProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
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
    setOpen(false);
  };
  const closeAfterDelay = () => {
    window.clearTimeout(openTimerRef.current);
    cancelClose();
    closeTimerRef.current = window.setTimeout(close, 100);
  };
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
        onPointerEnter={cancelClose}
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
                    icon={TerminalIcon}
                    onOpen={onOpenTerminalLocally}
                    testId="terminal"
                  />
                )}
              </span>
            )}
          </div>
        )}
        {branch && (
          <div className={sidebarStyles.sessionDetailsRow}>
            <GitBranchIcon aria-hidden="true" />
            <span title={branch}>{branch}</span>
          </div>
        )}
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
