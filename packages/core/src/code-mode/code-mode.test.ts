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
  planCodeModeBindings,
  type CodeModeBindingPlan,
} from '../tools/code-mode.js';
import { executeCodeMode } from './host-client.js';
import {
  CODE_MODE_MAX_CONTROL_FRAME_BYTES,
  encodeFrame,
  FrameDecoder,
  type HostMessage,
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

describe('CodeModeOnly exposure', () => {
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
    const registry = new ToolRegistry(makeFakeConfig({ codeModeOnly: true }));
    for (const name of [
      'read_file',
      'tool_search',
      'ask_user_question',
      'agent',
      'exec',
    ]) {
      registry.registerTool(new MockTool({ name }));
    }

    const declarations = registry.getFunctionDeclarations();
    expect(declarations.map((item) => item.name)).toEqual([
      'agent',
      'ask_user_question',
      'exec',
    ]);
    expect(
      declarations.find((item) => item.name === 'exec')?.description,
    ).toContain('tools.read_file');
    expect(
      declarations.find((item) => item.name === 'exec')?.description,
    ).not.toContain('tools.tool_search');
    expect(registry.getAllToolNames()).toEqual(
      expect.arrayContaining(['read_file', 'tool_search']),
    );
  });

  it('narrows nested tools for filtered subagent declarations', () => {
    const registry = new ToolRegistry(makeFakeConfig({ codeModeOnly: true }));
    for (const name of ['read_file', 'write_file', 'agent', 'exec']) {
      registry.registerTool(new MockTool({ name }));
    }

    const declarations = registry.getFunctionDeclarationsFiltered([
      'read_file',
    ]);
    expect(declarations.map((item) => item.name)).toEqual(['exec']);
    expect(declarations[0]?.description).toContain('tools.read_file');
    expect(declarations[0]?.description).not.toContain('tools.write_file');
  });

  it('keeps exec structured across Gemini, OpenAI, and Anthropic tool conversion', async () => {
    const registry = new ToolRegistry(makeFakeConfig({ codeModeOnly: true }));
    for (const name of ['read_file', 'agent', 'exec']) {
      registry.registerTool(new MockTool({ name, params: { type: 'object' } }));
    }
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
      new MockTool({ name: 'a-tool', shouldDefer: true }),
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
    expect(buildExecDescription(first)).toContain(
      'tools.z_tool(args: { "count": number })',
    );
    expect(buildExecDescription(first)).toContain(
      'tools.a_tool(args: Record<string, unknown>)',
    );
    expect(buildExecDescription(first)).toContain('base64 data URL');
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

    const frame = encodeFrame(complete);
    expect(new FrameDecoder<HostMessage>().push(frame)).toEqual([complete]);
    expect(() =>
      encodeFrame({
        type: 'tool_call',
        id: 'large-control',
        name: 'probe',
        args: { data },
      }),
    ).toThrow('frame exceeds the size limit');
  });
});

