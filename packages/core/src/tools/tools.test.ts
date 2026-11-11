/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  DeclarativeTool,
  hasCycleInSchema,
  isGlobResult,
  isGrepResult,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { ReadFileTool } from './read-file.js';
import { makeFakeConfig } from '../test-utils/config.js';

class TestToolInvocation implements ToolInvocation<object, ToolResult> {
  constructor(
    readonly params: object,
    private readonly executeFn: () => Promise<ToolResult>,
  ) {}

  getDescription(): string {
    return 'A test invocation';
  }

  toolLocations() {
    return [];
  }

  execute(): Promise<ToolResult> {
    return this.executeFn();
  }
}

class TestTool extends DeclarativeTool<object, ToolResult> {
  private readonly buildFn: (params: object) => TestToolInvocation;

  constructor(buildFn: (params: object) => TestToolInvocation) {
    super(
      'test-tool',
      'Test Tool',
      'A tool for testing',
      Kind.Other,
      {},
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
    this.buildFn = buildFn;
  }

  build(params: object): ToolInvocation<object, ToolResult> {
    return this.buildFn(params);
  }
}

class TestBaseDeclarativeTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  constructor(schema: unknown) {
    super('test-base-tool', 'Test Base Tool', 'A base tool for testing', Kind.Other, schema);
  }

  protected createInvocation(
    params: Record<string, unknown>,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new TestToolInvocation(params, async () => ({
      llmContent: 'Success!',
      returnDisplay: 'Success!',
    })) as ToolInvocation<Record<string, unknown>, ToolResult>;
  }
}

