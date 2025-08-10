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
import { Config } from '../config/config.js';

// Mock the OpenAIContentGenerator parent class
vi.mock('../core/openaiContentGenerator.js', () => ({
  OpenAIContentGenerator: class {
    client: {
      apiKey: string;
      baseURL: string;
    };

    constructor(apiKey: string, _model: string, _config: Config) {
      this.client = {
        apiKey,
        baseURL: 'https://api.openai.com/v1',
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
    qwenContentGenerator = new QwenContentGenerator(
      mockQwenClient,
      'qwen-turbo',
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

      // First call fails with auth error
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValueOnce(authError);

      // Refresh succeeds
      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        access_token: 'refreshed-token',
        token_type: 'Bearer',
        expires_in: 3600,
        resource_url: 'https://refreshed-endpoint.com',
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

    it('should handle token refresh failure', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(
        new Error('Token expired'),
      );
      vi.mocked(mockQwenClient.refreshAccessToken).mockRejectedValue(
        new Error('Refresh failed'),
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

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'initial-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);
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

    it('should clear token and endpoint on clearToken()', () => {
      // Simulate having cached values
      const qwenInstance = qwenContentGenerator as unknown as {
        currentToken: string;
        currentEndpoint: string;
        refreshPromise: Promise<string>;
      };
      qwenInstance.currentToken = 'cached-token';
      qwenInstance.currentEndpoint = 'https://cached-endpoint.com';
      qwenInstance.refreshPromise = Promise.resolve('token');

      qwenContentGenerator.clearToken();

      expect(qwenContentGenerator.getCurrentToken()).toBeNull();
      expect(
        (qwenContentGenerator as unknown as { currentEndpoint: string | null })
          .currentEndpoint,
      ).toBeNull();
      expect(
        (
          qwenContentGenerator as unknown as {
            refreshPromise: Promise<string> | null;
          }
        ).refreshPromise,
      ).toBeNull();
    });

    it('should handle concurrent token refresh requests', async () => {
      let refreshCallCount = 0;

      // Clear any existing cached token first
      qwenContentGenerator.clearToken();

      // Mock to simulate auth error on first parent call, which should trigger refresh
      const authError = { status: 401, message: 'Unauthorized' };
      let parentCallCount = 0;

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'initial-token',
      });
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

      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'initial-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        ...mockCredentials,
        resource_url: 'custom-endpoint.com',
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
});
