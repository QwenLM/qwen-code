/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import {
  HookManager,
  HookType,
  type HookContext,
  type HookPayload,
} from './HookManager.js';
import type { HooksSettings, ClaudeHookConfig } from './HooksSettings.js';
import { HookExecutor } from './HookExecutor.js';
import { HookConfigLoader } from './HookConfigLoader.js';
import { PayloadConverter } from './PayloadConverter.js';
export class HookService {
  private hookManager: HookManager;
  private config: Config;
  private hooksSettings?: HooksSettings;
  private hookExecutor: HookExecutor;
  private configLoader: HookConfigLoader;
  private payloadConverter: PayloadConverter;

  constructor(config: Config) {
    this.hookManager = HookManager.getInstance();
    this.config = config;
    this.hookExecutor = new HookExecutor(config);
    this.configLoader = new HookConfigLoader();
    this.payloadConverter = new PayloadConverter(config, this.configLoader);

    // Safely get hooks settings, handling cases where getHooksSettings method doesn't exist
    let settings = undefined;
    try {
      // Check existence and callability of the method
      if (config && typeof config.getHooksSettings === 'function') {
        settings = config.getHooksSettings(); // Call the method directly
      }
    } catch (e) {
      console.warn(
        'Error calling getHooksSettings, continuing without hook configuration:',
        e,
      );
      settings = undefined;
    }
    this.hooksSettings = settings;
    // Initialize configured hooks if settings exist
    if (this.hooksSettings?.hooks) {
      this.registerConfiguredHooks();
    }
    // Initialize Claude-compatible hooks if settings exist
    if (this.hooksSettings?.claudeHooks) {
      this.registerClaudeCompatibleHooks();
    }
  }
  private async registerConfiguredHooks(): Promise<void> {
    if (!this.hooksSettings?.hooks) return;
    for (const hookConfig of this.hooksSettings.hooks) {
      if (hookConfig.enabled !== false) {
        // enabled by default if not explicitly disabled
        const handler = await this.createHandlerFromConfig(hookConfig);
        if (handler) {
          this.hookManager.register({
            type: hookConfig.type,
            handler,
            priority: hookConfig.priority,
            enabled: hookConfig.enabled,
          });
        }
      }
    }
  }
  private async registerClaudeCompatibleHooks(): Promise<void> {
    if (!this.hooksSettings?.claudeHooks) return;
    for (const claudeHookConfig of this.hooksSettings.claudeHooks) {
      if (claudeHookConfig.enabled !== false) {
        // enabled by default if not explicitly disabled
        // Convert Claude event to Qwen HookType
        const hookType = this.convertClaudeEventToHookType(
          claudeHookConfig.event,
        );
        if (hookType) {
          const handler =
            await this.createClaudeHandlerFromConfig(claudeHookConfig);
          if (handler) {
            this.hookManager.register({
              type: hookType,
              handler,
              priority: claudeHookConfig.priority,
              enabled: claudeHookConfig.enabled,
            });
          }
        }
      }
    }
  }
  private convertClaudeEventToHookType(event: string): HookType | null {
    // Load event mappings from configuration
    const eventMappings = this.configLoader.loadHookEventMappings();
    // Look up the mapping for this Claude event
    const qwenHookType = eventMappings[event];
    if (qwenHookType) {
      // Convert string to enum value
      return this.normalizeHookType(qwenHookType) as HookType;
    }
    return null;
  }
  private async createClaudeHandlerFromConfig(
    claudeHookConfig: ClaudeHookConfig,
  ) {
    if (claudeHookConfig.command) {
      // We need to get the hook type for this Claude hook to pass to the script
      // This is tricky because the handler doesn't receive the hook type directly
      // We'll need the handler to capture the hook type from where it's registered
      // For this, we need to modify the approach
      // We'll create a closure that captures the hook type for this specific Claude hook
      const hookType = this.convertClaudeEventToHookType(
        claudeHookConfig.event,
      );
      if (hookType) {
        return async (payload: HookPayload, context: HookContext) =>
          await this.executeClaudeScriptHook(
            claudeHookConfig.command,
            payload,
            context,
            hookType,
          );
      }
    }
    return null;
  }
  private async executeClaudeScriptHook(
    command: string,
    payload: HookPayload,
    context: HookContext,
    hookType: HookType,
  ): Promise<HookPayload> {
    try {
      const { spawn } = await import('node:child_process');
      // Convert the Qwen payload to Claude-compatible format
      const claudePayload = this.payloadConverter.convertToClaudeFormat(
        payload,
        context,
        hookType,
      );
      // Execute with shell to allow any application/command to be called
      const child = spawn(command, [], { shell: true });
      // Capture stdout and stderr for response processing
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      // Write the Claude-compatible payload as JSON to stdin
      child.stdin.write(JSON.stringify(claudePayload));
      child.stdin.end();
      let resultPayload = payload; // Initialize result with original payload

      // Wait for the command to complete
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
          // Print stderr if there is any
          if (stderr) {
            console.error(`Claude hook stderr: ${stderr}`);
          }
          if (code !== 0) {
            console.error(
              `Claude hook command "${command}" exited with code ${code}`,
            );
            // Handle exit codes as per Claude protocol
            if (code === 2) {
              // Exit code 2 means blocking error in Claude
              throw new Error(`Claude hook blocking error, exit code: ${code}`);
            }
            // Other non-zero codes are non-blocking errors
          } else if (stdout) {
            // Process Claude-compatible response if there's output
            const response = this.payloadConverter.processClaudeHookResponse(
              stdout,
              hookType,
            );
            // If there's updated input, we need to modify the payload
            if (
              (response as Record<string, unknown>)['updatedInput'] &&
              hookType === HookType.INPUT_RECEIVED
            ) {
              // For INPUT_RECEIVED, we want to update the params which contains the user input
              const payloadObj =
                typeof payload === 'object' && payload !== null
                  ? (payload as Record<string, unknown>)
                  : {};
              const updatedInputObj =
                typeof (response as Record<string, unknown>)['updatedInput'] ===
                  'object' &&
                (response as Record<string, unknown>)['updatedInput'] !== null
                  ? ((response as Record<string, unknown>)[
                      'updatedInput'
                    ] as Record<string, unknown>)
                  : {};
              resultPayload = {
                id: payload.id, // Preserve required HookPayload properties
                timestamp: payload.timestamp,
                ...payloadObj,
                ...updatedInputObj,
              };
            }
          }
          resolve();
        });
      });
      // Return the potentially modified payload
      return resultPayload;
    } catch (error: unknown) {
      console.error(`Error executing Claude hook command "${command}":`, error);
      // Return the original payload if there's an error
      return payload;
    }
  }
  private async createHandlerFromConfig(
    hookConfig: import('./HooksSettings.js').HookConfig,
  ) {
    if (hookConfig.scriptPath) {
      // Register hook from external script
      return async (payload: HookPayload, context: HookContext) =>
        await this.hookExecutor.executeScriptHook(
          hookConfig.scriptPath!, // Non-null assertion since we checked it exists
          payload,
          context,
        );
    } else if (hookConfig.inlineScript) {
      // Register hook from inline script
      return async (payload: HookPayload, context: HookContext) =>
        await this.hookExecutor.executeInlineHook(
          hookConfig.inlineScript!, // Non-null assertion since we checked it exists
          payload,
          context,
        );
    }
    return null;
  }
  async executeHooks(
    type: import('./HookManager.js').HookType | string,
    payload: HookPayload,
  ): Promise<HookPayload> {
    // Only disable hooks if explicitly set to false (undefined means enabled by default)
    if (this.hooksSettings?.enabled === false) {
      return payload; // Hooks are explicitly disabled in configuration, return original payload
    }
    // Convert string type to enum if necessary
    const hookType =
      typeof type === 'string' ? this.normalizeHookType(type) : type;
    // If hook type is null (unknown), skip execution
    if (hookType === null) {
      return payload; // Unknown hook type, return original payload
    }
    const context: HookContext = {
      config: this.config,
      signal: (
        payload as {
          signal?: AbortSignal;
        }
      ).signal,
    };
    // Return the potentially modified payload from the hook execution
    return await this.hookManager.executeHooks(hookType, payload, context);
  }
  private normalizeHookType(
    type: string,
  ): import('./HookManager.js').HookType | null {
    // Map string literals to proper enum values
    switch (type) {
      case 'app.startup':
        return HookType.APP_STARTUP;
      case 'app.shutdown':
        return HookType.APP_SHUTDOWN;
      case 'session.start':
        return HookType.SESSION_START;
      case 'session.end':
        return HookType.SESSION_END;
      case 'input.received':
        return HookType.INPUT_RECEIVED;
      case 'output.ready':
        return HookType.OUTPUT_READY;
      case 'before.response':
        return HookType.BEFORE_RESPONSE;
      case 'after.response':
        return HookType.AFTER_RESPONSE;
      case 'tool.before':
        return HookType.BEFORE_TOOL_USE;
      case 'tool.after':
        return HookType.AFTER_TOOL_USE;
      case 'command.before':
        return HookType.BEFORE_COMMAND;
      case 'command.after':
        return HookType.AFTER_COMMAND;
      case 'model.before_request':
        return HookType.BEFORE_MODEL_REQUEST;
      case 'model.after_response':
        return HookType.AFTER_MODEL_RESPONSE;
      case 'file.before_read':
        return HookType.BEFORE_FILE_READ;
      case 'file.after_read':
        return HookType.AFTER_FILE_READ;
      case 'file.before_write':
        return HookType.BEFORE_FILE_WRITE;
      case 'file.after_write':
        return HookType.AFTER_FILE_WRITE;
      case 'error.occurred':
        return HookType.ERROR_OCCURRED;
      case 'error.handled':
        return HookType.ERROR_HANDLED;
      case 'before.compact':
        return HookType.BEFORE_COMPACT;
      case 'session.notification':
        return HookType.SESSION_NOTIFICATION;
      default:
        // Strictly return null for unknown types - no default behavior
        return null;
    }
  }
  registerHook(
    type: import('./HookManager.js').HookType,
    handler: import('./HookManager.js').HookFunction,
    priority?: number,
  ): string {
    return this.hookManager.register({
      type,
      handler,
      priority,
      enabled: true,
    });
  }
  unregisterHook(hookId: string): boolean {
    return this.hookManager.unregister(hookId);
  }
  getHookManager(): HookManager {
    return this.hookManager;
  }
}
