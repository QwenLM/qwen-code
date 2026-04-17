/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import os from 'node:os';
import { getNpmVersion } from './systemInfo.js';
import { validateAuthMethod } from '../config/auth.js';
import type { CommandContext } from '../ui/commands/types.js';
import type { DoctorCheckResult } from '../ui/types.js';
import {
  canUseRipgrep,
  getMCPServerStatus,
  MCPServerStatus,
} from '@qwen-code/qwen-code-core';
import { t } from '../i18n/index.js';

const MIN_NODE_MAJOR = 20;

function checkNodeVersion(): DoctorCheckResult {
  const version = process.version;
  const major = parseInt(version.replace(/^v/, '').split('.')[0]!, 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      category: t('System'),
      name: t('Node.js version'),
      status: 'warn',
      message: version,
      detail: t('Node.js v{{min}}+ is recommended. Current: {{version}}', {
        min: String(MIN_NODE_MAJOR),
        version,
      }),
    };
  }
  return {
    category: t('System'),
    name: t('Node.js version'),
    status: 'pass',
    message: version,
  };
}

async function checkNpmVersion(): Promise<DoctorCheckResult> {
  const version = await getNpmVersion();
  if (version === 'unknown') {
    return {
      category: t('System'),
      name: t('npm version'),
      status: 'warn',
      message: t('not found'),
      detail: t('npm is not available. Some features may not work.'),
    };
  }
  return {
    category: t('System'),
    name: t('npm version'),
    status: 'pass',
    message: version,
  };
}

function checkPlatform(): DoctorCheckResult {
  return {
    category: t('System'),
    name: t('Platform'),
    status: 'pass',
    message: `${process.platform}/${process.arch} (${os.release()})`,
  };
}

function checkAuth(context: CommandContext): DoctorCheckResult {
  const authType = context.services.config?.getAuthType();
  if (!authType) {
    return {
      category: t('Authentication'),
      name: t('API key'),
      status: 'fail',
      message: t('not configured'),
      detail: t('Run /auth to configure authentication.'),
    };
  }

  const error = validateAuthMethod(
    authType,
    context.services.config ?? undefined,
  );
  if (error) {
    return {
      category: t('Authentication'),
      name: t('API key'),
      status: 'fail',
      message: t('invalid ({{authType}})', { authType }),
      detail: error,
    };
  }

  return {
    category: t('Authentication'),
    name: t('API key'),
    status: 'pass',
    message: t('configured ({{authType}})', { authType }),
  };
}

async function checkApiClient(
  context: CommandContext,
): Promise<DoctorCheckResult> {
  const config = context.services.config;
  if (!config) {
    return {
      category: t('Authentication'),
      name: t('API client'),
      status: 'fail',
      message: t('config not loaded'),
    };
  }

  try {
    const client = config.getGeminiClient();
    if (client.isInitialized()) {
      return {
        category: t('Authentication'),
        name: t('API client'),
        status: 'pass',
        message: t('client initialized'),
      };
    }
    return {
      category: t('Authentication'),
      name: t('API client'),
      status: 'warn',
      message: t('client not initialized'),
      detail: t('The API client has not been initialized yet.'),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      category: t('Authentication'),
      name: t('API client'),
      status: 'warn',
      message: t('error'),
      detail: errorMsg,
    };
  }
}

function checkSettings(context: CommandContext): DoctorCheckResult {
  const settings = context.services.settings;
  if (!settings) {
    return {
      category: t('Configuration'),
      name: t('Settings'),
      status: 'fail',
      message: t('not loaded'),
      detail: t(
        'Settings could not be loaded. Check your settings files for syntax errors.',
      ),
    };
  }
  return {
    category: t('Configuration'),
    name: t('Settings'),
    status: 'pass',
    message: t('loaded'),
  };
}

