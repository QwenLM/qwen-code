/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  createGoalRuntime,
  type GoalJournal,
  type GoalRuntime,
  type GoalTurnHost,
} from './goal-runtime.js';
import {
  type GetGoalToolParams,
  GetGoalTool,
  PROPOSE_GOAL_NOT_APPROVED_MESSAGE,
  PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS,
  PROPOSE_GOAL_PLAN_MODE_MESSAGE,
  PROPOSE_GOAL_UNAVAILABLE_MESSAGE,
  PROPOSE_GOAL_UNTRUSTED_MESSAGE,
  ProposeGoalTool,
  type ProposeGoalToolConfig,
  UpdateGoalTool,
  type GoalToolConfig,
} from './goal-tools.js';
import { ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { goalTurnContext } from './goal-turn-context.js';
import {
  emptyGoalSnapshot,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  GOAL_PROPOSAL_REASON_MAX_BYTES,
  GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
  type GoalTurnPermit,
  type TranscriptCursor,
} from './goal-protocol.js';

const permit: GoalTurnPermit = {
  goalId: 'goal-1',
  revision: 3,
  turnId: 'turn-4',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeConfig(runtime: Partial<GoalRuntime>) {
  return {
    getGoalRuntime: vi.fn(() => runtime as GoalRuntime),
  };
}

function fakeGoalJournal(): GoalJournal {
  return {
    getTranscriptCursor(): TranscriptCursor {
      return { recordId: null };
    },
    async recordGoalState(): Promise<void> {},
  };
}

function fakeHost(): GoalTurnHost & { started: GoalTurnPermit[] } {
  const started: GoalTurnPermit[] = [];
  return {
    started,
    async startGoalTurn({ permit: startedPermit }) {
      started.push(structuredClone(startedPermit));
    },
    preemptGoalTurn: vi.fn(),
  };
}

async function activeRuntime() {
  const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
  const host = fakeHost();
  runtime.bindHost(host);
  await runtime.dispatch({ action: 'create', objective: 'Ship Goal v3' });
  return { runtime, permit: host.started[0]! };
}

async function execute(tool: GetGoalTool) {
  return tool.build({}).execute(new AbortController().signal);
}

describe('GetGoalTool', () => {
  it('uses the canonical Goal tool name', () => {
    const tool = new GetGoalTool(makeConfig({}));

    expect(ToolNames.GET_GOAL).toBe('get_goal');
    expect(ToolDisplayNames.GET_GOAL).toBe('Goal');
    expect(tool.name).toBe(ToolNames.GET_GOAL);
    expect(tool.displayName).toBe(ToolDisplayNames.GET_GOAL);
    expect(tool.shouldDefer).toBe(false);
    expect(tool.build({}).getDescription()).toBe('Read the current goal');
  });

  it('keeps both Goal tools visible and out of deferred search', () => {
    const config = {
      getMcpTransportPool: () => undefined,
      getDisabledTools: () => new Set<string>(),
      getVisibleTools: () => new Set<string>(),
      getGoalRuntime: () => undefined as never,
    } as unknown as Config & GoalToolConfig;
    const registry = new ToolRegistry(config);
    const getGoal = new GetGoalTool(config);
    const updateGoal = new UpdateGoalTool(config);
    registry.registerTool(getGoal);
    registry.registerTool(updateGoal);

    expect(getGoal.shouldDefer).toBe(false);
    expect(updateGoal.shouldDefer).toBe(false);
    expect(registry.getDeferredToolSummary()).toEqual([]);
    expect(
      registry.getFunctionDeclarations().map((declaration) => declaration.name),
    ).toEqual([ToolNames.GET_GOAL, ToolNames.UPDATE_GOAL]);
  });

  it('reports no active Goal outside a permitted Goal turn', async () => {
    const getGoalForWorker = vi.fn();
    const config = makeConfig({ getGoalForWorker });

    const result = await execute(new GetGoalTool(config));

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.llmContent))).toEqual({ active: false });
    expect(result.returnDisplay).toBe(
      'No active Goal is available for this turn.',
    );
    expect(getGoalForWorker).not.toHaveBeenCalled();
  });

  it('summarises the last Goal once it has stopped issuing permits', async () => {
    const getGoalForWorker = vi.fn();
    const config = makeConfig({
      getGoalForWorker,
      getSnapshot: () => ({
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-1',
          revision: 3,
          objective: 'Ship Goal v3',
          status: 'usage_limited' as const,
          evidenceCursor: { recordId: 'record-1' },
          turnCount: 27,
          activeTimeMs: 1_763_705,
          tokensUsed: 4_500,
          tokenBudget: 30_000_000,
          createdAt: 1,
          updatedAt: 2,
          lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
          evidenceCheckpoint: {
            checkpointId: 'checkpoint-1',
            createdAt: 2,
            claims: [
              {
                id: 'checkpoint-1:1',
                proofKind: 'external_fact' as const,
                claim: 'note-01.md exists',
                sourceRefs: ['record-1'],
              },
            ],
          },
        },
      }),
    });

    const result = await execute(new GetGoalTool(config));

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: false,
      lastGoal: {
        goalId: 'goal-1',
        revision: 3,
        status: 'usage_limited',
        turnCount: 27,
        activeTimeMs: 1_763_705,
        tokensUsed: 4_500,
        tokenBudget: 30_000_000,
        lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
      },
    });
    expect(result.returnDisplay).toBe(
      'No Goal turn is permitted · last Goal usage_limited after 27 turns',
    );
    expect(getGoalForWorker).not.toHaveBeenCalled();
  });

  it('summarises a paused Goal outside a permitted turn', async () => {
    const config = makeConfig({
      getGoalForWorker: vi.fn(),
      getSnapshot: () => ({
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-1',
          revision: 2,
          objective: 'Ship Goal v3',
          status: 'paused' as const,
          evidenceCursor: { recordId: 'record-1' },
          turnCount: 1,
          activeTimeMs: 750,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    });

    const result = await execute(new GetGoalTool(config));

    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: false,
      lastGoal: {
        goalId: 'goal-1',
        revision: 2,
        status: 'paused',
        turnCount: 1,
        activeTimeMs: 750,
        tokensUsed: 0,
      },
    });
    expect(result.returnDisplay).toBe(
      'No Goal turn is permitted · last Goal paused after 1 turn',
    );
  });

  it('keeps the objective and the evidence checkpoint behind the permit', async () => {
    const config = makeConfig({
      getGoalForWorker: vi.fn(),
      getSnapshot: () => ({
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-1',
          revision: 1,
          objective: 'SECRET_OBJECTIVE',
          status: 'complete' as const,
          evidenceCursor: { recordId: 'record-1' },
          turnCount: 2,
          activeTimeMs: 10,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
          evidenceCheckpoint: {
            checkpointId: 'checkpoint-1',
            createdAt: 2,
            claims: [
              {
                id: 'checkpoint-1:1',
                proofKind: 'delivered_output' as const,
                claim: 'SECRET_CLAIM',
                sourceRefs: ['record-1'],
              },
            ],
          },
        },
      }),
    });

    const result = await execute(new GetGoalTool(config));

    expect(String(result.llmContent)).not.toContain('SECRET_OBJECTIVE');
    expect(String(result.llmContent)).not.toContain('SECRET_CLAIM');
    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: false,
      lastGoal: {
        goalId: 'goal-1',
        revision: 1,
        status: 'complete',
        turnCount: 2,
        activeTimeMs: 10,
        tokensUsed: 0,
      },
    });
  });

  it('reports no Goal when the session never had one', async () => {
    const config = makeConfig({
      getGoalForWorker: vi.fn(),
      getSnapshot: () => emptyGoalSnapshot(),
    });

    const result = await execute(new GetGoalTool(config));

    expect(JSON.parse(String(result.llmContent))).toEqual({ active: false });
  });

  it('reports no Goal when Goal persistence is unreachable', async () => {
    const config = {
      getGoalRuntime: vi.fn(() => {
        throw new Error('Goal persistence is unavailable');
      }),
    };

    const result = await execute(new GetGoalTool(config));

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.llmContent))).toEqual({ active: false });
    expect(result.returnDisplay).toBe(
      'No active Goal is available for this turn.',
    );
  });

  it('returns only the bounded worker view for the captured permit', async () => {
    const snapshot = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 3,
        objective: 'Ship Goal v3',
        status: 'active' as const,
        evidenceCursor: { recordId: 'cursor-1' },
        turnCount: 4,
        activeTimeMs: 120,
        tokensUsed: 0,
        createdAt: 10,
        updatedAt: 20,
      },
    };
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: 'goal-1',
      revision: 3,
      objective: 'Ship Goal v3',
      evidenceCursor: { recordId: 'cursor-1' },
      evidenceCatalog: {
        entries: [
          {
            uuid: 'evidence-1',
            provenance: 'tool_result',
            turnId: 'turn-4',
            preview: '12 tests passed',
            proofKind: 'external_fact',
          },
        ],
        lineageTurnIds: ['turn-4'],
      },
      verifierFeedback: 'retry: missing edge case',
      fullTranscript: ['must not leak'],
    });
    const getSnapshotForPermit = vi.fn(() => structuredClone(snapshot));
    const tool = new GetGoalTool(
      makeConfig({ getGoalForWorker, getSnapshotForPermit }),
    );
    const invocation = goalTurnContext.run(permit, () => tool.build({}));

    const result = await invocation.execute(new AbortController().signal);

    expect(invocation.getDescription()).toBe('Read the current goal');
    expect(getGoalForWorker).toHaveBeenCalledWith(permit);
    expect(getSnapshotForPermit).toHaveBeenCalledWith(permit);
    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: true,
      view: 'summary',
      snapshot,
      evidenceCatalog: {
        entries: [
          {
            uuid: 'evidence-1',
            provenance: 'tool_result',
            turnId: 'turn-4',
            preview: '12 tests passed',
            proofKind: 'external_fact',
          },
        ],
        lineageTurnIds: ['turn-4'],
      },
      verifierFeedback: 'retry: missing edge case',
    });
    expect(String(result.llmContent)).not.toContain('must not leak');
    expect(result.returnDisplay).toBe('Active goal · revision 3');
  });

  it('exposes the view parameter and nothing else', () => {
    const tool = new GetGoalTool(makeConfig({ getGoalForWorker: vi.fn() }));
    expect(tool.schema.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['summary', 'full'],
          description: expect.stringContaining('summary (default)'),
        },
      },
      additionalProperties: false,
    });
  });

  // A long-running Goal after a few checkpoints: 32 claims of the maximum
  // length, a catalog at its entry cap, and a lineage at its cap.
  const LONG_CLAIM = 'C'.repeat(2_000);
  const LONG_PREVIEW_ASCII = 'p'.repeat(240);
  const LONG_PREVIEW_CJK = '证'.repeat(80); // 240 bytes
  const checkpointedGoal = () => ({
    goalId: 'goal-1',
    revision: 3,
    objective: 'Ship Goal v3',
    status: 'active' as const,
    evidenceCursor: { recordId: 'checkpoint-9' },
    turnCount: 40,
    activeTimeMs: 120,
    tokensUsed: 0,
    createdAt: 10,
    updatedAt: 20,
    evidenceCheckpoint: {
      checkpointId: 'checkpoint-9',
      createdAt: 15,
      claims: Array.from({ length: 32 }, (_, index) => ({
        id: `checkpoint-9:${index + 1}`,
        proofKind: 'external_fact' as const,
        claim: `SECRET_CLAIM_TEXT ${LONG_CLAIM}`,
        sourceRefs: Array.from(
          { length: 4 },
          (_, ref) => `src-${index}-${ref}`,
        ),
      })),
    },
  });
  const checkpointedCatalog = () => ({
    entries: [
      ...Array.from({ length: 32 }, (_, index) => ({
        uuid: `checkpoint-9:${index + 1}`,
        provenance: 'goal_checkpoint' as const,
        turnId: 'checkpoint:checkpoint-9',
        preview: `claim ${index + 1} ${LONG_PREVIEW_ASCII}`.slice(0, 240),
        proofKind: 'external_fact' as const,
      })),
      ...Array.from({ length: 60 }, (_, index) => ({
        uuid: `earlier-${index}`,
        provenance: 'tool_result' as const,
        turnId: `earlier-turn-${index % 12}`,
        preview: index % 2 === 0 ? LONG_PREVIEW_ASCII : LONG_PREVIEW_CJK,
        proofKind: 'external_fact' as const,
      })),
      {
        uuid: 'earlier-short',
        provenance: 'tool_result' as const,
        turnId: 'earlier-turn-0',
        preview: '12 tests passed',
        proofKind: 'external_fact' as const,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        uuid: `current-${index}`,
        provenance: 'assistant_output' as const,
        turnId: permit.turnId,
        preview: LONG_PREVIEW_ASCII,
        proofKind: 'delivered_output' as const,
      })),
    ],
    lineageTurnIds: [
      ...Array.from({ length: 15 }, (_, index) => `earlier-turn-${index}`),
      permit.turnId,
    ],
    truncated: false,
  });
  const checkpointedTool = () =>
    new GetGoalTool(
      makeConfig({
        getGoalForWorker: vi.fn().mockResolvedValue({
          goalId: 'goal-1',
          revision: 3,
          objective: 'Ship Goal v3',
          evidenceCursor: { recordId: 'checkpoint-9' },
          evidenceCatalog: checkpointedCatalog(),
        }),
        getSnapshotForPermit: vi.fn(() => ({
          v: 2 as const,
          activity: 'running' as const,
          goal: checkpointedGoal(),
        })),
      }),
    );
  const read = async (params: GetGoalToolParams) => {
    const invocation = goalTurnContext.run(permit, () =>
      checkpointedTool().build(params),
    );
    const result = await invocation.execute(new AbortController().signal);
    return String(result.llmContent);
  };

  it('collapses checkpoint claims and shortens earlier previews in the summary view', async () => {
    const content = await read({});
    const payload = JSON.parse(content);

    // The claims' text is the duplicate: each claim is already a catalog entry.
    expect(content).not.toContain('SECRET_CLAIM_TEXT');
    expect(payload.snapshot.goal.evidenceCheckpoint).toEqual({
      checkpointId: 'checkpoint-9',
      createdAt: 15,
      claimCount: 32,
    });
    expect(payload.view).toBe('summary');

    const entries: Array<{
      uuid: string;
      turnId: string;
      provenance: string;
      preview: string;
    }> = payload.evidenceCatalog.entries;
    // Every uuid survives: the summary changes what is shown, not what is
    // citable.
    expect(entries.map((entry) => entry.uuid)).toEqual(
      checkpointedCatalog().entries.map((entry) => entry.uuid),
    );
    for (const entry of entries) {
      const bytes = Buffer.byteLength(entry.preview, 'utf8');
      if (
        entry.provenance === 'goal_checkpoint' ||
        entry.turnId === permit.turnId
      ) {
        expect(bytes).toBe(240);
      } else {
        expect(bytes).toBeLessThanOrEqual(80);
      }
    }
    // Multi-byte previews are cut on a code point, not mid-character.
    expect(entries.find((entry) => entry.uuid === 'earlier-1')?.preview).toBe(
      '证'.repeat(26),
    );
    // An earlier-turn preview already within the cap passes through
    // byte-identical and is not counted as shortened.
    expect(
      entries.find((entry) => entry.uuid === 'earlier-short')?.preview,
    ).toBe('12 tests passed');
    expect(payload.evidenceCatalog.shortenedPreviews).toBe(60);
    expect(payload.evidenceCatalog.lineageTurnIds).toHaveLength(16);
  });

  it('returns the whole checkpoint and catalog in the full view', async () => {
    const payload = JSON.parse(await read({ view: 'full' }));

    expect(payload.view).toBe('full');
    expect(payload.snapshot.goal).toEqual(checkpointedGoal());
    expect(payload.evidenceCatalog).toEqual(checkpointedCatalog());
    expect(payload.evidenceCatalog).not.toHaveProperty('shortenedPreviews');
  });

  it('keeps a steady-state summary read under a fixed byte ceiling', async () => {
    const summaryBytes = Buffer.byteLength(await read({}), 'utf8');
    const fullBytes = Buffer.byteLength(await read({ view: 'full' }), 'utf8');

    // The full read of this fixture is what a long Goal paid on every
    // get_goal before: the 2,000-character claims alone are ~64 KB.
    expect(fullBytes).toBeGreaterThan(100_000);
    expect(summaryBytes).toBeLessThanOrEqual(36_000);
    expect(fullBytes / summaryBytes).toBeGreaterThanOrEqual(3);
  });
});