describe('isolated code mode host', () => {
  it('runs async tool calls, Promise.all, helpers, and return values', async () => {
    const dispatch = vi.fn(async (name, args) => ({
      callId: String(args['value']),
      name,
      status: 'success' as const,
      output: String(args['value']),
    }));

    const result = await executeCodeMode(
      `const [a, b] = await Promise.all([
        tools.echo({ value: 1 }),
        tools.echo({ value: 2 }),
      ]);
      text(a.output);
      text('tail');
      return { second: b.output, tools: ALL_TOOLS };`,
      plan('echo'),
      runtime(dispatch),
      new AbortController().signal,
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
      executeCodeMode(
        'await tools.wait({}); while (true) {}',
        plan('wait'),
        runtime(async (name) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            callId: 'wait',
            name,
            status: 'success',
            output: 'finished',
          };
        }),
        new AbortController().signal,
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/interrupted|timed out/);
  });

  it('calls a deferred MCP-style tool through its normalized JavaScript name', async () => {
    const dispatch = vi.fn(async (name: string) => ({
      callId: 'mcp-call',
      name,
      status: 'success' as const,
      output: 'mcp output',
    }));
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

    const result = await executeCodeMode(
      'return (await tools.mcp_server_read_resource({ uri: "test://item" })).output',
      mcpPlan,
      runtime(dispatch),
      new AbortController().signal,
    );

    expect(result.value).toBe('mcp output');
    expect(dispatch).toHaveBeenCalledWith(
      'mcp.server/read-resource',
      { uri: 'test://item' },
      expect.any(AbortSignal),
    );
  });

  it('reports invalid JavaScript and thrown errors', async () => {
    await expect(
      executeCodeMode(
        'if (',
        plan(),
        runtime(async () => {
          throw new Error('unused');
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      executeCodeMode(
        'throw new Error("guest failure")',
        plan(),
        runtime(async () => {
          throw new Error('unused');
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('guest failure');
    await expect(
      executeCodeMode(
        'await tools.echo({}).then(() => { throw new Error("job failure"); })',
        plan('echo'),
        runtime(async (name) => ({
          callId: 'echo',
          name,
          status: 'success',
          output: 'ok',
        })),
        new AbortController().signal,
      ),
    ).rejects.toThrow('job failure');
  });

  it('interrupts CPU loops and bounds helper output', async () => {
    await expect(
      executeCodeMode(
        'while (true) {}',
        plan(),
        runtime(async () => {
          throw new Error('unused');
        }),
        new AbortController().signal,
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/interrupted|timed out/);

    const result = await executeCodeMode(
      'text("abcdefgh")',
      plan(),
      runtime(async () => {
        throw new Error('unused');
      }),
      new AbortController().signal,
      { maxOutputChars: 3 },
    );
    expect(result.output).toBe('abc');
  });

  it('bounds return values and nested tool content', async () => {
    const result = await executeCodeMode(
      `const nested = await tools.large({});
      text(typeof nested.content);
      try { await tools.fail({}); } catch (error) { text(error.message.length); }
      return 'v'.repeat(1000);`,
      plan('large', 'fail'),
      runtime(async (name) => {
        if (name === 'fail') throw new Error('e'.repeat(2_000_000));
        return {
          callId: 'large',
          name,
          status: 'success',
          output: 'ok',
          content: 'n'.repeat(600_000),
        };
      }),
      new AbortController().signal,
      { maxOutputChars: 100 },
    );

    expect(result.output).toBe('undefined\n100000');
    expect(result.value).toMatch(/^\[Code mode value truncated\]/);
    expect((result.value as string).length).toBeLessThanOrEqual(100);
  });

  it('preserves media independently of the text output budget', async () => {
    const data = 'QUJD'.repeat(2_000);
    const result = await executeCodeMode(
      `text('before');
      image('data:image/png;base64,${data}');
      text('after');`,
      plan(),
      runtime(async () => {
        throw new Error('unused');
      }),
      new AbortController().signal,
      { maxOutputChars: 100 },
    );

    expect(result.output).toBe('before\nafter');
    expect(result.content).toEqual([
      { type: 'image', mimeType: 'image/png', data },
    ]);
  });

  it('rejects image output that is not a base64 data URL', async () => {
    for (const value of [
      'https://example.com/image.png',
      'data:audio/wav;base64,QUJD',
      'data:image/png;base64,==',
    ]) {
      await expect(
        executeCodeMode(
          `image(${JSON.stringify(value)})`,
          plan(),
          runtime(async () => {
            throw new Error('unused');
          }),
          new AbortController().signal,
        ),
      ).rejects.toThrow('base64 data URL');
    }
  });

  it('enforces the memory limit and rejects unavailable or recursive tools', async () => {
    const noTools = runtime(async () => {
      throw new Error('unused');
    });
    await expect(
      executeCodeMode(
        'return new ArrayBuffer(128 * 1024 * 1024).byteLength',
        plan(),
        noTools,
        new AbortController().signal,
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow('out of memory');
    await expect(
      executeCodeMode(
        'await tools.exec({ source: "" })',
        plan(),
        noTools,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Unknown or unavailable code mode tool: exec');
    await expect(
      executeCodeMode(
        'Object.prototype.hasOwnProperty = () => true; await tools.constructor({})',
        plan(),
        noTools,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Unknown or unavailable code mode tool: constructor');

    const protoDispatch = vi.fn(async (name: string) => ({
      callId: 'proto',
      name,
      status: 'success' as const,
      output: 'proto ok',
    }));
    const proto = await executeCodeMode(
      'return (await tools.__proto__({})).output',
      plan('__proto__'),
      runtime(protoDispatch),
      new AbortController().signal,
    );
    expect(proto.value).toBe('proto ok');
  });

  it('supports immediate exit without running later statements', async () => {
    const result = await executeCodeMode(
      'text("before"); exit(); text("after")',
      plan(),
      runtime(async () => {
        throw new Error('unused');
      }),
      new AbortController().signal,
    );
    expect(result.output).toBe('before');
  });

  it('does not expose Node, network, timers, console, or WebAssembly', async () => {
    const result = await executeCodeMode(
      `return [
        typeof process, typeof require, typeof fetch, typeof setTimeout,
        typeof console, typeof WebAssembly, typeof SharedArrayBuffer,
      ];`,
      plan(),
      runtime(async () => {
        throw new Error('unused');
      }),
      new AbortController().signal,
    );
    expect(result.value).toEqual(Array(7).fill('undefined'));

    await expect(
      executeCodeMode(
        'await import("node:fs")',
        plan(),
        runtime(async () => {
          throw new Error('unused');
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it('uses a fresh global context for every call', async () => {
    const noTools = runtime(async () => {
      throw new Error('unused');
    });
    await executeCodeMode(
      'globalThis.persisted = 42',
      plan(),
      noTools,
      new AbortController().signal,
    );
    const result = await executeCodeMode(
      'return typeof persisted',
      plan(),
      noTools,
      new AbortController().signal,
    );
    expect(result.value).toBe('undefined');
  });

  it('cancels unawaited nested calls when the program settles', async () => {
    let aborted = false;
    const result = await executeCodeMode(
      'tools.wait({}); return "done";',
      plan('wait'),
      runtime(
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
      ),
      new AbortController().signal,
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
