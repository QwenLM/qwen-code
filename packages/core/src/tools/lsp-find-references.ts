/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type {
  LspClient,
  LspLocation,
  LspReference,
} from '../lsp/types.js';

export interface LspFindReferencesParams {
  /**
   * Symbol name to resolve if a file/position is not provided.
   */
  symbol?: string;
  /**
   * File path (absolute or workspace-relative).
   * Use together with `line` (1-based) and optional `character` (1-based).
   */
  file?: string;
  /**
   * File URI (e.g., file:///path/to/file).
   * Use together with `line` (1-based) and optional `character` (1-based).
   */
  uri?: string;
  /**
   * 1-based line number when targeting a specific file location.
   */
  line?: number;
  /**
   * 1-based character/column number when targeting a specific file location.
   */
  character?: number;
  /**
   * Whether to include the declaration in results (default: false).
   */
  includeDeclaration?: boolean;
  /**
   * Optional server name override.
   */
  serverName?: string;
  /**
   * Optional maximum number of results.
   */
  limit?: number;
}

type ResolvedTarget =
  | {
      location: LspLocation;
      description: string;
      serverName?: string;
      fromSymbol: boolean;
    }
  | { error: string };

class LspFindReferencesInvocation extends BaseToolInvocation<
  LspFindReferencesParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: LspFindReferencesParams,
  ) {
    super(params);
  }

  getDescription(): string {
    if (this.params.symbol) {
      return `LSP find-references（查引用） for symbol "${this.params.symbol}"`;
    }
    if (this.params.file && this.params.line !== undefined) {
      return `LSP find-references（查引用） at ${this.params.file}:${this.params.line}:${this.params.character ?? 1}`;
    }
    if (this.params.uri && this.params.line !== undefined) {
      return `LSP find-references（查引用） at ${this.params.uri}:${this.params.line}:${this.params.character ?? 1}`;
    }
    return 'LSP find-references（查引用）';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const client = this.config.getLspClient();
    if (!client || !this.config.isLspEnabled()) {
      const message =
        'LSP find-references is unavailable (LSP disabled or not initialized).';
      return { llmContent: message, returnDisplay: message };
    }

    const target = await this.resolveTarget(client);
    if ('error' in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }

    const limit = this.params.limit ?? 50;
    let references: LspReference[] = [];
    try {
      references = await client.references(
        target.location,
        target.serverName,
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
    const lines = references.slice(0, limit).map((reference, index) => {
      return `${index + 1}. ${this.formatLocation(reference, workspaceRoot)}`;
    });

    const heading = `References for ${target.description}:`;
    return {
      llmContent: [heading, ...lines].join('\n'),
      returnDisplay: lines.join('\n'),
    };
  }

  private async resolveTarget(
    client: Pick<LspClient, 'workspaceSymbols'>,
  ): Promise<ResolvedTarget> {
    const workspaceRoot = this.config.getProjectRoot();
    const lineProvided = typeof this.params.line === 'number';
    const character = this.params.character ?? 1;

    if ((this.params.file || this.params.uri) && lineProvided) {
      const uri = this.resolveUri(workspaceRoot);
      if (!uri) {
        return {
          error:
            'A valid file path or URI is required when specifying a line/character.',
        };
      }
      const position = {
        line: Math.max(0, Math.floor((this.params.line ?? 1) - 1)),
        character: Math.max(0, Math.floor(character - 1)),
      };
      const location: LspLocation = {
        uri,
        range: { start: position, end: position },
      };
      const description = this.formatLocation(
        { ...location, serverName: this.params.serverName },
        workspaceRoot,
      );
      return {
        location,
        description,
        serverName: this.params.serverName,
        fromSymbol: false,
      };
    }

    if (this.params.symbol) {
      try {
        const symbols = await client.workspaceSymbols(this.params.symbol, 5);
        if (!symbols.length) {
          return {
            error: `No symbols found for query "${this.params.symbol}".`,
          };
        }
        const top = symbols[0];
        return {
          location: top.location,
          description: `symbol "${this.params.symbol}"`,
          serverName: this.params.serverName ?? top.serverName,
          fromSymbol: true,
        };
      } catch (error) {
        return {
          error: `Workspace symbol search failed: ${
            (error as Error)?.message || String(error)
          }`,
        };
      }
    }

    return {
      error:
        'Provide a symbol name or a file plus line (and optional character) to use find-references.',
    };
  }

  private resolveUri(workspaceRoot: string): string | null {
    if (this.params.uri) {
      if (
        this.params.uri.startsWith('file://') ||
        this.params.uri.includes('://')
      ) {
        return this.params.uri;
      }
      const absoluteUriPath = path.isAbsolute(this.params.uri)
        ? this.params.uri
        : path.resolve(workspaceRoot, this.params.uri);
      return pathToFileURL(absoluteUriPath).toString();
    }

    if (this.params.file) {
      const absolutePath = path.isAbsolute(this.params.file)
        ? this.params.file
        : path.resolve(workspaceRoot, this.params.file);
      return pathToFileURL(absolutePath).toString();
    }

    return null;
  }

  private formatLocation(
    location: LspReference | (LspLocation & { serverName?: string }),
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
}

export class LspFindReferencesTool extends BaseDeclarativeTool<
  LspFindReferencesParams,
  ToolResult
> {
  static readonly Name = ToolNames.LSP_FIND_REFERENCES;

  constructor(private readonly config: Config) {
    super(
      LspFindReferencesTool.Name,
      ToolDisplayNames.LSP_FIND_REFERENCES,
      'Use LSP find-references for a symbol or a specific file location（查引用，优先于 grep 搜索）。',
      Kind.Other,
      {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description:
              'Symbol name to resolve when a file/position is not provided.',
          },
          file: {
            type: 'string',
            description:
              'File path (absolute or workspace-relative). Requires `line`.',
          },
          uri: {
            type: 'string',
            description:
              'File URI (file:///...). Requires `line` when provided.',
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
          includeDeclaration: {
            type: 'boolean',
            description:
              'Include the declaration itself when looking up references.',
          },
          serverName: {
            type: 'string',
            description: 'Optional LSP server name to target.',
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of results to return.',
          },
        },
      },
      false,
      false,
    );
  }

  protected createInvocation(
    params: LspFindReferencesParams,
  ): ToolInvocation<LspFindReferencesParams, ToolResult> {
    return new LspFindReferencesInvocation(this.config, params);
  }
}
