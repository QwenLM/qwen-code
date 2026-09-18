import { describe, expect, it } from 'vitest';
import type {
  ChannelUserInputRequestContext,
  ChannelUserQuestion,
} from '@qwen-code/channel-base';
import {
  buildQuestionCard,
  buildQuestionTerminalCard,
  parseQuestionAction,
  parseQuestionAnswers,
} from './question-card.js';

interface CardElement {
  tag: string;
  name?: string;
  value?: Record<string, unknown>;
  options?: Array<{
    value: string;
    text?: { tag?: string; content?: string };
  }>;
  elements?: CardElement[];
  content?: string;
  form_action_type?: string;
  text_size?: string;
}

interface QuestionCard {
  schema: string;
  body: { elements: CardElement[] };
}

const questions: ChannelUserQuestion[] = [
  {
    answerKey: 'region',
    header: 'Region',
    question: 'Which region should I use?',
    options: [
      { label: 'Beijing', description: 'Use the Beijing region.' },
      { label: 'Shanghai', description: 'Use the Shanghai region.' },
    ],
    multiSelect: false,
  },
  {
    answerKey: 'sources',
    header: 'Sources',
    question: 'Which sources should I inspect?',
    options: [
      { label: 'Logs', description: 'Inspect application logs.' },
      { label: 'Metrics', description: 'Inspect service metrics.' },
    ],
    multiSelect: true,
  },
];

const context: Pick<
  ChannelUserInputRequestContext,
  'requestId' | 'questions' | 'sourceLabel'
> = {
  requestId: 'request-1',
  questions,
};

function form(card: Record<string, unknown>): CardElement {
  const elements = (card as unknown as QuestionCard).body.elements;
  expect(elements).toHaveLength(1);
  expect(elements[0]?.tag).toBe('form');
  return elements[0]!;
}

