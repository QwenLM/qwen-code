/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ASK_USER_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../base-declarations.js';

const OPTION_USAGE_NOTES = `- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`;

/**
 * Returns the description for `AskUserQuestion`.
 */
export function getAskUserDescription(asyncUserInteraction = false): string {
  const availability = asyncUserInteraction
    ? 'This tool is only available in Plan mode. Outside Plan mode, use AskUserQuestionAsync; calls to this tool will be rejected without asking the user.'
    : "Outside Plan mode, use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.";
  return `In Plan mode, use this tool to clarify requirements and compare approaches before finalizing the plan; you do not need to wait until all independent work is blocked. ${availability}

Usage notes:
${OPTION_USAGE_NOTES}

Plan mode note: To switch into plan mode, use ${ENTER_PLAN_MODE_TOOL_NAME} (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ${EXIT_PLAN_MODE_TOOL_NAME} for approval.
`;
}

/** Stable guidance when asynchronous questions are available, also used by Plan reminders. */
export function getAskUserPlanPreferenceNote(): string {
  return `
In Plan mode, strongly prefer ${ASK_USER_TOOL_NAME} to clarify requirements and choose
between approaches. It waits for the host's response, which may contain answers
or no answer. An empty result is not a user choice or approval.
If no answer is returned, do not repeatedly ask the same question. Continue with
reasonable assumptions where possible; otherwise explain the missing prerequisite.
Use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval and the existing permission flow for approvals.
`;
}

/**
 * Returns the description for `AskUserQuestionAsync`.
 */
export function getAskUserAsyncDescription(): string {
  return `Ask the user one or more questions during ongoing work. Use this tool only to
request missing information, preferences, constraints, or clarification. The tool
returns immediately without ending the turn or waiting for a reply; any reply
arrives asynchronously as a new user message. Keep questions concise,
self-contained, and easy to understand, using a level of detail appropriate to
the user and task. The user can always provide a free-text answer, including when
suggested options are provided. A recommended option is not submitted automatically.

Host-formatted replies use <ask_user_reply> with toolUseId and an answers array.
Each answer includes questionIndex (zero-based in the original questions array),
question text, and answer, with optional notes. Match by toolUseId and questionIndex;
a reply may answer only some questions. Ordinary free-text messages may also answer
questions; do not require this envelope from the user.
Use the existing permission and plan-approval flows for approvals.

Usage notes:
${OPTION_USAGE_NOTES}
`;
}

/** Stable conditional guidance; entering Plan must not change the tool schema. */
export function getAskUserAsyncPlanNote(): string {
  return `
In Plan mode, strongly prefer ${ASK_USER_TOOL_NAME} for clarification and decisions.
`;
}

/**
 * Returns the description for `Sleep`.
 */
export function getSleepDescription(): string {
  return `Pause execution for duration_ms. The sleep ends early when input eligible for
the current turn arrives, including a queued user message or task notification.
Returns elapsedMs (actual elapsed wall-clock time) and reason (input or timeout).
`;
}
