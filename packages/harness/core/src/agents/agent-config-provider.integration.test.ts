/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import { createProviderHttpFixture } from '../test-utils/provider-http-fixture.js';
import { setTestSessionPermission } from '../test-utils/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ReadFileTool } from '../tools/read-file.js';
import { SkillManager } from '../skills/skillManager.js';
import { PermissionManager } from '../permissions/manager/permission-manager.js';
import { executeForkedSkillDirect } from '../tools/activate-skill.js';
import { invokeWorkflowAgent } from '../workflows/workflow-agent-adapter.js';
import { ENV_SUBAGENT_MODEL } from '../config/brand.js';
import { AgentRegistry } from './registry/agentRegistry.js';
import { runLocalAgentInvocation } from './local-agent-runner.js';
import { disposeSessionEventQueue } from './subagent-sdk-events.js';

it.each([
  'agent',
  'skill',
  'workflow',
  'workflow-env',
  'skill-temporary',
  'workflow-temporary',
] as const)(
  'reads defaults and passes only runtime requirements through the real %s/HTTP chain',
  async (entry) => {
    const fixture = await createProviderHttpFixture();
    const { config, manager, requests, dir } = fixture;
    const registry = new AgentRegistry(config);
    const tools = new ToolRegistry(config);
    tools.registerTool(new ReadFileTool(config));
    vi.spyOn(config, 'getAgentRegistry').mockReturnValue(registry);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(tools);
    vi.spyOn(config, 'toolRegistry', 'get').mockReturnValue(tools);
    vi.spyOn(config, 'getSkillManager').mockReturnValue(new SkillManager());
    const permissionManager = new PermissionManager();
    permissionManager.initialize();
    setTestSessionPermission(
      config,
      permissionManager.createSessionPermissionManager({
        getSessionId: () => config.getSessionId(),
        getWorkingDir: () => dir,
        flagSettings: {
          initialMode: 'default',
          rules: { allow: { userSettings: ['Agent'] }, deny: {}, ask: {} },
          additionalDirectories: [],
        },
      }),
    );
    const temporary = entry.endsWith('-temporary');
    try {
      vi.stubEnv(ENV_SUBAGENT_MODEL, '');
      if (!temporary) {
        const result = await registry.registerSdkAgents([
          {
            kind: 'local',
            name: 'reviewer',
            description: 'Review',
            modelConfig: {
              model: 'fixture/model-b',
              generateContentConfig: { temperature: 0.2 },
            },
            effort: 'low',
            promptConfig: { systemPrompt: 'Reply with a marker.' },
            runConfig: { maxTurns: 1 },
          },
        ]);
        expect(result.failed).toEqual([]);
      }
      const select = vi.spyOn(manager, 'select');
      const invoke = async (override: boolean) => {
        const effort = override ? ('high' as const) : undefined;
        const model = override && !temporary ? 'fixture/model-c' : undefined;
        if (entry.startsWith('skill')) {
          const text = await executeForkedSkillDirect(
            config,
            {
              name: 'selection-probe',
              description: 'Selection probe',
              location: `${dir}/SKILL.md`,
              skillRoot: dir,
              body: 'Reply with the marker.',
              context: 'fork',
              agent: temporary ? undefined : 'reviewer',
              model,
              effort,
            },
            undefined,
            new AbortController().signal,
          );
          expect(text).toBe('PROVIDER_HTTP_OK');
        } else if (entry.startsWith('workflow')) {
          const result = await invokeWorkflowAgent({
            config,
            ctx: {
              signal: new AbortController().signal,
              callId: 'workflow-probe',
              modelKey: 'fixture/model-b',
            },
            invocation: {
              index: 1,
              label: 'review',
              prompt: 'Reply with the marker.',
              agentType: temporary ? undefined : 'reviewer',
              model,
              effort,
            },
          });
          expect(result.content).toContain('PROVIDER_HTTP_OK');
        } else {
          await runLocalAgentInvocation({
            definition: registry.getDefinition('reviewer')!,
            context: config,
            agentArgs: { query: 'Reply with the marker.' },
            signal: new AbortController().signal,
            description: 'Review',
            registerTask: false,
            emitSdkSideEvents: false,
            modelOverride: model,
            querySelection: effort
              ? { config: { reasoning: { effort } } }
              : undefined,
          });
        }
      };
      if (entry === 'workflow-env')
        vi.stubEnv(ENV_SUBAGENT_MODEL, 'fixture/model-a');
      await invoke(true);
      const firstModel =
        entry === 'workflow-env' || entry === 'skill-temporary'
          ? 'model-a'
          : entry === 'workflow-temporary'
            ? 'model-b'
            : 'model-c';
      expect(requests[0]).toMatchObject({
        model: firstModel,
        reasoning_effort: 'high',
      });
      expect(select.mock.calls[0][0].overrideSelection).toEqual({
        key: `fixture/${firstModel}`,
        config: { reasoning: { effort: 'high' } },
      });
      expect(config.taskRegistry).toBeUndefined();
      if (temporary) return;

      vi.stubEnv(ENV_SUBAGENT_MODEL, '');
      await invoke(false);
      expect(requests[1]).toMatchObject({
        model: 'model-b',
        reasoning_effort: 'low',
      });
      expect(select.mock.calls[1][0].overrideSelection).toEqual({
        key: 'fixture/model-b',
      });
      await expect(select.mock.results[1].value).resolves.toMatchObject({
        config: { sampling: { temperature: 0.2 } },
      });

      const host = vi.fn(async () => ({
        model: 'fixture/model-a',
        parameters: { reasoningEffort: 'low' as const },
      }));
      config.setModelPolicyCallbacks(host);
      await invoke(true);
      expect(requests[2]).toMatchObject({
        model: 'model-a',
        reasoning_effort: 'low',
      });
      expect(host).toHaveBeenCalledOnce();
      expect(manager.getMainModelKey()).toBe('fixture/model-a');
    } finally {
      disposeSessionEventQueue(config.getSessionId());
      registry.dispose();
      await fixture.dispose();
    }
  },
  30000,
);
