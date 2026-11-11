/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure functions that produce the radio-select options for each
 * ToolConfirmationMessage type. Extracted from the component so they
 * can be unit-tested without rendering React.
 */

import {
  type SerializableConfirmationDetails,
  ToolConfirmationOutcome,
} from '@qwen-code/core';
import type { RadioSelectItem } from '../shared/RadioButtonSelect.js';
import { safeHostname } from '../../utils/urlSecurityUtils.js';

/**
 * Sentinel value used for "Type Something" / "Refuse and say something"
 * options. The component intercepts this before it reaches the confirm handler.
 */
export const TYPE_SOMETHING_VALUE =
  '__type_something__' as unknown as ToolConfirmationOutcome;
export const VIEW_WORKFLOW_SCRIPT_VALUE =
  '__view_workflow_script__' as unknown as ToolConfirmationOutcome;

// ─── Per-type option builders ────────────────────────────────────────────────

/** Shared sublabel for all ProceedPersist options. */
const PERSIST_SUBLABEL =
  'Save a permanent allow rule to your local settings file.';

function getEditOptions(
  details: Extract<SerializableConfirmationDetails, { type: 'edit' }>,
): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  if (details.isModifying) return [];

  return [
    {
      label: 'Allow once',
      sublabel: 'Approve this file edit for the current request only.',
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Allow once',
    },
    {
      label: 'Allow for this session',
      sublabel: 'Approve all file edits without asking until you exit.',
      value: ToolConfirmationOutcome.ProceedSession,
      key: 'Allow for this session',
    },
    {
      label: 'Modify with external editor',
      sublabel: 'Open the proposed changes in your editor to review or adjust.',
      value: ToolConfirmationOutcome.ModifyWithEditor,
      key: 'Modify with external editor',
    },
    {
      label: 'Reject and type something',
      sublabel: 'Reject this edit and provide feedback to the model.',
      value: TYPE_SOMETHING_VALUE,
      key: 'Reject and type something',
    },
    {
      label: 'No',
      sublabel: 'Deny this edit without providing feedback.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'No',
    },
  ];
}

function getExecOptions(
  details: Extract<SerializableConfirmationDetails, { type: 'exec' }>,
): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  // A catastrophic-removal finding has no rule that should cover it, so the
  // dialog offers no "always allow".
  const persistOption: Array<RadioSelectItem<ToolConfirmationOutcome>> =
    details.persistable === false
      ? []
      : [
          {
            label: details.isCompound
              ? `Always allow this exact command for future sessions`
              : `Always allow "${details.rootCommand}" for future sessions`,
            sublabel: PERSIST_SUBLABEL,
            value: ToolConfirmationOutcome.ProceedPersist,
            key: 'always-allow-cmd',
          },
        ];
  return [
    {
      label: 'Allow once',
      sublabel: 'Run this command for the current request only.',
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Allow once',
    },
    ...persistOption,
    {
      label: 'Reject and type something',
      sublabel: 'Deny and send a message back to the model.',
      value: TYPE_SOMETHING_VALUE,
      key: 'Reject and type something',
    },
    {
      label: 'No',
      sublabel: 'Deny this command without feedback.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'No',
    },
  ];
}

function getInfoOptions(
  details: Extract<SerializableConfirmationDetails, { type: 'info' }>,
): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  // Auto-mode circuit breaker: a plain proceed/don't-proceed gate, matching the
  // reference breaker dialog which offers only continue/stop.
  if (details.kind === 'auto_mode_breaker') {
    return [
      {
        label: 'Yes',
        sublabel: 'Reset the denial count and allow this action.',
        value: ToolConfirmationOutcome.ProceedOnce,
        key: 'Yes',
      },
      {
        label: 'No',
        sublabel: 'Deny this action.',
        value: ToolConfirmationOutcome.Cancel,
        key: 'No',
      },
    ];
  }

  const isWebFetch = details.urls && details.urls.length > 0;
  const options: Array<RadioSelectItem<ToolConfirmationOutcome>> = [];

  if (isWebFetch) {
    const hostname = safeHostname(details.urls![0]);
    options.push(
      {
        label: 'Allow once',
        sublabel: 'Approve this tool call for the current request only.',
        value: ToolConfirmationOutcome.ProceedOnce,
        key: 'Allow once',
      },
      {
        label: `Always allow "${hostname}" for future sessions`,
        sublabel: PERSIST_SUBLABEL,
        value: ToolConfirmationOutcome.ProceedPersist,
        key: 'always-allow-host',
      },
    );
  } else {
    options.push(
      {
        label: 'Allow once',
        sublabel: 'Approve this tool call for the current request only.',
        value: ToolConfirmationOutcome.ProceedOnce,
        key: 'Allow once',
      },
      {
        label: 'Allow for this session',
        sublabel:
          'Approve this tool without asking for the rest of the session.',
        value: ToolConfirmationOutcome.ProceedSession,
        key: 'allow-read-session',
      },
    );
  }

  options.push(
    {
      label: 'Reject and type something',
      sublabel: 'Deny and send a message back to the model.',
      value: TYPE_SOMETHING_VALUE,
      key: 'Reject and type something',
    },
    {
      label: 'No',
      sublabel: 'Deny this tool call without feedback.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'No',
    },
  );

  return options;
}

