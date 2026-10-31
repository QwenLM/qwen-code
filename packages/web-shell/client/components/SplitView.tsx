/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DaemonSessionProvider,
  useConnection,
  useSession,
  useWorkspace,
  type DaemonSessionActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  STANDALONE_SESSIONS_CAPABILITY,
  DaemonHttpError,
  isStandaloneSessionNotFoundError,
  type DaemonSessionArtifact,
  type DaemonSessionMonitorTaskStatus,
  type DaemonSessionSummary,
  type DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import type { WebShellSlashCommandHandler } from '../App';
import type { WebShellModelManagementOptions } from '../modelManagement';
import type {
  WebShellUnavailableModel,
  WebShellUnavailableModelTooltipMount,
} from '../unavailableModels';
import type { RegisterContextUsageControls } from '../hooks/useContextUsageControls';
import { useI18n } from '../i18n';
import { ChatPane, type PaneHeaderActionsRenderer } from './ChatPane';
import { ErrorBoundary } from './ErrorBoundary';
import { MAX_SPLIT_PANES } from '../utils/splitUrl';
import type {
  TurnOutputKind,
  TurnOutputOpenRequest,
} from './artifacts/TurnOutputs';
import {
  SESSION_LIST_PAGE_SIZE,
  SESSION_ORGANIZATION_FEATURE,
  WEB_SHELL_HISTORY_PAGE_SIZE,
  WEB_SHELL_MAX_TRANSCRIPT_BLOCKS,
} from '../constants/sessions';
import { isSessionArchivedHttpError } from '../daemon/session/DaemonSessionProvider';
import { useOtherWorkspaceSessions } from '../hooks/useOtherWorkspaceSessions';
import { useScopedSessions } from '../hooks/useScopedSessions';
import {
  hasMultipleWorkspaces,
  mergeSessionsById,
  workspaceLabelForCwd,
} from '../utils/workspace';
import { isEditableTarget } from '../utils/dom';
import { AssistantTurnSettlementObserver } from '../assistant-turn-settlement';
import type { WebShellAssistantTurnSettledEvent } from '../customization';
import styles from './SplitView.module.css';

const MAX_PANES = MAX_SPLIT_PANES;

// A deterministic 409 that is not the not-found answer: the daemon knows the
// id but refuses to serve it as a standalone session (a session-id case
// conflict, or a stored/live shape mismatch). The pane is kept on this
// outcome — the id exists somewhere — and the verdict is cached so the round
// stops re-probing it. A conflict the daemon marks `retryable` (a pending
// deletion journal) is transient: it caches nothing, so a later round asks
// again.
function isStandaloneSessionConflictError(error: unknown): boolean {
  if (!(error instanceof DaemonHttpError) || error.status !== 409) {
    return false;
  }
  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  return (
    record['code'] === 'standalone_session_conflict' &&
    record['retryable'] !== true
  );
}

/**
 * Reports, from inside a pane's own provider, the moment the connection
 * parks on the daemon's terminal `session_archived` answer (409). SplitView
 * acts on it whether or not the catalog page is complete: it is the pane's
 * own authoritative answer.
 */
function TerminalArchivedReporter({
  sessionId,
  onReport,
}: {
  sessionId: string;
  onReport: (sessionId: string, archived: boolean) => void;
}) {
  const { connection } = useSession();
  const archived =
    connection.sessionArchived === true &&
    connection.status === 'disconnected' &&
    connection.sessionId === undefined;
  useEffect(() => {
    if (!archived) return;
    onReport(sessionId, true);
    return () => onReport(sessionId, false);
  }, [archived, onReport, sessionId]);
  return null;
}

