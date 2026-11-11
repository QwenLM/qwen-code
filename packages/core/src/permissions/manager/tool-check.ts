/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  configDiffers,
  mergeSnapshot,
  type ConfigSnapshot,
} from './decision/config-snapshot.js';
import type {
  AskHandler,
  CheckPermissionOptions,
  PermissionDecision,
  PermissionRequest,
  PermissionRules,
  RulesForTool,
  ToolCheckContext,
  ToolCheckResult,
} from './decision/index.js';
import { PermissionModes } from './decision/index.js';
import type { PermissionContext } from './types.js';
import { checkManagedToolRules } from '../../tools/tool-checkers/rule-precedence.js';
import type { ToolPermissionChecker } from './decision/types/tool-check.js';
import type { SkillCheckerDeps } from '../../tools/tool-checkers/content-checkers.js';
import type { ToolPermissionReason, ToolPermissionExtra } from '../../tools/tool-checkers/checker-reasons.js';

export class UnregisteredToolError extends Error {
  constructor(readonly toolName: string) {
    super(`No permission checker is registered for tool: ${toolName}`);
    this.name = 'UnregisteredToolError';
  }
}

export type CheckerResolution = {
  checker: ToolPermissionChecker<ToolPermissionReason>;
  /** 工具审批由会话落定模式；内部读探针不进入模式层。 */
  applyModeLayer: boolean;
};

/**
 * 会话向单次判定暴露的能力：配置快照、checker 解析、规则投影与模式落定。
 * 判定过程本身归 ToolCheck，会话只负责管理在途集合。
 */
export interface ToolCheckHost {
  getSkill(): SkillCheckerDeps | undefined;
  getSnapshot(): ConfigSnapshot;
  getAskHandler(
    override: CheckPermissionOptions<ToolPermissionReason> | undefined,
  ): AskHandler<ToolPermissionReason> | undefined;
  resolveChecker(
    request: PermissionRequest,
    context: PermissionContext | undefined,
  ): CheckerResolution | undefined;
  getManagedRules():
    | import('./policy.js').PermissionPolicySnapshot['rules']
    | undefined;
  effectiveRules(rules: PermissionRules): PermissionRules;
  rulesForTool(rules: PermissionRules, toolName: string): RulesForTool;
  isMcpToolKnown(qualifiedName: string): boolean;
  getAutoClassifier(
    agentId: string,
  ): import('./decision/index.js').AutoClassifierView<ToolPermissionReason> | undefined;
  hasManagedRules(): boolean;
  resolveModeAsk(
    ask: Extract<ToolCheckResult<ToolPermissionReason>, { kind: 'ask' }>,
    ctx: ToolCheckContext<ToolPermissionReason>,
    toolName: string,
    input: Record<string, unknown>,
    context: PermissionContext | undefined,
  ):
    | ToolCheckResult<ToolPermissionReason>
    | Promise<ToolCheckResult<ToolPermissionReason>>;
}

/** 一次在途判定：首检、追问、配置变化重跑与最终决策都在这里闭环。 */
export class ToolCheck {
  readonly request: PermissionRequest;
  readonly context: PermissionContext | undefined;
  readonly override: CheckPermissionOptions<ToolPermissionReason> | undefined;
  readonly askHandler: AskHandler<ToolPermissionReason> | undefined;
  snapshot: ConfigSnapshot;
  readonly listeners = new Set<
    (result: ToolCheckResult<ToolPermissionReason>) => void
  >();
  pending: Promise<void> = Promise.resolve();
  armed = false;
  readonly history: Array<ToolCheckResult<ToolPermissionReason>> = [];
  private readonly host: ToolCheckHost;
  private readonly checkerResolver:
    | (() => CheckerResolution | undefined)
    | undefined;

  constructor(
    host: ToolCheckHost,
    request: PermissionRequest,
    context: PermissionContext | undefined,
    override: CheckPermissionOptions<ToolPermissionReason> | undefined,
    checkerResolver: (() => CheckerResolution | undefined) | undefined,
  ) {
    this.host = host;
    this.request = {
      ...request,
      agentId: context?.agentId ?? request.agentId,
    };
    this.context = context;
    this.override = override;
    this.askHandler = host.getAskHandler(override);
    this.snapshot = mergeSnapshot(host.getSnapshot(), override);
    this.checkerResolver = checkerResolver;
  }