describe('UpdateGoalTool', () => {
  const activeSnapshot = () => ({
    v: 2 as const,
    activity: 'running' as const,
    goal: {
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Deliver the result',
      status: 'active' as const,
      evidenceCursor: { recordId: 'goal-created' },
      turnCount: 3,
      activeTimeMs: 100,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 2,
    },
  });

  it('exposes the exact evidence and non-terminal response contract', () => {
    const tool = new UpdateGoalTool(makeConfig({}));
    const schema = tool.schema.parametersJsonSchema as {
      properties: {
        reason: { maxLength?: number };
        evidenceRefs: {
          description?: string;
          items?: { description?: string };
          maxItems?: number;
        };
        blockerKind: { description?: string };
      };
    };

    expect(tool.description).toContain('call get_goal in the current turn');
    expect(tool.description).toContain('evidenceCatalog.entries[].uuid');
    expect(tool.description).toContain(
      'never goalId, turnId, or lineageTurnIds',
    );
    expect(tool.description).toContain(
      'Do not tell the user the Goal is complete',
    );
    expect(tool.description).toContain(
      'call get_goal, wait for its result, and call update_goal in a later model step',
    );
    expect(tool.description).not.toContain('in that same response');
    expect(tool.description).toContain(
      'Do not add progress or completion commentary',
    );
    expect(tool.description).toContain(
      'end the turn without additional user-facing text',
    );
    expect(tool.description).not.toContain(
      'say the proposal is awaiting independent verification',
    );
    expect(schema.properties.evidenceRefs.description).toContain(
      'evidenceCatalog.entries[].uuid',
    );
    expect(schema.properties.evidenceRefs.items?.description).toContain(
      'not a turnId',
    );
    expect(schema.properties.evidenceRefs.maxItems).toBe(100);
    expect(schema.properties.reason.maxLength).toBe(
      GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
    );
    expect(schema.properties.blockerKind.description).toContain(
      'three consecutive Goal turns',
    );
    expect(schema.properties.blockerKind.description).toContain(
      'exact same reason text',
    );
    expect(
      (schema.properties.blockerKind as { enum?: string[] }).enum,
    ).toContain('infeasible');
    expect(schema.properties.blockerKind.description).toContain(
      'cannot be satisfied as written',
    );
    expect(tool.description).toContain('a tool result, not your own text');
    expect(tool.description).toContain(
      'not for difficulty, uncertainty, information you could still obtain',
    );
  });

  it('rejects lineage turn ids before recording a proposal', async () => {
    const recordTerminalProposal = vi.fn();
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Reply test until the user types qqq',
      evidenceCursor: { recordId: 'goal-created' },
      evidenceCatalog: {
        entries: [
          {
            uuid: 'user-input-qqq',
            provenance: 'real_user',
            turnId: permit.turnId,
            preview: 'qqq',
            proofKind: 'user_input',
          },
        ],
        lineageTurnIds: [permit.turnId],
      },
    });
    const getSnapshotForPermit = vi.fn(() => ({
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'Reply test until the user types qqq',
        status: 'active' as const,
        evidenceCursor: { recordId: 'goal-created' },
        turnCount: 3,
        activeTimeMs: 100,
        tokensUsed: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    }));
    const tool = new UpdateGoalTool(
      makeConfig({
        getGoalForWorker,
        getSnapshotForPermit,
        recordTerminalProposal,
      }),
    );
    const invocation = goalTurnContext.run(permit, () =>
      tool.build({
        status: 'complete',
        reason: 'The user typed qqq',
        evidenceRefs: [permit.turnId],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(JSON.parse(String(result.llmContent))).toEqual({
      proposalRecorded: false,
      readyForVerification: false,
      goalLifecycleChanged: false,
      invalidEvidenceRefs: [permit.turnId],
      error:
        'evidenceRefs must use values from the latest get_goal evidenceCatalog.entries[].uuid; call get_goal and retry. Do not use goalId, turnId, or lineageTurnIds.',
    });
    expect(result.returnDisplay).toBe(
      'Goal proposal was not recorded because its evidence is not current. Read the current Goal and retry.',
    );
    expect(result.returnDisplay).not.toContain('turnId');
    expect(result.returnDisplay).not.toContain('uuid');
    expect(recordTerminalProposal).not.toHaveBeenCalled();
  });

  it("cites this turn's delivered output for a completion that omitted it", async () => {
    const recordTerminalProposal = vi.fn(() => ({
      recorded: true,
      readyForVerification: true,
    }));
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Output ZQPX one character per turn',
      evidenceCursor: { recordId: 'goal-created' },
      evidenceCatalog: {
        entries: [
          {
            uuid: 'tool-result-1',
            provenance: 'tool_result',
            turnId: 'turn-1',
            preview: 'tests passed',
            proofKind: 'external_fact',
          },
          {
            uuid: 'letter-x',
            provenance: 'assistant_output',
            turnId: permit.turnId,
            preview: 'X',
            proofKind: 'delivered_output',
          },
        ],
        lineageTurnIds: ['turn-1', permit.turnId],
      },
    });
    const getSnapshotForPermit = vi.fn(() => ({
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'Output ZQPX one character per turn',
        status: 'active' as const,
        evidenceCursor: { recordId: 'goal-created' },
        turnCount: 3,
        activeTimeMs: 100,
        tokensUsed: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    }));
    const tool = new UpdateGoalTool(
      makeConfig({
        getGoalForWorker,
        getSnapshotForPermit,
        recordTerminalProposal,
      }),
    );
    const invocation = goalTurnContext.run(permit, () =>
      tool.build({
        status: 'complete',
        reason: 'All characters were delivered',
        evidenceRefs: ['tool-result-1'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    // Refusing here could not converge: complying emits assistant text, which
    // is delivered_output stamped with this same turn, so the required set
    // grew by one per retry until a human stopped the Goal.
    expect(recordTerminalProposal).toHaveBeenCalledWith(
      permit,
      expect.objectContaining({
        status: 'complete',
        evidenceRefs: ['tool-result-1', 'letter-x'],
      }),
    );
    expect(JSON.parse(String(result.llmContent))).toMatchObject({
      proposalRecorded: true,
      readyForVerification: true,
      autoCitedCurrentDeliveredOutput: ['letter-x'],
    });
  });

  it('does not duplicate output the completion already cited', async () => {
    // validateGoalEvidenceReferences rejects a duplicated ref outright, so the
    // fold has to be a union rather than an append.
    const recordTerminalProposal = vi.fn(() => ({
      recorded: true,
      readyForVerification: true,
    }));
    const tool = new UpdateGoalTool(
      makeConfig({
        getGoalForWorker: vi.fn().mockResolvedValue({
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'Deliver the result',
          evidenceCursor: { recordId: 'goal-created' },
          evidenceCatalog: {
            entries: [
              {
                uuid: 'letter-x',
                provenance: 'assistant_output',
                turnId: permit.turnId,
                preview: 'X',
                proofKind: 'delivered_output',
              },
              {
                uuid: 'letter-y',
                provenance: 'assistant_output',
                turnId: permit.turnId,
                preview: 'Y',
                proofKind: 'delivered_output',
              },
              {
                uuid: 'current-external-fact',
                provenance: 'tool_result',
                turnId: permit.turnId,
                preview: 'permission denied',
                proofKind: 'external_fact',
              },
              {
                uuid: 'prior-delivered-output',
                provenance: 'assistant_output',
                turnId: 'prior-turn',
                preview: 'Earlier output',
                proofKind: 'delivered_output',
              },
            ],
            lineageTurnIds: ['prior-turn', permit.turnId],
          },
        }),
        getSnapshotForPermit: vi.fn(() => activeSnapshot()),
        recordTerminalProposal,
      }),
    );
    const invocation = goalTurnContext.run(permit, () =>
      tool.build({
        status: 'complete',
        reason: 'Delivered',
        evidenceRefs: ['letter-x'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(recordTerminalProposal).toHaveBeenCalledWith(
      permit,
      expect.objectContaining({ evidenceRefs: ['letter-x', 'letter-y'] }),
    );
    expect(recordTerminalProposal).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(result.llmContent))).toMatchObject({
      autoCitedCurrentDeliveredOutput: ['letter-y'],
    });
  });

  it('leaves a blocked proposal to cite whatever it chose', async () => {
    // The gate only ever guarded completion: a blocker is judged on the
    // blocker, not on what the turn happened to deliver.
    const recordTerminalProposal = vi.fn(() => ({
      recorded: true,
      readyForVerification: false,
    }));
    const tool = new UpdateGoalTool(
      makeConfig({
        getGoalForWorker: vi.fn().mockResolvedValue({
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'Deliver the result',
          evidenceCursor: { recordId: 'goal-created' },
          evidenceCatalog: {
            entries: [
              {
                uuid: 'tool-result-1',
                provenance: 'tool_result',
                turnId: permit.turnId,
                preview: 'permission denied',
                proofKind: 'external_fact',
              },
              {
                uuid: 'letter-x',
                provenance: 'assistant_output',
                turnId: permit.turnId,
                preview: 'X',
                proofKind: 'delivered_output',
              },
            ],
            lineageTurnIds: [permit.turnId],
          },
        }),
        getSnapshotForPermit: vi.fn(() => activeSnapshot()),
        recordTerminalProposal,
      }),
    );
    const invocation = goalTurnContext.run(permit, () =>
      tool.build({
        status: 'blocked',
        reason: 'The credential store is unreadable',
        evidenceRefs: ['tool-result-1'],
        blockerKind: 'external',
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(recordTerminalProposal).toHaveBeenCalledWith(
      permit,
      expect.objectContaining({ evidenceRefs: ['tool-result-1'] }),
    );
    expect(JSON.parse(String(result.llmContent))).not.toHaveProperty(
      'autoCitedCurrentDeliveredOutput',
    );
  });

  it('queues truncated completion for boundary classification', async () => {
    const recordTerminalProposal = vi.fn(() => ({
      recorded: true,
      readyForVerification: true,
    }));
    const runtime = {
      getGoalForWorker: vi.fn().mockResolvedValue({
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'Ship Goal v3',
        evidenceCursor: { recordId: 'goal-created' },
        evidenceCatalog: {
          entries: [
            {
              uuid: 'output',
              provenance: 'assistant_output',
              turnId: permit.turnId,
              preview: 'done',
              proofKind: 'delivered_output',
            },
          ],
          lineageTurnIds: [permit.turnId],
          truncated: true,
        },
      }),
      getSnapshotForPermit: vi.fn(() => ({
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'Ship Goal v3',
          status: 'active' as const,
          evidenceCursor: { recordId: 'goal-created' },
          turnCount: 1,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })),
      recordTerminalProposal,
    };
    const invocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['output'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(JSON.parse(String(result.llmContent))).toMatchObject({
      proposalRecorded: true,
      readyForVerification: true,
    });
    expect(result.terminateTurn).toBe(true);
    expect(recordTerminalProposal).toHaveBeenCalledOnce();
  });

  it('records one proposal while leaving the Goal active', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const tool = new UpdateGoalTool(makeConfig(runtime));
    const invocation = goalTurnContext.run(activePermit, () =>
      tool.build({
        status: 'complete',
        reason: 'Focused tests passed',
        evidenceRefs: ['tool-result-1'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(ToolNames.UPDATE_GOAL).toBe('update_goal');
    expect(ToolDisplayNames.UPDATE_GOAL).toBe('UpdateGoal');
    expect(JSON.parse(String(result.llmContent))).toEqual({
      proposalRecorded: true,
      readyForVerification: true,
      goalLifecycleChanged: false,
      nextAction:
        'End this turn without user-facing text. Do not claim the Goal is complete or blocked. The Goal status card will report the independent verification result.',
    });
    expect(result.returnDisplay).toContain(
      'queued for independent verification',
    );
    expect(result.terminateTurn).toBe(true);
    expect(runtime.getSnapshot().goal?.status).toBe('active');
  });

  it('keeps audit-only blocker proposals in the current turn', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const tool = new UpdateGoalTool(makeConfig(runtime));
    const build = () =>
      goalTurnContext.run(activePermit, () =>
        tool.build({
          status: 'blocked',
          reason: 'The same external blocker is still present',
          evidenceRefs: ['tool-result-1'],
          blockerKind: 'repeated',
        }),
      );

    const first = await build().execute(new AbortController().signal);
    const second = await build().execute(new AbortController().signal);

    for (const result of [first, second]) {
      expect(JSON.parse(String(result.llmContent))).toEqual({
        proposalRecorded: result === first,
        readyForVerification: false,
        goalLifecycleChanged: false,
        nextAction:
          'Continue this turn without claiming the Goal is complete or blocked. A repeated-blocker audit requires the same blocker mode and exact same reason text across three consecutive Goal turns, with current evidence cited on each turn.',
      });
      expect(result.terminateTurn).toBeUndefined();
    }
    expect(first.returnDisplay).toContain('blocker audit');
    expect(second.returnDisplay).toContain('already recorded');
  });

  it('rejects a second proposal in the same exact turn', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const tool = new UpdateGoalTool(makeConfig(runtime));
    const build = () =>
      goalTurnContext.run(activePermit, () =>
        tool.build({
          status: 'complete',
          reason: 'Focused tests passed',
          evidenceRefs: ['tool-result-1'],
        }),
      );

    await build().execute(new AbortController().signal);
    const second = await build().execute(new AbortController().signal);

    expect(JSON.parse(String(second.llmContent))).toEqual({
      proposalRecorded: false,
      readyForVerification: true,
      goalLifecycleChanged: false,
      nextAction:
        'End this turn without user-facing text. Do not claim the Goal is complete or blocked. The Goal status card will report the independent verification result.',
    });
    expect(second.returnDisplay).toContain('already recorded');
    expect(second.returnDisplay).not.toContain('Goal is complete');
    expect(second.terminateTurn).toBe(true);
  });

  it('rejects a proposal after pause invalidates its permit', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const invocation = goalTurnContext.run(activePermit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'blocked',
        reason: 'Needs authority',
        evidenceRefs: ['user-request-1'],
        blockerKind: 'authority',
      }),
    );
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: activePermit.goalId,
      expectedRevision: activePermit.revision,
    });

    await expect(
      invocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
  });

  it('requires a non-empty reason and stable evidence references', () => {
    const { runtime } = {
      runtime: {} as GoalRuntime,
    };
    const tool = new UpdateGoalTool(makeConfig(runtime));

    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'x'.repeat(GOAL_PROPOSAL_REASON_MAX_CHARACTERS),
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'é'.repeat(GOAL_PROPOSAL_REASON_MAX_BYTES / 2),
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: '   ',
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).toThrow(/reason/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'blocked',
          reason: 'Waiting for authority',
          evidenceRefs: [],
        }),
      ),
    ).toThrow(/evidence/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'blocked',
          reason: 'Waiting for authority',
          evidenceRefs: ['   '],
        }),
      ),
    ).toThrow(/evidence/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'Focused tests passed',
          evidenceRefs: ['same-reference', ' same-reference '],
        }),
      ),
    ).toThrow('evidenceRefs must contain unique stable evidence references');
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'x'.repeat(GOAL_PROPOSAL_REASON_MAX_CHARACTERS + 1),
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).toThrow(/characters/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: '界'.repeat(
            Math.floor(GOAL_PROPOSAL_REASON_MAX_BYTES / 3) + 1,
          ),
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).toThrow(/UTF-8 bytes/i);
  });

  it.each(['edit', 'replace', 'clear', 'finish'] as const)(
    'rejects both delayed tools after %s invalidates the captured permit',
    async (action) => {
      const { runtime, permit: activePermit } = await activeRuntime();
      const config = makeConfig(runtime);
      const getInvocation = goalTurnContext.run(activePermit, () =>
        new GetGoalTool(config).build({}),
      );
      const updateInvocation = goalTurnContext.run(activePermit, () =>
        new UpdateGoalTool(config).build({
          status: 'complete',
          reason: 'Focused tests passed',
          evidenceRefs: ['tool-result-1'],
        }),
      );

      if (action === 'finish') {
        await runtime.finishTurn(activePermit);
      } else if (action === 'clear') {
        await runtime.dispatch({
          action,
          expectedGoalId: activePermit.goalId,
          expectedRevision: activePermit.revision,
        });
      } else {
        await runtime.dispatch({
          action,
          objective: 'Changed objective',
          expectedGoalId: activePermit.goalId,
          expectedRevision: activePermit.revision,
        });
      }

      await expect(
        getInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      await expect(
        updateInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
    },
  );

  it('keeps the exact runtime captured at build across a session swap', async () => {
    const oldGetGoalForWorker = vi
      .fn()
      .mockRejectedValue(new Error('Goal runtime has been disposed'));
    const newGetGoalForWorker = vi.fn().mockResolvedValue({
      goalId: 'new-goal',
      revision: 1,
      objective: 'new session',
      evidenceCursor: { recordId: 'new-cursor' },
    });
    const oldRuntime = {
      getGoalForWorker: oldGetGoalForWorker,
      recordTerminalProposal: vi.fn(),
    } as unknown as GoalRuntime;
    const newRuntime = {
      getGoalForWorker: newGetGoalForWorker,
      recordTerminalProposal: vi.fn(),
    } as unknown as GoalRuntime;
    const getGoalRuntime = vi.fn().mockReturnValue(oldRuntime);
    const config: GoalToolConfig = { getGoalRuntime };
    const getInvocation = goalTurnContext.run(permit, () =>
      new GetGoalTool(config).build({}),
    );
    const updateInvocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(config).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );
    getGoalRuntime.mockReturnValue(newRuntime);

    await expect(
      getInvocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
    await expect(
      updateInvocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
    expect(oldGetGoalForWorker).toHaveBeenCalledTimes(2);
    expect(newGetGoalForWorker).not.toHaveBeenCalled();
    expect(getGoalRuntime).toHaveBeenCalledTimes(2);
  });

  it('propagates unexpected worker-view errors from both tools', async () => {
    const unexpectedError = new Error('unexpected database failure');
    const getGoalForWorker = vi.fn().mockRejectedValue(unexpectedError);
    const runtime = {
      getGoalForWorker,
      recordTerminalProposal: vi.fn(),
    } as unknown as GoalRuntime;
    const config = makeConfig(runtime);
    const getInvocation = goalTurnContext.run(permit, () =>
      new GetGoalTool(config).build({}),
    );
    const updateInvocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(config).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );

    await expect(
      getInvocation.execute(new AbortController().signal),
    ).rejects.toBe(unexpectedError);
    await expect(
      updateInvocation.execute(new AbortController().signal),
    ).rejects.toBe(unexpectedError);
    expect(getGoalForWorker).toHaveBeenCalledTimes(2);
    expect(runtime.recordTerminalProposal).not.toHaveBeenCalled();
  });

  it('honors cancellation before recording an update proposal', async () => {
    const workerRead = deferred<{
      goalId: string;
      revision: number;
      objective: string;
      evidenceCursor: { recordId: string };
    }>();
    const recordTerminalProposal = vi.fn();
    const getGoalForWorker = vi.fn(() => workerRead.promise);
    const runtime = {
      getGoalForWorker,
      getSnapshotForPermit: vi.fn(),
      recordTerminalProposal,
    };
    const invocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );
    const controller = new AbortController();
    const execution = invocation.execute(controller.signal);
    await vi.waitFor(() => expect(getGoalForWorker).toHaveBeenCalledOnce());

    controller.abort(new Error('cancelled'));

    await expect(execution).rejects.toThrow('cancelled');
    workerRead.resolve({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Ship Goal v3',
      evidenceCursor: { recordId: 'cursor' },
    });
    await Promise.resolve();
    expect(recordTerminalProposal).not.toHaveBeenCalled();
  });

  it.each(['missing snapshot API', 'stale snapshot API'] as const)(
    'fails both tools closed with a stable stale-permit error for a %s',
    async (scenario) => {
      const getGoalForWorker = vi.fn().mockResolvedValue({
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'old session',
        evidenceCursor: { recordId: 'old-cursor' },
      });
      const recordTerminalProposal = vi.fn().mockReturnValue({
        recorded: true,
        readyForVerification: true,
      });
      const runtime = {
        getGoalForWorker,
        recordTerminalProposal,
        ...(scenario === 'stale snapshot API'
          ? {
              getSnapshotForPermit: vi.fn(() => {
                throw new Error('Goal turn permit is no longer valid');
              }),
            }
          : {}),
      } as unknown as GoalRuntime;
      const config = makeConfig(runtime);
      const getInvocation = goalTurnContext.run(permit, () =>
        new GetGoalTool(config).build({}),
      );
      const updateInvocation = goalTurnContext.run(permit, () =>
        new UpdateGoalTool(config).build({
          status: 'complete',
          reason: 'done',
          evidenceRefs: ['evidence-1'],
        }),
      );

      await expect(
        getInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      await expect(
        updateInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      expect(recordTerminalProposal).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['get_goal', 'goalId'],
    ['get_goal', 'revision'],
    ['update_goal', 'goalId'],
    ['update_goal', 'revision'],
  ] as const)(
    'rejects a %s worker view with a mismatched %s after an exact snapshot check',
    async (toolName, mismatchedField) => {
      const matchingSnapshot = {
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'permitted goal',
          status: 'active' as const,
          evidenceCursor: { recordId: 'cursor-1' },
          turnCount: 1,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
      const getGoalForWorker = vi.fn().mockResolvedValue({
        goalId: mismatchedField === 'goalId' ? 'different-goal' : permit.goalId,
        revision:
          mismatchedField === 'revision'
            ? permit.revision + 1
            : permit.revision,
        objective: 'wrong worker view',
        evidenceCursor: { recordId: 'wrong-cursor' },
      });
      const recordTerminalProposal = vi.fn();
      const runtime = {
        getGoalForWorker,
        getSnapshotForPermit: vi.fn(() => structuredClone(matchingSnapshot)),
        recordTerminalProposal,
      };
      const config = makeConfig(runtime);
      const invocation = goalTurnContext.run(permit, () =>
        toolName === 'get_goal'
          ? new GetGoalTool(config).build({})
          : new UpdateGoalTool(config).build({
              status: 'complete',
              reason: 'done',
              evidenceRefs: ['evidence-1'],
            }),
      );

      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      expect(recordTerminalProposal).not.toHaveBeenCalled();
    },
  );

  it.each(['get_goal', 'update_goal'] as const)(
    'normalizes disposal after the awaited %s worker read',
    async (toolName) => {
      const { runtime, permit: activePermit } = await activeRuntime();
      const originalGetGoalForWorker = runtime.getGoalForWorker.bind(runtime);
      vi.spyOn(runtime, 'getGoalForWorker').mockImplementation(
        async (runtimePermit) => {
          const view = await originalGetGoalForWorker(runtimePermit);
          runtime.dispose();
          return view;
        },
      );
      const recordTerminalProposal = vi.spyOn(
        runtime,
        'recordTerminalProposal',
      );
      const invocation = goalTurnContext.run(activePermit, () =>
        toolName === 'get_goal'
          ? new GetGoalTool(makeConfig(runtime)).build({})
          : new UpdateGoalTool(makeConfig(runtime)).build({
              status: 'complete',
              reason: 'done',
              evidenceRefs: ['evidence-1'],
            }),
      );

      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      expect(recordTerminalProposal).not.toHaveBeenCalled();
    },
  );

  it('normalizes disposal from proposal recording', async () => {
    const runtime = {
      getGoalForWorker: vi.fn().mockResolvedValue({
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'permitted goal',
        evidenceCursor: { recordId: 'cursor-1' },
      }),
      getSnapshotForPermit: vi.fn(() => ({
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'permitted goal',
          status: 'active' as const,
          evidenceCursor: { recordId: 'cursor-1' },
          turnCount: 1,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })),
      recordTerminalProposal: vi.fn(() => {
        throw new Error('Goal runtime has been disposed');
      }),
    };
    const invocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );

    await expect(
      invocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
  });

  it('does not expose Goal lifecycle controls through either invocation', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const dispatch = vi.spyOn(runtime, 'dispatch');
    const getInvocation = goalTurnContext.run(activePermit, () =>
      new GetGoalTool(makeConfig(runtime)).build({}),
    );
    const updateInvocation = goalTurnContext.run(activePermit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );

    await getInvocation.execute(new AbortController().signal);
    await updateInvocation.execute(new AbortController().signal);

    expect(dispatch).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().goal?.status).toBe('active');
  });
});

