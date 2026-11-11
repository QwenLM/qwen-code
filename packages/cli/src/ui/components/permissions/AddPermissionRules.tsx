/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  type PermissionBehavior,
  type PermissionRule,
  type PermissionRuleValue,
  type EditableSettingSource,
  type SettingsWriter,
  type UnreachableRule,
  type PermissionRules,
  type PermissionUpdate,
  persistPermissionUpdate,
  permissionRuleValueToString,
  detectUnreachableRules,
  CONFIG_DIR,
  getUserConfigDisplayPath,
} from '@qwen-code/core';
import { DescriptiveRadioButtonSelect } from '../shared/DescriptiveRadioButtonSelect.js';
import { PermissionRuleDescription } from './PermissionRuleDescription.js';
import { theme } from '../../semantic-colors.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';

// ── Types ────────────────────────────────────────────────────────────────────

const SOURCES: readonly EditableSettingSource[] = [
  'localSettings',
  'projectSettings',
  'userSettings',
] as const;

interface SaveDestinationOption {
  key: string;
  title: string;
  description: string;
  value: EditableSettingSource;
}

interface AddPermissionRulesProps {
  onAddRules: (
    rules: PermissionRule[],
    unreachable?: UnreachableRule[],
  ) => void;
  onCancel: () => void;
  ruleValues: PermissionRuleValue[];
  ruleBehavior: PermissionBehavior;
  /** Applies the chosen rules to the live module and re-renders the dialog. */
  applyUpdates: (...updates: PermissionUpdate[]) => void;
  /** The rule set after the write, for the shadowed-rule check below. */
  rulesAfterApply: () => PermissionRules;
  settingsWriter?: SettingsWriter;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getOptionForSaveDestination(
  source: EditableSettingSource,
): SaveDestinationOption {
  switch (source) {
    case 'localSettings':
      return {
        key: source,
        title: 'Project settings (local)',
        description: `Saved in ./${CONFIG_DIR}/settings.local.json (gitignored)`,
        value: source,
      };
    case 'projectSettings':
      return {
        key: source,
        title: 'Project settings',
        description: `Checked in at ./${CONFIG_DIR}/settings.json`,
        value: source,
      };
    case 'userSettings':
      return {
        key: source,
        title: 'User settings',
        description: `Saved in ${getUserConfigDisplayPath('settings.json')}`,
        value: source,
      };
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unknown source: ${_exhaustive}`);
    }
  }
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Sub-screen for choosing where to save a new permission rule.
 *
 * After the user has entered a rule in PermissionRuleInput, this component
 * displays the rule details and asks where to persist it:
 *  - Project settings (local) — gitignored
 *  - Project settings — committed
 *  - User settings — global
 */
export function AddPermissionRules({
  onAddRules,
  onCancel,
  ruleValues,
  ruleBehavior,
  applyUpdates,
  rulesAfterApply,
  settingsWriter,
}: AddPermissionRulesProps): React.JSX.Element {
  const options = useMemo(() => SOURCES.map(getOptionForSaveDestination), []);
  const [saveError, setSaveError] = useState<string>();

  const handleSelect = useCallback(
    (destination: EditableSettingSource) => {
      setSaveError(undefined);
      const update = {
        type: 'addRules' as const,
        rules: ruleValues,
        behavior: ruleBehavior,
        destination,
      };

      if (settingsWriter) {
        if (persistPermissionUpdate(update, settingsWriter) === false) {
          setSaveError(
            'Failed to save permission rules. No rules were added. Retry or press Esc to cancel.',
          );
          return;
        }
      }

      applyUpdates(update);

      const rules: PermissionRule[] = ruleValues.map((ruleValue) => ({
        ruleValue,
        ruleBehavior,
        source: destination,
      }));

      const allUnreachable = detectUnreachableRules(rulesAfterApply());
      const newUnreachable = allUnreachable.filter((u: UnreachableRule) =>
        ruleValues.some(
          (rv) =>
            rv.toolName === u.rule.ruleValue.toolName &&
            rv.ruleContent === u.rule.ruleValue.ruleContent,
        ),
      );

      onAddRules(rules, newUnreachable.length > 0 ? newUnreachable : undefined);
    },
    [
      ruleValues,
      ruleBehavior,
      applyUpdates,
      rulesAfterApply,
      settingsWriter,
      onAddRules,
    ],
  );

  // Handle Esc key to cancel and go back
  const handleKey = useCallback(
    (key: Key) => {
      if (key.name === 'escape') {
        onCancel();
        return true;
      }
      return false;
    },
    [onCancel],
  );
  useKeypress(handleKey, { isActive: true });

  const ruleCount = ruleValues.length;
  const title = `Add ${ruleBehavior} permission rule${ruleCount > 1 ? 's' : ''}`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text bold color={theme.ui.active}>
        {title}
      </Text>

      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {ruleValues.map((rv) => (
          <Box flexDirection="column" key={permissionRuleValueToString(rv)}>
            <Text bold>{permissionRuleValueToString(rv)}</Text>
            <PermissionRuleDescription ruleValue={rv} />
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          {ruleCount === 1
            ? 'Where should this rule be saved?'
            : 'Where should these rules be saved?'}
        </Text>
        <DescriptiveRadioButtonSelect
          items={options}
          onSelect={handleSelect}
          isFocused={true}
        />
      </Box>

      {saveError && <Text color={theme.status.error}>{saveError}</Text>}
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
