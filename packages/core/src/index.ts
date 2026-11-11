/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { StartupDiagnostics } from './startup/startupDiagnostics.js';
export type {
  StartupPhaseObservation,
  StartupPhaseObserver,
} from './startup/startupDiagnostics.js';

export type {
  Model,
  ModelConfig,
  ModelContextConfig,
  ModelReasoningConfig,
  ModelSamplingConfig,
  ModelThinkingConfig,
} from './provider/model/model.js';
export { resolveModelName } from './provider/model/resolveModelName.js';
export {
  assertModelConfigSupported,
  mergeModelConfig,
  resolveSelectedModelConfig,
} from './provider/model/modelConfig.js';

export type { ModelConfigurator } from './provider/model/modelConfigurator.js';
export type {
  ModelSelection,
  ModelSelectResult,
} from './provider/model/modelSelection.js';
export type {
  ModelSelectionPolicy,
  PrepareModelSelection,
} from './provider/model/modelSelector.js';
export type {
  ModelPurpose,
  ModelSelectContext,
  CompactModelSelectContext,
} from './provider/model/modelSelectContext.js';
export type {
  ModelCacheControl,
  ModelExecutionControl,
  ModelStreamTextBlock,
  ModelImageBlock,
  ModelInputContentBlock,
  ModelStreamSystemContent,
  ModelStreamUserContent,
  ModelStreamAssistantContent,
  ModelStreamToolResultContent,
  ModelStreamRequest,
  ModelPrompt,
  ModelToolChoice,
  ModelStreamMessage,
  ModelStreamSystemMessage,
  ModelStreamUserMessage,
  ModelStreamAssistantMessage,
  ModelStreamToolResultMessage,
  ModelStreamToolCall,
  ModelStreamTool,
} from './provider/modelStreamRequest.js';
export type {
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageDeltaEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelSignatureBlockDeltaEvent,
  ModelStopReason,
  ModelStreamEvent,
  ModelStreamUsage,
  ModelTextBlockDeltaEvent,
  ModelTextBlockStartEvent,
  ModelThinkingBlockDeltaEvent,
  ModelThinkingBlockStartEvent,
  ModelToolInputBlockDeltaEvent,
  ModelToolUseBlockStartEvent,
} from './provider/event/modelStreamEvent.js';
export type { ModelStreamResponse } from './provider/modelStreamResponse.js';
export type {
  ModelPartialMessage,
  ModelPartialBlock,
  ModelPartialTextBlock,
  ModelPartialThinkingBlock,
  ModelPartialRedactedThinkingBlock,
  ModelPartialToolUseBlock,
} from './provider/aggregate/modelPartialMessage.js';
export type {
  ModelReasoningMetadata,
  ModelRedactedThinkingBlockStartEvent,
} from './provider/event/modelStreamEvent.js';
export type {
  ModelMessage,
  ModelContentBlock,
  ModelTextBlock,
  ModelThinkingBlock,
  ModelRedactedThinkingBlock,
  ModelToolUseBlock,
  ModelCompleteEvent,
  ModelBlockCompleteEvent,
  ModelMessageCompleteEvent,
} from './provider/event/modelCompleteEvent.js';
export type { ModelProvider } from './provider/modelProvider.js';
export { QODER_PROVIDER_ID } from './provider/modelProvider.js';
export * from './provider/presets/index.js';
export * from './qwen/subscription/index.js';
export {
  getDefaultAuthType,
  resolveEffectiveAuthType,
  setDefaultAuthType,
} from './core/contentGenerator.js';
export type { ModelSelector } from './provider/model/modelSelector.js';
export type {
  ModelResolver,
  ModelListOptions,
} from './provider/model/modelResolver.js';
export {
  ANTHROPIC_MESSAGES,
  OPENAI_CHAT_COMPLETIONS,
  OPENAI_RESPONSES,
  type ModelProtocol,
} from './provider/transport/modelProtocol.js';
export type {
  ModelStreamClient,
  ModelTransport,
} from './provider/transport/modelTransport.js';
export { ModelTransportManager } from './provider/transport/modelTransportManager.js';
export { ChatCompletionsTransport } from './provider/transport/impl/chatCompletionsTransport.js';
export { MessagesTransport } from './provider/transport/impl/messagesTransport.js';
export { ResponsesTransport } from './provider/transport/impl/responsesTransport.js';
export { GeminiTransport } from './provider/transport/impl/geminiTransport.js';
export {
  QoderProvider,
  type CreateQoderProviderOptions,
} from './provider/qoder/qoderProvider.js';
export {
  CustomModelProvider,
  type CreateCustomModelProviderOptions,
} from './provider/impl/customModelProvider.js';
export { CustomProviderConfig } from './provider/impl/customProviderConfig.js';
export { createModelStreamResponse } from './provider/modelStreamResponseFactory.js';
export {
  classifyClientError,
  inferenceErrorKindFromStatus,
  ModelInferenceError,
  findModelInferenceError,
  type ModelInferenceErrorClassifier,
  type ModelInferenceErrorDetail,
  type ModelInferenceErrorKind,
  type ModelInferenceErrorOptions,
  type ModelInferenceErrorPhase,
} from './provider/modelInferenceError.js';
export {
  buildApiErrorDetails,
  isServerRetryDisabled,
  parseApiErrorBody,
  QODER_API_LOGIN_EXPIRED_CODE,
  type QoderApiErrorDetails,
} from './protocol/provider/qoder-api-error.js';
export {
  ModelConfigStore,
  type CreateModelConfigStoreOptions,
  type ModelConfigStoreScope,
} from './provider/impl/modelConfigStore.js';
export {
  CUSTOM_MODEL_PROVIDER_CONFIG_ERROR,
  CUSTOM_MODEL_PROVIDER_CONFIG_WIRE,
  CustomModelProviderConfigError,
  addCredentialSecrets,
  createConfigOperationLog,
  customModelProviderConfigError,
  isCustomProviderConfigInput,
  requireBoolean,
  requireEnum,
  requireEnumArray,
  requirePositiveInteger,
  requireRecord,
  requireString,
  requireStringArray,
  requireStringRecord,
  rethrowConfigPersistFailure,
  validateOptionalPositiveInteger,
  type CustomModelProviderConfigReference,
} from './provider/impl/customModelProviderConfigCommon.js';
export {
  CustomModelProviderConfigLog,
  safeConfigLogText,
} from './provider/impl/customModelProviderConfigLog.js';
export {
  CustomProviderManager,
  type CustomModelProviderConfigInfo,
  type CustomModelProviderConfigInput,
  type CustomModelProviderProtocol,
  type CustomProviderModelEdit,
  type UpdateCustomModelProviderConfigInput,
} from './provider/custom/customProviderManager.js';
export { ModelProviderManager } from './provider/impl/modelProviderManager.js';
export { resolveModelSelectionOverride } from './provider/session-model.js';
export { ModelThinkingUtils } from './provider/utils/modelThinkingUtils.js';
export {
  createCustomModelProviders,
  createCustomModelProvidersFromSettingsTexts,
  customProviderConfigFromRuntime,
} from './provider/impl/customModelProviderFactory.js';
export { isComposedProviderId } from './provider/impl/customProviderComposers.js';

export * from './client/index.js';
export * from './client/pipeline/customOutboundPipeline.js';
export * from './client/pipeline/pipeline.js';
export * from './client/pipeline/pipelineError.js';
export * from './client/pipeline/valve/proxyValve.js';
export * from './client/pipeline/valve/transportValve.js';
export * from './client/pipeline/valve/endpointValve.js';
export * from './client/pipeline/valve/valve.js';
export * from './client/pipeline/valve/valveError.js';
export * from './client/proxy/proxyInstance.js';
export * from './client/transport/httpTransport.js';
export * from './client/transport/transport.js';
export * from './client/transport/modelRequestPhysicalObservation.js';

