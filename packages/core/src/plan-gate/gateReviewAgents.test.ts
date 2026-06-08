/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseGateAgentResult, formatEvidence } from './gateReviewAgents.js';
import type { EvidenceBundle } from './types.js';

describe('parseGateAgentResult', () => {
  it('should parse valid JSON', () => {
    const json = JSON.stringify({
      agent: 'request_fit',
      decision: 'pass',
      findings: [],
      limitations: [],
      reviewedEvidence: ['plan'],
    });
    const result = parseGateAgentResult(json, 'request_fit');
    expect(result.agent).toBe('request_fit');
    expect(result.decision).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  it('should parse markdown-fenced JSON', () => {
    const raw =
      '```json\n{"agent":"system_fit","decision":"blocked","findings":[{"localId":"SF-1","severity":"P2","issue":"wrong path","rationale":"moved"}],"limitations":[],"reviewedEvidence":[]}\n```';
    const result = parseGateAgentResult(raw, 'system_fit');
    expect(result.decision).toBe('blocked');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('P2');
  });

  it('should parse fenced JSON without lang tag', () => {
    const raw =
      '```\n{"agent":"request_fit","decision":"pass","findings":[],"limitations":[],"reviewedEvidence":[]}\n```';
    const result = parseGateAgentResult(raw, 'request_fit');
    expect(result.decision).toBe('pass');
  });

  it('should throw on invalid JSON', () => {
    expect(() =>
      parseGateAgentResult('not json at all', 'request_fit'),
    ).toThrow('returned invalid JSON');
  });

  it('should throw on invalid decision value', () => {
    const json = JSON.stringify({
      agent: 'request_fit',
      decision: 'maybe',
      findings: [],
    });
    expect(() => parseGateAgentResult(json, 'request_fit')).toThrow(
      'returned invalid decision',
    );
  });

  it('should default invalid severity to P2', () => {
    const json = JSON.stringify({
      agent: 'request_fit',
      decision: 'blocked',
      findings: [
        { localId: 'RF-1', severity: 'HIGH', issue: 'x', rationale: 'y' },
      ],
      limitations: [],
      reviewedEvidence: [],
    });
    const result = parseGateAgentResult(json, 'request_fit');
    expect(result.findings[0]!.severity).toBe('P2');
  });

  it('should assign a fallback localId when missing', () => {
    const json = JSON.stringify({
      agent: 'execution_readiness',
      decision: 'blocked',
      findings: [{ severity: 'P1', issue: 'test', rationale: 'why' }],
      limitations: [],
      reviewedEvidence: [],
    });
    const result = parseGateAgentResult(json, 'execution_readiness');
    expect(result.findings[0]!.localId).toBe('EXECUTION_READINESS-1');
  });

  it('should use the expected role, not the agent field in the JSON', () => {
    const json = JSON.stringify({
      agent: 'wrong_name',
      decision: 'pass',
      findings: [],
      limitations: [],
      reviewedEvidence: [],
    });
    const result = parseGateAgentResult(json, 'system_fit');
    expect(result.agent).toBe('system_fit');
  });

  it('should handle missing optional arrays gracefully', () => {
    const json = JSON.stringify({
      agent: 'request_fit',
      decision: 'pass',
    });
    const result = parseGateAgentResult(json, 'request_fit');
    expect(result.findings).toEqual([]);
    expect(result.limitations).toEqual([]);
    expect(result.reviewedEvidence).toEqual([]);
  });
});

describe('formatEvidence', () => {
  it('should include all provided sections', () => {
    const bundle: EvidenceBundle = {
      originalRequest: 'Add a button',
      userAdditions: ['Make it blue'],
      plan: 'Step 1: create button',
      researchSummary: 'Found Button.tsx',
      keyContext: ['file: src/Button.tsx'],
      lastFindings: [
        {
          id: 'GF-1',
          severity: 'P2',
          issue: 'Missing color prop',
          rationale: 'user asked for blue',
          reportedBy: ['request_fit'],
        },
      ],
      resolutionSummary: 'GF-1: added color prop',
      agentLimitations: ['Could not read test file'],
    };
    const text = formatEvidence(bundle);
    expect(text).toContain('Add a button');
    expect(text).toContain('Make it blue');
    expect(text).toContain('Step 1: create button');
    expect(text).toContain('Found Button.tsx');
    expect(text).toContain('src/Button.tsx');
    expect(text).toContain('GF-1');
    expect(text).toContain('added color prop');
    expect(text).toContain('Could not read test file');
  });

  it('should omit empty optional sections', () => {
    const bundle: EvidenceBundle = {
      originalRequest: 'Do X',
      userAdditions: [],
      plan: 'Step 1',
    };
    const text = formatEvidence(bundle);
    expect(text).toContain('Do X');
    expect(text).toContain('Step 1');
    expect(text).not.toContain('User Additions');
    expect(text).not.toContain('Research Summary');
    expect(text).not.toContain('Previous Gate Findings');
  });
});
