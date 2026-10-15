import type { JavaManagedAgentProviderOptions } from './java-managed-agent-provider';

/** Local Vite configuration; the production host supplies these provider options directly. */
export function managedDevelopmentOptions(
  params: URLSearchParams,
  env: {
    VITE_MANAGED_AGENT_ACTOR_ID?: string;
    VITE_MANAGED_AGENT_MODEL_PRESETS?: string;
    VITE_MANAGED_AGENT_WORKSPACE_BINDING?: string;
  },
): Pick<
  JavaManagedAgentProviderOptions,
  'productScope' | 'getHeaders' | 'enableWorkspaceBinding' | 'modelPresets'
> {
  const tenantId = params.get('tenant')?.trim() || 'local-java-demo';
  const actorId = env.VITE_MANAGED_AGENT_ACTOR_ID?.trim();
  const raw: unknown = env.VITE_MANAGED_AGENT_MODEL_PRESETS
    ? JSON.parse(env.VITE_MANAGED_AGENT_MODEL_PRESETS)
    : [];
  if (
    !Array.isArray(raw) ||
    raw.some((item: unknown) => {
      if (typeof item !== 'object' || item === null) return true;
      const preset = item as Record<string, unknown>;
      return (
        typeof preset['agentId'] !== 'string' ||
        !preset['agentId'].trim() ||
        typeof preset['label'] !== 'string' ||
        !preset['label'].trim()
      );
    })
  )
    throw new Error(
      'VITE_MANAGED_AGENT_MODEL_PRESETS must be an array of {agentId, label}',
    );
  const modelPresets = raw as { agentId: string; label: string }[];
  if (
    new Set(modelPresets.map((item) => item.agentId)).size !==
    modelPresets.length
  )
    throw new Error('Managed model preset agentId values must be unique');
  return {
    productScope: actorId ? JSON.stringify([tenantId, actorId]) : tenantId,
    getHeaders: () => ({
      'X-Qwen-Tenant-Id': tenantId,
      ...(actorId ? { 'X-Qwen-Actor-Id': actorId } : {}),
    }),
    enableWorkspaceBinding:
      params.get('managedWorkspace') === '1' ||
      env.VITE_MANAGED_AGENT_WORKSPACE_BINDING === 'true',
    modelPresets,
  };
}
