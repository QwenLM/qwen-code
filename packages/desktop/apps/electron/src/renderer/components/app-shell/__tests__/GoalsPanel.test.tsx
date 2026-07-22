import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GoalRecord, GoalSnapshotV2 } from '../../../../shared/types';
import {
  buildGoalRowControlRequest,
  createGoalInNewSession,
  getGoalRows,
  GoalsPanel,
  runWithGoalPendingKey,
  type GoalsPanelLabels,
  type GoalSessionSource,
} from '../GoalsPanel';

const labels: GoalsPanelLabels = {
  title: 'Goals',
  newObjective: 'New goal objective',
  create: 'Create goal',
  empty: 'No unfinished goals',
  open: 'Open session',
  edit: 'Edit goal',
  pause: 'Pause goal',
  resume: 'Resume goal',
  clear: 'Clear goal',
  save: 'Save',
  cancel: 'Cancel',
  status: {
    active: 'Active',
    paused: 'Paused',
    blocked: 'Blocked',
    usage_limited: 'Usage limited',
    complete: 'Completed',
  },
};

function goal(status: GoalRecord['status'], updatedAt: number): GoalRecord {
  return {
    goalId: `goal-${status}`,
    revision: 5,
    objective: `${status} objective`,
    status,
    evidenceCursor: { recordId: null },
    turnCount: 3,
    activeTimeMs: 20_000,
    createdAt: 1_000,
    updatedAt,
  };
}

function session(
  id: string,
  goalState: GoalSnapshotV2 | undefined,
): GoalSessionSource {
  return { id, name: id, workspaceId: 'workspace-1', goalState };
}

describe('GoalsPanel', () => {
  it('derives unfinished rows directly from authoritative session snapshots', () => {
    const rows = getGoalRows([
      session('paused', {
        v: 2,
        goal: goal('paused', 20),
        activity: 'idle',
      }),
      session('blocked', {
        v: 2,
        goal: goal('blocked', 30),
        activity: 'idle',
      }),
      session('complete', {
        v: 2,
        goal: goal('complete', 40),
        activity: 'idle',
      }),
      session('empty', { v: 2, goal: null, activity: 'idle' }),
    ]);

    expect(rows.map((row) => row.session.id)).toEqual(['blocked', 'paused']);
  });

  it('includes hidden unfinished canonical Goal sessions', () => {
    const hiddenPaused = session('hidden-paused', {
      v: 2,
      goal: goal('paused', 20),
      activity: 'idle',
    });
    hiddenPaused.hidden = true;
    const hiddenComplete = session('hidden-complete', {
      v: 2,
      goal: goal('complete', 30),
      activity: 'idle',
    });
    hiddenComplete.hidden = true;

    expect(getGoalRows([hiddenPaused, hiddenComplete])).toHaveLength(1);
    expect(getGoalRows([hiddenPaused, hiddenComplete])[0]?.session.id).toBe(
      'hidden-paused',
    );
  });

  it('keeps B pending when concurrent A completes first', async () => {
    let pendingKeys: ReadonlySet<string> = new Set();
    const setPendingKeys = (
      update: (current: ReadonlySet<string>) => ReadonlySet<string>,
    ) => {
      pendingKeys = update(pendingKeys);
    };
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    const operationA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const operationB = new Promise<void>((resolve) => {
      resolveB = resolve;
    });

    const pendingA = runWithGoalPendingKey(
      'session-a:pause',
      setPendingKeys,
      () => operationA,
    );
    const pendingB = runWithGoalPendingKey(
      'session-b:resume',
      setPendingKeys,
      () => operationB,
    );
    expect(Array.from(pendingKeys)).toEqual([
      'session-a:pause',
      'session-b:resume',
    ]);

    resolveA?.();
    await pendingA;
    expect(Array.from(pendingKeys)).toEqual(['session-b:resume']);

    resolveB?.();
    await pendingB;
    expect(pendingKeys.size).toBe(0);
  });

  it('creates a session before sending the typed create control', async () => {
    const calls: string[] = [];
    const result = await createGoalInNewSession({
      workspaceId: 'workspace-1',
      objective: 'Ship every surface',
      createSession: async (workspaceId) => {
        calls.push(`create:${workspaceId}`);
        return { id: 'session-new' };
      },
      controlGoal: async (sessionId, request) => {
        calls.push(
          `control:${sessionId}:${request.action}:${request.objective}`,
        );
      },
      openSession: (sessionId) => calls.push(`open:${sessionId}`),
    });

    expect(result).toBe('session-new');
    expect(calls).toEqual([
      'create:workspace-1',
      'control:session-new:create:Ship every surface',
      'open:session-new',
    ]);
  });

  it('builds row controls with the exact Goal ID and revision', () => {
    const record = goal('active', 30);
    expect(buildGoalRowControlRequest(record, 'pause')).toEqual({
      action: 'pause',
      expectedGoalId: 'goal-active',
      expectedRevision: 5,
    });
    expect(
      buildGoalRowControlRequest(record, 'edit', 'Updated objective'),
    ).toEqual({
      action: 'edit',
      objective: 'Updated objective',
      expectedGoalId: 'goal-active',
      expectedRevision: 5,
    });
  });

  it('renders a paused row with accessible open, edit, resume, and clear actions', () => {
    const html = renderToStaticMarkup(
      <GoalsPanel
        sessions={[
          session('paused', {
            v: 2,
            goal: goal('paused', 20),
            activity: 'idle',
          }),
        ]}
        activeWorkspaceId="workspace-1"
        labels={labels}
        onCreateSession={async () => ({ id: 'session-new' })}
        onControl={async () => {}}
        onOpen={() => {}}
      />,
    );

    expect(html).toContain('paused objective');
    expect(html).toContain('aria-label="Open session"');
    expect(html).toContain('aria-label="Edit goal"');
    expect(html).toContain('aria-label="Resume goal"');
    expect(html).toContain('aria-label="Clear goal"');
    expect(html).not.toContain('aria-label="Pause goal"');
    expect(html).not.toContain('token');
    expect(html).not.toContain('turn');
  });
});
