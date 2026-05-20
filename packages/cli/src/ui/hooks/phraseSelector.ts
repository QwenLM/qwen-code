/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Select a random phrase from an array.
 * @param phrases Array of phrases to select from
 * @returns A randomly selected phrase
 */
export function selectRandomPhrase<T>(phrases: T[]): T {
  if (!phrases || phrases.length === 0) {
    throw new Error('Phrases array cannot be empty');
  }
  const index = Math.floor(Math.random() * phrases.length);
  return phrases[index];
}
