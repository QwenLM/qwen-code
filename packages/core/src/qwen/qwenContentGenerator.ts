/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenAIContentGenerator } from '../core/openaiContentGenerator/index.js';
import { DashScopeOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/dashscope.js';
import { IQwenOAuth2Client } from './qwenOAuth2.js';
import { SharedTokenManager } from './sharedTokenManager.js';
import { Config } from '../config/config.js';
import {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import { ContentGeneratorConfig } from '../core/contentGenerator.js';

// Default fallback base URL if no endpoint is provided
const DEFAULT_QWEN_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

/**
 * Qwen Content Generator that uses Qwen OAuth tokens with automatic refresh
 */
export class QwenContentGenerator extends OpenAIContentGenerator {
  private qwenClient: IQwenOAuth2Client;
  private sharedManager: SharedTokenManager;
  private currentToken?: string;

  constructor(
    qwenClient: IQwenOAuth2Client,
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    // Create DashScope provider for Qwen
    const dashscopeProvider = new DashScopeOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig,
    );

    // Initialize with DashScope provider
    super(contentGeneratorConfig, cliConfig, dashscopeProvider);
    this.qwenClient = qwenClient;
    this.sharedManager = SharedTokenManager.getInstance();

    // Set default base URL, will be updated dynamically
    if (contentGeneratorConfig?.baseUrl && contentGeneratorConfig?.apiKey) {
      this.pipeline.client.baseURL = contentGeneratorConfig?.baseUrl;
      this.pipeline.client.apiKey = contentGeneratorConfig?.apiKey;
    }
  }

  /**
   * Get the current endpoint URL with proper protocol and /v1 suffix
   */
  private getCurrentEndpoint(resourceUrl?: string): string {
    const baseEndpoint = resourceUrl || DEFAULT_QWEN_BASE_URL;
    const suffix = '/v1';

    // Normalize the URL: add protocol if missing, ensure /v1 suffix
    const normalizedUrl = baseEndpoint.startsWith('http')
      ? baseEndpoint
      : `https://${baseEndpoint}`;

    return normalizedUrl.endsWith(suffix)
      ? normalizedUrl
      : `${normalizedUrl}${suffix}`;
  }

  /**
   * Override error logging behavior to suppress auth errors during token refresh
   */
  protected override shouldSuppressErrorLogging(
    error: unknown,
    _request: GenerateContentParameters,
  ): boolean {
    // Suppress logging for authentication errors that we handle with token refresh
    return this.isAuthError(error);
  }

  /**
   * Get valid token and endpoint using the shared token manager
   */
  private async getValidToken(): Promise<{ token: string; endpoint: string }> {
    try {
      // Use SharedTokenManager for consistent token/endpoint pairing and automatic refresh
      const credentials = await this.sharedManager.getValidCredentials(
        this.qwenClient,
      );

      if (!credentials.access_token) {
        throw new Error('No access token available');
      }

      return {
        token: credentials.access_token,
        endpoint: this.getCurrentEndpoint(credentials.resource_url),
      };
    } catch (error) {
      // Propagate auth errors as-is for retry logic
      if (this.isAuthError(error)) {
        throw error;
      }
      console.warn('Failed to get token from shared manager:', error);
      throw new Error(
        'Failed to obtain valid Qwen access token. Please re-authenticate.',
      );
    }
  }

  /**
   * Execute an operation with automatic credential management and retry logic.
   * This method handles:
   * - Dynamic token and endpoint retrieval
   * - Client configuration updates
   * - Retry logic on authentication errors with token refresh
   *
   * @param operation - The operation to execute with updated client configuration
   * @returns The result of the operation
   */
  private async executeWithCredentialManagement<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    // Attempt the operation with credential management and retry logic
    const attemptOperation = async (): Promise<T> => {
      const { token, endpoint } = await this.getValidToken();

      // Apply dynamic configuration
      this.pipeline.client.apiKey = token;
      this.pipeline.client.baseURL = endpoint;

      return await operation();
    };

    // Execute with retry logic for auth errors
    try {
      return await attemptOperation();
    } catch (error) {
      if (this.isAuthError(error)) {
        // Use SharedTokenManager to properly refresh and persist the token
        // This ensures the refreshed token is saved to oauth_creds.json
        await this.sharedManager.getValidCredentials(this.qwenClient, true);
        return await attemptOperation();
      }
      throw error;
    }
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  override async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.executeWithCredentialManagement(() =>
      super.generateContent(request, userPromptId),
    );
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  override async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.executeWithCredentialManagement(() =>
      super.generateContentStream(request, userPromptId),
    );
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  override async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return this.executeWithCredentialManagement(() =>
      super.countTokens(request),
    );
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  override async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.executeWithCredentialManagement(() =>
      super.embedContent(request),
    );
  }

  /**
   * Check if an error is related to authentication/authorization
   */
  private isAuthError(error: unknown): boolean {
    if (!error) return false;

    const errorMessage =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();

    // Define a type for errors that might have status or code properties
    const errorWithCode = error as {
      status?: number | string;
      code?: number | string;
    };
    const errorCode = errorWithCode?.status || errorWithCode?.code;

    return (
      errorCode === 401 ||
      errorCode === 403 ||
      errorCode === '401' ||
      errorCode === '403' ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('forbidden') ||
      errorMessage.includes('invalid api key') ||
      errorMessage.includes('invalid access token') ||
      errorMessage.includes('token expired') ||
      errorMessage.includes('authentication') ||
      errorMessage.includes('access denied') ||
      (errorMessage.includes('token') && errorMessage.includes('expired'))
    );
  }

  /**
   * Get the current cached token (may be expired)
   */
  getCurrentToken(): string | null {
    // First check internal state for backwards compatibility with tests
    if (this.currentToken) {
      return this.currentToken;
    }
    // Fall back to SharedTokenManager
    const credentials = this.sharedManager.getCurrentCredentials();
    return credentials?.access_token || null;
  }

  /**
   * Clear the cached token
   */
  clearToken(): void {
    // Clear internal state for backwards compatibility with tests
    this.currentToken = undefined;
    // Also clear SharedTokenManager
    this.sharedManager.clearCache();
  }
}
