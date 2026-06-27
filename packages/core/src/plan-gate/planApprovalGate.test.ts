/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assignFindingIds, runPlanApprovalGate } from './planApprovalGate.js';
import type { GateAgentResult, EvidenceBundle } from './types.js';
import { type PlanGateState, createPlanGateState } from './state.js';
import type { Config } from '../config/config.js';

// ── assignFindingIds unit tests ───────────────────────────────────────

describe('assignFindingIds', () => {
  it('should assign stable GF-N ids in order', () => {
    const result: GateAgentResult = {
      agent: 'plan_reviewer',
      decision: 'blocked',
      findings: [
        {
          localId: 'GF-1',
          severity: 'P2',
          issue: 'Missing feature X',
          rationale: 'not addressed',
        },
        {
          localId: 'GF-2',
          severity: 'P3',
          issue: 'Wrong file path',
          rationale: 'file moved',
        },
      ],
    };
    const merged = assignFindingIds(result);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.id).toBe('GF-1');
    expect(merged[1]!.id).toBe('GF-2');
  });

  it('should return empty array when agent passes', () => {
    const result: GateAgentResult = {
      agent: 'plan_reviewer',
      decision: 'pass',
      findings: [],
    };
    const merged = assignFindingIds(result);
    expect(merged).toHaveLength(0);
  });

  it('should preserve all finding fields', () => {
    const result: GateAgentResult = {
      agent: 'plan_reviewer',
      decision: 'blocked',
      findings: [
        {
          localId: 'GF-1',
          severity: 'P1',
          issue: 'Critical',
          rationale: 'violates request',
          suggestedFix: 'Fix it',
          suggestedQuestion: 'Are you sure?',
        },
      ],
    };
    const merged = assignFindingIds(result);
    expect(merged[0]).toEqual({
      id: 'GF-1',
      severity: 'P1',
      issue: 'Critical',
      rationale: 'violates request',
      suggestedFix: 'Fix it',
      suggestedQuestion: 'Are you sure?',
    });
  });
});

// ── runPlanApprovalGate ───────────────────────────────────────────────

vi.mock('./gateReviewAgents.js', () => ({
  runGateAgent: vi.fn(),
}));

import { runGateAgent } from './gateReviewAgents.js';

const mockRunGateAgent = vi.mocked(runGateAgent);

function makeResult(overrides: Partial<GateAgentResult> = {}): GateAgentResult {
  return {
    agent: 'plan_reviewer',
    decision: 'pass',
    findings: [],
    ...overrides,
  };
}

describe('runPlanApprovalGate', () => {
  let gateState: PlanGateState;
  let mockConfig: Config;
  const signal = new AbortController().signal;

  const bundle: EvidenceBundle = {
    originalRequest: 'Add a button',
    plan: 'Step 1: add button component',
  };

  beforeEach(() => {
    gateState = createPlanGateState(1);
    mockConfig = {
      getPlanGateState: vi.fn(() => gateState),
      getSubagentManager: vi.fn(),
    } as unknown as Config;
    mockRunGateAgent.mockReset();
  });

  it('should return unavailable when no gate state', async () => {
    (mockConfig.getPlanGateState as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('unavailable');
  });

  it('should return approved when agent passes with no findings', async () => {
    mockRunGateAgent.mockResolvedValue(makeResult({ decision: 'pass' }));

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('approved');
  });

  it('should return unavailable when agent reports itself as unavailable (even with empty findings)', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({ decision: 'unavailable', findings: [] }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('unavailable');
    expect((decision as { reason: string }).reason).toContain('unavailable');
  });

  it('should return blocked when agent has P1 findings', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'blocked',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P1',
            issue: 'Critical flaw',
            rationale: 'violates request',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('blocked');
  });

  it('should return needs_user when agent returns needs_user with suggestedQuestion', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'needs_user',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P2',
            issue: 'Ambiguous scope',
            rationale: 'unclear',
            suggestedQuestion: 'Do you want feature A or B?',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('needs_user');
    expect((decision as { questions: string[] }).questions).toEqual([
      'Do you want feature A or B?',
    ]);
  });

  it('should fall through to blocked when needs_user has no suggestedQuestion', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'needs_user',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P2',
            issue: 'Missing info',
            rationale: 'no question provided',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('blocked');
  });

  it('should return cap_escalation when at cap with blocking findings', async () => {
    gateState.reviewCount = 4; // next will be 5 (= CAPPED_REVIEW_LIMIT)
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'blocked',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P1',
            issue: 'Still broken',
            rationale: 'unresolved',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('cap_escalation');
  });

  it('should approve with non-blocking notes when at cap with only P3 findings', async () => {
    gateState.reviewCount = 4;
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'blocked',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P3',
            issue: 'Minor style',
            rationale: 'nit',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('approved');
    expect(
      (decision as { nonBlockingFindings?: unknown[] }).nonBlockingFindings,
    ).toHaveLength(1);
  });

  it('should return unavailable when agent exhausts retries', async () => {
    mockRunGateAgent.mockRejectedValue(new Error('network error'));

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('unavailable');
    expect((decision as { reason: string }).reason).toContain('retries');
  });
});

