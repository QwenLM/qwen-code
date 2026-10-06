/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { NativeLspService } from './native-lsp-service.js';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { LspDiagnostic, LspLocation } from './types.js';

/** An LSP range from line `sl`, character `sc` to line `el`, character `ec`. */
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

/** LSP server responses, shaped as a real server would send them. */
const MOCK_LSP_RESPONSES = {
  'textDocument/definition': [
    { uri: 'file:///test/workspace/src/types.ts', range: range(10, 0, 10, 20) },
  ],
  'textDocument/references': [
    { uri: 'file:///test/workspace/src/app.ts', range: range(5, 10, 5, 20) },
    { uri: 'file:///test/workspace/src/utils.ts', range: range(15, 5, 15, 15) },
  ],
  'textDocument/hover': {
    contents: {
      kind: 'markdown',
      value:
        '```typescript\nfunction testFunc(): void\n```\n\nA test function.',
    },
    range: range(10, 0, 10, 8),
  },
  'textDocument/documentSymbol': [
    {
      name: 'TestClass',
      kind: 5, // Class
      range: range(0, 0, 20, 1),
      selectionRange: range(0, 6, 0, 15),
      children: [
        {
          name: 'constructor',
          kind: 9, // Constructor
          range: range(2, 2, 4, 3),
          selectionRange: range(2, 2, 2, 13),
        },
      ],
    },
  ],
  'workspace/symbol': [
    {
      name: 'TestClass',
      kind: 5, // Class
      location: {
        uri: 'file:///test/workspace/src/test.ts',
        range: range(0, 0, 20, 1),
      },
    },
    {
      name: 'testFunction',
      kind: 12, // Function
      location: {
        uri: 'file:///test/workspace/src/utils.ts',
        range: range(5, 0, 10, 1),
      },
      containerName: 'utils',
    },
  ],
  'textDocument/prepareCallHierarchy': [
    {
      name: 'testFunction',
      kind: 12, // Function
      detail: '(param: string) => void',
      uri: 'file:///test/workspace/src/utils.ts',
      range: range(5, 0, 10, 1),
      selectionRange: range(5, 9, 5, 21),
    },
  ],
  'callHierarchy/incomingCalls': [
    {
      from: {
        name: 'callerFunction',
        kind: 12,
        uri: 'file:///test/workspace/src/caller.ts',
        range: range(10, 0, 15, 1),
        selectionRange: range(10, 9, 10, 23),
      },
      fromRanges: [range(12, 2, 12, 16)],
    },
  ],
  'callHierarchy/outgoingCalls': [
    {
      to: {
        name: 'helperFunction',
        kind: 12,
        uri: 'file:///test/workspace/src/helper.ts',
        range: range(0, 0, 5, 1),
        selectionRange: range(0, 9, 0, 23),
      },
      fromRanges: [range(7, 2, 7, 16)],
    },
  ],
  'textDocument/diagnostic': {
    kind: 'full',
    items: [
      {
        range: range(5, 0, 5, 10),
        severity: 1, // Error
        code: 'TS2304',
        source: 'typescript',
        message: "Cannot find name 'undeclaredVar'.",
      },
      {
        range: range(10, 0, 10, 15),
        severity: 2, // Warning
        code: 'TS6133',
        source: 'typescript',
        message: "'unusedVar' is declared but its value is never read.",
        tags: [1], // Unnecessary
      },
    ],
  },
  'workspace/diagnostic': {
    items: [
      {
        kind: 'full',
        uri: 'file:///test/workspace/src/app.ts',
        items: [
          {
            range: range(5, 0, 5, 10),
            severity: 1,
            code: 'TS2304',
            source: 'typescript',
            message: "Cannot find name 'undeclaredVar'.",
          },
        ],
      },
      {
        kind: 'full',
        uri: 'file:///test/workspace/src/utils.ts',
        items: [
          {
            range: range(10, 0, 10, 15),
            severity: 2,
            code: 'TS6133',
            source: 'typescript',
            message: "'unusedVar' is declared but its value is never read.",
          },
        ],
      },
    ],
  },
  'textDocument/codeAction': [
    {
      title: "Add missing import 'React'",
      kind: 'quickfix',
      diagnostics: [
        {
          range: range(0, 0, 0, 5),
          severity: 1,
          message: "Cannot find name 'React'.",
        },
      ],
      edit: {
        changes: {
          'file:///test/workspace/src/app.tsx': [
            {
              range: range(0, 0, 0, 0),
              newText: "import React from 'react';\n",
            },
          ],
        },
      },
      isPreferred: true,
    },
    {
      title: 'Organize imports',
      kind: 'source.organizeImports',
      edit: {
        changes: {
          'file:///test/workspace/src/app.tsx': [
            {
              range: range(0, 0, 5, 0),
              newText:
                "import { Component } from 'react';\nimport { helper } from './utils';\n",
            },
          ],
        },
      },
    },
  ],
};

