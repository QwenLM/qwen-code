/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { BaseTabDialog, type TabItem } from '../shared/BaseTabDialog.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from '../shared/SettingsListPanel.js';
import { type ToolDefinition } from '../../types.js';

interface ToolsListProps {
  tools: readonly ToolDefinition[];
  onClose?: () => void;
}

/** Tool category key. */
type ToolCategory = 'builtin' | 'mcp';

/** Human-readable labels for each category. */
const CATEGORY_LABELS: Record<ToolCategory, string> = {
  builtin: 'Built-in',
  mcp: 'MCP',
};

/** Display order for categories. */
const ORDERED_CATEGORIES: ToolCategory[] = ['builtin', 'mcp'];

const ALL_CATEGORY_VALUES = new Set<string>(ORDERED_CATEGORIES);

const MAX_ITEMS_TO_SHOW = 10;

/**
 * ToolsList — Full-screen tool listing using SettingsListPanel.
 *
 * Renders all registered tools grouped by category (Built-in / MCP)
 * in a tabbed dialog. Each tool is displayed as a read-only list item
 * with its description shown directly below the tool name.
 *
 * Uses BaseTabDialog + SettingsListPanel for consistent UI patterns.
 * ESC closes the view.
 */
export const ToolsList: React.FC<ToolsListProps> = ({ tools, onClose }) => {
  // Categorize tools
  const { categoryCounts, initialTab } = useMemo(() => {
    const counts = new Map<ToolCategory, number>();
    for (const cat of ORDERED_CATEGORIES) {
      counts.set(cat, 0);
    }
    for (const tool of tools) {
      const cat: ToolCategory = tool.serverName ? 'mcp' : 'builtin';
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }

    // Pick the first non-empty tab in display order
    let first: ToolCategory = 'builtin';
    for (const cat of ORDERED_CATEGORIES) {
      if ((counts.get(cat) ?? 0) > 0) {
        first = cat;
        break;
      }
    }
    return { categoryCounts: counts, initialTab: first };
  }, [tools]);

  const [activeTab, setActiveTab] = useState<ToolCategory>(initialTab);

  // Build tabs (only show tabs that have tools)
  const tabs: TabItem[] = useMemo(
    () =>
      ORDERED_CATEGORIES.filter(
        (cat) => (categoryCounts.get(cat) ?? 0) > 0,
      ).map((cat) => ({
        key: cat,
        label: `${CATEGORY_LABELS[cat]} (${categoryCounts.get(cat) ?? 0})`,
      })),
    [categoryCounts],
  );

  // Filter and sort tools for active tab
  const filteredTools = useMemo(
    () =>
      tools
        .filter((tool) => {
          const cat: ToolCategory = tool.serverName ? 'mcp' : 'builtin';
          return cat === activeTab;
        })
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [tools, activeTab],
  );

  // Max tools across all tabs for stable layout height
  const maxToolsAcrossTabs = useMemo(() => {
    let max = 0;
    for (const count of categoryCounts.values()) {
      if (count > max) max = count;
    }
    return max;
  }, [categoryCounts]);

  // Convert tools to SettingsDialogItem[]
  const listItems: SettingsDialogItem[] = useMemo(
    () =>
      filteredTools.map((tool) => ({
        key: tool.name,
        label: tool.displayName,
        description: tool.description || undefined,
        type: 'string' as const,
        displayValue: tool.serverName
          ? `[${tool.serverName}] ${tool.name}`
          : tool.name,
        isGreyedOut: true,
      })),
    [filteredTools],
  );

  const handleClose = onClose ?? (() => {});

  // No-op handlers for read-only mode
  const noopToggle = (_key: string, _item: SettingsDialogItem) => {};
  const noopEdit = (
    _key: string,
    _val: string,
    _item: SettingsDialogItem,
  ) => {};
  const noopClear = (_key: string, _item: SettingsDialogItem) => {};

  if (tools.length === 0) {
    return (
      <BaseTabDialog title="Tools" onClose={handleClose}>
        <Text color={theme.text.primary}> No tools available.</Text>
      </BaseTabDialog>
    );
  }

  return (
    <BaseTabDialog
      title="Tools"
      tabs={tabs}
      activeKey={activeTab}
      onTabChange={(key: string) => {
        if (ALL_CATEGORY_VALUES.has(key)) {
          setActiveTab(key as ToolCategory);
        }
      }}
      isActive={true}
      showSeparator={true}
      showContent={true}
      onClose={handleClose}
    >
      <SettingsListPanel
        searchEnabled={true}
        searchPlaceholder="Search tools"
        items={listItems}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        minItemSlots={maxToolsAcrossTabs}
        itemHeight={2}
        readOnly={true}
        onItemToggle={noopToggle}
        onEditCommit={noopEdit}
        onItemClear={noopClear}
        onClose={handleClose}
      />
    </BaseTabDialog>
  );
};
