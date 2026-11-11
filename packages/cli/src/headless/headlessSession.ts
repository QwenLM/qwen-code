/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseSdkInputBlock } from '@qwen-code/core';

/**
 * Pure headless 会话：`-p` 一次性 prompt，输出 text/json；也支持文档承诺的
 * `--input-format stream-json` 结构化输入与 `--output-format stream-json` 帧输出。
 *
 * 由 Framework 在 init 阶段创建并注入已启动的 ThreadManager；`run()` 打开会话、
 * 装配执行内核、接管输入输出并收尾。
 */

import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import {
  BRAND_CLI_BIN,
  FatalError,
  FatalInputError,
  ExitCodes,
  ForkSessionService,
  TranscriptStore,
  OutputFormat,
  buildTurnFailureResult,
  createWorkingStdio,
  getResultErrorCode,
  ndjsonSafeStringify,
  runLogger,
  writeToStderr,
  type SDKSystemMessage,
  type BackgroundWindDownPolicy,
  type Config,
  type SDKMessage,
  type SessionResumeData,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import type { LoadedSettings } from '../config/settings.js';
import type { WorktreeStartupRequest } from '../utils/worktreeStartupRequest.js';
import { applyWorktreeStartupRequest } from '../utils/worktreeStartupRequest.js';
import { applyResumeWorktreeState } from '../utils/applyResumeWorktreeState.js';
import { restoreRuntimeConfigFromResumeData } from '../utils/resumeModel.js';
import { isStdioPermissionPromptTool } from '../utils/headlessPermissionPrompt.js';
import { initializeOutputListenersAndFlush } from '../utils/outputListeners.js';
import { readStdin } from '../utils/readStdin.js';
import {
  buildErrorResultMessage,
  formatResultErrorMessage,
} from '../utils/errors.js';
import {
  setStreamJsonResultExitCode,
  writeHeadlessTextResult,
} from '../utils/nonInteractiveOutput.js';
import {
  exitHeadlessMode,
  resetHeadlessExitCode,
  HeadlessStartupAbort,
} from './exit.js';
import type {
  ThreadCallContext,
  ThreadCanUseToolDecision,
  ThreadCanUseToolRequest,
  ThreadEvent,
  ThreadEventSink,
  ThreadHost,
  ThreadHostRequests,
  ThreadReverseRequestOptions,
} from '../thread-manager/thread-session/contract/hostContext.js';
import type { ThreadUserMessage } from '../thread-manager/thread-session/contract/threadSessionTypes.js';
import { SessionPhaseLog } from '../thread-manager/thread-session/phase-log/sessionPhaseLog.js';
import type { ThreadManager } from '../thread-manager/threadManager.js';
import {
  applyUpdatedPermissions,
  createNamedToolAskHandler,
} from './permission.js';
import { StdioPermissionChannel } from './controlStream.js';
import { StreamJsonOutput } from './streamJsonOutput.js';
import { resolveHeadlessResume } from './sessionResume.js';
import { prepareHeadlessSession } from './startup.js';
import { createStartupModelApplier } from '../startup/applyStartupModel.js';
import { ToolFailureLog } from './toolFailureLog.js';
import { readPrintBackgroundWindDownPolicy } from './backgroundWindDownPolicy.js';

export interface HeadlessSessionParams {
  readonly settings: LoadedSettings;
  readonly cliArgs: CliArgs;
  readonly threadManager: ThreadManager;
  readonly workspaceRoot: string;
  readonly inheritedWorktreeRequest?: WorktreeStartupRequest;
}

type HeadlessResultMode = 'text' | 'json';

type TurnWaiter = {
  promise: Promise<SDKMessage>;
  resolve: (message: SDKMessage) => void;
};

/** 纯 headless 对 /plan 的固定拒绝文案与退出语义。 */
const PLAN_MODE_UNAVAILABLE_MESSAGE =
  'Plan mode is not available in headless mode.';
const PLAN_COMMAND_PATTERN = /^\/plan(\s|$)/;

function isPlanCommand(input: string): boolean {
  return PLAN_COMMAND_PATTERN.test(input.trim());
}

/** 落盘类错误：text 输出额外把原始错误打到 stderr。 */
const FILESYSTEM_ERROR_CODES = new Set([
  'EPERM',
  'EACCES',
  'EEXIST',
  'ENOTDIR',
  'ENOENT',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EISDIR',
  'EMFILE',
  'ENFILE',
]);

function isFilesystemError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && FILESYSTEM_ERROR_CODES.has(code);
}