describe('DeclarativeTool', () => {
  describe('toClassifierInput', () => {
    const tool = new TestTool(() => new TestToolInvocation({}, vi.fn()));

    it('returns long input whole', () => {
      const input = { content: 'x'.repeat(5000) + 'TAIL' };
      expect(tool.toClassifierInput(input)).toBe(input);
    });

    it('returns a placeholder for unserializable input', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(tool.toClassifierInput(circular)).toEqual({
        _error: 'input not serializable',
      });
    });
  });

  describe('validateBuildAndExecute', () => {
    const abortSignal = new AbortController().signal;

    it('should return INVALID_TOOL_PARAMS error if build fails', async () => {
      const buildError = new Error('Invalid build parameters');
      const buildFn = vi.fn().mockImplementation(() => {
        throw buildError;
      });
      const tool = new TestTool(buildFn);
      const params = { foo: 'bar' };

      const result = await tool.validateBuildAndExecute(params, abortSignal);

      expect(buildFn).toHaveBeenCalledWith(params);
      expect(result).toEqual({
        llmContent: `Error: Invalid parameters provided. Reason: ${buildError.message}`,
        returnDisplay: buildError.message,
        error: {
          message: buildError.message,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
        data: {
          tool_error_stage: 'parameter_validation',
          tool_error_subtype: 'unknown_build_validation',
          tool_error_details_json: JSON.stringify({
            schema_version: 1,
            validation_source: 'build',
            constraint_category: 'unknown',
            quality: 'fallback',
            validation_phase: 'build',
          }),
        },
      });
    });

    it('should return EXECUTION_FAILED error if execute fails', async () => {
      const executeError = new Error('Execution failed');
      const executeFn = vi.fn().mockRejectedValue(executeError);
      const invocation = new TestToolInvocation({}, executeFn);
      const buildFn = vi.fn().mockReturnValue(invocation);
      const tool = new TestTool(buildFn);
      const params = { foo: 'bar' };

      const result = await tool.validateBuildAndExecute(params, abortSignal);

      expect(buildFn).toHaveBeenCalledWith(params);
      expect(executeFn).toHaveBeenCalled();
      expect(result).toEqual({
        llmContent: `Error: Tool call execution failed. Reason: ${executeError.message}`,
        returnDisplay: executeError.message,
        error: {
          message: executeError.message,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      });
    });

    it('should return the result of execute on success', async () => {
      const successResult: ToolResult = {
        llmContent: 'Success!',
        returnDisplay: 'Success!',
      };
      const executeFn = vi.fn().mockResolvedValue(successResult);
      const invocation = new TestToolInvocation({}, executeFn);
      const buildFn = vi.fn().mockReturnValue(invocation);
      const tool = new TestTool(buildFn);
      const params = { foo: 'bar' };

      const result = await tool.validateBuildAndExecute(params, abortSignal);

      expect(buildFn).toHaveBeenCalledWith(params);
      expect(executeFn).toHaveBeenCalled();
      expect(result).toEqual(successResult);
    });
  });
});

describe('BaseDeclarativeTool', () => {
  it('should parse container string params before schema validation and invocation creation', () => {
    const tool = new TestBaseDeclarativeTool({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'integer' } },
      },
      required: ['items'],
    });
    const params = { items: '["1", "2"]' };

    const invocation = tool.build(params);

    expect(invocation.params).toEqual({ items: [1, 2] });
    expect(params).toEqual({ items: [1, 2] });
  });

  it('should leave invalid scalar number strings for AJV to reject', () => {
    const tool = new TestBaseDeclarativeTool({
      type: 'object',
      properties: {
        count: { type: 'number' },
      },
      required: ['count'],
    });

    expect(() => tool.build({ count: '1abc' })).toThrow(
      'params/count must be number',
    );
  });

  it('reports schema diagnostics from the original shape before container coercion', () => {
    const tool = new TestBaseDeclarativeTool({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'number' } },
      },
      required: ['items'],
    });
    const rawSecret = '{"privateValue":1}';

    let thrown: unknown;
    try {
      tool.build({ items: rawSecret });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const diagnosticData = (thrown as Error & {
      data?: Record<string, unknown>;
    }).data;
    expect(diagnosticData).toMatchObject({
      tool_error_stage: 'parameter_validation',
      tool_error_subtype: 'json_schema',
    });
    const details = JSON.parse(
      diagnosticData?.['tool_error_details_json'] as string,
    );
    expect(details).toEqual({
      schema_version: 1,
      validation_source: 'json_schema',
      parameter_path: 'params.items',
      validation_keyword: 'type',
      expected_type: 'array',
      actual_type: 'string',
      actual_shape_bucket: 'string_json_object',
      constraint_category: 'type',
      quality: 'precise',
      validation_phase: 'build',
    });
    expect(JSON.stringify(diagnosticData)).not.toContain(rawSecret);
    expect(JSON.stringify(diagnosticData)).not.toContain('privateValue');
  });

  it('normalizes numeric schema paths without including invalid values', () => {
    const tool = new TestBaseDeclarativeTool({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { count: { type: 'number' } },
            required: ['count'],
          },
        },
      },
      required: ['items'],
    });
    const rawSecret = 'not-a-number-private';

    let thrown: unknown;
    try {
      tool.build({ items: [{ count: 1 }, { count: rawSecret }] });
    } catch (error) {
      thrown = error;
    }

    const diagnosticData = (thrown as Error & {
      data?: Record<string, unknown>;
    }).data;
    const details = JSON.parse(
      diagnosticData?.['tool_error_details_json'] as string,
    );
    expect(details.parameter_path).toBe('params.items[].count');
    expect(JSON.stringify(diagnosticData)).not.toContain(rawSecret);
  });

  it('derives the expected type for a missing required property', () => {
    const tool = new TestBaseDeclarativeTool({
      type: 'object',
      properties: { items: { type: 'array' } },
      required: ['items'],
    });

    let thrown: unknown;
    try {
      tool.build({});
    } catch (error) {
      thrown = error;
    }

    const data = (thrown as Error & { data: Record<string, unknown> }).data;
    expect(JSON.parse(data['tool_error_details_json'] as string)).toMatchObject({
      parameter_path: 'params.items',
      validation_keyword: 'required',
      expected_type: 'array',
      actual_type: 'missing',
      actual_shape_bucket: 'missing',
    });
  });
});

describe('tool result type guards', () => {
  it('does not classify GlobResult as GrepResult', () => {
    const globResult = {
      durationMs: 1,
      numFiles: 1,
      filenames: ['src/a.ts'],
      truncated: false,
    };

    expect(isGlobResult(globResult)).toBe(true);
    expect(isGrepResult(globResult)).toBe(false);
  });

  it('classifies current and legacy GrepResult shapes', () => {
    expect(
      isGrepResult({
        mode: 'files_with_matches',
        numFiles: 1,
        filenames: ['src/a.ts'],
      }),
    ).toBe(true);

    expect(
      isGrepResult({
        summary: 'Found 1 match',
        matches: [
          {
            filePath: 'src/a.ts',
            absolutePath: '/workspace/src/a.ts',
            lineNumber: 1,
            line: 'match',
          },
        ],
      }),
    ).toBe(true);
  });
});

