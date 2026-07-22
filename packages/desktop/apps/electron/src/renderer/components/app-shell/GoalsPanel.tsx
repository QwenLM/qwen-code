import * as React from 'react';
import {
  Check,
  ExternalLink,
  Pause,
  Pencil,
  Play,
  Plus,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import type {
  GoalControlRequest,
  GoalRecord,
  GoalSnapshotV2,
  GoalStatus,
} from '../../../shared/types';

export interface GoalSessionSource {
  id: string;
  name?: string;
  workspaceId: string;
  hidden?: boolean;
  goalState?: GoalSnapshotV2;
}

export interface GoalsPanelLabels {
  title: string;
  newObjective: string;
  create: string;
  empty: string;
  open: string;
  edit: string;
  pause: string;
  resume: string;
  clear: string;
  save: string;
  cancel: string;
  status: Record<GoalStatus, string>;
}

export interface GoalRow {
  session: GoalSessionSource;
  snapshot: GoalSnapshotV2;
  goal: GoalRecord;
}

export function getGoalRows(sessions: readonly GoalSessionSource[]): GoalRow[] {
  return sessions
    .flatMap((session): GoalRow[] => {
      const snapshot = session.goalState;
      const goal = snapshot?.goal;
      if (!snapshot || !goal || goal.status === 'complete') return [];
      return [{ session, snapshot, goal }];
    })
    .sort((a, b) => b.goal.updatedAt - a.goal.updatedAt);
}

export function buildGoalRowControlRequest(
  goal: GoalRecord,
  action: 'edit' | 'pause' | 'resume' | 'clear',
  objective?: string,
): GoalControlRequest {
  const expected = {
    expectedGoalId: goal.goalId,
    expectedRevision: goal.revision,
  };
  if (action === 'edit') {
    return { action, objective: objective ?? goal.objective, ...expected };
  }
  return { action, ...expected };
}

export async function createGoalInNewSession(options: {
  workspaceId: string;
  objective: string;
  createSession: (workspaceId: string) => Promise<{ id: string }>;
  controlGoal: (
    sessionId: string,
    request: Extract<GoalControlRequest, { action: 'create' }>,
  ) => Promise<void>;
  openSession: (sessionId: string) => void;
}): Promise<string> {
  const objective = options.objective.trim();
  const session = await options.createSession(options.workspaceId);
  await options.controlGoal(session.id, { action: 'create', objective });
  options.openSession(session.id);
  return session.id;
}

type GoalPendingUpdater = (
  update: (current: ReadonlySet<string>) => ReadonlySet<string>,
) => void;

export async function runWithGoalPendingKey<T>(
  key: string,
  setPendingKeys: GoalPendingUpdater,
  operation: () => Promise<T>,
): Promise<T> {
  setPendingKeys((current) => new Set(current).add(key));
  try {
    return await operation();
  } finally {
    setPendingKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }
}

interface GoalsPanelProps {
  sessions: readonly GoalSessionSource[];
  activeWorkspaceId: string | null;
  labels: GoalsPanelLabels;
  onCreateSession: (workspaceId: string) => Promise<{ id: string }>;
  onControl: (sessionId: string, request: GoalControlRequest) => Promise<void>;
  onOpen: (sessionId: string) => void;
}

const actionClassName =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';

function statusTone(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return 'bg-success';
    case 'blocked':
    case 'usage_limited':
      return 'bg-warning';
    case 'paused':
      return 'bg-foreground/35';
    case 'complete':
      return 'bg-info';
  }
}

