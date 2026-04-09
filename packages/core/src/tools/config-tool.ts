/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolInfoConfirmationDetails,
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type { FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  SUPPORTED_CONFIG_SETTINGS,
  getAllKeys,
  getDescriptor,
  getOptionsForSetting,
  isSupported,
} from './supported-config-settings.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CONFIG_TOOL');

export interface ConfigToolParams {
  action: 'get' | 'set';
  setting: string;
  value?: string;
}

/** Structured result returned by ConfigTool operations. */
export interface ConfigToolOutput {
  success: boolean;
  operation: 'get' | 'set';
  setting: string;
  source?: 'global' | 'project';
  value?: string | boolean | number;
  previousValue?: string | boolean | number;
  newValue?: string | boolean | number;
  options?: string[];
  error?: string;
}

const configToolDescription = `Read or write Qwen Code configuration settings.

## Supported settings
${getAllKeys()
  .map((k) => {
    const d = SUPPORTED_CONFIG_SETTINGS[k];
    return `- **${k}** (${d.type}, ${d.source}): ${d.description} (${d.writable ? 'read/write' : 'read-only'})`;
  })
  .join('\n')}

## Usage
- GET: read a setting's current value. Always allowed without confirmation.
- SET: change a setting's value. Requires user confirmation.

## Response format
Returns a JSON object with fields: success, operation, setting, source, value/previousValue/newValue, options, error.
`;

const configToolSchemaData: FunctionDeclaration = {
  name: ToolNames.CONFIG,
  description: configToolDescription,
  parametersJsonSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set'],
        description: "Whether to read ('get') or write ('set') the setting.",
      },
      setting: {
        type: 'string',
        description: `Setting name. Supported: ${getAllKeys().join(', ')}.`,
      },
      value: {
        type: 'string',
        description:
          "New value for the setting. Required when action is 'set'. For boolean settings, use 'true' or 'false'.",
      },
    },
    required: ['action', 'setting'],
    additionalProperties: false,
  },
};

/**
 * Coerce a string value to the target type declared in the descriptor.
 * Returns the coerced value or an error string.
 */
function coerceValue(
  raw: string,
  targetType: 'string' | 'boolean' | 'number',
):
  | { ok: true; value: string | boolean | number }
  | { ok: false; error: string } {
  if (targetType === 'boolean') {
    const lower = raw.toLowerCase().trim();
    if (lower === 'true') return { ok: true, value: true };
    if (lower === 'false') return { ok: true, value: false };
    return { ok: false, error: `Expected 'true' or 'false', got '${raw}'.` };
  }
  if (targetType === 'number') {
    const num = Number(raw);
    if (Number.isNaN(num)) {
      return { ok: false, error: `Expected a number, got '${raw}'.` };
    }
    return { ok: true, value: num };
  }
  return { ok: true, value: raw };
}

function formatOutput(output: ConfigToolOutput): string {
  return JSON.stringify(output);
}

