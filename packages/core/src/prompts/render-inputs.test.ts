/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import {
  ENV_DISABLE_EXPLORE_PLAN_AGENTS,
  ENV_ENABLE_AGENT_SESSIONS,
  ENV_FORK_SUBAGENT,
} from '../config/brand.js';
import {
  AGENT_TOOL_NAME,
  SKILL_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from '../tools/tool-names.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { getConfigHomeDir } from '../utils/paths.js';
import { createPromptRenderInputs } from './render-inputs.js';
import { CORE_LEAN_SECTIONS } from './sections/core-lean.js';
import {
  promptSectionCacheKey,
  type PromptAssemblyContext,
  type PromptSurface,
} from './types.js';

function renderAgentGuidance(
  availableAgentTypes: string[],
  surface: PromptSurface = 'headless',
  bundle: 'full' | 'lean' = 'full',
  agentToolEnabled = true,
): string | null {
  const cwd = process.cwd();
  const config = {
    getWorkingDir: () => cwd,
    getWorkspaceContext: () => ({ getDirectories: () => [cwd] }),
    getLanguage: () => undefined,
    getOutputStyle: () => undefined,
    getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
  } as unknown as Config;
  const toolRegistry = {
    getAllToolNames: () => (agentToolEnabled ? [AGENT_TOOL_NAME] : []),
    getTool: (name: string) =>
      agentToolEnabled && name === AGENT_TOOL_NAME
        ? {
            isAgentTypeAvailable: (agentType: string) =>
              availableAgentTypes.includes(agentType),
            getAvailableAgentListing: () =>
              availableAgentTypes.map((agentType) => ({
                name: agentType,
                description: `${agentType} agent`,
              })),
          }
        : undefined,
  } as unknown as ToolRegistry;
  const inputs = createPromptRenderInputs(
    { config, toolRegistry } as AgentLoopContext,
    'default',
    surface,
  );

  return inputs.sessionGuidance?.computeForBundle(bundle) as string | null;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CodeMode session guidance', () => {
  function inputs(mode: 'on' | 'only' | undefined) {
    const config = {
      getWorkingDir: () => process.cwd(),
      getWorkspaceContext: () => ({ getDirectories: () => [process.cwd()] }),
      getLanguage: () => undefined,
      getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
    } as unknown as Config;
    const toolRegistry = {
      getAllToolNames: () => ['CodeMode', AGENT_TOOL_NAME],
      getCodeModeExposure: () => mode,
      getTool: () => ({
        isAgentTypeAvailable: (type: string) => type === 'Explore',
        getAvailableAgentListing: () => [],
      }),
    } as unknown as ToolRegistry;
    return createPromptRenderInputs(
      { config, toolRegistry } as AgentLoopContext,
      'default',
      'headless',
    );
  }

  it('replaces the parallel-call rule in Using your tools per exposure', async () => {
    const dedicatedBullet = (text?: string | null) =>
      text?.split('\n').find((line) => line.includes('Prefer dedicated tools'));
    const firstBullet = (text?: string | null) => text?.split('\n')[1];
    const lastBullet = (text?: string | null) => text?.split('\n').at(-1);
    const off = await inputs(undefined).usingTools.compute();
    expect(off).toContain('Maximize use of parallel tool calls');
    expect(off).not.toContain('CodeMode');
    expect(firstBullet(off)).toBe(dedicatedBullet(off));

    const on = await inputs('on').usingTools.compute();
    expect(firstBullet(on)).toBe(dedicatedBullet(off));
    expect(lastBullet(on)).toContain(
      'You can call multiple tools in a single response.',
    );
    expect(lastBullet(on)).toContain(
      'Use CodeMode instead when running tools from a script',
    );
    expect(on).not.toContain('Maximize use of parallel tool calls');
    // How-to rules live only in the CodeMode tool description.
    expect(on).not.toContain('Promise.allSettled');
    expect(on).not.toContain('CodeModeWait');

    const only = await inputs('only').usingTools.compute();
    expect(firstBullet(only)).toBe(dedicatedBullet(off));
    expect(lastBullet(only)).toContain(
      "Call tools in CodeMode's catalog through CodeMode",
    );
    expect(lastBullet(only)).toContain(
      'You can call multiple direct tools in a single response',
    );
    expect(only).not.toContain('Maximize use of parallel tool calls');
    for (const rule of [on, only]) {
      expect(rule).not.toContain('End the script');
    }
  });

  it('carries the call rule in the lean harness, not session guidance', async () => {
    const harness = CORE_LEAN_SECTIONS.find(
      (section) => section.id === 'core.harness.lean',
    )!;
    const lean = (mode: 'on' | 'only' | undefined) => {
      const context = {
        renderInputs: inputs(mode),
      } as PromptAssemblyContext;
      return {
        text: harness.render(context) as string,
        cacheKey: promptSectionCacheKey(harness, context),
      };
    };
    const off = lean(undefined);
    expect(off.text).toContain(
      'Independent tool calls can run in parallel in one response.',
    );
    expect(off.text).not.toContain('CodeMode');
    expect(off.cacheKey).toBe('core.harness.lean@1');

    const on = lean('on');
    expect(
      on.text.split(
        'Independent tool calls can run in parallel in one response.',
      ),
    ).toHaveLength(2);
    expect(on.text).not.toContain('You can call multiple tools');
    expect(on.cacheKey).toBe('core.harness.lean@1:on');

    const only = lean('only');
    expect(only.text).not.toContain(
      'Independent tool calls can run in parallel in one response.',
    );
    expect(only.text).toContain(
      'independent direct calls can run in parallel in one response.',
    );
    expect(only.cacheKey).toBe('core.harness.lean@1:only');

    for (const [text, rule] of [
      [on.text, 'Use CodeMode instead when running tools from a script'],
      [only.text, "Call tools in CodeMode's catalog through CodeMode"],
    ]) {
      expect(text).toContain(rule);
      expect(text.indexOf(rule)).toBeGreaterThan(
        text.indexOf('Prefer dedicated file/search tools'),
      );
    }

    for (const mode of ['on', 'only'] as const) {
      expect(
        await inputs(mode).sessionGuidance?.computeForBundle('lean'),
      ).not.toContain('Use CodeMode instead when running tools from a script');
      expect(
        await inputs(mode).sessionGuidance?.computeForBundle('lean'),
      ).not.toContain("Call tools in CodeMode's catalog");
    }
  });

  it('points Explore fallback searches at CodeMode when exposed', async () => {
    expect(
      await inputs('on').sessionGuidance?.computeForBundle('full'),
    ).toContain('directly or batched in CodeMode');
    const only = await inputs('only').sessionGuidance?.computeForBundle('full');
    expect(only).toContain('`Grep` through CodeMode');
    expect(only).not.toContain('`Grep` directly');
  });

  it('keys the prompt cache by effective exposure', () => {
    for (const section of ['sessionGuidance', 'usingTools'] as const) {
      expect(
        new Set(
          [undefined, 'on', 'only'].map(
            (mode) =>
              inputs(mode as 'on' | 'only' | undefined)[section]?.cacheVariant,
          ),
        ).size,
      ).toBe(3);
    }
  });
});