  /** 配置变化时重跑；结果经 listeners 送达，不影响正在等待的追问。 */
  onConfigChange(host: ToolCheckHost): void {
    if (!this.armed) return;
    const next = mergeSnapshot(host.getSnapshot(), this.override);
    if (!configDiffers(this.snapshot, next)) return;
    this.snapshot = next;
    const rerun = this.executeRerun();
    this.pending = this.pending.then(() => rerun).catch(() => {});
  }

  async run(
    fallbackUnregistered: boolean,
  ): Promise<PermissionDecision<ToolPermissionReason>> {
    try {
      const first = await this.runFirstCheck();
      if (first.kind !== 'ask') {
        return this.buildDecision(
          this.request,
          first,
          first.kind,
          'toolCheck',
          [],
        );
      }
      if (this.askHandler === undefined) {
        return this.buildDecision(this.request, first, 'deny', 'ask', []);
      }

      const approvedRules = this.snapshot.rules;
      const ctx = {
        toolUseId: this.request.toolUseId,
        agentId: this.request.agentId,
        toolName: this.request.toolName,
        input: this.request.input,
        signal: this.request.signal,
        toolCheckResult: first,
        onToolCheckResult: (
          listener: (result: ToolCheckResult<ToolPermissionReason>) => void,
        ) => {
          this.listeners.add(listener);
          return () => {
            this.listeners.delete(listener);
          };
        },
      };

      this.armed = true;
      this.onConfigChange(this.host);

      let handleResult;
      try {
        handleResult = await this.askHandler(ctx);
      } catch {
        handleResult = { kind: 'aborted' as const };
      }

      await this.pending;

      if (handleResult.kind !== 'approved') {
        const decision = this.buildDecision(
          this.request,
          first,
          'deny',
          'ask',
          this.history,
          handleResult.kind,
        );
        if (handleResult.kind === 'rejected' && handleResult.reason) {
          decision.denialMessage = handleResult.reason;
        }
        return decision;
      }

      const approvedRequest: PermissionRequest =
        handleResult.input !== undefined
          ? { ...this.request, input: handleResult.input }
          : this.request;
      const snapshot = mergeSnapshot(this.host.getSnapshot(), this.override);
      // Local edits do not revoke an unchanged manual approval. Managed rules
      // are read live by runChecker; amended inputs still use the latest rules.
      if (handleResult.input === undefined) snapshot.rules = approvedRules;
      // Approval settles the ask. Recheck rules without invoking Auto judges again.
      const recheck = await this.runCheckFor(
        approvedRequest,
        snapshot,
        snapshot.permissionMode !== PermissionModes.Auto,
      );
      this.history.push(recheck);
      const decision = this.buildDecision(
        approvedRequest,
        first,
        recheck.kind === 'deny' ? 'deny' : 'allow',
        'ask',
        this.history,
        'approved',
      );
      if (recheck.kind === 'deny') {
        const extra = recheck.extra as ToolPermissionExtra | undefined;
        const message = extra?.denialReason?.message;
        if (message !== undefined) decision.denialMessage = message;
      }
      return decision;
    } catch (error) {
      if (
        !fallbackUnregistered ||
        (error as Error | undefined)?.name !== 'UnregisteredToolError'
      ) {
        throw error;
      }
      return unregisteredToolDecision(this.request);
    }
  }

  private async runFirstCheck(): Promise<
    ToolCheckResult<ToolPermissionReason>
  > {
    const resolved = this.resolveChecker();
    const checker = resolved?.checker;
    if (!checker) {
      if (this.host.hasManagedRules()) {
        return this.managedOnlyCheck(this.request, this.snapshot);
      }
      throw new UnregisteredToolError(this.request.toolName);
    }
    return this.runChecker(
      this.request,
      this.snapshot,
      checker,
      resolved?.applyModeLayer ?? false,
    );
  }

  private async runCheckFor(
    request: PermissionRequest,
    snapshot: ConfigSnapshot,
    applyModeLayer = true,
  ): Promise<ToolCheckResult<ToolPermissionReason>> {
    const resolved = this.resolveChecker();
    const checker = resolved?.checker;
    if (!checker) {
      return this.host.hasManagedRules()
        ? this.managedOnlyCheck(request, snapshot, applyModeLayer)
        : { kind: 'deny' };
    }
    return this.runChecker(
      request,
      snapshot,
      checker,
      applyModeLayer && (resolved?.applyModeLayer ?? false),
    );
  }

