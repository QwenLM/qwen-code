/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dns from 'node:dns';
import * as fs from 'node:fs';
import { isSubpath } from '../utils/paths.js';
import { detectIde, type IdeInfo } from '../ide/detect-ide.js';
import { ideContextStore } from './ideContext.js';
import { Storage } from '../config/storage.js';
import {
  IdeContextNotificationSchema,
  IdeDiffAcceptedNotificationSchema,
  IdeDiffClosedNotificationSchema,
  IdeDiffRejectedNotificationSchema,
} from './types.js';
import { getIdeProcessInfo } from './process-utils.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnvHttpProxyAgent } from 'undici';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { IDE_REQUEST_TIMEOUT_MS } from './constants.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('IDE');

export type DiffUpdateResult =
  | {
      status: 'accepted';
      content?: string;
    }
  | {
      status: 'rejected';
      content: undefined;
    };

export type IDEConnectionState = {
  status: IDEConnectionStatus;
  details?: string; // User-facing
};

export enum IDEConnectionStatus {
  Connected = 'connected',
  Disconnected = 'disconnected',
  Connecting = 'connecting',
}

type StdioConfig = {
  command: string;
  args: string[];
};

type ConnectionConfig = {
  port?: string;
  authToken?: string;
  stdio?: StdioConfig;
};

function getRealPath(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch (_e) {
    // If realpathSync fails, it might be because the path doesn't exist.
    // In that case, we can fall back to the original path.
    return path;
  }
}

/**
 * Manages the connection to and interaction with the IDE server.
 */
export class IdeClient {
  private static instancePromise: Promise<IdeClient> | null = null;
  private client: Client | undefined = undefined;
  private state: IDEConnectionState = {
    status: IDEConnectionStatus.Disconnected,
    details:
      'IDE integration is currently disabled. To enable it, run /ide enable.',
  };
  private currentIde: IdeInfo | undefined;
  private ideProcessInfo: { pid: number; command: string } | undefined;
  private connectionConfig:
    | (ConnectionConfig & { workspacePath?: string; ideInfo?: IdeInfo })
    | undefined;
  private authToken: string | undefined;
  private diffResponses = new Map<string, (result: DiffUpdateResult) => void>();
  private statusListeners = new Set<(state: IDEConnectionState) => void>();
  private trustChangeListeners = new Set<(isTrusted: boolean) => void>();
  private availableTools: string[] = [];
  /**
   * A mutex to ensure that only one diff view is open in the IDE at a time.
   * This prevents race conditions and UI issues in IDEs like VSCode that
   * can't handle multiple diff views being opened simultaneously.
   */
  private diffMutex = Promise.resolve();

  private constructor() {}

  static getInstance(): Promise<IdeClient> {
    if (!IdeClient.instancePromise) {
      IdeClient.instancePromise = (async () => {
        const client = new IdeClient();
        client.ideProcessInfo = await getIdeProcessInfo();
        client.connectionConfig = await client.getConnectionConfigFromFile();
        client.currentIde = detectIde(
          client.ideProcessInfo,
          client.connectionConfig?.ideInfo,
        );
        return client;
      })();
    }
    return IdeClient.instancePromise;
  }

  addStatusChangeListener(listener: (state: IDEConnectionState) => void) {
    this.statusListeners.add(listener);
  }

  removeStatusChangeListener(listener: (state: IDEConnectionState) => void) {
    this.statusListeners.delete(listener);
  }

  addTrustChangeListener(listener: (isTrusted: boolean) => void) {
    this.trustChangeListeners.add(listener);
  }

