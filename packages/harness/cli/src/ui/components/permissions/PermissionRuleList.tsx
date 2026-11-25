/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import {
  type PermissionBehavior,
  type PermissionRule,
  type PermissionRuleValue,
  type SettingsWriter,
  type UnreachableRule,
  type EditableSettingSource,
  type SessionPermissionManager,
  type AutoClassifier,
  permissionRuleValueToString,
  isEditableSource,
  deletePermissionRuleFromSettings,
  getAllowRules,
  getDenyRules,
  getAskRules,
} from '@qwen-code/core';
import { BaseTabDialog, type TabItem } from '../shared/BaseTabDialog.js';
import type { ShortcutHint } from '../../hooks/useContainerKeyboard.js';
import { PermissionRulesTab } from './PermissionRulesTab.js';
import { PermissionRuleInput } from './PermissionRuleInput.js';
import { AddPermissionRules } from './AddPermissionRules.js';
import { RuleDetails } from './RuleDetails.js';
import { TrustTab } from './TrustTab.js';
import {
  RecentDenialsTab,
  type RecentDenialsState,
} from './RecentDenialsTab.js';
import { useRegisterKeyboardContext } from '../../contexts/KeyboardContextRegistry.js';
import { usePermissionRules } from './usePermissionRules.js';
import { theme } from '../../semantic-colors.js';

// ── Types ────────────────────────────────────────────────────────────────────

type TabType = 'recent' | 'allow' | 'ask' | 'deny' | 'trust';

