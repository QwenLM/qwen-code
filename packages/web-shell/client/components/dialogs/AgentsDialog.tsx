import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonAgentMutationResult,
  DaemonCreateAgentRequest,
  DaemonWorkspaceAgentDetail,
  DaemonWorkspaceAgentSummary,
  DaemonWorkspaceAgentsStatus,
} from '@qwen-code/sdk/daemon';

interface AgentsDialogProps {
  initialMode?: 'create' | 'manage';
  listAgents: () => Promise<DaemonWorkspaceAgentsStatus>;
  getAgent: (agentType: string) => Promise<DaemonWorkspaceAgentDetail>;
  createAgent: (
    req: DaemonCreateAgentRequest,
  ) => Promise<DaemonAgentMutationResult>;
  deleteAgent: (
    agentType: string,
    scope?: 'workspace' | 'global',
  ) => Promise<void>;
  onClose: () => void;
}

function scopeForLevel(level: string): 'workspace' | 'global' | undefined {
  if (level === 'project') return 'workspace';
  if (level === 'user') return 'global';
  return undefined;
}

export function AgentsDialog({
  initialMode = 'manage',
  listAgents,
  getAgent,
  createAgent,
  deleteAgent,
  onClose,
}: AgentsDialogProps) {
  const [mode, setMode] = useState<'create' | 'manage'>(initialMode);
  const [agents, setAgents] = useState<DaemonWorkspaceAgentSummary[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [detail, setDetail] = useState<DaemonWorkspaceAgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [scope, setScope] = useState<'workspace' | 'global'>('workspace');
  const listRef = useRef<HTMLDivElement>(null);

  const selected = agents[selectedIdx];

  const reload = useCallback(() => {
    setLoading(true);
    listAgents()
      .then((status) => {
        setAgents(status.agents);
        setMessage(null);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [listAgents]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (selectedIdx >= agents.length && agents.length > 0) {
      setSelectedIdx(agents.length - 1);
    }
  }, [agents.length, selectedIdx]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const loadDetail = useCallback(
    (agent: DaemonWorkspaceAgentSummary) => {
      setDetail(null);
      getAgent(agent.name)
        .then(setDetail)
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        });
    },
    [getAgent],
  );

  useEffect(() => {
    if (selected && mode === 'manage') {
      loadDetail(selected);
    }
  }, [loadDetail, mode, selected]);

  const handleCreate = useCallback(() => {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedPrompt = systemPrompt.trim();
    if (!trimmedName || !trimmedDescription || !trimmedPrompt) {
      setMessage('Name, description, and system prompt are required.');
      return;
    }
    setBusy(true);
    createAgent({
      name: trimmedName,
      description: trimmedDescription,
      systemPrompt: trimmedPrompt,
      scope,
    })
      .then((result) => {
        setMessage(`Created ${result.agent.name}`);
        setName('');
        setDescription('');
        setSystemPrompt('');
        setMode('manage');
        reload();
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, [createAgent, description, name, reload, scope, systemPrompt]);

  const handleDelete = useCallback(
    (agent: DaemonWorkspaceAgentSummary) => {
      const deleteScope = scopeForLevel(agent.level);
      if (!deleteScope || agent.isBuiltin || agent.level === 'extension') {
        setMessage('This agent is read-only.');
        return;
      }
      setBusy(true);
      deleteAgent(agent.name, deleteScope)
        .then(() => {
          setMessage(`Deleted ${agent.name}`);
          setDetail(null);
          reload();
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusy(false));
    },
    [deleteAgent, reload],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (mode === 'create') return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(agents.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      }
    };
    const timer = setTimeout(
      () => window.addEventListener('keydown', handler),
      50,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [agents.length, mode, onClose]);

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">Agents</span>
        <span className="resume-picker-count">{agents.length} agents</span>
      </div>

      <div className="resume-picker-search">
        <button
          className="dialog-inline-button"
          onClick={() => setMode('manage')}
        >
          Manage
        </button>
        <button
          className="dialog-inline-button"
          onClick={() => setMode('create')}
        >
          Create
        </button>
        <span className="resume-picker-search-hint">
          {message || (loading ? 'Loading agents...' : '')}
        </span>
      </div>

      <div className="resume-picker-sep" />

      {mode === 'create' ? (
        <div className="dialog-form">
          <div className="dialog-form-row">
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Scope
              <select
                value={scope}
                onChange={(e) =>
                  setScope(e.target.value as 'workspace' | 'global')
                }
              >
                <option value="workspace">workspace</option>
                <option value="global">global</option>
              </select>
            </label>
          </div>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            System prompt
            <textarea
              className="dialog-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </label>
          <button
            className="dialog-primary-button"
            disabled={busy}
            onClick={handleCreate}
          >
            {busy ? 'Creating...' : 'Create Agent'}
          </button>
        </div>
      ) : (
        <div className="dialog-split">
          <div className="resume-picker-list dialog-split-list" ref={listRef}>
            {!loading && agents.length === 0 && (
              <div className="resume-picker-empty">No subagents found.</div>
            )}
            {agents.map((agent, i) => (
              <div
                key={`${agent.level}:${agent.name}`}
                className={`resume-picker-item ${i === selectedIdx ? 'selected' : ''}`}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => loadDetail(agent)}
              >
                <div className="resume-picker-item-row">
                  <span className="resume-picker-item-prefix">
                    {i === selectedIdx ? '›' : ' '}
                  </span>
                  <span className="resume-picker-item-title">{agent.name}</span>
                  <span className="resume-picker-item-badge">
                    {agent.level}
                  </span>
                </div>
                <div className="resume-picker-item-meta">
                  {agent.description}
                </div>
              </div>
            ))}
          </div>

          <div className="dialog-detail">
            {detail ? (
              <>
                <div className="dialog-detail-title">{detail.name}</div>
                <div className="dialog-detail-meta">
                  {detail.level}
                  {detail.model ? ` · ${detail.model}` : ''}
                </div>
                <div className="dialog-detail-body">{detail.systemPrompt}</div>
                {detail.tools && detail.tools.length > 0 && (
                  <div className="dialog-detail-meta">
                    tools: {detail.tools.join(', ')}
                  </div>
                )}
                <button
                  className="dialog-danger-button"
                  disabled={
                    busy || detail.isBuiltin || detail.level === 'extension'
                  }
                  onClick={() => handleDelete(detail)}
                >
                  {busy ? 'Deleting...' : 'Delete'}
                </button>
              </>
            ) : (
              <div className="resume-picker-empty">Select an agent.</div>
            )}
          </div>
        </div>
      )}

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        {mode === 'manage' ? '↑↓ to navigate · Esc to close' : 'Esc to close'}
      </div>
    </div>
  );
}
