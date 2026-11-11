/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';
import {
  PermissionModes,
  composeMcpRuleName,
  type PermissionMode,
} from './decision/index.js';
import type {
  HostToolChecker,
  ToolPermissionResult,
} from '../../tools/tool-checkers/rule-precedence.js';
import {
  isBypassImmune,
  isSafetyObjection,
  stampPoint,
  withHookAsk,
  withToolLevelRules,
} from '../../tools/tool-checkers/rule-precedence.js';
import {
  DONT_ASK_REJECT_MESSAGE,
  isUnskippable,
} from '../../tools/tool-checkers/mode-layer.js';
import type { SessionMcpManager } from '../../mcp/sessionMcpManager/sessionMcpManager.js';
import {
  normalizeMcpSegment,
  parseMcpToolName,
} from '../../mcp/tools/mcp-names.js';
import {
  createMcpToolChecker,
  type McpToolIdentity,
} from '../../tools/tool-checkers/checkers/mcp-checker.js';
import { SettingsManagedPolicy } from './managed-policy.js';
import { toSkillCheckerDeps } from '../config-checker-deps.js';
import {
  createGlobalCheckerMap,
  createGlobalCheckerDeps,
} from './global-checkers.js';
import { SessionPermissionManager } from './session-permission-manager.js';
import { AutoClassifier } from '../permission-modes/auto/auto-classifier.js';
import type { SessionPermissionOptions } from './types.js';
import type {
  Checker,
  FlagSettings,
  ManagedPolicy,
  PermissionModeDefinition,
  Scene,
} from './types.js';
import { qwenInternalPathDeps } from '../../tools/filesystem-permissions/internal-path-deps.js';

export interface PermissionManagerInput {
  readonly settings?: SettingsService;
  readonly pluginCheckers?: ReadonlyMap<string, HostToolChecker>;
}

export type PermissionManagerFactory = (
  input: PermissionManagerInput,
) => PermissionManager;

export interface SessionPermissionContext {
  /** 会话身份实时读取；resume / 切换会话后自动跟随。 */
  readonly getSessionId: () => string;
  /** 会话当前工作目录；每次判定实时读取。 */
  readonly getWorkingDir: () => string;
  readonly flagSettings: FlagSettings;
  readonly sessionMcpManager?: SessionMcpManager;
  /** 为直接注册的 MCP 工具构造 checker；会话按 MCP 工具表变化实时同步。 */
  readonly createMcpToolChecker?: (
    entry: import('../../mcp/sessionMcpManager/types.js').LazyMcpToolEntry,
  ) => HostToolChecker;
  /** 会话的 SkillManager 视图；Skill checker 的会话依赖。 */
  readonly skill?: import('../../skills/skillManager.js').SkillManager | import('../../tools/tool-checkers/content-checkers.js').SkillCheckerDeps;
  readonly toolNameAliases?: Record<string, string>;
  /** 会话设置来源的模式限制；全局托管限制由 modes.isAvailable 负责。 */
  readonly permissionSettings?: SessionPermissionOptions['permissionSettings'];
  readonly createSessionJudges?: SessionPermissionOptions['createSessionJudges'];
  readonly autoModeUserConfig?: SessionPermissionOptions['autoModeUserConfig'];
  readonly autoModeUserInstructions?: SessionPermissionOptions['autoModeUserInstructions'];
  readonly reportAutoShadowComparison?: SessionPermissionOptions['reportAutoShadowComparison'];
  readonly isAutoShadowReportingEnabled?: SessionPermissionOptions['isAutoShadowReportingEnabled'];
  /** 会话 transcript 与工具表；每次判定随会话配置传给分类器。 */
  readonly classifierInputs?: SessionPermissionOptions['classifierInputs'];
  readonly getSessionModeRestriction?: (
    mode: PermissionMode,
  ) => string | undefined;
}

/**
 * 模式只负责把 ask 落定，逐条复刻原 mode layer 的语义：Default 仍为文件
 * 编辑补 AcceptEdits 建议，AcceptEdits 仍拒绝 safety/hook 不适用项，Auto
 * 把分类器交给会话注入的视图。
 */
