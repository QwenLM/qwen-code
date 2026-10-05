/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  CallableTool,
  Content,
  FunctionDeclaration,
  GenerateContentParameters,
} from '@google/genai';
import type { Config } from '../../config/config.js';
import { computeThresholds } from '../../services/chatCompressionService.js';
import {
  estimateContentTokens,
  estimateContextTextTokens,
} from '../../services/tokenEstimation.js';
import type { SkillConfig } from '../../skills/types.js';
import { DiscoveredMCPTool } from '../../tools/mcp-tool.js';
import { buildSkillLlmContent } from '../../tools/skill-utils.js';
import { ToolNames } from '../../tools/tool-names.js';
import { serializeContextUsage } from '../../telemetry/context-usage.js';
import { convertToFunctionResponse } from '../coreToolScheduler.js';
import { appendAdditionalContext } from '../toolHookTriggers.js';
import { createContextUsageSnapshot } from './context-usage-snapshot.js';
import {
  content,
  fnResponse,
  userText,
} from '../../test-utils/model-fixtures.js';

function createConfig(options?: {
  userMemory?: string;
  autoMemory?: string;
  cachedSkills?: SkillConfig[] | null;
  loadedSkillNames?: ReadonlySet<string>;
  loadedSkillContents?: ReadonlySet<string>;
  tools?: Map<string, unknown>;
  listSkills?: ReturnType<typeof vi.fn>;
  autoCompactThreshold?: number;
}): Config {
  const listSkills = options?.listSkills ?? vi.fn();
  const skillTool = {
    getLoadedSkillNames: () => options?.loadedSkillNames ?? new Set<string>(),
    ...(options?.loadedSkillContents === undefined
      ? {}
      : {
          getLoadedSkillContents: () => options.loadedSkillContents,
        }),
  };
  const tools = new Map(options?.tools ?? []);
  tools.set(ToolNames.SKILL, skillTool);

  return {
    getUserMemory: () => options?.userMemory ?? '',
    getAutoMemoryPrompt: () => options?.autoMemory ?? '',
    getAutoCompactThreshold: () => options?.autoCompactThreshold,
    getToolRegistry: () => ({
      getTool: (name: string) => tools.get(name),
    }),
    getSkillManager: () => ({
      getCachedSkills: () => options?.cachedSkills ?? null,
      listSkills,
    }),
  } as unknown as Config;
}

function skillConfig(): SkillConfig {
  return {
    name: 'example-skill',
    description: 'Example',
    level: 'project',
    filePath: '/skills/example-skill/SKILL.md',
    body: '# Example body',
  };
}

/** The loaded output of `skillConfig()` (same path and body). */
const LOADED_OUTPUT = buildSkillLlmContent(
  '/skills/example-skill',
  '# Example body',
);

/** A user turn of Skill function responses carrying `outputs`. */
const skillTurn = (...outputs: unknown[]): Content =>
  content(
    'user',
    ...outputs.map((output) => fnResponse(ToolNames.SKILL, { output })),
  );

const requestOf = (
  contents: Content[],
  config?: GenerateContentParameters['config'],
): GenerateContentParameters => ({
  model: 'test-model',
  contents,
  ...(config ? { config } : {}),
});

/** Snapshots `contents` in a 200k window and checks the Skill tokens are
 * exactly `skillsTokens` while messages estimate as `messages`. */
function expectSplit(
  contents: Content[],
  config: Config,
  skillsTokens: number,
  messages: Content[],
) {
  const snapshot = createContextUsageSnapshot(
    requestOf(contents),
    config,
    200_000,
  );
  expect(snapshot?.breakdown.skills_tokens).toBe(skillsTokens);
  expect(snapshot?.breakdown.messages_tokens).toBe(
    estimateContentTokens(messages),
  );
}

