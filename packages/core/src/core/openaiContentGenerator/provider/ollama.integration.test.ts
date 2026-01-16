import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaOpenAICompatibleProvider } from './ollama.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import { ApprovalMode } from '../../../config/config.js';
import { OutputFormat } from '../../../output/types.js';

/**
 * Integration tests for Ollama provider
 * These tests require Ollama to be running locally on http://localhost:11434
 */
describe('OllamaOpenAICompatibleProvider - Integration Tests', () => {
  let provider: OllamaOpenAICompatibleProvider;
  let contentGeneratorConfig: ContentGeneratorConfig;
  let cliConfig: Config;
  const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
  const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] || 'Qwen3-Coder:30b';

  beforeAll(() => {
    contentGeneratorConfig = {
      model: OLLAMA_MODEL,
      authType: AuthType.USE_OLLAMA,
      baseUrl: OLLAMA_BASE_URL,
      apiKey: undefined,
      schemaCompliance: 'auto',
      customHeaders: {},
      samplingParams: {
        temperature: 0.7,
        max_tokens: 100,
      },
    };

    cliConfig = {
      getCliVersion: () => '0.7.1',
      getContentGeneratorConfig: () => contentGeneratorConfig,
      getModel: () => OLLAMA_MODEL,
      getEmbeddingModel: () => 'qwen3-embedding:8b',
      getSessionId: () => 'test-session',
      getMaxSessionTurns: () => 10,
      getSessionTokenLimit: () => 100000,
      getSkipStartupContext: () => false,
      getFullContext: () => false,
      getChatRecordingService: () => undefined,
      getUserMemory: () => '',
      getContentGenerator: () => undefined as any,
      getToolRegistry: () => undefined as any,
      getFileFilteringOptions: () => ({ respectGitIgnore: true, respectQwenIgnore: true }),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getIdeMode: () => false,
      getOutputFormat: () => OutputFormat.TEXT,
      getIncludePartialMessages: () => false,
      getScreenReader: () => false,
      getVlmSwitchMode: () => 'once',
      getUseSmartEdit: () => false,
      getSkipNextSpeakerCheck: () => false,
      getExperimentalSkills: () => false,
      getProxy: () => undefined,
      getWebSearchConfig: () => ({ provider: [], default: 'google' }),
      getMcpServers: () => ({}),
      getTrustedFolder: () => ({}),
      getSecuritySettings: () => ({}),
      getExtensionManagement: () => false,
      getExtensions: () => [],
      getCoreTools: () => [],
      getExcludeTools: () => [],
      getAllowedTools: () => [],
      getMemoryFileFilteringOptions: () => ({}),
      getContextFileName: () => 'GEMINI.md',
      getContextLoadMemoryFromIncludeDirectories: () => false,
      getCheckpointingEnabled: () => false,
    } as unknown as Config;

    provider = new OllamaOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig,
    );
  });

  describe('Non-streaming requests', () => {
    it('should send a simple non-streaming request and receive a response', async () => {
      const client = provider.buildClient();

      const response = await client.chat.completions.create({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'user', content: 'Say "Hello"' },
        ],
        temperature: 0.5,
        max_tokens: 10,
        stream: false,
      });

      expect(response).toBeDefined();
      expect(response.choices[0]?.message?.content).toBeTruthy();
      expect(response.choices[0]?.message?.content?.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe('Streaming requests', () => {
    it('should send a streaming request and receive chunks', async () => {
      const client = provider.buildClient();

      const stream = await client.chat.completions.create({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'user', content: 'Count from 1 to 5' },
        ],
        stream: true,
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].choices[0]?.finish_reason).toBe('stop');
    }, 30000);
  });
});