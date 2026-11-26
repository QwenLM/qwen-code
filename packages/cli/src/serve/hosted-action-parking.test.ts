/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  hostedApprovalResumeShapeRefusal,
  hostedCommandStepResumeShapeRefusal,
} from './hosted-action-parking.js';
import { hostedConfigScopedOwnerId } from './hosted-hook-session.js';
import { hostedDurableMcpOwnerId } from './hosted-mcp-session.js';

describe('hostedApprovalResumeShapeRefusal', () => {
  const broker = {};
  const files = { toolProfile: 'hosted-workspace-files/1' };

  it('admits a tool profile with a Broker and a memory-only Session', () => {
    expect(hostedApprovalResumeShapeRefusal(files, broker)).toBeUndefined();
    expect(
      hostedApprovalResumeShapeRefusal({ memory: {} }, undefined),
    ).toBeUndefined();
  });

  const configOwner = {
    broker: {
      runtimeSessionId: hostedConfigScopedOwnerId(
        { tenantId: 'tenant', workspaceId: 'workspace', sessionId: 'session' },
        1,
      ),
    },
  };
  const activationOwner = {
    broker: { runtimeSessionId: 'hooks-activation-0' },
  };

  it('admits Hooks only on a config-scoped Hook owner', () => {
    expect(
      hostedApprovalResumeShapeRefusal(
        { ...files, hooks: configOwner },
        broker,
      ),
    ).toBeUndefined();
    expect(
      hostedApprovalResumeShapeRefusal(
        { ...files, hooks: activationOwner },
        broker,
      ),
    ).toBe('hooks_activation_owner');
  });

  const mcpOwner = {
    broker: {
      runtimeSessionId: hostedDurableMcpOwnerId(
        { tenantId: 'tenant', workspaceId: 'workspace', sessionId: 'session' },
        undefined,
      ),
    },
  };

  it('admits MCP on a durable or config-scoped owner, and Hooks that borrow it', () => {
    for (const mcp of [mcpOwner, configOwner])
      expect(
        hostedApprovalResumeShapeRefusal({ ...files, mcp }, broker),
      ).toBeUndefined();
    expect(
      hostedApprovalResumeShapeRefusal(
        { ...files, mcp: mcpOwner, hooks: mcpOwner },
        broker,
      ),
    ).toBeUndefined();
    // An MCP Session with settings but no configuration rows takes the
    // latest Hook execution's owner, which may be activation-scoped.
    expect(
      hostedApprovalResumeShapeRefusal(
        { ...files, mcp: activationOwner, hooks: activationOwner },
        broker,
      ),
    ).toBe('mcp_activation_owner');
    expect(
      hostedApprovalResumeShapeRefusal(
        { ...files, mcp: mcpOwner, hooks: activationOwner },
        broker,
      ),
    ).toBe('hooks_activation_owner');
  });

  it('names the MCP owner before the Hook owner, and both before the tool owner', () => {
    expect(
      hostedApprovalResumeShapeRefusal(
        { hooks: activationOwner, mcp: activationOwner },
        undefined,
      ),
    ).toBe('mcp_activation_owner');
    expect(
      hostedApprovalResumeShapeRefusal({ hooks: activationOwner }, undefined),
    ).toBe('hooks_activation_owner');
  });

  it('refuses a Session with no tool owner to resume through', () => {
    expect(hostedApprovalResumeShapeRefusal(files, undefined)).toBe(
      'no_tool_owner',
    );
    expect(hostedApprovalResumeShapeRefusal({}, broker)).toBe('no_tool_owner');
  });
});

describe('hostedCommandStepResumeShapeRefusal', () => {
  const broker = {};
  const shell = {
    toolProfile: 'hosted-workspace-shell/1',
    extensions: { enabled: true },
  };

  it('admits an extensions Session even with a Hook catalog', () => {
    const withHooks = { ...shell, hooks: {} };
    expect(
      hostedCommandStepResumeShapeRefusal(withHooks, broker),
    ).toBeUndefined();
  });

  it('refuses a Session without enabled extensions or a tool owner', () => {
    expect(
      hostedCommandStepResumeShapeRefusal(
        { ...shell, extensions: { enabled: false } },
        broker,
      ),
    ).toBe('extensions_disabled');
    expect(hostedCommandStepResumeShapeRefusal(shell, undefined)).toBe(
      'no_tool_owner',
    );
  });
});