export interface SplitViewProps {
  showResponseTokensPerSecond?: boolean;
  /** Sessions to show in the split view. */
  sessionIds?: string[];
  /** Respect the host's session-details action allowlist. */
  showSessionDetails?: boolean;
  /**
   * Report the live pane set (after every add / remove) up to the parent so it
   * survives this view unmounting. Switching away from the split and back must
   * restore exactly the panes the user had, not reseed from a stale selection.
   * Must be referentially stable (e.g. a `useState` setter) — a fresh callback
   * each render would re-fire the reporting effect and loop.
   */
  onPanesChange?: (sessionIds: string[]) => void;
  onAssistantTurnSettled?: (event: WebShellAssistantTurnSettledEvent) => void;
  /**
   * Report panes surfacing approvals, including hidden panes. Keep stable while
   * consumer inputs are unchanged; a new callback receives the current list.
   */
  onPendingPanesChange?: (sessionIds: string[]) => void;
  /** Leave the split view (back to the single-session chat). */
  onExit: () => void;
  onError?: (error: unknown, fallback: string) => void;
  onImageIngestionNotice?: (tone: 'warning' | 'error', message: string) => void;
  onSlashCommand?: WebShellSlashCommandHandler;
  modelManagement?: WebShellModelManagementOptions;
  unavailableModels?: readonly WebShellUnavailableModel[];
  mountUnavailableModelTooltip?: WebShellUnavailableModelTooltipMount;
  onOpenGoals?: () => void;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onOpenMonitor?: (
    task: DaemonSessionMonitorTaskStatus,
    sessionId: string,
    sessionActions: DaemonSessionActions,
  ) => void;
  registerContextUsageControls?: RegisterContextUsageControls;
  onBeforeContextCompress?: (sessionId: string) => void;
  onOpenContextUsage?: (
    sessionId: string,
    sessionActions: DaemonSessionActions,
  ) => void;
  onPaneArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
  ) => void;
  messageTurnOutputs?: readonly TurnOutputKind[];
  /**
   * Extra actions rendered in each pane header, before the built-in close
   * button. See `ChatPaneProps.renderHeaderActions`.
   */
  renderPaneHeaderActions?: PaneHeaderActionsRenderer;
  /** Include active sessions from every trusted registered workspace. */
  includeOtherWorkspaces?: boolean;
  /** Limit session discovery and pane attachment to this workspace. */
  workspaceCwd?: string;
  /** Restart each pane's SSE event stream after an accepted prompt. */
  restartSseOnPrompt?: boolean;
  /** Persisted transcript records requested per page by each pane. */
  historyPageSize?: number;
  voiceUserRevision?: number;
  voiceWorkspaceRevisions?: Readonly<Record<string, number>>;
  voiceWorkspaces?: readonly DaemonWorkspaceCapability[];
  sessionWorkflowEnabled?: boolean;
  planControlVisible?: boolean;
}

/**
 * Shows 2+ independent interactive chats side by side in one window. Each pane
 * is its own `DaemonSessionProvider` (own session, SSE, transcript, approvals),
 * all sharing the one `DaemonWorkspaceProvider` above the app. Browser focus
 * naturally scopes the keyboard to the pane the user clicks into, so panes never
 * fight over which session an approval or Enter belongs to.
 */
