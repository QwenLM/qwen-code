/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import { GenerateContentResponse } from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
type Message = Anthropic.Message;
type MessageCreateParamsNonStreaming =
  Anthropic.MessageCreateParamsNonStreaming;
type MessageCreateParamsStreaming = Anthropic.MessageCreateParamsStreaming;
type RawMessageStreamEvent = Anthropic.RawMessageStreamEvent;
import { RequestTokenEstimator } from '../../utils/request-tokenizer/index.js';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { AnthropicContentConverter } from './converter.js';
import {
  buildRuntimeFetchOptions,
  redactProxyError,
} from '../../utils/runtimeFetchOptions.js';
import { DEFAULT_TIMEOUT } from '../openaiContentGenerator/constants.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  tokenLimit,
  CAPPED_DEFAULT_MAX_TOKENS,
  hasExplicitOutputLimit,
} from '../tokenLimits.js';

const debugLogger = createDebugLogger('ANTHROPIC');

/**
 * Hostname-only DeepSeek anthropic-compatible detector. Returns true ONLY
 * when the resolved baseURL hostname is `api.deepseek.com` or one of its
 * subdomains (e.g. `us.api.deepseek.com`). Use this for decisions where a
 * false positive would route DeepSeek-only behavior to a stricter backend
 * — e.g. clamping `reasoning.effort: 'max'`, where matching by model name
 * could send `'max'` to real `api.anthropic.com` and trigger HTTP 400.
 */
function isDeepSeekAnthropicHostname(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  const baseUrl = contentGeneratorConfig.baseUrl ?? '';
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com')
    );
  } catch {
    return false;
  }
}

/**
 * DeepSeek's anthropic-compatible API rejects requests in thinking mode when
 * a prior assistant turn carrying `tool_use` omits a thinking block.
 * Plain-text assistant turns without thinking are accepted unchanged. Detect
 * the provider by base URL hostname or model name so the converter can inject
 * empty thinking blocks on the affected turns. The model-name fallback is
 * intentional — it covers self-hosted DeepSeek deployments behind generic
 * anthropic-compatible endpoints (sglang/vllm). For decisions where a model-
 * name false positive is dangerous (e.g. `reasoning.effort: 'max'` clamping),
 * use `isDeepSeekAnthropicHostname` instead.
 * https://github.com/QwenLM/qwen-code/issues/3786
 */
function isDeepSeekAnthropicProvider(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  if (isDeepSeekAnthropicHostname(contentGeneratorConfig)) return true;
  const model = (contentGeneratorConfig.model ?? '').toLowerCase();
  return model.includes('deepseek');
}

/**
 * Resolve the baseURL the Anthropic SDK will actually use, mirroring the
 * SDK's own destructuring-default order: explicit config first, then
 * `ANTHROPIC_BASE_URL` env, then the SDK default. Returns the SDK default
 * literal when nothing is configured so callers can do hostname matching
 * without a special case for the empty path.
 *
 * Both inputs get the SDK's `readEnv`-style normalization
 * (whitespace-trim + empty-as-missing). Trimming the config side too
 * prevents a copy-pasted baseURL with stray whitespace from tripping
 * `new URL(...)` in `isAnthropicNativeBaseUrl`, which would otherwise
 * fall through the catch branch to proxy identity and ship Bearer auth
 * against the real Anthropic API.
 */
function resolveEffectiveBaseUrl(
  contentGeneratorConfig: ContentGeneratorConfig,
): string {
  const fromConfig = contentGeneratorConfig.baseUrl?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env['ANTHROPIC_BASE_URL']?.trim();
  if (fromEnv) return fromEnv;
  return 'https://api.anthropic.com';
}

/**
 * Whether the resolved baseURL is Anthropic's native API (or the SDK default
 * when no baseURL is set). Used to gate IdeaLab-style proxy workarounds —
 * `Authorization: Bearer` auth and the `claude-cli` User-Agent — so that
 * users hitting `api.anthropic.com` directly keep the SDK-default
 * `x-api-key` auth and a truthful `QwenCode` User-Agent (avoids identity
 * misattribution in Anthropic-side logs/quotas).
 */
function isAnthropicNativeBaseUrl(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  try {
    const hostname = new URL(
      resolveEffectiveBaseUrl(contentGeneratorConfig),
    ).hostname.toLowerCase();
    return (
      hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com')
    );
  } catch {
    return false;
  }
}

