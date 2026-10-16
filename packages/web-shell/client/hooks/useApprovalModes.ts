import { useEffect, useMemo, useState } from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import {
  useWorkspace,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  resolveApprovalModes,
  type WebShellApprovalMode,
} from '../utils/planMode';

export function useApprovalModes(
  cwd: string | undefined,
  allowedApprovalModes: readonly WebShellApprovalMode[] | undefined,
): readonly WebShellApprovalMode[] {
  const { client } = useWorkspace();
  const settingsVersion = useWorkspaceEventSignals()?.settingsVersion;
  const [setting, setSetting] = useState<{
    client: DaemonClient;
    cwd: string;
    value: unknown;
  }>();
  useEffect(() => {
    if (allowedApprovalModes !== undefined || !cwd) return;
    let cancelled = false;
    void client
      .workspaceByCwd(cwd)
      .workspaceSettings()
      .then((status) => {
        if (!cancelled)
          setSetting({
            client,
            cwd,
            value: status.settings.find(
              (entry) => entry.key === 'ui.allowedApprovalModes',
            )?.values.effective,
          });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [allowedApprovalModes, client, cwd, settingsVersion]);
  return useMemo(
    () =>
      resolveApprovalModes(
        allowedApprovalModes ??
          (setting?.client === client && setting.cwd === cwd
            ? setting.value
            : undefined),
      ),
    [allowedApprovalModes, client, cwd, setting],
  );
}
