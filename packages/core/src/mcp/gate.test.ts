/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MCPServerConfig } from './mcpServerConfig.js';
import {
  gateDenyMessage,
  MCP_GATE_DENY_ALLOWLIST,
  MCP_GATE_DENY_EXCLUDELIST,
  MCP_GATE_LIST_DENY_REASONS,
  isHostPolicyDeny,
  MCP_POLICY_BLOCKED_MESSAGE,
  McpSettingsGate,
  type McpGateRequest,
  type McpServerGate,
} from './gate.js';

const gate = new McpSettingsGate();

function request(overrides: Partial<McpGateRequest> = {}): McpGateRequest {
  return {
    config: Object.assign(new MCPServerConfig(), { command: 'node' }),
    serverName: 'docs',
    allowList: [],
    excludeList: [],
    ...overrides,
  };
}

describe('McpSettingsGate', () => {
  it('allows an unrestricted server', () => {
    expect(gate.evaluate(request())).toEqual({ allowed: true });
  });

  it('denies a server missing from a non-empty allowlist', () => {
    const decision = gate.evaluate(request({ allowList: ['other'] }));

    expect(decision).toMatchObject({
      allowed: false,
      reason: MCP_GATE_DENY_ALLOWLIST,
    });
    expect(gateDenyMessage(decision)).toContain('mcp.allowed');
  });

  it('treats an empty allowlist as no restriction', () => {
    expect(gate.evaluate(request({ allowList: [] }))).toEqual({
      allowed: true,
    });
  });

  it('denies a server on the excludelist', () => {
    const decision = gate.evaluate(request({ excludeList: ['docs'] }));

    expect(decision).toMatchObject({
      allowed: false,
      reason: MCP_GATE_DENY_EXCLUDELIST,
    });
    expect(gateDenyMessage(decision)).toContain('mcp.excluded');
  });

  it('reports the allowlist before the excludelist', () => {
    // Order is observable: it decides which remediation the user is told about.
    const decision = gate.evaluate(
      request({ allowList: ['other'], excludeList: ['docs'] }),
    );

    expect(decision).toMatchObject({ reason: MCP_GATE_DENY_ALLOWLIST });
  });

  it('matches list entries exactly, without case folding', () => {
    // Deliberate: folding case here would admit servers the runtime rejects
    // today. `canLoadServer` in the CLI folds case for display only.
    expect(gate.evaluate(request({ allowList: ['DOCS'] }))).toMatchObject({
      allowed: false,
      reason: MCP_GATE_DENY_ALLOWLIST,
    });
    expect(gate.evaluate(request({ excludeList: ['DOCS'] }))).toEqual({
      allowed: true,
    });
  });

  it('has no lifecycle of its own', () => {
    // The settings gate reads through to the caller's inputs, so there is
    // nothing to warm up, poll, or tear down.
    const asGate: McpServerGate = gate;
    expect(asGate.initialize).toBeUndefined();
    expect(asGate.start).toBeUndefined();
    expect(asGate.stop).toBeUndefined();
  });
});

describe('gate deny reasons', () => {
  it('names the administrator-list reasons core reacts to', () => {
    expect(MCP_GATE_LIST_DENY_REASONS).toEqual([
      MCP_GATE_DENY_ALLOWLIST,
      MCP_GATE_DENY_EXCLUDELIST,
    ]);
    // A host policy reason is deliberately not named here: core only needs to
    // tell "the user's own lists rejected it" from "some host policy did".
    expect(MCP_GATE_LIST_DENY_REASONS).not.toContain('enterprise');
    expect(isHostPolicyDeny({ allowed: false, reason: 'enterprise' })).toBe(true);
    expect(
      isHostPolicyDeny({ allowed: false, reason: MCP_GATE_DENY_ALLOWLIST }),
    ).toBe(false);
    expect(isHostPolicyDeny({ allowed: true })).toBe(false);
  });

  it('falls back to a generic message when a gate supplies no wording', () => {
    expect(gateDenyMessage({ allowed: false, reason: 'something-new' })).toBe(
      MCP_POLICY_BLOCKED_MESSAGE,
    );
    expect(
      gateDenyMessage({
        allowed: false,
        reason: 'something-new',
        detail: 'host wording',
      }),
    ).toBe('host wording');
  });

  it('returns no message for an allow', () => {
    expect(gateDenyMessage({ allowed: true })).toBe('');
  });
});
