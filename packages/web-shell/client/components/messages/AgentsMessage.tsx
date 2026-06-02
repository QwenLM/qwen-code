import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  useAgents,
  useTools,
  type DaemonWorkspaceAgentSummary,
  type DaemonWorkspaceAgentDetail,
  type DaemonWorkspaceToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './AgentsMessage.module.css';

export type AgentsInitialMode =
  | 'menu'
  | 'create'
  | 'create-user'
  | 'create-project'
  | 'manage';

export const AGENTS_ACTIVE_EVENT = 'web-shell:agents-panel-active';

interface AgentsMessageProps {
  mode: AgentsInitialMode;
  onMessage: (text: string) => void;
  onClose: () => void;
}

const COLOR_OPTIONS = [
  { id: 'auto', name: 'Automatic Color', value: 'auto' },
  { id: 'blue', name: 'Blue', value: '#3b82f6' },
  { id: 'green', name: 'Green', value: '#10b981' },
  { id: 'purple', name: 'Purple', value: '#8b5cf6' },
  { id: 'orange', name: 'Orange', value: '#f59e0b' },
  { id: 'red', name: 'Red', value: '#ef4444' },
  { id: 'cyan', name: 'Cyan', value: '#06b6d4' },
];

function dispatchActive(id: string, active: boolean): void {
  window.dispatchEvent(
    new CustomEvent(AGENTS_ACTIVE_EVENT, { detail: { id, active } }),
  );
}

type ManageStep =
  | 'agent-selection'
  | 'action-selection'
  | 'agent-viewer'
  | 'edit-options'
  | 'edit-tools'
  | 'edit-color'
  | 'delete-confirmation';

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