describe('createContextUsageSnapshot', () => {
  it('attributes exact memory, tools, and the first loaded Skill body', () => {
    const skill = skillConfig();
    const mcpTool = new DiscoveredMCPTool(
      {} as CallableTool,
      'server',
      'search',
      'Search',
      { type: 'object', properties: {} },
    );
    const builtinDeclaration: FunctionDeclaration = {
      name: 'read_file',
      description: 'Read a file',
      parametersJsonSchema: { type: 'object' },
    };
    const skillDeclaration: FunctionDeclaration = {
      name: ToolNames.SKILL,
      description: 'Load a skill',
      parametersJsonSchema: { type: 'object' },
    };
    const mcpDeclaration = mcpTool.schema;
    const contents: Content[] = [
      userText('hello'),
      skillTurn(LOADED_OUTPUT, 'Skill already loaded'),
    ];
    const listSkills = vi.fn();
    const config = createConfig({
      userMemory: ' Project memory ',
      autoMemory: 'Auto memory\n',
      cachedSkills: [skill],
      loadedSkillNames: new Set([skill.name]),
      tools: new Map([[mcpTool.name, mcpTool]]),
      listSkills,
      autoCompactThreshold: 0.5,
    });
    const request = requestOf(contents, {
      systemInstruction:
        'Base prompt\n\n---\n\nProject memory\n\n---\n\nAuto memory',
      tools: [
        {
          functionDeclarations: [
            builtinDeclaration,
            skillDeclaration,
            mcpDeclaration,
          ],
        },
      ],
    });

    const snapshot = createContextUsageSnapshot(request, config, 100_000);

    expect(snapshot).toEqual({
      version: 1,
      window_size_tokens: 100_000,
      breakdown: {
        system_prompt_tokens: estimateContextTextTokens(
          'Base prompt\n\n---\n\n\n\n---\n\n',
        ),
        builtin_tools_tokens: estimateContextTextTokens(
          JSON.stringify(builtinDeclaration),
        ),
        mcp_tools_tokens: estimateContextTextTokens(
          JSON.stringify(mcpDeclaration),
        ),
        memory_files_tokens:
          estimateContextTextTokens('Project memory') +
          estimateContextTextTokens('Auto memory'),
        skills_tokens:
          estimateContextTextTokens(JSON.stringify(skillDeclaration)) +
          estimateContextTextTokens(LOADED_OUTPUT),
        messages_tokens: estimateContentTokens([
          contents[0]!,
          content(
            'user',
            fnResponse(ToolNames.SKILL, { output: '' }),
            contents[1]!.parts![1]!,
          ),
        ]),
      },
      compaction_reserve_tokens: 100_000 - computeThresholds(100_000, 0.5).auto,
      estimated: true,
    });
    expect(listSkills).not.toHaveBeenCalled();
    expect(serializeContextUsage(snapshot)).not.toContain('/skills/');
    expect(serializeContextUsage(snapshot)).not.toContain('example-skill');
  });

  it('omits the snapshot rather than resolving a CallableTool asynchronously', () => {
    const tool = vi.fn().mockResolvedValue({
      functionDeclarations: [{ name: 'callable_decl' }],
    });
    const request = requestOf([], {
      tools: [{ tool } as unknown as CallableTool],
    });

    expect(
      createContextUsageSnapshot(request, createConfig(), 100_000),
    ).toBeUndefined();
    expect(tool).not.toHaveBeenCalled();
  });

  it('keeps unmatched and duplicate Skill outputs in messages', () => {
    const skill = skillConfig();
    const contents = [skillTurn(LOADED_OUTPUT, LOADED_OUTPUT)];
    expectSplit(
      contents,
      createConfig({
        cachedSkills: [skill],
        loadedSkillNames: new Set([skill.name]),
      }),
      estimateContextTextTokens(LOADED_OUTPUT),
      [
        content(
          'user',
          fnResponse(ToolNames.SKILL, { output: '' }),
          contents[0]!.parts![1]!,
        ),
      ],
    );
  });

  it('attributes the immutable loaded output after the Skill cache changes', () => {
    const loadedSkill = skillConfig();
    const editedSkill = { ...loadedSkill, body: '# Edited body' };
    expectSplit(
      [skillTurn(LOADED_OUTPUT)],
      createConfig({
        cachedSkills: [editedSkill],
        loadedSkillNames: new Set([loadedSkill.name]),
        loadedSkillContents: new Set([LOADED_OUTPUT]),
      }),
      estimateContextTextTokens(LOADED_OUTPUT),
      [skillTurn('')],
    );
  });

  it('attributes a retained Skill body while leaving an appended hook suffix in messages', () => {
    const responseParts = convertToFunctionResponse(
      ToolNames.SKILL,
      'skill-call',
      appendAdditionalContext([{ text: LOADED_OUTPUT }], 'hook context'),
    );
    const output = responseParts[0]?.functionResponse?.response?.['output'];
    expect(typeof output).toBe('string');
    const hookSuffix = (output as string).slice(LOADED_OUTPUT.length);

    expectSplit(
      [skillTurn(output)],
      createConfig({ loadedSkillContents: new Set([LOADED_OUTPUT]) }),
      estimateContextTextTokens(LOADED_OUTPUT),
      [skillTurn(hookSuffix)],
    );
  });

  it.each([
    ['truncated', 'Tool output was too large and has been truncated\npreview'],
    ['persisted', '<persisted-output>\npreview\n</persisted-output>'],
  ])('keeps a %s Skill output in messages', (_, transformedOutput) => {
    const contents = [skillTurn(transformedOutput)];
    expectSplit(
      contents,
      createConfig({ loadedSkillContents: new Set([LOADED_OUTPUT]) }),
      0,
      contents,
    );
  });

  it('uses only committed Skill cache data and exact in-request memory', () => {
    const listSkills = vi.fn();
    const request = requestOf([skillTurn('not indexed on a cold cache')], {
      systemInstruction: 'Base prompt',
    });
    const config = createConfig({
      userMemory: 'configured but absent',
      cachedSkills: null,
      loadedSkillNames: new Set(['example-skill']),
      listSkills,
    });

    const snapshot = createContextUsageSnapshot(request, config, 200_000);

    expect(snapshot?.breakdown.system_prompt_tokens).toBe(
      estimateContextTextTokens('Base prompt'),
    );
    expect(snapshot?.breakdown.memory_files_tokens).toBe(0);
    expect(snapshot?.breakdown.skills_tokens).toBe(0);
    expect(snapshot?.breakdown.messages_tokens).toBe(
      estimateContentTokens(request.contents as Content[]),
    );
    expect(listSkills).not.toHaveBeenCalled();
  });

  it('omits an invalid context window', () => {
    const request = requestOf([]);
    expect(
      createContextUsageSnapshot(request, createConfig(), 0),
    ).toBeUndefined();
    expect(
      createContextUsageSnapshot(request, createConfig(), Number.NaN),
    ).toBeUndefined();
  });
});
