import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../../adapters/types';
import type { DaemonWorkspaceActions } from '@qwen-code/webui/daemon-react-sdk';
import { memo, useState } from 'react';
import { useI18n } from '../../i18n';
import { describeCron } from '../dialogs/scheduledTasksSchedule';
import {
  artifactKindLabel,
  formatArtifactSize,
  isSamePath,
  stripWorkspacePath,
} from './artifactUtils';
import { LineStats, sumLineStats } from './LineStats';
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
  display?: string;
}

export type TurnOutputKind = 'file' | 'artifact' | 'scheduled_task';

export const TURN_OUTPUT_KINDS: readonly TurnOutputKind[] = [
  'file',
  'artifact',
  'scheduled_task',
];

export type TurnOutputOpenRequest =
  | {
      id: 'review';
      kind: 'review';
      title: string;
      turnId: string;
      changes: readonly TurnOutputFileChange[];
      selectedPath?: string;
    }
  | {
      id: string;
      kind: 'artifact';
      title: string;
      turnId: string;
      artifactId: string;
      artifact: DaemonSessionArtifact;
      workspaceActions?: DaemonWorkspaceActions;
      previewContent?: string;
    }
  | {
      id: string;
      kind: 'scheduled_task';
      title: string;
      turnId: string;
      task: TurnOutputScheduledTask;
      workspaceActions?: DaemonWorkspaceActions;
    }
  | {
      id: string;
      kind: 'subagent';
      title: string;
      turnId: string;
      tool: ACPToolCall;
      sessionId: string;
      workspaceCwd?: string;
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
}: TurnOutputsProps) {
  const { t } = useI18n();
  const [showAllChanges, setShowAllChanges] = useState(false);
  if (
    changes.length === 0 &&
    artifacts.length === 0 &&
    scheduledTasks.length === 0
  ) {
    return null;
  }
  const visibleChanges = showAllChanges ? changes : changes.slice(0, 3);
  const remainingChanges = changes.length - 3;
  const totals = sumLineStats(changes);
  const openReview = (selectedPath?: string) => {
    if (onOpenRequest) {
      onOpenRequest({
        id: 'review',
        kind: 'review',
        title: t('turnOutputs.review'),
        turnId,
        changes,
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
        artifact,
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
        task,
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
            <div>
              <div className={styles.title}>
                {t('turnOutputs.filesEdited', { count: changes.length })}
              </div>
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

      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          onOpen={() => openArtifact(artifact)}
        />
      ))}

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
}: {
  artifact: DaemonSessionArtifact;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const size = formatArtifactSize(artifact.sizeBytes);
  return (
    <div className={styles.card}>
      <div className={styles.summary}>
        <span className={styles.icon} aria-hidden="true">
          <DocumentIcon />
        </span>
        <div className={styles.artifactInfo}>
          <div className={styles.title}>{artifact.title}</div>
          <div className={styles.artifactMeta}>
            {[artifactKindLabel(artifact.kind), size]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.reviewButton}
            onClick={onOpen}
            title={artifact.title}
          >
            {t('common.open')}
          </button>
        </div>
      </div>
    </div>
  );
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
  if (artifact.kind !== 'html' || !artifact.workspacePath) return undefined;
  const change = changes.find((item) =>
    isSamePath(item.path, artifact.workspacePath, workspaceCwd),
  );
  if (!change) return undefined;
  for (let index = change.diffs.length - 1; index >= 0; index--) {
    const diff = change.diffs[index];
    if (diff?.fullContent) return diff.newText;
  }
  return undefined;
}

export function displayPath(path: string, workspaceCwd?: string) {
  return stripWorkspacePath(path, workspaceCwd);
}