function displayAgentColor(color: string | undefined): string | undefined {
  return color && color !== 'auto' ? color : undefined;
}

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
    updateAgent,
  } = useAgents({ autoLoad: true });
  const { tools: workspaceTools } = useTools({ autoLoad: true });

  const [closed, setClosed] = useState(false);
  const panelIdRef = useRef(`agents-${Math.random().toString(36).slice(2)}`);
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

  // ── Manage state (stack-based navigation) ──
  const [manageStack, setManageStack] = useState<ManageStep[]>([
    'agent-selection',
  ]);
  const [selectedAgentIdx, setSelectedAgentIdx] = useState(0);
  const [selectedAgent, setSelectedAgent] =
    useState<DaemonWorkspaceAgentDetail | null>(null);
  const [manageSelIdx, setManageSelIdx] = useState(0);
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
  const [createColor, setCreateColor] = useState('auto');
  const [createTools, setCreateTools] = useState<string[]>([]);
  const [createSelIdx, setCreateSelIdx] = useState(0);
  const [createGenerating, setCreateGenerating] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const generationRunRef = useRef(0);

  const manageStep = manageStack[manageStack.length - 1]!;

  const handleClose = useCallback(() => {
    setClosed(true);
    dispatchActive(panelIdRef.current, false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (closed) return;
    const id = panelIdRef.current;
    dispatchActive(id, true);
    return () => dispatchActive(id, false);
  }, [closed]);

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
    const agent = flatAgents[selectedAgentIdx];
    if (
      agent &&
      (manageStep === 'action-selection' ||
        manageStep === 'agent-viewer' ||
        manageStep === 'edit-options' ||
        manageStep === 'edit-tools' ||
        manageStep === 'edit-color' ||
        manageStep === 'delete-confirmation')
    ) {
      getAgent(agent.name)
        .then(setSelectedAgent)
        .catch((e: unknown) =>
          setErrorMsg(e instanceof Error ? e.message : String(e)),
        );
    }
  }, [topMode, flatAgents, selectedAgentIdx, manageStep, getAgent]);

  // Clamp selectedAgentIdx when agents list changes
  useEffect(() => {
    if (selectedAgentIdx >= flatAgents.length && flatAgents.length > 0) {
      setSelectedAgentIdx(flatAgents.length - 1);
    }
  }, [flatAgents.length, selectedAgentIdx]);

  // ── Manage: navigate stack ──
  const managePush = useCallback((step: ManageStep) => {
    setManageStack((s) => [...s, step]);
    setManageSelIdx(0);
  }, []);

  const managePop = useCallback(() => {
    setManageStack((s) => {
      if (s.length <= 1) return s;
      return s.slice(0, -1);
    });
    setManageSelIdx(0);
  }, []);

  // ── Manage: delete agent ──
  const handleDelete = useCallback(() => {
    const agent = flatAgents[selectedAgentIdx];
    if (!agent || !canModifyAgent(agent)) return;
    const deleteScope = scopeForLevel(agent.level);
    if (!deleteScope) return;
    setBusy(true);
    deleteAgent(agent.name, deleteScope)
      .then(() => {
        onMessage(t('agent.deleted', { name: agent.name }));
        setSelectedAgent(null);
        setManageStack(['agent-selection']);
        setSelectedAgentIdx(0);
        reload();
      })
      .catch((e: unknown) =>
        setErrorMsg(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [flatAgents, selectedAgentIdx, deleteAgent, onMessage, reload, t]);

  // ── Manage: update color ──
  const handleUpdateColor = useCallback(
    (color: string) => {
      const agent = flatAgents[selectedAgentIdx];
      if (!agent || !canModifyAgent(agent)) return;
      const updateScope = scopeForLevel(agent.level);
      if (!updateScope) return;
      setBusy(true);
      updateAgent(agent.name, { color }, updateScope)
        .then(() => {
          onMessage(t('agent.colorUpdated', { name: agent.name }));
          managePop();
          reload();
        })
        .catch((e: unknown) =>
          setErrorMsg(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setBusy(false));
    },
    [
      flatAgents,
      selectedAgentIdx,
      updateAgent,
      onMessage,
      managePop,
      reload,
      t,
    ],
  );

  const handleUpdateTools = useCallback(
    (tools: string[]) => {
      const agent = flatAgents[selectedAgentIdx];
      if (!agent || !canModifyAgent(agent)) return;
      const updateScope = scopeForLevel(agent.level);
      if (!updateScope) return;
      setBusy(true);
      updateAgent(agent.name, { tools }, updateScope)
        .then(() => {
          onMessage(t('agent.toolsUpdated', { name: agent.name }));
          managePop();
          reload();
        })
        .catch((e: unknown) =>
          setErrorMsg(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setBusy(false));
    },
    [
      flatAgents,
      selectedAgentIdx,
      updateAgent,
      onMessage,
      managePop,
      reload,
      t,
    ],
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
      color: createColor !== 'auto' ? createColor : undefined,
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
    createColor,
    createAgent,
    onMessage,
    handleClose,
    t,
  ]);

  // ── Create: total steps ──
  const createTotalSteps = createMethod === 'manual' ? 8 : 6;
  const createToolsStep = createMethod === 'manual' ? 6 : 4;
  const createColorStep = createMethod === 'manual' ? 7 : 5;

  // ── Keyboard handler ──
  useEffect(() => {
    if (closed || inputFocused) return;

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      // ── Menu mode ──
      if (topMode === 'menu') {
        if (e.key === 'ArrowDown' || e.key === 'j') {
          claim();
          setMenuIdx((i) => Math.min(i + 1, 1));
        } else if (e.key === 'ArrowUp' || e.key === 'k') {
          claim();
          setMenuIdx((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' || e.key === ' ') {
          claim();
          if (menuIdx === 0) {
            setTopMode('manage');
          } else {
            setTopMode('create');
          }
        } else if (e.key === 'Escape') {
          claim();
          handleClose();
        }
        return;
      }

      // ── Manage mode ──
      if (topMode === 'manage') {
        if (e.key === 'Escape') {
          claim();
          if (manageStack.length <= 1) {
            if (mode === 'manage') handleClose();
            else {
              setTopMode('menu');
              setMenuIdx(0);
            }
          } else {
            managePop();
          }
          return;
        }

        if (manageStep === 'agent-selection') {
          const total = flatAgents.length;
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setSelectedAgentIdx((i) => Math.min(i + 1, total - 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setSelectedAgentIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            if (total > 0) managePush('action-selection');
          }
          return;
        }

        if (manageStep === 'action-selection') {
          const agent = flatAgents[selectedAgentIdx];
          const isReadOnly = agent ? !canModifyAgent(agent) : true;
          const actions = isReadOnly
            ? ['view', 'back']
            : ['view', 'edit', 'delete', 'back'];
          const total = actions.length;

          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setManageSelIdx((i) => Math.min(i + 1, total - 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setManageSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            const action = actions[manageSelIdx];
            if (action === 'view') managePush('agent-viewer');
            else if (action === 'edit') managePush('edit-options');
            else if (action === 'delete') managePush('delete-confirmation');
            else if (action === 'back') managePop();
          }
          return;
        }

        if (manageStep === 'agent-viewer') {
          // View is display-only, Esc handled above
          return;
        }

        if (manageStep === 'edit-options') {
          const editActions = ['tools', 'color', 'back'];
          const total = editActions.length;
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setManageSelIdx((i) => Math.min(i + 1, total - 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setManageSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            const action = editActions[manageSelIdx];
            if (action === 'tools') {
              managePush('edit-tools');
              setManageSelIdx(
                resolveToolCategoryIndex(toolCategories, selectedAgent?.tools),
              );
            } else if (action === 'color') managePush('edit-color');
            else if (action === 'back') managePop();
          }
          return;
        }

        if (manageStep === 'edit-tools') {
          const total = toolCategories.length;
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setManageSelIdx((i) => Math.min(i + 1, total - 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setManageSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            if (!busy)
              handleUpdateTools(toolCategories[manageSelIdx]?.tools ?? []);
          }
          return;
        }

        if (manageStep === 'edit-color') {
          const total = COLOR_OPTIONS.length;
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setManageSelIdx((i) => Math.min(i + 1, total - 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setManageSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            if (!busy) handleUpdateColor(COLOR_OPTIONS[manageSelIdx]!.value);
          }
          return;
        }

        if (manageStep === 'delete-confirmation') {
          if (e.key === 'y' || e.key === 'Enter') {
            claim();
            if (!busy) handleDelete();
          } else if (e.key === 'n') {
            claim();
            managePop();
          }
          return;
        }

        return;
      }

      // ── Create mode ──
      if (topMode === 'create') {
        if (createGenerating) {
          if (e.key === 'Escape') {
            claim();
            generationRunRef.current += 1;
            setCreateGenerating(false);
            setInputFocused(true);
          }
          return;
        }
        if (e.key === 'Escape') {
          claim();
          if (createStep <= 1) {
            if (
              mode === 'create' ||
              mode === 'create-user' ||
              mode === 'create-project'
            ) {
              handleClose();
            } else {
              setTopMode('menu');
              setMenuIdx(1);
            }
          } else {
            setCreateStep((s) => s - 1);
            setCreateSelIdx(0);
          }
          return;
        }

        // Step 1: Location
        if (createStep === 1) {
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setCreateSelIdx((i) => Math.min(i + 1, 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setCreateSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            setCreateScope(createSelIdx === 0 ? 'workspace' : 'global');
            setCreateStep(2);
            setCreateSelIdx(0);
          }
          return;
        }

        // Step 2: Generation method
        if (createStep === 2) {
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setCreateSelIdx((i) => Math.min(i + 1, 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setCreateSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            setCreateMethod(createSelIdx === 0 ? 'qwen' : 'manual');
            setCreateStep(3);
            setCreateSelIdx(0);
            setInputFocused(true);
          }
          return;
        }

        // Steps 3-5 (manual: name, prompt, description) require text input
        if (createMethod === 'manual' && createStep >= 3 && createStep <= 5) {
          // Focus should be on input, but if not, focus it
          setInputFocused(true);
          return;
        }

        // qwen description step (text input)
        if (createMethod === 'qwen' && createStep === 3) {
          setInputFocused(true);
          return;
        }

        // Tool selection
        if (createStep === createToolsStep) {
          const total = toolCategories.length;
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setCreateSelIdx((i) => Math.min(i + 1, total - 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setCreateSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            setCreateTools(toolCategories[createSelIdx]?.tools ?? []);
            setCreateStep((s) => s + 1);
            setCreateSelIdx(0);
          }
          return;
        }

        // Color selection
        if (createStep === createColorStep) {
          const total = COLOR_OPTIONS.length;
          if (e.key === 'ArrowDown' || e.key === 'j') {
            claim();
            setCreateSelIdx((i) => Math.min(i + 1, total - 1));
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            claim();
            setCreateSelIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' || e.key === ' ') {
            claim();
            setCreateColor(COLOR_OPTIONS[createSelIdx]!.value);
            setCreateStep((s) => s + 1);
            setCreateSelIdx(0);
          }
          return;
        }

        // Final confirmation step
        const isFinalStep =
          (createMethod === 'manual' && createStep === createTotalSteps) ||
          (createMethod === 'qwen' && createStep === createTotalSteps);
        if (isFinalStep) {
          if (
            e.key === 'Enter' ||
            e.key === ' ' ||
            e.key === 's' ||
            e.key === 'e'
          ) {
            claim();
            if (!busy) handleCreateSave();
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    closed,
    inputFocused,
    topMode,
    mode,
    menuIdx,
    manageStack,
    manageStep,
    flatAgents,
    selectedAgentIdx,
    manageSelIdx,
    busy,
    createGenerating,
    createStep,
    createSelIdx,
    createMethod,
    createScope,
    createTotalSteps,
    createToolsStep,
    createColorStep,
    toolCategories,
    handleClose,
    managePush,
    managePop,
    handleDelete,
    handleUpdateColor,
    handleUpdateTools,
    handleCreateSave,
    selectedAgent?.tools,
  ]);

  // ── Text input key handler ──
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

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent, field: 'name' | 'desc' | 'prompt') => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
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
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setInputFocused(false);
        setCreateStep((s) => s - 1);
        setCreateSelIdx(0);
      }
    },
    [createName, createDesc, createPrompt, createMethod, handleGenerateAgent],
  );

  // ── Render ──

  if (closed) {
    return (
      <div className={`${styles.panel} ${styles.closed}`}>
        <div className={styles.closedText}>{t('agents.closed')}</div>
      </div>
    );
  }

  if (loading && agents.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.titleLine}>
          <span className={styles.icon}>?</span>
          <span className={styles.title}>{t('agents.title')}</span>
        </div>
        <div className={styles.loading}>{t('common.loading')}</div>
      </div>
    );
  }

  const activeAgentName = flatAgents[selectedAgentIdx]?.name ?? '';
  const titleColor =
    topMode === 'manage' && manageStep === 'agent-viewer'
      ? displayAgentColor(selectedAgent?.color)
      : undefined;
  const panelTitle =
    topMode === 'manage'
      ? manageStep === 'agent-selection'
        ? t('agents.title')
        : manageStep === 'action-selection'
          ? t('agent.chooseActionTitle')
          : manageStep === 'agent-viewer'
            ? activeAgentName
            : manageStep === 'edit-options'
              ? t('agent.editTitle', { name: activeAgentName })
              : manageStep === 'edit-tools'
                ? t('agent.edit.tools')
                : manageStep === 'edit-color'
                  ? t('agent.editColorTitle', { name: activeAgentName })
                  : t('agent.delete.title', { name: activeAgentName })
      : t('agents.title');

  return (
    <div className={styles.panel}>
      {topMode !== 'create' && (
        <div className={styles.titleLine}>
          <span className={styles.icon}>?</span>
          <span className={styles.title} style={{ color: titleColor }}>
            {panelTitle}
          </span>
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
          step={manageStep}
          agents={flatAgents}
          agentGroups={agentGroups}
          selectedAgentIdx={selectedAgentIdx}
          selectedAgent={selectedAgent}
          selIdx={manageSelIdx}
          busy={busy}
          toolCategories={toolCategories}
          onSelectAgent={(idx) => {
            setSelectedAgentIdx(idx);
            managePush('action-selection');
          }}
          onHoverAgent={setSelectedAgentIdx}
          onSelectAction={(action) => {
            if (action === 'view') managePush('agent-viewer');
            else if (action === 'edit') managePush('edit-options');
            else if (action === 'delete') managePush('delete-confirmation');
            else if (action === 'back') managePop();
          }}
          onHoverAction={setManageSelIdx}
          onSelectEditOption={(opt) => {
            if (opt === 'tools') {
              managePush('edit-tools');
              setManageSelIdx(
                resolveToolCategoryIndex(toolCategories, selectedAgent?.tools),
              );
            } else if (opt === 'color') managePush('edit-color');
            else if (opt === 'back') managePop();
          }}
          onSelectTools={(tools) => {
            if (!busy) handleUpdateTools(tools);
          }}
          onSelectColor={(color) => {
            if (!busy) handleUpdateColor(color);
          }}
          onHoverColor={setManageSelIdx}
          t={t}
        />
      )}

      {/* ── Create ── */}
      {topMode === 'create' && (
        <CreateView
          step={createStep}
          totalSteps={createTotalSteps}
          method={createMethod}
          scope={createScope}
          name={createName}
          desc={createDesc}
          prompt={createPrompt}
          color={createColor}
          tools={createTools}
          toolCategories={toolCategories}
          selIdx={createSelIdx}
          busy={busy}
          generating={createGenerating}
          inputFocused={inputFocused}
          onSetName={setCreateName}
          onSetDesc={setCreateDesc}
          onSetPrompt={setCreatePrompt}
          onInputKeyDown={handleInputKeyDown}
          onInputFocus={() => setInputFocused(true)}
          onInputBlur={() => setInputFocused(false)}
          onSelectLocation={(idx) => {
            setCreateSelIdx(idx);
            setCreateScope(idx === 0 ? 'workspace' : 'global');
            setCreateStep(2);
            setCreateSelIdx(0);
          }}
          onHoverLocation={setCreateSelIdx}
          onSelectMethod={(idx) => {
            setCreateSelIdx(idx);
            setCreateMethod(idx === 0 ? 'qwen' : 'manual');
            setCreateStep(3);
            setCreateSelIdx(0);
            setInputFocused(true);
          }}
          onHoverMethod={setCreateSelIdx}
          onSelectTools={(idx) => {
            setCreateTools(toolCategories[idx]?.tools ?? []);
            setCreateStep((s) => s + 1);
            setCreateSelIdx(0);
          }}
          onHoverTools={setCreateSelIdx}
          onSelectColor={(idx) => {
            setCreateColor(COLOR_OPTIONS[idx]!.value);
            setCreateStep((s) => s + 1);
            setCreateSelIdx(0);
          }}
          onHoverColor={setCreateSelIdx}
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
  colorDot,
  numbered = false,
  onClick,
  onHover,
}: {
  idx: number;
  active: boolean;
  label: string;
  desc?: string;
  badge?: string;
  colorDot?: string;
  numbered?: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <div
      className={`${styles.option} ${active ? styles.optionActive : ''}`}
      onClick={onClick}
      onMouseEnter={onHover}
    >
      <span className={styles.pointer}>{active ? '›' : ' '}</span>
      <span className={styles.optionContent}>
        <span className={styles.optionLabel}>
          {numbered ? `${idx + 1}. ` : ''}
          {colorDot && (
            <span
              className={styles.colorDot}
              style={{
                backgroundColor: colorDot === 'auto' ? '#888' : colorDot,
              }}
            />
          )}
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
  step,
  agents,
  agentGroups,
  selectedAgentIdx,
  selectedAgent,
  selIdx,
  busy,
  toolCategories,
  onSelectAgent,
  onHoverAgent,
  onSelectAction,
  onHoverAction,
  onSelectEditOption,
  onSelectTools,
  onSelectColor,
  onHoverColor,
  t,
}: {
  step: ManageStep;
  agents: DaemonWorkspaceAgentSummary[];
  agentGroups: {
    project: DaemonWorkspaceAgentSummary[];
    user: DaemonWorkspaceAgentSummary[];
    builtin: DaemonWorkspaceAgentSummary[];
    extension: DaemonWorkspaceAgentSummary[];
  };
  selectedAgentIdx: number;
  selectedAgent: DaemonWorkspaceAgentDetail | null;
  selIdx: number;
  busy: boolean;
  toolCategories: ToolCategory[];
  onSelectAgent: (idx: number) => void;
  onHoverAgent: (idx: number) => void;
  onSelectAction: (action: string) => void;
  onHoverAction: (idx: number) => void;
  onSelectEditOption: (opt: string) => void;
  onSelectTools: (tools: string[]) => void;
  onSelectColor: (color: string) => void;
  onHoverColor: (idx: number) => void;
  t: ReturnType<typeof useI18n>['t'];
}) {
  if (step === 'agent-selection') {
    if (agents.length === 0) {
      return (
        <>
          <div className={styles.text}>{t('agent.empty')}</div>
          <div className={styles.text}>{t('agent.createFirstHint')}</div>
          <div className={styles.footer}>{t('agent.footer.close')}</div>
        </>
      );
    }

    let globalIdx = 0;
    const projectNames = new Set(
      agentGroups.project.map((agent) => agent.name),
    );
    const renderGroup = (
      label: string,
      list: DaemonWorkspaceAgentSummary[],
    ) => {
      if (list.length === 0) return null;
      const start = globalIdx;
      globalIdx += list.length;
      return (
        <div key={label}>
          <div className={styles.groupLabel}>{label}</div>
          <div className={styles.options}>
            {list.map((agent, i) => (
              <OptionItem
                key={`${agent.level}:${agent.name}`}
                idx={start + i}
                active={selectedAgentIdx === start + i}
                label={agent.name}
                colorDot={displayAgentColor(agent.color)}
                badge={
                  agent.isBuiltin
                    ? t('agent.builtInBadge')
                    : agent.level === 'user' && projectNames.has(agent.name)
                      ? t('agent.overriddenBadge')
                      : undefined
                }
                onClick={() => onSelectAgent(start + i)}
                onHover={() => onHoverAgent(start + i)}
              />
            ))}
          </div>
        </div>
      );
    };

    return (
      <>
        {renderGroup(t('agent.level.project'), agentGroups.project)}
        {renderGroup(t('agent.level.user'), agentGroups.user)}
        {renderGroup(t('agent.level.builtin'), agentGroups.builtin)}
        {renderGroup(t('agent.level.extension'), agentGroups.extension)}
        <div className={styles.agentCount}>
          {t('agent.usingCount', {
            count:
              agentGroups.project.length +
              agentGroups.user.filter((agent) => !projectNames.has(agent.name))
                .length +
              agentGroups.builtin.length +
              agentGroups.extension.length,
          })}
        </div>
        <div className={styles.footer}>{t('agent.footer.cliSelect')}</div>
      </>
    );
  }

  if (step === 'action-selection') {
    const agent = agents[selectedAgentIdx];
    const isReadOnly = agent ? !canModifyAgent(agent) : true;
    const actions = isReadOnly
      ? [
          { id: 'view', label: t('agent.action.view') },
          { id: 'back', label: t('agent.back') },
        ]
      : [
          { id: 'view', label: t('agent.action.view') },
          { id: 'edit', label: t('agent.action.edit') },
          { id: 'delete', label: t('agent.action.delete') },
          { id: 'back', label: t('agent.back') },
        ];

    return (
      <>
        <div className={styles.options}>
          {actions.map((action, i) => (
            <OptionItem
              key={action.id}
              idx={i}
              active={selIdx === i}
              label={action.label}
              onClick={() => onSelectAction(action.id)}
              onHover={() => onHoverAction(i)}
            />
          ))}
        </div>
        <div className={styles.footer}>{t('agent.footer.cliBack')}</div>
      </>
    );
  }

  if (step === 'agent-viewer') {
    return (
      <>
        {selectedAgent ? (
          <div className={styles.viewer}>
            <div className={styles.viewerRow}>
              <span className={styles.viewerLabel}>
                {t('agent.filePathLabel')}
              </span>
              <span>{selectedAgent.filePath || ''}</span>
            </div>
            <div className={styles.viewerRow}>
              <span className={styles.viewerLabel}>
                {t('agent.toolsLabel')}
              </span>
              <span>
                {selectedAgent.tools && selectedAgent.tools.length > 0
                  ? selectedAgent.tools.join(', ')
                  : '*'}
              </span>
            </div>
            {selectedAgent.model && (
              <div className={styles.viewerRow}>
                <span className={styles.viewerLabel}>
                  {t('agent.modelLabel')}
                </span>
                <span>{selectedAgent.model}</span>
              </div>
            )}
            {selectedAgent.color && selectedAgent.color !== 'auto' && (
              <div className={styles.viewerRow}>
                <span className={styles.viewerLabel}>
                  {t('agent.colorLabel')}
                </span>
                <span style={{ color: selectedAgent.color }}>
                  {selectedAgent.color}
                </span>
              </div>
            )}
            <div className={styles.viewerSectionTitle}>
              {t('agent.descriptionLabel')}
            </div>
            <div className={styles.viewerBlock}>
              {selectedAgent.description}
            </div>
            <div className={styles.viewerSectionTitle}>
              {t('agent.systemPromptLabel')}
            </div>
            <div className={styles.viewerBlock}>
              {selectedAgent.systemPrompt}
            </div>
          </div>
        ) : (
          <div className={styles.loading}>{t('common.loading')}</div>
        )}
        <div className={styles.footer}>{t('agent.footer.viewerBack')}</div>
      </>
    );
  }

  if (step === 'edit-options') {
    const editActions = [
      { id: 'tools', label: t('agent.edit.tools') },
      { id: 'color', label: t('agent.edit.color') },
      { id: 'back', label: t('agent.back') },
    ];

    return (
      <>
        <div className={styles.options}>
          {editActions.map((action, i) => (
            <OptionItem
              key={action.id}
              idx={i}
              active={selIdx === i}
              label={action.label}
              onClick={() => onSelectEditOption(action.id)}
              onHover={() => onHoverAction(i)}
            />
          ))}
        </div>
        <div className={styles.footer}>{t('agent.footer.cliBack')}</div>
      </>
    );
  }

  if (step === 'edit-tools') {
    const selectedCategory = toolCategories[selIdx] ?? toolCategories[0];
    const selectedToolList = selectedCategory?.tools ?? [];
    const selectedReadTools = selectedToolList.filter(isReadTool);
    const selectedEditTools = selectedToolList.filter(isEditTool);
    const selectedExecuteTools = selectedToolList.filter(isExecuteTool);
    return (
      <>
        <div className={styles.options}>
          {toolCategories.map((category, i) => (
            <OptionItem
              key={category.id}
              idx={i}
              active={selIdx === i}
              label={category.label}
              numbered
              onClick={() => onSelectTools(category.tools)}
              onHover={() => onHoverAction(i)}
            />
          ))}
        </div>
        <div className={styles.toolDetail}>
          {selectedCategory?.id === 'all' ? (
            <div className={styles.toolDetailBody}>
              {t('agent.create.tools.allInfo')}
            </div>
          ) : (
            <>
              <div className={styles.toolDetailTitle}>
                {t('agent.create.tools.selected')}
              </div>
              <div className={styles.toolList}>
                {selectedToolList.length === 0 ? (
                  t('agent.create.tools.none')
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
        <div className={styles.footer}>{t('agent.footer.cliBack')}</div>
      </>
    );
  }

  if (step === 'edit-color') {
    return (
      <>
        <div className={styles.options}>
          {COLOR_OPTIONS.map((color, i) => (
            <OptionItem
              key={color.id}
              idx={i}
              active={selIdx === i}
              label={color.name}
              colorDot={color.value}
              onClick={() => onSelectColor(color.value)}
              onHover={() => onHoverColor(i)}
            />
          ))}
        </div>
        <div className={styles.footer}>{t('agent.footer.cliBack')}</div>
      </>
    );
  }

  if (step === 'delete-confirmation') {
    const agent = agents[selectedAgentIdx];
    return (
      <>
        <div className={styles.text}>
          {busy
            ? t('agent.delete.loading')
            : t('agent.delete.confirm', { name: agent?.name ?? '' })}
        </div>
        <div className={styles.footer}>{t('agent.footer.deleteConfirm')}</div>
      </>
    );
  }

  return null;
}

// ── Create View ───────────────────────────────────────────────────

function CreateView({
  step,
  totalSteps,
  method,
  scope,
  name,
  desc,
  prompt,
  color,
  tools,
  toolCategories,
  selIdx,
  busy,
  generating,
  inputFocused,
  onSetName,
  onSetDesc,
  onSetPrompt,
  onInputKeyDown,
  onInputFocus,
  onInputBlur,
  onSelectLocation,
  onHoverLocation,
  onSelectMethod,
  onHoverMethod,
  onSelectTools,
  onHoverTools,
  onSelectColor,
  onHoverColor,
  onSave,
  t,
}: {
  step: number;
  totalSteps: number;
  method: 'manual' | 'qwen';
  scope: 'workspace' | 'global';
  name: string;
  desc: string;
  prompt: string;
  color: string;
  tools: string[];
  toolCategories: ToolCategory[];
  selIdx: number;
  busy: boolean;
  generating: boolean;
  inputFocused: boolean;
  onSetName: (v: string) => void;
  onSetDesc: (v: string) => void;
  onSetPrompt: (v: string) => void;
  onInputKeyDown: (
    e: React.KeyboardEvent,
    field: 'name' | 'desc' | 'prompt',
  ) => void;
  onInputFocus: () => void;
  onInputBlur: () => void;
  onSelectLocation: (idx: number) => void;
  onHoverLocation: (idx: number) => void;
  onSelectMethod: (idx: number) => void;
  onHoverMethod: (idx: number) => void;
  onSelectTools: (idx: number) => void;
  onHoverTools: (idx: number) => void;
  onSelectColor: (idx: number) => void;
  onHoverColor: (idx: number) => void;
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

  const stepTitle = (title: string) =>
    `${t('agent.step', { n: step })}: ${title}`;

  // Step 1: Location
  if (step === 1) {
    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.location'))}
        </div>
        <div className={styles.options}>
          <OptionItem
            idx={0}
            active={selIdx === 0}
            label={t('agent.create.project.cli')}
            numbered
            onClick={() => onSelectLocation(0)}
            onHover={() => onHoverLocation(0)}
          />
          <OptionItem
            idx={1}
            active={selIdx === 1}
            label={t('agent.create.user.cli')}
            numbered
            onClick={() => onSelectLocation(1)}
            onHover={() => onHoverLocation(1)}
          />
        </div>
        <div className={styles.footer}>{t('agent.footer.createLocation')}</div>
      </>
    );
  }

  // Step 2: Generation method
  if (step === 2) {
    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.method'))}
        </div>
        <div className={styles.options}>
          <OptionItem
            idx={0}
            active={selIdx === 0}
            label={t('agent.create.method.qwen.recommended')}
            numbered
            onClick={() => onSelectMethod(0)}
            onHover={() => onHoverMethod(0)}
          />
          <OptionItem
            idx={1}
            active={selIdx === 1}
            label={t('agent.create.method.manual')}
            numbered
            onClick={() => onSelectMethod(1)}
            onHover={() => onHoverMethod(1)}
          />
        </div>
        <div className={styles.footer}>{t('agent.footer.createContinue')}</div>
      </>
    );
  }

  // Manual step 3: name
  if (method === 'manual' && step === 3) {
    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.enterName'))}
        </div>
        <div className={styles.text}>{t('agent.create.nameHelp')}</div>
        <input
          ref={nameRef}
          className={styles.textInput}
          value={name}
          onChange={(e) => onSetName(e.target.value)}
          onKeyDown={(e) => onInputKeyDown(e, 'name')}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('agent.create.namePlaceholder')}
          autoFocus
        />
        <div className={styles.footer}>{t('agent.footer.enterNext')}</div>
      </>
    );
  }

  // Manual step 4: prompt
  if (method === 'manual' && step === 4) {
    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.enterPrompt'))}
        </div>
        <div className={styles.text}>{t('agent.create.promptHelp')}</div>
        <textarea
          ref={promptRef}
          className={styles.textArea}
          value={prompt}
          onChange={(e) => onSetPrompt(e.target.value)}
          onKeyDown={(e) => onInputKeyDown(e, 'prompt')}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('agent.create.promptPlaceholder.cli')}
          autoFocus
        />
        <div className={styles.footer}>{t('agent.footer.enterNext')}</div>
      </>
    );
  }

  // Manual step 5: description
  if (method === 'manual' && step === 5) {
    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.enterDescription'))}
        </div>
        <div className={styles.text}>{t('agent.create.manualDescHelp')}</div>
        <textarea
          ref={descRef}
          className={styles.textArea}
          value={desc}
          onChange={(e) => onSetDesc(e.target.value)}
          onKeyDown={(e) => onInputKeyDown(e, 'desc')}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('agent.create.manualDescPlaceholder')}
          autoFocus
        />
        <div className={styles.footer}>{t('agent.footer.enterNext')}</div>
      </>
    );
  }

  // Qwen description step
  if (method === 'qwen' && step === 3) {
    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.describeAgent'))}
        </div>
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
              onKeyDown={(e) => onInputKeyDown(e, 'desc')}
              onFocus={onInputFocus}
              onBlur={onInputBlur}
              placeholder={t('agent.create.qwenPlaceholder')}
              autoFocus
            />
            <div className={styles.footer}>{t('agent.footer.enterNext')}</div>
          </>
        )}
      </>
    );
  }

  // Tool step (manual: 6, qwen: 4)
  const toolsStep = method === 'manual' ? 6 : 4;
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

    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.toolsSelection'))}
        </div>
        <div className={styles.options}>
          {toolCategories.map((category, i) => (
            <OptionItem
              key={category.id}
              idx={i}
              active={selIdx === i}
              label={category.label}
              numbered
              onClick={() => onSelectTools(i)}
              onHover={() => onHoverTools(i)}
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
        <div className={styles.footer}>{t('agent.footer.createContinue')}</div>
      </>
    );
  }

  // Color step (manual: 7, qwen: 5)
  const colorStep = method === 'manual' ? 7 : 5;
  if (step === colorStep) {
    const previewColor = COLOR_OPTIONS[selIdx]?.value ?? 'auto';
    const previewName = name || t('agent.label');
    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.colorSelection'))}
        </div>
        <div className={styles.options}>
          {COLOR_OPTIONS.map((c, i) => (
            <OptionItem
              key={c.id}
              idx={i}
              active={selIdx === i}
              label={c.name}
              colorDot={c.value}
              numbered
              onClick={() => onSelectColor(i)}
              onHover={() => onHoverColor(i)}
            />
          ))}
        </div>
        <div className={styles.colorPreview}>
          <span>{t('agent.create.preview')}:</span>
          <span
            style={{
              color:
                previewColor === 'auto' ? 'var(--text-primary)' : previewColor,
            }}
          >
            {' '}
            {previewName}{' '}
          </span>
        </div>
        <div className={styles.footer}>{t('agent.footer.createContinue')}</div>
      </>
    );
  }

  // Final confirmation
  if (step === totalSteps) {
    const colorName =
      COLOR_OPTIONS.find((c) => c.value === color)?.name ?? color;
    const toolsDisplay = tools.length === 0 ? '*' : tools.join(', ');

    return (
      <>
        <div className={styles.stepHeader}>
          {stepTitle(t('agent.create.confirm'))}
        </div>
        <div className={styles.summary}>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>
              {t('agent.create.name')}:
            </span>
            <span className={styles.summaryValue}>{name || '—'}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>{t('agent.location')}:</span>
            <span className={styles.summaryValue}>
              {scope === 'workspace'
                ? t('agent.create.project.cli')
                : t('agent.create.user.cli')}
            </span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>{t('agent.toolsLabel')}</span>
            <span className={styles.summaryValue}>{toolsDisplay}</span>
          </div>
          {color !== 'auto' && (
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>
                {t('agent.create.colorSelection')}:
              </span>
              <span className={styles.summaryValue}>{colorName}</span>
            </div>
          )}
          <div className={styles.summaryBlockTitle}>
            {t('agent.descriptionLabel')}
          </div>
          <div className={styles.summaryBlock}>{desc || '—'}</div>
          <div className={styles.summaryBlockTitle}>
            {t('agent.systemPromptLabel')}
          </div>
          <div className={styles.summaryBlock}>{prompt || '—'}</div>
        </div>
        <button
          type="button"
          className={styles.hiddenAction}
          onClick={onSave}
          disabled={busy}
        >
          {busy ? t('agent.create.loading') : t('agent.create.save')}
        </button>
        <div className={styles.footer}>{t('agent.footer.final')}</div>
      </>
    );
  }

  return null;
}
