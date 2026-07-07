/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  OpenDialogActionReturn,
  MessageActionReturn,
  SubmitPromptActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  AuthType,
  type AvailableModel,
  type Config,
  isImageCapable,
  parseVisionModelSetting,
  resolveModelId,
} from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import {
  isInlineModelOverrideAllowed,
  parseAcpModelOption,
} from '../../utils/acpModelUtils.js';
import {
  formatUnsupportedVoiceModelMessage,
  isSelectableVoiceModel,
} from '../voice/voice-model.js';

const MAIN_MODEL_CONFIGURATION_HINT =
  'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model without arguments to choose from configured models.';

const FAST_MODEL_CONFIGURATION_HINT =
  'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model --fast without a model to choose from configured models.';

const VISION_MODEL_CONFIGURATION_HINT =
  'Configure an image-capable model in settings.modelProviders and ensure the required environment variables are set. Run /model --vision <model-id> to set it, or leave it unset to auto-pick a same-provider vision model.';

/**
 * Parse --project / --global scope flags from the argument string.
 * Returns the resolved scope override and the remaining args with flags stripped.
 */
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

function formatVisionModelSettingForDisplay(setting: string): string {
  const parsed = parseVisionModelSetting(setting);
  if (!parsed) return setting.replace(/\0/g, '\\0');
  return parsed.baseUrl
    ? `${parsed.selector} (${parsed.baseUrl})`
    : parsed.selector;
}

function persistSetting(
  settings: LoadedSettings,
  path: string,
  value: unknown,
  scopeOverride?: SettingScope,
): void {
  settings.setValue(resolveScope(settings, scopeOverride), path, value);
}

async function switchMainModel(
  config: Config,
  settings: LoadedSettings,
  currentAuthType: AuthType,
  modelArg: string,
  scopeOverride?: SettingScope,
): Promise<string> {
  const parsed = parseAcpModelOption(modelArg);

  if (parsed.authType) {
    await config.switchModel(
      parsed.authType,
      parsed.modelId,
      parsed.authType !== currentAuthType &&
        parsed.authType === AuthType.QWEN_OAUTH
        ? { requireCachedCredentials: true }
        : undefined,
    );
    persistSetting(
      settings,
      'security.auth.selectedType',
      parsed.authType,
      scopeOverride,
    );
    persistSetting(settings, 'model.name', parsed.modelId, scopeOverride);
    // `/model <id>` selects by id only, so clear any baseUrl disambiguator left
    // by a previous model-picker selection — otherwise next launch would
    // resolve to a different provider than this switch just chose. Use an
    // empty-string tombstone so the clear overrides a lower-scope value (an
    // undefined write is dropped from JSON and would not override on merge).
    persistSetting(settings, 'model.baseUrl', '', scopeOverride);
    return parsed.modelId;
  }

  await config.switchModel(currentAuthType, modelArg, undefined);
  persistSetting(settings, 'model.name', modelArg, scopeOverride);
  persistSetting(settings, 'model.baseUrl', '', scopeOverride);
  return modelArg;
}

function formatUnavailableModelMessage(
  kind: 'Model' | 'Fast model' | 'Vision model',
  modelName: string,
  authType: AuthType,
  availableModels: AvailableModel[],
): string {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id)),
  );
  const availableModelsLine =
    availableModelIds.length === 0
      ? `No models are configured for auth type '${authType}'.`
      : `Available models for '${authType}': ${availableModelIds.join(', ')}.`;

  const hint =
    kind === 'Fast model'
      ? FAST_MODEL_CONFIGURATION_HINT
      : kind === 'Vision model'
        ? VISION_MODEL_CONFIGURATION_HINT
        : MAIN_MODEL_CONFIGURATION_HINT;

  return (
    `${kind} '${modelName}' is not available for auth type '${authType}'.\n` +
    `${availableModelsLine}\n` +
    hint
  );
}

// Fast and vision share the same "not configured for any auth type" message
// shape, differing only in the label and the configuration hint.
function formatUnavailableAuxModelMessage(
  label: 'Fast model' | 'Vision model',
  modelName: string,
  availableModels: AvailableModel[],
  hint: string,
): string {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id)),
  );
  const availableModelsLine =
    availableModelIds.length === 0
      ? 'No models are configured.'
      : `Configured models: ${availableModelIds.join(', ')}.`;

  return (
    `${label} '${modelName}' is not configured for any auth type.\n` +
    `${availableModelsLine}\n` +
    hint
  );
}

