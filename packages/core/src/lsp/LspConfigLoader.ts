/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  recursivelyHydrateStrings,
  type JsonValue,
} from '../extension/variables.js';
import type { Extension } from '../extension/extensionManager.js';
import type {
  LspInitializationOptions,
  LspServerConfig,
  LspSocketOptions,
} from './types.js';

export class LspConfigLoader {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Load user .lsp.json configuration.
   * Supports basic format: { "language": { "command": "...", "extensionToLanguage": {...} } }
   */
  async loadUserConfigs(): Promise<LspServerConfig[]> {
    const lspConfigPath = path.join(this.workspaceRoot, '.lsp.json');
    if (!fs.existsSync(lspConfigPath)) {
      return [];
    }

    try {
      const configContent = fs.readFileSync(lspConfigPath, 'utf-8');
      const data = JSON.parse(configContent);
      return this.parseConfigSource(data, lspConfigPath);
    } catch (error) {
      console.warn('Failed to load user .lsp.json config:', error);
      return [];
    }
  }

  /**
   * Load LSP configurations declared by extensions (Claude plugins).
   */
  async loadExtensionConfigs(
    extensions: Extension[],
  ): Promise<LspServerConfig[]> {
    const configs: LspServerConfig[] = [];

    for (const extension of extensions) {
      const lspServers = extension.config?.lspServers;
      if (!lspServers) {
        continue;
      }

      const originBase = `extension ${extension.name}`;
      if (typeof lspServers === 'string') {
        const configPath = this.resolveExtensionConfigPath(
          extension.path,
          lspServers,
        );
        if (!fs.existsSync(configPath)) {
          console.warn(`LSP config not found for ${originBase}: ${configPath}`);
          continue;
        }

        try {
          const configContent = fs.readFileSync(configPath, 'utf-8');
          const data = JSON.parse(configContent) as JsonValue;
          const hydrated = this.hydrateExtensionLspConfig(data, extension.path);
          configs.push(
            ...this.parseConfigSource(
              hydrated,
              `${originBase} (${configPath})`,
            ),
          );
        } catch (error) {
          console.warn(
            `Failed to load extension LSP config from ${configPath}:`,
            error,
          );
        }
      } else if (this.isRecord(lspServers)) {
        const hydrated = this.hydrateExtensionLspConfig(
          lspServers as JsonValue,
          extension.path,
        );
        configs.push(
          ...this.parseConfigSource(hydrated, `${originBase} (lspServers)`),
        );
      } else {
        console.warn(
          `LSP config for ${originBase} must be an object or a JSON file path.`,
        );
      }
    }

    return configs;
  }

  /**
   * Merge configs: built-in presets + extension configs + user configs
   */
  mergeConfigs(
    detectedLanguages: string[],
    extensionConfigs: LspServerConfig[],
    userConfigs: LspServerConfig[],
  ): LspServerConfig[] {
    // Built-in preset configurations
    const presets = this.getBuiltInPresets(detectedLanguages);

    // Merge configs, user configs take priority
    const mergedConfigs = [...presets];

    const applyConfigs = (configs: LspServerConfig[]) => {
      for (const config of configs) {
        // Find if there's a preset with the same name, if so replace it
        const existingIndex = mergedConfigs.findIndex(
          (c) => c.name === config.name,
        );
        if (existingIndex !== -1) {
          mergedConfigs[existingIndex] = config;
        } else {
          mergedConfigs.push(config);
        }
      }
    };

    applyConfigs(extensionConfigs);
    applyConfigs(userConfigs);

    return mergedConfigs;
  }

  collectExtensionToLanguageOverrides(
    configs: LspServerConfig[],
  ): Record<string, string> {
    const overrides: Record<string, string> = {};
    for (const config of configs) {
      if (!config.extensionToLanguage) {
        continue;
      }
      for (const [key, value] of Object.entries(config.extensionToLanguage)) {
        if (typeof value !== 'string') {
          continue;
        }
        const normalized = key.startsWith('.') ? key.slice(1) : key;
        if (!normalized) {
          continue;
        }
        overrides[normalized.toLowerCase()] = value;
      }
    }
    return overrides;
  }