describe('Workflow authoring system guidance', () => {
  function inputs(surface: PromptSurface) {
    const config = {
      getWorkingDir: () => process.cwd(),
      getWorkspaceContext: () => ({ getDirectories: () => [process.cwd()] }),
      getLanguage: () => undefined,
      getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
    } as unknown as Config;
    const toolRegistry = {
      getAllToolNames: () => [WORKFLOW_TOOL_NAME],
    } as unknown as ToolRegistry;
    return createPromptRenderInputs(
      { config, toolRegistry } as AgentLoopContext,
      'default',
      surface,
    );
  }

  it.each(['local_tui', 'headless', 'sdk', 'remote_worker'] as const)(
    'keeps Workflow instructions out of the system prompt on %s',
    async (surface) => {
      const rendered = inputs(surface);
      for (const bundle of ['full', 'lean'] as const) {
        const guidance =
          await rendered.sessionGuidance?.computeForBundle(bundle);
        expect(guidance).not.toContain('Workflow orchestration guidance:');
        expect(guidance).not.toContain('Use script for a new inline workflow');
      }
      expect(rendered).not.toHaveProperty('availableWorkflows');
    },
  );
});

describe('createPromptRenderInputs Explore guidance', () => {
  const defaultAgentGuidance =
    "Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.";
  const forkAgentGuidance =
    'Calling Agent with subagent_type: "fork" creates a fork — it inherits your full conversation context, runs in the background, and keeps its tool output out of your context';

  it('includes the default Agent guidance only in Full', () => {
    expect(renderAgentGuidance(['Explore'], 'headless', 'full')).toContain(
      defaultAgentGuidance,
    );
    const leanGuidance = renderAgentGuidance(['Explore'], 'headless', 'lean');
    expect(leanGuidance).not.toContain(defaultAgentGuidance);
    expect(leanGuidance).not.toContain(
      "broad codebase exploration or research that'll take more than 3 queries",
    );
  });

  it('omits the default Agent guidance when the Agent tool is unavailable', () => {
    expect(
      renderAgentGuidance(['Explore'], 'headless', 'full', false),
    ).not.toContain(defaultAgentGuidance);
  });

  it('replaces the default Agent guidance when fork subagents are enabled', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');

    const guidance = renderAgentGuidance(
      ['Explore', 'fork'],
      'headless',
      'full',
    );
    expect(guidance).not.toContain(defaultAgentGuidance);
    expect(guidance).toContain(forkAgentGuidance);
    expect(
      renderAgentGuidance(['Explore', 'fork'], 'headless', 'lean'),
    ).not.toContain(forkAgentGuidance);
  });

  it('keeps the default guidance when the fork type is unavailable', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');

    const guidance = renderAgentGuidance(['Explore'], 'headless', 'full');
    expect(guidance).toContain(defaultAgentGuidance);
    expect(guidance).not.toContain(forkAgentGuidance);
    expect(guidance).toContain(
      "broad codebase exploration or research that'll take more than 3 queries",
    );
  });

  it('keeps foreground-safe guidance when Agent sessions are disabled', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');

    const guidance = renderAgentGuidance(
      ['Explore', 'fork'],
      'headless',
      'full',
    );
    expect(guidance).toContain(defaultAgentGuidance);
    expect(guidance).not.toContain(forkAgentGuidance);
    expect(guidance).toContain(
      "broad codebase exploration or research that'll take more than 3 queries",
    );
  });

  it('includes Explore routing only when the concrete Agent tool exposes it', () => {
    expect(renderAgentGuidance(['Explore'])).toContain(
      "broad codebase exploration or research that'll take more than 3 queries",
    );
    expect(renderAgentGuidance([])).not.toContain(
      "broad codebase exploration or research that'll take more than 3 queries",
    );
  });

  it('suppresses Explore routing when Explore and Plan agents are disabled', () => {
    vi.stubEnv(ENV_DISABLE_EXPLORE_PLAN_AGENTS, '1');

    const guidance = renderAgentGuidance(['Explore']);
    expect(guidance).not.toContain(
      "broad codebase exploration or research that'll take more than 3 queries",
    );
  });

  it('suppresses Explore routing when fork subagents are enabled', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');

    expect(renderAgentGuidance(['Explore', 'fork'])).not.toContain(
      "broad codebase exploration or research that'll take more than 3 queries",
    );
  });

  it('keeps output-file handling out of session guidance', () => {
    expect(renderAgentGuidance(['Explore'])).not.toContain(
      "Do not Read or inspect a background agent's output_file path",
    );
  });
});