  removeTrustChangeListener(listener: (isTrusted: boolean) => void) {
    this.trustChangeListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (!this.currentIde) {
      this.setState(
        IDEConnectionStatus.Disconnected,
        `IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks`,
        false,
      );
      return;
    }

    this.setState(IDEConnectionStatus.Connecting);

    this.connectionConfig = await this.getConnectionConfigFromFile();
    if (this.connectionConfig?.authToken) {
      this.authToken = this.connectionConfig.authToken;
    }
    const workspacePath =
      this.connectionConfig?.workspacePath ??
      process.env['QWEN_CODE_IDE_WORKSPACE_PATH'];

    const { isValid, error } = IdeClient.validateWorkspacePath(
      workspacePath,
      process.cwd(),
    );

    if (!isValid) {
      this.setState(IDEConnectionStatus.Disconnected, error, true);
      return;
    }

    if (this.connectionConfig) {
      if (this.connectionConfig.port) {
        const connected = await this.establishHttpConnection(
          this.connectionConfig.port,
        );
        if (connected) {
          return;
        }
      }
      if (this.connectionConfig.stdio) {
        const connected = await this.establishStdioConnection(
          this.connectionConfig.stdio,
        );
        if (connected) {
          return;
        }
      }
    }

    const portFromEnv = this.getPortFromEnv();
    if (portFromEnv) {
      const connected = await this.establishHttpConnection(portFromEnv);
      if (connected) {
        return;
      }
    }

    const stdioConfigFromEnv = this.getStdioConfigFromEnv();
    if (stdioConfigFromEnv) {
      const connected = await this.establishStdioConnection(stdioConfigFromEnv);
      if (connected) {
        return;
      }
    }

    this.setState(
      IDEConnectionStatus.Disconnected,
      `Failed to connect to IDE companion extension in ${this.currentIde.displayName}. Please ensure the extension is running. To install the extension, run /ide install.`,
      true,
    );
  }

  /**
   * Opens a diff view in the IDE, allowing the user to review and accept or
   * reject changes.
   *
   * This method sends a request to the IDE to display a diff between the
   * current content of a file and the new content provided. It then waits for
   * a notification from the IDE indicating that the user has either accepted
   * (potentially with manual edits) or rejected the diff.
   *
   * A mutex ensures that only one diff view can be open at a time to prevent
   * race conditions.
   *
   * @param filePath The absolute path to the file to be diffed.
   * @param newContent The proposed new content for the file.
   * @returns A promise that resolves with a `DiffUpdateResult`, indicating
   *   whether the diff was 'accepted' or 'rejected' and including the final
   *   content if accepted.
   */
  async openDiff(
    filePath: string,
    newContent: string,
  ): Promise<DiffUpdateResult> {
    const release = await this.acquireMutex();

    const promise = new Promise<DiffUpdateResult>((resolve, reject) => {
      if (!this.client) {
        // The promise will be rejected, and the finally block below will release the mutex.
        return reject(new Error('IDE client is not connected.'));
      }
      this.diffResponses.set(filePath, resolve);
      this.client
        .request(
          {
            method: 'tools/call',
            params: {
              name: `openDiff`,
              arguments: {
                filePath,
                newContent,
              },
            },
          },
          CallToolResultSchema,
          { timeout: IDE_REQUEST_TIMEOUT_MS },
        )
        .then((parsedResultData) => {
          if (parsedResultData.isError) {
            const textPart = parsedResultData.content.find(
              (part) => part.type === 'text',
            );
            const errorMessage =
              textPart?.text ?? `Tool 'openDiff' reported an error.`;
            debugLogger.debug(
              `Request for openDiff ${filePath} failed with isError:`,
              errorMessage,
            );
            this.diffResponses.delete(filePath);
            reject(new Error(errorMessage));
          }
        })
        .catch((err) => {
          debugLogger.debug(`Request for openDiff ${filePath} failed:`, err);
          this.diffResponses.delete(filePath);
          reject(err);
        });
    });

    // Ensure the mutex is released only after the diff interaction is complete.
    promise.finally(release);

    return promise;
  }

