/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import { getErrorMessage } from '../../utils/errorMessage.js';

/**
 * Auth message handler
 * Handles all authentication-related messages
 */
export class AuthMessageHandler extends BaseMessageHandler {
  private authInteractiveHandler:
    | ((
        provider: string,
        region?: string,
        apiKey?: string,
        baseUrl?: string,
        model?: string,
        modelIds?: string,
      ) => Promise<void>)
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
   * Set auth interactive handler — interactive auth flow.
   */
  setAuthInteractiveHandler(
    handler: (
      provider: string,
      region?: string,
      apiKey?: string,
      baseUrl?: string,
      model?: string,
      modelIds?: string,
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

  // ---------------------------------------------------------------------------
  // auth: Interactive auth flow (mirrors CLI's /auth)
  // ---------------------------------------------------------------------------

  // Alibaba Standard API Key region endpoints
  private static readonly ALIBABA_STANDARD_ENDPOINTS: Record<string, string> = {
    'cn-beijing': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'sg-singapore': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'us-virginia': 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    'cn-hongkong':
      'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
  };

  /**
   * Helper: show a QuickPick and return the selected item's `value`.
   * Returns undefined if the user cancels.
   */
  private async pick<T extends string>(
    items: Array<{ label: string; description?: string; value: T }>,
    title: string,
    placeHolder: string,
  ): Promise<T | undefined> {
    const choice = await vscode.window.showQuickPick(items, {
      title,
      placeHolder,
    });
    return choice ? (choice as { value: T }).value : undefined;
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
    return vscode.window.showInputBox({
      title: opts.title,
      prompt: opts.prompt,
      placeHolder: opts.placeHolder,
      value: opts.value,
      password: opts.password ?? false,
      validateInput: opts.required
        ? (v) => (!v?.trim() ? 'This field is required' : null)
        : undefined,
    });
  }

  /**
   * Handle auth — full interactive auth flow.
   *
   * Tree (mirrors CLI AuthDialog):
   *   |- Coding Plan -> Region (China/Global) -> API Key -> done
   *   \- API Key
   *      |- Alibaba Standard -> Region (4 regions) -> API Key -> Model IDs -> done
   *      \- Custom -> Base URL -> API Key -> Model -> done
   */
  private async handleAuthInteractive(): Promise<void> {
    try {
      // Main menu
      const provider = await this.pick(
        [
          {
            label: 'Alibaba Cloud Coding Plan',
            description:
              'Paid · Up to 6,000 requests/5 hrs · All Coding Plan Models',
            value: 'coding-plan' as const,
          },
          {
            label: 'API Key',
            description: 'Bring your own API key',
            value: 'api-key' as const,
          },
        ],
        'Qwen Code: Auth',
        'Select authentication method',
      );
      if (!provider) {
        return;
      }

      if (provider === 'coding-plan') {
        await this.authCodingPlan();
      } else {
        await this.authApiKey();
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error('[AuthMessageHandler] auth failed:', error);
      this.sendToWebView({
        type: 'authError',
        data: { message: `Auth failed: ${errorMsg}` },
      });
    }
  }

  /**
   * Coding Plan: region -> API key -> connect.
   */
  private async authCodingPlan(): Promise<void> {
    const region = await this.pick(
      [
        {
          label: '中国 (China)',
          description: '阿里云百炼 — aliyun.com',
          value: 'china' as const,
        },
        {
          label: 'Global',
          description: 'Alibaba Cloud — alibabacloud.com',
          value: 'global' as const,
        },
      ],
      'Qwen Code: Coding Plan Region',
      'Select region',
    );
    if (!region) {
      return;
    }

    const apiKey = await this.input({
      title: 'Qwen Code: API Key',
      prompt: 'Enter your Coding Plan API key',
      placeHolder: 'sk-...',
      password: true,
      required: true,
    });
    if (!apiKey) {
      return;
    }

    if (this.authInteractiveHandler) {
      await this.authInteractiveHandler('coding-plan', region, apiKey);
    }
  }

  /**
   * API Key: select type -> Alibaba Standard or Custom.
   */
  private async authApiKey(): Promise<void> {
    const keyType = await this.pick(
      [
        {
          label: 'Alibaba Cloud ModelStudio Standard API Key',
          description: 'Quick setup for Model Studio (China/International)',
          value: 'alibaba-standard' as const,
        },
        {
          label: 'Custom API Key',
          description:
            'For other OpenAI / Anthropic / Gemini-compatible providers',
          value: 'custom' as const,
        },
      ],
      'Qwen Code: Select API Key Type',
      'Select API key type',
    );
    if (!keyType) {
      return;
    }

    if (keyType === 'alibaba-standard') {
      await this.authAlibabaStandard();
    } else {
      await this.authCustom();
    }
  }

  /**
   * Alibaba Standard: region -> API key -> model IDs -> connect.
   */
  private async authAlibabaStandard(): Promise<void> {
    const endpoints = AuthMessageHandler.ALIBABA_STANDARD_ENDPOINTS;

    const region = await this.pick(
      Object.entries(endpoints).map(([key, endpoint]) => ({
        label:
          key === 'cn-beijing'
            ? 'China (Beijing)'
            : key === 'sg-singapore'
              ? 'Singapore'
              : key === 'us-virginia'
                ? 'US (Virginia)'
                : 'China (Hong Kong)',
        description: `Endpoint: ${endpoint}`,
        value: key,
      })),
      'Qwen Code: Select Region',
      'Select region for Alibaba Cloud ModelStudio',
    );
    if (!region) {
      return;
    }

    const apiKey = await this.input({
      title: 'Qwen Code: API Key',
      prompt: 'Enter your Alibaba Cloud ModelStudio API key',
      placeHolder: 'sk-...',
      password: true,
      required: true,
    });
    if (!apiKey) {
      return;
    }

    const modelIds = await this.input({
      title: 'Qwen Code: Model IDs',
      prompt: 'Enter model IDs (comma-separated)',
      placeHolder: 'qwen3.5-plus,glm-5,kimi-k2.5',
      value: 'qwen3.5-plus',
      required: true,
    });
    if (!modelIds) {
      return;
    }

    const baseUrl = endpoints[region] || endpoints['cn-beijing'];
    const firstModel = modelIds.split(',')[0]?.trim() || 'qwen3.5-plus';

    if (this.authInteractiveHandler) {
      await this.authInteractiveHandler(
        'alibaba-standard',
        region,
        apiKey,
        baseUrl,
        firstModel,
        modelIds,
      );
    }
  }

  /**
   * Custom: base URL -> API key -> model -> connect.
   */
  private async authCustom(): Promise<void> {
    const baseUrl = await this.input({
      title: 'Qwen Code: Base URL',
      prompt: 'Enter API base URL',
      placeHolder: 'https://api.openai.com/v1',
      value: 'https://api.openai.com/v1',
    });
    if (baseUrl === undefined) {
      return;
    }

    const apiKey = await this.input({
      title: 'Qwen Code: API Key',
      prompt: 'Enter your API key',
      placeHolder: 'sk-...',
      password: true,
      required: true,
    });
    if (!apiKey) {
      return;
    }

    const model = await this.input({
      title: 'Qwen Code: Model',
      prompt: 'Enter model name',
      placeHolder: 'gpt-4o',
      required: true,
    });
    if (!model) {
      return;
    }

    if (this.authInteractiveHandler) {
      await this.authInteractiveHandler(
        'api-key',
        undefined,
        apiKey,
        baseUrl,
        model,
      );
    }
  }
}