// Export bootstrap modules
export {
  PREDICTION_FORK_REQUEST,
  SINGLE_REQUEST_FORK,
  endModelRequestScope,
  onModelRequestScopeEnd,
  publishModelRequestProgress,
  publishModelRequestRecovery,
  onModelRequestObservation,
  publishModelRequestObservation,
  hasModelRequestObservationListeners,
  type ModelRequestProgressIdentity,
  type ModelRequestRecoveryEvent,
} from './model-request/request-scope.js';
export type {
  ModelQueueStatusSystemMessage,
  ModelRequestObservation,
  ModelRequestObserver,
} from './model-request/types.js';
export {
  modelRequestObservationError,
  observationMonotonicNow,
  observationElapsedMs,
  observationWaitFailureStatus,
} from './model-request/observation.js';

// Export config
export * from './config/config.js';
export * from './config/mcpServerScope.js';
export * from './config/feature-flags.js';
export * from './config/mcpServerTypeNormalization.js';
export * from './config/brand.js';
export {
  getSensitiveEnvironmentVariables,
  registerSensitiveEnvironmentVariables,
} from './config/sensitiveEnvironment.js';

export * from './config/agent-loop-context.js';
// 单进程多会话改造：进程级 ResourceService 与会话级 SessionState（Config 的未来平替）。
export * from './thread-manager/index.js';
export * from './config/memory.js';
export { getDefaultUtilityModel } from './config/defaultUtilityModel.js';
export * from './config/models.js';
export * from './config/constants.js';
export * from './config/settingsPathDetector.js';
export * from './startup/startupRuntime.js';
export * from './file-history/index.js';
export * from './output/types.js';
export {
  InMemoryToolCallSnapshotStore,
  type ToolCallSnapshot,
  type ToolCallSnapshotListener,
  type ToolCallSnapshotPublisher,
  type ToolCallSnapshotSubscriber,
  type ToolCallSnapshotStore,
} from './tool-executor/tool-call-snapshot.js';
export type { SerializableConfirmationDetails } from './tools/confirmation-details.js';
export {
  buildConfirmationDetails,
  presentationOptionsForPrompt,
  breakerConfirmationDetails,
  projectConfirmationDetailsForExternalUse,
  DEFAULT_MAX_WIRE_CONFIRMATION_DETAILS_BYTES,
  AUTO_MODE_BREAKER_DECISION_POINT,
} from './tools/confirmation-details-builder.js';
export type { CommandHookEnv, PermissionSuggestion } from './hooks/types.js';
export type {
  QuestionOption,
  QuestionAnnotation,
  Question,
} from './tools/ask-user-types.js';
export { NOTES_ONLY_ANSWER } from './tools/ask-user-types.js';
export {
  deriveSessionTeamName,
  IN_PROCESS_TEAMMATE_TASK_TYPE,
  isAgentTeamsEnabled,
  isInProcessTeammateFeatureEnabled,
} from './agents/teams/agent-teams-feature.js';
export {
  formatAgentMessage,
  formatTeammateMessage,
  parseTeammateMessage,
  type ParsedTeammateMessage,
} from './agents/teams/agent-team-peer-message.js';
// Environment variable expansion
export { expandEnvVars } from './utils/envExpansion.js';
export { expandMcpEnvVars } from './mcp/mcpEnvExpansion.js';
export {
  InstallationManager,
  wasInstallationIdCreatedThisProcess,
} from './utils/installationManager.js';
export {
  inferEntrySurface,
  isLocalCliHost,
  type EntrySurface,
} from './utils/entry-surface.js';
export { applyExplicitModelChange } from './config/explicitModelChange.js';
export {
  StartupProfiler,
  startupProfiler,
  type StartupPhaseHandle,
} from './utils/startupProfiler.js';
export { detectContainer, detectRosetta } from './utils/hostEnvironment.js';
export {
  normalizeProxyUrl,
  normalizeProxyUrlIfSupported,
  redactProxyUrl,
} from './utils/proxy.js';

// Config load error types
export type { ConfigLoadError } from './utils/configLoadError.js';
export {
  emitLoadErrorSummary,
  truncateMessage,
} from './utils/configLoadError.js';
export {
  sessionLogger,
  summarizeDiagnosticText,
  type DiagnosticEventKind,
  type DiagnosticEventInput,
  type DiagnosticIds,
  type DiagnosticLogLevel,
  type ExitContext,
  type ExitReason,
} from './utils/sessionLogger.js';
export { redactSecrets } from './utils/diagnosticRedaction.js';
export {
  diagnosticLogger,
  PROCESS_LOG_FILE_NAME,
} from './utils/diagnosticLogger.js';
export { runLogger } from './utils/runLogger.js';
export { raceWithAbortSignal } from './utils/abort-race.js';
export {
  execFileNoThrow,
  type ExecFileResult,
} from './utils/execFileNoThrow.js';
export { getConfigHomeDir, safeUidSegment } from './utils/paths.js';
export { fetchWithTimeout } from './utils/fetch.js';
export { isNodeError } from './utils/errors.js';
export { closeDirHandleQuietly } from './utils/dirHandle.js';
export { getVersion } from './utils/version.js';
export { resolveCurrentHookCommand } from './builtin-plugins/resolve-current-hook-command.js';
export { getCwd as getShellCwd, setCwd as setShellCwd } from './utils/Shell.js';
export * from './utils/resultErrorCode.js';

// Brand constants — canonical source is config/brand.js, re-exported above.

// Runtime protocol — SDK message schemas, transcript types, provider layer
export * from './protocol/index.js';
export type { Message } from './protocol/transcript/message.js';
export {
  countAiTitleCadenceHumanPromptMessages,
  countHumanPromptMessages,
  collectToolStatuses,
  getAssistantTextBlocks,
  getDisplayablePromptText,
  getDisplayableUserText,
  getRealUserPromptText,
  getUserTextBlocks,
  getUserPromptFallbackText,
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  isAiTitleCadenceHumanPromptMessage,
  isCommandStyleUserPromptText,
  isHiddenUserMessageInDefaultHistory,
  isToolResultUserMessage,
  isHumanTaskInputMessage,
  isTaskTriggeringPrompt,
  isMeaningfulUserPromptMessage,
  isReplayableUserMessage,
  isSyntheticMessage,
  isSyntheticPromptText,
  parseCommandPromptText,
  parseLocalCommandStdoutText,
  TASK_LIFECYCLE_SUBTYPES,
  SYNTHETIC_MESSAGES,
} from './protocol/transcript/message-utils.js';
export {
  isPathLikeCommandStyleText,
  isSlashCommandStyleUserPromptText,
  type SlashCommandStyleOptions,
} from './utils/commandStyleText.js';
export {
  getSessionStateDir,
  getSessionStatePath,
} from './services/session-state-paths.js';
export {
  SessionStateStore,
  type SessionStatePayload,
  type SessionStateSegments,
  type SessionStateStoreOptions,
} from './services/session-state-store.js';
export {
  recordSessionUsage,
  loadLatestSessionUsage,
  recordSessionUsageInMemory,
  flushSessionUsage,
  bindSessionCreditsPersistence,
  bindSessionUsagePersistence,
  clearSessionCredits,
  getSessionCreditsSnapshot,
  hydrateSessionCredits,
  recordCompletedRequest,
  beginActiveCreditsRequest,
  CREDITS_REQUEST_SETTLE_TIMEOUT_MS,
  INTERACTIVE_CREDITS_REQUEST_SETTLE_TIMEOUT_MS,
  INTERACTIVE_USAGE_REQUEST_SETTLE_TIMEOUT_MS,
  type PersistedSessionCredits,
  type SessionCreditsSnapshot,
  type MeteredRequestUsage,
  type SessionCreditsDisposeOptions,
  type SessionCreditsPersistenceDisposer,
  type SessionUsagePersistenceDisposer,
} from './services/session-state-usage.js';