function formatUnavailableFastModelMessage(
  modelName: string,
  availableModels: AvailableModel[],
): string {
  return formatUnavailableAuxModelMessage(
    'Fast model',
    modelName,
    availableModels,
    FAST_MODEL_CONFIGURATION_HINT,
  );
}

function formatUnavailableVisionModelMessage(
  modelName: string,
  availableModels: AvailableModel[],
): string {
  return formatUnavailableAuxModelMessage(
    'Vision model',
    modelName,
    availableModels,
    VISION_MODEL_CONFIGURATION_HINT,
  );
}

function formatAmbiguousVisionModelMessage(
  modelName: string,
  matchingModels: AvailableModel[],
): string {
  const endpoints = matchingModels
    .map((model) => model.baseUrl ?? '(default endpoint)')
    .join(', ');
  const qualifiedSelectors = Array.from(
    new Set(
      matchingModels
        .map((model) =>
          model.authType ? `${model.authType}:${model.id}` : undefined,
        )
        .filter((selector): selector is string => selector !== undefined),
    ),
  );
  const scriptedHint =
    qualifiedSelectors.length > 1
      ? `\n${t(
          'For scripts, pass an auth-qualified selector such as {{selector}}.',
          {
            selector: qualifiedSelectors[0],
          },
        )}`
      : '';
  return (
    t("Vision model '{{modelName}}' matches multiple configured endpoints.", {
      modelName,
    }) +
    '\n' +
    t('Matching endpoints: {{endpoints}}.', { endpoints }) +
    '\n' +
    t(
      'Run /model --vision without an argument and choose the exact endpoint.',
    ) +
    scriptedHint
  );
}

// Shown when a user pins a model that isn't known to accept images. The pin is
// still honored, but the bridge will send images to it, so flag it. Reuses the
// same translated key the model dialog emits (ModelDialog.tsx) so both paths
// stay i18n-consistent.
function formatNonVisionModelWarning(modelName: string): string {
  return t(
    "⚠ '{{model}}' is not a known image-capable model; the vision bridge may fail on images.",
    { model: modelName },
  );
}

function formatUnavailableVoiceModelMessage(
  modelName: string,
  availableModels: AvailableModel[],
): string {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id)),
  );
  const availableModelsLine =
    availableModelIds.length === 0
      ? t('No models are configured.')
      : t('Configured models: {{models}}.', {
          models: availableModelIds.join(', '),
        });

  return (
    t("Voice model '{{modelName}}' is not configured.", { modelName }) +
    '\n' +
    `${availableModelsLine}\n` +
    t(
      'Configure a unique model id in settings.modelProviders or run /model --voice to select an available model.',
    )
  );
}

// Get an array of the available model IDs as strings, filtered by mode
function getAvailableModelIds(
  context: CommandContext,
  mode: 'main' | 'fast' | 'voice' | 'vision' = 'main',
) {
  const { services } = context;
  const { config } = services;
  if (!config) {
    return [];
  }
  const availableModels = config.getAvailableModels().filter((m) => {
    if (mode === 'fast') return !m.voiceOnly;
    if (mode === 'voice') return !m.fastOnly;
    // 'vision' and 'main' both exclude fast/voice-only models.
    return !m.fastOnly && !m.voiceOnly;
  });
  return availableModels.map((model) => model.id);
}

