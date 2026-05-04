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
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  fetchWithTimeout,
  isPrivateIp,
  createDebugLogger,
  stripTerminalControlSequences,
  AuthType,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('MODEL_COMMAND');
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Sanitize a URL for logging by removing credentials and sensitive info.
 */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    parsed.username = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export const modelCommand: SlashCommand = {
  name: 'model',
  completionPriority: 100,
  get description() {
    return t('Switch the model for this session (--fast for suggestion model)');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  completion: async (_context, partialArg) => {
    const completions = [];

    // Filter by match for flags and subcommands
    if ('--fast'.startsWith(partialArg)) {
      completions.push({
        value: '--fast',
        description: t(
          'Set a lighter model for prompt suggestions and speculative execution',
        ),
      });
    }

    if ('list'.startsWith(partialArg)) {
      completions.push({
        value: 'list',
        description: t(
          'List available models from the configured API endpoint',
        ),
      });
    }

    return completions.length > 0 ? completions : null;
  },
  action: async (
    context: CommandContext,
  ): Promise<OpenDialogActionReturn | MessageActionReturn> => {
    const { services } = context;
    const { config, settings } = services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    // Handle --fast flag: /model --fast <modelName>
    const args = context.invocation?.args?.trim() ?? '';
    if (args.startsWith('--fast')) {
      const modelName = args.replace('--fast', '').trim();
      if (!modelName) {
        // Open model dialog in fast-model mode (interactive) or return current fast model (non-interactive)
        if (context.executionMode !== 'interactive') {
          const fastModel =
            context.services.settings?.merged?.fastModel ?? 'not set';
          return {
            type: 'message',
            messageType: 'info',
            content: t(
              'Current fast model: {{fastModel}}\nUse "/model --fast <model-id>" to set fast model.',
              { fastModel },
            ),
          };
        }
        return {
          type: 'dialog',
          dialog: 'fast-model',
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
      settings.setValue(
        getPersistScopeForModelSelection(settings),
        'fastModel',
        modelName,
      );
      // Sync the runtime Config so forked agents pick up the change immediately
      // without requiring a restart.
      config.setFastModel(modelName);
      return {
        type: 'message',
        messageType: 'info',
        content: t('Fast Model') + ': ' + modelName,
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

    // Non-interactive/ACP: set model if an arg was provided, otherwise show current model
    if (context.executionMode !== 'interactive') {
      const modelName = args.trim();
      if (modelName) {
        // /model <model-id> — set the main model
        if (!settings) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Settings service not available.'),
          };
        }
        settings.setValue(
          getPersistScopeForModelSelection(settings),
          'model.name',
          modelName,
        );
        await config.setModel(modelName);
        return {
          type: 'message',
          messageType: 'info',
          content: t('Model') + ': ' + modelName,
        };
      }
      // /model with no args — show current model
      const currentModel = config.getModel() ?? 'unknown';
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Current model: {{currentModel}}\nUse "/model <model-id>" to switch models or "/model --fast <model-id>" to set the fast model.',
          { currentModel },
        ),
      };
    }

    return {
      type: 'dialog',
      dialog: 'model',
    };
  },
  subCommands: [
    {
      name: 'list',
      get description() {
        return t('List available models from the configured API endpoint');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: async (context: CommandContext): Promise<MessageActionReturn> => {
        const { services } = context;
        const { config } = services;

        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Configuration not available.'),
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

        const { baseUrl, apiKey, authType, customHeaders, proxy } =
          contentGeneratorConfig;

        if (!baseUrl) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              'No baseUrl configured. Please configure modelProviders or set the API endpoint.',
            ),
          };
        }

        try {
          const models = await fetchModels(
            baseUrl,
            apiKey,
            authType,
            customHeaders,
            context.abortSignal,
            proxy,
          );
          if (models.length === 0) {
            return {
              type: 'message',
              messageType: 'info',
              content: t('No models found from the configured endpoint.'),
            };
          }
          const output = models.join('\n');
          return {
            type: 'message',
            messageType: 'info',
            content: output,
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            type: 'message',
            messageType: 'error',
            content: t('Failed to fetch models from {{url}}: {{error}}', {
              url: baseUrl,
              error: errorMessage,
            }),
          };
        }
      },
    },
  ],
};

