/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '../../utils/logger.js';
import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import { getErrorMessage } from '../../utils/errorMessage.js';
import {
  ALL_PROVIDERS,
  ALIBABA_PROVIDERS,
  AuthType,
  THIRD_PARTY_PROVIDERS,
  shouldShowStep,
  resolveBaseUrl,
  findExistingProviderModels,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  normalizeBaseUrlForMatching,
  legacyEnvKeyAttribution,
  type ProviderConfig,
  type ProviderModelConfig,
  type ProviderSetupInputs,
  type BaseUrlOption,
} from '@qwen-code/qwen-code-core';

/**
 * Auth message handler
 * Handles all authentication-related messages.
 *
 * Uses the shared ProviderConfig registry from core to dynamically
 * generate setup flows instead of hardcoding provider-specific logic.
 */
export class AuthMessageHandler extends BaseMessageHandler {
  private authInteractiveHandler:
    | ((config: ProviderConfig, inputs: ProviderSetupInputs) => Promise<void>)
    | null = null;

  constructor(
    agentManager: ConstructorParameters<typeof BaseMessageHandler>[0],
    conversationStore: ConstructorParameters<typeof BaseMessageHandler>[1],
    currentConversationId: string | null,
    sendToWebView: (message: unknown) => void,
    private readonly getModelProviders: () =>
      | Record<string, unknown>
      | undefined = () => undefined,
  ) {
    super(
      agentManager,
      conversationStore,
      currentConversationId,
      sendToWebView,
    );
  }

  canHandle(messageType: string): boolean {
    return ['auth', 'getAccountInfo'].includes(messageType);
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    switch (message.type) {
      case 'auth':
        await this.handleAuthInteractive();
        break;

      case 'getAccountInfo':
        await this.handleGetAccountInfo();
        break;

      default:
        logger.warn('[AuthMessageHandler] Unknown message type:', message.type);
        break;
    }
  }

  /**
   * Set auth interactive handler — called with provider config and user inputs.
   */
  setAuthInteractiveHandler(
    handler: (
      config: ProviderConfig,
      inputs: ProviderSetupInputs,
    ) => Promise<void>,
  ): void {
    this.authInteractiveHandler = handler;
  }

  /**
   * Handle getAccountInfo request
   */
  private async handleGetAccountInfo(): Promise<void> {
    try {
      const info = await this.agentManager.getAccountInfo();
      this.sendToWebView({
        type: 'accountInfo',
        data: {
          authType: info.authType,
          baseUrl: info.baseUrl,
          envKey: info.apiKeyEnvKey,
          modelId: info.model,
        },
      });
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      logger.error('[AuthMessageHandler] getAccountInfo failed:', error);
      this.sendToWebView({
        type: 'accountInfo',
        data: { error: errorMsg },
      });
    }
  }

  /**
   * Notify the webview that the interactive auth flow was dismissed.
   */
  private notifyAuthCancelled(): void {
    this.sendToWebView({ type: 'authCancelled' });
  }

  /**
   * Helper: show a QuickPick and return the selected item's `value`.
   * Returns undefined if the user cancels.
   *
   * Items with `kind: Separator` are rendered by VSCode as non-selectable
   * group headers; they should be left in `items` to preserve grouping.
   */
  private async pick<T extends string>(
    items: Array<{
      label: string;
      description?: string;
      value: T;
      kind?: vscode.QuickPickItemKind;
    }>,
    title: string,
    placeHolder: string,
  ): Promise<T | undefined> {
    const choice = await vscode.window.showQuickPick(items, {
      title,
      placeHolder,
      ignoreFocusOut: true,
    });
    if (!choice || choice.kind === vscode.QuickPickItemKind.Separator) {
      this.notifyAuthCancelled();
      return undefined;
    }
    return (choice as { value: T }).value;
  }

