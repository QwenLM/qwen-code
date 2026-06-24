import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  useAgents,
  useTools,
  type DaemonWorkspaceAgentSummary,
  type DaemonWorkspaceAgentDetail,
  type DaemonWorkspaceToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { trimDialogLabel } from '../../utils/dialogLabels';
import styles from './AgentsMessage.module.css';

export type AgentsInitialMode =
  | 'menu'
  | 'create'
  | 'create-user'
  | 'create-project'
  | 'manage';

interface AgentsMessageProps {
  mode: AgentsInitialMode;
  embedded?: boolean;
  onMessage: (text: string) => void;
  onClose: () => void;
}

type ToolCategoryId = 'all' | 'read' | 'edit' | 'execute';

interface ToolCategory {
  id: ToolCategoryId;
  label: string;
  tools: string[];
}

function scopeForLevel(level: string): 'workspace' | 'global' | undefined {
  if (level === 'project') return 'workspace';
  if (level === 'user') return 'global';
  return undefined;
}

function canModifyAgent(agent: DaemonWorkspaceAgentSummary): boolean {
  return (
    scopeForLevel(agent.level) !== undefined &&
    !agent.isBuiltin &&
    agent.level !== 'extension'
  );
}

function levelLabel(level: string, t: ReturnType<typeof useI18n>['t']): string {
  if (level === 'project') return t('agent.level.project');
  if (level === 'user') return t('agent.level.user');
  if (level === 'builtin') return t('agent.level.builtin');
  if (level === 'extension') return t('agent.level.extension');
  return level;
}

const detailLabel = trimDialogLabel;

function normalizeToolName(tool: DaemonWorkspaceToolStatus): string {
  return tool.displayName || tool.name;
}

function isReadTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return [
    'read',
    'grep',
    'glob',
    'ls',
    'list',
    'search',
    'fetch',
    'webfetch',
    'web_fetch',
    'websearch',
    'web_search',
    'think',
    'todo',
    'context',
  ].some((token) => normalized.includes(token));
}

function isEditTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return ['edit', 'write', 'delete', 'move', 'patch', 'replace', 'create'].some(
    (token) => normalized.includes(token),
  );
}

function isExecuteTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return ['shell', 'exec', 'run', 'command', 'terminal', 'bash', 'spawn'].some(
    (token) => normalized.includes(token),
  );
}

function resolveToolCategoryIndex(
  categories: ToolCategory[],
  tools: string[] | undefined,
): number {
  if (!tools || tools.length === 0) return 0;
  const input = new Set(tools);
  const match = categories.findIndex((category) => {
    if (category.id === 'all') return false;
    if (category.tools.length !== input.size) return false;
    return category.tools.every((tool) => input.has(tool));
  });
  return match >= 0 ? match : 0;
}

// ── Main Component ────────────────────────────────────────────────