// ── Cap logic tests ───────────────────────────────────────────────────

describe('runPlanApprovalGate decision edge cases', () => {
  let gateState: PlanGateState;
  let mockConfig: Config;
  const signal = new AbortController().signal;

  const bundle: EvidenceBundle = {
    originalRequest: 'Add a button',
    plan: 'Step 1: add button component',
  };

  beforeEach(() => {
    gateState = createPlanGateState(1);
    mockConfig = {
      getPlanGateState: vi.fn(() => gateState),
      getSubagentManager: vi.fn(),
    } as unknown as Config;
    mockRunGateAgent.mockReset();
  });

  it('should return unavailable when needs_user has empty findings', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({ decision: 'needs_user', findings: [] }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('unavailable');
    expect((decision as { reason: string }).reason).toContain('needs_user');
  });

  it('should return unavailable when blocked has empty findings', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({ decision: 'blocked', findings: [] }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('unavailable');
    expect((decision as { reason: string }).reason).toContain('blocked');
  });

  it('should treat pass-with-findings as blocked', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'pass',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P2',
            issue: 'Anomalous finding',
            rationale: 'should not pass',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('blocked');
  });

  it('should return unavailable when pre-aborted signal', async () => {
    const abortController = new AbortController();
    abortController.abort();
    mockRunGateAgent.mockRejectedValue(new Error('aborted'));

    const decision = await runPlanApprovalGate(
      mockConfig,
      bundle,
      abortController.signal,
    );
    expect(decision.kind).toBe('unavailable');
  });

  it('should succeed after partial retries (fail 2, then succeed)', async () => {
    mockRunGateAgent
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce(makeResult({ decision: 'pass' }));

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('approved');
    expect(mockRunGateAgent).toHaveBeenCalledTimes(3);
  });

  it('should handle uncapped mode (findings still block without cap escalation)', async () => {
    gateState.gateMode = 'uncapped';
    gateState.reviewCount = 10;
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'blocked',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P1',
            issue: 'Critical',
            rationale: 'bad',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('blocked');
  });

  it('should increment reviewCount on each gate run', async () => {
    expect(gateState.reviewCount).toBe(0);
    mockRunGateAgent.mockResolvedValue(makeResult({ decision: 'pass' }));

    await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(gateState.reviewCount).toBe(1);
  });

  it('should store findings in gateState.lastFindings', async () => {
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'blocked',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P2',
            issue: 'Test issue',
            rationale: 'test',
          },
        ],
      }),
    );

    await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(gateState.lastFindings).toHaveLength(1);
    expect(gateState.lastFindings[0]!.id).toBe('GF-1');
  });

  it('P3-only at cap approves with nonBlockingFindings', async () => {
    gateState.reviewCount = 4;
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'blocked',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P3',
            issue: 'Minor',
            rationale: 'nit',
          },
          {
            localId: 'GF-2',
            severity: 'P3',
            issue: 'Also minor',
            rationale: 'style',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('approved');
    expect(
      (decision as { nonBlockingFindings?: unknown[] }).nonBlockingFindings,
    ).toHaveLength(2);
  });

  it('P1 at cap triggers cap_escalation with only blocking findings', async () => {
    gateState.reviewCount = 4;
    mockRunGateAgent.mockResolvedValue(
      makeResult({
        decision: 'blocked',
        findings: [
          {
            localId: 'GF-1',
            severity: 'P1',
            issue: 'Critical',
            rationale: 'bad',
          },
          {
            localId: 'GF-2',
            severity: 'P3',
            issue: 'Minor',
            rationale: 'nit',
          },
        ],
      }),
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('cap_escalation');
    const escalation = decision as { blockingFindings: Array<{ id: string }> };
    expect(escalation.blockingFindings).toHaveLength(1);
    expect(escalation.blockingFindings[0]!.id).toBe('GF-1');
  });
});
