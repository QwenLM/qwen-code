/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  type PermissionBehavior,
  type PermissionRule,
  type PermissionRuleSource,
  permissionRuleValueToString,
  permissionRuleSourceDisplayString,
  CONFIG_DIR,
  getUserConfigDisplayPath,
} from '@qwen-code/core';
import { RadioButtonSelect } from '../shared/RadioButtonSelect.js';
import { PermissionRuleDescription } from './PermissionRuleDescription.js';
import { theme } from '../../semantic-colors.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { isReadOnlySource } from '../../utils/scopeTag.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface RuleDetailsProps {
  rule: PermissionRule;
  onDelete: () => void;
  onCancel: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRuleBehaviorLabel(behavior: PermissionBehavior): string {
  switch (behavior) {
    case 'allow':
      return 'allowed';
    case 'deny':
      return 'denied';
    case 'ask':
      return 'ask';
    default: {
      const _exhaustive: never = behavior;
      return String(_exhaustive);
    }
  }
}

function getReadOnlyMessage(source: PermissionRuleSource): string {
  switch (source) {
    case 'policySettings':
      return 'This rule is configured by enterprise managed settings and cannot be modified.\nContact your system administrator for more information.';
    case 'flagSettings':
      return 'This rule is configured via the --settings startup flag and cannot be modified.\nRemove it from the settings file or restart without the flag.';
    case 'cliArg':
      return 'This rule is configured via --allowed-tools / --disallowed-tools and cannot be modified.\nRestart without this argument to remove it.';
    default:
      return 'This rule cannot be modified through the UI.';
  }
}

function getSourceDescription(source: PermissionRuleSource): string {
  switch (source) {
    case 'userSettings':
      return `Configured in ${getUserConfigDisplayPath('settings.json')} (global, applies to all projects)`;
    case 'projectSettings':
      return `Configured in ${CONFIG_DIR}/settings.json (shared with team, checked into git)`;
    case 'localSettings':
      return `Configured in ${CONFIG_DIR}/settings.local.json (local only, gitignored)`;
    case 'flagSettings':
      return 'Loaded from a file specified via --settings <path> at startup';
    case 'policySettings':
      return 'Configured by enterprise managed-settings.json (organization policy)';
    case 'cliArg':
      return 'Passed via --allowed-tools or --disallowed-tools at startup';
    case 'command':
      return 'Added via /allow or /deny command during this session';
    case 'session':
      return 'Granted interactively during this session (not persisted)';
    default:
      return '';
  }
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Sub-screen for viewing rule details or confirming rule deletion.
 *
 * For policy-managed rules: shows details with "cannot be modified" message.
 * For editable rules: shows delete confirmation dialog with Yes/No.
 */
export function RuleDetails({
  rule,
  onDelete,
  onCancel,
}: RuleDetailsProps): React.JSX.Element {
  const ruleString = permissionRuleValueToString(rule.ruleValue);
  const sourceText = `From ${permissionRuleSourceDisplayString(rule.source)}`;

  const confirmItems = useMemo(
    () => [
      { key: 'yes', label: 'Yes', value: 'yes' as const },
      { key: 'no', label: 'No', value: 'no' as const },
    ],
    [],
  );

  const handleConfirm = useCallback(
    (value: 'yes' | 'no') => {
      if (value === 'yes') {
        onDelete();
      } else {
        onCancel();
      }
    },
    [onDelete, onCancel],
  );

  // Handle Esc key to cancel/go back
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

  const ruleDescription = (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>{ruleString}</Text>
      <PermissionRuleDescription ruleValue={rule.ruleValue} />
      <Text dimColor>{sourceText}</Text>
      <Text dimColor italic>{getSourceDescription(rule.source)}</Text>
    </Box>
  );

  // Read-only rules cannot be modified through the UI
  if (isReadOnlySource(rule.source)) {
    return (
      <Box flexDirection="column">
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.ui.active}
          paddingLeft={1}
          paddingRight={1}
        >
          <Text bold color={theme.ui.active}>
            Rule details
          </Text>
          {ruleDescription}
          <Box marginTop={1}>
            <Text italic>
              {getReadOnlyMessage(rule.source)}
            </Text>
          </Box>
        </Box>
        <Box marginLeft={3}>
          <Text dimColor>Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  // Editable rules — show delete confirmation
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.status.error}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text bold color={theme.status.error}>
          Delete {getRuleBehaviorLabel(rule.ruleBehavior)} tool?
        </Text>
        {ruleDescription}
        <Box marginTop={1}>
          <Text>Are you sure you want to delete this permission rule?</Text>
        </Box>
        <RadioButtonSelect
          items={confirmItems}
          onSelect={handleConfirm}
          isFocused={true}
        />
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
