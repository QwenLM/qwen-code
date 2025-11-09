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
import type { HooksSettings } from './HooksSettings.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class HookService {
  private hookManager: HookManager;
  private config: Config;
  private hooksSettings?: HooksSettings;

  constructor(config: Config) {
    this.hookManager = HookManager.getInstance();
    this.config = config;

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

  private convertClaudeEventToHookType(
    event: import('./HooksSettings.js').ClaudeHookEvent,
  ): import('./HookManager.js').HookType | null {
    // Load event mappings from configuration
    const eventMappings = this.loadHookEventMappings();

    // Look up the mapping for this Claude event
    const qwenHookType = eventMappings[event];
    if (qwenHookType) {
      // Convert string to enum value
      return this.normalizeHookType(
        qwenHookType,
      ) as import('./HookManager.js').HookType;
    }

    return null;
  }

  private loadHookEventMappings(): Record<string, string> {
    try {
      // Try to load from a configuration file
      const configPath = join(
        __dirname,
        '../../../config/hook-event-mappings.json',
      );

      // Use the fs module that's already imported
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        return config.hookEventMappings || {};
      }
    } catch (error) {
      console.warn('Could not load hook event mappings:', error);
    }

    // Return default mappings as fallback
    return {
      PreToolUse: 'tool.before',
      Stop: 'session.end',
      SubagentStop: 'session.end',
      InputReceived: 'input.received',
      BeforeResponse: 'before.response',
      AfterResponse: 'after.response',
      SessionStart: 'session.start',
      AppStartup: 'app.startup',
      AppShutdown: 'app.shutdown',
    };
  }

  private async createClaudeHandlerFromConfig(
    claudeHookConfig: import('./HooksSettings.js').ClaudeHookConfig,
  ) {
    if (claudeHookConfig.command) {
      // Register hook from command (external script)
      return async (payload: HookPayload, context: HookContext) => {
        await this.executeClaudeScriptHook(
          claudeHookConfig.command,
          payload,
          context,
        );
      };
    }
    return null;
  }

  private async executeClaudeScriptHook(
    command: string,
    payload: HookPayload,
    _context: HookContext,
  ): Promise<void> {
    try {
      const { spawn } = await import('node:child_process');

      // Execute with shell to allow any application/command to be called
      const child = spawn(command, [], { shell: true });

      // Write the payload as JSON to stdin
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();

      // Wait for the command to complete
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            console.error(
              `Claude hook command "${command}" exited with code ${code}`,
            );
          }
          resolve();
        });
      });
    } catch (error: unknown) {
      console.error(`Error executing Claude hook command "${command}":`, error);
    }
  }

  private async createHandlerFromConfig(
    hookConfig: import('./HooksSettings.js').HookConfig,
  ) {
    if (hookConfig.scriptPath) {
      // Register hook from external script
      return async (payload: HookPayload, context: HookContext) => {
        await this.executeScriptHook(hookConfig.scriptPath!, payload, context);
      };
    } else if (hookConfig.inlineScript) {
      // Register hook from inline script
      return async (payload: HookPayload, context: HookContext) => {
        await this.executeInlineHook(
          hookConfig.inlineScript!,
          payload,
          context,
        );
      };
    }
    return null;
  }

  private async executeScriptHook(
    scriptPath: string,
    payload: HookPayload,
    context: HookContext,
  ): Promise<void> {
    try {
      const resolvedPath = path.resolve(this.config.getTargetDir(), scriptPath);

      // Security: Check that the path is within the project directory
      const projectRoot = this.config.getProjectRoot();
      const relativePath = path.relative(projectRoot, resolvedPath);

      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        console.error(
          `Security error: Script path ${scriptPath} is outside project directory`,
        );
        return;
      }

      // Check if file exists
      await fs.access(resolvedPath);

      // Import the script module
      const scriptModule = await import(resolvedPath);

      // If the module has a default export that is a function, use it
      if (typeof scriptModule.default === 'function') {
        await Promise.resolve(scriptModule.default(payload, context));
      }
      // If the module itself is a function, use it
      else if (typeof scriptModule === 'function') {
        await Promise.resolve(scriptModule(payload, context));
      }
      // If the module has an execute function, use it
      else if (typeof scriptModule.execute === 'function') {
        await Promise.resolve(scriptModule.execute(payload, context));
      } else {
        console.error(
          `Hook script ${scriptPath} does not export a valid function`,
        );
      }
    } catch (error: unknown) {
      console.error(`Error executing hook script ${scriptPath}:`, error);
    }
  }

  private async executeInlineHook(
    inlineScript: string,
    payload: HookPayload,
    context: HookContext,
  ): Promise<void> {
    try {
      // Create a dynamic function with the inline script
      // Using new Function is potentially unsafe, but we're only executing trusted configuration
      // The function receives payload and context as parameters
      const hookFn = new Function('payload', 'context', inlineScript);
      await Promise.resolve(hookFn(payload, context));
    } catch (error) {
      console.error(`Error executing inline hook:`, error);
    }
  }

  async executeHooks(
    type: import('./HookManager.js').HookType | string,
    payload: HookPayload,
  ): Promise<void> {
    // Only disable hooks if explicitly set to false (undefined means enabled by default)
    if (this.hooksSettings?.enabled === false) {
      return; // Hooks are explicitly disabled in configuration
    }

    // Convert string type to enum if necessary
    const hookType =
      typeof type === 'string' ? this.normalizeHookType(type) : type;

    // If hook type is null (unknown), skip execution
    if (hookType === null) {
      return; // Unknown hook type, skip execution
    }

    const context: HookContext = {
      config: this.config,
      signal: (payload as { signal?: AbortSignal }).signal,
    };

    await this.hookManager.executeHooks(hookType, payload, context);
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
      case 'output.ready':
        return HookType.OUTPUT_READY;
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