export const modelCommand: SlashCommand = {
  name: 'model',
  completionPriority: 100,
  get description() {
    return t(
      'Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, --vision for the vision bridge model, --project to persist to project settings, --global to persist to user settings, [model-id] to switch immediately, or [model-id] [prompt] to run a one-off prompt on another model; the inline prompt is sent verbatim without @file expansion).',
    );
  },
  argumentHint:
    '[--fast|--voice|--vision] [--project|--global] [<model-id>] | <model-id> <prompt>',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  completion: async (context, partialArg) => {
    if (partialArg) {
      const flagCompletions = [
        {
          value: '--fast',
          description: t(
            'Set a lighter model for prompt suggestions and speculative execution',
          ),
        },
        {
          value: '--voice',
          description: t('Set the model for voice transcription'),
        },
        {
          value: '--vision',
          description: t(
            'Set the image-capable model used to transcribe images for a text-only main model',
          ),
        },
        {
          value: '--project',
          description: t(
            'Persist the model selection to the project settings (workspace scope)',
          ),
        },
        {
          value: '--global',
          description: t(
            'Persist the model selection to the user settings (global scope)',
          ),
        },
      ].filter((item) => item.value.startsWith(partialArg));
      if (flagCompletions.length > 0) {
        return flagCompletions;
      }
      const trimmed = partialArg.trim();
      if (trimmed) {
        let mode: 'main' | 'fast' | 'voice' | 'vision' = 'main';
        // Strip all known flags to isolate the model prefix for completion
        const modelPrefix = trimmed
          .replace(/(?:^|\s)--fast(?:\s|$)/, ' ')
          .replace(/(?:^|\s)--voice(?:\s|$)/, ' ')
          .replace(/(?:^|\s)--vision(?:\s|$)/, ' ')
          .replace(/(?:^|\s)--project(?:\s|$)/, ' ')
          .replace(/(?:^|\s)--global(?:\s|$)/, ' ')
          .trim();
        if (/(?:^|\s)--fast(?:\s|$)/.test(trimmed)) mode = 'fast';
        else if (/(?:^|\s)--voice(?:\s|$)/.test(trimmed)) mode = 'voice';
        else if (/(?:^|\s)--vision(?:\s|$)/.test(trimmed)) mode = 'vision';
        return getAvailableModelIds(context, mode).filter((id) =>
          id.startsWith(modelPrefix),
        );
      }
      return null;
    } else {
      return null;
    }
  },
  action: async (
    context: CommandContext,
    actionArgs: string,
  ): Promise<
    OpenDialogActionReturn | MessageActionReturn | SubmitPromptActionReturn
  > => {
    const { services } = context;
    const { config, settings } = services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    // Parse --project / --global scope flags first, then process the rest
    const rawArgs = context.invocation?.args?.trim() || actionArgs.trim();
    const {
      scopeOverride,
      remaining: args,
      hasProject,
      hasGlobal,
    } = parseScopeFlags(rawArgs);
    // Reject mutually exclusive scope flags
    if (hasProject && hasGlobal) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot use both --project and --global. Choose one scope flag.',
        ),
      };
    }
    // Reject --project when workspace is untrusted — workspace settings are
    // ignored on merge, so the save would silently not take effect.
    if (
      scopeOverride === SettingScope.Workspace &&
      settings &&
      !settings.isTrusted
    ) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Workspace is untrusted; run /trust first or use --global.'),
      };
    }
    const scopeSuffix =
      scopeOverride === SettingScope.Workspace
        ? t(' (this project)')
        : scopeOverride === SettingScope.User
          ? t(' (global)')
          : '';
    const isVoiceModelCommand =
      args === '--voice' || args.startsWith('--voice ');
    if (isVoiceModelCommand) {
      const modelName = args.replace('--voice', '').trim();
      if (!modelName) {
        if (context.executionMode !== 'interactive') {
          const voiceModel =
            context.services.settings?.merged?.voiceModel?.trim() ||
            t('not set');
          return {
            type: 'message',
            messageType: 'info',
            content: t(
              'Current voice model: {{voiceModel}}\nUse "/model --voice <model-id>" to set voice model.',
              { voiceModel },
            ),
          };
        }
        return {
          type: 'dialog',
          dialog: 'voice-model',
          ...persistScopeSpread(scopeOverride),
        };
      }

      if (!settings) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Settings service not available.'),
        };
      }

      const availableModels = config
        .getAllConfiguredModels()
        .filter((m) => !m.fastOnly);
      const matches = availableModels.filter((model) => model.id === modelName);
      if (matches.length === 0) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatUnavailableVoiceModelMessage(
            modelName,
            availableModels,
          ),
        };
      }
      if (matches.length > 1) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            "Voice model '{{modelName}}' is ambiguous. Configure a unique model id before using /model --voice.",
            { modelName },
          ),
        };
      }
      if (!isSelectableVoiceModel(matches[0]!)) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatUnsupportedVoiceModelMessage(modelName),
        };
      }

      persistSetting(settings, 'voiceModel', modelName, scopeOverride);
      return {
        type: 'message',
        messageType: 'info',
        content: t('Voice Model') + ': ' + modelName + scopeSuffix,
      };
    }

    const isFastModelCommand = args === '--fast' || args.startsWith('--fast ');
    if (isFastModelCommand) {
      const modelName = args.replace('--fast', '').trim();
      if (!modelName) {
        // Open model dialog in fast-model mode (interactive) or return current fast model (non-interactive)
        if (context.executionMode !== 'interactive') {
          const fastModel =
            context.services.settings?.merged?.fastModel ?? 'not set';
          return {
            type: 'message',
            messageType: 'info',
            content: `Current fast model: ${fastModel}\nUse "/model --fast <model-id>" to set fast model.`,
          };
        }
        return {
          type: 'dialog',
          dialog: 'fast-model',
          ...persistScopeSpread(scopeOverride),
        };
      }
      // Set fast model
      if (!settings) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Settings service not available.'),
        };
      }

      const contentGeneratorConfig = config.getContentGeneratorConfig();
      const authType = contentGeneratorConfig?.authType;
      if (!authType) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Authentication type not available.'),
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
          content: formatUnavailableFastModelMessage(modelName, []),
        };
      }

      const availableModels = (
        selector.authType
          ? config.getAvailableModelsForAuthType(selector.authType)
          : config.getAllConfiguredModels()
      ).filter((m) => !m.voiceOnly);
      if (!availableModels.some((model) => model.id === selector.modelId)) {
        return {
          type: 'message',
          messageType: 'error',
          content: selector.authType
            ? formatUnavailableModelMessage(
                'Fast model',
                selector.modelId,
                selector.authType,
                availableModels,
              )
            : formatUnavailableFastModelMessage(modelName, availableModels),
        };
      }

      persistSetting(settings, 'fastModel', modelName, scopeOverride);
      // Sync the runtime Config so forked agents pick up the change immediately
      // without requiring a restart.
      config.setFastModel(modelName);
      return {
        type: 'message',
        messageType: 'info',
        content: t('Fast Model') + ': ' + modelName + scopeSuffix,
      };
    }

    const isVisionModelCommand =
      args === '--vision' || args.startsWith('--vision ');
    if (isVisionModelCommand) {
      const modelName = args.replace('--vision', '').trim();
      if (!modelName) {
        // Open the model picker in vision mode (interactive) or print the
        // current vision model (non-interactive).
        if (context.executionMode !== 'interactive') {
          const visionModel =
            context.services.settings?.merged?.visionModel?.trim();
          return {
            type: 'message',
            messageType: 'info',
            content: t(
              'Current vision model: {{visionModel}}\nUse "/model --vision <model-id>" to set the vision bridge model.',
              {
                visionModel: visionModel
                  ? formatVisionModelSettingForDisplay(visionModel)
                  : t('not set'),
              },
            ),
          };
        }
        return {
          type: 'dialog',
          dialog: 'vision-model',
          ...persistScopeSpread(scopeOverride),
        };
      }
      if (!settings) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Settings service not available.'),
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
          content: formatUnavailableVisionModelMessage(modelName, []),
        };
      }

      const availableModels = (
        selector.authType
          ? config.getAvailableModelsForAuthType(selector.authType)
          : config.getAllConfiguredModels()
      ).filter((m) => !m.fastOnly && !m.voiceOnly);
      const matchingModels = availableModels.filter(
        (model) => model.id === selector.modelId,
      );
      if (matchingModels.length > 1) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatAmbiguousVisionModelMessage(modelName, matchingModels),
        };
      }
      const matched = matchingModels[0];
      if (!matched) {
        return {
          type: 'message',
          messageType: 'error',
          content: selector.authType
            ? formatUnavailableModelMessage(
                'Vision model',
                selector.modelId,
                selector.authType,
                availableModels,
              )
            : formatUnavailableVisionModelMessage(modelName, availableModels),
        };
      }

      // Pinning the primary itself is a no-op at runtime (the bridge guard skips
      // it and falls back to auto-select), so reject it at set time instead of
      // persisting a dead pin and reporting success.
      if (config.isCurrentPrimaryModel(matched)) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            "'{{model}}' is the current primary model and cannot be used as the vision bridge. Choose a different image-capable model.",
            { model: modelName },
          ),
        };
      }

      const qualifiedModelName = `${
        selector.authType ?? matched.authType
      }:${selector.modelId}`;
      const visionModel = matched.baseUrl
        ? `${qualifiedModelName}\0${matched.baseUrl}`
        : qualifiedModelName;
      persistSetting(settings, 'visionModel', visionModel, scopeOverride);
      // Sync runtime Config so the vision bridge picks it up without a restart.
      config.setVisionModel(visionModel);
      // The pin is honored even if the model isn't image-capable (the user may
      // know better than our metadata), but warn — the bridge sends images to it.
      const visionWarning = isImageCapable(matched)
        ? ''
        : `\n${formatNonVisionModelWarning(modelName)}`;
      return {
        type: 'message',
        messageType: 'info',
        content:
          t('Vision Model') + ': ' + modelName + scopeSuffix + visionWarning,
      };
    }

    const contentGeneratorConfig = config.getContentGeneratorConfig();
    if (!contentGeneratorConfig) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Content generator configuration not available.'),
      };
    }

    const authType = contentGeneratorConfig.authType;
    if (!authType) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Authentication type not available.'),
      };
    }

    // `/model <id>` switches the session model; `/model <id> <prompt>` runs the
    // prompt on <id> for this turn only (inline one-shot override) without
    // changing or persisting the session model.
    const trimmedArgs = args.trim();
    const firstSpace = trimmedArgs.search(/\s/);
    const modelName =
      firstSpace === -1 ? trimmedArgs : trimmedArgs.slice(0, firstSpace);
    const inlinePrompt =
      firstSpace === -1 ? '' : trimmedArgs.slice(firstSpace + 1).trim();
    if (modelName) {
      const parsed = parseAcpModelOption(modelName);
      const targetAuthType = parsed.authType ?? authType;
      const availableModels = config
        .getAvailableModelsForAuthType(targetAuthType)
        .filter((m) => !m.fastOnly && !m.voiceOnly);
      if (!availableModels.some((model) => model.id === parsed.modelId)) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatUnavailableModelMessage(
            'Model',
            parsed.modelId,
            targetAuthType,
            availableModels,
          ),
        };
      }

      if (inlinePrompt) {
        // ACP hosts send the prompt on the session model via a separate
        // pipeline that doesn't thread a per-turn override, so the inline form
        // would silently run on the default model. Reject it there rather than
        // mislead; the two-step `/model <id>` flow still works in ACP.
        if (context.executionMode === 'acp') {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              "Inline one-shot override isn't supported in this mode — run '/model {{model}}' first, then send your prompt.",
              { model: modelName },
            ),
          };
        }
        // Scope flags are silently consumed by parseScopeFlags but the inline
        // prompt path doesn't persist the model. Reject the combination to avoid
        // surprising the user with a "(this project)" confirmation that never
        // took effect.
        if (scopeOverride) {
          const scopeFlag = hasProject
            ? '--project'
            : hasGlobal
              ? '--global'
              : '';
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              "Cannot combine {{flag}} with an inline prompt. Run '/model {{flag}} {{model}}' first, then send your prompt.",
              { flag: scopeFlag },
            ),
          };
        }
        // The per-turn override reuses the active provider's endpoint and
        // credentials and only swaps the model id; it cannot rebuild
        // baseUrl/envKey for a different provider. So the target must resolve to
        // the SAME provider identity, not merely the same auth type — otherwise
        // a same-id model owned by a different (e.g. OpenAI-compatible) provider
        // would be sent to the active endpoint/account. Reject an explicit
        // different auth type outright (the `(authType)` suffix), then require
        // the provider identity (baseUrl + envKey) to match the active content
        // generator via the shared check that consumers also enforce. Mismatches
        // are pointed at the two-step `/model <id>` flow, which does switch
        // providers.
        const sameAuthType = targetAuthType === authType;
        if (
          !sameAuthType ||
          !isInlineModelOverrideAllowed(config, parsed.modelId)
        ) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              "Inline one-shot override can't switch providers. '{{model}}' belongs to a different provider — run '/model {{model}}' first, then send your prompt.",
              { model: modelName },
            ),
          };
        }
        return {
          type: 'submit_prompt',
          content: inlinePrompt,
          modelOverride: parsed.modelId,
        };
      }

      if (!settings) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Settings service not available.'),
        };
      }
      const effectiveModelName = await switchMainModel(
        config,
        settings,
        authType,
        modelName,
        scopeOverride,
      );
      return {
        type: 'message',
        messageType: 'info',
        content: t('Model') + ': ' + effectiveModelName + scopeSuffix,
      };
    }

    // Non-interactive/ACP: set model if an arg was provided, otherwise show current model
    if (context.executionMode !== 'interactive') {
      // /model with no args — show current model
      const currentModel = config.getModel() ?? 'unknown';
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Current model: {{model}}\nUse "/model <model-id>" to switch models, "/model --fast <model-id>" to set the fast model, "/model --project <model-id>" to persist to project settings, or "/model --global <model-id>" to persist to user settings.',
          { model: currentModel },
        ),
      };
    }

    return {
      type: 'dialog',
      dialog: 'model',
      ...persistScopeSpread(scopeOverride),
    };
  },
};
