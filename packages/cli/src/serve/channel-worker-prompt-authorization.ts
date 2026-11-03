const workspacesByToken = new Map<string, string>();

export const CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY =
  'qwen.daemon.channelPromptAuthorization';

/**
 * Explicit bound-relay intent marker. Cross-workspace channel classification
 * requires it IN ADDITION to a registered worker token and a trusted target:
 * the process-level credential exists for `createBoundSessionsAccessor`
 * relays, not for any prompt a worker happens to address at another
 * workspace. A plain (non-relay) prompt carrying a foreign worker token is
 * classified as an ordinary interactive prompt. The marker is intent, not
 * authentication — a token holder can set it; the security boundary remains
 * token possession plus the target's trust (documented in the design's
 * Constraints and risks).
 */
export const CHANNEL_BOUND_RELAY_META_KEY = 'qwen.daemon.channelBoundRelay';

export function registerChannelWorkerPromptAuthorization(
  token: string,
  workspaceCwd: string,
): void {
  workspacesByToken.set(token, workspaceCwd);
}

export function revokeChannelWorkerPromptAuthorization(token: string): void {
  workspacesByToken.delete(token);
}

export function isChannelWorkerPromptAuthorized(
  token: unknown,
  workspaceCwd: string,
): boolean {
  return (
    typeof token === 'string' && workspacesByToken.get(token) === workspaceCwd
  );
}

/**
 * Process-level relay check: the token belongs to a registered channel
 * worker, regardless of which workspace it was launched for. Bound delivery
 * is cross-workspace by design (the bindings route is process-global and
 * lists every served workspace). The prompt route uses this ONLY together
 * with the explicit CHANNEL_BOUND_RELAY_META_KEY marker and the target
 * runtime's trust (primary or trusted); a plain prompt carrying a foreign
 * worker token gets no channel classification. The per-workspace check
 * above stays the narrow observable for the supervisor's home-workspace
 * registration and for same-workspace channel turns.
 */
export function isChannelWorkerPromptToken(token: unknown): boolean {
  return typeof token === 'string' && workspacesByToken.has(token);
}
