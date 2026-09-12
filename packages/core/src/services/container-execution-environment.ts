/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { parse } from 'shell-quote';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolNames } from '../tools/tool-names.js';
import type {
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
  ToolResult,
  ToolResultDisplay,
} from '../tools/tools.js';
import type {
  ExecutionConfirmation,
  ExecutionEnvironment,
  ExecutionPreparation,
  ExecutionWorkerOptions,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
  PreparedExecution,
} from './execution-environment.js';
import { ExecutionCleanupError } from './execution-environment.js';

export interface ContainerExecutionOptions {
  runtime: 'docker' | 'podman';
  image: string;
  bundleDirectory: string;
  runtimeEnv: NodeJS.ProcessEnv;
  environment: readonly string[];
  containerHome: string;
}

/** Only standalone package-manager installs receive network access. */
export function isPackageInstallation(command: string): boolean {
  if (/[\n\r$`]/.test(command)) return false;
  try {
    const words = parse(command);
    if (!words.every((word) => typeof word === 'string')) return false;
    const [program, action] = words;
    return (
      (program === 'npm' && (action === 'install' || action === 'ci')) ||
      (program === 'pnpm' && action === 'install') ||
      (program === 'yarn' && action === 'install')
    );
  } catch {
    return false;
  }
}

function runtimeCommand(
  options: ContainerExecutionOptions,
  args: string[],
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      options.runtime,
      args,
      {
        env: options.runtimeEnv,
        cwd: tmpdir(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${options.runtime} ${args[0]} failed: ${stderr || error.message}`,
            ),
          );
        else resolveResult(stdout);
      },
    );
  });
}

export function workerContainerArguments(
  options: ContainerExecutionOptions,
  worker: ExecutionWorkerOptions,
  name: string,
  rootless: boolean,
  gitMask?: string,
  network = false,
): string[] {
  const args = [
    'create',
    '--init',
    '--interactive',
    '--name',
    name,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--volume',
    `${worker.workspace}:${worker.workspace}`,
    '--volume',
    `${options.bundleDirectory}:/opt/qwen-executor:ro`,
    '--workdir',
    worker.workspace,
    '--tmpfs',
    `${options.containerHome}:rw,mode=1777`,
  ];
  if (worker.outputDirectory)
    args.push(
      '--volume',
      `${worker.outputDirectory}:${worker.outputDirectory}`,
    );
  if (gitMask)
    args.push('--volume', `${gitMask}:${join(worker.workspace, '.git')}:ro`);
  if (!network) args.push('--network', 'none');
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!rootless && uid !== undefined && gid !== undefined)
    args.push('--user', `${uid}:${gid}`);
  for (const value of options.environment) args.push('--env', value);
  args.push(
    '--entrypoint',
    'node',
    options.image,
    '/opt/qwen-executor/execution-worker.js',
    JSON.stringify(worker),
  );
  return args;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  update?: (output: ToolResultDisplay) => void;
}

class ContainerWorker {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private failure?: Error;
  private disposal?: Promise<void>;
  private starting?: Promise<void>;
  private stderr = '';
  readonly name = `qwen-agent-${randomUUID()}`;

  constructor(private readonly options: ContainerExecutionOptions) {}

  start(
    worker: ExecutionWorkerOptions,
    rootless: boolean,
    gitMask: string | undefined,
    network: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.starting = this.startInternal(
      worker,
      rootless,
      gitMask,
      network,
      signal,
    );
    return this.starting;
  }

