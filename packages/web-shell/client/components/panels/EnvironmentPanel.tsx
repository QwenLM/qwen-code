import { useEffect, useRef, useState } from 'react';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import {
  BotIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  FileDiffIcon,
  FolderClosedIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  SquareActivityIcon,
  SquareTerminalIcon,
} from 'lucide-react';
import type { WebShellEnvironmentPanelItem } from '../../customization';
import { useI18n } from '../../i18n';
import { BranchPickerPopover } from '../BranchPickerPopover';
import styles from './EnvironmentPanel.module.css';

interface EnvironmentPanelProps {
  floating?: boolean;
  hidden?: boolean;
  workspaceCwd?: string;
  gitWorkspaceCwd?: string;
  gitCwd?: string;
  branch?: string;
  gitStatus?: DaemonWorkspaceGitStatus;
  tasks: readonly DaemonSessionTaskStatus[];
  agentTasks?: readonly EnvironmentAgentTask[];
  items?: readonly WebShellEnvironmentPanelItem[];
  onOpenGitDiff?: () => void;
  onOpenGitCommit?: () => void;
  onOpenAgent?: (task: DaemonSessionAgentTaskStatus) => void;
  onOpenTask: (task: DaemonSessionTaskStatus) => void;
  onDismiss?: () => void;
}

export type EnvironmentAgentTask = DaemonSessionAgentTaskStatus & {
  color?: string;
};

const DEFAULT_ENVIRONMENT_PANEL_ITEMS: readonly WebShellEnvironmentPanelItem[] =
  ['environment', 'subagents', 'backgroundTasks'];
const AGENT_COLORS: Readonly<Record<string, string>> = {
  red: '#e5484d',
  blue: 'var(--agent-blue-500)',
  green: 'var(--success-color)',
  yellow: '#d6a900',
  purple: 'var(--agent-purple-600)',
  orange: 'var(--accent-orange)',
  pink: '#d6409f',
  cyan: '#0e9888',
};

function taskLabel(task: DaemonSessionTaskStatus): string {
  switch (task.kind) {
    case 'agent':
      return task.label;
    case 'shell':
      return task.command;
    case 'monitor':
      return task.description;
  }
}

function taskIcon(task: DaemonSessionTaskStatus) {
  switch (task.kind) {
    case 'agent':
      return <BotIcon />;
    case 'shell':
      return <SquareTerminalIcon />;
    case 'monitor':
      return <SquareActivityIcon />;
  }
}

function taskStatusKey(status: DaemonSessionTaskStatus['status']) {
  return `tasks.${status}` as const;
}

function taskStatusIcon(status: DaemonSessionTaskStatus['status']) {
  if (status === 'completed') return <CircleCheckIcon />;
  if (status === 'running') {
    return <LoaderCircleIcon className={styles.statusRunning} />;
  }
  if (status === 'failed') return <CircleXIcon />;
  if (status === 'cancelled') return <CircleStopIcon />;
  return null;
}

function isForkAgent(task: EnvironmentAgentTask): boolean {
  return task.subagentType?.toLowerCase() === 'fork';
}

function agentDisplayName(task: EnvironmentAgentTask): string {
  if (!isForkAgent(task)) return task.label;
  return task.label.replace(/^fork:\s*/i, '').trim();
}

function agentColorValue(color: string | undefined): string {
  return (color && AGENT_COLORS[color]) || 'var(--muted-foreground)';
}

