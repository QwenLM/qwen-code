/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { getErrorMessage } from '../utils/errors.js';
import type { RetrievalService } from '../indexing/retrievalService.js';
import { ToolErrorType } from './tool-error.js';

// --- Interfaces ---

/**
 * Parameters for the CodebaseSearchTool.
 */
export interface CodebaseSearchToolParams {
  /**
   * Pre-enhanced BM25 keyword queries for full-text search.
   * Each query should contain space-separated identifiers and keywords
   * (camelCase, snake_case, PascalCase) relevant to the search intent.
   */
  bm25Queries: string[];

  /**
   * Pre-enhanced vector/semantic queries for embedding-based search.
   * Should include hypothetical code snippets (HyDE) and/or semantic
   * descriptions of the desired functionality.
   */
  vectorQueries: string[];

  /**
   * Number of results to return. Defaults to 10.
   */
  topK?: number;

  /**
   * Whether the query is related to test code (unit tests, integration tests,
   * test fixtures, mocks, etc.). When true, the test-file penalty is skipped
   * so that test files rank normally in the results.
   */
  isTestRelated?: boolean;
}

// --- Constants ---

const MAX_TOP_K = 30;
const DEFAULT_TOP_K = 10;

const TOOL_DESCRIPTION = `Semantic code search over the codebase index using hybrid BM25 + vector retrieval with reranking and graph expansion.

Use this tool when:
- You need to understand HOW something is implemented, not just find an exact string
- You want to find code related to a concept, pattern, or functionality
- You don't know the exact identifier name but can describe what you're looking for

Do NOT use this tool when:
- You know the exact function/variable/string → use grep_search instead
- You need to find files by name → use glob instead

## bm25Queries (keyword / full-text search)
Provide 3-6 keyword queries. Each query is space-separated tokens.

1. **Exact identifiers** — Extract exact function, method, class, variable, type, and module names that likely appear in source code. Preserve casing conventions (camelCase, snake_case, PascalCase, SCREAMING_SNAKE_CASE). Include file path patterns and import paths if relevant.
   Example: "handleUserAuth middleware express", "JwtTokenVerifier verify"
2. **Query Decomposition (for complex queries)** — Break the original query into 2-4 focused sub-queries (3-8 words each, keyword style). Each sub-query targets a distinct aspect.
   Example for "How does the auth middleware validate JWT tokens and handle expired sessions":
   - "auth middleware JWT validate"
   - "expired session handling"
   - "token expiration error"
3. **Step-Back query** — One abstract/general query (3-8 words) that captures the high-level concept behind the question.
   Example: "authentication authorization middleware pattern"

## vectorQueries (semantic / embedding search)
Provide 2-4 queries. The first should be a HyDE code snippet; the rest are semantic variations.

1. **HyDE (Hypothetical Document Embedding)** — Write a REALISTIC 5-15 line code snippet that resembles code you expect to find in the codebase. Rules:
   - NO comments, NO docstrings, NO explanatory text — just raw code
   - Use realistic naming conventions that the codebase likely uses
   - Include function signatures, class definitions, import statements, or implementation patterns
   - Must look like actual source code, not pseudocode
   Example:
   \`\`\`
   async function verifyJwtToken(token: string): Promise<TokenPayload> {
     const decoded = jwt.verify(token, config.jwtSecret);
     if (decoded.exp < Date.now() / 1000) {
       throw new TokenExpiredError('Token has expired');
     }
     return decoded as TokenPayload;
   }
   \`\`\`
2. **Semantic variations** — 1-3 alternative phrasings of the query (5-12 words each), using different vocabulary to describe the same concept.
   Example: "middleware that checks authentication tokens before request processing"

## topK
Number of results to return (default 10, max 30).

## isTestRelated
Set to true when the query is specifically about test code (unit tests, integration tests, test utilities, mocks, fixtures). This ensures test files are not penalized in the results.
`;

const PARAMETER_SCHEMA = {
  type: 'object',
  properties: {
    bm25Queries: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Pre-enhanced BM25 keyword queries. Each should contain space-separated ' +
        'identifiers and keywords (camelCase, snake_case) relevant to the search intent.',
    },
    vectorQueries: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Pre-enhanced vector/semantic queries. Include hypothetical code snippets ' +
        '(5-10 lines) and/or semantic descriptions of the desired functionality.',
    },
    topK: {
      type: 'number',
      description: `Number of results to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`,
    },
    isTestRelated: {
      type: 'boolean',
      description:
        'Set to true when the query is about test code (unit tests, integration tests, ' +
        'test utilities, mocks, fixtures). Prevents test files from being penalized in results.',
    },
  },
  required: ['bm25Queries', 'vectorQueries'],
} as const;

