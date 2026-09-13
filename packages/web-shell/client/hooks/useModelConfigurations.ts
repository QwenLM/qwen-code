import { useCallback } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useDaemonResource } from '../daemon/workspace/hooks/useDaemonResource';
import { useWorkspaceEventReload } from '../daemon/workspace/hooks/useWorkspaceEventReload';
import { useDaemonWorkspaceEventSignals } from '../daemon/session/DaemonSessionProvider';

export function useModelConfigurations(enabled: boolean) {
  const { client } = useWorkspace();
  const load = useCallback(() => client.modelConfigurations(), [client]);
  const result = useDaemonResource(load, { enabled, autoLoad: enabled });
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(signals?.settingsVersion, result.reload, enabled);
  return { ...result, models: result.data?.models ?? [] };
}