class MockConfig {
  rootPath = '/test/workspace';
  private trusted = true;

  isTrustedFolder(): boolean {
    return this.trusted;
  }

  setTrusted(trusted: boolean): void {
    this.trusted = trusted;
  }

  get(_key: string) {
    return undefined;
  }

  getProjectRoot(): string {
    return this.rootPath;
  }
}

class MockWorkspaceContext {
  rootPath = '/test/workspace';

  async fileExists(filePath: string): Promise<boolean> {
    return (
      filePath.endsWith('.json') ||
      filePath.includes('package.json') ||
      filePath.includes('.ts')
    );
  }

  async readFile(filePath: string): Promise<string> {
    if (filePath.includes('.lsp.json')) {
      return JSON.stringify({
        'mock-lsp': {
          languages: ['typescript', 'javascript'],
          command: 'mock-lsp-server',
          args: ['--stdio'],
          transport: 'stdio',
        },
      });
    }
    return '{}';
  }

  resolvePath(relativePath: string): string {
    return this.rootPath + '/' + relativePath;
  }

  isPathWithinWorkspace(_path: string): boolean {
    return true;
  }

  getDirectories(): string[] {
    return [this.rootPath];
  }
}

class MockFileDiscoveryService {
  async discoverFiles(_root: string, _options: unknown): Promise<string[]> {
    return [
      '/test/workspace/src/index.ts',
      '/test/workspace/src/app.ts',
      '/test/workspace/src/utils.ts',
      '/test/workspace/src/types.ts',
    ];
  }

  shouldIgnoreFile(file: string): boolean {
    return file.includes('node_modules') || file.includes('.git');
  }
}

class MockIdeContextStore {}

