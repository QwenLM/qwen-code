/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type {
  LspCallHierarchyIncomingCall,
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspClient,
  LspCodeAction,
  LspCodeActionContext,
  LspCodeActionKind,
  LspDefinition,
  LspDiagnostic,
  LspFileDiagnostics,
  LspLocation,
  LspRange,
  LspReference,
  LspSymbolInformation,
} from '../lsp/types.js';

/**
 * Supported LSP operations.
 */
export type LspOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls'
  | 'diagnostics'
  | 'workspaceDiagnostics'
  | 'codeActions';

/**
 * Parameters for the unified LSP tool.
 */
export interface LspToolParams {
  /** Operation to perform. */
  operation: LspOperation;
  /** File path (absolute or workspace-relative). */
  filePath?: string;
  /** 1-based line number when targeting a specific file location. */
  line?: number;
  /** 1-based character/column number when targeting a specific file location. */
  character?: number;
  /** End line for range-based operations (1-based). */
  endLine?: number;
  /** End character for range-based operations (1-based). */
  endCharacter?: number;
  /** Whether to include the declaration in reference results. */
  includeDeclaration?: boolean;
  /** Query string for workspace symbol search. */
  query?: string;
  /** Call hierarchy item from a previous call hierarchy operation. */
  callHierarchyItem?: LspCallHierarchyItem;
  /** Optional server name override. */
  serverName?: string;
  /** Optional maximum number of results. */
  limit?: number;
  /** Diagnostics for code action context. */
  diagnostics?: LspDiagnostic[];
  /** Code action kinds to filter by. */
  codeActionKinds?: LspCodeActionKind[];
}

type ResolvedTarget =
  | {
      location: LspLocation;
      description: string;
    }
  | { error: string };

/** Operations that require filePath and line. */
const LOCATION_REQUIRED_OPERATIONS = new Set<LspOperation>([
  'goToDefinition',
  'findReferences',
  'hover',
  'goToImplementation',
  'prepareCallHierarchy',
]);

/** Operations that only require filePath. */
const FILE_REQUIRED_OPERATIONS = new Set<LspOperation>([
  'documentSymbol',
  'diagnostics',
]);

/** Operations that require query. */
const QUERY_REQUIRED_OPERATIONS = new Set<LspOperation>(['workspaceSymbol']);

/** Operations that require callHierarchyItem. */
const ITEM_REQUIRED_OPERATIONS = new Set<LspOperation>([
  'incomingCalls',
  'outgoingCalls',
]);

/** Operations that require filePath and range for code actions. */
const RANGE_REQUIRED_OPERATIONS = new Set<LspOperation>(['codeActions']);

