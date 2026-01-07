import type {
  Config as CoreConfig,
  WorkspaceContext,
  FileDiscoveryService,
  IdeContextStore,
  LspLocation,
  LspDefinition,
  LspReference,
  LspSymbolInformation,
} from '@qwen-code/qwen-code-core';
import type { EventEmitter } from 'events';
import {
  LspConnectionFactory,
  type JsonRpcMessage,
} from './LspConnectionFactory.js';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { globSync } from 'glob';

// 定义 LSP 初始化选项的类型
interface LspInitializationOptions {
  [key: string]: unknown;
}

// 定义 LSP 服务器配置类型
interface LspServerConfig {
  name: string;
  languages: string[];
  command: string;
  args: string[];
  transport: 'stdio' | 'tcp';
  initializationOptions?: LspInitializationOptions;
  rootUri: string;
  trustRequired?: boolean;
}

// 定义 LSP 连接接口
interface LspConnectionInterface {
  listen: (readable: NodeJS.ReadableStream) => void;
  send: (message: JsonRpcMessage) => void;
  onNotification: (handler: (notification: JsonRpcMessage) => void) => void;
  onRequest: (handler: (request: JsonRpcMessage) => Promise<unknown>) => void;
  request: (method: string, params: unknown) => Promise<unknown>;
  initialize: (params: unknown) => Promise<unknown>;
  shutdown: () => Promise<void>;
  end: () => void;
}

// 定义 LSP 服务器状态
type LspServerStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'READY' | 'FAILED';

// 定义 LSP 服务器句柄
interface LspServerHandle {
  config: LspServerConfig;
  status: LspServerStatus;
  connection?: LspConnectionInterface;
  process?: ChildProcess;
  error?: Error;
  warmedUp?: boolean;
}

interface NativeLspServiceOptions {
  allowedServers?: string[];
  excludedServers?: string[];
  requireTrustedWorkspace?: boolean;
  workspaceRoot?: string;
}

export class NativeLspService {
  private serverHandles: Map<string, LspServerHandle> = new Map();
  private config: CoreConfig;
  private workspaceContext: WorkspaceContext;
  private fileDiscoveryService: FileDiscoveryService;
  private allowedServers?: string[];
  private excludedServers?: string[];
  private requireTrustedWorkspace: boolean;
  private workspaceRoot: string;

  constructor(
    config: CoreConfig,
    workspaceContext: WorkspaceContext,
    _eventEmitter: EventEmitter, // 未使用，用下划线前缀
    fileDiscoveryService: FileDiscoveryService,
    _ideContextStore: IdeContextStore, // 未使用，用下划线前缀
    options: NativeLspServiceOptions = {},
  ) {
    this.config = config;
    this.workspaceContext = workspaceContext;
    this.fileDiscoveryService = fileDiscoveryService;
    this.allowedServers = options.allowedServers?.filter(Boolean);
    this.excludedServers = options.excludedServers?.filter(Boolean);
    this.requireTrustedWorkspace = options.requireTrustedWorkspace ?? true;
    this.workspaceRoot =
      options.workspaceRoot ?? (config as CoreConfig).getProjectRoot();
  }

  /**
   * 发现并准备 LSP 服务器
   */
  async discoverAndPrepare(): Promise<void> {
    const workspaceTrusted = this.config.isTrustedFolder();
    this.serverHandles.clear();

    // 检查工作区是否受信任
    if (this.requireTrustedWorkspace && !workspaceTrusted) {
      console.log('工作区不受信任，跳过 LSP 服务器发现');
      return;
    }

    // 检测工作区中的语言
    const detectedLanguages = await this.detectLanguages();

    // 合并配置：内置预设 + 用户 .lsp.json + 可选 cclsp 兼容转换
    const serverConfigs = await this.mergeConfigs(detectedLanguages);

    // 创建服务器句柄
    for (const config of serverConfigs) {
      this.serverHandles.set(config.name, {
        config,
        status: 'NOT_STARTED',
      });
    }
  }

