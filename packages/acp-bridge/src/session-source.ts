export interface SessionSourceMetadata {
  sourceType?: string;
  sourceId?: string;
}

export const SESSION_SOURCE_META_KEY = 'qwen.session.source';
export const SESSION_SOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_SESSION_SOURCE_ID_LENGTH = 256;
export const STANDALONE_SESSION_SOURCE_TYPE = 'standalone';
export const DAEMON_OWNED_STANDALONE_CREATION_KEY =
  'daemonOwnedStandaloneCreation';

export function isReservedStandaloneSessionSourceType(
  sourceType: unknown,
): sourceType is typeof STANDALONE_SESSION_SOURCE_TYPE {
  return sourceType === STANDALONE_SESSION_SOURCE_TYPE;
}

/**
 * Creator attribution of the fresh child session a per-run scheduled task
 * dispatches each fire into. The child keeps the `default` source type so it
 * lists alongside ordinary conversations (a task's bound controller session is
 * `scheduled_task`, which the default session list filters out); the id prefix
 * is what marks it as a task run. The web-shell sidebar mirrors the prefix
 * literally — it cannot import this package.
 */
export const SCHEDULED_TASK_RUN_SOURCE_TYPE = 'default';
export const SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX = 'scheduled_task_run:';

export function isScheduledTaskRunSource(
  source: SessionSourceMetadata,
): boolean {
  return (
    source.sourceType === SCHEDULED_TASK_RUN_SOURCE_TYPE &&
    source.sourceId?.startsWith(SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX) === true
  );
}

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
