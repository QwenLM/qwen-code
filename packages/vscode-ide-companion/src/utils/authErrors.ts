/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

const CODE_PATTERN = /\(\s*code:\s*(-?\d+)\s*\)/i;

const toNumericCode = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }
  return null;
};

const extractCodeFromUnknown = (value: unknown): number | null => {
  if (!value) {
    return null;
  }

  const directCode = toNumericCode(value);
  if (directCode !== null) {
    return directCode;
  }

  if (typeof value === 'string') {
    const match = value.match(CODE_PATTERN);
    return match?.[1] ? Number.parseInt(match[1], 10) : null;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const topLevelCode = toNumericCode(record['code']);
    if (topLevelCode !== null) {
      return topLevelCode;
    }

    const nestedCode = extractCodeFromUnknown(record['error']);
    if (nestedCode !== null) {
      return nestedCode;
    }

    const messageCode = extractCodeFromUnknown(record['message']);
    if (messageCode !== null) {
      return messageCode;
    }
  }

  return null;
};

/**
 * Determines if the given error is authentication-related
 */
export const isAuthenticationRequiredError = (error: unknown): boolean => {
  // Null check to avoid unnecessary processing
  if (!error) {
    return false;
  }

  const code = extractCodeFromUnknown(error);
  return code === ACP_ERROR_CODES.AUTH_REQUIRED;
};
