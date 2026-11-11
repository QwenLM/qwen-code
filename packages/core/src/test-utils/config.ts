/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermissionManager, createPermissionModes } from '../permissions/manager/permission-manager.js';
import { createClassifierInputsForConfig } from '../permissions/config-checker-deps.js';
import {
  ACCEPT_EDITS_TOOL_NAMES,
  createToolCheckerMap,
  type ToolCheckerRegistryDeps,
} from '../tools/tool-checkers/checker-registry.js';
import type { HostToolChecker } from '../tools/tool-checkers/rule-precedence.js';
import type { SessionPermissionManager } from '../permissions/manager/session-permission-manager.js';
import {
  PermissionModes,
  type PermissionMode,
  type PermissionRules,
} from '../permissions/manager/decision/index.js';
import type { PermissionOptions } from '../permissions/manager/decision/types/options.js';
import type {
  CheckPermissionOptions,
  PermissionDecision,
  PermissionRequest,
  ToolPermissionChecker,
} from '../permissions/manager/decision/index.js';
import type { PermissionContext } from '../permissions/manager/types.js';
import type {
  HostAskHandler,
  ToolPermissionReason,
} from '../tools/tool-checkers/checker-reasons.js';
import type { PermissionPolicySnapshot } from '../permissions/manager/policy.js';
import type { ManagedPolicy } from '../permissions/manager/types.js';
import { LoadedSettings, type MergedSettings } from '@qwen-code/resource';

import { Config, type ConfigParameters } from '../config/config.js';

/** Creates an isolated in-memory settings projection for tests. */
export function createEmptyLoadedSettings(): LoadedSettings {
  const emptyFile = () => ({
    path: '',
    settings: {},
    originalSettings: {},
    readOnly: true,
  });
  return new LoadedSettings(
    {
      merge: (user, project, trusted, local, flag) =>
        ({
          ...user,
          ...(trusted ? project : {}),
          ...(trusted ? local : {}),
          ...flag,
        }) as MergedSettings,
      runtimeValues: (value) => value,
      normalizeOriginal: () => {},
      resolveEnvironment: (value) => value,
      normalizeDisplaySettings: () => {},
      readFile: () => ({ settings: {}, originalSettings: {} }),
    },
    emptyFile(),
    emptyFile(),
    emptyFile(),
    false,
  );
}

/**
 * Default parameters used for {@link FAKE_CONFIG}
 */
export const DEFAULT_CONFIG_PARAMETERS: ConfigParameters = {
  get loadedSettings() {
    return createEmptyLoadedSettings();
  },
  debugMode: false,
  sessionId: 'test-session-id',
  proxy: undefined,
  model: 'gemini-9001-super-duper',
  targetDir: '/',
  cwd: '/',
};

/**
 * Produces a config.  Default parameters are set to
 * {@link DEFAULT_CONFIG_PARAMETERS}, optionally, fields can be specified to
 * override those defaults.
 */
export function makeFakeConfig(
  config: Partial<ConfigParameters> = {},
): Config {
  const instance = new Config({ ...DEFAULT_CONFIG_PARAMETERS, ...config });
  attachTestPermission(instance);
  return instance;
}

export function attachTestPermission(config: Config): void {
  class TestPermissionManager extends PermissionManager {
    constructor() { super(); this.initialize(); }
  }
  setTestSessionPermission(
    config,
    new TestPermissionManager().createSessionPermissionManager({
      getSessionId: () => config.getSessionId(),
      getWorkingDir: () => config.getWorkingDir(),
      flagSettings: { initialMode: config.getPermissionMode(), rules: { allow: {}, deny: {}, ask: {} }, additionalDirectories: [] },
      classifierInputs: createClassifierInputsForConfig(config),
    }),
  );
}

/**
 * 测试专用：安装会话权限对象。生产侧不再有 permission setter——会话权限只由
 * Config 初始化时自建；测试需要预置或替换该对象时统一走这里。
 */
export function setTestSessionPermission(
  config: Config,
  permission: SessionPermissionManager | undefined,
): void {
  Object.defineProperty(config, 'permission', {
    value: permission,
    configurable: true,
    writable: true,
  });
}


/**
 * 测试用模式层：把裸 checker 的 ask 交给会话同一份模式定义落定。
 * 生产不再有 checker 内置模式层，直接 `.check` 的测试用它补齐。
 */
