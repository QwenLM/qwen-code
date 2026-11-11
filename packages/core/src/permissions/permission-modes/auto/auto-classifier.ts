/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auto mode's classifier, process-wide.
 *
 * The product owns one instance (commercial entries subclass it); every session
 * borrows it and owns its request judges. What differs per session — transcript,
 * user rules and judges — arrives with each `classify` call; what
 * differs per agent inside a session — the denial streak — lives on that
 * agent's view. Everything else the classifier caches (refusal list,
 * dangerous-rule stash, exit flag) is keyed by session id, so two sessions in
 * one process neither judge with the other's rules nor trip the other's
 * breaker.
 */

import {
  buildClassifierSystemPrompt,
  createClassifierSnapshot,
  type AutoModeClassifierResult,
  type AutoModeClassifierDetails,
  type AutoModeUserConfig,
  type ClassifierMessage,
  type ClassifierRuntime,
  type ClassifierToolLookup,
} from './classifier.js';
import { AutoClassifierView } from './auto-classifier-view.js';
export { AutoClassifierView } from './auto-classifier-view.js';
import {
  createAutoModeDenialLog,
  type AutoModeDenial,
  type AutoModeDenialLog,
} from './denials.js';
import {
  createDangerousRuleStash,
  restoreDangerousAllowRules,
  stripDangerousAllowRules,
  type DangerousRuleStash,
} from './dangerous-rules.js';
import { runLogger } from '../../../utils/runLogger.js';
import {
  type JevAutoModeClassifierResult,
} from './jev-classifier.js';
import {
  readAutoJudgmentSettings,
  type AutoJudgmentSettings,
} from './jev-settings.js';
import type {
  TypeSafeJudgmentSettings,
} from '../../../judgment/settings.js';
import type { Judge } from '../../../judgment/types.js';
import { TypeSafeJudge } from '../../../judgment/typesafe.js';
import { customProviderRequest } from '../../../provider/custom/request.js';
import { createClassifierInvoke } from './classifier-llm.js';
import { LlmAutoJudge, JevAutoJudge, type AutoSessionJudges } from './auto-judge.js';
import type { Config } from '../../../config/config.js';
import type { PermissionRules } from '../../manager/decision/index.js';
import type { Message } from '../../../protocol/transcript/message.js';
import { raceWithAbortSignal } from '../../../utils/abort-race.js';

/** 主会话的 auto 视图 key；子 agent 用 agentId。 */
export const SESSION_AUTO_KEY = '';

export interface AutoClassifierShadowContext {
  toolCallId: string;
  toolName: string;
  isSubagent: boolean;
}

export interface AutoClassifierShadowComparison {
  compareSeq: number;
  context: AutoClassifierShadowContext;
  llm: AutoModeClassifierResult;
  jev: JevAutoModeClassifierResult;
}

type AutoClassifierShadowReporter = (
  comparison: AutoClassifierShadowComparison,
) => void;

/** 会话交给分类器的一切：调用入口、输入、规则来源与用户指令。 */
export interface AutoClassifierSession {
  readonly getSessionId: () => string;
  readonly judges?: AutoSessionJudges;
  readonly getMessages: () => readonly Message[];
  readonly getToolLookup: () => ClassifierToolLookup;
  readonly getUserConfig?: () => AutoModeUserConfig | undefined;
  readonly getUserInstructions?: () => string | undefined;
  readonly reportShadowComparison?: (
    comparison: AutoClassifierShadowComparison,
  ) => void;
  readonly isShadowReportingEnabled?: () => boolean;
}

function createUnavailableShadowResult(): JevAutoModeClassifierResult {
  return {
    shouldBlock: true,
    outcome: 'unavailable',
    unavailable: true,
    errorKind: 'other',
    reason: 'Jev shadow classification failed',
    model: 'jev',
  };
}

/** 主会话对话和工具表，由宿主提供实时读取。 */
export interface SessionClassifierInputs {
  getMessages(): readonly Message[];
  getToolLookup(): ClassifierToolLookup;
}

export class AutoClassifier {
  // ── Per-session state ───────────────────────────────────────────────────
  private readonly views = new Map<string, AutoClassifierView>();
  private readonly denialLogs = new Map<string, AutoModeDenialLog>();
  private readonly dangerousRules = new Map<string, DangerousRuleStash>();
  private readonly exitAttachments = new Set<string>();

  // ── Shared settings and shadow bookkeeping ─────────────────────────────
  private jevSettings?: AutoJudgmentSettings;
  private readonly pendingComparisons = new Set<Promise<void>>();
  private shadowCompareSeq = 0;
  private readonly shadowAbortController = new AbortController();
  private shadowDisposed = false;

  // ── Product hooks ───────────────────────────────────────────────────────

