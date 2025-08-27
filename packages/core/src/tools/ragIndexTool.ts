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

const ragIndexToolSchemaData: FunctionDeclaration = {
  name: 'rag_index',
  description:
    'Creates or updates a RAG (Retrieval Augmented Generation) collection by indexing documents from a specified path. This tool integrates with the user\'s local RAG system to create searchable collections of documents and code. Collection names are automatically derived from the indexed path.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The absolute path to the directory or files to index',
      },
      confirm: {
        type: 'boolean',
        description: 'Optional: bypass interactive confirmation (default: false)',
        default: false,
      },
      extensions: {
        type: 'string',
        description: 'Optional: comma-separated list of file extensions to include (e.g., "py,js,md")',
      },
      sync_registry: {
        type: 'boolean',
        description: 'Optional: sync registry after indexing (default: false)',
        default: false,
      },
    },
    required: ['path'],
  },
};

const ragIndexToolDescription = `
Creates or updates a RAG (Retrieval Augmented Generation) collection by indexing documents.

This tool provides direct access to the user's local RAG indexing system, allowing you to:
- Index directories and files to create searchable collections
- Update existing collections with new content
- Create project-specific knowledge bases
- Index code repositories for semantic search

The RAG indexing system supports:
- Automatic collection naming based on source path
- Custom file type filtering
- Non-interactive mode for automated workflows
- Incremental updates for existing collections

Usage patterns:
- Basic indexing: \`rag-index create /path/to/project --confirm\`
- With extensions: \`rag-index create /path/to/code --extensions py,js,ts --confirm\`
- With registry sync: \`rag-index create /path/to/project --confirm --sync-registry\`

This creates collections that can be searched using the RAG search tool.
`;

interface RAGIndexToolParams {
  path: string;
  confirm?: boolean;
  extensions?: string;
  sync_registry?: boolean;
}

class RAGIndexToolInvocation extends BaseToolInvocation<RAGIndexToolParams, ToolResult> {

  getDescription(): string {
    let description = `RAG index: "${this.params.path}"`;
    if (this.params.extensions) {
      description += ` (${this.params.extensions} files)`;
    }
    if (this.params.sync_registry) {
      description += ` with registry sync`;
    }
    return description;
  }

  private formatIndexResults(results: string, path: string): string {
    if (!results || results.trim() === '') {
      return `┌─ 📊 RAG Index Results ─┐
│ No output received       │
└──────────────────────────┘`;
    }

    const header = `┌─ 📊 RAG Index: "${path}" ─┐`;
    const footer = `└${'─'.repeat(Math.max(header.length - 2, 10))}┘`;
    
    // Add border to each line of results
    const lines = results.split('\n').filter(line => line.trim() !== '');
    const maxLineLength = Math.max(header.length - 4, ...lines.map(l => l.length));
    const borderedLines = lines.map(line => `│ ${line.padEnd(maxLineLength)} │`);
    
    return `${header}\n${borderedLines.join('\n')}\n${footer}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { path, confirm, extensions, sync_registry } = this.params;

    try {
      let command = `rag-index create ${path}`;
      
      // Add optional parameters
      if (confirm) {
        command += ` --confirm`;
      }
      
      if (extensions) {
        command += ` --extensions ${extensions}`;
      }
      
      if (sync_registry) {
        command += ` --sync-registry`;
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
        const formattedResults = this.formatIndexResults(stdout, path);
        return {
          llmContent: JSON.stringify({
            success: true,
            output: stdout,
            path,
            command_executed: command,
          }),
          returnDisplay: formattedResults,
        };
      } else {
        const errorMessage = stderr || 'RAG indexing failed';
        return {
          llmContent: JSON.stringify({
            success: false,
            error: errorMessage,
            path,
            command_executed: command,
          }),
          returnDisplay: `RAG indexing error: ${errorMessage}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: JSON.stringify({
          success: false,
          error: errorMessage,
          path,
        }),
        returnDisplay: `RAG indexing failed: ${errorMessage}`,
      };
    }
  }
}

export class RAGIndexTool extends BaseDeclarativeTool<RAGIndexToolParams, ToolResult> {
  static readonly Name: string = ragIndexToolSchemaData.name!;

  constructor() {
    super(
      RAGIndexTool.Name,
      'RAG Index',
      ragIndexToolDescription,
      Kind.Execute,
      ragIndexToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  override validateToolParams(params: RAGIndexToolParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    if (!params.path || params.path.trim() === '') {
      return 'Path parameter is required and cannot be empty';
    }

    // Validate that path looks reasonable
    if (!params.path.startsWith('/')) {
      return 'Path must be an absolute path starting with /';
    }

    return null;
  }

  protected createInvocation(params: RAGIndexToolParams) {
    return new RAGIndexToolInvocation(params);
  }
}