describe('Feishu question cards', () => {
  it('projects all questions into one Card V2 form', () => {
    const card = buildQuestionCard(context);
    const questionForm = form(card);
    const elements = questionForm.elements!;

    const selects = elements.filter((element) =>
      ['select_static', 'multi_select_static'].includes(element.tag),
    );

    expect((card as unknown as QuestionCard).schema).toBe('2.0');
    expect(questionForm.name).toBe('qwen_ask_form');
    expect(elements).toMatchObject([
      { tag: 'markdown' },
      { tag: 'select_static', name: 'region' },
      { tag: 'markdown' },
      { tag: 'multi_select_static', name: 'sources' },
      { tag: 'button' },
      { tag: 'button' },
    ]);
    expect(selects).toMatchObject([
      {
        tag: 'select_static',
        name: 'region',
        options: [
          { value: 'Beijing', text: { tag: 'plain_text', content: 'Beijing' } },
          {
            value: 'Shanghai',
            text: { tag: 'plain_text', content: 'Shanghai' },
          },
        ],
      },
      {
        tag: 'multi_select_static',
        name: 'sources',
        options: [
          { value: 'Logs', text: { tag: 'plain_text', content: 'Logs' } },
          { value: 'Metrics', text: { tag: 'plain_text', content: 'Metrics' } },
        ],
      },
    ]);
  });

  it('renders one escaped source label in initial and terminal cards', () => {
    const questionForm = form(
      buildQuestionCard({ ...context, sourceLabel: '[review_*]' }),
    );
    expect(questionForm.elements?.[0]).toMatchObject({
      tag: 'markdown',
      content: '\\[review\\_\\*\\]',
    });

    const terminal = buildQuestionTerminalCard(
      questions,
      'cancelled',
      undefined,
      '[review_*]',
    ) as unknown as QuestionCard;
    expect(terminal.body.elements[0]?.content).toContain(
      '\\[review\\_\\*\\]\n\n**已取消**',
    );
  });

  it('neutralizes Feishu mention markup in source labels', () => {
    const sourceLabel = '[Alice <at id=ou_other></at> & review]';
    const questionForm = form(buildQuestionCard({ ...context, sourceLabel }));
    const terminal = buildQuestionTerminalCard(
      questions,
      'cancelled',
      undefined,
      sourceLabel,
    ) as unknown as QuestionCard;

    expect(questionForm.elements?.[0]?.content).toContain(
      String.raw`&lt;at id=ou\_other&gt;&lt;/at&gt; &amp;`,
    );
    expect(questionForm.elements?.[0]?.content).not.toContain('<at');
    expect(terminal.body.elements[0]?.content).not.toContain('<at');
  });

  it('includes correlated submit and cancel actions', () => {
    const elements = form(buildQuestionCard(context)).elements!;

    const submit = elements.find(
      (element) => element.name === 'qwen_ask_submit_request-1',
    );
    const cancel = elements.find(
      (element) => element.value?.['action'] === 'qwen_ask_cancel',
    );

    expect(submit).toMatchObject({
      tag: 'button',
      text: { tag: 'plain_text', content: '提交' },
      name: 'qwen_ask_submit_request-1',
      value: {
        action: 'qwen_ask_submit',
        operation_id: 'request-1',
      },
      form_action_type: 'submit',
    });
    expect(cancel).toMatchObject({
      tag: 'button',
      text: { tag: 'plain_text', content: '取消' },
      name: 'qwen_ask_cancel_request-1',
      value: {
        action: 'qwen_ask_cancel',
        operation_id: 'request-1',
      },
    });
    expect(cancel?.form_action_type).toBeUndefined();
  });

  it('renders option descriptions as Markdown notes', () => {
    const elements = form(buildQuestionCard(context)).elements!;
    const markdown = elements
      .filter((element) => element.tag === 'markdown')
      .map((element) => element.content)
      .join('\n');

    expect(markdown).toContain('Use the Beijing region.');
    expect(markdown).toContain('Inspect service metrics.');
    expect(markdown).toContain('**Region**');
    expect(markdown).toContain('Which region should I use?');
    expect(markdown).toContain('**Sources**');
    expect(markdown).toContain('Which sources should I inspect?');
    expect(
      elements.find((element) => element.tag === 'markdown'),
    ).toMatchObject({ text_size: 'notation' });
  });

  it('makes terminal cards non-interactive', () => {
    const card = buildQuestionTerminalCard(questions, 'submitted', {
      region: 'Beijing',
      sources: 'Logs, Metrics',
    });
    const elements = (card as unknown as QuestionCard).body.elements;

    expect((card as unknown as QuestionCard).schema).toBe('2.0');
    expect(elements.some((element) => element.tag === 'form')).toBe(false);
    expect(elements.some((element) => element.tag === 'button')).toBe(false);
    const content = elements.map((element) => element.content ?? '').join('\n');
    expect(content).toContain('已提交');
    expect(content).toContain('**Region**\nBeijing');
    expect(content).toContain('**Sources**\nLogs, Metrics');
  });

  it('renders the processing projection between claim and finalization', () => {
    const card = buildQuestionTerminalCard(questions, 'processing', {
      region: 'Beijing',
      sources: 'Logs',
    });
    const elements = (card as unknown as QuestionCard).body.elements;
    const content = elements.map((element) => element.content ?? '').join('\n');

    expect(content).toContain('正在处理...');
    expect(content).toContain('**Region**\nBeijing');
  });

  it('falls back to the question text when a terminal card has no answers', () => {
    const card = buildQuestionTerminalCard(questions, 'cancelled');
    const elements = (card as unknown as QuestionCard).body.elements;
    const content = elements.map((element) => element.content ?? '').join('\n');

    expect(content).toContain('已取消');
    expect(content).toContain('Which region should I use?');
    expect(content).toContain('Which sources should I inspect?');
  });

  it('parses a submitted form with top-level message context', () => {
    expect(
      parseQuestionAction({
        open_chat_id: 'oc_1',
        open_message_id: 'om_1',
        operator: { open_id: 'ou_1' },
        action: {
          name: 'qwen_ask_submit_request-1',
          value: {
            action: 'qwen_ask_submit',
            operation_id: 'request-1',
          },
          form_value: { region: 'Beijing' },
        },
      }),
    ).toEqual({
      kind: 'submit',
      requestId: 'request-1',
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
      formValue: { region: 'Beijing' },
    });
  });

  it('recovers a form submission when Feishu omits the button value', () => {
    expect(
      parseQuestionAction({
        context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
        operator: { open_id: 'ou_1' },
        action: {
          name: 'qwen_ask_submit_request-1',
          form_value: { region: 'Beijing' },
        },
      }),
    ).toEqual({
      kind: 'submit',
      requestId: 'request-1',
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
      formValue: { region: 'Beijing' },
    });
  });

  it('parses cancellation with nested message context', () => {
    expect(
      parseQuestionAction({
        open_chat_id: 'oc_fallback',
        open_message_id: 'om_fallback',
        context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
        operator: { open_id: 'ou_1' },
        action: {
          name: 'qwen_ask_cancel_request-1',
          value: {
            action: 'qwen_ask_cancel',
            operation_id: 'request-1',
          },
        },
      }),
    ).toEqual({
      kind: 'cancel',
      requestId: 'request-1',
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
    });
  });

  it('recovers a cancellation when Feishu omits the button value', () => {
    expect(
      parseQuestionAction({
        context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
        operator: { open_id: 'ou_1' },
        action: {
          name: 'qwen_ask_cancel_request-1',
        },
      }),
    ).toEqual({
      kind: 'cancel',
      requestId: 'request-1',
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
    });
  });

  it('parses an action without optional correlation or operator fields', () => {
    expect(
      parseQuestionAction({
        operator: { open_id: '' },
        action: {
          name: 'qwen_ask_cancel_request-1',
          value: {
            action: 'qwen_ask_cancel',
            operation_id: 'request-1',
          },
        },
      }),
    ).toEqual({ kind: 'cancel', requestId: 'request-1' });
  });

  it.each([
    {
      action: {
        name: 'qwen_ask_submit_request-1',
        value: { action: 'qwen_ask_submit' },
      },
    },
    {
      action: {
        name: 'qwen_ask_submit_wrong-request',
        value: {
          action: 'qwen_ask_submit',
          operation_id: 'request-1',
        },
      },
    },
    {
      action: {
        name: 'qwen_ask_cancel_request-1',
        value: { action: 'stop', operation_id: 'request-1' },
      },
    },
    {
      action: {
        name: 'qwen_ask_cancel_wrong-request',
        value: {
          action: 'qwen_ask_cancel',
          operation_id: 'request-1',
        },
      },
    },
  ])('does not claim unrelated or malformed actions', (data) => {
    expect(parseQuestionAction(data)).toEqual({ kind: 'unhandled' });
  });

  it('normalizes single and multi-select answers', () => {
    expect(
      parseQuestionAnswers(questions, {
        region: 'Beijing',
        sources: ['Logs', 'Metrics'],
      }),
    ).toEqual({ region: 'Beijing', sources: 'Logs, Metrics' });
    expect(
      parseQuestionAnswers(questions, {
        region: 'Shanghai',
        sources: '["Metrics", "Logs"]',
      }),
    ).toEqual({ region: 'Shanghai', sources: 'Metrics, Logs' });
  });

  it.each([
    undefined,
    { region: 'Beijing' },
    { region: 'Unknown', sources: ['Logs'] },
    { region: ['Beijing'], sources: ['Logs'] },
    { region: ['Beijing', 'Beijing'], sources: ['Logs'] },
    { region: 'Beijing', sources: ['Logs', 'Logs'] },
    { region: 'Beijing', sources: ['Logs'], extra: 'value' },
    { region: 'Beijing', sources: [] },
    { region: 'Beijing', sources: '[]' },
    { region: 'Beijing', sources: '"Logs"' },
    { region: 'Beijing', sources: 'not-json' },
    { region: 'Beijing', sources: '{"a":1}' },
    { region: 'Beijing', sources: 42 },
  ])('rejects incomplete or invalid form values', (formValue) => {
    expect(parseQuestionAnswers(questions, formValue)).toBeUndefined();
  });
});