export function SplitView({
  sessionIds,
  showSessionDetails = true,
  onPanesChange,
  onAssistantTurnSettled,
  onPendingPanesChange,
  onExit,
  onError,
  onImageIngestionNotice,
  onSlashCommand,
  modelManagement,
  unavailableModels,
  mountUnavailableModelTooltip,
  onOpenGoals,
  onRightPanelOpen,
  onOpenMonitor,
  onPaneArtifactsChange,
  registerContextUsageControls,
  onBeforeContextCompress,
  onOpenContextUsage,
  messageTurnOutputs,
  renderPaneHeaderActions,
  includeOtherWorkspaces = true,
  workspaceCwd,
  restartSseOnPrompt,
  historyPageSize = WEB_SHELL_HISTORY_PAGE_SIZE,
  voiceUserRevision = 0,
  voiceWorkspaceRevisions = {},
  voiceWorkspaces,
  sessionWorkflowEnabled = false,
  showResponseTokensPerSecond = false,
  planControlVisible = false,
}: SplitViewProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const currentSessionId = connection.sessionId;
  // The provider clears `connection.sessionId` when the current session parks
  // on a terminal answer (archived, deleted). The seed pane must keep its
  // prune exemption and its workspace through that park, so it is keyed on
  // the last defined id.
  const seedSessionIdRef = useRef(currentSessionId);
  if (currentSessionId !== undefined) {
    seedSessionIdRef.current = currentSessionId;
  }
  const seedSessionId = seedSessionIdRef.current;
  const organizationEnabled =
    connection.capabilities?.features?.includes(SESSION_ORGANIZATION_FEATURE) ??
    false;
  const workspace = useWorkspace();
  const {
    sessions,
    reload,
    // Defined only once the active list has loaded at least once — the
    // readiness signal for pruning panes whose session left the catalog.
    data: activeSessionPage,
    // Page-completeness markers: a bounded page (more results than were
    // fetched) or a merge that failed partway means "not in this page" is not
    // "gone", so the prune guard waits for all three to be clean before
    // trusting an absence.
    nextCursor: activeSessionNextCursor,
    liveMergeFailed: activeSessionLiveMergeFailed,
    truncated: activeSessionTruncated,
    // A page retained after a failed refresh is not a fresh answer: absence
    // from it proves nothing, so the prune guard waits for it too.
    error: activeSessionError,
    stale: activeSessionStale,
  } = useScopedSessions(workspaceCwd, {
    autoLoad: true,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'active',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  // Live sessions from the daemon's other workspaces, so the picker can offer —
  // and a pane can attach to — sessions that aren't in the primary workspace.
  // Empty (a no-op) on a single-workspace daemon.
  const {
    sessions: otherSessions,
    loading: otherSessionsLoading,
    // The workspaces the fan-out actually queries. A pane whose workspace is
    // not among them is outside the catalog's coverage — its absence from the
    // merged list proves nothing.
    queriedCwds: otherQueriedCwds,
    // The queried workspaces where absence can't be proven right now (errored,
    // never landed, or an incomplete page): a pane whose workspace is here
    // must not be pruned on catalog absence.
    notReadyCwds: otherNotReadyCwds,
    reload: reloadOther,
  } = useOtherWorkspaceSessions(includeOtherWorkspaces && !workspaceCwd);
  const allSessions = useMemo(
    () => mergeSessionsById(sessions, otherSessions),
    [sessions, otherSessions],
  );
  const knownSessionIds = useMemo(
    () => new Set(allSessions.map((session) => session.sessionId)),
    [allSessions],
  );
  const knownSessionIdsRef = useRef(knownSessionIds);
  knownSessionIdsRef.current = knownSessionIds;
  // The workspaces where the catalog can *prove* a session is gone: the
  // primary workspace when its page landed fresh and complete, plus each
  // fan-out workspace whose page is ready. Everything else — a workspace the
  // daemon no longer advertises, a page that never landed, or one that landed
  // incomplete — is not proof of anything, so a pane living there is a
  // candidate for the probe, never for direct pruning.
  const provenCwds = useMemo(() => {
    const set = new Set<string>();
    const primaryCwd = workspaceCwd ?? workspace.workspaceCwd;
    const primaryReady =
      activeSessionPage !== undefined &&
      activeSessionError === undefined &&
      !activeSessionStale &&
      !activeSessionTruncated &&
      activeSessionNextCursor === undefined &&
      !activeSessionLiveMergeFailed;
    if (primaryCwd !== undefined && primaryReady) set.add(primaryCwd);
    for (const cwd of otherQueriedCwds) {
      if (!otherNotReadyCwds.includes(cwd)) set.add(cwd);
    }
    return set;
  }, [
    workspaceCwd,
    workspace.workspaceCwd,
    activeSessionPage,
    activeSessionError,
    activeSessionStale,
    activeSessionTruncated,
    activeSessionNextCursor,
    activeSessionLiveMergeFailed,
    otherQueriedCwds,
    otherNotReadyCwds,
  ]);
  // Sessions a pane's own provider has already answered terminal: parked on
  // the daemon's 409 session_archived. Authoritative per pane, so it prunes
  // whether or not the catalog page is complete.
  const [terminalArchivedIds, setTerminalArchivedIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const reportTerminalArchived = useCallback(
    (sessionId: string, archived: boolean) => {
      setTerminalArchivedIds((current) => {
        if (current.has(sessionId) === archived) return current;
        const next = new Set(current);
        if (archived) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    },
    [],
  );
  const multiWorkspace =
    !workspaceCwd &&
    includeOtherWorkspaces &&
    hasMultipleWorkspaces(connection.capabilities);
  const scopePanesByWorkspace = Boolean(workspaceCwd) || multiWorkspace;
  const sessionIdsControlled = sessionIds !== undefined;
  const normalizedSessionIds = useMemo(
    () =>
      Array.from(new Set((sessionIds ?? []).filter(Boolean))).slice(
        0,
        MAX_PANES,
      ),
    [sessionIds],
  );

  const [statePaneIds, setStatePaneIds] = useState<string[]>(() => {
    if (normalizedSessionIds.length > 0) return normalizedSessionIds;
    return currentSessionId ? [currentSessionId] : [];
  });
  // In controlled mode the prop is the authoritative pane set. Deriving from
  // it directly (a state mirror synced by an effect could lag a commit) keeps
  // the derived state and the async prune continuation on the same set.
  const paneIds = sessionIdsControlled ? normalizedSessionIds : statePaneIds;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activePaneId, setActivePaneId] = useState(paneIds[0]);
  const [pendingPaneIds, setPendingPaneIds] = useState<Set<string>>(new Set());
  const [paneFocusId, setPaneFocusId] = useState<string | null>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const previousPaneIdsRef = useRef(paneIds);
  const activeId = paneIds.includes(activePaneId ?? '')
    ? activePaneId
    : paneIds[
        Math.min(
          Math.max(previousPaneIdsRef.current.indexOf(activePaneId ?? ''), 0),
          paneIds.length - 1,
        )
      ];
  useLayoutEffect(() => {
    if (previousPaneIdsRef.current === paneIds) return;
    previousPaneIdsRef.current = paneIds;
    if (activeId === activePaneId) return;
    setActivePaneId(activeId);
    if (document.activeElement === document.body) {
      setPaneFocusId(activeId ?? null);
    }
  }, [paneIds, activeId, activePaneId]);
  // Keep report identity stable across parent renders: consumers may store it
  // in state, which would otherwise retrigger the reporting effect below.
  const pendingIds = useMemo(
    () => paneIds.filter((id) => pendingPaneIds.has(id)),
    [paneIds, pendingPaneIds],
  );
  useEffect(() => {
    onPendingPanesChange?.(pendingIds);
  }, [pendingIds, onPendingPanesChange]);
  useEffect(() => () => onPendingPanesChange?.([]), [onPendingPanesChange]);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const pendingButtonRef = useRef<HTMLButtonElement | null>(null);
  const setPendingButtonRef = useCallback(
    (button: HTMLButtonElement | null) => {
      if (!button && pendingButtonRef.current === document.activeElement) {
        backButtonRef.current?.focus();
      }
      pendingButtonRef.current = button;
    },
    [],
  );
  const handleApprovalChange = useCallback(
    (sessionId: string, pending: boolean) => {
      setPendingPaneIds((current) => {
        if (current.has(sessionId) === pending) return current;
        const next = new Set(current);
        if (pending) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    },
    [],
  );
  // Which pane, if any, is maximized to fill the whole split. Purely visual and
  // ephemeral (not deep-linked via `?split=`, like the dialog fullscreen toggle
  // it mirrors): the other panes stay mounted and streaming, just hidden.
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const addWrapRef = useRef<HTMLDivElement | null>(null);
  // A per-tab/per-mount nonce: two browser tabs opening the same split must not
  // register the same daemon client id, or suppressOwnUserEcho would treat one
  // tab's prompt as the other's own echo and drop it from the transcript.
  const [instanceId] = useState(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2),
  );

  const paneIdsRef = useRef(paneIds);
  paneIdsRef.current = paneIds;
  // Probe verdicts per session id, recorded for the lifetime of the pane set.
  // Only definitive outcomes are recorded: a successful probe of a live
  // standalone session, a not-found or archived answer (nothing a pane can
  // load), and a non-retryable conflict 409 (the daemon knows the id but
  // refuses to serve it standalone — keep the pane and stop re-probing). A
  // transient failure, including a retryable conflict, records nothing, so
  // the next round re-probes. A pane's own terminal answer is checked before
  // this cache, so a cached verdict never outvotes it. Without the cache,
  // every catalog commit (the 5s live-state poll, every invalidation) would
  // re-ask the daemon a question whose answer cannot change.
  const probeVerdictsRef = useRef(
    new Map<string, 'alive' | 'absent' | 'conflict'>(),
  );
  // One in-flight probe per id: a catalog commit landing mid-probe joins the
  // running request instead of firing a duplicate.
  const probeInFlightRef = useRef(new Map<string, Promise<void>>());

  // Dismiss the "add session" picker on Escape or a click outside it.
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!addWrapRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  // Refresh the list the moment the picker opens so it includes sessions
  // created since the split was first entered.
  useEffect(() => {
    if (pickerOpen) {
      void reload().catch(() => undefined);
      void reloadOther().catch(() => undefined);
    }
  }, [pickerOpen, reload, reloadOther]);

  // Last-seen summary per session id (refreshed on every render). A pane the
  // prune guard keeps can temporarily leave the merged catalog — e.g. its
  // workspace flips untrusted and the fan-out stops querying it, dropping its
  // snapshot — and its entries must stay resolvable or the pane renders with
  // an empty title and remounts under the primary workspace. Kept as the full
  // summary so the pane's session-details target survives too.
  const lastKnownById = useRef(new Map<string, DaemonSessionSummary>());
  for (const session of allSessions) {
    lastKnownById.current.set(session.sessionId, session);
  }

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of allSessions) {
      map.set(
        session.sessionId,
        session.displayName?.trim() || session.sessionId.slice(0, 8),
      );
    }
    for (const id of paneIds) {
      if (!map.has(id)) {
        const known = lastKnownById.current.get(id);
        if (known) {
          map.set(id, known.displayName?.trim() || known.sessionId.slice(0, 8));
        }
      }
    }
    return map;
  }, [allSessions, paneIds]);

  const sessionById = useMemo(() => {
    const map = new Map(
      allSessions.map((session) => [session.sessionId, session]),
    );
    for (const id of paneIds) {
      if (!map.has(id)) {
        const known = lastKnownById.current.get(id);
        if (known) map.set(id, known);
      }
    }
    return map;
  }, [allSessions, paneIds]);

  // The workspace each session lives in, so a pane attaches under its owning
  // workspace (a non-primary session 409s if loaded with the primary cwd). The
  // seed pane is the current session, whose workspace the connection already
  // knows before the lists finish loading — cover it so it attaches correctly
  // on first paint.
  const workspaceCwdById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of allSessions) {
      map.set(session.sessionId, session.workspaceCwd);
    }
    for (const id of paneIds) {
      if (!map.has(id)) {
        const known = lastKnownById.current.get(id);
        if (known) map.set(id, known.workspaceCwd);
      }
    }
    if (seedSessionId && connection.workspaceCwd && !map.has(seedSessionId)) {
      map.set(seedSessionId, connection.workspaceCwd);
    }
    return map;
  }, [allSessions, seedSessionId, connection.workspaceCwd, paneIds]);

  const addPane = useCallback(
    (sessionId: string) => {
      const currentPaneIds = paneIdsRef.current;
      if (
        currentPaneIds.includes(sessionId) ||
        currentPaneIds.length >= MAX_PANES
      ) {
        setPickerOpen(false);
        return;
      }
      const next = [...currentPaneIds, sessionId];
      // Reveal the freshly added pane rather than leaving it hidden behind a
      // still-maximized one.
      setMaximizedPaneId(null);
      setActivePaneId(sessionId);
      if (sessionIdsControlled) {
        onPanesChange?.(next);
      } else {
        setStatePaneIds(next);
      }
      setPickerOpen(false);
    },
    [onPanesChange, sessionIdsControlled],
  );

  // Closing the last pane is a natural "I'm done" gesture — return to the
  // overview instead of stranding the user on an empty split. Guarded so an
  // initial empty seed (no current session) doesn't bounce straight back out.
  const hadPanesRef = useRef(false);
  useEffect(() => {
    if (paneIds.length > 0) {
      hadPanesRef.current = true;
    } else if (hadPanesRef.current) {
      onExit();
    }
  }, [paneIds, onExit]);

  // Mirror the live pane set up to the parent so it outlives this component
  // unmounting when the user switches views. On re-entry the parent reseeds
  // `sessionIds` from it, restoring the exact panes instead of clearing.
  useEffect(() => {
    if (!sessionIdsControlled) onPanesChange?.(paneIds);
  }, [paneIds, onPanesChange, sessionIdsControlled]);

  const removePane = useCallback(
    (sessionId: string) => {
      const currentPaneIds = paneIdsRef.current;
      if (!currentPaneIds.includes(sessionId)) return;
      const next = currentPaneIds.filter((id) => id !== sessionId);
      if (sessionIdsControlled) {
        onPanesChange?.(next);
      } else {
        setStatePaneIds(next);
      }
    },
    [onPanesChange, sessionIdsControlled],
  );

  // Reconcile the live pane set with the settled active catalog: a pane whose
  // session has left it (archived or deleted) has nothing left to load — the
  // provider parks on a terminal error with an empty transcript, and the
  // parent re-seeds the stale id from the persisted pane set on every entry
  // into the split view.
  //
  // Pruning is only safe when the catalog can *prove* a session is gone. An
  // absence from a bounded page (the daemon clamps the page size, so a busy
  // workspace can have more sessions than were fetched), a merge that failed
  // partway, an errored or stale-retained page, or a fan-out workspace whose
  // page never landed is not proof of removal — a session may simply be
  // missing from what we saw. A pane whose workspace the daemon no longer
  // advertises is outside the catalog's coverage entirely: it is a candidate
  // for the standalone probe, never for direct pruning. The seed pane (the
  // current session) is never pruned. Standalone panes (deep-linked) never
  // appear in a workspace list: probe them and keep them on any non-not-found
  // outcome — a transient probe failure must not close a live pane. A pane
  // whose own provider parked on the terminal `session_archived` answer is
  // pruned on that answer alone, whatever the page state.
  useEffect(() => {
    if (activeSessionPage === undefined || otherSessionsLoading) return;
    const terminalIds = paneIds.filter(
      (id) => id !== seedSessionId && terminalArchivedIds.has(id),
    );
    const listInferenceOff =
      activeSessionTruncated ||
      activeSessionNextCursor !== undefined ||
      activeSessionLiveMergeFailed ||
      activeSessionError !== undefined ||
      activeSessionStale;
    const staleIds = listInferenceOff
      ? []
      : paneIds.filter((id) => {
          if (id === seedSessionId || terminalArchivedIds.has(id)) {
            return false;
          }
          if (knownSessionIds.has(id)) return false;
          const cwd = workspaceCwdById.get(id);
          // A pane of unknown workspace (cold mount, deep link) is settled
          // only while every fan-out workspace can prove absence: the probe's
          // not-found means "not a standalone session", which a live
          // workspace session answers too.
          if (cwd === undefined) return otherNotReadyCwds.length === 0;
          return provenCwds.has(cwd);
        });
    if (staleIds.length === 0) {
      if (terminalIds.length === 0) return;
      const next = paneIds.filter((id) => !terminalIds.includes(id));
      if (sessionIdsControlled) onPanesChange?.(next);
      else setStatePaneIds(next);
      return;
    }
    let cancelled = false;
    const standaloneSessionsEnabled =
      connection.capabilities?.features?.includes(
        STANDALONE_SESSIONS_CAPABILITY,
      ) === true;
    void (async () => {
      const toPrune: string[] = [];
      await Promise.all(
        staleIds.map(async (id) => {
          const verdict = probeVerdictsRef.current.get(id);
          if (verdict === 'alive' || verdict === 'conflict') {
            return; // a kept pane — stop re-probing
          }
          if (verdict === 'absent') {
            toPrune.push(id);
            return;
          }
          if (!standaloneSessionsEnabled) {
            toPrune.push(id);
            return;
          }
          const inFlight = probeInFlightRef.current.get(id);
          if (inFlight) {
            await inFlight;
          } else {
            const probe = (async () => {
              try {
                const lookup = await workspace.client.getStandaloneSession(id);
                // An archived standalone session still answers 200 with its
                // summary: readable, but nothing a pane can load.
                probeVerdictsRef.current.set(
                  id,
                  'isArchived' in lookup && lookup.isArchived === true
                    ? 'absent'
                    : 'alive',
                );
              } catch (error) {
                if (
                  isStandaloneSessionNotFoundError(error) ||
                  isSessionArchivedHttpError(error)
                ) {
                  probeVerdictsRef.current.set(id, 'absent');
                } else if (isStandaloneSessionConflictError(error)) {
                  probeVerdictsRef.current.set(id, 'conflict');
                }
                // transient: records nothing, next round re-probes
              } finally {
                probeInFlightRef.current.delete(id);
              }
            })();
            probeInFlightRef.current.set(id, probe);
            await probe;
          }
          const settled = probeVerdictsRef.current.get(id);
          if (settled === 'absent') toPrune.push(id);
        }),
      );
      if (cancelled) return;
      // The probes may have taken a moment: re-check against the freshest
      // pane set and catalog before removing, so a re-unarchived session
      // survives the round trip. paneIdsRef tracks the prop-derived set in
      // controlled mode too, so a stale mirror can't resurrect a pane the
      // parent just closed.
      const currentPaneIds = paneIdsRef.current;
      const next = currentPaneIds.filter(
        (id) =>
          !terminalIds.includes(id) &&
          (!toPrune.includes(id) || knownSessionIdsRef.current.has(id)),
      );
      if (next.length === currentPaneIds.length) return;
      if (sessionIdsControlled) onPanesChange?.(next);
      else setStatePaneIds(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeSessionPage,
    activeSessionTruncated,
    activeSessionNextCursor,
    activeSessionLiveMergeFailed,
    activeSessionError,
    activeSessionStale,
    otherSessionsLoading,
    provenCwds,
    paneIds,
    knownSessionIds,
    workspaceCwdById,
    seedSessionId,
    terminalArchivedIds,
    otherNotReadyCwds,
    connection.capabilities,
    workspace.client,
    sessionIdsControlled,
    onPanesChange,
  ]);

  const toggleMaximize = useCallback((sessionId: string) => {
    setActivePaneId(sessionId);
    setMaximizedPaneId((current) => (current === sessionId ? null : sessionId));
  }, []);

  const goToPendingPane = () => {
    const activeIndex = paneIds.indexOf(activeId ?? '');
    const nextId =
      pendingIds.find((id) => paneIds.indexOf(id) > activeIndex) ??
      pendingIds[0];
    if (!nextId) return;
    setActivePaneId(nextId);
    if (maximizedPaneId) setMaximizedPaneId(nextId);
    setPaneFocusId(nextId);
  };

  useLayoutEffect(() => {
    if (!paneFocusId) return;
    const pane = Array.from(panesRef.current?.children ?? []).find(
      (element) => element.getAttribute('data-pane-session-id') === paneFocusId,
    );
    pane?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Approval panels submit on Escape, Enter, and digits. Navigation must
    // stop outside those keyboard scopes until the user deliberately enters.
    if (pane instanceof HTMLElement) pane.focus({ preventScroll: true });
    setPaneFocusId(null);
  }, [paneFocusId]);

  // Maximize only makes sense against another pane, so drop it whenever it no
  // longer can hold: the maximized pane left the set (closed here, or removed by
  // a controlled-mode sync), or the split shrank to a lone pane. Without the
  // length guard a surviving maximized pane would keep a stale `maximizedPaneId`
  // that silently re-hides the next pane a controlled parent adds back.
  useEffect(() => {
    if (
      maximizedPaneId &&
      (paneIds.length < 2 || !paneIds.includes(maximizedPaneId))
    ) {
      setMaximizedPaneId(null);
    }
  }, [paneIds, maximizedPaneId]);

  // Escape restores the tiled layout, but only when the key is otherwise unused:
  // defer to an open picker (its own Escape closes it first), and never steal
  // Escape from the composer — it cancels the in-flight turn / closes its menus —
  // or from an open dialog. `isEditableTarget` covers `.cm-editor` and dialog
  // keyboard scopes, so a maximized pane's composer keeps its Escape.
  useEffect(() => {
    if (!maximizedPaneId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (pickerOpen || isEditableTarget(event.target)) return;
      setMaximizedPaneId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [maximizedPaneId, pickerOpen]);

  const available = useMemo(
    () => allSessions.filter((session) => !paneIds.includes(session.sessionId)),
    [allSessions, paneIds],
  );
  // The cached catalog may lag behind sessions created elsewhere, so the button
  // must stay clickable whenever another pane fits. The picker reloads on open
  // and reports an empty list itself.
  const canAdd = paneIds.length < MAX_PANES;
  // Only offer per-pane maximize once there's another pane to maximize against —
  // a lone pane already fills the split.
  const canMaximize = paneIds.length > 1;

  return (
    <div className={styles.split} data-testid="split-view">
      <header className={styles.toolbar}>
        <button
          type="button"
          className={styles.backButton}
          ref={backButtonRef}
          onClick={onExit}
          aria-label={t('common.back')}
          title={t('common.back')}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M15 18l-6-6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className={styles.title}>{t('splitView.title')}</span>
        <span className={styles.count}>
          {t('splitView.count', { count: paneIds.length })}
        </span>
        <span className="sr-only" role="status">
          {pendingIds.length > 0
            ? t('splitView.pendingCount', { count: pendingIds.length })
            : ''}
        </span>
        {pendingIds.length > 0 && (
          <button
            type="button"
            className={styles.pendingButton}
            onClick={goToPendingPane}
            ref={setPendingButtonRef}
            title={t('splitView.nextPending')}
            aria-label={`${t('splitView.pendingCount', {
              count: pendingIds.length,
            })} — ${t('splitView.nextPending')}`}
          >
            {t('splitView.pendingCount', { count: pendingIds.length })}
          </button>
        )}
        <div className={styles.addWrap} ref={addWrapRef}>
          <button
            type="button"
            className={styles.addButton}
            disabled={!canAdd}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            + {t('splitView.addPane')}
          </button>
          {pickerOpen && (
            <ul className={styles.picker} role="listbox">
              {available.length === 0 && (
                <li className={styles.pickerEmpty} role="presentation">
                  {t('splitView.noOtherSessions')}
                </li>
              )}
              {available.map((session) => (
                <li key={session.sessionId} role="option" aria-selected="false">
                  <button
                    type="button"
                    className={styles.pickerItem}
                    onClick={() => addPane(session.sessionId)}
                  >
                    <span className={styles.pickerItemLabel}>
                      {titleById.get(session.sessionId) ??
                        session.sessionId.slice(0, 8)}
                    </span>
                    {multiWorkspace && (
                      <span
                        className={styles.pickerItemWorkspace}
                        title={session.workspaceCwd}
                      >
                        {workspaceLabelForCwd(
                          session.workspaceCwd,
                          connection.capabilities?.workspaces,
                        )}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      <div className={styles.panes} ref={panesRef}>
        {paneIds.length === 0 ? (
          <div className={styles.empty}>{t('splitView.empty')}</div>
        ) : (
          paneIds.map((sessionId) => {
            const paneWorkspaceCwd = workspaceCwdById.get(sessionId);
            const isMaximized = maximizedPaneId === sessionId;
            // When one pane is maximized, the rest stay mounted (their sessions
            // keep streaming) but are hidden via CSS — a purely visual solo.
            const isHidden = maximizedPaneId !== null && !isMaximized;
            return (
              <div
                className={styles.paneSlot}
                data-pane-session-id={sessionId}
                data-pane-hidden={isHidden ? '' : undefined}
                role="group"
                aria-label={titleById.get(sessionId) ?? sessionId.slice(0, 8)}
                tabIndex={-1}
                onPointerDownCapture={(event) => {
                  if (event.currentTarget.contains(event.target as Node)) {
                    setActivePaneId(sessionId);
                  }
                }}
                onFocusCapture={(event) => {
                  if (event.currentTarget.contains(event.target as Node)) {
                    setActivePaneId(sessionId);
                  }
                }}
                // Include the resolved workspace in the key on a multi-workspace
                // daemon so a pane whose workspace resolves only after mount (e.g.
                // a `?split=` deep link) remounts under the right workspace rather
                // than staying attached with the primary cwd.
                key={
                  scopePanesByWorkspace
                    ? `${sessionId}:${paneWorkspaceCwd ?? ''}`
                    : sessionId
                }
              >
                {/* Contain a render crash to its own pane — a malformed block in
                  one session must not white-screen the whole split. */}
                <ErrorBoundary
                  label={`split-pane:${sessionId}`}
                  resetKeys={[sessionId]}
                  fallback={(error) => (
                    <div className={styles.paneError} role="alert">
                      <div className={styles.paneErrorTitle}>
                        {titleById.get(sessionId) ?? sessionId.slice(0, 8)}
                      </div>
                      <div className={styles.paneErrorMessage}>
                        {t('splitView.paneError')}: {error.message}
                      </div>
                      <button
                        type="button"
                        className={styles.paneErrorClose}
                        onClick={() => removePane(sessionId)}
                      >
                        {t('splitView.closePane')}
                      </button>
                    </div>
                  )}
                >
                  <DaemonSessionProvider
                    sessionId={sessionId}
                    // Attach the pane under its session's own workspace. Only on
                    // a multi-workspace daemon — passing it on a single-workspace
                    // daemon would flip a deep-linked pane's prop from undefined
                    // to the primary cwd once the list resolves, needlessly
                    // re-attaching it. Undefined falls back to the provider's
                    // primary cwd, i.e. today's behavior.
                    workspaceCwd={
                      scopePanesByWorkspace
                        ? (paneWorkspaceCwd ?? workspaceCwd)
                        : undefined
                    }
                    // Distinct from the main view's client (and from any other
                    // tab's panes) for the same session, so the attachments don't
                    // collide on one client identity.
                    clientId={`split-pane:${instanceId}:${sessionId}`}
                    historyPageSize={historyPageSize}
                    subagentTranscriptMode="summary"
                    maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
                    suppressOwnUserEcho
                    restartEventStreamOnPrompt={restartSseOnPrompt}
                  >
                    <TerminalArchivedReporter
                      sessionId={sessionId}
                      onReport={reportTerminalArchived}
                    />
                    {onAssistantTurnSettled ? (
                      <AssistantTurnSettlementObserver
                        onAssistantTurnSettled={onAssistantTurnSettled}
                      />
                    ) : null}
                    <ChatPane
                      showResponseTokensPerSecond={showResponseTokensPerSecond}
                      title={titleById.get(sessionId)}
                      sessionSummary={
                        showSessionDetails
                          ? sessionById.get(sessionId)
                          : undefined
                      }
                      isActive={activeId === sessionId}
                      onApprovalChange={handleApprovalChange}
                      workspaceCwd={paneWorkspaceCwd}
                      reportCatalogTurnCompletion={
                        sessionId !== currentSessionId ||
                        paneWorkspaceCwd !== connection.workspaceCwd
                      }
                      renderHeaderActions={renderPaneHeaderActions}
                      hidden={isHidden}
                      voiceUserRevision={voiceUserRevision}
                      voiceWorkspaceRevisions={voiceWorkspaceRevisions}
                      voiceWorkspaces={voiceWorkspaces}
                      onClose={() => removePane(sessionId)}
                      onToggleMaximize={
                        canMaximize
                          ? () => toggleMaximize(sessionId)
                          : undefined
                      }
                      isMaximized={isMaximized}
                      onError={onError}
                      onImageIngestionNotice={onImageIngestionNotice}
                      onSlashCommand={onSlashCommand}
                      modelManagement={modelManagement}
                      unavailableModels={unavailableModels}
                      mountUnavailableModelTooltip={
                        mountUnavailableModelTooltip
                      }
                      onOpenGoals={onOpenGoals}
                      onRightPanelOpen={onRightPanelOpen}
                      onOpenMonitor={onOpenMonitor}
                      onPaneArtifactsChange={onPaneArtifactsChange}
                      registerContextUsageControls={
                        registerContextUsageControls
                      }
                      onBeforeContextCompress={onBeforeContextCompress}
                      onOpenContextUsage={onOpenContextUsage}
                      messageTurnOutputs={messageTurnOutputs}
                      sessionWorkflowEnabled={sessionWorkflowEnabled}
                      planControlVisible={planControlVisible}
                    />
                  </DaemonSessionProvider>
                </ErrorBoundary>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