  /**
   * Get built-in preset configurations
   */
  private getBuiltInPresets(detectedLanguages: string[]): LspServerConfig[] {
    const presets: LspServerConfig[] = [];

    // Convert directory path to file URI format
    const rootUri = pathToFileURL(this.workspaceRoot).toString();

    // Generate corresponding LSP server config based on detected languages
    if (
      detectedLanguages.includes('typescript') ||
      detectedLanguages.includes('javascript')
    ) {
      presets.push({
        name: 'typescript-language-server',
        languages: [
          'typescript',
          'javascript',
          'typescriptreact',
          'javascriptreact',
        ],
        command: 'typescript-language-server',
        args: ['--stdio'],
        transport: 'stdio',
        initializationOptions: {},
        rootUri,
        workspaceFolder: this.workspaceRoot,
        trustRequired: true,
      });
    }

    if (detectedLanguages.includes('python')) {
      presets.push({
        name: 'pylsp',
        languages: ['python'],
        command: 'pylsp',
        args: [],
        transport: 'stdio',
        initializationOptions: {},
        rootUri,
        workspaceFolder: this.workspaceRoot,
        trustRequired: true,
      });
    }

    if (detectedLanguages.includes('go')) {
      presets.push({
        name: 'gopls',
        languages: ['go'],
        command: 'gopls',
        args: [],
        transport: 'stdio',
        initializationOptions: {},
        rootUri,
        workspaceFolder: this.workspaceRoot,
        trustRequired: true,
      });
    }

    // Additional language presets can be added as needed

    return presets;
  }

  /**
   * Parse configuration source and extract server configs.
   * Expects basic format keyed by language identifier.
   */
  private parseConfigSource(
    source: unknown,
    origin: string,
  ): LspServerConfig[] {
    if (!this.isRecord(source)) {
      return [];
    }

    const configs: LspServerConfig[] = [];

    for (const [key, spec] of Object.entries(source)) {
      if (!this.isRecord(spec)) {
        continue;
      }

      // In basic format: key is language name, server name comes from command.
      const languages = [key];
      const name =
        typeof spec['command'] === 'string' ? (spec['command'] as string) : key;

      const config = this.buildServerConfig(name, languages, spec, origin);
      if (config) {
        configs.push(config);
      }
    }

    return configs;
  }

  private resolveExtensionConfigPath(
    extensionPath: string,
    configPath: string,
  ): string {
    return path.isAbsolute(configPath)
      ? path.resolve(configPath)
      : path.resolve(extensionPath, configPath);
  }

  private hydrateExtensionLspConfig(
    source: JsonValue,
    extensionPath: string,
  ): JsonValue {
    return recursivelyHydrateStrings(source, {
      extensionPath,
      CLAUDE_PLUGIN_ROOT: extensionPath,
      workspacePath: this.workspaceRoot,
      '/': path.sep,
      pathSeparator: path.sep,
    });
  }

