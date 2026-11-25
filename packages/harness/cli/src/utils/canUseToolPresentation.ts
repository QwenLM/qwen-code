/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REPEATED_TOOL_CALL_PERMISSION_KIND,
  ToolConfirmationOutcome,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { getConfirmationOptions } from '../ui/components/messages/confirmationOptions.js';

export interface CanUseToolPermissionOption {
  outcome:
    | ToolConfirmationOutcome.ProceedOnce
    | ToolConfirmationOutcome.ProceedSession
    | ToolConfirmationOutcome.ProceedPersist
    | ToolConfirmationOutcome.Cancel;
  name: string;
  allowed: boolean;
}

export interface CanUseToolPresentation {
  permission_kind?: typeof REPEATED_TOOL_CALL_PERMISSION_KIND;
  options?: CanUseToolPermissionOption[];
}

const HEADLESS_CONFIRMATION_OUTCOMES = new Set<ToolConfirmationOutcome>([
  ToolConfirmationOutcome.ProceedOnce,
  ToolConfirmationOutcome.ProceedSession,
  ToolConfirmationOutcome.ProceedPersist,
  ToolConfirmationOutcome.Cancel,
]);

/**
 * Project the existing confirmation policy onto the SDK/headless wire.
 *
 * TUI-only actions such as entering feedback, opening an editor, or viewing a
 * workflow script are deliberately excluded because a remote client cannot
 * perform those local UI actions.
 */
export function getCanUseToolPresentation(
  details: SerializableConfirmationDetails | undefined,
  persistable = true,
): CanUseToolPresentation {
  if (!details) {
    return persistable ? {} : {
      options: [
        { outcome: ToolConfirmationOutcome.ProceedOnce, name: 'Allow once', allowed: true },
        { outcome: ToolConfirmationOutcome.Cancel, name: 'No', allowed: false },
      ],
    };
  }

  const options = getConfirmationOptions(details)
    .filter(
      (option): option is typeof option & { value: CanUseToolPermissionOption['outcome'] } =>
        HEADLESS_CONFIRMATION_OUTCOMES.has(option.value) &&
        (persistable || option.value === ToolConfirmationOutcome.ProceedOnce || option.value === ToolConfirmationOutcome.Cancel),
    )
    .map(
      (option): CanUseToolPermissionOption => ({
        outcome: option.value,
        name: option.label,
        allowed: option.value !== ToolConfirmationOutcome.Cancel,
      }),
    );

  return {
    ...(details.type === REPEATED_TOOL_CALL_PERMISSION_KIND
      ? { permission_kind: REPEATED_TOOL_CALL_PERMISSION_KIND }
      : {}),
    ...(options.length > 0 ? { options } : {}),
  };
}
