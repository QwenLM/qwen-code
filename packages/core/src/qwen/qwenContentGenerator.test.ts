/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IQwenOAuth2Client } from './qwenOAuth2.js';
import { type QwenCredentials, type ErrorData } from './qwenOAuth2.js';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import { FinishReason } from '@google/genai';
import { QwenContentGenerator } from './qwenContentGenerator.js';
import { SharedTokenManager } from './sharedTokenManager.js';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { collect, userText } from '../test-utils/model-fixtures.js';

// Mock OpenAI client to avoid real network calls
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn(),
      },
    };
    embeddings = {
      create: vi.fn(),
    };
    apiKey = '';
    baseURL = '';
    constructor(config: { apiKey: string; baseURL: string }) {
      this.apiKey = config.apiKey;
      this.baseURL = config.baseURL;
    }
  },
}));

// Mock DashScope provider
vi.mock('../core/openaiContentGenerator/provider/dashscope.js', () => ({
  DashScopeOpenAICompatibleProvider: class {
    constructor(_config: unknown, _cliConfig: unknown) {}
  },
}));

// Mock ContentGenerationPipeline
vi.mock('../core/openaiContentGenerator/pipeline.js', () => ({
  ContentGenerationPipeline: class {
    client: {
      apiKey: string;
      baseURL: string;
      chat: {
        completions: {
          create: ReturnType<typeof vi.fn>;
        };
      };
      embeddings: {
        create: ReturnType<typeof vi.fn>;
      };
    };

    constructor(_config: unknown) {
      this.client = {
        apiKey: '',
        baseURL: '',
        chat: {
          completions: {
            create: vi.fn(),
          },
        },
        embeddings: {
          create: vi.fn(),
        },
      };
    }

    async execute(
      _request: GenerateContentParameters,
      _userPromptId: string,
    ): Promise<GenerateContentResponse> {
      return createMockResponse('Test response');
    }

    async executeStream(
      _request: GenerateContentParameters,
      _userPromptId: string,
    ): Promise<AsyncGenerator<GenerateContentResponse>> {
      return (async function* () {
        yield createMockResponse('Stream chunk 1');
        yield createMockResponse('Stream chunk 2');
      })();
    }

    async embedContent(
      _request: EmbedContentParameters,
    ): Promise<EmbedContentResponse> {
      return { embeddings: [{ values: [0.1, 0.2, 0.3] }] };
    }
  },
}));

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
vi.mock('../core/openaiContentGenerator/index.js', () => ({
  OpenAIContentGenerator: class {
    pipeline: {
      client: {
        apiKey: string;
        baseURL: string;
      };
    };

    constructor(_config: Config, _provider: unknown) {
      this.pipeline = {
        client: {
          apiKey: 'test-key',
          baseURL: 'https://api.openai.com/v1',
        },
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
  const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const TOKEN_FAILURE = 'Failed to obtain valid Qwen access token';

  // Private members the tests reach into.
  type Internals = {
    currentToken: string;
    sharedManager: SharedTokenManager;
    pipeline: { client: { apiKey: string; baseURL: string } };
    getCurrentEndpoint: (resourceUrl?: string) => string;
    isAuthError: (error: unknown) => boolean;
    shouldSuppressErrorLogging: (
      error: unknown,
      request: GenerateContentParameters,
    ) => boolean;
  };
  const internals = (generator = qwenContentGenerator) =>
    generator as unknown as Internals;
  // The singleton from the SharedTokenManager mock, with its test hooks.
  const tokenManagerMock = () =>
    SharedTokenManager.getInstance() as unknown as {
      setMockError: (error: Error | null) => void;
      setMockCredentials: (credentials: QwenCredentials | null) => void;
    };

  const request = (text = 'Hello'): GenerateContentParameters => ({
    model: 'qwen-turbo',
    contents: [userText(text)],
  });
  const generate = (req = request()) =>
    qwenContentGenerator.generateContent(req, 'test-prompt-id');
  const streamTexts = async (req: GenerateContentParameters) =>
    (
      await collect(
        await qwenContentGenerator.generateContentStream(req, 'test-prompt-id'),
      )
    ).map((chunk) => chunk.text || '');
  const expectTokenFailure = (promise: Promise<unknown>) =>
    expect(promise).rejects.toThrow(TOKEN_FAILURE);

  const mockToken = (
    credentials: QwenCredentials = mockCredentials,
    token = 'valid-token',
  ) => {
    vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({ token });
    vi.mocked(mockQwenClient.getCredentials).mockReturnValue(credentials);
  };
  // A successful refresh response and the credentials the client holds after it.
  const mockRefresh = (
    access_token: string,
    resource_url: string,
    { expires_in = 3600, refreshCarriesUrl = true } = {},
  ) => {
    vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
      access_token,
      token_type: 'Bearer',
      expires_in,
      ...(refreshCarriesUrl ? { resource_url } : {}),
    });
    vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
      access_token,
      token_type: 'Bearer',
      refresh_token: 'refresh-token',
      resource_url,
      expiry_date: Date.now() + expires_in * 1000,
    });
  };
  // getAccessToken fails on the first two calls (initial + retry), then succeeds.
  const failTwiceThen = (authError: object, token: string) => {
    let calls = 0;
    vi.mocked(mockQwenClient.getAccessToken).mockImplementation(async () => {
      if (++calls <= 2) throw authError;
      return { token };
    });
  };

  // Swaps a method on the mocked OpenAIContentGenerator prototype; returns the restore.
  const patchParent = (
    name: 'generateContent' | 'generateContentStream',
    impl: unknown,
  ) => {
    const proto = Object.getPrototypeOf(
      Object.getPrototypeOf(qwenContentGenerator),
    );
    const original = proto[name];
    proto[name] = impl;
    return () => {
      proto[name] = original;
    };
  };
  const newGenerator = (extra: { baseUrl?: string; apiKey?: string } = {}) =>
    new QwenContentGenerator(
      mockQwenClient,
      { model: 'qwen-turbo', authType: AuthType.QWEN_OAUTH, ...extra },
      mockConfig,
    );
  // A generator whose SharedTokenManager.getInstance() returns `manager`. Only
  // the constructor calls getInstance, so the original is restored right away.
  const generatorWith = (manager: object) => {
    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(manager);
    try {
      return newGenerator();
    } finally {
      SharedTokenManager.getInstance = originalGetInstance;
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        model: 'qwen-turbo',
        apiKey: 'test-api-key',
        authType: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        },
      }),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    mockQwenClient = {
      getAccessToken: vi.fn(),
      getCredentials: vi.fn(),
      setCredentials: vi.fn(),
      refreshAccessToken: vi.fn(),
      requestDeviceAuthorization: vi.fn(),
      pollDeviceToken: vi.fn(),
    };

    const contentGeneratorConfig = {
      model: 'qwen-turbo',
      apiKey: 'test-api-key',
      authType: AuthType.QWEN_OAUTH,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      timeout: 120000,
      maxRetries: 3,
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
      mockToken();
      const result = await generate();
      expect(result.text).toBe('Generated content');
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });

    it('should generate content stream with valid token', async () => {
      mockToken();
      expect(await streamTexts(request('Hello stream'))).toEqual([
        'Stream chunk 1',
        'Stream chunk 2',
      ]);
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });

    it('should embed content with valid token', async () => {
      mockToken();
      const result = await qwenContentGenerator.embedContent({
        model: 'qwen-turbo',
        contents: [{ parts: [{ text: 'Embed me' }] }],
      });
      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings?.[0]?.values).toEqual([0.1, 0.2, 0.3]);
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });
  });

  describe('Token Management and Refresh Logic', () => {
    // getAccessToken fails once with a 401, then succeeds after the refresh.
    const mockRefreshFlow = (token: string, resourceUrl: string) => {
      vi.mocked(mockQwenClient.getAccessToken)
        .mockRejectedValueOnce({ status: 401, message: 'Unauthorized' })
        .mockResolvedValueOnce({ token });
      mockRefresh(token, resourceUrl);
    };

    it('should refresh token on auth error and retry', async () => {
      mockRefreshFlow('refreshed-token', 'https://refreshed-endpoint.com');
      const result = await generate();
      expect(result.text).toBe('Generated content');
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
    });

    it('should refresh token on auth error and retry for content stream', async () => {
      vi.clearAllMocks();
      mockRefreshFlow(
        'refreshed-stream-token',
        'https://refreshed-stream-endpoint.com',
      );
      expect(await streamTexts(request('Hello stream'))).toEqual([
        'Stream chunk 1',
        'Stream chunk 2',
      ]);
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
    });

    it('should handle token refresh failure', async () => {
      const message = `${TOKEN_FAILURE}. Please re-authenticate.`;
      tokenManagerMock().setMockError(new Error(message));
      await expect(generate()).rejects.toThrow(message);
      tokenManagerMock().setMockError(null);
    });

    it('should update endpoint when token is refreshed', async () => {
      mockToken({
        ...mockCredentials,
        resource_url: 'https://new-endpoint.com',
      });
      await generate();
      expect(mockQwenClient.getCredentials).toHaveBeenCalled();
    });
  });

  describe('Endpoint URL Normalization', () => {
    it.each<[string, QwenCredentials, string]>([
      [
        'should use default endpoint when no custom endpoint provided',
        { access_token: 'test-token', refresh_token: 'test-refresh' },
        DEFAULT_ENDPOINT,
      ],
      [
        'should normalize hostname-only endpoints by adding https protocol',
        { ...mockCredentials, resource_url: 'custom-endpoint.com' },
        'https://custom-endpoint.com/v1',
      ],
      [
        'should preserve existing protocol in endpoint URLs',
        { ...mockCredentials, resource_url: 'https://custom-endpoint.com' },
        'https://custom-endpoint.com/v1',
      ],
      [
        'should not duplicate /v1 suffix if already present',
        { ...mockCredentials, resource_url: 'https://custom-endpoint.com/v1' },
        'https://custom-endpoint.com/v1',
      ],
    ])('%s', async (_title, credentials, expected) => {
      let capturedBaseURL = '';
      mockToken(credentials);
      // Capture the baseURL the parent sees during the call.
      const restore = patchParent(
        'generateContent',
        vi.fn().mockImplementation(function (this: Internals) {
          capturedBaseURL = this.pipeline.client.baseURL;
          return createMockResponse('Generated content');
        }),
      );
      await generate();
      expect(capturedBaseURL).toBe(expected);
      restore();
    });
  });

  describe('Client State Management', () => {
    it('should set dynamic credentials during operations', async () => {
      const { client } = internals().pipeline;
      mockToken(
        {
          ...mockCredentials,
          access_token: 'temp-token',
          resource_url: 'https://temp-endpoint.com',
        },
        'temp-token',
      );
      await generate();
      expect(client.apiKey).toBe('temp-token');
      expect(client.baseURL).toBe('https://temp-endpoint.com/v1');
    });

    it('should set credentials even when operation throws', async () => {
      const { client } = internals().pipeline;
      mockToken(
        { ...mockCredentials, access_token: 'temp-token' },
        'temp-token',
      );
      const mockError = new Error('Network error');
      const restore = patchParent(
        'generateContent',
        vi.fn().mockRejectedValue(mockError),
      );
      try {
        await generate();
      } catch (error) {
        expect(error).toBe(mockError);
      }
      // Credentials are set before the error occurs.
      expect(client.apiKey).toBe('temp-token');
      expect(client.baseURL).toBe('https://test-endpoint.com/v1');
      restore();
    });
  });

  describe('Error Handling and Retry Logic', () => {
    it('should retry once on authentication errors', async () => {
      const authError = { status: 401, message: 'Unauthorized' };
      const mockGenerateContent = vi
        .fn()
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce(createMockResponse('Success after retry'));
      const restore = patchParent('generateContent', mockGenerateContent);
      failTwiceThen(authError, 'refreshed-token');
      mockRefresh('refreshed-token', 'https://test-endpoint.com', {
        refreshCarriesUrl: false,
      });

      const result = await generate();
      expect(result.text).toBe('Success after retry');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
      restore();
    });

    it('should not retry non-authentication errors', async () => {
      const mockGenerateContent = vi
        .fn()
        .mockRejectedValue(new Error('Network timeout'));
      const restore = patchParent('generateContent', mockGenerateContent);
      mockToken();

      await expect(generate()).rejects.toThrow('Network timeout');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockQwenClient.refreshAccessToken).not.toHaveBeenCalled();
      restore();
    });

    it('should handle error response from token refresh', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(
        new Error('Token expired'),
      );
      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        error: 'invalid_grant',
        error_description: 'Refresh token expired',
      } as ErrorData);
      await expectTokenFailure(generate());
    });
  });

  describe('Token State Management', () => {
    it('should cache and return current token', () => {
      expect(qwenContentGenerator.getCurrentToken()).toBeNull();
      internals().currentToken = 'cached-token'; // simulate a token set internally
      expect(qwenContentGenerator.getCurrentToken()).toBe('cached-token');
    });

    it('should clear token on clearToken()', () => {
      internals().currentToken = 'cached-token';
      qwenContentGenerator.clearToken();
      expect(qwenContentGenerator.getCurrentToken()).toBeNull();
    });

    it('should handle concurrent token refresh requests', async () => {
      let refreshCallCount = 0;
      let parentCallCount = 0;
      qwenContentGenerator.clearToken(); // drop any cached token first

      // An auth error on the first parent call should trigger a refresh.
      const authError = { status: 401, message: 'Unauthorized' };
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(authError);
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue(mockCredentials);
      vi.mocked(mockQwenClient.refreshAccessToken).mockImplementation(
        async () => {
          refreshCallCount++;
          await new Promise((resolve) => setTimeout(resolve, 50)); // long enough for the requests to overlap
          return {
            access_token: 'refreshed-token',
            token_type: 'Bearer',
            expires_in: 3600,
          };
        },
      );
      const restore = patchParent(
        'generateContent',
        vi.fn().mockImplementation(async () => {
          if (++parentCallCount === 1) throw authError;
          return createMockResponse('Generated content');
        }),
      );

      // Concurrent requests should all share one refresh promise.
      const results = await Promise.all([generate(), generate(), generate()]);
      results.forEach((result) => {
        expect(result.text).toBe('Generated content');
      });
      // The main point is that every request succeeds; the refresh still runs
      // through SharedTokenManager.
      expect(results).toHaveLength(3);
      expect(refreshCallCount).toBeGreaterThanOrEqual(1);
      restore();
    });
  });

  describe('Error Logging Suppression', () => {
    const suppresses = (error: unknown) =>
      internals().shouldSuppressErrorLogging(
        error,
        {} as GenerateContentParameters,
      );

    it('should suppress logging for authentication errors', () => {
      [
        { status: 401 },
        { code: 403 },
        new Error('Unauthorized access'),
        new Error('Token expired'),
        new Error('Invalid API key'),
      ].forEach((error) => {
        expect(suppresses(error)).toBe(true);
      });
    });

    it('should not suppress logging for non-auth errors', () => {
      [
        new Error('Network timeout'),
        new Error('Rate limit exceeded'),
        { status: 500 },
        new Error('Internal server error'),
      ].forEach((error) => {
        expect(suppresses(error)).toBe(false);
      });
    });
  });

  describe('Integration Tests', () => {
    it('should handle complete workflow: get token, use it, refresh on auth error, retry', async () => {
      const authError = { status: 401, message: 'Token expired' };
      let callCount = 0;
      // The first parent call fails, the retry succeeds. (Left patched.)
      patchParent(
        'generateContent',
        vi.fn().mockImplementation(async () => {
          if (++callCount === 1) throw authError;
          return createMockResponse('Success after refresh');
        }),
      );
      failTwiceThen(authError, 'new-token');
      mockRefresh('new-token', 'https://new-endpoint.com', {
        expires_in: 7200,
      });

      const result = await generate(request('Test message'));
      expect(result.text).toBe('Success after refresh');
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
      expect(callCount).toBe(2); // initial call + retry
    });
  });

  describe('SharedTokenManager Integration', () => {
    it('should use SharedTokenManager to get valid credentials', async () => {
      const manager = {
        getValidCredentials: vi.fn().mockResolvedValue({
          access_token: 'manager-token',
          resource_url: 'https://manager-endpoint.com',
        }),
        getCurrentCredentials: vi.fn(),
        clearCache: vi.fn(),
      };
      await generatorWith(manager).generateContent(request(), 'test-prompt-id');
      expect(manager.getValidCredentials).toHaveBeenCalledWith(mockQwenClient);
    });

    it('should handle SharedTokenManager errors gracefully', async () => {
      const generator = generatorWith({
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('Token manager error')),
        getCurrentCredentials: vi.fn(),
        clearCache: vi.fn(),
      });
      await expectTokenFailure(
        generator.generateContent(request(), 'test-prompt-id'),
      );
    });

    it('should handle missing access token from credentials', async () => {
      const generator = generatorWith({
        getValidCredentials: vi.fn().mockResolvedValue({
          access_token: undefined,
          resource_url: 'https://test-endpoint.com',
        }),
        getCurrentCredentials: vi.fn(),
        clearCache: vi.fn(),
      });
      await expectTokenFailure(
        generator.generateContent(request(), 'test-prompt-id'),
      );
    });
  });

  describe('getCurrentEndpoint Method', () => {
    const expectEndpoints = (pairs: string[][]) =>
      pairs.forEach(([input, expected]) => {
        expect(internals().getCurrentEndpoint(input)).toBe(expected);
      });

    it('should handle URLs with custom ports', () => {
      expectEndpoints([
        ['localhost:8080', 'https://localhost:8080/v1'],
        ['http://localhost:8080', 'http://localhost:8080/v1'],
        ['https://api.example.com:443', 'https://api.example.com:443/v1'],
        ['HTTPS://api.example.com', 'HTTPS://api.example.com/v1'],
        ['HtTp://localhost:8080', 'HtTp://localhost:8080/v1'],
        ['api.example.com:9000/api', 'https://api.example.com:9000/api/v1'],
      ]);
    });

    it('should handle URLs with existing paths', () => {
      expectEndpoints([
        ['https://api.example.com/api', 'https://api.example.com/api/v1'],
        ['api.example.com/api/v2', 'https://api.example.com/api/v2/v1'],
        ['https://api.example.com/api/v1', 'https://api.example.com/api/v1'],
      ]);
    });

    it('should handle undefined resource URL', () => {
      expect(internals().getCurrentEndpoint(undefined)).toBe(DEFAULT_ENDPOINT);
    });

    it('should handle empty resource URL', () => {
      // An empty string falls back to the default endpoint.
      expect(internals().getCurrentEndpoint('')).toBe(DEFAULT_ENDPOINT);
    });
  });

  describe('isAuthError Method Enhanced', () => {
    const isAuthError = (error: unknown) => internals().isAuthError(error);
    const expectAuth = (errors: unknown[], expected: boolean) =>
      errors.forEach((error) => {
        expect(isAuthError(error)).toBe(expected);
      });

    it('should identify auth errors by numeric status codes', () => {
      // String status codes count too.
      expectAuth(
        [{ code: 401 }, { status: 403 }, { code: '401' }, { status: '403' }],
        true,
      );
      // 400 is a bad request, not an auth error.
      expect(isAuthError({ status: 400 })).toBe(false);
    });

    it('should identify auth errors by message content variations', () => {
      expectAuth(
        [
          'UNAUTHORIZED access',
          'Access is FORBIDDEN',
          'Invalid API Key provided',
          'Invalid Access Token',
          'Token has Expired',
          'Authentication Required',
          'Access Denied by server',
          'The token has expired and needs refresh',
          'Bearer token expired',
        ].map((message) => new Error(message)),
        true,
      );
    });

    it('should not identify non-auth errors', () => {
      expectAuth(
        [
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
        ],
        false,
      );
    });

    it('should handle complex error objects', () => {
      // Not auth errors: the method only looks at top-level properties.
      expectAuth(
        [
          { error: { status: 401, message: 'Unauthorized' } },
          { response: { status: 403 } },
          { details: { code: 401 } },
        ],
        false,
      );
    });
  });

  describe('Stream Error Handling', () => {
    it('should set credentials when stream generation fails', async () => {
      const { client } = internals().pipeline;
      mockToken(
        {
          ...mockCredentials,
          access_token: 'stream-token',
          resource_url: 'https://stream-endpoint.com',
        },
        'stream-token',
      );
      const restore = patchParent(
        'generateContentStream',
        vi.fn().mockRejectedValue(new Error('Stream error')),
      );
      try {
        await qwenContentGenerator.generateContentStream(
          request('Stream test'),
          'test-prompt-id',
        );
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      // Credentials are set before the error occurs.
      expect(client.apiKey).toBe('stream-token');
      expect(client.baseURL).toBe('https://stream-endpoint.com/v1');
      restore();
    });

    it('should set credentials for successful streams', async () => {
      const { client } = internals().pipeline;
      const streamCredentials = {
        access_token: 'stream-token',
        refresh_token: 'stream-refresh-token',
        resource_url: 'https://stream-endpoint.com',
        expiry_date: Date.now() + 3600000,
      };
      mockToken(streamCredentials, 'stream-token');
      // The SharedTokenManager mock returns the same credentials.
      tokenManagerMock().setMockCredentials(streamCredentials);

      const stream = await qwenContentGenerator.generateContentStream(
        request('Stream test'),
        'test-prompt-id',
      );
      // Credentials are set once the stream is created.
      expect(client.apiKey).toBe('stream-token');
      expect(client.baseURL).toBe('https://stream-endpoint.com/v1');
      expect(stream).toBeDefined();
      expect(await collect(stream)).toHaveLength(2);
      tokenManagerMock().setMockCredentials(null);
    });
  });

  describe('Token and Endpoint Management', () => {
    it.each<[string, QwenCredentials | null, string | null]>([
      [
        'should get current token from SharedTokenManager',
        { access_token: 'current-token' },
        'current-token',
      ],
      ['should return null when no credentials available', null, null],
      [
        'should return null when credentials have no access token',
        { access_token: undefined },
        null,
      ],
    ])('%s', (_title, credentials, expected) => {
      const generator = generatorWith({
        getCurrentCredentials: vi.fn().mockReturnValue(credentials),
      });
      expect(generator.getCurrentToken()).toBe(expected);
    });

    it('should clear token through SharedTokenManager', () => {
      const manager = { clearCache: vi.fn() };
      generatorWith(manager).clearToken();
      expect(manager.clearCache).toHaveBeenCalled();
    });
  });

  describe('Constructor and Initialization', () => {
    it('should initialize with configured base URL when provided', () => {
      const generator = newGenerator({
        baseUrl: DEFAULT_ENDPOINT,
        apiKey: 'test-key',
      });
      expect(internals(generator).pipeline.client.baseURL).toBe(
        DEFAULT_ENDPOINT,
      );
    });

    it('should get SharedTokenManager instance', () => {
      expect(internals(newGenerator()).sharedManager).toBeDefined();
    });
  });

  describe('Edge Cases and Error Conditions', () => {
    const failingGenerator = (message: string) =>
      generatorWith({
        getValidCredentials: vi.fn().mockRejectedValue(new Error(message)),
      });

    it('should handle token retrieval with warning when SharedTokenManager fails', async () => {
      const generator = failingGenerator('Internal token manager error');
      await expectTokenFailure(
        generator.generateContent(request(), 'test-prompt-id'),
      );
    });

    it('should handle method types with token failure', async () => {
      const generator = failingGenerator('Token error');
      // Every method that needs authentication fails.
      await expectTokenFailure(generator.generateContent(request(), 'test-id'));
      await expectTokenFailure(
        generator.generateContentStream(request(), 'test-id'),
      );
      await expectTokenFailure(
        generator.embedContent({
          model: 'qwen-turbo',
          contents: [{ parts: [{ text: 'Embed' }] }],
        }),
      );
    });
  });
});