export function withSessionModeForTest(
  checker: HostToolChecker,
  toolName: string,
  options: {
    autoClassifier?: import('../permissions/manager/decision/index.js').AutoClassifierView<ToolPermissionReason>;
  } = {},
): HostToolChecker {
  const modes = createPermissionModes(createTestManagedPolicy());
  const coveredByAcceptEdits = ACCEPT_EDITS_TOOL_NAMES.has(toolName);
  return {
    async check(input, ctx) {
      const result = await checker.check(input, ctx);
      if (result.kind !== 'ask') return result;
      return modes[ctx.mode].resolve(result, {
        mode: ctx.mode,
        toolName,
        input,
        rules: ctx.rules,
        signal: ctx.signal,
        toolCheckContext: ctx,
        coveredByAcceptEdits,
        autoClassifier: options.autoClassifier,
      });
    },
  };
}

// ── Permission test doubles ─────────────────────────────────────────────────

/** 测试专用策略 key；真实 channel 由商业构建侧维护。 */
export const TEST_POLICY_KEY = 'global_permissions';

type PolicySource = {
  getValue<T>(key: string): T | undefined;
};

function createTestManagedPolicy(source?: PolicySource): ManagedPolicy {
  return {
    getRules() {
      const policy = source?.getValue<PermissionPolicySnapshot>(TEST_POLICY_KEY);
      return {
        allow: {},
        deny: policy?.rules ? { policySettings: [...policy.rules.deny] } : {},
        ask: policy?.rules ? { policySettings: [...policy.rules.ask] } : {},
      };
    },
    getModeRestriction(mode) {
      const policy = source?.getValue<PermissionPolicySnapshot>(TEST_POLICY_KEY);
      if (!policy?.disabledModes.includes(mode)) return undefined;
      return { message: policy.disabledModeMessages?.[mode] };
    },
    dispose() {},
  };
}

export type TestPermissionManager = SessionPermissionManager & {
  readonly permissionManager?: PermissionManager;
};

export interface TestPermissionOptions {
  manager?: PermissionManager;
  builtinToolCheckers?: ReadonlyMap<string, HostToolChecker>;
  cwd: string;
  getWorkingDir?: () => string;
  permissionMode?: PermissionMode;
  rules?: PermissionRules;
  additionalDirectories?: string[];
  checkerDeps: ToolCheckerRegistryDeps;
  askHandler?: HostAskHandler;
  /** 测试用组织策略读取面；真实 QCS 通道只在商业构建侧。 */
  organizationPolicy?: PolicySource;
  /** 测试用 Auto 模式落定；替代会话分类器，仅用于验收模式层行为。 */
  resolveAuto?: import('../permissions/permission-modes/auto/auto-classifier-view.js').AutoClassifierView['classify'];
}

export function emptyPermissionRules(): PermissionRules {
  return { allow: {}, deny: {}, ask: {} };
}