export function createPermissionModes(
  managedPolicy: ManagedPolicy,
): Record<PermissionMode, PermissionModeDefinition> {
  const modes = {
    [PermissionModes.Default]: {
      resolve: (ask, ctx) =>
        ctx.coveredByAcceptEdits === true ||
        ask.extra?.acceptEditsEligible === true
          ? {
              ...ask,
              suggestions: [
                ...(ask.suggestions ?? []),
                {
                  type: 'setMode',
                  destination: 'session',
                  mode: PermissionModes.AcceptEdits,
                },
              ],
            }
          : ask,
      isAvailable: () => ({ ok: true }),
    },
    [PermissionModes.AcceptEdits]: {
      resolve: (ask, ctx) => {
        if (isUnskippable(ask)) {
          return stampPoint(ask, 'mode.needs_user.keep_ask');
        }
        if (isSafetyObjection(ask)) {
          return stampPoint(ask, 'mode.safety_objection.keep_ask');
        }
        if (
          (ctx.coveredByAcceptEdits !== true &&
            ask.extra?.acceptEditsEligible !== true) ||
          ask.reason.attribution.type === 'hook'
        ) {
          return stampPoint(ask, 'mode.accept_edits.ineligible.keep_ask');
        }
        return {
          kind: 'allow',
          extra: {
            ...ask.extra,
            decisionPoint: 'mode.accept_edits.allow',
          },
        };
      },
      isAvailable: () => ({ ok: true }),
    },
    [PermissionModes.DontAsk]: {
      resolve: (ask, _ctx) => {
        const decisionPoint = 'mode.dont_ask.deny';
        return {
          kind: 'deny',
          extra: {
            ...ask.extra,
            decisionPoint,
            denialReason: {
              message: DONT_ASK_REJECT_MESSAGE,
              attribution: {
                type: 'mode',
                mode: PermissionModes.DontAsk,
              },
              denialKind: 'permission-rule',
              decisionPoint,
            },
          },
        };
      },
      isAvailable: () => ({ ok: true }),
    },
    [PermissionModes.Yolo]: {
      resolve: (ask) => {
        if (isUnskippable(ask)) {
          return stampPoint(ask, 'mode.needs_user.keep_ask');
        }
        if (isBypassImmune(ask)) {
          return stampPoint(ask, 'mode.bypass_immune.keep_ask');
        }
        return {
          kind: 'allow',
          extra: { ...ask.extra, decisionPoint: 'mode.yolo.allow' },
        };
      },
      isAvailable: () => ({ ok: true }),
    },
    [PermissionModes.Auto]: {
      resolve: async (ask, ctx) => {
        if (isUnskippable(ask)) {
          return stampPoint(ask, 'mode.needs_user.keep_ask');
        }
        const autoClassifier = ctx.autoClassifier;
        if (!autoClassifier || !ctx.toolCheckContext) {
          const decisionPoint = 'mode.auto_unavailable.deny';
          return {
            kind: 'deny',
            extra: {
              ...ask.extra,
              decisionPoint,
              denialReason: {
                message:
                  'Auto mode has no classifier available, so this action cannot be approved without prompting.',
                attribution: {
                  type: 'mode',
                  mode: PermissionModes.Auto,
                },
                denialKind: 'permission-rule',
                decisionPoint,
              },
            },
          };
        }
        return autoClassifier.classify(
          {
            toolName: ctx.toolName,
            coveredByAcceptEdits: ctx.coveredByAcceptEdits === true,
          },
          ctx.input,
          ctx.toolCheckContext,
          ask,
          ctx.messages,
          ctx.autoSession,
        ) as Promise<ToolPermissionResult>;
      },
      isAvailable: () => ({ ok: true }),
    },
  } as Record<PermissionMode, PermissionModeDefinition>;
  for (const mode of Object.keys(modes) as PermissionMode[]) {
    const definition = modes[mode];
    modes[mode] = {
      ...definition,
      isAvailable: () => {
        const restriction = managedPolicy.getModeRestriction(mode);
        return restriction
          ? {
              ok: false,
              reason: 'enterprise_policy',
              message:
                restriction.message ?? `Permission mode "${mode}" is disabled by global policy.`,
            }
          : definition.isAvailable();
      },
    };
  }
  return modes;
}

export class PermissionManager {
  protected readonly settings?: SettingsService;
  protected checkerMap!: Map<Scene, Map<string, Checker>>;
  protected modes!: Record<PermissionMode, PermissionModeDefinition>;
  protected managedPolicy!: ManagedPolicy;
  protected autoClassifier!: AutoClassifier;

  protected readonly pluginCheckers: ReadonlyMap<string, HostToolChecker>;
  private readonly dynamicCheckers = new Map<string, Checker>();
  private readonly sceneCheckerMap = new Map<
    Scene,
    Map<string, HostToolChecker>
  >();

  constructor(
    settings?: SettingsService,
    pluginCheckers: ReadonlyMap<string, HostToolChecker> = new Map(),
  ) {
    this.settings = settings;
    this.pluginCheckers = pluginCheckers;
  }

