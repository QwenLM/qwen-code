/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  createGatewayApp,
  type GatewayDeps,
  type GatewayApp,
} from './server.js';
export {
  startDaemon,
  type DaemonHandle,
  type SpawnedDaemon,
  type StartDaemonOptions,
} from './daemonSupervisor.js';
export { TokenStore, type TokenInfo, type ShareInfo } from './tokenStore.js';
export { PairingService } from './pairing.js';
export { ConnectionRegistry } from './connectionRegistry.js';
export {
  AuditLog,
  AUDIT_ACTIONS,
  type AuditEntry,
  type AuditAction,
  type AuditRecord,
  type AuditQuery,
  type AuditRecorder,
  type AuditReader,
} from './auditLog.js';
export { createAuditQueryRoute } from './routes/audit.js';
export { bearerResolve, requireScope, enforceSessionLock } from './auth.js';
export {
  SESSION_READ,
  OWNER,
  APPROVE,
  WRITE,
  SHARE,
  BRIDGE,
  KNOWN_SCOPES,
  type RcScope,
} from './scopes.js';
export {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';
export { createShareRouter } from './routes/share.js';
export { selectAllowOnceOptionId } from './permissionOptions.js';
export { runServe, type ServeOptions } from './cli.js';
export { createPermissionVoteRoute } from './routes/permission.js';
export { createPromptRoute } from './routes/prompt.js';
export { VapidStore, type VapidKeys } from './webpush/vapid.js';
export { PushStore, type PushSubscriptionRecord } from './pushStore.js';
export { createPushRouter } from './routes/push.js';
export {
  buildPayload,
  buildDigestPayload,
  type PushPayload,
} from './webpush/payload.js';
export {
  QuietDigestWatcher,
  type QuietDigestRecord,
} from './webpush/quietDigestWatcher.js';
export {
  PushSender,
  type PushTransport,
  type PushTransportResult,
  type PushSenderOptions,
} from './webpush/sender.js';
export { PushNotifier } from './webpush/notifier.js';
export {
  PushRateLimiter,
  DEFAULT_MAX_PER_HOUR,
  type RateLimitResult,
} from './webpush/rateLimiter.js';
export {
  PushCoalescer,
  DEFAULT_COALESCE_WINDOW_MS,
} from './webpush/coalescer.js';
export { PushDigest, type DigestSummary } from './webpush/digest.js';
export {
  SessionEventPump,
  type SessionEventPumpOptions,
  type PumpNotifier,
} from './webpush/pump.js';
export {
  loadPolicy,
  loadPolicyFile,
  loadLayeredPolicy,
  mergePolicies,
  lintPolicyFile,
  formatPolicyLint,
  type PolicyLintResult,
  PolicyError,
  type Policy,
  type PolicyRule,
  type PolicyRuleMatch,
  type PolicyAction,
} from './policy/loader.js';
export {
  evaluate,
  explainPolicy,
  type PolicyDecision,
  type ToolCallContext,
  type QuotaOracle,
  type RuleTrace,
  type PolicyExplanation,
} from './policy/evaluator.js';
export {
  parseExplainArgs,
  formatExplanation,
  type ParsedExplain,
} from './policy/explain.js';
export { PolicyEnforcer } from './policy/enforcer.js';
export {
  QuotaStore,
  FileQuotaWal,
  MemoryQuotaWal,
  quotaLimitsFromPolicy,
  type QuotaLimit,
  type QuotaState,
  type QuotaRecord,
  type QuotaWal,
} from './policy/quotas.js';
export {
  PolicyReloader,
  type PolicyReloaderOptions,
} from './policy/reloader.js';
export {
  SnoozeStore,
  type SnoozeState,
  type SnoozeEntry,
} from './routing/snooze.js';
export {
  WorkingDeviceTracker,
  recordActivity,
} from './routing/workingDevice.js';
export { createRoutingRouter } from './routes/routing.js';
export {
  loadRoutingConfig,
  loadRoutingConfigFile,
  loadLayeredRoutingMatcher,
  loadResolvedRoutingRules,
  formatResolvedRouting,
  mergeRoutingConfigs,
  compileRouting,
  RoutingError,
  type ResolvedRoutingRule,
  type RoutingRule,
  type RoutingRuleMatch,
  type RoutingConfig,
  type RoutingMatcher,
} from './routing/rules.js';
export {
  searchTranscripts,
  searchTranscriptsDetailed,
  SearchTimeoutError,
  type SearchHit,
  type SearchResult,
  type SearchOptions,
} from './search/transcripts.js';
export { createSearchRoute } from './routes/search.js';
export {
  parseSearchArgs,
  formatSearchResults,
  type ParsedSearchArgs,
} from './search/searchCli.js';
export { createForkRoute, type ForkRouteDeps } from './routes/fork.js';
export {
  // The single canonical chats-path resolver: sanitizeCwd + runtime-base exact,
  // byte-identical to the daemon's write path (proven by the fork e2e). Used by
  // the search route, the fork route, and the e2e. `resolveForkChatsDir` is a
  // back-compat alias kept only so scripts/rc-gateway-e2e.mjs stays untouched.
  resolveChatsDir,
  resolveChatsDir as resolveForkChatsDir,
  isValidSessionId,
  SESSION_FILE_RE,
} from './sessions/chatsPath.js';
export { parseFrontMatter, substitute } from './commands/parse.js';
export {
  CommandLoader,
  type LoadedCommand,
  type CommandScope,
} from './commands/loader.js';
export {
  createListCommandsRoute,
  createInvokeCommandRoute,
  mapDeclaredScope,
  ifNoneMatchSatisfied,
} from './routes/commands.js';