/**
 * Fetch available models from the OpenAI-compatible /models endpoint.
 * Returns an array of model ID strings.
 * Exported for testing purposes.
 */
export async function fetchModels(
  baseUrl: string,
  apiKey?: string,
  authType?: AuthType,
  customHeaders?: Record<string, string>,
  signal?: AbortSignal,
  proxy?: string,
): Promise<string[]> {
  // Guard against non-compatible auth types
  if (authType === AuthType.QWEN_OAUTH) {
    throw new Error(
      t(
        'Model discovery is not supported for Qwen OAuth. Please switch to an OpenAI-compatible provider.',
      ),
    );
  }

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(t('Invalid baseUrl: must be a valid URL'));
  }

  // Enforce HTTPS
  if (parsed.protocol !== 'https:') {
    throw new Error(t('baseUrl must use HTTPS'));
  }

  // SSRF protection: block private IPs and localhost.
  // Parse hostname once, then classify — do NOT pass a URL string to isPrivateIp.
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('[') || // IPv6 literal in Node 20+ includes brackets
    isPrivateIp(hostname)
  ) {
    throw new Error(t('baseUrl points to a private IP address (SSRF check)'));
  }

  // Normalize baseUrl: strip trailing slashes and /models suffix, then append /models.
  // Use URL object to correctly handle query strings and fragments.
  const urlObj = new URL(baseUrl);
  urlObj.pathname =
    urlObj.pathname.replace(/\/+$/, '').replace(/\/models$/i, '') + '/models';
  const url = urlObj.toString();
  const headers: Record<string, string> = {};

  // Apply custom headers first (case-insensitive merge)
  if (customHeaders) {
    for (const [key, value] of Object.entries(customHeaders)) {
      headers[key.toLowerCase()] = value;
    }
  }

  // Set defaults if not overridden
  if (!headers['accept']) {
    headers['accept'] = 'application/json';
  }

  if (apiKey && !headers['authorization']) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  const sanitizedUrl = sanitizeUrl(url);
  debugLogger.debug('Fetching models', {
    url: sanitizedUrl,
    proxy: proxy ?? 'none',
  });

  const startTime = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, headers, signal, {
      redirect: 'error',
    });
  } catch (error) {
    debugLogger.debug('Models request failed', {
      error,
      url: sanitizedUrl,
      proxy: proxy ?? 'none',
    });
    throw error;
  }

  debugLogger.debug('Models response', {
    status: response.status,
    duration: Date.now() - startTime,
    proxy: proxy ?? 'none',
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Sanitize API key from error messages to prevent leakage
    const truncated = errorText.slice(0, 500);
    const sanitized = apiKey
      ? truncated.replaceAll(apiKey, '[REDACTED]')
      : truncated;
    throw new Error(
      t('Request to {{url}} failed ({{status}}): {{sanitized}}', {
        url,
        status: String(response.status),
        sanitized,
      }),
    );
  }

  const json = (await response.json()) as unknown;
  let modelList: unknown[] = [];
  let foundValidStructure = false;

  // Normalize various response shapes (OpenAI, Ollama, DeepSeek, etc.)
  if (Array.isArray(json)) {
    // Bare array: [{id: "model-1"}, ...] or ["model-1", ...]
    modelList = json;
    foundValidStructure = true;
  } else if (json && typeof json === 'object') {
    const data = json as Record<string, unknown>;
    if (Array.isArray(data['data'])) {
      // Standard OpenAI: { data: [{id: "model-1"}, ...] }
      modelList = data['data'] as unknown[];
      foundValidStructure = true;
    } else if (Array.isArray(data['models'])) {
      // Some providers use 'models' instead of 'data'
      modelList = data['models'] as unknown[];
      foundValidStructure = true;
    }
  }

  if (!foundValidStructure) {
    throw new Error(t('Unexpected response format: missing data array'));
  }

  // Type-check model IDs: only accept non-empty strings, and sanitize for terminal safety
  return modelList
    .map((model) => {
      if (typeof model === 'string') return model;
      if (model && typeof model === 'object' && 'id' in model) {
        return (model as { id: unknown }).id;
      }
      return undefined;
    })
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => stripTerminalControlSequences(id).trim())
    .filter((id) => id.length > 0);
}
