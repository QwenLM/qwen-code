/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SchemaValidator } from '../utils/schemaValidator.js';
import {
  BaseTool,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
} from './tools.js';
import { Type } from '@google/genai';
import { getErrorMessage } from '../utils/errors.js';
import { Config, ApprovalMode } from '../config/config.js';
import { fetchWithTimeout } from '../utils/fetch.js';

const RAG_FETCH_TIMEOUT_MS = 10000;

export interface RAGSearchResult {
  title: string;
  content: string;
  source: string;
  similarity_score: number;
  metadata?: any;
}

export interface RAGResponse {
  success: boolean;
  query: string;
  results: RAGSearchResult[];
  answer?: string;
  sources_used?: Array<{
    title: string;
    source: string;
    similarity_score: number;
  }>;
  timestamp: string;
  error?: string;
}

export interface RAGQueryRequest {
  query: string;
  limit?: number;
  similarity_threshold?: number;
  sources?: string[];
  generate_answer?: boolean;
}

/**
 * Parameters for the RAG tool
 */
export interface RAGToolParams {
  /**
   * The query to search in the knowledge base
   */
  query: string;
  /**
   * Maximum number of results to return (default: 5)
   */
  limit?: number;
  /**
   * Minimum similarity threshold for results (default: 0.6)
   */
  similarity_threshold?: number;
  /**
   * Filter results by specific sources
   */
  sources?: string[];
  /**
   * Whether to generate an AI answer based on search results (default: true)
   */
  generate_answer?: boolean;
}

/**
 * Implementation of the RAG (Retrieval-Augmented Generation) tool
 */
export class RAGTool extends BaseTool<RAGToolParams, ToolResult> {
  static readonly Name: string = 'rag_query';

  constructor(private readonly config: Config) {
    super(
      RAGTool.Name,
      'RAG Query',
      'Searches the RAG knowledge base for relevant information and optionally generates an AI-powered answer based on the retrieved documents. Requires RAG endpoint to be configured via --rag-endpoint, settings.json, or RAG_ENDPOINT environment variable.',
      {
        properties: {
          query: {
            description: 'The search query to find relevant information in the knowledge base',
            type: Type.STRING,
          },
          limit: {
            description: 'Maximum number of results to return (default: 5)',
            type: Type.NUMBER,
          },
          similarity_threshold: {
            description: 'Minimum similarity threshold for results (default: 0.6)',
            type: Type.NUMBER,
          },
          sources: {
            description: 'Filter results by specific sources (optional)',
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
          },
          generate_answer: {
            description: 'Whether to generate an AI answer based on search results (default: true)',
            type: Type.BOOLEAN,
          },
        },
        required: ['query'],
        type: Type.OBJECT,
      },
    );
  }

  validateParams(params: RAGToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }
    if (!params.query || params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }
    