describe('hasCycleInSchema', () => {
  it('should detect a simple direct cycle', () => {
    const schema = {
      properties: {
        data: {
          $ref: '#/properties/data',
        },
      },
    };
    expect(hasCycleInSchema(schema)).toBe(true);
  });

  it('should detect a cycle from object properties referencing parent properties', () => {
    const schema = {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            child: { $ref: '#/properties/data' },
          },
        },
      },
    };
    expect(hasCycleInSchema(schema)).toBe(true);
  });

  it('should detect a cycle from array items referencing parent properties', () => {
    const schema = {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              child: { $ref: '#/properties/data/items' },
            },
          },
        },
      },
    };
    expect(hasCycleInSchema(schema)).toBe(true);
  });

  it('should detect a cycle between sibling properties', () => {
    const schema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            child: { $ref: '#/properties/b' },
          },
        },
        b: {
          type: 'object',
          properties: {
            child: { $ref: '#/properties/a' },
          },
        },
      },
    };
    expect(hasCycleInSchema(schema)).toBe(true);
  });

  it('should not detect a cycle in a valid schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { $ref: '#/definitions/address' },
      },
      definitions: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    };
    expect(hasCycleInSchema(schema)).toBe(false);
  });

  it('should handle non-cyclic sibling refs', () => {
    const schema = {
      properties: {
        a: { $ref: '#/definitions/stringDef' },
        b: { $ref: '#/definitions/stringDef' },
      },
      definitions: {
        stringDef: { type: 'string' },
      },
    };
    expect(hasCycleInSchema(schema)).toBe(false);
  });

  it('should handle nested but not cyclic refs', () => {
    const schema = {
      properties: {
        a: { $ref: '#/definitions/defA' },
      },
      definitions: {
        defA: { properties: { b: { $ref: '#/definitions/defB' } } },
        defB: { type: 'string' },
      },
    };
    expect(hasCycleInSchema(schema)).toBe(false);
  });

  it('should return false for an empty schema', () => {
    expect(hasCycleInSchema({})).toBe(false);
  });
});

describe('Tools Read-Only property', () => {
  it('should have isReadOnly true for ReadFileTool', () => {
    const config = makeFakeConfig();
    const tool = new ReadFileTool(config);
    expect(tool.isReadOnly).toBe(true);
  });

  it('should derive isReadOnly from Kind', () => {
    class MyTool extends DeclarativeTool<object, ToolResult> {
      build(_params: object): ToolInvocation<object, ToolResult> {
        throw new Error('Not implemented');
      }
    }

    const mutator = new MyTool('m', 'M', 'd', Kind.Edit, {});
    expect(mutator.isReadOnly).toBe(false);

    const reader = new MyTool('r', 'R', 'd', Kind.Read, {});
    expect(reader.isReadOnly).toBe(true);

    const searcher = new MyTool('s', 'S', 'd', Kind.Search, {});
    expect(searcher.isReadOnly).toBe(true);
  });
});

describe('toJSON serialization', () => {
  it('DeclarativeTool.toJSON should return essential metadata', () => {
    class MyTool extends DeclarativeTool<object, ToolResult> {
      build(_params: object): ToolInvocation<object, ToolResult> {
        throw new Error('Not implemented');
      }
    }
    const tool = new MyTool('name', 'display', 'desc', Kind.Read, {
      type: 'object',
    });
    const json = tool.toJSON();

    expect(json).toEqual({
      name: 'name',
      displayName: 'display',
      description: 'desc',
      kind: Kind.Read,
      parameterSchema: { type: 'object' },
    });
    expect(JSON.stringify(tool)).toContain('"name":"name"');
  });

  it('BaseToolInvocation.toJSON should return only params', () => {
    const params = { foo: 'bar' };
    class MyInvocation extends BaseToolInvocation<object, ToolResult> {
      getDescription() {
        return 'desc';
      }
      async execute() {
        return { llmContent: '', returnDisplay: '' };
      }
    }
    const invocation = new MyInvocation(params, 'tool');
    const json = invocation.toJSON();

    expect(json).toEqual({ params });
    expect(JSON.stringify(invocation)).toBe('{"params":{"foo":"bar"}}');
  });
});
