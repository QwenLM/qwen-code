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
