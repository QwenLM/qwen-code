import {
  BotIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  CircleStopIcon,
  CircleXIcon,
  LoaderCircleIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import type { EnvironmentAgentTask } from '../panels/EnvironmentPanel';
import { Skeleton } from '../ui/skeleton';
import styles from './AgentWorkflow.module.css';

const NODE_WIDTH = 184;
const NODE_HEIGHT = 68;
const HORIZONTAL_GAP = 32;
const VERTICAL_GAP = 72;
const PADDING = 32;
const MAIN_ID = '__main__';

interface Position {
  x: number;
  y: number;
}

function positionStyle(position: Position | undefined) {
  return position ? { left: position.x, top: position.y } : undefined;
}

function layoutTasks(tasks: readonly EnvironmentAgentTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, EnvironmentAgentTask[]>();
  for (const task of tasks) {
    const parentId =
      task.parentAgentId && byId.has(task.parentAgentId)
        ? task.parentAgentId
        : MAIN_ID;
    const siblings = children.get(parentId) ?? [];
    siblings.push(task);
    children.set(parentId, siblings);
  }

  const widths = new Map<string, number>();
  const measuring = new Set<string>();
  const measure = (id: string): number => {
    const measured = widths.get(id);
    if (measured !== undefined) return measured;
    if (measuring.has(id)) return NODE_WIDTH;
    measuring.add(id);
    const descendants = children.get(id) ?? [];
    const width = Math.max(
      NODE_WIDTH,
      descendants.reduce((sum, child) => sum + measure(child.id), 0) +
        Math.max(0, descendants.length - 1) * HORIZONTAL_GAP,
    );
    measuring.delete(id);
    widths.set(id, width);
    return width;
  };

  const positions = new Map<string, Position>();
  const visited = new Set<string>();
  const place = (id: string, left: number, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const width = measure(id);
    positions.set(id, {
      x: left + (width - NODE_WIDTH) / 2,
      y: PADDING + depth * (NODE_HEIGHT + VERTICAL_GAP),
    });
    let childLeft = left;
    for (const child of children.get(id) ?? []) {
      place(child.id, childLeft, depth + 1);
      childLeft += measure(child.id) + HORIZONTAL_GAP;
    }
  };

  place(MAIN_ID, PADDING, 0);
  let nextRootLeft = PADDING + measure(MAIN_ID) + HORIZONTAL_GAP;
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    place(task.id, nextRootLeft, 1);
    nextRootLeft += measure(task.id) + HORIZONTAL_GAP;
  }

  return {
    positions,
    width: Math.max(
      360,
      ...Array.from(positions.values(), ({ x }) => x + NODE_WIDTH + PADDING),
    ),
    height: Math.max(
      220,
      ...Array.from(positions.values(), ({ y }) => y + NODE_HEIGHT + PADDING),
    ),
  };
}

function displayName(
  task: EnvironmentAgentTask,
  index: number,
  unnamed: (index: number) => string,
) {
  const name = (
    task.subagentType?.toLowerCase() === 'fork'
      ? task.label.replace(/^fork:\s*/i, '')
      : task.label
  ).trim();
  return name && name.toLowerCase() !== 'agent' ? name : unnamed(index + 1);
}

function taskDuration(task: EnvironmentAgentTask, now: number) {
  if (task.status === 'running') {
    return task.startTime > 0
      ? Math.max(task.runtimeMs, now - task.startTime)
      : task.runtimeMs;
  }
  return task.endTime === undefined
    ? task.runtimeMs
    : Math.max(0, task.endTime - task.startTime) || task.runtimeMs;
}

export function AgentWorkflow({
  tasks,
  loading = false,
  error,
  onOpenAgent,
}: {
  tasks: readonly EnvironmentAgentTask[];
  loading?: boolean;
  error?: string;
  onOpenAgent?: (task: EnvironmentAgentTask) => void;
}) {
  const { t } = useI18n();
  const layout = useMemo(() => layoutTasks(tasks), [tasks]);
  const hasRunningTask = tasks.some((task) => task.status === 'running');
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!hasRunningTask) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask]);

  if (loading) {
    return (
      <div
        className={styles.loading}
        role="status"
        aria-label={t('common.loading')}
      >
        <Skeleton className="h-[68px] w-[184px] rounded-xl" />
        <Skeleton className="h-[68px] w-[184px] rounded-xl" />
      </div>
    );
  }
  if (error) {
    return <div className={styles.empty}>{error}</div>;
  }
  if (tasks.length === 0) {
    return <div className={styles.empty}>{t('workflow.empty')}</div>;
  }

  return (
    <div className={styles.viewport} data-testid="agent-workflow">
      <div
        className={styles.canvas}
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className={styles.edges}
          data-testid="agent-workflow-edges"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          {tasks.map((task) => {
            const source =
              layout.positions.get(task.parentAgentId ?? '') ??
              layout.positions.get(MAIN_ID)!;
            const target = layout.positions.get(task.id)!;
            const startX = source.x + NODE_WIDTH / 2;
            const startY = source.y + NODE_HEIGHT;
            const endX = target.x + NODE_WIDTH / 2;
            const endY = target.y;
            const middleY = (startY + endY) / 2;
            return (
              <path
                key={task.id}
                className={task.status === 'running' ? styles.edgeRunning : ''}
                d={`M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`}
              />
            );
          })}
        </svg>
        <div
          className={`${styles.node} ${styles.mainNode}`}
          style={positionStyle(layout.positions.get(MAIN_ID))}
        >
          <BotIcon />
          <span>{t('workflow.mainAgent')}</span>
        </div>
        {tasks.map((task, index) => (
          <button
            key={task.id}
            type="button"
            className={styles.node}
            data-status={task.status}
            style={positionStyle(layout.positions.get(task.id))}
            onClick={() => onOpenAgent?.(task)}
            disabled={!onOpenAgent}
            title={task.description || task.label}
          >
            <span className={styles.nodeTitle}>
              <BotIcon />
              <span>
                {displayName(task, index, (agentIndex) =>
                  t('environment.unnamedAgent', { index: agentIndex }),
                )}
              </span>
            </span>
            <span className={styles.nodeMeta}>
              <span className={styles.status} data-status={task.status}>
                {task.status === 'completed' && <CircleCheckIcon />}
                {task.status === 'running' && (
                  <LoaderCircleIcon className={styles.statusRunning} />
                )}
                {task.status === 'paused' && <CirclePauseIcon />}
                {task.status === 'failed' && <CircleXIcon />}
                {task.status === 'cancelled' && <CircleStopIcon />}
                {t(`tasks.${task.status}`)}
              </span>
              <span className={styles.duration}>
                {formatDuration(taskDuration(task, now))}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
