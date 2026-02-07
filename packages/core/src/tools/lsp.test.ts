/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '../config/config.js';
import type {
  LspCallHierarchyIncomingCall,
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspClient,
  LspDefinition,
  LspHoverResult,
  LspLocation,
  LspReference,
  LspSymbolInformation,
} from '../lsp/types.js';
import { LspTool, type LspToolParams, type LspOperation } from './lsp.js';

const abortSignal = new AbortController().signal;
const workspaceRoot = '/test/workspace';

/**
 * Helper to resolve a path relative to workspace root.
 */
const resolvePath = (...segments: string[]) =>
  path.join(workspaceRoot, ...segments);

/**
 * Helper to convert file path to URI.
 */
const toUri = (filePath: string) => pathToFileURL(filePath).toString();

/**
 * Helper to create a mock LspLocation.
 */
const createLocation = (
  filePath: string,
  line: number,
  character: number,
): LspLocation => ({
  uri: toUri(filePath),
  range: {
    start: { line, character },
    end: { line, character },
  },
});

/**
 * Create a mock LspClient with all methods mocked.
 */
const createMockClient = (): LspClient =>
  ({
    workspaceSymbols: vi.fn().mockResolvedValue([]),
    hover: vi.fn().mockResolvedValue(null),
    documentSymbols: vi.fn().mockResolvedValue([]),
    definitions: vi.fn().mockResolvedValue([]),
    implementations: vi.fn().mockResolvedValue([]),
    references: vi.fn().mockResolvedValue([]),
    prepareCallHierarchy: vi.fn().mockResolvedValue([]),
    incomingCalls: vi.fn().mockResolvedValue([]),
    outgoingCalls: vi.fn().mockResolvedValue([]),
  }) as unknown as LspClient;

/**
 * Create a mock Config for testing.
 */
const createMockConfig = (client?: LspClient, enabled = true): Config =>
  ({
    getLspClient: () => client,
    isLspEnabled: () => enabled,
    getProjectRoot: () => workspaceRoot,
  }) as unknown as Config;

/**
 * Create a LspTool with mock config.
 */
const createTool = (client?: LspClient, enabled = true) =>
  new LspTool(createMockConfig(client, enabled));

