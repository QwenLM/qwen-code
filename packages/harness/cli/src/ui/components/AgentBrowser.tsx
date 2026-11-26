/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { theme } from '../semantic-colors.js';
import { SelectionText } from './SelectionText.js';
import type { Config, AgentSource, ConfigLoadError } from '@qwen-code/core';
import {
  CONFIG_DIR,
  getDisplayString,
  coreEvents,
  CoreEvent,
  runLogger,
  getUserConfigDisplayPath,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { enableAgent, disableAgent } from '../../utils/agentSettings.js';
import { getScopeForAgentSource } from '../../utils/scopeUtils.js';
import { AGENT_SOURCE_LABELS } from '../../utils/agentUtils.js';
import { figures } from '../utils/figures.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from './shared/SettingsListPanel.js';
import { BaseTabDialog, type TabItem } from './shared/BaseTabDialog.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { Command } from '../key/keyMatchers.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import type { Key } from '../hooks/useKeypress.js';
import { InputField } from './shared/InputField.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import {
  buildWarningsByName,
  buildErrorListItems,
  handleErrorItemKeyPress,
} from './shared/configErrorItems.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentDisplayInfo {
  name: string;
  description: string;
  enabled: boolean;
  experimental: boolean;
  filePath?: string; // only set for file-based agents (deletable)
  source?: AgentSource;
  modelId?: string;
  modelLabel?: string;
  /** When set, this agent is shadowed by a higher-priority agent from the given source. */
  shadowedBy?: AgentSource;
}

export interface AgentBrowserProps {
  config: Config;
  settings: LoadedSettings;
  activeSourceTab: SourceTabKey;
  onSourceTabChange: (tab: SourceTabKey) => void;
  onOpenConfig: (
    name: string,
    definition: import('@qwen-code/core').AgentDefinition,
  ) => void;
  onCreateAgent?: (prompt: string) => void;
  onExit: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export type SourceTabKey = 'project' | 'user' | 'built-in' | 'plugin' | 'flag';

const MAX_ITEMS_TO_SHOW = 8;
const CREATE_AGENT_KEY = '__create_new_agent__';

/** Scope metadata for agent creation */
const SCOPE_META: Record<'project' | 'user', { label: string; path: string }> =
  {
    project: { label: 'project', path: `${CONFIG_DIR}/agents/` },
    user: { label: 'user', path: `${getUserConfigDisplayPath('agents')}/` },
  };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadAgentDisplayInfo(
  config: Config,
  _settings: LoadedSettings,
): AgentDisplayInfo[] {
  const agentRegistry = config.getAgentRegistry();
  if (!agentRegistry) return [];

  const enabledNames = new Set(agentRegistry.getAllAgentNames());
  const allDefs = agentRegistry.getAllDiscoveredDefinitions();

  return allDefs.map((def) => {
    const source = def.metadata?.source;
    // Check if this definition is shadowed by a higher-priority same-name agent
    const activeAgent = agentRegistry.getDefinition(def.name);
    const isShadowed =
      activeAgent != null && activeAgent.metadata?.source !== source;

    const effectiveDef = activeAgent ?? def;
    return {
      name: def.name,
      description: def.description || '',
      enabled: enabledNames.has(def.name) && !isShadowed,
      experimental: def.experimental === true,
      filePath: def.metadata?.filePath,
      source,
      modelId: effectiveDef.modelConfig?.model,
      shadowedBy: isShadowed
        ? (activeAgent.metadata?.source ?? 'built-in')
        : undefined,
    };
  });
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function AgentBrowser({
  config,
  settings,
  activeSourceTab,
  onSourceTabChange,
  onOpenConfig,
  onCreateAgent,
  onExit,
}: AgentBrowserProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const { columns: terminalWidth } = useTerminalSize();
  const { openConfigErrorDetail } = useUIActions();

  // Global state
  const [agents, setAgents] = useState<AgentDisplayInfo[]>([]);
  const [settingsNonce, setSettingsNonce] = useState(0);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Create agent input mode
  const [isCreateMode, setIsCreateMode] = useState(false);
  const createQueryBuffer = useTextBuffer({
    initialText: '',
    initialCursorOffset: 0,
    viewport: { width: Math.max(20, terminalWidth - 12), height: 5 },
  });

  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const currentModel = config.getModel();
  // Load agents
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const load = async () => {
      const request = ++revision;
      const data = loadAgentDisplayInfo(config, settings);
      const resolved = await Promise.all(
        data.map(async (agent) => {
          if (!agent.modelId) return agent;
          let listed;
          try {
            listed = await config
              .getModelProviderManager()
              .getModel(agent.modelId);
          } catch (error) {
            runLogger.debug('[agents] 模型展示查询失败:', error);
          }
          return {
            ...agent,
            modelLabel: getDisplayString(listed, agent.modelId),
          };
        }),
      );
      if (
        !disposed &&
        request === revision &&
        identity === config.getModelRequestIdentity() &&
        sessionId === config.getSessionId() &&
        currentModel === config.getModel()
      )
        setAgents(resolved);
    };
    const onModelChanged = (event: { sessionId: string }) => {
      if (event.sessionId === sessionId) void load();
    };
    void load();
    coreEvents.on(CoreEvent.ModelChanged, onModelChanged);
    coreEvents.on(CoreEvent.ModelInfoChanged, load);
    return () => {
      disposed = true;
      coreEvents.off(CoreEvent.ModelChanged, onModelChanged);
      coreEvents.off(CoreEvent.ModelInfoChanged, load);
    };
  }, [config, settings, settingsNonce, identity, sessionId, currentModel]);