  /**
   * Acquires a lock to ensure sequential execution of critical sections.
   *
   * This method implements a promise-based mutex. It works by chaining promises.
   * Each call to `acquireMutex` gets the current `diffMutex` promise. It then
   * creates a *new* promise (`newMutex`) that will be resolved when the caller
   * invokes the returned `release` function. The `diffMutex` is immediately
   * updated to this `newMutex`.
   *
   * The method returns a promise that resolves with the `release` function only
   * *after* the *previous* `diffMutex` promise has resolved. This creates a
   * queue where each subsequent operation must wait for the previous one to release
   * the lock.
   *
   * @returns A promise that resolves to a function that must be called to
   *   release the lock.
   */
  private acquireMutex(): Promise<() => void> {
    let release: () => void;
    const newMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldMutex = this.diffMutex;
    this.diffMutex = newMutex;
    return oldMutex.then(() => release);
  }

  async closeDiff(
    filePath: string,
    options?: { suppressNotification?: boolean },
  ): Promise<string | undefined> {
    try {
      if (!this.client) {
        return undefined;
      }
      const resultData = await this.client.request(
        {
          method: 'tools/call',
          params: {
            name: `closeDiff`,
            arguments: {
              filePath,
              suppressNotification: options?.suppressNotification,
            },
          },
        },
        CallToolResultSchema,
        { timeout: IDE_REQUEST_TIMEOUT_MS },
      );

      if (!resultData) {
        return undefined;
      }

      if (resultData.isError) {
        const textPart = resultData.content.find(
          (part) => part.type === 'text',
        );
        const errorMessage =
          textPart?.text ?? `Tool 'closeDiff' reported an error.`;
        debugLogger.debug(
          `Request for closeDiff ${filePath} failed with isError:`,
          errorMessage,
        );
        return undefined;
      }

      const textPart = resultData.content.find((part) => part.type === 'text');

      if (textPart?.text) {
        try {
          const parsedJson = JSON.parse(textPart.text);
          if (parsedJson && typeof parsedJson.content === 'string') {
            return parsedJson.content;
          }
          if (parsedJson && parsedJson.content === null) {
            return undefined;
          }
        } catch (_e) {
          debugLogger.debug(
            `Invalid JSON in closeDiff response for ${filePath}:`,
            textPart.text,
          );
        }
      }
    } catch (err) {
      debugLogger.debug(`Request for closeDiff ${filePath} failed:`, err);
    }
    return undefined;
  }

  // Closes the diff. Instead of waiting for a notification,
  // manually resolves the diff resolver as the desired outcome.
  async resolveDiffFromCli(filePath: string, outcome: 'accepted' | 'rejected') {
    const resolver = this.diffResponses.get(filePath);
    const content = await this.closeDiff(filePath, {
      // Suppress notification to avoid race where closing the diff rejects the
      // request.
      suppressNotification: true,
    });

    if (resolver) {
      if (outcome === 'accepted') {
        resolver({ status: 'accepted', content });
      } else {
        resolver({ status: 'rejected', content: undefined });
      }
      this.diffResponses.delete(filePath);
    }
  }

  async disconnect() {
    if (this.state.status === IDEConnectionStatus.Disconnected) {
      return;
    }
    for (const filePath of this.diffResponses.keys()) {
      await this.closeDiff(filePath);
    }
    this.diffResponses.clear();
    this.setState(
      IDEConnectionStatus.Disconnected,
      'IDE integration disabled. To enable it again, run /ide enable.',
    );
    this.client?.close();
  }

  getCurrentIde(): IdeInfo | undefined {
    return this.currentIde;
  }

  getConnectionStatus(): IDEConnectionState {
    return this.state;
  }

  getDetectedIdeDisplayName(): string | undefined {
    return this.currentIde?.displayName;
  }

  isDiffingEnabled(): boolean {
    return (
      !!this.client &&
      this.state.status === IDEConnectionStatus.Connected &&
      this.availableTools.includes('openDiff') &&
      this.availableTools.includes('closeDiff')
    );
  }

