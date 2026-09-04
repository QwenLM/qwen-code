import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../../adapters/types';
import {
  DownloadIcon,
  FileAudioIcon,
  FileCode2Icon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  LinkIcon,
  NotebookTabsIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { describeCron } from '../dialogs/scheduledTasksSchedule';
import {
  formatArtifactSize,
  downloadWorkspaceFile,
  getArtifactTypeLabel,
  getImageMimeTypeFromPath,
  isSamePath,
  normalizePath,
  stripWorkspacePath,
} from './artifactUtils';
import { LineStats, sumLineStats } from './LineStats';
import { useArtifactWorkspaceTarget } from './useArtifactWorkspaceTarget';
import styles from './TurnOutputs.module.css';

export interface TurnOutputFileChange {
  path: string;
  status: 'created' | 'modified';
  toolCallId: string;
  isArtifact: boolean;
  additions?: number;
  deletions?: number;
  diffs: TurnOutputFileDiff[];
}

export interface TurnOutputFileDiff {
  oldText: string;
  newText: string;
  fileDiff?: string;
  fullContent?: boolean;
}

export interface TurnOutputScheduledTask {
  id: string;
  toolCallId: string;
  title: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  workspaceId?: string;
  display?: string;
}

export type TurnOutputKind = 'file' | 'artifact' | 'scheduled_task';

export const TURN_OUTPUT_KINDS: readonly TurnOutputKind[] = [
  'file',
  'artifact',
  'scheduled_task',
];

export const TURN_OUTPUT_VISIBLE_LIMIT = 3;

export function visibleTurnOutputs<T>(
  items: readonly T[],
  expanded: boolean,
): readonly T[] {
  return expanded ? items : items.slice(0, TURN_OUTPUT_VISIBLE_LIMIT);
}

export type TurnOutputOpenRequest = (
  | {
      id: 'review';
      kind: 'review';
      title: string;
      turnId: string;
      changes: readonly TurnOutputFileChange[];
      selectedPath?: string;
      workspaceCwd?: string;
      workspaceId?: string;
    }
  | {
      id: 'image';
      kind: 'image';
      title: string;
      turnId: string;
      src: string;
      alt?: string;
      attachmentId?: string;
    }
  | {
      id: string;
      kind: 'attachment';
      title: string;
      turnId: string;
      mimeType?: string;
      data?: Blob;
      text?: string;
      attachmentId?: string;
      workspacePath?: string;
      workspaceCwd?: string;
    }
  | {
      id: string;
      kind: 'artifact';
      title: string;
      turnId: string;
      artifactId: string;
      managedId?: string;
      artifact: DaemonSessionArtifact;
      workspaceCwd?: string;
      workspaceId?: string;
      previewContent?: string;
    }
  | {
      id: string;
      kind: 'scheduled_task';
      title: string;
      turnId: string;
      task: TurnOutputScheduledTask;
      workspaceCwd?: string;
      workspaceId?: string;
    }
  | {
      id: string;
      kind: 'subagent';
      title: string;
      turnId: string;
      tool: ACPToolCall;
      sessionId: string;
      workspaceCwd?: string;
    }
) & {
  /** Session whose transcript produced this output. */
  sourceSessionId?: string;
};

interface TurnOutputsProps {
  turnId: string;
  changes: readonly TurnOutputFileChange[];
  artifacts: readonly DaemonSessionArtifact[];
  scheduledTasks: readonly TurnOutputScheduledTask[];
  workspaceCwd?: string;
  onOpenRequest?: (request: TurnOutputOpenRequest) => void;
  onReviewChanges: (
    changes: readonly TurnOutputFileChange[],
    selectedPath?: string,
  ) => void;
  onOpenArtifact: (artifactId: string, previewContent?: string) => void;
  onOpenScheduledTask: (task: TurnOutputScheduledTask) => void;
  onError?: (error: unknown, fallback: string) => void;
}

function TurnOutputsComponent({
  turnId,
  changes,
  artifacts,
  scheduledTasks,
  workspaceCwd,
  onOpenRequest,
  onReviewChanges,
  onOpenArtifact,
  onOpenScheduledTask,
  onError,
}: TurnOutputsProps) {
  const { t } = useI18n();
  const workspaceTarget = useArtifactWorkspaceTarget(workspaceCwd);
  const workspaceActions = workspaceTarget?.actions;
  const [showAllChanges, setShowAllChanges] = useState(false);
  const [showAllArtifacts, setShowAllArtifacts] = useState(false);
  if (
    changes.length === 0 &&
    artifacts.length === 0 &&
    scheduledTasks.length === 0
  ) {
    return null;
  }
  const visibleChanges = visibleTurnOutputs(changes, showAllChanges);
  const remainingChanges = changes.length - TURN_OUTPUT_VISIBLE_LIMIT;
  const visibleArtifacts = visibleTurnOutputs(artifacts, showAllArtifacts);
  const remainingArtifacts = artifacts.length - TURN_OUTPUT_VISIBLE_LIMIT;
  const totals = sumLineStats(changes);
  const openReview = (selectedPath?: string) => {
    if (onOpenRequest) {
      onOpenRequest({
        id: 'review',
        kind: 'review',
        title: t('turnOutputs.review'),
        turnId,
        changes,
        ...(workspaceCwd ? { workspaceCwd } : {}),
        ...(workspaceTarget?.workspaceId
          ? { workspaceId: workspaceTarget.workspaceId }
          : {}),
        ...(selectedPath ? { selectedPath } : {}),
      });
      return;
    }
    onReviewChanges(changes, selectedPath);
  };
  const openArtifact = (artifact: DaemonSessionArtifact) => {
    const previewContent = getArtifactPreviewContent(
      artifact,
      changes,
      workspaceCwd,
    );
    if (onOpenRequest) {
      onOpenRequest({
        id: `artifact:${artifact.id}`,
        kind: 'artifact',
        title: artifact.title ?? 'Artifact',
        turnId,
        artifactId: artifact.id,
        ...(artifact.managedId ? { managedId: artifact.managedId } : {}),
        artifact,
        ...(workspaceCwd ? { workspaceCwd } : {}),
        ...(workspaceTarget?.workspaceId
          ? { workspaceId: workspaceTarget.workspaceId }
          : {}),
        ...(previewContent !== undefined ? { previewContent } : {}),
      });
      return;
    }
    onOpenArtifact(artifact.id, previewContent);
  };
  const openScheduledTask = (task: TurnOutputScheduledTask) => {
    if (onOpenRequest) {
      onOpenRequest({
        id: `scheduled-task:${task.toolCallId}`,
        kind: 'scheduled_task',
        title: t('scheduledTasks.title'),
        turnId,
        task: workspaceTarget?.workspaceId
          ? { ...task, workspaceId: workspaceTarget.workspaceId }
          : task,
        ...(workspaceCwd ? { workspaceCwd } : {}),
        ...(workspaceTarget?.workspaceId
          ? { workspaceId: workspaceTarget.workspaceId }
          : {}),
      });
      return;
    }
    onOpenScheduledTask(task);
  };

  return (
    <div className={styles.root}>
      {changes.length > 0 && (
        <div className={styles.card}>
          <div className={styles.summary}>
            <span className={styles.icon} aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                focusable="false"
                className={styles.iconSvg}
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
            </span>
            <div
              className={[
                styles.reviewSummary,
                totals ? styles.reviewSummaryWithStats : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={styles.title}>
                {t('turnOutputs.filesEdited', { count: changes.length })}
              </div>
              <div className={styles.reviewMeta}>
                <LineStats
                  additions={totals?.additions}
                  deletions={totals?.deletions}
                  className={styles.lineStats}
                  additionsClassName={styles.additions}
                  deletionsClassName={styles.deletions}
                />
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => openReview()}
                >
                  {t('turnOutputs.viewChanges')} ↗
                </button>
              </div>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.reviewButton}
                onClick={() => openReview()}
              >
                {t('turnOutputs.review')}
              </button>
            </div>
          </div>

          <div className={styles.list}>
            {visibleChanges.map((change) => (
              <button
                type="button"
                key={`${change.toolCallId}:${change.path}`}
                className={styles.fileRow}
                onClick={() => openReview(change.path)}
                title={change.path}
              >
                <span className={styles.path}>
                  {displayPath(change.path, workspaceCwd)}
                </span>
                <LineStats
                  additions={change.additions}
                  deletions={change.deletions}
                  className={styles.lineStats}
                  additionsClassName={styles.additions}
                  deletionsClassName={styles.deletions}
                />
              </button>
            ))}
            {remainingChanges > 0 && (
              <button
                type="button"
                className={styles.showMoreButton}
                onClick={() => setShowAllChanges((value) => !value)}
              >
                <span>
                  {showAllChanges
                    ? t('turnOutputs.collapseFiles')
                    : t('turnOutputs.showMoreFiles', {
                        count: remainingChanges,
                      })}
                </span>
                <ChevronIcon open={showAllChanges} />
              </button>
            )}
          </div>
        </div>
      )}

      {visibleArtifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          onOpen={
            canOpenWorkspaceArtifact(artifact)
              ? () => openArtifact(artifact)
              : undefined
          }
          onError={onError}
          onDownload={
            canDownloadArtifact(artifact) && workspaceActions
              ? (isCancelled) =>
                  downloadWorkspaceFile(
                    workspaceActions,
                    artifact.workspacePath,
                    artifact.mimeType,
                    isCancelled,
                  )
              : undefined
          }
        />
      ))}
      {remainingArtifacts > 0 && (
        <button
          type="button"
          className={styles.showMoreButton}
          onClick={() => setShowAllArtifacts((value) => !value)}
        >
          <span>
            {showAllArtifacts
              ? t('turnOutputs.collapseArtifacts')
              : t('turnOutputs.showMoreArtifacts', {
                  count: remainingArtifacts,
                })}
          </span>
          <ChevronIcon open={showAllArtifacts} />
        </button>
      )}

      {scheduledTasks.map((task) => (
        <ScheduledTaskCard
          key={task.toolCallId}
          task={task}
          scheduleLabel={describeCron(task.cron, t)}
          onOpen={() => openScheduledTask(task)}
        />
      ))}
    </div>
  );
}

