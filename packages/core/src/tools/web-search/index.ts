/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolCallConfirmationDetails,
  type ToolInfoConfirmationDetails,
  ToolConfirmationOutcome,
} from '../tools.js';
import { ToolErrorType } from '../tool-error.js';

import type { Config } from '../../config/config.js';
import { ApprovalMode } from '../../config/config.js';
import { getErrorMessage } from '../../utils/errors.js';
import { buildContentWithSources } from './utils.js';
import { TavilyProvider } from './providers/tavily-provider.js';
import { GoogleProvider } from './providers/google-provider.js';
import { DashScopeProvider } from './providers/dashscope-provider.js';
import type {
  WebSearchToolParams,
  WebSearchToolResult,
  WebSearchProvider,
  WebSearchResultItem,
  WebSearchProviderConfig,
  DashScopeProviderConfig,
} from './types.js';

class WebSearchToolInvocation extends BaseToolInvocation<
  WebSearchToolParams,
  WebSearchToolResult
> {
  constructor(
    private readonly config: Config,
    params: WebSearchToolParams,
  ) {
    super(params);
  }

  override getDescription(): string {
    const webSearchConfig = this.config.getWebSearchConfig();
    if (!webSearchConfig) {
      return ' (Web search is disabled - configure a provider in settings.json)';
    }
    const provider = this.params.provider || webSearchConfig.default;
    return ` (Searching the web via ${provider})`;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT) {
      return false;
    }

    const confirmationDetails: ToolInfoConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Search',
      prompt: `Search the web for: "${this.params.query}"`,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  /**
   * Create a provider instance from configuration.
   */
  private createProvider(config: WebSearchProviderConfig): WebSearchProvider {
    switch (config.type) {
      case 'tavily':
        return new TavilyProvider(config);
      case 'google':
        return new GoogleProvider(config);
      case 'dashscope': {
        // Pass auth type to DashScope provider for availability check
        const authType = this.config.getAuthType();
        const dashscopeConfig: DashScopeProviderConfig = {
          ...config,
          authType: authType as string | undefined,
        };
        return new DashScopeProvider(dashscopeConfig);
      }
      default:
        throw new Error('Unknown provider type');
    }
  }

  /**
   * Create all configured providers.
   */
  private createProviders(
    configs: WebSearchProviderConfig[],
  ): Map<string, WebSearchProvider> {
    const providers = new Map<string, WebSearchProvider>();

    for (const config of configs) {
      try {
        const provider = this.createProvider(config);
        if (provider.isAvailable()) {
          providers.set(config.type, provider);
        }
      } catch (error) {
        console.warn(`Failed to create ${config.type} provider:`, error);
      }
    }

    return providers;
  }

  /**
   * Select the appropriate provider based on configuration and parameters.
   * Throws error if provider not found.
   */
  private selectProvider(
    providers: Map<string, WebSearchProvider>,
    requestedProvider?: string,
    defaultProvider?: string,
  ): WebSearchProvider {
    // Use requested provider if specified
    if (requestedProvider) {
      const provider = providers.get(requestedProvider);
      if (!provider) {
        const available = Array.from(providers.keys()).join(', ');
        throw new Error(
          `The specified provider "${requestedProvider}" is not available. Available: ${available}`,
        );
      }
      return provider;
    }

    // Use default provider if specified and available
    if (defaultProvider && providers.has(defaultProvider)) {
      return providers.get(defaultProvider)!;
    }

    // Fallback to first available provider
    const firstProvider = providers.values().next().value;
    if (!firstProvider) {
      throw new Error('No web search providers are available.');
    }
    return firstProvider;
  }

  /**
   * Format search results into a content string.
   */
  private formatSearchResults(searchResult: {
    answer?: string;
    results: WebSearchResultItem[];
  }): {
    content: string;
    sources: Array<{ title: string; url: string }>;
  } {
    const sources = searchResult.results.map((r) => ({
      title: r.title,
      url: r.url,
    }));

    let content = searchResult.answer?.trim() || '';

    if (!content) {
      // Fallback: Build an informative summary with title + snippet + source link
      // This provides enough context for the LLM while keeping token usage efficient
      content = searchResult.results
        .slice(0, 5) // Top 5 results
        .map((r, i) => {
          const parts = [`${i + 1}. **${r.title}**`];

          // Include snippet/content if available
          if (r.content?.trim()) {
            parts.push(`   ${r.content.trim()}`);
          }

          // Always include the source URL
          parts.push(`   Source: ${r.url}`);

          // Optionally include relevance score if available
          if (r.score !== undefined) {
            parts.push(`   Relevance: ${(r.score * 100).toFixed(0)}%`);
          }

          // Optionally include publish date if available
          if (r.publishedDate) {
            parts.push(`   Published: ${r.publishedDate}`);
          }

          return parts.join('\n');
        })
        .join('\n\n');

      // Add a note about using web_fetch for detailed content
      if (content) {
        content +=
          '\n\n*Note: For detailed content from any source above, use the web_fetch tool with the URL.*';
      }
    } else {
      // When answer is available, append sources section
      content = buildContentWithSources(content, sources);
    }

    return { content, sources };
  }

  async execute(signal: AbortSignal): Promise<WebSearchToolResult> {
    // Check if web search is configured
    const webSearchConfig = this.config.getWebSearchConfig();
    if (!webSearchConfig) {
      return {
        llmContent:
          'Web search is disabled. Please configure a web search provider in your settings.',
        returnDisplay: 'Web search is disabled.',
        error: {
          message: 'Web search is disabled',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    try {
      // Create and select provider
      const providers = this.createProviders(webSearchConfig.provider);
      const provider = this.selectProvider(
        providers,
        this.params.provider,
        webSearchConfig.default,
      );

      // Perform search
      const searchResult = await provider.search(this.params.query, signal);
      const { content, sources } = this.formatSearchResults(searchResult);

      // Guard: Check if we got results
      if (!content.trim()) {
        return {
          llmContent: `No search results found for query: "${this.params.query}" (via ${provider.name})`,
          returnDisplay: `No information found for "${this.params.query}".`,
        };
      }

      // Success result
      return {
        llmContent: `Web search results for "${this.params.query}" (via ${provider.name}):\n\n${content}`,
        returnDisplay: `Search results for "${this.params.query}".`,
        sources,
      };
    } catch (error: unknown) {
      const errorMessage = `Error during web search: ${getErrorMessage(error)}`;
      console.error(errorMessage, error);
      return {
        llmContent: errorMessage,
        returnDisplay: 'Error performing web search.',
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

/**
 * A tool to perform web searches using configurable providers.
 */
export class WebSearchTool extends BaseDeclarativeTool<
  WebSearchToolParams,
  WebSearchToolResult
> {
  static readonly Name: string = 'web_search';

  constructor(private readonly config: Config) {
    super(
      WebSearchTool.Name,
      'WebSearch',
      'Allows searching the web and using results to inform responses. Provides up-to-date information for current events and recent data beyond the training data cutoff. Returns search results formatted with concise answers and source links. Use this tool when accessing information that may be outdated or beyond the knowledge cutoff.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find information on the web.',
          },
          provider: {
            type: 'string',
            description:
              'Optional provider to use for the search (e.g., "tavily", "google", "dashscope"). IMPORTANT: Only specify this parameter if you explicitly know which provider to use. Otherwise, omit this parameter entirely and let the system automatically select the appropriate provider based on availability and configuration. The system will choose the best available provider automatically.',
          },
        },
        required: ['query'],
      },
    );
  }

  /**
   * Validates the parameters for the WebSearchTool.
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  protected override validateToolParamValues(
    params: WebSearchToolParams,
  ): string | null {
    if (!params.query || params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }

    // Validate provider parameter if provided
    if (params.provider !== undefined && params.provider.trim() === '') {
      return "The 'provider' parameter cannot be empty if specified.";
    }

    return null;
  }

  protected createInvocation(
    params: WebSearchToolParams,
  ): ToolInvocation<WebSearchToolParams, WebSearchToolResult> {
    return new WebSearchToolInvocation(this.config, params);
  }
}

// Re-export types for external use
export type {
  WebSearchToolParams,
  WebSearchToolResult,
  WebSearchConfig,
  WebSearchProviderConfig,
} from './types.js';
