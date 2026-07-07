/**
 * Session utility functions
 */

import { SESSION_PERSISTENT_FIELDS, type SessionPersistentField } from './types.js';

/**
 * Pick persistent fields from a session-like object.
 * Used by createSessionHeader, readSessionJsonl, getSessions, getSession
 * to ensure all persistent fields are included consistently.
 *
 * @param source - Object containing session fields
 * @returns Object with only the persistent fields that exist in source
 */
export function pickSessionFields<T extends object>(
  source: T
): Partial<Record<SessionPersistentField, unknown>> {
  const result: Partial<Record<SessionPersistentField, unknown>> = {};
  for (const field of SESSION_PERSISTENT_FIELDS) {
    if (field in source && (source as Record<string, unknown>)[field] !== undefined) {
      result[field] = (source as Record<string, unknown>)[field];
    }
  }
  return result;
}
