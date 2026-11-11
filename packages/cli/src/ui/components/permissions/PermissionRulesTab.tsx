/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo, useCallback } from 'react';
import { Box, Text } from 'ink';
import {
  type PermissionRule,
  type PermissionRuleSource,
  type PermissionRules,
  permissionRuleValueToString,
  getAllowRules,
  getDenyRules,
  getAskRules,
  BRAND_CLI_NAME,
} from '@qwen-code/core';
import { RadioButtonSelect } from '../shared/RadioButtonSelect.js';
import type { RadioSelectItem } from '../shared/RadioButtonSelect.js';
import type { RenderItemContext } from '../shared/BaseSelectionList.js';
import { InputField } from '../shared/InputField.js';
import { useSearchBuffer } from '../../hooks/useSearchBuffer.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { theme } from '../../semantic-colors.js';
import { formatScopeTag, isReadOnlySource } from '../../utils/scopeTag.js';
import { figures } from '../../utils/figures.js';

// ── Types ────────────────────────────────────────────────────────────────────

type TabBehavior = 'allow' | 'ask' | 'deny';

interface PermissionRulesTabProps {
  tab: TabBehavior;
  allRules: PermissionRules;
  onSelectRule: (rule: PermissionRule) => void;
  onAddNewRule: (tab: TabBehavior) => void;
  onCancel: () => void;
  isFocused: boolean;
  /** Key of the rule to focus after deletion (for cursor restoration) */
  lastFocusedRuleKey?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TAB_DESCRIPTION_BUILDERS: Record<TabBehavior, () => string> = {
  allow: () => `${BRAND_CLI_NAME} won't ask before using allowed tools.`,
  ask: () =>
    `${BRAND_CLI_NAME} will always ask for confirmation before using these tools.`,
  deny: () =>
    `${BRAND_CLI_NAME} will always reject requests to use denied tools.`,
};

const getTabDescription = (tab: TabBehavior): string =>
  TAB_DESCRIPTION_BUILDERS[tab]();

const ADD_NEW_RULE_KEY = '__add-new-rule__';

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Content component for the Allow / Ask / Deny tabs in the /permissions dialog.
 *
 * Displays:
 * 1. A description of the tab's behavior
 * 2. A search/filter input (always visible, activates on typing or '/')
 * 3. A selectable list with "Add a new rule…" at the top, followed by
 *    alphabetically sorted permission rules
 */
export function PermissionRulesTab({
  tab,
  allRules,
  onSelectRule,
  onAddNewRule,
  onCancel: _onCancel,
  isFocused,
  lastFocusedRuleKey,
}: PermissionRulesTabProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const searchBuffer = useSearchBuffer({
    initialText: '',
    onChange: useCallback((text: string) => {
      setSearchQuery(text);
    }, []),
  });

  // Intercept printable chars (and '/') to activate search from the list
  const handleKeyForSearch = useCallback(
    (key: Key) => {
      if (isSearchFocused) return false; // Let TextInput handle it

      // Any printable character activates search and seeds the query
      if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
        setIsSearchFocused(true);
        searchBuffer.setText(key.sequence);
        setSearchQuery(key.sequence);
        return true;
      }
      return false;
    },
    [isSearchFocused, searchBuffer],
  );

  useKeypress(handleKeyForSearch, {
    isActive: isFocused && !isSearchFocused,
  });

  // Get rules for this tab
  const rules: PermissionRule[] = useMemo(() => {
    switch (tab) {
      case 'allow':
        return getAllowRules(allRules);
      case 'deny':
        return getDenyRules(allRules);
      case 'ask':
        return getAskRules(allRules);
      default:
        return [];
    }
  }, [tab, allRules]);

  // Sort rules: source priority (high→low) first, then tool name alphabetically
  const sortedRuleItems = useMemo(() => {
    const SOURCE_PRIORITY: Record<PermissionRuleSource, number> = {
      policySettings: 0,
      cliArg: 1,
      flagSettings: 2,
      userSettings: 3,
      projectSettings: 4,
      localSettings: 5,
      command: 6,
      session: 7,
    };
    return rules
      .map((rule) => {
        const ruleString = permissionRuleValueToString(rule.ruleValue);
        return {
          key: `${ruleString}::${rule.source}`,
          label: ruleString,
          value: `${ruleString}::${rule.source}`,
          rule,
        };
      })
      .sort((a, b) => {
        const pa = SOURCE_PRIORITY[a.rule.source] ?? 99;
        const pb = SOURCE_PRIORITY[b.rule.source] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
      })
      // Deduplicate by tool name: keep only the highest-priority source.
      .filter(
        (item, _idx, arr) =>
          arr.find((candidate) => candidate.label === item.label) === item,
      );
  }, [rules]);

