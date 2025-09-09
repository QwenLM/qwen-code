/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

type Model = string;
type TokenCount = number;

function parseTokenLimit(value: string | undefined): TokenCount {
  if (!value) {
    return 1_048_576; // Default if env var is not set
  }

  const normalizedValue = value.toLowerCase().trim();
  const multiplierMatch = normalizedValue.match(/^(\d+)([km])$/);
  let numericValue;
  let multiplier = 1;

  if (multiplierMatch) {
    numericValue = parseInt(multiplierMatch[1], 10);
    const suffix = multiplierMatch[2];
    if (suffix === 'k') {
      multiplier = 1024;
    } else if (suffix === 'm') {
      multiplier = 1024 * 1024;
    }
  } else {
    numericValue = parseInt(normalizedValue, 10);
  }

  if (isNaN(numericValue)) {
    // Fallback to default if parsing fails
    return 1_048_576;
  }

  return numericValue * multiplier;
}

export const DEFAULT_TOKEN_LIMIT: TokenCount = parseTokenLimit(
  process.env['DEFAULT_TOKEN_LIMIT'],
);

export function tokenLimit(model: Model): TokenCount {
  // Add other models as they become relevant or if specified by config
  // Pulled from https://ai.google.dev/gemini-api/docs/models
  switch (model) {
    case 'gemini-1.5-pro':
      return 2_097_152;
    case 'gemini-1.5-flash':
    case 'gemini-2.5-pro-preview-05-06':
    case 'gemini-2.5-pro-preview-06-05':
    case 'gemini-2.5-pro':
    case 'gemini-2.5-flash-preview-05-20':
    case 'gemini-2.5-flash':
    case 'gemini-2.5-flash-lite':
    case 'gemini-2.0-flash':
      return 1_048_576;
    case 'gemini-2.0-flash-preview-image-generation':
      return 32_000;
    default:
      return DEFAULT_TOKEN_LIMIT;
  }
}
