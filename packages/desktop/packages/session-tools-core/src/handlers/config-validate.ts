/**
 * Config Validate Handler
 *
 * Validates Qwen Code configuration files.
 * Uses full validators if available, otherwise basic validation.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

const AUTOMATIONS_CONFIG_FILE = 'automations.json';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import {
  formatValidationResult,
  validateJsonFileHasFields,
  mergeResults,
} from '../validation.ts';
import { getSourceConfigPath } from '../source-helpers.ts';

export interface ConfigValidateArgs {
  target: 'config' | 'sources' | 'statuses' | 'preferences' | 'permissions' | 'automations' | 'tool-icons' | 'all';
  sourceSlug?: string;
}

/**
 * Handle the config_validate tool call.
 *
 * If ctx.validators is available, uses full Zod validators.
 * Otherwise falls back to basic JSON field checking.
 */
export async function handleConfigValidate(
  ctx: SessionToolContext,
  args: ConfigValidateArgs
): Promise<ToolResult> {
  const { target, sourceSlug } = args;
  const craftAgentRoot = join(homedir(), '.craft-agent');

  // If full validators are available, use them
  if (ctx.validators) {
    try {
      let result;

      switch (target) {
        case 'config':
          result = ctx.validators.validateConfig();
          break;
        case 'sources':
          if (sourceSlug) {
            result = ctx.validators.validateSource(ctx.workspacePath, sourceSlug);
          } else {
            result = ctx.validators.validateAllSources(ctx.workspacePath);
          }
          break;
        case 'statuses':
          result = ctx.validators.validateStatuses(ctx.workspacePath);
          break;
        case 'preferences':
          result = ctx.validators.validatePreferences();
          break;
        case 'permissions':
          result = ctx.validators.validatePermissions(ctx.workspacePath, sourceSlug);
          break;
        case 'automations':
          result = ctx.validators.validateAutomations(ctx.workspacePath);
          break;
        case 'tool-icons':
          result = ctx.validators.validateToolIcons();
          break;
        case 'all':
          result = ctx.validators.validateAll(ctx.workspacePath);
          break;
      }

      return successResponse(formatValidationResult(result!));
    } catch (error) {
      return errorResponse(
        `Config validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Fallback: basic validation
  switch (target) {
    case 'config': {
      const result = validateJsonFileHasFields(
        join(craftAgentRoot, 'config.json'),
        ['workspaces']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'sources': {
      if (sourceSlug) {
        const sourcePath = getSourceConfigPath(ctx.workspacePath, sourceSlug);
        const result = validateJsonFileHasFields(sourcePath, ['slug', 'name', 'type']);
        return successResponse(formatValidationResult(result));
      } else {
        // Validate all sources
        const sourcesDir = join(ctx.workspacePath, 'sources');
        if (!ctx.fs.exists(sourcesDir)) {
          return successResponse('✓ No sources directory (no sources to validate)');
        }

        const results = [];
        const entries = ctx.fs.readdir(sourcesDir);
        for (const entry of entries) {
          const entryPath = join(sourcesDir, entry);
          if (ctx.fs.isDirectory(entryPath)) {
            const sourceResult = validateJsonFileHasFields(
              join(entryPath, 'config.json'),
              ['slug', 'name', 'type']
            );
            if (!sourceResult.valid) {
              // Prefix errors with source name
              sourceResult.errors = sourceResult.errors.map(e => ({
                ...e,
                path: `${entry}/${e.path}`,
              }));
            }
            results.push(sourceResult);
          }
        }

        const merged = mergeResults(...results);
        return successResponse(formatValidationResult(merged));
      }
    }

    case 'statuses': {
      const result = validateJsonFileHasFields(
        join(ctx.workspacePath, 'statuses', 'config.json'),
        ['statuses']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'preferences': {
      const result = validateJsonFileHasFields(
        join(craftAgentRoot, 'preferences.json'),
        []
      );
      return successResponse(formatValidationResult(result));
    }

    case 'permissions': {
      // Check workspace-level permissions.json
      const workspacePermsPath = join(ctx.workspacePath, 'permissions.json');
      if (!ctx.fs.exists(workspacePermsPath)) {
        return successResponse('✓ No workspace permissions.json (using defaults)');
      }
      const result = validateJsonFileHasFields(workspacePermsPath, []);
      return successResponse(formatValidationResult(result));
    }

    case 'automations': {
      const automationsPath = join(ctx.workspacePath, AUTOMATIONS_CONFIG_FILE);
      if (ctx.fs.exists(automationsPath)) {
        const result = validateJsonFileHasFields(automationsPath, []);
        return successResponse(formatValidationResult(result));
      }
      return successResponse(`✓ No ${AUTOMATIONS_CONFIG_FILE} (no automations configured)`);
    }

    case 'tool-icons': {
      const result = validateJsonFileHasFields(
        join(craftAgentRoot, 'tool-icons', 'tool-icons.json'),
        ['version', 'tools']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'all': {
      const configResult = validateJsonFileHasFields(
        join(craftAgentRoot, 'config.json'),
        ['workspaces']
      );
      const prefsResult = validateJsonFileHasFields(
        join(craftAgentRoot, 'preferences.json'),
        []
      );
      const merged = mergeResults(configResult, prefsResult);
      return successResponse(formatValidationResult(merged));
    }

    default:
      return errorResponse(
        `Unknown validation target: ${target}. Valid targets: config, sources, statuses, preferences, permissions, automations, tool-icons, all`
      );
  }
}
