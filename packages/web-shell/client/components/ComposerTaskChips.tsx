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
import {
  BotIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  LoaderCircleIcon,
  SquareActivityIcon,
  SquareTerminalIcon,
  WorkflowIcon,
} from 'lucide-react';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import { useI18n } from '../i18n';
import { useSharedNow } from '../hooks/useSharedNow';
import { getShadowAwareActiveElement, isFocusUnclaimed } from '../utils/dom';
import {
  explainDisplayLabel,
  getComposerTaskChipGroups,
  type ComposerChipTask,
  type ComposerTaskChipGroup,
  type ComposerTaskChipKind,
} from '../utils/composerTasks';
import { formatRuntime } from '../utils/formatRuntime';
import styles from './ComposerTaskChips.module.css';

export interface ComposerTaskChipsHandle {
  /** Focus the first chip; false when there is none to focus. */
  focus(): boolean;
}

export interface ComposerTaskChipsProps {
  tasks: readonly ComposerChipTask[];
  /** Whether background agents get a chip (hosts without agent surfaces opt out). */
  includeAgents: boolean;
  /** Select a task; direct single-chip activation also allows collapsing it. */
  onSelectTask: (task: ComposerChipTask, toggle?: boolean) => void;
  /** Whether a single-task chip's target panel or dialog is currently open. */
  isTaskOpen?: (task: ComposerChipTask) => boolean;
  /** Ask the model to explain the task as a side question, without opening it. */
  onExplainTask?: (task: DaemonSessionTaskWithWorkflowStatus) => void;
  /** Hand focus back to the composer, optionally with a typed character. */
  onReturnToInput?: (text?: string) => void;
}

const LABEL_KEYS: Record<ComposerTaskChipKind, [string, string]> = {
  workflow: ['tasks.pill.workflow', 'tasks.pill.workflows'],
  agent: ['tasks.pill.agent', 'tasks.pill.agents'],
  session: ['tasks.pill.session', 'tasks.pill.sessions'],
  shell: ['tasks.pill.shell', 'tasks.pill.shells'],
  monitor: ['tasks.pill.monitor', 'tasks.pill.monitors'],
};

function kindIcon(kind: ComposerTaskChipKind): ReactNode | undefined {
  switch (kind) {
    case 'workflow':
      return <WorkflowIcon aria-hidden="true" />;
    case 'agent':
      return <BotIcon aria-hidden="true" />;
    case 'session':
      return undefined;
    case 'shell':
      return <SquareTerminalIcon aria-hidden="true" />;
    case 'monitor':
      return <SquareActivityIcon aria-hidden="true" />;
  }
}

function taskLabel(task: ComposerChipTask): string {
  switch (task.kind) {
    case 'shell':
      return task.command;
    case 'monitor':
      return task.description;
    case 'agent':
    case 'session':
    case 'workflow':
      return task.label;
  }
}

/**
 * The session's own background task, which the model can explain; a message
 * sent to another session is not one of them.
 */
function isChildTask(
  task: ComposerChipTask,
): task is DaemonSessionTaskWithWorkflowStatus {
  return task.kind !== 'session';
}

/** A session the message went to is waiting on a permission or a question. */
function isWaiting(task: ComposerChipTask): boolean {
  return task.kind === 'session' && task.waitingForInput === true;
}

function isMoving(task: ComposerChipTask): boolean {
  return task.status === 'running' || task.status === 'pausing';
}

function TaskElapsed({ task, now }: { task: ComposerChipTask; now: number }) {
  // A paused task's clock stopped; the snapshot's runtime is the honest number.
  const ms = isMoving(task)
    ? Math.max(task.runtimeMs, now - task.startTime)
    : task.runtimeMs;
  return <span className={styles.elapsed}>{formatRuntime(ms)}</span>;
}

/**
 * Chips above the composer for this session's unfinished background work —
 * one per kind ("1 workflow", "2 shells"). A chip that stands for a single
 * task toggles its detail; one that stands for several opens a list above the
 * row to pick from and collapses that list on repeat activation. Finished
 * tasks have no chip, so the row clears itself.
 */
