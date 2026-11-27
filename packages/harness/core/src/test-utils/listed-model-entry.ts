/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomProviderAdapterKind } from '../provider/custom/types.js';
import type {
  ContextConfig,
  ThinkingConfig,
  ModelStrategy,
  ServerModelJson,
} from '../qoder/models/types.js';

/** Legacy snake_case model shape retained only for test fixtures. */
export interface ListedModelEntryFixture {
  /** Unique model key, e.g. 'qwen-max', 'deepseek-v3'. */
  key: string;
  /** Human-readable name for UI display. */
  display_name: string;
  /** Whether this is the server-designated default model. */
  is_default: boolean;
  /** Whether this model is currently enabled. */
  enable: boolean;
  /** Whether this model supports reasoning / chain-of-thought. */
  is_reasoning: boolean;
  /** Whether this model supports multimodal/vision input. */
  is_vl: boolean;
  /** Whether this is a newly-launched model. */
  is_new: boolean;
  /** Whether this model is currently free to use. */
  is_free?: boolean;
  /** Explicit reasoning effort levels supported by this model. */
  efforts?: string[];
  /** Whether the model supports disabling thinking explicitly. */
  supports_disabled?: boolean;
  /** Server-designated default reasoning effort, when provided. */
  default_effort?: string;
  /** Maximum input token count. */
  max_input_tokens: number;
  /** Local fallback budget; not a verified upstream model capacity. */
  context_window_is_estimate?: boolean;
  /** Supported configurable context window sizes in tokens. */
  available_context_windows?: number[];
  /** Server-designated default configurable context window, when provided. */
  default_context_window?: number;
  /**
   * Raw `context_config` block from the server, preserved structure-for-structure.
   * Keys are tier labels ("200K" / "1M" / "400K"); values carry token_count + is_default.
   */
  context_config?: ContextConfig;
  /**
   * Raw `thinking_config` block from the server, preserved structure-for-structure.
   * Carries the rich shape including effort descriptions and `is_default` markers.
   */
  thinking_config?: ThinkingConfig;
  /** Maximum output token count. */
  max_output_tokens: number;
  /** Price factor relative to base model (1.0 = standard). */
  price_factor?: number;
  /** Original price factor before discounts. */
  original_price_factor?: number;
  /** Model provider source, e.g. 'system', 'user' (user-supplied connection). */
  source: string;
  /** 外部模型渠道，例如 "cmcc"；普通模型与直连模型不设置。 */
  outer_provider?: string;
  /** Output format, e.g. 'openai', 'dashscope'. */
  format: string;
  /** Local Custom Provider adapter retained for transport/error attribution. */
  custom_provider_adapter?: CustomProviderAdapterKind;
  /**
   * Optional icon for the model — server-provided string (URL, emoji, or
   * provider identifier). Forwarded verbatim; consumers decide how to render.
   */
  icon?: string;
  /** Optional custom model URL. */
  url?: string;
  /** For direct-connection models: the bare model identifier within the provider, e.g. "gpt-4o". */
  model?: string;
  /** For direct-connection models: the provider key, e.g. "openai", "deepseek". */
  provider?: string;
  /** For direct-connection models: provider model type key from the provider catalog. */
  type?: string;
  /** Tags, e.g. ['limited_time_free']. */
  tags: string[];
  /** Usage scene / purpose description. */
  scene?: string;
  /** Original top-level key in the server model-list response. */
  server_scene?: string;
  /**
   * Codebase security tag strategies.
   * Defines whether this model is available when the workspace repo carries
   * a given security tag (e.g. 'C4').  Absent → no restriction.
   */
  strategies?: ModelStrategy[];
  /** Promotion / discount info from the model list API, cached for the UI. */
  promotion?: Record<string, unknown>;
  /** Raw server entry from the model list API for SDK host extensions. */
  server_model?: ServerModelJson;
}
