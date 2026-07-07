/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallConfirmationDetails } from '@qwen-code/qwen-code-core';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import type {
  PermissionOption,
  ToolCallContent,
} from '@agentclientprotocol/sdk';

const basicPermissionOptions = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
] as const satisfies readonly PermissionOption[];

function supportsHideAlwaysAllow(
  confirmation: ToolCallConfirmationDetails,
): confirmation is Exclude<
  ToolCallConfirmationDetails,
  { type: 'ask_user_question' }
> {
  return confirmation.type !== 'ask_user_question';
}

function filterAlwaysAllowOptions(
  confirmation: ToolCallConfirmationDetails,
  options: PermissionOption[],
  forceHideAlwaysAllow = false,
): PermissionOption[] {
  const hideAlwaysAllow =
    forceHideAlwaysAllow ||
    (supportsHideAlwaysAllow(confirmation) &&
      confirmation.hideAlwaysAllow === true);
  return hideAlwaysAllow
    ? options.filter((option) => option.kind !== 'allow_always')
    : options;
}

function formatExecPermissionScopeLabel(
  confirmation: Extract<ToolCallConfirmationDetails, { type: 'exec' }>,
): string {
  const permissionRules = confirmation.permissionRules ?? [];
  const bashRules = permissionRules
    .map((rule) => {
      const match = /^Bash\((.*)\)$/.exec(rule.trim());
      return match?.[1]?.trim() || undefined;
    })
    .filter((rule): rule is string => Boolean(rule));

  const uniqueRules = [...new Set(bashRules)];
  if (uniqueRules.length === 1) {
    return uniqueRules[0];
  }
  if (uniqueRules.length > 1) {
    return uniqueRules.join(', ');
  }
  return confirmation.rootCommand;
}

export function buildPermissionRequestContent(
  confirmation: ToolCallConfirmationDetails,
): ToolCallContent[] {
  const content: ToolCallContent[] = [];

  if (confirmation.type === 'edit') {
    content.push({
      type: 'diff',
      path: confirmation.filePath ?? confirmation.fileName,
      oldText: confirmation.originalContent ?? '',
      newText: confirmation.newContent,
    });
  }

  if (confirmation.type === 'plan') {
    content.push({
      type: 'content',
      content: {
        type: 'text',
        text: confirmation.plan,
      },
    });
  }

  return content;
}

export function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
  forceHideAlwaysAllow = false,
): PermissionOption[] {
  switch (confirmation.type) {
    case 'edit':
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlways,
            name: 'Allow All Edits',
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    case 'exec': {
      const label = formatExecPermissionScopeLabel(confirmation);
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: `Always Allow in project: ${label}`,
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
            name: `Always Allow for user: ${label}`,
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    }
    case 'mcp':
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: `Always Allow in project: ${confirmation.toolName}`,
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
            name: `Always Allow for user: ${confirmation.toolName}`,
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    case 'info':
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Always Allow in project',
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
            name: 'Always Allow for user',
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    case 'plan':
      return [
        {
          optionId: ToolConfirmationOutcome.RestorePrevious,
          name: `Yes, restore previous mode (${confirmation.prePlanMode ?? 'default'})`,
          kind: 'allow_once',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Yes, and auto-accept edits',
          kind: 'allow_always',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          name: 'Yes, and manually approve edits',
          kind: 'allow_once',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          name: 'No, keep planning (esc)',
          kind: 'reject_once',
        },
      ];
    case 'ask_user_question':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          name: 'Submit',
          kind: 'allow_once',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          name: 'Cancel',
          kind: 'reject_once',
        },
      ];
    default: {
      const unreachable: never = confirmation;
      throw new Error(`Unexpected: ${unreachable}`);
    }
  }
}