export class HeadlessSession {
  private readonly toolFailureLog = new ToolFailureLog();
  protected readonly outputFormat: OutputFormat;
  private readonly resultMode: HeadlessResultMode;
  private readonly streamJsonInput: boolean;
  private readonly streamJsonOutput: StreamJsonOutput | undefined;
  private permissionChannel: StdioPermissionChannel | undefined;
  private readonly manager: ThreadManager;
  private openedSessionId: string | undefined;
  private host: ThreadHost | undefined;
  private turnWaiter: TurnWaiter | undefined;
  private stdinText: string | undefined;
  private stdoutErrorHandler: ((error: Error) => void) | undefined;
  private finished = false;
  private pendingFork:
    | {
        projectRoot: string;
        sessionId: string;
        sessionPath: string;
      }
    | undefined;

  constructor(private readonly params: HeadlessSessionParams) {
    this.manager = params.threadManager;
    this.outputFormat = (params.cliArgs.outputFormat ??
      (params.settings.merged.output as { format?: OutputFormat } | undefined)
        ?.format ??
      OutputFormat.TEXT) as OutputFormat;
    this.resultMode = this.outputFormat === OutputFormat.JSON ? 'json' : 'text';
    this.streamJsonInput = params.cliArgs.inputFormat === 'stream-json';
    this.streamJsonOutput =
      this.outputFormat === OutputFormat.STREAM_JSON
        ? new StreamJsonOutput(
            (line) => {
              createWorkingStdio().stdout.write(line);
            },
            {
              getSessionId: () => this.sessionId,
              decorateInitMessage: (message, version) =>
                this.decorateInitMessage(message, version),
              includeHookEvents: params.cliArgs.includeHookEvents === true,
              replayUserMessages: params.cliArgs.replayUserMessages === true,
            },
          )
        : undefined;
  }

  async run(): Promise<void> {
    resetHeadlessExitCode();
    this.validateCompatibility();
    await this.initInput();
    initializeOutputListenersAndFlush({
      skipUserFeedback: this.streamJsonOutput !== undefined,
    });
    this.installStdoutErrorHandler();
    try {
      await this.openSession();
      if (
        !this.streamJsonInput &&
        isStdioPermissionPromptTool(this.params.cliArgs.permissionPromptTool)
      ) {
        this.startPermissionConnection();
      }
      if (this.streamJsonInput) {
        await this.runStreamJsonInput();
      } else {
        await this.runTextTurn();
      }
    } catch (error) {
      if (error instanceof HeadlessStartupAbort) {
        this.renderStartupFailure(error.failure);
      } else if (
        this.streamJsonOutput &&
        this.openedSessionId &&
        !(error instanceof FatalError)
      ) {
        // stream-json 的会话级意外失败以单帧 result 收尾；text 与 FatalError
        // 仍走入口的错误出口（stderr + 对应退出码）。
        this.renderSessionFailure(error);
      } else {
        throw error;
      }
    } finally {
      this.permissionChannel?.close();
      this.permissionChannel = undefined;
      this.removeStdoutErrorHandler();
      try {
        await this.finish();
      } finally {
        this.toolFailureLog.clear();
      }
    }
    await exitHeadlessMode();
  }