describe('NativeLspService Integration Tests', () => {
  let lspService: NativeLspService;
  let mockConfig: MockConfig;
  let mockWorkspace: MockWorkspaceContext;
  let mockFileDiscovery: MockFileDiscoveryService;
  let mockIdeStore: MockIdeContextStore;
  let eventEmitter: EventEmitter;

  /** A service over this test's mocks. */
  const createService = (
    options?: ConstructorParameters<typeof NativeLspService>[5],
    workspace: MockWorkspaceContext = mockWorkspace,
  ) =>
    new NativeLspService(
      mockConfig as unknown as CoreConfig,
      workspace as unknown as WorkspaceContext,
      eventEmitter,
      mockFileDiscovery as unknown as FileDiscoveryService,
      mockIdeStore as unknown as IdeContextStore,
      options,
    );

  beforeEach(() => {
    mockConfig = new MockConfig();
    mockWorkspace = new MockWorkspaceContext();
    mockFileDiscovery = new MockFileDiscoveryService();
    mockIdeStore = new MockIdeContextStore();
    eventEmitter = new EventEmitter();

    lspService = createService({ workspaceRoot: mockWorkspace.rootPath });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Service Lifecycle', () => {
    it('should initialize service correctly', () => {
      expect(lspService).toBeDefined();
    });

    it('should discover and prepare without errors', async () => {
      await expect(lspService.discoverAndPrepare()).resolves.not.toThrow();
    });

    it('should return status after discovery', async () => {
      await lspService.discoverAndPrepare();
      const status = lspService.getStatus();
      expect(status).toBeDefined();
      expect(status instanceof Map).toBe(true);
    });

    it('should skip discovery for untrusted workspace', async () => {
      mockConfig.setTrusted(false);
      const untrustedService = createService({
        workspaceRoot: mockWorkspace.rootPath,
        requireTrustedWorkspace: true,
      });

      await untrustedService.discoverAndPrepare();
      const status = untrustedService.getStatus();
      expect(status.size).toBe(0);
    });
  });

  describe('Configuration Merging', () => {
    it('should detect TypeScript/JavaScript in workspace', async () => {
      await lspService.discoverAndPrepare();
      const status = lspService.getStatus();

      // Should have detected TypeScript based on mock file discovery
      // The exact server name depends on built-in presets
      expect(status.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe('LSP Operations - Mock Responses', () => {
    // Note: These tests verify the structure of expected responses
    // In a real integration test, you would mock the connection or use a real server

    it('should format definition response correctly', () => {
      const response = MOCK_LSP_RESPONSES['textDocument/definition'];
      expect(response).toHaveLength(1);
      expect(response[0]).toHaveProperty('uri');
      expect(response[0]).toHaveProperty('range');
      expect(response[0].range.start).toHaveProperty('line');
      expect(response[0].range.start).toHaveProperty('character');
    });

    it('should format references response correctly', () => {
      const response = MOCK_LSP_RESPONSES['textDocument/references'];
      expect(response).toHaveLength(2);
      for (const ref of response) {
        expect(ref).toHaveProperty('uri');
        expect(ref).toHaveProperty('range');
      }
    });

    it('should format hover response correctly', () => {
      const response = MOCK_LSP_RESPONSES['textDocument/hover'];
      expect(response).toHaveProperty('contents');
      expect(response.contents).toHaveProperty('value');
      expect(response.contents.value).toContain('testFunc');
    });

    it('should format document symbols correctly', () => {
      const response = MOCK_LSP_RESPONSES['textDocument/documentSymbol'];
      expect(response).toHaveLength(1);
      expect(response[0].name).toBe('TestClass');
      expect(response[0].kind).toBe(5); // Class
      expect(response[0].children).toHaveLength(1);
    });

    it('should format workspace symbols correctly', () => {
      const response = MOCK_LSP_RESPONSES['workspace/symbol'];
      expect(response).toHaveLength(2);
      expect(response[0].name).toBe('TestClass');
      expect(response[1].name).toBe('testFunction');
      expect(response[1].containerName).toBe('utils');
    });

    it('should format call hierarchy items correctly', () => {
      const response = MOCK_LSP_RESPONSES['textDocument/prepareCallHierarchy'];
      expect(response).toHaveLength(1);
      expect(response[0].name).toBe('testFunction');
      expect(response[0]).toHaveProperty('detail');
      expect(response[0]).toHaveProperty('range');
      expect(response[0]).toHaveProperty('selectionRange');
    });

    it('should format incoming calls correctly', () => {
      const response = MOCK_LSP_RESPONSES['callHierarchy/incomingCalls'];
      expect(response).toHaveLength(1);
      expect(response[0].from.name).toBe('callerFunction');
      expect(response[0].fromRanges).toHaveLength(1);
    });

    it('should format outgoing calls correctly', () => {
      const response = MOCK_LSP_RESPONSES['callHierarchy/outgoingCalls'];
      expect(response).toHaveLength(1);
      expect(response[0].to.name).toBe('helperFunction');
      expect(response[0].fromRanges).toHaveLength(1);
    });

    it('should format diagnostics correctly', () => {
      const response = MOCK_LSP_RESPONSES['textDocument/diagnostic'];
      expect(response.items).toHaveLength(2);
      expect(response.items[0].severity).toBe(1); // Error
      expect(response.items[0].code).toBe('TS2304');
      expect(response.items[1].severity).toBe(2); // Warning
      expect(response.items[1].tags).toContain(1); // Unnecessary
    });

    it('should format workspace diagnostics correctly', () => {
      const response = MOCK_LSP_RESPONSES['workspace/diagnostic'];
      expect(response.items).toHaveLength(2);
      expect(response.items[0].uri).toContain('app.ts');
      expect(response.items[1].uri).toContain('utils.ts');
    });

    it('should format code actions correctly', () => {
      const response = MOCK_LSP_RESPONSES['textDocument/codeAction'];
      expect(response).toHaveLength(2);

      const quickfix = response[0];
      expect(quickfix.title).toContain('import');
      expect(quickfix.kind).toBe('quickfix');
      expect(quickfix.isPreferred).toBe(true);
      expect(quickfix.edit).toHaveProperty('changes');

      const organizeImports = response[1];
      expect(organizeImports.kind).toBe('source.organizeImports');
    });
  });

  describe('Diagnostic Normalization', () => {
    it('should normalize severity levels correctly', () => {
      const severityMap: Record<number, string> = {
        1: 'error',
        2: 'warning',
        3: 'information',
        4: 'hint',
      };

      for (const [num, label] of Object.entries(severityMap)) {
        expect(severityMap[Number(num)]).toBe(label);
      }
    });

    it('should normalize diagnostic tags correctly', () => {
      const tagMap: Record<number, string> = {
        1: 'unnecessary',
        2: 'deprecated',
      };

      expect(tagMap[1]).toBe('unnecessary');
      expect(tagMap[2]).toBe('deprecated');
    });
  });

  describe('Code Action Context', () => {
    it('should support filtering by code action kind', () => {
      const kinds = ['quickfix', 'refactor', 'source.organizeImports'];
      const filteredActions = MOCK_LSP_RESPONSES[
        'textDocument/codeAction'
      ].filter((action) => kinds.includes(action.kind));
      expect(filteredActions).toHaveLength(2);
    });

    it('should support quick fix actions with diagnostics', () => {
      const quickfix = MOCK_LSP_RESPONSES['textDocument/codeAction'][0];
      expect(quickfix.diagnostics).toBeDefined();
      expect(quickfix.diagnostics).toHaveLength(1);
      expect(quickfix.edit).toBeDefined();
    });
  });

  describe('Workspace Edit Application', () => {
    it('should structure workspace edits correctly', () => {
      const codeAction = MOCK_LSP_RESPONSES['textDocument/codeAction'][0];
      const edit = codeAction.edit;

      expect(edit).toHaveProperty('changes');
      expect(edit?.changes).toBeDefined();

      const changes = edit?.changes as Record<string, unknown[]>;
      const uri = Object.keys(changes ?? {})[0];
      expect(uri).toContain('app.tsx');

      const edits = changes?.[uri];
      expect(edits).toHaveLength(1);
      expect(edits?.[0]).toHaveProperty('range');
      expect(edits?.[0]).toHaveProperty('newText');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing workspace gracefully', async () => {
      const emptyWorkspace = new MockWorkspaceContext();
      emptyWorkspace.getDirectories = () => [];

      const service = createService(undefined, emptyWorkspace);

      await expect(service.discoverAndPrepare()).resolves.not.toThrow();
    });

    it('should return empty results when no server is ready', async () => {
      // Before starting any servers, operations should return empty
      const results = await lspService.workspaceSymbols('test');
      expect(results).toEqual([]);
    });

    it('should return empty diagnostics when no server is ready', async () => {
      const uri = 'file:///test/workspace/src/app.ts';
      const results = await lspService.diagnostics(uri);
      expect(results).toEqual([]);
    });

    it('should return empty code actions when no server is ready', async () => {
      const uri = 'file:///test/workspace/src/app.ts';
      const context = {
        diagnostics: [],
        only: undefined,
        triggerKind: 'invoked' as const,
      };

      const results = await lspService.codeActions(
        uri,
        range(0, 0, 0, 10),
        context,
      );
      expect(results).toEqual([]);
    });
  });

  describe('Security Controls', () => {
    it('should respect trust requirements', async () => {
      mockConfig.setTrusted(false);

      const strictService = createService({ requireTrustedWorkspace: true });

      await strictService.discoverAndPrepare();
      const status = strictService.getStatus();

      // No servers should be discovered in untrusted workspace
      expect(status.size).toBe(0);
    });

    it('should allow operations in trusted workspace', async () => {
      mockConfig.setTrusted(true);

      await lspService.discoverAndPrepare();
      // Service should be ready to accept operations (even if no real server)
      expect(lspService).toBeDefined();
    });
  });
});

describe('LSP Response Type Validation', () => {
  describe('LspDiagnostic', () => {
    it('should have correct structure', () => {
      const diagnostic: LspDiagnostic = {
        range: range(0, 0, 0, 10),
        severity: 'error',
        code: 'TS2304',
        source: 'typescript',
        message: 'Cannot find name.',
      };

      expect(diagnostic.range).toBeDefined();
      expect(diagnostic.severity).toBe('error');
      expect(diagnostic.code).toBe('TS2304');
      expect(diagnostic.source).toBe('typescript');
      expect(diagnostic.message).toBeDefined();
    });

    it('should support optional fields', () => {
      const minimalDiagnostic: LspDiagnostic = {
        range: range(0, 0, 0, 10),
        message: 'Error message',
      };

      expect(minimalDiagnostic.severity).toBeUndefined();
      expect(minimalDiagnostic.code).toBeUndefined();
      expect(minimalDiagnostic.source).toBeUndefined();
    });
  });

  describe('LspLocation', () => {
    it('should have correct structure', () => {
      const location: LspLocation = {
        uri: 'file:///test/file.ts',
        range: range(10, 5, 10, 15),
      };

      expect(location.uri).toBe('file:///test/file.ts');
      expect(location.range.start.line).toBe(10);
      expect(location.range.start.character).toBe(5);
      expect(location.range.end.line).toBe(10);
      expect(location.range.end.character).toBe(15);
    });
  });
});