class LspToolInvocation extends BaseToolInvocation<LspToolParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: LspToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const operationLabel = this.getOperationLabel();
    if (this.params.operation === 'workspaceSymbol') {
      return `LSP ${operationLabel} for "${this.params.query ?? ''}"`;
    }
    if (this.params.operation === 'documentSymbol') {
      return this.params.filePath
        ? `LSP ${operationLabel} for ${this.params.filePath}`
        : `LSP ${operationLabel}`;
    }
    if (
      this.params.operation === 'incomingCalls' ||
      this.params.operation === 'outgoingCalls'
    ) {
      return `LSP ${operationLabel} for ${this.describeCallHierarchyItemShort()}`;
    }
    if (this.params.filePath && this.params.line !== undefined) {
      return `LSP ${operationLabel} at ${this.params.filePath}:${this.params.line}:${this.params.character ?? 1}`;
    }
    if (this.params.filePath) {
      return `LSP ${operationLabel} for ${this.params.filePath}`;
    }
    return `LSP ${operationLabel}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const client = this.config.getLspClient();
    if (!client || !this.config.isLspEnabled()) {
      const message = `LSP ${this.getOperationLabel()} is unavailable (LSP disabled or not initialized).`;
      return { llmContent: message, returnDisplay: message };
    }

    switch (this.params.operation) {
      case 'goToDefinition':
        return this.executeDefinitions(client);
      case 'findReferences':
        return this.executeReferences(client);
      case 'hover':
        return this.executeHover(client);
      case 'documentSymbol':
        return this.executeDocumentSymbols(client);
      case 'workspaceSymbol':
        return this.executeWorkspaceSymbols(client);
      case 'goToImplementation':
        return this.executeImplementations(client);
      case 'prepareCallHierarchy':
        return this.executePrepareCallHierarchy(client);
      case 'incomingCalls':
        return this.executeIncomingCalls(client);
      case 'outgoingCalls':
        return this.executeOutgoingCalls(client);
      case 'diagnostics':
        return this.executeDiagnostics(client);
      case 'workspaceDiagnostics':
        return this.executeWorkspaceDiagnostics(client);
      case 'codeActions':
        return this.executeCodeActions(client);
      default: {
        const message = `Unsupported LSP operation: ${this.params.operation}`;
        return { llmContent: message, returnDisplay: message };
      }
    }
  }

  private async executeDefinitions(client: LspClient): Promise<ToolResult> {
    const target = this.resolveLocationTarget();
    if ('error' in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }

    const limit = this.params.limit ?? 20;
    let definitions: LspDefinition[] = [];
    try {
      definitions = await client.definitions(
        target.location,
        this.params.serverName,
        limit,
      );
    } catch (error) {
      const message = `LSP go-to-definition failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!definitions.length) {
      const message = `No definitions found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const lines = definitions
      .slice(0, limit)
      .map(
        (definition, index) =>
          `${index + 1}. ${this.formatLocationWithServer(definition, workspaceRoot)}`,
      );

    const heading = `Definitions for ${target.description}:`;
    return {
      llmContent: [heading, ...lines].join('\n'),
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeImplementations(client: LspClient): Promise<ToolResult> {
    const target = this.resolveLocationTarget();
    if ('error' in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }

    const limit = this.params.limit ?? 20;
    let implementations: LspDefinition[] = [];
    try {
      implementations = await client.implementations(
        target.location,
        this.params.serverName,
        limit,
      );
    } catch (error) {
      const message = `LSP go-to-implementation failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!implementations.length) {
      const message = `No implementations found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const lines = implementations
      .slice(0, limit)
      .map(
        (implementation, index) =>
          `${index + 1}. ${this.formatLocationWithServer(implementation, workspaceRoot)}`,
      );

    const heading = `Implementations for ${target.description}:`;
    return {
      llmContent: [heading, ...lines].join('\n'),
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeReferences(client: LspClient): Promise<ToolResult> {
    const target = this.resolveLocationTarget();
    if ('error' in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }

    const limit = this.params.limit ?? 50;
    let references: LspReference[] = [];
    try {
      references = await client.references(
        target.location,
        this.params.serverName,
        this.params.includeDeclaration ?? false,
        limit,
      );
    } catch (error) {
      const message = `LSP find-references failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!references.length) {
      const message = `No references found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const lines = references
      .slice(0, limit)
      .map(
        (reference, index) =>
          `${index + 1}. ${this.formatLocationWithServer(reference, workspaceRoot)}`,
      );

    const heading = `References for ${target.description}:`;
    return {
      llmContent: [heading, ...lines].join('\n'),
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeHover(client: LspClient): Promise<ToolResult> {
    const target = this.resolveLocationTarget();
    if ('error' in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }

    let hoverText = '';
    try {
      const result = await client.hover(
        target.location,
        this.params.serverName,
      );
      if (result) {
        hoverText = result.contents ?? '';
      }
    } catch (error) {
      const message = `LSP hover failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!hoverText || hoverText.trim().length === 0) {
      const message = `No hover information found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const heading = `Hover for ${target.description}:`;
    const content = hoverText.trim();
    return {
      llmContent: `${heading}\n${content}`,
      returnDisplay: content,
    };
  }

  private async executeDocumentSymbols(client: LspClient): Promise<ToolResult> {
    const workspaceRoot = this.config.getProjectRoot();
    const filePath = this.params.filePath ?? '';
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      const message = 'A valid filePath is required for document symbols.';
      return { llmContent: message, returnDisplay: message };
    }

    const limit = this.params.limit ?? 50;
    let symbols: LspSymbolInformation[] = [];
    try {
      symbols = await client.documentSymbols(
        uri,
        this.params.serverName,
        limit,
      );
    } catch (error) {
      const message = `LSP document symbols failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!symbols.length) {
      const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
      const message = `No document symbols found for ${fileLabel}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const lines = symbols.slice(0, limit).map((symbol, index) => {
      const location = this.formatLocationWithoutServer(
        symbol.location,
        workspaceRoot,
      );
      const serverSuffix = symbol.serverName ? ` [${symbol.serverName}]` : '';
      const kind = symbol.kind ? ` (${symbol.kind})` : '';
      const container = symbol.containerName
        ? ` in ${symbol.containerName}`
        : '';
      return `${index + 1}. ${symbol.name}${kind}${container} - ${location}${serverSuffix}`;
    });

    const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
    const heading = `Document symbols for ${fileLabel}:`;
    return {
      llmContent: [heading, ...lines].join('\n'),
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeWorkspaceSymbols(
    client: LspClient,
  ): Promise<ToolResult> {
    const limit = this.params.limit ?? 20;
    const query = this.params.query ?? '';
    let symbols: LspSymbolInformation[] = [];
    try {
      symbols = await client.workspaceSymbols(query, limit);
    } catch (error) {
      const message = `LSP workspace symbol search failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!symbols.length) {
      const message = `No symbols found for query "${query}".`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const lines = symbols.slice(0, limit).map((symbol, index) => {
      const location = this.formatLocationWithoutServer(
        symbol.location,
        workspaceRoot,
      );
      const serverSuffix = symbol.serverName ? ` [${symbol.serverName}]` : '';
      const kind = symbol.kind ? ` (${symbol.kind})` : '';
      const container = symbol.containerName
        ? ` in ${symbol.containerName}`
        : '';
      return `${index + 1}. ${symbol.name}${kind}${container} - ${location}${serverSuffix}`;
    });

    const heading = `Found ${Math.min(symbols.length, limit)} of ${
      symbols.length
    } symbols for query "${query}":`;

    // Also fetch references for the top match to provide additional context.
    let referenceSection = '';
    const topSymbol = symbols[0];
    if (topSymbol) {
      try {
        const referenceLimit = Math.min(20, Math.max(limit, 5));
        const references = await client.references(
          topSymbol.location,
          topSymbol.serverName,
          false,
          referenceLimit,
        );
        if (references.length > 0) {
          const refLines = references.map((ref, index) => {
            const location = this.formatLocationWithoutServer(
              ref,
              workspaceRoot,
            );
            const serverSuffix = ref.serverName ? ` [${ref.serverName}]` : '';
            return `${index + 1}. ${location}${serverSuffix}`;
          });
          referenceSection = [
            '',
            `References for top match (${topSymbol.name}):`,
            ...refLines,
          ].join('\n');
        }
      } catch (error) {
        referenceSection = `\nReferences lookup failed: ${
          (error as Error)?.message || String(error)
        }`;
      }
    }

    const llmParts = referenceSection
      ? [heading, ...lines, referenceSection]
      : [heading, ...lines];
    const displayParts = referenceSection
      ? [...lines, referenceSection]
      : [...lines];

    return {
      llmContent: llmParts.join('\n'),
      returnDisplay: displayParts.join('\n'),
    };
  }

  private async executePrepareCallHierarchy(
    client: LspClient,
  ): Promise<ToolResult> {
    const target = this.resolveLocationTarget();
    if ('error' in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }

    const limit = this.params.limit ?? 20;
    let items: LspCallHierarchyItem[] = [];
    try {
      items = await client.prepareCallHierarchy(
        target.location,
        this.params.serverName,
        limit,
      );
    } catch (error) {
      const message = `LSP call hierarchy prepare failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!items.length) {
      const message = `No call hierarchy items found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const slicedItems = items.slice(0, limit);
    const lines = slicedItems.map((item, index) =>
      this.formatCallHierarchyItemLine(item, index, workspaceRoot),
    );

    const heading = `Call hierarchy items for ${target.description}:`;
    const jsonSection = this.formatJsonSection(
      'Call hierarchy items (JSON)',
      slicedItems,
    );
    return {
      llmContent: [heading, ...lines].join('\n') + jsonSection,
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeIncomingCalls(client: LspClient): Promise<ToolResult> {
    const item = this.params.callHierarchyItem;
    if (!item) {
      const message = 'callHierarchyItem is required for incomingCalls.';
      return { llmContent: message, returnDisplay: message };
    }

    const limit = this.params.limit ?? 20;
    const serverName = this.params.serverName ?? item.serverName;
    let calls: LspCallHierarchyIncomingCall[] = [];
    try {
      calls = await client.incomingCalls(item, serverName, limit);
    } catch (error) {
      const message = `LSP incoming calls failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!calls.length) {
      const message = `No incoming calls found for ${this.describeCallHierarchyItemFull(
        item,
      )}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const slicedCalls = calls.slice(0, limit);
    const lines = slicedCalls.map((call, index) => {
      const targetItem = call.from;
      const location = this.formatLocationWithServer(
        {
          uri: targetItem.uri,
          range: targetItem.selectionRange,
          serverName: targetItem.serverName,
        },
        workspaceRoot,
      );
      const kind = targetItem.kind ? ` (${targetItem.kind})` : '';
      const detail = targetItem.detail ? ` ${targetItem.detail}` : '';
      const rangeSuffix = this.formatCallRanges(call.fromRanges);
      return `${index + 1}. ${targetItem.name}${kind}${detail} - ${location}${rangeSuffix}`;
    });

    const heading = `Incoming calls for ${this.describeCallHierarchyItemFull(
      item,
    )}:`;
    const jsonSection = this.formatJsonSection(
      'Incoming calls (JSON)',
      slicedCalls,
    );
    return {
      llmContent: [heading, ...lines].join('\n') + jsonSection,
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeOutgoingCalls(client: LspClient): Promise<ToolResult> {
    const item = this.params.callHierarchyItem;
    if (!item) {
      const message = 'callHierarchyItem is required for outgoingCalls.';
      return { llmContent: message, returnDisplay: message };
    }

    const limit = this.params.limit ?? 20;
    const serverName = this.params.serverName ?? item.serverName;
    let calls: LspCallHierarchyOutgoingCall[] = [];
    try {
      calls = await client.outgoingCalls(item, serverName, limit);
    } catch (error) {
      const message = `LSP outgoing calls failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!calls.length) {
      const message = `No outgoing calls found for ${this.describeCallHierarchyItemFull(
        item,
      )}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const slicedCalls = calls.slice(0, limit);
    const lines = slicedCalls.map((call, index) => {
      const targetItem = call.to;
      const location = this.formatLocationWithServer(
        {
          uri: targetItem.uri,
          range: targetItem.selectionRange,
          serverName: targetItem.serverName,
        },
        workspaceRoot,
      );
      const kind = targetItem.kind ? ` (${targetItem.kind})` : '';
      const detail = targetItem.detail ? ` ${targetItem.detail}` : '';
      const rangeSuffix = this.formatCallRanges(call.fromRanges);
      return `${index + 1}. ${targetItem.name}${kind}${detail} - ${location}${rangeSuffix}`;
    });

    const heading = `Outgoing calls for ${this.describeCallHierarchyItemFull(
      item,
    )}:`;
    const jsonSection = this.formatJsonSection(
      'Outgoing calls (JSON)',
      slicedCalls,
    );
    return {
      llmContent: [heading, ...lines].join('\n') + jsonSection,
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeDiagnostics(client: LspClient): Promise<ToolResult> {
    const workspaceRoot = this.config.getProjectRoot();
    const filePath = this.params.filePath ?? '';
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      const message = 'A valid filePath is required for diagnostics.';
      return { llmContent: message, returnDisplay: message };
    }

    let diagnostics: LspDiagnostic[] = [];
    try {
      diagnostics = await client.diagnostics(uri, this.params.serverName);
    } catch (error) {
      const message = `LSP diagnostics failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!diagnostics.length) {
      const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
      const message = `No diagnostics found for ${fileLabel}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const lines = diagnostics.map((diag, index) => {
      const severity = diag.severity ? `[${diag.severity.toUpperCase()}]` : '';
      const position = `${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
      const code = diag.code ? ` (${diag.code})` : '';
      const source = diag.source ? ` [${diag.source}]` : '';
      return `${index + 1}. ${severity} ${position}${code}${source}: ${diag.message}`;
    });

    const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
    const heading = `Diagnostics for ${fileLabel} (${diagnostics.length} issues):`;
    return {
      llmContent: [heading, ...lines].join('\n'),
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeWorkspaceDiagnostics(
    client: LspClient,
  ): Promise<ToolResult> {
    const limit = this.params.limit ?? 50;
    let fileDiagnostics: LspFileDiagnostics[] = [];
    try {
      fileDiagnostics = await client.workspaceDiagnostics(
        this.params.serverName,
        limit,
      );
    } catch (error) {
      const message = `LSP workspace diagnostics failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!fileDiagnostics.length) {
      const message = 'No diagnostics found in the workspace.';
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const lines: string[] = [];
    let totalIssues = 0;

    for (const fileDiag of fileDiagnostics) {
      const fileLabel = this.formatUriForDisplay(fileDiag.uri, workspaceRoot);
      const serverSuffix = fileDiag.serverName
        ? ` [${fileDiag.serverName}]`
        : '';
      lines.push(`\n${fileLabel}${serverSuffix}:`);

      for (const diag of fileDiag.diagnostics) {
        const severity = diag.severity
          ? `[${diag.severity.toUpperCase()}]`
          : '';
        const position = `${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
        const code = diag.code ? ` (${diag.code})` : '';
        lines.push(`  ${severity} ${position}${code}: ${diag.message}`);
        totalIssues++;
      }
    }

    const heading = `Workspace diagnostics (${totalIssues} issues in ${fileDiagnostics.length} files):`;
    return {
      llmContent: [heading, ...lines].join('\n'),
      returnDisplay: lines.join('\n'),
    };
  }

  private async executeCodeActions(client: LspClient): Promise<ToolResult> {
    const workspaceRoot = this.config.getProjectRoot();
    const filePath = this.params.filePath ?? '';
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      const message = 'A valid filePath is required for code actions.';
      return { llmContent: message, returnDisplay: message };
    }

    // Build range from params
    const startLine = Math.max(0, (this.params.line ?? 1) - 1);
    const startChar = Math.max(0, (this.params.character ?? 1) - 1);
    const endLine = Math.max(
      0,
      (this.params.endLine ?? this.params.line ?? 1) - 1,
    );
    const endChar = Math.max(
      0,
      (this.params.endCharacter ?? this.params.character ?? 1) - 1,
    );

    const range: LspRange = {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    };

    // Build context
    const context: LspCodeActionContext = {
      diagnostics: this.params.diagnostics ?? [],
      only: this.params.codeActionKinds,
      triggerKind: 'invoked',
    };

    const limit = this.params.limit ?? 20;
    let actions: LspCodeAction[] = [];
    try {
      actions = await client.codeActions(
        uri,
        range,
        context,
        this.params.serverName,
        limit,
      );
    } catch (error) {
      const message = `LSP code actions failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!actions.length) {
      const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
      const message = `No code actions available at ${fileLabel}:${startLine + 1}:${startChar + 1}.`;
      return { llmContent: message, returnDisplay: message };
    }

    const lines = actions.slice(0, limit).map((action, index) => {
      const kind = action.kind ? ` [${action.kind}]` : '';
      const preferred = action.isPreferred ? ' ★' : '';
      const hasEdit = action.edit ? ' (has edit)' : '';
      const hasCommand = action.command ? ' (has command)' : '';
      const serverSuffix = action.serverName ? ` [${action.serverName}]` : '';
      return `${index + 1}. ${action.title}${kind}${preferred}${hasEdit}${hasCommand}${serverSuffix}`;
    });

    const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
    const heading = `Code actions at ${fileLabel}:${startLine + 1}:${startChar + 1}:`;
    const jsonSection = this.formatJsonSection(
      'Code actions (JSON)',
      actions.slice(0, limit),
    );
    return {
      llmContent: [heading, ...lines].join('\n') + jsonSection,
      returnDisplay: lines.join('\n'),
    };
  }

  private resolveLocationTarget(): ResolvedTarget {
    const filePath = this.params.filePath;
    if (!filePath) {
      return {
        error: 'filePath is required for this operation.',
      };
    }
    if (typeof this.params.line !== 'number') {
      return {
        error: 'line is required for this operation.',
      };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      return {
        error: 'A valid filePath is required when specifying a line/character.',
      };
    }

    const position = {
      line: Math.max(0, Math.floor(this.params.line - 1)),
      character: Math.max(0, Math.floor((this.params.character ?? 1) - 1)),
    };
    const location: LspLocation = {
      uri,
      range: { start: position, end: position },
    };
    const description = this.formatLocationWithServer(
      { ...location, serverName: this.params.serverName },
      workspaceRoot,
    );
    return {
      location,
      description,
    };
  }

  private resolveUri(filePath: string, workspaceRoot: string): string | null {
    if (!filePath) {
      return null;
    }
    if (filePath.startsWith('file://') || filePath.includes('://')) {
      return filePath;
    }
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath);
    return pathToFileURL(absolutePath).toString();
  }

  private formatLocationWithServer(
    location: LspLocation & { serverName?: string },
    workspaceRoot: string,
  ): string {
    const start = location.range.start;
    let filePath = location.uri;

    if (filePath.startsWith('file://')) {
      filePath = fileURLToPath(filePath);
      filePath = path.relative(workspaceRoot, filePath) || '.';
    }

    const serverSuffix =
      location.serverName && location.serverName !== ''
        ? ` [${location.serverName}]`
        : '';

    return `${filePath}:${(start.line ?? 0) + 1}:${(start.character ?? 0) + 1}${serverSuffix}`;
  }

  private formatLocationWithoutServer(
    location: LspLocation,
    workspaceRoot: string,
  ): string {
    const { uri, range } = location;
    let filePath = uri;
    if (uri.startsWith('file://')) {
      filePath = fileURLToPath(uri);
      filePath = path.relative(workspaceRoot, filePath) || '.';
    }
    const line = (range.start.line ?? 0) + 1;
    const character = (range.start.character ?? 0) + 1;
    return `${filePath}:${line}:${character}`;
  }

  private formatCallHierarchyItemLine(
    item: LspCallHierarchyItem,
    index: number,
    workspaceRoot: string,
  ): string {
    const location = this.formatLocationWithServer(
      {
        uri: item.uri,
        range: item.selectionRange,
        serverName: item.serverName,
      },
      workspaceRoot,
    );
    const kind = item.kind ? ` (${item.kind})` : '';
    const detail = item.detail ? ` ${item.detail}` : '';
    return `${index + 1}. ${item.name}${kind}${detail} - ${location}`;
  }

  private formatCallRanges(ranges: LspRange[]): string {
    if (!ranges.length) {
      return '';
    }
    const formatted = ranges.map((range) => this.formatPosition(range.start));
    const maxShown = 3;
    const shown = formatted.slice(0, maxShown);
    const extra =
      formatted.length > maxShown
        ? `, +${formatted.length - maxShown} more`
        : '';
    return ` (calls at ${shown.join(', ')}${extra})`;
  }

  private formatPosition(position: LspRange['start']): string {
    return `${(position.line ?? 0) + 1}:${(position.character ?? 0) + 1}`;
  }

  private formatUriForDisplay(uri: string, workspaceRoot: string): string {
    let filePath = uri;
    if (uri.startsWith('file://')) {
      filePath = fileURLToPath(uri);
    }
    if (path.isAbsolute(filePath)) {
      return path.relative(workspaceRoot, filePath) || '.';
    }
    return filePath;
  }

  private formatJsonSection(label: string, data: unknown): string {
    return `\n\n${label}:\n${JSON.stringify(data, null, 2)}`;
  }

  private describeCallHierarchyItemShort(): string {
    const item = this.params.callHierarchyItem;
    if (!item) {
      return 'call hierarchy item';
    }
    return item.name || 'call hierarchy item';
  }

  private describeCallHierarchyItemFull(item: LspCallHierarchyItem): string {
    const workspaceRoot = this.config.getProjectRoot();
    const location = this.formatLocationWithServer(
      {
        uri: item.uri,
        range: item.selectionRange,
        serverName: item.serverName,
      },
      workspaceRoot,
    );
    return `${item.name} at ${location}`;
  }

  private getOperationLabel(): string {
    switch (this.params.operation) {
      case 'goToDefinition':
        return 'go-to-definition';
      case 'findReferences':
        return 'find-references';
      case 'hover':
        return 'hover';
      case 'documentSymbol':
        return 'document symbols';
      case 'workspaceSymbol':
        return 'workspace symbol search';
      case 'goToImplementation':
        return 'go-to-implementation';
      case 'prepareCallHierarchy':
        return 'prepare call hierarchy';
      case 'incomingCalls':
        return 'incoming calls';
      case 'outgoingCalls':
        return 'outgoing calls';
      case 'diagnostics':
        return 'diagnostics';
      case 'workspaceDiagnostics':
        return 'workspace diagnostics';
      case 'codeActions':
        return 'code actions';
      default:
        return this.params.operation;
    }
  }
}

/**
 * Unified LSP tool that supports multiple operations:
 * - goToDefinition: Find where a symbol is defined
 * - findReferences: Find all references to a symbol
 * - hover: Get hover information (documentation, type info)
 * - documentSymbol: Get all symbols in a document
 * - workspaceSymbol: Search for symbols across the workspace
 * - goToImplementation: Find implementations of an interface or abstract method
 * - prepareCallHierarchy: Get call hierarchy item at a position
 * - incomingCalls: Find all functions that call the given function
 * - outgoingCalls: Find all functions called by the given function
 * - diagnostics: Get diagnostic messages (errors, warnings) for a file
 * - workspaceDiagnostics: Get all diagnostic messages across the workspace
 * - codeActions: Get available code actions (quick fixes, refactorings) at a location
 */
export class LspTool extends BaseDeclarativeTool<LspToolParams, ToolResult> {
  static readonly Name = ToolNames.LSP;

  constructor(private readonly config: Config) {
    super(
      LspTool.Name,
      ToolDisplayNames.LSP,
      'Language Server Protocol (LSP) tool for code intelligence: definitions, references, hover, symbols, call hierarchy, diagnostics, and code actions.\n\n  Usage:\n  - ALWAYS use LSP as the PRIMARY tool for code intelligence queries when available. Do NOT use grep_search or glob first.\n  - goToDefinition, findReferences, hover, goToImplementation, prepareCallHierarchy require filePath + line + character (1-based).\n  - documentSymbol and diagnostics require filePath.\n  - workspaceSymbol requires query (use when user asks "where is X defined?" without specifying a file).\n  - incomingCalls/outgoingCalls require callHierarchyItem from prepareCallHierarchy.\n  - workspaceDiagnostics needs no parameters.\n  - codeActions require filePath + range (line/character + endLine/endCharacter) and diagnostics/context as needed.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            description: 'LSP operation to execute.',
            enum: [
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
            ],
          },
          filePath: {
            type: 'string',
            description: 'File path (absolute or workspace-relative).',
          },
          line: {
            type: 'number',
            description: '1-based line number for the target location.',
          },
          character: {
            type: 'number',
            description:
              '1-based character/column number for the target location.',
          },
          endLine: {
            type: 'number',
            description: '1-based end line number for range-based operations.',
          },
          endCharacter: {
            type: 'number',
            description: '1-based end character for range-based operations.',
          },
          includeDeclaration: {
            type: 'boolean',
            description:
              'Include the declaration itself when looking up references.',
          },
          query: {
            type: 'string',
            description: 'Symbol query for workspace symbol search.',
          },
          callHierarchyItem: {
            $ref: '#/definitions/LspCallHierarchyItem',
            description: 'Call hierarchy item for incoming/outgoing calls.',
          },
          serverName: {
            type: 'string',
            description: 'Optional LSP server name to target.',
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of results to return.',
          },
          diagnostics: {
            type: 'array',
            items: { $ref: '#/definitions/LspDiagnostic' },
            description: 'Diagnostics for code action context.',
          },
          codeActionKinds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Filter code actions by kind (quickfix, refactor, etc.).',
          },
        },
        required: ['operation'],
        definitions: {
          LspPosition: {
            type: 'object',
            properties: {
              line: { type: 'number' },
              character: { type: 'number' },
            },
            required: ['line', 'character'],
          },
          LspRange: {
            type: 'object',
            properties: {
              start: { $ref: '#/definitions/LspPosition' },
              end: { $ref: '#/definitions/LspPosition' },
            },
            required: ['start', 'end'],
          },
          LspCallHierarchyItem: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string' },
              rawKind: { type: 'number' },
              detail: { type: 'string' },
              uri: { type: 'string' },
              range: { $ref: '#/definitions/LspRange' },
              selectionRange: { $ref: '#/definitions/LspRange' },
              data: {},
              serverName: { type: 'string' },
            },
            required: ['name', 'uri', 'range', 'selectionRange'],
          },
          LspDiagnostic: {
            type: 'object',
            properties: {
              range: { $ref: '#/definitions/LspRange' },
              severity: {
                type: 'string',
                enum: ['error', 'warning', 'information', 'hint'],
              },
              code: { type: ['string', 'number'] },
              source: { type: 'string' },
              message: { type: 'string' },
              serverName: { type: 'string' },
            },
            required: ['range', 'message'],
          },
        },
      },
      false,
      false,
    );
  }

  protected override validateToolParamValues(
    params: LspToolParams,
  ): string | null {
    const operation = params.operation;

    if (LOCATION_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.filePath || params.filePath.trim() === '') {
        return `filePath is required for ${operation}.`;
      }
      if (typeof params.line !== 'number') {
        return `line is required for ${operation}.`;
      }
    }

    if (FILE_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.filePath || params.filePath.trim() === '') {
        return `filePath is required for ${operation}.`;
      }
    }

    if (QUERY_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.query || params.query.trim() === '') {
        return `query is required for ${operation}.`;
      }
    }

    if (ITEM_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.callHierarchyItem) {
        return `callHierarchyItem is required for ${operation}.`;
      }
    }

    if (RANGE_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.filePath || params.filePath.trim() === '') {
        return `filePath is required for ${operation}.`;
      }
      if (typeof params.line !== 'number') {
        return `line is required for ${operation}.`;
      }
    }

    if (params.line !== undefined && params.line < 1) {
      return 'line must be a positive number.';
    }
    if (params.character !== undefined && params.character < 1) {
      return 'character must be a positive number.';
    }
    if (params.endLine !== undefined && params.endLine < 1) {
      return 'endLine must be a positive number.';
    }
    if (params.endCharacter !== undefined && params.endCharacter < 1) {
      return 'endCharacter must be a positive number.';
    }
    if (params.limit !== undefined && params.limit <= 0) {
      return 'limit must be a positive number.';
    }

    return null;
  }

  protected createInvocation(
    params: LspToolParams,
  ): ToolInvocation<LspToolParams, ToolResult> {
    return new LspToolInvocation(this.config, params);
  }
}