export function createPermissionManager(
  options: TestPermissionOptions,
): TestPermissionManager {
  const source = options.organizationPolicy;
  let global: PermissionManager;
  if (source) {
    const policySource = source;
    class TestManager extends PermissionManager {
      static initialized() {
        const manager = new TestManager();
        manager.initialize();
        return manager;
      }
      override initialize() {
        super.initialize();
        const create = () =>
          createToolCheckerMap(
            options.checkerDeps,
            options.builtinToolCheckers,
          );
        this.registerSceneCheckers('main', create());
        this.registerSceneCheckers('probe', create());
        this.managedPolicy = createTestManagedPolicy(policySource);
        this.modes = createPermissionModes(this.managedPolicy);
      }
    }
    global = TestManager.initialized();
  } else {
    global = options.manager ?? new PermissionManager();
    if (options.manager === undefined) global.initialize();
    const create = () =>
      createToolCheckerMap(
        options.checkerDeps,
        options.builtinToolCheckers,
      );
    global.registerSceneCheckers('main', create());
    global.registerSceneCheckers('probe', create());
  }
  const getWorkingDir = options.getWorkingDir ?? (() => options.cwd);
  if (options.resolveAuto) {
    const resolveAuto = options.resolveAuto;
    const modes = global.getModes();
    modes[PermissionModes.Auto] = {
      ...modes[PermissionModes.Auto],
      resolve: (ask, ctx) => {
        if (
          ask.reason.attribution.type === 'managedRule' ||
          ask.reason.attribution.type === 'interaction'
        ) {
          return ask;
        }
        return resolveAuto(
          {
            toolName: ctx.toolName,
            coveredByAcceptEdits: ACCEPT_EDITS_TOOL_NAMES.has(ctx.toolName),
          },
          ctx.input,
          ctx.toolCheckContext!,
          ask,
        );
      },
    };
  }
  const session = global.createSessionPermissionManager({
    getSessionId: () => '',
    getWorkingDir,
    flagSettings: {
      initialMode: options.permissionMode ?? PermissionModes.Default,
      rules: options.rules ?? emptyPermissionRules(),
      additionalDirectories: options.additionalDirectories ?? [],
    },
    skill: options.checkerDeps.skill,
  });
  session.setAskHandler(options.askHandler);

  // 测试装配的旧约定：表里没有的工具默认放行，不让装配遗漏变拒绝。
  const innerCheck = session.check.bind(session);
  session.check = async (request, input) => {
    try {
      return await innerCheck(request, input);
    } catch (error) {
      if ((error as Error | undefined)?.name !== 'UnregisteredToolError') {
        throw error;
      }
      return {
        kind: 'allow' as const,
        decidedBy: 'toolCheck' as const,
        toolName: request.toolName,
        input: request.input,
        toolUseId: request.toolUseId,
        toolCheck: {
          kind: 'allow' as const,
          extra: { decisionPoint: 'unregistered_tool_fallback.allow' },
        },
        history: [],
        stages: [{ stage: 'toolCheck' as const, verdict: 'allow' as const }],
      };
    }
  };

  return Object.assign(session, { permissionManager: global });
}

/**
 * 用一张完整 checker 表构造隔离会话：测试与 fork 之外的宿主装配使用。
 * 规则、模式、目录都直接落到会话对象上，不经过全局 checker 发现。
 */
export function createIsolatedPermissionSession(
  options: PermissionOptions<ToolPermissionReason>,
): SessionPermissionManager {
  const manager = new PermissionManager();
  manager.initialize();
  const checkers = options.toolCheckerMap as unknown as ReadonlyMap<
    string,
    HostToolChecker
  >;
  manager.registerSceneCheckers('main', checkers);
  manager.registerSceneCheckers('probe', checkers);
  const session = manager.createSessionPermissionManager({
    getSessionId: () => '',
    getWorkingDir: () => options.cwd,
    flagSettings: {
      initialMode: options.permissionMode,
      rules: options.rules,
      additionalDirectories: options.additionalDirectories,
    },
    toolNameAliases: options.toolNameAliases,
  });
  session.setAskHandler(options.askHandler);

  return session;
}


// ── Compatibility helpers for tests authored around the removed internals ──

export async function checkWithOverride(
  permission: SessionPermissionManager,
  request: PermissionRequest,
  override?: CheckPermissionOptions<ToolPermissionReason>,
  _resolver?: () => ToolPermissionChecker<ToolPermissionReason> | undefined,
): Promise<PermissionDecision<ToolPermissionReason>> {
  const context = {
    ...(override?.rules !== undefined ? { rules: override.rules } : undefined),
    ...(override?.additionalRules !== undefined
      ? { additionalRules: override.additionalRules }
      : undefined),
    ...(override?.additionalDirectories !== undefined
      ? { additionalDirectories: override.additionalDirectories }
      : undefined),
    ...(override?.permissionMode !== undefined
      ? { mode: override.permissionMode }
      : undefined),
  };
  const checkedRequest = override?.preToolUseHookVerdict
    ? { ...request, preToolUseHookVerdict: override.preToolUseHookVerdict }
    : request;
  if (!override?.askHandler) return permission.check(checkedRequest, context);
  // Test-only access avoids adding a production getter for the removed override API.
  const previousHandler = Reflect.get(permission, 'askHandler') as
    | HostAskHandler
    | undefined;
  // ToolCheck captures the handler synchronously; restore before awaiting approval.
  permission.setAskHandler(override.askHandler as unknown as HostAskHandler);
  try {
    return permission.check(checkedRequest, context);
  } finally {
    permission.setAskHandler(previousHandler);
  }
}

export function recheckWithApproval(
  permission: SessionPermissionManager,
  request: PermissionRequest,
  _approved: PermissionDecision<ToolPermissionReason>,
  context?: PermissionContext,
): Promise<PermissionDecision<ToolPermissionReason>> {
  return permission.check(
    request,
    context,
  );
}