// Agent loop runtime — query() async generator (runtime main loop)
export {
  query,
  DEFAULT_MAX_TURNS,
  createQueryEventBus,
} from './core/agent-loop.js';
export { REPEATED_TOOL_CALL_PERMISSION_KIND } from './core/doom-loop-guard.js';
export type {
  ConfirmContinuation,
  ContinuationRequest,
  ContinuationDecision,
} from './core/doom-loop-guard.js';
export type {
  QueryParams,
  TaskTrigger,
  QueryEventRuntime,
} from './core/agent-loop.js';
export type {
  TurnHookModule,
  TurnHookModuleFactory,
} from './core/turn-hooks.js';
export type { QueryBusinessContext } from './core/query-business-context.js';
export type {
  GetModelPolicyCallback,
  GetModelPolicyResult,
  ModelPolicyLabels,
  ModelPolicyParameters,
  GetModelPolicyExtras,
} from './core/model-policy.js';
export type { CacheSafeQuerySnapshot } from './core/cache-safe-query-snapshot.js';
export { createCompactRequestResolver } from './core/compact-request-resolver.js';
export { runForkedAgent } from './core/forkedAgent.js';
export type {
  ForkedAgentParams,
  SingleRequestForkParams,
  ForkedAgentResult,
} from './core/forkedAgent.js';
export { runSideQuestion } from './core/side-question.js';
export type {
  SideQuestionParams,
  SideQuestionResult,
  SideQuestionHistoryEntry,
} from './core/side-question.js';
export type {
  QueryEvent,
  RequestStartEvent,
  StreamEvent,
  AssistantBlockEvent,
  ResultTextResetEvent,
  Terminal,
} from './core/query-event.js';
export {
  CONTENT_FILTERED_MESSAGE,
  isDurableQueryEvent,
} from './core/query-event.js';
export {
  projectAssistantPayloadForSdk,
  projectMessageOriginForSdk,
  projectTaskSystemEventForSdk,
} from './engine/headless-projection.js';
export { addAnthropicUsage } from './protocol/provider/usage-converter.js';
export { resolveBusinessIdentity } from './core/agent-lifecycle-state.js';
export {
  getAgentContext,
  runWithoutAgentContext,
} from './utils/agentContext.js';
export type { AgentContext } from './utils/agentContext.js';

export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from './qoder/models/output-tokens.js';
export { parseModelPromptPatches } from './qoder/infer/model-prompt-patches.js';
export type { ModelPromptPatches } from './qoder/infer/model-prompt-patches.js';
export { deterministicUUID } from './utils/deterministicUuid.js';
export {
  parseReasoningEffortLevel,
  REASONING_EFFORT_LEVELS,
} from './config/model-values.js';
export type { ReasoningEffortLevel } from './config/model-values.js';
export {
  generationConfigFromLegacyFields,
  generationConfigFromServerModel,
  generationConfigFromWireParameters,
  generationFromModelConfig,
  modelConfigFromGeneration,
  mergeLlmGenerationConfigs,
  normalizeLlmGenerationConfig,
  normalizeReasoningConfig,
  resolveEffectiveReasoningEffort,
  resolveExplicitReasoningEffort,
  stripReasoningEffort,
  toCustomProviderWireFields,
  toRemoteWireParameters,
  withReasoningEffortOverride,
} from './config/generation-config.js';
export type {
  CustomProviderWireGenerationFields,
  LlmGenerationConfig,
  LlmReasoningConfig,
  LlmThinkingConfig,
} from './config/generation-config.js';
export {
  getSupportedReasoningEfforts,
  normalizeModelEfforts,
} from './qoder/models/efforts.js';
export type { ParsedModelEfforts } from './qoder/models/efforts.js';
export {
  getSupportedContextWindows,
  normalizeContextWindows,
  parseContextWindowConfig,
  resolveContextWindow,
  supportsContextWindow,
} from './qoder/models/context-windows.js';
export type {
  ContextWindowCapableModel,
  ParsedContextWindowConfig,
} from './qoder/models/context-windows.js';
export {
  CONTEXT_WINDOW_SELECTION_GATE,
  isContextWindowSelectionEnabled,
} from './config-service/features/contextWindowSelection.js';
export {
  CODEBASE_BACKFLOW_FEATURE_ENV,
  CODEBASE_BACKFLOW_FEATURE_GATE,
  getCodebaseBackflowConfig,
  isCodebaseBackflowEnabled,
  isCodebaseBackflowOrganizationAllowed,
  subscribeCodebaseBackflowEnabled,
} from './config-service/features/codebaseBackflow.js';
export type { CodebaseBackflowConfig } from './config-service/features/codebaseBackflow.js';
export {
  DYNAMIC_COMMANDS_GATE,
  getDynamicCommandsConfig,
  getDynamicCommandDefinitions,
} from './config-service/features/dynamicCommands.js';
export type {
  DynamicCommandDefinition,
  DynamicCommandDisplayConfig,
  DynamicCommandEndpointConfig,
  DynamicCommandsConfig,
} from './config-service/features/dynamicCommands.js';
export { normalizeLocale } from './utils/locale.js';
export type { UiLocale } from './utils/locale.js';

// Tool execution — session executor and agent schema registry
export type { ToolResultBlock } from './core/tool-result.js';
export {
  completedToolCallToResult,
  LocalToolCallExecutor,
  StreamingToolExecutor,
} from './tool-executor/index.js';
export {
  ToolRegistry,
  type ToolRegistrySchemaOptions,
} from './tools/tool-registry.js';
export type {
  ToolCallResult,
  ToolExecuteContext,
  ToolExecutor,
} from './tool-executor/index.js';
export type { CompletedToolCall } from './tool-executor/types.js';

// Permission types — SDK bidirectional tool permission protocol
export type {
  ToolPermissionDecision,
  ToolPermissionRequestContext,
  RepeatedToolCallPermissionContext,
  CanUseToolCallback,
} from './protocol/schemas/common.js';

