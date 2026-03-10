/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { SettingScope } from '../../config/settings.js';
import { TextInput } from './shared/TextInput.js';
import { Colors } from '../colors.js';
import { t } from '../../i18n/index.js';
import type {
  PermissionManager,
  RuleWithSource,
  RuleType,
} from '@qwen-code/qwen-code-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'allow' | 'ask' | 'deny' | 'workspace';

interface Tab {
  id: TabId;
  label: string;
  description: string;
}

/** Internal views for the dialog state machine. */
type DialogView =
  | 'rule-list' // main rule list view
  | 'add-rule-input' // text input for new rule
  | 'add-rule-scope' // scope selector after entering a rule
  | 'delete-confirm'; // confirm rule deletion

// ---------------------------------------------------------------------------
// Scope items (matches Claude Code screenshot layout)
// ---------------------------------------------------------------------------

interface PermScopeItem {
  label: string;
  description: string;
  value: SettingScope;
  key: string;
}

function getPermScopeItems(): PermScopeItem[] {
  return [
    {
      label: t('Project settings'),
      description: t('Checked in at .qwen/settings.json'),
      value: SettingScope.Workspace,
      key: 'project',
    },
    {
      label: t('User settings'),
      description: t('Saved in at ~/.qwen/settings.json'),
      value: SettingScope.User,
      key: 'user',
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTabs(): Tab[] {
  return [
    {
      id: 'allow',
      label: t('Allow'),
      description: t("Qwen Code won't ask before using allowed tools."),
    },
    {
      id: 'ask',
      label: t('Ask'),
      description: t('Qwen Code will ask before using these tools.'),
    },
    {
      id: 'deny',
      label: t('Deny'),
      description: t('Qwen Code is not allowed to use denied tools.'),
    },
    {
      id: 'workspace',
      label: t('Workspace'),
      description: t('Manage trusted directories for this workspace.'),
    },
  ];
}

function describeRule(raw: string): string {
  const match = raw.match(/^([^(]+?)(?:\((.+)\))?$/);
  if (!match) return raw;
  const toolName = match[1]!.trim();
  const specifier = match[2]?.trim();
  if (!specifier) {
    return t('Any use of the {{tool}} tool', { tool: toolName });
  }
  return t("{{tool}} commands matching '{{pattern}}'", {
    tool: toolName,
    pattern: specifier,
  });
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case 'user':
      return t('From user settings');
    case 'workspace':
      return t('From project settings');
    case 'session':
      return t('From session');
    default:
      return scope;
  }
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

interface PermissionsDialogProps {
  onExit: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PermissionsDialog({
  onExit,
}: PermissionsDialogProps): React.JSX.Element {
  const config = useConfig();
  const settings = useSettings();
  const pm = config.getPermissionManager?.() as PermissionManager | null;

  // --- Tab state ---
  const tabs = useMemo(() => getTabs(), []);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const activeTab = tabs[activeTabIndex]!;

  // --- Rule list state ---
  const [allRules, setAllRules] = useState<RuleWithSource[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchActive, setIsSearchActive] = useState(false);

  // --- Dialog view state machine ---
  const [view, setView] = useState<DialogView>('rule-list');
  const [newRuleInput, setNewRuleInput] = useState('');
  const [pendingRuleText, setPendingRuleText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RuleWithSource | null>(null);

  // Refresh rules from PermissionManager
  const refreshRules = useCallback(() => {
    if (pm) {
      setAllRules(pm.listRules());
    }
  }, [pm]);

  useEffect(() => {
    refreshRules();
  }, [refreshRules]);

  // Filter rules for current tab
  const currentTabRules = useMemo(() => {
    if (activeTab.id === 'workspace') return [];
    return allRules.filter((r) => r.type === activeTab.id);
  }, [allRules, activeTab.id]);

  // Search-filtered rules
  const filteredRules = useMemo(() => {
    if (!searchQuery.trim()) return currentTabRules;
    const q = searchQuery.toLowerCase();
    return currentTabRules.filter(
      (r) =>
        r.rule.raw.toLowerCase().includes(q) ||
        r.rule.toolName.toLowerCase().includes(q),
    );
  }, [currentTabRules, searchQuery]);

  // Build radio items: "Add a new rule..." + filtered rules
  const listItems = useMemo(() => {
    const items: Array<{
      label: string;
      value: string;
      key: string;
    }> = [
      {
        label: t('Add a new rule…'),
        value: '__add__',
        key: '__add__',
      },
    ];
    for (const r of filteredRules) {
      items.push({
        label: `${r.rule.raw}`,
        value: r.rule.raw,
        key: `${r.type}-${r.scope}-${r.rule.raw}`,
      });
    }
    return items;
  }, [filteredRules]);

  // --- Action handlers ---

  const handleTabCycle = useCallback(
    (direction: 1 | -1) => {
      setActiveTabIndex(
        (prev) => (prev + direction + tabs.length) % tabs.length,
      );
      setSearchQuery('');
      setIsSearchActive(false);
    },
    [tabs.length],
  );

  const handleListSelect = useCallback(
    (value: string) => {
      if (value === '__add__') {
        setNewRuleInput('');
        setView('add-rule-input');
        return;
      }
      // Selecting an existing rule → offer to delete
      const found = filteredRules.find((r) => r.rule.raw === value);
      if (found) {
        setDeleteTarget(found);
        setView('delete-confirm');
      }
    },
    [filteredRules],
  );

  const handleAddRuleSubmit = useCallback(() => {
    const trimmed = newRuleInput.trim();
    if (!trimmed) return;
    setPendingRuleText(trimmed);
    setView('add-rule-scope');
  }, [newRuleInput]);

  const handleScopeSelect = useCallback(
    (scope: SettingScope) => {
      if (!pm || activeTab.id === 'workspace') return;
      const ruleType = activeTab.id as RuleType;

      // Add to PermissionManager in-memory
      pm.addPersistentRule(pendingRuleText, ruleType);

      // Persist to settings file (with dedup)
      const key = `permissions.${ruleType}`;
      const perms = (settings.merged as Record<string, unknown>)[
        'permissions'
      ] as Record<string, string[]> | undefined;
      const currentRules = perms?.[ruleType] ?? [];
      if (!currentRules.includes(pendingRuleText)) {
        settings.setValue(scope, key, [...currentRules, pendingRuleText]);
      }

      // Refresh and go back
      refreshRules();
      setView('rule-list');
      setPendingRuleText('');
    },
    [pm, activeTab.id, pendingRuleText, settings, refreshRules],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!pm || !deleteTarget) return;
    const ruleType = deleteTarget.type;

    // Remove from PermissionManager in-memory
    pm.removePersistentRule(deleteTarget.rule.raw, ruleType);

    // Persist removal — find and remove from settings
    // We try both User and Workspace scopes
    for (const scope of [SettingScope.User, SettingScope.Workspace]) {
      const scopeSettings = settings.forScope(scope).settings;
      const perms = (scopeSettings as Record<string, unknown>)[
        'permissions'
      ] as Record<string, string[]> | undefined;
      const scopeRules = perms?.[ruleType];
      if (scopeRules?.includes(deleteTarget.rule.raw)) {
        const updated = scopeRules.filter(
          (r: string) => r !== deleteTarget.rule.raw,
        );
        settings.setValue(scope, `permissions.${ruleType}`, updated);
        break;
      }
    }

    refreshRules();
    setDeleteTarget(null);
    setView('rule-list');
  }, [pm, deleteTarget, settings, refreshRules]);

  // --- Keypress handling ---

  useKeypress(
    (key) => {
      if (view === 'rule-list') {
        if (key.name === 'escape') {
          if (isSearchActive && searchQuery) {
            setSearchQuery('');
            setIsSearchActive(false);
          } else {
            onExit();
          }
          return;
        }
        if (key.name === 'tab') {
          handleTabCycle(1);
          return;
        }
        if (key.name === 'right' || key.name === 'left') {
          handleTabCycle(key.name === 'right' ? 1 : -1);
          return;
        }
        // Search input: backspace
        if (key.name === 'backspace' || key.name === 'delete') {
          if (searchQuery.length > 0) {
            setSearchQuery((prev) => prev.slice(0, -1));
          }
          return;
        }
        // Search input: printable characters
        if (
          key.sequence &&
          !key.ctrl &&
          !key.meta &&
          key.sequence.length === 1 &&
          key.sequence >= ' '
        ) {
          setSearchQuery((prev) => prev + key.sequence);
          setIsSearchActive(true);
          return;
        }
      }
      if (view === 'add-rule-input') {
        if (key.name === 'escape') {
          setView('rule-list');
          return;
        }
      }
      if (view === 'add-rule-scope') {
        if (key.name === 'escape') {
          setView('add-rule-input');
          return;
        }
      }
      if (view === 'delete-confirm') {
        if (key.name === 'escape') {
          setDeleteTarget(null);
          setView('rule-list');
          return;
        }
        if (key.name === 'return') {
          handleDeleteConfirm();
          return;
        }
      }
    },
    { isActive: true },
  );

  // --- Workspace tab placeholder ---
  if (activeTab.id === 'workspace') {
    return (
      <Box flexDirection="column">
        <TabBar tabs={tabs} activeIndex={activeTabIndex} />
        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          flexDirection="column"
          padding={1}
        >
          <Text color={theme.text.secondary}>
            {t(
              'Use /trust to manage folder trust settings for this workspace.',
            )}
          </Text>
        </Box>
        <FooterHint view={view} />
      </Box>
    );
  }

  // --- Render views ---

  if (view === 'add-rule-input') {
    return (
      <Box flexDirection="column">
        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          flexDirection="column"
          padding={1}
        >
          <Text bold>
            {t('Add {{type}} permission rule', { type: activeTab.id })}
          </Text>
          <Box height={1} />
          <Text wrap="wrap">
            {t(
              'Permission rules are a tool name, optionally followed by a specifier in parentheses.',
            )}
          </Text>
          <Text>
            {t('e.g.,')} <Text bold>WebFetch</Text> {t('or')}{' '}
            <Text bold>Bash(ls:*)</Text>
          </Text>
          <Box height={1} />
          <Box
            borderStyle="round"
            borderColor={theme.border.default}
            paddingLeft={1}
            paddingRight={1}
          >
            <TextInput
              value={newRuleInput}
              onChange={setNewRuleInput}
              onSubmit={handleAddRuleSubmit}
              placeholder={t('Enter permission rule…')}
              isActive={true}
            />
          </Box>
        </Box>
        <Box marginTop={1} marginLeft={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to submit · Esc to cancel')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (view === 'add-rule-scope') {
    const scopeItems = getPermScopeItems();
    return (
      <Box flexDirection="column">
        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          flexDirection="column"
          padding={1}
        >
          <Text bold>
            {t('Add {{type}} permission rule', { type: activeTab.id })}
          </Text>
          <Box height={1} />
          <Box marginLeft={2} flexDirection="column">
            <Text bold>{pendingRuleText}</Text>
            <Text color={theme.text.secondary}>
              {describeRule(pendingRuleText)}
            </Text>
          </Box>
          <Box height={1} />
          <Text>{t('Where should this rule be saved?')}</Text>
          <RadioButtonSelect
            items={scopeItems.map((s) => ({
              label: `${s.label}    ${s.description}`,
              value: s.value,
              key: s.key,
            }))}
            onSelect={handleScopeSelect}
            isFocused={true}
            showNumbers={true}
          />
        </Box>
        <Box marginTop={1} marginLeft={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to confirm · Esc to cancel')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (view === 'delete-confirm' && deleteTarget) {
    return (
      <Box flexDirection="column">
        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          flexDirection="column"
          padding={1}
        >
          <Text bold>
            {t('Delete {{type}} rule?', { type: deleteTarget.type })}
          </Text>
          <Box height={1} />
          <Box marginLeft={2} flexDirection="column">
            <Text bold>{deleteTarget.rule.raw}</Text>
            <Text color={theme.text.secondary}>
              {describeRule(deleteTarget.rule.raw)}
            </Text>
            <Text color={theme.text.secondary}>
              {scopeLabel(deleteTarget.scope)}
            </Text>
          </Box>
          <Box height={1} />
          <Text>
            {t('Are you sure you want to delete this permission rule?')}
          </Text>
        </Box>
        <Box marginTop={1} marginLeft={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to confirm · Esc to cancel')}
          </Text>
        </Box>
      </Box>
    );
  }

  // --- Default: rule-list view ---

  return (
    <Box flexDirection="column">
      <TabBar tabs={tabs} activeIndex={activeTabIndex} />
      <Text>{activeTab.description}</Text>
      {/* Search box */}
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        paddingLeft={1}
        paddingRight={1}
        width={60}
      >
        <Text color={theme.text.accent}>{'> '}</Text>
        {searchQuery ? (
          <Text>{searchQuery}</Text>
        ) : (
          <Text color={Colors.Gray}>{t('Search…')}</Text>
        )}
      </Box>
      <Box height={1} />
      {/* Rule list */}
      <RadioButtonSelect
        items={listItems}
        onSelect={handleListSelect}
        isFocused={view === 'rule-list'}
        showNumbers={true}
        showScrollArrows={false}
        maxItemsToShow={15}
      />
      <FooterHint view={view} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabBar({
  tabs,
  activeIndex,
}: {
  tabs: Tab[];
  activeIndex: number;
}): React.JSX.Element {
  return (
    <Box marginBottom={1}>
      <Text color={theme.text.accent} bold>
        {t('Permissions:')}{' '}
      </Text>
      {tabs.map((tab, i) => (
        <Box key={tab.id} marginRight={2}>
          {i === activeIndex ? (
            <Text
              bold
              backgroundColor={theme.text.accent}
              color={theme.background.primary}
            >
              {` ${tab.label} `}
            </Text>
          ) : (
            <Text color={theme.text.secondary}>{` ${tab.label} `}</Text>
          )}
        </Box>
      ))}
      <Text color={theme.text.secondary}>{t('(←/→ or tab to cycle)')}</Text>
    </Box>
  );
}

function FooterHint({ view }: { view: DialogView }): React.JSX.Element {
  if (view !== 'rule-list') return <></>;
  return (
    <Box marginTop={1}>
      <Text color={theme.text.secondary}>
        {t(
          'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel',
        )}
      </Text>
    </Box>
  );
}
