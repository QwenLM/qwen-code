/**
 * Session ID Validation
 *
 * Security utilities for validating session IDs to prevent path traversal attacks.
 * Session IDs should only contain letters, numbers, hyphens, and underscores.
 */

import { basename } from 'path';

/**
 * Valid session ID pattern.
 * Matches: Unicode letters/numbers, hyphens, underscores
 * Examples: "260202-fix-session-names", "260202-你好", "my_session_1"
 */
const SESSION_ID_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/**
 * Validate that a session ID is safe for use in file paths.
 * Throws a SecurityError if the session ID contains path traversal characters.
 *
 * @param sessionId - The session ID to validate
 * @throws Error if sessionId is invalid or contains path traversal
 */
export function validateSessionId(sessionId: string): void {
  // Check for null/undefined/empty
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Security Error: Session ID is required');
  }

  // Check for path traversal attempts
  // basename() strips directory components, so if it differs, there was traversal
  const sanitized = basename(sessionId);
  if (sanitized !== sessionId) {
    throw new Error('Security Error: Invalid session ID - path traversal detected');
  }

  // Check format matches expected pattern
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Security Error: Invalid session ID format');
  }
}

/**
 * Sanitize a session ID by stripping any path components.
 * This is a defense-in-depth measure - validation should happen first.
 *
 * @param sessionId - The session ID to sanitize
 * @returns The sanitized session ID (basename only)
 */
export function sanitizeSessionId(sessionId: string): string {
  if (!sessionId || typeof sessionId !== 'string') {
    return '';
  }
  return basename(sessionId);
}

/**
 * Check if a session ID is valid without throwing.
 *
 * @param sessionId - The session ID to check
 * @returns true if valid, false otherwise
 */
export function isValidSessionId(sessionId: string): boolean {
  try {
    validateSessionId(sessionId);
    return true;
  } catch {
    return false;
  }
}