  private async startInternal(
    worker: ExecutionWorkerOptions,
    rootless: boolean,
    gitMask: string | undefined,
    network: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await runtimeCommand(
      this.options,
      workerContainerArguments(
        this.options,
        worker,
        this.name,
        rootless,
        gitMask,
        network,
      ),
    );
    signal.throwIfAborted();
    if (this.disposal)
      throw new Error('Container executor was disposed during startup.');
    const child = spawn(
      this.options.runtime,
      ['start', '--attach', '--interactive', this.name],
      {
        env: this.options.runtimeEnv,
        cwd: tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.process = child;
    child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-8192);
    });
    child.on('error', (error) => this.fail(error));
    child.on('close', () =>
      this.fail(new Error(`Container executor exited. ${this.stderr}`)),
    );
    child.stdin.on('error', (error) => this.fail(error));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const reply = JSON.parse(line) as ExecutionWorkerReply;
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        if ('update' in reply) {
          pending.update?.(reply.update);
          return;
        }
        this.pending.delete(reply.id);
        if ('error' in reply) pending.reject(new Error(reply.error));
        else pending.resolve(reply.result);
      } catch {
        this.fail(
          new Error(
            'Container executor returned an invalid protocol response.',
          ),
        );
      }
    });
    await this.request(
      { method: 'invalidateReadCache' },
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
  }

  request<T>(
    request: ExecutionWorkerRequest,
    signal: AbortSignal,
    update?: (output: ToolResultDisplay) => void,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposal || !this.process)
      return Promise.reject(new Error('Container executor is closed.'));
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise<T>((resolveResult, reject) => {
      const aborted = () => {
        this.process?.stdin.write(`${JSON.stringify({ cancel: id })}\n`);
        this.fail(
          new Error(
            'Container execution cancelled; an interrupted write may have completed. Do not automatically retry.',
          ),
        );
      };
      this.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener('abort', aborted);
          resolveResult(value as T);
        },
        reject: (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        },
        update,
      });
      signal.addEventListener('abort', aborted, { once: true });
      this.process!.stdin.write(`${JSON.stringify({ id, request })}\n`);
    });
  }

  private fail(error: Error): void {
    this.failure ??= new Error(
      `${error.message} Execution outcome may be unknown; no operation was replayed.`,
    );
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  dispose(): Promise<void> {
    this.fail(new Error('Container executor disposed.'));
    this.disposal ??= this.remove();
    return this.disposal;
  }

  private async remove(): Promise<void> {
    await this.starting?.catch(() => undefined);
    this.process?.kill('SIGKILL');
    try {
      await runtimeCommand(this.options, ['rm', '-f', this.name]);
    } catch (error) {
      if (
        !/No such container|no container with (?:name or )?ID/i.test(
          String(error),
        )
      ) {
        throw new ExecutionCleanupError(
          `Could not remove container ${this.name}; preserve its workspace until cleanup succeeds: ${String(error)}`,
        );
      }
    }
  }
}

export class ContainerExecutionEnvironment implements ExecutionEnvironment {
  get outputDirectory(): string {
    return join(this.temporaryDirectory, 'output');
  }
  private readonly workers = new Set<ContainerWorker>();
  private readonly invocations = new Map<string, ContainerWorker>();
  private disposal?: Promise<void>;
  private constructor(
    private readonly options: ContainerExecutionOptions,
    private readonly workerOptions: ExecutionWorkerOptions,
    private readonly rootless: boolean,
    private readonly temporaryDirectory: string,
    private readonly gitMask: string | undefined,
    private readonly primary: ContainerWorker,
  ) {
    this.workers.add(primary);
  }

