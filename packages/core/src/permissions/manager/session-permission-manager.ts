/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SESSION_AUTO_KEY,
  type AutoClassifier,
  type AutoClassifierSession,
} from '../permission-modes/auto/auto-classifier.js';
import { createEmptyToolLookup } from '../permission-modes/auto/classifier.js';
import type { AutoJudgmentSettings } from '../permission-modes/auto/jev-settings.js';
import type { Judge } from '../../judgment/types.js';
import {
  PERMISSION_MODES,
  PermissionModes,
  rulesForToolName,
  type AskHandler,
  type CheckPermissionOptions,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRules,
  type PermissionRuleSource,
  type RulesForTool,
  type ToolCheckContext,
  type ToolCheckResult,
} from './decision/index.js';
import type { ConfigSnapshot } from './decision/config-snapshot.js';
import type { ToolPermissionChecker } from './decision/types/tool-check.js';
import type {
  HostToolChecker,
  ToolPermissionResult,
} from '../../tools/tool-checkers/rule-precedence.js';
import type {
  HostAskHandler,
  ToolPermissionReason,
} from '../../tools/tool-checkers/checker-reasons.js';
import { coreEvents } from '../../utils/events.js';
import { PermissionModeUnavailableError, type PermissionPolicySnapshot } from './policy.js';
import { getReadProbeChecker, withReadProbe } from '../../tools/tool-checkers/rule-precedence.js';
import { ACCEPT_EDITS_TOOL_NAMES } from '../../tools/tool-checkers/checker-registry.js';
import type {
  CheckRequest,
  ModeChangeResult,
  ModeListing,
  PermissionContext,
  SessionPermissionOptions,
  Scene,
  AskHandler as ManagerAskHandler,
} from './types.js';
import {
  ToolCheck,
  type CheckerResolution,
  type ToolCheckHost,
} from './tool-check.js';
import type { SessionMcpManager } from '../../mcp/sessionMcpManager/sessionMcpManager.js';
import type { SettingsWriter } from '../settings/permissionsLoader.js';
import type { LazyMcpToolEntry } from '../../mcp/sessionMcpManager/types.js';
import { createNonInteractiveReadChecker } from './probe-checker.js';
import { READ_FILE_TOOL_NAME } from '../../tools/tool-names.js';

export { UnregisteredToolError } from './tool-check.js';

export class SessionPermissionManager {
  private readonly options: SessionPermissionOptions;
  private readonly sceneCheckers: ReadonlyMap<
    Scene,
    ReadonlyMap<string, HostToolChecker>
  >;

  private sessionMcpManager?: SessionMcpManager;
  private readonly mcpToolCheckers = new Map<
    string,
    { entry: LazyMcpToolEntry; checker: HostToolChecker }
  >();
  private unsubscribeMcpTools?: () => void;
  private unsubscribePolicy?: () => void;
  private readonly isMcpToolKnown = (qualifiedName: string): boolean =>
    this.sessionMcpManager?.getLazyDiscoveredMcpToolByQualifiedName(
      qualifiedName,
    ) !== undefined;
  private permissionMode: PermissionMode;
  private rules: PermissionRules;
  private additionalDirectories: string[];
  private readonly toolNameAliases: Record<string, string>;
  private toolCheckVersion = 0;
  private askHandler: AskHandler<ToolPermissionReason> | undefined;
  private readonly activeChecks = new Set<ToolCheck>();
  private readonly toolCheckHost: ToolCheckHost = {
    getSkill: () => this.options.skill,
    getSnapshot: () => this.getSnapshot(),
    getAskHandler: (override) => this.getAskHandler(override),
    resolveChecker: (request, context) =>
      this.resolveCheckerResolution(request, context),
    getManagedRules: () => this.getManagedRules(),
    effectiveRules: (rules) => this.effectiveRules(rules),
    rulesForTool: (rules, toolName) =>
      rulesForToolName(rules, toolName, this.toolNameAliases),
    isMcpToolKnown: (name) => this.isMcpToolKnown(name),
    getAutoClassifier: (agentId) => this.getAutoClassifier(agentId ?? SESSION_AUTO_KEY),
    hasManagedRules: () => this.getManagedRules() !== undefined,
    resolveModeAsk: (ask, ctx, toolName, input, context) =>
      this.resolveModeAsk(ask, ctx, toolName, input, context),
  };