  /**
   * 启动所有 LSP 服务器
   */
  async start(): Promise<void> {
    for (const [name, handle] of this.serverHandles) {
      await this.startServer(name, handle);
    }
  }

  /**
   * 停止所有 LSP 服务器
   */
  async stop(): Promise<void> {
    for (const [name, handle] of this.serverHandles) {
      await this.stopServer(name, handle);
    }
    this.serverHandles.clear();
  }

  /**
   * 获取 LSP 服务器状态
   */
  getStatus(): Map<string, LspServerStatus> {
    const statusMap = new Map<string, LspServerStatus>();
    for (const [name, handle] of this.serverHandles) {
      statusMap.set(name, handle.status);
    }
    return statusMap;
  }

  /**
   * Workspace symbol search across all ready LSP servers.
   */
  async workspaceSymbols(
    query: string,
    limit = 50,
  ): Promise<LspSymbolInformation[]> {
    const results: LspSymbolInformation[] = [];

    for (const [serverName, handle] of this.serverHandles) {
      if (handle.status !== 'READY' || !handle.connection) {
        continue;
      }
      try {
        await this.warmupTypescriptServer(handle);
        let response = await handle.connection.request('workspace/symbol', {
          query,
        });
        if (
          this.isTypescriptServer(handle) &&
          this.isNoProjectErrorResponse(response)
        ) {
          await this.warmupTypescriptServer(handle, true);
          response = await handle.connection.request('workspace/symbol', {
            query,
          });
        }
        if (!Array.isArray(response)) {
          continue;
        }
        for (const item of response) {
          const symbol = this.normalizeSymbolResult(item, serverName);
          if (symbol) {
            results.push(symbol);
          }
          if (results.length >= limit) {
            return results.slice(0, limit);
          }
        }
      } catch (error) {
        console.warn(`LSP workspace/symbol failed for ${serverName}:`, error);
      }
    }

    return results.slice(0, limit);
  }

  /**
   * 跳转到定义
   */
  async definitions(
    location: LspLocation,
    serverName?: string,
    limit = 50,
  ): Promise<LspDefinition[]> {
    const handles = Array.from(this.serverHandles.entries()).filter(
      ([name, handle]) =>
        handle.status === 'READY' &&
        handle.connection &&
        (!serverName || name === serverName),
    );

    for (const [name, handle] of handles) {
      if (!handle.connection) {
        continue;
      }
      try {
        await this.warmupTypescriptServer(handle);
        await this.warmupTypescriptServer(handle);
        const response = await handle.connection.request(
          'textDocument/definition',
          {
            textDocument: { uri: location.uri },
            position: location.range.start,
          },
        );
        const candidates = Array.isArray(response)
          ? response
          : response
            ? [response]
            : [];
        const definitions: LspDefinition[] = [];
        for (const def of candidates) {
          const normalized = this.normalizeLocationResult(def, name);
          if (normalized) {
            definitions.push(normalized);
            if (definitions.length >= limit) {
              return definitions.slice(0, limit);
            }
          }
        }
        if (definitions.length > 0) {
          return definitions.slice(0, limit);
        }
      } catch (error) {
        console.warn(`LSP textDocument/definition failed for ${name}:`, error);
      }
    }

    return [];
  }

  /**
   * 查找引用
   */
  async references(
    location: LspLocation,
    serverName?: string,
    includeDeclaration = false,
    limit = 200,
  ): Promise<LspReference[]> {
    const handles = Array.from(this.serverHandles.entries()).filter(
      ([name, handle]) =>
        handle.status === 'READY' &&
        handle.connection &&
        (!serverName || name === serverName),
    );

    for (const [name, handle] of handles) {
      if (!handle.connection) {
        continue;
      }
      try {
        await this.warmupTypescriptServer(handle);
        await this.warmupTypescriptServer(handle);
        const response = await handle.connection.request(
          'textDocument/references',
          {
            textDocument: { uri: location.uri },
            position: location.range.start,
            context: { includeDeclaration },
          },
        );
        if (!Array.isArray(response)) {
          continue;
        }
        const refs: LspReference[] = [];
        for (const ref of response) {
          const normalized = this.normalizeLocationResult(ref, name);
          if (normalized) {
            refs.push(normalized);
          }
          if (refs.length >= limit) {
            return refs.slice(0, limit);
          }
        }
        if (refs.length > 0) {
          return refs.slice(0, limit);
        }
      } catch (error) {
        console.warn(`LSP textDocument/references failed for ${name}:`, error);
      }
    }

    return [];
  }

