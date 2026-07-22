import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../../adapters/types';
import {
  useWorkspaceActions,
  type DaemonWorkspaceActions,
  type DaemonScheduledTask,
} from '@qwen-code/webui/daemon-react-sdk';
import { EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useI18n } from '../../i18n';
import { DialogShell } from '../dialogs/DialogShell';
import { isSafeHref, Markdown } from '../messages/Markdown';
import {
  buildCron,
  describeCron,
  parseCronToBuilder,
  type BuilderState,
  type Frequency,
} from '../dialogs/scheduledTasksSchedule';
import taskStyles from '../dialogs/ScheduledTasksDialog.module.css';
import {
  artifactKindLabel,
  formatArtifactSize,
  getArtifactLocation,
  normalizePath,
  withArtifactPreviewCsp,
} from './artifactUtils';
import {
  displayPath,
  isRenderedFilePath,
  type TurnOutputFileChange,
  type TurnOutputFileDiff,
  type TurnOutputScheduledTask,
} from './TurnOutputs';
import { LineStats, sumLineStats } from './LineStats';
import styles from './ArtifactPanel.module.css';
import { SubagentDetail } from './SubagentDetail';

const MAX_REVIEW_SIDE_BY_SIDE_WIDTH = 700;
const FREQUENCIES: Frequency[] = [
  'daily',
  'weekdays',
  'weekly',
  'hourly',
  'minutes',
  'custom',
];
const MINUTE_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];

export type ArtifactPanelTab =
  | {
      id: string;
      kind: 'review';
      title: string;
      workspaceActions?: DaemonWorkspaceActions;
      workspaceCwd?: string;
    }
  | {
      id: string;
      kind: 'file';
      title: string;
      workspacePath: string;
      workspaceActions?: DaemonWorkspaceActions;
      previewContent?: string;
    }
  | {
      id: string;
      kind: 'artifact';
      title: string;
      artifactId: string;
      workspaceActions?: DaemonWorkspaceActions;
      previewContent?: string;
    }
  | {
      id: string;
      kind: 'scheduled_task';
      title: string;
      task: TurnOutputScheduledTask;
      workspaceActions?: DaemonWorkspaceActions;
    }
  | {
      id: string;
      kind: 'subagent';
      title: string;
      sessionId: string;
      rootToolCallId: string;
      rootTool: ACPToolCall;
      workspaceCwd?: string;
    };

interface ArtifactPanelProps {
  artifacts: readonly DaemonSessionArtifact[];
  tabs: readonly ArtifactPanelTab[];
  activeTabId: string | null;
  reviewChanges: readonly TurnOutputFileChange[];
  selectedReviewPath: string | null;
  panelWidth?: number;
  workspaceCwd?: string;
  loading?: boolean;
  error?: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenFilePreview: (
    change: TurnOutputFileChange,
    workspaceActions: DaemonWorkspaceActions,
    workspaceCwd?: string,
  ) => void;
  onClose: () => void;
  variant?: 'docked' | 'drawer';
}

export function ArtifactPanel({
  artifacts,
  tabs,
  activeTabId,
  reviewChanges,
  selectedReviewPath,
  panelWidth,
  workspaceCwd,
  loading,
  error,
  onSelectTab,
  onCloseTab,
  onOpenFilePreview,
  onClose,
  variant = 'docked',
}: ArtifactPanelProps) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const defaultWorkspaceActions = useWorkspaceActions();
  const activeWorkspaceActions =
    activeTab?.workspaceActions ?? defaultWorkspaceActions;

  return (
    <aside
      className={`${styles.panel} ${variant === 'drawer' ? styles.panelDrawer : ''}`}
      style={
        variant === 'docked' && panelWidth
          ? { flexBasis: panelWidth, width: panelWidth }
          : undefined
      }
      aria-label="Right panel"
    >
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Right panel">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={[
                styles.tabItem,
                tab.id === activeTab?.id ? styles.tabActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTab?.id}
                className={styles.tab}
                onClick={() => onSelectTab(tab.id)}
                title={tab.title}
              >
                <span className={styles.tabIcon} aria-hidden="true">
                  {tab.kind === 'review' ? (
                    <TabReviewIcon />
                  ) : tab.kind === 'artifact' || tab.kind === 'file' ? (
                    <TabArtifactIcon />
                  ) : tab.kind === 'subagent' ? (
                    <TabSubagentIcon />
                  ) : (
                    <TabScheduledTaskIcon />
                  )}
                </span>
                {tab.title}
              </button>
              <button
                type="button"
                className={styles.tabCloseButton}
                onClick={() => onCloseTab(tab.id)}
                aria-label={`Close ${tab.title}`}
                title="Close"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close artifacts panel"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className={styles.body}>
        {!activeTab ? (
          <div className={styles.empty}>No panel selected.</div>
        ) : activeTab.kind === 'review' ? (
          <ReviewChanges
            changes={reviewChanges}
            selectedPath={selectedReviewPath}
            workspaceCwd={activeTab.workspaceCwd ?? workspaceCwd}
            onOpenFilePreview={(change) =>
              onOpenFilePreview(
                change,
                activeWorkspaceActions,
                activeTab.workspaceCwd ?? workspaceCwd,
              )
            }
          />
        ) : activeTab.kind === 'file' ? (
          <WorkspaceFilePreview
            key={activeTab.id}
            workspacePath={activeTab.workspacePath}
            workspaceActions={activeWorkspaceActions}
            previewContent={activeTab.previewContent}
          />
        ) : activeTab.kind === 'artifact' ? (
          <ArtifactDetailTab
            key={activeTab.id}
            artifacts={artifacts}
            artifactId={activeTab.artifactId}
            workspaceActions={activeWorkspaceActions}
            previewContent={activeTab.previewContent}
            loading={loading}
            error={error}
          />
        ) : activeTab.kind === 'subagent' ? (
          <SubagentDetail
            sessionId={activeTab.sessionId}
            rootToolCallId={activeTab.rootToolCallId}
            initialRootTool={activeTab.rootTool}
            workspaceCwd={activeTab.workspaceCwd ?? workspaceCwd}
          />
        ) : (
          <ScheduledTaskDetail
            key={activeTab.id}
            task={activeTab.task}
            actions={activeWorkspaceActions}
          />
        )}
      </div>
    </aside>
  );
}