type StreamingBlockState = {
  type: string;
  id?: string;
  name?: string;
  inputJson: string;
  signature: string;
};

// Two thinking shapes — the budget-tokens shape for pre-4.6 Claude families
// and the adaptive shape for 4.6+. Centralized so the message-params type,
// the streaming-request override, and `buildThinkingConfig`'s return type
// stay in lockstep when a third shape (e.g. `extended`) eventually lands.
type AnthropicThinkingParam =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' };

type MessageCreateParamsWithThinking = MessageCreateParamsNonStreaming & {
  thinking?: AnthropicThinkingParam;
  // Anthropic beta feature: output_config.effort (requires beta header effort-2025-11-24)
  // This is not yet represented in the official SDK types we depend on. The
  // 'max' tier is a DeepSeek extension (see contentGenerator.ts comment).
  output_config?: { effort: 'low' | 'medium' | 'high' | 'max' };
};

export class AnthropicContentGenerator implements ContentGenerator {
  private client: Anthropic;
  private converter: AnthropicContentConverter;
  // Latch so the 'max' clamp warning fires once per generator lifetime
  // instead of on every request that needs the downgrade.
  private effortClampWarned = false;

  constructor(
    private contentGeneratorConfig: ContentGeneratorConfig,
    private readonly cliConfig: Config,
  ) {
    // One predicate drives the whole IdeaLab-style proxy compatibility
    // bundle: `Authorization: Bearer` auth, `claude-cli` User-Agent, and
    // `x-app: cli`. Two locally-named booleans for the same thing would
    // obscure that coupling and tempt a future contributor to split one
    // half of the bundle without the other.
    const useProxyIdentity = !isAnthropicNativeBaseUrl(contentGeneratorConfig);
    const defaultHeaders = this.buildHeaders(useProxyIdentity);
    const baseURL = contentGeneratorConfig.baseUrl;
    // Configure fetch options for proxy support and timeout handling.
    // With proxy, dispatcher timeouts are disabled so SDK timeout controls the
    // request; without proxy, no custom dispatcher is installed.
    const runtimeOptions = buildRuntimeFetchOptions(
      'anthropic',
      this.cliConfig.getProxy(),
    );

    // IdeaLab-style Anthropic proxies expect `Authorization: Bearer <token>`
    // instead of the SDK-default `x-api-key` header. Use the SDK's
    // `authToken` parameter (sends `Authorization: Bearer` natively) only
    // when targeting a non-Anthropic-native baseURL — direct
    // `api.anthropic.com` users keep the SDK-default `apiKey` (`x-api-key`)
    // path so they don't break against the Anthropic API itself.
    //
    // Pass `null` on the unused side rather than omitting it: the SDK
    // destructures with defaults (`apiKey = readEnv('ANTHROPIC_API_KEY') ?? null`,
    // same for `authToken`), and destructuring defaults fire ONLY for
    // `undefined`. Omitting the field would let `ANTHROPIC_API_KEY` /
    // `ANTHROPIC_AUTH_TOKEN` env back-fill it; the SDK's auth resolver
    // then prefers `apiKey` over `authToken`, so a user with
    // `ANTHROPIC_API_KEY=sk-ant-…` exported (common for anyone who also
    // runs Claude Code in the same shell) would ship their real Anthropic
    // key as `X-Api-Key` to the IdeaLab proxy — leaking the credential to
    // a third-party endpoint. Explicit `null` suppresses the back-fill
    // and forces the intended auth path.
    this.client = new Anthropic({
      ...(useProxyIdentity
        ? { authToken: contentGeneratorConfig.apiKey, apiKey: null }
        : { apiKey: contentGeneratorConfig.apiKey, authToken: null }),
      baseURL,
      timeout: contentGeneratorConfig.timeout || DEFAULT_TIMEOUT,
      maxRetries: contentGeneratorConfig.maxRetries,
      defaultHeaders,
      ...runtimeOptions,
    });

    this.converter = new AnthropicContentConverter(
      contentGeneratorConfig.model,
      contentGeneratorConfig.schemaCompliance,
      contentGeneratorConfig.enableCacheControl,
    );
  }

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    let response: Message;
    try {
      const anthropicRequest = await this.buildRequest(request);
      const headers = this.buildPerRequestHeaders(anthropicRequest);
      response = (await this.client.messages.create(anthropicRequest, {
        signal: request.config?.abortSignal,
        ...(headers ? { headers } : {}),
      })) as Message;
    } catch (error) {
      throw redactProxyError(error);
    }

