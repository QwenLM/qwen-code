/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolResult,
} from './tools.js';
import { FunctionDeclaration } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

const ragToolSchemaData: FunctionDeclaration = {
  name: 'rag_search',
  description:
    'Searches the RAG (Retrieval Augmented Generation) system for information. This tool integrates with the user\'s local RAG system to search through knowledge bases, code collections, and documentation.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to find relevant information',
      },
      collection: {
        type: 'string',
        description: 'Optional: specific collection to search. If not provided, searches default collections',
      },
      limit: {
        type: 'number',
        description: 'Optional: maximum number of results to return (default: 5)',
        minimum: 1,
        maximum: 20,
      },
      file_filter: {
        type: 'string',
        description: 'Optional: filter by file extensions (e.g., "py,js,md")',
      },
    },
    required: ['query'],
  },
};

const ragToolDescription = `
Searches the RAG (Retrieval Augmented Generation) system for information.

This tool provides direct access to the user's local RAG system, allowing you to:
- Search through code collections and knowledge bases
- Find relevant documentation and examples
- Access project-specific information
- Retrieve context for complex queries

The RAG system supports various search modes:
- Basic search: \`rag "your query"\`
- Collection-specific: \`rag collection-name "your query"\`
- Knowledge base: \`ragkb "your query"\`
- With filters: supports file type filtering and result limits

This is more efficient than external MCP servers and provides immediate access to local knowledge.
`;

interface RAGToolParams {
  query: string;
  collection?: string;
  limit?: number;
  file_filter?: string;
}

class RAGToolInvocation extends BaseToolInvocation<RAGToolParams, ToolResult> {

  getDescription(): string {
    let description = `RAG search: "${this.params.query}"`;
    if (this.params.collection) {
      description += ` in collection "${this.params.collection}"`;
    }
    if (this.params.limit) {
      description += ` (limit: ${this.params.limit})`;
    }
    return description;
  }

  private formatRAGResults(results: string, query: string, collection?: string): string {
    if (!results || results.trim() === '') {
      return `┌─ 🔍 RAG Search Results ─┐
│ No results found         │
└──────────────────────────┘`;
    }

    const collectionText = collection ? ` from "${collection}"` : '';
    const header = `┌─ 🔍 RAG Search: "${query}"${collectionText} ─┐`;
    const footer = `└${'─'.repeat(header.length - 2)}┘`;
    
    // Add border to each line of results
    const lines = results.split('\n');
    const borderedLines = lines.map(line => `│ ${line.padEnd(header.length - 4)} │`);
    
    return `${header}\n${borderedLines.join('\n')}\n${footer}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { query, collection, limit, file_filter } = this.params;

    try {
      let command: string;
      
      if (collection) {
        // Search specific collection
        command = `rag ${collection} "${query}"`;
      } else {
        // Default search or knowledge base search
        command = `rag "${query}"`;
      }

      // Add optional parameters
      if (limit) {
        command += ` --topk ${limit}`;
      }
      
      if (file_filter) {
        command += ` --files ${file_filter}`;
      }

      let stdout = '';
      let stderr = '';
      let success = false;
      
      const handle = ShellExecutionService.execute(
        command,
        process.cwd(),
        (event) => {
          if (event.type === 'data') {
            if (event.stream === 'stdout') {
              stdout += event.chunk;
            } else {
              stderr += event.chunk;
            }
          }
        },
        signal,
      );
      
      const executionResult = await handle.result;
      success = executionResult.exitCode === 0;

      if (success) {
        const formattedResults = this.formatRAGResults(stdout, query, collection);
        return {
          llmContent: JSON.stringify({
            success: true,
            results: stdout,
            query,
            collection: collection || 'default',
          }),
          returnDisplay: formattedResults,
        };
      } else {
        // Fallback to knowledge base search if specific collection fails
        if (collection && stderr?.includes('not found')) {
          const fallbackCommand = `ragkb "${query}"`;
          let fallbackStdout = '';
          let _fallbackStderr = '';
          
          const fallbackHandle = ShellExecutionService.execute(
            fallbackCommand,
            process.cwd(),
            (event) => {
              if (event.type === 'data') {
                if (event.stream === 'stdout') {
                  fallbackStdout += event.chunk;
                } else {
                  _fallbackStderr += event.chunk;
                }
              }
            },
            signal,
          );
          
          const fallbackResult = await fallbackHandle.result;
          
          if (fallbackResult.exitCode === 0) {
            return {
              llmContent: JSON.stringify({
                success: true,
                results: fallbackStdout,
                query,
                collection: 'knowledge-base (fallback)',
                note: `Collection "${collection}" not found, searched knowledge base instead`,
              }),
              returnDisplay: this.formatRAGResults(fallbackStdout, query, 'knowledge-base (fallback)'),
            };
          }
        }

        const errorMessage = stderr || 'RAG search failed';
        return {
          llmContent: JSON.stringify({
            success: false,
            error: errorMessage,
            query,
          }),
          returnDisplay: `RAG search error: ${errorMessage}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: JSON.stringify({
          success: false,
          error: errorMessage,
          query,
        }),
        returnDisplay: `RAG search failed: ${errorMessage}`,
      };
    }
  }
}

export class RAGTool extends BaseDeclarativeTool<RAGToolParams, ToolResult> {
  static readonly Name: string = ragToolSchemaData.name!;

  constructor() {
    super(
      RAGTool.Name,
      'RAG Search',
      ragToolDescription,
      Kind.Read,
      ragToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  override validateToolParams(params: RAGToolParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    if (!params.query || params.query.trim() === '') {
      return 'Query parameter is required and cannot be empty';
    }

    return null;
  }

  protected createInvocation(params: RAGToolParams) {
    return new RAGToolInvocation(params);
  }
}