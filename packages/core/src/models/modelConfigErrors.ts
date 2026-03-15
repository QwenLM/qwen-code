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

function modelProviderFieldPath(
  authType: string | undefined,
  providerId: string | undefined,
  field: string,
): string {
  if (providerId) {
    return `modelProviders.${providerId}.models[].${field}`;
  }
  return `modelProviders.${authType || '(unknown)'}[].${field}`;
}

function providerLabel(
  authType: string | undefined,
  providerId: string | undefined,
): string {
  if (providerId) {
    return `provider '${providerId}' (authType: ${authType || '(unknown)'})`;
  }
  return `${authType || '(unknown)'} auth`;
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
    providerId?: string,
  ) {
    const modelName = model || '(unknown)';
    const envKeyPath = modelProviderFieldPath(authType, providerId, 'envKey');
    super(
      `Missing credentials for modelProviders model '${modelName}'. ` +
        (envKey
          ? `Current configured envKey: '${envKey}'. Set that environment variable, or update ${envKeyPath}.`
          : `Configure ${envKeyPath} and set that environment variable.`),
    );
  }
}

export class StrictMissingModelIdError extends ModelConfigError {
  readonly code = 'STRICT_MISSING_MODEL_ID';

  constructor(authType: string | undefined, providerId?: string) {
    const label = providerLabel(authType, providerId);
    super(`Missing model id for strict modelProviders resolution (${label}).`);
  }
}

export class MissingApiKeyError extends ModelConfigError {
  readonly code = 'MISSING_API_KEY';

  constructor(params: {
    authType: string | undefined;
    model: string | undefined;
    baseUrl: string | undefined;
    envKey: string;
    providerId?: string;
  }) {
    const label = providerLabel(params.authType, params.providerId);
    super(
      `Missing API key for ${label}. ` +
        `Current model: '${params.model || '(unknown)'}', baseUrl: '${params.baseUrl || '(default)'}'. ` +
        `Provide an API key via settings (security.auth.apiKey), ` +
        `or set the environment variable '${params.envKey}'.`,
    );
  }
}

export class MissingModelError extends ModelConfigError {
  readonly code = 'MISSING_MODEL';

  constructor(params: {
    authType: string | undefined;
    envKey: string;
    providerId?: string;
  }) {
    const label = providerLabel(params.authType, params.providerId);
    super(
      `Missing model for ${label}. ` +
        `Set the environment variable '${params.envKey}'.`,
    );
  }
}

export class MissingBaseUrlError extends ModelConfigError {
  readonly code = 'MISSING_BASE_URL';

  constructor(params: {
    authType: string | undefined;
    model: string | undefined;
    providerId?: string;
  }) {
    const baseUrlPath = modelProviderFieldPath(
      params.authType,
      params.providerId,
      'baseUrl',
    );
    super(
      `Missing baseUrl for modelProviders model '${params.model || '(unknown)'}'. ` +
        `Configure ${baseUrlPath}.`,
    );
  }
}

export class MissingAnthropicBaseUrlEnvError extends ModelConfigError {
  readonly code = 'MISSING_ANTHROPIC_BASE_URL_ENV';

  constructor() {
    super('ANTHROPIC_BASE_URL environment variable not found.');
  }
}