  private disposed = false;
  private disposal?: Promise<void>;
  readonly autoClassifier: AutoClassifier;
  private readonly autoSessionIds = new Set<string>();
  private autoSessionConfig?: AutoClassifierSession;

  constructor(options: SessionPermissionOptions) {
    this.options = options;
    this.autoClassifier = options.autoClassifier;
    this.sceneCheckers = options.sceneCheckers ?? new Map();
    this.sessionMcpManager = options.sessionMcpManager;
    this.attachMcpToolSync();
    this.unsubscribePolicy = options.managedPolicy.subscribe?.(() => {
      this.toolCheckVersion++;
      this.notifyChecks();
    });
    this.permissionMode = options.initialMode;
    this.rules = options.rules;
    this.additionalDirectories = [...options.directories.additional];
    this.toolNameAliases = { ...(options.toolNameAliases ?? {}) };
    if (options.askHandler) {
      const handler = options.askHandler;
      this.askHandler = (ask) => handler.handleAsk(this.options.getSessionId(), ask);
    }
  }

  getAutoJudgmentSettings(): AutoJudgmentSettings {
    return this.autoClassifier.getJevSettings();
  }

  isAutoModeJevEnabled(): boolean {
    return this.autoClassifier.isJevModeEnabled();
  }

  async getAutoModeJudge(): Promise<Judge | undefined> {
    return this.autoClassifier.getJudge(this.getAutoSessionConfig());
  }

  getSessionId(): string {
    return this.options.getSessionId();
  }

  /** 唯一对外判定入口：请求 + 会话上下文，返回决策。 */
  async check(
    request: CheckRequest,
    context?: PermissionContext,
  ): Promise<PermissionDecision<ToolPermissionReason>> {
    if (this.options.managedPolicy.whenReady) {
      await this.options.managedPolicy.whenReady();
    }
    return this.evaluate(request, context);
  }

  /**
   * 受保护搜索结果确认专用：用调用方提供的 checker 走同一 check 流程，
   * 模式仍由会话模式层落定。仅用于需要在判定前重建 checker 的内部读确认。
   */
  async checkWithChecker(
    request: CheckRequest,
    checker: ToolPermissionChecker<ToolPermissionReason>,
    override?: CheckPermissionOptions<ToolPermissionReason>,
  ): Promise<PermissionDecision<ToolPermissionReason>> {
    if (this.options.managedPolicy.whenReady) {
      await this.options.managedPolicy.whenReady();
    }
    this.assertAlive();
    const mode = override?.permissionMode ?? this.permissionMode;
    const modeRestriction = this.getModeRestriction(mode);
    if (modeRestriction !== undefined) {
      return deniedByMode(request, mode, modeRestriction);
    }
    const handler = override?.askHandler ?? this.askHandler;
    return this.runCheck(
      request,
      undefined,
      { ...override, askHandler: handler },
      false,
      () => ({ checker, applyModeLayer: true }),
    );
  }

  private async evaluate(
    request: CheckRequest,
    context?: PermissionContext,
  ): Promise<PermissionDecision<ToolPermissionReason>> {
    this.assertAlive();

    const mode = this.effectiveMode(context);
    const modeRestriction = this.getModeRestriction(mode);
    if (modeRestriction !== undefined) {
      return deniedByMode(request, mode, modeRestriction);
    }

    const additionalRules = this.contextAdditionalRules(context);
    // 替换语义的 rules 与后加的 grants/overlay 必须合在一起，否则
    // mergeSnapshot 见到 rules 会丢弃 additionalRules。
    const rules =
      context?.rules !== undefined
        ? additionalRules !== undefined
          ? mergeRules(context.rules, additionalRules)
          : context.rules
        : undefined;
    const override: CheckPermissionOptions<ToolPermissionReason> = {
      askHandler: this.buildAskHandler(context),
      preToolUseHookVerdict: request.preToolUseHookVerdict,
      cwd: this.options.getWorkingDir(),
      ...(context?.additionalDirectories
        ? { additionalDirectories: [...context.additionalDirectories] }
        : undefined),
      ...(rules !== undefined ? { rules } : undefined),
      ...(rules === undefined && additionalRules !== undefined
        ? { additionalRules }
        : undefined),
    };
    this.applyResolvedMode(override, context);

    return this.runCheck(request, context, override, true);
  }

  getSettingsWriter(): SettingsWriter | undefined {
    const settings = this.options.permissionSettings;
    if (!settings) return undefined;
    return {
      getSettingsForSource: (source) => settings.getSettingsForSource(source),
      mutateSettingsForSource: (source, mutation) =>
        settings.mutateSettingsForSource(source, mutation),
    };
  }

