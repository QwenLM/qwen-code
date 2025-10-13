/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { loadEnvironment, loadSettings } from './settings.js';

export function validateAuthMethod(authMethod: string): string | null {
  const settings = loadSettings();
  loadEnvironment(settings.merged);

  if (authMethod === AuthType.USE_OPENAI) {
    const hasApiKey =
      process.env['OPENAI_API_KEY'] || settings.merged.security?.auth?.apiKey;
    if (!hasApiKey) {
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
}
