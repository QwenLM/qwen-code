/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { LspSymbolInformation } from '../lsp/types.js';

export interface LspWorkspaceSymbolParams {
  /**
   * Query string to search symbols (e.g., function or class name).
   */
  query: string;
  /**
   * Maximum number of results to return.
   */
  limit?: number;
}

class LspWorkspaceSymbolInvocation extends BaseToolInvocation<
  LspWorkspaceSymbolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: LspWorkspaceSymbolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `LSP workspace symbol search（按名称找定义/实现/引用） for "${this.params.query}"`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const client = this.config.getLspClient();
    if (!client || !this.config.isLspEnabled()) {
      const message =
        'LSP workspace symbol search is unavailable (LSP disabled or not initialized).';
      return { llmContent: message, returnDisplay: message };
    }

    const limit = this.params.limit ?? 20;
    let symbols: LspSymbolInformation[] = [];
    try {
      symbols = await client.workspaceSymbols(this.params.query, limit);
    } catch (error) {
      const message = `LSP workspace symbol search failed: ${
        (error as Error)?.message || String(error)
      }`;
      return { llmContent: message, returnDisplay: message };
    }

    if (!symbols.length) {
      const message = `No symbols found for query "${this.params.query}".`;
      return { llmContent: message, returnDisplay: message };
    }

    const workspaceRoot = this.config.getProjectRoot();
    const lines = symbols.slice(0, limit).map((symbol, index) => {
      const location = this.formatLocation(symbol, workspaceRoot);
      const serverSuffix = symbol.serverName
        ? ` [${symbol.serverName}]`
        : '';
      const kind = symbol.kind ? ` (${symbol.kind})` : '';
      const container = symbol.containerName
        ? ` in ${symbol.containerName}`
        : '';
      return `${index + 1}. ${symbol.name}${kind}${container} - ${location}${serverSuffix}`;
    });

    const heading = `Found ${Math.min(symbols.length, limit)} of ${
      symbols.length
    } symbols for query "${this.params.query}":`;

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
            const location = this.formatLocation(
              { location: ref, name: '', kind: undefined },
              workspaceRoot,
            );
            const serverSuffix = ref.serverName
              ? ` [${ref.serverName}]`
              : '';
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

  private formatLocation(symbol: LspSymbolInformation, workspaceRoot: string) {
    const { uri, range } = symbol.location;
    let filePath = uri;
    if (uri.startsWith('file://')) {
      filePath = fileURLToPath(uri);
      filePath = path.relative(workspaceRoot, filePath) || '.';
    }
    const line = (range.start.line ?? 0) + 1;
    const character = (range.start.character ?? 0) + 1;
    return `${filePath}:${line}:${character}`;
  }
}

export class LspWorkspaceSymbolTool extends BaseDeclarativeTool<
  LspWorkspaceSymbolParams,
  ToolResult
> {
  static readonly Name = ToolNames.LSP_WORKSPACE_SYMBOL;

  constructor(private readonly config: Config) {
    super(
      LspWorkspaceSymbolTool.Name,
      ToolDisplayNames.LSP_WORKSPACE_SYMBOL,
      'Search workspace symbols via LSP（查找定义/实现/引用，按名称定位符号，优先于 grep）。',
      Kind.Other,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Symbol name query, e.g., function/class/variable name to search.',
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of results to return.',
          },
        },
        required: ['query'],
      },
      false,
      false,
    );
  }

  protected createInvocation(
    params: LspWorkspaceSymbolParams,
  ): ToolInvocation<LspWorkspaceSymbolParams, ToolResult> {
    return new LspWorkspaceSymbolInvocation(this.config, params);
  }
}