  private buildServerConfig(
    name: string,
    languages: string[],
    spec: Record<string, unknown>,
    origin: string,
  ): LspServerConfig | null {
    const transport = this.normalizeTransport(spec['transport']);
    const command =
      typeof spec['command'] === 'string'
        ? (spec['command'] as string)
        : undefined;
    const args = this.normalizeStringArray(spec['args']) ?? [];
    const env = this.normalizeEnv(spec['env']);
    const initializationOptions = this.isRecord(spec['initializationOptions'])
      ? (spec['initializationOptions'] as LspInitializationOptions)
      : undefined;
    const settings = this.isRecord(spec['settings'])
      ? (spec['settings'] as Record<string, unknown>)
      : undefined;
    const extensionToLanguage = this.normalizeExtensionToLanguage(
      spec['extensionToLanguage'],
    );
    const workspaceFolder = this.resolveWorkspaceFolder(
      spec['workspaceFolder'],
    );
    const rootUri = pathToFileURL(workspaceFolder).toString();
    const startupTimeout = this.normalizeTimeout(spec['startupTimeout']);
    const shutdownTimeout = this.normalizeTimeout(spec['shutdownTimeout']);
    const restartOnCrash =
      typeof spec['restartOnCrash'] === 'boolean'
        ? (spec['restartOnCrash'] as boolean)
        : undefined;
    const maxRestarts = this.normalizeMaxRestarts(spec['maxRestarts']);
    const trustRequired =
      typeof spec['trustRequired'] === 'boolean'
        ? (spec['trustRequired'] as boolean)
        : true;
    const socket = this.normalizeSocketOptions(spec);

    if (transport === 'stdio' && !command) {
      console.warn(`LSP config error in ${origin}: ${name} missing command`);
      return null;
    }

    if (transport !== 'stdio' && !socket) {
      console.warn(
        `LSP config error in ${origin}: ${name} missing socket info`,
      );
      return null;
    }

    return {
      name,
      languages,
      command,
      args,
      transport,
      env,
      initializationOptions,
      settings,
      extensionToLanguage,
      rootUri,
      workspaceFolder,
      startupTimeout,
      shutdownTimeout,
      restartOnCrash,
      maxRestarts,
      trustRequired,
      socket,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return value.filter((item): item is string => typeof item === 'string');
  }

  private normalizeEnv(value: unknown): Record<string, string> | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(value)) {
      if (
        typeof val === 'string' ||
        typeof val === 'number' ||
        typeof val === 'boolean'
      ) {
        env[key] = String(val);
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }

  private normalizeExtensionToLanguage(
    value: unknown,
  ): Record<string, string> | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }
    const mapping: Record<string, string> = {};
    for (const [key, lang] of Object.entries(value)) {
      if (typeof lang !== 'string') {
        continue;
      }
      const normalized = key.startsWith('.') ? key.slice(1) : key;
      if (!normalized) {
        continue;
      }
      mapping[normalized.toLowerCase()] = lang;
    }
    return Object.keys(mapping).length > 0 ? mapping : undefined;
  }

  private normalizeTransport(value: unknown): 'stdio' | 'tcp' | 'socket' {
    if (typeof value !== 'string') {
      return 'stdio';
    }
    const normalized = value.toLowerCase();
    if (normalized === 'tcp' || normalized === 'socket') {
      return normalized;
    }
    return 'stdio';
  }

  private normalizeTimeout(value: unknown): number | undefined {
    if (typeof value !== 'number') {
      return undefined;
    }
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return value;
  }

  private normalizeMaxRestarts(value: unknown): number | undefined {
    if (typeof value !== 'number') {
      return undefined;
    }
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return value;
  }

  private normalizeSocketOptions(
    value: Record<string, unknown>,
  ): LspSocketOptions | undefined {
    const socketValue = value['socket'];
    if (typeof socketValue === 'string') {
      return { path: socketValue };
    }

    const source = this.isRecord(socketValue) ? socketValue : value;
    const host =
      typeof source['host'] === 'string'
        ? (source['host'] as string)
        : undefined;
    const pathValue =
      typeof source['path'] === 'string'
        ? (source['path'] as string)
        : typeof source['socketPath'] === 'string'
          ? (source['socketPath'] as string)
          : undefined;
    const portValue = source['port'];
    const port =
      typeof portValue === 'number'
        ? portValue
        : typeof portValue === 'string'
          ? Number(portValue)
          : undefined;

    const socket: LspSocketOptions = {};
    if (host) {
      socket.host = host;
    }
    if (Number.isFinite(port) && (port as number) > 0) {
      socket.port = port as number;
    }
    if (pathValue) {
      socket.path = pathValue;
    }

    if (!socket.path && !socket.port) {
      return undefined;
    }
    return socket;
  }

  private resolveWorkspaceFolder(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      return this.workspaceRoot;
    }

    const resolved = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(this.workspaceRoot, value);
    const root = path.resolve(this.workspaceRoot);

    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }

    console.warn(
      `LSP workspaceFolder must be within ${this.workspaceRoot}; using workspace root instead.`,
    );
    return this.workspaceRoot;
  }
}
