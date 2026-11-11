/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import { createProviderHttpFixture } from '../test-utils/provider-http-fixture.js';
import { systemPromptFromText } from '../prompts/system-prompt.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

import { runSubagent } from './run-subagent.js';
import { resolveAgentModel } from './run-agent.js';
import { SubagentForkContext } from './subagent-fork-context.js';
import {
  RESOLVED_AGENT_REASONING,
  type LocalAgentDefinition,
} from './types.js';

const scenarios = [
  { name: 'inherit parent effort', effort: 'high' },
  { name: 'independent model', model: 'fixture/model-b', effort: 'high' },
  { name: 'without parent snapshot', noParent: true },
  // The pre-refactor Custom selector still merges parent.config for the same
  // model. These opt-outs prevent carrying effort to a different SDK model;
  // they do not erase the same-model snapshot's effort.
  { name: 'disable parent reasoning', inherit: false, sameModelEffort: 'high' },
  {
    name: 'budget only',
    reasoning: { thinkingBudget: 1024 },
    sameModelEffort: 'high',
  },
  {
    name: 'explicit off',
    reasoning: { thinkingBudget: 0, reasoningEffort: 'none' as const },
    effort: 'none',
  },
];

it.each(
  scenarios.flatMap((scenario) =>
    [false, true].map((policy) => ({ ...scenario, policy })),
  ),
)(
  'E07: $name (SDK changes model=$policy) reaches HTTP with the expected reasoning',
  async (scenario) => {
    const fixture = await createProviderHttpFixture();
    const { config, manager, requests } = fixture;
    try {
      const parentSelection = scenario.noParent
        ? undefined
        : await manager.select({
            purpose: 'main',
            overrideSelection: { config: { reasoning: { effort: 'high' } } },
          });
      const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(async () =>
        scenario.policy ? { model: 'fixture/model-c' } : undefined,
      );
      config.setModelPolicyCallbacks(host);
      const definition: LocalAgentDefinition = {
        kind: 'local',
        name: 'reasoning-probe',
        description: 'Reasoning probe',
        modelConfig: { model: scenario.model ?? 'inherit' },
        promptConfig: { systemPrompt: 'Reply with the marker.' },
        inputConfig: { inputSchema: { type: 'object', properties: {} } },
        runConfig: { maxTimeMinutes: 1 },
        ...(scenario.reasoning
          ? { [RESOLVED_AGENT_REASONING]: scenario.reasoning }
          : {}),
      };
      const context = { config } as AgentLoopContext;
      const model = await resolveAgentModel(
        context,
        definition,
        undefined,
        parentSelection?.model.key,
      );
      const result = await runSubagent({
        definition,
        context,
        model,
        parentSelection,
        inheritParentReasoning: scenario.inherit,
        agentId: 'reasoning-probe',
        promptId: 'reasoning-prompt',
        prompt: 'Return the marker.',
        systemPrompt: systemPromptFromText('Reply with the marker.'),
        sessionId: config.getSessionId(),
        toolRegistry: {
          getSchema: () => [],
        } as unknown as ToolRegistry,
        forkContext: new SubagentForkContext(),
        disableCompression: true,
        maxTurns: 1,
      });
      expect(result.terminal?.reason).toBe('end_turn');
      expect(result.textContent).toBe('PROVIDER_HTTP_OK');
      expect(requests.map((r) => [r.model, r.reasoning_effort])).toEqual([
        [
          scenario.policy
            ? 'model-c'
            : (scenario.model?.split('/')[1] ?? 'model-a'),
          scenario.policy
            ? scenario.effort
            : (scenario.sameModelEffort ?? scenario.effort),
        ],
      ]);
      expect(host).toHaveBeenCalledOnce();
      expect(host.mock.calls[0][5]).toMatchObject({ resolvedModel: model });
      expect(manager.getMainModelKey()).toBe('fixture/model-a');
    } finally {
      await fixture.dispose();
    }
  },
);
