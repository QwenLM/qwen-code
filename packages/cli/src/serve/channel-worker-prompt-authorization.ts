const workspacesByToken = new Map<string, string>();

export const CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY =
  'qwen.daemon.channelPromptAuthorization';

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
 * lists every served workspace), so the prompt route admits a worker's
 * channel classification for any workspace the daemon serves bindings for
 * (primary or trusted) — not just the worker's home. The caller gates on the
 * target runtime's trust; the per-workspace check above stays the narrow
 * observable for the supervisor's home-workspace registration.
 */
export function isChannelWorkerPromptToken(token: unknown): boolean {
  return typeof token === 'string' && workspacesByToken.has(token);
}
