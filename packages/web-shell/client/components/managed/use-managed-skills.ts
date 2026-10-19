import { useEffect, useState } from 'react';
import type {
  ManagedAgentProvider,
  ManagedSessionSkills,
} from './managed-agent-provider';

export function useManagedSkills(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{
    provider: ManagedAgentProvider;
    sessionId: string;
    skills?: ManagedSessionSkills['skills'];
    error: boolean;
  }>();
  const current =
    state?.provider === provider && state.sessionId === sessionId
      ? state
      : undefined;
  const loaded = current?.skills !== undefined;
  const supported = Boolean(provider.skills && sessionId);

  useEffect(() => {
    if (!open || loaded || !sessionId || !provider.skills) return;
    const abort = new AbortController();
    setState({ provider, sessionId, error: false });
    void provider.skills
      .list(sessionId, { clientId, signal: abort.signal })
      .then(({ skills }) => {
        if (!abort.signal.aborted)
          setState({ provider, sessionId, skills, error: false });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setState({ provider, sessionId, error: true });
      });
    return () => abort.abort();
  }, [provider, clientId, sessionId, open, loaded]);

  return {
    supported,
    skills: current?.skills ?? [],
    loading: supported && open && !loaded && !current?.error,
    loaded,
    error: current?.error === true,
    onOpenChange: setOpen,
  };
}