// ── Permission ──────────────────────────────────────────────────────────────
//
// The decision engine lives in `permissions/manager/decision/`; its vocabulary and contracts
// are re-exported here so consumers need one import. What this surface adds is
// the mode *behaviour* layer (`permissions/permission-modes/`) and the tool
// check table (`tools/tool-checkers/checker-registry.ts`).
//
// Host settings persistence and rule-management helpers (the settings I/O trio,
// shadowed-rule detection) are being restored as host modules and are therefore
// not on this surface yet.
export {
  PERMISSION_MODES,
  PermissionModes,
  normalizePermissionMode,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  rulesForToolName,
  toolNameMatchesRule,
} from './permissions/manager/decision/index.js';
export type {
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRule,
  PermissionRules,
  PermissionRuleSource,
  PermissionRuleValue,
  RulesForTool,
  ToolCheckContext,
  ToolCheckResult,
  ToolPermissionChecker,
} from './permissions/manager/decision/index.js';
export {
  PermissionManager,
  createPermissionModes,
} from './permissions/manager/permission-manager.js';
export type { SessionPermissionContext } from './permissions/manager/permission-manager.js';
export { SessionPermissionManager } from './permissions/manager/session-permission-manager.js';
export type {
  PermissionManagerFactory,
  PermissionManagerInput,
} from './permissions/manager/permission-manager.js';
export type {
  AskHandler as SessionAskHandler,
  CheckRequest,
  Checker,
  CheckerFactory,
  FlagSettings,
  ManagedPolicy,
  ModeGate,
  ModeListing,
  ModeChangeResult,
  PermissionContext,
  PermissionModeDefinition,
  Scene,
  SessionPermissionOptions,
  SkillRules,
} from './permissions/manager/types.js';
export { SettingsManagedPolicy } from './permissions/manager/managed-policy.js';
export {
  checkInternalRead,
  fileReadPermission,
} from './permissions/file-read.js';
export type { ReadPermissionDecision } from './permissions/file-read.js';
export {
  createCheckerDepsForConfig,
  createClassifierInputsForConfig,
  createEagerMcpToolChecker,
} from './permissions/config-checker-deps.js';
export { PermissionModeUnavailableError } from './permissions/manager/policy.js';
export type { PermissionPolicySnapshot } from './permissions/manager/policy.js';
export { permissionRulesFromStartup } from './permissions/settings/startup-rules.js';
export {
  hasManagedPermissionRulesOnly,
  loadPermissionRulesFromLoadedSettings,
  settingsToPermissionRules,
} from './permissions/settings/rule-sources.js';
export type { StartupRulesOptions } from './permissions/settings/startup-rules.js';
export {
  addPermissionRulesToSettings,
  computeRulesAfterDelete,
  computeRulesToAdd,
  deletePermissionRuleFromSettings,
  getEmptyPermissionSettingsJson,
  getPermissionRulesForSource,
  isEditableSource,
  loadAllPermissionRulesFromDisk,
  loadPermissionRulesForModule,
  rulesToPermissionRules,
  settingsJsonToRules,
  shouldAllowManagedPermissionRulesOnly,
  shouldShowAlwaysAllowOptions,
} from './permissions/settings/permissionsLoader.js';
export type {
  EditableSettingSource,
  PermissionRuleFromEditableSettings,
  PermissionsSettingsJson,
  SettingsAccessor,
  SettingsWriter,
} from './permissions/settings/permissionsLoader.js';
export { createSettingsAccessor } from './permissions/settings/settingsAccessorFactory.js';
export {
  extractRules,
  hasRules,
  persistPermissionUpdate,
  persistPermissionUpdates,
  applyUpdatesToRules,
  applyUpdatesToModule,
  updatesForApprovalScope,
  supportsPersistence,
} from './permissions/settings/persist-permission-update.js';
export type {
  PersistableDestination,
} from './permissions/settings/persist-permission-update.js';
export {
  detectUnreachableRules,
  getAllowRules,
  getAskRules,
  getDenyRules,
  permissionRuleSourceDisplayString,
} from './permissions/settings/shadowedRuleDetection.js';
export type {
  ShadowType,
  UnreachableRule,
} from './permissions/settings/shadowedRuleDetection.js';
export type { HostAskHandler } from './tools/tool-checkers/checker-reasons.js';
export {
  createAskHandler,
  promptForCheck,
  rememberApproval,
  consultPermissionRequestHook,
  withPermissionRequestHook,
  withPermissionRequestHookHandler,
} from './permissions/ask-handler/ask-handler.js';
export {
  createPermissionRequestHookBridge,
  permissionPromptNotifier,
} from './permissions/ask-handler/hook-bridge.js';
export {
  createAskMetricsStore,
  type AskMetrics,
  type AskMetricsStore,
} from './permissions/ask-handler/ask-facts.js';
export { PermissionTelemetry } from './permissions/permission-ask-channel.js';
export type {
  AskPresenter,
  AskPrompt,
  AskSettlement,
  PermissionRequestHookBridge,
  PermissionRequestHookVerdict,
} from './permissions/ask-handler/ask-handler.js';
export type {
  PermissionAttribution,
  PermissionUpdate,
  PermissionUpdateDestination,
  ToolPermissionExtra,
  ToolPermissionReason,
} from './tools/tool-checkers/checker-reasons.js';
export { directoryPermissionPattern } from './tools/filesystem-permissions/pathRules.js';
export {
  createToolCheckerMap,
  type ToolCheckerRegistryDeps,
} from './tools/tool-checkers/checker-registry.js';
export {
  alwaysAllowChecker,
  askWithSelfAllowChecker,
  type HostToolChecker,
} from './tools/tool-checkers/rule-precedence.js';
export {
  parseToolListFromCLI,
  FRONTMATTER_REGEX,
} from './utils/frontmatterParsers.js';
export { AutoClassifier } from './permissions/permission-modes/auto/auto-classifier.js';
export type { AutoModeDenial } from './permissions/permission-modes/auto/denials.js';
export { readGlobalAutoModeUserConfig } from './permissions/permission-modes/auto/classifier-init.js';
export {
  PERMISSION_MODE_CYCLE,
  PLAN_MODE_BLOCKED_MESSAGE,
  PLAN_MODE_FORCE_EXITED_MESSAGE,
  WORK_STATE_COLORS,
  getNextPermissionMode,
  isAcceptEditsMode,
  isAutoMode,
  isDefaultMode,
  isDontAskMode,
  isPlanStateBlockedByMode,
  isYoloMode,
  parsePermissionMode,
  permissionModeColor,
  permissionModeDescription,
  permissionModeShortTitle,
  permissionModeSymbol,
  permissionModeTitle,
  resolveEffectiveMode,
} from './permissions/permission-modes/index.js';
export type { PermissionModeDisplay } from './permissions/permission-modes/index.js';

// QueryEngine — unified agent loop orchestrator
export * from './engine/index.js';

// Attachment pipeline — per-request context injection (file contents, IDE state, skills, etc.)
export * from './attachments/index.js';

// Input processing pipeline — unified TUI/SDK input handling
export * from './input/index.js';
export * from './commands/review.js';

// StructuredIO — NDJSON stdin/stdout communication for SDK integration
export * from './io/index.js';

// NDJSON safe serialization
export { ndjsonSafeStringify } from './output/ndjson-safe-stringify.js';
export * from './protocol/transcript/conversation-history.js';

// 标准工具声明生成
export { buildModelStreamTools } from './qoder/tools/function-declarations.js';

export * from './qoder/index.js';
// Qoder account and gateway API.
export * from './qoder/api/index.js';
export {
  REMOVED_GENERATION_FIELDS,
  REMOVED_PROVIDER_MODEL_FIELDS,
  REMOVED_MODEL_GENERATION_FIELDS,
  getRemovedCustomProviderFieldMessage,
  parseCustomProviderSettings,
} from './provider/custom/parser.js';

export { DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS } from './provider/custom/builtins.js';

// Shared by product packages that talk to user-configured (custom provider) endpoints.
export { customProviderRequest } from './provider/custom/request.js';
export {
  parseProviderErrorBody,
  redactSecret,
} from './utils/provider-error-body.js';

// Export Commands logic
export * from './commands/init.js';
export * from './commands/review.js';
export * from './commands/types.js';

// Export Core Logic
export * from './judgment/index.js';
export { AuthType } from '@qwen-code/resource';
export * from './core/logger.js';
export {
  buildSystemPromptForTurn,
  buildSystemPromptResultForTurn,
  type BuildSystemPromptForTurnOptions,
} from './prompts/build-system-prompt.js';
export {
  systemPromptFromText,
  systemPromptToText,
  appendSystemPromptText,
} from './prompts/system-prompt.js';
export type {
  AgentDefinitionLike,
  AssembledSystemPrompt,
  PromptBuildResult,
  PromptSource,
  PromptBundle,
  PromptSurface,
  PromptAssemblyContext,
  PromptRenderInputs,
  SdkMemoryPromptState,
  SystemPromptBlockKind,
  SystemPromptTextBlock,
  SystemPrompt,
} from './prompts/types.js';
export {
  createTurnPromptResolver,
  type TurnPromptResolver,
  type TurnPromptResolverOptions,
} from './prompts/turn-prompt-resolver.js';
export {
  resolveEffectivePromptSource,
  type ResolvedPromptSource,
} from './prompts/effective-prompt.js';
export {
  buildStartupMemoryPrefix,
  createStartupMemoryContext,
} from './prompts/context-injection.js';
export { PROMPT_SECTION_ID } from './prompts/section-ids.js';
export type { InvalidatablePromptSectionId } from './prompts/section-ids.js';
export { MANDATORY_PREFIX_SEPARATOR } from './prompts/mandatory-prefix.js';
export {
  DEFAULT_OUTPUT_STYLE_NAME,
  BUILTIN_OUTPUT_STYLES,
} from './prompts/outputStyles/builtin.js';
export type {
  OutputStyleConfig,
  OutputStyleSource,
} from './prompts/outputStyles/types.js';
export { loadOutputStylesFromDir } from './prompts/outputStyles/loader.js';
export {
  getAllOutputStyles,
  getAvailableOutputStyleDefinitions,
  getAvailableOutputStyles,
  resolveOutputStyleWithForce,
} from './prompts/outputStyles/resolve.js';
export type { GetOutputStylesOptions } from './prompts/outputStyles/resolve.js';
export {
  SystemPromptAssembler,
  type SystemPromptAssemblerOptions,
} from './prompts/system-prompt-assembler.js';
export * from './core/tokenLimits.js';
export * from './compression-v2/thresholds.js';
export type { CompressionConfig } from './compression-v2/config.js';
export {
  estimateBlocksTokenCount,
  getContentBlocks,
} from './compression-v2/message-types.js';
export * from './core/stream-errors.js';
export * from './core/turn-events.js';
export * from './core/llmRequest.js';
export * from './tool-executor/types.js';

