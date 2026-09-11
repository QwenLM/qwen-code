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
import { isOpenRouterHostname } from './provider/openrouter.js';
import { isDeepSeekHostname } from './provider/deepseek.js';
import { ensureReasoningContentOnAssistantMessage } from './provider/utils.js';
import {
  isReasoningEffortPlaceholder,
  REASONING_EFFORT_TIERS,
  type ReasoningEffort,
} from '../reasoning-effort.js';

const THINKING_FIELDS = [
  'reasoning',
  'reasoning_effort',
  'enable_thinking',
  'thinking_budget',
  'thinking',
] as const;

function withResolvedReasoningEffort(
  layer: Record<string, unknown> | undefined,
  fallback: ReasoningEffort | undefined,
): Record<string, unknown> | undefined {
  if (!layer) return layer;
  if (Object.hasOwn(layer, 'reasoning_effort')) {
    if (!isReasoningEffortPlaceholder(layer['reasoning_effort'])) return layer;
    const normalized = { ...layer };
    if (fallback) normalized['reasoning_effort'] = fallback;
    else delete normalized['reasoning_effort'];
    return normalized;
  }
  const reasoning = layer?.['reasoning'];
  const effort =
    reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)
      ? (reasoning as Record<string, unknown>)['effort']
      : undefined;
  if (effort === undefined) return layer;
  return {
    ...layer,
    ...(isReasoningEffortPlaceholder(effort)
      ? fallback
        ? { reasoning_effort: fallback }
        : {}
      : { reasoning_effort: effort }),
  };
}

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
      if (
        profile !== 'dashscope-effort' &&
        reasoning.budget_tokens !== undefined
      )
        body['reasoning'] = { budget_tokens: reasoning.budget_tokens };
    }
  }
  for (const rawLayer of [generation.samplingParams, generation.extra_body]) {
    const layer =
      profile === 'dashscope-effort'
        ? withoutNullishThinkingKnobs(rawLayer)
        : rawLayer;
    if (!layer) continue;
    for (const key of THINKING_FIELDS) {
      if (key === 'reasoning' || key === 'reasoning_effort') continue;
      if (Object.hasOwn(layer, key)) {
        if (layer[key] == null) delete body[key];
        else body[key] = layer[key];
        if (key === 'thinking' && layer[key] != null) {
          delete body['reasoning'];
          delete body['reasoning_effort'];
        }
      }
    }
    const hasReasoning = Object.hasOwn(layer, 'reasoning');
    const rawReasoning = layer['reasoning'];
    const hasEffortField = Object.hasOwn(layer, 'reasoning_effort');
    const rawEffort = layer['reasoning_effort'];
    const hasEffort =
      hasEffortField && !isReasoningEffortPlaceholder(rawEffort);
    const effectiveLayerEffort = hasEffort
      ? rawEffort
      : hasEffortField && typeof effort === 'string'
        ? effort
        : undefined;
    const useLayerEffort =
      !resolved.toggleOnly && effectiveLayerEffort !== undefined;
    if (hasReasoning) {
      if (rawReasoning === null) {
        body['reasoning'] = null;
        delete body['reasoning_effort'];
      } else if (
        rawReasoning &&
        typeof rawReasoning === 'object' &&
        !Array.isArray(rawReasoning)
      ) {
        const rawReasoningRecord = rawReasoning as Record<string, unknown>;
        const { effort: nestedEffort, ...rest } = rawReasoningRecord;
        const hasNestedEffort = Object.hasOwn(rawReasoningRecord, 'effort');
        const normalizedNestedEffort =
          hasNestedEffort && isReasoningEffortPlaceholder(nestedEffort)
            ? typeof effort === 'string'
              ? effort
              : undefined
            : nestedEffort;
        if (profile === 'openai-reasoning' && !useLayerEffort) {
          body['reasoning'] = {
            ...rest,
            ...(normalizedNestedEffort !== undefined
              ? { effort: normalizedNestedEffort }
              : {}),
          };
          delete body['reasoning_effort'];
        } else {
          if (
            !useLayerEffort &&
            !resolved.toggleOnly &&
            normalizedNestedEffort !== undefined
          )
            body['reasoning_effort'] = normalizedNestedEffort;
          if (
            !useLayerEffort &&
            normalizedNestedEffort === undefined &&
            Object.hasOwn(rawReasoning, 'enabled')
          )
            delete body['reasoning_effort'];
          if (Object.keys(rest).length) body['reasoning'] = rest;
          else delete body['reasoning'];
        }
      } else if (rawReasoning === undefined) {
        delete body['reasoning'];
      } else {
        body['reasoning'] = rawReasoning;
        delete body['reasoning_effort'];
      }
    }
    if (useLayerEffort) {
      body['reasoning_effort'] = effectiveLayerEffort;
      delete body['thinking'];
      delete body['thinking_budget'];
      delete body['enable_thinking'];
      const nested = body['reasoning'];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const rest = { ...(nested as Record<string, unknown>) };
        delete rest['effort'];
        delete rest['enabled'];
        if (Object.keys(rest).length) body['reasoning'] = rest;
        else delete body['reasoning'];
      } else {
        delete body['reasoning'];
      }
    } else if (hasEffortField) {
      delete body['reasoning_effort'];
    }
    if (layer['chat_template_kwargs'] !== undefined) {
      body['chat_template_kwargs'] = {
        ...(body['chat_template_kwargs'] as
          | Record<string, unknown>
          | undefined),
        ...(layer['chat_template_kwargs'] as Record<string, unknown>),
      };
    }
    const rawTemplate = layer['chat_template_kwargs'];
    const templateSwitch =
      rawTemplate !== null &&
      typeof rawTemplate === 'object' &&
      !Array.isArray(rawTemplate)
        ? (rawTemplate as Record<string, unknown>)['enable_thinking']
        : undefined;
    const hasTemplateDisable =
      rawTemplate !== null &&
      typeof rawTemplate === 'object' &&
      !Array.isArray(rawTemplate) &&
      Object.hasOwn(rawTemplate, 'enable_thinking') &&
      templateSwitch === false;
    if (
      profile === 'qwen-chat-template' &&
      Object.hasOwn(layer, 'enable_thinking')
    ) {
      body['chat_template_kwargs'] = {
        ...(body['chat_template_kwargs'] as
          | Record<string, unknown>
          | undefined),
        enable_thinking: layer['enable_thinking'],
      };
      delete body['enable_thinking'];
    }
    if (
      hasTemplateDisable &&
      (profile === 'qwen-chat-template' || !useLayerEffort)
    ) {
      delete body['reasoning'];
      delete body['reasoning_effort'];
      delete body['thinking'];
    } else if (useLayerEffort) {
      const kwargs = body['chat_template_kwargs'];
      if (kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs)) {
        const next = { ...(kwargs as Record<string, unknown>) };
        delete next['enable_thinking'];
        if (Object.keys(next).length) body['chat_template_kwargs'] = next;
        else delete body['chat_template_kwargs'];
      }
    }
  }
  let dashscopeBudgetSelected = false;
  if (profile === 'dashscope-effort') {
    const selected = selectDashScopeThinkingKnob(
      generation.model,
      withResolvedReasoningEffort(
        generation.extra_body,
        typeof effort === 'string' ? effort : undefined,
      ),
      withResolvedReasoningEffort(
        generation.samplingParams,
        typeof effort === 'string' ? effort : undefined,
      ),
      effort || undefined,
      true,
    );
    dashscopeBudgetSelected = selected?.field === 'thinking_budget';
    if (dashscopeBudgetSelected) delete body['reasoning_effort'];
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
    if (body['chat_template_kwargs'] !== undefined)
      body['chat_template_kwargs'] = {
        ...(body['chat_template_kwargs'] as Record<string, unknown>),
        enable_thinking: false,
      };
    if (profile === 'openai-reasoning') {
      if (
        generation.reasoningConfig?.profile === 'openai-reasoning' ||
        isOpenRouterHostname(generation)
      )
        body['reasoning'] = { enabled: false };
    } else if (profile === 'deepseek-openai')
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
    if (profile === 'dashscope-thinking') body['enable_thinking'] = true;
    else if (profile === 'qwen-chat-template')
      body['chat_template_kwargs'] = {
        ...(body['chat_template_kwargs'] as
          | Record<string, unknown>
          | undefined),
        enable_thinking: true,
      };
    if (
      effort &&
      !dashscopeBudgetSelected &&
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
  if (
    profile === 'deepseek-openai' &&
    (generation.reasoningConfig?.profile === 'deepseek-openai' ||
      isDeepSeekHostname(generation) ||
      generation.model.toLowerCase().includes('deepseek'))
  )
    body['messages'] = request.messages.map(
      ensureReasoningContentOnAssistantMessage,
    );
  return body as unknown as OpenAI.Chat.ChatCompletionCreateParams;
}

export function getOpenAIReasoningState(
  generation: ContentGeneratorConfig,
  resolved: ResolvedModelReasoningConfig,
): ContentGeneratorConfig['reasoning'] {
  // Derive the displayed state through the wire serializer so raw override
  // precedence cannot make the controls claim a different effective effort.
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
  if (typeof value === 'string' && value) {
    return { effort: value as ReasoningEffort };
  }
  return resolveEffectiveReasoning(generation, resolved) === false
    ? false
    : undefined;
}
