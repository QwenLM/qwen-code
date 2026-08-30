import type {
  ChannelUserInputRequestContext,
  ChannelUserQuestion,
} from '@qwen-code/channel-base';

export type FeishuQuestionTerminalState =
  | 'processing'
  | 'submitted'
  | 'cancelled'
  | 'expired';

export type FeishuQuestionAction =
  | {
      kind: 'submit';
      requestId: string;
      operatorId?: string;
      chatId?: string;
      messageId?: string;
      formValue?: Record<string, unknown>;
    }
  | {
      kind: 'cancel';
      requestId: string;
      operatorId?: string;
      chatId?: string;
      messageId?: string;
    }
  | { kind: 'unhandled' };

export const terminalLabels: Record<FeishuQuestionTerminalState, string> = {
  processing: '正在处理...',
  submitted: '已提交',
  cancelled: '已取消',
  expired: '已过期',
};

export function buildQuestionCard(
  context: Pick<ChannelUserInputRequestContext, 'requestId' | 'questions'>,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  for (const question of context.questions) {
    const descriptions = question.options
      .map((option) => `> **${option.label}**: ${option.description}`)
      .join('\n');
    elements.push({
      tag: 'markdown',
      text_size: 'notation',
      content: `**${question.header}**\n> ${question.question}\n\n${descriptions}`,
    });
    elements.push({
      tag: question.multiSelect ? 'multi_select_static' : 'select_static',
      name: question.answerKey,
      options: question.options.map((option) => ({
        text: { tag: 'plain_text', content: option.label },
        value: option.label,
      })),
    });
  }

  elements.push(
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '提交' },
      type: 'primary',
      name: `qwen_ask_submit_${context.requestId}`,
      form_action_type: 'submit',
      value: {
        action: 'qwen_ask_submit',
        operation_id: context.requestId,
      },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '取消' },
      name: `qwen_ask_cancel_${context.requestId}`,
      value: {
        action: 'qwen_ask_cancel',
        operation_id: context.requestId,
      },
    },
  );

  return {
    schema: '2.0',
    body: { elements: [{ tag: 'form', name: 'qwen_ask_form', elements }] },
  };
}

export function buildQuestionTerminalCard(
  questions: ChannelUserQuestion[],
  state: FeishuQuestionTerminalState,
  answers?: Record<string, string>,
): Record<string, unknown> {
  const details = questions
    .map((question) => {
      const answer = answers?.[question.answerKey];
      return answer
        ? `**${question.header}**\n${answer}`
        : `**${question.header}**\n${question.question}`;
    })
    .join('\n\n');

  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**${terminalLabels[state]}**\n\n${details}`,
        },
      ],
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function parseQuestionAction(data: unknown): FeishuQuestionAction {
  const payload = record(data);
  const action = record(payload?.['action']);
  const rawValue = action?.['value'];
  const value = record(rawValue);
  let requestId = nonEmptyString(value?.['operation_id']);
  let actionId = nonEmptyString(value?.['action']);
  const name = action?.['name'];

  if (
    rawValue === undefined &&
    typeof name === 'string' &&
    name.startsWith('qwen_ask_submit_')
  ) {
    requestId = nonEmptyString(name.slice('qwen_ask_submit_'.length));
    actionId = requestId ? 'qwen_ask_submit' : undefined;
  }

  if (
    rawValue === undefined &&
    typeof name === 'string' &&
    name.startsWith('qwen_ask_cancel_')
  ) {
    requestId = nonEmptyString(name.slice('qwen_ask_cancel_'.length));
    actionId = requestId ? 'qwen_ask_cancel' : undefined;
  }

  if (!requestId || !actionId || typeof name !== 'string') {
    return { kind: 'unhandled' };
  }

  const operator = record(payload?.['operator']);
  const operatorId = nonEmptyString(operator?.['open_id']);
  const operatorResult = operatorId ? { operatorId } : undefined;
  const context = record(payload?.['context']);
  const chatId =
    nonEmptyString(context?.['open_chat_id']) ??
    nonEmptyString(payload?.['open_chat_id']);
  const messageId =
    nonEmptyString(context?.['open_message_id']) ??
    nonEmptyString(payload?.['open_message_id']);
  const correlation = {
    ...(chatId ? { chatId } : {}),
    ...(messageId ? { messageId } : {}),
  };

  if (
    actionId === 'qwen_ask_submit' &&
    name === `qwen_ask_submit_${requestId}`
  ) {
    const formValue = record(action?.['form_value']);
    return {
      kind: 'submit',
      requestId,
      ...operatorResult,
      ...correlation,
      ...(formValue ? { formValue } : {}),
    };
  }

  if (
    actionId === 'qwen_ask_cancel' &&
    name === `qwen_ask_cancel_${requestId}`
  ) {
    return { kind: 'cancel', requestId, ...operatorResult, ...correlation };
  }

  return { kind: 'unhandled' };
}

export function parseQuestionAnswers(
  questions: ChannelUserQuestion[],
  formValue: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!formValue) return undefined;

  const answerKeys = new Set(questions.map((question) => question.answerKey));
  const submittedKeys = Object.keys(formValue);
  if (
    submittedKeys.length !== questions.length ||
    submittedKeys.some((key) => !answerKeys.has(key))
  ) {
    return undefined;
  }

  const answers: Record<string, string> = {};
  for (const question of questions) {
    const rawAnswer = formValue[question.answerKey];
    let values: unknown[];

    if (question.multiSelect) {
      if (Array.isArray(rawAnswer)) {
        values = rawAnswer;
      } else if (typeof rawAnswer === 'string') {
        try {
          const parsed = JSON.parse(rawAnswer) as unknown;
          if (!Array.isArray(parsed)) return undefined;
          values = parsed;
        } catch {
          return undefined;
        }
      } else {
        return undefined;
      }
    } else if (typeof rawAnswer === 'string' && rawAnswer) {
      values = [rawAnswer];
    } else {
      return undefined;
    }

    if (
      values.length === 0 ||
      (!question.multiSelect && values.length !== 1) ||
      (question.multiSelect && new Set(values).size !== values.length) ||
      values.some(
        (value) =>
          typeof value !== 'string' ||
          !question.options.some((option) => option.label === value),
      )
    ) {
      return undefined;
    }

    answers[question.answerKey] = values.join(', ');
  }

  return answers;
}