export function GoalsPanel({
  sessions,
  activeWorkspaceId,
  labels,
  onCreateSession,
  onControl,
  onOpen,
}: GoalsPanelProps) {
  const rows = React.useMemo(() => getGoalRows(sessions), [sessions]);
  const [newObjective, setNewObjective] = React.useState('');
  const [editingSessionId, setEditingSessionId] = React.useState<string | null>(
    null,
  );
  const [editObjective, setEditObjective] = React.useState('');
  const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [error, setError] = React.useState<string | null>(null);

  const runControl = async (sessionId: string, request: GoalControlRequest) => {
    setError(null);
    try {
      await runWithGoalPendingKey(
        `${sessionId}:${request.action}`,
        setPendingKeys,
        () => onControl(sessionId, request),
      );
      if (request.action === 'edit') setEditingSessionId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createGoal = async () => {
    const objective = newObjective.trim();
    if (!activeWorkspaceId || !objective) return;
    setError(null);
    try {
      await runWithGoalPendingKey('create', setPendingKeys, () =>
        createGoalInNewSession({
          workspaceId: activeWorkspaceId,
          objective,
          createSession: onCreateSession,
          controlGoal: onControl,
          openSession: onOpen,
        }),
      );
      setNewObjective('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={labels.title}>
      <header className="shrink-0 border-b border-foreground/10 px-6 pb-4 pt-5">
        <div className="mb-4 flex items-center gap-2">
          <Target className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-base font-semibold text-foreground">
            {labels.title}
          </h1>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createGoal();
          }}
        >
          <input
            value={newObjective}
            onChange={(event) => setNewObjective(event.target.value)}
            aria-label={labels.newObjective}
            placeholder={labels.newObjective}
            disabled={!activeWorkspaceId || pendingKeys.has('create')}
            className="h-9 min-w-0 flex-1 rounded-[9px] border border-foreground/15 bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="submit"
            aria-label={labels.create}
            disabled={
              !activeWorkspaceId ||
              !newObjective.trim() ||
              pendingKeys.has('create')
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-[9px] bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus className="size-4" aria-hidden />
            {labels.create}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {rows.length === 0 ? (
          <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted-foreground">
            {labels.empty}
          </div>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-2">
            {rows.map(({ session, goal }) => {
              const editing = editingSessionId === session.id;
              const rowPending = Array.from(pendingKeys).some((key) =>
                key.startsWith(`${session.id}:`),
              );
              const canResume =
                goal.status === 'paused' ||
                goal.status === 'blocked' ||
                goal.status === 'usage_limited';
              const trimmedEdit = editObjective.trim();

              return (
                <li
                  key={session.id}
                  className="rounded-[12px] border border-foreground/10 bg-background px-4 py-3 shadow-minimal"
                >
                  <div className="flex items-center gap-2">
                    <Target
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${statusTone(goal.status)}`}
                      aria-hidden
                    />
                    <span className="shrink-0 text-xs font-medium text-foreground">
                      {labels.status[goal.status]}
                    </span>
                    {editing ? (
                      <input
                        autoFocus
                        value={editObjective}
                        onChange={(event) =>
                          setEditObjective(event.target.value)
                        }
                        aria-label={labels.edit}
                        disabled={rowPending}
                        className="h-8 min-w-0 flex-1 rounded-[8px] border border-foreground/15 bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    ) : (
                      <span
                        className="min-w-0 flex-1 truncate text-sm text-foreground"
                        title={goal.objective}
                      >
                        {goal.objective}
                      </span>
                    )}

                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        className={actionClassName}
                        aria-label={labels.open}
                        title={labels.open}
                        disabled={rowPending}
                        onClick={() => onOpen(session.id)}
                      >
                        <ExternalLink className="size-3.5" aria-hidden />
                      </button>
                      {editing ? (
                        <>
                          <button
                            type="button"
                            className={actionClassName}
                            aria-label={labels.save}
                            title={labels.save}
                            disabled={
                              rowPending ||
                              !trimmedEdit ||
                              trimmedEdit === goal.objective
                            }
                            onClick={() =>
                              void runControl(
                                session.id,
                                buildGoalRowControlRequest(
                                  goal,
                                  'edit',
                                  trimmedEdit,
                                ),
                              )
                            }
                          >
                            <Check className="size-3.5" aria-hidden />
                          </button>
                          <button
                            type="button"
                            className={actionClassName}
                            aria-label={labels.cancel}
                            title={labels.cancel}
                            disabled={rowPending}
                            onClick={() => setEditingSessionId(null)}
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
                            disabled={rowPending}
                            onClick={() => {
                              setEditObjective(goal.objective);
                              setEditingSessionId(session.id);
                            }}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                          </button>
                          {goal.status === 'active' && (
                            <button
                              type="button"
                              className={actionClassName}
                              aria-label={labels.pause}
                              title={labels.pause}
                              disabled={rowPending}
                              onClick={() =>
                                void runControl(
                                  session.id,
                                  buildGoalRowControlRequest(goal, 'pause'),
                                )
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
                              disabled={rowPending}
                              onClick={() =>
                                void runControl(
                                  session.id,
                                  buildGoalRowControlRequest(goal, 'resume'),
                                )
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
                            disabled={rowPending}
                            onClick={() =>
                              void runControl(
                                session.id,
                                buildGoalRowControlRequest(goal, 'clear'),
                              )
                            }
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {session.name && (
                    <p className="mt-1 truncate pl-8 text-xs text-muted-foreground">
                      {session.name}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
