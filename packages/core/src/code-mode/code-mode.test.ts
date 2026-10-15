/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@google/genai';
import { AnthropicContentConverter } from '../core/anthropicContentGenerator/converter.js';
import { convertLlmToolsToOpenAI } from '../core/openaiContentGenerator/converter.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  buildExecDescription,
  getToolExposure,
  isCodeModeToolCallAllowed,
  planCodeModeBindings,
  type CodeModeBindingPlan,
} from '../tools/code-mode.js';
import { executeCodeMode } from './host-client.js';
import {
  CODE_MODE_MAX_CONTROL_FRAME_BYTES,
  CODE_MODE_MAX_FRAME_BYTES,
  encodeFrame,
  FrameDecoder,
  type HostMessage,
  type ParentMessage,
} from './protocol.js';
import type { ToolCallRuntimeContext } from './tool-call-runtime.js';

function plan(...jsNames: string[]): CodeModeBindingPlan {
  return {
    bindings: jsNames.map((jsName) => ({
      name: jsName,
      jsName,
      description: `${jsName} description`,
      parametersJsonSchema: { type: 'object' },
      deferred: false,
    })),
    collisions: [],
  };
}

function runtime(
  dispatch: ToolCallRuntimeContext['dispatch'],
): ToolCallRuntimeContext {
  return { parentCallId: 'parent', dispatch };
}

/** Runs `source` against `bindingPlan`, sending nested calls to `dispatch`. */
function runWith(
  source: string,
  bindingPlan: CodeModeBindingPlan,
  dispatch: ToolCallRuntimeContext['dispatch'],
  options?: Parameters<typeof executeCodeMode>[4],
) {
  return executeCodeMode(
    source,
    bindingPlan,
    runtime(dispatch),
    new AbortController().signal,
    options,
  );
}

/** Runs `source` with no bound tools; a nested dispatch would throw. */
function run(source: string, options?: Parameters<typeof executeCodeMode>[4]) {
  return runWith(
    source,
    plan(),
    async () => {
      throw new Error('unused');
    },
    options,
  );
}

function success(callId: string, name: string, output: string) {
  return { callId, name, status: 'success' as const, output };
}

/** A registry (CodeModeOnly unless `config` says otherwise) of MockTools. */
function registryWith(
  names: string[],
  config?: Parameters<typeof makeFakeConfig>[0],
  params?: Record<string, unknown>,
) {
  const registry = new ToolRegistry(
    makeFakeConfig(config ?? { codeModeOnly: true }),
  );
  for (const name of names) {
    registry.registerTool(new MockTool({ name, params }));
  }
  return registry;
}

