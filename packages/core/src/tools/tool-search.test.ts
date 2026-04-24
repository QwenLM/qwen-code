/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableTool } from '@google/genai';
import type { ConfigParameters } from '../config/config.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ToolRegistry } from './tool-registry.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolSearchTool, scoreTool, tokenize } from './tool-search.js';

const baseConfigParams: ConfigParameters = {
  cwd: '/tmp',
  model: 'test-model',
  embeddingModel: 'test-embedding-model',
  sandbox: undefined,
  targetDir: '/test/dir',
  debugMode: false,
  userMemory: '',
  geminiMdFileCount: 0,
  approvalMode: ApprovalMode.DEFAULT,
};

function makeConfigWithRegistry(): {
  config: Config;
  registry: ToolRegistry;
} {
  const config = new Config(baseConfigParams);
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  // Stub out the chat client reference ToolSearch tries to refresh; we don't
  // need end-to-end chat behaviour, just to confirm the call is tolerated.
  vi.spyOn(config, 'getGeminiClient').mockReturnValue({
    setTools: vi.fn().mockResolvedValue(undefined),
  } as never);
  return { config, registry };
}

describe('tokenize', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenize('SlACK Send Message')).toEqual([
      'slack',
      'send',
      'message',
    ]);
  });

  it('filters empty tokens', () => {
    expect(tokenize('   foo    bar  ')).toEqual(['foo', 'bar']);
  });
});

describe('scoreTool', () => {
  it('gives higher score on exact name match than substring', () => {
    const exactTool = new MockTool({ name: 'grep' });
    const substringTool = new MockTool({ name: 'grep_tool' });
    expect(scoreTool(exactTool, ['grep'])).toBeGreaterThan(
      scoreTool(substringTool, ['grep']),
    );
  });

  it('boosts MCP tools above built-in tools with equal match type', () => {
    const builtin = new MockTool({
      name: 'send_message',
      // Explicit description without the search term so both tools only match
      // on name, isolating the MCP vs built-in weight difference.
      description: 'an action',
    });
    const mcpCallable = {} as CallableTool;
    const mcp = new DiscoveredMCPTool(
      mcpCallable,
      'slack',
      'send_message',
      'an action',
      {},
    );
    const terms = ['send_message'];
    // MCP gets SCORE_NAME_EXACT_MCP (12) for suffix match vs built-in 10.
    expect(scoreTool(mcp, terms)).toBeGreaterThan(scoreTool(builtin, terms));
  });

  it('scores searchHint word matches', () => {
    const withHint = new MockTool({
      name: 'cron_create',
      description: 'scheduler',
      searchHint: 'schedule recurring timer',
    });
    const withoutHint = new MockTool({
      name: 'cron_create',
      description: 'scheduler',
    });
    expect(scoreTool(withHint, ['schedule'])).toBeGreaterThan(
      scoreTool(withoutHint, ['schedule']),
    );
  });

  it('scores description matches but less than name matches', () => {
    const tool = new MockTool({
      name: 'foo',
      description: 'this tool does slack things',
    });
    expect(scoreTool(tool, ['slack'])).toBe(2); // SCORE_DESC_BUILTIN
  });

  it('returns 0 when no term matches', () => {
    const tool = new MockTool({
      name: 'foo',
      description: 'bar',
    });
    expect(scoreTool(tool, ['unrelated'])).toBe(0);
  });
});