interface PermissionRuleListProps {
  /** Close the dialog */
  onExit: (result?: string) => void;
  /** The session's permission module. Rules are read and written through it. */
  permission: SessionPermissionManager;
  /**
   * The session's auto mode. The "Recently denied" tab reads the refusals this
   * session's classifier recorded — the list is per session, so the dialog can
   * never show what a different session was refused.
   */
  autoMode: AutoClassifier;
  /** Settings writer for persistence */
  settingsWriter?: SettingsWriter;
  /** Initial tab to show */
  initialTab?: TabType;
  /** Whether folder trust feature is enabled */
  /** Called with command display strings when the user marks denials for retry */
  onRetryDenials?: (commands: string[]) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Root component for the /permissions dialog.
 *
 * Implements a state machine that renders either:
 * - The main tabbed view (Recently denied / Allow / Ask / Deny)
 * - Sub-screens for adding rules, deleting rules, or viewing details
 *
 * State machine priority:
 *   selectedRule     → <RuleDetails>
 *   addingRuleToTab  → <PermissionRuleInput>
 *   validatedRule    → <AddPermissionRules>
 *   (default)        → <BaseTabDialog> with tabs
 */
export function PermissionRuleList({
  onExit,
  permission,
  autoMode,
  settingsWriter,
  initialTab,
  onRetryDenials,
}: PermissionRuleListProps): React.JSX.Element {
  // Register Dialog keyboard context to suppress Chat's key handlers (e.g. Enter → submit)
  // Without this, the ContextRouting system (priority 300) dispatches Enter to Chat's
  // input.submit action, which closes the dialog instead of reaching our TextInput.
  useRegisterKeyboardContext('Dialog', true);

  // Snapshot at mount, and only this session's refusals: the dialog lists what
  // had been denied when it opened rather than a feed that shifts underneath the
  // user while they read it.
  const denials = useMemo(
    () => autoMode.getDenials(permission.getSessionId()),
    [autoMode, permission],
  );
  const hasDenials = denials.length > 0;
  const denialStateRef = useRef<RecentDenialsState>({
    approved: new Set(),
    retry: new Set(),
    denials: [],
  });
  const handleDenialStateChange = useCallback((state: RecentDenialsState) => {
    denialStateRef.current = state;
  }, []);

  // The dialog no longer keeps its own copy of the rules: the module is the live
  // state, and this handle re-reads it after every write. One owner for the whole
  // dialog — two would each miss the other's writes.
  const { rules, directories, apply } = usePermissionRules(permission);

  const [changes, setChanges] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState<string>();

  // --- State machine states ---
  const [selectedRule, setSelectedRule] = useState<
    PermissionRule | undefined
  >();
  const [addingRuleToTab, setAddingRuleToTab] = useState<TabType | null>(null);
  const [validatedRule, setValidatedRule] = useState<{
    ruleValue: PermissionRuleValue;
    ruleBehavior: PermissionBehavior;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<string>(
    () => initialTab ?? (hasDenials ? 'recent' : 'allow'),
  );
  const [lastFocusedRuleKey, setLastFocusedRuleKey] = useState<
    string | undefined
  >();

  // --- Exit handling ---
  const handleClose = useCallback(() => {
    const s = denialStateRef.current;
    const denialsFor = (set: Set<number>) =>
      Array.from(set)
        .map((idx) => s.denials[idx])
        .filter((d): d is NonNullable<typeof d> => d !== undefined);

    // If user marked denials for retry, notify parent and exit
    const retryDenials = denialsFor(s.retry);
    if (retryDenials.length > 0) {
      const commands = retryDenials.map((d) => d.display);
      onRetryDenials?.(commands);
      onExit(
        `Permission granted for: ${commands.join(', ')}. You may now retry ${commands.length === 1 ? 'this command' : 'these commands'}.`,
      );
      return;
    }

    // If user approved denials (without retry), include in exit message
    const approvedDenials = denialsFor(s.approved);
    if (approvedDenials.length > 0 || changes.length > 0) {
      const approvedMsg =
        approvedDenials.length > 0
          ? [`Approved: ${approvedDenials.map((d) => d.display).join(', ')}`]
          : [];
      onExit([...approvedMsg, ...changes].join('\n'));
    } else {
      onExit('Permissions dialog dismissed');
    }
  }, [changes, onExit, onRetryDenials]);

  // --- Rule selection (view details / delete) ---
  const handleSelectRule = useCallback((rule: PermissionRule) => {
    setDeleteError(undefined);
    setSelectedRule(rule);
  }, []);

  const handleDeleteRule = useCallback(() => {
    if (!selectedRule) return;

    // Compute adjacent rule key for cursor restoration
    const getRulesForBehavior = (b: PermissionBehavior) => {
      switch (b) {
        case 'allow':
          return getAllowRules(rules);
        case 'deny':
          return getDenyRules(rules);
        case 'ask':
          return getAskRules(rules);
        default:
          return [];
      }
    };
    const currentRules = getRulesForBehavior(selectedRule.ruleBehavior);
    const sortedRules = [...currentRules]
      .map((r) => ({ rule: r, key: permissionRuleValueToString(r.ruleValue) }))
      .sort((a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase()));
    const deletedKey = permissionRuleValueToString(selectedRule.ruleValue);
    const idx = sortedRules.findIndex((r) => r.key === deletedKey);
    // Pick the next rule, or the previous one if we're deleting the last
    const adjacentIdx = idx < sortedRules.length - 1 ? idx + 1 : idx - 1;
    const adjacentKey =
      adjacentIdx >= 0 ? sortedRules[adjacentIdx]?.key : undefined;

    // Delete from disk if source is editable
    if (isEditableSource(selectedRule.source) && settingsWriter) {
      const editableSource = selectedRule.source;
      if (
        !deletePermissionRuleFromSettings(
          { ...selectedRule, source: editableSource },
          settingsWriter,
        )
      ) {
        setDeleteError(
          'Failed to delete permission rule. The current rule is unchanged. Retry or press Esc to cancel.',
        );
        return;
      }
    }

    setDeleteError(undefined);
    setLastFocusedRuleKey(adjacentKey);

    apply({
      type: 'removeRules',
      rules: [selectedRule.ruleValue],
      behavior: selectedRule.ruleBehavior,
      destination: selectedRule.source as EditableSettingSource,
    });

    setChanges((prev) => [
      ...prev,
      `Deleted ${selectedRule.ruleBehavior} rule: ${permissionRuleValueToString(selectedRule.ruleValue)}`,
    ]);
    setSelectedRule(undefined);
  }, [selectedRule, settingsWriter, apply, rules]);

  // --- Add new rule flow ---
  const handleAddNewRule = useCallback((tab: TabType) => {
    setAddingRuleToTab(tab);
  }, []);

  const handleRuleInputSubmit = useCallback(
    (ruleValue: PermissionRuleValue, ruleBehavior: PermissionBehavior) => {
      setValidatedRule({ ruleValue, ruleBehavior });
      setAddingRuleToTab(null);
    },
    [],
  );

  const handleRuleInputCancel = useCallback(() => {
    setAddingRuleToTab(null);
  }, []);

  const handleAddRulesSuccess = useCallback(
    (rules: PermissionRule[], unreachable?: UnreachableRule[]) => {
      setValidatedRule(null);
      const newEntries: string[] = [];
      for (const rule of rules) {
        newEntries.push(
          `Added ${rule.ruleBehavior} rule: ${permissionRuleValueToString(rule.ruleValue)}`,
        );
      }
      if (unreachable && unreachable.length > 0) {
        for (const u of unreachable) {
          const severity = u.shadowType === 'deny' ? 'blocked' : 'shadowed';
          newEntries.push(
            `⚠ Warning: ${permissionRuleValueToString(u.rule.ruleValue)} is ${severity}`,
            `  ${u.reason}`,
            `  Fix: ${u.fix}`,
          );
        }
      }
      setChanges((prev) => [...prev, ...newEntries]);
    },
    [],
  );

  const handleAddRuleCancel = useCallback(() => {
    setValidatedRule(null);
  }, []);

  // --- State machine rendering ---
  const isAddingRule =
    addingRuleToTab !== null &&
    addingRuleToTab !== 'trust' &&
    addingRuleToTab !== 'recent';
  const isChoosingDestination = validatedRule !== null;
  const isViewingRule = selectedRule !== undefined;
  const showSubScreen = isAddingRule || isChoosingDestination || isViewingRule;

  // Tab definitions (stable across renders)
  const tabs: TabItem[] = useMemo(
    () => [
      ...(hasDenials ? [{ key: 'recent', label: 'Recently denied' }] : []),
      { key: 'allow', label: 'Allow' },
      { key: 'ask', label: 'Ask' },
      { key: 'deny', label: 'Deny' },
      // Always visible: the workspace's additional directories are a core
      // surface, not something the folder-trust feature gates.
      { key: 'trust', label: 'Trust' },
    ],
    [hasDenials],
  );

  // Dynamic footer hints based on active tab
  const extraHints: ShortcutHint[] = useMemo(() => {
    const hints: ShortcutHint[] = [
      { label: '↑↓ navigate', order: 10 },
      {
        label:
          activeTab === 'trust'
            ? 'Enter remove · x remove'
            : activeTab === 'recent'
              ? 'Enter approve · r retry'
              : 'Enter select',
        order: 20,
      },
    ];
    if (activeTab !== 'trust' && activeTab !== 'recent') {
      hints.push({ label: 'Type to search', order: 30 });
    }
    return hints;
  }, [activeTab]);

  // Keep BaseTabDialog always mounted to preserve internal state (selection
  // position, search query, keyboard registrations). Sub-screens render above
  // the hidden tab view and are conditionally mounted/unmounted as needed.
  return (
    <Box flexDirection="column">
      {/* Sub-screen: View/delete rule */}
      {isViewingRule && selectedRule && (
        <PermissionErrorBoundary onReset={() => setSelectedRule(undefined)}>
          {deleteError && <Text color={theme.status.error}>{deleteError}</Text>}
          <RuleDetails
            rule={selectedRule}
            onDelete={handleDeleteRule}
            onCancel={() => setSelectedRule(undefined)}
          />
        </PermissionErrorBoundary>
      )}

      {/* Sub-screen: Add rule text input */}
      {isAddingRule && (
        <PermissionErrorBoundary onReset={handleRuleInputCancel}>
          <PermissionRuleInput
            onCancel={handleRuleInputCancel}
            onSubmit={handleRuleInputSubmit}
            ruleBehavior={addingRuleToTab as PermissionBehavior}
            rules={rules}
          />
        </PermissionErrorBoundary>
      )}

      {/* Sub-screen: Choose save destination */}
      {isChoosingDestination && validatedRule && (
        <PermissionErrorBoundary onReset={handleAddRuleCancel}>
          <AddPermissionRules
            onAddRules={handleAddRulesSuccess}
            onCancel={handleAddRuleCancel}
            ruleValues={[validatedRule.ruleValue]}
            ruleBehavior={validatedRule.ruleBehavior}
            applyUpdates={apply}
            rulesAfterApply={() => permission.getRules()}
            settingsWriter={settingsWriter}
          />
        </PermissionErrorBoundary>
      )}

      {/* Main tabbed view — always mounted, hidden when sub-screen is active */}
      <Box display={showSubScreen ? 'none' : 'flex'} flexDirection="column">
        <BaseTabDialog
          title="Permissions"
          tabs={tabs}
          activeKey={activeTab}
          onTabChange={setActiveTab}
          onClose={handleClose}
          isActive={!showSubScreen}
          showSeparator={true}
          showContent={true}
          extraHints={extraHints}
        >
          {/* Unmount tab content when sub-screens are active to prevent
              keyboard context conflicts (multiple RadioButtonSelect instances
              competing for the same 'Select' context registration). BaseTabDialog
              itself stays mounted to avoid the freeze bug. */}
          {!showSubScreen && (
            <>
              {activeTab === 'recent' && (
                <RecentDenialsTab
                  initialDenials={denials}
                  onStateChange={handleDenialStateChange}
                />
              )}
              {(activeTab === 'allow' ||
                activeTab === 'ask' ||
                activeTab === 'deny') && (
                <PermissionRulesTab
                  tab={activeTab}
                  allRules={rules}
                  onSelectRule={handleSelectRule}
                  onAddNewRule={handleAddNewRule}
                  onCancel={handleClose}
                  isFocused={true}
                  lastFocusedRuleKey={lastFocusedRuleKey}
                />
              )}
              {activeTab === 'trust' && (
                <TrustTab
                  trustedDirectories={directories}
                  applyUpdates={apply}
                  onClose={handleClose}
                />
              )}
            </>
          )}
        </BaseTabDialog>
      </Box>
    </Box>
  );
}

// ── Error Boundary ─────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  error: Error | null;
}

class PermissionErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset: () => void },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; onReset: () => void }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column">
          <Text color="red" bold>
            Error in permissions dialog
          </Text>
          <Text color="red">{this.state.error.message}</Text>
          <Text dimColor>Press Esc to go back</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