  getRules(): PermissionRules;
  getRules(toolName: string): RulesForTool;
  getRules(toolName?: string): PermissionRules | RulesForTool {
    return toolName === undefined
      ? this.effectiveRules()
      : rulesForToolName(this.effectiveRules(), toolName, this.toolNameAliases);
  }

  setRules(rules: PermissionRules, opts?: { merge?: boolean }): void {
    if (this.applyRules(rules, opts)) this.notifyChecks();
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.applyPermissionMode(mode)) this.notifyChecks();
  }

  /**
   * 会话配置只在 classify 时交给共享分类器；分类器不持有任何会话对象。
   */
  getAutoSessionConfig(): AutoClassifierSession {
    return (this.autoSessionConfig ??= {
      getSessionId: () => this.options.getSessionId(),
      judges: this.options.createSessionJudges?.(),
      getMessages: () => this.options.classifierInputs?.getMessages() ?? [],
      getToolLookup: () =>
        this.options.classifierInputs?.getToolLookup() ??
        createEmptyToolLookup(),
      getUserConfig: this.options.autoModeUserConfig,
      getUserInstructions: this.options.autoModeUserInstructions,
      reportShadowComparison: this.options.reportAutoShadowComparison,
      isShadowReportingEnabled: this.options.isAutoShadowReportingEnabled,
    });
  }

  private attachMcpToolSync(): void {
    this.unsubscribeMcpTools?.();
    this.unsubscribeMcpTools = undefined;
    const manager = this.sessionMcpManager;
    if (!manager || !this.options.createMcpToolChecker) return;
    this.unsubscribeMcpTools = manager.onToolListChange(() =>
      this.syncMcpToolCheckers(),
    );
    this.syncMcpToolCheckers();
  }

  private syncMcpToolCheckers(): void {
    const manager = this.sessionMcpManager;
    const create = this.options.createMcpToolChecker;
    if (!manager || !create) return;
    const wanted = new Map(
      manager
        .getInjectedMcpTools()
        .tools.map((entry) => [entry.qualifiedName, entry]),
    );
    let changed = false;
    for (const name of [...this.mcpToolCheckers.keys()]) {
      if (!wanted.has(name)) {
        this.mcpToolCheckers.delete(name);
        changed = true;
      }
    }
    for (const [name, entry] of wanted) {
      const current = this.mcpToolCheckers.get(name);
      if (!current || current.entry.tool !== entry.tool) {
        this.mcpToolCheckers.set(name, { entry, checker: create(entry) });
        changed = true;
      }
    }
    if (changed) {
      this.toolCheckVersion++;
      this.notifyChecks();
    }
  }

  getAdditionalDirectories(): string[] {
    return this.additionalDirectories;
  }

  setAdditionalDirectories(dirs: string[]): void {
    if (dirs === this.additionalDirectories) return;
    this.additionalDirectories = dirs;
    this.notifyChecks();
  }

  addDirectory(dir: string): void {
    if (this.additionalDirectories.includes(dir)) return;
    this.setAdditionalDirectories([...this.additionalDirectories, dir]);
  }

  setAskHandler(handler: HostAskHandler | ManagerAskHandler | undefined): void {
    if (!handler) {
      this.askHandler = undefined;
      return;
    }
    this.askHandler = (typeof handler === 'function'
      ? handler
      : (ask) => handler.handleAsk(this.options.getSessionId(), ask)) as AskHandler<ToolPermissionReason>;
  }

  setSessionMcpManager(manager: SessionMcpManager | undefined): void {
    this.sessionMcpManager = manager;
    this.attachMcpToolSync();
  }

  listModes(): ModeListing[] {
    return PERMISSION_MODES.map((mode) => {
      const reason = this.getModeRestriction(mode);
      return { mode, available: reason === undefined, reason };
    });
  }

  getModeRestriction(mode: PermissionMode): string | undefined {
    const gate = this.options.modes[mode]?.isAvailable();
    if (gate && !gate.ok) return gate.message ?? gate.reason;
    return this.options.getSessionModeRestriction?.(mode);
  }

  setMode(next: PermissionMode): ModeChangeResult {
    this.assertAlive();
    this.assertModeAvailable(next);
    const previous = this.permissionMode;
    this.setPermissionMode(next);
    coreEvents.emitPermissionModeChanged(
      this.options.getSessionId(),
      next,
      previous,
    );
    return {
      previous,
      current: next,
      recheckPending: false,
      resolvePending: false,
    };
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.mcpToolCheckers.clear();
    for (const sessionId of this.autoSessionIds) {
      this.autoClassifier.disposeSession(sessionId);
    }
    this.autoSessionIds.clear();
    this.autoSessionConfig = undefined;
    this.unsubscribeMcpTools?.();
    this.unsubscribeMcpTools = undefined;
    this.unsubscribePolicy?.();
    this.unsubscribePolicy = undefined;
    this.askHandler = undefined;
    return (this.disposal = Promise.resolve());
  }

  private async runCheck(
    request: PermissionRequest,
    context: PermissionContext | undefined,
    override: CheckPermissionOptions<ToolPermissionReason> | undefined,
    fallbackUnregistered: boolean,
    checkerResolver?: () => CheckerResolution | undefined,
  ): Promise<PermissionDecision<ToolPermissionReason>> {
    const check = new ToolCheck(
      this.toolCheckHost,
      request,
      context,
      override,
      checkerResolver,
    );
    this.activeChecks.add(check);
    try {
      const decision = await check.run(fallbackUnregistered);
      if (decision.kind === 'allow') {
        const mode = override?.permissionMode ?? this.effectiveMode(context);
        const restriction = this.getModeRestriction(mode);
        if (restriction !== undefined) {
          return deniedByMode(
            { ...request, input: decision.input },
            mode,
            restriction,
          );
        }
      }
      return decision;
    } finally {
      this.activeChecks.delete(check);
    }
  }

  private getAskHandler(
    override: CheckPermissionOptions<ToolPermissionReason> | undefined,
  ): AskHandler<ToolPermissionReason> | undefined {
    if (override?.askHandler !== undefined) return override.askHandler;
    return this.askHandler;
  }

  getManagedRules(): PermissionPolicySnapshot['rules'] {
    const rules = this.options.managedPolicy.getRules();
    if (
      !Object.keys(rules.deny).length &&
      !Object.keys(rules.ask).length
    ) {
      return undefined;
    }
    return {
      deny: Object.values(rules.deny).flatMap((entry) => entry ?? []),
      ask: Object.values(rules.ask).flatMap((entry) => entry ?? []),
    };
  }

  private effectiveRules(local = this.rules): PermissionRules {
    const managed = this.options.managedPolicy.getRules();
    const configured = [managed.allow, managed.deny, managed.ask].some(
      (bucket) =>
        Object.values(bucket).some((rules) => (rules?.length ?? 0) > 0),
    );
    return configured ? mergeRules(managed, local) : local;
  }

  private getSnapshot(): ConfigSnapshot {
    return {
      permissionMode: this.permissionMode,
      rules: this.rules,
      cwd: this.options.getWorkingDir(),
      additionalDirectories: this.additionalDirectories,
      toolCheckVersion: this.toolCheckVersion,
    };
  }

  private notifyChecks(): void {
    for (const check of this.activeChecks) {
      check.onConfigChange(this.toolCheckHost);
    }
  }

  private applyPermissionMode(mode: PermissionMode): boolean {
    if (mode === this.permissionMode) return false;
    const sessionId = this.options.getSessionId();
    if (mode === 'auto') {
      this.autoClassifier.clearDenials(sessionId);
      this.autoClassifier.resetDenialTrackers(sessionId);
      this.rules = this.autoClassifier.stripDangerousAllowRules(
        sessionId,
        this.rules,
      );
    } else if (this.permissionMode === 'auto') {
      this.rules = this.autoClassifier.restoreDangerousAllowRules(
        sessionId,
        this.rules,
      );
      this.autoClassifier.setNeedsExitAttachment(sessionId, true);
    }
    this.permissionMode = mode;
    return true;
  }

  private applyRules(
    rules: PermissionRules,
    opts?: { merge?: boolean },
  ): boolean {
    // getRules() includes managed policy for readers. A local write-back
    // must not retain that snapshot after the owning policy changes.
    let local = rules;
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      const owned = opts?.merge === true
        ? undefined
        : this.rules[behavior].policySettings;
      if (rules[behavior].policySettings === owned) continue;
      const { policySettings: _managed, ...writable } = rules[behavior];
      local = {
        ...local,
        [behavior]: owned === undefined ? writable : { ...writable, policySettings: owned },
      };
    }
    rules = local;
    if (opts?.merge === true) {
      this.rules = this.mergeRules(this.rules, rules);
      return true;
    }
    if (rules === this.rules) return false;
    this.rules = rules;
    return true;
  }

  private mergeRules(
    current: PermissionRules,
    incoming: PermissionRules,
  ): PermissionRules {
    return {
      allow: this.mergeBucket(current.allow, incoming.allow),
      deny: this.mergeBucket(current.deny, incoming.deny),
      ask: this.mergeBucket(current.ask, incoming.ask),
    };
  }

  private mergeBucket(
    base: Record<string, string[] | undefined>,
    extra: Record<string, string[] | undefined>,
  ): Record<string, string[] | undefined> {
    const out: Record<string, string[] | undefined> = { ...base };
    for (const source of Object.keys(extra)) {
      const strings = extra[source];
      if (!strings) continue;
      out[source] = [...(base[source] ?? []), ...strings];
    }
    return out;
  }

  /** 工具审批统一进入模式层；内部读探针只做权限预判。 */
  private resolveCheckerResolution(
    request: PermissionRequest,
    context: PermissionContext | undefined,
  ): CheckerResolution | undefined {
    const scene = context?.scene ?? 'main';
    const resolved = this.resolveChecker(scene, request.toolName);
    if (!resolved.checker) return undefined;
    return {
      checker: resolved.checker,
      applyModeLayer: resolved.needsModeLayer,
    };
  }

  private resolveChecker(
    scene: Scene,
    toolName: string,
  ): { checker?: HostToolChecker; needsModeLayer: boolean; canonical?: HostToolChecker } {
    const registered = this.options.getChecker(scene, toolName);
    // A fork keeps its own local checker. Only managed content matching may
    // consult the main checker; unknown scenes keep their original fallback.
    const canonical = this.getManagedRules() && scene !== 'main' && scene !== 'probe'
      ? this.options.getChecker('main', toolName)
      : registered;
    const sceneChecker = this.sceneCheckers.get(scene)?.get(toolName) ?? registered;
    // probe 只做内部读预判：不套模式层，避免 Auto 分类器在写前预读时参与判定。
    if (scene !== 'main' && sceneChecker !== undefined) {
      return {
        checker: sceneChecker,
        needsModeLayer: scene !== 'probe',
        canonical,
      };
    }
    const mcp = this.mcpToolCheckers.get(toolName);
    if (mcp !== undefined) {
      // MCP checker 只做工具级规则与 hook；模式统一由会话模式层落定。
      return { checker: mcp.checker, needsModeLayer: true, canonical };
    }
    if (sceneChecker !== undefined) {
      return { checker: sceneChecker, needsModeLayer: true, canonical };
    }
    // probe 是内部读探针的保留场景：即使宿主表为空，Read 也必须有一个
    // 不弹窗的判定，否则未注册兜底会把 deny/ask 规则整体放行。
    if (scene === 'probe' && toolName === READ_FILE_TOOL_NAME) {
      const probe = createNonInteractiveReadChecker();
      return {
        checker: withReadProbe(probe, getReadProbeChecker(probe) ?? probe),
        needsModeLayer: false,
        canonical,
      };
    }
    return { checker: undefined, needsModeLayer: true, canonical };
  }

  private resolveModeAsk(
    ask: Extract<ToolCheckResult<ToolPermissionReason>, { kind: 'ask' }>,
    ctx: ToolCheckContext<ToolPermissionReason>,
    toolName: string,
    input: Record<string, unknown>,
    context: PermissionContext | undefined,
  ): ToolCheckResult<ToolPermissionReason> | Promise<ToolCheckResult<ToolPermissionReason>> {
    // 托管策略的 ask 各模式都不能放行：Yolo/AcceptEdits/Auto 都把它当
    // unskippable 保持 ask，DontAsk 落成拒绝；这里交给模式定义统一处理。
    const definition =
      this.options.modes[ctx.mode] ??
      this.options.modes[PermissionModes.Default];
    if (!definition) return ask;
    return definition.resolve(
      ask as Extract<ToolPermissionResult, { kind: 'ask' }>,
      {
      mode: ctx.mode,
      toolName,
      input,
      agentId: ctx.agentId,
      rules: ctx.rules,
      skillRules: context?.skillRules,
      messages: context?.messages,
      signal: ctx.signal,
      toolCheckContext: ctx,
      coveredByAcceptEdits: ACCEPT_EDITS_TOOL_NAMES.has(toolName),
      autoClassifier: this.getAutoClassifier(ctx.agentId ?? SESSION_AUTO_KEY),
      autoSession: this.getAutoSessionConfig(),
    });
  }

  private buildAskHandler(
    context?: PermissionContext,
  ): CheckPermissionOptions<ToolPermissionReason>['askHandler'] {
    if (context?.canPrompt === false) {
      // 「禁止询问」必须表达成拒绝，而不是 undefined——后者会被当成
      // 「没有意见」并回退到会话 handler。
      return async () => ({ kind: 'rejected' });
    }
    if (this.askHandler) return this.askHandler;
    const handler = this.options.askHandler;
    if (!handler) return undefined;
    return (ask) => handler.handleAsk(this.options.getSessionId(), ask);
  }

  private contextAdditionalRules(
    context?: PermissionContext,
  ): PermissionRules | undefined {
    const grants = context?.skillRules?.grants;
    if (!context?.additionalRules && (!grants || grants.length === 0)) {
      return undefined;
    }
    return mergeRules(
      emptyRules(),
      context?.additionalRules,
      grants && grants.length > 0
        ? { allow: { session: [...grants] }, deny: {}, ask: {} }
        : undefined,
    );
  }

  /**
   * 本次判定的最终模式：显式传入即最终模式，缺省跟随会话。
   * 子代理的父/子模式合并（父会话不可降级）由 run-subagent 的声明上下文
   * 先解析后再传入，这里不重复决策。
   */
  getAutoClassifier(
    agentId: string,
  ): import('../permission-modes/auto/auto-classifier.js').AutoClassifierView {
    const sessionId = this.options.getSessionId();
    this.autoSessionIds.add(sessionId);
    return this.autoClassifier.getView(sessionId, agentId);
  }

  releaseAutoClassifier(agentId: string): void {
    this.autoClassifier.releaseView(this.options.getSessionId(), agentId);
  }

  resolveMode(mode?: PermissionMode): PermissionMode {
    return mode ?? this.permissionMode;
  }

  private effectiveMode(context?: PermissionContext): PermissionMode {
    return this.resolveMode(context?.mode);
  }

  /** 本次调用声明了模式：把解析结果钉在 override 上，复检沿用同一结论。 */
  private applyResolvedMode(
    override: CheckPermissionOptions<ToolPermissionReason>,
    context?: PermissionContext,
  ): void {
    if (context?.mode === undefined) return;
    Object.defineProperty(override, 'permissionMode', {
      enumerable: true,
      configurable: true,
      get: () => this.effectiveMode(context),
    });
  }

  private assertModeAvailable(mode: PermissionMode): void {
    const restriction = this.getModeRestriction(mode);
    if (restriction !== undefined) {
      throw new PermissionModeUnavailableError(restriction);
    }
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error('SessionPermissionManager disposed');
    }
  }
}