describe('ToolSearchTool', () => {
  let config: Config;
  let registry: ToolRegistry;

  beforeEach(() => {
    ({ config, registry } = makeConfigWithRegistry());
  });

  it('is marked alwaysLoad so the model can always reach it', () => {
    const tool = new ToolSearchTool(config);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.shouldDefer).toBe(false);
  });

  it('select: mode loads named tool and reveals it', async () => {
    const hidden = new MockTool({
      name: 'cron_create',
      description: 'schedules a cron',
      shouldDefer: true,
    });
    registry.registerTool(hidden);

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'select:cron_create' });
    const result = await invocation.execute(new AbortController().signal);

    const content = String(result.llmContent);
    expect(content).toContain('<functions>');
    expect(content).toContain('"name":"cron_create"');
    expect(registry.isDeferredToolRevealed('cron_create')).toBe(true);
  });

  it('select: mode handles multiple names and missing names', async () => {
    registry.registerTool(new MockTool({ name: 'alpha', shouldDefer: true }));
    registry.registerTool(new MockTool({ name: 'bravo', shouldDefer: true }));

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'select:alpha,bravo,missing' });
    const result = await invocation.execute(new AbortController().signal);

    const content = String(result.llmContent);
    expect(content).toContain('"name":"alpha"');
    expect(content).toContain('"name":"bravo"');
    expect(content).toContain('Not found: missing');
    expect(registry.isDeferredToolRevealed('alpha')).toBe(true);
    expect(registry.isDeferredToolRevealed('bravo')).toBe(true);
  });

  it('keyword search returns top-N ranked tools', async () => {
    registry.registerTool(
      new MockTool({
        name: 'cron_create',
        description: 'schedules recurring jobs',
        searchHint: 'schedule cron timer',
        shouldDefer: true,
      }),
    );
    registry.registerTool(
      new MockTool({
        name: 'lsp',
        description: 'language server',
        shouldDefer: true,
      }),
    );
    registry.registerTool(
      new MockTool({
        name: 'ask_user_question',
        description: 'asks the user',
        shouldDefer: true,
      }),
    );

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'schedule' });
    const result = await invocation.execute(new AbortController().signal);

    const content = String(result.llmContent);
    expect(content).toContain('"name":"cron_create"');
    // Unrelated tools should not surface on a 'schedule' query.
    expect(content).not.toContain('"name":"lsp"');
    expect(content).not.toContain('"name":"ask_user_question"');
  });

  it('returns a friendly message when nothing matches', async () => {
    registry.registerTool(new MockTool({ name: 'foo', shouldDefer: true }));

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'zzzzzz' });
    const result = await invocation.execute(new AbortController().signal);

    const content = String(result.llmContent);
    expect(content).toContain('No tools found matching');
  });

  it('enforces max_results cap', async () => {
    for (let i = 0; i < 25; i++) {
      registry.registerTool(
        new MockTool({
          name: `slack_tool_${i}`,
          description: 'slack',
          shouldDefer: true,
        }),
      );
    }

    const tool = new ToolSearchTool(config);
    // Ask for 100, should be clamped to 20.
    const invocation = tool.build({ query: 'slack', max_results: 100 });
    const result = await invocation.execute(new AbortController().signal);

    const matches = (String(result.llmContent).match(/<function>/g) ?? [])
      .length;
    expect(matches).toBeLessThanOrEqual(20);
    expect(matches).toBeGreaterThan(0);
  });

  it('revealed tools show up in subsequent getFunctionDeclarations', async () => {
    registry.registerTool(new MockTool({ name: 'visible' }));
    registry.registerTool(new MockTool({ name: 'hidden', shouldDefer: true }));

    // Before search: hidden is excluded.
    expect(registry.getFunctionDeclarations().map((d) => d.name)).toEqual([
      'visible',
    ]);

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'select:hidden' });
    await invocation.execute(new AbortController().signal);

    // After search: hidden joins the declaration list.
    expect(
      registry
        .getFunctionDeclarations()
        .map((d) => d.name)
        .sort(),
    ).toEqual(['hidden', 'visible']);
  });

  it('rejects empty query with error', async () => {
    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: '   ' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('Error');
  });

  it('select: mode dedupes repeated names', async () => {
    registry.registerTool(
      new MockTool({ name: 'cron_create', shouldDefer: true }),
    );

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({
      query: 'select:cron_create,cron_create,CRON_CREATE',
    });
    const result = await invocation.execute(new AbortController().signal);

    const content = String(result.llmContent);
    const occurrences = (content.match(/"name":"cron_create"/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('keyword search ignores non-deferred tools', async () => {
    // Deferred — should be findable via keyword.
    registry.registerTool(
      new MockTool({
        name: 'cron_create',
        description: 'schedule something',
        searchHint: 'schedule cron',
        shouldDefer: true,
      }),
    );
    // Not deferred — the model already has it, so keyword search should
    // skip it to reduce noise.
    registry.registerTool(
      new MockTool({
        name: 'schedule_run',
        description: 'schedule something',
        searchHint: 'schedule run',
        shouldDefer: false,
      }),
    );

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'schedule' });
    const result = await invocation.execute(new AbortController().signal);

    const content = String(result.llmContent);
    expect(content).toContain('"name":"cron_create"');
    expect(content).not.toContain('"name":"schedule_run"');
  });

  it('select: mode still works for non-deferred tools (e.g. re-inspect schema)', async () => {
    registry.registerTool(
      new MockTool({ name: 'core_tool', shouldDefer: false }),
    );

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'select:core_tool' });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('"name":"core_tool"');
  });

  it('+must-word filters candidates whose name does not contain the required term', async () => {
    // Both tools would match on "send" in description; only one has "slack"
    // in its name. The +slack prefix should narrow the result to that one.
    registry.registerTool(
      new MockTool({
        name: 'slack_send',
        description: 'send a message',
        shouldDefer: true,
      }),
    );
    registry.registerTool(
      new MockTool({
        name: 'email_send',
        description: 'send a message',
        shouldDefer: true,
      }),
    );

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: '+slack send' });
    const result = await invocation.execute(new AbortController().signal);

    const content = String(result.llmContent);
    expect(content).toContain('"name":"slack_send"');
    expect(content).not.toContain('"name":"email_send"');
  });
});

describe('ToolRegistry.clearRevealedDeferredTools', () => {
  it('empties the revealed set so new sessions start clean', async () => {
    const { config, registry } = makeConfigWithRegistry();
    registry.registerTool(
      new MockTool({ name: 'cron_create', shouldDefer: true }),
    );

    const tool = new ToolSearchTool(config);
    const invocation = tool.build({ query: 'select:cron_create' });
    await invocation.execute(new AbortController().signal);
    expect(registry.isDeferredToolRevealed('cron_create')).toBe(true);

    registry.clearRevealedDeferredTools();
    expect(registry.isDeferredToolRevealed('cron_create')).toBe(false);
    // And the declarations list should once again exclude it.
    expect(registry.getFunctionDeclarations().map((d) => d.name)).not.toContain(
      'cron_create',
    );
  });
});
