/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IQwenOAuth2Client,
  type QwenCredentials,
  type ErrorData,
} from './qwenOAuth2.js';
import {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  FinishReason,
} from '@google/genai';
import { QwenContentGenerator } from './qwenContentGenerator.js';
import { SharedTokenManager } from './sharedTokenManager.js';
import { Config } from '../config/config.js';
import { AuthType, ContentGeneratorConfig } from '../core/contentGenerator.js';

// Mock SharedTokenManager
vi.mock('./sharedTokenManager.js', () => ({
  SharedTokenManager: class {
    private static instance: unknown = null;
    private mockCredentials: QwenCredentials | null = null;
    private shouldThrowError: boolean = false;
    private errorToThrow: Error | null = null;

    static getInstance() {
      if (!this.instance) {
        this.instance = new this();
      }
      return this.instance;
    }

    async getValidCredentials(
      qwenClient: IQwenOAuth2Client,
    ): Promise<QwenCredentials> {
      // If we're configured to throw an error, do so
      if (this.shouldThrowError && this.errorToThrow) {
        throw this.errorToThrow;
      }

      // Try to get credentials from the mock client first to trigger auth errors
      try {
        const { token } = await qwenClient.getAccessToken();
        if (token) {
          const credentials = qwenClient.getCredentials();
          return credentials;
        }
      } catch (error) {
        // If it's an auth error and we need to simulate refresh behavior
        const errorMessage =
          error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();
        const errorCode =
          (error as { status?: number; code?: number })?.status ||
          (error as { status?: number; code?: number })?.code;

        const isAuthError =
          errorCode === 401 ||
          errorCode === 403 ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('forbidden') ||
          errorMessage.includes('token expired');

        if (isAuthError) {
          // Try to refresh the token through the client
          try {
            const refreshResult = await qwenClient.refreshAccessToken();
            if (refreshResult && !('error' in refreshResult)) {
              // Refresh succeeded, update client credentials and return them
              const updatedCredentials = qwenClient.getCredentials();
              return updatedCredentials;
            } else {
              // Refresh failed, throw appropriate error
              throw new Error(
                'Failed to obtain valid Qwen access token. Please re-authenticate.',
              );
            }
          } catch {
            throw new Error(
              'Failed to obtain valid Qwen access token. Please re-authenticate.',
            );
          }
        } else {
          // Re-throw non-auth errors
          throw error;
        }
      }

      // Return mock credentials only if they're set
      if (this.mockCredentials && this.mockCredentials.access_token) {
        return this.mockCredentials;
      }

      // Default fallback for tests that need credentials
      return {
        access_token: 'valid-token',
        refresh_token: 'valid-refresh-token',
        resource_url: 'https://test-endpoint.com/v1',
        expiry_date: Date.now() + 3600000,
      };
    }

    getCurrentCredentials(): QwenCredentials | null {
      return this.mockCredentials;
    }

    clearCache(): void {
      this.mockCredentials = null;
    }

    // Helper method for tests to set credentials
    setMockCredentials(credentials: QwenCredentials | null): void {
      this.mockCredentials = credentials;
    }

    // Helper method for tests to simulate errors
    setMockError(error: Error | null): void {
      this.shouldThrowError = !!error;
      this.errorToThrow = error;
    }
  },
}));

// Mock the OpenAIContentGenerator parent class
vi.mock('../core/openaiContentGenerator.js', () => ({
  OpenAIContentGenerator: class {
    client: {
      apiKey: string;
      baseURL: string;
    };

    constructor(
      contentGeneratorConfig: ContentGeneratorConfig,
      _config: Config,
    ) {
      this.client = {
        apiKey: contentGeneratorConfig.apiKey || 'test-key',
        baseURL: contentGeneratorConfig.baseUrl || 'https://api.openai.com/v1',
      };
    }

    async generateContent(
      _request: GenerateContentParameters,
    ): Promise<GenerateContentResponse> {
      return createMockResponse('Generated content');
    }

    async generateContentStream(
      _request: GenerateContentParameters,
    ): Promise<AsyncGenerator<GenerateContentResponse>> {
      return (async function* () {
        yield createMockResponse('Stream chunk 1');
        yield createMockResponse('Stream chunk 2');
      })();
    }

    async countTokens(
      _request: CountTokensParameters,
    ): Promise<CountTokensResponse> {
      return { totalTokens: 10 };
    }

    async embedContent(
      _request: EmbedContentParameters,
    ): Promise<EmbedContentResponse> {
      return { embeddings: [{ values: [0.1, 0.2, 0.3] }] };
    }

    protected shouldSuppressErrorLogging(
      _error: unknown,
      _request: GenerateContentParameters,
    ): boolean {
      return false;
    }
  },
}));

