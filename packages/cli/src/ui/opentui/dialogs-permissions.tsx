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
import { useMemo, useState } from 'react';
import { decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { SettingScope } from '../../config/settings.js';
import { Command, keyMatchers } from '../keyMatchers.js';
import { parseRule } from '@qwen-code/qwen-code-core/permissions/rule-parser.js';
import { isPathWithinRoot } from '@qwen-code/qwen-code-core/utils/workspaceContext.js';
import { toOriginalKey } from './key-map.js';
import { useLineEdit, windowLineAtCaret } from './line-edit.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import { useBatchSafeCursor, useBatchSafeState } from './batch-cursor.js';
import {
  matchesSearchQuery,
  regionListWindow,
  wrappedRows,
} from './dialogs-core.js';
import {
  DialogFrame,
  DialogSelect,
  DialogTabBar,
  FooterHint,
  dialogAreaWidth,
  useDialogSelect,
} from './dialogs-shared.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';

import {
  clipToWidth,
  getCachedStringWidth,
  sanitizeTerminalLine,
  truncateToWidth,
} from '../utils/textUtils.js';

function directoryCompletions(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~/, os.homedir())
    : trimmed;
  const endsWithSep = expanded.endsWith('/') || expanded.endsWith(nodePath.sep);
  const searchDir = endsWithSep ? expanded : nodePath.dirname(expanded);
  const prefix = endsWithSep ? '' : nodePath.basename(expanded);
  try {
    return fs
      .readdirSync(searchDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith(prefix) &&
          !entry.name.startsWith('.'),
      )
      .map((entry) => nodePath.join(searchDir, entry.name))
      .slice(0, 6);
  } catch {
    return [];
  }
}

