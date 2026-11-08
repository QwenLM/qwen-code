import {
  isStandaloneSessionNotFoundError,
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonClient,
  type DaemonCapabilities,
} from '@qwen-code/sdk/daemon';

/**
 * Outcome of classifying one session id for the workspace split view.
 *
 * - `standalone`: the id resolves in the standalone registry, so it is
 *   ineligible for a workspace split and is dropped silently.
 * - `workspace`: the id is provably absent from the standalone registry
 *   (404 `standalone_session_not_found`), so it belongs to the workspace and
 *   is kept.
 * - `failed`: classification could not complete (non-404 error). The id is
 *   dropped, but unlike the other two outcomes it is reported separately so
 *   the caller can surface the failure instead of opening a partial split
 *   silently.
 */
export type SplitSessionOutcome = 'standalone' | 'workspace' | 'failed';

export interface SplitSessionClassification {
  kept: string[];
  transientFailures: string[];
}

export type SplitSessionClassifier = (
  sessionId: string,
) => Promise<SplitSessionOutcome>;

export async function keepWorkspaceSplitSessionIds(
  client: DaemonClient,
  capabilities: DaemonCapabilities | undefined,
  sessionIds: readonly string[],
  classify: SplitSessionClassifier = (sessionId) =>
    client.getStandaloneSession(sessionId).then(
      () => 'standalone',
      (error) =>
        (isStandaloneSessionNotFoundError(error)
          ? 'workspace'
          : 'failed') as SplitSessionOutcome,
    ),
): Promise<SplitSessionClassification> {
  const requested = Array.from(new Set(sessionIds.filter(Boolean)));
  if (requested.length === 0 || !capabilities) {
    return { kept: [], transientFailures: [] };
  }
  if (!capabilities.features?.includes(STANDALONE_SESSIONS_CAPABILITY)) {
    return { kept: requested, transientFailures: [] };
  }

  const outcomes = await Promise.all(requested.map((id) => classify(id)));
  const kept: string[] = [];
  const transientFailures: string[] = [];
  requested.forEach((id, index) => {
    if (outcomes[index] === 'workspace') kept.push(id);
    else if (outcomes[index] === 'failed') transientFailures.push(id);
  });
  return { kept, transientFailures };
}