function ArtifactCard({
  artifact,
  onOpen,
  onDownload,
  onError,
}: {
  artifact: DaemonSessionArtifact;
  onOpen?: () => void;
  onDownload?: (isCancelled: () => boolean) => Promise<void>;
  onError?: (error: unknown, fallback: string) => void;
}) {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    // StrictMode replays setup -> cleanup -> setup without re-running useRef's
    // initializer, so restore the flag or every download looks cancelled.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const size = formatArtifactSize(artifact.sizeBytes);
  const FormatIcon = getArtifactFormatIcon(artifact.kind);
  const blockedReason = getWorkspaceArtifactOpenBlockReason(artifact, t);
  const downloadName =
    (artifact.workspacePath &&
      normalizePath(artifact.workspacePath).split('/').at(-1)) ||
    artifact.title;
  const handleDownload = async () => {
    if (!onDownload || downloading) return;
    setDownloading(true);
    try {
      await onDownload(() => !mountedRef.current);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = t('common.downloadFailed', {
        message: extractErrorDetail(error),
      });
      if (onError) onError(new Error(message, { cause: error }), message);
      else console.error(message, error);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className={styles.card}>
      <div className={styles.summary}>
        <span className={styles.icon} aria-hidden="true">
          {FormatIcon ? (
            <FormatIcon className={styles.iconSvg} strokeWidth={1.8} />
          ) : (
            <DocumentIcon />
          )}
        </span>
        <div className={styles.artifactInfo}>
          <div className={styles.title}>{artifact.title}</div>
          <div className={styles.artifactMeta}>
            {[getArtifactTypeLabel(artifact), size, blockedReason]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className={styles.actions}>
          {onDownload && (
            <button
              type="button"
              className={styles.reviewButton}
              onClick={() => void handleDownload()}
              title={`${t('common.download')} ${downloadName}`}
              disabled={downloading}
            >
              <DownloadIcon size={16} strokeWidth={1.8} aria-hidden="true" />
              {t(downloading ? 'common.downloading' : 'common.download')}
            </button>
          )}
          <button
            type="button"
            className={styles.reviewButton}
            onClick={onOpen}
            title={blockedReason ?? artifact.title}
            disabled={!onOpen}
          >
            {t('common.open')}
          </button>
        </div>
      </div>
    </div>
  );
}

const ARTIFACT_FORMAT_ICONS: Readonly<Record<string, LucideIcon>> = {
  file: FileIcon,
  link: LinkIcon,
  html: FileCode2Icon,
  image: FileImageIcon,
  video: FileVideoIcon,
  audio: FileAudioIcon,
  pdf: FileTextIcon,
  notebook: NotebookTabsIcon,
  document: FileTextIcon,
};

export function getArtifactFormatIcon(kind: string): LucideIcon | undefined {
  return ARTIFACT_FORMAT_ICONS[kind];
}

function ScheduledTaskCard({
  task,
  scheduleLabel,
  onOpen,
}: {
  task: TurnOutputScheduledTask;
  scheduleLabel: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.card}>
      <div className={styles.summary}>
        <span className={styles.icon} aria-hidden="true">
          <ClockIcon />
        </span>
        <div className={styles.artifactInfo}>
          <div className={styles.title}>{task.title}</div>
          <div className={styles.artifactMeta}>
            {[
              scheduleLabel,
              task.recurring
                ? t('scheduledTasks.repeats')
                : t('scheduledTasks.runsOnce'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.reviewButton}
            onClick={onOpen}
            title={task.title}
          >
            {t('common.open')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DocumentIcon() {
  return (
    <svg
      className={styles.iconSvg}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      aria-hidden="true"
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

function ClockIcon() {
  return (
    <svg
      className={styles.iconSvg}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      aria-hidden="true"
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

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={[styles.chevronIcon, open ? styles.chevronIconOpen : '']
        .filter(Boolean)
        .join(' ')}
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

export const TurnOutputs = memo(TurnOutputsComponent);

export function getArtifactPreviewContent(
  artifact: DaemonSessionArtifact,
  changes: readonly TurnOutputFileChange[],
  workspaceCwd?: string,
) {
  if (!isRenderedArtifact(artifact) || !artifact.workspacePath) {
    return undefined;
  }
  const change = changes.find((item) =>
    isSamePath(item.path, artifact.workspacePath, workspaceCwd),
  );
  if (!change) return undefined;
  return getFileChangePreviewContent(change);
}

export function getFileChangePreviewContent(change: TurnOutputFileChange) {
  for (let index = change.diffs.length - 1; index >= 0; index--) {
    const diff = change.diffs[index];
    if (diff?.fullContent) return diff.newText;
  }
  return undefined;
}

function isRenderedArtifact(artifact: DaemonSessionArtifact) {
  const path = artifact.workspacePath?.toLowerCase() ?? '';
  const mimeType = artifact.mimeType?.toLowerCase() ?? '';
  return (
    artifact.kind === 'html' ||
    isRenderedFilePath(path) ||
    mimeType === 'text/html' ||
    mimeType === 'text/markdown'
  );
}

export function isRenderedFilePath(value: string) {
  const path = value.toLowerCase();
  return (
    path.endsWith('.html') ||
    path.endsWith('.htm') ||
    path.endsWith('.md') ||
    path.endsWith('.markdown') ||
    getImageMimeTypeFromPath(path) !== undefined
  );
}

export function isDownloadableReviewFilePath(value: string) {
  return /\.(?:html?|md|markdown)$/i.test(value);
}

function canDownloadArtifact(
  artifact: DaemonSessionArtifact,
): artifact is DaemonSessionArtifact & { workspacePath: string } {
  return (
    artifact.storage === 'workspace' &&
    artifact.status === 'available' &&
    Boolean(artifact.workspacePath)
  );
}

export function canOpenWorkspaceArtifact(
  artifact: DaemonSessionArtifact,
): boolean {
  if (artifact.storage !== 'workspace') {
    return true;
  }
  return artifact.status === 'available' || artifact.status === 'changed';
}

export function getWorkspaceArtifactOpenBlockReason(
  artifact: DaemonSessionArtifact,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | undefined {
  if (canOpenWorkspaceArtifact(artifact)) {
    return undefined;
  }
  return artifact.workspacePath
    ? t('turnOutputs.artifactUnavailable', { path: artifact.workspacePath })
    : t('turnOutputs.artifactMissing');
}

export function displayPath(path: string, workspaceCwd?: string) {
  return stripWorkspacePath(path, workspaceCwd);
}
