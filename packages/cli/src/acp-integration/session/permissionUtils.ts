/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallConfirmationDetails } from '@qwen-code/qwen-code-core';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
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

export interface PermissionPersistencePolicy {
  readonly allowProjectPersistence: boolean;
  readonly allowUserPersistence: boolean;
}

function filterPermissionPersistenceOptions(
  options: PermissionOption[],
  policy: PermissionPersistencePolicy | undefined,
): PermissionOption[] {
  if (!policy) return options;
  return options.filter((option) => {
    if (
      option.optionId === ToolConfirmationOutcome.ProceedAlwaysProject &&
      !policy.allowProjectPersistence
    ) {
      return false;
    }
    if (
      option.optionId === ToolConfirmationOutcome.ProceedAlwaysUser &&
      !policy.allowUserPersistence
    ) {
      return false;
    }
    return true;
  });
}

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
    confirmation.autoModeFallback !== undefined ||
    (supportsHideAlwaysAllow(confirmation) &&
      confirmation.hideAlwaysAllow === true);
  const visibleOptions = hideAlwaysAllow
    ? options.filter((option) => option.kind !== 'allow_always')
    : options;
  if (
    confirmation.autoModeFallback?.reason !== 'classifier_unavailable' &&
    confirmation.autoModeFallback?.reason !== 'consecutive_unavailable'
  ) {
    return visibleOptions;
  }

  const switchOption: PermissionOption = {
    optionId: ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
    name: 'Switch to Default Mode and allow once (recommended)',
    kind: 'allow_once',
  };
  const rejectIndex = visibleOptions.findIndex(
    (option) => option.kind === 'reject_once',
  );
  if (rejectIndex === -1) return [...visibleOptions, switchOption];
  return [
    ...visibleOptions.slice(0, rejectIndex),
    switchOption,
    ...visibleOptions.slice(rejectIndex),
  ];
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

/** Metadata that lets daemon session polling distinguish questions from tools. */
export function interactionMetaFields(
  confirmation: ToolCallConfirmationDetails,
): Record<string, unknown> {
  return confirmation.type === 'ask_user_question'
    ? {
        qwenInteractionKind: 'user_question',
        qwenQuestions: confirmation.questions,
      }
    : {};
}

export function buildPermissionRequestContent(
  confirmation: ToolCallConfirmationDetails,
): ToolCallContent[] {
  const content: ToolCallContent[] = [];

  if (confirmation.autoModeFallback) {
    content.push({
      type: 'content',
      content: {
        type: 'text',
        text: confirmation.autoModeFallback.message,
      },
    });
  }

  const warnings =
    confirmation.type === 'exec' || confirmation.type === 'edit'
      ? (confirmation.warnings ?? [])
      : [];
  for (const warning of warnings) {
    content.push({
      type: 'content',
      content: { type: 'text', text: warning },
    });
  }

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

  if (confirmation.type === 'info' && confirmation.renderPromptAsPlainText) {
    content.push({
      type: 'content',
      content: { type: 'text', text: confirmation.prompt },
    });
  }

  // A conforming client is told to ignore `_meta`, so the questions must be
  // readable in the standard content channel rather than only in the raw
  // JSON payload. This is what a plain ACP host (e.g. Zed) renders. Nested
  // sub-agent events may carry a partial question, so read defensively.
  if (confirmation.type === 'ask_user_question') {
    for (const question of confirmation.questions) {
      const lines: string[] = [];
      if (question.header) lines.push(question.header);
      if (question.question) lines.push(question.question);
      for (const option of question.options ?? []) {
        lines.push(`• ${option.label} — ${option.description}`);
      }
      content.push({
        type: 'content',
        content: { type: 'text', text: lines.join('\n') },
      });
    }
  }

  return content;
}

function permissionAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Permission request was aborted.');
}