  /** 读取输入并校验只有 stream-json 输出才支持的选项；入口不再做特判。 */
  private async initInput(): Promise<void> {
    const streamJsonOutput = this.outputFormat === OutputFormat.STREAM_JSON;
    // 参数组合错误固定带 Error: 前缀与句号，退出码 1。
    if (this.streamJsonInput && !streamJsonOutput) {
      throw new FatalError(
        'Error: --input-format=stream-json requires output-format=stream-json.',
        1,
      );
    }
    if (this.params.cliArgs.includePartialMessages && !streamJsonOutput) {
      throw new FatalError(
        'Error: --include-partial-messages requires --print and --output-format=stream-json.',
        1,
      );
    }
    // 仅在 stream-json 输入输出同时开启时回显用户消息。
    if (
      this.params.cliArgs.replayUserMessages &&
      !(this.streamJsonInput && streamJsonOutput)
    ) {
      throw new FatalError(
        'Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.',
        1,
      );
    }
    // hook 三帧由 StreamJsonOutput 转发。
    if (
      this.params.cliArgs.bare === true &&
      !(this.streamJsonInput && streamJsonOutput)
    ) {
      throw new FatalInputError(
        'bare_session_control_only: --bare requires --input-format stream-json --output-format stream-json; ordinary prompts are not supported',
      );
    }
    if (
      this.streamJsonInput &&
      isStdioPermissionPromptTool(this.params.cliArgs.permissionPromptTool)
    ) {
      throw new FatalError(
        '--permission-prompt-tool stdio cannot be combined with --input-format stream-json',
        1,
      );
    }
    if (this.streamJsonInput) return;

    // stdio 权限工具下 stdin 属于控制通道，不能当 prompt 读。
    if (
      !process.stdin.isTTY &&
      !isStdioPermissionPromptTool(this.params.cliArgs.permissionPromptTool)
    ) {
      this.stdinText = (await readStdin()) || undefined;
    }
  }

  /** 文本输入由会话自己的 Config 组装：argv prompt + session agent 的 initialPrompt，再拼 stdin。 */
  private composeTextInput(): string {
    const prompt = this.currentConfig().getEffectiveQuestion() ?? '';
    const stdin = this.stdinText;
    if (!stdin) return prompt;
    return prompt ? `${stdin}\n\n${prompt}` : stdin;
  }

  protected get sessionId(): string {
    if (!this.openedSessionId) {
      throw new Error('headless session is not opened');
    }
    return this.openedSessionId;
  }

  /** 产品层读会话自己的 Config；它由 ThreadManager 从 argv 装配，不是入口 Config。 */
  protected get settings(): LoadedSettings {
    return this.params.settings;
  }

  protected get cliArgs(): CliArgs {
    return this.params.cliArgs;
  }

  protected currentConfig(): Config {
    const session = this.manager?.get(this.sessionId);
    if (!session) {
      throw new Error('headless session is not initialized');
    }
    return session.requireConfig();
  }

  /** `adoptProcessAuth` 消费的进程运行期选项。 */
  protected get authRuntime(): { proxy?: string } {
    return {
      ...(this.params.cliArgs.proxy
        ? { proxy: this.params.cliArgs.proxy }
        : {}),
    };
  }

