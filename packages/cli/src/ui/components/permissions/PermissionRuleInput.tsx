/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type {
  PermissionBehavior,
  PermissionRuleValue,
  PermissionRules,
} from '@qwen-code/core';
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
  getAllowRules,
  getDenyRules,
  getAskRules,
} from '@qwen-code/core';
import { InputField } from '../shared/InputField.js';
import { useSearchBuffer } from '../../hooks/useSearchBuffer.js';
import { useCompletion } from '../../hooks/useCompletion.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { SuggestionsDisplay, type Suggestion } from '../SuggestionsDisplay.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { theme } from '../../semantic-colors.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PermissionRuleInputProps {
  onCancel: () => void;
  onSubmit: (
    ruleValue: PermissionRuleValue,
    ruleBehavior: PermissionBehavior,
  ) => void;
  ruleBehavior: PermissionBehavior;
  rules?: PermissionRules;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Sub-screen for entering a new permission rule.
 *
 * Shows a text input where the user types a rule string like "Bash(npm install:*)"
 * or "WebFetch". On submit, parses the rule and calls onSubmit.
 * Displays a filtered list of registered tool names as the user types.
 */
export function PermissionRuleInput({
  onCancel,
  onSubmit,
  ruleBehavior,
  rules,
}: PermissionRuleInputProps): React.JSX.Element {
  const config = useConfig();
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  // All registered tool names as suggestion source
  const allToolNames = useMemo(
    () => config.getToolRegistry()?.getAllToolNames() ?? [],
    [config],
  );

  // Existing rules for duplicate detection
  const existingRuleStrings = useMemo(() => {
    if (!rules) return new Set<string>();
    const getRules =
      ruleBehavior === 'allow'
        ? getAllowRules
        : ruleBehavior === 'deny'
          ? getDenyRules
          : getAskRules;
    return new Set(
      getRules(rules).map((r) =>
        permissionRuleValueToString(r.ruleValue),
      ),
    );
  }, [rules, ruleBehavior]);

  const buffer = useSearchBuffer({
    initialText: '',
    onChange: () => {},
  });

  // Completion state for tool name suggestions
  const completion = useCompletion();

  // The TextInput child consumes Enter before this component's keypress
  // handler can, so the highlighted suggestion must be resolved inside the
  // submit callback — otherwise typing "web" and picking "webSearch" would
  // write the fragment "web" as the rule.
  const completionRef = useRef(completion);
  completionRef.current = completion;

  const handleSubmit = useCallback(
    (value: string) => {
      const completionSnapshot = completionRef.current;
      const activeIdx = completionSnapshot.activeSuggestionIndex;
      const picked =
        activeIdx >= 0 && activeIdx < completionSnapshot.suggestions.length
          ? completionSnapshot.suggestions[activeIdx].value
          : value;
      const trimmedValue = picked.trim();
      if (trimmedValue.length === 0) {
        return;
      }
      // Check for duplicate
      if (existingRuleStrings.has(trimmedValue)) {
        setDuplicateWarning(`Rule already exists: ${trimmedValue}`);
        return;
      }
      setDuplicateWarning(null);
      const ruleValue = permissionRuleValueFromString(trimmedValue);
      onSubmit(ruleValue, ruleBehavior);
    },
    [onSubmit, ruleBehavior, existingRuleStrings],
  );

  // Filter suggestions based on current input
  useEffect(() => {
    const input = buffer.text.trim();
    // Don't show suggestions when input is empty or after '(' (specifier phase)
    if (input.length === 0 || input.indexOf('(') >= 0) {
      completion.setSuggestions([]);
      completion.setActiveSuggestionIndex(-1);
      return;
    }

    const lower = input.toLowerCase();
    const filtered: Suggestion[] = allToolNames
      .filter((name) => {
        // Case-insensitive prefix match
        if (name.toLowerCase().startsWith(lower)) return true;
        // Camel-case initials match (e.g. "rf" matches "ReadFile")
        const initials = name.replace(/[^A-Z]/g, '').toLowerCase();
        if (initials.startsWith(lower)) return true;
        // Substring match
        if (name.toLowerCase().includes(lower)) return true;
        return false;
      })
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 8)
      .map((name) => ({ label: name, value: name }));

    completion.setSuggestions(filtered);
    completion.setActiveSuggestionIndex(-1);
    // The completion object is rebuilt every render, so depending on it would
    // re-run this on every keystroke whether or not the input changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer.text, allToolNames]);

  // Keyboard: ↑↓ navigate suggestions, Tab completes
  useKeypress(
    useCallback(
      (key: Key) => {
        if (completion.suggestions.length === 0) return false;

        if (key.name === 'up') {
          completion.navigateUp();
          return true;
        }
        if (key.name === 'down') {
          completion.navigateDown();
          return true;
        }
        if (key.name === 'tab') {
          const idx = completion.activeSuggestionIndex;
          const targetIdx = idx >= 0 ? idx : 0;
          if (targetIdx < completion.suggestions.length) {
            buffer.setText(completion.suggestions[targetIdx].value);
          }
          return true;
        }
        return false;
      },
      [completion, buffer],
    ),
    { isActive: true },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingLeft={1}
      paddingRight={1}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.ui.active}>
          Add {ruleBehavior} permission rule
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text>
          Permission rules are a tool name, optionally followed by a specifier
          in parentheses.
        </Text>
        <Text>
          e.g., <Text bold>WebFetch</Text> or <Text bold>Bash(ls:*)</Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <InputField
          buffer={buffer}
          placeholder="Enter permission rule…"
          onSubmit={handleSubmit}
          onCancel={onCancel}
        />
      </Box>

      {duplicateWarning && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>{duplicateWarning}</Text>
        </Box>
      )}

      {completion.suggestions.length > 0 && (
        <Box marginTop={1}>
          <SuggestionsDisplay
            suggestions={completion.suggestions}
            activeIndex={completion.activeSuggestionIndex}
            isLoading={false}
            width={40}
            scrollOffset={completion.visibleStartIndex}
            userInput={buffer.text}
            mode="slash"
          />
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Enter to submit · ↑↓ navigate · Tab to complete · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
