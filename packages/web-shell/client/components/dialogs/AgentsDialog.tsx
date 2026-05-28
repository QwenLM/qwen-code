import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { dp } from './dialogStyles';
import {
  useAgents,
  type DaemonWorkspaceAgentDetail,
  type DaemonWorkspaceAgentSummary,
} from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

export type AgentsDialogInitialMode =
  | 'menu'
  | 'create'
  | 'create-user'
  | 'create-project'
  | 'manage';

interface AgentsDialogProps {
  initialMode?: AgentsDialogInitialMode;
  onClose: () => void;
}

function scopeForLevel(level: string): 'workspace' | 'global' | undefined {
  if (level === 'project') return 'workspace';
  if (level === 'user') return 'global';
  return undefined;
}

function canDeleteAgent(agent: DaemonWorkspaceAgentSummary): boolean {
  return (
    scopeForLevel(agent.level) !== undefined &&
    !agent.isBuiltin &&
    agent.level !== 'extension'
  );
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
  onClose,
}: AgentsDialogProps) {
  const { t } = useI18n();
  const {
    agents,
    loading,
    error: agentsError,
    reload,
    getAgent,
    createAgent,
    deleteAgent,
  } = useAgents({ autoLoad: true });
  const [mode, setMode] = useState<
    'menu' | 'create-scope' | 'create' | 'manage'
  >(() => initialDialogMode(initialMode));
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [detail, setDetail] = useState<DaemonWorkspaceAgentDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [scope, setScope] = useState<'workspace' | 'global'>(() =>
    initialScope(initialMode),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLInputElement>(null);
  const systemPromptRef = useRef<HTMLTextAreaElement>(null);
  const directCreateMode =
    initialMode === 'create' ||
    initialMode === 'create-user' ||
    initialMode === 'create-project';

  const selected = agents[selectedIdx];
  const scopeItems = useMemo(
    () => [
      {
        label: t('agent.create.user'),
        description: t('agent.create.user.desc'),
        scope: 'global' as const,
      },
      {
        label: t('agent.create.project'),
        description: t('agent.create.project.desc'),
        scope: 'workspace' as const,
      },
    ],
    [t],
  );
  const menuItems = useMemo(
    () => [
      {
        label: t('agent.manage'),
        description: t('agent.manage.desc'),
        onSelect: () => {
          setSelectedIdx(0);
          setMode('manage' as const);
        },
      },
      {
        label: t('agent.create'),
        description: t('agent.create'),
        onSelect: () => {
          setSelectedIdx(scope === 'global' ? 0 : 1);
          setMode('create-scope' as const);
        },
      },
    ],
    [scope, t],
  );

  useEffect(() => {
    if (agentsError) setMessage(agentsError.message);
  }, [agentsError]);

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

  useEffect(() => {
    if (mode !== 'create') return;
    window.setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [mode]);

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
      setMessage(t('agent.create.required'));
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
        setMessage(t('agent.created', { name: result.agent.name }));
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
    t,
  ]);

  const handleDelete = useCallback(
    (agent: DaemonWorkspaceAgentSummary) => {
      const deleteScope = scopeForLevel(agent.level);
      if (!deleteScope || agent.isBuiltin || agent.level === 'extension') {
        setMessage(t('agent.readonly'));
        return;
      }
      setBusy(true);
      deleteAgent(agent.name, deleteScope)
        .then(() => {
          setMessage(t('agent.deleted', { name: agent.name }));
          setDetail(null);
          reload();
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusy(false));
    },
    [deleteAgent, reload, t],
  );

  const handleCreateKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!busy) handleCreate();
        return;
      }

      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
        return;
      }

      const target = e.target;
      if (
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        return;
      }

      const fields = [
        nameInputRef.current,
        descriptionInputRef.current,
        systemPromptRef.current,
      ].filter((field): field is HTMLInputElement | HTMLTextAreaElement =>
        Boolean(field),
      );
      const index = fields.indexOf(target);
      if (index < 0) return;

      e.preventDefault();
      const nextIndex =
        e.key === 'ArrowDown'
          ? Math.min(index + 1, fields.length - 1)
          : Math.max(index - 1, 0);
      fields[nextIndex]?.focus();
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
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('agents.title')}</span>
        <span className={dp('resume-picker-count')}>
          {t('agent.count', { count: agents.length })}
        </span>
        <button
          className={dp('resume-picker-close')}
          onClick={onClose}
          title="Close"
        >
          ESC
        </button>
      </div>

      <div className={dp('resume-picker-search')}>
        <span className={dp('resume-picker-search-hint')}>
          {message ||
            (loading
              ? t('common.loading')
              : mode === 'menu'
                ? t('agent.selectAction')
                : mode === 'create-scope'
                  ? t('agent.create.scope')
                  : '')}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      {mode === 'menu' ? (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {menuItems.map((item, index) => (
            <div
              key={item.label}
              className={dp(
                'resume-picker-item',
                index === selectedIdx ? 'selected' : undefined,
              )}
              onClick={() => item.onSelect()}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {index === selectedIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {item.label}
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>
                {item.description}
              </div>
            </div>
          ))}
        </div>
      ) : mode === 'create-scope' ? (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {scopeItems.map((item, index) => (
            <div
              key={item.scope}
              className={dp(
                'resume-picker-item',
                index === selectedIdx ? 'selected' : undefined,
              )}
              onClick={() => {
                setScope(item.scope);
                setMode('create');
              }}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {index === selectedIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {item.label}
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>
                {item.description}
              </div>
            </div>
          ))}
        </div>
      ) : mode === 'create' ? (
        <div className={dp('dialog-form')} onKeyDown={handleCreateKeyDown}>
          <label>
            {t('agent.create.name')}
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {t('agent.create.description')}
            <input
              ref={descriptionInputRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            {t('agent.create.prompt')}
            <textarea
              ref={systemPromptRef}
              className={dp('dialog-textarea')}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </label>
          <button
            className={dp('dialog-primary-button')}
            disabled={busy}
            onClick={handleCreate}
          >
            {busy ? t('agent.create.loading') : t('agent.create.button')}
          </button>
        </div>
      ) : (
        <div className={dp('dialog-split')}>
          <div
            className={dp('resume-picker-list', 'dialog-split-list')}
            ref={listRef}
          >
            {!loading && agents.length === 0 && (
              <div className={dp('resume-picker-empty')}>
                {t('agent.empty')}
              </div>
            )}
            {agents.map((agent, i) => (
              <div
                key={`${agent.level}:${agent.name}`}
                className={dp(
                  'resume-picker-item',
                  i === selectedIdx ? 'selected' : undefined,
                )}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => loadDetail(agent)}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-prefix')}>
                    {i === selectedIdx ? '›' : ' '}
                  </span>
                  <span className={dp('resume-picker-item-title')}>
                    {agent.name}
                  </span>
                  <span className={dp('resume-picker-item-badge')}>
                    {agent.level}
                  </span>
                </div>
                <div className={dp('resume-picker-item-meta')}>
                  {agent.description}
                </div>
              </div>
            ))}
          </div>

          <div className={dp('dialog-detail')}>
            {detail ? (
              <>
                <div className={dp('dialog-detail-title')}>{detail.name}</div>
                <div className={dp('dialog-detail-meta')}>
                  {detail.level}
                  {detail.model ? ` · ${detail.model}` : ''}
                </div>
                <div className={dp('dialog-detail-body')}>
                  {detail.systemPrompt}
                </div>
                {detail.tools && detail.tools.length > 0 && (
                  <div className={dp('dialog-detail-meta')}>
                    {t('agent.tools')}: {detail.tools.join(', ')}
                  </div>
                )}
                {canDeleteAgent(detail) && (
                  <button
                    className={dp('dialog-danger-button')}
                    disabled={busy}
                    onClick={() => handleDelete(detail)}
                  >
                    {busy ? t('agent.delete.loading') : t('agent.delete')}
                  </button>
                )}
              </>
            ) : (
              <div className={dp('resume-picker-empty')}>
                {t('agent.select')}
              </div>
            )}
          </div>
        </div>
      )}

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {mode === 'menu'
          ? t('dialog.footer.navSelectClose')
          : mode === 'create-scope'
            ? initialMode === 'menu'
              ? t('dialog.footer.navSelectMenu')
              : t('dialog.footer.navSelectClose')
            : mode === 'manage'
              ? initialMode === 'menu'
                ? `${t('common.navigate')} · ${t('dialog.footer.menu')}`
                : `${t('common.navigate')} · ${t('dialog.footer.close')}`
              : initialMode === 'menu'
                ? t('dialog.footer.saveMenu')
                : t('dialog.footer.saveClose')}
      </div>
    </div>
  );
}