// --- Invocation ---

/**
 * Provider function that returns a {@link RetrievalService} instance.
 * Returns `null` when the index is not ready (should not happen because the
 * tool is only registered after the index is built).
 */
export type RetrievalServiceProvider = () => Promise<RetrievalService | null>;

class CodebaseSearchInvocation extends BaseToolInvocation<
  CodebaseSearchToolParams,
  ToolResult
> {
  constructor(
    private readonly getRetrievalService: RetrievalServiceProvider,
    params: CodebaseSearchToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const bm25Summary = this.params.bm25Queries.map((q) => `'${q}'`).join(', ');
    const vectorSummary = this.params.vectorQueries
      .map((q) => `'${q.slice(0, 60)}${q.length > 60 ? '...' : ''}'`)
      .join(', ');
    return `bm25=[${bm25Summary}] vector=[${vectorSummary}] topK=${this.params.topK ?? DEFAULT_TOP_K}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    // Abort-early check.
    if (signal.aborted) {
      return {
        llmContent: 'Search was cancelled.',
        returnDisplay: 'Cancelled',
      };
    }

    try {
      const service = await this.getRetrievalService();
      if (!service) {
        return {
          llmContent:
            'Error: Codebase index is not available. ' +
            'The index may still be building or was not initialized.',
          returnDisplay: 'Index not available',
          error: {
            message: 'Codebase index is not available',
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      const topK = Math.min(
        Math.max(this.params.topK ?? DEFAULT_TOP_K, 1),
        MAX_TOP_K,
      );

      // Build a composite query for the reranker from BM25 keywords.
      const rerankQuery = this.params.bm25Queries.join(' ');

      const response = await service.retrieveWithEnhancedQueries(
        rerankQuery,
        this.params.bm25Queries,
        this.params.vectorQueries,
        { topK, isTestRelated: this.params.isTestRelated ?? false },
      );

      if (response.chunks.length === 0) {
        return {
          llmContent: 'No results found for the given queries.',
          returnDisplay: 'No results found',
        };
      }

      // Use the pre-built text view from the retrieval pipeline.
      const resultCount = response.chunks.length;
      const resultTerm = resultCount === 1 ? 'result' : 'results';

      return {
        llmContent: response.textView,
        returnDisplay: `Found ${resultCount} ${resultTerm}`,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error(`Error during codebase search: ${error}`);
      return {
        llmContent: `Error during codebase search: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

// --- Tool ---

/**
 * Semantic code search tool that leverages the codebase index for hybrid
 * BM25 + vector retrieval with reranking and graph expansion.
 *
 * This tool should only be registered when the codebase index is built and
 * ready. Registration is managed by {@link Config} which listens to the
 * IndexService `build_complete` event.
 */
export class CodebaseSearchTool extends BaseDeclarativeTool<
  CodebaseSearchToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.CODEBASE_SEARCH;

  constructor(private readonly getRetrievalService: RetrievalServiceProvider) {
    super(
      CodebaseSearchTool.Name,
      ToolDisplayNames.CODEBASE_SEARCH,
      TOOL_DESCRIPTION,
      Kind.Search,
      PARAMETER_SCHEMA,
    );
  }

  protected override validateToolParamValues(
    params: CodebaseSearchToolParams,
  ): string | null {
    if (!params.bm25Queries || params.bm25Queries.length === 0) {
      return 'bm25Queries must be a non-empty array of strings.';
    }
    if (!params.vectorQueries || params.vectorQueries.length === 0) {
      return 'vectorQueries must be a non-empty array of strings.';
    }
    if (
      params.topK !== undefined &&
      (typeof params.topK !== 'number' || params.topK < 1)
    ) {
      return `topK must be a positive number (got ${params.topK}).`;
    }
    return null;
  }

  protected createInvocation(
    params: CodebaseSearchToolParams,
  ): ToolInvocation<CodebaseSearchToolParams, ToolResult> {
    return new CodebaseSearchInvocation(this.getRetrievalService, params);
  }
}
