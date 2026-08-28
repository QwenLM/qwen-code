/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode, Config } from '../config/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { buildCodeModeToolCatalog } from './code-mode-catalog.js';
import { executeCodeMode } from './code-mode-runtime.js';
import { ExecTool, type ExecParams } from './exec.js';
import { ToolMode } from './tool-mode.js';
import { ToolNames } from './tool-names.js';
import { ToolRegistry } from './tool-registry.js';
import {
  toolCallResponseValue,
  type ToolRuntimeDispatchRequest,
} from './tool-call-runtime.js';

function createConfig(codeModeOnly = false): Config {
  return new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    model: 'test-model',
    embeddingModel: 'test-embedding-model',
    sandbox: undefined,
    debugMode: false,
    userMemory: '',
    memoryFileCount: 0,
    approvalMode: ApprovalMode.DEFAULT,
    codeModeOnly,
  });
}

describe('CodeModeOnly exposure', () => {
  it('defaults to Direct and keeps its declaration behavior unchanged', () => {
    const config = createConfig();
    const registry = new ToolRegistry(config);
    registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
    registry.registerTool(new MockTool({ name: ToolNames.TOOL_SEARCH }));
    registry.registerTool(new MockTool({ name: ToolNames.TOOL_CALL }));
    registry.registerTool(new MockTool({ name: ToolNames.EXEC }));

    expect(config.getEffectiveToolMode()).toBe(ToolMode.Direct);
    expect(registry.getFunctionDeclarations().map((tool) => tool.name)).toEqual(
      [ToolNames.READ_FILE, ToolNames.TOOL_CALL, ToolNames.TOOL_SEARCH],
    );
  });

  it('shows only exec and audited direct-only tools without shrinking the registry', () => {
    const config = createConfig(true);
    const registry = new ToolRegistry(config);
    for (const name of [
      ToolNames.READ_FILE,
      ToolNames.TOOL_SEARCH,
      ToolNames.TOOL_CALL,
      ToolNames.EXEC,
      ToolNames.ASK_USER_QUESTION,
      ToolNames.AGENT,
      'capture_screen_context',
      'list_threads',
    ]) {
      registry.registerTool(new MockTool({ name }));
    }

    expect(config.getEffectiveToolMode()).toBe(ToolMode.CodeModeOnly);
    expect(registry.getAllToolNames()).toHaveLength(8);
    expect(registry.getFunctionDeclarations().map((tool) => tool.name)).toEqual(
      [
        ToolNames.AGENT,
        ToolNames.ASK_USER_QUESTION,
        'capture_screen_context',
        ToolNames.EXEC,
        'list_threads',
      ],
    );
    expect(
      registry
        .getFunctionDeclarationsFiltered([ToolNames.READ_FILE, ToolNames.EXEC])
        .map((tool) => tool.name),
    ).toEqual([ToolNames.EXEC]);
  });

  it('gives Gemini/Qwen a structured source-only exec declaration', () => {
    const config = createConfig(true);
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
    registry.registerTool(new ExecTool(config));

    const declaration = registry
      .getFunctionDeclarations()
      .find((tool) => tool.name === ToolNames.EXEC);

    expect(declaration?.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'JavaScript source to execute.',
        },
      },
      required: ['source'],
      additionalProperties: false,
    });
    expect(declaration?.description).toContain(
      'read_file(args: unknown): Promise<unknown>',
    );
  });

  it('rejects non-string exec source before generic parameter coercion', () => {
    const config = createConfig(true);
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const tool = new ExecTool(config);

    for (const source of [42, true]) {
      expect(tool.validateToolParams({ source } as unknown as ExecParams)).toBe(
        "The 'source' parameter must be a string.",
      );
    }
    expect(tool.validateToolParams({ source: 'text(42);' })).toBeNull();
  });

  it('builds a stable nested catalog and reports normalized-name collisions', () => {
    const registry = new ToolRegistry(createConfig(true));
    registry.registerTool(
      new MockTool({
        name: 'a-b',
        description: 'first',
        params: {
          type: 'object',
          properties: { z: { type: 'string' }, a: { type: 'number' } },
          required: ['z'],
        },
      }),
    );
    registry.registerTool(new MockTool({ name: 'a_b', description: 'second' }));
    registry.registerTool(
      new MockTool({
        name: 'deferred_tool',
        description: 'deferred',
        shouldDefer: true,
      }),
    );
    registry.registerTool(new MockTool({ name: ToolNames.AGENT }));
    registry.registerTool(new MockTool({ name: ToolNames.TOOL_SEARCH }));

    const catalog = buildCodeModeToolCatalog(registry);

    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'a_b',
      'deferred_tool',
    ]);
    expect(catalog.tools[0]?.originalName).toBe('a-b');
    expect(catalog.warnings).toEqual([
      expect.stringContaining('already claimed by "a-b"'),
    ]);
    expect(catalog.description).toContain(
      'a_b(args: { "a"?: number; "z": string; })',
    );
    expect(catalog.description).not.toContain('deferred_tool(args:');
    expect(catalog.description).toContain('"name": "deferred_tool"');
    expect(catalog.description).not.toContain('tool_search(args:');
    expect(catalog.description).not.toContain('agent(args:');
  });
});

