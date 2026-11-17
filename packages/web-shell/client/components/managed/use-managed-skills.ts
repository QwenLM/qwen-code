import { useCallback, useEffect, useState } from 'react';
import type { ManagedCreationSkillsSource } from './managed-creation-skills';
import type {
  ManagedAgentProvider,
  ManagedSessionSkills,
} from './managed-agent-provider';

export function useManagedSkills(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  creationSkills?: ManagedCreationSkillsSource,
) {
  const source = sessionId ? undefined : creationSkills;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{
    provider: ManagedAgentProvider;
    clientId: string;
    sessionId?: string;
    source?: ManagedCreationSkillsSource;
    skills?: ManagedSessionSkills['skills'];
    error: boolean;
  }>();
  const current =
    state?.provider === provider &&
    state.clientId === clientId &&
    state.sessionId === sessionId &&
    state.source === source
      ? state
      : undefined;
  const loaded = current?.skills !== undefined;
  const supported = sessionId ? Boolean(provider.skills) : Boolean(source);
  const needsLoad = !sessionId || !loaded;
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next && !sessionId) setState(undefined);
      setOpen(next);
    },
    [sessionId],
  );

  useEffect(() => {
    if (!open || !supported || !needsLoad) return;
    const abort = new AbortController();
    const owner = { provider, clientId, sessionId, source };
    setState({ ...owner, error: false });
    const request = sessionId
      ? provider
          .skills!.list(sessionId, { clientId, signal: abort.signal })
          .then(({ skills }) => skills)
      : source!.list(abort.signal);
    void request
      .then((skills) => {
        if (!abort.signal.aborted) setState({ ...owner, skills, error: false });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ ...owner, error: true });
      });
    return () => abort.abort();
  }, [provider, clientId, sessionId, source, open, supported, needsLoad]);

  const skills = current?.skills ?? [];
  return {
    supported,
    skills,
    commands: skills.map(({ name, description }) => ({
      name,
      description,
      source: 'skill',
      displayCategory: 'skill' as const,
    })),
    loading: supported && open && !loaded && !current?.error,
    loaded,
    error: current?.error === true,
    onOpenChange,
  };
}
