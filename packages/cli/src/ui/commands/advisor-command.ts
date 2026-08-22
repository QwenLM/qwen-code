/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  BTW_MAX_INPUT_LENGTH,
  buildBtwCacheSafeParams,
  runForkedAgent,
  resolveModelId,
} from '@qwen-code/qwen-code-core';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

const ADVISOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', minLength: 1 },
    risks: { type: 'string', minLength: 1 },
    missingEvidence: { type: 'string', minLength: 1 },
    recommendation: { type: 'string', minLength: 1 },
  },
  required: ['verdict', 'risks', 'missingEvidence', 'recommendation'],
} as const;

interface AdvisorReview {
  verdict: string;
  risks: string;
  missingEvidence: string;
  recommendation: string;
}

function buildAdvisorPrompt(focus: string): string {
  return [
    '<system-reminder>',
    'You are acting as an ADVISOR — an independent senior reviewer giving a second opinion on the conversation so far. The transcript above may be truncated to the most recent turns; treat what is shown as the evidence available to you.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You have NO tools. Base every claim strictly on evidence present in the transcript; never claim to have verified something you could not observe.',
    '- Do not perform the task or write the implementation. Review only.',
    '- Be direct about problems: flawed assumptions, premature conclusions, unverified claims, risky next steps.',
    '- The main conversation is NOT interrupted; your review is shown to the user only.',
    '',
    'Return exactly one JSON object with these string fields and no markdown fence, preamble, extra key, or commentary:',
    '- verdict: one short paragraph stating whether the current approach or conclusion is sound.',
    '- risks: concrete risks or flawed assumptions, each citing transcript evidence. Write "None found" if none.',
    '- missingEvidence: claims asserted but not verified in the visible transcript (earlier verification may exist outside the shown window).',
    '- recommendation: the single most valuable next action.',
    '</system-reminder>',
    '',
    focus || 'Review the conversation above.',
  ].join('\n');
}

function formatAdvisorReview(
  value: Record<string, unknown> | undefined,
): string {
  const fields = ['verdict', 'risks', 'missingEvidence', 'recommendation'];
  if (
    !value ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => {
      const fieldValue = value[field];
      return typeof fieldValue !== 'string' || fieldValue.trim().length === 0;
    })
  ) {
    throw new Error('Advisor returned invalid structured output.');
  }

  const review = value as unknown as AdvisorReview;

  return [
    '## Verdict',
    review.verdict.trim(),
    '## Risks',
    review.risks.trim(),
    '## Missing evidence',
    review.missingEvidence.trim(),
    '## Recommendation',
    review.recommendation.trim(),
  ].join('\n\n');
}

function formatAdvisorError(error: unknown): string {
  return t('Advisor review failed: {{error}}', {
    error:
      error instanceof Error ? error.message : String(error || 'Unknown error'),
  });
}

function parseScopeFlags(args: string): {
  scopeOverride: SettingScope | undefined;
  remaining: string;
  hasProject: boolean;
  hasGlobal: boolean;
} {
  let scopeOverride: SettingScope | undefined;
  let remaining = args;
  const hasProject = /(?:^|\s)--project(?:\s|$)/.test(remaining);
  const hasGlobal = /(?:^|\s)--global(?:\s|$)/.test(remaining);

  if (hasProject) {
    scopeOverride = SettingScope.Workspace;
    remaining = remaining.replace(/(?:^|\s)--project(?:\s|$)/, ' ').trim();
  } else if (hasGlobal) {
    scopeOverride = SettingScope.User;
    remaining = remaining.replace(/(?:^|\s)--global(?:\s|$)/, ' ').trim();
  }

  return { scopeOverride, remaining, hasProject, hasGlobal };
}

function resolveScope(
  settings: LoadedSettings,
  scopeOverride: SettingScope | undefined,
): SettingScope {
  return scopeOverride ?? getPersistScopeForModelSelection(settings);
}

function persistScopeSpread(
  scopeOverride: SettingScope | undefined,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
): { persistScope: 'workspace' } | { persistScope: 'user' } | {} {
  if (scopeOverride === SettingScope.Workspace)
    return { persistScope: 'workspace' as const };
  if (scopeOverride === SettingScope.User)
    return { persistScope: 'user' as const };
  return {};
}

function scopeSuffix(scopeOverride: SettingScope | undefined): string {
  return scopeOverride === SettingScope.Workspace
    ? t(' (this project)')
    : scopeOverride === SettingScope.User
      ? t(' (global)')
      : '';
}

