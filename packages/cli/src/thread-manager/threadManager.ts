/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCliSettingsService } from '../config/createCliSettingsService.js';

/**
 * 进程内会话承接方：注册表、生命周期、能力路由与磁盘仓库。具体类，不持有协议知识。
 *
 * 不变量：每个会话的终止恰好上报一次；装配期间的终止不会丢，也不会抢在 opened 之前；
 * 同一 sessionId 同时只有一个在世会话。
 */

import {
  beginStartupStep,
  clearStartupMilestones,
  markStartupMilestone,
  runLogger,
  raceWithAbortSignal,
  ResumeReadError,
  type ResumeTranscriptResult,
  type BuiltinPluginContributions,
  type FileSystemService,
  type LoadedPlugin,
  type MCPServerConfig,
} from '@qwen-code/core';
import * as path from 'node:path';
import { sessionManager, type Session } from '@qwen-code/core/sessions';
import type {
  ThreadCallContext,
  ThreadHost,
  ThreadTerminationReason,
} from './thread-session/contract/hostContext.js';
import type {
  ThreadInitializeResult,
  ThreadAddDirectoriesResult,
  ThreadAppliedFlagSettings,
  ThreadGoalResult,
  ThreadInterruptResult,
  ThreadPlanModeResult,
  ThreadProxyResult,
  ThreadSessionTitleResult,
  ThreadSideQuestionResult,
  ThreadTaskResult,
  ThreadRewindResult,
  ThreadSessionDeclarations,
  ThreadSubmission,
  ThreadUserMessage,
} from './thread-session/contract/threadSessionTypes.js';
import type { ThreadResumeData } from './thread-session/contract/threadResumeData.js';
import type { ThreadForkRequest } from './thread-session/contract/threadOpenRequest.js';
import type { ThreadSession } from './thread-session/threadSession.js';
import { SessionPhaseLog } from './thread-session/phase-log/sessionPhaseLog.js';
import type { CliArgs } from '../config/config.js';
import { randomUUID } from 'node:crypto';
import {
  ResourceService,
  type BackgroundWindDownPolicy,
  type ConfigParameters,
  type ModelTransportManager,
  type CustomProviderManager,
  type McpManager,
} from '@qwen-code/core';
import type { SettingsService } from '@qwen-code/resource';
import { ThreadSessionAlreadyOpenError } from './sessionAlreadyOpenError.js';
import {
  createForkTranscript,
  rollbackForkTranscript,
  toThreadResumeData,
  type CreatedForkTranscript,
} from './open/createForkTranscript.js';

/**
 * open 请求只携带产品数据；wire 键翻译由宿主完成。
 * fork / resume 的会话创建动作归 Manager：目标副本、checkpoint 复制与 SessionState
 * 都在 `start()` 内完成，Manager 不解析 argv。
 */
/** close 回包前等 transcript 尾部落盘的上界；超时只告警，不改变 close 成功语义。 */
const TRANSCRIPT_FLUSH_CLOSE_WAIT_MS = 5_000;

export interface ThreadOpenRequest {
  readonly businessType?: string;
  /**
   * 宿主声明的会话 id。缺席时由 Manager 派生：
   * - fork：mint 新 id（绝不使用源 id）；
   * - plain resume：沿用 `cliArgs.resume`（续用源身份）；
   * - 新会话：mint 新 id。
   */
  readonly sessionId?: string;
  /**
   * 会话工作目录，**必填**。daemon 不持有 cwd 概念，进程目录不是任何会话的缺省
   * 工作目录；目录只能由发起方（open_session 帧）逐会话声明。
   */
  readonly cwd: string;
  readonly cliArgs: CliArgs;
  /**
   * 会话所属的产品启动面。影响 `customProviderAccessMode` 等产品分支，不改变会话
   * 能力本身；缺省按 SDK（既有嵌入方）。
   */
  readonly startupMode?: 'sdk' | 'acp' | 'headless';
  /**
   * 会话关闭时等待后台任务的策略。由宿主按入口形态注入；缺省用 core 的
   * `DEFAULT_BACKGROUND_WIND_DOWN_POLICY`。
   */
  readonly backgroundWindDownPolicy?: BackgroundWindDownPolicy;
  /**
   * 宿主已经确立的认证类型。ACP 的 IDE 登录/PAT 与环境凭据可能不写回 settings 的
   * `selectedType`，由宿主显式声明；缺省仍从会话 settings 推导。
   */
  readonly authType?: import('@qwen-code/core').AuthType;
  /** plain resume 的 transcript；fork 与新会话缺席。 */
  readonly resumeTranscriptPath?: string;
  /**
   * 入口已经创建好 fork 副本（headless 的 resume 前置链），Manager 不再重复 fork，
   * 直接使用前置链生成的 resumeData 装配。
   */
  readonly forked?: boolean;
  /** Already-created fork data; avoids reading the target transcript again. */
  readonly resumeData?: ThreadResumeData;
  /** 同进程普通恢复候选，不进入任何宿主协议，且与 fork 互斥。 */
  readonly resumeCandidate?: ResumeTranscriptResult;
  /** 宿主随会话打开声明的动态 MCP server，在 `config.initialize()` 前注入。 */
  readonly dynamicMcpServers?: Record<string, MCPServerConfig>;
  /** 宿主文件系统包装；ACP 用它把读写转给客户端。 */
  readonly fileSystemServiceFactory?: (
    config: import('@qwen-code/core').Config,
    fallback: FileSystemService,
  ) => FileSystemService;
  /**
   * fork 意图。宿主只做 argv / 存储布局翻译；读源、写目标、复制 checkpoint、
   * 建 SessionState 与失败回滚都由 `start()` 执行。
   */
  readonly fork?: ThreadForkRequest;
  /**
   * 阶段耗时日志的起点实例。由 open_session 在**受理帧的那一刻**创建并传进来，
   * 于是汇总表的「自受理起」覆盖的是接入方看到的整段 `run → session`，而不是从
   * ThreadSession 构造才起算（那会漏掉 open_session 的参数翻译与 transcript 探测）。
   * 可选：Manager 也被非 SDK 入口使用，那些入口不创建它，会话自己兜底建一个。
   */
  readonly phaseLog?: SessionPhaseLog;
}

