/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import {
  resolveEffectiveReasoning,
  type ResolvedModelReasoningConfig,
} from '../model-reasoning-config.js';
import {
  selectDashScopeThinkingKnob,
  withoutNullishThinkingKnobs,
} from './provider/dashscope.js';
import { ensureReasoningContentOnAssistantMessage } from './provider/utils.js';
import { REASONING_EFFORT_TIERS } from '../reasoning-effort.js';

const THINKING_FIELDS = [
  'reasoning',
  'reasoning_effort',
  'enable_thinking',
  'thinking_budget',
  'thinking',
] as const;

export function applyOpenAIReasoningProfile(
  request: OpenAI.Chat.ChatCompletionCreateParams,
  generation: ContentGeneratorConfig,
  resolved: ResolvedModelReasoningConfig,
  requestDisabled: boolean,
): OpenAI.Chat.ChatCompletionCreateParams {
  const body = { ...request } as unknown as Record<string, unknown>;
  // Discard only thinking fields produced by legacy adapters, then restore
  // explicit raw overrides after generating the selected profile's fields.
  for (const key of THINKING_FIELDS) delete body[key];
  const template = {
    ...(body['chat_template_kwargs'] as Record<string, unknown> | undefined),
  };
  delete template['enable_thinking'];
  delete body['chat_template_kwargs'];
  if (Object.keys(template).length) body['chat_template_kwargs'] = template;

  const reasoning = resolveEffectiveReasoning(generation, resolved);
  const effort = reasoning && reasoning.effort;
  const profile = resolved.profile;
  const mandatory = resolved.canDisable === false;
  const disabled =
    !mandatory && (requestDisabled || generation.reasoning === false);
  if (!disabled) {
    if (profile === 'openai-reasoning') {
      if (reasoning) body['reasoning'] = { ...reasoning };
    } else if (profile === 'dashscope-thinking') {
      body['enable_thinking'] = true;
      if (reasoning && reasoning.budget_tokens !== undefined)
        body['thinking_budget'] = reasoning.budget_tokens;
    } else if (profile === 'qwen-chat-template') {
      body['chat_template_kwargs'] = { ...template, enable_thinking: true };
    } else if (effort) {
      body['reasoning_effort'] = effort;
    }
  }
  for (const rawLayer of [generation.samplingParams, generation.extra_body]) {
    const layer =
      profile === 'dashscope-effort'
        ? withoutNullishThinkingKnobs(rawLayer)
        : rawLayer;
    if (!layer) continue;
    if (layer['reasoning'] !== undefined) delete body['reasoning_effort'];
    if (layer['reasoning_effort'] != null) delete body['reasoning'];
    for (const key of THINKING_FIELDS) {
      if (Object.hasOwn(layer, key)) {
        if (layer[key] == null) delete body[key];
        else body[key] = layer[key];
      }
    }
    if (layer['chat_template_kwargs'] !== undefined) {
      body['chat_template_kwargs'] = {
        ...template,
        ...(layer['chat_template_kwargs'] as Record<string, unknown>),
      };
    }
  }
  if (profile === 'dashscope-effort') {
    const selected = selectDashScopeThinkingKnob(
      generation.model,
      generation.extra_body,
      generation.samplingParams,
      effort || undefined,
      true,
    );
    if (selected?.field === 'thinking_budget') delete body['reasoning_effort'];
    else if (body['reasoning_effort'] !== undefined) {
      delete body['thinking_budget'];
      if (body['enable_thinking'] !== false) delete body['enable_thinking'];
    }
    if (body['enable_thinking'] === false && !mandatory) {
      body['reasoning_effort'] = 'none';
      delete body['thinking_budget'];
      delete body['enable_thinking'];
    }
  }
  if (disabled) {
    for (const key of THINKING_FIELDS) delete body[key];
    if (profile === 'openai-reasoning') body['reasoning'] = { enabled: false };
    else if (profile === 'deepseek-openai')
      body['thinking'] = { type: 'disabled' };
    else if (profile === 'dashscope-thinking') body['enable_thinking'] = false;
    else if (profile === 'qwen-chat-template')
      body['chat_template_kwargs'] = {
        ...(body['chat_template_kwargs'] as Record<string, unknown>),
        enable_thinking: false,
      };
    else body['reasoning_effort'] = 'none';
  }
  if (mandatory) {
    if (body['reasoning_effort'] === 'none') delete body['reasoning_effort'];
    if (body['enable_thinking'] === false) delete body['enable_thinking'];
    const nested = body['reasoning'] as
      | Record<string, unknown>
      | false
      | undefined;
    if (
      nested === false ||
      nested?.['enabled'] === false ||
      nested?.['effort'] === 'none'
    )
      delete body['reasoning'];
    const thinking = body['thinking'] as Record<string, unknown> | undefined;
    if (thinking?.['type'] === 'disabled' || thinking?.['enabled'] === false)
      delete body['thinking'];
    const kwargs = body['chat_template_kwargs'] as
      | Record<string, unknown>
      | undefined;
    if (kwargs?.['enable_thinking'] === false) {
      const next = { ...kwargs };
      delete next['enable_thinking'];
      if (Object.keys(next).length) body['chat_template_kwargs'] = next;
      else delete body['chat_template_kwargs'];
    }
    if (
      effort &&
      body['reasoning_effort'] === undefined &&
      body['reasoning'] === undefined
    ) {
      if (profile === 'openai-reasoning') body['reasoning'] = { effort };
      else if (!resolved.toggleOnly) body['reasoning_effort'] = effort;
    }
  }
  if (
    (profile === 'dashscope-thinking' || profile === 'dashscope-effort') &&
    body['tool_choice'] === 'required' &&
    (mandatory ||
      body['enable_thinking'] === true ||
      (body['reasoning_effort'] !== undefined &&
        body['reasoning_effort'] !== 'none') ||
      (body['thinking_budget'] !== undefined &&
        body['enable_thinking'] !== false))
  )
    delete body['tool_choice'];
  if (profile === 'deepseek-openai')
    body['messages'] = request.messages.map(
      ensureReasoningContentOnAssistantMessage,
    );
  return body as unknown as OpenAI.Chat.ChatCompletionCreateParams;
}

export function getOpenAIReasoningState(
  generation: ContentGeneratorConfig,
  resolved: ResolvedModelReasoningConfig,
): ContentGeneratorConfig['reasoning'] {
  const body = applyOpenAIReasoningProfile(
    { model: generation.model, messages: [] },
    generation,
    resolved,
    false,
  ) as unknown as Record<string, unknown>;
  const nested = body['reasoning'] as
    | Record<string, unknown>
    | false
    | undefined;
  const thinking = body['thinking'] as Record<string, unknown> | undefined;
  const template = body['chat_template_kwargs'] as
    | Record<string, unknown>
    | undefined;
  if (
    body['reasoning_effort'] === 'none' ||
    body['enable_thinking'] === false ||
    nested === false ||
    nested?.['enabled'] === false ||
    nested?.['effort'] === 'none' ||
    thinking?.['type'] === 'disabled' ||
    thinking?.['enabled'] === false ||
    template?.['enable_thinking'] === false
  )
    return false;
  const value = body['reasoning_effort'] ?? (nested && nested['effort']);
  const effort = REASONING_EFFORT_TIERS.find((tier) => tier === value);
  if (effort) return { effort };
  return resolveEffectiveReasoning(generation, resolved) === false
    ? false
    : undefined;
}
