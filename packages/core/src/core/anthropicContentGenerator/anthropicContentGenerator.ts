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
import {
  clampReasoningEffort,
  type ReasoningEffort,
} from '../reasoning-effort.js';
type Message = Anthropic.Message;
type MessageCreateParamsNonStreaming =
  Anthropic.MessageCreateParamsNonStreaming;
type MessageCreateParamsStreaming = Anthropic.MessageCreateParamsStreaming;
type RawMessageStreamEvent = Anthropic.RawMessageStreamEvent;
import { RequestTokenEstimator } from '../../utils/request-tokenizer/index.js';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { AnthropicContentConverter } from './converter.js';
import { buildAnthropicUsageMetadata } from './usage.js';
import {
  buildRuntimeFetchOptions,
  redactProxyError,
} from '../../utils/runtimeFetchOptions.js';
import { resolveRequestTimeout } from '../openaiContentGenerator/constants.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { runtimeDiagnostics } from '../../utils/runtimeDiagnostics.js';
import { createChildAbortController } from '../../utils/abortController.js';
import {
  tokenLimit,
  hasExplicitOutputLimit,
  defaultOutputCeiling,
  reconcileMaxTokens,
  parsePositiveIntegerEnvValue,
} from '../tokenLimits.js';
import { setToolCallPreparations } from '../tool-call-preparation.js';

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

// Single source of truth for the Claude family list. Both the `ClaudeModelFamily`
// union and the model-id regex are derived from this array, so adding a family
// updates the type and the parser together — a maintainer can't update one and
// silently leave the other (and the `as ClaudeModelFamily` cast) stale.
const CLAUDE_MODEL_FAMILIES = [
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'mythos',
] as const;
type ClaudeModelFamily = (typeof CLAUDE_MODEL_FAMILIES)[number];

interface ParsedClaudeModelVersion {
  family: ClaudeModelFamily;
  major: number;
  minor: number;
}

/**
 * Parse a Claude model id into `{ family, major, minor }`, or `null` for
 * non-Claude / unversioned ids. The single source of truth for the capability
 * gating below — both `anthropicSupportedEffortTiers` and
 * `modelSupportsAdaptiveThinking` consume this so the family list and the
 * version-parsing rules can't drift apart when Anthropic ships a new family.
 *
 * The regex is unanchored so reseller-prefixed ids (`bedrock/…`, `vertex_ai/…`,
 * `idealab:…`) match the same Anthropic models on the wire. The minor-version
 * group is capped at one or two digits with a trailing `(?!\d)` so an 8-digit
 * date suffix (`claude-opus-4-20250514` = Opus 4.0) is not mis-parsed as a giant
 * minor version. The `{1,2}` cap alone is not enough — `\d{1,2}` is greedy and
 * still matches `20` from `20250514`; it's the trailing `(?!\d)` negative
 * lookahead that does the real work, forcing the engine to backtrack past any
 * digit-followed match so the optional minor group fails to match entirely.
 * Both together make dated ids with no real minor resolve to `minor = 0`
 * (otherwise `minor` would wrongly clear `atLeast(4, 6)` / `atLeast(4, 7)` gates
 * the model doesn't support — a server 400). Dated ids that do carry a minor,
 * like `claude-opus-4-7-20251101`, still resolve to minor `7`; a bare major
 * (`claude-opus-5`) resolves to minor `0`.
 */
function parseClaudeModelVersion(
  model: string,
): ParsedClaudeModelVersion | null {
  const match = model
    .toLowerCase()
    .match(
      new RegExp(
        `claude-(${CLAUDE_MODEL_FAMILIES.join(
          '|',
        )})-(\\d+)(?:-(\\d{1,2})(?!\\d))?`,
      ),
    );
  if (!match) {
    return null;
  }
  return {
    family: match[1] as ClaudeModelFamily,
    major: Number.parseInt(match[2], 10),
    minor: match[3] ? Number.parseInt(match[3], 10) : 0,
  };
}

