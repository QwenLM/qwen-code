/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '../config/config.js';
import type {
  LspCallHierarchyItem,
  LspLocation,
  LspSymbolInformation,
} from '../lsp/types.js';
import { LspTool, type LspToolParams, type LspOperation } from './lsp.js';

const abortSignal = new AbortController().signal;
const workspaceRoot = '/test/workspace';

const resolvePath = (...segments: string[]) =>
  path.join(workspaceRoot, ...segments);
const toUri = (filePath: string) => pathToFileURL(filePath).toString();
const appPath = resolvePath('src', 'app.ts');

const lineSpan = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});
/** Zero-width location at the given 0-based position. */
const createLocation = (
  filePath: string,
  line: number,
  character: number,
): LspLocation => ({
  uri: toUri(filePath),
  range: lineSpan(line, character, character),
});
/** Symbol in src/app.ts at 0-based line:0. */
const symbol = (
  name: string,
  kind: string,
  line: number,
  extra: Partial<LspSymbolInformation> = {},
): LspSymbolInformation => ({
  name,
  kind,
  location: createLocation(appPath, line, 0),
  ...extra,
});
/** Item in src/<file> spanning lines start..end, named at start:9-19. */
const callItem = (
  name: string,
  file: string,
  start: number,
  end: number,
  extra: Partial<LspCallHierarchyItem> = {},
): LspCallHierarchyItem => ({
  name,
  uri: toUri(resolvePath('src', file)),
  range: {
    start: { line: start, character: 0 },
    end: { line: end, character: 1 },
  },
  selectionRange: lineSpan(start, 9, 19),
  ...extra,
});
const testItem = (): LspCallHierarchyItem => ({
  name: 'testFunc',
  uri: 'file:///test.ts',
  range: lineSpan(0, 0, 10),
  selectionRange: lineSpan(0, 0, 10),
});

/** LspClient whose methods are all mocks resolving to empty results. */
const createMockClient = () => ({
  workspaceSymbols: vi.fn().mockResolvedValue([]),
  hover: vi.fn().mockResolvedValue(null),
  documentSymbols: vi.fn().mockResolvedValue([]),
  definitions: vi.fn().mockResolvedValue([]),
  implementations: vi.fn().mockResolvedValue([]),
  references: vi.fn().mockResolvedValue([]),
  prepareCallHierarchy: vi.fn().mockResolvedValue([]),
  incomingCalls: vi.fn().mockResolvedValue([]),
  outgoingCalls: vi.fn().mockResolvedValue([]),
});
type MockClient = ReturnType<typeof createMockClient>;

const createTool = (client?: MockClient, enabled = true) =>
  new LspTool({
    getLspClient: () => client,
    isLspEnabled: () => enabled,
    getProjectRoot: () => workspaceRoot,
  } as unknown as Config);

/** Location params: src/app.ts at 1-based 5:10 unless overridden. */
const at = (
  operation: LspOperation,
  extra: Partial<LspToolParams> = {},
): LspToolParams => ({
  operation,
  filePath: 'src/app.ts',
  line: 5,
  character: 10,
  ...extra,
});
const hoverParams = () => at('hover', { line: 10, character: 5 });

/** Fresh client, optional mock setup, then one execute. */
const run = async (
  params: LspToolParams,
  configure?: (client: MockClient) => void,
) => {
  const client = createMockClient();
  configure?.(client);
  const result = await createTool(client).build(params).execute(abortSignal);
  return { client, result };
};
const expectContains = (text: unknown, ...parts: string[]) => {
  for (const part of parts) expect(text).toContain(part);
};

