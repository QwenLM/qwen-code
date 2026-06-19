/**
 * Blaze Runtime DP/Nestor configuration.
 *
 * This module intentionally keeps the sandbox/server flow small: no DP binary
 * download, no interactive device flow, no Nessy CLI dependency.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export const BLAZE_RUNTIME_HOME_ENV = 'BLAZE_RUNTIME_HOME';
export const BLAZE_DP_CREDENTIALS_PATH_ENV = 'BLAZE_DP_CREDENTIALS_PATH';

export const BLAZE_DP_TOKEN_ENV = 'BLAZE_DP_TOKEN';
export const LEGACY_DP_TOKEN_ENV = 'DP_TOKEN';
export const BLAZE_DP_JWT_ENV = 'BLAZE_DP_JWT';
export const LEGACY_NESSY_DP_AUTH_TOKEN_ENV = 'NESSY_CLI_DP_AUTH_TOKEN';

export const BLAZE_NESTOR_SERVER_URL_ENV = 'BLAZE_NESTOR_SERVER_URL';
export const BLAZE_NESTOR_BASE_URL_ENV = 'BLAZE_NESTOR_BASE_URL';
export const LEGACY_NESTOR_BASE_URL_ENV = 'NESTOR_BASE_URL';
export const BLAZE_NESTOR_MODEL_ENV = 'BLAZE_NESTOR_MODEL';
export const LEGACY_NESTOR_MODEL_ENV = 'NESTOR_MODEL';

export const DEFAULT_NESTOR_SERVER_URL =
  'https://code-completion-nestor.tcsbank.ru';
export const DEFAULT_BLAZE_NESTOR_MODEL = 'tgpt/qwen3-next-80b-a3b-instruct';
export const DP_CREDENTIALS_FILE_NAME = 'dp_auth_creds.json';

export function getNestorServerUrl(): string {
  return (
    process.env[BLAZE_NESTOR_SERVER_URL_ENV] || DEFAULT_NESTOR_SERVER_URL
  ).replace(/\/+$/, '');
}

export function getDefaultNestorBaseUrl(): string {
  return `${getNestorServerUrl()}/api/v1/cli/openai-like/v1`;
}

export function resolveNestorBaseUrl(): string {
  return (
    process.env[BLAZE_NESTOR_BASE_URL_ENV] ||
    process.env[LEGACY_NESTOR_BASE_URL_ENV] ||
    getDefaultNestorBaseUrl()
  );
}

export function resolveNestorModel(): string {
  return (
    process.env[BLAZE_NESTOR_MODEL_ENV] ||
    process.env[LEGACY_NESTOR_MODEL_ENV] ||
    DEFAULT_BLAZE_NESTOR_MODEL
  );
}

export function getBlazeRuntimeHome(): string {
  return (
    process.env[BLAZE_RUNTIME_HOME_ENV] ||
    path.join(os.homedir(), '.blaze-runtime')
  );
}

export function getDpCredentialsPath(): string {
  return (
    process.env[BLAZE_DP_CREDENTIALS_PATH_ENV] ||
    path.join(getBlazeRuntimeHome(), DP_CREDENTIALS_FILE_NAME)
  );
}

export function getLegacyNessyCredentialsPath(): string {
  return path.join(os.homedir(), '.nessy', DP_CREDENTIALS_FILE_NAME);
}