// Export Routing

export * from './fallback/types.js';

// Export utilities
export * from './utils/fetch.js';
export * from './utils/certificate-store.js';
export { homedir, tmpdir } from './utils/paths.js';
export * from './utils/paths.js';
export * from './utils/pathShape.js';
export { killProcessGroup, type KillOptions } from './utils/process-utils.js';
export * from './utils/checks.js';
export * from './utils/headless.js';
export * from './utils/bundledMode.js';
export * from './utils/schemaValidator.js';
export * from './utils/delay.js';
export * from './utils/errors.js';
// Generic network utilities borrowed by the product client package (packages/qoder).
export { copyHttpdnsErrorMetadata } from './utils/api-error-logger.js';
// Aliased: the network stack uses api-error-logger's (error, context) variant
// under a distinct public name.
export { logApiError as logApiRequestError } from './utils/api-error-logger.js';
export { calculateExponentialBackoffMs } from './utils/backoff.js';
export { writeFileAtomic } from './utils/fileWriteUtils.js';
export {
  getFetchRuntimeDiagnostics,
  type FetchRuntimeDiagnostics,
} from './utils/undici-diagnostics.js';
export {
  isProtocolLimitError,
  ProtocolLimitError,
} from './utils/protocol-limits.js';
export { CLI_VERSION } from './generated/git-commit.js';
export { stripBOM } from './utils/stripBom.js';
export * from './utils/fsErrorMessages.js';
export * from './utils/exitCodes.js';
export {
  detectImageFormatFromBuffer,
  detectSupportedImageFormatFromBuffer,
  maybeResizeAndDownsampleImageBuffer,
  readImageWithMediaLimits,
  readImageWithTokenBudget,
} from './utils/imageReader.js';
export {
  SUPPORTED_IMAGE_MEDIA_TYPES,
  isSupportedImageMediaType,
  normalizeImageMediaType,
  unsupportedImagePlaceholder,
  type SupportedImageMediaType,
} from './utils/supportedImageTypes.js';
export { repairBunNativesRuntime } from './bootstrap/bunNativesBootstrap.js';
export {
  extractTextFromBlocks,
  extractUserVisiblePromptText,
} from './utils/promptTextUtils.js';
export * from './utils/getFolderStructure.js';
export * from './utils/memoryDiscovery.js';
export {
  startOomDiagnostics,
  stopOomDiagnostics,
} from './utils/oom-diagnostics.js';
export {
  setShellIfWindows,
  findGitBashPath,
  findGitBashPathSync,
  windowsPathToPosixPath,
  posixPathToWindowsPath,
} from './utils/windowsPaths.js';
export {
  bindCwdContext,
  getCwd,
  setCwd,
  setCwdAndNotify,
  notifyCwdChanged,
  getOriginalCwd,
  runWithCwdContext,
  runWithShellSession,
  setOriginalCwd,
  prewarmShellProvider,
  type CwdContext,
} from './utils/Shell.js';
export type {
  BuildExecCommandOptions,
  ShellSessionContext,
} from './utils/shell/shellProvider.js';
export { setPkillSelfProtectionEnabled } from './utils/shell/pkillSelfProtection.js';
export {
  getSessionEnvScript,
  cleanupOldSessionEnvDirs,
  cleanupSessionEnvDir,
} from './hooks/sessionEnvironment.js';
export {
  findPreparedGitPath,
  getGitBashPreparationState,
  getManagedGitDirectory,
  registerGitBashPreparation,
  type GitBashPreparationResult,
  type GitBashPreparationState,
} from './utils/envprep/index.js';
export { prepareWindowsEnvironment } from './utils/envprep/prepareWindowsEnvironment.js';
export type { WindowsEnvironmentUrls } from './utils/envprep/types.js';
export { WELL_KNOWN_BASH_PATHS } from './utils/envprep/types.js';
export {
  validateGitBashFiles,
  validateGitBashInstallation,
} from './utils/envprep/validation.js';
export { runWindowsExecutableProbe } from './utils/windowsExecutableProbe.js';
export { isWindowsShellScriptWrapper } from './utils/windowsExecutable.js';
export { Downloader, type DownloadConfig } from './utils/downloader.js';
export * from './utils/memoryImportProcessor.js';
export * from './utils/gitIgnoreParser.js';
export * from './utils/gitUtils.js';
export * from './utils/editor.js';
export * from './utils/quotaErrorDetection.js';
export * from './utils/authConsent.js';
export * from './utils/googleQuotaErrors.js';
export * from './utils/googleErrors.js';
export * from './utils/fileUtils.js';
export * from './utils/sessionOperations.js';
export * from './utils/sessionIdValidation.js';
export * from './utils/planUtils.js';
export * from './utils/fileDiffUtils.js';
export * from './utils/retry.js';
export * from './utils/shell-utils.js';
export {
  parseArguments,
  substituteArguments,
  generateProgressiveArgumentHint,
} from './utils/argumentSubstitution.js';
export {
  deriveCommandName,
  pathToNamespace,
  type DerivedCommandName,
  type DeriveCommandNameInput,
  type PathImpl,
} from './utils/commandNamespace.js';
export * from './utils/tool-utils.js';
export * from './utils/systemEncoding.js';
export * from './utils/textUtils.js';
export { safeJsonStringify } from './utils/safeJsonStringify.js';
export * from './utils/formatters.js';
export * from './utils/generateContentResponseUtilities.js';
export * from './utils/filesearch/fileSearch.js';
export * from './utils/errorParsing.js';
export { SYNTHETIC_MODEL } from './protocol/provider/request-converter.js';
export * from './utils/resultErrorCode.js';
export * from './utils/fastAckHelper.js';
export * from './utils/workspaceContext.js';
export * from './utils/environmentContext.js';
export * from './utils/ignorePatterns.js';
export * from './utils/partUtils.js';
export * from './utils/promptIdContext.js';
export * from './utils/thoughtUtils.js';
export * from './utils/secure-browser-launcher.js';
export * from './utils/debugLogger.js';
export * from './utils/diagnosticInterceptors.js';
export * from './utils/events.js';
export * from './utils/agentsMdSize.js';
export * from './utils/package.js';
export * from './utils/version.js';
export * from './utils/runtimeAssetPath.js';
export * from './utils/apiConversionUtils.js';
export * from './utils/channel.js';
export * from './utils/constants.js';
export * from './utils/cache.js';
export * from './utils/markdownUtils.js';