    // Check for potential JSON-breaking characters
    try {
      JSON.stringify({ query: params.query });
    } catch (jsonError) {
      return "The 'query' parameter contains characters that cannot be JSON serialized.";
    }
    if (params.limit !== undefined && (params.limit < 1 || params.limit > 20)) {
      return "The 'limit' parameter must be between 1 and 20.";
    }
    if (params.similarity_threshold !== undefined && (params.similarity_threshold < 0 || params.similarity_threshold > 1)) {
      return "The 'similarity_threshold' parameter must be between 0 and 1.";
    }
    return null;
  }

  getDescription(params: RAGToolParams): string {
    const displayQuery = params.query.length > 50 
      ? params.query.substring(0, 47) + '...' 
      : params.query;
    return `Searching RAG knowledge base for: "${displayQuery}"`;
  }

  async shouldConfirmExecute(
    params: RAGToolParams,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT) {
      return false;
    }

    const validationError = this.validateParams(params);
    if (validationError) {
      return false;
    }

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Confirm RAG Query`,
      prompt: `Query: ${params.query}${params.sources ? `\nSources: ${params.sources.join(', ')}` : ''}`,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    params: RAGToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    const ragEndpoint = this.config.getRagEndpoint();
    if (!ragEndpoint) {
      return {
        llmContent: 'Error: RAG endpoint not configured. Please set RAG_ENDPOINT environment variable or configure ragEndpoint in settings.',
        returnDisplay: 'Error: RAG endpoint not configured.',
      };
    }

    try {
      const requestBody: RAGQueryRequest = {
        query: params.query,
        limit: params.limit || 5,
        similarity_threshold: params.similarity_threshold || 0.6,
        sources: params.sources,
        generate_answer: params.generate_answer !== false,
      };

      const requestBodyString = JSON.stringify(requestBody);
      
      if (this.config.getDebugMode()) {
        console.debug(`[RAGTool] Querying RAG endpoint: ${ragEndpoint}`);
        console.debug(`[RAGTool] Request body:`, requestBodyString);
        console.debug(`[RAGTool] Request body length:`, requestBodyString.length);
      }

      const controller = new AbortController();
      
      // Combine the provided signal with our own timeout
      if (signal) {
        signal.addEventListener('abort', () => controller.abort());
      }
      
      const timeoutId = setTimeout(() => controller.abort(), RAG_FETCH_TIMEOUT_MS);
      
      let ragResponse: RAGResponse;
      try {
        const response = await fetch(ragEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: requestBodyString,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

        const responseText = await response.text();
        
        if (!response.ok) {
          if (this.config.getDebugMode()) {
            console.debug(`[RAGTool] Error response body:`, responseText);
          }
          throw new Error(`RAG service responded with status ${response.status}: ${response.statusText}. Body: ${responseText}`);
        }

        try {
          ragResponse = JSON.parse(responseText);
        } catch (jsonError) {
          if (this.config.getDebugMode()) {
            console.debug(`[RAGTool] Invalid JSON response:`, responseText);
            console.debug(`[RAGTool] JSON parse error:`, jsonError);
          }
          throw new Error(`RAG service returned invalid JSON. Response: ${responseText.substring(0, 200)}...`);
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }

      if (this.config.getDebugMode()) {
        console.debug(`[RAGTool] RAG response:`, JSON.stringify(ragResponse, null, 2));
      }

      if (!ragResponse.success) {
        return {
          llmContent: `Error: RAG query failed. ${ragResponse.error || 'Unknown error'}`,
          returnDisplay: `Error: RAG query failed. ${ragResponse.error || 'Unknown error'}`,
        };
      }

      // Format the response for display
      let displayContent = '';
      let llmContent = '';

      if (ragResponse.answer) {
        llmContent = ragResponse.answer;
        displayContent += `## Answer\n\n${ragResponse.answer}\n\n`;
      }

      if (ragResponse.results && ragResponse.results.length > 0) {
        displayContent += `## Search Results (${ragResponse.results.length} found)\n\n`;
        
        ragResponse.results.forEach((result: RAGSearchResult, index: number) => {
          displayContent += `### ${index + 1}. ${result.title}\n`;
          displayContent += `**Source:** ${result.source}\n`;
          displayContent += `**Similarity:** ${(result.similarity_score * 100).toFixed(1)}%\n\n`;
          displayContent += `${result.content.substring(0, 300)}${result.content.length > 300 ? '...' : ''}\n\n---\n\n`;
        });

        // Add raw results to LLM content for further processing
        if (!ragResponse.answer) {
          llmContent = `Found ${ragResponse.results.length} relevant documents:\n\n`;
          ragResponse.results.forEach((result: RAGSearchResult, index: number) => {
            llmContent += `${index + 1}. ${result.title} (${result.source})\n`;
            llmContent += `${result.content}\n\n`;
          });
        }
      } else {
        const noResultsMessage = 'No relevant documents found for your query.';
        displayContent += noResultsMessage;
        if (!ragResponse.answer) {
          llmContent = noResultsMessage;
        }
      }

      if (ragResponse.sources_used && ragResponse.sources_used.length > 0) {
        displayContent += `\n## Sources Used\n\n`;
        ragResponse.sources_used.forEach((source: { title: string; source: string; similarity_score: number }, index: number) => {
          displayContent += `${index + 1}. ${source.title} (${source.source}) - ${(source.similarity_score * 100).toFixed(1)}%\n`;
        });
      }

      return {
        llmContent,
        returnDisplay: displayContent,
      };

    } catch (error: unknown) {
      const errorMessage = `Error querying RAG service: ${getErrorMessage(error)}`;
      console.error(`[RAGTool] ${errorMessage}`, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }
}