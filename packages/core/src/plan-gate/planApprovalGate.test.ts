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
      limitations: [],
      reviewedEvidence: [],
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
      limitations: [],
      reviewedEvidence: [],
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
      limitations: [],
      reviewedEvidence: [],
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
  });

  it('should return unavailable when no gate state', async () => {
    (mockConfig.getPlanGateState as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );

    const decision = await runPlanApprovalGate(mockConfig, bundle, signal);
    expect(decision.kind).toBe('unavailable');
  });
});

// ── Cap logic tests ───────────────────────────────────────────────────

describe('cap handling with assignFindingIds', () => {
  it('P3-only findings are identified correctly', () => {
    const result: GateAgentResult = {
      agent: 'plan_reviewer',
      decision: 'blocked',
      findings: [
        {
          localId: 'GF-1',
          severity: 'P3',
          issue: 'Minor thing',
          rationale: 'small',
        },
      ],
      limitations: [],
      reviewedEvidence: [],
    };
    const merged = assignFindingIds(result);
    const hasBlocking = merged.some(
      (f) => f.severity === 'P1' || f.severity === 'P2',
    );
    expect(hasBlocking).toBe(false);
    expect(merged.length).toBeGreaterThan(0);
  });

  it('P1 findings are always blocking', () => {
    const result: GateAgentResult = {
      agent: 'plan_reviewer',
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
          rationale: 'small',
        },
      ],
      limitations: [],
      reviewedEvidence: [],
    };
    const merged = assignFindingIds(result);
    const hasBlocking = merged.some(
      (f) => f.severity === 'P1' || f.severity === 'P2',
    );
    expect(hasBlocking).toBe(true);
  });
});
