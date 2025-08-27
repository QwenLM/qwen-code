/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, Kind, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import { spawn } from 'node:child_process';

/**
 * Parameters for the WebscraperTool.
 */
export interface WebscraperToolParams {
  /**
   * The search query (for search operations).
   */
  query?: string;
  /**
   * Direct URL to scrape.
   */
  url?: string;
  /**
   * Number of search results to process (default: 10, max: 20).
   */
  results?: number;
  /**
   * Search only mode - returns URLs without content extraction.
   */
  searchOnly?: boolean;
  /**
   * Topic for semantic filtering during search.
   */
  topic?: string;
  /**
   * Topic relevance threshold (0.0-1.0, default: 0.5).
   */
  topicThreshold?: number;
  /**
   * Output directory for scraped content (markdown files).
   */
  output?: string;
  /**
   * Output results as JSON (default: true for tool integration).
   */
  jsonOutput?: boolean;
}

/**
 * Extends ToolResult to include sources for webscraper results.
 */
export interface WebscraperToolResult extends ToolResult {
  sources?: Array<{
    url: string;
    title: string;
    description: string;
    domain: string;
    quality_score: number;
    source: string;
  }>;
  operation?: string;
  results_count?: number;
}

/**
 * Advanced web scraping and search tool using WebScraperPortable.
 * Provides comprehensive web search with optional content extraction,
 * semantic filtering, and quality scoring.
 */
export class WebscraperTool extends BaseTool<
  WebscraperToolParams,
  WebscraperToolResult