export const ComposerTaskChips = forwardRef<
  ComposerTaskChipsHandle,
  ComposerTaskChipsProps
>(function ComposerTaskChips(
  {
    tasks,
    includeAgents,
    onSelectTask,
    isTaskOpen,
    onExplainTask,
    onReturnToInput,
  },
  ref,
) {
  const { t, isRtl } = useI18n();
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
  const pointerDownInsideRef = useRef(false);
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
    // A chip "?" unmounts when its group grows; reclaim focus to the owning
    // group's chip, not to whichever group happens to sort first — and not
    // to a different group whose list happens to be open. Row "?" buttons
    // carry no kind attribute, so openKind stays as their fallback.
    const focusedKind =
      focused.element.getAttribute('data-explain-kind') ??
      focused.element.getAttribute('data-kind');
    const chip =
      (focusedKind &&
        chipRefs.current.get(focusedKind as ComposerTaskChipKind)) ||
      (openKind && chipRefs.current.get(openKind)) ||
      chipRefs.current.get(groups[0]?.kind);
    if (chip) chip.focus({ preventScroll: true });
    else onReturnToInput?.();
  }, [groups, openKind, onReturnToInput]);

  const listOpen = Boolean(openGroup);

  // The list closes on a click anywhere outside the chip row.
  useEffect(() => {
    if (!listOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.composedPath().includes(rootRef.current)) {
        return;
      }
      pointerDownInsideRef.current = false;
      focusedElementRef.current = null;
      setOpenKind(null);
    };
    const clearInsidePointerDown = () => {
      if (!pointerDownInsideRef.current) return;
      pointerDownInsideRef.current = false;
      const activeElement =
        getShadowAwareActiveElement(rootRef.current) ?? document.activeElement;
      if (rootRef.current?.contains(activeElement)) return;
      focusedElementRef.current = null;
      setOpenKind(null);
    };
    const closeOnWindowBlur = () => {
      pointerDownInsideRef.current = false;
      focusedElementRef.current = null;
      setOpenKind(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    document.addEventListener('pointerup', clearInsidePointerDown, true);
    document.addEventListener('pointercancel', clearInsidePointerDown, true);
    window.addEventListener('blur', closeOnWindowBlur);
    return () => {
      pointerDownInsideRef.current = false;
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
      document.removeEventListener('pointerup', clearInsidePointerDown, true);
      document.removeEventListener(
        'pointercancel',
        clearInsidePointerDown,
        true,
      );
      window.removeEventListener('blur', closeOnWindowBlur);
    };
  }, [listOpen]);

  if (groups.length === 0) return null;

  const selectTask = (task: ComposerChipTask, toggle = false) => {
    chipRefs.current.get(task.kind)?.focus({ preventScroll: true });
    setOpenKind(null);
    if (toggle) {
      onSelectTask(task, true);
    } else {
      onSelectTask(task);
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setOpenKind(null);
    if (openGroup) {
      chipRefs.current.get(openGroup.kind)?.focus({ preventScroll: true });
    }
  };

  const explainButton = (
    task: DaemonSessionTaskWithWorkflowStatus,
    className: string,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void,
    explainKind?: ComposerTaskChipKind,
  ) => (
    <button
      type="button"
      className={className}
      aria-label={t('tasks.explain.aria', {
        label: explainDisplayLabel(taskLabel(task)),
      })}
      title={t('tasks.explain.tooltip')}
      data-testid="composer-task-explain"
      data-explain-kind={explainKind}
      onClick={() => onExplainTask?.(task)}
      onKeyDown={onKeyDown}
    >
      <CircleHelpIcon aria-hidden="true" />
    </button>
  );

  const activateChip = (group: ComposerTaskChipGroup) => {
    if (group.tasks.length === 1) {
      selectTask(group.tasks[0], true);
      return;
    }
    if (openKind === group.kind) {
      setOpenKind(null);
      chipRefs.current.get(group.kind)?.focus({ preventScroll: true });
      return;
    }
    setOpenKind(group.kind);
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
      const step =
        event.key === 'ArrowRight' ? (isRtl ? -1 : 1) : isRtl ? 1 : -1;
      focusChipAt(index + step);
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

  // The chip "?" sits after its chip in reading order, so the chip's index
  // arithmetic would step the back key past the owning chip; that key returns
  // to the chip instead (ArrowLeft in LTR, ArrowRight in RTL).
  const handleChipExplainKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    kind: ComposerTaskChipKind,
    index: number,
  ) => {
    if (event.key === (isRtl ? 'ArrowRight' : 'ArrowLeft')) {
      event.preventDefault();
      chipRefs.current.get(kind)?.focus({ preventScroll: true });
      return;
    }
    handleChipKeyDown(event, index);
  };

  const groupLabel = (group: ComposerTaskChipGroup) => {
    const waiting = group.tasks.filter(isWaiting).length;
    if (waiting > 0) return t('tasks.pill.sessionWaiting', { count: waiting });
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
      onPointerDown={() => {
        if (openGroup) pointerDownInsideRef.current = true;
      }}
      onMouseDown={(event) => {
        if (openGroup) event.preventDefault();
      }}
      onFocus={(event) => {
        focusedElementRef.current = {
          element: event.target,
          root: event.target.getRootNode(),
        };
      }}
      onBlur={(event) => {
        if (
          (pointerDownInsideRef.current &&
            !(event.relatedTarget instanceof Node)) ||
          (event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget))
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
            <div
              key={task.id}
              className={styles.listRow}
              data-testid="composer-task-row"
            >
              <button
                type="button"
                className={styles.listRowMain}
                data-testid="composer-task-open"
                onClick={() => selectTask(task)}
                onKeyDown={handleListKeyDown}
              >
                {kindIcon(openGroup.kind) && (
                  <span className={styles.rowIcon}>
                    {kindIcon(openGroup.kind)}
                  </span>
                )}
                <span className={styles.rowLabel} title={taskLabel(task)}>
                  {taskLabel(task)}
                </span>
                {isWaiting(task) ? (
                  <span className={styles.waitingTag}>
                    {t('tasks.waitingForInput')}
                  </span>
                ) : (
                  <TaskElapsed task={task} now={now} />
                )}
              </button>
              {onExplainTask &&
                isChildTask(task) &&
                explainButton(
                  task,
                  `${styles.explainButton} ${styles.rowExplain}`,
                  handleListKeyDown,
                )}
            </div>
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
          const waiting = group.tasks.some(isWaiting);
          const multiple = group.tasks.length > 1;
          const chip = (
            <button
              ref={(node) => {
                if (node) chipRefs.current.set(group.kind, node);
                else chipRefs.current.delete(group.kind);
              }}
              type="button"
              className={styles.chip}
              data-kind={group.kind}
              data-waiting={waiting ? '' : undefined}
              aria-expanded={
                multiple
                  ? openGroup === group
                  : isTaskOpen
                    ? isTaskOpen(group.tasks[0])
                    : undefined
              }
              aria-haspopup={multiple ? 'true' : undefined}
              title={
                multiple ? undefined : taskLabel(group.tasks[0]) || undefined
              }
              onMouseDown={(event) => {
                if (openGroup) event.preventDefault();
              }}
              onClick={() => activateChip(group)}
              onKeyDown={(event) => handleChipKeyDown(event, index)}
            >
              <span className={styles.state} aria-hidden="true">
                {waiting ? (
                  <CircleAlertIcon />
                ) : moving ? (
                  <LoaderCircleIcon className={styles.spinning} />
                ) : (
                  <CirclePauseIcon />
                )}
              </span>
              <span className={styles.chipLabel}>{groupLabel(group)}</span>
            </button>
          );
          // The wrapper is unconditional so the chip node keeps its identity
          // when a group crosses the 1↔2 task boundary; remounting it would
          // drop keyboard focus onto another chip.
          return (
            <span key={group.kind} className={styles.chipWrap}>
              {chip}
              {!multiple &&
                onExplainTask &&
                isChildTask(group.tasks[0]) &&
                explainButton(
                  group.tasks[0],
                  `${styles.explainButton} ${styles.chipExplain}`,
                  (event) => handleChipExplainKeyDown(event, group.kind, index),
                  group.kind,
                )}
            </span>
          );
        })}
      </div>
    </div>
  );
});
