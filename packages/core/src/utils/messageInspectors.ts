/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Content } from '@google/genai';

/**
 * Checks if a `Content` object represents a function response.
 * A function response is a `Content` object with the role 'user' where all parts are `functionResponse` objects.
 *
 * @param content The `Content` object to check.
 * @returns `true` if the object is a function response, `false` otherwise.
 */
export function isFunctionResponse(content: Content): boolean {
  return (
    content.role === 'user' &&
    !!content.parts &&
    content.parts.every((part) => !!part.functionResponse)
  );
}

/**
 * Checks if a `Content` object represents a function call.
 * A function call is a `Content` object with the role 'model' where all parts are `functionCall` objects.
 *
 * @param content The `Content` object to check.
 * @returns `true` if the object is a function call, `false` otherwise.
 */
export function isFunctionCall(content: Content): boolean {
  return (
    content.role === 'model' &&
    !!content.parts &&
    content.parts.every((part) => !!part.functionCall)
  );
}