> {
  static readonly Name: string = 'webscraper';

  constructor() {
    super(
      WebscraperTool.Name,
      'WebScraperPortable',
      'Advanced web scraping and search tool with semantic analysis capabilities. Can perform web searches with quality scoring, extract content from URLs, apply semantic filtering, and provide structured results. Supports both search-only mode for quick URL discovery and full scraping for content extraction.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query to find information on the web. Use this for web search operations.',
          },
          url: {
            type: 'string',
            description: 'Direct URL to scrape content from. Use this for scraping specific pages.',
          },
          results: {
            type: 'number',
            description: 'Number of search results to process (default: 10, max: 20).',
            minimum: 1,
            maximum: 20,
            default: 10,
          },
          searchOnly: {
            type: 'boolean',
            description: 'If true, performs search and returns URLs with metadata only (no content extraction). Faster for discovery operations.',
            default: false,
          },
          topic: {
            type: 'string',
            description: 'Topic for semantic filtering. When provided, results are filtered for relevance to this topic.',
          },
          topicThreshold: {
            type: 'number',
            description: 'Topic relevance threshold (0.0-1.0, default: 0.5). Higher values = more strict filtering.',
            minimum: 0.0,
            maximum: 1.0,
            default: 0.5,
          },
          output: {
            type: 'string',
            description: 'Output directory for scraped content (markdown files). Defaults to current working directory (no subfolders created).',
          },
          jsonOutput: {
            type: 'boolean',
            description: 'Output results as structured JSON (default: true).',
            default: true,
          },
        },
        anyOf: [
          { required: ['query'] },
          { required: ['url'] }
        ],
      },
    );
  }

  /**
   * Validates the parameters for the WebscraperTool.
   */
  validateParams(params: WebscraperToolParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    // Must have either query or url
    if (!params.query && !params.url) {
      return "Either 'query' (for search) or 'url' (for direct scraping) parameter is required.";
    }

    // Cannot have both query and url
    if (params.query && params.url) {
      return "Cannot specify both 'query' and 'url' parameters. Use one or the other.";
    }

    if (params.query && params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }

    if (params.url && params.url.trim() === '') {
      return "The 'url' parameter cannot be empty.";
    }

    return null;
  }

  override getDescription(params: WebscraperToolParams): string {
    if (params.query) {
      let description = `Web search: "${params.query}"`;
      if (params.searchOnly) {
        description += ' (URLs only)';
      } else {
        description += ' (with content extraction)';
      }
      if (params.results) {
        description += ` (${params.results} results)`;
      }
      if (params.topic) {
        description += ` filtered by topic: "${params.topic}"`;
      }
      return description;
    } else if (params.url) {
      return `Web scrape: "${params.url}"`;
    }
    return 'Web operation';
  }

  async execute(
    params: WebscraperToolParams,
    _signal: AbortSignal,
  ): Promise<WebscraperToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters. ${validationError}`,
        returnDisplay: validationError,
      };
    }

    try {
      // Build webscraper command for streaming execution
      const { command, args } = this.buildStreamingCommand(params);
      
      return new Promise<WebscraperToolResult>((resolve, reject) => {
        let jsonOutput = '';
        let progressOutput = '';
        let isComplete = false;
        
        // Start webscraper process
        const process = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Handle stdout (JSON output with embedded progress)
        process.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          jsonOutput += chunk;
        });

        // Handle stderr (progress messages - stream these live)
        process.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          progressOutput += chunk;
          // Stream progress messages to console in real-time
          console.log(chunk.toString().trim());
        });

        // Handle process completion
        process.on('close', (code: number) => {
          if (isComplete) return; // Avoid double processing
          isComplete = true;
          
          if (code === 0) {
            // Parse the JSON output with embedded progress tracking
            try {
              // Clean up progress bars and other non-JSON content from stdout
              const cleanJson = this.extractJsonFromOutput(jsonOutput);
              const response = JSON.parse(cleanJson);
              
              // Use the embedded progress information and structured data
              const result = this.processEnhancedResponse(response, params);
              resolve(result);
              
            } catch (parseError) {
              // JSON parsing failed, fall back to parsing progress output
              const fallbackResult = this.parseProgressOutput(progressOutput, params);
              resolve(fallbackResult);
            }
          } else {
            reject(new Error(`Webscraper process exited with code ${code}. Progress: ${progressOutput}`));
          }
        });

        // Handle process errors
        process.on('error', (error: Error) => {
          if (isComplete) return;
          isComplete = true;
          reject(new Error(`Failed to start webscraper process: ${error.message}`));
        });

        // Set up timeout
        const timeout = setTimeout(() => {
          if (!isComplete) {
            isComplete = true;
            process.kill('SIGTERM');
            reject(new Error('Webscraper operation timed out after 2 minutes'));
          }
        }, 120000); // 2 minute timeout

        // Clear timeout when process completes
        process.on('close', () => {
          clearTimeout(timeout);
        });
      });

    } catch (error: unknown) {
      const errorMessage = `Webscraper execution failed: ${getErrorMessage(error)}`;
      console.error(errorMessage, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Webscraper operation failed.`,
      };
    }
  }

  private extractJsonFromOutput(output: string): string {
    // Remove progress bars and other terminal output from stdout
    // Look for the first '{' and take everything from there
    const firstBraceIndex = output.indexOf('{');
    if (firstBraceIndex === -1) {
      throw new Error('No JSON found in output');
    }
    
    // Extract from first brace to end, then find the last complete JSON object
    const jsonPart = output.substring(firstBraceIndex);
    
    // Find the last '}' to get complete JSON
    const lastBraceIndex = jsonPart.lastIndexOf('}');
    if (lastBraceIndex === -1) {
      throw new Error('Incomplete JSON in output');
    }
    
    return jsonPart.substring(0, lastBraceIndex + 1).trim();
  }

  private buildStreamingCommand(params: WebscraperToolParams): { command: string; args: string[] } {
    const args: string[] = [];

    // Add primary operation
    if (params.query) {
      args.push('--search', params.query);
      
      if (params.searchOnly) {
        args.push('--search-only');
      }
      
      if (params.results) {
        args.push('--search-results', params.results.toString());
      }
    } else if (params.url) {
      args.push('--url', params.url);
    }

    // Add semantic filtering options
    if (params.topic) {
      args.push('--topic', params.topic);
    }
    
    if (params.topicThreshold !== undefined) {
      args.push('--topic-threshold', params.topicThreshold.toString());
    }

    // Add output directory for markdown files (default to current working directory)
    // Use absolute path to ensure files are created in QwenCode's working directory
    const outputDir = params.output ? params.output : process.cwd();
    args.push('--output', outputDir);

    // Use the enhanced JSON output with embedded progress tracking
    args.push('--json-output');

    return { command: 'webscraper', args };
  }


  private processEnhancedResponse(response: any, params: WebscraperToolParams): WebscraperToolResult {
    // Extract progress information
    const progress = response.progress || {};
    const operation = response.operation || 'unknown';
    const resultsCount = response.results_count || 0;
    
    // Build content based on operation type and progress
    let content = '';
    let displayMessage = '';
    
    if (progress.completed) {
      if (operation === 'search_only') {
        content = `Web search completed for "${response.query || params.query}".\n\n`;
        content += `Found ${resultsCount} results from web search APIs.\n\n`;
        if (progress.details) {
          content += `Details: ${progress.details}\n`;
        }
        if (progress.duration) {
          content += `Completed in ${progress.duration} seconds.\n`;
        }
        displayMessage = `Search completed: ${resultsCount} results found.`;
        
        // Include search results if available
        if (response.results && Array.isArray(response.results)) {
          content += '\nSearch Results:\n';
          response.results.slice(0, 10).forEach((result: any, index: number) => {
            content += `${index + 1}. ${result.title}\n`;
            content += `   URL: ${result.url}\n`;
            content += `   Domain: ${result.domain}\n`;
            if (result.quality_score) {
              content += `   Quality: ${result.quality_score.toFixed(2)}\n`;
            }
            content += '\n';
          });
        }
      } else if (operation === 'search_and_scrape') {
        const scraperResult = response.scraper_result || {};
        content = `Web search and scraping completed for "${response.search_query || response.query || params.query}".\n\n`;
        if (progress.details) {
          content += `Results: ${progress.details}\n`;
        }
        if (progress.duration) {
          content += `Completed in ${progress.duration} seconds.\n`;
        }
        displayMessage = `Web scraping completed successfully.`;
        
        if (scraperResult.output_directory) {
          content += `\nMarkdown files saved to: ${scraperResult.output_directory}`;
          displayMessage += ` Results saved to: ${scraperResult.output_directory}`;
        }
        if (scraperResult.cache_stats) {
          content += `\nProcessed ${scraperResult.cache_stats.processed_sources} sources`;
        }
      } else if (operation === 'direct_scrape') {
        content = `Web scraping completed for "${params.url}".\n\n`;
        if (progress.details) {
          content += `Results: ${progress.details}\n`;
        }
        if (progress.duration) {
          content += `Completed in ${progress.duration} seconds.\n`;
        }
        displayMessage = `Web scraping completed successfully.`;
        
        if (response.output_directory) {
          content += `\nMarkdown files saved to: ${response.output_directory}`;
          displayMessage += ` Results saved to: ${response.output_directory}`;
        }
        if (response.cache_stats) {
          content += `\nProcessed ${response.cache_stats.processed_sources} sources`;
        }
      }
    } else {
      // Operation failed or incomplete
      content = `Web operation failed: ${progress.message || 'Unknown error'}`;
      displayMessage = `Web operation failed.`;
      if (response.error_message) {
        content += `\nError details: ${response.error_message}`;
      }
    }
    
    // Extract sources if available
    const sources: any[] = [];
    if (response.results && Array.isArray(response.results)) {
      response.results.forEach((result: any) => {
        if (result.url && result.title) {
          sources.push({
            url: result.url,
            title: result.title,
            description: result.description || result.snippet || '',
            domain: result.domain || new URL(result.url).hostname,
            quality_score: result.quality_score || 0,
            source: result.source || 'web_search'
          });
        }
      });
    }
    
    return {
      llmContent: content,
      returnDisplay: displayMessage,
      sources,
      operation,
      results_count: resultsCount,
    };
  }

  private parseProgressOutput(progressOutput: string, params: WebscraperToolParams): WebscraperToolResult {
    const lines = progressOutput.split('\n');
    const sources: any[] = [];
    let resultsCount = 0;
    let operation = 'unknown';
    let summary = '';
    
    // Parse progress output to extract meaningful information
    for (const line of lines) {
      // Extract search results count
      if (line.includes('Found') && line.includes('results for query:')) {
        const match = line.match(/Found (\d+) (?:relevant )?results for query:/);
        if (match) {
          resultsCount = parseInt(match[1], 10);
          operation = params.searchOnly ? 'search_only' : 'search_and_scrape';
        }
      }
      
      // Extract API results
      if (line.includes('API returned') && line.includes('results')) {
        const match = line.match(/(\w+) API returned (\d+) results/);
        if (match) {
          const [, apiName, count] = match;
          summary += `${apiName} API: ${count} results\n`;
        }
      }
      
      // Extract completion messages
      if (line.includes('✅') || line.includes('completed')) {
        summary += line + '\n';
      }
      
      // Extract error messages
      if (line.includes('ERROR') || line.includes('Failed')) {
        summary += `⚠️ ${line}\n`;
      }
    }
    
    // Create a summary based on the operation type and results
    let content = '';
    if (params.query) {
      if (params.searchOnly) {
        content = `Web search completed for "${params.query}"\n\n`;
        content += `Found ${resultsCount} results from web search APIs.\n\n`;
        content += `Summary:\n${summary}`;
      } else {
        content = `Web search and scraping completed for "${params.query}"\n\n`;
        content += `Found and processed ${resultsCount} results with content extraction.\n\n`;
        content += `Summary:\n${summary}`;
      }
    } else if (params.url) {
      content = `Web scraping completed for "${params.url}"\n\n`;
      content += `Summary:\n${summary}`;
    }
    
    return {
      llmContent: content,
      returnDisplay: operation === 'search_only' 
        ? `Search completed: ${resultsCount} results found.`
        : `Web scraping completed successfully.`,
      sources,
      operation,
      results_count: resultsCount,
    };
  }


}