function formatAdvisorStatus(context: CommandContext): string {
  const advisorModel =
    context.services.config?.getAdvisorModel?.() ?? t('not set');
  return t(
    'Current Advisor model: {{advisorModel}}\nUse "/advisor <model-id>" to enable Advisor or "/advisor off" to disable it.',
    { advisorModel },
  );
}

function formatUnavailableAdvisorModelMessage(
  modelName: string,
  availableModelIds: string[],
): string {
  const availableModelsLine =
    availableModelIds.length === 0
      ? t('No models are configured.')
      : t('Configured models: {{models}}.', {
          models: availableModelIds.join(', '),
        });
  return (
    t("Advisor model '{{modelName}}' is not configured.", { modelName }) +
    '\n' +
    availableModelsLine +
    '\n' +
    t(
      'Configure models in settings.modelProviders, or run /advisor without arguments in interactive mode to choose from configured models.',
    )
  );
}

async function askAdvisor(
  context: CommandContext,
  focus: string,
  abortSignal: AbortSignal,
): Promise<{ text: string; model: string }> {
  const { config } = context.services;
  if (!config) throw new Error(t('Config not loaded.'));

  const cacheSafeParams = buildBtwCacheSafeParams(config);
  if (
    !cacheSafeParams ||
    config.getGeminiClient().getHistoryForForkWindow().length === 0
  ) {
    throw new Error(t('No conversation context available for /advisor'));
  }

  const advisorModel = config.getAdvisorModel();

  // Tools are always stripped (NO_TOOLS), matching /btw and the "You have NO
  // tools" framing of the advisor prompt. This accepts a cache-prefix miss in
  // exchange for guaranteeing the reviewer cannot answer with tool calls that
  // would be discarded and surface as an empty review.
  const result = await runForkedAgent({
    config,
    userMessage: buildAdvisorPrompt(focus),
    cacheSafeParams,
    jsonSchema: ADVISOR_SCHEMA,
    ...(advisorModel ? { model: advisorModel } : {}),
    abortSignal,
    disableModelFallbacks: true,
  });

  return {
    text: formatAdvisorReview(result.jsonResult),
    model: result.model,
  };
}

async function setAdvisorModel(
  context: CommandContext,
  modelName: string | undefined,
  scopeOverride: SettingScope | undefined,
): Promise<SlashCommandActionReturn> {
  const { config, settings } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Config not loaded.'),
    };
  }
  if (!settings) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Settings service not available.'),
    };
  }

  const scope = resolveScope(settings, scopeOverride);
  if (modelName === undefined) {
    settings.setValue(scope, 'advisorModel', '');
    await config.setAdvisorConfig({
      model: undefined,
      maxUses: settings.merged.advisorMaxUses,
      modelOverride: true,
    });
    return {
      type: 'message',
      messageType: 'info',
      content: t('Advisor disabled') + scopeSuffix(scopeOverride),
    };
  }

  const selector = (() => {
    try {
      return resolveModelId(modelName);
    } catch {
      return undefined;
    }
  })();
  if (!selector) {
    return {
      type: 'message',
      messageType: 'error',
      content: formatUnavailableAdvisorModelMessage(modelName, []),
    };
  }

  const availableModels = (
    selector.authType
      ? config.getAvailableModelsForAuthType(selector.authType)
      : config.getAllConfiguredModels()
  ).filter(
    (model) =>
      !model.fastOnly &&
      !model.voiceOnly &&
      !model.visionOnly &&
      !model.imageOnly,
  );
  if (!availableModels.some((model) => model.id === selector.modelId)) {
    return {
      type: 'message',
      messageType: 'error',
      content: formatUnavailableAdvisorModelMessage(
        modelName,
        Array.from(new Set(availableModels.map((model) => model.id))),
      ),
    };
  }

  settings.setValue(scope, 'advisorModel', modelName);
  await config.setAdvisorConfig({
    model: modelName,
    maxUses: settings.merged.advisorMaxUses,
    modelOverride: true,
  });
  return {
    type: 'message',
    messageType: 'info',
    content: t('Advisor Model') + ': ' + modelName + scopeSuffix(scopeOverride),
  };
}