/**
 * The reasoning-effort tiers a real Anthropic model accepts on
 * `output_config.effort`. Every effort-capable model takes low/medium/high; the
 * extra-strong tiers are gated by model version per the Anthropic docs
 * (https://platform.claude.com/docs/en/build-with-claude/effort):
 *   - `max`:   Opus/Sonnet 4.6+ and every 5.x family (Fable 5, Mythos 5, …).
 *   - `xhigh`: Opus 4.7+ and every 5.x family (NOT Sonnet 4.6 / Opus 4.6).
 *
 * Unknown/unversioned ids fall back to low/medium/high so we never send a tier
 * the server might 400 on. Effort levels above what the model supports are
 * clamped by the caller via clampReasoningEffort.
 */
function anthropicSupportedEffortTiers(model: string): ReasoningEffort[] {
  const tiers: ReasoningEffort[] = ['low', 'medium', 'high'];
  const parsed = parseClaudeModelVersion(model);
  if (!parsed) {
    return tiers;
  }
  const { family, major, minor } = parsed;
  const atLeast = (maj: number, min: number) =>
    major > maj || (major === maj && minor >= min);

  // xhigh: Opus 4.7+ and all 5.x families.
  if (major >= 5 || (family === 'opus' && atLeast(4, 7))) {
    tiers.push('xhigh');
  }
  // max: 4.6+ (opus/sonnet only) and all 5.x families. The 4.x branch is
  // family-guarded to match the documented support above — haiku 4.x never
  // gains `max` (a server 400), while every 5.x family still does via major>=5.
  if (
    major >= 5 ||
    ((family === 'opus' || family === 'sonnet') && atLeast(4, 6))
  ) {
    tiers.push('max');
  }
  return tiers;
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
  // Anthropic beta feature: output_config.effort (requires beta header
  // effort-2025-11-24), not yet represented in the official SDK types we depend
  // on. Accepts the full ladder; xhigh/max are gated per model via
  // anthropicSupportedEffortTiers + clampReasoningEffort.
  output_config?: { effort: ReasoningEffort };
};