describe('CodeModeOnly exposure', () => {
  const directTools = [
    'tool_search',
    'ask_user_question',
    'agent',
    'enter_plan_mode',
    'exit_plan_mode',
    'structured_output',
    'create_sub_session',
    'enter_worktree',
    'exit_worktree',
    'send_message',
    'speak_to_user',
    'wait_threads',
  ];
  const migratedTools = [
    'get_goal',
    'list_agents',
    'task_create',
    'task_update',
    'task_list',
    'task_stop',
    'team_create',
    'team_delete',
    'team_plan_approval',
    'request_shutdown',
    'list_threads',
    'read_thread',
    'send_message_to_thread',
    'create_thread',
    'skill',
    'update_goal',
    'capture_screen_context',
    'todo_write',
    'report_findings',
    'cron_create',
    'cron_list',
    'cron_delete',
    'loop_wakeup',
    'monitor',
    'workflow',
  ];

  it.each(directTools)('keeps %s directly callable only', (name) => {
    expect(getToolExposure(name)).toBe('direct-only');
    expect(isCodeModeToolCallAllowed(name, 'model')).toBe(true);
    expect(isCodeModeToolCallAllowed(name, 'code_mode')).toBe(false);
  });

  it.each(migratedTools)(
    'exposes %s through exec with scoped permissions',
    (name) => {
      expect(getToolExposure(name)).toBe('code-mode-callable');
      expect(isCodeModeToolCallAllowed(name, 'model')).toBe(false);
      expect(isCodeModeToolCallAllowed(name, 'code_mode')).toBe(true);
      expect(isCodeModeToolCallAllowed(name, 'code_mode', new Set())).toBe(
        false,
      );
      expect(
        isCodeModeToolCallAllowed(name, 'code_mode', new Set([name])),
      ).toBe(true);
    },
  );

  it('keeps tool_call hidden and exec non-nestable', () => {
    for (const name of ['tool_call']) {
      expect(getToolExposure(name)).toBe('hidden');
      expect(isCodeModeToolCallAllowed(name, 'model')).toBe(false);
      expect(isCodeModeToolCallAllowed(name, 'code_mode')).toBe(false);
    }
    expect(getToolExposure('exec')).toBe('exec');
    expect(isCodeModeToolCallAllowed('exec', 'code_mode')).toBe(false);
  });

  it('moves management and context tools out of top-level declarations', () => {
    const registry = registryWith([...directTools, ...migratedTools, 'exec']);
    const declarations = registry.getFunctionDeclarations();
    expect(declarations.map((declaration) => declaration.name).sort()).toEqual(
      [...directTools, 'exec'].sort(),
    );
    const description = declarations.find(
      (declaration) => declaration.name === 'exec',
    )?.description;
    for (const name of migratedTools)
      expect(description).toContain(`tools.${name}(args:`);
    expect(description).toContain(
      'are not automatically added to the exec response',
    );
    expect(description).toContain('Use text(value) to return text');
    expect(description).toContain(
      'bare return values and successful script completion produce no output',
    );
    expect(description).toContain('terminal update_goal');
  });

  it('registers exec only when CodeModeOnly is enabled', async () => {
    const direct = makeFakeConfig();
    const directRegistry = await direct.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    const codeMode = makeFakeConfig({ codeModeOnly: true });
    const codeModeRegistry = await codeMode.createToolRegistry(undefined, {
      skipDiscovery: true,
    });

    expect(directRegistry.getAllToolNames()).not.toContain('exec');
    expect(codeModeRegistry.getAllToolNames()).toContain('exec');
    expect(codeModeRegistry.getAllToolNames()).toContain('tool_search');
  });

  it('keeps Direct declarations unchanged', () => {
    const registry = new ToolRegistry(makeFakeConfig());
    for (const name of ['read_file', 'tool_search', 'agent']) {
      registry.registerTool(new MockTool({ name }));
    }

    expect(registry.getFunctionDeclarations().map((item) => item.name)).toEqual(
      ['agent', 'read_file', 'tool_search'],
    );
  });

  it('exposes exec and direct controls while retaining ordinary and hidden tools', () => {
    const registry = registryWith([
      'read_file',
      'tool_search',
      'ask_user_question',
      'agent',
      'exec',
    ]);

    const declarations = registry.getFunctionDeclarations();
    expect(declarations.map((item) => item.name)).toEqual([
      'agent',
      'ask_user_question',
      'exec',
      'tool_search',
    ]);
    const exec = declarations.find((item) => item.name === 'exec');
    expect(exec?.description).toContain('tools.read_file');
    expect(exec?.description).not.toContain('tools.tool_search');
    expect(registry.getAllToolNames()).toEqual(
      expect.arrayContaining(['read_file', 'tool_search']),
    );
  });

  it('narrows nested tools for filtered subagent declarations', () => {
    const registry = registryWith(['read_file', 'write_file', 'agent', 'exec']);

    const declarations = registry.getFunctionDeclarationsFiltered([
      'read_file',
    ]);
    expect(declarations.map((item) => item.name)).toEqual(['exec']);
    expect(declarations[0]?.description).toContain('tools.read_file');
    expect(declarations[0]?.description).not.toContain('tools.write_file');
  });

  it('keeps exec structured across Gemini, OpenAI, and Anthropic tool conversion', async () => {
    const registry = registryWith(['read_file', 'agent', 'exec'], undefined, {
      type: 'object',
    });
    const declarations = registry.getFunctionDeclarations();
    const tools = [{ functionDeclarations: declarations }] as Tool[];

    expect(declarations.map((item) => item.name)).toEqual(['agent', 'exec']);
    const openai = await convertLlmToolsToOpenAI(tools);
    expect(openai.map((item) => item.function.name)).toEqual(['agent', 'exec']);
    const anthropic = await new AnthropicContentConverter(
      'test-model',
    ).convertLlmToolsToAnthropic(tools);
    expect(anthropic.map((item) => item.name)).toEqual(['agent', 'exec']);
    expect(openai[1]?.function.description).toContain('tools.read_file');
    expect(anthropic[1]?.description).toContain('tools.read_file');
  });

  it('builds stable declarations and resolves normalized-name collisions first-wins', () => {
    const tools = [
      new MockTool({
        name: 'z-tool',
        params: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        },
      }),
      new MockTool({ name: 'z_tool' }),
      new MockTool({
        name: 'a-tool',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }),
    ];
    const first = planCodeModeBindings(tools, (name) => name === 'a-tool');
    const second = planCodeModeBindings(
      [...tools].reverse(),
      (name) => name === 'a-tool',
    );

    expect(first).toEqual(second);
    expect(first.bindings.map((item) => item.name)).toEqual([
      'a-tool',
      'z-tool',
    ]);
    expect(first.collisions).toEqual([
      { jsName: 'z_tool', kept: 'z-tool', omitted: 'z_tool' },
    ]);
    for (const fragment of [
      'tools.z_tool(args: { "count": number })',
      'tools.a_tool(args: { "query": string })',
      'ImageContent',
      'generatedImage',
      'text(result.value.output)',
      'setTimeout(callback: () => void, delayMs?: number)',
      'Pending timeouts do not keep exec alive by themselves',
      'clearTimeout(timeoutId?: number)',
    ]) {
      expect(buildExecDescription(first)).toContain(fragment);
    }
    expect(buildExecDescription(first)).not.toContain('text(result.value)');
  });

  it('keeps deferred tool schemas when search is unavailable', () => {
    const deferredPlan = planCodeModeBindings(
      [
        new MockTool({
          name: 'mcp__server__fetch',
          shouldDefer: true,
          params: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              depth: { type: 'integer' },
            },
            required: ['url'],
          },
        }),
      ],
      () => true,
    );
    const description = buildExecDescription(deferredPlan);

    expect(deferredPlan.bindings[0]?.deferred).toBe(true);
    expect(description).toContain(
      'tools.mcp__server__fetch(args: { "depth"?: number; "url": string })',
    );
    expect(description).not.toContain('mcp__server__fetch(args: Record');
    expect(description).toContain('"deferred":true');
  });

  it('omits deferred metadata while retaining callable bindings and stable declarations', () => {
    const config = makeFakeConfig({ codeModeOnly: true });
    const registry = new ToolRegistry(config);
    for (const name of ['exec', 'tool_search', 'read_file']) {
      registry.registerTool(new MockTool({ name }));
    }
    registry.registerTool(
      new MockTool({
        name: 'remote_lookup',
        shouldDefer: true,
        description: 'PRIVATE_DEFERRED_DESCRIPTION',
        params: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }),
    );
    const before = registry.getFunctionDeclarations();
    const description = before.find((d) => d.name === 'exec')!.description!;
    expect(description).toContain('tools.read_file(args:');
    expect(description).toContain('tool_search');
    expect(description).not.toContain('remote_lookup');
    expect(description).not.toContain('PRIVATE_DEFERRED_DESCRIPTION');
    expect(
      registry.getCodeModeBindingPlan().bindings.map((b) => b.name),
    ).toContain('remote_lookup');

    registry.registerTool(
      new MockTool({ name: 'another_deferred', shouldDefer: true }),
    );
    expect(registry.getFunctionDeclarations()).toEqual(before);
    const scoped = registry.getFunctionDeclarationsFiltered(['remote_lookup']);
    expect(scoped.map((d) => d.name)).toEqual(['exec']);
    expect(scoped[0].description).toContain('tools.remote_lookup(args:');
    expect(scoped[0].description).not.toContain('tools.read_file(args:');
  });

  it('keeps visible deferred signatures and omits hidden collision names', () => {
    const config = makeFakeConfig({ codeModeOnly: true });
    vi.spyOn(config, 'getVisibleTools').mockReturnValue(
      new Set(['visible_tool']),
    );
    const registry = new ToolRegistry(config);
    for (const name of ['exec', 'tool_search'])
      registry.registerTool(new MockTool({ name }));
    for (const name of ['visible_tool', 'hidden-tool', 'hidden_tool']) {
      registry.registerTool(new MockTool({ name, shouldDefer: true }));
    }
    const description = registry
      .getFunctionDeclarations()
      .find((d) => d.name === 'exec')!.description!;
    expect(description).toContain('tools.visible_tool(args:');
    expect(description).not.toContain('hidden-tool');
    expect(description).not.toContain('hidden_tool');
  });

  it('keeps numeric schema limits visible in nested tool declarations', () => {
    const boundedPlan = planCodeModeBindings(
      [
        new MockTool({
          name: 'run_shell_command',
          params: {
            type: 'object',
            properties: {
              timeout: { type: 'integer', minimum: 1, maximum: 600000 },
            },
          },
        }),
      ],
      () => false,
    );

    expect(buildExecDescription(boundedPlan)).toContain(
      '"timeout"?: number /* min 1, max 600000 */',
    );
  });
});