  /**
   * 检测工作区中的编程语言
   */
  private async detectLanguages(): Promise<string[]> {
    const patterns = ['**/*.{js,ts,jsx,tsx,py,go,rs,java,cpp,php,rb,cs}'];
    const excludePatterns = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
    ];

    const files = new Set<string>();
    const searchRoots = this.workspaceContext.getDirectories();

    for (const root of searchRoots) {
      for (const pattern of patterns) {
        try {
          const matches = globSync(pattern, {
            cwd: root,
            ignore: excludePatterns,
            absolute: true,
            nodir: true,
          });

          for (const match of matches) {
            if (this.fileDiscoveryService.shouldIgnoreFile(match)) {
              continue;
            }
            files.add(match);
          }
        } catch (_error) {
          // Ignore glob errors for missing/invalid directories
        }
      }
    }

    // 统计不同语言的文件数量
    const languageCounts = new Map<string, number>();
    for (const file of files) {
      const ext = path.extname(file).slice(1).toLowerCase();
      if (ext) {
        const lang = this.mapExtensionToLanguage(ext);
        if (lang) {
          languageCounts.set(lang, (languageCounts.get(lang) || 0) + 1);
        }
      }
    }

    // 也可以通过特定的配置文件来检测语言
    const rootMarkers = await this.detectRootMarkers();
    for (const marker of rootMarkers) {
      const lang = this.mapMarkerToLanguage(marker);
      if (lang) {
        // 使用安全的数字操作避免 NaN
        const currentCount = languageCounts.get(lang) || 0;
        languageCounts.set(lang, currentCount + 100); // 给配置文件更高的权重
      }
    }

