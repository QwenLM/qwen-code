/**
 * Agent Backend Abstraction Layer
 *
 * This module provides the Qwen backend interface used by sessions.
 *
 * Usage:
 * ```typescript
 * import { createAgent, type AgentBackend } from '@craft-agent/shared/agent/backend';
 *
 * const agent = createAgent({
 *   provider: 'qwen',
 *   workspace: myWorkspace,
 *   model: 'qwen3-coder',
 * });
 *
 * for await (const event of agent.chat('Hello')) {
 *   console.log(event);
 * }
 * ```
 */

// Core types
export type {
  AgentBackend,
  AgentProvider,
  CoreBackendConfig,
  BackendConfig,
  BackendHostRuntimeContext,
  PermissionCallback,
  PlanCallback,
  AuthCallback,
  SourceChangeCallback,
  SourceActivationCallback,
  ChatOptions,
  BackendSessionInfo,
  BackendSessionListOptions,
  BackendSessionListResult,
  RecoveryMessage,
  SdkMcpServerConfig,
  LlmAuthType,
  LlmProviderType,
  AvailableCommandsSnapshot,
  BackendSessionMessagesResult,
  PostInitResult,
} from './types.ts';

// Enums need to be exported as values, not just types
export { AbortReason } from './types.ts';

// Factory
export {
  createBackend,
  createAgent,
  detectProvider,
  getAvailableProviders,
  isProviderAvailable,
  // LLM Connection support
  connectionTypeToProvider,
  connectionAuthTypeToBackendAuthType,
  resolveSessionConnection,
  resolveBackendContext,
  resolveSetupTestConnectionHint,
  createConfigFromConnection,
  createBackendFromConnection,
  createBackendFromResolvedContext,
  initializeBackendHostRuntime,
  resolveBackendHostTooling,
  fetchBackendModels,
  validateStoredBackendConnection,
  providerTypeToAgentProvider,
  // Capabilities and utilities
  BACKEND_CAPABILITIES,
  resolveModelForProvider,
  getDefaultAuthType,
  cleanupSourceRuntimeArtifacts,
  testBackendConnection,
  // Connection validation
  validateConnection,
} from './factory.ts';

// Shared infrastructure
export { BaseEventAdapter } from './base-event-adapter.ts';
export { EventQueue } from './event-queue.ts';

// Agent implementation is imported directly by factory.ts
// Consumers should use createAgent() / createBackend() instead of concrete classes