describe('createPromptRenderInputs interactive guidance', () => {
  it('keeps shell-command guidance without injecting feedback guidance', () => {
    const guidance = renderAgentGuidance(['Explore'], 'local_tui', 'full');

    expect(guidance).toContain('suggest they type `! <command>` in the prompt');
    expect(guidance).not.toContain('direct them to the `/feedback` command');
  });
});

describe('createPromptRenderInputs resource guidance', () => {
  it('briefly identifies the configured user resource directory', () => {
    const cwd = process.cwd();
    const config = {
      getWorkingDir: () => cwd,
      getWorkspaceContext: () => ({ getDirectories: () => [cwd] }),
      getLanguage: () => undefined,
      getOutputStyle: () => undefined,
      getSkillManager: () => ({
        getModelVisibleSkills: () => [{ name: 'review' }],
      }),
    } as unknown as Config;
    const toolRegistry = {
      getAllToolNames: () => [SKILL_TOOL_NAME],
      getTool: () => undefined,
    } as unknown as ToolRegistry;

    const inputs = createPromptRenderInputs(
      { config, toolRegistry } as AgentLoopContext,
      'default',
      'local_tui',
    );
    const guidance = inputs.sessionGuidance?.computeForBundle('full') as string;
    const leanGuidance = inputs.sessionGuidance?.computeForBundle(
      'lean',
    ) as string;

    expect(guidance).toContain(
      "When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess.",
    );
    expect(leanGuidance).toContain(
      "When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess.",
    );
    expect(guidance).not.toContain(
      'When users ask you to perform tasks, check if any of the available skills match.',
    );
    expect(guidance).not.toContain('BLOCKING REQUIREMENT');
    expect(guidance).toContain(
      `Skills, plugins, and other resources may be stored in the user resource directory (\`${getConfigHomeDir()}\`) or the current project directory.`,
    );
    expect(guidance).not.toContain(cwd);
    expect(guidance).not.toContain('additional working directories');
  });

  it.each(['headless', 'sdk', 'remote_worker'] as const)(
    'also adds resource guidance to the %s surface',
    (surface) => {
      expect(renderAgentGuidance([], surface)).toContain(
        `user resource directory (\`${getConfigHomeDir()}\`) or the current project directory`,
      );
    },
  );
});