export function AgentsMessage({
  mode,
  embedded = false,
  onMessage,
  onClose,
}: AgentsMessageProps) {
  const { t } = useI18n();
  const {
    agents,
    loading,

    reload,
    getAgent,
    createAgent,
    generateAgent,
    deleteAgent,
  } = useAgents({ autoLoad: true });
  const { tools: workspaceTools } = useTools({ autoLoad: true });

  const [closed, setClosed] = useState(false);
  const [topMode, setTopMode] = useState<'menu' | 'manage' | 'create'>(() => {
    if (mode === 'manage') return 'manage';
    if (
      mode === 'create' ||
      mode === 'create-user' ||
      mode === 'create-project'
    )
      return 'create';
    return 'menu';
  });

  // ── Menu state ──
  const [menuIdx, setMenuIdx] = useState(0);

  // ── Manage state ──
  const [selectedAgentIdx, setSelectedAgentIdx] = useState(0);
  const [selectedAgent, setSelectedAgent] =
    useState<DaemonWorkspaceAgentDetail | null>(null);
  const [expandedAgentIdx, setExpandedAgentIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── Create state (linear wizard) ──
  const [createStep, setCreateStep] = useState(1);
  const [createScope, setCreateScope] = useState<'workspace' | 'global'>(() =>
    mode === 'create-user' ? 'global' : 'workspace',
  );
  const [createMethod, setCreateMethod] = useState<'manual' | 'qwen'>('manual');
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createPrompt, setCreatePrompt] = useState('');
  const [createTools, setCreateTools] = useState<string[]>([]);
  const [createSelIdx, setCreateSelIdx] = useState(0);
  const [createGenerating, setCreateGenerating] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const generationRunRef = useRef(0);

  const handleClose = useCallback(() => {
    setClosed(true);
    onClose();
  }, [onClose]);

  // Group agents by level for manage view
  const agentGroups = useMemo(() => {
    const project = agents.filter((a) => a.level === 'project');
    const user = agents.filter((a) => a.level === 'user');
    const builtin = agents.filter((a) => a.level === 'builtin');
    const extension = agents.filter((a) => a.level === 'extension');
    return { project, user, builtin, extension };
  }, [agents]);

  const flatAgents = useMemo(
    () => [
      ...agentGroups.project,
      ...agentGroups.user,
      ...agentGroups.builtin,
      ...agentGroups.extension,
    ],
    [agentGroups],
  );

  const toolCategories = useMemo<ToolCategory[]>(() => {
    const enabledToolNames = workspaceTools
      .filter((tool) => tool.enabled)
      .map(normalizeToolName)
      .sort((a, b) => a.localeCompare(b));
    const readTools = enabledToolNames.filter(isReadTool);
    const editTools = enabledToolNames.filter(isEditTool);
    const executeTools = enabledToolNames.filter(isExecuteTool);

    return [
      { id: 'all', label: t('agent.create.tools.all'), tools: [] },
      { id: 'read', label: t('agent.create.tools.readOnly'), tools: readTools },
      {
        id: 'edit',
        label: t('agent.create.tools.readEdit'),
        tools: [...new Set([...readTools, ...editTools])],
      },
      {
        id: 'execute',
        label: t('agent.create.tools.readEditExecute'),
        tools: [...new Set([...readTools, ...editTools, ...executeTools])],
      },
    ];
  }, [t, workspaceTools]);

  // Load agent detail when selected
  useEffect(() => {
    if (topMode !== 'manage') return;
    const agent =
      expandedAgentIdx !== null ? flatAgents[expandedAgentIdx] : undefined;
    if (!agent) return;
    getAgent(agent.name)
      .then(setSelectedAgent)
      .catch((e: unknown) =>
        setErrorMsg(e instanceof Error ? e.message : String(e)),
      );
  }, [topMode, flatAgents, expandedAgentIdx, getAgent]);

  // Clamp selectedAgentIdx when agents list changes
  useEffect(() => {
    if (selectedAgentIdx >= flatAgents.length && flatAgents.length > 0) {
      setSelectedAgentIdx(flatAgents.length - 1);
    }
    if (expandedAgentIdx !== null && expandedAgentIdx >= flatAgents.length) {
      setExpandedAgentIdx(null);
    }
  }, [expandedAgentIdx, flatAgents.length, selectedAgentIdx]);

  // ── Manage: delete agent ──
  const handleDelete = useCallback(
    (agentIdx = selectedAgentIdx) => {
      const agent = flatAgents[agentIdx];
      if (!agent || !canModifyAgent(agent)) return;
      const deleteScope = scopeForLevel(agent.level);
      if (!deleteScope) return;
      setBusy(true);
      deleteAgent(agent.name, deleteScope)
        .then(() => {
          onMessage(t('agent.deleted', { name: agent.name }));
          setSelectedAgent(null);
          setExpandedAgentIdx(null);
          setSelectedAgentIdx(0);
          reload();
        })
        .catch((e: unknown) =>
          setErrorMsg(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setBusy(false));
    },
    [flatAgents, selectedAgentIdx, deleteAgent, onMessage, reload, t],
  );

  // ── Create: save ──
  const handleCreateSave = useCallback(() => {
    if (!createName.trim() || !createDesc.trim() || !createPrompt.trim()) {
      setErrorMsg(t('agent.create.required'));
      return;
    }
    setBusy(true);
    createAgent({
      name: createName.trim(),
      description: createDesc.trim(),
      systemPrompt: createPrompt.trim(),
      scope: createScope,
      tools: createTools,
    })
      .then((result) => {
        onMessage(t('agent.created', { name: result.agent.name }));
        handleClose();
      })
      .catch((e: unknown) =>
        setErrorMsg(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [
    createName,
    createDesc,
    createPrompt,
    createScope,
    createTools,
    createAgent,
    onMessage,
    handleClose,
    t,
  ]);
  // ── Create helpers ──
  const handleGenerateAgent = useCallback(async () => {
    const description = createDesc.trim();
    if (!description || createGenerating) return;
    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    setCreateGenerating(true);
    setInputFocused(false);
    setErrorMsg(null);
    try {
      const generated = await generateAgent(description);
      if (generationRunRef.current !== runId) return;
      setCreateName(generated.name);
      setCreateDesc(generated.description);
      setCreatePrompt(generated.systemPrompt);
      setCreateStep(createMethod === 'manual' ? 6 : 4);
      setCreateSelIdx(0);
    } catch (err) {
      if (generationRunRef.current !== runId) return;
      setErrorMsg(
        t('agent.create.generateFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      setInputFocused(true);
    } finally {
      if (generationRunRef.current === runId) {
        setCreateGenerating(false);
      }
    }
  }, [createDesc, createGenerating, createMethod, generateAgent, t]);

  const handleInputNext = useCallback(
    (field: 'name' | 'desc' | 'prompt') => {
      if (field === 'name' && createName.trim()) {
        setCreateStep(4);
        setInputFocused(true);
      } else if (field === 'prompt' && createPrompt.trim()) {
        setCreateStep(5);
        setInputFocused(true);
      } else if (field === 'desc' && createDesc.trim()) {
        if (createMethod === 'qwen') {
          void handleGenerateAgent();
          return;
        }
        setCreateStep(createMethod === 'manual' ? 6 : 4);
        setCreateSelIdx(0);
        setInputFocused(false);
      }
    },
    [createName, createDesc, createPrompt, createMethod, handleGenerateAgent],
  );

  // ── Render ──

  if (closed) {
    return (
      <div
        className={`${styles.panel} ${embedded ? styles.embedded : ''} ${
          styles.closed
        }`}
      >
        <div className={styles.closedText}>{t('agents.closed')}</div>
      </div>
    );
  }

  if (loading && agents.length === 0) {
    return (
      <div className={`${styles.panel} ${embedded ? styles.embedded : ''}`}>
        <div className={styles.titleLine}>
          <span className={styles.icon}>?</span>
          <span className={styles.title}>{t('agents.title')}</span>
        </div>
        <div className={styles.loading}>{t('common.loading')}</div>
      </div>
    );
  }

  const panelTitle = t('agents.title');

  return (
    <div className={`${styles.panel} ${embedded ? styles.embedded : ''}`}>
      {!embedded && topMode !== 'create' && (
        <div className={styles.titleLine}>
          <span className={styles.icon}>?</span>
          <span className={styles.title}>{panelTitle}</span>
          <span className={styles.subtitle}>
            {t('agent.count', { count: agents.length })}
          </span>
        </div>
      )}

      {errorMsg && <div className={styles.error}>{errorMsg}</div>}

      {/* ── Menu ── */}
      {topMode === 'menu' && (
        <>
          <div className={styles.text}>{t('agent.selectAction')}</div>
          <div className={styles.options}>
            <OptionItem
              idx={0}
              active={menuIdx === 0}
              label={t('agent.manage')}
              desc={t('agent.manage.desc')}
              onClick={() => {
                setMenuIdx(0);
                setTopMode('manage');
              }}
              onHover={() => setMenuIdx(0)}
            />
            <OptionItem
              idx={1}
              active={menuIdx === 1}
              label={t('agent.create')}
              desc={t('agent.create.desc')}
              onClick={() => {
                setMenuIdx(1);
                setTopMode('create');
              }}
              onHover={() => setMenuIdx(1)}
            />
          </div>
          <div className={styles.footer}>{t('agent.footer.nav')}</div>
        </>
      )}

      {/* ── Manage ── */}
      {topMode === 'manage' && (
        <ManageView
          agents={flatAgents}
          expandedAgentIdx={expandedAgentIdx}
          selectedAgent={selectedAgent}
          busy={busy}
          onToggleAgent={(idx) => {
            setSelectedAgentIdx(idx);
            setExpandedAgentIdx((current) => (current === idx ? null : idx));
            setSelectedAgent(null);
          }}
          onDelete={(idx) => {
            if (!busy) handleDelete(idx);
          }}
          t={t}
        />
      )}

      {/* ── Create ── */}
      {topMode === 'create' && (
        <CreateView
          step={createStep}
          method={createMethod}
          scope={createScope}
          name={createName}
          desc={createDesc}
          prompt={createPrompt}
          tools={createTools}
          toolCategories={toolCategories}
          selIdx={createSelIdx}
          busy={busy}
          generating={createGenerating}
          inputFocused={inputFocused}
          onSetName={setCreateName}
          onSetDesc={setCreateDesc}
          onSetPrompt={setCreatePrompt}
          onInputNext={handleInputNext}
          onInputFocus={() => setInputFocused(true)}
          onInputBlur={() => setInputFocused(false)}
          onSetStep={setCreateStep}
          onSetSelectedIndex={setCreateSelIdx}
          onSelectLocation={(idx) => {
            setCreateSelIdx(idx);
            setCreateScope(idx === 0 ? 'workspace' : 'global');
          }}
          onSelectMethod={(idx) => {
            setCreateSelIdx(idx);
            setCreateMethod(idx === 0 ? 'qwen' : 'manual');
          }}
          onSelectTools={(idx) => {
            setCreateSelIdx(idx);
            setCreateTools(toolCategories[idx]?.tools ?? []);
          }}
          onSave={() => {
            if (!busy) handleCreateSave();
          }}
          t={t}
        />
      )}
    </div>
  );
}

// ── Shared OptionItem ─────────────────────────────────────────────

function OptionItem({
  idx,
  active,
  label,
  desc,
  badge,
  numbered = false,
  onClick,
  onHover,
}: {
  idx: number;
  active: boolean;
  label: string;
  desc?: string;
  badge?: string;
  numbered?: boolean;
  onClick: () => void;
  onHover?: () => void;
}) {
  return (
    <div
      className={`${styles.option} ${active ? styles.optionActive : ''}`}
      onClick={onClick}
      onMouseEnter={onHover}
    >
      <span className={styles.optionIcon} aria-hidden="true" />
      <span className={styles.optionContent}>
        <span className={styles.optionLabel}>
          {numbered ? `${idx + 1}. ` : ''}
          {label}
          {badge && <span className={styles.badge}>{badge}</span>}
        </span>
        {desc && <span className={styles.optionDesc}>{desc}</span>}
      </span>
    </div>
  );
}

// ── Manage View ───────────────────────────────────────────────────

function ManageView({
  agents,
  expandedAgentIdx,
  selectedAgent,
  busy,
  onToggleAgent,
  onDelete,
  t,
}: {
  agents: DaemonWorkspaceAgentSummary[];
  expandedAgentIdx: number | null;
  selectedAgent: DaemonWorkspaceAgentDetail | null;
  busy: boolean;
  onToggleAgent: (idx: number) => void;
  onDelete: (idx: number) => void;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const [deleteConfirmIdx, setDeleteConfirmIdx] = useState<number | null>(null);
  const projectNames = useMemo(
    () =>
      new Set(
        agents
          .filter((agent) => agent.level === 'project')
          .map((agent) => agent.name),
      ),
    [agents],
  );

  if (agents.length === 0) {
    return (
      <>
        <div className={styles.text}>{t('agent.empty')}</div>
        <div className={styles.text}>{t('agent.createFirstHint')}</div>
      </>
    );
  }

  return (
    <div className={styles.manageList}>
      {agents.map((agent, idx) => {
        const expanded = expandedAgentIdx === idx;
        const detail =
          expanded && selectedAgent?.name === agent.name ? selectedAgent : null;
        const mutable = canModifyAgent(agent);
        const detailTools = detail?.tools ?? [];
        const toolsText =
          detailTools.length === 0 || detailTools.includes('*')
            ? t('agent.create.tools.all')
            : detailTools.join(', ');
        return (
          <div
            key={`${agent.level}:${agent.name}`}
            className={`${styles.manageItem} ${
              expanded ? styles.manageItemExpanded : ''
            }`}
          >
            <button
              type="button"
              className={`${styles.manageRow} ${
                expanded ? styles.manageRowActive : ''
              }`}
              onClick={() => {
                setDeleteConfirmIdx(null);
                onToggleAgent(idx);
              }}
            >
              <span className={styles.manageIcon} aria-hidden="true" />
              <span className={styles.manageName}>{agent.name}</span>
              <span className={styles.levelTag}>
                {levelLabel(agent.level, t)}
              </span>
              {agent.level === 'user' && projectNames.has(agent.name) ? (
                <span className={styles.levelTag}>
                  {t('agent.overriddenBadge')}
                </span>
              ) : null}
              <span
                className={`${styles.manageChevron} ${
                  expanded ? styles.manageChevronExpanded : ''
                }`}
              />
            </button>

            {expanded ? (
              <div className={styles.manageDetail}>
                {detail ? (
                  <div className={styles.manageDetailInner}>
                    <div className={styles.manageDetailHeader}>
                      {mutable ? (
                        <div className={styles.manageActions}>
                          {deleteConfirmIdx === idx ? (
                            <>
                              <span className={styles.deleteText}>
                                {busy
                                  ? t('agent.delete.loading')
                                  : t('agent.delete.confirm', {
                                      name: agent.name,
                                    })}
                              </span>
                              <button
                                type="button"
                                className={styles.manageButton}
                                onClick={() => setDeleteConfirmIdx(null)}
                                disabled={busy}
                              >
                                {t('common.cancel')}
                              </button>
                              <button
                                type="button"
                                className={`${styles.manageButton} ${styles.dangerButton}`}
                                onClick={() => onDelete(idx)}
                                disabled={busy}
                              >
                                {t('agent.action.delete')}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.manageButton} ${styles.dangerButton}`}
                              onClick={() => setDeleteConfirmIdx(idx)}
                              disabled={busy}
                            >
                              {t('agent.action.delete')}
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <div className={styles.viewerField}>
                      <div className={styles.viewerSectionTitle}>
                        {detailLabel(t('agent.toolsLabel'))}
                      </div>
                      <div className={styles.viewerBlock}>{toolsText}</div>
                    </div>
                    <div className={styles.viewerField}>
                      <div className={styles.viewerSectionTitle}>
                        {detailLabel(t('agent.filePathLabel'))}
                      </div>
                      <div className={styles.viewerBlock}>
                        {detail.filePath || '—'}
                      </div>
                    </div>
                    {detail.model ? (
                      <div className={styles.viewerRow}>
                        <span className={styles.viewerLabel}>
                          {detailLabel(t('agent.modelLabel'))}
                        </span>
                        <span>{detail.model}</span>
                      </div>
                    ) : null}
                    <div className={styles.viewerField}>
                      <div className={styles.viewerSectionTitle}>
                        {detailLabel(t('agent.descriptionLabel'))}
                      </div>
                      <div className={styles.viewerBlock}>
                        {detail.description || '—'}
                      </div>
                    </div>
                    <div className={styles.viewerField}>
                      <div className={styles.viewerSectionTitle}>
                        {detailLabel(t('agent.systemPromptLabel'))}
                      </div>
                      <div className={styles.viewerBlock}>
                        {detail.systemPrompt || '—'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className={styles.loading}>{t('common.loading')}</div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Create View ───────────────────────────────────────────────────

function CreateView({
  step,
  method,
  scope,
  name,
  desc,
  prompt,
  tools,
  toolCategories,
  selIdx,
  busy,
  generating,
  inputFocused,
  onSetName,
  onSetDesc,
  onSetPrompt,
  onInputNext,
  onInputFocus,
  onInputBlur,
  onSetStep,
  onSetSelectedIndex,
  onSelectLocation,
  onSelectMethod,
  onSelectTools,
  onSave,
  t,
}: {
  step: number;
  method: 'manual' | 'qwen';
  scope: 'workspace' | 'global';
  name: string;
  desc: string;
  prompt: string;
  tools: string[];
  toolCategories: ToolCategory[];
  selIdx: number;
  busy: boolean;
  generating: boolean;
  inputFocused: boolean;
  onSetName: (v: string) => void;
  onSetDesc: (v: string) => void;
  onSetPrompt: (v: string) => void;
  onInputNext: (field: 'name' | 'desc' | 'prompt') => void;
  onInputFocus: () => void;
  onInputBlur: () => void;
  onSetStep: (step: number) => void;
  onSetSelectedIndex: (idx: number) => void;
  onSelectLocation: (idx: number) => void;
  onSelectMethod: (idx: number) => void;
  onSelectTools: (idx: number) => void;
  onSave: () => void;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus text inputs
  useEffect(() => {
    if (!inputFocused) return;
    if (method === 'manual') {
      if (step === 3) nameRef.current?.focus();
      else if (step === 4) promptRef.current?.focus();
      else if (step === 5) descRef.current?.focus();
    } else {
      if (step === 3) descRef.current?.focus();
    }
  }, [step, method, inputFocused]);

  const toolsStep = method === 'manual' ? 6 : 4;
  const confirmStep = toolsStep + 1;
  const stepItems =
    method === 'manual'
      ? [
          t('agent.create.location'),
          t('agent.create.method'),
          t('agent.create.name'),
          t('agent.create.prompt'),
          t('agent.create.description'),
          t('agent.create.toolsSelection'),
        ]
      : [
          t('agent.create.location'),
          t('agent.create.method'),
          t('agent.create.describeAgent'),
          t('agent.create.toolsSelection'),
        ];

  const selectedIndexForStep = (targetStep: number) => {
    if (targetStep === 1) return scope === 'workspace' ? 0 : 1;
    if (targetStep === 2) return method === 'qwen' ? 0 : 1;
    if (targetStep === toolsStep) {
      return resolveToolCategoryIndex(toolCategories, tools);
    }
    return 0;
  };

  const goToStep = (targetStep: number) => {
    onSetStep(targetStep);
    onSetSelectedIndex(selectedIndexForStep(targetStep));
    if (
      (method === 'manual' &&
        (targetStep === 3 || targetStep === 4 || targetStep === 5)) ||
      (method === 'qwen' && targetStep === 3)
    ) {
      onInputFocus();
    } else {
      onInputBlur();
    }
  };

  const goBack = () => {
    if (step <= 1 || generating) return;
    goToStep(step - 1);
  };

  const goNext = () => {
    if (generating) return;
    if (step === 1) {
      goToStep(2);
      return;
    }
    if (step === 2) {
      goToStep(3);
      return;
    }
    if (method === 'manual' && step === 3) {
      onInputNext('name');
      return;
    }
    if (method === 'manual' && step === 4) {
      onInputNext('prompt');
      return;
    }
    if (
      (method === 'manual' && step === 5) ||
      (method === 'qwen' && step === 3)
    ) {
      onInputNext('desc');
      return;
    }
    if (step === toolsStep) {
      onSelectTools(selIdx);
      goToStep(confirmStep);
    }
  };

  const nextDisabled =
    generating ||
    (method === 'manual' && step === 3 && !name.trim()) ||
    (method === 'manual' && step === 4 && !prompt.trim()) ||
    (method === 'manual' && step === 5 && !desc.trim()) ||
    (method === 'qwen' && step === 3 && !desc.trim());

  let body: ReactNode = null;

  if (step === 1) {
    body = (
      <>
        <div className={styles.options}>
          <OptionItem
            idx={0}
            active={selIdx === 0}
            label={t('agent.create.project.cli')}
            numbered
            onClick={() => onSelectLocation(0)}
          />
          <OptionItem
            idx={1}
            active={selIdx === 1}
            label={t('agent.create.user.cli')}
            numbered
            onClick={() => onSelectLocation(1)}
          />
        </div>
      </>
    );
  }

  if (step === 2) {
    body = (
      <>
        <div className={styles.options}>
          <OptionItem
            idx={0}
            active={selIdx === 0}
            label={t('agent.create.method.qwen.recommended')}
            numbered
            onClick={() => onSelectMethod(0)}
          />
          <OptionItem
            idx={1}
            active={selIdx === 1}
            label={t('agent.create.method.manual')}
            numbered
            onClick={() => onSelectMethod(1)}
          />
        </div>
      </>
    );
  }

  if (method === 'manual' && step === 3) {
    body = (
      <>
        <div className={styles.text}>{t('agent.create.nameHelp')}</div>
        <input
          ref={nameRef}
          className={styles.textInput}
          value={name}
          onChange={(e) => onSetName(e.target.value)}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('agent.create.namePlaceholder')}
          autoFocus
        />
      </>
    );
  }

  if (method === 'manual' && step === 4) {
    body = (
      <>
        <div className={styles.text}>{t('agent.create.promptHelp')}</div>
        <textarea
          ref={promptRef}
          className={styles.textArea}
          value={prompt}
          onChange={(e) => onSetPrompt(e.target.value)}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('agent.create.promptPlaceholder.cli')}
          autoFocus
        />
      </>
    );
  }

  if (method === 'manual' && step === 5) {
    body = (
      <>
        <div className={styles.text}>{t('agent.create.manualDescHelp')}</div>
        <textarea
          ref={descRef}
          className={styles.textArea}
          value={desc}
          onChange={(e) => onSetDesc(e.target.value)}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('agent.create.manualDescPlaceholder')}
          autoFocus
        />
      </>
    );
  }

  if (method === 'qwen' && step === 3) {
    body = (
      <>
        <div className={styles.text}>{t('agent.create.qwenHint')}</div>
        {generating ? (
          <>
            <div className={styles.text}>
              {t('agent.create.generatingConfig')}
            </div>
            <div className={styles.footer}>{t('agent.footer.generating')}</div>
          </>
        ) : (
          <>
            <textarea
              ref={descRef}
              className={styles.textArea}
              value={desc}
              onChange={(e) => onSetDesc(e.target.value)}
              onFocus={onInputFocus}
              onBlur={onInputBlur}
              placeholder={t('agent.create.qwenPlaceholder')}
              autoFocus
            />
          </>
        )}
      </>
    );
  }

  if (step === toolsStep) {
    const selectedCategory = toolCategories[selIdx] ?? toolCategories[0];
    const selectedToolList = selectedCategory?.tools ?? [];
    const selectedToolsDisplay =
      selectedCategory?.id === 'all'
        ? t('agent.create.tools.allInfo')
        : selectedToolList.length > 0
          ? selectedToolList.join(', ')
          : t('agent.create.tools.none');
    const selectedReadTools = selectedToolList.filter(isReadTool);
    const selectedEditTools = selectedToolList.filter(isEditTool);
    const selectedExecuteTools = selectedToolList.filter(isExecuteTool);

    body = (
      <>
        <div className={styles.options}>
          {toolCategories.map((category, i) => (
            <OptionItem
              key={category.id}
              idx={i}
              active={selIdx === i}
              label={category.label}
              numbered
              onClick={() => onSelectTools(i)}
            />
          ))}
        </div>
        <div className={styles.toolDetail}>
          {selectedCategory?.id === 'all' ? (
            <div className={styles.toolDetailBody}>{selectedToolsDisplay}</div>
          ) : (
            <>
              <div className={styles.toolDetailTitle}>
                {t('agent.create.tools.selected')}
              </div>
              <div className={styles.toolList}>
                {selectedToolList.length === 0 ? (
                  selectedToolsDisplay
                ) : (
                  <>
                    {selectedReadTools.length > 0 && (
                      <div>
                        {t('agent.create.tools.readOnlyLabel')}{' '}
                        {selectedReadTools.join(', ')}
                      </div>
                    )}
                    {selectedEditTools.length > 0 && (
                      <div>
                        {t('agent.create.tools.editLabel')}{' '}
                        {selectedEditTools.join(', ')}
                      </div>
                    )}
                    {selectedExecuteTools.length > 0 && (
                      <div>
                        {t('agent.create.tools.executionLabel')}{' '}
                        {selectedExecuteTools.join(', ')}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  if (step === confirmStep) {
    const toolsDisplay = tools.length === 0 ? '*' : tools.join(', ');

    body = (
      <>
        <div className={styles.summary}>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>
              {detailLabel(t('agent.create.name'))}
            </span>
            <span className={styles.summaryValue}>{name || '—'}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>
              {detailLabel(t('agent.location'))}
            </span>
            <span className={styles.summaryValue}>
              {scope === 'workspace'
                ? t('agent.create.project.cli')
                : t('agent.create.user.cli')}
            </span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>
              {detailLabel(t('agent.toolsLabel'))}
            </span>
            <span className={styles.summaryValue}>{toolsDisplay}</span>
          </div>
          <div className={styles.summaryBlockTitle}>
            {detailLabel(t('agent.descriptionLabel'))}
          </div>
          <div className={styles.summaryBlock}>{desc || '—'}</div>
          <div className={styles.summaryBlockTitle}>
            {detailLabel(t('agent.systemPromptLabel'))}
          </div>
          <div className={styles.summaryBlock}>{prompt || '—'}</div>
        </div>
      </>
    );
  }

  return (
    <div className={styles.createWizard}>
      <div className={styles.createSteps}>
        {stepItems.map((label, index) => {
          const stepNumber = index + 1;
          return (
            <div
              key={`${stepNumber}:${label}`}
              className={`${styles.createStepPill} ${
                stepNumber === Math.min(step, toolsStep)
                  ? styles.createStepPillActive
                  : ''
              } ${stepNumber < Math.min(step, toolsStep) ? styles.createStepPillDone : ''}`}
            >
              <span className={styles.createStepNumber}>{stepNumber}</span>
              <span className={styles.createStepLabel}>{label}</span>
            </div>
          );
        })}
      </div>
      <div className={styles.createBody}>{body}</div>
      <div className={styles.createActions}>
        <button
          type="button"
          className={styles.manageButton}
          onClick={goBack}
          disabled={step <= 1 || generating || busy}
        >
          {t('common.previous')}
        </button>
        {step === confirmStep ? (
          <button
            type="button"
            className={styles.manageButton}
            onClick={onSave}
            disabled={busy}
          >
            {busy ? t('agent.create.loading') : t('agent.create.save')}
          </button>
        ) : (
          <button
            type="button"
            className={styles.manageButton}
            onClick={goNext}
            disabled={nextDisabled}
          >
            {t('common.next')}
          </button>
        )}
      </div>
    </div>
  );
}