// Export services
export * from './services/fileDiscoveryService.js';
export * from './services/FolderTrustDiscoveryService.js';
export * from './services/fork-session-service.js';
export {
  assertResumeDropsTurn,
  RESUME_DROPS_TURN_REJECTION_PREFIX,
} from './services/resumeSessionAt.js';
export {
  type SessionResumeData,
  createSessionResumeWriterBinding,
  getResumeArtifactWorktreeStates,
  extractLastAssistantModelFromTranscript,
  selectHistoricalSessionResumePoint,
  selectSessionResumePoint,
} from './services/sessionResumeData.js';
export * from './services/transcript-paths.js';
export { getSessionArtifactProjectRoots } from './services/sessionArtifactRoots.js';
export * from './services/transcriptSessionService.js';
export * from './services/transcript/repository.js';
export * from './services/transcript/resume-read-budget.js';
export {
  matchesTranscriptSnapshot,
  sameTranscriptSnapshots,
} from './services/transcript/snapshot.js';
export * from './services/transcript/writer-handle.js';
export * from './services/transcript/store.js';
export * from './services/transcript/conversation-rewind.js';
export { isChainParticipant } from './services/transcript/session-writer.js';
export {
  getSubagentTranscriptDir,
  getSubagentTranscriptPath,
  getSubagentMetadataPath,
  createSubagentTranscriptRecorder,
  writeSubagentMetadata,
  readSubagentMetadata,
  deleteSubagentTranscriptArtifacts,
  readSubagentTranscript,
  loadAllSubagentTranscripts,
  type SubagentMetadata,
  type LoadedSubagentTranscript,
  type SubagentArtifactContext,
} from './services/subagent-transcript.js';
export * from './agents/agent-task-runtime.js';
export { isAgentSessionsEnabled } from './agents/agent-session-feature.js';
export * from './utils/sessionIdContext.js';
export * from './services/fileSystemService.js';
export * from './services/promptSuggestionService.js';
export {
  canGeneratePromptSuggestionFork,
  capturePromptSuggestionForkSource,
} from './services/promptSuggestionFork.js';
export * from './services/sessionTitleService.js';
export * from './services/sessionTitleUtils.js';
export {
  AutoMemoryExtractionService,
  type AutoMemoryCallbacks,
  type AutoMemoryGenerationResult,
  type AutoMemoryTurnContext,
  type SdkAutoMemoryGenerationConfig,
  type SdkAutoMemoryRoot,
} from './services/autoMemoryExtractionService.js';
export * from './services/auto-memory-generation/index.js';
export {
  SkillEvolutionReviewService,
  DEFAULT_SKILL_EVOLUTION_COOLDOWN_MS,
  DEFAULT_SKILL_EVOLUTION_REVIEW_THRESHOLD,
} from './services/skillEvolutionReviewService.js';
export type { SkillEvolutionReviewResult } from './services/skillEvolutionReviewService.js';
export {
  drainAutoDream,
  resolveDreamConfig,
} from './services/autoDream/index.js';
export {
  loadAutoMemoryPrompt,
  loadAutoMemoryPromptForRoots,
} from './memory/auto-memory-prompt.js';
export { loadAutoMemoryGenerationPromptForRoots } from './memory/memory-generation-prompt.js';
export { estimateTextTokens } from './utils/tokenCalculation.js';
export {
  getAutoMemoryDir,
  getUserAutoMemoryDir,
  getScopedAutoMemoryDirs,
  getKnownAutoMemoryDirs,
  ensureAutoMemoryDir,
  deleteMemoryFile,
  getMemoryIndexPath,
  isAutoMemoryFile,
  getFrontmatterMemoryType,
  validateAutoMemoryWriteScope,
  listMemoryFiles as listStructuredMemoryFiles,
  listMemoryFileNames,
  type MemoryScope,
  type ScopedAutoMemoryDir,
} from './memory/structured-memory-store.js';
export * from './memory/types.js';
export * from './memory/memory-index.js';
export * from './context/memoryContextManager.js';
export * from './tasks/task-list-id.js';
export * from './tasks/task-list-types.js';
export * from './tasks/task-store.js';
export * from './services/keychainService.js';
export * from './services/keychainTypes.js';
export * from './skills/skillManager.js';
// Skill filesystem parsing is owned by @qwen-code/resource. Keep the established
// core exports as compatibility forwards for CLI/SDK consumers.
export {
  drainSkillLoadErrors,
  extractDescriptionFromBody,
  loadSkillFromFile,
  loadSkillsFromCommandsDir,
  loadSkillsFromDir,
  parseFrontmatter,
  resolveSkillDir,
} from '@qwen-code/resource';
export type {
  FrontmatterShell,
  LoadSkillsFromDirOptions,
  ParsedFrontmatter,
  SkillArgument,
  SkillDefinition,
  SkillScanLimits,
  SkillSource,
} from '@qwen-code/resource';
export * from './skills/inlineSkillActivation.js';
export * from './skills/selectedSkillActivation.js';

// Export Shell Execution Service
export * from './services/shellExecutionService.js';