describe('isolated code mode runtime', () => {
  const catalog = {
    warnings: [],
    description: '',
    tools: [
      {
        name: 'echo',
        originalName: 'echo',
        description: 'Echo a value',
        deferred: false,
        parametersJsonSchema: {},
      },
    ],
  };

  it('rejects non-string source at the runtime boundary', async () => {
    await expect(
      executeCodeMode(
        42 as unknown as string,
        'parent',
        catalog,
        { dispatch: vi.fn() },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Code mode source must be a string.');
  });

  it('supports top-level await and concurrent tool promises', async () => {
    let active = 0;
    let maxActive = 0;
    const dispatch = vi.fn(async ({ args }: ToolRuntimeDispatchRequest) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { output: args['value'] };
    });

    const result = await executeCodeMode(
      `const values = await Promise.all([
        tools.echo({ value: 'a' }),
        tools.echo({ value: 'b' })
      ]);
      text(values);`,
      'parent',
      catalog,
      { dispatch },
      new AbortController().signal,
    );

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);
    expect(result).toEqual({
      outputs: ['[{"output":"a"},{"output":"b"}]'],
      truncated: false,
    });
  });

  it('supports sequential tool calls and preserves their order', async () => {
    const values: unknown[] = [];
    const dispatch = vi.fn(async ({ args }: ToolRuntimeDispatchRequest) => {
      values.push(args['value']);
      return { output: args['value'] };
    });

    const result = await executeCodeMode(
      `text(await tools.echo({ value: 'first' }));
       text(await tools.echo({ value: 'second' }));`,
      'parent',
      catalog,
      { dispatch },
      new AbortController().signal,
    );

    expect(values).toEqual(['first', 'second']);
    expect(result.outputs).toEqual([
      '{"output":"first"}',
      '{"output":"second"}',
    ]);
  });

  it('binds special object property names without changing the tools prototype', async () => {
    const specialCatalog = {
      ...catalog,
      tools: [
        {
          name: '__proto__',
          originalName: '__proto__',
          description: 'special',
          deferred: false,
          parametersJsonSchema: {},
        },
      ],
    };
    const dispatch = vi.fn().mockResolvedValue({ output: 'safe' });

    const result = await executeCodeMode(
      `text(await tools.__proto__({}));`,
      'parent',
      specialCatalog,
      { dispatch },
      new AbortController().signal,
    );

    expect(result.outputs).toEqual(['{"output":"safe"}']);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('reports invalid source, non-object arguments, and recursive exec clearly', async () => {
    await expect(
      executeCodeMode(
        'const = invalid',
        'parent',
        catalog,
        { dispatch: vi.fn() },
        new AbortController().signal,
      ),
    ).rejects.toThrow();

    const result = await executeCodeMode(
      `try { await tools.echo(null); } catch (error) { text(error.message); }
       text(typeof tools.exec);`,
      'parent',
      catalog,
      { dispatch: vi.fn() },
      new AbortController().signal,
    );

    expect(result.outputs).toEqual([
      'Tool arguments must be an object.',
      'undefined',
    ]);
  });

  it('rejects nested failures into JavaScript', async () => {
    const result = await executeCodeMode(
      `try { await tools.echo({}); }
       catch (error) { text(error.message); }`,
      'parent',
      catalog,
      { dispatch: vi.fn().mockRejectedValue(new Error('nested failure')) },
      new AbortController().signal,
    );

    expect(result.outputs).toEqual(['nested failure']);
  });

  it('preserves nested cancellation as an abort error', () => {
    expect(() =>
      toolCallResponseValue({
        callId: 'nested',
        responseParts: [],
        resultDisplay: undefined,
        error: new Error('generic scheduler error'),
        errorType: undefined,
        executionStatus: 'cancelled',
      }),
    ).toThrow('Nested tool call was cancelled.');
  });

  it('does not expose Node, shared-memory, or WebAssembly globals', async () => {
    const result = await executeCodeMode(
      `text([
        typeof process,
        typeof require,
        typeof Buffer,
        typeof console,
        typeof Atomics,
        typeof SharedArrayBuffer,
        typeof WebAssembly,
        typeof fetch,
        typeof XMLHttpRequest,
        typeof WebSocket
      ]);`,
      'parent',
      catalog,
      { dispatch: vi.fn() },
      new AbortController().signal,
    );

    expect(result.outputs).toEqual([
      '["undefined","undefined","undefined","undefined","undefined","undefined","undefined","undefined","undefined","undefined"]',
    ]);
  });

  it('does not install an import loader', async () => {
    await expect(
      executeCodeMode(
        `await import('node:fs');`,
        'parent',
        catalog,
        { dispatch: vi.fn() },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it('hard-cancels a guest CPU loop without blocking the host', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled by test')), 50);

    await expect(
      executeCodeMode(
        'while (true) {}',
        'parent',
        catalog,
        { dispatch: vi.fn() },
        controller.signal,
      ),
    ).rejects.toThrow('cancelled by test');
  });

  it('aborts unawaited tool work when the script finishes', async () => {
    let nestedAborted = false;
    const dispatch = vi.fn(
      ({ signal }: ToolRuntimeDispatchRequest) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              nestedAborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    );

    const result = await executeCodeMode(
      `tools.echo({ value: 'unawaited' }); text('done');`,
      'parent',
      catalog,
      { dispatch },
      new AbortController().signal,
    );

    expect(result.outputs).toEqual(['done']);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(nestedAborted).toBe(true);
  });

  it('propagates parent cancellation to awaited nested work', async () => {
    const controller = new AbortController();
    let nestedAborted = false;
    const dispatch = vi.fn(
      ({ signal }: ToolRuntimeDispatchRequest) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              nestedAborted = true;
              reject(new Error('nested cancelled'));
            },
            { once: true },
          );
        }),
    );
    const execution = executeCodeMode(
      'await tools.echo({});',
      'parent',
      catalog,
      { dispatch },
      controller.signal,
    );
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    controller.abort(new Error('turn cancelled'));

    await expect(execution).rejects.toThrow('turn cancelled');
    expect(nestedAborted).toBe(true);
  });

  it('uses a fresh isolate and bounds final output', async () => {
    await executeCodeMode(
      `globalThis.leak = 'secret';`,
      'first',
      catalog,
      { dispatch: vi.fn() },
      new AbortController().signal,
    );
    const isolated = await executeCodeMode(
      `text(typeof globalThis.leak);`,
      'second',
      catalog,
      { dispatch: vi.fn() },
      new AbortController().signal,
    );
    expect(isolated.outputs).toEqual(['undefined']);

    const bounded = await executeCodeMode(
      `text('x'.repeat(40_000));`,
      'bounded',
      catalog,
      { dispatch: vi.fn() },
      new AbortController().signal,
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.outputs.join('')).toContain('code mode output truncated');
    expect(bounded.outputs.join('').length).toBeLessThanOrEqual(32_000);
  });
});
