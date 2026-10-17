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

const NO_APPROVAL_MODES: readonly WebShellApprovalMode[] = [];

interface ScopedSetting {
  client: DaemonClient;
  cwd: string;
  failed: boolean;
  // Present once a read for this client+cwd has succeeded, so a rejected
  // reload can keep the last-known-good value.
  value?: { effective: unknown };
}

export function useApprovalModes(
  cwd: string | undefined,
  allowedApprovalModes: readonly WebShellApprovalMode[] | undefined,
): readonly WebShellApprovalMode[] {
  const { client } = useWorkspace();
  const settingsVersion = useWorkspaceEventSignals()?.settingsVersion;
  const [setting, setSetting] = useState<ScopedSetting>();
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
            failed: false,
            value: {
              effective: status.settings.find(
                (entry) => entry.key === 'ui.allowedApprovalModes',
              )?.values.effective,
            },
          });
      })
      .catch(() => {
        if (cancelled) return;
        setSetting((previous) => ({
          client,
          cwd,
          failed: true,
          value:
            previous?.client === client && previous.cwd === cwd
              ? previous.value
              : undefined,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [allowedApprovalModes, client, cwd, settingsVersion]);
  return useMemo(() => {
    if (allowedApprovalModes !== undefined)
      return resolveApprovalModes(allowedApprovalModes);
    const scoped =
      setting?.client === client && setting.cwd === cwd ? setting : undefined;
    // A rejection is not "no allowlist": resolving it to the default list
    // would silently drop the operator's restriction, so a failed first read
    // offers nothing and a failed reload keeps the last-known-good list. The
    // next settings event re-runs the effect above and retries the read.
    if (scoped?.failed && !scoped.value) return NO_APPROVAL_MODES;
    return resolveApprovalModes(scoped?.value?.effective);
  }, [allowedApprovalModes, client, cwd, setting]);
}