function PermissionInput({
  value,
  caret,
  placeholder,
  width,
}: {
  value: string;
  caret: number;
  placeholder: string;
  width: number;
}) {
  if (width < 1) return null;
  const spans = windowLineAtCaret({ text: value, cursor: caret }, width);
  const before = sanitizeTerminalLine(spans.before);
  const after = value
    ? sanitizeTerminalLine(spans.after)
    : truncateToWidth(placeholder, Math.max(0, width - 1));
  return (
    <box flexDirection="row">
      {before ? <text fg={C.text}>{before}</text> : null}
      <text bg={C.accent}>{sanitizeTerminalLine(spans.at) || ' '}</text>
      {after ? <text fg={value ? C.text : C.dim}>{after}</text> : null}
    </box>
  );
}

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
  /**
   * The popup region's row budget. The rule and directory lists window from
   * it rather than painting a constant fifteen rows, so a short region's
   * clip never hides a row the digits and Enter can still commit.
   */
  availableTerminalHeight?: number;
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

  const { width } = useTerminalDimensions();
  // These views are bare boxes — no DialogFrame — so every run inside them
  // is charged and clipped against the region's own width.
  const areaWidth = dialogAreaWidth(width);
  const tabs = getPermissionsTabs();
  const {
    cursor: activeTabIndex,
    cursorRef: tabIndexRef,
    setCursor: setActiveTabIndex,
  } = useBatchSafeCursor();
  const activeTab = tabs[activeTabIndex]!;
  const {
    value: view,
    ref: viewRef,
    setValue: setView,
  } = useBatchSafeState<PermissionsView>('rule-list');
  const [searchQuery, setSearchQuery] = useState('');
  // Enter lands in the same burst as the characters typed into the field, so
  // the handler submits the ref rather than the pre-burst render value.
  const { value: newRuleInput, setValue: setNewRuleInput } =
    useBatchSafeState('');
  const [ruleInputError, setRuleInputError] = useState('');
  const [pendingRuleText, setPendingRuleText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PermissionRuleEntry | null>(
    null,
  );
  const { value: newDirInput, setValue: setNewDirInput } =
    useBatchSafeState('');
  const [dirInputError, setDirInputError] = useState('');
  const [removeDirTarget, setRemoveDirTarget] = useState<string | null>(null);
  const {
    cursor: completionIndex,
    cursorRef: completionIndexRef,
    setCursor: setCompletionIndex,
  } = useBatchSafeCursor();
  const ruleLine = useLineEdit(
    newRuleInput,
    (text) => {
      setNewRuleInput(text);
      setRuleInputError('');
    },
    view === 'add-rule-input',
  );
  const [dirInputEpoch, setDirInputEpoch] = useState(0);
  const dirLine = useLineEdit(
    newDirInput,
    (text) => {
      setNewDirInput(text);
      setDirInputError('');
      setCompletionIndex(0);
    },
    `${view === 'ws-add-dir-input'}:${dirInputEpoch}`,
  );
  const completions = useMemo(
    () =>
      view === 'ws-add-dir-input' ? directoryCompletions(newDirInput) : [],
    [newDirInput, view],
  );

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

  // Chrome the rule list view pays outside the list: the tab bar (1), the
  // tab description and its margin (2), the bordered search box and its
  // margin (4), the spacer (1) and the footer hint (2). The workspace tab's
  // chrome is the tab bar, its description, a spacer and the footer hint
  // (5), plus one row per initial directory listed above the list. Each
  // description is paid for the rows it actually wraps into at this width —
  // the workspace tab's takes two at 80 columns — since a run left
  // uncharged paints over a row the window thinks it owns.
  const regionHeight = clampDialogHeight(props.availableTerminalHeight);
  const workspaceDescription = t(
    'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.',
  );
  const ruleDescriptionRows = wrappedRows(activeTab.description, areaWidth);
  const workspaceDescriptionRows = wrappedRows(workspaceDescription, areaWidth);
  const dirInputVisible =
    areaWidth > 4 &&
    (regionHeight === undefined ||
      regionHeight >=
        6 +
          wrappedRows(t('Add directory to workspace'), areaWidth) +
          wrappedRows(
            t(
              'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.',
            ),
            areaWidth,
          ) +
          wrappedRows(t('Enter the path to the directory:'), areaWidth));
  const ruleInputVisible =
    areaWidth > 8 &&
    (regionHeight === undefined ||
      regionHeight >=
        7 +
          wrappedRows(
            t('Add {{type}} permission rule', { type: activeTab.id }),
            areaWidth - 4,
          ) +
          wrappedRows(
            t(
              'Permission rules are a tool name, optionally followed by a specifier in parentheses.',
            ),
            areaWidth - 4,
          ) +
          wrappedRows(
            `${t('e.g.,')} WebFetch ${t('or')} Bash(ls:*)`,
            areaWidth - 4,
          ));
  const completionRows =
    regionHeight === undefined
      ? 6
      : Math.max(
          0,
          Math.min(
            6,
            regionHeight -
              8 -
              wrappedRows(t('Add directory to workspace'), areaWidth) -
              wrappedRows(
                t(
                  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.',
                ),
                areaWidth,
              ) -
              wrappedRows(t('Enter the path to the directory:'), areaWidth) -
              wrappedRows(
                t('Tab to complete · Enter to add · Esc to cancel'),
                areaWidth,
              ) -
              (dirInputError ? wrappedRows(dirInputError, areaWidth) : 0),
          ),
        );
  const visibleCompletions = completions.slice(0, completionRows);
  const paintedCompletionIndex = Math.min(
    completionIndex,
    Math.max(0, visibleCompletions.length - 1),
  );
  const maxRulesToShow =
    regionHeight === undefined
      ? 15
      : Math.max(0, Math.min(15, regionHeight - 9 - ruleDescriptionRows));
  const maxDirsToShow =
    regionHeight === undefined
      ? 15
      : Math.max(
          0,
          Math.min(
            15,
            regionHeight -
              4 -
              workspaceDescriptionRows -
              initialDirectories.length,
          ),
        );

  const ruleList = useDialogSelect({
    items: ruleListItems,
    focused: view === 'rule-list' && activeTab.id !== 'workspace',
    numbers: true,
    maxItemsToShow: maxRulesToShow,
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
    maxItemsToShow: maxDirsToShow,
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
  // ink gives every row `wrap="truncate"`; an unclipped rule or path wraps
  // its row into two physical rows the window charged as one. DialogSelect
  // sizes the number box from the full list's length, so the label's budget
  // is the container's width minus the `›` box (2) and that box — the bare
  // region's width for the list views, four columns less for the scope step,
  // whose DialogFrame pays border and padding first.
  const rowLabelWidth = (containerWidth: number, itemCount: number) =>
    Math.max(0, containerWidth - 2 - (String(itemCount).length + 2));
  // The scope step's chrome: the frame (4), the two spacer rows (2) and the
  // footer's margin row (1) are the rows no run can wrap into; the title,
  // the question and the footer are charged the rows they wrap into at the
  // width they paint (the footer paints below the frame, a column in), and
  // the rule block is measured the same way — the rule text is whatever was
  // typed, so a flat count under-pays the moment it wraps. The block paints
  // two columns in.
  const scopeRuleBlockRows =
    wrappedRows(sanitizeTerminalLine(pendingRuleText), areaWidth - 6) +
    wrappedRows(
      sanitizeTerminalLine(describePermissionRule(pendingRuleText)),
      areaWidth - 6,
    );
  const scopeWindow = regionListWindow(
    regionHeight,
    {
      fixed: 7,
      runs: [
        {
          text: t('Add {{type}} permission rule', { type: activeTab.id }),
          width: Math.max(1, areaWidth - 4),
        },
        {
          text: t('Where should this rule be saved?'),
          width: Math.max(1, areaWidth - 4),
        },
        {
          text: t('Enter to confirm · Esc to cancel'),
          width: Math.max(1, areaWidth - 1),
        },
      ],
      measuredRows: scopeRuleBlockRows,
    },
    scopeItems.length,
    10,
  );
  const scopeList = useDialogSelect({
    items: scopeItems,
    focused: view === 'add-rule-scope',
    numbers: true,
    maxItemsToShow: scopeWindow.maxItemsToShow,
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
    const newIndex =
      (tabIndexRef.current + direction + tabs.length) % tabs.length;
    setActiveTabIndex(newIndex);
    setSearchQuery('');
    const newTab = tabs[newIndex]!;
    setView(newTab.id === 'workspace' ? 'ws-dir-list' : 'rule-list');
  };

  useKeyboard((key) => {
    if (viewRef.current !== view || key.eventType === 'release') return;
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
      if (ruleLine.settled) return;
      if (name === 'escape') {
        ruleLine.settle();
        setView('rule-list');
        return;
      }
      if (!ruleInputVisible) return;
      if (name === 'return') {
        const trimmed = ruleLine.text.trim();
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
        ruleLine.settle();
        setView('add-rule-scope');
        return;
      }
      if (keyMatchers[Command.CLEAR_INPUT](original)) {
        ruleLine.clear();
        return;
      }
      if (!ruleLine.handleKey(original) && isPrintableKeyInput(key)) {
        ruleLine.insert(key.sequence);
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
      if (dirLine.settled) return;
      if (name === 'escape') {
        dirLine.settle();
        setDirInputError('');
        setView('ws-dir-list');
        return;
      }
      if (!dirInputVisible) return;
      if (name === 'return') {
        // ink's handleAddDirSubmit returns early on empty input — the user
        // stays in the form instead of silently dropping back to the list
        // (validateWorkspaceDirectory's empty-input sentinel is falsy).
        if (!dirLine.text.trim()) return;
        const result = validateWorkspaceDirectory(dirLine.text, directories);
        if (result.error) {
          setDirInputError(result.error);
          return;
        }
        if (result.resolved) {
          onAddDirectory(result.resolved);
          dirLine.settle();
        }
        setDirInputError('');
        setNewDirInput('');
        setView('ws-dir-list');
        return;
      }
      if (
        visibleCompletions.length > 0 &&
        (name === 'tab' || name === 'up' || name === 'down')
      ) {
        // A same-read edit must not select suggestions from the preceding render.
        if (dirLine.text !== newDirInput) return;
        if (name === 'tab') {
          const selected =
            visibleCompletions[
              Math.min(
                completionIndexRef.current,
                visibleCompletions.length - 1,
              )
            ];
          dirLine.settle();
          setNewDirInput(selected + '/');
          setDirInputError('');
          setDirInputEpoch((epoch) => epoch + 1);
          setCompletionIndex(0);
        } else {
          setCompletionIndex(
            (Math.min(
              completionIndexRef.current,
              visibleCompletions.length - 1,
            ) +
              (name === 'up' ? -1 : 1) +
              visibleCompletions.length) %
              visibleCompletions.length,
          );
        }
        return;
      }
      if (keyMatchers[Command.CLEAR_INPUT](original)) {
        dirLine.clear();
        return;
      }
      if (!dirLine.handleKey(original) && isPrintableKeyInput(key)) {
        dirLine.insert(key.sequence);
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

  usePaste((event) => {
    if (viewRef.current !== view) return;
    const line =
      view === 'add-rule-input' && ruleInputVisible
        ? ruleLine
        : view === 'ws-add-dir-input' && dirInputVisible
          ? dirLine
          : null;
    if (!line || line.settled) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    line.insert(text);
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
          <PermissionInput
            value={newDirInput}
            caret={dirLine.caret}
            placeholder={t('Enter directory path…')}
            width={Math.max(0, areaWidth - 4)}
          />
        </box>
        {dirInputError && <text fg={C.red}>{dirInputError}</text>}
        {visibleCompletions.length > 0 && (
          <box flexDirection="column" marginTop={1}>
            {visibleCompletions.map((completion, index) => (
              <text
                key={completion}
                fg={index === paintedCompletionIndex ? C.accent : C.dim}
              >
                {truncateToWidth(
                  `${sanitizeTerminalLine(nodePath.basename(completion))}/    directory`,
                  areaWidth,
                )}
              </text>
            ))}
          </box>
        )}
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
        <text fg={C.dim}>{workspaceDescription}</text>
        <box height={1} />
        {initialDirectories.map((dir, idx) => {
          const suffix =
            idx === 0
              ? t('  (Original working directory)')
              : t('  (from settings)');
          return (
            <box key={dir} marginLeft={2} flexDirection="row">
              <text fg={C.dim}>{'- '}</text>
              <text fg={C.text}>
                {truncateToWidth(
                  sanitizeTerminalLine(dir),
                  Math.max(0, areaWidth - 4 - getCachedStringWidth(suffix)),
                )}
              </text>
              <text fg={C.dim}>{suffix}</text>
            </box>
          );
        })}
        <DialogSelect
          items={dirListItems}
          activeIndex={dirList.activeIndex}
          scrollOffset={dirList.scrollOffset}
          maxItemsToShow={maxDirsToShow}
          showNumbers={true}
          focused={view === 'ws-dir-list'}
          onHover={dirList.setActiveIndex}
          onSelectIndex={dirList.selectIndex}
          renderLabel={(item, { titleColor }) => (
            <text fg={titleColor}>
              {truncateToWidth(
                sanitizeTerminalLine(item.label),
                rowLabelWidth(areaWidth, dirListItems.length),
              )}
            </text>
          )}
        />
        {footerText ? (
          <FooterHint text={truncateToWidth(footerText, areaWidth)} />
        ) : null}
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
          <box flexDirection="row">
            <text fg={C.text}>{`${t('e.g.,')} `}</text>
            <text attributes={1}>WebFetch</text>
            <text fg={C.text}>{` ${t('or')} `}</text>
            <text attributes={1}>Bash(ls:*)</text>
          </box>
          <box height={1} />
          <box borderStyle="rounded" borderColor={C.dim} paddingX={1}>
            <PermissionInput
              value={newRuleInput}
              caret={ruleLine.caret}
              placeholder={t('Enter permission rule…')}
              width={Math.max(0, areaWidth - 8)}
            />
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
              {sanitizeTerminalLine(pendingRuleText)}
            </text>
            <text fg={C.dim}>
              {sanitizeTerminalLine(describePermissionRule(pendingRuleText))}
            </text>
          </box>
          <box height={1} />
          <text fg={C.text}>{t('Where should this rule be saved?')}</text>
          <DialogSelect
            items={scopeItems}
            activeIndex={scopeList.activeIndex}
            scrollOffset={scopeList.scrollOffset}
            maxItemsToShow={scopeWindow.maxItemsToShow}
            showScrollArrows={scopeWindow.showScrollArrows}
            showNumbers={true}
            focused={true}
            onHover={scopeList.setActiveIndex}
            onSelectIndex={scopeList.selectIndex}
            renderLabel={(item, { titleColor }) => (
              <text fg={titleColor}>
                {clipToWidth(
                  `${item.label}    ${item.description}`,
                  rowLabelWidth(areaWidth - 4, scopeItems.length),
                )}
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
        <text fg={C.dim}>
          {truncateToWidth(
            t('(←/→ or tab to cycle)'),
            Math.max(
              0,
              areaWidth -
                getCachedStringWidth(`${t('Permissions:')} `) -
                tabs.reduce(
                  (total, tab) =>
                    total + getCachedStringWidth(` ${tab.label} `) + 2,
                  0,
                ),
            ),
          )}
        </text>
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
        flexDirection="row"
      >
        <text fg={C.accent}>{'> '}</text>
        {searchQuery ? (
          // A query longer than the box would wrap it onto a second content
          // row the chrome budget does not pay for.
          <text fg={C.text}>{truncateToWidth(searchQuery, 54)}</text>
        ) : (
          <text fg={C.dim}>{t('Search…')}</text>
        )}
      </box>
      <box height={1} />
      <DialogSelect
        items={ruleListItems}
        activeIndex={ruleList.activeIndex}
        scrollOffset={ruleList.scrollOffset}
        maxItemsToShow={maxRulesToShow}
        showNumbers={true}
        focused={view === 'rule-list'}
        onHover={ruleList.setActiveIndex}
        onSelectIndex={ruleList.selectIndex}
        renderLabel={(item, { titleColor }) => (
          <text fg={titleColor}>
            {truncateToWidth(
              sanitizeTerminalLine(item.label),
              rowLabelWidth(areaWidth, ruleListItems.length),
            )}
          </text>
        )}
      />
      <FooterHint text={truncateToWidth(footerText, areaWidth)} />
    </box>
  );
}
