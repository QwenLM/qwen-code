import type { ProviderDriver } from '../driver-types.ts';

export const qwenDriver: ProviderDriver = {
  provider: 'qwen',
  buildRuntime: ({ resolvedPaths }) => ({
    paths: {
      qwenCli: resolvedPaths.qwenCliPath,
      node: resolvedPaths.nodeRuntimePath,
    },
  }),
  validateStoredConnection: async () => ({ success: true }),
  testConnection: async () => null,
};