// Export Task Output utilities
export {
  getTaskOutputDir,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from './utils/task/diskOutput.js';

// Export Message Queue Manager
export * from './services/messageQueueManager.js';
export {
  disposeSessionEventQueue,
  drainSubagentSdkEvents,
  createTaskUpdatedEvent,
  enqueueSubagentSdkEvent,
  getSubagentSdkEventTaskIdentity,
  type SubagentSdkEventTaskIdentity,
} from './agents/subagent-sdk-events.js';
export { QueryGuard } from './services/QueryGuard.js';
export {
  processQueueIfReady,
  type ProcessQueueParams,
  type ProcessQueueResult,
} from './services/queueProcessor.js';

// Export Task Notification helpers
export * from './services/taskNotification.js';
export * from './services/stallDetection.js';
export * from './constants/xmlTags.js';

export {
  getSystemContext,
  clearSystemContext,
  clearSessionPromptCaches,
} from './context/system-context.js';

// Export Execution Lifecycle Service
export * from './services/executionLifecycleService.js';

// Export Injection Service
export * from './config/injectionService.js';

// Export base tool definitions
export * from './tools/tools.js';
export * from './tools/file-tool-result-projection.js';
export * from './tools/file-read-recovery-schemas.js';
export * from './tools/tool-error.js';
export * from './tools/tool-registry.js';
export * from './tools/tool-names.js';
export * from './tools/tool-use-display.js';
export * from './tools/abort-utils.js';
export * from './tools/tool-use-context-factory.js';
export * from './tools/simple-invocation.js';
export * from './tools/define-tool.js';
export { imageGenContract } from './codemode/contracts.js';
export {
  CODE_MODE_RESULT_TYPE,
  DEFAULT_DEFERRED_HINTS,
  MODEL_ONLY_HINTS,
  isFailedScriptStatus,
} from './codemode/types.js';
export type {
  ProgrammaticContract,
  ToolExposureHints,
} from './codemode/types.js';
export * from './tools/tool-orchestration.js';
export {
  customProviderAuthHeaders,
  type CustomProviderAuthType,
} from './provider/custom/types.js';
export { readString } from './config/model-values.js';
export {
  loadGeneratedImage,
  saveGeneratedImage,
} from './utils/generated-image.js';
export {
  BusinessTypeText2Img,
  BusinessTypeText2Video,
} from './qoder/business-info.js';
export {
  setBusinessFinishReporter,
  type BusinessFinishReporter,
  type ReportBusinessFinishParams,
} from './qoder/business-finish.js';
export {
  CustomProviderAccessError,
  type CustomProviderAccessCheck,
  type CustomProviderAccessMode,
} from './config/custom-provider-access.js';
export {
  SessionIdInvariantError,
  isSessionIdInvariantError,
} from './utils/sessionIdInvariantError.js';

// Export streaming tool executor
export * from './tools/streaming-tool-executor.js';
export * from './tools/tool-execution-lifecycle.js';

// Export streaming primitives
export * from './utils/stream.js';
export * from './utils/generators.js';

// Export prompt logic

// Export agent definitions
export * from './agents/types.js';
export * from './agents/agent-tool-result.js';
export * from './agents/registry/agentLoader.js';
export * from './agents/agent-setup.js';

// Export specific tool logic
export * from './tools/read-file.js';
export * from './tools/ripGrep.js';
export * from './tools/glob.js';
export * from './tools/edit.js';
export * from './tools/write-file.js';
export * from './tools/web-fetch.js';
export {
  createPreapprovedHostChecker,
  isPreapprovedHost,
  type PreapprovedHostChecker,
} from './tools/web-fetch-preapproved.js';
export { createWebFetchToolChecker } from './tools/tool-checkers/checkers/web-fetch-checker.js';
export * from './tools/memoryTool.js';
export * from './tools/shell.js';
export * from './tools/shell-result.js';
export * from './tools/monitor.js';
export * from './tools/task-stop.js';
export * from './tools/user-shell-command-runner.js';
export * from './mcp/authorization.js';
export * from './mcp/mcpClientContext.js';
export * from './mcp/tools/mcp-prompt.js';
export * from './mcp/tools/mcp-resource.js';
export * from './mcp/tools/mcp-server-command.js';
export {
  MCP_CALL_TIMEOUT_MSEC,
  MCP_CONNECT_TIMEOUT_MSEC,
} from './mcp/tools/mcp-timeouts.js';
export { mcpServerRequiresOAuth } from './mcp/oauthState.js';
export { getMCPServerPrompts } from './prompts/mcpPrompts.js';
export * from './mcp/connector/transport/headers-helper.js';
export * from './mcp/tools/mcp-tool.js';
export * from './mcp/tools/mcp-result.js';
export * from './protocol/transcript/tool-result-side-channel.js';
export * from './tools/mcp-auth-tool.js';
export * from './mcp/gate.js';
export * from './mcp/session-hook.js';
export * from './mcp/server-key.js';
export {
  McpManager,
  type McpManagerInitOptions,
  type McpManagerListener,
  type McpRegistrationStats,
  type McpServerRegistration,
  type McpUserServerLoadResult,
} from './mcp/mcpManager.js';
export * from './mcp/sessionMcpManager/index.js';
export { applyMcpLazyLoad } from './mcp/mcp-lazy-load.js';
export { LAZY_MCP_META_TOOL_NAMES } from './tools/mcp-lazy/index.js';
export * from './mcp/client/index.js';
export {
  mcpModelContext,
  type McpModelInfo,
} from './mcp/tools/mcp-model-context.js';
export * from './mcp/connector/index.js';
export {
  createMcpTransportFetch,
  createTransportRequestInit,
  getPluginEnvironment,
  registerMcpTransportFetchDecorator,
  registerReservedMcpHeader,
  sanitizeHeaderValue,
  type McpTransportFetchDecorator,
} from './mcp/connector/transport/support.js';
export { getMcpHeadersFromHelper } from './mcp/connector/transport/headers-helper.js';
export * from './tools/write-todos.js';
export * from './tools/taskTools.js';
export * from './tools/activate-skill.js';
export * from './tools/ask-user.js';

// MCP OAuth
export {
  MCPOAuthProvider,
  setMcpOAuthBrowserOpener,
  getMcpOAuthBrowserOpener,
} from './mcp/connector/oauth/provider.js';
export type {
  OAuthToken,
  OAuthCredentials,
} from './mcp/token-storage/types.js';
export { MCPOAuthTokenStorage } from './mcp/oauth-token-storage.js';
export {
  isMcpHostAuthenticated,
  withMcpHostAuthentication,
} from './mcp/authenticationOwnership.js';
export type {
  MCPOAuthConfig,
  McpOAuthBrowserOpener,
  McpOAuthBrowserOpenMeta,
  McpOAuthBrowserOpenResult,
} from './mcp/connector/oauth/provider.js';
export type {
  OAuthAuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from './mcp/connector/oauth/utils.js';
export { OAuthUtils } from './mcp/connector/oauth/utils.js';

// Export local session stats, prompt-token accounting and UI-facing stats types.
export * from './services/session-stats.js';
export { sessionId } from './utils/session.js';
export * from './utils/compatibility.js';
export * from './utils/browser.js';
export { Storage, ensureLocalFilesGitignored } from './config/storage.js';

// Export plugins subsystem
export * from './plugins/index.js';
export {
  assertContainedSymlinks,
  assertInside,
  extractArchiveSafely,
} from './utils/archiveUtils.js';

// Export hooks system
export * from './hooks/index.js';

// Export stdio utils
export * from './utils/stdio.js';
export * from './utils/terminal.js';
export {
  resolveClientRequestId,
  REQUEST_ID_HEADER,
} from './utils/request-id.js';
export * from './services/worktreeService.js';
export {
  getCommittedWorkspace,
  runWithWorkspaceTransition,
} from './utils/workspaceTransition.js';
export {
  recordInitialWorktreeTranscriptState,
  releasePersistedWorktreeSessionOwnership,
  releasePersistedWorktreeOwnerHandoff,
  toAttachedForkWorktreeSession,
  toTranscriptWorktreeSession,
  worktreeSessionService,
  type WorktreeEnterResult,
  type WorktreeRestoreResult,
  type WorktreeSessionService,
} from './services/worktreeSessionService.js';
export {
  migrateLegacyWorktreeTranscript,
  type LegacyWorktreeTranscriptMigrationRequest,
} from './services/legacyWorktreeTranscriptMigration.js';
export { resolveSessionWorktreeState } from './services/legacyWorktreeSessionState.js';
export type {
  PreparedWorktree,
  WorktreeEntryRequest,
  WorktreeRequest,
} from './services/worktree/contracts.js';
export * from './services/worktree-discovery.js';
export * from './services/worktree-owner-state.js';


// Export types from @google/genai
export type { Content, Part, FunctionCall } from '@google/genai';

// Export context types and profiles
export * from './context/types.js';
export * from './context/profiles.js';

// Export Goal system
export * from './goal/index.js';

// Export StatusLine
export * from './statusline/index.js';

export * from './qoder/types.js';
// Explicit re-exports to resolve ambiguous `export *` when the same name is
// reachable through both `./qoder/index.js` (line 222) and `./qoder/types.js`.
export type { QoderModelConfig } from './qoder/types.js';

// Config Service
export {
  installConfigService,
  initializeConfigService,
  ensureConfigReadyForRequest,
  getConfigService,
  subscribeConfigValue,
  getConfigValue,
  stopConfigService,
} from './config-service/index.js';
export type {
  ConfigKey,
  ConfigErrorListener,
  ConfigService,
  ConfigReadiness,
  ConfigValue,
  ConfigValueListener,
  ConfigValueUnsubscribe,
} from './config-service/config-service.js';
export {
  getPromptSuggestionFeatureConfig,
  isPromptSuggestionPolicyCurrent,
  subscribePromptSuggestionFeatureGate,
  type PromptSuggestionFeatureConfig,
  type PromptSuggestionMode,
} from './config-service/features/promptSuggestion.js';

export { BoundedLruMap } from './utils/boundedLruMap.js';

// Cron Scheduler
//
// The scheduler itself, its wakeup timer and the non-durable task store are not
// exported as free functions any more: they are per-session state and live on
// `CronManager`, reached through `config.getCronManager()`. What remains
// here is the stateless file store and the pure helpers.
export {
  hasCronTasksSync,
  countCronTasksSync,
  readCronTasks,
  nextCronRunMs,
  cronToHuman,
  CronManager,
  buildOwnerFingerprint,
  registerUserActivityClock,
} from './cron/index.js';
export type {
  CronTask,
  CronOwnerFingerprint,
  EnsureCronSchedulerOptions,
  ScheduleWakeupResult,
  LoopStatus,
  CronManagerHost,
} from './cron/index.js';

// Insights
export { generateInsights } from './insights/index.js';
export type {
  GenerateInsightsOptions,
  InsightsReport,
  SessionMeta,
  SessionFacets,
  AggregatedData,
  InsightResults,
} from './insights/index.js';
// Unified Task system
export {
  TaskRegistry,
  stopTask,
  TaskControlError,
  bridgeExecutionLifecycleToRegistry,
  isActiveStatus,
  isTerminalStatus,
  isBashTask,
  isAgentTask,
  isWorkflowTask,
  isInternalAgentTask,
  isVideoGenTask,
  DEFAULT_BACKGROUND_WIND_DOWN_POLICY,
} from './tasks/index.js';
export type {
  TaskType,
  TaskStatus,
  UnifiedTaskBase,
  BashUnifiedTask,
  AgentUnifiedTask,
  WorkflowUnifiedTask,
  InternalAgentUnifiedTask,
  VideoGenUnifiedTask,
  UnifiedTask,
  TaskControlErrorCode,
  StopTaskResult,
  BackgroundWindDownPolicy,
} from './tasks/index.js';

// /subtask — user-facing fork subagent spawn + helpers
export {
  spawnForkSubtask,
  buildForkSubtaskParams,
} from './agents/subagent-tool.js';
export type { SpawnForkSubtaskResult } from './agents/subagent-tool.js';
export {
  deriveForkName,
  truncateDirectiveLabel,
  isInForkChild,
} from './agents/fork-subagent.js';

export {
  WorkflowTool,
  buildWorkflowResumePrompt,
  createWorkflowRegistryFromConfig,
  getProjectWorkflowsDir,
  WorkflowRegistry,
  isWorkflowAuthoringAvailable,
  isWorkflowSkill,
  getModelVisibleSkillsForTools,
  buildWorkflowCommandPrompt,
  listWorkflowRunSnapshots,
  parseWorkflowScript,
  readWorkflowRunSnapshot,
  slugifyWorkflowName,
  writeWorkflowRunSnapshot,
  WORKFLOW_TOOL_DESCRIPTION,
  WORKFLOW_LAUNCH_DISPLAY,
  WORKFLOW_STRUCTURED_OUTPUT_TOOL_NAME,
} from './workflows/index.js';
export type {
  WorkflowMeta,
  WorkflowPhaseSeed,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowProgressItem,
  WorkflowRunAgentIndex,
  WorkflowRunSnapshot,
  WorkflowToolParams,
  WorkflowLaunchResult,
  WorkflowRegistryDiagnostic,
  WorkflowRegistryEntry,
  WorkflowRegistryListResult,
  WorkflowRegistrySource,
  WorkflowTerminationReason,
} from './workflows/index.js';

// Cross-session peer messaging (feature-gated; see src/messaging/index.ts).
export * from './messaging/index.js';
export * from './utils/errorPresentation.js';

export {
  countRequestTokens,
  estimateRequestBlockTokens,
  type RequestTokenInput,
  type RequestTokenCount,
} from './utils/request-token-count.js';
export { buildModelProjectionOptions } from './utils/modelProjectionOptions.js';

export {
  internalGitArgs,
  internalGitConfig,
  internalGitEnv,
} from './utils/gitCommandPolicy.js';

export { createGitCommandEnv } from './utils/gitUtils.js';

export { createQueryBusinessInfo } from './core/agent-lifecycle-state.js';

export { FatalRoutingError, isFatalRoutingError } from './routing/errors.js';
export {
  ModelNotFoundError,
  ModelNotAvailableError,
} from './utils/httpErrors.js';

export type { BuiltinSessionContext } from './builtin-plugins/types.js';

export {
  enableDetachedProcessGuard,
  stopDetachedProcessGuard,
  drainDetachedProcessGuard,
} from './services/detachedProcessGuard.js';

export type {
  ShellEnvironmentPreparation,
  ShellSpawnPreparationConfig,
} from './services/shellSpawnPreparation.js';
export type { ShellEnvironmentInvocation } from './tools/shell-environment.js';
export { stripSafeWrappers } from './tools/shell-permissions/shellPermissions.js';
export { PowerShellTool } from './tools/powerShell.js';
export type { EnvironmentSanitizationConfig } from './services/environmentSanitization.js';

export * from './model-request/retry-context.js';
export * from './config/modelRequestConfig.js';
export { getErrorStatus } from './utils/httpErrors.js';
export { readRetryAfterHeaderMs } from './utils/retry-after.js';
export { isResumableStreamFailure } from './model-request/stream-interruption.js';

export {
  parseBoolean,
  parseEnabledGateValue,
  parseObjectGateValue,
} from './config-service/features/gateParseUtils.js';

export {
  EmptyAssistantCompletionError,
  findEmptyAssistantCompletionError,
} from './model-request/empty-assistant-completion.js';

export {
  invokeClassifierJson,
  CLASSIFIER_MAX_OUTPUT_TOKENS,
} from './permissions/permission-modes/auto/classifier-invoke.js';

export {
  AutoClassifierView,
  SESSION_AUTO_KEY,
  type AutoClassifierSession,
  type AutoClassifierShadowComparison,
  type AutoClassifierShadowContext,
} from './permissions/permission-modes/auto/auto-classifier.js';

export { type ClassifierInvokeFn } from './permissions/permission-modes/auto/classifier.js';

export { readAutoJudgmentSettings } from './permissions/permission-modes/auto/jev-settings.js';

export { getBusinessInfoFromContext, getRequestSetIdFromContext } from './utils/sessionIdContext.js';

export {
  applyBusinessSubTask,
  resolveBusinessSubTask,
} from './qoder/business-info.js';

export {
  createGlobalCheckerMap,
  createGlobalCheckerDeps,
} from './permissions/manager/global-checkers.js';
export {
  qwenInternalPathDeps,
  resolveInternalPaths,
  type InternalPathContext,
  type InternalPathDeps,
  type InternalPathRoots,
  type InternalPathResolveContext,
} from './tools/filesystem-permissions/internal-path-deps.js';
export { resolveConfigDirectoryNames } from './config/configDirectory.js';
export { getConfigHomeDirOverride } from './utils/paths.js';
export { sanitizePath } from './utils/sanitizePath.js';
export { getTaskOutputBaseDir } from './utils/task/diskOutput.js';

export {
  LlmAutoJudge,
  JevAutoJudge,
  type AutoJudge,
  type AutoSessionJudges,
} from './permissions/permission-modes/auto/auto-judge.js';

// Runtime profiling (/profile): local diagnostics, no telemetry reporting.
export {
  BUN_CPU_PROFILING_UNSUPPORTED_MESSAGE,
  DEFAULT_PROFILE_LOG_INTERVAL_MS,
  MIN_PROFILE_LOG_INTERVAL_MS,
  RuntimeProfiler,
  formatLightweightProfileSample,
  getOrInitRuntimeProfiler,
  getRuntimeProfiler,
  initializeRuntimeProfiler,
  parseProfileLogIntervalMs,
  setProfileEncryption,
  type LightweightProfileSample,
  type ProfileChunkEncryptor,
  type ProfileEncryption,
  type ProfileResult,
  type ProfileType,
  type RuntimeProfilerOptions,
} from './utils/runtimeProfiler.js';
export { registerProfilingSignalHandlers } from './utils/runtimeProfilingSignals.js';

// Product telemetry: one cli_started log record over OTLP/HTTP.
export {
  CLI_STARTED_EVENT_NAME,
  DEFAULT_TELEMETRY_ENDPOINT,
  buildTelemetryLogsUrl,
  flushTelemetry,
  getTelemetryEndpoint,
  isTelemetryDisabled,
  reportCliStartedEvent,
  type CliStartedEventFields,
} from './telemetry/telemetry.js';
export {
  installStartupTraceRecorder,
  STARTUP_TRACE_FILE_NAME,
  StartupTraceRecorder,
  type StartupTraceFile,
  type StartupTraceMode,
  type StartupTraceRecorderOptions,
} from './startup/startupTraceRecorder.js';
