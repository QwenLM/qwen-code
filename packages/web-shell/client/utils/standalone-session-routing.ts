import {
  isStandaloneSessionNotFoundError,
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonClient,
  type DaemonCapabilities,
} from '@qwen-code/sdk/daemon';

export async function keepWorkspaceSplitSessionIds(
  client: DaemonClient,
  capabilities: DaemonCapabilities | undefined,
  sessionIds: readonly string[],
): Promise<string[]> {
  const requested = Array.from(new Set(sessionIds.filter(Boolean)));
  if (requested.length === 0 || !capabilities) return [];
  if (!capabilities.features?.includes(STANDALONE_SESSIONS_CAPABILITY)) {
    return requested;
  }

  const classifications = await Promise.all(
    requested.map(async (sessionId) => {
      try {
        await client.getStandaloneSession(sessionId);
        return false;
      } catch (error) {
        return isStandaloneSessionNotFoundError(error);
      }
    }),
  );
  return requested.filter((_, index) => classifications[index]);
}