    return this.converter.convertAnthropicResponseToGemini(response);
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const anthropicRequest = await this.buildRequest(request);
    const headers = this.buildPerRequestHeaders(anthropicRequest);
    const streamingRequest: MessageCreateParamsStreaming & {
      thinking?: AnthropicThinkingParam;
    } = {
      ...anthropicRequest,
      stream: true,
    };

    let stream: AsyncIterable<RawMessageStreamEvent>;
    try {
      stream = (await this.client.messages.create(
        streamingRequest as MessageCreateParamsStreaming,
        {
          signal: request.config?.abortSignal,
          ...(headers ? { headers } : {}),
        },
      )) as AsyncIterable<RawMessageStreamEvent>;
    } catch (error) {
      throw redactProxyError(error);
    }

    return this.processStream(this.redactStreamErrors(stream));
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    try {
      const estimator = new RequestTokenEstimator();
      const result = await estimator.calculateTokens(request);

      return {
        totalTokens: result.totalTokens,
      };
    } catch (error) {
      debugLogger.warn(
        'Failed to calculate tokens with tokenizer, ' +
          'falling back to simple method:',
        error,
      );

      const content = JSON.stringify(request.contents);
      const totalTokens = Math.ceil(content.length / 4);
      return {
        totalTokens,
      };
    }
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Anthropic does not support embeddings.');
  }

  useSummarizedThinking(): boolean {
    return false;
  }

  private buildHeaders(useProxyIdentity: boolean): Record<string, string> {
    // Beta headers are computed per-request in buildPerRequestHeaders so they
    // stay in sync with what the request body actually carries — see #3788
    // review feedback. Constructor headers carry User-Agent, the
    // proxy-only `x-app: cli` (when useProxyIdentity is true), and any
    // user-supplied custom headers EXCEPT anthropic-beta (any casing):
    // the per-request path owns that header, and copying it into
    // defaultHeaders would cause two physical headers on the wire (one
    // mixed-case, one lowercase) when the per-request override fires.
    const version = this.cliConfig.getCliVersion() || 'unknown';
    // For non-Anthropic-native baseURLs (IdeaLab-style proxies), present as
    // `claude-cli` + `x-app: cli` to satisfy proxy Team rules that restrict
    // usage by client identity. For api.anthropic.com itself we keep the
    // truthful QwenCode User-Agent so usage isn't misattributed to Claude
    // CLI in Anthropic's logs/quotas, and we don't ship the proxy-specific
    // `x-app` header. Predicate is computed once at construction and shared
    // with the auth-mode decision so the bundle stays internally consistent.
    const userAgent = useProxyIdentity
      ? `claude-cli/${version} (external, cli)`
      : `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { customHeaders } = this.contentGeneratorConfig;

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
    };
    if (useProxyIdentity) {
      headers['x-app'] = 'cli';
    }
    if (customHeaders) {
      for (const [key, value] of Object.entries(customHeaders)) {
        if (key.toLowerCase() === 'anthropic-beta') continue;
        headers[key] = value;
      }
    }
    return headers;
  }

  /**
   * Compute `anthropic-beta` from the actual fields present in the request
   * body. Keeps the header consistent with the body even when a per-request
   * `thinkingConfig.includeThoughts: false` opt-out drops `thinking` /
   * `output_config` after the constructor has already run.
   *
   * User-supplied `customHeaders['anthropic-beta']` flags are merged in (and
   * deduped) so the per-request override doesn't wipe out the existing
   * customHeaders escape hatch for unrelated beta features. The lookup is
   * case-insensitive — HTTP header names are case-insensitive by spec, so a
   * user-configured `Anthropic-Beta` or `ANTHROPIC-BETA` is honored too.
   */
  private buildPerRequestHeaders(
    anthropicRequest: MessageCreateParamsWithThinking,
  ): Record<string, string> | undefined {
    const betas: string[] = [];

    for (const flag of this.collectCustomBetaFlags()) {
      betas.push(flag);
    }

    if (anthropicRequest.thinking) {
      betas.push('interleaved-thinking-2025-05-14');
    }
    if (anthropicRequest.output_config) {
      betas.push('effort-2025-11-24');
    }

    // The `prompt-caching-scope-2026-01-05` beta is meaningful only when
    // the body actually carries a `cache_control: { …, scope: 'global' }`
    // entry. The converter emits those entries on the system text block
    // and the last tool entry when `useGlobalCacheScope` is true (gated
    // on `enableCacheControl !== false` AND Anthropic-native baseURL).
    // Scan the assembled request body for that field rather than
    // re-deriving the gate here, so:
    //   1. The beta and the body-side field share a single source of
    //      truth — there's no window between sampling the predicate and
    //      emitting the body where the two could diverge.
    //   2. The degenerate empty-system + no-tools case (predicate true,
    //      body has nothing to attach scope to) doesn't ship the beta as
    //      dead weight.
    //   3. Anthropic-compatible proxies that disable cache stay clean —
    //      no body-side scope field means no beta either.
    if (this.hasGlobalCacheScopeOnWire(anthropicRequest)) {
      betas.push('prompt-caching-scope-2026-01-05');
    }

    if (betas.length === 0) return undefined;
    const unique = Array.from(new Set(betas));
    return { 'anthropic-beta': unique.join(',') };
  }

  /**
   * Whether to ATTACH the body-side `scope: 'global'` field on
   * `cache_control` entries this request. Requires both
   * `enableCacheControl !== false` AND an Anthropic-native baseURL.
   * Computed per request: `Config.handleModelChange()` hot-updates
   * `enableCacheControl` in-place on the qwen-oauth path (without
   * recreating the ContentGenerator); non-qwen-oauth providers refresh
   * via generator recreation, which captures `baseUrl` fresh at
   * construct time (not mutated). Reading both fields each request is
   * the right defense — cheap and avoids stale-cache surprises if the
   * hot-update list ever expands.
   *
   * The matching `prompt-caching-scope-2026-01-05` beta header is NOT
   * gated on this predicate directly; instead `buildPerRequestHeaders`
   * scans the assembled body via `hasGlobalCacheScopeOnWire` so the beta
   * and the body field always agree even in degenerate cases (e.g.
   * empty-system + no-tools request — predicate true, body has nothing
   * to attach scope to, beta correctly suppressed).
   */
  private useGlobalCacheScope(): boolean {
    return (
      this.contentGeneratorConfig.enableCacheControl !== false &&
      isAnthropicNativeBaseUrl(this.contentGeneratorConfig)
    );
  }

  /**
   * Whether the assembled request body carries any
   * `cache_control: { …, scope: 'global' }` entry. Scans the system
   * block (when present as TextBlockParam[]) and the tools array — these
   * are the only two places the converter attaches scoped cache control.
   * Used to gate the `prompt-caching-scope-2026-01-05` beta header so it
   * never ships without a matching body field, and conversely so the
   * field never ships without the beta declaring it.
   */
  private hasGlobalCacheScopeOnWire(
    req: MessageCreateParamsWithThinking,
  ): boolean {
    const isGlobalScope = (block: unknown): boolean => {
      if (!block || typeof block !== 'object') return false;
      const cc = (block as { cache_control?: unknown }).cache_control;
      if (!cc || typeof cc !== 'object') return false;
      return (cc as { scope?: string }).scope === 'global';
    };

    if (Array.isArray(req.system)) {
      for (const block of req.system) {
        if (isGlobalScope(block)) return true;
      }
    }
    if (Array.isArray(req.tools)) {
      for (const tool of req.tools) {
        if (isGlobalScope(tool)) return true;
      }
    }
    return false;
  }

  /**
   * Read every customHeaders entry whose key (case-insensitively) is
   * `anthropic-beta` and yield the comma-separated flags from each. Multiple
   * matching entries are concatenated; later ones may produce duplicates
   * which the caller dedupes.
   */
  private collectCustomBetaFlags(): string[] {
    const customHeaders = this.contentGeneratorConfig.customHeaders;
    if (!customHeaders) return [];

    const flags: string[] = [];
    for (const [key, value] of Object.entries(customHeaders)) {
      if (key.toLowerCase() !== 'anthropic-beta') continue;
      if (typeof value !== 'string' || !value) continue;
      for (const flag of value.split(',')) {
        const trimmed = flag.trim();
        if (trimmed) flags.push(trimmed);
      }
    }
    return flags;
  }

  private async buildRequest(
    request: GenerateContentParameters,
  ): Promise<MessageCreateParamsWithThinking> {
    const sampling = this.buildSamplingParameters(request);
    // Normalize reasoning.effort once per request (clamps DeepSeek-only
    // 'max' to 'high' for stricter Anthropic backends and logs the
    // downgrade once). Both the thinking budget ladder and output_config
    // consume the result so the wire shape stays internally consistent.
    const effectiveEffort = this.resolveEffectiveEffort(request);
    const thinking = this.buildThinkingConfig(request, effectiveEffort);
    const outputConfig = this.buildOutputConfig(request, effectiveEffort);

    // Compute per-request: `Config.setModel()` mutates contentGeneratorConfig
    // in place, so a constructor-time cache could go stale on a runtime
    // model switch. The detector is cheap (URL parse + string compare).
    const isDeepSeek = isDeepSeekAnthropicProvider(this.contentGeneratorConfig);

    // On DeepSeek the converter must keep history aligned with the top-level
    // `thinking` parameter to avoid HTTP 400:
    //   - thinking on  → inject empty thinking on tool_use turns missing one
    //                    (issue #3786 trigger)
    //   - thinking off → strip pre-existing thinking blocks from assistant
    //                    history so a request without `thinking` config
    //                    doesn't ship stray thinking blocks. Matters for
    //                    code paths that pass `includeThoughts: false`
    //                    against a session whose history already contains
    //                    `thought: true` parts (suggestionGenerator /
    //                    ArenaManager / forkedAgent).
    const deepseekThinkingOn = isDeepSeek && !!thinking;
    const stripAssistantThinking = isDeepSeek && !thinking;

    // Sample the live cache-control flags once per request and forward
    // them to the converter (body-side `cache_control`). The converter's
    // constructor-time value would otherwise diverge from the live value
    // on the qwen-oauth path, where `Config.handleModelChange()`
    // hot-updates `enableCacheControl` in place without recreating the
    // ContentGenerator. (Non-qwen-oauth providers refresh via generator
    // recreation, so `baseUrl` is captured fresh at construct time, not
    // mutated mid-session — defensive per-request reads on both fields
    // cover both paths.) `useGlobalCacheScope` is a strict subset of
    // `enableCacheControl` (true only when caching is on AND the resolved
    // baseURL is Anthropic-native) and governs whether the body's
    // `cache_control` entries carry `scope: 'global'`. The matching
    // `prompt-caching-scope-2026-01-05` beta isn't passed through this
    // sample — `buildPerRequestHeaders` instead scans the assembled body
    // via `hasGlobalCacheScopeOnWire` so beta and body field share a
    // single source of truth.
    const enableCacheControl =
      this.contentGeneratorConfig.enableCacheControl !== false;
    const useGlobalCacheScope = this.useGlobalCacheScope();

    const { system, messages } = this.converter.convertGeminiRequestToAnthropic(
      request,
      {
        // Both run together: normalization fills missing signatures so the
        // injection pass treats those blocks as already-present, and the
        // injection adds a synthetic block on tool_use turns lacking one.
        normalizeAssistantThinkingSignature: deepseekThinkingOn,
        injectThinkingOnToolUseTurns: deepseekThinkingOn,
        stripAssistantThinking,
        enableCacheControl,
        useGlobalCacheScope,
      },
    );

    const tools = request.config?.tools
      ? await this.converter.convertGeminiToolsToAnthropic(
          request.config.tools,
          { enableCacheControl, useGlobalCacheScope },
        )
      : undefined;

    return {
      model: this.contentGeneratorConfig.model,
      system,
      messages,
      tools,
      ...sampling,
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
    };
  }

  private buildSamplingParameters(request: GenerateContentParameters): {
    max_tokens: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
  } {
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;
    const requestConfig = request.config || {};

    const getParam = <T>(
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof requestConfig>,
    ): T | undefined => {
      const configValue = configSamplingParams?.[configKey] as T | undefined;
      const requestValue = requestKey
        ? (requestConfig[requestKey] as T | undefined)
        : undefined;
      return configValue !== undefined ? configValue : requestValue;
    };

    // Apply output token limit logic consistent with OpenAI providers
    const userMaxTokens = getParam<number>('max_tokens', 'maxOutputTokens');
    const modelId = this.contentGeneratorConfig.model;
    const modelLimit = tokenLimit(modelId, 'output');
    const isKnownModel = hasExplicitOutputLimit(modelId);

    let maxTokens: number;
    if (userMaxTokens !== undefined && userMaxTokens !== null) {
      maxTokens = isKnownModel
        ? Math.min(userMaxTokens, modelLimit)
        : userMaxTokens;
    } else {
      // No explicit user config — check env var, then use capped default.
      const envVal = process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];
      const envMaxTokens = envVal ? parseInt(envVal, 10) : NaN;
      if (!isNaN(envMaxTokens) && envMaxTokens > 0) {
        maxTokens = isKnownModel
          ? Math.min(envMaxTokens, modelLimit)
          : envMaxTokens;
      } else {
        maxTokens = Math.min(modelLimit, CAPPED_DEFAULT_MAX_TOKENS);
      }
    }

    return {
      max_tokens: maxTokens,
      temperature: getParam<number>('temperature', 'temperature') ?? 1,
      top_p: getParam<number>('top_p', 'topP'),
      top_k: getParam<number>('top_k', 'topK'),
    };
  }

  /**
   * Compute the effort value that both the thinking budget ladder and
   * output_config should use for this request. Returns undefined whenever
   * reasoning is disabled or the user didn't set an effort. Clamps the
   * DeepSeek-only 'max' tier to 'high' when the resolved baseURL is NOT a
   * DeepSeek hostname (real Anthropic accepts low/medium/high only and
   * would 400 on 'max'). Uses the hostname-only detector deliberately —
   * the broader `isDeepSeekAnthropicProvider` model-name fallback exists
   * for the thinking-block injection workaround (sglang/vllm self-hosted
   * coverage), but trusting it here would let a model named e.g.
   * "deepseek-clone" running on real api.anthropic.com bypass the clamp.
   *
   * The downgrade warning fires once per generator lifetime via the
   * `effortClampWarned` latch — repeating on every request just spams
   * the log without giving users new information.
   */
  private resolveEffectiveEffort(
    request: GenerateContentParameters,
  ): 'low' | 'medium' | 'high' | 'max' | undefined {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return undefined;
    }
    const reasoning = this.contentGeneratorConfig.reasoning;
    if (reasoning === false || reasoning === undefined) {
      return undefined;
    }
    const effort = reasoning.effort;
    if (effort === undefined) {
      return undefined;
    }
    if (
      effort === 'max' &&
      !isDeepSeekAnthropicHostname(this.contentGeneratorConfig)
    ) {
      if (!this.effortClampWarned) {
        debugLogger.warn(
          "reasoning.effort='max' is a DeepSeek extension; clamping to " +
            "'high' for non-DeepSeek anthropic provider to avoid HTTP 400.",
        );
        this.effortClampWarned = true;
      }
      return 'high';
    }
    return effort;
  }

  /**
   * Check if the current model supports adaptive thinking (type: 'adaptive').
   * Claude 4.6+ models require adaptive thinking; older models use the
   * budget-based config. Uses numeric major/minor comparison rather than a
   * single-digit character class so that future families (haiku, opus-4-10,
   * opus-5-1, …) are recognized instead of silently falling back to the
   * budget path and tripping HTTP 400 with `budget_tokens` they don't
   * accept.
   *
   * The regex is intentionally unanchored so reseller-prefixed model names
   * also match (`bedrock/claude-opus-4-7`, `vertex_ai/claude-sonnet-4-6@…`,
   * `idealab:claude-opus-4-6`, etc.) — those route to the same Anthropic
   * models on the wire and need the same thinking shape. Do not tighten to
   * `^claude-` without also covering those naming conventions.
   */
  private modelSupportsAdaptiveThinking(): boolean {
    const model = (this.contentGeneratorConfig.model || '').toLowerCase();
    const match = model.match(/claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/);
    if (!match) return false;
    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2], 10);
    return major > 4 || (major === 4 && minor >= 6);
  }

  private buildThinkingConfig(
    request: GenerateContentParameters,
    effectiveEffort: 'low' | 'medium' | 'high' | 'max' | undefined,
  ): AnthropicThinkingParam | undefined {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return undefined;
    }

    const reasoning = this.contentGeneratorConfig.reasoning;

    if (reasoning === false) {
      return undefined;
    }

    // Explicit budget_tokens is an escape hatch from the effort ladder:
    // honor exactly what the user asked for. This deliberately does NOT
    // re-clamp the value to track the (possibly clamped) effort label —
    // a user who set `{ effort: 'max', budget_tokens: 128_000 }` against
    // real api.anthropic.com will see `output_config.effort: 'high'`
    // (clamped) but `thinking.budget_tokens: 128_000` (preserved). That
    // wire-shape mismatch is intentional: the clamp protects against
    // unknown-enum 400s on the effort field, but the budget field is
    // just an integer the server accepts within its context window, so
    // an explicit override stays explicit. The default ladder below is
    // what stays consistent with the clamped effort.
    //
    // Checked before the adaptive-thinking branch so an explicit budget
    // isn't silently dropped on Claude 4.6+ models — adaptive omits
    // `budget_tokens` entirely, which would discard the user override.
    if (reasoning?.budget_tokens !== undefined) {
      return {
        type: 'enabled',
        budget_tokens: reasoning.budget_tokens,
      };
    }

    // Models that support adaptive thinking use { type: 'adaptive' } without
    // a budget_tokens field. The server controls the thinking budget via
    // output_config.effort instead.
    if (this.modelSupportsAdaptiveThinking()) {
      return { type: 'adaptive' };
    }

    // When using interleaved thinking with tools, this budget token limit is the entire context window(200k tokens).
    // 'max' is the DeepSeek-specific extra-strong tier; bump the budget
    // accordingly so any client-side budgeting matches the spirit of the
    // server-side label. resolveEffectiveEffort already clamps 'max' to
    // 'high' on non-DeepSeek anthropic backends so the budget here stays
    // consistent with the effort label written into output_config.
    const budgetTokens =
      effectiveEffort === 'low'
        ? 16_000
        : effectiveEffort === 'max'
          ? 128_000
          : effectiveEffort === 'high'
            ? 64_000
            : 32_000;

    return {
      type: 'enabled',
      budget_tokens: budgetTokens,
    };
  }

  private buildOutputConfig(
    request: GenerateContentParameters,
    effectiveEffort: 'low' | 'medium' | 'high' | 'max' | undefined,
  ): { effort: 'low' | 'medium' | 'high' | 'max' } | undefined {
    // resolveEffectiveEffort already returns undefined when:
    //   - per-request includeThoughts is false (side queries)
    //   - reasoning is disabled or unset
    //   - the user didn't set an effort
    // and clamps DeepSeek-only 'max' to 'high' on stricter anthropic
    // backends. Just consume the value here.
    if (effectiveEffort === undefined) return undefined;
    return { effort: effectiveEffort };
  }

  private async *redactStreamErrors(
    stream: AsyncIterable<RawMessageStreamEvent>,
  ): AsyncGenerator<RawMessageStreamEvent> {
    try {
      for await (const event of stream) {
        yield event;
      }
    } catch (error) {
      throw redactProxyError(error);
    }
  }

  private async *processStream(
    stream: AsyncIterable<RawMessageStreamEvent>,
  ): AsyncGenerator<GenerateContentResponse> {
    let messageId: string | undefined;
    let model = this.contentGeneratorConfig.model;
    let cachedTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: string | undefined;

    const blocks = new Map<number, StreamingBlockState>();
    const collectedResponses: GenerateContentResponse[] = [];

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          messageId = event.message.id ?? messageId;
          model = event.message.model ?? model;
          cachedTokens =
            event.message.usage?.cache_read_input_tokens ?? cachedTokens;
          promptTokens = event.message.usage?.input_tokens ?? promptTokens;
          break;
        }
        case 'content_block_start': {
          const index = event.index ?? 0;
          const type = String(event.content_block.type || 'text');
          const initialInput =
            type === 'tool_use' && 'input' in event.content_block
              ? JSON.stringify(event.content_block.input)
              : '';
          blocks.set(index, {
            type,
            id:
              'id' in event.content_block ? event.content_block.id : undefined,
            name:
              'name' in event.content_block
                ? event.content_block.name
                : undefined,
            inputJson: initialInput !== '{}' ? initialInput : '',
            signature:
              type === 'thinking' &&
              'signature' in event.content_block &&
              typeof event.content_block.signature === 'string'
                ? event.content_block.signature
                : '',
          });
          break;
        }
        case 'content_block_delta': {
          const index = event.index ?? 0;
          const deltaType = (event.delta as { type?: string }).type || '';
          const blockState = blocks.get(index);

          if (deltaType === 'text_delta') {
            const text = 'text' in event.delta ? event.delta.text : '';
            if (text) {
              const chunk = this.buildGeminiChunk({ text }, messageId, model);
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === 'thinking_delta') {
            const thinking =
              (event.delta as { thinking?: string }).thinking || '';
            if (thinking) {
              const chunk = this.buildGeminiChunk(
                { text: thinking, thought: true },
                messageId,
                model,
              );
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === 'signature_delta' && blockState) {
            const signature =
              (event.delta as { signature?: string }).signature || '';
            if (signature) {
              blockState.signature += signature;
              const chunk = this.buildGeminiChunk(
                { thought: true, thoughtSignature: signature },
                messageId,
                model,
              );
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === 'input_json_delta' && blockState) {
            const jsonDelta =
              (event.delta as { partial_json?: string }).partial_json || '';
            if (jsonDelta) {
              blockState.inputJson += jsonDelta;
            }
          }
          break;
        }
        case 'content_block_stop': {
          const index = event.index ?? 0;
          const blockState = blocks.get(index);
          if (blockState?.type === 'tool_use') {
            const args = safeJsonParse(blockState.inputJson || '{}', {});
            const chunk = this.buildGeminiChunk(
              {
                functionCall: {
                  id: blockState.id,
                  name: blockState.name,
                  args,
                },
              },
              messageId,
              model,
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          blocks.delete(index);
          break;
        }
        case 'message_delta': {
          const stopReasonValue = event.delta.stop_reason;
          if (stopReasonValue) {
            finishReason = stopReasonValue;
          }

          // Some Anthropic-compatible providers may include additional usage fields
          // (e.g. `input_tokens`, `cache_read_input_tokens`) even though the official
          // Anthropic SDK types only expose `output_tokens` here.
          const usageUnknown = event.usage as unknown;
          const usageRecord =
            usageUnknown && typeof usageUnknown === 'object'
              ? (usageUnknown as Record<string, unknown>)
              : undefined;

          if (event.usage?.output_tokens !== undefined) {
            completionTokens = event.usage.output_tokens;
          }
          if (usageRecord?.['input_tokens'] !== undefined) {
            const inputTokens = usageRecord['input_tokens'];
            if (typeof inputTokens === 'number') {
              promptTokens = inputTokens;
            }
          }
          if (usageRecord?.['cache_read_input_tokens'] !== undefined) {
            const cacheRead = usageRecord['cache_read_input_tokens'];
            if (typeof cacheRead === 'number') {
              cachedTokens = cacheRead;
            }
          }

          if (finishReason || event.usage) {
            const chunk = this.buildGeminiChunk(
              undefined,
              messageId,
              model,
              finishReason,
              {
                cachedContentTokenCount: cachedTokens,
                promptTokenCount: cachedTokens + promptTokens,
                candidatesTokenCount: completionTokens,
                totalTokenCount: cachedTokens + promptTokens + completionTokens,
              },
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          break;
        }
        case 'message_stop': {
          if (promptTokens || completionTokens) {
            const chunk = this.buildGeminiChunk(
              undefined,
              messageId,
              model,
              finishReason,
              {
                cachedContentTokenCount: cachedTokens,
                promptTokenCount: cachedTokens + promptTokens,
                candidatesTokenCount: completionTokens,
                totalTokenCount: cachedTokens + promptTokens + completionTokens,
              },
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private buildGeminiChunk(
    part?: {
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      functionCall?: unknown;
    },
    responseId?: string,
    model?: string,
    finishReason?: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
  ): GenerateContentResponse {
    const response = new GenerateContentResponse();
    response.responseId = responseId;
    response.createTime = Date.now().toString();
    response.modelVersion = model || this.contentGeneratorConfig.model;
    response.promptFeedback = { safetyRatings: [] };

    const candidateParts = part ? [part as unknown as Part] : [];
    const mappedFinishReason =
      finishReason !== undefined
        ? this.converter.mapAnthropicFinishReasonToGemini(finishReason)
        : undefined;
    response.candidates = [
      {
        content: {
          parts: candidateParts,
          role: 'model' as const,
        },
        index: 0,
        safetyRatings: [],
        ...(mappedFinishReason ? { finishReason: mappedFinishReason } : {}),
      },
    ];

    if (usageMetadata) {
      response.usageMetadata = usageMetadata;
    }

    return response;
  }
}