  private async discoverTools(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      debugLogger.debug('Discovering tools from IDE...');
      const response = await this.client.request(
        { method: 'tools/list', params: {} },
        ListToolsResultSchema,
      );

      // Map the array of tool objects to an array of tool names (strings)
      this.availableTools = response.tools.map((tool) => tool.name);

      if (this.availableTools.length > 0) {
        debugLogger.debug(
          `Discovered ${this.availableTools.length} tools from IDE: ${this.availableTools.join(', ')}`,
        );
      } else {
        debugLogger.debug(
          'IDE supports tool discovery, but no tools are available.',
        );
      }
    } catch (error) {
      // It's okay if this fails, the IDE might not support it.
      // Don't log an error if the method is not found, which is a common case.
      if (
        error instanceof Error &&
        !error.message?.includes('Method not found')
      ) {
        debugLogger.error(`Error discovering tools from IDE: ${error.message}`);
      } else {
        debugLogger.debug('IDE does not support tool discovery.');
      }
      this.availableTools = [];
    }
  }

  private setState(
    status: IDEConnectionStatus,
    details?: string,
    logToConsole = false,
  ) {
    const isAlreadyDisconnected =
      this.state.status === IDEConnectionStatus.Disconnected &&
      status === IDEConnectionStatus.Disconnected;

    // Only update details & log to console if the state wasn't already
    // disconnected, so that the first detail message is preserved.
    if (!isAlreadyDisconnected) {
      this.state = { status, details };
      for (const listener of this.statusListeners) {
        listener(this.state);
      }
      if (details) {
        if (logToConsole) {
          debugLogger.error(details);
        } else {
          // We only want to log disconnect messages to debug
          // if they are not already being logged to the console.
          debugLogger.debug(details);
        }
      }
    }

    if (status === IDEConnectionStatus.Disconnected) {
      ideContextStore.clear();
    }
  }

  static validateWorkspacePath(
    ideWorkspacePath: string | undefined,
    cwd: string,
  ): { isValid: boolean; error?: string } {
    if (ideWorkspacePath === undefined) {
      return {
        isValid: false,
        error: `Failed to connect to IDE companion extension. Please ensure the extension is running. To install the extension, run /ide install.`,
      };
    }

    if (ideWorkspacePath === '') {
      return {
        isValid: false,
        error: `To use this feature, please open a workspace folder in your IDE and try again.`,
      };
    }

    const ideWorkspacePaths = ideWorkspacePath.split(path.delimiter);
    const realCwd = getRealPath(cwd);
    const isWithinWorkspace = ideWorkspacePaths.some((workspacePath) => {
      const idePath = getRealPath(workspacePath);
      return isSubpath(idePath, realCwd);
    });

    if (!isWithinWorkspace) {
      return {
        isValid: false,
        error: `Directory mismatch. Qwen Code is running in a different location than the open workspace in the IDE. Please run the CLI from one of the following directories: ${ideWorkspacePaths.join(
          ', ',
        )}`,
      };
    }
    return { isValid: true };
  }

  private getPortFromEnv(): string | undefined {
    const port = process.env['QWEN_CODE_IDE_SERVER_PORT'];
    if (!port) {
      return undefined;
    }
    return port;
  }

  private getStdioConfigFromEnv(): StdioConfig | undefined {
    const command = process.env['QWEN_CODE_IDE_SERVER_STDIO_COMMAND'];
    if (!command) {
      return undefined;
    }

    const argsStr = process.env['QWEN_CODE_IDE_SERVER_STDIO_ARGS'];
    let args: string[] = [];
    if (argsStr) {
      try {
        const parsedArgs = JSON.parse(argsStr);
        if (Array.isArray(parsedArgs)) {
          args = parsedArgs;
        } else {
          debugLogger.error(
            'QWEN_CODE_IDE_SERVER_STDIO_ARGS must be a JSON array string.',
          );
        }
      } catch (e) {
        debugLogger.error(
          'Failed to parse QWEN_CODE_IDE_SERVER_STDIO_ARGS:',
          e,
        );
      }
    }

    return { command, args };
  }

  private async getConnectionConfigFromFile(): Promise<
    | (ConnectionConfig & { workspacePath?: string; ideInfo?: IdeInfo })
    | undefined
  > {
    const portFromEnv = this.getPortFromEnv();
    if (portFromEnv) {
      try {
        const ideDir = Storage.getGlobalIdeDir();
        const lockFile = path.join(ideDir, `${portFromEnv}.lock`);
        const lockFileContents = await fs.promises.readFile(lockFile, 'utf8');
        return JSON.parse(lockFileContents);
      } catch (_) {
        // Fall through to legacy discovery.
      }
    }

    // Legacy discovery for VSCode extension < v0.5.1.
    return this.getLegacyConnectionConfig(portFromEnv);
  }

  // Legacy connection files were written in the global temp directory.
  private async getLegacyConnectionConfig(
    portFromEnv?: string,
  ): Promise<
    | (ConnectionConfig & { workspacePath?: string; ideInfo?: IdeInfo })
    | undefined
  > {
    if (this.ideProcessInfo) {
      try {
        const portFile = path.join(
          os.tmpdir(),
          `qwen-code-ide-server-${this.ideProcessInfo.pid}.json`,
        );
        const portFileContents = await fs.promises.readFile(portFile, 'utf8');
        return JSON.parse(portFileContents);
      } catch (_) {
        // For older/newer extension versions, the file name matches the pattern
        // /^qwen-code-ide-server-${pid}-\d+\.json$/. If multiple IDE
        // windows are open, multiple files matching the pattern are expected to
        // exist.
      }
    }

    if (portFromEnv) {
      try {
        const portFile = path.join(
          os.tmpdir(),
          `qwen-code-ide-server-${portFromEnv}.json`,
        );
        const portFileContents = await fs.promises.readFile(portFile, 'utf8');
        return JSON.parse(portFileContents);
      } catch (_) {
        // Ignore and fall through.
      }
    }

    return undefined;
  }

  protected async getAllConnectionConfigs(
    ideDir: string,
  ): Promise<
    ConnectionConfig & Array<{ workspacePath?: string; ideInfo?: IdeInfo }>
  > {
    const fileRegex = new RegExp('^\\d+\\.lock$');
    let lockFiles: string[];
    try {
      lockFiles = (await fs.promises.readdir(ideDir)).filter((file) =>
        fileRegex.test(file),
      );
    } catch (e) {
      debugLogger.debug('Failed to read IDE connection directory:', e);
      return [];
    }

    const fileContents = await Promise.all(
      lockFiles.map(async (file) => {
        const fullPath = path.join(ideDir, file);
        try {
          const stat = await fs.promises.stat(fullPath);
          const content = await fs.promises.readFile(fullPath, 'utf8');
          try {
            const parsed = JSON.parse(content);
            return { file, mtimeMs: stat.mtimeMs, parsed };
          } catch (e) {
            debugLogger.debug('Failed to parse JSON from lock file: ', e);
            return { file, mtimeMs: stat.mtimeMs, parsed: undefined };
          }
        } catch (e) {
          // If we can't stat/read the file, treat it as very old so it doesn't
          // win ties, and skip parsing by returning undefined content.
          debugLogger.debug('Failed to read/stat IDE lock file:', e);
          return { file, mtimeMs: -Infinity, parsed: undefined };
        }
      }),
    );

    return fileContents
      .filter(({ parsed }) => parsed !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(({ parsed }) => parsed);
  }

  private createProxyAwareFetch(ideHost: string) {
    // ignore proxy for '127.0.0.1' and the actual IDE host by default
    // to allow connecting to the ide mcp server even when HTTP_PROXY is set
    const existingNoProxy = process.env['NO_PROXY'] || '';
    const agent = new EnvHttpProxyAgent({
      noProxy: [existingNoProxy, '127.0.0.1', ideHost]
        .filter(Boolean)
        .join(','),
    });
    const undiciPromise = import('undici');
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const { fetch: fetchFn } = await undiciPromise;
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        ...init,
        dispatcher: agent,
      };
      const options = fetchOptions as unknown as import('undici').RequestInit;
      const response = await fetchFn(url, options);
      // Convert undici Headers to standard Headers for compatibility
      const standardHeaders = new Headers();
      for (const [key, value] of response.headers.entries()) {
        standardHeaders.set(key, value);
      }

      return new Response(response.body as ReadableStream<unknown> | null, {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
      });
    };
  }

  private registerClientHandlers() {
    if (!this.client) {
      return;
    }

    this.client.setNotificationHandler(
      IdeContextNotificationSchema,
      (notification) => {
        ideContextStore.set(notification.params);
        const isTrusted = notification.params.workspaceState?.isTrusted;
        if (isTrusted !== undefined) {
          for (const listener of this.trustChangeListeners) {
            listener(isTrusted);
          }
        }
      },
    );
    this.client.onerror = (_error) => {
      const errorMessage = _error instanceof Error ? _error.message : `_error`;
      this.setState(
        IDEConnectionStatus.Disconnected,
        `IDE connection error. The connection was lost unexpectedly. Please try reconnecting by running /ide enable\n${errorMessage}`,
        true,
      );
    };
    this.client.onclose = () => {
      this.setState(
        IDEConnectionStatus.Disconnected,
        `IDE connection closed. To reconnect, run /ide enable.`,
        true,
      );
    };
    this.client.setNotificationHandler(
      IdeDiffAcceptedNotificationSchema,
      (notification) => {
        const { filePath, content } = notification.params;
        const resolver = this.diffResponses.get(filePath);
        if (resolver) {
          resolver({ status: 'accepted', content });
          this.diffResponses.delete(filePath);
        } else {
          debugLogger.debug(`No resolver found for ${filePath}`);
        }
      },
    );

    this.client.setNotificationHandler(
      IdeDiffRejectedNotificationSchema,
      (notification) => {
        const { filePath } = notification.params;
        const resolver = this.diffResponses.get(filePath);
        if (resolver) {
          resolver({ status: 'rejected', content: undefined });
          this.diffResponses.delete(filePath);
        } else {
          debugLogger.debug(`No resolver found for ${filePath}`);
        }
      },
    );

    // For backwards compatability. Newer extension versions will only send
    // IdeDiffRejectedNotificationSchema.
    this.client.setNotificationHandler(
      IdeDiffClosedNotificationSchema,
      (notification) => {
        const { filePath } = notification.params;
        const resolver = this.diffResponses.get(filePath);
        if (resolver) {
          resolver({ status: 'rejected', content: undefined });
          this.diffResponses.delete(filePath);
        } else {
          debugLogger.debug(`No resolver found for ${filePath}`);
        }
      },
    );
  }

  private async establishHttpConnection(port: string): Promise<boolean> {
    let transport: StreamableHTTPClientTransport | undefined;
    try {
      debugLogger.debug('Attempting to connect to IDE via HTTP SSE');
      this.client = new Client({
        name: 'streamable-http-client',
        // TODO(#3487): use the CLI version here.
        version: '1.0.0',
      });

      const ideHost = await getIdeServerHost();
      transport = new StreamableHTTPClientTransport(
        new URL(`http://${ideHost}:${port}/mcp`),
        {
          fetch: this.createProxyAwareFetch(ideHost),
          requestInit: {
            headers: this.authToken
              ? { Authorization: `Bearer ${this.authToken}` }
              : {},
          },
        },
      );

      this.registerClientHandlers();

      await this.client.connect(transport);
      this.registerClientHandlers();
      await this.discoverTools();
      this.setState(IDEConnectionStatus.Connected);
      return true;
    } catch (_error) {
      if (transport) {
        try {
          await transport.close();
        } catch (closeError) {
          debugLogger.debug('Failed to close transport:', closeError);
        }
      }
      return false;
    }
  }

  private async establishStdioConnection({
    command,
    args,
  }: StdioConfig): Promise<boolean> {
    let transport: StdioClientTransport | undefined;
    try {
      debugLogger.debug('Attempting to connect to IDE via stdio');
      this.client = new Client({
        name: 'stdio-client',
        // TODO(#3487): use the CLI version here.
        version: '1.0.0',
      });

      transport = new StdioClientTransport({
        command,
        args,
      });
      await this.client.connect(transport);
      this.registerClientHandlers();
      await this.discoverTools();
      this.setState(IDEConnectionStatus.Connected);
      return true;
    } catch (_error) {
      if (transport) {
        try {
          await transport.close();
        } catch (closeError) {
          debugLogger.debug('Failed to close transport:', closeError);
        }
      }
      return false;
    }
  }
}

