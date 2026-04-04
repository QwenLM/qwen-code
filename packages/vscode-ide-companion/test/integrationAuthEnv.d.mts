export interface IntegrationAuthEnvMap {
  [key: string]: string | undefined;
}

export interface ResolvedIntegrationAuthEnv {
  hasQwenOauth: boolean;
  hasModelAuth: boolean;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiModel?: string;
  qwenOauth?: string;
}

export declare function resolveIntegrationAuthEnv(
  env?: IntegrationAuthEnvMap,
): ResolvedIntegrationAuthEnv;

export declare function hasIntegrationAuthEnv(
  env?: IntegrationAuthEnvMap,
): boolean;

export declare function buildIntegrationRunnerEnv(
  env?: IntegrationAuthEnvMap,
): IntegrationAuthEnvMap;
