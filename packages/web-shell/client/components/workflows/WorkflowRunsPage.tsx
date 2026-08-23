import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionWorkflowTasksStatus,
} from '@qwen-code/sdk/daemon';
import { useActions, useConnection } from '@qwen-code/webui/daemon-react-sdk';
import {
  CirclePlayIcon,
  FileCode2Icon,
  HistoryIcon,
  PlayIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { TasksStatusMessage } from '../messages/TasksStatusMessage';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import styles from './WorkflowRunsPage.module.css';

type WorkflowTab = 'saved' | 'active' | 'history';
type SavedWorkflow = NonNullable<
  DaemonSessionSupportedCommandsStatus['savedWorkflows']
>[number];

function isActiveStatus(
  status: DaemonSessionTaskWithWorkflowStatus['status'],
): boolean {
  return status === 'running' || status === 'pausing' || status === 'paused';
}

export function WorkflowRunsPage() {
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
  const activeSessionIdRef = useRef(connection.sessionId);
  const reloadGenerationRef = useRef(0);
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
      const [nextSnapshot] = await Promise.all([
        actions.getWorkflowTasks(),
        actions.refreshCommands(),
      ]);
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

  const handleTasksChange = useCallback(
    (nextSnapshot: DaemonSessionWorkflowTasksStatus) => {
      if (nextSnapshot.sessionId !== activeSessionIdRef.current) return;
      setSnapshot(nextSnapshot);
    },
    [],
  );

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
        setTab('active');
        await reload();
      } catch {
        if (activeSessionIdRef.current === sessionId) setStartError(true);
      } finally {
        if (activeSessionIdRef.current === sessionId) setStartingName(null);
      }
    },
    [actions, reload],
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
                    {savedWorkflows.map((workflow) => (
                      <div
                        key={`${workflow.source}:${workflow.name}`}
                        className={styles.savedCard}
                        data-scope={workflow.source}
                      >
                        <div className={styles.savedIdentity}>
                          <div className={styles.savedName}>
                            /{workflow.name}
                          </div>
                          <div className={styles.savedDescription}>
                            {workflow.source === 'project'
                              ? t('workflowRuns.projectDescription')
                              : t('workflowRuns.userDescription')}
                          </div>
                        </div>
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
                    ))}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="active" className={styles.content}>
                <TasksStatusMessage
                  message={{ snapshot }}
                  embedded
                  keyboardShortcuts={false}
                  manageActiveEvent={false}
                  syncSnapshot
                  taskView="workflow-active"
                  emptyLabel={t('workflowRuns.emptyActive')}
                  onTasksChange={handleTasksChange}
                  onWorkflowRunStarted={() => setTab('active')}
                />
              </TabsContent>
              <TabsContent value="history" className={styles.content}>
                <TasksStatusMessage
                  message={{ snapshot }}
                  embedded
                  keyboardShortcuts={false}
                  manageActiveEvent={false}
                  syncSnapshot
                  taskView="workflow-history"
                  emptyLabel={t('workflowRuns.emptyHistory')}
                  onTasksChange={handleTasksChange}
                  onWorkflowRunStarted={() => setTab('active')}
                />
              </TabsContent>
            </>
          )
        )}
      </Tabs>
    </div>
  );
}