export function EnvironmentPanel({
  floating = false,
  hidden = false,
  workspaceCwd,
  gitWorkspaceCwd,
  gitCwd,
  branch,
  gitStatus,
  tasks,
  agentTasks,
  items = DEFAULT_ENVIRONMENT_PANEL_ITEMS,
  onOpenGitDiff,
  onOpenGitCommit,
  onOpenAgent,
  onOpenTask,
  onDismiss,
}: EnvironmentPanelProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  const agents: readonly EnvironmentAgentTask[] =
    agentTasks ??
    tasks.filter(
      (task): task is DaemonSessionAgentTaskStatus => task.kind === 'agent',
    );
  const backgroundTasks = tasks.filter((task) => task.kind !== 'agent');
  const [environmentExpanded, setEnvironmentExpanded] = useState(true);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const activeBranch = branch ?? gitStatus?.branch;

  useEffect(() => {
    if (hidden || !environmentExpanded || !gitWorkspaceCwd || !activeBranch) {
      setBranchPickerOpen(false);
    }
  }, [activeBranch, environmentExpanded, gitWorkspaceCwd, hidden]);

  useEffect(() => {
    if (!floating || hidden || !onDismiss || branchPickerOpen) return;
    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      if (
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.hasAttribute('data-web-shell-environment-toggle'),
          )
      ) {
        return;
      }
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target)
      ) {
        onDismiss();
      }
    };
    document.addEventListener('pointerdown', dismissOnOutsidePointerDown);
    return () =>
      document.removeEventListener('pointerdown', dismissOnOutsidePointerDown);
  }, [branchPickerOpen, floating, hidden, onDismiss]);

  const gitDetails = [
    gitStatus?.operation
      ? t(`git.operation.${gitStatus.operation}`)
      : undefined,
    gitStatus?.detached ? t('git.detached') : undefined,
    gitStatus?.staged
      ? t('git.staged', { count: gitStatus.staged })
      : undefined,
    gitStatus?.unstaged
      ? t('git.unstaged', { count: gitStatus.unstaged })
      : undefined,
    gitStatus?.untracked
      ? t('git.untracked', { count: gitStatus.untracked })
      : undefined,
    gitStatus?.conflicted
      ? t('git.conflicted', { count: gitStatus.conflicted })
      : undefined,
    gitStatus?.ahead ? t('git.ahead', { count: gitStatus.ahead }) : undefined,
    gitStatus?.behind
      ? t('git.behind', { count: gitStatus.behind })
      : undefined,
    gitStatus?.stashCount
      ? t('git.stash', { count: gitStatus.stashCount })
      : undefined,
  ].filter((detail): detail is string => Boolean(detail));

  return (
    <aside
      ref={panelRef}
      className={`${styles.panel} ${floating ? styles.floating : ''}`}
      aria-label={t('environment.title')}
      data-testid="environment-panel"
      data-floating={floating}
      hidden={hidden}
    >
      {items.includes('environment') && (
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionHeader}
            aria-expanded={environmentExpanded}
            onClick={() => setEnvironmentExpanded((expanded) => !expanded)}
          >
            <span>{t('environment.title')}</span>
            {!environmentExpanded && <ChevronRightIcon />}
          </button>
          {environmentExpanded && (
            <div className={styles.sectionContent}>
              <button
                type="button"
                className={styles.row}
                disabled={!onOpenGitDiff}
                onClick={onOpenGitDiff}
              >
                <FileDiffIcon />
                <span>{t('environment.changes')}</span>
                <span className={styles.value}>
                  {gitStatus === undefined
                    ? t('environment.unavailable')
                    : gitDetails.length > 0
                      ? gitDetails.join(' · ')
                      : t('environment.clean')}
                </span>
              </button>
              <div className={styles.row} title={workspaceCwd}>
                <FolderClosedIcon className={styles.workspaceIcon} />
                <span>{t('environment.workspace')}</span>
                <span className={styles.value}>
                  {workspaceCwd?.split(/[/\\]/).filter(Boolean).at(-1) ??
                    t('environment.unavailable')}
                </span>
              </div>
              {gitWorkspaceCwd && activeBranch ? (
                <BranchPickerPopover
                  open={branchPickerOpen}
                  onOpenChange={setBranchPickerOpen}
                  workspaceCwd={gitWorkspaceCwd}
                  gitCwd={gitCwd}
                  side="left"
                  status={gitStatus}
                  onOpenDiff={onOpenGitDiff}
                  onOpenCommit={onOpenGitCommit}
                >
                  <button
                    type="button"
                    className={styles.row}
                    title={activeBranch}
                  >
                    <GitBranchIcon />
                    <span className={styles.branchName}>{activeBranch}</span>
                    <ChevronRightIcon className={styles.rowActionIcon} />
                  </button>
                </BranchPickerPopover>
              ) : (
                <div className={styles.row} title={activeBranch ?? undefined}>
                  <GitBranchIcon />
                  <span className={styles.branchName}>
                    {activeBranch ?? t('environment.unavailable')}
                  </span>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {items.includes('subagents') && agents.length > 0 && (
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionHeader}
            aria-expanded={agentsExpanded}
            onClick={() => setAgentsExpanded((expanded) => !expanded)}
          >
            <span>{t('environment.agents')}</span>
            {!agentsExpanded && <ChevronRightIcon />}
          </button>
          {agentsExpanded && (
            <ul className={styles.tasks}>
              {agents.map((task, index) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={styles.task}
                    disabled={!onOpenAgent}
                    onClick={() => onOpenAgent?.(task)}
                  >
                    <span className={styles.taskLabel}>
                      {!isForkAgent(task) && (
                        <span
                          className={styles.agentColor}
                          data-agent-color={task.color ?? 'default'}
                          style={{
                            backgroundColor: agentColorValue(task.color),
                          }}
                          aria-hidden="true"
                        />
                      )}
                      {isForkAgent(task) && (
                        <span className={styles.agentTag}>fork</span>
                      )}
                      <span className={styles.agentName}>
                        {(() => {
                          const name = agentDisplayName(task).trim();
                          return name && name.toLowerCase() !== 'agent'
                            ? name
                            : t('environment.unnamedAgent', {
                                index: index + 1,
                              });
                        })()}
                      </span>
                    </span>
                    <span
                      className={styles.taskStatus}
                      data-status={task.status}
                    >
                      {taskStatusIcon(task.status)}
                      {t(taskStatusKey(task.status))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {items.includes('backgroundTasks') && backgroundTasks.length > 0 && (
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionHeader}
            aria-expanded={tasksExpanded}
            onClick={() => setTasksExpanded((expanded) => !expanded)}
          >
            <span>{t('tasks.title')}</span>
            {!tasksExpanded && <ChevronRightIcon />}
          </button>
          {tasksExpanded && (
            <ul className={styles.tasks}>
              {backgroundTasks.map((task) => (
                <li key={`${task.kind}:${task.id}`}>
                  <button
                    type="button"
                    className={styles.task}
                    onClick={() => onOpenTask(task)}
                  >
                    <span className={styles.taskIcon}>{taskIcon(task)}</span>
                    <span className={styles.taskLabel}>
                      <span className={styles.taskName} title={taskLabel(task)}>
                        {taskLabel(task)}
                      </span>
                    </span>
                    <span
                      className={styles.taskStatus}
                      data-status={task.status}
                    >
                      {taskStatusIcon(task.status)}
                      {t(taskStatusKey(task.status))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </aside>
  );
}