export const advisorCommand: SlashCommand = {
  name: 'advisor',
  get description() {
    return t(
      'Configure the native Advisor model, or run /advisor review for a manual second opinion',
    );
  },
  argumentHint:
    '[--project|--global] [<model-id>|off] | status | review [focus]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  completion: async (context, partialArg) => {
    if (!partialArg) return null;
    const fixed = [
      {
        value: 'off',
        description: t('Disable the native Advisor tool'),
      },
      {
        value: 'review',
        description: t('Run a manual second-opinion review'),
      },
      {
        value: 'status',
        description: t('Show the current Advisor model'),
      },
      {
        value: '--project',
        description: t('Persist the Advisor model to project settings'),
      },
      {
        value: '--global',
        description: t('Persist the Advisor model to user settings'),
      },
    ].filter((item) => item.value.startsWith(partialArg));
    if (fixed.length > 0) return fixed;
    const prefix = partialArg
      .replace(/(?:^|\s)--project(?:\s|$)/, ' ')
      .replace(/(?:^|\s)--global(?:\s|$)/, ' ')
      .trim();
    if (!prefix || prefix === 'review') return null;
    return context.services.config
      ? context.services.config
          .getAllConfiguredModels()
          .filter(
            (model) =>
              !model.fastOnly &&
              !model.voiceOnly &&
              !model.visionOnly &&
              !model.imageOnly,
          )
          .map((model) => model.id)
          .filter((id) => id.startsWith(prefix))
      : null;
  },
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const rawArgs = context.invocation?.args?.trim() || args.trim();
    const [subcommand = '', ...rest] = rawArgs.split(/\s+/);
    const isReview = subcommand === 'review';
    const isStatus = subcommand === 'status';
    const focus = isReview ? rest.join(' ').trim() : '';

    if (isReview && focus.length > BTW_MAX_INPUT_LENGTH) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Focus too long (max {{max}} chars)', {
          max: String(BTW_MAX_INPUT_LENGTH),
        }),
      };
    }

    const { config } = context.services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    if (isStatus) {
      if (rest.length > 0) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Usage: /advisor status'),
        };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: formatAdvisorStatus(context),
      };
    }

    if (!isReview) {
      const { scopeOverride, remaining, hasProject, hasGlobal } =
        parseScopeFlags(rawArgs);
      if (hasProject && hasGlobal) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Cannot use both --project and --global. Choose one scope flag.',
          ),
        };
      }
      if (
        scopeOverride === SettingScope.Workspace &&
        context.services.settings &&
        !context.services.settings.isTrusted
      ) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Workspace is untrusted; run /trust first or use --global.',
          ),
        };
      }
      if (!remaining) {
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'info',
            content: formatAdvisorStatus(context),
          };
        }
        return {
          type: 'dialog',
          dialog: 'advisor-model',
          ...persistScopeSpread(scopeOverride),
        };
      }
      return setAdvisorModel(
        context,
        remaining.toLowerCase() === 'off' ? undefined : remaining,
        scopeOverride,
      );
    }

    if (!config.getModel()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No model configured.'),
      };
    }

    const { ui } = context;
    const abortSignal = context.abortSignal ?? new AbortController().signal;
    const executionMode = context.executionMode ?? 'interactive';

    if (executionMode !== 'interactive') {
      try {
        const review = await askAdvisor(context, focus, abortSignal);
        return { type: 'message', messageType: 'info', content: review.text };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatAdvisorError(error),
        };
      }
    }

    // Mirror /recap's guard: pendingItem alone misses an in-flight main turn,
    // which isIdleRef covers. Without it the advisor would review a stale
    // snapshot and park a blocking pendingItem on top of a live turn.
    const turnInFlight = !ui.isIdleRef.current || ui.pendingItem !== null;
    if (turnInFlight) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Another operation is in progress, wait for it to complete before running /advisor',
        ),
      };
    }

    try {
      ui.setPendingItem({
        type: MessageType.INFO,
        text: t('Consulting advisor...'),
      });

      const review = await askAdvisor(context, focus, abortSignal);

      if (abortSignal.aborted) return;

      ui.addItem(
        { type: MessageType.ADVISOR, text: review.text, model: review.model },
        Date.now(),
      );
    } catch (error) {
      if (abortSignal.aborted) return;

      ui.addItem(
        { type: MessageType.ERROR, text: formatAdvisorError(error) },
        Date.now(),
      );
    } finally {
      if (!abortSignal.aborted) ui.setPendingItem(null);
    }
  },
};