const createMockResponse = (text: string): GenerateContentResponse =>
  ({
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: FinishReason.STOP,
        index: 0,
        safetyRatings: [],
      },
    ],
    promptFeedback: { safetyRatings: [] },
    text,
    data: undefined,
    functionCalls: [],
    executableCode: '',
    codeExecutionResult: '',
  }) as GenerateContentResponse;

describe('QwenContentGenerator', () => {
  let mockQwenClient: IQwenOAuth2Client;
  let qwenContentGenerator: QwenContentGenerator;
  let mockConfig: Config;

  const mockCredentials: QwenCredentials = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    resource_url: 'https://test-endpoint.com/v1',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Config
    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'qwen',
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        },
      }),
    } as unknown as Config;

    // Mock QwenOAuth2Client
    mockQwenClient = {
      getAccessToken: vi.fn(),
      getCredentials: vi.fn(),
      setCredentials: vi.fn(),
      refreshAccessToken: vi.fn(),
      requestDeviceAuthorization: vi.fn(),
      pollDeviceToken: vi.fn(),
    };

    // Create QwenContentGenerator instance
    const contentGeneratorConfig = {
      model: 'qwen-turbo',
      authType: AuthType.QWEN_OAUTH,
    };
    qwenContentGenerator = new QwenContentGenerator(
      mockQwenClient,
      contentGeneratorConfig,
      mockConfig,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Core Content Generation Methods', () => {
    it('should generate content with valid token', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      const result = await qwenContentGenerator.generateContent(
        request,
        'test-prompt-id',
      );

      expect(result.text).toBe('Generated content');
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });

    it('should generate content stream with valid token', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello stream' }] }],
      };

      const stream = await qwenContentGenerator.generateContentStream(
        request,
        'test-prompt-id',
      );
      const chunks: string[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk.text || '');
      }

      expect(chunks).toEqual(['Stream chunk 1', 'Stream chunk 2']);
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });

    it('should count tokens with valid token', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);

      const request: CountTokensParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Count me' }] }],
      };

      const result = await qwenContentGenerator.countTokens(request);

      expect(result.totalTokens).toBe(10);
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });

    it('should embed content with valid token', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);

      const request: EmbedContentParameters = {
        model: 'qwen-turbo',
        contents: [{ parts: [{ text: 'Embed me' }] }],
      };

      const result = await qwenContentGenerator.embedContent(request);

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings?.[0]?.values).toEqual([0.1, 0.2, 0.3]);
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });
  });

  describe('Token Management and Refresh Logic', () => {
    it('should refresh token on auth error and retry', async () => {
      const authError = { status: 401, message: 'Unauthorized' };

      // First call fails with auth error, second call succeeds
      vi.mocked(mockQwenClient.getAccessToken)
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce({ token: 'refreshed-token' });

      // Refresh succeeds
      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        access_token: 'refreshed-token',
        token_type: 'Bearer',
        expires_in: 3600,
        resource_url: 'https://refreshed-endpoint.com',
      });

      // Set credentials for second call
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        access_token: 'refreshed-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-token',
        resource_url: 'https://refreshed-endpoint.com',
        expiry_date: Date.now() + 3600000,
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      const result = await qwenContentGenerator.generateContent(
        request,
        'test-prompt-id',
      );

      expect(result.text).toBe('Generated content');
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
    });

    it('should refresh token on auth error and retry for content stream', async () => {
      const authError = { status: 401, message: 'Unauthorized' };

      // Reset mocks for this test
      vi.clearAllMocks();

      // First call fails with auth error, second call succeeds
      vi.mocked(mockQwenClient.getAccessToken)
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce({ token: 'refreshed-stream-token' });

      // Refresh succeeds
      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        access_token: 'refreshed-stream-token',
        token_type: 'Bearer',
        expires_in: 3600,
        resource_url: 'https://refreshed-stream-endpoint.com',
      });

      // Set credentials for second call
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        access_token: 'refreshed-stream-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-token',
        resource_url: 'https://refreshed-stream-endpoint.com',
        expiry_date: Date.now() + 3600000,
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello stream' }] }],
      };

      const stream = await qwenContentGenerator.generateContentStream(
        request,
        'test-prompt-id',
      );
      const chunks: string[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk.text || '');
      }

      expect(chunks).toEqual(['Stream chunk 1', 'Stream chunk 2']);
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
    });

    it('should handle token refresh failure', async () => {
      // Mock the SharedTokenManager to throw an error
      const mockTokenManager = SharedTokenManager.getInstance() as unknown as {
        setMockError: (error: Error | null) => void;
      };
      mockTokenManager.setMockError(
        new Error(
          'Failed to obtain valid Qwen access token. Please re-authenticate.',
        ),
      );

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await expect(
        qwenContentGenerator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow(
        'Failed to obtain valid Qwen access token. Please re-authenticate.',
      );

      // Clean up
      mockTokenManager.setMockError(null);
    });

    it('should update endpoint when token is refreshed', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        ...mockCredentials,
        resource_url: 'https://new-endpoint.com',
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await qwenContentGenerator.generateContent(request, 'test-prompt-id');

      expect(mockQwenClient.getCredentials).toHaveBeenCalled();
    });
  });

  describe('Endpoint URL Normalization', () => {
    it('should use default endpoint when no custom endpoint provided', async () => {
      let capturedBaseURL = '';

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        // No resource_url provided
      });

      // Mock the parent's generateContent to capture the baseURL during the call
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = vi.fn().mockImplementation(function (
        this: QwenContentGenerator,
      ) {
        capturedBaseURL = (this as unknown as { client: { baseURL: string } })
          .client.baseURL;
        return createMockResponse('Generated content');
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await qwenContentGenerator.generateContent(request, 'test-prompt-id');

      // Should use default endpoint with /v1 suffix
      expect(capturedBaseURL).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      );

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });

    it('should normalize hostname-only endpoints by adding https protocol', async () => {
      let capturedBaseURL = '';

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        ...mockCredentials,
        resource_url: 'custom-endpoint.com',
      });

      // Mock the parent's generateContent to capture the baseURL during the call
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = vi.fn().mockImplementation(function (
        this: QwenContentGenerator,
      ) {
        capturedBaseURL = (this as unknown as { client: { baseURL: string } })
          .client.baseURL;
        return createMockResponse('Generated content');
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await qwenContentGenerator.generateContent(request, 'test-prompt-id');

      // Should add https:// and /v1
      expect(capturedBaseURL).toBe('https://custom-endpoint.com/v1');

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });

    it('should preserve existing protocol in endpoint URLs', async () => {
      let capturedBaseURL = '';

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        ...mockCredentials,
        resource_url: 'https://custom-endpoint.com',
      });

      // Mock the parent's generateContent to capture the baseURL during the call
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = vi.fn().mockImplementation(function (
        this: QwenContentGenerator,
      ) {
        capturedBaseURL = (this as unknown as { client: { baseURL: string } })
          .client.baseURL;
        return createMockResponse('Generated content');
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await qwenContentGenerator.generateContent(request, 'test-prompt-id');

      // Should preserve https:// and add /v1
      expect(capturedBaseURL).toBe('https://custom-endpoint.com/v1');

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });

    it('should not duplicate /v1 suffix if already present', async () => {
      let capturedBaseURL = '';

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        ...mockCredentials,
        resource_url: 'https://custom-endpoint.com/v1',
      });

      // Mock the parent's generateContent to capture the baseURL during the call
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = vi.fn().mockImplementation(function (
        this: QwenContentGenerator,
      ) {
        capturedBaseURL = (this as unknown as { client: { baseURL: string } })
          .client.baseURL;
        return createMockResponse('Generated content');
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await qwenContentGenerator.generateContent(request, 'test-prompt-id');

      // Should not duplicate /v1
      expect(capturedBaseURL).toBe('https://custom-endpoint.com/v1');

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });
  });

  describe('Client State Management', () => {
    it('should restore original client credentials after operations', async () => {
      const client = (
        qwenContentGenerator as unknown as {
          client: { apiKey: string; baseURL: string };
        }
      ).client;
      const originalApiKey = client.apiKey;
      const originalBaseURL = client.baseURL;

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'temp-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        ...mockCredentials,
        resource_url: 'https://temp-endpoint.com',
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await qwenContentGenerator.generateContent(request, 'test-prompt-id');

      // Should restore original values after operation
      expect(client.apiKey).toBe(originalApiKey);
      expect(client.baseURL).toBe(originalBaseURL);
    });

    it('should restore credentials even when operation throws', async () => {
      const client = (
        qwenContentGenerator as unknown as {
          client: { apiKey: string; baseURL: string };
        }
      ).client;
      const originalApiKey = client.apiKey;
      const originalBaseURL = client.baseURL;

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'temp-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);

      // Mock the parent method to throw an error
      const mockError = new Error('Network error');
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = vi.fn().mockRejectedValue(mockError);

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      try {
        await qwenContentGenerator.generateContent(request, 'test-prompt-id');
      } catch (error) {
        expect(error).toBe(mockError);
      }

      // Credentials should still be restored
      expect(client.apiKey).toBe(originalApiKey);
      expect(client.baseURL).toBe(originalBaseURL);

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });
  });

  describe('Error Handling and Retry Logic', () => {
    it('should retry once on authentication errors', async () => {
      const authError = { status: 401, message: 'Unauthorized' };

      // Mock first call to fail with auth error
      const mockGenerateContent = vi
        .fn()
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce(createMockResponse('Success after retry'));

      // Replace the parent method
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = mockGenerateContent;

      // Mock getAccessToken to fail initially, then succeed
      let getAccessTokenCallCount = 0;
      vi.mocked(mockQwenClient.getAccessToken).mockImplementation(async () => {
        getAccessTokenCallCount++;
        if (getAccessTokenCallCount <= 2) {
          throw authError; // Fail on first two calls (initial + retry)
        }
        return { token: 'refreshed-token' }; // Succeed after refresh
      });

      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        access_token: 'refreshed-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-token',
        resource_url: 'https://test-endpoint.com',
        expiry_date: Date.now() + 3600000,
      });

      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        access_token: 'refreshed-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      const result = await qwenContentGenerator.generateContent(
        request,
        'test-prompt-id',
      );

      expect(result.text).toBe('Success after retry');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });

    it('should not retry non-authentication errors', async () => {
      const networkError = new Error('Network timeout');

      const mockGenerateContent = vi.fn().mockRejectedValue(networkError);
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = mockGenerateContent;

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await expect(
        qwenContentGenerator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Network timeout');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockQwenClient.refreshAccessToken).not.toHaveBeenCalled();

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });

    it('should handle error response from token refresh', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(
        new Error('Token expired'),
      );
      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        error: 'invalid_grant',
        error_description: 'Refresh token expired',
      } as ErrorData);

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await expect(
        qwenContentGenerator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Failed to obtain valid Qwen access token');
    });
  });

  describe('Token State Management', () => {
    it('should cache and return current token', () => {
      expect(qwenContentGenerator.getCurrentToken()).toBeNull();

      // Simulate setting a token internally
      (
        qwenContentGenerator as unknown as { currentToken: string }
      ).currentToken = 'cached-token';

      expect(qwenContentGenerator.getCurrentToken()).toBe('cached-token');
    });

    it('should clear token on clearToken()', () => {
      // Simulate having cached token value
      const qwenInstance = qwenContentGenerator as unknown as {
        currentToken: string;
      };
      qwenInstance.currentToken = 'cached-token';

      qwenContentGenerator.clearToken();

      expect(qwenContentGenerator.getCurrentToken()).toBeNull();
    });

    it('should handle concurrent token refresh requests', async () => {
      let refreshCallCount = 0;

      // Clear any existing cached token first
      qwenContentGenerator.clearToken();

      // Mock to simulate auth error on first parent call, which should trigger refresh
      const authError = { status: 401, message: 'Unauthorized' };
      let parentCallCount = 0;

      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(authError);
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);

      vi.mocked(mockQwenClient.refreshAccessToken).mockImplementation(
        async () => {
          refreshCallCount++;
          await new Promise((resolve) => setTimeout(resolve, 50)); // Longer delay to ensure concurrency
          return {
            access_token: 'refreshed-token',
            token_type: 'Bearer',
            expires_in: 3600,
          };
        },
      );

      // Mock the parent method to fail first then succeed
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContent = parentPrototype.generateContent;
      parentPrototype.generateContent = vi.fn().mockImplementation(async () => {
        parentCallCount++;
        if (parentCallCount === 1) {
          throw authError; // First call triggers auth error
        }
        return createMockResponse('Generated content');
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      // Make multiple concurrent requests - should all use the same refresh promise
      const promises = [
        qwenContentGenerator.generateContent(request, 'test-prompt-id'),
        qwenContentGenerator.generateContent(request, 'test-prompt-id'),
        qwenContentGenerator.generateContent(request, 'test-prompt-id'),
      ];

      const results = await Promise.all(promises);

      // All should succeed
      results.forEach((result) => {
        expect(result.text).toBe('Generated content');
      });

      // The main test is that all requests succeed without crashing
      expect(results).toHaveLength(3);
      // With our new implementation through SharedTokenManager, refresh should still be called
      expect(refreshCallCount).toBeGreaterThanOrEqual(1);

      // Restore original method
      parentPrototype.generateContent = originalGenerateContent;
    });
  });

  describe('Error Logging Suppression', () => {
    it('should suppress logging for authentication errors', () => {
      const authErrors = [
        { status: 401 },
        { code: 403 },
        new Error('Unauthorized access'),
        new Error('Token expired'),
        new Error('Invalid API key'),
      ];

      authErrors.forEach((error) => {
        const shouldSuppress = (
          qwenContentGenerator as unknown as {
            shouldSuppressErrorLogging: (
              error: unknown,
              request: GenerateContentParameters,
            ) => boolean;
          }
        ).shouldSuppressErrorLogging(error, {} as GenerateContentParameters);
        expect(shouldSuppress).toBe(true);
      });
    });

    it('should not suppress logging for non-auth errors', () => {
      const nonAuthErrors = [
        new Error('Network timeout'),
        new Error('Rate limit exceeded'),
        { status: 500 },
        new Error('Internal server error'),
      ];

      nonAuthErrors.forEach((error) => {
        const shouldSuppress = (
          qwenContentGenerator as unknown as {
            shouldSuppressErrorLogging: (
              error: unknown,
              request: GenerateContentParameters,
            ) => boolean;
          }
        ).shouldSuppressErrorLogging(error, {} as GenerateContentParameters);
        expect(shouldSuppress).toBe(false);
      });
    });
  });

  describe('Integration Tests', () => {
    it('should handle complete workflow: get token, use it, refresh on auth error, retry', async () => {
      const authError = { status: 401, message: 'Token expired' };

      // Setup complex scenario
      let callCount = 0;
      const mockGenerateContent = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw authError; // First call fails
        }
        return createMockResponse('Success after refresh'); // Second call succeeds
      });

      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      parentPrototype.generateContent = mockGenerateContent;

      // Mock getAccessToken to fail initially, then succeed
      let getAccessTokenCallCount = 0;
      vi.mocked(mockQwenClient.getAccessToken).mockImplementation(async () => {
        getAccessTokenCallCount++;
        if (getAccessTokenCallCount <= 2) {
          throw authError; // Fail on first two calls (initial + retry)
        }
        return { token: 'new-token' }; // Succeed after refresh
      });

      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        access_token: 'new-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-token',
        resource_url: 'https://new-endpoint.com',
        expiry_date: Date.now() + 7200000,
      });

      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        access_token: 'new-token',
        token_type: 'Bearer',
        expires_in: 7200,
        resource_url: 'https://new-endpoint.com',
      });

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Test message' }] }],
      };

      const result = await qwenContentGenerator.generateContent(
        request,
        'test-prompt-id',
      );

      expect(result.text).toBe('Success after refresh');
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
      expect(callCount).toBe(2); // Initial call + retry
    });
  });

  describe('SharedTokenManager Integration', () => {
    it('should use SharedTokenManager to get valid credentials', async () => {
      const mockTokenManager = {
        getValidCredentials: vi.fn().mockResolvedValue({
          access_token: 'manager-token',
          resource_url: 'https://manager-endpoint.com',
        }),
        getCurrentCredentials: vi.fn(),
        clearCache: vi.fn(),
      };

      // Mock the SharedTokenManager.getInstance()
      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      // Create new instance to pick up the mock
      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await newGenerator.generateContent(request, 'test-prompt-id');

      expect(mockTokenManager.getValidCredentials).toHaveBeenCalledWith(
        mockQwenClient,
      );

      // Restore original
      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should handle SharedTokenManager errors gracefully', async () => {
      const mockTokenManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('Token manager error')),
        getCurrentCredentials: vi.fn(),
        clearCache: vi.fn(),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await expect(
        newGenerator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Failed to obtain valid Qwen access token');

      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should handle missing access token from credentials', async () => {
      const mockTokenManager = {
        getValidCredentials: vi.fn().mockResolvedValue({
          access_token: undefined,
          resource_url: 'https://test-endpoint.com',
        }),
        getCurrentCredentials: vi.fn(),
        clearCache: vi.fn(),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await expect(
        newGenerator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Failed to obtain valid Qwen access token');

      SharedTokenManager.getInstance = originalGetInstance;
    });
  });

  describe('getCurrentEndpoint Method', () => {
    it('should handle URLs with custom ports', () => {
      const endpoints = [
        { input: 'localhost:8080', expected: 'https://localhost:8080/v1' },
        {
          input: 'http://localhost:8080',
          expected: 'http://localhost:8080/v1',
        },
        {
          input: 'https://api.example.com:443',
          expected: 'https://api.example.com:443/v1',
        },
        {
          input: 'api.example.com:9000/api',
          expected: 'https://api.example.com:9000/api/v1',
        },
      ];

      endpoints.forEach(({ input, expected }) => {
        vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
          token: 'test-token',
        });
        vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
          ...mockCredentials,
          resource_url: input,
        });

        const generator = qwenContentGenerator as unknown as {
          getCurrentEndpoint: (resourceUrl?: string) => string;
        };

        expect(generator.getCurrentEndpoint(input)).toBe(expected);
      });
    });

    it('should handle URLs with existing paths', () => {
      const endpoints = [
        {
          input: 'https://api.example.com/api',
          expected: 'https://api.example.com/api/v1',
        },
        {
          input: 'api.example.com/api/v2',
          expected: 'https://api.example.com/api/v2/v1',
        },
        {
          input: 'https://api.example.com/api/v1',
          expected: 'https://api.example.com/api/v1',
        },
      ];

      endpoints.forEach(({ input, expected }) => {
        const generator = qwenContentGenerator as unknown as {
          getCurrentEndpoint: (resourceUrl?: string) => string;
        };

        expect(generator.getCurrentEndpoint(input)).toBe(expected);
      });
    });

    it('should handle undefined resource URL', () => {
      const generator = qwenContentGenerator as unknown as {
        getCurrentEndpoint: (resourceUrl?: string) => string;
      };

      expect(generator.getCurrentEndpoint(undefined)).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      );
    });

    it('should handle empty resource URL', () => {
      const generator = qwenContentGenerator as unknown as {
        getCurrentEndpoint: (resourceUrl?: string) => string;
      };

      // Empty string should fall back to default endpoint
      expect(generator.getCurrentEndpoint('')).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      );
    });
  });

  describe('isAuthError Method Enhanced', () => {
    it('should identify auth errors by numeric status codes', () => {
      const authErrors = [
        { code: 401 },
        { status: 403 },
        { code: '401' }, // String status codes
        { status: '403' },
      ];

      authErrors.forEach((error) => {
        const generator = qwenContentGenerator as unknown as {
          isAuthError: (error: unknown) => boolean;
        };
        expect(generator.isAuthError(error)).toBe(true);
      });

      // 400 is not typically an auth error, it's bad request
      const nonAuthError = { status: 400 };
      const generator = qwenContentGenerator as unknown as {
        isAuthError: (error: unknown) => boolean;
      };
      expect(generator.isAuthError(nonAuthError)).toBe(false);
    });

    it('should identify auth errors by message content variations', () => {
      const authMessages = [
        'UNAUTHORIZED access',
        'Access is FORBIDDEN',
        'Invalid API Key provided',
        'Invalid Access Token',
        'Token has Expired',
        'Authentication Required',
        'Access Denied by server',
        'The token has expired and needs refresh',
        'Bearer token expired',
      ];

      authMessages.forEach((message) => {
        const error = new Error(message);
        const generator = qwenContentGenerator as unknown as {
          isAuthError: (error: unknown) => boolean;
        };
        expect(generator.isAuthError(error)).toBe(true);
      });
    });

    it('should not identify non-auth errors', () => {
      const nonAuthErrors = [
        new Error('Network timeout'),
        new Error('Rate limit exceeded'),
        { status: 500 },
        { code: 429 },
        'Internal server error',
        null,
        undefined,
        '',
        { status: 200 },
        new Error('Model not found'),
      ];

      nonAuthErrors.forEach((error) => {
        const generator = qwenContentGenerator as unknown as {
          isAuthError: (error: unknown) => boolean;
        };
        expect(generator.isAuthError(error)).toBe(false);
      });
    });

    it('should handle complex error objects', () => {
      const complexErrors = [
        { error: { status: 401, message: 'Unauthorized' } },
        { response: { status: 403 } },
        { details: { code: 401 } },
      ];

      // These should not be identified as auth errors because the method only looks at top-level properties
      complexErrors.forEach((error) => {
        const generator = qwenContentGenerator as unknown as {
          isAuthError: (error: unknown) => boolean;
        };
        expect(generator.isAuthError(error)).toBe(false);
      });
    });
  });

  describe('Stream Error Handling', () => {
    it('should restore credentials when stream generation fails', async () => {
      const client = (
        qwenContentGenerator as unknown as {
          client: { apiKey: string; baseURL: string };
        }
      ).client;
      const originalApiKey = client.apiKey;
      const originalBaseURL = client.baseURL;

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'stream-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        ...mockCredentials,
        resource_url: 'https://stream-endpoint.com',
      });

      // Mock parent method to throw error
      const parentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(qwenContentGenerator),
      );
      const originalGenerateContentStream =
        parentPrototype.generateContentStream;
      parentPrototype.generateContentStream = vi
        .fn()
        .mockRejectedValue(new Error('Stream error'));

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Stream test' }] }],
      };

      try {
        await qwenContentGenerator.generateContentStream(
          request,
          'test-prompt-id',
        );
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }

      // Credentials should be restored even on error
      expect(client.apiKey).toBe(originalApiKey);
      expect(client.baseURL).toBe(originalBaseURL);

      // Restore original method
      parentPrototype.generateContentStream = originalGenerateContentStream;
    });

    it('should not restore credentials in finally block for successful streams', async () => {
      const client = (
        qwenContentGenerator as unknown as {
          client: { apiKey: string; baseURL: string };
        }
      ).client;

      // Set up the mock to return stream credentials
      const streamCredentials = {
        access_token: 'stream-token',
        refresh_token: 'stream-refresh-token',
        resource_url: 'https://stream-endpoint.com',
        expiry_date: Date.now() + 3600000,
      };

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'stream-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(
        streamCredentials,
      );

      // Set the SharedTokenManager mock to return stream credentials
      const mockTokenManager = SharedTokenManager.getInstance() as unknown as {
        setMockCredentials: (credentials: QwenCredentials | null) => void;
      };
      mockTokenManager.setMockCredentials(streamCredentials);

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Stream test' }] }],
      };

      const stream = await qwenContentGenerator.generateContentStream(
        request,
        'test-prompt-id',
      );

      // After successful stream creation, credentials should still be set for the stream
      expect(client.apiKey).toBe('stream-token');
      expect(client.baseURL).toBe('https://stream-endpoint.com/v1');

      // Consume the stream
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);

      // Clean up
      mockTokenManager.setMockCredentials(null);
    });
  });

  describe('Token and Endpoint Management', () => {
    it('should get current token from SharedTokenManager', () => {
      const mockTokenManager = {
        getCurrentCredentials: vi.fn().mockReturnValue({
          access_token: 'current-token',
        }),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      expect(newGenerator.getCurrentToken()).toBe('current-token');

      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should return null when no credentials available', () => {
      const mockTokenManager = {
        getCurrentCredentials: vi.fn().mockReturnValue(null),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      expect(newGenerator.getCurrentToken()).toBeNull();

      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should return null when credentials have no access token', () => {
      const mockTokenManager = {
        getCurrentCredentials: vi.fn().mockReturnValue({
          access_token: undefined,
        }),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      expect(newGenerator.getCurrentToken()).toBeNull();

      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should clear token through SharedTokenManager', () => {
      const mockTokenManager = {
        clearCache: vi.fn(),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      newGenerator.clearToken();

      expect(mockTokenManager.clearCache).toHaveBeenCalled();

      SharedTokenManager.getInstance = originalGetInstance;
    });
  });

  describe('Constructor and Initialization', () => {
    it('should initialize with default base URL', () => {
      const generator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      const client = (generator as unknown as { client: { baseURL: string } })
        .client;
      expect(client.baseURL).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      );
    });

    it('should get SharedTokenManager instance', () => {
      const generator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      const sharedManager = (
        generator as unknown as { sharedManager: SharedTokenManager }
      ).sharedManager;
      expect(sharedManager).toBeDefined();
    });
  });

  describe('Edge Cases and Error Conditions', () => {
    it('should handle token retrieval with warning when SharedTokenManager fails', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockTokenManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('Internal token manager error')),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      const request: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      await expect(
        newGenerator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Failed to obtain valid Qwen access token');

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to get token from shared manager:',
        expect.any(Error),
      );

      consoleSpy.mockRestore();
      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should handle all method types with token failure', async () => {
      const mockTokenManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('Token error')),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const newGenerator = new QwenContentGenerator(
        mockQwenClient,
        { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH },
        mockConfig,
      );

      const generateRequest: GenerateContentParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      const countRequest: CountTokensParameters = {
        model: 'qwen-turbo',
        contents: [{ role: 'user', parts: [{ text: 'Count' }] }],
      };

      const embedRequest: EmbedContentParameters = {
        model: 'qwen-turbo',
        contents: [{ parts: [{ text: 'Embed' }] }],
      };

      // All methods should fail with the same error
      await expect(
        newGenerator.generateContent(generateRequest, 'test-id'),
      ).rejects.toThrow('Failed to obtain valid Qwen access token');

      await expect(
        newGenerator.generateContentStream(generateRequest, 'test-id'),
      ).rejects.toThrow('Failed to obtain valid Qwen access token');

      await expect(newGenerator.countTokens(countRequest)).rejects.toThrow(
        'Failed to obtain valid Qwen access token',
      );

      await expect(newGenerator.embedContent(embedRequest)).rejects.toThrow(
        'Failed to obtain valid Qwen access token',
      );

      SharedTokenManager.getInstance = originalGetInstance;
    });
  });
});