  // Collect agent load errors from the registry (must be above sourceTabs so counts include errors)
  /* eslint-disable react-hooks/exhaustive-deps -- settingsNonce intentionally triggers re-read */
  const agentErrors: readonly ConfigLoadError[] = useMemo(
    () => config.getAgentRegistry()?.getLoadErrors() ?? [],
    [config, settingsNonce],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  const sourceTabs: TabItem[] = useMemo(() => {
    const counts = {
      project: agents.filter((a) => a.source === 'project').length,
      user: agents.filter((a) => a.source === 'user').length,
      'built-in': agents.filter((a) => a.source === 'built-in' || !a.source)
        .length,
      plugin: agents.filter((a) => a.source === 'plugin').length,
      flag: agents.filter((a) => a.source === 'flag').length,
    };
    // Include fatal error items in tab counts (not warnings — those attach to normal items)
    for (const err of agentErrors) {
      if (err.severity === 'warning') continue;
      const errSource = (err.source ?? 'built-in') as keyof typeof counts;
      if (errSource in counts) counts[errSource]++;
    }
    const tabs: TabItem[] = [
      { key: 'project', label: `Project (${counts.project})` },
      { key: 'user', label: `User (${counts.user})` },
      { key: 'built-in', label: `Built-in (${counts['built-in']})` },
    ];
    if (counts.plugin > 0) {
      tabs.push({ key: 'plugin', label: `Plugin (${counts.plugin})` });
    }
    if (counts.flag > 0) {
      tabs.unshift({ key: 'flag', label: `Flag (${counts.flag})` });
    }
    return tabs;
  }, [agents, agentErrors]);

  useEffect(() => {
    const validKeys = sourceTabs.map((tab) => tab.key);
    if (!validKeys.includes(activeSourceTab)) {
      onSourceTabChange('project');
    }
  }, [sourceTabs, activeSourceTab, onSourceTabChange]);

  // Filter by source tab (search filtering is handled internally by SLP)
  const filteredAgents = useMemo(
    () =>
      agents.filter((a) => {
        if (activeSourceTab === 'built-in') {
          return a.source === 'built-in' || !a.source;
        }
        return a.source === activeSourceTab;
      }),
    [agents, activeSourceTab],
  );

  // Stable cross-tab item slot count for layout height stabilization.
  // This is the max number of agents in any single source tab, so the
  // container height stays constant when switching between tabs.
  const maxAgentsAcrossTabs = useMemo(() => {
    let projectCount = 0;
    let userCount = 0;
    let builtInCount = 0;
    let pluginCount = 0;
    let flagCount = 0;
    for (const a of agents) {
      if (a.source === 'project') projectCount++;
      else if (a.source === 'user') userCount++;
      else if (a.source === 'plugin') pluginCount++;
      else if (a.source === 'flag') flagCount++;
      else builtInCount++;
    }
    return Math.max(
      projectCount,
      userCount,
      builtInCount,
      pluginCount,
      flagCount,
    );
  }, [agents]);

  // Convert agents to SettingsDialogItem[] for SettingsListPanel
  const agentItems: SettingsDialogItem[] = useMemo(() => {
    const warningsByName = buildWarningsByName(agentErrors);

    const items: SettingsDialogItem[] = filteredAgents.map((agent) => {
      const tags: string[] = [];
      if (agent.experimental) tags.push('experimental');
      if (agent.shadowedBy) {
        const shadowLabel =
          AGENT_SOURCE_LABELS[agent.shadowedBy] ?? agent.shadowedBy;
        tags.push(`shadowed by ${shadowLabel}`);
      }
      const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
      const hasWarning = warningsByName.has(agent.name);
      const warningTag = hasWarning ? ' ⚠' : '';
      const statusStr = agent.shadowedBy
        ? '◌ shadowed'
        : agent.enabled
          ? `${figures.bullet} enabled`
          : `${figures.circle} disabled`;

      const description = agent.description || '';
      const modelLabel = agent.modelLabel;
      const label = modelLabel ? `${agent.name} · ${modelLabel}` : agent.name;

      return {
        key: `${agent.name}:${agent.source ?? 'built-in'}`,
        label,
        description: description || undefined,
        type: 'boolean' as const,
        displayValue: `${statusStr}${tagStr}${warningTag}`,
        isGreyedOut: !agent.enabled || !!agent.shadowedBy,
        rawValue: agent.enabled && !agent.shadowedBy,
      };
    });

    // Append fatal load-error items (not warnings) for the active source tab
    items.push(
      ...buildErrorListItems(agentErrors, activeSourceTab, (source) => {
        const s = source ?? 'built-in';
        return s === 'built-in' || !s ? 'built-in' : s;
      }),
    );

    // Add "+ New Agent" entry for project and user tabs
    if (activeSourceTab === 'project' || activeSourceTab === 'user') {
      const scopeMeta = SCOPE_META[activeSourceTab];
      const scopeLabel =
        activeSourceTab === 'project' ? 'Project Agent' : 'User Agent';
      items.unshift({
        key: CREATE_AGENT_KEY,
        label:
          activeSourceTab === 'project'
            ? `[+] New ${scopeLabel} (this project only)`
            : `[+] New ${scopeLabel} (all projects on this machine)`,
        description: `Create a new agent · saved to ${scopeMeta.path}`,
        type: 'boolean' as const,
        displayValue: '',
        isGreyedOut: false,
        rawValue: false,
      });
    }

    return items;
  }, [filteredAgents, activeSourceTab, agentErrors]);

  // ─── List Operations (via SettingsListPanel callbacks) ────────────────────

  /** Extract agent name from composite key `name:source`. */
  const findAgentByKey = useCallback(
    (key: string) =>
      filteredAgents.find((a) => `${a.name}:${a.source ?? 'built-in'}` === key),
    [filteredAgents],
  );

  const handleItemToggle = useCallback(
    async (key: string, _item: SettingsDialogItem) => {
      if (key === CREATE_AGENT_KEY) return;
      // Plugin and --agents definitions are runtime-owned and read-only.
      if (activeSourceTab === 'plugin' || activeSourceTab === 'flag') {
        setStatusMessage(
          activeSourceTab === 'flag'
            ? 'Agents provided by --agents are read-only.'
            : 'Plugin agents cannot be toggled individually.',
        );
        return;
      }
      const agent = findAgentByKey(key);
      if (!agent || agent.shadowedBy) return;
      const agentRegistry = config.getAgentRegistry();
      if (!agentRegistry) return;
      const scope = getScopeForAgentSource(agent.source);
      const result = agent.enabled
        ? disableAgent(settings, agent.name, scope)
        : enableAgent(settings, agent.name, scope);
      if (result.status === 'error') return;
      await agentRegistry.reload();
      setSettingsNonce((n) => n + 1);
    },
    [findAgentByKey, config, settings, activeSourceTab],
  );

  const handleItemClear = useCallback(
    (_key: string, _item: SettingsDialogItem) => {
      // No-op for agent list - agents don't have a "clear/reset" concept
    },
    [],
  );

  const handleEditCommit = useCallback(
    (_key: string, _newValue: string, _item: SettingsDialogItem) => {
      // No-op for agent list - boolean items use toggle, not edit
    },
    [],
  );

  // Open agent config dialog via parent callback
  const openAgentConfig = useCallback(
    (key: string) => {
      const agent = findAgentByKey(key);
      if (!agent) return;
      const reg = config.getAgentRegistry();
      if (!reg) return;
      // Look up by name + source to avoid returning a same-name definition
      // from a different source (e.g., project overwriting built-in in the Map).
      const allDefs = reg.getAllDiscoveredDefinitions();
      const definition =
        allDefs.find(
          (d) => d.name === agent.name && d.metadata?.source === agent.source,
        ) ?? reg.getDiscoveredDefinition(agent.name);
      if (!definition) return;
      onOpenConfig(agent.name, definition);
    },
    [findAgentByKey, config, onOpenConfig],
  );

  // Custom key handler for list view: Enter opens config dialog or create mode
  const handleListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        if (currentItem.key === CREATE_AGENT_KEY) {
          setIsCreateMode(true);
          return true;
        }
        // Open error detail view for load-error items
        if (
          handleErrorItemKeyPress(
            currentItem.key,
            agentErrors,
            openConfigErrorDetail,
            'agent',
          )
        ) {
          return true;
        }
        openAgentConfig(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, openAgentConfig, agentErrors, openConfigErrorDetail],
  );

