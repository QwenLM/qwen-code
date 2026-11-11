/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * daemon 宿主的内部接缝。
 */

export type { CliArgs } from './src/config/config.js';
export {
  applyEnvironmentDefaults,
  getStringArg,
} from './src/config/cliEnvironment.js';
export { permissionModeIdToSdk } from './src/session/permissionMode.js';
export { normalizePermissionModeValue } from './src/config/permissionMode.js';
export {
  coerceCommaSeparated,
  coerceOptionalStringFlag,
} from './src/utils/coerce.js';
export { isStdioPermissionPromptTool } from './src/utils/headlessPermissionPrompt.js';
export { isRecord } from './src/utils/settingsUtils.js';
export { WIRE_PROTOCOL_CAPABILITIES } from './src/utils/nonInteractiveOutput.js';
export { buildErrorResultMessage } from './src/utils/errors.js';
export type { StdoutMessage } from './src/utils/controlProtocol.js';
export type { SessionModelInfo } from './src/session/sessionModels.js';
export {
  getCanUseToolClassifierApprovable,
  serializeCanUseToolDecisionReason,
  serializeCanUseToolDecisionReasonType,
} from './src/utils/toolPermissionReason.js';
export type { CanUseToolDecisionReasonType } from './src/utils/toolPermissionReason.js';
export { getCanUseToolPresentation } from './src/utils/canUseToolPresentation.js';

export { logAsyncPhase } from './src/thread-manager/logAsyncPhase.js';
export {
  findSessionIdArg,
  findSessionIdOnlyArg,
  hasForkSessionArg,
} from './src/thread-manager/sessionIdArgs.js';
export { ThreadSessionAlreadyOpenError } from './src/thread-manager/sessionAlreadyOpenError.js';
export { ThreadCapabilityError } from './src/thread-manager/thread-session/contract/handlerContract.js';
export { SessionPhaseLog } from './src/thread-manager/thread-session/phase-log/sessionPhaseLog.js';
export type { SessionEndCloseoutView } from './src/thread-manager/thread-session/host/sessionEndCloseout.js';
export type { McpControlResult } from './src/thread-manager/thread-session/host/sessionMcpControl.js';
export { renderStreamJsonInitMessage } from './src/thread-manager/thread-session/initialize/sessionInitFrame.js';
export {
  isStringProp,
  normalizeProtocolError,
} from './src/thread-manager/support/protocolError.js';

export {
  buildNativeSdkMemoryConsumptionResult,
  buildSdkMemoryPermissionUpdates,
  buildSdkMemoryPrompt,
  loadSdkMemoryConsumption,
  parseSdkMemoryConfig,
  prepareSdkMemoryRoots,
  resolveSdkMemoryEnablement,
} from './src/sdkMemory.js';
export type {
  SdkMemoryConfig,
  SdkMemoryConsumptionFileState,
  SdkMemoryConsumptionResult,
  SdkMemoryRoot,
} from './src/sdkMemory.js';
export {
  parseSdkEvolutionConfig,
  resolveSdkSkillEvolutionEnablement,
} from './src/sdkSkillEvolution.js';
export type { SdkSkillEvolutionConfig } from './src/sdkSkillEvolution.js';
export { collectActiveSkillEvolutionContext } from './src/services/skillEvolutionContext.js';

export type { ThreadHostTokenSource } from './src/thread-manager/thread-session/contract/hostTokenSource.js';

export {
  buildLiveSessionModelList,
  buildSessionModelList,
} from './src/session/buildSessionModelList.js';

/** 插件校验依赖整棵插件管理链，保持按需加载，避免 daemon 空闲期付这份模块图。 */
export async function loadDaemonPluginValidation() {
  return import('@qwen-code/core/plugin-management');
}

export {
  exitAfterConfirmedCliCrash,
  gracefulExit,
  getExitCleanupTimeoutMs,
  registerExitCancellation,
  runExitCleanupWithTimeout,
} from './src/utils/cleanup.js';
export { logRouteEntered } from './src/startup/route/routeLogging.js';
export { SdkServer, type SdkServerParams } from './src/sdk/sdkServer.js';

/**
 * 延迟加载整棵命令树：daemon 入口与 session 参数解析共用同一份 root option 事实源，
 * 但只有真正创建 worker argv 模板时才付命令树的加载代价。
 */
export async function createRootCommandTemplate() {
  const { createCommand } = await import('./src/commands/index.js');
  return createCommand();
}

// Native tools and hooks used by the product session binding.
export { PresentFilesTool } from './src/session/artifacts/presentFilesTool.js';
export { PRESENT_FILES_TOOL_NAME } from './src/session/artifacts/artifactProtocol.js';
export { parseContextWindowControlValue } from './src/session/contextWindow.js';
export { attachSessionHookEvents } from './src/thread-manager/thread-session/turn/sessionHookEvents.js';
export type { HistoryItemWithoutId } from './src/ui/types.js';

export { initializeSessionConfigHome } from './src/startup/sessionConfigHome.js';
export { applyConfigDirFlagFromArgv } from './src/config/configDirFlag.js';
