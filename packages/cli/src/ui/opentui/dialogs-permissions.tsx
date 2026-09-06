/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink `/permissions` dialog
 * (ui/components/PermissionsDialog.tsx): the Allow/Ask/Deny/Workspace tab
 * bar, the type-to-search rule list ("Add a new rule…" first), the
 * add-rule → scope-select and delete-confirm flows, and the workspace
 * directory views (initial dirs inline, "Add directory…" entry, remove
 * confirm). Rule parsing reuses the original core `parseRule`; fs-based
 * directory validation is a pure exported helper. Mutation is the
 * backend's job — the dialog reports intents through callbacks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { SettingScope } from '../../config/settings.js';
import { isPathWithinRoot, parseRule } from '@qwen-code/qwen-code-core';
import { toOriginalKey } from './key-map.js';
import { matchesSearchQuery } from './dialogs-core.js';
import {
  DialogFrame,
  DialogSelect,
  DialogTabBar,
  FooterHint,
  useDialogSelect,
} from './dialogs-shared.js';

export type PermissionsTabId = 'allow' | 'ask' | 'deny' | 'workspace';

export interface PermissionsTabDef {
  id: PermissionsTabId;
  label: string;
  description: string;
}

/** Parity of getTabs() in PermissionsDialog.tsx. */
export function getPermissionsTabs(): PermissionsTabDef[] {
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

/** Parity of describeRule in PermissionsDialog.tsx. */
export function describePermissionRule(raw: string): string {
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

/** Parity of scopeLabel in PermissionsDialog.tsx. */
export function permissionScopeLabel(scope: string): string {
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

/** Parity of getPermScopeItems in PermissionsDialog.tsx. */
export function getPermissionScopeItems(): Array<{
  label: string;
  description: string;
  value: SettingScope;
  key: string;
}> {
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

export interface PermissionRuleEntry {
  raw: string;
  toolName: string;
  type: 'allow' | 'ask' | 'deny';
  scope: string;
}

/** The workspace-directory add validation, exactly as the ink dialog runs it. */
export function validateWorkspaceDirectory(
  input: string,
  currentDirectories: readonly string[],
): { error?: string; resolved?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: '' };

  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~/, os.homedir())
    : trimmed;
  const absoluteExpanded = nodePath.isAbsolute(expanded)
    ? expanded
    : nodePath.resolve(expanded);

  if (!fs.existsSync(absoluteExpanded)) {
    return { error: t('Directory does not exist.') };
  }
  if (!fs.statSync(absoluteExpanded).isDirectory()) {
    return { error: t('Path is not a directory.') };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(absoluteExpanded);
  } catch {
    resolved = absoluteExpanded;
  }

  if (currentDirectories.includes(resolved)) {
    return { error: t('This directory is already in the workspace.') };
  }
  for (const existingDir of currentDirectories) {
    if (isPathWithinRoot(resolved, existingDir)) {
      return {
        error: t('Already covered by existing directory: {{dir}}', {
          dir: existingDir,
        }),
      };
    }
  }
  return { resolved };
}

type PermissionsView =
  | 'rule-list'
  | 'add-rule-input'
  | 'add-rule-scope'
  | 'delete-confirm'
  | 'ws-dir-list'
  | 'ws-add-dir-input'
  | 'ws-remove-confirm';

export interface OpenTuiPermissionsDialogProps {
  rules: readonly PermissionRuleEntry[];
  directories: readonly string[];
  initialDirectories: readonly string[];
  onAddRule: (
    ruleText: string,
    type: PermissionRuleEntry['type'],
    scope: SettingScope,
  ) => void;
  onDeleteRule: (raw: string, type: PermissionRuleEntry['type']) => void;
  onAddDirectory: (resolvedDir: string) => void;
  onRemoveDirectory: (dir: string) => void;
  onExit: () => void;
}

export function OpenTuiPermissionsDialog(props: OpenTuiPermissionsDialogProps) {
  const {
    rules,
    directories,
    initialDirectories,
    onAddRule,
    onDeleteRule,
    onAddDirectory,
    onRemoveDirectory,
    onExit,
  } = props;

  const tabs = getPermissionsTabs();
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const activeTab = tabs[activeTabIndex]!;
  const [view, setView] = useState<PermissionsView>('rule-list');
  const [searchQuery, setSearchQuery] = useState('');
  const [newRuleInput, setNewRuleInput] = useState('');
  const [ruleInputError, setRuleInputError] = useState('');
  const [pendingRuleText, setPendingRuleText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PermissionRuleEntry | null>(
    null,
  );
  const [newDirInput, setNewDirInput] = useState('');
  const [dirInputError, setDirInputError] = useState('');
  const [removeDirTarget, setRemoveDirTarget] = useState<string | null>(null);

  const currentTabRules =
    activeTab.id === 'workspace'
      ? []
      : rules.filter((r) => r.type === activeTab.id);
  const filteredRules = currentTabRules.filter((r) =>
    matchesSearchQuery(searchQuery, [r.raw, r.toolName]),
  );

  const ruleListItems = [
    { label: t('Add a new rule…'), key: '__add__', value: '__add__' },
    ...filteredRules.map((r) => ({
      label: r.raw,
      value: r.raw,
      key: `${r.type}-${r.scope}-${r.raw}`,
    })),
  ];
  const initialDirSet = new Set(initialDirectories);
  const dirListItems = [
    { label: t('Add directory…'), key: '__add_dir__', value: '__add_dir__' },
    ...directories
      .filter((dir) => !initialDirSet.has(dir))
      .map((dir) => ({ label: dir, value: dir, key: `dir-${dir}` })),
  ];

  const ruleList = useDialogSelect({
    items: ruleListItems,
    focused: view === 'rule-list' && activeTab.id !== 'workspace',
    numbers: true,
    maxItemsToShow: 15,
    onSelect: (value) => {
      if (value === '__add__') {
        setNewRuleInput('');
        setRuleInputError('');
        setView('add-rule-input');
        return;
      }
      const found = filteredRules.find((r) => r.raw === value);
      if (found) {
        setDeleteTarget(found);
        setView('delete-confirm');
      }
    },
  });

  const dirList = useDialogSelect({
    items: dirListItems,
    focused: view === 'ws-dir-list' && activeTab.id === 'workspace',
    numbers: true,
    maxItemsToShow: 15,
    onSelect: (value) => {
      if (value === '__add_dir__') {
        setNewDirInput('');
        setView('ws-add-dir-input');
        return;
      }
      if (!initialDirSet.has(value)) {
        setRemoveDirTarget(value);
        setView('ws-remove-confirm');
      }
    },
  });

  const scopeItems = getPermissionScopeItems().map((s) => ({
    ...s,
    key: s.key,
    value: s.value,
  }));
  const scopeList = useDialogSelect({
    items: scopeItems,
    focused: view === 'add-rule-scope',
    numbers: true,
    onSelect: (scope) => {
      onAddRule(
        pendingRuleText,
        activeTab.id as PermissionRuleEntry['type'],
        scope,
      );
      setPendingRuleText('');
      setView('rule-list');
    },
  });

  const cycleTab = (direction: 1 | -1) => {
    const newIndex = (activeTabIndex + direction + tabs.length) % tabs.length;
    setActiveTabIndex(newIndex);
    setSearchQuery('');
    const newTab = tabs[newIndex]!;
    setView(newTab.id === 'workspace' ? 'ws-dir-list' : 'rule-list');
  };

  useKeyboard((key) => {
    const original = toOriginalKey(key);
    const { name, ctrl } = original;

    if (view === 'rule-list') {
      if (name === 'escape') {
        if (searchQuery) setSearchQuery('');
        else onExit();
        return;
      }
      if (name === 'tab') {
        cycleTab(1);
        return;
      }
      if (name === 'right' || name === 'left') {
        cycleTab(name === 'right' ? 1 : -1);
        return;
      }
      if (name === 'backspace' || name === 'delete') {
        if (searchQuery.length > 0) setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      if (
        original.sequence &&
        !ctrl &&
        !original.meta &&
        original.sequence.length === 1 &&
        original.sequence >= ' '
      ) {
        setSearchQuery((q) => q + original.sequence);
        return;
      }
    }
    if (view === 'add-rule-input') {
      if (name === 'escape') {
        setView('rule-list');
        return;
      }
      if (name === 'return') {
        const trimmed = newRuleInput.trim();
        if (!trimmed) return;
        const rule = parseRule(trimmed);
        if (rule.invalid) {
          setRuleInputError(
            t(
              'Malformed rule: unbalanced parentheses. Use the format ToolName(specifier).',
            ),
          );
          return;
        }
        setRuleInputError('');
        setPendingRuleText(trimmed);
        setView('add-rule-scope');
        return;
      }
      if (name === 'backspace') {
        setNewRuleInput((v) => v.slice(0, -1));
        return;
      }
      if (!ctrl && original.sequence.length === 1 && original.sequence >= ' ') {
        setNewRuleInput((v) => v + original.sequence);
        setRuleInputError('');
      }
      return;
    }
    if (view === 'add-rule-scope') {
      if (name === 'escape') {
        setView('add-rule-input');
      }
      return;
    }
    if (view === 'delete-confirm') {
      if (name === 'escape') {
        setDeleteTarget(null);
        setView('rule-list');
        return;
      }
      if (name === 'return' && deleteTarget) {
        onDeleteRule(deleteTarget.raw, deleteTarget.type);
        setDeleteTarget(null);
        setView('rule-list');
      }
      return;
    }
    if (view === 'ws-dir-list') {
      if (name === 'escape') {
        onExit();
        return;
      }
      if (name === 'tab') {
        cycleTab(1);
        return;
      }
      if (name === 'right' || name === 'left') {
        cycleTab(name === 'right' ? 1 : -1);
      }
      return;
    }
    if (view === 'ws-add-dir-input') {
      if (name === 'escape') {
        setDirInputError('');
        setView('ws-dir-list');
        return;
      }
      if (name === 'return') {
        // ink's handleAddDirSubmit returns early on empty input — the user
        // stays in the form instead of silently dropping back to the list
        // (validateWorkspaceDirectory's empty-input sentinel is falsy).
        if (!newDirInput.trim()) return;
        const result = validateWorkspaceDirectory(newDirInput, directories);
        if (result.error) {
          setDirInputError(result.error);
          return;
        }
        if (result.resolved) onAddDirectory(result.resolved);
        setDirInputError('');
        setNewDirInput('');
        setView('ws-dir-list');
        return;
      }
      if (name === 'backspace') {
        setNewDirInput((v) => v.slice(0, -1));
        return;
      }
      if (!ctrl && original.sequence.length === 1 && original.sequence >= ' ') {
        setNewDirInput((v) => v + original.sequence);
        if (dirInputError) setDirInputError('');
      }
      return;
    }
    if (view === 'ws-remove-confirm') {
      if (name === 'escape') {
        setRemoveDirTarget(null);
        setView('ws-dir-list');
        return;
      }
      if (name === 'return' && removeDirTarget) {
        onRemoveDirectory(removeDirTarget);
        setRemoveDirTarget(null);
        setView('ws-dir-list');
      }
    }
  });

  const footerText =
    view === 'rule-list' || view === 'ws-dir-list'
      ? t(
          'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel',
        )
      : '';

  // --- Workspace sub-views ---

  if (activeTab.id === 'workspace' && view === 'ws-add-dir-input') {
    return (
      <box flexDirection="column">
        <text fg={C.accent} attributes={1}>
          {t('Add directory to workspace')}
        </text>
        <box height={1} />
        <text fg={C.dim}>
          {t(
            'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.',
          )}
        </text>
        <box height={1} />
        <text fg={C.text}>{t('Enter the path to the directory:')}</text>
        <box
          borderStyle="rounded"
          borderColor={C.dim}
          paddingX={1}
          marginTop={1}
        >
          <text fg={newDirInput ? C.text : C.dim}>
            {newDirInput || t('Enter directory path…')}
          </text>
        </box>
        {dirInputError && <text fg={C.red}>{dirInputError}</text>}
        <FooterHint
          text={t('Tab to complete · Enter to add · Esc to cancel')}
        />
      </box>
    );
  }

  if (
    activeTab.id === 'workspace' &&
    view === 'ws-remove-confirm' &&
    removeDirTarget
  ) {
    return (
      <box flexDirection="column">
        <DialogFrame>
          <text fg={C.text} attributes={1}>
            {t('Remove directory?')}
          </text>
          <box height={1} />
          <box marginLeft={2} flexDirection="column">
            <text fg={C.text} attributes={1}>
              {removeDirTarget}
            </text>
          </box>
          <box height={1} />
          <text fg={C.text}>
            {t(
              'Are you sure you want to remove this directory from the workspace?',
            )}
          </text>
        </DialogFrame>
        <box marginTop={1} marginLeft={1}>
          <text fg={C.dim}>{t('Enter to confirm · Esc to cancel')}</text>
        </box>
      </box>
    );
  }

  if (activeTab.id === 'workspace') {
    return (
      <box flexDirection="column">
        <DialogTabBar
          tabs={tabs}
          activeId={activeTab.id}
          hint={t('(←/→ or tab to cycle)')}
        />
        <text fg={C.dim}>
          {t(
            'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.',
          )}
        </text>
        <box height={1} />
        {initialDirectories.map((dir, idx) => (
          <box key={dir} marginLeft={2} flexDirection="row">
            <text fg={C.dim}>{'- '}</text>
            <text fg={C.text}>{dir}</text>
            <text fg={C.dim}>
              {idx === 0
                ? t('  (Original working directory)')
                : t('  (from settings)')}
            </text>
          </box>
        ))}
        <DialogSelect
          items={dirListItems}
          activeIndex={dirList.activeIndex}
          scrollOffset={dirList.scrollOffset}
          maxItemsToShow={15}
          showNumbers={true}
          focused={view === 'ws-dir-list'}
          onHover={dirList.setActiveIndex}
          onSelectIndex={dirList.selectIndex}
          renderLabel={(item, { titleColor }) => (
            <text fg={titleColor}>{item.label}</text>
          )}
        />
        {footerText ? <FooterHint text={footerText} /> : null}
      </box>
    );
  }

  // --- Rule sub-views ---

  if (view === 'add-rule-input') {
    return (
      <box flexDirection="column">
        <DialogFrame>
          <text fg={C.text} attributes={1}>
            {t('Add {{type}} permission rule', { type: activeTab.id })}
          </text>
          <box height={1} />
          <text fg={C.text}>
            {t(
              'Permission rules are a tool name, optionally followed by a specifier in parentheses.',
            )}
          </text>
          <text fg={C.text}>
            {t('e.g.,')} <text attributes={1}>WebFetch</text> {t('or')}{' '}
            <text attributes={1}>Bash(ls:*)</text>
          </text>
          <box height={1} />
          <box borderStyle="rounded" borderColor={C.dim} paddingX={1}>
            <text fg={newRuleInput ? C.text : C.dim}>
              {newRuleInput || t('Enter permission rule…')}
            </text>
          </box>
          {ruleInputError ? (
            <box marginTop={1}>
              <text fg={C.red}>{ruleInputError}</text>
            </box>
          ) : null}
        </DialogFrame>
        <box marginTop={1} marginLeft={1}>
          <text fg={C.dim}>{t('Enter to submit · Esc to cancel')}</text>
        </box>
      </box>
    );
  }

  if (view === 'add-rule-scope') {
    return (
      <box flexDirection="column">
        <DialogFrame>
          <text fg={C.text} attributes={1}>
            {t('Add {{type}} permission rule', { type: activeTab.id })}
          </text>
          <box height={1} />
          <box marginLeft={2} flexDirection="column">
            <text fg={C.text} attributes={1}>
              {pendingRuleText}
            </text>
            <text fg={C.dim}>{describePermissionRule(pendingRuleText)}</text>
          </box>
          <box height={1} />
          <text fg={C.text}>{t('Where should this rule be saved?')}</text>
          <DialogSelect
            items={scopeItems}
            activeIndex={scopeList.activeIndex}
            scrollOffset={scopeList.scrollOffset}
            showNumbers={true}
            focused={true}
            onHover={scopeList.setActiveIndex}
            onSelectIndex={scopeList.selectIndex}
            renderLabel={(item, { titleColor }) => (
              <text fg={titleColor}>
                {item.label} <text fg={C.dim}>{item.description}</text>
              </text>
            )}
          />
        </DialogFrame>
        <box marginTop={1} marginLeft={1}>
          <text fg={C.dim}>{t('Enter to confirm · Esc to cancel')}</text>
        </box>
      </box>
    );
  }

  if (view === 'delete-confirm' && deleteTarget) {
    return (
      <box flexDirection="column">
        <DialogFrame>
          <text fg={C.text} attributes={1}>
            {t('Delete {{type}} rule?', { type: deleteTarget.type })}
          </text>
          <box height={1} />
          <box marginLeft={2} flexDirection="column">
            <text fg={C.text} attributes={1}>
              {deleteTarget.raw}
            </text>
            <text fg={C.dim}>{describePermissionRule(deleteTarget.raw)}</text>
            <text fg={C.dim}>{permissionScopeLabel(deleteTarget.scope)}</text>
          </box>
          <box height={1} />
          <text fg={C.text}>
            {t('Are you sure you want to delete this permission rule?')}
          </text>
        </DialogFrame>
        <box marginTop={1} marginLeft={1}>
          <text fg={C.dim}>{t('Enter to confirm · Esc to cancel')}</text>
        </box>
      </box>
    );
  }

  // --- Default: rule list view ---

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={C.accent} attributes={1}>
          {t('Permissions:')}{' '}
        </text>
        {tabs.map((tab, i) => (
          <box key={tab.id} marginRight={2}>
            <text
              fg={i === activeTabIndex ? '#000000' : C.dim}
              bg={i === activeTabIndex ? C.accent : undefined}
              attributes={i === activeTabIndex ? 1 : undefined}
            >
              {` ${tab.label} `}
            </text>
          </box>
        ))}
        <text fg={C.dim}>{t('(←/→ or tab to cycle)')}</text>
      </box>
      <box marginTop={1}>
        <text fg={C.text}>{activeTab.description}</text>
      </box>
      <box
        borderStyle="rounded"
        borderColor={C.dim}
        paddingX={1}
        marginTop={1}
        width={60}
      >
        <text fg={C.accent}>{'> '}</text>
        {searchQuery ? (
          <text fg={C.text}>{searchQuery}</text>
        ) : (
          <text fg={C.dim}>{t('Search…')}</text>
        )}
      </box>
      <box height={1} />
      <DialogSelect
        items={ruleListItems}
        activeIndex={ruleList.activeIndex}
        scrollOffset={ruleList.scrollOffset}
        maxItemsToShow={15}
        showNumbers={true}
        focused={view === 'rule-list'}
        onHover={ruleList.setActiveIndex}
        onSelectIndex={ruleList.selectIndex}
        renderLabel={(item, { titleColor }) => (
          <text fg={titleColor}>{item.label}</text>
        )}
      />
      <FooterHint text={footerText} />
    </box>
  );
}
