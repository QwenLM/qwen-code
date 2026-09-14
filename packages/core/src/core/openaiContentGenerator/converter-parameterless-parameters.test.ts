/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Tool } from '@google/genai';
import type { Config } from '../../config/config.js';
import { ListAgentsTool } from '../../tools/list-agents.js';
import { convertLlmToolsToOpenAI } from './converter.js';

/**
 * A zero-argument tool's `parameters` key is contested on the wire:
 *
 * - llama.cpp cannot compile a grammar over an empty `properties` map (#10080)
 *   and strict OpenAI-contract validators such as LM Studio reject
 *   `parameters: {"type":"object"}` without `properties` (#11410), which is why
 *   #11431 made omitting the key the default;
 * - MiniMax rejects the omission itself — a request carrying the
 *   always-registered `list_agents` answers `400 invalid params, function
 *   parameters is empty (2013)` before the model is even reached (#11834).
 *
 * There is no single shape both accept, so the omission stays the default and
 * the MiniMax routing opts out. Every assertion here is made on the
 * *serialized* body: the defect is `JSON.stringify` dropping the key, so an
 * assertion on the returned object could pass while the wire still omits it.
 */
describe('convertLlmToolsToOpenAI parameterless `parameters` (#11834)', () => {
  /**
   * The declaration from the report, taken from the real tool rather than a
   * hand-written copy of its schema. `list_agents` is registered
   * unconditionally, so every default interactive request carries it — which
   * is why a bare greeting fails with no tool call in the conversation yet.
   */
  function listAgentsTools(): Tool[] {
    const declaration = new ListAgentsTool({} as Config).schema;
    return [{ functionDeclarations: [declaration] }] as Tool[];
  }

  function wire(tools: unknown): string {
    return JSON.stringify(tools);
  }

  it('keeps an explicit empty `parameters` object when the routing opts out', async () => {
    const result = await convertLlmToolsToOpenAI(listAgentsTools(), 'auto', {
      keepParameterlessParameters: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe('list_agents');
    expect(wire(result)).toContain(
      '"parameters":{"type":"object","properties":{}}',
    );
    expect(result[0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('still omits `parameters` by default', async () => {
    const result = await convertLlmToolsToOpenAI(listAgentsTools());

    expect(wire(result)).not.toContain('parameters');
    expect(result[0].function.parameters).toBeUndefined();
  });

  it('still omits `parameters` when the opt-out is explicitly disabled', async () => {
    const result = await convertLlmToolsToOpenAI(listAgentsTools(), 'auto', {
      keepParameterlessParameters: false,
    });

    expect(wire(result)).not.toContain('parameters');
    expect(result[0].function.parameters).toBeUndefined();
  });

  it('gates an MCP-style zero-argument tool the same way', async () => {
    // An MCP server that declares no input schema reaches the converter as
    // this default shape.
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'mcp_ping',
            description: 'No arguments',
            parametersJsonSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ] as Tool[];

    const kept = await convertLlmToolsToOpenAI(tools, 'auto', {
      keepParameterlessParameters: true,
    });
    expect(wire(kept)).toContain(
      '"parameters":{"type":"object","properties":{}}',
    );

    const omitted = await convertLlmToolsToOpenAI(tools);
    expect(wire(omitted)).not.toContain('parameters');
  });

  it('leaves a tool that declares arguments identical on both paths', async () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Reads a file',
            parametersJsonSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
    ] as Tool[];

    const kept = await convertLlmToolsToOpenAI(tools, 'auto', {
      keepParameterlessParameters: true,
    });
    const omitted = await convertLlmToolsToOpenAI(tools);

    expect(kept).toEqual(omitted);
    expect(wire(kept)).toContain('"path"');
  });

  it('does not synthesise `parameters` for a declaration that never carried a schema', async () => {
    // No registration path produces this — tools always expose
    // `parametersJsonSchema`, and an MCP tool without an input schema gets an
    // empty object one — so the opt-out deliberately stops at undoing the
    // omission #11431 introduced.
    const tools = [
      {
        functionDeclarations: [{ name: 'bare', description: 'No schema' }],
      },
    ] as Tool[];

    const result = await convertLlmToolsToOpenAI(tools, 'auto', {
      keepParameterlessParameters: true,
    });

    expect(result[0].function.parameters).toBeUndefined();
    expect(wire(result)).not.toContain('parameters');
  });
});
