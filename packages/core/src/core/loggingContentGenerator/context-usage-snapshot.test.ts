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
import { createContextUsageSnapshot } from './context-usage-snapshot.js';

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

describe('createContextUsageSnapshot', () => {
  it('attributes exact memory, tools, and the first loaded Skill body', () => {
    const skill = skillConfig();
    const skillOutput = buildSkillLlmContent(
      '/skills/example-skill',
      skill.body,
    );
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
    const systemInstruction =
      'Base prompt\n\n---\n\nProject memory\n\n---\n\nAuto memory';
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: ToolNames.SKILL,
              response: { output: skillOutput },
            },
          },
          {
            functionResponse: {
              name: ToolNames.SKILL,
              response: { output: 'Skill already loaded' },
            },
          },
        ],
      },
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
    const request: GenerateContentParameters = {
      model: 'test-model',
      contents,
      config: {
        systemInstruction,
        tools: [
          {
            functionDeclarations: [
              builtinDeclaration,
              skillDeclaration,
              mcpDeclaration,
            ],
          },
        ],
      },
    };

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
          estimateContextTextTokens(skillOutput),
        messages_tokens: estimateContentTokens([
          contents[0]!,
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: ToolNames.SKILL,
                  response: { output: '' },
                },
              },
              contents[1]!.parts![1]!,
            ],
          },
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
    const request: GenerateContentParameters = {
      model: 'test-model',
      contents: [],
      config: { tools: [{ tool } as unknown as CallableTool] },
    };

    expect(
      createContextUsageSnapshot(request, createConfig(), 100_000),
    ).toBeUndefined();
    expect(tool).not.toHaveBeenCalled();
  });

  it('keeps unmatched and duplicate Skill outputs in messages', () => {
    const skill = skillConfig();
    const skillOutput = buildSkillLlmContent(
      '/skills/example-skill',
      skill.body,
    );
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: ToolNames.SKILL,
              response: { output: skillOutput },
            },
          },
          {
            functionResponse: {
              name: ToolNames.SKILL,
              response: { output: skillOutput },
            },
          },
        ],
      },
    ];
    const request: GenerateContentParameters = {
      model: 'test-model',
      contents,
    };
    const config = createConfig({
      cachedSkills: [skill],
      loadedSkillNames: new Set([skill.name]),
    });

    const snapshot = createContextUsageSnapshot(request, config, 200_000);

    expect(snapshot?.breakdown.skills_tokens).toBe(
      estimateContextTextTokens(skillOutput),
    );
    expect(snapshot?.breakdown.messages_tokens).toBe(
      estimateContentTokens([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: ToolNames.SKILL,
                response: { output: '' },
              },
            },
            contents[0]!.parts![1]!,
          ],
        },
      ]),
    );
  });

  it('attributes the immutable loaded output after the Skill cache changes', () => {
    const loadedSkill = skillConfig();
    const loadedOutput = buildSkillLlmContent(
      '/skills/example-skill',
      loadedSkill.body,
    );
    const editedSkill = { ...loadedSkill, body: '# Edited body' };
    const request: GenerateContentParameters = {
      model: 'test-model',
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: ToolNames.SKILL,
                response: { output: loadedOutput },
              },
            },
          ],
        },
      ],
    };
    const config = createConfig({
      cachedSkills: [editedSkill],
      loadedSkillNames: new Set([loadedSkill.name]),
      loadedSkillContents: new Set([loadedOutput]),
    });

    const snapshot = createContextUsageSnapshot(request, config, 200_000);

    expect(snapshot?.breakdown.skills_tokens).toBe(
      estimateContextTextTokens(loadedOutput),
    );
    expect(snapshot?.breakdown.messages_tokens).toBe(
      estimateContentTokens([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: ToolNames.SKILL,
                response: { output: '' },
              },
            },
          ],
        },
      ]),
    );
  });

  it('uses only committed Skill cache data and exact in-request memory', () => {
    const body = 'not indexed on a cold cache';
    const listSkills = vi.fn();
    const request: GenerateContentParameters = {
      model: 'test-model',
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: ToolNames.SKILL,
                response: { output: body },
              },
            },
          ],
        },
      ],
      config: { systemInstruction: 'Base prompt' },
    };
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
    const request: GenerateContentParameters = {
      model: 'test-model',
      contents: [],
    };
    expect(
      createContextUsageSnapshot(request, createConfig(), 0),
    ).toBeUndefined();
    expect(
      createContextUsageSnapshot(request, createConfig(), Number.NaN),
    ).toBeUndefined();
  });
});