export interface ThreadManagerParams {
  readonly pluginManagerFactory?: import('@qwen-code/core').PluginManagerFactory;
  /**
   * 逐会话建宿主通道。出站事件与八个反向请求都在里面，因此**它就是 Manager 的出站口**——
   * 不需要再单独注入一个 transport：宿主实现 `events.emit` 时自己决定怎么装帧、写到哪。
   */
  readonly createHost?: (sessionId: string) => ThreadHost;
  /**
   * 进程级 ResourceService。daemon（SDKServer）把 root Config 已持有的那一份传进来，使会话面
   * 与 root Config 共用同一个 ResourceService；不传则退化为本类自建（非 daemon 的嵌入入口）。
   */
  readonly resourceService?: ResourceService;
  /** 注入时由宿主回收；未注入时本类自建并在 shutdown 回收。 */
  readonly settingsService?: SettingsService;
  /** 会话级 provider 工厂；沿装配链传给 Config，每个会话构造独立实例。 */
  readonly modelProviderFactory: NonNullable<ConfigParameters['modelProviderFactory']>;
  readonly permissionManager: import('@qwen-code/core').PermissionManager;
  /**
   * 进程级 transport 注册表（Framework 装配单例，构造期钉死）。
   * 新开 ThreadSession 建会话级 provider 时按协议取 transport 要用。
   */
  readonly modelTransportManager: ModelTransportManager;
  readonly customProviderManager?: CustomProviderManager;
  /** Process-level MCP pool owned by the application framework. */
  readonly mcpManager?: McpManager;
}

/** 生命周期事件。中立词汇，翻译成上游形状是消费方的事。 */
export type ThreadManagerEvent =
  | { type: 'sessionStarted'; sessionId: string }
  | {
      type: 'sessionTerminated';
      sessionId: string;
      termination: ThreadTerminationReason;
    }
  | { type: 'sessionOpened'; sessionId: string }
  | {
      type: 'sessionClosed';
      sessionId: string;
      /** 被关闭的是哪一代（每次 open 自增，区分同 ID 的新旧两代）。 */
      generation: number;
    }
  | { type: 'sessionDeleted'; sessionId: string; deleted: boolean }
  | { type: 'sessionRenamed'; sessionId: string; title: string };

/** active：绑定当前信道的会话；generation 每次 open 自增。 */
interface ActiveEntry {
  readonly session: ThreadSession;
  readonly generation: number;
}

/** retiring：信道已关、后台任务还在跑的旧会话。 */
interface RetiringEntry {
  readonly session: ThreadSession;
  readonly generation: number;
  /** 唯一会挡住新 open 的东西：旧 writer 内存尾部落盘。 */
  readonly transcriptFlushed: Promise<void>;
  /** drain → dispose → 资源释放；open 绝不等它。 */
  teardown: Promise<void>;
}

export type ThreadManagerObserver = (
  event: ThreadManagerEvent,
) => void | Promise<void>;

export class ThreadManager {
  private createHost?: (sessionId: string) => ThreadHost;
  private resolveHost!: () => void;
  private rejectHost!: (error: Error) => void;
  private readonly hostProvided = new Promise<void>((resolve, reject) => {
    this.resolveHost = resolve;
    this.rejectHost = reject;
  });
  private initialization?: Promise<void>;
  private ready = false;
  private builtinPlugins?: BuiltinPluginContributions;

  /** 对象先存在，握手只提交宿主能力，不负责创建或补启动 Manager。 */
  provideHost(input: { createHost: (sessionId: string) => ThreadHost }): void {
    if (this.shutdownPromise) throw new Error('ThreadManager is shut down');
    this.createHost ??= input.createHost;
    this.resolveHost();
  }

  initializeRuntime(input: {
    builtinPlugins?: BuiltinPluginContributions;
    signal: AbortSignal;
  }): Promise<void> {
    this.initialization ??= (async () => {
      const done = beginStartupStep('thread_manager.initialize_runtime');
      const hostWaitDone = beginStartupStep(
        'thread_manager.initialize_runtime.wait_host',
      );
      try {
        try {
          await raceWithAbortSignal(this.hostProvided, input.signal);
        } finally {
          hostWaitDone();
        }
        input.signal.throwIfAborted();
        if (this.shutdownPromise) throw new Error('ThreadManager is shut down');
        createCliSettingsService({
          service: this.settingsService,
          environmentPolicy: 'session',
        });
        this.builtinPlugins = input.builtinPlugins;
        this.ready = true;
      } finally {
        done();
      }
    })();
    void this.initialization.catch(() => {});
    return this.initialization;
  }
  /** 已启动的会话（active：绑定当前信道）。 */
  private readonly sessions = new Map<string, ActiveEntry>();
  /**
   * 信道已关、后台任务还在跑的旧会话。同一个 sessionId 允许 1 个 active + N 个
   * retiring；open 只等最近一代的 transcriptFlushed，绝不等 teardown。
   */
  private readonly retiring = new Map<string, Set<RetiringEntry>>();
  /** 每个 sessionId 最近一次的 generation；每次 open 自增。 */
  private readonly lastGeneration = new Map<string, number>();
  /** 装配中的会话：同 id 的第二次 open 直接拒绝，不会装两遍。 */
  private readonly opening = new Map<string, Promise<ThreadSession>>();
  /** 收尾中的会话：并发 close 只跑一次收尾。 */
  private readonly closing = new Map<string, Promise<void>>();
  /**
   * daemon 级全局代理。`undefined` = 从未设置（不覆盖会话自身 argv 的值）；
   * `null` = 显式清除。设置后同步到在世会话，并在之后每次 open 装配完成后继承。
   */
  private daemonProxy: string | null | undefined;
  /** 关停是终态；并发调用共用会话收尾与共享资源回收的结果。 */
  private shutdownPromise: Promise<void> | undefined;
  private readonly observers = new Set<ThreadManagerObserver>();
  /**
   * 借用 Framework 注入的共享资源，随会话传递，不负责关闭。
   * 独立嵌入且未注入时才自建，并在 manager 关闭时回收。
   */
  private readonly resourceService: ResourceService;
  private readonly settingsService: SettingsService;