export class AnthropicContentGenerator implements ContentGenerator {
  private client: Anthropic;
  private converter: AnthropicContentConverter;
  // Latch so the 'max' clamp warning fires once per generator lifetime
  // instead of on every request that needs the downgrade.
  private effortClampWarned = false;
  private budgetDropWarned = false;
  private temperatureDropWarned = false;

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
      timeout: resolveRequestTimeout(contentGeneratorConfig.timeout),
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
    // Wrap the caller's signal in a per-request child for the same reason as
    // generateContentStream: the Anthropic SDK leaks an abort listener onto
    // whatever signal it is handed, so keep that on a short-lived signal rather
    // than the caller's long-lived round signal.
    const parentSignal = request.config?.abortSignal;
    const perRequestAc = parentSignal
      ? createChildAbortController(parentSignal)
      : undefined;
    try {
      const anthropicRequest = await this.buildRequest(request);
      runtimeDiagnostics.recordAnthropicWireRequest(anthropicRequest);
      const headers = this.buildPerRequestHeaders(anthropicRequest);
      response = (await this.client.messages.create(anthropicRequest, {
        signal: perRequestAc?.signal,
        ...(headers ? { headers } : {}),
      })) as Message;
    } catch (error) {
      throw redactProxyError(error);
    } finally {
      perRequestAc?.abort();
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
    runtimeDiagnostics.recordAnthropicWireRequest(streamingRequest);

    // Wrap the caller's signal in a per-request child so the Anthropic SDK's
    // leaked abort listener (core.mjs fetchWithTimeout registers one with no
    // { once: true } and never removes it) lands on a short-lived signal
    // instead of piling up on the caller's long-lived round signal. The
    // OpenAI pipeline wraps its stream the same way for the identical leak.
    const perRequestAc = createChildAbortController(
      request.config?.abortSignal,
    );

    let stream: AsyncIterable<RawMessageStreamEvent>;
    try {
      stream = (await this.client.messages.create(
        streamingRequest as MessageCreateParamsStreaming,
        {
          signal: perRequestAc.signal,
          ...(headers ? { headers } : {}),
        },
      )) as AsyncIterable<RawMessageStreamEvent>;
    } catch (error) {
      perRequestAc.abort();
      throw redactProxyError(error);
    }

    const inner = this.processStreamWithEmptyFallback(
      this.redactStreamErrors(stream),
      anthropicRequest,
      perRequestAc.signal,
      headers,
    );
    // Abort the child once the stream is fully drained or abandoned; this
    // releases the SDK request and detaches the child's listener from the
    // caller's signal.
    async function* drainThenCleanup(): AsyncGenerator<GenerateContentResponse> {
      try {
        yield* inner;
      } finally {
        perRequestAc.abort();
      }
    }
    return drainThenCleanup();
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
    // on `enableCacheControl !== false` AND (Anthropic-native baseURL OR `forceGlobalCacheScope`)).
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
   * `cache_control` entries this request. Requires
   * `enableCacheControl !== false` AND either an Anthropic-native baseURL
   * OR `forceGlobalCacheScope` (opt-in for proxy providers that forward
   * the `prompt-caching-scope-2026-01-05` beta; see issue #6642).
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
    if (this.contentGeneratorConfig.enableCacheControl === false) {
      return false;
    }
    return (
      isAnthropicNativeBaseUrl(this.contentGeneratorConfig) ||
      this.contentGeneratorConfig.forceGlobalCacheScope === true
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
    // cover both paths.) `useGlobalCacheScope` requires
    // `enableCacheControl` (true only when caching is on AND either the resolved
    // baseURL is Anthropic-native OR `forceGlobalCacheScope` is set) and governs whether the body's
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

    // Map Gemini-style toolConfig.functionCallingConfig.mode to Anthropic's
    // tool_choice. Without this, the API defaults to tool_choice=auto and
    // the model may legitimately skip tool calls — a problem for structured
    // side queries (e.g. the AUTO-mode classifier's respond_in_schema) where
    // the model must emit a tool call. Adaptive-thinking models (Claude
    // 4.6+) compound this by consuming output budget on server-driven
    // thinking before any tool_use, making forced tool_choice essential.
    const toolChoice = this.resolveToolChoice(request, tools);

    return {
      model: this.contentGeneratorConfig.model,
      system,
      messages,
      tools,
      ...sampling,
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
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

    // Apply output token limit logic consistent with OpenAI providers.
    // A config-level max_tokens is a ceiling, not an exemption from the
    // window clamp: when the request also carries a (clamped)
    // maxOutputTokens, the smaller of the two goes on the wire so
    // `prompt + max_tokens ≤ window` holds for samplingParams users too.
    const configMaxTokens = configSamplingParams?.max_tokens as
      | number
      | undefined
      | null;
    const requestMaxTokens = requestConfig.maxOutputTokens;
    const userMaxTokens =
      reconcileMaxTokens(configMaxTokens, requestMaxTokens) ??
      configMaxTokens ??
      requestMaxTokens;
    const modelId = this.contentGeneratorConfig.model;
    const modelLimit = tokenLimit(modelId, 'output');
    const isKnownModel = hasExplicitOutputLimit(modelId);

    let maxTokens: number;
    if (userMaxTokens !== undefined && userMaxTokens !== null) {
      maxTokens = isKnownModel
        ? Math.min(userMaxTokens, modelLimit)
        : userMaxTokens;
    } else {
      // No explicit user config — check env var, then use the model limit
      // clipped to the flat output ceiling.
      const envMaxTokens = parsePositiveIntegerEnvValue(
        process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'],
      );
      if (envMaxTokens !== undefined) {
        maxTokens = isKnownModel
          ? Math.min(envMaxTokens, modelLimit)
          : envMaxTokens;
      } else {
        maxTokens = defaultOutputCeiling(modelId);
      }
    }

    // Claude 4.8+ deprecated temperature — the server rejects it with a 400.
    // Omit the parameter entirely for those models; older models keep the
    // default of 1 (Anthropic's documented neutral value).
    const temperatureDropped = this.modelRejectsTemperature();
    if (temperatureDropped && !this.temperatureDropWarned) {
      const userTemp = getParam<number>('temperature', 'temperature');
      if (userTemp !== undefined) {
        debugLogger.warn(
          `temperature=${userTemp} is not supported by '${
            this.contentGeneratorConfig.model ?? 'unknown'
          }' (deprecated on 4.8+); ignoring.`,
        );
      }
      this.temperatureDropWarned = true;
    }

    return {
      max_tokens: maxTokens,
      ...(temperatureDropped
        ? {}
        : { temperature: getParam<number>('temperature', 'temperature') ?? 1 }),
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
  ): ReasoningEffort | undefined {
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
    if (isDeepSeekAnthropicHostname(this.contentGeneratorConfig)) {
      // DeepSeek's anthropic-compatible output_config.effort accepts only
      // high/max. Mirror the DeepSeek OpenAI adapter (deepseek.ts): low/medium
      // lift to high and xhigh groups to max, so a low/medium request is not
      // passed through verbatim (which the endpoint would 400 on). Warn once
      // when the requested tier is remapped — mirroring the real-Anthropic
      // clamp path below — so a `/effort low` silently running at `high` is
      // visible in debug logs.
      const mapped: ReasoningEffort =
        effort === 'xhigh' || effort === 'max' ? 'max' : 'high';
      if (mapped !== effort && !this.effortClampWarned) {
        debugLogger.warn(
          `reasoning.effort='${effort}' is not accepted by the DeepSeek ` +
            `anthropic-compatible endpoint; using '${mapped}'.`,
        );
        this.effortClampWarned = true;
      }
      return mapped;
    }
    // Real Anthropic: clamp the requested tier to what this model actually
    // accepts. Opus 4.7/4.8 and the 5.x families take xhigh/max natively;
    // older models (Opus 4.6 / Sonnet 4.6 lack xhigh, Opus 4.5 lacks both)
    // clamp so we never 400 on an unsupported enum.
    const supported = anthropicSupportedEffortTiers(
      this.contentGeneratorConfig.model ?? '',
    );
    const clamped = clampReasoningEffort(effort, supported);
    if (clamped !== effort && !this.effortClampWarned) {
      debugLogger.warn(
        `reasoning.effort='${effort}' is not supported by '${
          this.contentGeneratorConfig.model ?? 'unknown'
        }'; using '${clamped}'.`,
      );
      this.effortClampWarned = true;
    }
    return clamped;
  }

  /**
   * Check if the current model supports adaptive thinking (type: 'adaptive').
   * Claude 4.6+ models require adaptive thinking; older models use the
   * budget-based config. Shares `parseClaudeModelVersion` with
   * `anthropicSupportedEffortTiers` so the family list and the date-suffix guard
   * stay in lockstep — a model parsed for effort gating is parsed identically
   * here for the thinking shape.
   */
  private modelSupportsAdaptiveThinking(): boolean {
    const parsed = parseClaudeModelVersion(
      this.contentGeneratorConfig.model || '',
    );
    if (!parsed) return false;
    const { major, minor } = parsed;
    return major > 4 || (major === 4 && minor >= 6);
  }

  /**
   * Whether the model rejects the manual `thinking: { type: 'enabled',
   * budget_tokens: N }` shape with a 400. Opus 4.7+ and every 5.x family
   * (Fable 5, Mythos 5, Sonnet 5, …) dropped manual extended thinking in favor
   * of adaptive thinking, so a budget-tokens-shaped request errors on those
   * models — they must use `{ type: 'adaptive' }` with `output_config.effort`
   * instead (https://platform.claude.com/docs/en/build-with-claude/effort).
   * Opus 4.5/4.6 and Sonnet 4.6 still accept `budget_tokens` (deprecated on
   * 4.6), and unknown/unversioned ids keep the manual escape hatch, so both
   * return false. Shares `parseClaudeModelVersion` with the effort/adaptive
   * gates so the version rules can't drift.
   */
  private modelRejectsManualThinking(): boolean {
    const parsed = parseClaudeModelVersion(
      this.contentGeneratorConfig.model || '',
    );
    if (!parsed) return false;
    const { major, minor } = parsed;
    return major > 4 || (major === 4 && minor >= 7);
  }

  /**
   * Whether the model rejects the `temperature` sampling parameter with a 400.
   * Claude Opus 4.8+ deprecated temperature — the server controls sampling
   * determinism internally and responds with
   * `"temperature is deprecated for this model."` when the parameter is sent.
   * Older models (4.7 and below) and unknown/unversioned ids still accept it,
   * so both return false.
   */
  private modelRejectsTemperature(): boolean {
    const parsed = parseClaudeModelVersion(
      this.contentGeneratorConfig.model || '',
    );
    if (!parsed) return false;
    const { major, minor } = parsed;
    return major > 4 || (major === 4 && minor >= 8);
  }

  private buildThinkingConfig(
    request: GenerateContentParameters,
    effectiveEffort: ReasoningEffort | undefined,
  ): AnthropicThinkingParam | undefined {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return undefined;
    }

    const reasoning = this.contentGeneratorConfig.reasoning;

    if (reasoning === false) {
      return undefined;
    }

    // Explicit budget_tokens is an escape hatch from the effort ladder: honor
    // exactly what the user asked for, without re-clamping to track the
    // (possibly clamped) effort label — the budget field is just an integer the
    // server accepts within its context window, so an explicit override stays
    // explicit. This only applies to models that still accept the manual
    // `{ type: 'enabled', budget_tokens }` shape (Opus 4.5/4.6, Sonnet 4.6,
    // older 4.x, and unknown/unversioned ids). Opus 4.7+ and every 5.x family
    // reject manual thinking with a 400 and require adaptive thinking, so on
    // those models the budget is dropped and `output_config.effort` governs
    // thinking depth instead
    // (https://platform.claude.com/docs/en/build-with-claude/effort).
    //
    // Checked before the adaptive-thinking branch so an explicit budget isn't
    // silently dropped on models that DO still honor it — adaptive omits
    // `budget_tokens` entirely, which would discard the user override.
    if (
      reasoning?.budget_tokens !== undefined &&
      !this.modelRejectsManualThinking()
    ) {
      return {
        type: 'enabled',
        budget_tokens: reasoning.budget_tokens,
      };
    }

    // A model that rejects manual thinking (Opus 4.7+, every 5.x) discards an
    // explicit budget_tokens in favor of adaptive thinking + output_config.
    // effort. Every other clamp in this PR leaves a one-time trace; mirror that
    // here so the dropped user override isn't silently invisible.
    if (
      reasoning?.budget_tokens !== undefined &&
      this.modelRejectsManualThinking() &&
      !this.budgetDropWarned
    ) {
      debugLogger.warn(
        `reasoning.budget_tokens=${reasoning.budget_tokens} is ignored on '${
          this.contentGeneratorConfig.model ?? 'unknown'
        }' (Opus 4.7+/5.x use adaptive thinking); output_config.effort governs thinking depth instead.`,
      );
      this.budgetDropWarned = true;
    }

    // Models that support adaptive thinking use { type: 'adaptive' } without
    // a budget_tokens field. The server controls the thinking budget via
    // output_config.effort instead.
    if (this.modelSupportsAdaptiveThinking()) {
      return { type: 'adaptive' };
    }

    // Budget path for non-adaptive (pre-4.6) models. resolveEffectiveEffort has
    // already clamped the tier to what the model accepts, so map each tier to a
    // budget that matches the spirit of the effort label written into
    // output_config. xhigh/max only reach here on DeepSeek-anthropic backends
    // (real pre-4.6 Anthropic models clamp them away).
    const budgetTokens =
      effectiveEffort === 'low'
        ? 16_000
        : effectiveEffort === 'max'
          ? 128_000
          : effectiveEffort === 'xhigh'
            ? 96_000
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
    effectiveEffort: ReasoningEffort | undefined,
  ): { effort: ReasoningEffort } | undefined {
    // resolveEffectiveEffort already returns undefined when:
    //   - per-request includeThoughts is false (side queries)
    //   - reasoning is disabled or unset
    //   - the user didn't set an effort
    // and clamps the tier to what the current model supports. Just consume the
    // value here.
    if (effectiveEffort === undefined) return undefined;
    return { effort: effectiveEffort };
  }

  /**
   * Translate the Gemini-style `toolConfig.functionCallingConfig.mode` on
   * the request into an Anthropic `tool_choice` value.
   *
   * Mapping:
   *   mode 'ANY'  → `{ type: 'any' }`   (model must call at least one tool)
   *   mode 'NONE' → `{ type: 'none' }`  (model must not call any tool)
   *   mode 'AUTO' or absent → undefined (let Anthropic default to auto)
   *
   * Only emitted when `tools` is non-empty — Anthropic rejects requests
   * that carry `tool_choice` without a `tools` array.
   */
  private resolveToolChoice(
    request: GenerateContentParameters,
    tools: AnthropicToolParam[] | undefined,
  ): NonNullable<MessageCreateParamsNonStreaming['tool_choice']> | undefined {
    if (!tools || tools.length === 0) return undefined;
    const mode =
      request.config?.toolConfig?.functionCallingConfig?.mode;
    if (mode === 'ANY') {
      return { type: 'any' };
    }
    if (mode === 'NONE') {
      return { type: 'none' };
    }
    return undefined;
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
    let cacheCreationTokens = 0;
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
          cacheCreationTokens =
            event.message.usage?.cache_creation_input_tokens ??
            cacheCreationTokens;
          promptTokens = event.message.usage?.input_tokens ?? promptTokens;
          break;
        }
        case 'content_block_start': {
          const index = event.index ?? 0;
          const type = String(event.content_block.type || 'text');
          const id =
            'id' in event.content_block ? event.content_block.id : undefined;
          const name =
            'name' in event.content_block
              ? event.content_block.name
              : undefined;
          const initialInput =
            type === 'tool_use' && 'input' in event.content_block
              ? JSON.stringify(event.content_block.input)
              : '';
          blocks.set(index, {
            type,
            id,
            name,
            inputJson: initialInput !== '{}' ? initialInput : '',
            signature:
              type === 'thinking' &&
              'signature' in event.content_block &&
              typeof event.content_block.signature === 'string'
                ? event.content_block.signature
                : '',
          });
          if (
            type === 'tool_use' &&
            typeof id === 'string' &&
            id.length > 0 &&
            typeof name === 'string' &&
            name.length > 0
          ) {
            const chunk = this.buildGeminiChunk(undefined, messageId, model);
            setToolCallPreparations(chunk, [{ callId: id, toolName: name }]);
            collectedResponses.push(chunk);
            yield chunk;
          }
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
          if (usageRecord?.['cache_creation_input_tokens'] !== undefined) {
            const cacheCreate = usageRecord['cache_creation_input_tokens'];
            if (typeof cacheCreate === 'number') {
              cacheCreationTokens = cacheCreate;
            }
          }

          if (finishReason || event.usage) {
            const chunk = this.buildGeminiChunk(
              undefined,
              messageId,
              model,
              finishReason,
              buildAnthropicUsageMetadata({
                inputTokens: promptTokens,
                cacheReadTokens: cachedTokens,
                cacheCreationTokens,
                outputTokens: completionTokens,
              }),
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
              buildAnthropicUsageMetadata({
                inputTokens: promptTokens,
                cacheReadTokens: cachedTokens,
                cacheCreationTokens,
                outputTokens: completionTokens,
              }),
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

  // Some Anthropic-compatible gateways close the SSE stream with HTTP 200
  // but emit no assistant content or stop reason (e.g. billing / quota
  // limits hit mid-proxy). When that happens we probe once with the same
  // request in non-streaming mode so the real provider error surfaces
  // instead of the generic "stream ended without a finish reason".
  private async *processStreamWithEmptyFallback(
    stream: AsyncIterable<RawMessageStreamEvent>,
    fallbackRequest: MessageCreateParamsWithThinking,
    abortSignal: AbortSignal | undefined,
    headers: Record<string, string> | undefined,
  ): AsyncGenerator<GenerateContentResponse> {
    let hasAssistantPayload = false;
    let hasFinishReason = false;

    for await (const chunk of this.processStream(stream)) {
      const candidates = chunk.candidates ?? [];
      hasFinishReason ||= candidates.some(
        (candidate) => candidate.finishReason !== undefined,
      );
      hasAssistantPayload ||= candidates.some((candidate) =>
        candidate.content?.parts?.some(
          (part) =>
            part.text ||
            part.thought ||
            part.thoughtSignature ||
            part.functionCall,
        ),
      );
      yield chunk;
    }

    if (hasAssistantPayload || hasFinishReason) {
      return;
    }

    debugLogger.warn(
      'Anthropic stream ended without assistant payload or finish reason; ' +
        'probing once with a non-streaming request to surface provider errors.',
    );

    let response: Message;
    try {
      runtimeDiagnostics.recordAnthropicWireRequest(fallbackRequest);
      response = (await this.client.messages.create(fallbackRequest, {
        signal: abortSignal,
        ...(headers ? { headers } : {}),
      })) as Message;
      yield this.converter.convertAnthropicResponseToGemini(response);
    } catch (error) {
      throw redactProxyError(error);
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
