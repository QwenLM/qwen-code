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
import type { FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  SUPPORTED_CONFIG_SETTINGS,
  getAllKeys,
  getDescriptor,
  isSupported,
} from './supported-config-settings.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CONFIG_TOOL');

export interface ConfigToolParams {
  action: 'get' | 'set';
  setting: string;
  value?: string;
}

const configToolDescription = `Read or write Qwen Code configuration settings.

## Supported settings
${getAllKeys()
  .map((k) => {
    const d = SUPPORTED_CONFIG_SETTINGS[k];
    return `- **${k}**: ${d.description} (${d.writable ? 'read/write' : 'read-only'})`;
  })
  .join('\n')}

## Usage
- GET: read a setting's current value. Always allowed without confirmation.
- SET: change a setting's value. Requires user confirmation.
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
          "New value for the setting. Required when action is 'set'.",
      },
    },
    required: ['action', 'setting'],
    additionalProperties: false,
  },
};

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
        currentValue = descriptor.read(this.config);
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
      permissionRules: [`Config(${this.params.action}:${this.params.setting})`],
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // No-op: persistence handled by coreToolScheduler via PM rules
      },
    };
    return details;
  }

  async execute(): Promise<ToolResult> {
    const { action, setting, value } = this.params;
    const descriptor = getDescriptor(setting);

    if (!descriptor) {
      const available = getAllKeys().join(', ');
      const msg = `Unknown setting: "${setting}". Available settings: ${available}`;
      debugLogger.debug(msg);
      return { llmContent: msg, returnDisplay: msg };
    }

    if (action === 'get') {
      const currentValue = descriptor.read(this.config);
      let result = `${setting} = ${currentValue}`;

      // For model, also list available options
      if (setting === 'model') {
        try {
          const available = this.config.getAvailableModels();
          if (available.length > 0) {
            const modelList = available
              .map((m) => `  - ${m.id}${m.label ? ` (${m.label})` : ''}`)
              .join('\n');
            result += `\nAvailable models:\n${modelList}`;
          }
        } catch (err) {
          debugLogger.debug('Failed to get available models:', err);
        }
      }

      debugLogger.debug(`Config GET ${setting} = ${currentValue}`);
      return { llmContent: result, returnDisplay: result };
    }

    // SET
    if (value == null) {
      const msg = `Value is required for SET operation on "${setting}".`;
      return { llmContent: msg, returnDisplay: msg };
    }
    const previousValue = descriptor.read(this.config);
    const error = await descriptor.write(this.config, value);

    if (error) {
      const msg = `Failed to set ${setting}: ${error}`;
      debugLogger.debug(msg);
      return { llmContent: msg, returnDisplay: msg };
    }

    const newValue = descriptor.read(this.config);
    const msg = `${setting} changed from '${previousValue}' to '${newValue}'`;
    debugLogger.debug(`Config SET ${msg}`);
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