  const sourceByKey = useMemo(() => {
    const map = new Map<string, PermissionRuleSource>();
    for (const item of sortedRuleItems) {
      map.set(item.key, item.rule.source);
    }
    return map;
  }, [sortedRuleItems]);

  // Filter by search query (cheap operation on each keystroke)
  const items = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase();

    const filtered = searchQuery
      ? sortedRuleItems.filter((item) =>
          item.label.toLowerCase().includes(lowerQuery),
        )
      : sortedRuleItems;

    // Only show "Add a new rule…" when NOT searching
    if (!searchQuery) {
      return [
        {
          key: ADD_NEW_RULE_KEY,
          label: 'Add a new rule…',
          value: ADD_NEW_RULE_KEY,
          rule: null as PermissionRule | null,
        },
        ...filtered,
      ];
    }

    return filtered;
  }, [sortedRuleItems, searchQuery]);

  const handleSelect = useCallback(
    (value: string) => {
      if (value === ADD_NEW_RULE_KEY) {
        onAddNewRule(tab);
        return;
      }
      const item = items.find((i) => i.value === value);
      if (item?.rule) {
        onSelectRule(item.rule);
      }
    },
    [tab, items, onAddNewRule, onSelectRule],
  );

  const handleSearchCancel = useCallback(() => {
    setIsSearchFocused(false);
    setSearchQuery('');
    searchBuffer.setText('');
  }, [searchBuffer]);

  // Compute initial index for cursor restoration after deletion
  const initialIndex = useMemo(() => {
    if (!lastFocusedRuleKey) return 0;
    const idx = items.findIndex((i) => i.label === lastFocusedRuleKey);
    return idx >= 0 ? idx : 0;
  }, [items, lastFocusedRuleKey]);

  const renderItem = useCallback(
    (item: RadioSelectItem<string>, { titleColor }: RenderItemContext) => {
      if (item.value === ADD_NEW_RULE_KEY) {
        return (
          <Box>
            <Text color={titleColor} bold>
              {item.label}
            </Text>
          </Box>
        );
      }
      const source = sourceByKey.get(item.key);
      const tag = source ? formatScopeTag(source) : null;
      const readOnly = source ? isReadOnlySource(source) : false;
      const MAX_LABEL = 60;
      const displayLabel =
        item.label.length > MAX_LABEL
          ? item.label.slice(0, MAX_LABEL) + '\u2026'
          : item.label;
      return (
        <Box overflow="hidden">
          {tag && (
            <Text color={tag.color} bold>
              [{tag.label}]{' '}
            </Text>
          )}
          <Text
            color={readOnly ? theme.text.secondary : titleColor}
            dimColor={readOnly}
            wrap="truncate"
          >
            {readOnly ? `${figures.lock} ` : ''}
            {displayLabel}
          </Text>
        </Box>
      );
    },
    [sourceByKey],
  );

  return (
    <Box flexDirection="column">
      <Text color={theme.text.secondary}>{getTabDescription(tab)}</Text>

      {/* Search input — always visible, matches SettingsListPanel styling */}
      <Box marginBottom={1} flexDirection="column">
        <InputField
          buffer={searchBuffer}
          placeholder="Filter rules…"
          onCancel={handleSearchCancel}
          focus={isSearchFocused && isFocused}
        />
      </Box>

      {/* Rules list */}
      {items.length === 0 ? (
        <Text dimColor>
          {searchQuery ? 'No matching rules found.' : 'No rules configured.'}
        </Text>
      ) : (
        <RadioButtonSelect
          items={items}
          onSelect={handleSelect}
          initialIndex={initialIndex}
          isFocused={!isSearchFocused && isFocused}
          maxItemsToShow={Math.min(10, items.length)}
          showScrollArrows={true}
          renderItem={renderItem}
        />
      )}
    </Box>
  );
}