describe('code mode protocol', () => {
  it('allows large completion media without widening control messages', () => {
    const data = 'A'.repeat(CODE_MODE_MAX_CONTROL_FRAME_BYTES);
    const complete: HostMessage = {
      type: 'complete',
      output: '',
      content: [{ type: 'image', mimeType: 'image/png', data }],
    };
    const toolResult: ParentMessage = {
      type: 'tool_result',
      id: 'large-media-result',
      ok: true,
      result: {
        callId: 'image-gen',
        name: 'image_gen',
        status: 'success',
        output: 'generated',
        content: [{ type: 'image', mimeType: 'image/png', data }],
      },
    };

    const frame = encodeFrame(complete);
    expect(new FrameDecoder<HostMessage>().push(frame)).toEqual([complete]);
    const toolResultFrame = encodeFrame(toolResult);
    expect(new FrameDecoder<ParentMessage>().push(toolResultFrame)).toEqual([
      toolResult,
    ]);
    expect(() =>
      encodeFrame({
        type: 'tool_call',
        id: 'large-control',
        name: 'probe',
        args: { data },
      }),
    ).toThrow('frame exceeds the size limit');
    expect(() =>
      encodeFrame({
        type: 'tool_result',
        id: 'large-text-result',
        ok: true,
        result: {
          callId: 'large-text',
          name: 'probe',
          status: 'success',
          output: data,
        },
      }),
    ).toThrow('frame exceeds the size limit');
  });
});

