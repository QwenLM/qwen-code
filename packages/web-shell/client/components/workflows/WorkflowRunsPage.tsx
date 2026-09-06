import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonSessionSavedWorkflowDetail,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionWorkflowTasksStatus,
} from '@qwen-code/sdk/daemon';
import {
  useActions,
  useConnection,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  ChevronRightIcon,
  CirclePlayIcon,
  FileCode2Icon,
  HistoryIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
import { formatTimestamp } from '../MessageTimestamp';
import { Markdown } from '../messages/Markdown';
import { TasksStatusMessage } from '../messages/TasksStatusMessage';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import styles from './WorkflowRunsPage.module.css';

type WorkflowTab = 'saved' | 'active' | 'history';
type SavedWorkflow = NonNullable<
  DaemonSessionSupportedCommandsStatus['savedWorkflows']
>[number];

interface WorkflowRunsPageProps {
  onCreateViaChat: () => void;
  onWorkflowRunStarted?: () => void;
}

const RECENT_RUNS_LIMIT = 3;

type SavedWorkflowDetailState =
  | { status: 'loading' }
  | { status: 'loaded'; detail: DaemonSessionSavedWorkflowDetail }
  | { status: 'unavailable' }
  | { status: 'failed' };

function isActiveStatus(
  status: DaemonSessionTaskWithWorkflowStatus['status'],
): boolean {
  return status === 'running' || status === 'pausing' || status === 'paused';
}

export function WorkflowRunsPage({
  onCreateViaChat,
  onWorkflowRunStarted,
}: WorkflowRunsPageProps) {
  const { t } = useI18n();
  const actions = useActions();
  const connection = useConnection();
  const [tab, setTab] = useState<WorkflowTab>('saved');
  const [snapshot, setSnapshot] =
    useState<DaemonSessionWorkflowTasksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [startingName, setStartingName] = useState<string | null>(null);
  const [startError, setStartError] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] =
    useState<SavedWorkflow | null>(null);
  const [detailState, setDetailState] =
    useState<SavedWorkflowDetailState | null>(null);
  const [showSource, setShowSource] = useState(false);
  const activeSessionIdRef = useRef(connection.sessionId);
  const reloadGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  activeSessionIdRef.current = connection.sessionId;

  const reload = useCallback(async () => {
    const sessionId = connection.sessionId;
    const generation = ++reloadGenerationRef.current;
    if (!sessionId) {
      setSnapshot(null);
      setLoadError(false);
      setLoading(false);
      return;
    }
    setSnapshot((current) =>
      current?.sessionId === sessionId ? current : null,
    );
    setLoading(true);
    try {
      // Only the task fetch gates the page. A supported-commands refresh
      // is auxiliary — in the same Promise.all its rejection discarded an
      // already-fetched snapshot and hid all three tabs behind the load
      // banner, and a persistently failing refresh made the page unusable
      // while task status worked fine. The user still hears about it:
      // refreshCommands dispatches its own notice before throwing.
      void actions.refreshCommands().catch(() => {});
      const nextSnapshot = await actions.getWorkflowTasks();
      if (
        reloadGenerationRef.current !== generation ||
        activeSessionIdRef.current !== sessionId ||
        nextSnapshot.sessionId !== sessionId
      ) {
        return;
      }
      setSnapshot(nextSnapshot);
      setLoadError(false);
    } catch (error: unknown) {
      if (
        reloadGenerationRef.current !== generation ||
        activeSessionIdRef.current !== sessionId
      ) {
        return;
      }
      console.warn('[web-shell] failed to load workflow runs:', error);
      setLoadError(true);
    } finally {
      if (
        reloadGenerationRef.current === generation &&
        activeSessionIdRef.current === sessionId
      ) {
        setLoading(false);
      }
    }
  }, [actions, connection.sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setStartingName(null);
    setStartError(false);
    setSelectedWorkflow(null);
    setDetailState(null);
    setShowSource(false);
    // Session A's failure banner must not render over session B: reload
    // clears this only on success, so without the reset a hanging load on
    // B leaves A's 'failed' banner up for a session that never failed.
    setLoadError(false);
  }, [connection.sessionId]);

  const counts = useMemo(() => {
    let active = 0;
    let history = 0;
    for (const task of snapshot?.tasks ?? []) {
      if (task.kind !== 'workflow') continue;
      if (isActiveStatus(task.status)) active += 1;
      else history += 1;
    }
    return { active, history };
  }, [snapshot]);

  const savedWorkflows = useMemo(
    () => connection.supportedCommands?.savedWorkflows ?? [],
    [connection.supportedCommands?.savedWorkflows],
  );

  // A definition that disappears from the list (deleted file, scope change)
  // takes its expanded detail with it rather than showing stale content.
  useEffect(() => {
    if (
      selectedWorkflow !== null &&
      !savedWorkflows.some(
        (workflow) =>
          workflow.name === selectedWorkflow.name &&
          workflow.source === selectedWorkflow.source,
      )
    ) {
      detailGenerationRef.current += 1;
      setSelectedWorkflow(null);
      setDetailState(null);
      setShowSource(false);
    }
  }, [savedWorkflows, selectedWorkflow]);

  const loadDetail = useCallback(
    async (name: string) => {
      const sessionId = activeSessionIdRef.current;
      const generation = ++detailGenerationRef.current;
      setDetailState({ status: 'loading' });
      try {
        const detail = await actions.readSavedWorkflow(name);
        if (
          detailGenerationRef.current !== generation ||
          activeSessionIdRef.current !== sessionId
        ) {
          return;
        }
        setDetailState(
          detail ? { status: 'loaded', detail } : { status: 'unavailable' },
        );
      } catch (error: unknown) {
        if (
          detailGenerationRef.current !== generation ||
          activeSessionIdRef.current !== sessionId
        ) {
          return;
        }
        console.warn('[web-shell] failed to read saved workflow:', error);
        setDetailState({ status: 'failed' });
      }
    },
    [actions],
  );

  const toggleDetail = useCallback(
    (workflow: SavedWorkflow) => {
      if (
        selectedWorkflow?.name === workflow.name &&
        selectedWorkflow.source === workflow.source
      ) {
        detailGenerationRef.current += 1;
        setSelectedWorkflow(null);
        setDetailState(null);
        setShowSource(false);
        return;
      }
      setSelectedWorkflow(workflow);
      setShowSource(false);
      void loadDetail(workflow.name);
    },
    [loadDetail, selectedWorkflow],
  );

  const recentRunsByName = useMemo(() => {
    const byName = new Map<string, DaemonSessionTaskWithWorkflowStatus[]>();
    for (const task of snapshot?.tasks ?? []) {
      if (task.kind !== 'workflow') continue;
      if (!task.workflowName) continue;
      const runs = byName.get(task.workflowName) ?? [];
      runs.push(task);
      byName.set(task.workflowName, runs);
    }
    for (const runs of byName.values()) {
      runs.sort((a, b) => b.startTime - a.startTime);
    }
    return byName;
  }, [snapshot]);

  const handleTasksChange = useCallback(
    (nextSnapshot: DaemonSessionWorkflowTasksStatus) => {
      if (nextSnapshot.sessionId !== activeSessionIdRef.current) return;
      setSnapshot(nextSnapshot);
    },
    [],
  );

  const handleWorkflowRunStarted = useCallback(() => {
    setTab('active');
    onWorkflowRunStarted?.();
  }, [onWorkflowRunStarted]);

  const runSavedWorkflow = useCallback(
    async (workflow: SavedWorkflow) => {
      const sessionId = activeSessionIdRef.current;
      setStartingName(workflow.name);
      setStartError(false);
      try {
        const result = await actions.runSavedWorkflow(workflow.name);
        if (activeSessionIdRef.current !== sessionId) return;
        if (!result.started) {
          setStartError(true);
          return;
        }
        handleWorkflowRunStarted();
        await reload();
      } catch {
        if (activeSessionIdRef.current === sessionId) setStartError(true);
      } finally {
        if (activeSessionIdRef.current === sessionId) setStartingName(null);
      }
    },
    [actions, handleWorkflowRunStarted, reload],
  );

  return (
    <div className={styles.root}>
      <Tabs
        className={styles.tabs}
        value={tab}
        onValueChange={(value) => setTab(value as WorkflowTab)}
      >
        <div className={styles.toolbar}>
          <TabsList variant="line">
            <TabsTrigger value="saved">
              <FileCode2Icon data-icon="inline-start" />
              {t('workflowRuns.saved')}
              <Badge variant="secondary">{savedWorkflows.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="active">
              <CirclePlayIcon data-icon="inline-start" />
              {t('workflowRuns.active')}
              <Badge variant="secondary">{counts.active}</Badge>
            </TabsTrigger>
            <TabsTrigger value="history">
              <HistoryIcon data-icon="inline-start" />
              {t('workflowRuns.history')}
              <Badge variant="secondary">{counts.history}</Badge>
            </TabsTrigger>
          </TabsList>
          <div className={styles.toolbarActions}>
            <Button type="button" size="sm" onClick={onCreateViaChat}>
              <PlusIcon data-icon="inline-start" />
              {t('workflowRuns.create')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => void reload()}
              disabled={loading || !connection.sessionId}
              aria-label={t('workflowRuns.refresh')}
              title={t('workflowRuns.refresh')}
            >
              <RefreshCwIcon />
            </Button>
          </div>
        </div>

        {loadError && (
          <div className={styles.error} role="alert">
            {t('workflowRuns.loadFailed')}
          </div>
        )}

        {!connection.sessionId ? (
          <div className={styles.emptyState}>{t('workflowRuns.noSession')}</div>
        ) : loading && !snapshot ? (
          <div className={styles.loading}>{t('workflowRuns.loading')}</div>
        ) : (
          snapshot && (
            <>
              <TabsContent value="saved" className={styles.content}>
                {startError && (
                  <div className={styles.error} role="alert">
                    {t('workflowRuns.startFailed')}
                  </div>
                )}
                {savedWorkflows.length === 0 ? (
                  <div className={styles.savedEmpty}>
                    <FileCode2Icon aria-hidden="true" />
                    <div>
                      <div className={styles.savedEmptyTitle}>
                        {t('workflowRuns.emptySaved')}
                      </div>
                      <div className={styles.savedEmptyDescription}>
                        {t('workflowRuns.emptySavedHint')}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className={styles.savedList}>
                    {savedWorkflows.map((workflow) => {
                      const expanded =
                        selectedWorkflow?.name === workflow.name &&
                        selectedWorkflow.source === workflow.source;
                      const detailId = `workflow-saved-detail-${workflow.source}-${workflow.name}`;
                      return (
                        <div
                          key={`${workflow.source}:${workflow.name}`}
                          className={styles.savedEntry}
                          data-scope={workflow.source}
                          data-expanded={expanded || undefined}
                        >
                          <div className={styles.savedCard}>
                            <button
                              type="button"
                              className={styles.savedIdentity}
                              aria-expanded={expanded}
                              aria-controls={expanded ? detailId : undefined}
                              aria-label={t('workflowRuns.detail.toggle', {
                                name: workflow.name,
                              })}
                              onClick={() => toggleDetail(workflow)}
                            >
                              <ChevronRightIcon
                                className={styles.savedChevron}
                                aria-hidden="true"
                              />
                              <span className={styles.savedIdentityText}>
                                <span className={styles.savedName}>
                                  /{workflow.name}
                                </span>
                                <span className={styles.savedDescription}>
                                  {workflow.source === 'project'
                                    ? t('workflowRuns.projectDescription')
                                    : t('workflowRuns.userDescription')}
                                </span>
                              </span>
                            </button>
                            <Badge variant="outline">
                              {workflow.source === 'project'
                                ? t('workflowRuns.project')
                                : t('workflowRuns.user')}
                            </Badge>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void runSavedWorkflow(workflow)}
                              disabled={startingName !== null}
                              aria-label={t('workflowRuns.runNamed', {
                                name: workflow.name,
                              })}
                            >
                              {startingName === workflow.name ? (
                                <RefreshCwIcon
                                  className={styles.startingIcon}
                                  data-icon="inline-start"
                                />
                              ) : (
                                <PlayIcon data-icon="inline-start" />
                              )}
                              {startingName === workflow.name
                                ? t('workflowRuns.starting')
                                : t('workflowRuns.run')}
                            </Button>
                          </div>
                          {expanded && (
                            <SavedWorkflowDetail
                              id={detailId}
                              name={workflow.name}
                              state={detailState}
                              recentRuns={
                                recentRunsByName.get(workflow.name) ?? []
                              }
                              showSource={showSource}
                              onToggleSource={() =>
                                setShowSource((visible) => !visible)
                              }
                              onRetry={() => void loadDetail(workflow.name)}
                              onViewHistory={() => setTab('history')}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
              {/* forceMount: the snapshot's only live update path is the
                  poller inside these panes, and Radix unmounts an inactive
                  pane — so on the default 'saved' tab the Active/History
                  badges and the saved cards' recent-runs list froze at
                  whatever the last reload saw. Radix keeps forced content
                  hidden while inactive, so only the poller stays alive. */}
              <TabsContent forceMount value="active" className={styles.content}>
                <TasksStatusMessage
                  message={{ snapshot }}
                  embedded
                  keyboardShortcuts={false}
                  manageActiveEvent={false}
                  syncSnapshot
                  taskView="workflow-active"
                  emptyLabel={t('workflowRuns.emptyActive')}
                  onTasksChange={handleTasksChange}
                  onWorkflowRunStarted={handleWorkflowRunStarted}
                />
              </TabsContent>
              <TabsContent
                forceMount
                value="history"
                className={styles.content}
              >
                <TasksStatusMessage
                  message={{ snapshot }}
                  embedded
                  keyboardShortcuts={false}
                  manageActiveEvent={false}
                  syncSnapshot
                  taskView="workflow-history"
                  emptyLabel={t('workflowRuns.emptyHistory')}
                  onTasksChange={handleTasksChange}
                  onWorkflowRunStarted={handleWorkflowRunStarted}
                />
              </TabsContent>
            </>
          )
        )}
      </Tabs>
    </div>
  );
}

function SavedWorkflowDetail({
  id,
  name,
  state,
  recentRuns,
  showSource,
  onToggleSource,
  onRetry,
  onViewHistory,
}: {
  id: string;
  name: string;
  state: SavedWorkflowDetailState | null;
  recentRuns: readonly DaemonSessionTaskWithWorkflowStatus[];
  showSource: boolean;
  onToggleSource: () => void;
  onRetry: () => void;
  onViewHistory: () => void;
}) {
  const { t } = useI18n();
  if (!state || state.status === 'loading') {
    return (
      <div id={id} className={styles.savedDetail} data-workflow-detail={name}>
        <div className={styles.detailMuted}>
          {t('workflowRuns.detail.loading')}
        </div>
      </div>
    );
  }
  if (state.status !== 'loaded') {
    return (
      <div id={id} className={styles.savedDetail} data-workflow-detail={name}>
        <div className={styles.detailMuted} role="status">
          {state.status === 'unavailable'
            ? t('workflowRuns.detail.unavailable')
            : t('workflowRuns.detail.loadFailed')}
        </div>
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          {t('workflowRuns.detail.retry')}
        </Button>
      </div>
    );
  }
  const { detail } = state;
  const meta = detail.meta;
  const phases = meta?.phases ?? [];
  return (
    <div id={id} className={styles.savedDetail} data-workflow-detail={name}>
      <p className={styles.detailDescription}>
        {meta?.description ?? t('workflowRuns.detail.noDescription')}
      </p>
      {meta?.whenToUse && (
        <section className={styles.detailSection}>
          <h4 className={styles.detailLabel}>
            {t('workflowRuns.detail.whenToUse')}
          </h4>
          <p className={styles.detailText}>{meta.whenToUse}</p>
        </section>
      )}
      {detail.metaError && (
        <div className={styles.detailWarning} role="status">
          {t('workflowRuns.detail.metaError', { error: detail.metaError })}
        </div>
      )}
      {phases.length > 0 && (
        <section className={styles.detailSection}>
          <h4 className={styles.detailLabel}>
            {t('workflowRuns.detail.phases', { count: phases.length })}
          </h4>
          <ol className={styles.detailPhases}>
            {phases.map((phase, index) => (
              <li key={`${index}:${phase.title}`}>
                <span className={styles.detailPhaseIndex}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className={styles.detailPhaseCopy}>
                  <strong>{phase.title}</strong>
                  {phase.detail && <span>{phase.detail}</span>}
                </span>
                {phase.model && (
                  <Badge variant="outline" className={styles.detailPhaseModel}>
                    {phase.model}
                  </Badge>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className={styles.detailSection}>
        <h4 className={styles.detailLabel}>
          {t('workflowRuns.detail.recentRuns')}
        </h4>
        {recentRuns.length === 0 ? (
          <p className={styles.detailMuted}>
            {t('workflowRuns.detail.noRuns')}
          </p>
        ) : (
          <ul className={styles.detailRuns}>
            {recentRuns.slice(0, RECENT_RUNS_LIMIT).map((run) => (
              <li key={run.id} data-status={run.status}>
                <span className={styles.detailRunStatus}>
                  {t(`tasks.${run.status}`)}
                </span>
                <span className={styles.detailRunTime}>
                  {formatTimestamp(run.startTime)}
                </span>
                <span className={styles.detailRunRuntime}>
                  {formatRuntime(run.runtimeMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {recentRuns.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={styles.detailLink}
            onClick={onViewHistory}
          >
            <HistoryIcon data-icon="inline-start" />
            {t('workflowRuns.detail.viewRuns', { count: recentRuns.length })}
          </Button>
        )}
      </section>
      <section className={styles.detailSection}>
        <div className={styles.detailSourceBar}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-expanded={showSource}
            onClick={onToggleSource}
          >
            <FileCode2Icon data-icon="inline-start" />
            {showSource
              ? t('workflowRuns.detail.hideSource')
              : t('workflowRuns.detail.showSource')}
          </Button>
          <code className={styles.detailPath} title={detail.scriptPath}>
            {detail.scriptPath}
          </code>
        </div>
        {showSource && (
          <div className={styles.detailSource} data-workflow-source>
            <Markdown content={fenceScript(detail.script)} />
          </div>
        )}
      </section>
    </div>
  );
}

/** Wrap the script in a JS fence, using a longer fence than any run of backticks inside it. */
function fenceScript(script: string): string {
  const longest = Math.max(
    2,
    ...Array.from(script.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}js\n${script.replace(/\n?$/, '\n')}${fence}`;
}
