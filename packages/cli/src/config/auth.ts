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

  if (authMethod === AuthType.USE_OPENAI) {
    if (!process.env['OPENAI_API_KEY']) {
      return 'OPENAI_API_KEY environment variable not found. You can enter it interactively or add it to your .env file.';
    }
    return null;
  }

  if (authMethod === AuthType.QWEN_OAUTH) {
    // Qwen OAuth doesn't require any environment variables for basic setup
    // The OAuth flow will handle authentication
    return null;
  }

  if (authMethod === AuthType.USE_BEDROCK) {
    // AWS Bedrock uses the AWS credential chain (AWS_PROFILE, AWS_ACCESS_KEY_ID, etc.)
    // We don't strictly validate credentials here as the AWS SDK will handle it
    // Just provide helpful guidance if common env vars are missing
    const hasAwsProfile = !!process.env['AWS_PROFILE'];
    const hasAwsKeys =
      !!process.env['AWS_ACCESS_KEY_ID'] &&
      !!process.env['AWS_SECRET_ACCESS_KEY'];

    if (!hasAwsProfile && !hasAwsKeys) {
      return (
        'When using Amazon Bedrock, you should configure AWS credentials via:\n' +
        '• AWS_PROFILE environment variable (for named profiles), or\n' +
        '• AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables, or\n' +
        '• Default AWS credential chain (EC2/ECS instance roles, ~/.aws/credentials)\n' +
        'Note: You can proceed, but requests will fail if no credentials are available.'
      );
    }
    return null;
  }

  return 'Invalid auth method selected.';
};

export const setOpenAIApiKey = (apiKey: string): void => {
  process.env['OPENAI_API_KEY'] = apiKey;
};

export const setOpenAIBaseUrl = (baseUrl: string): void => {
  process.env['OPENAI_BASE_URL'] = baseUrl;
};

export const setOpenAIModel = (model: string): void => {
  process.env['OPENAI_MODEL'] = model;
};