  protected async openSession(): Promise<void> {
    const resumedSessionData = await resolveHeadlessResume({
      cliArgs: this.params.cliArgs,
      workspaceRoot: this.params.workspaceRoot,
    });
    // The resolver creates these artifacts in this invocation. Keep ownership
    // until initialization succeeds; Manager only borrows the resume data.
    if (
      this.params.cliArgs.forkSession &&
      resumedSessionData?.forkTranscriptPath &&
      resumedSessionData.sourceSessionId &&
      resumedSessionData.sourceSessionId !== resumedSessionData.sessionId &&
      resumedSessionData.transcriptProjectRoot
    ) {
      this.pendingFork = {
        projectRoot: resumedSessionData.transcriptProjectRoot,
        sessionId: resumedSessionData.sessionId,
        sessionPath: resumedSessionData.forkTranscriptPath,
      };
    }
    // 恢复/续接沿用源会话身份；fork 沿用 builder 生成的 fork id（与旧入口一致）。
    const declaredSessionId =
      this.params.cliArgs.sessionId ?? resumedSessionData?.sessionId;
    try {
      this.openedSessionId = await this.manager.open({
        ...(declaredSessionId === undefined
          ? {}
          : { sessionId: declaredSessionId }),
        cwd: this.params.workspaceRoot,
        cliArgs:
          resumedSessionData && this.params.cliArgs.resume !== undefined
            ? { ...this.params.cliArgs, resume: resumedSessionData.sessionId }
            : this.params.cliArgs,
        ...(resumedSessionData?.sessionPath
          ? { resumeTranscriptPath: resumedSessionData.sessionPath }
          : {}),
        ...(resumedSessionData?.resumeCandidate
          ? { resumeCandidate: resumedSessionData.resumeCandidate }
          : {}),
        ...(resumedSessionData?.forkTranscriptPath &&
        resumedSessionData.transcriptReadState
          ? {
              resumeData: {
                ...resumedSessionData,
                resumeState: resumedSessionData.transcriptReadState,
                sourceSessionId:
                  resumedSessionData.sourceSessionId ??
                  resumedSessionData.sessionId,
                fileHistorySnapshots:
                  resumedSessionData.fileHistorySnapshots ?? [],
              },
            }
          : {}),
        // headless 的 resume/fork 前置链（buildResumedSessionData）已把 fork 副本落盘；
        // Manager 只接收「已是 fork 产物」的事实，不重复 fork。
        forked: this.params.cliArgs.forkSession === true,
        startupMode: 'headless',
        backgroundWindDownPolicy: this.backgroundWindDownPolicy(),
        ...(declaredSessionId === undefined
          ? {}
          : { phaseLog: new SessionPhaseLog(declaredSessionId) }),
      });
    } finally {
      resumedSessionData?.resumeAttempt?.finish();
    }
    this.host = this.createThreadHost();
    // 在首个 append 前打开 resume transcript；不可写时在会话 init 之前失败。
    // 这里用一次 append 打开复刻该时序。
    await this.assertResumeTranscriptWritable(resumedSessionData?.sessionPath);
    await this.applyResumeAndWorktreeState(
      resumedSessionData,
      this.resolveWorktreeStartupRequest(),
    );
    await prepareHeadlessSession({
      config: this.currentConfig(),
      settings: this.params.settings,
      cliArgs: this.params.cliArgs,
    });
    await this.applyStartupModel();
    await this.recordModelDisplayName();
  }

  /** 本地入口在初始恢复完成后应用一次 CLI 模型；产品子类自行决定认证后的时机。 */
  protected async applyStartupModel(): Promise<void> {
    await createStartupModelApplier(this.cliArgs.model)(this.currentConfig());
  }

