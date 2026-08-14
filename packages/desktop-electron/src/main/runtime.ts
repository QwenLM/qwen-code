/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const LISTEN_PREFIX = 'qwen serve listening on ';
const STARTUP_TIMEOUT_MS = 45_000;
const HEALTH_RETRY_MS = 100;
const FAILURE_OUTPUT_LIMIT = 16 * 1024;

export interface RuntimeLayout {
  entry: string;
  node: string;
  root: string;
}

export interface RuntimeStartOptions {
  logPath: string;
  onUnexpectedExit?: (status: string) => void;
  packageDir: string;
  resourcesPath: string;
  workspace: string;
}

export function runtimeArguments(workspace: string): string[] {
  return [
    'serve',
    '--port',
    '0',
    '--hostname',
    '127.0.0.1',
    '--require-auth',
    '--workspace',
    workspace,
    '--no-open',
  ];
}

export function parseListeningUrl(line: string): string | undefined {
  if (!line.startsWith(LISTEN_PREFIX)) return undefined;
  const raw = line.slice(LISTEN_PREFIX.length).split(/\s+/, 1)[0];
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function createAuthenticatedWebUrl(
  baseUrl: string,
  token: string,
): string {
  const url = new URL(baseUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.href;
}

export function resolveRuntimeLayout(
  packageDir: string,
  resourcesPath: string,
  override = process.env['QWEN_DESKTOP_RUNTIME_DIR'],
): RuntimeLayout {
  const root = override
    ? path.resolve(override)
    : process.env['ELECTRON_IS_PACKAGED'] === '1'
      ? path.join(resourcesPath, 'runtime', 'qwen-code')
      : path.join(packageDir, 'runtime', 'qwen-code');
  const node =
    process.platform === 'win32'
      ? path.join(root, 'node', 'node.exe')
      : path.join(root, 'node', 'bin', 'node');
  const entry = path.join(root, 'lib', 'cli-entry.js');
  requireFile(node, 'Node.js runtime');
  requireFile(entry, 'Qwen Code runtime entry');
  return { entry, node, root };
}

export class DesktopRuntime {
  readonly baseUrl: string;
  readonly token: string;

  private constructor(
    baseUrl: string,
    token: string,
    private readonly child: ChildProcess,
    private readonly log: fs.WriteStream,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private stopping = false;

  static async start(options: RuntimeStartOptions): Promise<DesktopRuntime> {
    const layout = resolveRuntimeLayout(
      options.packageDir,
      options.resourcesPath,
    );
    const token = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
    const log = fs.createWriteStream(options.logPath, { flags: 'a' });
    const child = spawn(
      layout.node,
      [layout.entry, ...runtimeArguments(options.workspace)],
      {
        cwd: options.workspace,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          QWEN_CODE_DESKTOP: '1',
          QWEN_SERVER_TOKEN: token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let runtime: DesktopRuntime | undefined;
    let failureOutput = '';
    let stdoutBuffer = '';
    const record = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      log.write(`[${stream}] ${text}`);
      if (failureOutput.length < FAILURE_OUTPUT_LIMIT) {
        failureOutput = `${failureOutput}${text}`.slice(
          0,
          FAILURE_OUTPUT_LIMIT,
        );
      }
    };
    child.stderr?.on('data', (chunk: Buffer) => record('stderr', chunk));

    const listening = new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.stdout?.on('data', (chunk: Buffer) => {
        record('stdout', chunk);
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const baseUrl = parseListeningUrl(line);
          if (baseUrl) {
            resolve(baseUrl);
            return;
          }
        }
      });
      child.once('exit', (code, signal) => {
        if (!runtime) {
          reject(
            new Error(
              startupError(
                `Bundled runtime exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`,
                failureOutput,
              ),
            ),
          );
        }
      });
    });

    try {
      const baseUrl = await withTimeout(
        listening,
        STARTUP_TIMEOUT_MS,
        'Timed out waiting for the bundled runtime to listen.',
      );
      await waitForHealth(baseUrl, token, child, failureOutput);
      runtime = new DesktopRuntime(baseUrl, token, child, log);
      child.on('exit', (code, signal) => {
        if (!runtime?.stopping) {
          options.onUnexpectedExit?.(
            `code ${code ?? 'null'}, signal ${signal ?? 'null'}`,
          );
        }
      });
      return runtime;
    } catch (error) {
      terminateProcessTree(child);
      log.end();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(startupError(message, failureOutput));
    }
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    terminateProcessTree(this.child);
    this.log.end();
  }

  authenticatedWebUrl(): string {
    return createAuthenticatedWebUrl(this.baseUrl, this.token);
  }
}

async function waitForHealth(
  baseUrl: string,
  token: string,
  child: ChildProcess,
  failureOutput: string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        startupError(
          'Bundled runtime exited during health check.',
          failureOutput,
        ),
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health?deep=true`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok && (await response.text()).includes('"status":"ok"')) {
        return;
      }
    } catch {
      // The deferred runtime may not be mounted yet.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
  }
  throw new Error(
    startupError(
      'Timed out waiting for the bundled runtime health check.',
      failureOutput,
    ),
  );
}

function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function requireFile(file: string, description: string): void {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${description} is missing at ${file}`);
  }
}

function startupError(message: string, output: string): string {
  const trimmed = output.trim();
  return trimmed ? `${message}\n\nRuntime output:\n${trimmed}` : message;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