    // 返回检测到的语言，按数量排序
    return Array.from(languageCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([lang]) => lang);
  }

  /**
   * 检测根目录标记文件
   */
  private async detectRootMarkers(): Promise<string[]> {
    const markers = new Set<string>();
    const commonMarkers = [
      'package.json',
      'tsconfig.json',
      'pyproject.toml',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'build.gradle',
      'composer.json',
      'Gemfile',
      'mix.exs',
      'deno.json',
    ];

    for (const root of this.workspaceContext.getDirectories()) {
      for (const marker of commonMarkers) {
        try {
          const fullPath = path.join(root, marker);
          if (fs.existsSync(fullPath)) {
            markers.add(marker);
          }
        } catch (_error) {
          // ignore missing files
        }
      }
    }

    return Array.from(markers);
  }

  /**
   * 将文件扩展名映射到编程语言
   */
  private mapExtensionToLanguage(ext: string): string | null {
    const extToLang: { [key: string]: string } = {
      js: 'javascript',
      ts: 'typescript',
      jsx: 'javascriptreact',
      tsx: 'typescriptreact',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      cpp: 'cpp',
      c: 'c',
      php: 'php',
      rb: 'ruby',
      cs: 'csharp',
      vue: 'vue',
      svelte: 'svelte',
      html: 'html',
      css: 'css',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
    };

    return extToLang[ext] || null;
  }

  /**
   * 将根目录标记映射到编程语言
   */
  private mapMarkerToLanguage(marker: string): string | null {
    const markerToLang: { [key: string]: string } = {
      'package.json': 'javascript',
      'tsconfig.json': 'typescript',
      'pyproject.toml': 'python',
      'go.mod': 'go',
      'Cargo.toml': 'rust',
      'pom.xml': 'java',
      'build.gradle': 'java',
      'composer.json': 'php',
      Gemfile: 'ruby',
      '*.sln': 'csharp',
      'mix.exs': 'elixir',
      'deno.json': 'deno',
    };

    return markerToLang[marker] || null;
  }

  private normalizeLocationResult(
    item: unknown,
    serverName: string,
  ): LspReference | null {
    const itemObj = item as Record<string, unknown>;
    const uri =
      itemObj?.uri ??
      itemObj?.targetUri ??
      (itemObj?.target as Record<string, unknown>)?.uri;
    const range =
      itemObj?.range ??
      itemObj?.targetSelectionRange ??
      itemObj?.targetRange ??
      (itemObj?.target as Record<string, unknown>)?.range;

    if (!uri || !range?.start || !range?.end) {
      return null;
    }

    return {
      uri,
      range: {
        start: {
          line: Number(range.start.line ?? 0),
          character: Number(range.start.character ?? 0),
        },
        end: {
          line: Number(range.end.line ?? 0),
          character: Number(range.end.character ?? 0),
        },
      },
      serverName,
    };
  }

  private normalizeSymbolResult(
    item: unknown,
    serverName: string,
  ): LspSymbolInformation | null {
    const itemObj = item as Record<string, unknown>;
    const location = itemObj?.location ?? itemObj?.target ?? itemObj;
    const locationObj = location as Record<string, unknown>;
    const range =
      locationObj?.range ??
      locationObj?.targetRange ??
      itemObj?.range ??
      undefined;

    if (!location?.uri || !range?.start || !range?.end) {
      return null;
    }

    return {
      name: item?.name ?? item?.label ?? 'symbol',
      kind: item?.kind ? String(item.kind) : undefined,
      containerName: item?.containerName ?? item?.container,
      location: {
        uri: location.uri,
        range: {
          start: {
            line: Number(range.start.line ?? 0),
            character: Number(range.start.character ?? 0),
          },
          end: {
            line: Number(range.end.line ?? 0),
            character: Number(range.end.character ?? 0),
          },
        },
      },
      serverName,
    };
  }

  /**
   * 合并配置：内置预设 + 用户配置 + 兼容层
   */
  private async mergeConfigs(
    detectedLanguages: string[],
  ): Promise<LspServerConfig[]> {
    // 内置预设配置
    const presets = this.getBuiltInPresets(detectedLanguages);

    // 用户 .lsp.json 配置（如果存在）
    const userConfigs = await this.loadUserConfigs();

    // 合并配置，用户配置优先级更高
    const mergedConfigs = [...presets];

    for (const userConfig of userConfigs) {
      // 查找是否有同名的预设配置，如果有则替换
      const existingIndex = mergedConfigs.findIndex(
        (c) => c.name === userConfig.name,
      );
      if (existingIndex !== -1) {
        mergedConfigs[existingIndex] = userConfig;
      } else {
        mergedConfigs.push(userConfig);
      }
    }

    return mergedConfigs;
  }

  /**
   * 获取内置预设配置
   */
  private getBuiltInPresets(detectedLanguages: string[]): LspServerConfig[] {
    const presets: LspServerConfig[] = [];

    // 将目录路径转换为文件 URI 格式
    const rootUri = pathToFileURL(this.workspaceRoot).toString();

    // 根据检测到的语言生成对应的 LSP 服务器配置
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
        trustRequired: true,
      });
    }

    // 可以根据需要添加更多语言的预设配置

    return presets;
  }

  /**
   * 加载用户 .lsp.json 配置
   */
  private async loadUserConfigs(): Promise<LspServerConfig[]> {
    const configs: LspServerConfig[] = [];

    try {
      const lspConfigPath = path.join(this.workspaceRoot, '.lsp.json');
      if (fs.existsSync(lspConfigPath)) {
        const configContent = fs.readFileSync(lspConfigPath, 'utf-8');
        const userConfig = JSON.parse(configContent);

        // 验证并转换用户配置为内部格式
        if (userConfig && typeof userConfig === 'object') {
          for (const [langId, serverSpec] of Object.entries(userConfig) as [
            string,
            Record<string, unknown>,
          ]) {
            // 转换为文件 URI 格式
            const rootUri = pathToFileURL(this.workspaceRoot).toString();

            // 验证 command 不为 undefined
            if (!serverSpec.command) {
              console.warn(`LSP 配置错误: ${langId} 缺少 command 属性`);
              continue;
            }

            const serverConfig: LspServerConfig = {
              name: serverSpec.command,
              languages: [langId],
              command: serverSpec.command,
              args: serverSpec.args || [],
              transport: serverSpec.transport || 'stdio',
              initializationOptions: serverSpec.initializationOptions,
              rootUri,
              trustRequired: serverSpec.trustRequired ?? true,
            };

            configs.push(serverConfig);
          }
        }
      }
    } catch (e) {
      console.warn('加载用户 .lsp.json 配置失败:', e);
    }

    return configs;
  }

  /**
   * 启动单个 LSP 服务器
   */
  private async startServer(
    name: string,
    handle: LspServerHandle,
  ): Promise<void> {
    if (this.excludedServers?.includes(name)) {
      console.log(`LSP 服务器 ${name} 在排除列表中，跳过启动`);
      handle.status = 'FAILED';
      return;
    }

    if (this.allowedServers && !this.allowedServers.includes(name)) {
      console.log(`LSP 服务器 ${name} 不在允许列表中，跳过启动`);
      handle.status = 'FAILED';
      return;
    }

    const workspaceTrusted = this.config.isTrustedFolder();
    if (
      (this.requireTrustedWorkspace || handle.config.trustRequired) &&
      !workspaceTrusted
    ) {
      console.log(`LSP 服务器 ${name} 需要受信任的工作区，跳过启动`);
      handle.status = 'FAILED';
      return;
    }

    // 请求用户确认
    const consent = await this.requestUserConsent(
      name,
      handle.config,
      workspaceTrusted,
    );
    if (!consent) {
      console.log(`用户拒绝启动 LSP 服务器 ${name}`);
      handle.status = 'FAILED';
      return;
    }

    // 检查命令是否存在
    if (!(await this.commandExists(handle.config.command))) {
      console.warn(`LSP 服务器 ${name} 的命令不存在: ${handle.config.command}`);
      handle.status = 'FAILED';
      return;
    }

    // 检查路径安全性
    if (
      !this.isPathSafe(handle.config.command, (this.config as CoreConfig).cwd)
    ) {
      console.warn(
        `LSP 服务器 ${name} 的命令路径不安全: ${handle.config.command}`,
      );
      handle.status = 'FAILED';
      return;
    }

    try {
      handle.status = 'IN_PROGRESS';

      // 创建 LSP 连接
      const connection = await this.createLspConnection(handle.config);
      handle.connection = connection.connection;
      handle.process = connection.process;

      // 初始化 LSP 服务器
      await this.initializeLspServer(connection, handle.config);

      handle.status = 'READY';
      console.log(`LSP 服务器 ${name} 启动成功`);
    } catch (error) {
      handle.status = 'FAILED';
      handle.error = error as Error;
      console.error(`LSP 服务器 ${name} 启动失败:`, error);
    }
  }

  /**
   * 停止单个 LSP 服务器
   */
  private async stopServer(
    name: string,
    handle: LspServerHandle,
  ): Promise<void> {
    if (handle.connection) {
      try {
        await handle.connection.shutdown();
        handle.connection.end();
      } catch (error) {
        console.error(`关闭 LSP 服务器 ${name} 时出错:`, error);
      }
    } else if (handle.process && !handle.process.killed) {
      handle.process.kill();
    }
    handle.connection = undefined;
    handle.process = undefined;
    handle.status = 'NOT_STARTED';
  }

  /**
   * 创建 LSP 连接
   */
  private async createLspConnection(config: LspServerConfig): Promise<{
    connection: LspConnectionInterface;
    process: ChildProcess;
    shutdown: () => Promise<void>;
    exit: () => void;
    initialize: (params: unknown) => Promise<unknown>;
  }> {
    if (config.transport === 'stdio') {
      // 修复：使用 cwd 作为 cwd 而不是 rootUri
      const lspConnection = await LspConnectionFactory.createStdioConnection(
        config.command,
        config.args,
        { cwd: this.workspaceRoot },
      );

      return {
        connection: lspConnection.connection as LspConnectionInterface,
        process: lspConnection.process as ChildProcess,
        shutdown: async () => {
          await lspConnection.connection.shutdown();
        },
        exit: () => {
          if (lspConnection.process && !lspConnection.process.killed) {
            (lspConnection.process as ChildProcess).kill();
          }
          lspConnection.connection.end();
        },
        initialize: async (params: unknown) =>
          lspConnection.connection.initialize(params),
      };
    } else if (config.transport === 'tcp') {
      // 如果需要 TCP 支持，可以扩展此部分
      throw new Error('TCP transport not yet implemented');
    } else {
      throw new Error(`Unsupported transport: ${config.transport}`);
    }
  }

  /**
   * 初始化 LSP 服务器
   */
  private async initializeLspServer(
    connection: Awaited<ReturnType<NativeLspService['createLspConnection']>>,
    config: LspServerConfig,
  ): Promise<void> {
    const workspaceFolder = {
      name: path.basename(this.workspaceRoot) || this.workspaceRoot,
      uri: config.rootUri,
    };

    const initializeParams = {
      processId: process.pid,
      rootUri: config.rootUri,
      rootPath: this.workspaceRoot,
      workspaceFolders: [workspaceFolder],
      capabilities: {
        textDocument: {
          completion: { dynamicRegistration: true },
          hover: { dynamicRegistration: true },
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
          documentSymbol: { dynamicRegistration: true },
          codeAction: { dynamicRegistration: true },
        },
        workspace: {
          workspaceFolders: { supported: true },
        },
      },
      initializationOptions: config.initializationOptions,
    };

    await connection.initialize(initializeParams);

    // Send initialized notification and workspace folders change to help servers (e.g. tsserver)
    // create projects in the correct workspace.
    connection.connection.send({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    });
    connection.connection.send({
      jsonrpc: '2.0',
      method: 'workspace/didChangeWorkspaceFolders',
      params: {
        event: {
          added: [workspaceFolder],
          removed: [],
        },
      },
    });

    // Warm up TypeScript server by opening a workspace file so it can create a project.
    if (config.name.includes('typescript')) {
      try {
        const tsFile = this.findFirstTypescriptFile();
        if (tsFile) {
          const uri = pathToFileURL(tsFile).toString();
          const languageId = tsFile.endsWith('.tsx')
            ? 'typescriptreact'
            : 'typescript';
          const text = fs.readFileSync(tsFile, 'utf-8');
          connection.connection.send({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
              textDocument: {
                uri,
                languageId,
                version: 1,
                text,
              },
            },
          });
        }
      } catch (error) {
        console.warn('TypeScript LSP warm-up failed:', error);
      }
    }
  }

  /**
   * 检查命令是否存在
   */
  private async commandExists(command: string): Promise<boolean> {
    // 实现命令存在性检查
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(command, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        cwd: this.workspaceRoot,
      });

      child.on('error', () => {
        settled = true;
        resolve(false);
      });

      child.on('exit', (code) => {
        if (settled) {
          return;
        }
        // 如果命令存在，通常会返回 0 或其他非错误码
        // 有些命令的 --version 选项可能返回非 0，但不会抛出错误
        resolve(code !== 127); // 127 通常表示命令不存在
      });

      // 设置超时，避免长时间等待
      setTimeout(() => {
        settled = true;
        child.kill();
        resolve(false);
      }, 2000);
    });
  }

  /**
   * 检查路径安全性
   */
  private isPathSafe(command: string, workspacePath: string): boolean {
    // 检查命令是否在工作区路径内，或者是否在系统 PATH 中
    // 允许全局安装的命令（如在 PATH 中的命令）
    // 只阻止显式指定工作区外绝对路径的情况
    if (path.isAbsolute(command)) {
      // 如果是绝对路径，检查是否在工作区路径内
      const resolvedPath = path.resolve(command);
      const resolvedWorkspacePath = path.resolve(workspacePath);
      return (
        resolvedPath.startsWith(resolvedWorkspacePath + path.sep) ||
        resolvedPath === resolvedWorkspacePath
      );
    }
    // 相对路径和命令名（在 PATH 中查找）认为是安全的
    // 但需要确保相对路径不指向工作区外
    const resolvedPath = path.resolve(workspacePath, command);
    const resolvedWorkspacePath = path.resolve(workspacePath);
    return (
      resolvedPath.startsWith(resolvedWorkspacePath + path.sep) ||
      resolvedPath === resolvedWorkspacePath
    );
  }

  /**
   * 请求用户确认启动 LSP 服务器
   */
  private async requestUserConsent(
    serverName: string,
    serverConfig: LspServerConfig,
    workspaceTrusted: boolean,
  ): Promise<boolean> {
    if (workspaceTrusted) {
      return true; // 在受信任工作区中自动允许
    }

    if (this.requireTrustedWorkspace || serverConfig.trustRequired) {
      console.log(
        `工作区未受信任，跳过 LSP 服务器 ${serverName} (${serverConfig.command})`,
      );
      return false;
    }

    console.log(
      `未受信任的工作区，LSP 服务器 ${serverName} 标记为 trustRequired=false，将谨慎尝试启动`,
    );
    return true;
  }

  /**
   * Find a representative TypeScript/JavaScript file to warm up tsserver.
   */
  private findFirstTypescriptFile(): string | undefined {
    const patterns = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
    const excludePatterns = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
    ];

    for (const root of this.workspaceContext.getDirectories()) {
      for (const pattern of patterns) {
        try {
          const matches = globSync(pattern, {
            cwd: root,
            ignore: excludePatterns,
            absolute: true,
            nodir: true,
          });
          for (const file of matches) {
            if (this.fileDiscoveryService.shouldIgnoreFile(file)) {
              continue;
            }
            return file;
          }
        } catch (_error) {
          // ignore glob errors
        }
      }
    }

    return undefined;
  }

  private isTypescriptServer(handle: LspServerHandle): boolean {
    return handle.config.name.includes('typescript');
  }

  private isNoProjectErrorResponse(response: unknown): boolean {
    if (!response) {
      return false;
    }
    const message =
      typeof response === 'string'
        ? response
        : typeof (response as Record<string, unknown>)?.message === 'string'
          ? ((response as Record<string, unknown>).message as string)
          : '';
    return message.includes('No Project');
  }

  /**
   * Ensure tsserver has at least one file open so navto/navtree requests succeed.
   */
  private async warmupTypescriptServer(
    handle: LspServerHandle,
    force = false,
  ): Promise<void> {
    if (!handle.connection || !this.isTypescriptServer(handle)) {
      return;
    }
    if (handle.warmedUp && !force) {
      return;
    }
    const tsFile = this.findFirstTypescriptFile();
    if (!tsFile) {
      return;
    }
    handle.warmedUp = true;
    const uri = pathToFileURL(tsFile).toString();
    const languageId = tsFile.endsWith('.tsx')
      ? 'typescriptreact'
      : tsFile.endsWith('.jsx')
        ? 'javascriptreact'
        : tsFile.endsWith('.js')
          ? 'javascript'
          : 'typescript';
    try {
      const text = fs.readFileSync(tsFile, 'utf-8');
      handle.connection.send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId,
            version: 1,
            text,
          },
        },
      });
      // Give tsserver a moment to build the project.
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch (error) {
      console.warn('TypeScript server warm-up failed:', error);
    }
  }
}