  /**
   * 所有产品可替换的成员都在这里落定：托管策略、checker 表、模式与分类器。
   * 商业版整体覆写本方法，而不是覆写各自的工厂方法。
   */
  initialize(): void {
    this.managedPolicy = new SettingsManagedPolicy(this.settings);
    this.checkerMap = new Map([
      [
        'main',
        createGlobalCheckerMap(
          'main',
          createGlobalCheckerDeps(qwenInternalPathDeps),
          this.pluginCheckers,
        ),
      ],
      [
        'probe',
        createGlobalCheckerMap(
          'probe',
          createGlobalCheckerDeps(qwenInternalPathDeps),
          this.pluginCheckers,
        ),
      ],
    ]);
    this.modes = createPermissionModes(this.managedPolicy);
    this.autoClassifier = new AutoClassifier();
  }

  getChecker(
    scene: Scene,
    toolName: string,
    _mcp?: SessionMcpManager,
  ): Checker | undefined {
    return (
      this.checkerMap.get(scene)?.get(toolName) ??
      this.createDynamicChecker(scene, toolName)
    );
  }

  protected createDynamicChecker(
    scene: Scene,
    toolName: string,
  ): Checker | undefined {
    const cached = this.dynamicCheckers.get(toolName);
    if (cached) return cached;

    const parsed = parseMcpToolName(toolName);
    if (!parsed.serverName || !parsed.toolName) return undefined;
    const identity: McpToolIdentity = {
      serverName: parsed.serverName,
      toolName: parsed.toolName,
    };
    const qualified = composeMcpRuleName(
      normalizeMcpSegment(identity.serverName),
      normalizeMcpSegment(identity.toolName),
    );
    const checker = withHookAsk(
      withToolLevelRules(qualified, createMcpToolChecker(identity)),
    );
    this.dynamicCheckers.set(toolName, checker);
    return checker;
  }

  /** 插件在会话创建前注册的 checker 追加进全局表。 */
  registerChecker(toolName: string, checker: Checker): void {
    this.assertInitialized();
    for (const scene of this.checkerMap.values()) {
      scene.set(toolName, checker);
    }
  }

  getModes(): Record<PermissionMode, PermissionModeDefinition> {
    this.assertInitialized();
    return this.modes;
  }

  getManagedPolicy(): ManagedPolicy {
    this.assertInitialized();
    return this.managedPolicy;
  }

  getAutoClassifier(): AutoClassifier {
    this.assertInitialized();
    return this.autoClassifier;
  }

  /** 托管策略内容变化；由策略对象自己的更新通道驱动。 */
  subscribePolicyChanges(listener: () => void): () => void {
    return this.managedPolicy?.subscribe?.(listener) ?? (() => {});
  }

  /** 为 fork/隔离场景维护一张完整 checker 表；会话只读同一份。 */
  registerSceneCheckers(
    scene: Scene,
    checkers: ReadonlyMap<string, HostToolChecker>,
  ): void {
    this.sceneCheckerMap.set(scene, new Map(checkers));
  }

  unregisterSceneCheckers(scene: Scene): void {
    this.sceneCheckerMap.delete(scene);
  }

  createSessionPermissionManager(
    input: SessionPermissionContext,
  ): SessionPermissionManager {
    this.assertInitialized();

    return new SessionPermissionManager({
      autoClassifier: this.autoClassifier,
      managedPolicy: this.managedPolicy,
      getSessionId: input.getSessionId,
      getWorkingDir: input.getWorkingDir,
      rules: input.flagSettings.rules,
      modes: this.modes,
      getChecker: (scene, toolName) =>
        this.getChecker(scene, toolName, input.sessionMcpManager),
      sceneCheckers: this.sceneCheckerMap,
      sessionMcpManager: input.sessionMcpManager,
      createMcpToolChecker: input.createMcpToolChecker,
      initialMode: input.flagSettings.initialMode,
      directories: {
        additional: input.flagSettings.additionalDirectories,
      },
      classifierInputs: input.classifierInputs,
      skill: input.skill === undefined ? undefined : toSkillCheckerDeps(input.skill),
      toolNameAliases: input.toolNameAliases,
      permissionSettings: input.permissionSettings,
      createSessionJudges: input.createSessionJudges,
      autoModeUserConfig: input.autoModeUserConfig,
      autoModeUserInstructions: input.autoModeUserInstructions,
      reportAutoShadowComparison: input.reportAutoShadowComparison,
      isAutoShadowReportingEnabled: input.isAutoShadowReportingEnabled,
      getSessionModeRestriction: input.getSessionModeRestriction,
    });
  }

  dispose(): void {
    this.dynamicCheckers.clear();
    this.managedPolicy?.dispose();
    void this.autoClassifier?.dispose();
  }

  private assertInitialized(): void {
    if (!this.modes) {
      throw new Error('PermissionManager not initialized');
    }
  }
}
