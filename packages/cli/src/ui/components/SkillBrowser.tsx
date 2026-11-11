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
import type { Config, ConfigLoadError } from '@qwen-code/core';
import {
  Storage,
  CONFIG_DIR,
  getUserConfigDisplayPath,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { enableSkill, disableSkill } from '../../utils/skillSettings.js';
import { getScopeForAgentSource } from '../../utils/scopeUtils.js';
import { SKILL_SOURCE_LABELS } from '../../utils/skillUtils.js';
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

export type SkillSourceTabKey = 'project' | 'user' | 'built-in' | 'plugin';

export interface SkillDisplayInfo {
  name: string;
  displayName?: string;
  description: string;
  enabled: boolean;
  isBuiltin?: boolean;
  pluginName?: string;
  location: string;
  source: SkillSourceTabKey;
  model?: string;
  /** When set, this skill is shadowed by a higher-priority skill from the given source. */
  shadowedBy?: SkillSourceTabKey;
  /**
   * Locations of same-named skills this one superseded during discovery
   * (both same-source dedup and cross-source shadowing land here). Exposed
   * by the detail view as "Also defined at:".
   */
  alsoDefinedAt?: string[];
}

export interface SkillBrowserProps {
  config: Config;
  settings: LoadedSettings;
  onOpenConfig: (skill: SkillDisplayInfo) => void;
  onCreateSkill?: (prompt: string) => void;
  onExit: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ITEMS_TO_SHOW = 8;

// Bottom detail bar: 1 blank separator row + 1 line carrying either a transient
// status message or the focused skill's description.
const LIST_FOOTER_HEIGHT = 2;
const CREATE_SKILL_KEY = '__create_new_skill__';

/** Scope metadata for skill creation */
const SCOPE_META: Record<'project' | 'user', { label: string; path: string }> =
  {
    project: { label: 'project', path: `${CONFIG_DIR}/skills/` },
    user: { label: 'user', path: `${getUserConfigDisplayPath('skills')}/` },
  };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inferSkillSource(skill: {
  source?: string;
  isBuiltin?: boolean;
  pluginName?: string;
  location: string;
}): SkillSourceTabKey {
  // Prefer the explicit source field tagged by SkillManager
  if (
    skill.source === 'built-in' ||
    skill.source === 'user' ||
    skill.source === 'project' ||
    skill.source === 'plugin'
  ) {
    return skill.source;
  }

  // Fallback heuristic for skills loaded before source tagging
  if (skill.isBuiltin) return 'built-in';
  if (skill.pluginName) return 'plugin';

  const userDirs = [
    Storage.getUserSkillsDir(),
    Storage.getUserCommandsDir(),
    Storage.getUserAgentSkillsDir(),
  ];
  if (userDirs.some((dir) => skill.location.startsWith(dir))) return 'user';
  return 'project';
}

function loadSkillDisplayInfo(config: Config): SkillDisplayInfo[] {
  const skillManager = config.getSkillManager();
  if (!skillManager) return [];

  // Use getAllDiscoveredSkills() to include shadowed duplicates,
  // but filter out unactivated conditional skills (those with `paths`
  // that haven't been triggered yet). Aligns with upstream: conditional
  // skills are invisible until a matching file is touched.
  const allDiscovered = skillManager
    .getAllDiscoveredSkills()
    .filter((s) => skillManager.isConditionallyVisible(s));

  // Build a map of active skills (the winning skill for each name)
  const activeSkills = new Map<
    string,
    { location: string; source: SkillSourceTabKey }
  >();
  for (const skill of skillManager.getAllSkills()) {
    activeSkills.set(skill.name, {
      location: skill.location,
      source: skill.source
        ? (skill.source as SkillSourceTabKey)
        : inferSkillSource(skill),
    });
  }

  return allDiscovered.map((skill) => {
    const source = skill.source
      ? (skill.source as SkillSourceTabKey)
      : inferSkillSource(skill);
    const active = activeSkills.get(skill.name);
    // Shadowed if there's an active skill with a different location
    const isShadowed = active != null && active.location !== skill.location;

    return {
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      enabled: isShadowed ? false : !skill.disabled,
      isBuiltin: skill.isBuiltin,
      pluginName: skill.pluginName,
      location: skill.location,
      source,
      model: skill.model,
      shadowedBy: isShadowed ? active.source : undefined,
      alsoDefinedAt: skill.alsoDefinedAt,
    };
  });
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function SkillBrowser({
  config,
  settings,
  onOpenConfig,
  onCreateSkill,
  onExit,
}: SkillBrowserProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const { columns: terminalWidth } = useTerminalSize();
  const { openConfigErrorDetail } = useUIActions();

  const [skills, setSkills] = useState<SkillDisplayInfo[]>([]);
  const [settingsNonce, setSettingsNonce] = useState(0);
  const [activeSourceTab, setActiveSourceTab] =
    useState<SkillSourceTabKey>('project');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Create skill input mode
  const [isCreateMode, setIsCreateMode] = useState(false);
  const createQueryBuffer = useTextBuffer({
    initialText: '',
    initialCursorOffset: 0,
    viewport: { width: Math.max(20, terminalWidth - 12), height: 5 },
  });

  useEffect(() => {
    const data = loadSkillDisplayInfo(config);
    setSkills(data);
  }, [config, settingsNonce]);

  // Collect skill load errors from the manager (must be above sourceTabs so counts include errors)
  /* eslint-disable react-hooks/exhaustive-deps -- settingsNonce intentionally triggers re-read */
  const skillErrors: readonly ConfigLoadError[] = useMemo(
    () => config.getSkillManager()?.getLoadErrors() ?? [],
    [config, settingsNonce],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  // Single-pass derivation: source tabs, filtered skills, and max cross-tab count
  const { sourceTabs, filteredSkills, maxSkillsAcrossTabs } = useMemo(() => {
    const counts = { project: 0, user: 0, 'built-in': 0, plugin: 0 };
    const filtered: SkillDisplayInfo[] = [];
    for (const s of skills) {
      counts[s.source]++;
      if (s.source === activeSourceTab) filtered.push(s);
    }
    // Include fatal error items in tab counts (not warnings — those attach to normal items)
    for (const err of skillErrors) {
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
      tabs.push({
        key: 'plugin',
        label: `Plugin (${counts.plugin})`,
      });
    }

    return {
      sourceTabs: tabs,
      filteredSkills: filtered,
      maxSkillsAcrossTabs: Math.max(
        counts.project,
        counts.user,
        counts['built-in'],
        counts.plugin,
      ),
    };
  }, [skills, activeSourceTab, skillErrors]);

  const skillItems: SettingsDialogItem[] = useMemo(() => {
    const warningsByName = buildWarningsByName(skillErrors);

    const items: SettingsDialogItem[] = filteredSkills.map((skill) => {
      const tagStr = skill.shadowedBy
        ? ` [shadowed by ${SKILL_SOURCE_LABELS[skill.shadowedBy] ?? skill.shadowedBy}]`
        : '';
      const statusStr = skill.shadowedBy
        ? '◌ shadowed'
        : skill.enabled
          ? `${figures.bullet} enabled`
          : `${figures.circle} disabled`;
      const hasWarning = warningsByName.has(skill.name);
      const warningTag = hasWarning ? ' ⚠' : '';
      const displayBase = skill.displayName || skill.name;
      const label = skill.model
        ? `${displayBase} · ${skill.model}`
        : displayBase;

      return {
        key: `${skill.name}:${skill.source}:${skill.location}`,
        label,
        description: skill.description || undefined,
        type: 'boolean' as const,
        displayValue: `${statusStr}${tagStr}${warningTag}`,
        isGreyedOut: !skill.enabled || !!skill.shadowedBy,
        isWarning: hasWarning,
        rawValue: skill.enabled && !skill.shadowedBy,
      };
    });

    // Append fatal load-error items (not warnings) for the active source tab
    items.push(
      ...buildErrorListItems(
        skillErrors,
        activeSourceTab,
        (source) => (source as SkillSourceTabKey) ?? 'built-in',
      ),
    );

    // Add "+ New Skill" entry for project and user tabs
    if (activeSourceTab === 'project' || activeSourceTab === 'user') {
      const scopeMeta = SCOPE_META[activeSourceTab];
      const scopeLabel =
        activeSourceTab === 'project' ? 'Project Skill' : 'User Skill';
      items.unshift({
        key: CREATE_SKILL_KEY,
        label:
          activeSourceTab === 'project'
            ? `[+] New ${scopeLabel} (this project only)`
            : `[+] New ${scopeLabel} (all projects on this machine)`,
        description: `Create a new skill · saved to ${scopeMeta.path}`,
        type: 'boolean' as const,
        displayValue: '',
        isGreyedOut: false,
        rawValue: false,
      });
    }

    return items;
  }, [filteredSkills, activeSourceTab, skillErrors]);

  // ─── List Operations ─────────────────────────────────────────────────────

  const findSkillByKey = useCallback(
    (key: string) =>
      filteredSkills.find((s) => `${s.name}:${s.source}:${s.location}` === key),
    [filteredSkills],
  );

  const handleItemToggle = useCallback(
    async (key: string, _item: SettingsDialogItem) => {
      if (key === CREATE_SKILL_KEY) return;
      // Plugin skills are read-only — toggle disabled
      if (activeSourceTab === 'plugin') {
        setStatusMessage('Plugin skills cannot be toggled individually.');
        return;
      }
      const skill = findSkillByKey(key);
      if (!skill || skill.shadowedBy) return;
      const scope = getScopeForAgentSource(skill.source);
      const result = skill.enabled
        ? disableSkill(settings, skill.name, scope)
        : enableSkill(settings, skill.name, scope);
      if (result.status === 'error') return;
      await config.reloadSkills();
      setSettingsNonce((n) => n + 1);
    },
    [findSkillByKey, config, settings, activeSourceTab],
  );

  const handleItemClear = useCallback(
    (_key: string, _item: SettingsDialogItem) => {
      // No-op for skill list
    },
    [],
  );

  const handleEditCommit = useCallback(
    (_key: string, _newValue: string, _item: SettingsDialogItem) => {
      // No-op for skill list - boolean items use toggle, not edit
    },
    [],
  );

  const openSkillConfig = useCallback(
    (key: string) => {
      const skill = findSkillByKey(key);
      if (!skill) return;
      onOpenConfig(skill);
    },
    [findSkillByKey, onOpenConfig],
  );

  const handleListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        if (currentItem.key === CREATE_SKILL_KEY) {
          setIsCreateMode(true);
          return true;
        }
        // Open error detail view for load-error items
        if (
          handleErrorItemKeyPress(
            currentItem.key,
            skillErrors,
            openConfigErrorDetail,
            'skill',
          )
        ) {
          return true;
        }
        openSkillConfig(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, openSkillConfig, skillErrors, openConfigErrorDetail],
  );

  const listExtraHints = useMemo(
    (): ShortcutHint[] => [{ label: SHORTCUT_HINTS.ENTER_DETAILS, order: 30 }],
    [],
  );

  const exitCreateMode = useCallback(() => {
    setIsCreateMode(false);
    createQueryBuffer.setText('');
  }, [createQueryBuffer]);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (skills.length === 0) {
    return (
      <BaseTabDialog title="Skills" onClose={onExit}>
        <Text color={Colors.Gray}>No skills available.</Text>
      </BaseTabDialog>
    );
  }

  // ─── Create Mode (input skill description) ─────────────────────────────────

  if (isCreateMode) {
    const scopeKey = activeSourceTab === 'project' ? 'project' : 'user';
    const { label: scopeLabel, path: scopePath } = SCOPE_META[scopeKey];
    const scopeTitle = scopeKey === 'project' ? 'Project' : 'User';

    return (
      <BaseTabDialog
        title={`Skills > New ${scopeTitle} Skill`}
        onClose={exitCreateMode}
        extraHints={[{ label: SHORTCUT_HINTS.SUBMIT, order: 10 }]}
      >
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={theme.status.success} bold>
              Describe the skill you want to create:
            </Text>
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
                const prompt = `/skill-creator Create a new ${scopeLabel}-level skill (in ${scopePath}).\n\nUser requirement: ${value.trim()}`;
                onCreateSkill?.(prompt);
              }}
              onCancel={exitCreateMode}
              placeholder="e.g. A data analysis skill that processes CSV files..."
            />
          </Box>
        </Box>
      </BaseTabDialog>
    );
  }

  // ─── List View (SettingsListPanel with source tabs) ────────────────────────

  return (
    <BaseTabDialog
      title="Skills"
      tabs={sourceTabs}
      activeKey={activeSourceTab}
      onTabChange={(key: string) => {
        setStatusMessage(null);
        if (
          key === 'project' ||
          key === 'user' ||
          key === 'built-in' ||
          key === 'plugin'
        ) {
          setActiveSourceTab(key);
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
            ? 'Search project skills'
            : activeSourceTab === 'user'
              ? 'Search user skills'
              : 'Search skills'
        }
        items={skillItems}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        minItemSlots={maxSkillsAcrossTabs}
        itemHeight={1}
        valueAlign="left"
        onItemToggle={(key, item) => {
          handleItemToggle(key, item).catch(() => {});
        }}
        onEditCommit={handleEditCommit}
        onItemClear={handleItemClear}
        onClose={onExit}
        onKeyPress={handleListKeyPress}
        reservedFooterHeight={LIST_FOOTER_HEIGHT}
        footer={{
          height: LIST_FOOTER_HEIGHT,
          content: (currentItem) => (
            <Box marginTop={1}>
              <Text color={theme.text.secondary} wrap="truncate-end">
                {statusMessage ?? currentItem?.description ?? ''}
              </Text>
            </Box>
          ),
        }}
      />
    </BaseTabDialog>
  );
}
