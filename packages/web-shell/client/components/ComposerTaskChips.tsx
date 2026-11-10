import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import {
  BotIcon,
  CirclePauseIcon,
  LoaderCircleIcon,
  SquareActivityIcon,
  SquareTerminalIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useSharedNow } from '../hooks/useSharedNow';
import {
  getComposerTaskChipGroups,
  type ComposerTaskChipGroup,
  type ComposerTaskChipKind,
} from '../utils/composerTasks';
import { formatRuntime } from '../utils/formatRuntime';
import { isFocusUnclaimed } from '../utils/dom';
import styles from './ComposerTaskChips.module.css';

export interface ComposerTaskChipsHandle {
  /** Focus the first chip; false when there is none to focus. */
  focus(): boolean;
}

export interface ComposerTaskChipsProps {
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[];
  /** Whether background agents get a chip (hosts without agent surfaces opt out). */
  includeAgents: boolean;
  /** Open the task: locate a workflow in the transcript, open a shell's output, … */
  onSelectTask: (task: DaemonSessionTaskWithWorkflowStatus) => void;
  /** Hand focus back to the composer, optionally with a typed character. */
  onReturnToInput?: (text?: string) => void;
}

const LABEL_KEYS: Record<ComposerTaskChipKind, [string, string]> = {
  workflow: ['tasks.pill.workflow', 'tasks.pill.workflows'],
  agent: ['tasks.pill.agent', 'tasks.pill.agents'],
  shell: ['tasks.pill.shell', 'tasks.pill.shells'],
  monitor: ['tasks.pill.monitor', 'tasks.pill.monitors'],
};

function kindIcon(kind: ComposerTaskChipKind): ReactNode {
  switch (kind) {
    case 'workflow':
      return <WorkflowIcon aria-hidden="true" />;
    case 'agent':
      return <BotIcon aria-hidden="true" />;
    case 'shell':
      return <SquareTerminalIcon aria-hidden="true" />;
    case 'monitor':
      return <SquareActivityIcon aria-hidden="true" />;
  }
}

function taskLabel(task: DaemonSessionTaskWithWorkflowStatus): string {
  switch (task.kind) {
    case 'shell':
      return task.command;
    case 'monitor':
      return task.description;
    case 'agent':
    case 'workflow':
      return task.label;
  }
}

function isMoving(task: DaemonSessionTaskWithWorkflowStatus): boolean {
  return task.status === 'running' || task.status === 'pausing';
}

function TaskElapsed({
  task,
  now,
}: {
  task: DaemonSessionTaskWithWorkflowStatus;
  now: number;
}) {
  // A paused task's clock stopped; the snapshot's runtime is the honest number.
  const ms = isMoving(task)
    ? Math.max(task.runtimeMs, now - task.startTime)
    : task.runtimeMs;
  return <span className={styles.elapsed}>{formatRuntime(ms)}</span>;
}

/**
 * Chips above the composer for this session's unfinished background work —
 * one per kind ("1 workflow", "2 shells"). A chip that stands for a single
 * task opens it directly; one that stands for several opens a list above the
 * row to pick from. Finished tasks have no chip, so the row clears itself.
 */
export const ComposerTaskChips = forwardRef<
  ComposerTaskChipsHandle,
  ComposerTaskChipsProps
