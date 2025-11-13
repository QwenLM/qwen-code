/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { HookPayload, HookContext } from './HookManager.js';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export interface HookExecutionOptions {
  timeoutMs?: number;
  maxMemory?: number;
}

export class HookExecutor {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async executeScriptHook(
    scriptPath: string,
    payload: HookPayload,
    context: HookContext,
    options?: HookExecutionOptions,
  ): Promise<HookPayload> {
    try {
      const resolvedPath = path.resolve(this.config.getTargetDir(), scriptPath);
      // Security: Check that the path is within the project directory
      const projectRoot = this.config.getProjectRoot();
      const relativePath = path.relative(projectRoot, resolvedPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        console.error(
          `Security error: Script path ${scriptPath} is outside project directory`,
        );
        return payload;
      }
      // Check if file exists
      await fsPromises.access(resolvedPath);
      // Import the script module
      const scriptModule = await import(resolvedPath);
      // If the module has a default export that is a function, use it
      if (typeof scriptModule.default === 'function') {
        // Apply timeout if specified in options
        if (options?.timeoutMs) {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            options.timeoutMs,
          );

          try {
            // For now, we don't have the ability to pass AbortSignal to module execution,
            // so we just set up timeout for the operation
            const result = await Promise.resolve(
              scriptModule.default(payload, context),
            );
            clearTimeout(timeoutId);
            return result || payload;
          } catch (e) {
            clearTimeout(timeoutId);
            throw e;
          }
        } else {
          const result = await Promise.resolve(
            scriptModule.default(payload, context),
          );
          return result || payload;
        }
      }
      // If the module itself is a function, use it
      else if (typeof scriptModule === 'function') {
        if (options?.timeoutMs) {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            options.timeoutMs,
          );

          try {
            const result = await Promise.resolve(
              scriptModule(payload, context),
            );
            clearTimeout(timeoutId);
            return result || payload;
          } catch (e) {
            clearTimeout(timeoutId);
            throw e;
          }
        } else {
          const result = await Promise.resolve(scriptModule(payload, context));
          return result || payload;
        }
      }
      // If the module has an execute function, use it
      else if (typeof scriptModule.execute === 'function') {
        if (options?.timeoutMs) {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            options.timeoutMs,
          );

          try {
            const result = await Promise.resolve(
              scriptModule.execute(payload, context),
            );
            clearTimeout(timeoutId);
            return result || payload;
          } catch (e) {
            clearTimeout(timeoutId);
            throw e;
          }
        } else {
          const result = await Promise.resolve(
            scriptModule.execute(payload, context),
          );
          return result || payload;
        }
      } else {
        console.error(
          `Hook script ${scriptPath} does not export a valid function`,
        );
        return payload;
      }
    } catch (error: unknown) {
      console.error(`Error executing hook script ${scriptPath}:`, error);
      return payload;
    }
  }

  async executeInlineHook(
    inlineScript: string,
    payload: HookPayload,
    context: HookContext,
    options?: HookExecutionOptions,
  ): Promise<HookPayload> {
    try {
      // Create a dynamic function with the inline script
      // Using new Function is potentially unsafe, but we're only executing trusted configuration
      // The function receives payload and context as parameters
      const hookFn = new Function(
        'payload',
        'context',
        'return ' + inlineScript,
      );

      if (options?.timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          options.timeoutMs,
        );

        try {
          const result = await Promise.resolve(hookFn(payload, context));
          clearTimeout(timeoutId);
          return result || payload;
        } catch (e) {
          clearTimeout(timeoutId);
          throw e;
        }
      } else {
        const result = await Promise.resolve(hookFn(payload, context));
        return result || payload;
      }
    } catch (error) {
      console.error(`Error executing inline hook:`, error);
      return payload;
    }
  }
}