  static async create(
    config: Config,
    options: ContainerExecutionOptions,
    signal: AbortSignal,
  ): Promise<ContainerExecutionEnvironment> {
    signal.throwIfAborted();
    const workspace = await realpath(config.getWorkingDir());
    const bundleDirectory = await realpath(options.bundleDirectory);
    if (
      process.platform === 'win32' ||
      workspace.includes(':') ||
      bundleDirectory.includes(':')
    ) {
      throw new Error(
        'Container execution requires Unix paths without volume separators.',
      );
    }
    for (const protectedDirectory of [
      homedir(),
      Storage.getGlobalQwenDir(),
      Storage.getRuntimeBaseDir(),
    ]) {
      const canonical = await realpath(protectedDirectory).catch(() =>
        resolve(protectedDirectory),
      );
      const fromWorkspace = relative(workspace, canonical);
      if (
        fromWorkspace === '' ||
        (!fromWorkspace.startsWith(`..${sep}`) &&
          fromWorkspace !== '..' &&
          !isAbsolute(fromWorkspace))
      ) {
        throw new Error(
          'Container workspace must not contain the host home, Qwen credentials or runtime directory.',
        );
      }
    }
    await access(join(bundleDirectory, 'execution-worker.js'));
    const resolvedOptions = { ...options, bundleDirectory };
    const info = await runtimeCommand(resolvedOptions, [
      'info',
      '--format',
      '{{json .}}',
    ]);
    const rootless =
      info.includes('"name=rootless"') ||
      info.includes('"rootless":true') ||
      info.includes('"Rootless":true');
    const lines = config.getTruncateToolOutputLines();
    const threshold = config.getTruncateToolOutputThreshold();
    const workerOptions: ExecutionWorkerOptions = {
      workspace,
      sessionId: `executor-${randomUUID()}`,
      // Zero disables truncation; Infinity would become null on the wire.
      truncateToolOutputLines: Number.isFinite(lines) ? lines : 0,
      truncateToolOutputThreshold:
        config.isTruncateToolOutputThresholdExplicit()
          ? Number.isFinite(threshold)
            ? threshold
            : 0
          : undefined,
      fileReadCacheDisabled: config.getFileReadCacheDisabled(),
      fileFiltering: config.getFileFilteringOptions(),
      defaultFileEncoding: config.getDefaultFileEncoding(),
      shellDefaultTimeoutMs: config.getShellDefaultTimeoutMs(),
      shellHeartbeatIntervalMs: config.getShellHeartbeatIntervalMs(),
      maxBufferedOutputBytes:
        config.getShellExecutionConfig().maxBufferedOutputBytes,
    };
    const gitEntry = await lstat(join(workspace, '.git')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      },
    );
    if (gitEntry?.isSymbolicLink())
      throw new Error('A symlinked .git entry cannot be safely mounted.');
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'qwen-agent-executor-'),
    );
    const gitMask = gitEntry ? join(temporaryDirectory, 'git-mask') : undefined;
    const primary = new ContainerWorker(resolvedOptions);
    const environment = new ContainerExecutionEnvironment(
      resolvedOptions,
      workerOptions,
      rootless,
      temporaryDirectory,
      gitMask,
      primary,
    );
    try {
      await mkdir(environment.outputDirectory);
      workerOptions.outputDirectory = environment.outputDirectory;
      if (gitMask) {
        if (gitEntry?.isDirectory()) await mkdir(gitMask);
        else await writeFile(gitMask, '');
      }
      await primary.start(workerOptions, rootless, gitMask, false, signal);
      return environment;
    } catch (error) {
      await environment.dispose();
      throw error;
    }
  }

  async prepare(
    request: ExecutionPreparation,
    signal: AbortSignal,
  ): Promise<PreparedExecution> {
    if (this.disposal) throw new Error('Container executor is closed.');
    let worker = this.primary;
    if (
      request.toolName === ToolNames.SHELL &&
      typeof request.params['command'] === 'string' &&
      isPackageInstallation(request.params['command'])
    ) {
      if (request.params['is_background'])
        throw new Error(
          'Network-enabled package installations must run in the foreground.',
        );
      worker = new ContainerWorker(this.options);
      this.workers.add(worker);
      try {
        await worker.start(
          this.workerOptions,
          this.rootless,
          this.gitMask,
          true,
          signal,
        );
      } catch (error) {
        await worker.dispose();
        this.workers.delete(worker);
        throw error;
      }
    }
    this.invocations.set(request.id, worker);
    try {
      return await worker.request({ method: 'prepare', request }, signal);
    } catch (error) {
      await this.release(request.id, AbortSignal.timeout(30_000));
      throw error;
    }
  }

  private invocation(id: string): ContainerWorker {
    const worker = this.invocations.get(id);
    if (!worker) throw new Error('Unknown container invocation.');
    return worker;
  }
  permission(id: string, signal: AbortSignal): Promise<PermissionDecision> {
    return this.invocation(id).request(
      { method: 'permission', invocationId: id },
      signal,
    );
  }
  confirmation(
    id: string,
    signal: AbortSignal,
  ): Promise<ExecutionConfirmation> {
    return this.invocation(id).request(
      { method: 'confirmation', invocationId: id },
      signal,
    );
  }
  confirm(
    id: string,
    outcome: ToolConfirmationOutcome,
    payload: ToolConfirmationPayload | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    return this.invocation(id).request(
      { method: 'confirm', invocationId: id, outcome, payload },
      signal,
    );
  }
  async execute(
    id: string,
    signal: AbortSignal,
    update?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    const worker = this.invocation(id);
    let result: ToolResult;
    try {
      result = await worker.request<ToolResult>(
        { method: 'execute', invocationId: id },
        signal,
        update,
      );
    } catch (error) {
      await this.release(id, AbortSignal.timeout(30_000)).catch(
        () => undefined,
      );
      throw error;
    }
    this.invocations.delete(id);
    if (worker !== this.primary) {
      try {
        await worker.dispose();
        this.workers.delete(worker);
      } catch (error) {
        const notice = `\n\n[Container cleanup failed after tool execution: ${String(error)}. The tool result above is still valid; do not automatically retry the command.]`;
        result.llmContent =
          typeof result.llmContent === 'string'
            ? result.llmContent + notice
            : [
                ...(Array.isArray(result.llmContent)
                  ? result.llmContent
                  : [result.llmContent]),
                { text: notice },
              ];
        if (typeof result.returnDisplay === 'string') {
          result.returnDisplay += notice;
        }
        if (result.error) result.error.message += notice;
      }
    }
    return result;
  }

  modificationContent(
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ current: string; proposed: string }> {
    return this.primary.request(
      { method: 'modificationContent', toolName, params },
      signal,
    );
  }
  async release(id: string, signal: AbortSignal): Promise<void> {
    const worker = this.invocations.get(id);
    if (!worker) return;
    this.invocations.delete(id);
    if (worker !== this.primary) {
      await worker.dispose();
      this.workers.delete(worker);
    } else
      await worker.request({ method: 'release', invocationId: id }, signal);
  }
  async invalidateReadCache(paths?: readonly string[]): Promise<void> {
    await this.primary.request(
      { method: 'invalidateReadCache', paths },
      AbortSignal.timeout(30_000),
    );
  }
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      const results = await Promise.allSettled(
        [...this.workers].map((worker) => worker.dispose()),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      this.invocations.clear();
      this.workers.clear();
      await rm(this.temporaryDirectory, { recursive: true, force: true });
    })();
    return this.disposal;
  }
}
