/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import { getErrorMessage } from '../../utils/errorMessage.js';
import type { Protocol } from '@qwen-code/qwen-code-core';
import {
  ALL_PROVIDERS,
  ALIBABA_PROVIDERS,
  AuthType,
  THIRD_PARTY_PROVIDERS,
  shouldShowStep,
  resolveBaseUrl,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  type ProviderConfig,
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
        console.warn(
          '[AuthMessageHandler] Unknown message type:',
          message.type,
        );
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
      console.error('[AuthMessageHandler] getAccountInfo failed:', error);
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
        console.error('[AuthMessageHandler] Provider not found:', selectedId);
        return;
      }

      // Run generic setup flow
      await this.runProviderSetupFlow(provider);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error('[AuthMessageHandler] auth failed:', error);
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
    let protocol: Protocol | undefined;
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
      protocol = selected as Protocol;
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
    if (shouldShowStep(provider, 'models')) {
      const defaults = getDefaultModelIds(provider);
      const modelInput = await this.input({
        title: `${flowTitle}: Models`,
        prompt: 'Enter model IDs (comma-separated)',
        placeHolder: defaults.join(',') || 'model-name',
        value: defaults.join(','),
        required: true,
      });
      if (!modelInput) return;
      modelIds = modelInput
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      if (modelIds.length === 0) {
        // E.g. user typed only whitespace/commas like ", , ,". No
        // authCancelled — see the base-URL validation note above.
        this.sendToWebView({
          type: 'authError',
          data: { message: 'Model IDs cannot be empty.' },
        });
        return;
      }
    } else {
      modelIds = getDefaultModelIds(provider);
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
      console.error(
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
      advancedConfig,
    });
  }
}
