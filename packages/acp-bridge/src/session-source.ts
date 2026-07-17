export interface SessionSourceMetadata {
  sourceType?: string;
  sourceId?: string;
}

export const SESSION_SOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_SESSION_SOURCE_ID_LENGTH = 256;

export function parseSessionSource(
  sourceType: unknown,
  sourceId: unknown,
): SessionSourceMetadata | { error: string } {
  if (sourceType === undefined && sourceId === undefined) return {};
  if (
    typeof sourceType !== 'string' ||
    !SESSION_SOURCE_TYPE_PATTERN.test(sourceType)
  ) {
    return {
      error: '`sourceType` must match [a-z][a-z0-9_-]{0,63} when provided',
    };
  }
  if (sourceId === undefined) return { sourceType };
  if (
    typeof sourceId !== 'string' ||
    sourceId.length === 0 ||
    sourceId.length > MAX_SESSION_SOURCE_ID_LENGTH ||
    [...sourceId].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return {
      error: `\`sourceId\` must be a non-empty string of at most ${MAX_SESSION_SOURCE_ID_LENGTH} characters without control characters`,
    };
  }
  return { sourceType, sourceId };
}
