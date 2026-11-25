/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import type { PermissionRuleValue } from '@qwen-code/core';

interface PermissionRuleDescriptionProps {
  ruleValue: PermissionRuleValue;
}

/**
 * Renders a human-readable description for a permission rule value.
 *
 * Examples:
 * - Bash + "npm install:*" → "Any Bash command starting with npm install"
 * - Bash + "npm install" → "The Bash command npm install"
 * - Bash (no content) → "Any Bash command"
 * - Write (no content) → "Any use of the Write tool"
 */
export function PermissionRuleDescription({
  ruleValue,
}: PermissionRuleDescriptionProps): React.JSX.Element | null {
  if (ruleValue.toolName === 'Bash') {
    if (ruleValue.ruleContent) {
      if (ruleValue.ruleContent.endsWith(':*')) {
        const prefix = ruleValue.ruleContent.slice(0, -2);
        return (
          <Text dimColor>
            Any Bash command starting with <Text bold>{prefix}</Text>
          </Text>
        );
      } else {
        return (
          <Text dimColor>
            The Bash command <Text bold>{ruleValue.ruleContent}</Text>
          </Text>
        );
      }
    } else {
      return <Text dimColor>Any Bash command</Text>;
    }
  }

  // For non-Bash tools without ruleContent
  if (!ruleValue.ruleContent) {
    return (
      <Text dimColor>
        Any use of the <Text bold>{ruleValue.toolName}</Text> tool
      </Text>
    );
  }

  // For non-Bash tools with ruleContent (e.g., Read with path patterns)
  return null;
}