describe('isolated code mode host', () => {
  it('keeps a pending sibling result when allSettled handles a rejection', async () => {
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const siblingStarted = vi.fn();
    const siblingAborted = vi.fn();
    const execution = executeCodeMode(
      `const results = await Promise.allSettled([
        tools.fail({}),
        tools.read({}),
      ]);
      for (const result of results) {
        text(result.status === 'fulfilled' ? result.value.output : String(result.reason));
      }
      return results.map(result => result.status);`,
      plan('fail', 'read'),
      runtime(async (name, _args, signal) => {
        if (name === 'fail') throw new Error('read failed');
        signal.addEventListener('abort', siblingAborted, { once: true });
        siblingStarted();
        await siblingGate;
        signal.removeEventListener('abort', siblingAborted);
        return { callId: 'read', name, status: 'success', output: 'retained' };
      }),
      new AbortController().signal,
    );
    try {
      await vi.waitFor(() => expect(siblingStarted).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      expect(siblingAborted).not.toHaveBeenCalled();
    } finally {
      releaseSibling();
    }
    const result = await execution;
    expect(result.value).toEqual(['rejected', 'fulfilled']);
    expect(result.output).toContain('read failed');
    expect(result.output).toContain('retained');
    expect(siblingAborted).not.toHaveBeenCalled();
  });

  it('runs async tool calls, Promise.all, helpers, and return values', async () => {
    const dispatch = vi.fn(async (name, args) =>
      success(String(args['value']), name, String(args['value'])),
    );

    const result = await runWith(
      `const [a, b] = await Promise.all([
        tools.echo({ value: 1 }),
        tools.echo({ value: 2 }),
      ]);
      text(a.output);
      text('tail');
      return { second: b.output, tools: ALL_TOOLS };`,
      plan('echo'),
      dispatch,
    );

    expect(result.output).toBe('1\ntail');
    expect(result.value).toEqual({
      second: '2',
      tools: [
        {
          name: 'echo',
          jsName: 'echo',
          description: 'echo description',
          deferred: false,
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not charge nested tool wait time against the guest CPU budget', async () => {
    const result = await executeCodeMode(
      'return (await tools.wait({})).output',
      plan('wait'),
      runtime(async (name) => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return {
          callId: 'wait',
          name,
          status: 'success',
          output: 'finished',
        };
      }),
      new AbortController().signal,
      { timeoutMs: 50 },
    );

    expect(result.value).toBe('finished');
  });

  it('resumes the guest CPU budget after a nested tool settles', async () => {
    await expect(
      runWith(
        'await tools.wait({}); while (true) {}',
        plan('wait'),
        async (name) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return success('wait', name, 'finished');
        },
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/interrupted|timed out/);
  });

  it('names the full wall budget when the host never frames a response', async () => {
    // A guest parked in an idle await burns no CPU, so the host-side
    // interrupt handler never fires and no response frame ever arrives; the
    // parent's wall backstop is the only timeout left. It must name the
    // budget that actually applied — the guest budget plus the host startup
    // grace — not the guest budget alone.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const pending = run('await new Promise(() => {})', { timeoutMs: 1 });
      // Keep the rejection handled while fake time advances; it is asserted
      // after the wall timer fires.
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(pending).rejects.toThrow(
        'JavaScript execution timed out after 30001ms (guest budget 1ms; the code-mode host may not have finished starting).',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls a deferred MCP-style tool through its normalized JavaScript name', async () => {
    const dispatch = vi.fn(async (name: string) =>
      success('mcp-call', name, 'mcp output'),
    );
    const mcpPlan: CodeModeBindingPlan = {
      bindings: [
        {
          name: 'mcp.server/read-resource',
          jsName: 'mcp_server_read_resource',
          description: 'Read an MCP resource',
          parametersJsonSchema: { type: 'object' },
          deferred: true,
        },
      ],
      collisions: [],
    };

    const result = await runWith(
      'return (await tools.mcp_server_read_resource({ uri: "test://item" })).output',
      mcpPlan,
      dispatch,
    );

    expect(result.value).toBe('mcp output');
    expect(dispatch).toHaveBeenCalledWith(
      'mcp.server/read-resource',
      { uri: 'test://item' },
      expect.any(AbortSignal),
    );
  });

  it('reports invalid JavaScript and thrown errors', async () => {
    await expect(run('if (')).rejects.toThrow();
    await expect(run('throw new Error("guest failure")')).rejects.toThrow(
      'guest failure',
    );
    await expect(
      runWith(
        'await tools.echo({}).then(() => { throw new Error("job failure"); })',
        plan('echo'),
        async (name) => success('echo', name, 'ok'),
      ),
    ).rejects.toThrow('job failure');
  });

  it('interrupts CPU loops and bounds helper output', async () => {
    await expect(run('while (true) {}', { timeoutMs: 50 })).rejects.toThrow(
      /interrupted|timed out/,
    );

    const result = await run('text("abcdefgh")', { maxOutputChars: 3 });
    expect(result.output).toBe('abc');
  });

  it('bounds return values and oversized nested tool content', async () => {
    const result = await runWith(
      `const nested = await tools.large({});
      text(typeof nested.content);
      try { await tools.fail({}); } catch (error) { text(error.message.length); }
      return 'v'.repeat(1000);`,
      plan('large', 'fail'),
      async (name) => {
        if (name === 'fail') throw new Error('e'.repeat(2_000_000));
        return {
          ...success('large', name, 'ok'),
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'A'.repeat(CODE_MODE_MAX_FRAME_BYTES + 1),
            },
          ],
        };
      },
      { maxOutputChars: 100 },
    );

    expect(result.output).toBe('undefined\n100000');
    expect(result.value).toMatch(/^\[Code mode value truncated\]/);
    expect((result.value as string).length).toBeLessThanOrEqual(100);
  });

  it('preserves media independently of the text output budget', async () => {
    const data = 'QUJD'.repeat(2_000);
    const result = await run(
      `text('before');
      image('data:image/png;base64,${data}');
      text('after');`,
      { maxOutputChars: 100 },
    );

    expect(result.output).toBe('before\nafter');
    expect(result.content).toEqual([
      { type: 'image', mimeType: 'image/png', data },
    ]);
  });

  it('accepts Qwen MCP ImageContent in image()', async () => {
    const result = await run(
      `image({
        type: 'image',
        mimeType: 'image/png',
        data: 'QUJD',
      });`,
    );

    expect(result.content).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    ]);
  });

  it('accepts the Qwen image_gen result in generatedImage()', async () => {
    const result = await run(
      `generatedImage({
        callId: 'image-gen',
        name: 'image_gen',
        status: 'success',
        output: 'Generated image saved to /workspace/generated.png.',
        content: [{
          type: 'image',
          mimeType: 'image/png',
          data: 'QUJD',
        }],
      });`,
    );

    expect(result).toEqual({
      output: 'Generated image saved to /workspace/generated.png.',
      content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }],
    });
  });

  it('preserves generated images larger than the control frame limit', async () => {
    const data = 'QUJD'.repeat(350_000);
    const result = await runWith(
      `const generated = await tools.image_gen({ prompt: 'large poster' });
      generatedImage(generated);`,
      plan('image_gen'),
      async (name) => ({
        ...success(
          'large-image-gen',
          name,
          'Generated image saved to /workspace/large.png.',
        ),
        content: [{ type: 'image', mimeType: 'image/png', data }],
      }),
    );

    expect(result.output).toBe(
      'Generated image saved to /workspace/large.png.',
    );
    expect(result.content).toEqual([
      { type: 'image', mimeType: 'image/png', data },
    ]);
  });

  it('rejects malformed Qwen media helper inputs', async () => {
    await expect(
      run(
        `image({
          type: 'image',
          mimeType: 'audio/wav',
          data: 'QUJD',
        });`,
      ),
    ).rejects.toThrow('Qwen MCP ImageContent');
    await expect(
      run(
        `generatedImage({
          callId: 'other',
          name: 'other_tool',
          status: 'success',
          output: 'not an image generator',
          content: [{
            type: 'image',
            mimeType: 'image/png',
            data: 'QUJD',
          }],
        });`,
      ),
    ).rejects.toThrow('tools.image_gen()');
  });

  it('rejects image output that is not a base64 data URL', async () => {
    for (const value of [
      'https://example.com/image.png',
      'data:audio/wav;base64,QUJD',
      'data:image/png;base64,==',
    ]) {
      await expect(run(`image(${JSON.stringify(value)})`)).rejects.toThrow(
        'base64 data URL',
      );
    }
  });

  it('enforces the memory limit and rejects unavailable or recursive tools', async () => {
    await expect(
      run('return new ArrayBuffer(128 * 1024 * 1024).byteLength', {
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('out of memory');
    await expect(run('await tools.exec({ source: "" })')).rejects.toThrow(
      'Unknown or unavailable code mode tool: exec',
    );
    await expect(
      run(
        'Object.prototype.hasOwnProperty = () => true; await tools.constructor({})',
      ),
    ).rejects.toThrow('Unknown or unavailable code mode tool: constructor');

    const protoDispatch = vi.fn(async (name: string) =>
      success('proto', name, 'proto ok'),
    );
    const proto = await runWith(
      'return (await tools.__proto__({})).output',
      plan('__proto__'),
      protoDispatch,
    );
    expect(proto.value).toBe('proto ok');
  });

  it('supports immediate exit without running later statements', async () => {
    const result = await run('text("before"); exit(); text("after")');
    expect(result.output).toBe('before');
  });

  it('supports cancellable one-shot timers', async () => {
    const result = await run(
      `const cancelled = setTimeout(() => text('cancelled'), 0);
      clearTimeout(cancelled);
      await new Promise((resolve) => setTimeout(resolve, 25));
      text('timer done');
      return [typeof setTimeout, typeof clearTimeout];`,
    );

    expect(result.output).toBe('timer done');
    expect(result.value).toEqual(['function', 'function']);
  });

  it('does not keep exec alive for an unawaited timer', async () => {
    const result = await run(
      `setTimeout(() => text('late'), 60_000);
      text('done');`,
      { timeoutMs: 25 },
    );

    expect(result.output).toBe('done');
  });

  it('does not charge timer wait time against the guest CPU budget', async () => {
    const result = await run(
      `await new Promise((resolve) => setTimeout(resolve, 100));
      text('done');`,
      { timeoutMs: 50 },
    );

    expect(result.output).toBe('done');
  });

  it('surfaces errors thrown by timer callbacks', async () => {
    await expect(
      run(
        `await new Promise(() => {
          setTimeout(() => { throw new Error('timer failure'); }, 0);
        });`,
      ),
    ).rejects.toThrow('timer failure');
  });

  it('bounds the number of live timers', async () => {
    await expect(
      run(
        `for (let i = 0; i < 1025; i++) {
          setTimeout(() => {}, 60_000);
        }`,
      ),
    ).rejects.toThrow('at most 1024 live timers');
  });

  it('does not expose Node, network, console, or WebAssembly', async () => {
    const result = await run(
      `return [
        typeof process, typeof require, typeof fetch, typeof console,
        typeof WebAssembly, typeof SharedArrayBuffer,
      ];`,
    );
    expect(result.value).toEqual(Array(6).fill('undefined'));

    await expect(run('await import("node:fs")')).rejects.toThrow();
  });

  it('uses a fresh global context for every call', async () => {
    await run('globalThis.persisted = 42');
    const result = await run('return typeof persisted');
    expect(result.value).toBe('undefined');
  });

  it('cancels unawaited nested calls when the program settles', async () => {
    let aborted = false;
    const result = await runWith(
      'tools.wait({}); return "done";',
      plan('wait'),
      (_name, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    expect(result.value).toBe('done');
    expect(aborted).toBe(true);
  });

  it('propagates parent cancellation', async () => {
    const controller = new AbortController();
    const execution = executeCodeMode(
      'await tools.wait({})',
      plan('wait'),
      runtime(
        (_name, _args, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('cancelled by test')), 100);
    await expect(execution).rejects.toThrow('cancelled by test');
  });
});