  constructor(private readonly params: ThreadManagerParams) {
    this.resourceService = params.resourceService ?? new ResourceService();
    this.settingsService =
      params.settingsService ??
      createCliSettingsService({ environmentPolicy: 'session' });
    void this.hostProvided.catch(() => {});
    // 直接嵌入也显式 initialize；构造时提供的 host 只满足输入条件。
    if (params.createHost) this.provideHost({ createHost: params.createHost });
  }

  // ===========================================================================
  // 注册表与生命周期
  // ===========================================================================

  subscribe(observer: ThreadManagerObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /**
   * 打开一个会话，返回其 sessionId。装配抛错则 open 失败、不留表项。
   *
   * opening / active 的 id 不再幂等复用：第二个请求直接回 `SESSION_ALREADY_OPEN`
   * （带状态）。close 之后的顺序重开不走这里的分支——close 已把会话移出 active，
   * open 会等 retiring 的 transcriptFlushed 后新建。
   */
  async open(request: ThreadOpenRequest): Promise<string> {
    if (!this.ready && this.initialization) {
      await (request.resumeCandidate
        ? raceWithAbortSignal(
            this.initialization,
            request.resumeCandidate.attempt.signal,
          )
        : this.initialization);
    }
    if (this.shutdownPromise) {
      throw new Error('ThreadManager is shut down');
    }
    const sessionId = this.resolveOpenSessionId(request);
    // 声明 id 的入口（SDKServer）从受理帧就带着 phaseLog；由 Manager mint id 的入口
    // 在这里补建，fork 的耗时仍然落在「从 open 受理起」的同一张表里。
    const phaseLog = request.phaseLog ?? new SessionPhaseLog(sessionId);
    if (!this.ready && this.initialization) {
      const initialization = this.initialization;
      await phaseLog.phase(
        'ThreadManager 初始化',
        'daemon 级会话运行时初始化：共享资源、插件与宿主能力就绪',
        () => initialization,
      );
    }
    if (!this.ready) throw new Error('ThreadManager is not initialized');
    if (this.opening.has(sessionId)) {
      runLogger.log('[thread-manager] session already opening', { sessionId });
      throw new ThreadSessionAlreadyOpenError(sessionId, 'opening');
    }
    if (this.sessions.has(sessionId)) {
      runLogger.log('[thread-manager] session already open', { sessionId });
      throw new ThreadSessionAlreadyOpenError(sessionId, 'active');
    }

    this.validateResumeCandidate(request, sessionId);
    const candidate = request.resumeCandidate;
    // 此点之后所有失败均由 Manager / ThreadSession 收尾，不能靠 open 最终是否成功推断。
    let pending: Promise<ThreadSession>;
    try {
      pending = candidate
        ? candidate.attempt.run(() =>
            this.startWithBarrier(request, sessionId, phaseLog),
          )
        : this.startWithBarrier(request, sessionId, phaseLog);
    } catch (error) {
      await candidate?.attempt.finish();
      throw error;
    }
    pending = pending.catch(async (error: unknown) => {
      await candidate?.attempt.finish();
      throw error;
    });
    this.opening.set(sessionId, pending);
    // 整条链路的入口。cwd 与 resume 意图必须在这里留痕：后续任何一步失败，
    // 都要能回答「当初是按什么参数开的」。resume 只记有无与路径，不记内容。
    runLogger.log('[thread-manager] opening session', {
      sessionId,
      cwd: request.cwd,
      resuming:
        request.resumeTranscriptPath !== undefined ||
        request.fork !== undefined,
      fork: request.fork !== undefined,
      ...(request.fork === undefined
        ? {}
        : { sourceSessionId: request.fork.sourceSessionId }),
      ...(request.fork !== undefined || request.cliArgs.resume === undefined
        ? {}
        : { sourceSessionId: request.cliArgs.resume }),
    });
    let session: ThreadSession;
    try {
      session = await pending;
    } finally {
      this.opening.delete(sessionId);
    }
    // open 的外层 run() 已收尾，此时归还恢复读取名额；空闲期不再占用或受 60s 时限约束。
    session.releaseResumeLease();

    const generation = (this.lastGeneration.get(sessionId) ?? 0) + 1;
    this.lastGeneration.set(sessionId, generation);
    this.sessions.set(sessionId, { session, generation });
    markStartupMilestone('session_opened', sessionId, {
      resuming:
        request.resumeTranscriptPath !== undefined ||
        request.fork !== undefined,
    });
    // 推理就绪在会话 initialize 时才跑，这里写入的 Config proxy 会先于它生效。
    if (this.daemonProxy !== undefined) {
      session.applyDaemonProxy(this.daemonProxy ?? undefined);
    }
    this.notifyObservers({ type: 'sessionStarted', sessionId });
    this.notifyObservers({ type: 'sessionOpened', sessionId });
    // attach 排在 sessionOpened 之后：会话可能在装配期间就已自行终止，先 attach 会让
    // sessionTerminated 抢在 sessionOpened 前面到观察者手上，而上游按这两个事件维护会话
    // 列表，顺序反了等于先删一个还没加进来的会话。推迟不丢事件——已 resolve 的 promise
    // 事后 attach 照样触发。
    void session.termination.then((termination) => {
      this.retire(sessionId, session, termination);
    });
    return sessionId;
  }

  /**
   * 会话 id 的最终决定权在 Manager：宿主显式声明就用它；fork 必须 mint 新 id，
   * 绝不能落到源 id；plain resume 续用源 id；新会话 mint。
   */
  private resolveOpenSessionId(request: ThreadOpenRequest): string {
    if (request.sessionId !== undefined) return request.sessionId;
    if (request.fork) return randomUUID();
    return request.cliArgs.resume ?? randomUUID();
  }

  /**
   * open 的唯一串行点：若同 ID 有 retiring 的旧会话，等**最近一代**的 transcriptFlushed
   * 再建新会话。旧 writer 内存里可能还有未落盘的尾部，新会话 resume 从磁盘读 transcript，
   * 先读后写会缺尾巴；teardown（memory / evolution / autoDream）不在这里等。
   */
  private async startWithBarrier(
    request: ThreadOpenRequest,
    sessionId: string,
    phaseLog: SessionPhaseLog,
  ): Promise<ThreadSession> {
    const retiringForId = this.retiring.get(sessionId);
    if (retiringForId && retiringForId.size > 0) {
      const latest = [...retiringForId].reduce((a, b) =>
        a.generation >= b.generation ? a : b,
      );
      await phaseLog.phase(
        '等待旧会话收尾',
        '同 id 上一代会话的 transcript flush',
        () =>
          request.resumeCandidate
            ? raceWithAbortSignal(
                latest.transcriptFlushed.catch(() => undefined),
                request.resumeCandidate.attempt.signal,
              )
            : latest.transcriptFlushed.catch(() => undefined),
      );
    }
    return this.start(request, sessionId, phaseLog);
  }

  /**
   * 关闭会话：只封信道并把会话移入 retiring，后台排干 teardown；
   * close 回包不等待记忆、evolution 等后台任务。
   */
  async close(sessionId: string): Promise<void> {
    const existingClose = this.closing.get(sessionId);
    if (existingClose) return existingClose;
    const opening = this.opening.get(sessionId);
    const activeEntry = this.sessions.get(sessionId);
    if (!opening && !activeEntry) {
      runLogger.log('[thread-manager] session already closed', { sessionId });
      return;
    }

    // 先登记 Promise 再执行收尾，让 shutdown 也能等到已在途的 close。
    const closing = Promise.resolve().then(async () => {
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        const opened = opening ? await opening.catch(() => undefined) : undefined;
        if (!opened) return;
      }
      const current = this.sessions.get(sessionId);
      if (!current) return;
      const { session, generation } = current;
      // 1. 关信道：不 dispose、不退订 turnReview。失败也不阻断退休流程。
      let transcriptFlushed: Promise<void> = Promise.resolve();
      try {
        ({ transcriptFlushed } = await session.closeChannel());
      } catch (error) {
        runLogger.warn('[thread-manager] closeChannel failed, retiring anyway', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // 2. active → retiring（teardown 之前必须落位，open 的屏障读这里）。
      if (this.sessions.get(sessionId) === current) {
        this.sessions.delete(sessionId);
        clearStartupMilestones(sessionId);
      }
      const retiringForId = this.retiring.get(sessionId) ?? new Set<RetiringEntry>();
      this.retiring.set(sessionId, retiringForId);
      const retiringEntry: RetiringEntry = {
        session,
        generation,
        transcriptFlushed,
        teardown: Promise.resolve(),
      };
      retiringForId.add(retiringEntry);
      runLogger.log('[thread-manager] session channel closed, retiring', {
        sessionId,
        generation,
      });
// close 回包前有界等待 transcript 尾部落盘；超时只告警，retiring 保留原 promise。
      const flushSettled = await Promise.race([
        transcriptFlushed.then(() => 'flushed' as const),
        new Promise<'timeout'>((resolveTimeout) => {
          const timer = setTimeout(
            () => resolveTimeout('timeout'),
            TRANSCRIPT_FLUSH_CLOSE_WAIT_MS,
          );
          timer.unref?.();
        }),
      ]);
      if (flushSettled === 'timeout') {
        runLogger.warn('[thread-manager] transcript flush did not settle before close wait bound', {
          sessionId,
          generation,
          waitMs: TRANSCRIPT_FLUSH_CLOSE_WAIT_MS,
        });
      }
      // 4. 后台 teardown：不 await。排干后台管线 → dispose 旧 Config 与其余资源。
      retiringEntry.teardown = Promise.resolve()
        .then(() => session.retire())
        .catch((error: unknown) => {
          runLogger.warn('[thread-manager] retiring teardown failed', {
            sessionId,
            generation,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          retiringForId.delete(retiringEntry);
          if (retiringForId.size === 0) this.retiring.delete(sessionId);
          this.notifyObservers({
            type: 'sessionClosed',
            sessionId,
            generation,
          });
        });
    }).finally(() => {
      this.closing.delete(sessionId);
    });
    this.closing.set(sessionId, closing);
    return closing;
  }

  /** 等某个 sessionId 的全部 retiring 代排干（delete_session 删盘前必须先做）。 */
  private async drainRetiring(sessionId: string): Promise<void> {
    const entries = this.retiring.get(sessionId);
    if (!entries || entries.size === 0) return;
    await Promise.allSettled([...entries].map((entry) => entry.teardown));
  }

  shutdown(): Promise<void> {
    this.rejectHost(new Error('ThreadManager is shut down'));
    // 同步封住 open；微任务内再收会话，避免收尾回调在登记终态前重入。
    this.shutdownPromise ??= Promise.resolve().then(async () => {
      const sessionIds = [
        ...new Set([
          ...this.sessions.keys(),
          ...this.opening.keys(),
          ...this.closing.keys(),
        ]),
      ];
      // daemon 关停是整条链路的终点，收了几个会话必须留痕：否则「会话怎么都没了」
      // 分不清是被 shutdown 收掉、还是各自 close、还是进程被打死。
      runLogger.log('[thread-manager] shutdown', {
        sessionCount: sessionIds.length,
        sessionIds,
      });
      const results = await Promise.allSettled(
        sessionIds.map((sessionId) => this.close(sessionId)),
      );
      // close 只关信道；退休收尾（Config dispose / 后台写盘）必须等干净再回收共享资源。
      await Promise.allSettled(
        [...this.retiring.keys()].map((id) => this.drainRetiring(id)),
      );
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      // 全部会话的释放尝试完成后，最后回收共享资源；任何失败都必须报告。
      // ResourceService 和 SettingsService 都只回收自建实例，注入实例由宿主回收。
      if (!this.params.resourceService) {
        try {
          await this.resourceService.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (!this.params.settingsService) {
        try {
          await this.settingsService.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) {
        throw new AggregateError(errors, 'ThreadManager shutdown failed');
      }
    });
    return this.shutdownPromise;
  }

  /**
   * daemon 级代理同步：记录给之后打开（或装配中）的会话，并立即写入所有在世会话的
   * Config。全局网络出口的重建由宿主在调用前完成。
   */
  setDaemonProxy(proxy: string | undefined): void {
    this.daemonProxy = proxy ?? null;
    for (const { session } of this.sessions.values()) {
      session.applyDaemonProxy(proxy);
    }
  }

  get(sessionId: string): ThreadSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * 路由原语：按 id 取会话，不存在则抛。
   *
   * 所有能力透传都经它，因此「未知会话」的错误语义只有一处。错误文本由宿主决定是否
   * 再翻译成上游的形状。
   */
  requireSession(sessionId: string): ThreadSession {
    const session = this.sessions.get(sessionId)?.session;
    if (!session) {
      // 抛错前把「当时到底有哪些会话」记下来：Unknown session 是联调最高频的错误，
      // 而错误文本里只有找不到的那个 id，没有可对照的现状——是 id 传错、会话已被
      // 关闭、还是压根没 open 成功，光看错误分不出来。带上活跃与装配中两份名单，
      // 一眼就能定位是哪一种。
      runLogger.warn('[thread-manager] unknown session requested', {
        sessionId,
        activeSessionIds: [...this.sessions.keys()],
        openingSessionIds: [...this.opening.keys()],
      });
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  /** 活着或正在装配都算活：宿主用它判 ready / inactive，装配中不该被当成已死。 */
  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.opening.has(sessionId);
  }

  /** 等待某 sessionId 的全部退休收尾（测试 / shutdown / delete 用）。 */
  waitForRetiring(sessionId: string): Promise<void> {
    return this.drainRetiring(sessionId);
  }

  getActiveSessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

/** 会话级 `list_plugins`：只列本会话 Config 已启用的插件，不聚合其他会话。 */
  listPlugins(
    _ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<readonly LoadedPlugin[]> {
    return Promise.resolve(this.requireSession(sessionId).getEnabledPlugins());
  }

// 磁盘会话仓库：列出、重命名、删除落盘 transcript，与运行时会话无关；
// 删除前先关闭活会话属于本类的编排职责。

/**
 * 列出磁盘会话。`projectDir` 缺省表示不过滤（全量扫盘），不退回落 daemon 进程目录。
 * 结果不缓存，保证刚落盘的会话可见。
 */
  async listSessions(projectDir?: string): Promise<readonly Session[]> {
    // projectDir 缺省与否是两条完全不同的语义（缺省=全盘扫描，不给目录过滤），
    // 联调时「为什么列出来这么多/这么少」第一个要分清的就是这个。
    const sessions =
      projectDir === undefined
        ? await sessionManager.listAll()
        : await sessionManager.list(projectDir);
    runLogger.log('[thread-manager] listSessions', {
      scoped: projectDir !== undefined,
      count: sessions.length,
    });
    return sessions;
  }

  async renameSession(
    projectDir: string,
    sessionId: string,
    title: string,
  ): Promise<Session> {
    const session = await sessionManager.rename(projectDir, sessionId, title);
    runLogger.log('[thread-manager] session renamed', { sessionId });
    this.notifyObservers({ type: 'sessionRenamed', sessionId, title });
    return session;
  }

  async deleteSession(projectDir: string, sessionId: string): Promise<boolean> {
    // 删记录之前先把活会话关掉：留着的话它会继续往一条已经不存在的记录上写 transcript。
    const wasLive = this.isLive(sessionId);
    if (wasLive) {
      await this.close(sessionId);
    }
    // close 只关信道：旧 writer / 后台任务可能还在写记录，删盘前必须等退休收尾。
    await this.drainRetiring(sessionId);
    const deleted = await sessionManager.delete(projectDir, sessionId);
    // deleted=false 是「记录本来就不在」，与「删失败」在调用方看是同一个 false，
    // 只有日志能分清；wasLive 说明这次删除顺带收掉了一个活会话。
    runLogger.log('[thread-manager] session deleted', {
      sessionId,
      deleted,
      wasLive,
    });
    this.notifyObservers({ type: 'sessionDeleted', sessionId, deleted });
    return deleted;
  }

  // 能力路由：一行透传给对应会话，不做校验或翻译。
  // 全部写成 async：未知会话的同步 throw 会变成 rejected promise，而不是逃出方法。

  async initialize(
    ctx: ThreadCallContext,
    sessionId: string,
    declarations: ThreadSessionDeclarations,
  ): Promise<ThreadInitializeResult> {
    return this.requireSession(sessionId).initialize(ctx, declarations);
  }

  async submitMessage(
    ctx: ThreadCallContext,
    sessionId: string,
    message: ThreadUserMessage,
  ): Promise<ThreadSubmission> {
    return this.requireSession(sessionId).submitMessage(ctx, message);
  }

  async interrupt(
    ctx: ThreadCallContext,
    sessionId: string,
    options?: { cancelQueued?: boolean },
  ): Promise<ThreadInterruptResult> {
    return this.requireSession(sessionId).interrupt(ctx, options);
  }

  async applyWorktreeStartupRequest(
    ctx: ThreadCallContext,
    sessionId: string,
    request: import('../utils/worktreeStartupRequest.js').WorktreeStartupRequest,
  ): Promise<void> {
    return this.requireSession(sessionId).applyWorktreeStartupRequest(request);
  }

  /**
   * 作废一条仍在排队的消息（wire 的 `cancel_async_message`）。会话侧是同步判定，
   * 这里仍声明 async 与其余路由方法同形：未知会话必须经 Promise 拒绝报出，而不是
   * 在返回 Promise 的签名里同步抛（那会让调用方的 catch 抓不到）。
   */
  async cancelQueuedMessage(
    sessionId: string,
    commandUuid: string,
  ): Promise<{ cancelled: boolean }> {
    return this.requireSession(sessionId).cancelQueuedMessage(commandUuid);
  }

  async setModel(
    ctx: ThreadCallContext,
    sessionId: string,
    request: {
      model?: string;
      reasoningEffort?: string | null;
      contextWindow?: unknown;
      /** ACP 的模型选择要写回设置；SDK 的会话级切换是临时的。 */
      persisted?: boolean;
    },
  ): Promise<void> {
    return this.requireSession(sessionId).setModel(ctx, request);
  }

  async setContextWindow(
    ctx: ThreadCallContext,
    sessionId: string,
    value: unknown,
  ): Promise<void> {
    return this.requireSession(sessionId).setContextWindow(ctx, value);
  }

  async setMaxThinkingTokens(
    ctx: ThreadCallContext,
    sessionId: string,
    maxThinkingTokens: number,
  ): Promise<void> {
    return this.requireSession(sessionId).setMaxThinkingTokens(
      ctx,
      maxThinkingTokens,
    );
  }

  async setPermissionMode(
    ctx: ThreadCallContext,
    sessionId: string,
    request: { mode: string; preservePlanMode?: boolean },
  ): Promise<void> {
    return this.requireSession(sessionId).setPermissionMode(ctx, request);
  }

  async setPlanMode(
    ctx: ThreadCallContext,
    sessionId: string,
    active: boolean,
  ): Promise<ThreadPlanModeResult> {
    return this.requireSession(sessionId).setPlanMode(ctx, active);
  }

  async getPlanMode(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<ThreadPlanModeResult> {
    return this.requireSession(sessionId).getPlanMode(ctx);
  }

  async setGoal(
    ctx: ThreadCallContext,
    sessionId: string,
    goal: {
      objective?: string;
      status?: string;
      creditsBudget?: number | null;
      customContext?: Readonly<Record<string, string>>;
    },
  ): Promise<ThreadGoalResult> {
    return this.requireSession(sessionId).setGoal(ctx, goal);
  }

  async setGoalMaxTurns(
    ctx: ThreadCallContext,
    sessionId: string,
    maxTurns: number | null,
  ): Promise<{ goalMaxTurns: number }> {
    return this.requireSession(sessionId).setGoalMaxTurns(ctx, maxTurns);
  }

  async getGoal(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<ThreadGoalResult> {
    return this.requireSession(sessionId).getGoal(ctx);
  }

  async resumeGoal(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<ThreadGoalResult> {
    return this.requireSession(sessionId).resumeGoal(ctx);
  }

  async clearGoal(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<{ cleared: boolean }> {
    return this.requireSession(sessionId).clearGoal(ctx);
  }

  async addDirectories(
    ctx: ThreadCallContext,
    sessionId: string,
    directories: readonly string[],
  ): Promise<ThreadAddDirectoriesResult> {
    return this.requireSession(sessionId).addDirectories(ctx, directories);
  }

  async seedReadState(
    ctx: ThreadCallContext,
    sessionId: string,
    entries: ReadonlyArray<{ path: string; mtime: number }>,
  ): Promise<void> {
    return this.requireSession(sessionId).seedReadState(ctx, entries);
  }

  async rewind(
    ctx: ThreadCallContext,
    sessionId: string,
    request: { userMessageId: string; scope?: string; dryRun?: boolean },
  ): Promise<ThreadRewindResult> {
    return this.requireSession(sessionId).rewind(ctx, request);
  }

  async rewindFiles(
    ctx: ThreadCallContext,
    sessionId: string,
    request: { userMessageId: string; dryRun?: boolean },
  ): Promise<ThreadRewindResult> {
    return this.requireSession(sessionId).rewindFiles(ctx, request);
  }

  async getContextUsage(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    return this.requireSession(sessionId).getContextUsage(ctx);
  }

  async getSettings(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    return this.requireSession(sessionId).getSettings(ctx);
  }

  async applyFlagSettings(
    ctx: ThreadCallContext,
    sessionId: string,
    settings: Record<string, unknown>,
  ): Promise<ThreadAppliedFlagSettings> {
    return this.requireSession(sessionId).applyFlagSettings(ctx, settings);
  }

  async reloadPlugins(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    return this.requireSession(sessionId).reloadPlugins(ctx);
  }

  async reloadSkills(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    return this.requireSession(sessionId).reloadSkills(ctx);
  }

  async setProxy(
    ctx: ThreadCallContext,
    sessionId: string,
    proxy: string | undefined,
  ): Promise<ThreadProxyResult> {
    return this.requireSession(sessionId).setProxy(ctx, proxy);
  }

  async flushMemory(ctx: ThreadCallContext, sessionId: string): Promise<void> {
    return this.requireSession(sessionId).flushMemory(ctx);
  }

  async refreshMemory(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<void> {
    return this.requireSession(sessionId).refreshMemory(ctx);
  }

  async flushSkillEvolution(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<void> {
    return this.requireSession(sessionId).flushSkillEvolution(ctx);
  }

  async stopTask(
    ctx: ThreadCallContext,
    sessionId: string,
    taskId: string,
  ): Promise<ThreadTaskResult> {
    return this.requireSession(sessionId).stopTask(ctx, taskId);
  }

  async backgroundTasks(
    ctx: ThreadCallContext,
    sessionId: string,
    options?: { toolUseId?: string },
  ): Promise<ThreadTaskResult> {
    return this.requireSession(sessionId).backgroundTasks(ctx, options);
  }

  async generateSessionTitle(
    ctx: ThreadCallContext,
    sessionId: string,
    request: {
      sourceUserMessageId?: string;
      description?: string;
      persist?: boolean;
      customContext?: Readonly<Record<string, string>>;
    },
  ): Promise<ThreadSessionTitleResult> {
    return this.requireSession(sessionId).generateSessionTitle(ctx, request);
  }

  async setSessionTitle(
    ctx: ThreadCallContext,
    sessionId: string,
    title: string,
  ): Promise<void> {
    return this.requireSession(sessionId).setSessionTitle(ctx, title);
  }

  async getSessionIdentity(
    ctx: ThreadCallContext,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    return this.requireSession(sessionId).getSessionIdentity(ctx);
  }

  async sideQuestion(
    ctx: ThreadCallContext,
    sessionId: string,
    request: {
      question: string;
      history?: readonly unknown[];
      customContext?: Readonly<Record<string, string>>;
    },
  ): Promise<ThreadSideQuestionResult> {
    return this.requireSession(sessionId).sideQuestion(ctx, request);
  }

  async setMcpServers(
    ctx: ThreadCallContext,
    sessionId: string,
    servers: readonly unknown[],
  ): Promise<unknown> {
    return this.requireSession(sessionId).setMcpServers(ctx, servers);
  }

  async reconnectMcp(
    ctx: ThreadCallContext,
    sessionId: string,
    serverName?: string,
  ): Promise<unknown> {
    return this.requireSession(sessionId).reconnectMcp(ctx, serverName);
  }

  async toggleMcp(
    ctx: ThreadCallContext,
    sessionId: string,
    serverName: string,
    enabled: boolean,
  ): Promise<unknown> {
    return this.requireSession(sessionId).toggleMcp(ctx, serverName, enabled);
  }

  async mcpStatus(ctx: ThreadCallContext, sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).mcpStatus(ctx);
  }

  async injectMcpToken(
    ctx: ThreadCallContext,
    sessionId: string,
    payload: unknown,
  ): Promise<unknown> {
    return this.requireSession(sessionId).injectMcpToken(ctx, payload);
  }

  async authenticateMcp(
    ctx: ThreadCallContext,
    sessionId: string,
    payload: unknown,
  ): Promise<unknown> {
    return this.requireSession(sessionId).authenticateMcp(ctx, payload);
  }

  async mcpOAuthCallbackUrl(
    ctx: ThreadCallContext,
    sessionId: string,
    payload: unknown,
  ): Promise<unknown> {
    return this.requireSession(sessionId).mcpOAuthCallbackUrl(ctx, payload);
  }

  async clearMcpAuth(
    ctx: ThreadCallContext,
    sessionId: string,
    payload: unknown,
  ): Promise<unknown> {
    return this.requireSession(sessionId).clearMcpAuth(ctx, payload);
  }

  // ===========================================================================
  // 内部
  // ===========================================================================

  private async start(
    request: ThreadOpenRequest,
    sessionId: string,
    phaseLog: SessionPhaseLog,
  ): Promise<ThreadSession> {
    const { ThreadSession } = await phaseLog.phase(
      '加载会话模块',
      '动态 import ThreadSession 实现',
      () => import('./thread-session/threadSession.js'),
    );
    // fork 的会话创建动作在 Manager 内部完成：入口只告诉 Manager「源在哪」。
    // 这样打开前的重复 id 门禁已经生效，且 fork 成功后如果装配失败，产物由这里回滚。
    const prepared = await phaseLog.phase(
      '准备恢复数据',
      'resume 路径解析；fork 源 transcript 复制与 checkpoint 建立',
      () => this.prepareResume(request, sessionId),
    );
    try {
      // `ThreadSession.create` 内部已 await 过 `start()`，返回即已启动完毕——Manager 拿到
      // 句柄就可能开始往它身上转调用，一个没启动完的会话会把这些调用丢进未装配的状态里。
      // 装配失败直接抛，open 按失败处理、不留表项。
      const session = await ThreadSession.create({
        businessType: request.businessType,
        sessionId,
        cwd: request.cwd,
        host: this.createHost!(sessionId),
        cliArgs: request.cliArgs,
        ...(request.startupMode === undefined
          ? {}
          : { startupMode: request.startupMode }),
        ...(request.backgroundWindDownPolicy === undefined
          ? {}
          : {
              backgroundWindDownPolicy: request.backgroundWindDownPolicy,
            }),
        ...(request.authType === undefined
          ? {}
          : { authType: request.authType }),
        resourceService: this.resourceService,
        pluginManagerFactory: this.params.pluginManagerFactory,
        settingsService: this.settingsService,
        builtinPlugins: this.builtinPlugins,
        modelProviderFactory: this.params.modelProviderFactory,
        permissionManager: this.params.permissionManager,

        modelTransportManager: this.params.modelTransportManager,
        customProviderManager: this.params.customProviderManager,
        mcpManager: this.params.mcpManager,
        phaseLog,
        ...(prepared.resumeTranscriptPath === undefined
          ? {}
          : { resumeTranscriptPath: prepared.resumeTranscriptPath }),
        ...(prepared.resumeData === undefined
          ? {}
          : { resumeData: prepared.resumeData }),
        ...(prepared.resumeCandidate === undefined
          ? {}
          : { resumeCandidate: prepared.resumeCandidate }),
        ...(request.dynamicMcpServers === undefined
          ? {}
          : { dynamicMcpServers: request.dynamicMcpServers }),
        ...(request.fileSystemServiceFactory === undefined
          ? {}
          : { fileSystemServiceFactory: request.fileSystemServiceFactory }),
        forked: prepared.forked,
      });
      runLogger.log('[thread-manager] session assembled', { sessionId });
      return session;
    } catch (error) {
      if (prepared.fork) {
        await rollbackForkTranscript({
          fork: prepared.fork,
          sessionId,
          originalError: error,
        }).catch((rollbackError: unknown) => {
          runLogger.warn('[thread-manager] fork rollback failed', {
            sessionId,
            error: rollbackError,
          });
        });
      }
      throw error;
    }
  }

  /**
   * 把 open 请求里的 resume/fork 意图落成会话装配数据。
   *
   * fork 在这里执行：读源、写目标 transcript、复制 checkpoint、建 SessionState。
   * `ForkSessionService.createFork` 负责自身中途失败的回滚；成功之后、会话装配之前的
   * 失败由 `start()` 调 `rollbackForkTranscript` 收尾。
   */
  private async prepareResume(
    request: ThreadOpenRequest,
    sessionId: string,
  ): Promise<{
    readonly resumeTranscriptPath?: string;
    readonly resumeData?: ThreadResumeData;
    readonly resumeCandidate?: ResumeTranscriptResult;
    readonly fork?: CreatedForkTranscript;
    readonly forked: boolean;
  }> {
    this.validateResumeCandidate(request, sessionId);
    if (request.resumeCandidate) {
      return {
        resumeTranscriptPath: request.resumeTranscriptPath!,
        resumeCandidate: request.resumeCandidate,
        forked: false,
      };
    }
    if (request.forked && request.resumeData) {
      if (
        request.fork ||
        request.resumeTranscriptPath === undefined ||
        request.resumeData.resumeState.sessionId !== sessionId ||
        path.resolve(request.resumeData.resumeState.filePath) !==
          path.resolve(request.resumeTranscriptPath) ||
        request.resumeData.sourceSessionId === sessionId ||
        (request.resumeData.messages.at(-1)?.uuid ?? null) !==
          request.resumeData.resumeState.runtimeTailUuid
      ) {
        throw new Error(
          'Fork resume data does not match the target transcript',
        );
      }
      return {
        resumeTranscriptPath: request.resumeTranscriptPath,
        resumeData: request.resumeData,
        forked: true,
      };
    }
    if (request.fork) {
      if (sessionId === request.fork.sourceSessionId) {
        throw new Error(
          `fork session "${sessionId}" must not reuse its source session id`,
        );
      }
      if (request.fork.sourceTranscriptPath === undefined) {
        throw new Error(
          `fork session "${sessionId}" is missing its source transcript`,
        );
      }
      const fork = await createForkTranscript({
        sourcePath: request.fork.sourceTranscriptPath,
        sessionMirror: request.cliArgs.sessionMirror,
        sourceSessionId: request.fork.sourceSessionId,
        sourceProjectRoot: request.fork.sourceProjectRoot,
        sourceSessionInfo: request.fork.sourceSessionInfo,
        targetSessionId: sessionId,
        targetProjectRoot: request.fork.targetProjectRoot,
        targetCwd: request.fork.targetCwd,
        targetWorktreeSession: request.fork.targetWorktreeSession,
        targetTitle: request.fork.targetTitle,
        strictFileHistoryRestore: request.fork.strictFileHistoryRestore,
        cwd: request.cwd,
        resumeSessionAt: request.fork.resumeSessionAt,
        resumeDropsTurn: request.fork.resumeDropsTurn,
      });
      return {
        resumeTranscriptPath: fork.sessionPath,
        resumeData: toThreadResumeData(fork),
        fork,
        forked: true,
      };
    }

    // resume 请求却没拿到源路径：入口解析失败不能被静默降级成全新会话。
    if (
      request.cliArgs.resume !== undefined &&
      request.resumeTranscriptPath === undefined
    ) {
      throw new Error(
        `resume session "${sessionId}" is missing its source transcript`,
      );
    }
    return {
      ...(request.resumeTranscriptPath === undefined
        ? {}
        : { resumeTranscriptPath: request.resumeTranscriptPath }),
      forked: request.forked === true,
    };
  }

  /** 不合法的候选明确失败，绝不能丢掉候选后重新读源文件。 */
  private validateResumeCandidate(
    request: ThreadOpenRequest,
    sessionId: string,
  ): void {
    const candidate = request.resumeCandidate;
    if (!candidate) return;
    candidate.attempt.check();
    if (
      request.fork !== undefined ||
      request.forked === true ||
      request.resumeData !== undefined ||
      candidate.sessionId !== sessionId ||
      (request.cliArgs.resume !== undefined &&
        request.cliArgs.resume !== sessionId) ||
      request.resumeTranscriptPath === undefined ||
      path.resolve(candidate.filePath) !==
        path.resolve(request.resumeTranscriptPath)
    ) {
      throw new ResumeReadError('unsafe');
    }
  }

  /**
   * 会话自行终止：摘表 + 上报，恰好一次。
   *
   * 以「表里还是这一个对象」为准入条件，因此与 `close()` 互斥。比身份而不是比存在：
   * 同一个 id 有可能在旧会话终止之前就被重新 open，只判存在会把新会话的表项当旧的摘掉。
   */
  private retire(
    sessionId: string,
    session: ThreadSession,
    termination: ThreadTerminationReason,
  ): void {
    if (this.sessions.get(sessionId)?.session !== session) return;
    this.sessions.delete(sessionId);
    clearStartupMilestones(sessionId);
    runLogger.warn('[thread-manager] session terminated', {
      sessionId,
      kind: termination.kind,
    });
    this.notifyObservers({ type: 'sessionTerminated', sessionId, termination });
  }

  private notifyObservers(event: ThreadManagerEvent): void {
    for (const observer of this.observers) {
      try {
        const result = observer(event);
        if (result instanceof Promise) {
          result.catch(() => {});
        }
      } catch {
        // observer 异常不影响主流程
      }
    }
  }
}
