/**
 * Shared limits for condition tree complexity.
 *
 * Depth starts at 0 for top-level conditions.
 * Allowed depth indexes are 0..(MAX_CONDITION_DEPTH_EXCLUSIVE - 1).
 */
export const MAX_CONDITION_DEPTH_EXCLUSIVE = 8;

/** Emit simplification warnings when condition depth exceeds this threshold. */
export const CONDITION_DEPTH_WARNING_THRESHOLD = 4;