  private managedOnlyCheck(
    request: PermissionRequest,
    snapshot: ConfigSnapshot,
    applyModeLayer = true,
  ): Promise<ToolCheckResult<ToolPermissionReason>> {
    const managed = this.host.getManagedRules();
    return this.runChecker(
      request,
      snapshot,
      {
        check: () =>
          (managed
            ? checkManagedToolRules(request.toolName, managed)
            : undefined) ?? { kind: 'allow' },
      },
      applyModeLayer,
    );
  }

  private resolveChecker(): CheckerResolution | undefined {
    return (
      this.checkerResolver?.() ??
      this.host.resolveChecker(this.request, this.context)
    );
  }

  private async runChecker(
    request: PermissionRequest,
    snapshot: ConfigSnapshot,
    checker: ToolPermissionChecker<ToolPermissionReason>,
    applyModeLayer: boolean,
  ): Promise<ToolCheckResult<ToolPermissionReason>> {
    const { context } = this;
    const ctx: ToolCheckContext<ToolPermissionReason> = {
      mode: snapshot.permissionMode,
      rules: snapshot.rules,
      cwd: snapshot.cwd,
      additionalDirectories: snapshot.additionalDirectories,
      preToolUseHookVerdict: snapshot.preToolUseHookVerdict,
      rulesForTool: this.host.rulesForTool(snapshot.rules, request.toolName),
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      agentId: request.agentId,
      signal: request.signal,
      skill: this.host.getSkill(),
      skillRules: context?.skillRules,
      isMcpToolKnown: (name) => this.host.isMcpToolKnown(name),
      autoClassifier: this.host.getAutoClassifier(request.agentId ?? ''),
    };
    const rules = this.host.effectiveRules(snapshot.rules);
    Object.assign(ctx, {
      rules,
      rulesForTool: this.host.rulesForTool(rules, request.toolName),
    });
    const managedRules = this.host.getManagedRules();
    if (managedRules !== undefined) {
      Object.assign(ctx, { globalRules: managedRules });
    }
    if (applyModeLayer) {
      Object.assign(ctx, {
        resolveAsk: (
          ask: Extract<ToolCheckResult<ToolPermissionReason>, { kind: 'ask' }>,
        ) =>
          this.host.resolveModeAsk(
            ask,
            ctx,
            request.toolName,
            request.input,
            context,
          ),
      });
    }
    try {
      let result = await checker.check(request.input, ctx);
      if (result.kind === 'ask' && ctx.resolveAsk) {
        result = await ctx.resolveAsk(result);
      }
      return result;
    } catch {
      return { kind: 'deny' };
    }
  }

  private async executeRerun(): Promise<void> {
    const snapshot = mergeSnapshot(this.host.getSnapshot(), this.override);
    const result = await this.runCheckFor(this.request, snapshot);
    this.history.push(result);
    for (const listener of this.listeners) listener(result);
  }

  private buildDecision(
    request: PermissionRequest,
    first: ToolCheckResult<ToolPermissionReason>,
    kind: PermissionDecision['kind'],
    decidedBy: 'toolCheck' | 'ask',
    history: Array<ToolCheckResult<ToolPermissionReason>>,
    settlement?: PermissionDecision['settlement'],
  ): PermissionDecision<ToolPermissionReason> {
    const askRan = decidedBy === 'ask';
    const askResult = first.kind === 'ask' ? first : undefined;
    const stages: PermissionDecision<ToolPermissionReason>['stages'] = [
      { stage: 'toolCheck', verdict: first.kind },
    ];
    for (const recheck of history) {
      stages.push({ stage: 'recheck', verdict: recheck.kind });
    }
    if (askRan) stages.push({ stage: 'ask', verdict: kind });

    const decision: PermissionDecision<ToolPermissionReason> = {
      kind,
      decidedBy,
      toolName: request.toolName,
      input: request.input,
      toolCheck: first,
      history,
      stages,
      toolUseId: request.toolUseId,
    };
    if (askRan && askResult !== undefined) {
      decision.reason = askResult.reason;
      if (askResult.suggestions !== undefined) {
        decision.suggestions = askResult.suggestions;
      }
    }
    if (settlement !== undefined) decision.settlement = settlement;
    return decision;
  }
}

function unregisteredToolDecision(
  request: PermissionRequest,
): PermissionDecision<ToolPermissionReason> {
  return {
    kind: 'allow',
    decidedBy: 'toolCheck',
    toolName: request.toolName,
    input: request.input,
    toolUseId: request.toolUseId,
    toolCheck: {
      kind: 'allow',
      extra: { decisionPoint: 'unregistered_tool_fallback.allow' },
    },
    history: [],
    stages: [{ stage: 'toolCheck', verdict: 'allow' }],
  };
}
