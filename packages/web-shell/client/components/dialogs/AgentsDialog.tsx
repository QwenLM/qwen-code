import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  DaemonAgentMutationResult,
  DaemonCreateAgentRequest,
  DaemonWorkspaceAgentDetail,
  DaemonWorkspaceAgentSummary,
  DaemonWorkspaceAgentsStatus,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';

export type AgentsDialogInitialMode =
  | 'menu'
  | 'create'
  | 'create-user'
  | 'create-project'
  | 'manage';

interface AgentsDialogProps {
  initialMode?: AgentsDialogInitialMode;
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

function initialDialogMode(
  mode: AgentsDialogInitialMode,
): 'menu' | 'create-scope' | 'create' | 'manage' {
  if (mode === 'create') return 'create-scope';
  if (mode === 'create-user' || mode === 'create-project') return 'create';
  return mode;
}

function initialScope(mode: AgentsDialogInitialMode): 'workspace' | 'global' {
  return mode === 'create-user' ? 'global' : 'workspace';
}

export function AgentsDialog({
  initialMode = 'menu',
  listAgents,
  getAgent,
  createAgent,
  deleteAgent,
  onClose,
}: AgentsDialogProps) {
  const [mode, setMode] = useState<
    'menu' | 'create-scope' | 'create' | 'manage'
  >(() => initialDialogMode(initialMode));
  const [agents, setAgents] = useState<DaemonWorkspaceAgentSummary[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [detail, setDetail] = useState<DaemonWorkspaceAgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [scope, setScope] = useState<'workspace' | 'global'>(() =>
    initialScope(initialMode),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const directCreateMode =
    initialMode === 'create' ||
    initialMode === 'create-user' ||
    initialMode === 'create-project';

  const selected = agents[selectedIdx];
  const scopeItems = useMemo(
    () => [
      {
        label: 'User',
        description: 'Create a user-level subagent',
        scope: 'global' as const,
      },
      {
        label: 'Project',
        description: 'Create a project-level subagent',
        scope: 'workspace' as const,
      },
    ],
    [],
  );
  const menuItems = useMemo(
    () => [
      {
        label: 'Manage',
        description: 'Manage existing subagents',
        onSelect: () => {
          setSelectedIdx(0);
          setMode('manage' as const);
        },
      },
      {
        label: 'Create',
        description: 'Create a new subagent',
        onSelect: () => {
          setSelectedIdx(scope === 'global' ? 0 : 1);
          setMode('create-scope' as const);
        },
      },
    ],
    [scope],
  );

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
    if (mode !== 'manage') return;
    if (selectedIdx >= agents.length && agents.length > 0) {
      setSelectedIdx(agents.length - 1);
    }
  }, [agents.length, mode, selectedIdx]);

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
        if (directCreateMode) {
          onClose();
          return;
        }
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
  }, [
    createAgent,
    description,
    directCreateMode,
    name,
    onClose,
    reload,
    scope,
    systemPrompt,
  ]);

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

  const handleCreateKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!busy) handleCreate();
      }
    },
    [busy, handleCreate],
  );

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mode === 'menu' || initialMode !== 'menu') {
          onClose();
        } else {
          setMode('menu');
          setSelectedIdx(0);
          setMessage(null);
        }
        return;
      }
      if (mode === 'create') return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        if (mode === 'menu') {
          setSelectedIdx((i) =>
            Math.min(i + 1, Math.max(menuItems.length - 1, 0)),
          );
        } else if (mode === 'create-scope') {
          setSelectedIdx((i) =>
            Math.min(i + 1, Math.max(scopeItems.length - 1, 0)),
          );
        } else {
          setSelectedIdx((i) =>
            Math.min(i + 1, Math.max(agents.length - 1, 0)),
          );
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && mode === 'menu') {
        e.preventDefault();
        menuItems[selectedIdx]?.onSelect();
      } else if (e.key === 'Enter' && mode === 'create-scope') {
        e.preventDefault();
        const nextScope = scopeItems[selectedIdx]?.scope ?? 'workspace';
        setScope(nextScope);
        setMode('create');
      }
    },
    [
      agents.length,
      initialMode,
      menuItems,
      mode,
      onClose,
      scopeItems,
      selectedIdx,
    ],
  );

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">Agents</span>
        <span className="resume-picker-count">{agents.length} agents</span>
      </div>

      <div className="resume-picker-search">
        <span className="resume-picker-search-hint">
          {message ||
            (loading
              ? 'Loading agents...'
              : mode === 'menu'
                ? 'Select an action'
                : mode === 'create-scope'
                  ? 'Choose where to save the subagent'
                  : '')}
        </span>
      </div>

      <div className="resume-picker-sep" />

      {mode === 'menu' ? (
        <div className="resume-picker-list" ref={listRef}>
          {menuItems.map((item, index) => (
            <div
              key={item.label}
              className={`resume-picker-item ${index === selectedIdx ? 'selected' : ''}`}
              onClick={() => item.onSelect()}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <div className="resume-picker-item-row">
                <span className="resume-picker-item-prefix">
                  {index === selectedIdx ? '›' : ' '}
                </span>
                <span className="resume-picker-item-title">{item.label}</span>
              </div>
              <div className="resume-picker-item-meta">{item.description}</div>
            </div>
          ))}
        </div>
      ) : mode === 'create-scope' ? (
        <div className="resume-picker-list" ref={listRef}>
          {scopeItems.map((item, index) => (
            <div
              key={item.scope}
              className={`resume-picker-item ${index === selectedIdx ? 'selected' : ''}`}
              onClick={() => {
                setScope(item.scope);
                setMode('create');
              }}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <div className="resume-picker-item-row">
                <span className="resume-picker-item-prefix">
                  {index === selectedIdx ? '›' : ' '}
                </span>
                <span className="resume-picker-item-title">{item.label}</span>
              </div>
              <div className="resume-picker-item-meta">{item.description}</div>
            </div>
          ))}
        </div>
      ) : mode === 'create' ? (
        <div className="dialog-form" onKeyDown={handleCreateKeyDown}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
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
        {mode === 'menu'
          ? '↑↓ to navigate · Enter to select · Esc to close'
          : mode === 'create-scope'
            ? initialMode === 'menu'
              ? '↑↓ to navigate · Enter to select · Esc to menu'
              : '↑↓ to navigate · Enter to select · Esc to close'
            : mode === 'manage'
              ? initialMode === 'menu'
                ? '↑↓ to navigate · Esc to menu'
                : '↑↓ to navigate · Esc to close'
              : initialMode === 'menu'
                ? '⌘/Ctrl+Enter to save · Esc to menu'
                : '⌘/Ctrl+Enter to save · Esc to close'}
      </div>
    </div>
  );
}