  /** 用户级 auto 判定设置；商业版提供默认 JEV 后端。 */
  protected readJevSettings(): AutoJudgmentSettings {
    return readAutoJudgmentSettings();
  }

  /** 商业版按发布开关启用 JEV；开源版始终使用配置文件。 */
  protected isJevEnabled(): boolean {
    return true;
  }

  createSessionJudges(config: Config): AutoSessionJudges {
    return {
      llm: new LlmAutoJudge(createClassifierInvoke(config)),
      jev: new JevAutoJudge({
        createJudge: async () => {
          const settings = this.getJevSettings().judgment;
          return settings
            ? new TypeSafeJudge(settings as TypeSafeJudgmentSettings, customProviderRequest)
            : undefined;
        },
        getSessionId: () => config.getSessionId(),
        getWorkspace: () => config.getTargetDir(),
        getQuestionMode: () => this.getJevSettings().jevQuestionMode,
      }),
    };
  }

  protected isShadowEnabled(): boolean {
    return false;
  }

  /** Shadow 对比的上报与开关；由产品覆写。 */
  reportShadow(
    _config: Config,
    _comparison: AutoClassifierShadowComparison,
  ): void {}

  isShadowReportingEnabled(_config: Config): boolean {
    return false;
  }

  // ── Views ───────────────────────────────────────────────────────────────

  getView(sessionId: string, agentId: string): AutoClassifierView {
    const key = `${sessionId}\u0000${agentId}`;
    let view = this.views.get(key);
    if (!view) {
      view = new AutoClassifierView(this);
      this.views.set(key, view);
    }
    return view;
  }

  releaseView(sessionId: string, agentId: string): void {
    this.views.delete(`${sessionId}\u0000${agentId}`);
  }

  disposeSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.views.keys()]) {
      if (key.startsWith(prefix)) this.views.delete(key);
    }
    this.denialLogs.delete(sessionId);
    this.dangerousRules.delete(sessionId);
    this.exitAttachments.delete(sessionId);
  }

  // ── Settings and availability ──────────────────────────────────────────

  getJevSettings(): AutoJudgmentSettings {
    return (this.jevSettings ??= this.readJevSettings());
  }

  isJevModeEnabled(): boolean {
    return this.isJevEnabled();
  }

  async getJudge(session: AutoClassifierSession): Promise<Judge | undefined> {
    return session.judges?.jev?.getJudge();
  }

  isAvailable(session: AutoClassifierSession | undefined): boolean {
    if (!session) return false;
    if (session.judges?.llm) return true;
    const settings = this.getJevSettings();
    return (
      settings.classifier === 'jev' &&
      settings.judgment !== undefined &&
      Boolean(session.judges?.jev) &&
      this.isJevEnabled()
    );
  }

  /** The classifier's system prompt, with the user's rules folded in. */
  buildSystemPrompt(userConfig?: AutoModeUserConfig): string {
    return buildClassifierSystemPrompt(userConfig);
  }

  // ── Classification ──────────────────────────────────────────────────────

  async classify(
    session: AutoClassifierSession,
    messages: ClassifierMessage[],
    toolName: string,
    input: unknown,
    toolLookup: ClassifierToolLookup,
    signal: AbortSignal,
    shadowContext?: AutoClassifierShadowContext,
  ): Promise<AutoModeClassifierResult & AutoModeClassifierDetails> {
    // One snapshot per approval, taken before the first await: every route
    // below reads the same transcript, action and rules.
    const snapshot = createClassifierSnapshot(
      this.runtime(session),
      messages,
      toolName,
      input,
      toolLookup,
    );
    const { llm, jev, shadow } = session.judges ?? {};
    const settings = this.getJevSettings();
    const judgeEnabled =
      settings.classifier === 'jev' ? this.isJevEnabled() : false;
    // Re-read host enablement so a cached Judge cannot outlive a runtime disable.
    if (judgeEnabled && settings.judgment !== undefined && jev) {
      const started = Date.now();
      const verdict = await jev.judge(snapshot, signal);
      if (!verdict.unavailable || signal.aborted || !llm) {
        return { ...verdict, route: 'jev' };
      }
      const fallbackReason = verdict.transcriptTooLong
        ? ('jev-input-too-long' as const)
        : ('jev-unavailable' as const);
      runLogger.log('Auto classifier: Jev unavailable; falling back to LLM', {
        model: verdict.model,
        fallbackReason,
      });
      const fallback = await llm.judge(snapshot, signal);
      return {
        ...fallback,
        route: 'jev_fallback_llm',
        fallbackReason,
        durationMs: Date.now() - started,
      };
    }

    if (!llm) {
      return {
        shouldBlock: true,
        unavailable: true,
        reason: 'Classifier invoke function not configured',
        model: 'none',
        route: 'llm',
      };
    }

    let shadowEnabled = false;
    try {
      shadowEnabled =
        Boolean(shadow) &&
        this.isShadowEnabled() &&
        !this.shadowDisposed &&
        Boolean(shadowContext) &&
        Boolean(session.reportShadowComparison) &&
        session.isShadowReportingEnabled?.() === true;
    } catch {
      shadowEnabled = false;
    }
    if (!shadowEnabled || !shadowContext) {
      return {
        ...(await llm.judge(snapshot, signal)),
        route: 'llm',
      };
    }

    const shadowCompareSeq = ++this.shadowCompareSeq;
    const shadowSignal = AbortSignal.any([
      signal,
      this.shadowAbortController.signal,
    ]);
    const shadowJev = raceWithAbortSignal(
      Promise.resolve().then(() => shadow!.judge(snapshot, shadowSignal)),
      shadowSignal,
    ).catch(
      (): JevAutoModeClassifierResult => ({
        ...createUnavailableShadowResult(),
        ...(shadowSignal.aborted ? { outcome: 'aborted' as const } : {}),
      }),
    );
    const llmResultPromise = llm.judge(snapshot, signal, true);
    // Track before awaiting the LLM so disposal also covers an in-flight check.
    // Only the observation is cancelled here; the caller still owns the LLM.
    const observedLlm = raceWithAbortSignal(
      llmResultPromise,
      this.shadowAbortController.signal,
    ).catch(
      (): AutoModeClassifierResult => ({
        shouldBlock: true,
        unavailable: true,
        aborted: this.shadowAbortController.signal.aborted,
        reason: 'LLM comparison unavailable',
        model: 'configured',
      }),
    );
    const report: AutoClassifierShadowReporter | undefined =
      session.reportShadowComparison;
    const pending = Promise.all([observedLlm, shadowJev])
      .then(([llmResult, jev]) => {
        report?.({
          compareSeq: shadowCompareSeq,
          context: shadowContext,
          llm: llmResult,
          jev,
        });
      })
      .catch(() => {})
      .finally(() => this.pendingComparisons.delete(pending));
    this.pendingComparisons.add(pending);
    return { ...(await llmResultPromise), route: 'llm' };
  }

  private runtime(session: AutoClassifierSession): ClassifierRuntime {
    return {
      invokeFn: null,
      userConfig: session.getUserConfig?.(),
      userInstructions: session.getUserInstructions?.(),
    };
  }

  async dispose(): Promise<void> {
    this.shadowDisposed = true;
    if (this.pendingComparisons.size === 0) return;
    this.shadowAbortController.abort();
    // Abort races settle even if a provider ignores cancellation. Emit the
    // terminal comparison before the session's final stats flush.
    await Promise.all(this.pendingComparisons);
  }

  // ── Mode transition ─────────────────────────────────────────────────────

  setNeedsExitAttachment(sessionId: string, needed: boolean): void {
    if (needed) this.exitAttachments.add(sessionId);
    else this.exitAttachments.delete(sessionId);
  }

  /** One-shot: a second call returns false unless the session leaves Auto again. */
  consumeNeedsExitAttachment(sessionId: string): boolean {
    return this.exitAttachments.delete(sessionId);
  }

  // ── Denial counters and refusals ────────────────────────────────────────

  resetDenialTrackers(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const [key, view] of this.views) {
      if (key.startsWith(prefix)) view.resetTracker();
    }
  }

  recordDenial(sessionId: string, denial: AutoModeDenial): void {
    let log = this.denialLogs.get(sessionId);
    if (!log) {
      log = createAutoModeDenialLog();
      this.denialLogs.set(sessionId, log);
    }
    log.record(denial);
  }

  getDenials(sessionId: string): readonly AutoModeDenial[] {
    return this.denialLogs.get(sessionId)?.getAll() ?? [];
  }

  clearDenials(sessionId: string): void {
    this.denialLogs.get(sessionId)?.clear();
  }

  // ── Dangerous allow rules ───────────────────────────────────────────────

  stripDangerousAllowRules(
    sessionId: string,
    rules: PermissionRules,
  ): PermissionRules {
    return stripDangerousAllowRules(this.dangerousRuleStash(sessionId), rules);
  }

  restoreDangerousAllowRules(
    sessionId: string,
    rules: PermissionRules,
  ): PermissionRules {
    return restoreDangerousAllowRules(this.dangerousRuleStash(sessionId), rules);
  }

  private dangerousRuleStash(sessionId: string): DangerousRuleStash {
    let stash = this.dangerousRules.get(sessionId);
    if (!stash) {
      stash = createDangerousRuleStash();
      this.dangerousRules.set(sessionId, stash);
    }
    return stash;
  }
}