/**
 * Cached IDE server host result to avoid repeated DNS lookups.
 */
let cachedIdeServerHost: string | undefined;

/**
 * In-flight promise for concurrent lookups to prevent redundant DNS queries.
 */
let lookupPromise: Promise<string> | undefined;

const IDE_HOST_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Reset the cached IDE server host. Exported for testing only.
 * @internal
 */
export function _resetCachedIdeServerHost(): void {
  cachedIdeServerHost = undefined;
  lookupPromise = undefined;
}

/**
 * Check if a hostname is resolvable via DNS lookup.
 */
function checkHostReachable(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      debugLogger.debug(
        `DNS lookup timed out for ${hostname} after ${IDE_HOST_LOOKUP_TIMEOUT_MS}ms`,
      );
      resolve(false);
    }, IDE_HOST_LOOKUP_TIMEOUT_MS);
    timeout.unref?.();

    dns.lookup(hostname, (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(!err);
    });
  });
}

/**
 * Determine the IDE server host to connect to.
 *
 * In container environments (Docker, Podman, etc.), the CLI needs to reach the
 * host machine where the IDE extension is running. The conventional hostname
 * `host.docker.internal` is typically available in Docker Desktop but may not
 * exist in Linux Docker or other container runtimes (e.g. code-server remote).
 *
 * This function:
 * 1. Detects if we are inside a container (via `/.dockerenv` or `/run/.containerenv`).
 * 2. If so, performs an async DNS check to verify `host.docker.internal` is resolvable.
 * 3. Falls back to `127.0.0.1` if the hostname is not reachable.
 */
async function doLookup(): Promise<string> {
  const isInContainer =
    fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

  if (isInContainer) {
    const reachable = await checkHostReachable('host.docker.internal');
    if (reachable) {
      debugLogger.debug(
        'Container detected, host.docker.internal is reachable',
      );
      cachedIdeServerHost = 'host.docker.internal';
    } else {
      debugLogger.debug(
        'Container detected, but host.docker.internal is NOT reachable, falling back to 127.0.0.1',
      );
      cachedIdeServerHost = '127.0.0.1';
    }
  } else {
    cachedIdeServerHost = '127.0.0.1';
  }

  return cachedIdeServerHost;
}

export async function getIdeServerHost(): Promise<string> {
  // Return cached result if available
  if (cachedIdeServerHost !== undefined) {
    return cachedIdeServerHost;
  }

  // If a lookup is already in progress, wait for it to complete
  if (lookupPromise !== undefined) {
    return lookupPromise;
  }

  // Start a new lookup and store the promise for concurrent callers
  lookupPromise = doLookup();

  try {
    const result = await lookupPromise;
    return result;
  } finally {
    // Clear the in-flight promise so future calls use the cache
    lookupPromise = undefined;
  }
}
