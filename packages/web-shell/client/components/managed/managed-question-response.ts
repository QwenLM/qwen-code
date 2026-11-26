import { sha256 } from '@noble/hashes/sha256';
import type {
  ManagedAgentPendingQuestionAction,
  ManagedAgentQuestionAnswer,
} from './managed-agent-provider';

export const MAX_MANAGED_QUESTION_ANSWER_BYTES = 32 * 1024;
export const MAX_MANAGED_QUESTION_TEXT_LENGTH = 8192;

export type ManagedQuestionDraft = Record<
  string,
  { optionIds: string[]; text: string }
>;

export function managedQuestionAnswersFromDraft(
  action: ManagedAgentPendingQuestionAction,
  draft: ManagedQuestionDraft,
): ManagedAgentQuestionAnswer[] {
  return action.questions.flatMap((question) => {
    const entry = draft[question.id];
    const optionIds = question.options
      .filter((option) => entry?.optionIds.includes(option.id))
      .map((option) => option.id);
    const text = entry?.text;
    if (!optionIds.length && !text?.trim()) return [];
    return [
      {
        questionId: question.id,
        ...(optionIds.length ? { optionIds } : {}),
        ...(text?.trim() ? { text } : {}),
      },
    ];
  });
}

export function exceedsManagedQuestionAnswerLimits(
  answers: readonly ManagedAgentQuestionAnswer[],
): boolean {
  return (
    answers.some(
      (answer) => (answer.text?.length ?? 0) > MAX_MANAGED_QUESTION_TEXT_LENGTH,
    ) ||
    new TextEncoder().encode(JSON.stringify(answers)).byteLength >
      MAX_MANAGED_QUESTION_ANSWER_BYTES
  );
}

export function canonicalQuestionAnswers(
  action: ManagedAgentPendingQuestionAction,
  answers: readonly ManagedAgentQuestionAnswer[],
): ManagedAgentQuestionAnswer[] {
  const questionOrder = new Map(
    action.questions.map((question, index) => [question.id, index]),
  );
  const ordered = answers.map((answer) => {
    const question = action.questions.find(
      (candidate) => candidate.id === answer.questionId,
    );
    const optionOrder = new Map(
      question?.options.map((option, index) => [option.id, index]),
    );
    return {
      questionId: answer.questionId,
      ...(answer.optionIds === undefined
        ? {}
        : {
            optionIds: [...answer.optionIds].sort(
              (a, b) =>
                (optionOrder.get(a) ?? Infinity) -
                (optionOrder.get(b) ?? Infinity),
            ),
          }),
      ...(answer.text === undefined ? {} : { text: answer.text }),
    };
  });
  ordered.sort(
    (a, b) =>
      (questionOrder.get(a.questionId) ?? Infinity) -
      (questionOrder.get(b.questionId) ?? Infinity),
  );
  if (
    new TextEncoder().encode(JSON.stringify(ordered)).byteLength >
    MAX_MANAGED_QUESTION_ANSWER_BYTES
  ) {
    throw Object.assign(new Error('Question answers exceed 32 KiB'), {
      code: 'question_answer_too_large',
    });
  }
  return ordered;
}

export function questionResponseKey(
  action: ManagedAgentPendingQuestionAction,
  answers: readonly ManagedAgentQuestionAnswer[],
): string {
  const digest = sha256(
    new TextEncoder().encode(
      JSON.stringify([
        action.sessionId,
        action.actionId,
        action.inputRevision,
        action.policyRevision,
        answers,
      ]),
    ),
  );
  return `question:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}
