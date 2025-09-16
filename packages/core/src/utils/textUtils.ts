/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks if a Buffer is likely binary by testing for the presence of a NULL byte.
 * The presence of a NULL byte is a strong indicator that the data is not plain text.
 * @param data The Buffer to check.
 * @param sampleSize The number of bytes from the start of the buffer to test.
 * @returns True if a NULL byte is found, false otherwise.
 */
export function isBinary(
  data: Buffer | null | undefined,
  sampleSize = 512,
): boolean {
  if (!data) {
    return false;
  }

  const sample = data.length > sampleSize ? data.subarray(0, sampleSize) : data;

  for (const byte of sample) {
    // The presence of a NULL byte (0x00) is one of the most reliable
    // indicators of a binary file. Text files should not contain them.
    if (byte === 0) {
      return true;
    }
  }

  // If no NULL bytes were found in the sample, we assume it's text.
  return false;
}

/**
 * Safely replaces all occurrences of a string with another string.
 * This is a simple implementation that doesn't use regex, so it's safe from regex injection.
 * @param str The string to search in
 * @param search The string to search for
 * @param replace The string to replace with
 * @returns The string with all occurrences replaced
 */
export function safeLiteralReplace(
  str: string,
  search: string,
  replace: string,
): string {
  if (search === '') {
    return str;
  }
  let result = str;
  let index = result.indexOf(search);
  while (index !== -1) {
    result =
      result.substring(0, index) +
      replace +
      result.substring(index + search.length);
    // Start the next search after the replacement to avoid infinite loops
    index = result.indexOf(search, index + replace.length);
  }
  return result;
}