>(function ComposerTaskChips(
  { tasks, includeAgents, onSelectTask, onReturnToInput },
  ref,
) {
  const { t } = useI18n();
  const groups = useMemo(
    () => getComposerTaskChipGroups(tasks, { includeAgents }),
    [includeAgents, tasks],
  );
  const [openKind, setOpenKind] = useState<ComposerTaskChipKind | null>(null);
  const openGroup: ComposerTaskChipGroup | undefined = groups.find(
    (group) => group.kind === openKind && group.tasks.length > 1,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<ComposerTaskChipKind, HTMLButtonElement>());
  const focusedElementRef = useRef<{ element: HTMLElement; root: Node } | null>(
    null,
  );
  const now = useSharedNow(Boolean(openGroup));

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        const first = groups[0];
        const chip = first ? chipRefs.current.get(first.kind) : undefined;
        if (!chip) return false;
        chip.focus({ preventScroll: true });
        return true;
      },
    }),
    [groups],
  );

  // A list whose group shrank to one task (or vanished) closes for good,
  // rather than popping back open if the group grows again.
  useEffect(() => {
    if (openKind && !openGroup) setOpenKind(null);
  }, [openGroup, openKind]);

  useEffect(() => {
    if (openKind) {
      listRef.current?.querySelector('button')?.focus({ preventScroll: true });
    }
  }, [openKind]);

  useLayoutEffect(() => {
    const focused = focusedElementRef.current;
    if (!focused || focused.element.isConnected) return;
    focusedElementRef.current = null;
    if (!isFocusUnclaimed(focused.root)) return;
    const chip =
      (openKind && chipRefs.current.get(openKind)) ||
      chipRefs.current.get(groups[0]?.kind);
    if (chip) chip.focus({ preventScroll: true });
    else onReturnToInput?.();
  }, [groups, openKind, onReturnToInput]);

  // The list closes on a click anywhere outside the chip row.
  useEffect(() => {
    if (!openGroup) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target)
      ) {
        return;
      }
      focusedElementRef.current = null;
      setOpenKind(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
  }, [openGroup]);

  if (groups.length === 0) return null;

  const selectTask = (task: DaemonSessionTaskWithWorkflowStatus) => {
    chipRefs.current.get(task.kind)?.focus({ preventScroll: true });
    setOpenKind(null);
    onSelectTask(task);
  };

  const activateChip = (group: ComposerTaskChipGroup) => {
    if (group.tasks.length === 1) {
      selectTask(group.tasks[0]);
      return;
    }
    setOpenKind((current) => (current === group.kind ? null : group.kind));
  };

  const focusChipAt = (index: number) => {
    const group = groups[(index + groups.length) % groups.length];
    chipRefs.current.get(group.kind)?.focus({ preventScroll: true });
  };

  const handleChipKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusChipAt(index + (event.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    if (event.key === 'Escape' && openGroup) {
      event.preventDefault();
      event.stopPropagation();
      setOpenKind(null);
      return;
    }
    // The chips sit right above the composer: Down (or Esc) drops back into it.
    if (event.key === 'ArrowDown' || event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpenKind(null);
      onReturnToInput?.();
      return;
    }
    if (
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      setOpenKind(null);
      onReturnToInput?.(event.key);
    }
  };

  const groupLabel = (group: ComposerTaskChipGroup) => {
    const [singular, plural] = LABEL_KEYS[group.kind];
    return t(group.tasks.length === 1 ? singular : plural, {
      count: group.tasks.length,
    });
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-web-shell-composer-task-chips=""
      data-testid="composer-task-chips"
      onFocus={(event) => {
        focusedElementRef.current = {
          element: event.target,
          root: event.target.getRootNode(),
        };
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        focusedElementRef.current = null;
        setOpenKind(null);
      }}
    >
      {openGroup && (
        <div
          ref={listRef}
          className={styles.list}
          role="group"
          aria-label={groupLabel(openGroup)}
          data-testid="composer-task-list"
        >
          <div className={styles.listTitle}>{groupLabel(openGroup)}</div>
          {openGroup.tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={styles.listRow}
              onClick={() => selectTask(task)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpenKind(null);
                  chipRefs.current
                    .get(openGroup.kind)
                    ?.focus({ preventScroll: true });
                }
              }}
            >
              <span className={styles.rowIcon}>{kindIcon(openGroup.kind)}</span>
              <span className={styles.rowLabel} title={taskLabel(task)}>
                {taskLabel(task)}
              </span>
              <TaskElapsed task={task} now={now} />
            </button>
          ))}
        </div>
      )}
      <div
        className={styles.chips}
        role="toolbar"
        aria-label={t('tasks.title')}
      >
        {groups.map((group, index) => {
          const moving = group.tasks.some(isMoving);
          const multiple = group.tasks.length > 1;
          return (
            <button
              key={group.kind}
              ref={(node) => {
                if (node) chipRefs.current.set(group.kind, node);
                else chipRefs.current.delete(group.kind);
              }}
              type="button"
              className={styles.chip}
              data-kind={group.kind}
              aria-expanded={multiple ? openGroup === group : undefined}
              aria-haspopup={multiple ? 'true' : undefined}
              title={
                multiple ? undefined : taskLabel(group.tasks[0]) || undefined
              }
              onClick={() => activateChip(group)}
              onKeyDown={(event) => handleChipKeyDown(event, index)}
            >
              <span className={styles.state} aria-hidden="true">
                {moving ? (
                  <LoaderCircleIcon className={styles.spinning} />
                ) : (
                  <CirclePauseIcon />
                )}
              </span>
              <span className={styles.chipLabel}>{groupLabel(group)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