describe('LspTool', () => {
  describe('validateToolParams', () => {
    let tool: LspTool;

    beforeEach(() => {
      tool = createTool();
    });

    const validate = (params: Partial<LspToolParams>) =>
      tool.validateToolParams(params as LspToolParams);
    /** One test per [title, params, expected error or null] row. */
    const cases = (
      rows: Array<[string, Partial<LspToolParams>, string | null]>,
    ) =>
      it.each(rows)('%s', (_title, params, expected) => {
        expect(validate(params)).toBe(expected);
      });

    describe('location-based operations', () => {
      const locationOperations: LspOperation[] = [
        'goToDefinition',
        'findReferences',
        'hover',
        'goToImplementation',
        'prepareCallHierarchy',
      ];

      it.each(locationOperations)(
        'requires filePath for %s operation',
        (operation) => {
          expect(validate({ operation })).toBe(
            `filePath is required for ${operation}.`,
          );
        },
      );

      it.each(locationOperations)(
        'requires line for %s operation',
        (operation) => {
          expect(validate({ operation, filePath: 'src/app.ts' })).toBe(
            `line is required for ${operation}.`,
          );
        },
      );

      it.each(locationOperations)(
        'passes validation with valid params for %s',
        (operation) => {
          expect(
            validate({
              operation,
              filePath: 'src/app.ts',
              line: 10,
              character: 5,
            }),
          ).toBeNull();
        },
      );
    });

    describe('documentSymbol operation', () => {
      cases([
        [
          'requires filePath for documentSymbol',
          { operation: 'documentSymbol' },
          'filePath is required for documentSymbol.',
        ],
        [
          'passes validation with filePath',
          { operation: 'documentSymbol', filePath: 'src/app.ts' },
          null,
        ],
      ]);
    });

    describe('workspaceSymbol operation', () => {
      cases([
        [
          'requires query for workspaceSymbol',
          { operation: 'workspaceSymbol' },
          'query is required for workspaceSymbol.',
        ],
        [
          'rejects empty query',
          { operation: 'workspaceSymbol', query: '   ' },
          'query is required for workspaceSymbol.',
        ],
        [
          'passes validation with query',
          { operation: 'workspaceSymbol', query: 'Widget' },
          null,
        ],
      ]);
    });

    describe('call hierarchy operations', () => {
      cases([
        [
          'requires callHierarchyItem for incomingCalls',
          { operation: 'incomingCalls' },
          'callHierarchyItem is required for incomingCalls.',
        ],
        [
          'requires callHierarchyItem for outgoingCalls',
          { operation: 'outgoingCalls' },
          'callHierarchyItem is required for outgoingCalls.',
        ],
        [
          'passes validation with callHierarchyItem',
          { operation: 'incomingCalls', callHierarchyItem: testItem() },
          null,
        ],
      ]);
    });

    describe('numeric parameter validation', () => {
      const def = (extra: Partial<LspToolParams>) => ({
        operation: 'goToDefinition' as const,
        filePath: 'src/app.ts',
        ...extra,
      });
      const docs = (limit: number) => ({
        operation: 'documentSymbol' as const,
        filePath: 'src/app.ts',
        limit,
      });
      const lineError = 'line must be a positive number.';
      cases([
        ['rejects non-positive line', def({ line: 0 }), lineError],
        ['rejects negative line', def({ line: -1 }), lineError],
        [
          'rejects non-positive character',
          def({ line: 1, character: 0 }),
          'character must be a positive number.',
        ],
        ['rejects non-positive limit', docs(0), 'params/limit must be >= 1'],
        [
          'rejects negative integer limit',
          docs(-1),
          'params/limit must be >= 1',
        ],
        ['rejects fractional limit', docs(1.5), 'params/limit must be integer'],
      ]);
    });

    describe('edge case validation', () => {
      cases([
        [
          'rejects empty filePath',
          { operation: 'goToDefinition', filePath: '', line: 1 },
          'filePath is required for goToDefinition.',
        ],
        [
          'rejects whitespace-only filePath',
          { operation: 'goToDefinition', filePath: '   ', line: 1 },
          'filePath is required for goToDefinition.',
        ],
        [
          'rejects whitespace-only query',
          { operation: 'workspaceSymbol', query: '  \t\n  ' },
          'query is required for workspaceSymbol.',
        ],
      ]);

      it.skipIf(process.platform === 'win32')(
        'should unescape shell-escaped filePath',
        () => {
          const params = at('goToDefinition', {
            filePath: 'src/app\\ file.ts',
            line: 10,
            character: 5,
          });
          expect(tool.validateToolParams(params)).toBeNull();
          expect(params.filePath).toBe('src/app file.ts');
        },
      );
    });
  });

  describe('execute', () => {
    describe('LSP disabled or unavailable', () => {
      it('returns unavailable message when LSP is disabled', async () => {
        const result = await createTool(undefined, false)
          .build(at('hover', { line: 1, character: 1 }))
          .execute(abortSignal);
        expectContains(
          result.llmContent,
          'LSP hover is unavailable',
          'LSP disabled or not initialized',
        );
      });

      it('returns unavailable message when no LSP client', async () => {
        const result = await createTool(undefined, true)
          .build(at('goToDefinition', { line: 1, character: 1 }))
          .execute(abortSignal);
        // Note: operation labels are formatted (e.g., "go-to-definition")
        expect(result.llmContent).toContain(
          'LSP go-to-definition is unavailable',
        );
      });
    });

    describe('goToDefinition operation', () => {
      it('dispatches to definitions and formats results', async () => {
        const { client, result } = await run(at('goToDefinition'), (c) =>
          c.definitions.mockResolvedValue([
            { ...createLocation(appPath, 10, 5), serverName: 'tsserver' },
          ]),
        );

        expect(client.definitions).toHaveBeenCalledWith(
          expect.objectContaining({
            uri: toUri(appPath),
            range: expect.objectContaining({
              start: { line: 4, character: 9 }, // 1-based to 0-based conversion
            }),
          }),
          undefined,
          20,
        );
        expectContains(result.llmContent, 'Definitions for', '1.');
      });

      it('handles empty results', async () => {
        const { result } = await run(at('goToDefinition'), (c) =>
          c.definitions.mockResolvedValue([]),
        );
        expect(result.llmContent).toContain('No definitions found');
      });
    });

    describe('findReferences operation', () => {
      it('dispatches to references and formats results', async () => {
        const { client, result } = await run(
          at('findReferences', { includeDeclaration: true }),
          (c) =>
            c.references.mockResolvedValue([
              { ...createLocation(appPath, 10, 5), serverName: 'tsserver' },
              createLocation(appPath, 20, 8),
            ]),
        );

        // Default limit for references is 50
        expect(client.references).toHaveBeenCalledWith(
          expect.objectContaining({ uri: toUri(appPath) }),
          undefined,
          true,
          50,
        );
        expectContains(result.llmContent, 'References for', '1.', '2.');
      });
    });

    describe('hover operation', () => {
      it('dispatches to hover and formats results', async () => {
        const { client, result } = await run(hoverParams(), (c) =>
          c.hover.mockResolvedValue({
            contents: '**Type**: string\n\nA sample variable.',
          }),
        );
        expect(client.hover).toHaveBeenCalled();
        expectContains(result.llmContent, 'Hover for', 'Type');
      });

      it('handles null hover result', async () => {
        const { result } = await run(hoverParams(), (c) =>
          c.hover.mockResolvedValue(null),
        );
        expect(result.llmContent).toContain('No hover information found');
      });
    });

    describe('documentSymbol operation', () => {
      it('dispatches to documentSymbols and formats results', async () => {
        const { client, result } = await run(
          { operation: 'documentSymbol', filePath: 'src/app.ts' },
          (c) =>
            c.documentSymbols.mockResolvedValue([
              symbol('MyClass', 'Class', 5, {
                containerName: 'app',
                serverName: 'tsserver',
              }),
              symbol('myFunction', 'Function', 20),
            ]),
        );

        // Default limit for documentSymbols is 50
        expect(client.documentSymbols).toHaveBeenCalledWith(
          toUri(appPath),
          undefined,
          50,
        );
        expectContains(
          result.llmContent,
          'Document symbols for',
          'MyClass',
          'myFunction',
        );
      });
    });

    describe('workspaceSymbol operation', () => {
      it('dispatches to workspaceSymbols and formats results', async () => {
        const { client, result } = await run(
          { operation: 'workspaceSymbol', query: 'Widget', limit: 10 },
          (c) => {
            c.workspaceSymbols.mockResolvedValue([
              symbol('Widget', 'Class', 10),
            ]);
            c.references.mockResolvedValue([]);
          },
        );

        expect(client.workspaceSymbols).toHaveBeenCalledWith('Widget', 10);
        expectContains(
          result.llmContent,
          'symbols for query "Widget"',
          'Widget',
        );
      });
    });

    describe('goToImplementation operation', () => {
      it('dispatches to implementations and formats results', async () => {
        const implPath = resolvePath('src', 'impl.ts');
        const { client, result } = await run(
          at('goToImplementation', { filePath: 'src/interface.ts' }),
          (c) =>
            c.implementations.mockResolvedValue([
              { ...createLocation(implPath, 15, 2), serverName: 'tsserver' },
            ]),
        );

        expect(client.implementations).toHaveBeenCalled();
        expect(result.llmContent).toContain('Implementations for');
      });
    });

    describe('prepareCallHierarchy operation', () => {
      it('dispatches to prepareCallHierarchy and formats results with JSON', async () => {
        const item = callItem('myFunction', 'app.ts', 10, 20, {
          kind: 'Function',
          detail: '(param: string)',
          serverName: 'tsserver',
        });
        const { client, result } = await run(
          at('prepareCallHierarchy', { line: 11, character: 15 }),
          (c) => c.prepareCallHierarchy.mockResolvedValue([item]),
        );

        expect(client.prepareCallHierarchy).toHaveBeenCalled();
        expectContains(
          result.llmContent,
          'Call hierarchy items for',
          'myFunction',
          'Call hierarchy items (JSON):',
          '"name": "myFunction"',
        );
      });
    });

    describe('incomingCalls operation', () => {
      it('dispatches to incomingCalls and formats results', async () => {
        const targetItem = callItem('targetFunc', 'target.ts', 5, 10, {
          serverName: 'tsserver',
        });
        const callerItem = callItem('callerFunc', 'caller.ts', 20, 30, {
          kind: 'Function',
        });
        const { client, result } = await run(
          { operation: 'incomingCalls', callHierarchyItem: targetItem },
          (c) =>
            c.incomingCalls.mockResolvedValue([
              { from: callerItem, fromRanges: [lineSpan(25, 4, 14)] },
            ]),
        );

        expect(client.incomingCalls).toHaveBeenCalledWith(
          targetItem,
          'tsserver',
          20,
        );
        expectContains(
          result.llmContent,
          'Incoming calls for targetFunc',
          'callerFunc',
          'Incoming calls (JSON):',
        );
      });
    });

    describe('outgoingCalls operation', () => {
      it('dispatches to outgoingCalls and formats results', async () => {
        const sourceItem = callItem('sourceFunc', 'source.ts', 5, 15);
        const targetItem = callItem('targetFunc', 'target.ts', 20, 30, {
          kind: 'Function',
          serverName: 'tsserver',
        });
        const { client, result } = await run(
          { operation: 'outgoingCalls', callHierarchyItem: sourceItem },
          (c) =>
            c.outgoingCalls.mockResolvedValue([
              { to: targetItem, fromRanges: [lineSpan(10, 4, 14)] },
            ]),
        );

        expect(client.outgoingCalls).toHaveBeenCalled();
        expectContains(
          result.llmContent,
          'Outgoing calls for sourceFunc',
          'targetFunc',
          'Outgoing calls (JSON):',
        );
      });
    });

    describe('error handling', () => {
      it.each([
        [
          'handles LSP client errors gracefully',
          'definitions',
          'goToDefinition',
          'Connection refused',
        ],
        ['handles hover operation errors', 'hover', 'hover', 'Server timeout'],
        [
          'handles call hierarchy errors',
          'prepareCallHierarchy',
          'prepareCallHierarchy',
          'Not supported',
        ],
      ] as const)('%s', async (_title, method, operation, message) => {
        const { result } = await run(at(operation), (c) =>
          c[method].mockRejectedValue(new Error(message)),
        );
        expectContains(result.llmContent, 'failed', message);
      });
    });

    describe('workspaceSymbol with references', () => {
      it('fetches references for top match when available', async () => {
        const refPath = resolvePath('src', 'other.ts');
        const top = symbol('TopWidget', 'Class', 10, {
          serverName: 'tsserver',
        });
        const { client, result } = await run(
          { operation: 'workspaceSymbol', query: 'TopWidget' },
          (c) => {
            c.workspaceSymbols.mockResolvedValue([top]);
            c.references.mockResolvedValue([
              { ...createLocation(refPath, 5, 10), serverName: 'tsserver' },
              createLocation(refPath, 20, 5),
            ]);
          },
        );

        // Should fetch references for top match
        expect(client.references).toHaveBeenCalledWith(
          top.location,
          'tsserver',
          false,
          expect.any(Number),
        );
        expectContains(
          result.llmContent,
          'References for top match',
          'TopWidget',
        );
      });

      it('handles reference lookup failure gracefully', async () => {
        const { result } = await run(
          { operation: 'workspaceSymbol', query: 'Widget' },
          (c) => {
            c.workspaceSymbols.mockResolvedValue([
              symbol('Widget', 'Class', 10),
            ]);
            c.references.mockRejectedValue(
              new Error('References not supported'),
            );
          },
        );

        // Should still return symbols even if references fail
        expectContains(result.llmContent, 'Widget', 'References lookup failed');
      });
    });

    describe('returnDisplay verification', () => {
      it('returns formatted display for definitions', async () => {
        const { result } = await run(at('goToDefinition'), (c) =>
          c.definitions.mockResolvedValue([
            { ...createLocation(appPath, 10, 5), serverName: 'tsserver' },
          ]),
        );

        // returnDisplay should be concise (without heading)
        expect(result.returnDisplay).toBeDefined();
        expectContains(result.returnDisplay, '1.', '[tsserver]');
      });

      it('returns formatted display for hover with trimmed content', async () => {
        const { result } = await run(hoverParams(), (c) =>
          c.hover.mockResolvedValue({ contents: '  \n  Type: string  \n  ' }),
        );
        // returnDisplay should be trimmed
        expect(result.returnDisplay).toBe('Type: string');
      });
    });

    describe('serverName and limit parameter passing', () => {
      it.each([
        [
          'passes serverName to client methods',
          { serverName: 'pylsp' },
          'pylsp',
          expect.any(Number),
        ],
        ['passes custom limit to client methods', { limit: 5 }, undefined, 5],
      ])('%s', async (_title, extra, serverName, limit) => {
        const { client } = await run(at('goToDefinition', extra), (c) =>
          c.definitions.mockResolvedValue([]),
        );
        expect(client.definitions).toHaveBeenCalledWith(
          expect.anything(),
          serverName,
          limit,
        );
      });
    });
  });

  describe('schema compatibility with Claude Code', () => {
    // Reference: Claude Code's LSP tool is named "lsp" and its input_schema is
    // an object whose only required field is "operation" (string enum), with
    // filePath (string), line and character (number), includeDeclaration
    // (boolean), query (string) and callHierarchyItem.
    type SchemaNode = {
      type?: string;
      minimum?: number;
      $ref?: string;
      enum?: string[];
      required?: string[];
      properties?: { [K in SchemaProp]?: SchemaNode };
      definitions?: {
        [K in 'LspCallHierarchyItem' | 'LspPosition' | 'LspRange']?: SchemaNode;
      };
    };
    type SchemaProp =
      | 'operation'
      | 'filePath'
      | 'line'
      | 'character'
      | 'limit'
      | 'includeDeclaration'
      | 'callHierarchyItem'
      | 'rawKind'
      | 'start'
      | 'end'
      | 'range'
      | 'selectionRange';
    const schema = () => createTool().schema.parametersJsonSchema as SchemaNode;
    // Core properties that must match Claude Code
    const coreProperties = [
      'operation',
      'filePath',
      'line',
      'character',
      'includeDeclaration',
      'query',
      'callHierarchyItem',
    ];

    it('has correct tool name', () => {
      expect(createTool().schema.name).toBe('lsp');
    });

    it('has operation as only required field', () => {
      expect(schema().required).toEqual(['operation']);
    });

    it('operation enum matches Claude Code exactly', () => {
      expect(schema().properties?.operation?.enum).toEqual([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
        'diagnostics',
        'workspaceDiagnostics',
        'codeActions',
      ]);
    });

    it('has all Claude Code core properties', () => {
      const properties = Object.keys(schema().properties ?? {});
      for (const prop of coreProperties) {
        expect(properties).toContain(prop);
      }
    });

    it('extension properties are documented', () => {
      // Every property is either core or one of our documented extensions.
      const knownProperties = [
        ...coreProperties,
        'serverName',
        'limit',
        'endLine',
        'endCharacter',
        'diagnostics',
        'codeActionKinds',
      ];
      for (const prop of Object.keys(schema().properties ?? {})) {
        expect(knownProperties).toContain(prop);
      }
    });

    it('filePath property has correct type', () => {
      expect(schema().properties?.filePath?.type).toBe('string');
    });

    it('line and character properties have correct type', () => {
      const { properties } = schema();
      expect(properties?.line?.type).toBe('number');
      expect(properties?.character?.type).toBe('number');
    });

    it('limit extension property has integer type', () => {
      const limit = schema().properties?.limit;
      expect(limit?.type).toBe('integer');
      expect(limit?.minimum).toBe(1);
    });

    it('includeDeclaration property has correct type', () => {
      expect(schema().properties?.includeDeclaration?.type).toBe('boolean');
    });

    it('callHierarchyItem has required structure', () => {
      const itemDef = schema().definitions?.LspCallHierarchyItem;
      expect(itemDef?.type).toBe('object');
      expect(itemDef?.required).toEqual([
        'name',
        'uri',
        'range',
        'selectionRange',
      ]);
      for (const prop of ['name', 'kind', 'uri', 'range', 'selectionRange']) {
        expect(itemDef?.properties).toHaveProperty(prop);
      }
    });

    it('supports rawKind for SymbolKind numeric preservation', () => {
      const itemDef = schema().definitions?.LspCallHierarchyItem;
      expect(itemDef?.properties?.rawKind?.type).toBe('number');
    });

    describe('schema definitions deep validation', () => {
      it('has LspPosition definition with correct structure', () => {
        const posDef = schema().definitions?.LspPosition;
        expect(posDef).toBeDefined();
        expect(posDef?.type).toBe('object');
        expect(posDef?.properties?.line?.type).toBe('number');
        expect(posDef?.properties?.character?.type).toBe('number');
        expect(posDef?.required).toEqual(['line', 'character']);
      });

      it('has LspRange definition with correct structure', () => {
        const rangeDef = schema().definitions?.LspRange;
        expect(rangeDef).toBeDefined();
        expect(rangeDef?.type).toBe('object');
        expect(rangeDef?.properties?.start?.$ref).toBe(
          '#/definitions/LspPosition',
        );
        expect(rangeDef?.properties?.end?.$ref).toBe(
          '#/definitions/LspPosition',
        );
        expect(rangeDef?.required).toEqual(['start', 'end']);
      });

      it('callHierarchyItem uses $ref for range fields', () => {
        const { properties, definitions } = schema();
        // callHierarchyItem property should reference the definition
        expect(properties?.callHierarchyItem?.$ref).toBe(
          '#/definitions/LspCallHierarchyItem',
        );
        // range and selectionRange should use LspRange $ref
        const itemDef = definitions?.LspCallHierarchyItem;
        expect(itemDef?.properties?.range?.$ref).toBe('#/definitions/LspRange');
        expect(itemDef?.properties?.selectionRange?.$ref).toBe(
          '#/definitions/LspRange',
        );
      });

      it('all definitions are present and accounted for', () => {
        // Should include at least these definitions
        expect(Object.keys(schema().definitions ?? {})).toEqual(
          expect.arrayContaining([
            'LspCallHierarchyItem',
            'LspDiagnostic',
            'LspPosition',
            'LspRange',
          ]),
        );
      });
    });
  });

  describe('invocation description', () => {
    // Each description uses the formatted operation label
    // ("go-to-definition", "workspace symbol search", "incoming calls").
    it.each<[string, LspToolParams, string[]]>([
      [
        'describes goToDefinition correctly',
        at('goToDefinition', { line: 10, character: 5 }),
        ['go-to-definition', 'src/app.ts:10:5'],
      ],
      [
        'describes workspaceSymbol correctly',
        { operation: 'workspaceSymbol', query: 'Widget' },
        ['workspace symbol search', 'Widget'],
      ],
      [
        'describes incomingCalls correctly',
        { operation: 'incomingCalls', callHierarchyItem: testItem() },
        ['incoming calls', 'testFunc'],
      ],
    ])('%s', (_title, params, parts) => {
      const invocation = createTool().build(params);
      for (const part of parts) {
        expect(invocation.getDescription()).toContain(part);
      }
    });
  });
});