class ConfigToolInvocation extends BaseToolInvocation<
  ConfigToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ConfigToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    if (this.params.action === 'get') {
      return `Get config: ${this.params.setting}`;
    }
    return `Set config: ${this.params.setting} → ${this.params.value}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return this.params.action === 'get' ? 'allow' : 'ask';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const descriptor = getDescriptor(this.params.setting);
    let currentValue = '<unknown>';
    if (descriptor) {
      try {
        currentValue = String(descriptor.read(this.config));
      } catch {
        currentValue = '<error reading value>';
      }
    }

    const details: ToolInfoConfirmationDetails = {
      type: 'info',
      title: 'Config',
      prompt:
        this.params.action === 'set'
          ? `Change ${this.params.setting} from '${currentValue}' to '${this.params.value}'`
          : `Read ${this.params.setting}`,
      hideAlwaysAllow: true,
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // No-op: config changes should be confirmed each time.
      },
    };
    return details;
  }

  async execute(_abortSignal: AbortSignal): Promise<ToolResult> {
    const { action, setting, value } = this.params;
    const descriptor = getDescriptor(setting);

    if (!descriptor) {
      const available = getAllKeys().join(', ');
      const output: ConfigToolOutput = {
        success: false,
        operation: action,
        setting,
        error: `Unknown setting: "${setting}". Available settings: ${available}`,
      };
      const msg = formatOutput(output);
      debugLogger.debug(msg);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: output.error!, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    if (action === 'get') {
      const currentValue = descriptor.read(this.config);
      const options = getOptionsForSetting(setting, this.config);

      const output: ConfigToolOutput = {
        success: true,
        operation: 'get',
        setting,
        source: descriptor.source,
        value: currentValue,
        ...(options && options.length > 0 ? { options } : {}),
      };

      // For model, also list available models with labels
      if (setting === 'model') {
        try {
          const available = this.config.getAvailableModels();
          if (available.length > 0) {
            output.options = available.map(
              (m) => `${m.id}${m.label ? ` (${m.label})` : ''}`,
            );
          }
        } catch (err) {
          debugLogger.debug('Failed to get available models:', err);
        }
      }

      const msg = formatOutput(output);
      debugLogger.debug(`Config GET ${setting} = ${currentValue}`);
      return { llmContent: msg, returnDisplay: msg };
    }

    // SET
    if (value == null || value.trim() === '') {
      const output: ConfigToolOutput = {
        success: false,
        operation: 'set',
        setting,
        error: `Value is required for SET operation on "${setting}".`,
      };
      const msg = formatOutput(output);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: output.error!, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    // Check writable
    if (!descriptor.writable) {
      const output: ConfigToolOutput = {
        success: false,
        operation: 'set',
        setting,
        error: `Setting "${setting}" is read-only.`,
      };
      const msg = formatOutput(output);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: output.error!, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    // Coerce type
    const coerced = coerceValue(value, descriptor.type);
    if (!coerced.ok) {
      const output: ConfigToolOutput = {
        success: false,
        operation: 'set',
        setting,
        error: coerced.error,
      };
      const msg = formatOutput(output);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: output.error!, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
    const finalValue = coerced.value;

    // Check options
    const options = getOptionsForSetting(setting, this.config);
    if (options && !options.includes(String(finalValue))) {
      const output: ConfigToolOutput = {
        success: false,
        operation: 'set',
        setting,
        error: `Invalid value "${finalValue}". Options: ${options.join(', ')}`,
      };
      const msg = formatOutput(output);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: output.error!, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    // Async validation
    if (descriptor.validateOnWrite) {
      const validationError = await descriptor.validateOnWrite(
        this.config,
        finalValue,
      );
      if (validationError) {
        const output: ConfigToolOutput = {
          success: false,
          operation: 'set',
          setting,
          error: validationError,
        };
        const msg = formatOutput(output);
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: {
            message: output.error!,
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }
    }

    const previousValue = descriptor.read(this.config);
    const error = await descriptor.write(this.config, finalValue);

    if (error) {
      const output: ConfigToolOutput = {
        success: false,
        operation: 'set',
        setting,
        error: `Failed to set ${setting}: ${error}`,
      };
      const msg = formatOutput(output);
      debugLogger.debug(msg);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: output.error!, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const newValue = descriptor.read(this.config);
    const output: ConfigToolOutput = {
      success: true,
      operation: 'set',
      setting,
      source: descriptor.source,
      previousValue,
      newValue,
    };
    const msg = formatOutput(output);
    debugLogger.debug(`Config SET ${setting}: ${previousValue} → ${newValue}`);
    return { llmContent: msg, returnDisplay: msg };
  }
}

export class ConfigTool extends BaseDeclarativeTool<
  ConfigToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.CONFIG;

  constructor(private config: Config) {
    super(
      ToolNames.CONFIG,
      ToolDisplayNames.CONFIG,
      configToolDescription,
      Kind.Other,
      configToolSchemaData.parametersJsonSchema!,
    );
  }

  protected override validateToolParamValues(
    params: ConfigToolParams,
  ): string | null {
    if (!isSupported(params.setting)) {
      return `Unknown setting: "${params.setting}". Available: ${getAllKeys().join(', ')}`;
    }

    if (params.action === 'set') {
      if (params.value == null || params.value.trim() === '') {
        return `Value is required when action is 'set'.`;
      }
      const descriptor = getDescriptor(params.setting);
      if (descriptor && !descriptor.writable) {
        return `Setting "${params.setting}" is read-only.`;
      }
    }

    return null;
  }

  protected createInvocation(
    params: ConfigToolParams,
  ): ToolInvocation<ConfigToolParams, ToolResult> {
    return new ConfigToolInvocation(this.config, params);
  }
}