export function requestPermissionWithAbort(
  client: Pick<AgentSideConnection, 'requestPermission'>,
  params: RequestPermissionRequest,
  signal: AbortSignal,
): Promise<RequestPermissionResponse> {
  if (signal.aborted) {
    return Promise.reject(permissionAbortError(signal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(permissionAbortError(signal)));

    signal.addEventListener('abort', onAbort, { once: true });
    let request: Promise<RequestPermissionResponse>;
    try {
      request = client.requestPermission(params);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    request.then(
      (response) => finish(() => resolve(response)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * ACP has no structured-choice primitive, so when the client does not
 * understand `_meta.qwenQuestions` we flatten a single `ask_user_question`
 * into one `PermissionOption` per choice. The option id encodes which
 * question and choice it stands for; the label is recovered from the request.
 */
const ASK_USER_QUESTION_OPTION_PREFIX = 'ask:';
const ASK_USER_QUESTION_OTHER_TOKEN = 'other';
/**
 * Answer recorded when the user picks the synthetic `Other…` choice. Free
 * text cannot travel through a `PermissionOption`, so the model receives a
 * parenthesised marker instead of a concrete answer.
 */
export const ASK_USER_QUESTION_OTHER_ANSWER = '(Other)';
/**
 * `_meta` key a client may use to return structured answers on the
 * `RequestPermissionResponse`, as an alternative to the top-level `answers`
 * sibling. `_meta` is a legal ACP response field, so an opt-in client can
 * ride it without inventing a new tool response shape.
 */
export const ASK_USER_QUESTION_ANSWERS_META_KEY = 'qwenAnswers';

interface ParsedAskUserQuestionOptionId {
  readonly questionIndex: number;
  /** Undefined for the synthetic `Other…` choice. */
  readonly optionIndex?: number;
}

function encodeAskUserQuestionOptionId(
  questionIndex: number,
  choice: number | typeof ASK_USER_QUESTION_OTHER_TOKEN,
): string {
  return `${ASK_USER_QUESTION_OPTION_PREFIX}q${questionIndex}:${
    choice === ASK_USER_QUESTION_OTHER_TOKEN ? choice : `o${choice}`
  }`;
}

function parseAskUserQuestionOptionId(
  optionId: unknown,
): ParsedAskUserQuestionOptionId | undefined {
  if (typeof optionId !== 'string') return undefined;
  const match = /^ask:q(\d+):(?:o(\d+)|(other))$/.exec(optionId);
  if (!match) return undefined;
  return match[2] !== undefined
    ? { questionIndex: Number(match[1]), optionIndex: Number(match[2]) }
    : { questionIndex: Number(match[1]) };
}

/**
 * Decides whether a confirmation can be projected onto a flat option list.
 * One question is unambiguous; two or more would interleave choices from
 * different questions in a single select, so those keep the generic pair.
 */
function canFlattenAskUserQuestion(
  confirmation: ToolCallConfirmationDetails,
): confirmation is Extract<
  ToolCallConfirmationDetails,
  { type: 'ask_user_question' }
> {
  return (
    confirmation.type === 'ask_user_question' &&
    confirmation.questions.length === 1
  );
}

function buildAskUserQuestionOptions(
  confirmation: Extract<
    ToolCallConfirmationDetails,
    { type: 'ask_user_question' }
  >,
): PermissionOption[] {
  const question = confirmation.questions[0]!;
  return [
    ...(question.options ?? []).map<PermissionOption>(
      (option, optionIndex) => ({
        optionId: encodeAskUserQuestionOptionId(0, optionIndex),
        name: option.label,
        kind: 'allow_once',
      }),
    ),
    {
      optionId: encodeAskUserQuestionOptionId(0, ASK_USER_QUESTION_OTHER_TOKEN),
      name: 'Other…',
      kind: 'allow_once',
    },
    {
      optionId: ToolConfirmationOutcome.Cancel,
      name: 'Cancel',
      kind: 'reject_once',
    },
  ];
}

export function resolvePermissionOutcome(
  response: RequestPermissionResponse,
  offeredOptions: readonly PermissionOption[],
  allowEncodedOptionIds = false,
): ToolConfirmationOutcome {
  if (response.outcome.outcome === 'cancelled') {
    return ToolConfirmationOutcome.Cancel;
  }

  const optionId = response.outcome.optionId;
  if (!offeredOptions.some((option) => option.optionId === optionId)) {
    throw new Error(
      `Permission response selected unoffered option: ${optionId}`,
    );
  }
  if (allowEncodedOptionIds && parseAskUserQuestionOptionId(optionId)) {
    return ToolConfirmationOutcome.ProceedOnce;
  }
  if (
    !Object.values(ToolConfirmationOutcome).includes(
      optionId as ToolConfirmationOutcome,
    )
  ) {
    throw new Error(`Permission response selected invalid option: ${optionId}`);
  }
  return optionId as ToolConfirmationOutcome;
}

/**
 * Recovers the answer map for a flattened `ask_user_question` from the
 * selected option id. Returns undefined for unencoded ids (a capable client
 * answers through the private `answers` channel instead).
 */
export function resolveAskUserQuestionAnswers(
  confirmation: ToolCallConfirmationDetails,
  optionId: string | undefined,
): Record<string, string> | undefined {
  if (confirmation.type !== 'ask_user_question' || optionId === undefined) {
    return undefined;
  }
  const parsed = parseAskUserQuestionOptionId(optionId);
  if (!parsed) return undefined;
  const question = confirmation.questions[parsed.questionIndex];
  if (!question) return undefined;
  const key = String(parsed.questionIndex);
  if (parsed.optionIndex === undefined) {
    return { [key]: ASK_USER_QUESTION_OTHER_ANSWER };
  }
  const option = question.options[parsed.optionIndex];
  return option ? { [key]: option.label } : undefined;
}

export function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
  forceHideAlwaysAllow = false,
  persistencePolicy?: PermissionPersistencePolicy,
  flattenStructuredQuestions = false,
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
        filterPermissionPersistenceOptions(
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
          persistencePolicy,
        ),
        forceHideAlwaysAllow,
      );
    }
    case 'mcp':
      return filterAlwaysAllowOptions(
        confirmation,
        filterPermissionPersistenceOptions(
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
          persistencePolicy,
        ),
        forceHideAlwaysAllow,
      );
    case 'info':
      return filterAlwaysAllowOptions(
        confirmation,
        filterPermissionPersistenceOptions(
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
          persistencePolicy,
        ),
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
      if (
        flattenStructuredQuestions &&
        canFlattenAskUserQuestion(confirmation)
      ) {
        return buildAskUserQuestionOptions(confirmation);
      }
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