function checkModel(context: CommandContext): DoctorCheckResult {
  const model = context.services.config?.getModel();
  if (!model) {
    return {
      category: t('Configuration'),
      name: t('Model'),
      status: 'fail',
      message: t('not configured'),
      detail: t('Run /model to select a model.'),
    };
  }
  return {
    category: t('Configuration'),
    name: t('Model'),
    status: 'pass',
    message: model,
  };
}

function checkMcpServers(context: CommandContext): DoctorCheckResult[] {
  const config = context.services.config;
  const servers = config?.getMcpServers();
  if (!servers || Object.keys(servers).length === 0) {
    return [
      {
        category: t('MCP Servers'),
        name: t('MCP servers'),
        status: 'pass',
        message: t('none configured'),
      },
    ];
  }

  return Object.keys(servers).map((name) => {
    // Skip disabled servers — report as informational pass
    if (config?.isMcpServerDisabled(name)) {
      return {
        category: t('MCP Servers'),
        name,
        status: 'pass' as const,
        message: t('disabled'),
      };
    }

    const status = getMCPServerStatus(name);
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return {
          category: t('MCP Servers'),
          name,
          status: 'pass' as const,
          message: t('connected'),
        };
      case MCPServerStatus.CONNECTING:
        return {
          category: t('MCP Servers'),
          name,
          status: 'warn' as const,
          message: t('connecting'),
          detail: t('Server is still starting up.'),
        };
      case MCPServerStatus.DISCONNECTED:
      default:
        return {
          category: t('MCP Servers'),
          name,
          status: 'fail' as const,
          message: t('disconnected'),
          detail: t(
            'Check that the server process is running and configuration is correct.',
          ),
        };
    }
  });
}

function checkToolRegistry(context: CommandContext): DoctorCheckResult {
  const registry = context.services.config?.getToolRegistry();
  if (!registry) {
    return {
      category: t('Tools'),
      name: t('Tool registry'),
      status: 'fail',
      message: t('not loaded'),
    };
  }
  const count = registry.getAllTools().length;
  return {
    category: t('Tools'),
    name: t('Tool registry'),
    status: 'pass',
    message: t('{{count}} tools registered', { count: String(count) }),
  };
}

async function checkRipgrep(
  context: CommandContext,
): Promise<DoctorCheckResult> {
  try {
    const useBuiltin = context.services.config?.getUseBuiltinRipgrep() ?? false;
    const result = await canUseRipgrep(useBuiltin);
    if (result) {
      return {
        category: t('Tools'),
        name: t('Ripgrep'),
        status: 'pass',
        message: t('available'),
      };
    }
    return {
      category: t('Tools'),
      name: t('Ripgrep'),
      status: 'warn',
      message: t('not available'),
      detail: t(
        'Install ripgrep for faster file search: https://github.com/BurntSushi/ripgrep',
      ),
    };
  } catch {
    return {
      category: t('Tools'),
      name: t('Ripgrep'),
      status: 'warn',
      message: t('check failed'),
    };
  }
}

function checkGit(context: CommandContext): DoctorCheckResult {
  if (!context.services.git) {
    return {
      category: t('Git'),
      name: t('Git'),
      status: 'warn',
      message: t('not available'),
      detail: t('Git features will be limited.'),
    };
  }
  return {
    category: t('Git'),
    name: t('Git'),
    status: 'pass',
    message: t('available'),
  };
}

/**
 * Run all doctor diagnostic checks.
 */
export async function runDoctorChecks(
  context: CommandContext,
): Promise<DoctorCheckResult[]> {
  // Run async checks in parallel
  const [npmResult, ripgrepResult, apiClientResult] = await Promise.all([
    checkNpmVersion(),
    checkRipgrep(context),
    checkApiClient(context),
  ]);

  return [
    // System
    checkNodeVersion(),
    npmResult,
    checkPlatform(),
    // Authentication
    checkAuth(context),
    apiClientResult,
    // Configuration
    checkSettings(context),
    checkModel(context),
    // MCP Servers
    ...checkMcpServers(context),
    // Tools
    checkToolRegistry(context),
    ripgrepResult,
    // Git
    checkGit(context),
  ];
}