function TabSubagentIcon() {
  return (
    <svg
      className={styles.tabIconSvg}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M6.5 19c.7-3.1 2.5-4.7 5.5-4.7s4.8 1.6 5.5 4.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className={styles.tabCloseIcon}
      viewBox="0 0 16 16"
      fill="none"
      focusable="false"
      aria-hidden="true"
    >
      <path
        d="m4.5 4.5 7 7M11.5 4.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TabReviewIcon() {
  return (
    <svg
      className={styles.tabIconSvg}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
    >
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M9 9.5h6M12 6.5v6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M9 16h6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TabArtifactIcon() {
  return (
    <svg
      className={styles.tabIconSvg}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
    >
      <rect
        x="6"
        y="4"
        width="12"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M9 10h6M9 14h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TabScheduledTaskIcon() {
  return (
    <svg
      className={styles.tabIconSvg}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
    >
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 8v4l3 2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArtifactDetailTab({
  artifacts,
  artifactId,
  workspaceActions,
  previewContent,
  loading,
  error,
}: {
  artifacts: readonly DaemonSessionArtifact[];
  artifactId: string;
  workspaceActions: DaemonWorkspaceActions;
  previewContent?: string;
  loading?: boolean;
  error?: string | null;
}) {
  const artifact = artifacts.find((item) => item.id === artifactId);
  if (artifact) {
    return (
      <ArtifactDetail
        artifact={artifact}
        workspaceActions={workspaceActions}
        previewContent={previewContent}
      />
    );
  }
  if (loading) {
    return <div className={styles.empty}>Loading artifact...</div>;
  }
  if (error) {
    return <div className={styles.empty}>{error}</div>;
  }
  return <div className={styles.empty}>Artifact not found.</div>;
}

function ScheduledTaskDetail({
  task,
  actions,
}: {
  task: TurnOutputScheduledTask;
  actions: DaemonWorkspaceActions;
}) {
  const { t } = useI18n();
  const [loadedTask, setLoadedTask] = useState<DaemonScheduledTask | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState(task.prompt);
  const [builder, setBuilder] = useState<BuilderState>(() =>
    parseCronToBuilder(task.cron),
  );
  const [showForm, setShowForm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadTask = useCallback(async () => {
    if (!task.durable) {
      setLoadedTask(null);
      setName('');
      setPrompt(task.prompt);
      setBuilder(parseCronToBuilder(task.cron));
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const tasks = await actions.listScheduledTasks();
      const match = tasks.find((item) => item.id === task.id) ?? null;
      setLoadedTask(match);
      if (match) {
        setName(match.name ?? '');
        setPrompt(match.prompt);
        setBuilder(parseCronToBuilder(match.cron));
      } else {
        setName('');
        setPrompt(task.prompt);
        setBuilder(parseCronToBuilder(task.cron));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [actions, task.cron, task.durable, task.id, task.prompt]);

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  const isSessionScoped = !task.durable;
  const isDeleted = task.durable && !loading && !loadError && !loadedTask;
  const canEdit = Boolean(loadedTask);
  const detailTitle = loadedTask?.name || loadedTask?.prompt || task.title;
  const detailPrompt = loadedTask?.prompt ?? task.prompt;
  const detailCron = loadedTask?.cron ?? task.cron;
  const detailRecurring = loadedTask?.recurring ?? task.recurring;
  const detailEnabled = loadedTask?.enabled;

  const openEdit = useCallback(() => {
    if (!loadedTask) return;
    setName(loadedTask.name ?? '');
    setPrompt(loadedTask.prompt);
    setBuilder(parseCronToBuilder(loadedTask.cron));
    setFormError(null);
    setShowForm(true);
  }, [loadedTask]);

  const closeEdit = useCallback(() => {
    setShowForm(false);
    setFormError(null);
    if (!loadedTask) return;
    setName(loadedTask.name ?? '');
    setPrompt(loadedTask.prompt);
    setBuilder(parseCronToBuilder(loadedTask.cron));
  }, [loadedTask]);

  const handleSave = useCallback(async () => {
    if (!loadedTask) return;
    const cron = buildCron(builder);
    if (!cron) {
      setFormError(t('scheduledTasks.error.invalidSchedule'));
      return;
    }
    if (prompt.trim().length === 0) {
      setFormError(t('scheduledTasks.error.emptyPrompt'));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const updated = await actions.updateScheduledTask(loadedTask.id, {
        cron,
        prompt: prompt.trim(),
        name: name.trim() || null,
      });
      setLoadedTask(updated);
      setName(updated.name ?? '');
      setPrompt(updated.prompt);
      setBuilder(parseCronToBuilder(updated.cron));
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [actions, builder, loadedTask, name, prompt, t]);

  const handleToggle = useCallback(async () => {
    if (!loadedTask) return;
    setBusy(true);
    setFormError(null);
    try {
      const updated = await actions.updateScheduledTask(loadedTask.id, {
        enabled: !loadedTask.enabled,
      });
      setLoadedTask(updated);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [actions, loadedTask]);

  const handleDelete = useCallback(async () => {
    if (!loadedTask) return;
    setBusy(true);
    setFormError(null);
    try {
      await actions.deleteScheduledTask(loadedTask.id);
      setLoadedTask(null);
      setShowDeleteConfirm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [actions, loadedTask]);

  const previewCron = buildCron(builder);
  const previewLabel = previewCron ? describeCron(previewCron, t) : null;

  return (
    <div className={styles.detail}>
      {loading && (
        <div className={styles.empty}>{t('scheduledTasks.loading')}</div>
      )}
      {loadError && <div className={taskStyles.loadError}>{loadError}</div>}
      {isDeleted && (
        <div className={styles.empty}>
          {t('scheduledTasks.deletedSnapshot')}
        </div>
      )}
      {isSessionScoped && (
        <div className={styles.empty}>
          {t('scheduledTasks.sessionScopedSnapshot')}
        </div>
      )}
      {!isDeleted && (
        <div className={styles.section}>
          <div className={styles.fieldGrid}>
            <span className={styles.fieldLabel}>
              {t('scheduledTasks.name')}
            </span>
            <span className={styles.fieldValue}>{detailTitle}</span>
            <span className={styles.fieldLabel}>
              {t('scheduledTasks.taskId')}
            </span>
            <span className={styles.fieldValue}>{task.id}</span>
            <span className={styles.fieldLabel}>
              {t('scheduledTasks.schedule')}
            </span>
            <span className={styles.fieldValue}>
              {describeCron(detailCron, t)}
            </span>
            <span className={styles.fieldLabel}>Cron</span>
            <span className={styles.fieldValue}>{detailCron}</span>
            <span className={styles.fieldLabel}>
              {t('scheduledTasks.type')}
            </span>
            <span className={styles.fieldValue}>
              {detailRecurring
                ? t('scheduledTasks.repeats')
                : t('scheduledTasks.runsOnce')}
            </span>
            {detailEnabled !== undefined && (
              <>
                <span className={styles.fieldLabel}>
                  {t('scheduledTasks.status')}
                </span>
                <span className={styles.fieldValue}>
                  {detailEnabled
                    ? t('scheduledTasks.enable')
                    : t('scheduledTasks.disable')}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {!isDeleted && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Prompt</div>
          <div className={styles.description}>{detailPrompt}</div>
        </div>
      )}

      {formError && <div className={taskStyles.formError}>{formError}</div>}

      <div className={styles.actionsRow}>
        <button
          type="button"
          className={taskStyles.primaryButton}
          disabled={!canEdit || busy}
          onClick={openEdit}
        >
          {t('scheduledTasks.edit')}
        </button>
        <button
          type="button"
          className={taskStyles.secondaryButton}
          disabled={!canEdit || busy}
          onClick={() => void handleToggle()}
        >
          {loadedTask?.enabled
            ? t('scheduledTasks.disable')
            : t('scheduledTasks.enable')}
        </button>
        <button
          type="button"
          className={taskStyles.secondaryButton}
          disabled={!canEdit || busy}
          onClick={() => setShowDeleteConfirm(true)}
        >
          {t('scheduledTasks.delete')}
        </button>
      </div>

      {showDeleteConfirm && loadedTask && (
        <DialogShell
          title={t('scheduledTasks.deleteConfirmTitle')}
          size="sm"
          onClose={() => setShowDeleteConfirm(false)}
        >
          <div className={taskStyles.formFields}>
            <div className={styles.description}>
              {t('scheduledTasks.deleteConfirm', {
                name: loadedTask.name || loadedTask.prompt,
              })}
            </div>
            {formError && (
              <div className={taskStyles.formError}>{formError}</div>
            )}
            <div className={taskStyles.formActions}>
              <button
                type="button"
                className={taskStyles.secondaryButton}
                onClick={() => setShowDeleteConfirm(false)}
                disabled={busy}
              >
                {t('scheduledTasks.cancel')}
              </button>
              <button
                type="button"
                className={taskStyles.primaryButton}
                onClick={() => void handleDelete()}
                disabled={busy}
              >
                {t('scheduledTasks.delete')}
              </button>
            </div>
          </div>
        </DialogShell>
      )}

      {showForm && (
        <DialogShell
          title={t('scheduledTasks.editTitle')}
          size="md"
          onClose={closeEdit}
        >
          <div className={taskStyles.formFields}>
            <label className={taskStyles.field}>
              <span className={taskStyles.fieldLabel}>
                {t('scheduledTasks.name')}
              </span>
              <input
                className={taskStyles.input}
                type="text"
                value={name}
                maxLength={200}
                placeholder={t('scheduledTasks.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className={taskStyles.field}>
              <span className={taskStyles.fieldLabel}>
                {t('scheduledTasks.prompt')}
                <span className={taskStyles.required}>*</span>
              </span>
              <textarea
                className={taskStyles.textarea}
                value={prompt}
                rows={4}
                maxLength={100_000}
                placeholder={t('scheduledTasks.promptPlaceholder')}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>

            <div className={taskStyles.scheduleRow}>
              <label className={taskStyles.field}>
                <span className={taskStyles.fieldLabel}>
                  {t('scheduledTasks.frequency')}
                </span>
                <select
                  className={taskStyles.select}
                  value={builder.frequency}
                  onChange={(e) => {
                    const frequency = e.target.value as Frequency;
                    setBuilder((value) => ({
                      ...value,
                      frequency,
                      ...(frequency === 'hourly' ? { time: '00:00' } : {}),
                    }));
                  }}
                >
                  {FREQUENCIES.map((frequency) => (
                    <option key={frequency} value={frequency}>
                      {t(`scheduledTasks.freq.${frequency}`)}
                    </option>
                  ))}
                </select>
              </label>

              {(builder.frequency === 'daily' ||
                builder.frequency === 'weekdays' ||
                builder.frequency === 'weekly') && (
                <label className={taskStyles.field}>
                  <span className={taskStyles.fieldLabel}>
                    {t('scheduledTasks.time')}
                  </span>
                  <input
                    className={taskStyles.input}
                    type="time"
                    value={builder.time}
                    onChange={(e) =>
                      setBuilder((value) => ({
                        ...value,
                        time: e.target.value,
                      }))
                    }
                  />
                </label>
              )}

              {builder.frequency === 'weekly' && (
                <label className={taskStyles.field}>
                  <span className={taskStyles.fieldLabel}>
                    {t('scheduledTasks.weekday')}
                  </span>
                  <select
                    className={taskStyles.select}
                    value={builder.weekday}
                    onChange={(e) =>
                      setBuilder((value) => ({
                        ...value,
                        weekday: Number(e.target.value),
                      }))
                    }
                  >
                    {t('scheduledTasks.weekdayNames')
                      .split(',')
                      .map((label, index) => (
                        <option key={index} value={index}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              {builder.frequency === 'minutes' && (
                <label className={taskStyles.field}>
                  <span className={taskStyles.fieldLabel}>
                    {t('scheduledTasks.interval')}
                  </span>
                  <select
                    className={taskStyles.select}
                    value={builder.minuteInterval}
                    onChange={(e) =>
                      setBuilder((value) => ({
                        ...value,
                        minuteInterval: Number(e.target.value),
                      }))
                    }
                  >
                    {MINUTE_INTERVALS.map((minute) => (
                      <option key={minute} value={minute}>
                        {minute}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {builder.frequency === 'custom' && (
                <label
                  className={`${taskStyles.field} ${taskStyles.fieldGrow}`}
                >
                  <span className={taskStyles.fieldLabel}>
                    {t('scheduledTasks.cron')}
                  </span>
                  <input
                    className={taskStyles.input}
                    type="text"
                    value={builder.customCron}
                    spellCheck={false}
                    placeholder="0 9 * * 1-5"
                    onChange={(e) =>
                      setBuilder((value) => ({
                        ...value,
                        customCron: e.target.value,
                      }))
                    }
                  />
                </label>
              )}
            </div>

            <div className={taskStyles.preview}>
              {previewLabel ? (
                <>
                  <span className={taskStyles.previewLabel}>
                    {previewLabel}
                  </span>
                  <code className={taskStyles.previewCron}>{previewCron}</code>
                </>
              ) : (
                <span className={taskStyles.previewInvalid}>
                  {t('scheduledTasks.error.invalidSchedule')}
                </span>
              )}
            </div>

            {formError && (
              <div className={taskStyles.formError}>{formError}</div>
            )}

            <div className={taskStyles.formActions}>
              <button
                type="button"
                className={taskStyles.secondaryButton}
                onClick={closeEdit}
                disabled={submitting}
              >
                {t('scheduledTasks.cancel')}
              </button>
              <button
                type="button"
                className={taskStyles.primaryButton}
                onClick={() => void handleSave()}
                disabled={submitting}
              >
                {submitting
                  ? t('scheduledTasks.saving')
                  : t('scheduledTasks.save')}
              </button>
            </div>
          </div>
        </DialogShell>
      )}
    </div>
  );
}

function ReviewChanges({
  changes,
  selectedPath,
  workspaceCwd,
  onOpenFilePreview,
}: {
  changes: readonly TurnOutputFileChange[];
  selectedPath: string | null;
  workspaceCwd?: string;
  onOpenFilePreview: (change: TurnOutputFileChange) => void;
}) {
  const { t } = useI18n();
  const [isTreeOpen, setIsTreeOpen] = useState(false);
  const [isFileListOpen, setIsFileListOpen] = useState(true);
  const [isReviewStacked, setIsReviewStacked] = useState(false);
  const [reviewListWidth, setReviewListWidth] = useState(520);
  const reviewListWidthRef = useRef(reviewListWidth);
  const reviewContentRef = useRef<HTMLDivElement | null>(null);
  const reviewResizeCleanupRef = useRef<(() => void) | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const showTree = isTreeOpen;
  const fileTree = useMemo(
    () => buildFileTree(changes, workspaceCwd),
    [changes, workspaceCwd],
  );

  useEffect(() => {
    setExpandedPath(selectedPath);
  }, [selectedPath]);

  useEffect(() => {
    reviewListWidthRef.current = reviewListWidth;
  }, [reviewListWidth]);

  useEffect(() => {
    const container = reviewContentRef.current;
    if (!container) return;
    const update = () => {
      setIsReviewStacked(container.clientWidth < MAX_REVIEW_SIDE_BY_SIDE_WIDTH);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [isFileListOpen]);

  useEffect(() => () => reviewResizeCleanupRef.current?.(), []);

  const handleReviewSplitResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = reviewContentRef.current;
      if (!container) return;
      event.preventDefault();
      const resizeHandle = event.currentTarget;
      resizeHandle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = reviewListWidthRef.current;
      const containerWidth = container.getBoundingClientRect().width;
      const maxWidth = Math.max(180, containerWidth - 180);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      let pendingWidth = startWidth;
      let animationFrame: number | null = null;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const flushWidth = () => {
        animationFrame = null;
        setReviewListWidth(pendingWidth);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        pendingWidth = Math.min(
          maxWidth,
          Math.max(180, startWidth + (moveEvent.clientX - startX)),
        );
        if (animationFrame === null) {
          animationFrame = window.requestAnimationFrame(flushWidth);
        }
      };
      let handlePointerUp: () => void = () => {};
      const cleanupResize = (commitWidth: boolean) => {
        reviewResizeCleanupRef.current = null;
        if (animationFrame !== null) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        if (commitWidth) setReviewListWidth(pendingWidth);
        if (resizeHandle.hasPointerCapture(event.pointerId)) {
          resizeHandle.releasePointerCapture(event.pointerId);
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
      };
      handlePointerUp = () => cleanupResize(true);
      reviewResizeCleanupRef.current = () => cleanupResize(false);
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    },
    [],
  );
  if (changes.length === 0) {
    return <div className={styles.empty}>No file changes to review.</div>;
  }

  const totals = sumLineStats(changes);
  const toggleDiff = (path: string) => {
    setExpandedPath((current) => (current === path ? null : path));
  };

  return (
    <div className={styles.review}>
      <div className={styles.reviewToolbar}>
        <div className={styles.reviewToolbarTitle}>
          <span>{t('turnOutputs.previousTurn')}</span>
          <LineStats
            additions={totals?.additions}
            deletions={totals?.deletions}
            className={styles.lineStats}
            additionsClassName={styles.additions}
            deletionsClassName={styles.deletions}
          />
        </div>
        <div className={styles.reviewToolbarActions}>
          <button
            type="button"
            className={styles.reviewTotalsButton}
            onClick={() => setIsFileListOpen((value) => !value)}
            aria-expanded={isFileListOpen}
          >
            <span>{t('turnOutputs.fileCount', { count: changes.length })}</span>
            <span
              className={[
                styles.chevron,
                isFileListOpen ? styles.chevronOpen : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            >
              <ChevronIcon />
            </span>
          </button>
          <button
            type="button"
            className={[
              styles.iconButton,
              isTreeOpen ? styles.iconButtonActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setIsTreeOpen((value) => !value)}
            aria-label={
              isTreeOpen
                ? t('turnOutputs.closeFileTree')
                : t('turnOutputs.openFileTree')
            }
            title={
              isTreeOpen
                ? t('turnOutputs.closeFileTree')
                : t('turnOutputs.openFileTree')
            }
          >
            {isTreeOpen ? <FolderOpenIcon /> : <FolderIcon />}
          </button>
        </div>
      </div>
      {isFileListOpen && (
        <div
          ref={reviewContentRef}
          className={[
            styles.reviewContent,
            showTree ? '' : styles.reviewContentListOnly,
            showTree && isReviewStacked ? styles.reviewContentStacked : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={
            {
              '--review-list-width': `${reviewListWidth}px`,
            } as CSSProperties
          }
        >
          <div
            className={[
              styles.reviewList,
              expandedPath ? styles.reviewListWithExpanded : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {changes.map((change) => {
              const isExpanded = expandedPath === change.path;
              const canOpenPreview = isRenderedFilePath(change.path);
              return (
                <div
                  key={`${change.toolCallId}:${change.path}`}
                  className={[
                    styles.reviewItem,
                    isExpanded ? styles.reviewItemExpanded : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div
                    className={styles.reviewRow}
                    data-selected={change.path === selectedPath || undefined}
                  >
                    <button
                      type="button"
                      className={styles.reviewRowToggle}
                      onClick={() => toggleDiff(change.path)}
                      aria-label={change.path}
                      aria-expanded={isExpanded}
                    />
                    <span className={styles.fileIcon}>
                      {fileExtensionLabel(change.path)}
                    </span>
                    <span className={styles.reviewFileName}>
                      <PathText
                        path={displayPath(change.path, workspaceCwd)}
                        title={change.path}
                      />
                      {canOpenPreview && (
                        <button
                          type="button"
                          className={styles.reviewOpenButton}
                          onClick={() => onOpenFilePreview(change)}
                          title={`${t('turnOutputs.preview')} ${change.path}`}
                        >
                          {t('turnOutputs.preview')}
                        </button>
                      )}
                    </span>
                    <LineStats
                      additions={change.additions}
                      deletions={change.deletions}
                      className={styles.lineStats}
                      additionsClassName={styles.additions}
                      deletionsClassName={styles.deletions}
                    />
                    <span
                      className={[
                        styles.chevron,
                        isExpanded ? styles.chevronOpen : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-hidden="true"
                    >
                      <ChevronIcon />
                    </span>
                  </div>
                  {isExpanded && <DiffPreview change={change} />}
                </div>
              );
            })}
          </div>
          {showTree && !isReviewStacked && (
            <div
              className={styles.reviewSplitHandle}
              role="separator"
              aria-orientation="vertical"
              onPointerDown={handleReviewSplitResizeStart}
            />
          )}
          {showTree && (
            <div className={styles.tree}>
              {fileTree.children.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  depth={0}
                  selectedPath={selectedPath}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffPreview({ change }: { change: TurnOutputFileChange }) {
  if (change.diffs.length === 0) {
    return <div className={styles.diffEmpty}>No diff available.</div>;
  }
  const diffs = getDisplayDiffs(change.diffs);
  return (
    <div className={styles.diffPreview}>
      {diffs.map((diff, index) => (
        <CodeMirrorDiff
          key={index}
          oldText={diff.oldText}
          newText={diff.newText}
        />
      ))}
    </div>
  );
}

function getDisplayDiffs(
  diffs: readonly TurnOutputFileDiff[],
): readonly TurnOutputFileDiff[] {
  for (let index = diffs.length - 1; index >= 0; index--) {
    const diff = diffs[index];
    if (diff?.fullContent) return diffs.slice(index);
  }
  return diffs;
}

function CodeMirrorDiff({
  oldText,
  newText,
}: {
  oldText: string;
  newText: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [isWide, setIsWide] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setIsWide(host.clientWidth >= 720);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || isWide === null) return;
    host.replaceChildren();
    setError(null);
    let cancelled = false;
    let view: { destroy(): void } | null = null;

    const extensions = [
      basicSetup,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];
    const diffConfig = { scanLimit: 1_000, timeout: 500 };
    const collapseUnchanged = { margin: 3, minSize: 8 };

    void import('@codemirror/merge')
      .then(({ MergeView, unifiedMergeView }) => {
        if (cancelled) return;
        try {
          if (isWide) {
            view = new MergeView({
              a: { doc: oldText, extensions },
              b: { doc: newText, extensions },
              parent: host,
              highlightChanges: true,
              gutter: true,
              revertControls: undefined,
              collapseUnchanged,
              diffConfig,
            });
            return;
          }

          view = new EditorView({
            doc: newText,
            extensions: [
              ...extensions,
              unifiedMergeView({
                original: oldText,
                highlightChanges: true,
                gutter: true,
                mergeControls: false,
                allowInlineDiffs: true,
                collapseUnchanged,
                diffConfig,
              }),
            ],
            parent: host,
          });
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [isWide, newText, oldText]);

  return (
    <div className={styles.codeMirrorDiffWrap}>
      <div ref={hostRef} className={styles.codeMirrorDiff} />
      {error && (
        <div className={styles.diffError}>Diff unavailable: {error}</div>
      )}
    </div>
  );
}

interface FileTreeNode {
  name: string;
  path: string;
  file?: TurnOutputFileChange;
  children: FileTreeNode[];
}

function TreeNode({
  node,
  depth,
  selectedPath,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
}) {
  const isFile = Boolean(node.file);
  const [isOpen, setIsOpen] = useState(true);
  const rowClassName = [
    styles.treeRow,
    isFile ? styles.treeFile : styles.treeFolder,
  ]
    .filter(Boolean)
    .join(' ');
  const rowStyle = {
    paddingLeft: 10 + depth * 18,
    '--tree-row-line-left': `${19 + Math.max(0, depth - 1) * 18}px`,
  } as CSSProperties;
  const childrenStyle = {
    '--tree-children-line-left': `${19 + depth * 18}px`,
  } as CSSProperties;
  const rowContent = (
    <>
      <span className={styles.treeTwisty}>
        {!isFile && (
          <span
            className={[
              styles.treeChevron,
              isOpen ? '' : styles.treeChevronClosed,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <TreeChevronIcon />
          </span>
        )}
      </span>
      <span className={styles.treeContent}>
        {isFile && (
          <span className={styles.fileIcon}>
            {fileExtensionLabel(node.path)}
          </span>
        )}
        <span className={styles.treeName}>{node.name}</span>
      </span>
      {node.file?.isArtifact && (
        <span className={styles.reviewBadge}>artifact</span>
      )}
    </>
  );

  return (
    <div className={styles.treeNode}>
      {isFile ? (
        <div
          className={rowClassName}
          data-selected={node.file?.path === selectedPath || undefined}
          data-depth={depth}
          style={rowStyle}
          title={node.path}
        >
          {rowContent}
        </div>
      ) : (
        <button
          type="button"
          className={rowClassName}
          data-depth={depth}
          style={rowStyle}
          title={node.path}
          aria-expanded={isOpen}
          onClick={() => setIsOpen((value) => !value)}
        >
          {rowContent}
        </button>
      )}
      {!isFile && isOpen && node.children.length > 0 && (
        <div className={styles.treeChildren} style={childrenStyle}>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PathText({ path, title }: { path: string; title?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(() => splitReviewPath(path));
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setDisplay(compactReviewPath(path, node));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [path]);
  return (
    <span ref={ref} className={styles.reviewPath} title={title ?? path}>
      {display.prefix && (
        <span className={styles.pathPrefix}>{display.prefix}</span>
      )}
      <span className={styles.pathFileName}>{display.leaf}</span>
    </span>
  );
}

function splitReviewPath(path: string) {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex < 0
    ? { prefix: '', leaf: path }
    : {
        prefix: path.slice(0, slashIndex + 1),
        leaf: path.slice(slashIndex + 1),
      };
}

let measureCanvas: HTMLCanvasElement | null = null;

function compactReviewPath(path: string, container: HTMLElement) {
  const full = splitReviewPath(path);
  const width = container.clientWidth;
  if (width <= 0) return full;
  const measure = createTextMeasurer(container);
  if (measure(path) <= width) return full;
  const parts = path.split('/').filter(Boolean);
  const leaf = parts.at(-1) ?? path;
  const fileWidth = measure(leaf);
  if (parts.length <= 1 || fileWidth + measure('.../') > width) {
    return { prefix: '', leaf };
  }
  let prefix = '.../';
  for (let dirCount = 1; dirCount < parts.length; dirCount++) {
    const dirs = parts.slice(parts.length - 1 - dirCount, -1);
    const candidate = `.../${dirs.join('/')}/`;
    if (measure(candidate) + fileWidth > width) break;
    prefix = candidate;
  }
  return { prefix, leaf };
}

function createTextMeasurer(element: HTMLElement) {
  measureCanvas ??= document.createElement('canvas');
  const context = measureCanvas.getContext('2d');
  const style = window.getComputedStyle(element);
  if (context) {
    context.font = [
      style.fontStyle,
      style.fontVariant,
      style.fontWeight,
      style.fontSize,
      style.fontFamily,
    ].join(' ');
  }
  return (text: string) => context?.measureText(text).width ?? text.length * 8;
}

function FolderIcon() {
  return (
    <svg
      className={styles.toolbarIcon}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      aria-hidden="true"
    >
      <path
        d="M3.5 7.5h6l1.6 2h9.4v8.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 7.5V5.8a1.5 1.5 0 0 1 1.5-1.5h4l1.8 2.1h7.2a1.5 1.5 0 0 1 1.5 1.5v1.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderOpenIcon() {
  return (
    <svg
      className={styles.toolbarIcon}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      aria-hidden="true"
    >
      <path
        d="M3.5 8.2V5.8A1.5 1.5 0 0 1 5 4.3h4l1.8 2.1h7.2a1.5 1.5 0 0 1 1.5 1.5v1.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M4.8 19.7h12.9a2 2 0 0 0 1.9-1.4l2-7H6.4l-2.8 7.1a.9.9 0 0 0 1.2 1.3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      className={styles.chevronIcon}
      viewBox="0 0 16 16"
      fill="none"
      focusable="false"
      aria-hidden="true"
    >
      <path
        d="m6 4 4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TreeChevronIcon() {
  return (
    <svg
      className={styles.treeChevronIcon}
      viewBox="0 0 16 16"
      fill="none"
      focusable="false"
      aria-hidden="true"
    >
      <path
        d="m4 6 4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function buildFileTree(
  changes: readonly TurnOutputFileChange[],
  workspaceCwd?: string,
): FileTreeNode {
  const root: FileTreeNode = { name: '', path: '', children: [] };
  for (const change of changes) {
    const parts = displayPath(change.path, workspaceCwd)
      .split('/')
      .filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const path = parts.slice(0, index + 1).join('/');
      let child = current.children.find((node) => node.name === part);
      if (!child) {
        child = { name: part, path, children: [] };
        current.children.push(child);
      }
      if (index === parts.length - 1) child.file = change;
      current = child;
    }
  }
  sortTree(root);
  return root;
}

function sortTree(node: FileTreeNode) {
  node.children.sort((left, right) => {
    if (Boolean(left.file) !== Boolean(right.file)) return left.file ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
  for (const child of node.children) sortTree(child);
}

function fileName(value: string) {
  const parts = normalizePath(value).split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}

function fileExtensionLabel(value: string) {
  const name = fileName(value);
  const extension = name.includes('.')
    ? name.split('.').pop()?.toLowerCase()
    : '';
  if (!extension) return 'FILE';
  const labels: Record<string, string> = {
    css: 'CSS',
    html: 'HTML',
    js: 'JS',
    json: 'JSON',
    jsx: 'JSX',
    md: 'MD',
    ts: 'TS',
    tsx: 'TSX',
  };
  return labels[extension] ?? extension.slice(0, 3).toUpperCase();
}

function ArtifactDetail({
  artifact,
  workspaceActions,
  previewContent,
}: {
  artifact: DaemonSessionArtifact;
  workspaceActions: DaemonWorkspaceActions;
  previewContent?: string;
}) {
  const location = getArtifactLocation(artifact);
  const safeUrl = isSafeHref(artifact.url) ? artifact.url : undefined;
  const isAutomationSnapshot =
    artifact.metadata?.['artifactType'] === 'automation_snapshot';
  const canPreviewWorkspaceFile =
    artifact.storage === 'workspace' && Boolean(artifact.workspacePath);

  if (canPreviewWorkspaceFile && artifact.workspacePath) {
    return (
      <WorkspaceFilePreview
        workspacePath={artifact.workspacePath}
        artifactVersion={artifact.updatedAt}
        workspaceActions={workspaceActions}
        previewContent={previewContent}
        previewKind={
          isHtmlArtifact(artifact)
            ? 'html'
            : isMarkdownArtifact(artifact)
              ? 'markdown'
              : 'source'
        }
      />
    );
  }

  return (
    <div className={styles.detail}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          {isAutomationSnapshot ? 'Automation Snapshot' : 'Artifact'}
        </div>
        <div className={styles.fieldGrid}>
          <Field label="Type" value={artifactKindLabel(artifact.kind)} />
          <Field label="Storage" value={artifact.storage} />
          <Field label="Status" value={artifact.status} />
          <Field label="Source" value={artifact.source} />
          <Field label="Size" value={formatArtifactSize(artifact.sizeBytes)} />
          <Field label="Created" value={artifact.createdAt} />
          <Field label="Updated" value={artifact.updatedAt} />
          {artifact.toolName && (
            <Field label="Tool" value={artifact.toolName} />
          )}
          {artifact.toolCallId && (
            <Field label="Tool call" value={artifact.toolCallId} />
          )}
        </div>
      </div>

      {artifact.description && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Description</div>
          <div className={styles.description}>{artifact.description}</div>
        </div>
      )}

      {isAutomationSnapshot && artifact.metadata && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Details</div>
          <div className={styles.fieldGrid}>
            {metadataField(artifact.metadata, 'automationId', 'Automation ID')}
            {metadataField(artifact.metadata, 'schedule', 'Schedule')}
            {metadataField(artifact.metadata, 'timezone', 'Timezone')}
            {metadataField(artifact.metadata, 'status', 'Status')}
            {metadataField(artifact.metadata, 'nextRunAt', 'Next run')}
            {metadataField(artifact.metadata, 'prompt', 'Prompt')}
          </div>
        </div>
      )}

      {(location || safeUrl) && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Location</div>
          {safeUrl ? (
            <a
              className={styles.link}
              href={safeUrl}
              target="_blank"
              rel="noreferrer"
            >
              {safeUrl}
            </a>
          ) : (
            <div className={styles.meta}>{location}</div>
          )}
        </div>
      )}
    </div>
  );
}

function isHtmlArtifact(artifact: DaemonSessionArtifact) {
  const path = artifact.workspacePath?.toLowerCase() ?? '';
  const mimeType = artifact.mimeType?.toLowerCase() ?? '';
  return (
    artifact.kind === 'html' ||
    path.endsWith('.html') ||
    path.endsWith('.htm') ||
    mimeType === 'text/html'
  );
}

function isMarkdownArtifact(artifact: DaemonSessionArtifact) {
  const path = artifact.workspacePath?.toLowerCase() ?? '';
  return (
    path.endsWith('.md') ||
    path.endsWith('.markdown') ||
    artifact.mimeType?.toLowerCase() === 'text/markdown'
  );
}

function WorkspaceFilePreview({
  workspacePath,
  artifactVersion,
  workspaceActions,
  previewContent,
  previewKind = workspacePath.toLowerCase().endsWith('.html') ||
  workspacePath.toLowerCase().endsWith('.htm')
    ? 'html'
    : workspacePath.toLowerCase().endsWith('.md') ||
        workspacePath.toLowerCase().endsWith('.markdown')
      ? 'markdown'
      : 'source',
}: {
  workspacePath: string;
  artifactVersion?: string;
  workspaceActions: DaemonWorkspaceActions;
  previewContent?: string;
  previewKind?: 'html' | 'markdown' | 'source';
}) {
  if (previewKind === 'html') {
    return (
      <HtmlArtifactPreview
        workspacePath={workspacePath}
        artifactVersion={artifactVersion}
        workspaceActions={workspaceActions}
        previewContent={previewContent}
      />
    );
  }
  if (previewKind === 'markdown') {
    return (
      <MarkdownArtifactPreview
        workspacePath={workspacePath}
        artifactVersion={artifactVersion}
        workspaceActions={workspaceActions}
        previewContent={previewContent}
      />
    );
  }
  return (
    <FileArtifactPreview
      workspacePath={workspacePath}
      artifactVersion={artifactVersion}
      workspaceActions={workspaceActions}
    />
  );
}

function useWorkspaceFileContent({
  workspacePath,
  artifactVersion,
  workspaceActions,
  previewContent,
  truncatedMessage,
}: {
  workspacePath: string;
  artifactVersion?: string;
  workspaceActions: DaemonWorkspaceActions;
  previewContent?: string;
  truncatedMessage: string;
}) {
  const [content, setContent] = useState<string | null>(previewContent ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(previewContent ?? null);
    setError(null);
    workspaceActions
      .readWorkspaceFile(workspacePath)
      .then((file) => {
        if (cancelled) return;
        setContent(file.content);
        if (file.truncated) setError(truncatedMessage);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [
    artifactVersion,
    previewContent,
    truncatedMessage,
    workspaceActions,
    workspacePath,
  ]);

  return { content, error };
}

function HtmlArtifactPreview({
  workspacePath,
  artifactVersion,
  workspaceActions,
  previewContent,
}: {
  workspacePath: string;
  artifactVersion?: string;
  workspaceActions: DaemonWorkspaceActions;
  previewContent?: string;
}) {
  const { content, error } = useWorkspaceFileContent({
    workspacePath,
    artifactVersion,
    workspaceActions,
    previewContent,
    truncatedMessage: 'Preview is truncated because the file is too large.',
  });

  return (
    <div className={styles.htmlPreviewWrap}>
      {content === null ? (
        <div className={styles.empty}>Loading preview...</div>
      ) : (
        <iframe
          className={styles.htmlPreview}
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={withArtifactPreviewCsp(content)}
          title={`Preview ${workspacePath}`}
        />
      )}
      {error && <div className={styles.previewError}>{error}</div>}
    </div>
  );
}

function FileArtifactPreview({
  workspacePath,
  artifactVersion,
  workspaceActions,
}: {
  workspacePath: string;
  artifactVersion?: string;
  workspaceActions: DaemonWorkspaceActions;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const { content, error } = useWorkspaceFileContent({
    workspacePath,
    artifactVersion,
    workspaceActions,
    truncatedMessage: 'File is truncated because it is too large.',
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || content === null) return;
    host.replaceChildren();
    setRenderError(null);
    let view: EditorView;
    try {
      view = new EditorView({
        doc: content,
        extensions: [
          basicSetup,
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
        ],
        parent: host,
      });
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
      return undefined;
    }
    return () => view.destroy();
  }, [content]);

  return (
    <div className={styles.filePreviewWrap}>
      {content === null ? (
        <div className={styles.empty}>Loading file...</div>
      ) : (
        <div ref={hostRef} className={styles.codeMirrorFile} />
      )}
      {(error || renderError) && (
        <div className={styles.previewError}>{error || renderError}</div>
      )}
    </div>
  );
}

function MarkdownArtifactPreview({
  workspacePath,
  artifactVersion,
  workspaceActions,
  previewContent,
}: {
  workspacePath: string;
  artifactVersion?: string;
  workspaceActions: DaemonWorkspaceActions;
  previewContent?: string;
}) {
  const { content, error } = useWorkspaceFileContent({
    workspacePath,
    artifactVersion,
    workspaceActions,
    previewContent,
    truncatedMessage: 'Preview is truncated because the file is too large.',
  });

  return (
    <div className={styles.markdownPreviewWrap}>
      {content === null ? (
        <div className={styles.empty}>Loading preview...</div>
      ) : (
        <Markdown content={content} />
      )}
      {error && <div className={styles.previewError}>{error}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value}</span>
    </>
  );
}

function metadataField(
  metadata: NonNullable<DaemonSessionArtifact['metadata']>,
  key: string,
  label: string,
) {
  const value = metadata[key];
  if (value === undefined || value === null || value === '') return null;
  return <Field key={key} label={label} value={String(value)} />;
}
