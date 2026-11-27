/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Shared primitive value types for the CLI ↔ SDK wire protocol.
 *
 * Anything callback-shaped or carrying a runtime instance lives in the SDK
 * package, not here.
 */
import type { BetaMessage, BetaRawMessageStreamEvent, BetaUsage, BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
export type { BetaMessage, BetaRawMessageStreamEvent, BetaUsage, BetaStopReason, MessageParam, };
/**
 * Wire-level UUID. We deliberately type it as plain `string` rather than
 * `crypto.UUID`'s template literal — the wire is a string, and using a
 * template literal made downstream zod schemas unable to express required
 * fields (zod treats template literals as `T | undefined` in `_input`).
 *
 * Consumers that want stricter UUID handling can cast at the boundary.
 */
export type UUID = string;
/**
 * `BetaUsage` with every field non-null AND required.
 *
 * Anthropic's BetaUsage marks fields like `cache_creation_input_tokens` as
 * `number | null | undefined`, but the runtime always emits a number (zeroed
 * if absent). We tighten that here to remove null-checking noise on the
 * SDK side. The optional `request_id` is a product-specific extension threaded
 * through for tracing persisted transcripts.
 */
export type NonNullableUsage = {
    [K in keyof BetaUsage]-?: NonNullable<BetaUsage[K]>;
} & {
    request_id?: string;
};
export type AccountInfo = {
    userId?: string;
    name?: string;
    email?: string;
    organization?: string;
    organizationName?: string;
    subscriptionType?: string;
    tokenSource?: string;
    apiKeySource?: string;
    apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry';
};
export type ApiKeySource = 'none' | 'user' | 'project' | 'org' | 'temporary' | 'oauth';
export type ExitReason = 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | 'bypass_permissions_disabled';
export type FastModeState = 'off' | 'cooldown' | 'on';
export type ConfigScope = 'local' | 'user' | 'project';
export type SettingSource = 'user' | 'project' | 'local';
export type SDKAssistantMessageError = 'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens';
export type SDKStatus = 'compacting' | null;
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export type ThinkingAdaptive = {
    type: 'adaptive';
};
export type ThinkingEnabled = {
    type: 'enabled';
    budgetTokens?: number;
};
export type ThinkingDisabled = {
    type: 'disabled';
};
export type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled;
export type OutputFormatType = 'json_schema';
export type JsonSchemaOutputFormat = {
    type: 'json_schema';
    schema: Record<string, unknown>;
};
export type OutputFormat = JsonSchemaOutputFormat;
export type BaseOutputFormat = {
    type: OutputFormatType;
};
export type ModelInfo = {
    value: string;
    displayName: string;
    description: string;
    isEnabled?: boolean;
    isNew?: boolean;
};
export type PluginInfo = {
    name: string;
    path: string;
    source?: string;
};
export type ModelUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUSD: number;
    contextWindow: number;
    maxOutputTokens: number;
};
export type SlashCommand = {
    name: string;
    description: string;
    argumentHint: string;
};
export type ToolConfig = {
    askUserQuestion?: {
        previewFormat?: 'markdown' | 'html';
    };
};
export type SdkPluginConfig = {
    type: 'local';
    path: string;
};