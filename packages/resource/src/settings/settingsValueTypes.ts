/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Settings data shapes only. Core retains its runtime/domain types.
import type { MCPServerConfig } from './mcpServerConfig.js';
import type { ModelConfig } from './modelConfigTypes.js';

/**
 * OAuth configuration for an MCP server.
 */
export interface MCPOAuthConfig {
  enabled?: boolean; // Whether OAuth is enabled for this server
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  issuer?: string;
  tokenUrl?: string;
  scopes?: string[];
  audiences?: string[];
  redirectUri?: string;
  tokenParamName?: string; // For SSE connections, specifies the query parameter name for the token
  registrationUrl?: string;
  // Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs).
  callbackPort?: number;
  resource?: string;
}

export interface AgentRunConfig {
  maxTimeMinutes?: number;
  maxTurns?: number;
}

/**
 * Override configuration for a specific agent.
 * Generic fields (modelConfig, runConfig, enabled) are standard across all agents.
 */
export interface AgentOverride {
  modelConfig?: ModelConfig;
  runConfig?: AgentRunConfig;
  enabled?: boolean;
  tools?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface CustomTheme {
  type: 'custom';
  name: string;

  text?: {
    primary?: string;
    secondary?: string;
    link?: string;
    accent?: string;
    response?: string;
  };
  background?: {
    primary?: string;
    diff?: {
      added?: string;
      removed?: string;
    };
  };
  border?: {
    default?: string;
  };
  ui?: {
    comment?: string;
    symbol?: string;
    active?: string;
    focus?: string;
    gradient?: string[];
  };
  status?: {
    error?: string;
    success?: string;
    warning?: string;
  };

  // Legacy properties (all optional)
  Background?: string;
  Foreground?: string;
  LightBlue?: string;
  AccentBlue?: string;
  AccentPurple?: string;
  AccentCyan?: string;
  AccentGreen?: string;
  AccentYellow?: string;
  AccentRed?: string;
  DiffAdded?: string;
  DiffRemoved?: string;
  Comment?: string;
  Gray?: string;
  DarkGray?: string;
  GradientColors?: string[];
}

/**
 * Per-model persisted user preferences. Generation fields are flattened for a
 * hand-editable settings shape; `contextWindow` lives alongside them.
 */
export interface ModelPreferenceEntry extends LlmGenerationConfig {
  contextWindow?: number;
  /**
   * Deprecated settings compatibility only. New settings flatten generation
   * fields directly onto this preference entry.
   * @deprecated Use the flattened generation fields on ModelPreferenceEntry.
   */
  generation?: LlmGenerationConfig;
  /** @deprecated Function switches were removed; kept so old settings stay valid. */
  functionSwitchSelections?: Record<string, string>;
}

export type ReasoningEffortLevel =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/**
 * Unified client-side reasoning configuration. This is the single internal
 * representation; each transport projects it to its own wire field names.
 */
export interface LlmReasoningConfig {
  /** Explicit provider-independent thinking mode. */
  thinking?: LlmThinkingConfig;
  /** Whether thinking is enabled using the model's provider-native mode. */
  enabled?: boolean;
  effort?: ReasoningEffortLevel;
  /** @deprecated Compatibility input only. Use `thinking.budgetTokens`. */
  budgetTokens?: number;
  /** Preserve prior thinking across turns. */
  preserve?: boolean;
}

export type LlmThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' };

/**
 * Persisted generation fields under `model.preferences[modelId]`.
 */
export interface LlmGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  reasoning?: LlmReasoningConfig;
}

export interface SessionRetentionSettings {
  /** Enable automatic session and tool output cleanup (disabled by default). Excludes diagnostic logs. */
  enabled?: boolean;

  /** Maximum age of sessions to keep (e.g., "30d", "7d", "24h", "1w") */
  maxAge?: string;

  /**
   * Maximum number of count-limited cleanup targets to keep.
   * Transcript JSONL files ignore maxCount and are deleted only by maxAge.
   */
  maxCount?: number;

  /** Minimum retention period (safety limit, defaults to "1d") */
  minRetention?: string;
}