  // Extra hints for capabilities handled by the SettingsListPanel
  // that are not auto-registered (↑↓ navigate is auto-registered by SLP).
  const listExtraHints = useMemo(
    (): ShortcutHint[] => [{ label: SHORTCUT_HINTS.ENTER_DETAILS, order: 30 }],
    [],
  );

  const exitCreateMode = useCallback(() => {
    setIsCreateMode(false);
    createQueryBuffer.setText('');
  }, [createQueryBuffer]);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (agents.length === 0) {
    return (
      <BaseTabDialog title="Agents" onClose={onExit}>
        <Text color={Colors.Gray}>No agents available.</Text>
      </BaseTabDialog>
    );
  }

  // ─── Create Mode (input agent description) ─────────────────────────────────

  if (isCreateMode) {
    const scopeKey = activeSourceTab === 'project' ? 'project' : 'user';
    const { label: scopeLabel, path: scopePath } = SCOPE_META[scopeKey];
    const scopeTitle = scopeKey === 'project' ? 'Project' : 'User';

    return (
      <BaseTabDialog
        title={`Agents > New ${scopeTitle} Agent`}
        onClose={exitCreateMode}
        extraHints={[{ label: SHORTCUT_HINTS.SUBMIT, order: 10 }]}
      >
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <SelectionText bold>
              Describe the agent you want to create:
            </SelectionText>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.text.secondary}>
              Scope: {scopeLabel} ({scopePath})
            </Text>
          </Box>
          <Box height={7} flexDirection="column">
            <InputField
              buffer={createQueryBuffer}
              onSubmit={(value: string) => {
                if (!value.trim()) return;
                const prompt = `/agent-creator Create a new ${scopeLabel}-level agent (in ${scopePath}).\n\nUser requirement: ${value.trim()}`;
                onCreateAgent?.(prompt);
              }}
              onCancel={exitCreateMode}
              placeholder="e.g. A code reviewer that checks for security issues..."
            />
          </Box>
        </Box>
      </BaseTabDialog>
    );
  }

  // ─── List View (SettingsListPanel with source tabs) ────────────────────────
  return (
    <BaseTabDialog
      title="Agents"
      tabs={sourceTabs}
      activeKey={activeSourceTab}
      onTabChange={(key: string) => {
        setStatusMessage(null);
        if (
          key === 'project' ||
          key === 'user' ||
          key === 'built-in' ||
          key === 'plugin' ||
          key === 'flag'
        ) {
          onSourceTabChange(key);
        }
      }}
      isActive={true}
      showSeparator={true}
      showContent={true}
      onClose={onExit}
      extraHints={listExtraHints}
    >
      <SettingsListPanel
        searchEnabled={true}
        searchPlaceholder={
          activeSourceTab === 'project'
            ? 'Search project agents'
            : activeSourceTab === 'user'
              ? 'Search user agents'
              : 'Search agents'
        }
        items={agentItems}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        minItemSlots={maxAgentsAcrossTabs}
        itemHeight={3}
        onItemToggle={(key, item) => {
          handleItemToggle(key, item).catch(() => {});
        }}
        onEditCommit={handleEditCommit}
        onItemClear={handleItemClear}
        onClose={onExit}
        onKeyPress={handleListKeyPress}
        footer={
          statusMessage
            ? {
                content: (
                  <Box>
                    <Text color={theme.text.secondary}>{statusMessage}</Text>
                  </Box>
                ),
                height: 1,
              }
            : undefined
        }
      />
    </BaseTabDialog>
  );
}
