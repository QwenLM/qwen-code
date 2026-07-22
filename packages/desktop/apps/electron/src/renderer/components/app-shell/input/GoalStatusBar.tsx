import * as React from 'react';
import { Check, Pause, Pencil, Play, Target, Trash2, X } from 'lucide-react';
import type {
  GoalActivity,
  GoalControlRequest,
  GoalSnapshotV2,
  GoalStatus,
} from '../../../../shared/types';
import { cn } from '@/lib/utils';

export interface GoalStatusBarLabels {
  status: Record<GoalStatus, string>;
  activity: Record<GoalActivity, string>;
  edit: string;
  pause: string;
  resume: string;
  clear: string;
  save: string;
  cancel: string;
  objective: string;
  elapsed: string;
}

interface GoalStatusBarProps {
  snapshot: GoalSnapshotV2;
  labels: GoalStatusBarLabels;
  onControl: (request: GoalControlRequest) => Promise<void>;
  onError?: (error: unknown) => void;
  className?: string;
}

export function formatGoalElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function getGoalElapsedMs(
  snapshot: GoalSnapshotV2,
  now: number,
): number {
  const goal = snapshot.goal;
  if (!goal) return 0;
  return (
    goal.activeTimeMs +
    (goal.status === 'active' ? Math.max(0, now - goal.updatedAt) : 0)
  );
}

function statusTone(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return 'bg-success';
    case 'complete':
      return 'bg-info';
    case 'blocked':
    case 'usage_limited':
      return 'bg-warning';
    case 'paused':
      return 'bg-foreground/35';
  }
}

const actionClassName =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';

export function GoalStatusBar({
  snapshot,
  labels,
  onControl,
  onError,
  className,
}: GoalStatusBarProps) {
  const goal = snapshot.goal;
  const [now, setNow] = React.useState(() => Date.now());
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(goal?.objective ?? '');
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const goalId = goal?.goalId;
  const goalStatus = goal?.status;
  const goalUpdatedAt = goal?.updatedAt;

  React.useEffect(() => {
    if (goalStatus !== 'active') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [goalId, goalStatus, goalUpdatedAt]);

  React.useEffect(() => {
    if (!editing) setDraft(goal?.objective ?? '');
  }, [editing, goal?.objective]);

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!goal || goal.status === 'complete') return null;

  const expected = {
    expectedGoalId: goal.goalId,
    expectedRevision: goal.revision,
  };
  const runControl = async (request: GoalControlRequest) => {
    setPendingAction(request.action);
    try {
      await onControl(request);
      if (request.action === 'edit') setEditing(false);
    } catch (error) {
      onError?.(error);
    } finally {
      setPendingAction(null);
    }
  };
  const objective = draft.trim();
  const canSave =
    objective.length > 0 && objective !== goal.objective && !pendingAction;
  const canResume =
    goal.status === 'paused' ||
    goal.status === 'blocked' ||
    goal.status === 'usage_limited';

  return (
    <section
      aria-label={labels.objective}
      className={cn(
        'relative z-0 mx-2 -mb-2 flex min-h-11 items-center gap-2 rounded-t-[12px] border border-foreground/10 bg-background/85 px-3 pb-3 pt-2 shadow-minimal backdrop-blur-sm',
        className,
      )}
    >
      <Target className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          statusTone(goal.status),
        )}
        aria-hidden
      />
      <span className="shrink-0 text-xs font-medium text-foreground">
        {labels.status[goal.status]}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {labels.activity[snapshot.activity]}
      </span>

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSave) {
              event.preventDefault();
              void runControl({
                action: 'edit',
                objective,
                ...expected,
              });
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(false);
            }
          }}
          aria-label={labels.objective}
          disabled={!!pendingAction}
          className="h-7 min-w-0 flex-1 rounded-[7px] border border-foreground/15 bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={goal.objective}
        >
          {goal.objective}
        </span>
      )}

      <span
        className="shrink-0 tabular-nums text-xs text-muted-foreground/75"
        aria-label={`${labels.elapsed} ${formatGoalElapsed(getGoalElapsedMs(snapshot, now))}`}
      >
        {formatGoalElapsed(getGoalElapsedMs(snapshot, now))}
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        {editing ? (
          <>
            <button
              type="button"
              className={actionClassName}
              aria-label={labels.save}
              title={labels.save}
              disabled={!canSave}
              onClick={() =>
                void runControl({
                  action: 'edit',
                  objective,
                  ...expected,
                })
              }
            >
              <Check className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className={actionClassName}
              aria-label={labels.cancel}
              title={labels.cancel}
              disabled={!!pendingAction}
              onClick={() => setEditing(false)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={actionClassName}
              aria-label={labels.edit}
              title={labels.edit}
              disabled={!!pendingAction}
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3.5" aria-hidden />
            </button>
            {goal.status === 'active' && (
              <button
                type="button"
                className={actionClassName}
                aria-label={labels.pause}
                title={labels.pause}
                disabled={!!pendingAction}
                onClick={() =>
                  void runControl({ action: 'pause', ...expected })
                }
              >
                <Pause className="size-3.5" aria-hidden />
              </button>
            )}
            {canResume && (
              <button
                type="button"
                className={actionClassName}
                aria-label={labels.resume}
                title={labels.resume}
                disabled={!!pendingAction}
                onClick={() =>
                  void runControl({ action: 'resume', ...expected })
                }
              >
                <Play className="size-3.5" aria-hidden />
              </button>
            )}
            <button
              type="button"
              className={actionClassName}
              aria-label={labels.clear}
              title={labels.clear}
              disabled={!!pendingAction}
              onClick={() => void runControl({ action: 'clear', ...expected })}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </>
        )}
      </div>
    </section>
  );
}