describe('ProposeGoalTool', () => {
  const objective =
    'Outcome: auth tests pass. Done when: 1) `npm test` exits 0 (paste the summary line). Must not: edit test files. Budget: stop as blocked after 20 turns. On block: report the blocker.';

  function proposeConfig(
    runtime: Partial<GoalRuntime> | (() => never),
    overrides: Partial<ProposeGoalToolConfig> = {},
  ): ProposeGoalToolConfig {
    return {
      getGoalRuntime:
        typeof runtime === 'function'
          ? runtime
          : vi.fn(() => runtime as GoalRuntime),
      isTrustedFolder: () => true,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      ...overrides,
    };
  }

  function idleRuntime() {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const host = fakeHost();
    runtime.bindHost(host);
    return { runtime, host };
  }

  async function confirm(
    tool: ProposeGoalTool,
    outcome: ToolConfirmationOutcome,
    params = { objective },
  ) {
    const invocation = tool.build(params);
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await details.onConfirm(outcome);
    return { invocation, details };
  }

  it('uses the canonical name, stays visible, and always goes through the dialog', async () => {
    const tool = new ProposeGoalTool(proposeConfig(idleRuntime().runtime));
    expect(tool.name).toBe(ToolNames.PROPOSE_GOAL);
    expect(tool.displayName).toBe(ToolDisplayNames.PROPOSE_GOAL);
    expect(tool.shouldDefer).toBe(false);

    const invocation = tool.build({ objective });
    // Consent for an autonomous loop cannot come from a rule or an approval
    // mode; YOLO and AUTO_EDIT would otherwise approve an `info` dialog.
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    expect(await invocation.getDefaultPermission()).toBe('ask');
    expect(invocation.getDescription()).toContain(objective);
  });

  it('validates the objective', () => {
    const tool = new ProposeGoalTool(proposeConfig(idleRuntime().runtime));
    expect(tool.validateToolParams({ objective: '   ' })).not.toBeNull();
    expect(
      tool.validateToolParams({
        objective: 'x'.repeat(PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS + 1),
      }),
    ).not.toBeNull();
    expect(tool.validateToolParams({ objective })).toBeNull();
  });

  it('shows the objective in a plain-text info dialog and sets the Goal on approval', async () => {
    const { runtime, host } = idleRuntime();
    const tool = new ProposeGoalTool(proposeConfig(runtime));

    const { invocation, details } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect(details.type).toBe('info');
    if (details.type !== 'info') return;
    expect(details.renderPromptAsPlainText).toBe(true);
    expect(details.prompt).toContain('Set this as the session Goal?');
    expect(details.prompt).toContain(objective);

    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.llmContent as string);
    expect(payload.goalSet).toBe(true);
    expect(payload.objective).toBe(objective);
    expect(payload.replacedGoalId).toBeUndefined();
    expect(payload.next).toContain('end this turn');

    const goal = runtime.getSnapshot().goal;
    expect(goal?.goalId).toBe(payload.goalId);
    expect(goal?.status).toBe('active');
    expect(goal?.objective).toBe(objective);
    // The runtime, not the tool, drives the first Goal turn.
    expect(host.started).toHaveLength(1);
    expect(result.returnDisplay).toContain('Goal set');
  });

  it('sets nothing when the dialog was cancelled', async () => {
    const { runtime, host } = idleRuntime();
    const tool = new ProposeGoalTool(proposeConfig(runtime));

    const { invocation } = await confirm(tool, ToolConfirmationOutcome.Cancel);
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(result.llmContent).toBe(PROPOSE_GOAL_NOT_APPROVED_MESSAGE);
    expect(runtime.getSnapshot().goal).toBeNull();
    expect(host.started).toHaveLength(0);
  });

  it('refuses before the dialog in plan mode, in an untrusted folder, and without persistence', async () => {
    const { runtime } = idleRuntime();
    const signal = new AbortController().signal;

    await expect(
      new ProposeGoalTool(
        proposeConfig(runtime, { getApprovalMode: () => ApprovalMode.PLAN }),
      )
        .build({ objective })
        .getConfirmationDetails(signal),
    ).rejects.toThrow(PROPOSE_GOAL_PLAN_MODE_MESSAGE);

    await expect(
      new ProposeGoalTool(
        proposeConfig(runtime, { isTrustedFolder: () => false }),
      )
        .build({ objective })
        .getConfirmationDetails(signal),
    ).rejects.toThrow(PROPOSE_GOAL_UNTRUSTED_MESSAGE);

    await expect(
      new ProposeGoalTool(
        proposeConfig(() => {
          throw new Error('no persistence');
        }),
      )
        .build({ objective })
        .getConfirmationDetails(signal),
    ).rejects.toThrow(PROPOSE_GOAL_UNAVAILABLE_MESSAGE);

    expect(runtime.getSnapshot().goal).toBeNull();
  });

  it('refuses to replace an active Goal and points at /goal edit', async () => {
    const { runtime } = await activeRuntime();
    const tool = new ProposeGoalTool(proposeConfig(runtime));

    await expect(
      tool
        .build({ objective })
        .getConfirmationDetails(new AbortController().signal),
    ).rejects.toThrow('/goal edit');
    expect(runtime.getSnapshot().goal?.objective).toBe('Ship Goal v3');
  });

  it('replaces a stopped Goal on approval', async () => {
    const { runtime, host } = idleRuntime();
    await runtime.dispatch({ action: 'create', objective: 'Ship Goal v3' });
    const paused = runtime.getSnapshot().goal!;
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: paused.goalId,
      expectedRevision: paused.revision,
    });
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
    const startedBefore = host.started.length;
    const tool = new ProposeGoalTool(proposeConfig(runtime));

    const { invocation, details } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );
    if (details.type !== 'info') throw new Error('expected info');
    expect(details.prompt).toContain('Replace the paused Goal');

    const result = await invocation.execute(new AbortController().signal);
    const payload = JSON.parse(result.llmContent as string);
    expect(payload.replacedGoalId).toBe(paused.goalId);
    expect(payload.goalId).not.toBe(paused.goalId);
    const goal = runtime.getSnapshot().goal;
    expect(goal?.goalId).toBe(payload.goalId);
    expect(goal?.status).toBe('active');
    expect(goal?.objective).toBe(objective);
    expect(host.started.length).toBe(startedBefore + 1);
  });

  it('does not set a Goal that changed while the dialog was open', async () => {
    const { runtime } = idleRuntime();
    const tool = new ProposeGoalTool(proposeConfig(runtime));
    const { invocation } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );

    // The user typed `/goal set …` while the proposal dialog was up.
    await runtime.dispatch({ action: 'create', objective: 'Typed by hand' });

    const result = await invocation.execute(new AbortController().signal);
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(result.llmContent).toContain('already active');
    expect(runtime.getSnapshot().goal?.objective).toBe('Typed by hand');
  });
});
