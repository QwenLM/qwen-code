/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { loadEnvironment } from './settings.js';

export const validateAuthMethod = (authMethod: string): string | null => {
  loadEnvironment();
  if (
    authMethod === AuthType.LOGIN_WITH_GOOGLE ||
    authMethod === AuthType.CLOUD_SHELL
  ) {
    return null;
  }

  if (authMethod === AuthType.USE_GEMINI) {
    if (!process.env['GEMINI_API_KEY']) {
      return 'GEMINI_API_KEY environment variable not found. Add that to your environment and try again (no reload needed if using .env)!';
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI) {
    const hasVertexProjectLocationConfig =
      !!process.env['GOOGLE_CLOUD_PROJECT'] &&
      !!process.env['GOOGLE_CLOUD_LOCATION'];
    const hasGoogleApiKey = !!process.env['GOOGLE_API_KEY'];
    if (!hasVertexProjectLocationConfig && !hasGoogleApiKey) {
      return (
        'When using Vertex AI, you must specify either:\n' +
        '• GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.\n' +
        '• GOOGLE_API_KEY environment variable (if using express mode).\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    return null;
  }

  if (authMethod === AuthType.AZURE_OPENAI) {
    const hasEndpoint = !!process.env.AZURE_OPENAI_ENDPOINT;
    const hasDeployment = !!process.env.AZURE_OPENAI_DEPLOYMENT;
    const hasApiKey = !!process.env.AZURE_OPENAI_API_KEY;
    const hasBearerToken = !!process.env.AZURE_OPENAI_BEARER_TOKEN;
    const hasCred = hasApiKey || hasBearerToken;

    const missingVars = [];
    if (!hasEndpoint) missingVars.push('AZURE_OPENAI_ENDPOINT');
    if (!hasDeployment) missingVars.push('AZURE_OPENAI_DEPLOYMENT');
    if (!hasCred)
      missingVars.push('AZURE_OPENAI_API_KEY or AZURE_OPENAI_BEARER_TOKEN');

    if (!hasEndpoint || !hasDeployment || !hasCred) {
      return (
        'Azure OpenAI configuration incomplete. Missing:\n' +
        '• ' +
        missingVars.join('\n• ') +
        '\n' +
        'You can enter these interactively or add them to your .env file.'
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_OPENAI) {
    const isOpenAIKeySet = !!process.env.OPENAI_API_KEY;

    // For USE_OPENAI auth type, only validate OpenAI API key
    // Azure configuration should use AZURE_OPENAI auth type instead
    if (!isOpenAIKeySet) {
      return (
        'OpenAI configuration not found. You must set:\n' +
        '• OPENAI_API_KEY environment variable for standard OpenAI\n' +
        'You can enter this interactively or add it to your .env file.\n' +
        '\nNote: For Azure OpenAI, please select "Azure OpenAI" authentication instead.'
      );
    }
    return null;
  }

  if (authMethod === AuthType.QWEN_OAUTH) {
    // Qwen OAuth doesn't require any environment variables for basic setup
    // The OAuth flow will handle authentication
    return null;
  }

  return 'Invalid auth method selected.';
};

export const setOpenAIApiKey = (apiKey: string): void => {
  process.env['OPENAI_API_KEY'] = apiKey;
};

export const setAzureOpenAIConfig = (
  endpoint: string,
  deployment: string,
  apiKey: string,
  apiVersion?: string,
): void => {
  process.env.AZURE_OPENAI_ENDPOINT = endpoint;
  process.env.AZURE_OPENAI_DEPLOYMENT = deployment;
  process.env.AZURE_OPENAI_API_KEY = apiKey;
  if (apiVersion) {
    process.env.AZURE_OPENAI_API_VERSION = apiVersion;
  }
};

export const setOpenAIBaseUrl = (baseUrl: string): void => {
  process.env['OPENAI_BASE_URL'] = baseUrl;
};

export const setOpenAIModel = (model: string): void => {
  process.env['OPENAI_MODEL'] = model;
};
