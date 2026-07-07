import type { ProviderDriver } from '../driver-types.ts';
import { fetchQwenModelsViaSharedAcp } from '../../../qwen-agent.ts';

export const qwenDriver: ProviderDriver = {
  provider: 'qwen',
  buildRuntime: ({ resolvedPaths }) => ({
    paths: {
      qwenCli: resolvedPaths.qwenCliPath,
      node: resolvedPaths.nodeRuntimePath,
    },
  }),
  fetchModels: ({ hostRuntime, timeoutMs }) =>
    fetchQwenModelsViaSharedAcp({
      hostRuntime,
      timeoutMs,
    }),
  validateStoredConnection: async () => ({
    success: true,
    shouldRefreshModels: true,
  }),
  testConnection: async () => null,
};
