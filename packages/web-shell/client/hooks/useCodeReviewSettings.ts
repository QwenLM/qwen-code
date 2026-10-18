import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonClient,
  DaemonGitHubPullRequestSettings,
} from '@qwen-code/sdk/daemon';

export function useCodeReviewSettings(
  client: DaemonClient,
  supported: boolean,
  revision: number | undefined,
) {
  const [state, setState] = useState<{
    client: DaemonClient;
    supported: boolean;
    status?: DaemonGitHubPullRequestSettings;
    loaded: boolean;
    error?: string;
  }>({ client, supported, loaded: false });
  const [saving, setSaving] = useState(false);
  const owner = useRef({ client, supported });
  owner.current = { client, supported };
  const request = useRef(0);
  const write = useRef<object | undefined>(undefined);
  const currentOwner = useCallback(
    () =>
      owner.current.client === client && owner.current.supported === supported,
    [client, supported],
  );
  const reload = useCallback(async () => {
    if (!supported || write.current) return;
    const token = ++request.current;
    try {
      const status = await client.githubPullRequestSettings();
      if (!currentOwner() || token !== request.current) return;
      setState({ client, supported, status, loaded: true });
    } catch (error) {
      if (!currentOwner() || token !== request.current) return;
      setState({
        client,
        supported,
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, currentOwner, supported]);
  const latestReload = useRef(reload);
  latestReload.current = reload;
  const invalidate = useCallback(() => {
    request.current++;
  }, []);
  useEffect(() => {
    void reload();
    return invalidate;
  }, [invalidate, reload, revision]);
  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [reload]);
  const current =
    state.client === client && state.supported === supported
      ? state
      : undefined;
  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (
        !supported ||
        !current?.loaded ||
        current.status?.locked ||
        current.error ||
        write.current
      )
        return;
      const token = {};
      write.current = token;
      request.current++;
      setSaving(true);
      try {
        const status = await client.updateGitHubPullRequestSettings(enabled);
        if (currentOwner())
          setState({ client, supported, status, loaded: true });
      } catch (error) {
        if (currentOwner())
          setState((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        if (write.current === token) {
          write.current = undefined;
          setSaving(false);
          if (!currentOwner()) void latestReload.current();
        }
      }
    },
    [client, current, currentOwner, supported],
  );
  return {
    enabled: supported && current?.status?.enabled === true && !current.error,
    userEnabled: current?.status?.userEnabled ?? null,
    locked: current?.status?.locked === true,
    loaded: supported && current?.loaded === true,
    busy: saving,
    error: current?.error,
    reload,
    setEnabled,
  };
}