describe('createPromptRenderInputs SDK memory', () => {
  function createSdkInputs(
    state: Parameters<typeof createPromptRenderInputs>[3],
  ) {
    const config = {
      getWorkingDir: () => process.cwd(),
      getWorkspaceContext: () => ({ getDirectories: () => [process.cwd()] }),
      getLanguage: () => undefined,
      getOutputStyle: () => undefined,
      getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
    } as unknown as Config;
    const toolRegistry = {
      getAllToolNames: () => [],
      getTool: () => undefined,
    } as unknown as ToolRegistry;
    return createPromptRenderInputs(
      { config, toolRegistry } as AgentLoopContext,
      'default',
      'sdk',
      state,
    );
  }

  it('selects a CLI-generated prompt by bundle', async () => {
    const inputs = createSdkInputs({
      owner: 'sdk',
      promptsByBundle: Object.freeze({ full: 'FULL', lean: 'LEAN' }),
      shapeKey: 1,
    });

    expect(await inputs.memory?.computeForBundle('full')).toBe('FULL');
    expect(await inputs.memory?.computeForBundle('lean')).toBe('LEAN');
  });

  it('keeps an SDK-provided prompt identical across bundles', async () => {
    const inputs = createSdkInputs({
      owner: 'sdk',
      prompt: 'SDK PROMPT',
      shapeKey: 1,
    });

    expect(await inputs.memory?.computeForBundle('full')).toBe('SDK PROMPT');
    expect(await inputs.memory?.computeForBundle('lean')).toBe('SDK PROMPT');
  });
});
