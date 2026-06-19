import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';

import type { Config } from '../config/config.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import { AuthType } from '../core/contentGenerator.js';
import { OpenAIContentGenerator } from '../core/openaiContentGenerator/openaiContentGenerator.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { NestorOpenAICompatibleProvider } from './nestorOpenAICompatibleProvider.js';
import {
  refreshDpCredentials,
  resolveDpCredentials,
  type ResolvedDpCredentials,
} from './dpTokenManager.js';
import { resolveNestorBaseUrl, resolveNestorModel } from './dpConfig.js';

const debugLogger = createDebugLogger('DP_AUTH');

export async function createDpContentGenerator(
  contentGeneratorConfig: ContentGeneratorConfig,
  cliConfig: Config,
): Promise<DpContentGenerator> {
  const credentials = await resolveDpCredentials(contentGeneratorConfig.apiKey);
  return new DpContentGenerator(
    buildEffectiveConfig(contentGeneratorConfig, credentials),
    cliConfig,
  );
}

function buildEffectiveConfig(
  contentGeneratorConfig: ContentGeneratorConfig,
  credentials: ResolvedDpCredentials,
): ContentGeneratorConfig {
  return {
    ...contentGeneratorConfig,
    authType: AuthType.DP_AUTH,
    apiKey: credentials.jwt,
    apiKeyEnvKey:
      contentGeneratorConfig.apiKeyEnvKey ?? credentials.sourceEnvKey,
    baseUrl: contentGeneratorConfig.baseUrl || resolveNestorBaseUrl(),
    model: contentGeneratorConfig.model || resolveNestorModel(),
  };
}

export class DpContentGenerator extends OpenAIContentGenerator {
  private contentGeneratorConfig: ContentGeneratorConfig;
  private readonly cliConfig: Config;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    const provider = new NestorOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig,
    );
    super(contentGeneratorConfig, cliConfig, provider);
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
  }

  protected override shouldSuppressErrorLogging(
    error: unknown,
    _request: GenerateContentParameters,
  ): boolean {
    return this.isAuthError(error);
  }

  override async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.executeWithCredentialManagement(() =>
      super.generateContent(request, userPromptId),
    );
  }

  override async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.executeWithCredentialManagement(() =>
      super.generateContentStream(request, userPromptId),
    );
  }

  override async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.executeWithCredentialManagement(() =>
      super.embedContent(request),
    );
  }

  private async executeWithCredentialManagement<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!this.isAuthError(error)) {
        throw error;
      }

      debugLogger.info('Nestor auth error detected, refreshing DP credentials');
      const credentials = await refreshDpCredentials();
      this.applyCredentials(credentials);
      return await operation();
    }
  }

  private applyCredentials(credentials: ResolvedDpCredentials): void {
    this.contentGeneratorConfig = buildEffectiveConfig(
      this.contentGeneratorConfig,
      credentials,
    );
    const provider = new NestorOpenAICompatibleProvider(
      this.contentGeneratorConfig,
      this.cliConfig,
    );
    this.pipeline.client = provider.buildClient();
  }

  private isAuthError(error: unknown): boolean {
    if (!error) return false;

    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
    const withCode = error as {
      status?: number | string;
      code?: number | string;
    };
    const code = withCode.status ?? withCode.code;

    return (
      code === 401 ||
      code === 403 ||
      code === '401' ||
      code === '403' ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('invalid api key') ||
      message.includes('token expired') ||
      message.includes('authentication')
    );
  }
}
