/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentCore } from './agent-core.js';
import { ToolMode } from '../../tools/code-mode.js';
import { ToolNames } from '../../tools/tool-names.js';
import { ExecTool } from '../../tools/exec.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import {
  hasAgentSkillExecBinding,
  isAgentSkillEagerHidden,
  toolConfigAllowsSkill,
} from './subagent-plan-tool-policy.js';

function fixture() {
  const config = makeFakeConfig({ toolMode: ToolMode.CodeMode });
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  vi.spyOn(config, 'getVisibleTools').mockReturnValue(
    new Set([ToolNames.SKILL, ToolNames.READ_FILE]),
  );
  registry.registerPermissionDeferredFactory(
    ToolNames.EXEC,
    async () => new ExecTool(config),
  );
  registry.registerTool(new MockTool({ name: ToolNames.SKILL }));
  registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
  return { config, registry };
}

describe('R33-62 eager exec skill visibility', () => {
  it('advertises the always-loaded exec route before warming lazy factories', () => {
    const { config, registry } = fixture();
    expect(registry.isPermissionDeferred(ToolNames.EXEC)).toBe(true);
    expect(hasAgentSkillExecBinding(config)).toBe(true);
    expect(
      toolConfigAllowsSkill(
        { tools: [ToolNames.EXEC] },
        hasAgentSkillExecBinding(config),
        isAgentSkillEagerHidden(config),
      ),
    ).toBe(true);
  });

  it('agrees with the actual AgentCore skill invocation gate', async () => {
    const { config, registry } = fixture();
    const core = new AgentCore(
      'eager-exec-reproduction',
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
      { tools: [ToolNames.EXEC] },
    );
    const internals = core as unknown as {
      willHaveSkillTool: () => boolean;
      canInvokeSkill: (declared: ReadonlySet<string>) => boolean;
    };
    const announcedBeforePrepare = internals.willHaveSkillTool();
    const declared = new Set(
      (await core.prepareTools())
        .map((x) => x.name)
        .filter((x): x is string => !!x),
    );
    expect(registry.isPermissionDeferred(ToolNames.EXEC)).toBe(true);
    expect(registry.isDeferredAndHidden(ToolNames.EXEC)).toBe(false);
    expect(declared.has(ToolNames.EXEC)).toBe(true);
    expect(internals.canInvokeSkill(declared)).toBe(true);
    expect(announcedBeforePrepare).toBe(true);
    expect(internals.willHaveSkillTool()).toBe(true);
  });

  it('still withholds an ordinary eager-hidden skill', () => {
    const { config, registry } = fixture();
    registry.registerPermissionDeferredFactory(
      ToolNames.SKILL,
      async () => new MockTool({ name: ToolNames.SKILL }),
    );
    vi.spyOn(config, 'getVisibleTools').mockReturnValue(new Set());
    expect(isAgentSkillEagerHidden(config)).toBe(true);
    expect(hasAgentSkillExecBinding(config)).toBe(false);
  });
});
