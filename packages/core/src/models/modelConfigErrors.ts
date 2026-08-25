/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function getDefaultApiKeyEnvVar(authType: string | undefined): string {
  switch (authType) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'vertex-ai':
      return 'GOOGLE_API_KEY';
    default:
      return 'API_KEY';
  }
}

export function getDefaultModelEnvVar(authType: string | undefined): string {
  switch (authType) {
    case 'openai':
      return 'OPENAI_MODEL';
    case 'anthropic':
      return 'ANTHROPIC_MODEL';
    case 'gemini':
      return 'GEMINI_MODEL';
    case 'vertex-ai':
      return 'GOOGLE_MODEL';
    default:
      return 'MODEL';
  }
}

/**
 * Vertex AI has a keyless path, so pointing the user only at an API key
 * variable sends them toward a placeholder value, which the Google SDK then
 * treats as an Express mode key and the API rejects. Shared with the CLI's own
 * missing-key message so the two surfaces cannot drift.
 */
export const VERTEX_ADC_HINT =
  ' Alternatively, set GOOGLE_CLOUD_PROJECT to authenticate with Application Default Credentials instead of an API key.';

/**
 * Only offered when the entry declares no key variable of its own: those
 * entries never take the ADC path, so suggesting a project there would be
 * advice that cannot work.
 */
function adcHint(
  authType: string | undefined,
  explicitEnvKey: string | undefined,
): string {
  return authType === 'vertex-ai' && !explicitEnvKey ? VERTEX_ADC_HINT : '';
}

export abstract class ModelConfigError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class StrictMissingCredentialsError extends ModelConfigError {
  readonly code = 'STRICT_MISSING_CREDENTIALS';

  constructor(
    authType: string | undefined,
    model: string | undefined,
    envKey?: string,
  ) {
    const providerKey = authType || '(unknown)';
    const modelName = model || '(unknown)';
    super(
      `Missing credentials for modelProviders model '${modelName}'. ` +
        (envKey
          ? `Current configured envKey: '${envKey}'. Set that environment variable, or update modelProviders.${providerKey}[].envKey.`
          : `Configure modelProviders.${providerKey}[].envKey and set that environment variable.`) +
        adcHint(authType, envKey),
    );
  }
}

export class StrictMissingModelIdError extends ModelConfigError {
  readonly code = 'STRICT_MISSING_MODEL_ID';

  constructor(authType: string | undefined) {
    super(
      `Missing model id for strict modelProviders resolution (authType: ${authType}).`,
    );
  }
}

export class MissingApiKeyError extends ModelConfigError {
  readonly code = 'MISSING_API_KEY';

  constructor(params: {
    authType: string | undefined;
    model: string | undefined;
    baseUrl: string | undefined;
    envKey: string;
    /** The entry's own key variable, if it declares one. */
    explicitEnvKey?: string;
  }) {
    super(
      `Missing API key for ${params.authType} auth. ` +
        `Current model: '${params.model || '(unknown)'}', baseUrl: '${params.baseUrl || '(default)'}'. ` +
        `Provide an API key via settings (security.auth.apiKey), ` +
        `or set the environment variable '${params.envKey}'.` +
        adcHint(params.authType, params.explicitEnvKey),
    );
  }
}

export class MissingModelError extends ModelConfigError {
  readonly code = 'MISSING_MODEL';

  constructor(params: { authType: string | undefined; envKey: string }) {
    super(
      `Missing model for ${params.authType} auth. ` +
        `Set the environment variable '${params.envKey}'.`,
    );
  }
}

export class MissingBaseUrlError extends ModelConfigError {
  readonly code = 'MISSING_BASE_URL';

  constructor(params: {
    authType: string | undefined;
    model: string | undefined;
  }) {
    super(
      `Missing baseUrl for modelProviders model '${params.model || '(unknown)'}'. ` +
        `Configure modelProviders.${params.authType || '(unknown)'}[].baseUrl.`,
    );
  }
}

export class MissingAnthropicBaseUrlEnvError extends ModelConfigError {
  readonly code = 'MISSING_ANTHROPIC_BASE_URL_ENV';

  constructor() {
    super('ANTHROPIC_BASE_URL environment variable not found.');
  }
}
