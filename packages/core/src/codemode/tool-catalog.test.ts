/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { estimateTextTokens } from '../utils/tokenCalculation.js';
import { describe, expect, it } from 'vitest';
import {
  describeProgrammaticContract,
  describeProgrammaticInput,
  describeProgrammaticResult,
  describeProgrammaticTool,
  renderToolCatalog,
  schemaToTs,
  toolAccessor,
} from './tool-catalog.js';

describe('TypeScript tool catalog', () => {
  it('renders common JSON Schema shapes as compact TypeScript', () => {
    expect(
      schemaToTs(
        {
          type: 'object',
          required: ['mode', 'paths'],
          properties: {
            mode: { enum: ['a', 'b'] },
            paths: { type: 'array', items: { type: 'string' } },
            limit: { type: ['integer', 'null'] },
            '-n': { type: 'boolean' },
            nested: {
              type: 'array',
              items: { type: 'object', properties: { id: { const: 1 } } },
            },
            extra: { type: 'object', additionalProperties: { type: 'number' } },
            either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
        { docs: false },
      ),
    ).toBe(
      [
        '{',
        '  mode: "a" | "b";',
        '  paths: string[];',
        '  limit?: number | null;',
        '  "-n"?: boolean;',
        '  nested?: Array<{',
        '    id?: 1;',
        '  }>;',
        '  extra?: Record<string, number>;',
        '  either?: string | number;',
        '}',
      ].join('\n'),
    );
    expect(schemaToTs({}, { docs: false })).toBe('unknown');
    expect(schemaToTs({ type: 'object' }, { docs: false })).toBe(
      'Record<string, unknown>',
    );
  });

  it('bounds recursion and escapes doc comments', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20; i++)
      schema = { type: 'object', properties: { x: schema } };
    expect(schemaToTs(schema, { docs: false })).toContain('unknown');
    expect(
      schemaToTs(
        {
          type: 'object',
          properties: { a: { type: 'string', description: 'ends */ here' } },
        },
        { docs: true },
      ),
    ).toContain('/** ends *\\/ here */');
  });

  it('bounds the catalog without cutting signatures and advertises omitted tools', () => {
    const small = '  Read(args: { path: string }): Promise<string>;';
    const huge =
      '  Huge(args: { ' +
      'lots: string; '.repeat(2000) +
      '}): Promise<string>;';
    const catalog = renderToolCatalog([huge, small], 150);
    expect(catalog).toContain(small);
    expect(catalog).not.toContain('Huge(args');
    expect(catalog).toContain('Additional tools');
    expect(estimateTextTokens(catalog)).toBeLessThanOrEqual(150);
  });

  it('renders accessors, input repair hints and catalog members', () => {
    const tool = {
      name: 'Read',
      description: 'Read a file.',
      parametersJsonSchema: {
        type: 'object',
        required: ['file_path'],
        properties: { file_path: { type: 'string', description: 'Path.' } },
      },
    };
    const output = {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string' } },
    };
    expect(toolAccessor('Read')).toBe('tools.Read');
    expect(toolAccessor('mcp-x')).toBe('tools["mcp-x"]');
    expect(describeProgrammaticInput(tool)).toBe(
      'tools.Read(args: {\n  file_path: string;\n})',
    );
    expect(describeProgrammaticResult('Read', output)).toBe(
      'CodeMode: tools.Read(args) resolves to { content: string; }.',
    );
    expect(describeProgrammaticTool(tool, output)).toContain(
      'Read a file.\ntools.Read(args: {\n  file_path: string;\n}): Promise<{\n  content: string;\n}>',
    );
    expect(describeProgrammaticResult('mcp-x', output)).toContain(
      'tools["mcp-x"](args)',
    );
    expect(
      renderToolCatalog([describeProgrammaticContract(tool, output, false)]),
    ).toBe(
      'declare const tools: {\n  Read(args: {\n    file_path: string;\n  }): Promise<{\n    content: string;\n  }>;\n};',
    );
    expect(describeProgrammaticContract(tool, output, true)).toContain(
      '  /** Read a file. */\n  Read(args: {\n    /** Path. */\n',
    );
  });

  it('truncates long descriptions but keeps the CodeMode note whole', () => {
    const tool = {
      name: 'Read',
      description: 'Reads files. '.repeat(60),
      parametersJsonSchema: { type: 'object', properties: {} },
    };
    const note = 'Text files only.';
    const comment = describeProgrammaticContract(tool, {}, true, note).split(
      '\n',
    )[0];
    expect(comment).toContain('…');
    expect(comment.endsWith(`${note} */`)).toBe(true);
  });
});
