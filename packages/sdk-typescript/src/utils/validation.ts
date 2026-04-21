/**
 * UUID validation utilities
 */

// UUID v4 regex pattern
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates if a string is a valid UUID format
 * @param value - The string to validate
 * @returns True if the string is a valid UUID, false otherwise
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Validates a session ID and throws an error if invalid
 * @param sessionId - The session ID to validate
 * @param paramName - The name of the parameter (for error messages)
 * @throws Error if the session ID is not a valid UUID
 */
export function validateSessionId(
  sessionId: string,
  paramName: string = 'sessionId',
): void {
  if (!isValidUUID(sessionId)) {
    throw new Error(
      `Invalid ${paramName}: "${sessionId}". Must be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`,
    );
  }
}