describe('LspTool', () => {
  describe('validateToolParams', () => {
    let tool: LspTool;

    beforeEach(() => {
      tool = createTool();
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
          const result = tool.validateToolParams({
            operation,
          } as LspToolParams);
          expect(result).toBe(`filePath is required for ${operation}.`);
        },
      );

      it.each(locationOperations)(
        'requires line for %s operation',
        (operation) => {
          const result = tool.validateToolParams({
            operation,
            filePath: 'src/app.ts',
          } as LspToolParams);
          expect(result).toBe(`line is required for ${operation}.`);
        },
      );

      it.each(locationOperations)(
        'passes validation with valid params for %s',
        (operation) => {
          const result = tool.validateToolParams({
            operation,
            filePath: 'src/app.ts',
            line: 10,
            character: 5,
          } as LspToolParams);
          expect(result).toBeNull();
        },
      );
    });

    describe('documentSymbol operation', () => {
      it('requires filePath for documentSymbol', () => {
        const result = tool.validateToolParams({
          operation: 'documentSymbol',
        } as LspToolParams);
        expect(result).toBe('filePath is required for documentSymbol.');
      });

      it('passes validation with filePath', () => {
        const result = tool.validateToolParams({
          operation: 'documentSymbol',
          filePath: 'src/app.ts',
        } as LspToolParams);
        expect(result).toBeNull();
      });
    });

    describe('workspaceSymbol operation', () => {
      it('requires query for workspaceSymbol', () => {
        const result = tool.validateToolParams({
          operation: 'workspaceSymbol',
        } as LspToolParams);
        expect(result).toBe('query is required for workspaceSymbol.');
      });

      it('rejects empty query', () => {
        const result = tool.validateToolParams({
          operation: 'workspaceSymbol',
          query: '   ',
        } as LspToolParams);
        expect(result).toBe('query is required for workspaceSymbol.');
      });

      it('passes validation with query', () => {
        const result = tool.validateToolParams({
          operation: 'workspaceSymbol',
          query: 'Widget',
        } as LspToolParams);
        expect(result).toBeNull();
      });
    });

    describe('call hierarchy operations', () => {
      it('requires callHierarchyItem for incomingCalls', () => {
        const result = tool.validateToolParams({
          operation: 'incomingCalls',
        } as LspToolParams);
        expect(result).toBe('callHierarchyItem is required for incomingCalls.');
      });

      it('requires callHierarchyItem for outgoingCalls', () => {
        const result = tool.validateToolParams({
          operation: 'outgoingCalls',
        } as LspToolParams);
        expect(result).toBe('callHierarchyItem is required for outgoingCalls.');
      });

      it('passes validation with callHierarchyItem', () => {
        const item: LspCallHierarchyItem = {
          name: 'testFunc',
          uri: 'file:///test.ts',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
        };
        const result = tool.validateToolParams({
          operation: 'incomingCalls',
          callHierarchyItem: item,
        } as LspToolParams);
        expect(result).toBeNull();
      });
    });

    describe('numeric parameter validation', () => {
      it('rejects non-positive line', () => {
        const result = tool.validateToolParams({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 0,
        } as LspToolParams);
        expect(result).toBe('line must be a positive number.');
      });

      it('rejects negative line', () => {
        const result = tool.validateToolParams({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: -1,
        } as LspToolParams);
        expect(result).toBe('line must be a positive number.');
      });

      it('rejects non-positive character', () => {
        const result = tool.validateToolParams({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 1,
          character: 0,
        } as LspToolParams);
        expect(result).toBe('character must be a positive number.');
      });

      it('rejects non-positive limit', () => {
        const result = tool.validateToolParams({
          operation: 'documentSymbol',
          filePath: 'src/app.ts',
          limit: 0,
        } as LspToolParams);
        expect(result).toBe('limit must be a positive number.');
      });
    });

    describe('edge case validation', () => {
      it('rejects empty filePath', () => {
        const result = tool.validateToolParams({
          operation: 'goToDefinition',
          filePath: '',
          line: 1,
        } as LspToolParams);
        expect(result).toBe('filePath is required for goToDefinition.');
      });

      it('rejects whitespace-only filePath', () => {
        const result = tool.validateToolParams({
          operation: 'goToDefinition',
          filePath: '   ',
          line: 1,
        } as LspToolParams);
        expect(result).toBe('filePath is required for goToDefinition.');
      });

      it('rejects whitespace-only query', () => {
        const result = tool.validateToolParams({
          operation: 'workspaceSymbol',
          query: '  \t\n  ',
        } as LspToolParams);
        expect(result).toBe('query is required for workspaceSymbol.');
      });
    });
  });

  describe('execute', () => {
    describe('LSP disabled or unavailable', () => {
      it('returns unavailable message when LSP is disabled', async () => {
        const tool = createTool(undefined, false);
        const invocation = tool.build({
          operation: 'hover',
          filePath: 'src/app.ts',
          line: 1,
          character: 1,
        });
        const result = await invocation.execute(abortSignal);
        expect(result.llmContent).toContain('LSP hover is unavailable');
        expect(result.llmContent).toContain('LSP disabled or not initialized');
      });

      it('returns unavailable message when no LSP client', async () => {
        const tool = createTool(undefined, true);
        const invocation = tool.build({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 1,
          character: 1,
        });
        const result = await invocation.execute(abortSignal);
        // Note: operation labels are formatted (e.g., "go-to-definition")
        expect(result.llmContent).toContain(
          'LSP go-to-definition is unavailable',
        );
      });
    });

    describe('goToDefinition operation', () => {
      it('dispatches to definitions and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const definition: LspDefinition = {
          ...createLocation(filePath, 10, 5),
          serverName: 'tsserver',
        };
        (client.definitions as Mock).mockResolvedValue([definition]);

        const invocation = tool.build({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
        });
        const result = await invocation.execute(abortSignal);

        expect(client.definitions).toHaveBeenCalledWith(
          expect.objectContaining({
            uri: toUri(filePath),
            range: expect.objectContaining({
              start: { line: 4, character: 9 }, // 1-based to 0-based conversion
            }),
          }),
          undefined,
          20,
        );
        expect(result.llmContent).toContain('Definitions for');
        expect(result.llmContent).toContain('1.');
      });

      it('handles empty results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        (client.definitions as Mock).mockResolvedValue([]);

        const invocation = tool.build({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
        });
        const result = await invocation.execute(abortSignal);

        expect(result.llmContent).toContain('No definitions found');
      });
    });

    describe('findReferences operation', () => {
      it('dispatches to references and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const refs: LspReference[] = [
          { ...createLocation(filePath, 10, 5), serverName: 'tsserver' },
          { ...createLocation(filePath, 20, 8) },
        ];
        (client.references as Mock).mockResolvedValue(refs);

        const invocation = tool.build({
          operation: 'findReferences',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
          includeDeclaration: true,
        });
        const result = await invocation.execute(abortSignal);

        // Default limit for references is 50
        expect(client.references).toHaveBeenCalledWith(
          expect.objectContaining({ uri: toUri(filePath) }),
          undefined,
          true,
          50,
        );
        expect(result.llmContent).toContain('References for');
        expect(result.llmContent).toContain('1.');
        expect(result.llmContent).toContain('2.');
      });
    });

    describe('hover operation', () => {
      it('dispatches to hover and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const hoverResult: LspHoverResult = {
          contents: '**Type**: string\n\nA sample variable.',
        };
        (client.hover as Mock).mockResolvedValue(hoverResult);

        const invocation = tool.build({
          operation: 'hover',
          filePath: 'src/app.ts',
          line: 10,
          character: 5,
        });
        const result = await invocation.execute(abortSignal);

        expect(client.hover).toHaveBeenCalled();
        expect(result.llmContent).toContain('Hover for');
        expect(result.llmContent).toContain('Type');
      });

      it('handles null hover result', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        (client.hover as Mock).mockResolvedValue(null);

        const invocation = tool.build({
          operation: 'hover',
          filePath: 'src/app.ts',
          line: 10,
          character: 5,
        });
        const result = await invocation.execute(abortSignal);

        expect(result.llmContent).toContain('No hover information found');
      });
    });

    describe('documentSymbol operation', () => {
      it('dispatches to documentSymbols and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const symbols: LspSymbolInformation[] = [
          {
            name: 'MyClass',
            kind: 'Class',
            containerName: 'app',
            location: createLocation(filePath, 5, 0),
            serverName: 'tsserver',
          },
          {
            name: 'myFunction',
            kind: 'Function',
            location: createLocation(filePath, 20, 0),
          },
        ];
        (client.documentSymbols as Mock).mockResolvedValue(symbols);

        const invocation = tool.build({
          operation: 'documentSymbol',
          filePath: 'src/app.ts',
        });
        const result = await invocation.execute(abortSignal);

        // Default limit for documentSymbols is 50
        expect(client.documentSymbols).toHaveBeenCalledWith(
          toUri(filePath),
          undefined,
          50,
        );
        expect(result.llmContent).toContain('Document symbols for');
        expect(result.llmContent).toContain('MyClass');
        expect(result.llmContent).toContain('myFunction');
      });
    });

    describe('workspaceSymbol operation', () => {
      it('dispatches to workspaceSymbols and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const symbols: LspSymbolInformation[] = [
          {
            name: 'Widget',
            kind: 'Class',
            location: createLocation(filePath, 10, 0),
          },
        ];
        (client.workspaceSymbols as Mock).mockResolvedValue(symbols);
        (client.references as Mock).mockResolvedValue([]);

        const invocation = tool.build({
          operation: 'workspaceSymbol',
          query: 'Widget',
          limit: 10,
        });
        const result = await invocation.execute(abortSignal);

        expect(client.workspaceSymbols).toHaveBeenCalledWith('Widget', 10);
        expect(result.llmContent).toContain('symbols for query "Widget"');
        expect(result.llmContent).toContain('Widget');
      });
    });

    describe('goToImplementation operation', () => {
      it('dispatches to implementations and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'impl.ts');
        const impl: LspDefinition = {
          ...createLocation(filePath, 15, 2),
          serverName: 'tsserver',
        };
        (client.implementations as Mock).mockResolvedValue([impl]);

        const invocation = tool.build({
          operation: 'goToImplementation',
          filePath: 'src/interface.ts',
          line: 5,
          character: 10,
        });
        const result = await invocation.execute(abortSignal);

        expect(client.implementations).toHaveBeenCalled();
        expect(result.llmContent).toContain('Implementations for');
      });
    });

    describe('prepareCallHierarchy operation', () => {
      it('dispatches to prepareCallHierarchy and formats results with JSON', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const item: LspCallHierarchyItem = {
          name: 'myFunction',
          kind: 'Function',
          detail: '(param: string)',
          uri: toUri(filePath),
          range: {
            start: { line: 10, character: 0 },
            end: { line: 20, character: 1 },
          },
          selectionRange: {
            start: { line: 10, character: 9 },
            end: { line: 10, character: 19 },
          },
          serverName: 'tsserver',
        };
        (client.prepareCallHierarchy as Mock).mockResolvedValue([item]);

        const invocation = tool.build({
          operation: 'prepareCallHierarchy',
          filePath: 'src/app.ts',
          line: 11,
          character: 15,
        });
        const result = await invocation.execute(abortSignal);

        expect(client.prepareCallHierarchy).toHaveBeenCalled();
        expect(result.llmContent).toContain('Call hierarchy items for');
        expect(result.llmContent).toContain('myFunction');
        expect(result.llmContent).toContain('Call hierarchy items (JSON):');
        expect(result.llmContent).toContain('"name": "myFunction"');
      });
    });

    describe('incomingCalls operation', () => {
      it('dispatches to incomingCalls and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const targetPath = resolvePath('src', 'target.ts');
        const callerPath = resolvePath('src', 'caller.ts');

        const targetItem: LspCallHierarchyItem = {
          name: 'targetFunc',
          uri: toUri(targetPath),
          range: {
            start: { line: 5, character: 0 },
            end: { line: 10, character: 1 },
          },
          selectionRange: {
            start: { line: 5, character: 9 },
            end: { line: 5, character: 19 },
          },
          serverName: 'tsserver',
        };

        const callerItem: LspCallHierarchyItem = {
          name: 'callerFunc',
          kind: 'Function',
          uri: toUri(callerPath),
          range: {
            start: { line: 20, character: 0 },
            end: { line: 30, character: 1 },
          },
          selectionRange: {
            start: { line: 20, character: 9 },
            end: { line: 20, character: 19 },
          },
        };

        const incomingCall: LspCallHierarchyIncomingCall = {
          from: callerItem,
          fromRanges: [
            {
              start: { line: 25, character: 4 },
              end: { line: 25, character: 14 },
            },
          ],
        };
        (client.incomingCalls as Mock).mockResolvedValue([incomingCall]);

        const invocation = tool.build({
          operation: 'incomingCalls',
          callHierarchyItem: targetItem,
        });
        const result = await invocation.execute(abortSignal);

        expect(client.incomingCalls).toHaveBeenCalledWith(
          targetItem,
          'tsserver',
          20,
        );
        expect(result.llmContent).toContain('Incoming calls for targetFunc');
        expect(result.llmContent).toContain('callerFunc');
        expect(result.llmContent).toContain('Incoming calls (JSON):');
      });
    });

    describe('outgoingCalls operation', () => {
      it('dispatches to outgoingCalls and formats results', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const sourcePath = resolvePath('src', 'source.ts');
        const targetPath = resolvePath('src', 'target.ts');

        const sourceItem: LspCallHierarchyItem = {
          name: 'sourceFunc',
          uri: toUri(sourcePath),
          range: {
            start: { line: 5, character: 0 },
            end: { line: 15, character: 1 },
          },
          selectionRange: {
            start: { line: 5, character: 9 },
            end: { line: 5, character: 19 },
          },
        };

        const targetItem: LspCallHierarchyItem = {
          name: 'targetFunc',
          kind: 'Function',
          uri: toUri(targetPath),
          range: {
            start: { line: 20, character: 0 },
            end: { line: 30, character: 1 },
          },
          selectionRange: {
            start: { line: 20, character: 9 },
            end: { line: 20, character: 19 },
          },
          serverName: 'tsserver',
        };

        const outgoingCall: LspCallHierarchyOutgoingCall = {
          to: targetItem,
          fromRanges: [
            {
              start: { line: 10, character: 4 },
              end: { line: 10, character: 14 },
            },
          ],
        };
        (client.outgoingCalls as Mock).mockResolvedValue([outgoingCall]);

        const invocation = tool.build({
          operation: 'outgoingCalls',
          callHierarchyItem: sourceItem,
        });
        const result = await invocation.execute(abortSignal);

        expect(client.outgoingCalls).toHaveBeenCalled();
        expect(result.llmContent).toContain('Outgoing calls for sourceFunc');
        expect(result.llmContent).toContain('targetFunc');
        expect(result.llmContent).toContain('Outgoing calls (JSON):');
      });
    });

    describe('error handling', () => {
      it('handles LSP client errors gracefully', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        (client.definitions as Mock).mockRejectedValue(
          new Error('Connection refused'),
        );

        const invocation = tool.build({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
        });
        const result = await invocation.execute(abortSignal);

        expect(result.llmContent).toContain('failed');
        expect(result.llmContent).toContain('Connection refused');
      });

      it('handles hover operation errors', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        (client.hover as Mock).mockRejectedValue(new Error('Server timeout'));

        const invocation = tool.build({
          operation: 'hover',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
        });
        const result = await invocation.execute(abortSignal);

        expect(result.llmContent).toContain('failed');
        expect(result.llmContent).toContain('Server timeout');
      });

      it('handles call hierarchy errors', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        (client.prepareCallHierarchy as Mock).mockRejectedValue(
          new Error('Not supported'),
        );

        const invocation = tool.build({
          operation: 'prepareCallHierarchy',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
        });
        const result = await invocation.execute(abortSignal);

        expect(result.llmContent).toContain('failed');
        expect(result.llmContent).toContain('Not supported');
      });
    });

    describe('workspaceSymbol with references', () => {
      it('fetches references for top match when available', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const refPath = resolvePath('src', 'other.ts');
        const symbols: LspSymbolInformation[] = [
          {
            name: 'TopWidget',
            kind: 'Class',
            location: createLocation(filePath, 10, 0),
            serverName: 'tsserver',
          },
        ];
        const references: LspReference[] = [
          { ...createLocation(refPath, 5, 10), serverName: 'tsserver' },
          { ...createLocation(refPath, 20, 5) },
        ];
        (client.workspaceSymbols as Mock).mockResolvedValue(symbols);
        (client.references as Mock).mockResolvedValue(references);

        const invocation = tool.build({
          operation: 'workspaceSymbol',
          query: 'TopWidget',
        });
        const result = await invocation.execute(abortSignal);

        // Should fetch references for top match
        expect(client.references).toHaveBeenCalledWith(
          symbols[0].location,
          'tsserver',
          false,
          expect.any(Number),
        );
        expect(result.llmContent).toContain('References for top match');
        expect(result.llmContent).toContain('TopWidget');
      });

      it('handles reference lookup failure gracefully', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const symbols: LspSymbolInformation[] = [
          {
            name: 'Widget',
            kind: 'Class',
            location: createLocation(filePath, 10, 0),
          },
        ];
        (client.workspaceSymbols as Mock).mockResolvedValue(symbols);
        (client.references as Mock).mockRejectedValue(
          new Error('References not supported'),
        );

        const invocation = tool.build({
          operation: 'workspaceSymbol',
          query: 'Widget',
        });
        const result = await invocation.execute(abortSignal);

        // Should still return symbols even if references fail
        expect(result.llmContent).toContain('Widget');
        expect(result.llmContent).toContain('References lookup failed');
      });
    });

    describe('returnDisplay verification', () => {
      it('returns formatted display for definitions', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const filePath = resolvePath('src', 'app.ts');
        const definition: LspDefinition = {
          ...createLocation(filePath, 10, 5),
          serverName: 'tsserver',
        };
        (client.definitions as Mock).mockResolvedValue([definition]);

        const invocation = tool.build({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
        });
        const result = await invocation.execute(abortSignal);

        // returnDisplay should be concise (without heading)
        expect(result.returnDisplay).toBeDefined();
        expect(result.returnDisplay).toContain('1.');
        expect(result.returnDisplay).toContain('[tsserver]');
      });

      it('returns formatted display for hover with trimmed content', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        const hoverResult: LspHoverResult = {
          contents: '  \n  Type: string  \n  ',
        };
        (client.hover as Mock).mockResolvedValue(hoverResult);

        const invocation = tool.build({
          operation: 'hover',
          filePath: 'src/app.ts',
          line: 10,
          character: 5,
        });
        const result = await invocation.execute(abortSignal);

        // returnDisplay should be trimmed
        expect(result.returnDisplay).toBe('Type: string');
      });
    });

    describe('serverName and limit parameter passing', () => {
      it('passes serverName to client methods', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        (client.definitions as Mock).mockResolvedValue([]);

        const invocation = tool.build({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
          serverName: 'pylsp',
        });
        await invocation.execute(abortSignal);

        expect(client.definitions).toHaveBeenCalledWith(
          expect.anything(),
          'pylsp',
          expect.any(Number),
        );
      });

      it('passes custom limit to client methods', async () => {
        const client = createMockClient();
        const tool = createTool(client);
        (client.definitions as Mock).mockResolvedValue([]);

        const invocation = tool.build({
          operation: 'goToDefinition',
          filePath: 'src/app.ts',
          line: 5,
          character: 10,
          limit: 5,
        });
        await invocation.execute(abortSignal);

        expect(client.definitions).toHaveBeenCalledWith(
          expect.anything(),
          undefined,
          5,
        );
      });
    });
  });

  describe('schema compatibility with Claude Code', () => {
    /**
     * Claude Code LSP tool schema reference:
     * {
     *   "name": "lsp",
     *   "input_schema": {
     *     "type": "object",
     *     "properties": {
     *       "operation": { "type": "string", "enum": [...] },
     *       "filePath": { "type": "string" },
     *       "line": { "type": "number" },
     *       "character": { "type": "number" },
     *       "includeDeclaration": { "type": "boolean" },
     *       "query": { "type": "string" },
     *       "callHierarchyItem": { ... }
     *     },
     *     "required": ["operation"]
     *   }
     * }
     */

    it('has correct tool name', () => {
      const tool = createTool();
      expect(tool.schema.name).toBe('lsp');
    });

    it('has operation as only required field', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        required?: string[];
      };
      expect(schema.required).toEqual(['operation']);
    });

    it('operation enum matches Claude Code exactly', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        properties?: {
          operation?: {
            enum?: string[];
          };
        };
      };
      const expectedOperations = [
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
      ];
      expect(schema.properties?.operation?.enum).toEqual(expectedOperations);
    });

    it('has all Claude Code core properties', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        properties?: Record<string, unknown>;
      };
      const properties = Object.keys(schema.properties ?? {});

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

      for (const prop of coreProperties) {
        expect(properties).toContain(prop);
      }
    });

    it('extension properties are documented', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        properties?: Record<string, unknown>;
      };
      const properties = Object.keys(schema.properties ?? {});

      // Our extensions beyond Claude Code
      const extensionProperties = [
        'serverName',
        'limit',
        'endLine',
        'endCharacter',
        'diagnostics',
        'codeActionKinds',
      ];

      // All properties should be either core or documented extensions
      const knownProperties = [
        'operation',
        'filePath',
        'line',
        'character',
        'includeDeclaration',
        'query',
        'callHierarchyItem',
        ...extensionProperties,
      ];

      for (const prop of properties) {
        expect(knownProperties).toContain(prop);
      }
    });

    it('filePath property has correct type', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        properties?: {
          filePath?: { type?: string };
        };
      };
      expect(schema.properties?.filePath?.type).toBe('string');
    });

    it('line and character properties have correct type', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        properties?: {
          line?: { type?: string };
          character?: { type?: string };
        };
      };
      expect(schema.properties?.line?.type).toBe('number');
      expect(schema.properties?.character?.type).toBe('number');
    });

    it('includeDeclaration property has correct type', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        properties?: {
          includeDeclaration?: { type?: string };
        };
      };
      expect(schema.properties?.includeDeclaration?.type).toBe('boolean');
    });

    it('callHierarchyItem has required structure', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        definitions?: {
          LspCallHierarchyItem?: {
            type?: string;
            properties?: Record<string, unknown>;
            required?: string[];
          };
        };
      };
      const itemDef = schema.definitions?.LspCallHierarchyItem;
      expect(itemDef?.type).toBe('object');
      expect(itemDef?.required).toEqual([
        'name',
        'uri',
        'range',
        'selectionRange',
      ]);
      expect(itemDef?.properties).toHaveProperty('name');
      expect(itemDef?.properties).toHaveProperty('kind');
      expect(itemDef?.properties).toHaveProperty('uri');
      expect(itemDef?.properties).toHaveProperty('range');
      expect(itemDef?.properties).toHaveProperty('selectionRange');
    });

    it('supports rawKind for SymbolKind numeric preservation', () => {
      const tool = createTool();
      const schema = tool.schema.parametersJsonSchema as {
        definitions?: {
          LspCallHierarchyItem?: {
            properties?: {
              rawKind?: { type?: string };
            };
          };
        };
      };
      const itemDef = schema.definitions?.LspCallHierarchyItem;
      expect(itemDef?.properties?.rawKind?.type).toBe('number');
    });

    describe('schema definitions deep validation', () => {
      it('has LspPosition definition with correct structure', () => {
        const tool = createTool();
        const schema = tool.schema.parametersJsonSchema as {
          definitions?: {
            LspPosition?: {
              type?: string;
              properties?: {
                line?: { type?: string };
                character?: { type?: string };
              };
              required?: string[];
            };
          };
        };
        const posDef = schema.definitions?.LspPosition;
        expect(posDef).toBeDefined();
        expect(posDef?.type).toBe('object');
        expect(posDef?.properties?.line?.type).toBe('number');
        expect(posDef?.properties?.character?.type).toBe('number');
        expect(posDef?.required).toEqual(['line', 'character']);
      });

      it('has LspRange definition with correct structure', () => {
        const tool = createTool();
        const schema = tool.schema.parametersJsonSchema as {
          definitions?: {
            LspRange?: {
              type?: string;
              properties?: {
                start?: { $ref?: string };
                end?: { $ref?: string };
              };
              required?: string[];
            };
          };
        };
        const rangeDef = schema.definitions?.LspRange;
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
        const tool = createTool();
        const schema = tool.schema.parametersJsonSchema as {
          properties?: {
            callHierarchyItem?: { $ref?: string };
          };
          definitions?: {
            LspCallHierarchyItem?: {
              properties?: {
                range?: { $ref?: string };
                selectionRange?: { $ref?: string };
              };
            };
          };
        };
        // callHierarchyItem property should reference the definition
        expect(schema.properties?.callHierarchyItem?.$ref).toBe(
          '#/definitions/LspCallHierarchyItem',
        );
        // range and selectionRange should use LspRange $ref
        const itemDef = schema.definitions?.LspCallHierarchyItem;
        expect(itemDef?.properties?.range?.$ref).toBe('#/definitions/LspRange');
        expect(itemDef?.properties?.selectionRange?.$ref).toBe(
          '#/definitions/LspRange',
        );
      });

      it('all definitions are present and accounted for', () => {
        const tool = createTool();
        const schema = tool.schema.parametersJsonSchema as {
          definitions?: Record<string, unknown>;
        };
        const definitionNames = Object.keys(schema.definitions ?? {});
        // Should include at least these definitions
        expect(definitionNames).toEqual(
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
    it('describes goToDefinition correctly', () => {
      const tool = createTool();
      const invocation = tool.build({
        operation: 'goToDefinition',
        filePath: 'src/app.ts',
        line: 10,
        character: 5,
      });
      // Uses formatted label "go-to-definition"
      expect(invocation.getDescription()).toContain('go-to-definition');
      expect(invocation.getDescription()).toContain('src/app.ts:10:5');
    });

    it('describes workspaceSymbol correctly', () => {
      const tool = createTool();
      const invocation = tool.build({
        operation: 'workspaceSymbol',
        query: 'Widget',
      });
      // Uses formatted label "workspace symbol search"
      expect(invocation.getDescription()).toContain('workspace symbol search');
      expect(invocation.getDescription()).toContain('Widget');
    });

    it('describes incomingCalls correctly', () => {
      const tool = createTool();
      const invocation = tool.build({
        operation: 'incomingCalls',
        callHierarchyItem: {
          name: 'testFunc',
          uri: 'file:///test.ts',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
        },
      });
      // Uses formatted label "incoming calls"
      expect(invocation.getDescription()).toContain('incoming calls');
      expect(invocation.getDescription()).toContain('testFunc');
    });
  });
});