function getMcpOptions(
  details: Extract<SerializableConfirmationDetails, { type: 'mcp' }>,
): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  return [
    {
      label: 'Allow once',
      sublabel: 'Approve this MCP tool call for the current request only.',
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Allow once',
    },
    {
      label: `Always allow "${details.toolDisplayName}" for future sessions`,
      sublabel: PERSIST_SUBLABEL,
      value: ToolConfirmationOutcome.ProceedPersist,
      key: 'always-allow-tool',
    },
    {
      label: 'Reject and type something',
      sublabel: 'Deny and send a message back to the model.',
      value: TYPE_SOMETHING_VALUE,
      key: 'Reject and type something',
    },
    {
      label: 'No',
      sublabel: 'Deny this MCP tool call without feedback.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'No',
    },
  ];
}

function getFileReadOptions(): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  return [
    {
      label: 'Allow once',
      sublabel: 'Approve this tool call for the current request only.',
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Allow once',
    },
    {
      label: 'Allow for this session',
      sublabel: 'Approve this tool without asking for the rest of the session.',
      value: ToolConfirmationOutcome.ProceedSession,
      key: 'allow-read-session',
    },
    {
      label: 'Reject and type something',
      sublabel: 'Deny and send a message back to the model.',
      value: TYPE_SOMETHING_VALUE,
      key: 'Reject and type something',
    },
    {
      label: 'No',
      sublabel: 'Deny this tool call without feedback.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'No',
    },
  ];
}

function getWorkflowOptions(): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  return [
    {
      label: 'Run',
      sublabel: 'Run this workflow for the current request only.',
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Run',
    },
    {
      label: 'View raw script',
      sublabel: 'Show the full workflow script before deciding.',
      value: VIEW_WORKFLOW_SCRIPT_VALUE,
      key: 'workflow-script-toggle',
    },
    {
      label: 'Reject and type something',
      sublabel: 'Deny and send a message back to the model.',
      value: TYPE_SOMETHING_VALUE,
      key: 'Reject and type something',
    },
    {
      label: 'No',
      sublabel: 'Deny this workflow without feedback.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'No',
    },
  ];
}

function getRepeatedToolCallOptions(): Array<
  RadioSelectItem<ToolConfirmationOutcome>
> {
  return [
    {
      label: 'Continue once',
      sublabel: 'Allow this repeated tool call one time.',
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Continue once',
    },
    {
      label: 'Always continue this exact call',
      sublabel:
        'Allow this exact tool input again during this session only.',
      value: ToolConfirmationOutcome.ProceedSession,
      key: 'Always continue this exact call',
    },
    {
      label: 'Stop',
      sublabel: 'Deny this repeated call and stop the current request.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'Stop',
    },
  ];
}

/**
 * Generation is billed by actual usage and the server has no cancel, so the
 * list is deliberately short and offers no remember-scope: silently skipping
 * future cost confirmations is not a shortcut this dialog should hand out.
 */
function getVideoOptions(): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  return [
    {
      label: 'Generate',
      sublabel: 'Submit this generation; billed by actual usage.',
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Generate',
    },
    {
      label: 'Reject and type something',
      sublabel: 'Deny and send a message back to the model.',
      value: TYPE_SOMETHING_VALUE,
      key: 'Reject and type something',
    },
    {
      label: 'No',
      sublabel: 'Deny this generation without feedback.',
      value: ToolConfirmationOutcome.Cancel,
      key: 'No',
    },
  ];
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Returns the radio-select options for a given confirmation type.
 *
 * This is a pure function with no React dependencies — it can be called
 * inside `useCallback` / `useMemo` or tested directly.
 */
export function getConfirmationOptions(
  details: SerializableConfirmationDetails,
): Array<RadioSelectItem<ToolConfirmationOutcome>> {
  switch (details.type) {
    case 'edit':
      return getEditOptions(details);
    case 'exec':
      return getExecOptions(details);
    case 'info':
      return getInfoOptions(details);
    case 'file_read':
      return getFileReadOptions();
    case 'workflow':
      return getWorkflowOptions();
    case 'repeated_tool_call':
      return getRepeatedToolCallOptions();
    case 'video':
      return getVideoOptions();
    case 'mcp':
      return getMcpOptions(details);
    // These two render their own dialogs (see isOwnUITool), so no radio list is
    // shown for them: an empty option set is the correct answer, not a gap.
    case 'AskUserQuestion':
    case 'ExitPlanMode':
      return [];
    default: {
      // Exhaustiveness, not a fallback: an unhandled details type renders a
      // dialog with a body and no actions, i.e. one the user cannot answer.
      // Every union member is handled above, so this binds `never` today and
      // becomes a type error the moment a new type lands without options.
      const unhandled: never = details;
      void unhandled;
      return [];
    }
  }
}