  /**
   * init 帧的 model 用展示名：会话快照只带内部 key，装配期查成展示名；
   * 查询失败或自定义 provider 模型保留内部 key。
   */
  private async recordModelDisplayName(): Promise<void> {
    const output = this.streamJsonOutput;
    if (output === undefined) return;
    const config = this.currentConfig();
    const modelKey = config.getModel() || 'auto';
    try {
      const model = await config.getModelProviderManager().getModel(modelKey);
      if (model?.displayName) {
        output.recordModelDisplayName(modelKey, model.displayName);
      }
    } catch (error) {
      runLogger.debug('[headless] resolve model display name failed', {
        sessionId: this.sessionId,
        modelKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 恢复会话的 transcript 是否可追加；不可写时在 init 帧与任何 turn 之前抛出。
   */
  private async assertResumeTranscriptWritable(
    filePath: string | undefined,
  ): Promise<void> {
    if (filePath === undefined) return;
    if (!this.currentConfig().getSessionPersistence()) return;
    const handle = await open(filePath, 'a');
    await handle.close();
  }

  private resolveWorktreeStartupRequest(): WorktreeStartupRequest | undefined {
    if (this.params.inheritedWorktreeRequest) {
      return this.params.inheritedWorktreeRequest;
    }
    const name = this.params.cliArgs.worktree;
    if (name === undefined) return undefined;
    return {
      kind: 'create',
      name,
      originalCwd: this.params.workspaceRoot,
    };
  }

  private async applyResumeAndWorktreeState(
    resumed: SessionResumeData | undefined,
    worktreeStartupRequest: WorktreeStartupRequest | undefined,
  ): Promise<void> {
    const session = this.manager.requireSession(this.sessionId);
    const config = session.requireConfig();
    if (resumed) {
      restoreRuntimeConfigFromResumeData(config, resumed);
    }
    if (!resumed?.worktreeSession && !worktreeStartupRequest) {
      return;
    }
    // transcript writer 与 runtime binding 由 runner 建立；worktree 恢复需要它们。
    await session.getQueryRunner();
    if (resumed) {
      await applyResumeWorktreeState(
        config,
        resumed.worktreeSession,
        config.recordWorktreeState.bind(config),
      );
    }
    if (worktreeStartupRequest) {
      await applyWorktreeStartupRequest(config, worktreeStartupRequest, {
        record: config.recordWorktreeState.bind(config),
      });
    }
  }

  /** 进程内 initialize：没有 wire 握手，直接完成会话装配。 */
  private async initializeSession(): Promise<void> {
    const session = this.manager.requireSession(this.sessionId);
    const result = await this.manager.initialize(
      this.callContext(session.signal),
      this.sessionId,
      this.params.cliArgs.includePartialMessages
        ? { includePartialMessages: true }
        : {},
    );
    await result.afterResponseSent();
    await this.persistInitialTitle();
    this.pendingFork = undefined;
  }

  private async persistInitialTitle(): Promise<void> {
    const title = this.params.cliArgs.name;
    if (!title) return;
    try {
      await this.currentConfig().persistSessionTitle(title);
    } catch (error) {
      runLogger.warn('[headless] persist initial session title failed', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private callContext(signal: AbortSignal): ThreadCallContext {
    if (!this.host) {
      throw new Error('headless session host is not initialized');
    }
    return { signal, host: this.host };
  }

  protected async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const sessionId = this.openedSessionId;
    let writersDrained = sessionId === undefined;
    if (sessionId) {
      try {
        await this.manager.close(sessionId);
      } catch (error) {
        runLogger.warn('[headless] close session failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await this.manager.shutdown();
      writersDrained = true;
    } catch (error) {
      runLogger.warn('[headless] shutdown manager failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const fork = this.pendingFork;
    this.pendingFork = undefined;
    if (fork && !writersDrained) {
      runLogger.warn('[headless] preserving fork after incomplete shutdown', {
        sessionId: fork.sessionId,
      });
      return;
    }
    if (fork) {
      const store = new TranscriptStore();
      try {
        await new ForkSessionService(store).deleteForkArtifacts(fork);
      } catch (error) {
        runLogger.warn('[headless] rollback fork failed', {
          sessionId: fork.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await store.close();
      }
    }
  }

  /** Product metadata is added at the output boundary. */
  protected decorateInitMessage(
    _message: SDKSystemMessage,
    _version: string,
  ): void {}

  /** Product layers reject legacy SDK worker entrypoints here; the base ignores them. */
  protected validateCompatibility(): void {}

  /** Print sessions use the branded wait override, or the default bounded shutdown. */
  protected backgroundWindDownPolicy(): BackgroundWindDownPolicy {
    return readPrintBackgroundWindDownPolicy();
  }

  private startPermissionConnection(): void {
    const input = new PassThrough();
    if (!process.stdin.readableEnded) {
      process.stdin.pipe(input);
    }
    this.permissionChannel = new StdioPermissionChannel(
      input,
      createWorkingStdio().stdout,
      this.sessionId,
    );
  }

  /** Framework 用它把 Manager 的 createHost 接到会话上。 */
  createThreadHost(): ThreadHost {
    if (this.host) return this.host;
    const permissionPromptTool = this.params.cliArgs.permissionPromptTool;
    const namedPermissionPromptTool =
      permissionPromptTool && !isStdioPermissionPromptTool(permissionPromptTool)
        ? permissionPromptTool
        : undefined;
    const events: ThreadEventSink = {
      emit: (event: ThreadEvent) => {
        if (event.kind === 'threadMessage') {
          this.toolFailureLog.observe(event.message);
        }
        this.streamJsonOutput?.handle(event);
        if (event.kind === 'threadMessage' && event.message.type === 'result') {
          this.resolveTurn(event.message);
          return;
        }
        if (event.kind === 'turnFailed') {
          // text 输出对落盘失败是双通道：stdout 出合成 result，stderr 另打一条
          // critical error；json / stream-json 只有 result。
          if (
            this.streamJsonOutput === undefined &&
            this.resultMode === 'text' &&
            isFilesystemError(event.error)
          ) {
            this.writeCriticalErrorToStderr(event.error);
          }
          const failure = buildTurnFailureResult(
            this.sessionId,
            event.error,
          ) as unknown as SDKMessage;
          this.streamJsonOutput?.writeMessage(failure);
          this.resolveTurn(failure);
        }
      },
    };
    const requests: ThreadHostRequests = {
      // 没有提示工具时不给回调：会话按「没人可问」走 hook-only 串行裁决，而不是拿到
      // 一个立刻 deny 的回调，把 PermissionRequest hook 的 allow 裁决抢掉。
      canUseTool: namedPermissionPromptTool
        ? createNamedToolAskHandler({
            getConfig: () => this.currentConfig(),
            permissionPromptToolName: namedPermissionPromptTool,
          })
        : isStdioPermissionPromptTool(permissionPromptTool)
          ? (request, options) => this.askOverControlChannel(request, options)
          : undefined,
      permissionPromptChannel:
        namedPermissionPromptTool === undefined
          ? 'stdio_control'
          : 'named_tool',
      hiddenToolName: namedPermissionPromptTool,
      elicit: async () => ({ action: 'cancel' }),
      runHookCallback: async () => {
        throw new Error('Hook callbacks are not available in headless mode.');
      },
      getModelPolicy: async () => {
        throw new Error('Model policy is not available in headless mode.');
      },
      resolveSessionArtifacts: async () => null,
      // 内核原始错误：text 输出对落盘失败额外打 stderr critical error。
      reportQueryError: (error) => {
        if (
          this.streamJsonOutput === undefined &&
          this.resultMode === 'text' &&
          isFilesystemError(error)
        ) {
          this.writeCriticalErrorToStderr(error);
        }
      },
      sendMcpMessage: async () => {
        throw new Error('SDK MCP is not available in headless mode.');
      },
      shouldGenerateMemory: async () => false,
      shouldReviewSkillEvolution: async () => false,
    };
    this.host = { events, requests };
    return this.host;
  }

  private async askOverControlChannel(
    request: ThreadCanUseToolRequest,
    options?: ThreadReverseRequestOptions,
  ): Promise<ThreadCanUseToolDecision> {
    if (!this.permissionChannel) {
      return {
        behavior: 'deny',
        message: 'Permission channel is not available.',
        interrupt: false,
      };
    }
    const result = await this.permissionChannel.requestCanUseTool(request, {
      signal: options?.signal,
    });
    applyUpdatedPermissions(this.currentConfig(), result.updatedPermissions);
    return result.decision;
  }

  /**
   * 文本输入的一轮：空 prompt 只记运行日志、stderr 保持干净、退出码 42；
   * /plan 按固定文案拒绝。
   */
  private async runTextTurn(): Promise<void> {
    const prompt = this.composeTextInput();
    if (prompt.length === 0) {
      runLogger.error(
        `No input provided via stdin. Input can be provided by piping data into ${BRAND_CLI_BIN} or using -p/--print with a positional prompt.`,
      );
      process.exitCode = ExitCodes.FATAL_INPUT_ERROR;
      return;
    }
    await this.initializeSession();
    if (isPlanCommand(prompt)) {
      this.emitPlanRejection();
      return;
    }
    const result = await this.submitTurn(prompt);
    this.renderResult(result);
  }

  private emitPlanRejection(): void {
    const failure = buildErrorResultMessage(this.sessionId, {
      errors: [PLAN_MODE_UNAVAILABLE_MESSAGE],
      errorCode: 500,
    }) as unknown as SDKMessage;
    if (this.streamJsonOutput) {
      this.streamJsonOutput.writeMessage(failure);
      setStreamJsonResultExitCode(failure);
      return;
    }
    this.renderResult(failure);
  }

  private async runStreamJsonInput(): Promise<void> {
    const reader = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    let initialized = false;
    let lineNumber = 0;
    try {
      for await (const line of reader) {
        lineNumber += 1;
        if (line.trim().length === 0) continue;
        const parsed = this.tryParseStreamJsonLine(
          line.trim(),
          lineNumber,
          line.length,
        );
        // 坏帧：已发出唯一失败结果，停止读取。
        if (parsed === undefined) return;
        // 非 user 类型静默跳过（不报错、不建会话）。
        if (parsed === null || parsed['type'] !== 'user') continue;
        const prompt = this.tryParseUserPrompt(parsed);
        // 缺 content：同样静默跳过。
        if (prompt === undefined || prompt.length === 0) continue;
        // init 延迟到第一条有效用户消息之前，空输入/坏帧不会先发 init。
        if (!initialized) {
          await this.initializeSession();
          initialized = true;
        }
        if (isPlanCommand(typeof prompt === 'string' ? prompt : prompt.filter(block => block.type === 'text').map(block => block.text).join(''))) {
          this.emitPlanRejection();
          continue;
        }
        await this.submitTurn(prompt);
      }
    } finally {
      reader.close();
    }
  }

  /**
   * 坏帧以单帧 result（`API Error: invalid_stream_json…`）收尾，rc=1，不先发 init。
   */
  private tryParseStreamJsonLine(
    line: string,
    lineNumber: number,
    charCount: number,
  ): Record<string, unknown> | null | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const error = new Error(
        `invalid_stream_json: stream-json input line ${lineNumber} (${charCount} chars)`,
      );
      this.emitStreamJsonInputFailure(error);
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  }

  private emitStreamJsonInputFailure(error: Error): void {
    const failure = buildErrorResultMessage(this.sessionId, {
      error,
      errors: [formatResultErrorMessage(error)],
    }) as unknown as SDKMessage;
    if (this.streamJsonOutput) {
      this.streamJsonOutput.writeMessage(failure);
      setStreamJsonResultExitCode(failure);
      return;
    }
    this.renderResult(failure);
  }

  private tryParseUserPrompt(
    message: Record<string, unknown>,
  ): string | ThreadUserMessage['message']['content'] | undefined {
    const body = message['message'] as
      | { content?: unknown }
      | null
      | undefined;
    const content = body?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content) && content.length > 0) {
      // Keep structured blocks for the shared input pipeline (including images).
      // Legacy string entries remain accepted as text blocks.
      const blocks = content.map((block) => {
        if (typeof block === 'string') return { type: 'text' as const, text: block };
        const parsed = parseSdkInputBlock(block);
        if (parsed) return parsed;
        throw new FatalInputError('Invalid stream-json user content block');
      });
      if (blocks.some((block) => block.type !== 'text' || block.text)) {
        return blocks;
      }
    }
    return undefined;
  }

  private beginTurn(): TurnWaiter {
    if (this.turnWaiter) {
      throw new Error('A headless turn is already in progress.');
    }
    let resolve!: (message: SDKMessage) => void;
    const promise = new Promise<SDKMessage>((done) => {
      resolve = done;
    });
    const waiter = { promise, resolve };
    this.turnWaiter = waiter;
    return waiter;
  }

  private resolveTurn(message: SDKMessage): void {
    this.toolFailureLog.clearTurn();
    const waiter = this.turnWaiter;
    this.turnWaiter = undefined;
    waiter?.resolve(message);
  }

  private async submitTurn(
    prompt: string | ThreadUserMessage['message']['content'],
  ): Promise<SDKMessage> {
    if (prompt.length === 0) {
      throw new FatalInputError(
        `No input provided via stdin. Input can be provided by piping data into ${BRAND_CLI_BIN} or using -p/--print with a positional prompt.`,
      );
    }
    const waiter = this.beginTurn();
    const manager = this.manager;
    const session = manager.requireSession(this.sessionId);
    const message: ThreadUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content:
          typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: randomUUID(),
    };
    await manager.submitMessage(
      this.callContext(session.signal),
      this.sessionId,
      message,
    );
    return waiter.promise;
  }

  private renderResult(result: SDKMessage): void {
    if (this.streamJsonOutput) {
      setStreamJsonResultExitCode(result);
      return;
    }
    const output = createWorkingStdio().stdout;
    if (this.resultMode === 'json') {
      output.write(ndjsonSafeStringify(result) + '\n');
      setStreamJsonResultExitCode(result);
      return;
    }
    writeHeadlessTextResult(
      result as Extract<SDKMessage, { type: 'result' }>,
      output,
    );
  }

  /**
   * 启动失败（如非法 -m）的终态结果：三种输出格式都要让消费者拿到 result 帧与
   * rc=1，不能只留 stderr / 空 stdout。stream-json 的帧出口不经 renderResult，
   * 这里显式写一帧。
   */
  private renderStartupFailure(error: unknown): void {
    const failure = buildTurnFailureResult(
      this.sessionId,
      error,
    ) as unknown as SDKMessage;
    if (this.streamJsonOutput) {
      this.streamJsonOutput.writeMessage(failure);
      setStreamJsonResultExitCode(failure);
      return;
    }
    this.renderResult(failure);
  }

  private writeCriticalErrorToStderr(error: unknown): void {
    writeToStderr('An unexpected critical error occurred:');
    writeToStderr(
      (error instanceof Error ? error.stack : String(error)) + '\n',
    );
  }

  /**
   * stream-json 的会话级失败终态：单帧 result，错误文案走旧映射（EPERM 等映射成
   * 权限提示），`error_code` 取结构化错误码。不补 init/artifacts/hook 帧。
   */
  private renderSessionFailure(error: unknown): void {
    const failure = buildErrorResultMessage(this.sessionId, {
      error,
      errors: [formatResultErrorMessage(error)],
      errorCode: getResultErrorCode(error),
    }) as unknown as SDKMessage;
    this.streamJsonOutput?.writeMessage(failure);
    setStreamJsonResultExitCode(failure);
  }

  private installStdoutErrorHandler(): void {
    const handler = (error: Error) => {
      runLogger.warn('[headless] stdout stream failed', {
        sessionId: this.sessionId,
        errorName: error.name,
      });
      process.exitCode = 0;
      this.permissionChannel?.close();
    };
    this.stdoutErrorHandler = handler;
    process.stdout.on('error', handler);
  }

  private removeStdoutErrorHandler(): void {
    if (!this.stdoutErrorHandler) return;
    process.stdout.removeListener('error', this.stdoutErrorHandler);
    this.stdoutErrorHandler = undefined;
  }
}
