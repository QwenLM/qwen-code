/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Replay scripts: a stand-in model that answers each case with the reference
 * document, so the deterministic run measures the runtime and host, not a
 * model. Turns are derived from the conversation in each request, never from
 * a global counter, so side requests cannot advance a script.
 */

import {
  fakeToolCall,
  type FakeOpenAIResponse,
} from '../fake-openai-server.js';
import { parseSubmittedInputs } from './cases.js';
import { SHOW_TOOL, showCalls, type RecordedRequest } from './harness.js';
import {
  COMPARATOR_RESET_PROMPT,
  COMPARATOR_SUPPORT_PROMPT,
} from './prompts.js';
import {
  activityFormDocument,
  billSplitterDocument,
  checklistDocument,
  comparatorDocument,
  type GeneratedUiDocument,
} from './reference-documents.js';

function lastIsToolResult(request: RecordedRequest): boolean {
  return request.messages[request.messages.length - 1]?.role === 'tool';
}

function show(
  request: RecordedRequest,
  document: GeneratedUiDocument,
): FakeOpenAIResponse {
  return {
    toolCalls: [
      fakeToolCall(
        SHOW_TOOL,
        { ...document },
        `call_show_${showCalls(request) + 1}`,
      ),
    ],
  };
}

/** One card for the first prompt, then a short reply. */
function singleCard(document: GeneratedUiDocument) {
  return (request: RecordedRequest): FakeOpenAIResponse => {
    if (lastIsToolResult(request)) return { content: 'The view is ready.' };
    if (showCalls(request) === 0) return show(request, document);
    return { content: 'Noted.' };
  };
}

export const billSplitterReplay = singleCard(billSplitterDocument);
export const checklistReplay = singleCard(checklistDocument);

export function activityFormReplay(
  request: RecordedRequest,
): FakeOpenAIResponse {
  if (lastIsToolResult(request)) return { content: 'The form is ready.' };
  if (showCalls(request) === 0) return show(request, activityFormDocument);
  const inputs = parseSubmittedInputs(request.lastUserText);
  if (Object.keys(inputs).length) {
    return {
      content: `Plan: ${inputs['activity']?.value} on ${inputs['date']?.value} for ${inputs['participants']?.value} people at CNY ${inputs['budget']?.value} each (${inputs['notes']?.value}).`,
    };
  }
  return { content: 'Noted.' };
}

const COMPARATOR_INITIAL = {
  seats: 10,
  billing: 'monthly',
  plan: 'basic',
} as const;

export function comparatorReplay(request: RecordedRequest): FakeOpenAIResponse {
  if (lastIsToolResult(request)) return { content: 'Updated.' };
  if (showCalls(request) === 0) {
    return show(
      request,
      comparatorDocument({ ...COMPARATOR_INITIAL, withSupport: false }),
    );
  }
  if (request.lastUserText.includes(COMPARATOR_SUPPORT_PROMPT.slice(0, 12))) {
    // A model sees the attached view values; rebuild from them.
    const inputs = parseSubmittedInputs(request.lastUserText);
    const checked = (prefix: string, values: string[], fallback: string) =>
      values.find((value) => inputs[`${prefix}-${value}`]?.checked) ?? fallback;
    return show(
      request,
      comparatorDocument({
        seats: Number(inputs['seats']?.value ?? COMPARATOR_INITIAL.seats),
        billing: checked(
          'billing',
          ['monthly', 'annual'],
          COMPARATOR_INITIAL.billing,
        ) as 'monthly' | 'annual',
        plan: checked(
          'plan',
          ['basic', 'pro', 'team'],
          COMPARATOR_INITIAL.plan,
        ) as 'basic' | 'pro' | 'team',
        withSupport: true,
      }),
    );
  }
  if (request.lastUserText.includes(COMPARATOR_RESET_PROMPT.slice(0, 12))) {
    return show(
      request,
      comparatorDocument({ ...COMPARATOR_INITIAL, withSupport: false }),
    );
  }
  return { content: 'Noted.' };
}