  /**
   * Helper: show an InputBox. Returns undefined if the user cancels.
   */
  private async input(opts: {
    title: string;
    prompt: string;
    placeHolder?: string;
    value?: string;
    password?: boolean;
    required?: boolean;
  }): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: opts.title,
      prompt: opts.prompt,
      placeHolder: opts.placeHolder,
      value: opts.value,
      password: opts.password ?? false,
      ignoreFocusOut: true,
      validateInput: opts.required
        ? (v) => (!v?.trim() ? 'This field is required' : null)
        : undefined,
    });
    if (value === undefined) {
      this.notifyAuthCancelled();
      return undefined;
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // Main entry: dynamic provider selection from ALL_PROVIDERS
  // ---------------------------------------------------------------------------

  /**
   * Handle auth — full interactive auth flow.
   * Dynamically generates provider choices from the shared registry.
   */
  private async handleAuthInteractive(): Promise<void> {
    try {
      // Build grouped provider menu
      const items: Array<{
        label: string;
        description?: string;
        value: string;
        kind?: vscode.QuickPickItemKind;
      }> = [];

      const addGroup = (
        label: string,
        providers: readonly ProviderConfig[],
      ) => {
        if (providers.length === 0) return;
        items.push({
          label,
          value: '',
          kind: vscode.QuickPickItemKind.Separator,
        });
        for (const p of providers) {
          items.push({
            label: p.label,
            description: p.description,
            value: p.id,
          });
        }
      };

      addGroup('Alibaba Cloud', ALIBABA_PROVIDERS);
      addGroup('Third Party', THIRD_PARTY_PROVIDERS);

      // Custom provider is always last
      const customProviders = ALL_PROVIDERS.filter(
        (p) => p.uiGroup === 'custom',
      );
      if (customProviders.length > 0) {
        addGroup('Custom', customProviders);
      }

      // Pass items including separators; VSCode QuickPick renders separator
      // entries as non-selectable group headers (mirrors the CLI grouping).
      const selectedId = await this.pick(
        items,
        'Qwen Code: Select Provider',
        'Choose how to connect',
      );
      if (!selectedId) return;

      const provider = ALL_PROVIDERS.find((p) => p.id === selectedId);
      if (!provider) {
        logger.error('[AuthMessageHandler] Provider not found:', selectedId);
        return;
      }

      // Run generic setup flow
      await this.runProviderSetupFlow(provider);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      logger.error('[AuthMessageHandler] auth failed:', error);
      this.sendToWebView({
        type: 'authError',
        data: { message: `Auth failed: ${errorMsg}` },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Generic provider setup flow — driven by ProviderConfig
  // ---------------------------------------------------------------------------

  private async runProviderSetupFlow(provider: ProviderConfig): Promise<void> {
    const flowTitle =
      provider.uiLabels?.flowTitle ?? `Qwen Code: ${provider.label}`;

    // Step 0: Protocol (only for providers offering multiple, e.g. custom)
    let protocol: AuthType | undefined;
    if (
      shouldShowStep(provider, 'protocol') &&
      provider.protocolOptions &&
      provider.protocolOptions.length > 1
    ) {
      // AuthType's raw string values ('openai' / 'anthropic' / 'gemini') are
      // implementation detail; QuickPick should show human-readable labels.
      const protocolLabels: Record<string, string> = {
        [AuthType.USE_OPENAI]: 'OpenAI Compatible',
        [AuthType.USE_ANTHROPIC]: 'Anthropic',
        [AuthType.USE_GEMINI]: 'Gemini',
      };
      const selected = await this.pick(
        provider.protocolOptions.map((p) => ({
          label: protocolLabels[String(p)] ?? String(p),
          value: String(p),
        })),
        `${flowTitle}: Protocol`,
        'Select API protocol',
      );
      if (!selected) return;
      protocol = selected as AuthType;
    }

    // Step 1: Base URL (if needed)
    let baseUrl: string;
    if (shouldShowStep(provider, 'baseUrl')) {
      if (Array.isArray(provider.baseUrl)) {
        const options = provider.baseUrl as BaseUrlOption[];
        const stepTitle = provider.uiLabels?.baseUrlStepTitle ?? 'Endpoint';
        const selected = await this.pick(
          options.map((opt) => ({
            label: opt.label,
            description: opt.url,
            value: opt.url,
          })),
          `${flowTitle}: ${stepTitle}`,
          `Select ${stepTitle.toLowerCase()}`,
        );
        if (!selected) return;
        baseUrl = selected;
      } else {
        // Free-form URL input. Show a protocol-specific default as
        // placeholder (NOT pre-filled value) so picking Anthropic/Gemini
        // doesn't silently write the OpenAI endpoint when the user hits
        // Enter on the OpenAI default. Defaults come from core's shared
        // getDefaultBaseUrlForProtocol so CLI and VS Code stay in sync.
        const effectiveProtocol = protocol ?? provider.protocol;
        // No local fallback: getDefaultBaseUrlForProtocol owns the defaults.
        // Adding an OpenAI fallback here would silently mask a new AuthType
        // that core hadn't been taught about, diverging from the CLI flow
        // (which shows an empty placeholder + scheme error in the same case).
        const placeholder = getDefaultBaseUrlForProtocol(effectiveProtocol);
        const urlInput = await this.input({
          title: `${flowTitle}: Base URL`,
          prompt: 'Enter API base URL',
          placeHolder: placeholder,
          value: '',
        });
        if (urlInput === undefined) return;
        baseUrl = urlInput.trim() || placeholder;
        if (!/^https?:\/\//i.test(baseUrl)) {
          // authError already clears the webview's connecting state; do NOT
          // also send authCancelled — the webview clears the error on
          // cancel, so the two messages race and the error flashes away
          // before the user can read it. authCancelled is reserved for
          // user-initiated dismissals (Escape on a QuickPick/InputBox).
          this.sendToWebView({
            type: 'authError',
            data: {
              message: 'Base URL must start with http:// or https://.',
            },
          });
          return;
        }
      }
    } else {
      baseUrl = resolveBaseUrl(provider);
    }

    // Step 2: API Key
    const apiKeyInput = await this.input({
      title: `${flowTitle}: API Key`,
      prompt: 'Enter your API key',
      placeHolder: provider.apiKeyPlaceholder ?? 'sk-...',
      password: true,
      required: true,
    });
    if (!apiKeyInput) return;
    // Trim before validation and persistence — a key pasted with trailing
    // whitespace would otherwise be stored as-is and cause silent auth
    // failures, and validateApiKey could reject in VS Code what the CLI
    // (which trims) accepts.
    const apiKey = apiKeyInput.trim();
    if (!apiKey) return;

    // Validate API key if provider has validation
    if (provider.validateApiKey) {
      const validationError = provider.validateApiKey(apiKey, baseUrl);
      if (validationError) {
        // No authCancelled here — see the base-URL validation note above.
        this.sendToWebView({
          type: 'authError',
          data: { message: validationError },
        });
        return;
      }
    }

    // Step 3: Model selection (if needed)
    let modelIds: string[];
    let preserveModels: ProviderModelConfig[] | undefined;
    let migratedLegacyModelIds: string[] | undefined;
    let adoptedFloatingModelIds: string[] | undefined;
    if (shouldShowStep(provider, 'models')) {
      const defaults = getDefaultModelIds(provider, baseUrl);
      const defaultIdSet = new Set(defaults);
      const existing = findExistingProviderModels(
        provider,
        this.getModelProviders(),
        protocol,
      );
      const selectedEndpoint = normalizeBaseUrlForMatching(baseUrl);
      // Endpoint attribution for baseUrl-less legacy entries (R45-4, R45-5),
      // mirroring the CLI dialog / ACP / serve gates. An entry whose env key
      // fails attribution (a floating key, or a fail-closed shared key naming
      // the whole endpoint group) is NEVER seeded, stamped, or claimed on this
      // surface: seeding it would let the submission adopt and re-home or
      // delete an entry that belongs to no endpoint (or a sibling's), and a
      // stamped copy could never claim the stored original — leaving a
      // permanent duplicate. The non-merge branch below still carries the
      // fail-closed entries through UNSTAMPED so a non-merge plan's unscoped
      // ownsModel does not delete them.
      const { endpointEnvKey, namesSelectedEndpoint, namesSiblingEndpoint } =
        legacyEnvKeyAttribution(
          provider,
          protocol ?? provider.protocol,
          baseUrl,
        );
      const isSelectedEndpointModel = (model: ProviderModelConfig) => {
        const endpointScoped =
          provider.mergeModelsByIdentity && Array.isArray(provider.baseUrl);
        return endpointScoped
          ? // An attributable baseUrl-less legacy entry belongs to the
            // selected endpoint exactly like a stamped one: admitting it
            // here lets the merge branch below stamp it and record it in
            // migratedLegacyModelIds. Dropping every baseUrl-less entry
            // BEFORE the attribution filter wired that stamp/migrate path
            // dead for exactly the array-baseUrl merge providers it was
            // written for (the Kimi/Xiaomi presets), leaving the entry
            // unseeded and unclaimed — a permanent duplicate re-created on
            // every reconnect.
            (model.baseUrl !== undefined &&
              normalizeBaseUrlForMatching(model.baseUrl) ===
                selectedEndpoint) ||
              (model.baseUrl === undefined && namesSelectedEndpoint(model))
          : model.baseUrl === undefined ||
              normalizeBaseUrlForMatching(model.baseUrl) === selectedEndpoint;
      };
      // Admitted entries BEFORE the id dedup: the claim channel below must
      // record every attributable baseUrl-less entry even when a stamped
      // twin precedes it in storage and the dedup keeps the twin instead.
      const admittedModels = (
        existing?.models.filter(isSelectedEndpointModel) ?? []
      ).filter(
        (model) => model.baseUrl !== undefined || namesSelectedEndpoint(model),
      );
      const restoredModels = admittedModels.filter(
        (model, index, models) =>
          models.findIndex((candidate) => candidate.id === model.id) === index,
      );
      const restoredIds = [...new Set(restoredModels.map((model) => model.id))];
      const seededModelIds = [
        ...defaults,
        ...restoredIds.filter((id) => !defaults.includes(id)),
      ];
      const modelInput = await this.input({
        title: `${flowTitle}: Models`,
        prompt: 'Enter model IDs (comma-separated)',
        placeHolder: defaults.join(',') || 'model-name',
        value: seededModelIds.join(','),
        required: true,
      });
      if (!modelInput) return;
      modelIds = [
        ...new Set(
          modelInput
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];
      if (modelIds.length === 0) {
        // E.g. user typed only whitespace/commas like ", , ,". No
        // authCancelled — see the base-URL validation note above.
        this.sendToWebView({
          type: 'authError',
          data: { message: 'Model IDs cannot be empty.' },
        });
        return;
      }
      const selectedIdSet = new Set(modelIds);
      if (provider.mergeModelsByIdentity) {
        // Record the claim for EVERY attributable baseUrl-less entry the
        // seed admitted — selected or not — mirroring computePreservedModels
        // and the ACP route: a deselected entry must be removed like any
        // other omission, and a default-id entry regenerates stamped while
        // the claim collapses the pair. Without the channel the stored
        // original was never owned and survived prepend-and-remove-owned —
        // every reconnect re-showed and re-ignored the deselection (R46-1).
        // Collected ahead of the twin dedup so an original whose stamped
        // twin precedes it in storage is still claimed.
        const migrated: string[] = [
          ...new Set(
            admittedModels
              .filter((model) => model.baseUrl === undefined)
              .map((model) => model.id),
          ),
        ];
        const restoredPreserved = restoredModels
          .filter(
            (model) =>
              !defaultIdSet.has(model.id) && selectedIdSet.has(model.id),
          )
          // Stamp a selected legacy model before identity merging so its
          // rich configuration survives canonical regeneration (same as
          // the non-merge branch below and the CLI/ACP/serve surfaces).
          // restoredModels carries only ATTRIBUTABLE baseUrl-less entries
          // (gated above), so stamping one migrates it to the selected
          // endpoint: its id was recorded above so buildInstallPlan claims
          // the stored original and collapses the pair instead of
          // persisting both (R45-5).
          .map((model) =>
            model.baseUrl === undefined ? { ...model, baseUrl } : model,
          );
        // STALE-STAMPED adoption (twin of the CLI dialog's stale-stamped
        // branch): a stamped entry whose baseUrl matches no preset option is
        // never seeded by this surface, so only an explicitly typed id
        // claims it — re-stamped at the submission endpoint and recorded in
        // migratedLegacyModelIds so the plan's stale-stamped clause
        // collapses the stored original instead of persisting a permanent
        // duplicate beside it. An untyped stale entry is never claimed and
        // survives the endpoint-scoped merge (R46-2).
        const baseUrlOptions = Array.isArray(provider.baseUrl)
          ? provider.baseUrl
          : undefined;
        const staleAdoptedModels = baseUrlOptions
          ? (existing?.models ?? []).flatMap((model) => {
              if (
                model.baseUrl === undefined ||
                !selectedIdSet.has(model.id) ||
                baseUrlOptions.some(
                  (option) =>
                    normalizeBaseUrlForMatching(option.url) ===
                    normalizeBaseUrlForMatching(model.baseUrl),
                )
              ) {
                return [];
              }
              migrated.push(model.id);
              return [
                {
                  ...model,
                  baseUrl,
                  ...(endpointEnvKey ? { envKey: endpointEnvKey } : {}),
                },
              ];
            })
          : [];
        // Floating adoption: a baseUrl-less entry whose env key names NO
        // endpoint never passes the attribution gate above, so it is never
        // seeded — but when the user explicitly types its id into the
        // models field the submission adopts it: stamp it into
        // preserveModels and thread its id through
        // adoptedFloatingModelIds so buildInstallPlan claims the stored
        // original (without the channel the stamped copy is written while
        // the original can never be claimed — a permanent duplicate with
        // the rich generationConfig stranded). Mirrors the ACP/serve
        // adoption channel; sibling/fail-closed keys are never adoptable.
        const adopted: string[] = [];
        const adoptedModels = (existing?.models ?? []).flatMap((model) => {
          if (
            model.baseUrl !== undefined ||
            !selectedIdSet.has(model.id) ||
            defaultIdSet.has(model.id) ||
            namesSelectedEndpoint(model) ||
            namesSiblingEndpoint(model)
          ) {
            return [];
          }
          adopted.push(model.id);
          return [
            {
              ...model,
              baseUrl,
              // Adoption re-keys the entry to the selected endpoint's key
              // (R39-6), matching the ACP/serve stamp semantics.
              ...(endpointEnvKey ? { envKey: endpointEnvKey } : {}),
            },
          ];
        });
        preserveModels = [
          ...restoredPreserved,
          ...adoptedModels,
          ...staleAdoptedModels,
        ];
        if (migrated.length > 0) {
          migratedLegacyModelIds = [...new Set(migrated)];
        }
        if (adopted.length > 0) adoptedFloatingModelIds = [...new Set(adopted)];
      } else {
        preserveModels = existing?.models.flatMap((model) => {
          // A baseUrl-less legacy entry whose env key fails attribution
          // closed (the static shared key of minimax/zai/alibaba-standard
          // names the whole endpoint group) is untouchable: a non-merge plan
          // carries the provider's UNSCOPED ownsModel, so stamping it would
          // re-home it to whichever endpoint was picked and dropping it would
          // delete it. Carry it through UNSTAMPED — the ACP/serve/CLI gate
          // (R45-4).
          if (
            model.baseUrl === undefined &&
            !namesSelectedEndpoint(model) &&
            namesSiblingEndpoint(model)
          ) {
            return [model];
          }
          if (!isSelectedEndpointModel(model)) return [model];
          if (defaultIdSet.has(model.id) || !selectedIdSet.has(model.id)) {
            return [];
          }
          // Stamp a selected legacy model before identity merging so its
          // rich configuration survives canonical regeneration.
          return [model.baseUrl === undefined ? { ...model, baseUrl } : model];
        });
      }
    } else {
      modelIds = getDefaultModelIds(provider, baseUrl);
    }

    // Step 4: Advanced config (if needed)
    let advancedConfig: ProviderSetupInputs['advancedConfig'];
    if (shouldShowStep(provider, 'advancedConfig')) {
      // Simplified: just ask about thinking mode
      const enableThinking = await this.pick(
        [
          {
            label: 'Yes',
            description: 'Enable extended thinking mode',
            value: 'yes' as const,
          },
          {
            label: 'No',
            description: 'Standard mode',
            value: 'no' as const,
          },
        ],
        `${flowTitle}: Advanced Config`,
        'Enable thinking mode?',
      );
      if (!enableThinking) return;
      advancedConfig = {
        enableThinking: enableThinking === 'yes',
      };
    }

    // Submit
    if (!this.authInteractiveHandler) {
      logger.error(
        '[AuthMessageHandler] authInteractiveHandler not set; cannot apply provider config.',
      );
      // No authCancelled — see the base-URL validation note above.
      this.sendToWebView({
        type: 'authError',
        data: {
          message:
            'Auth handler not initialized. Please reopen the panel and try again.',
        },
      });
      return;
    }
    await this.authInteractiveHandler(provider, {
      protocol,
      baseUrl,
      apiKey,
      modelIds,
      ...(preserveModels && preserveModels.length > 0
        ? { preserveModels }
        : {}),
      ...(migratedLegacyModelIds && migratedLegacyModelIds.length > 0
        ? { migratedLegacyModelIds }
        : {}),
      ...(adoptedFloatingModelIds && adoptedFloatingModelIds.length > 0
        ? { adoptedFloatingModelIds }
        : {}),
      advancedConfig,
    });
  }
}