function emptyRules(): PermissionRules {
  return { allow: {}, deny: {}, ask: {} };
}

function mergeRules(
  base: PermissionRules,
  ...overlays: Array<PermissionRules | undefined>
): PermissionRules {
  const result: PermissionRules = {
    allow: { ...base.allow },
    deny: { ...base.deny },
    ask: { ...base.ask },
  };
  for (const overlay of overlays) {
    if (!overlay) continue;
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      for (const [source, values] of Object.entries(overlay[behavior])) {
        const key = source as PermissionRuleSource;
        result[behavior][key] = [
          ...(result[behavior][key] ?? []),
          ...(values ?? []),
        ];
      }
    }
  }
  return result;
}

function deniedByMode(
  request: PermissionRequest,
  mode: PermissionMode,
  message: string,
): PermissionDecision<ToolPermissionReason> {
  return {
    kind: 'deny',
    decidedBy: 'toolCheck',
    toolName: request.toolName,
    input: request.input,
    toolUseId: request.toolUseId,
    reason: {
      message,
      attribution: { type: 'mode', mode },
    },
    toolCheck: {
      kind: 'deny',
      extra: {
        decisionPoint: 'mode.unavailable.deny',
        denialReason: {
          message,
          attribution: { type: 'mode', mode },
          denialKind: 'permission-rule',
          decisionPoint: 'mode.unavailable.deny',
        },
      },
    },
    history: [],
    stages: [{ stage: 'toolCheck', verdict: 'deny' }],
  };
}
