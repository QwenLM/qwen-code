import OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_DASHSCOPE_BASE_URL,
  DASHSCOPE_PROXY_BASE_URL,
  resolveRequestTimeout,
} from '../constants.js';
import type {
  DashScopeRequestMetadata,
  ChatCompletionContentPartTextWithCache,
  ChatCompletionContentPartWithCache,
  ChatCompletionToolWithCache,
} from './types.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import {
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
} from '../../modalityDefaults.js';
import {
  DASHSCOPE_REGIONAL_HOSTS,
  isDashScopeModelStudioHostname,
} from '../../model-reasoning-config.js';
import type { ReasoningEffort } from '../../reasoning-effort.js';
import { clampReasoningEffort } from '../../reasoning-effort.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const debugLogger = createDebugLogger('DashScopeOpenAICompatibleProvider');

const DASHSCOPE_TIERED_EFFORTS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type DashScopeThinkingKnobSelection = {
  source: 'extra_body' | 'samplingParams' | 'reasoning';
  field: 'enable_thinking' | 'reasoning_effort' | 'thinking_budget';
  value: unknown;
};

/**
 * Select the effective tiered-Qwen thinking knob using the same layer and
 * same-layer precedence as the request builder. Keeping this decision shared
 * lets UI reporters describe the value that will actually reach the wire.
 */
export function selectDashScopeThinkingKnob(
  model: string | undefined,
  extraBody: Record<string, unknown> | undefined,
  samplingParams: Record<string, unknown> | undefined,
  reasoningEffort: unknown,
): DashScopeThinkingKnobSelection | undefined {
  if (!isTieredEffortWireModel((model ?? '').toLowerCase())) {
    return undefined;
  }

  const selectFromLayer = (
    source: 'extra_body' | 'samplingParams',
    layer: Record<string, unknown> | undefined,
  ): DashScopeThinkingKnobSelection | undefined => {
    if (layer?.['enable_thinking'] === false) {
      return { source, field: 'enable_thinking', value: false };
    }
    return selectValueFromLayer(source, layer) ?? selectOnSwitch(source, layer);
  };

  const selectValueFromLayer = (
    source: 'extra_body' | 'samplingParams',
    layer: Record<string, unknown> | undefined,
  ): DashScopeThinkingKnobSelection | undefined => {
    if (layer?.['reasoning_effort'] != null) {
      return {
        source,
        field: 'reasoning_effort',
        value: layer['reasoning_effort'],
      };
    }
    if (layer?.['thinking_budget'] != null) {
      return {
        source,
        field: 'thinking_budget',
        value: layer['thinking_budget'],
      };
    }
    return undefined;
  };

  const selectOnSwitch = (
    source: 'extra_body' | 'samplingParams',
    layer: Record<string, unknown> | undefined,
  ): DashScopeThinkingKnobSelection | undefined => {
    if (layer?.['enable_thinking'] === true) {
      return { source, field: 'enable_thinking', value: true };
    }
    return undefined;
  };

  const reasoningSelection: DashScopeThinkingKnobSelection | undefined =
    reasoningEffort !== undefined
      ? {
          source: 'reasoning',
          field: 'reasoning_effort',
          value: reasoningEffort,
        }
      : undefined;
  const extraBodySelection = selectFromLayer('extra_body', extraBody);
  if (
    extraBodySelection?.field === 'enable_thinking' &&
    extraBodySelection.value === true
  ) {
    // An on-switch blocks lower-priority off-switches but does not choose the
    // effort tier or budget. Let the next value-bearing layer decide.
    return (
      selectValueFromLayer('samplingParams', samplingParams) ??
      reasoningSelection ??
      extraBodySelection
    );
  }
  if (extraBodySelection) {
    return extraBodySelection;
  }
  const samplingSelection = selectFromLayer('samplingParams', samplingParams);
  return samplingSelection?.field === 'enable_thinking' &&
    samplingSelection.value === true
    ? (reasoningSelection ?? samplingSelection)
    : (samplingSelection ?? reasoningSelection);
}

function withoutNullishThinkingKnobs(
  layer: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!layer) {
    return undefined;
  }
  const hasNullishEnableThinking =
    'enable_thinking' in layer && layer['enable_thinking'] == null;
  const hasNullishEffort =
    'reasoning_effort' in layer && layer['reasoning_effort'] == null;
  const hasNullishBudget =
    'thinking_budget' in layer && layer['thinking_budget'] == null;
  if (!hasNullishEnableThinking && !hasNullishEffort && !hasNullishBudget) {
    return layer;
  }
  const sanitized = { ...layer };
  if (hasNullishEnableThinking) {
    delete sanitized['enable_thinking'];
  }
  if (hasNullishEffort) {
    delete sanitized['reasoning_effort'];
  }
  if (hasNullishBudget) {
    delete sanitized['thinking_budget'];
  }
  return sanitized;
}

/**
 * Official DashScope regional API hosts (matched exactly or as a parent
 * domain of the endpoint hostname). Shared with the WebSearch side channel's
 * endpoint gate (tools/web-search.ts) so a new region is added in one place.
 */
export { DASHSCOPE_REGIONAL_HOSTS };

export class DashScopeOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  /**
   * Determines whether to use the DashScope-compatible provider.
   * Covers the official regional hosts (DASHSCOPE_REGIONAL_HOSTS),
   * Token Plan endpoints under token-plan.<region>.maas.aliyuncs.com,
   * internal Alibaba domains (*.alibaba-inc.com, *.aliyun-inc.com),
   * Alibaba Cloud API Gateway domains (*.alicloudapi.com),
   * and proxy matches.
   *
   * Note: any *.alibaba-inc.com / *.aliyun-inc.com host is treated as a
   * DashScope-compatible endpoint by design. Keep this generic and avoid
   * embedding individual private gateway hostnames in provider detection.
   */
  static isDashScopeProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    const { authType, baseUrl } = contentGeneratorConfig;

    if (authType === AuthType.QWEN_OAUTH) return true;
    if (!baseUrl) return true;

    const normalizedBaseUrl = baseUrl.endsWith('/')
      ? baseUrl.slice(0, -1)
      : baseUrl;

    // Parse the URL and check hostname instead of regex to avoid ReDoS on
    // attacker-controlled baseUrl and to reject path-only matches like
    // https://evil.example/dashscope.aliyuncs.com/...
    let hostname: string | null = null;
    try {
      hostname = new URL(normalizedBaseUrl).hostname.toLowerCase();
    } catch {
      hostname = null;
    }

    const isModelStudioOrigin =
      hostname !== null && isDashScopeModelStudioHostname(hostname);

    // Internal Alibaba domains proxying to DashScope-compatible APIs.
    // Covers *.alibaba-inc.com and *.aliyun-inc.com.
    const isInternalOrigin =
      hostname !== null &&
      (hostname.endsWith('.alibaba-inc.com') ||
        hostname.endsWith('.aliyun-inc.com'));

    // Alibaba Cloud API Gateway domains proxying to DashScope-compatible
    // APIs. Covers *.alicloudapi.com.
    const isAliCloudApiOrigin =
      hostname !== null && hostname.endsWith('.alicloudapi.com');

    // Check if proxy is configured and matches
    const normalizedProxyUrl = DASHSCOPE_PROXY_BASE_URL?.endsWith('/')
      ? DASHSCOPE_PROXY_BASE_URL.slice(0, -1)
      : DASHSCOPE_PROXY_BASE_URL;

    const isProxyMatch = Boolean(
      normalizedProxyUrl &&
        normalizedBaseUrl.toLowerCase() === normalizedProxyUrl.toLowerCase(),
    );

    if (
      normalizedProxyUrl &&
      !isModelStudioOrigin &&
      !isInternalOrigin &&
      !isAliCloudApiOrigin &&
      !isProxyMatch
    ) {
      debugLogger.debug(
        `DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match. DashScope headers/cache control will be skipped.`,
      );
    }

    if (isInternalOrigin) {
      debugLogger.debug(
        `DashScope provider activated via internal origin: ${hostname}`,
      );
    }

    if (isAliCloudApiOrigin) {
      debugLogger.debug(
        `DashScope provider activated via alicloudapi origin: ${hostname}`,
      );
    }

    return (
      isModelStudioOrigin ||
      isInternalOrigin ||
      isAliCloudApiOrigin ||
      isProxyMatch
    );
  }

  override buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { authType, customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders = {
      'User-Agent': userAgent,
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-UserAgent': userAgent,
      'X-DashScope-AuthType': authType,
    };

    return customHeaders
      ? { ...defaultHeaders, ...customHeaders }
      : defaultHeaders;
  }

  override buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl = DEFAULT_DASHSCOPE_BASE_URL,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const timeout = resolveRequestTimeout(this.contentGeneratorConfig.timeout);
    const defaultHeaders = this.buildHeaders();
    // Configure fetch options for proxy support and timeout handling.
    // With proxy, dispatcher timeouts are disabled so SDK timeout controls the
    // request; without proxy, no custom dispatcher is installed.
    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      ...(runtimeOptions || {}),
    });
  }

  /**
   * Build and configure the request for DashScope API.
   *
   * This method applies DashScope-specific configurations including:
   * - Cache control for the system message, last tool message (when tools are configured),
   *   and the latest history message
   * - Output token limits based on model capabilities
   * - Vision model specific parameters (vl_high_resolution_images)
   * - Request metadata for session tracking
   *
   * @param request - The original chat completion request parameters
   * @param userPromptId - Unique identifier for the user prompt for session tracking
   * @returns Configured request with DashScope-specific parameters applied
   */
  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    let messages = request.messages;
    let tools = request.tools;

    // glm-* models served via DashScope only parse structured "content parts"
    // arrays when the request is in function-calling mode. A tool-less request
    // (e.g. web_fetch's side-query: system + user, no tools, no tool messages)
    // with array content has its prompt silently dropped server-side —
    // prompt_tokens collapses and the model answers from an empty prompt. This
    // is glm-specific; other DashScope models read array content fine. Caching
    // is also moot for these one-shot side-queries, so for glm tool-less
    // requests we skip cache control and collapse content to plain strings (the
    // only form glm reliably reads here). Every other case keeps the existing
    // cache-control path unchanged.
    const flattenPlainTextForGlm =
      this.isGlmModel(request.model) &&
      !this.hasFunctionCallingContext(request);

    if (flattenPlainTextForGlm) {
      messages = this.flattenTextContent(messages);
    } else if (this.shouldEnableCacheControl()) {
      // Apply DashScope cache control if enabled (default is enabled).
      const { messages: updatedMessages, tools: updatedTools } =
        this.addDashScopeCacheControl(
          request,
          request.stream ? 'all' : 'system_only',
        );
      messages = updatedMessages;
      tools = updatedTools;
    }

    // Apply output token limits using parent class logic.
    const requestWithTokenLimits = this.applyOutputTokenLimit(request);

    const isTieredQwenModel = isTieredEffortWireModel(
      this.resolveWireModel(request.model),
    );
    const extraBody = isTieredQwenModel
      ? withoutNullishThinkingKnobs(this.contentGeneratorConfig.extra_body)
      : this.contentGeneratorConfig.extra_body;

    // qwen3.8-max accepts the unified effort tiers directly. Older qwen hybrid
    // models still expose only the on/off `enable_thinking` switch. User
    // extra_body wins (merged last); the disable path (reasoning: false) is
    // handled upstream in the pipeline.
    const qwenEffortConfig = this.buildQwenEffortConfig(request.model);
    const rawRequestParams = requestWithTokenLimits as unknown as Record<
      string,
      unknown
    >;
    const requestParams = isTieredQwenModel
      ? withoutNullishThinkingKnobs(rawRequestParams)!
      : rawRequestParams;
    // A request-level reasoning_effort (samplingParams) beats the config
    // tier: dashscopeExtras is spread after requestWithTokenLimits below, so
    // without this copy the tier would clobber the request-level override.
    if (
      'reasoning_effort' in requestParams &&
      'reasoning_effort' in qwenEffortConfig
    ) {
      qwenEffortConfig['reasoning_effort'] = requestParams['reasoning_effort'];
    }
    const hasQwenEffortConfig = Object.keys(qwenEffortConfig).length > 0;
    // qwen3.8 rejects reasoning_effort with thinking_budget. Resolve the
    // highest-priority layer once; when both fields are explicit in that
    // layer, reasoning_effort keeps the pre-existing provider behavior.
    const selectedThinkingKnob = isTieredQwenModel
      ? selectDashScopeThinkingKnob(
          this.resolveWireModel(request.model),
          extraBody,
          requestParams,
          qwenEffortConfig['reasoning_effort'],
        )
      : undefined;

    if (this.isVisionModel(request.model)) {
      // DashScope-exclusive fields not present in the OpenAI SDK types; spread
      // through a loose record so they don't trip excess-property checks.
      // Several vision models (e.g. qwen3.6-plus, qwen3.7-plus) are reasoning
      // models that need `preserve_thinking` for multi-turn reasoning continuity.
      const dashscopeExtras: Record<string, unknown> = {
        vl_high_resolution_images: true,
        preserve_thinking: true,
        ...qwenEffortConfig,
      };
      const visionResult: Record<string, unknown> = {
        ...requestParams,
        messages,
        ...(tools ? { tools } : {}),
        ...(this.buildMetadata(userPromptId) || {}),
        ...dashscopeExtras,
      };
      // DashScope qwen models use top-level effort fields, not the OpenAI-style
      // nested `reasoning` object the pipeline injects from /effort. Drop it so
      // we don't ship two competing knobs. User extra_body still wins.
      if (hasQwenEffortConfig && 'reasoning' in visionResult) {
        delete visionResult['reasoning'];
      }
      return this.mergeExtraBodyAndResolveKnobs(
        hasQwenEffortConfig
          ? visionResult
          : this.clampConfiguredReasoningEffort(visionResult),
        extraBody,
        request.model,
        selectedThinkingKnob,
      );
    }

    // DashScope-exclusive fields not present in the OpenAI SDK types; user
    // extra_body wins (merged last).
    const dashscopeExtras: Record<string, unknown> = {
      preserve_thinking: true,
      ...qwenEffortConfig,
    };
    const result: Record<string, unknown> = {
      ...requestParams, // Preserve all original parameters including sampling params and adjusted max_tokens
      messages,
      ...(tools ? { tools } : {}),
      ...(this.buildMetadata(userPromptId) || {}),
      ...dashscopeExtras,
    };
    // DashScope qwen models use top-level effort fields, not the OpenAI-style
    // nested `reasoning` object the pipeline injects from /effort. Drop it so
    // we don't ship two competing knobs. User extra_body still wins.
    if (hasQwenEffortConfig && 'reasoning' in result) {
      delete result['reasoning'];
    }
    // No qwen effort field means the nested `reasoning` object is what ships,
    // so it needs the same ceiling any other OpenAI-compatible request gets.
    return this.mergeExtraBodyAndResolveKnobs(
      hasQwenEffortConfig
        ? result
        : this.clampConfiguredReasoningEffort(result),
      extraBody,
      request.model,
      selectedThinkingKnob,
    );
  }

  /**
   * Shared tail for the vision and text branches: merge user extra_body
   * last, then resolve thinking-knob conflicts against the wire model.
   */
  private mergeExtraBodyAndResolveKnobs(
    result: Record<string, unknown>,
    extraBody: Record<string, unknown> | undefined,
    model: string | undefined,
    selectedThinkingKnob: DashScopeThinkingKnobSelection | undefined,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const merged: Record<string, unknown> = {
      ...result,
      ...(extraBody ? extraBody : {}),
    };
    const reasoningEffort = merged['reasoning_effort'];
    const dropped = new Set<string>();
    if (selectedThinkingKnob?.field === 'thinking_budget') {
      if (reasoningEffort !== undefined) {
        dropped.add('reasoning_effort');
      }
      if (merged['enable_thinking'] === false) {
        dropped.add('enable_thinking');
      }
    }
    if (
      selectedThinkingKnob?.field === 'reasoning_effort' &&
      merged['thinking_budget'] !== undefined
    ) {
      dropped.add('thinking_budget');
    }
    for (const key of dropped) {
      delete merged[key];
    }
    for (const key of this.dropConflictingThinkingKnobs(
      model,
      merged,
      selectedThinkingKnob,
    )) {
      dropped.add(key);
    }
    this.warnConflictingKnobDrop(model, reasoningEffort, [...dropped]);
    return merged as unknown as OpenAI.Chat.ChatCompletionCreateParams;
  }

  private resolveWireModel(model: string | undefined): string {
    return (model ?? this.contentGeneratorConfig.model ?? '').toLowerCase();
  }

  /**
   * Translate the unified reasoning effort into the wire shape the model
   * accepts. The qwen3.8-max family takes the tiered `reasoning_effort`
   * directly; older qwen hybrid models expose only the on/off
   * `enable_thinking` switch, so the effort ladder collapses to on/off
   * there. Gated to qwen-family wire models (mirroring the pipeline's
   * disable gate) so the qwen-specific fields never leak to a non-qwen
   * model sharing the DashScope endpoint.
   */
  private buildQwenEffortConfig(
    model: string | undefined,
  ): Record<string, unknown> {
    const reasoning = this.contentGeneratorConfig.reasoning;
    if (!reasoning || reasoning.effort === undefined) {
      return {};
    }
    const wireModel = this.resolveWireModel(model);
    if (isTieredEffortWireModel(wireModel)) {
      return { reasoning_effort: this.clampTieredEffort(reasoning.effort) };
    }
    if (isQwenFamilyWireModel(wireModel)) {
      return { enable_thinking: true };
    }
    return {};
  }

  private clampTieredEffort(effort: ReasoningEffort): ReasoningEffort {
    const clamped = clampReasoningEffort(effort, DASHSCOPE_TIERED_EFFORTS);
    if (clamped !== effort && !this.effortClampWarned) {
      debugLogger.warn(
        `reasoning.effort='${effort}' is not accepted by the DashScope ` +
          `tiered-effort family; using '${clamped}'.`,
      );
      this.effortClampWarned = true;
    }
    return clamped;
  }

  /**
   * Resolve thinking knobs that conflict with a shipping `reasoning_effort`.
   * Preset extra_body injects `enable_thinking` for models declared with
   * enableThinking (provider-config.ts), and user extra_body merges last.
   * Only the qwen3.8-max family reads `reasoning_effort` itself — there an
   * effort tier ships alone: an `enable_thinking: true` alongside an effort
   * tier is a second competing knob (the shape the nested-`reasoning` strip
   * in buildRequest exists to prevent), and DashScope rejects
   * `reasoning_effort` combined with `thinking_budget`. The `'none'`
   * disable and a winning `thinking_budget` intentionally keep a co-present
   * `enable_thinking: true`. Explicit same-layer effort/budget pairs retain
   * reasoning_effort, matching the provider's behavior before cross-layer
   * resolution. An explicit `enable_thinking: false` is the documented
   * extra_body escape hatch winning over the config tier, so it is honoured
   * as the family's canonical disable (`reasoning_effort: 'none'`, preserved
   * by the pipeline's disable strip) rather than silently deleted; a
   * higher-priority `enable_thinking: true` conversely keeps the shipping
   * tier. Older qwen
   * hybrids read `enable_thinking` / `thinking_budget`, not
   * `reasoning_effort`, so when an opaque reasoning_effort override
   * conflicts with a meaningful thinking_budget the inert field goes and
   * the knobs the model reads survive. Non-qwen models treat
   * `reasoning_effort` as an opaque sampling override and keep every knob.
   */
  private dropConflictingThinkingKnobs(
    model: string | undefined,
    merged: Record<string, unknown>,
    selectedThinkingKnob?: DashScopeThinkingKnobSelection,
  ): string[] {
    const wireModel = this.resolveWireModel(model);
    if (!isQwenFamilyWireModel(wireModel)) {
      return [];
    }
    const isTieredEffortModel = isTieredEffortWireModel(wireModel);
    if (
      isTieredEffortModel &&
      selectedThinkingKnob?.field === 'enable_thinking' &&
      selectedThinkingKnob.value === false
    ) {
      merged['reasoning_effort'] = 'none';
      const dropped = ['enable_thinking'];
      if (merged['thinking_budget'] !== undefined) {
        dropped.push('thinking_budget');
      }
      for (const key of dropped) {
        delete merged[key];
      }
      return dropped;
    }

    const effort = merged['reasoning_effort'];
    if (typeof effort !== 'string') {
      return [];
    }
    // `none` is a real disable only for the tiered family. On legacy Qwen
    // models reasoning_effort is opaque, so preserve the meaningful budget
    // and drop the inert field just like any other effort value.
    if (isTieredEffortModel && effort === 'none') {
      if (merged['thinking_budget'] === undefined) {
        return [];
      }
      delete merged['thinking_budget'];
      return ['thinking_budget'];
    }

    if (isTieredEffortModel) {
      if (
        selectedThinkingKnob?.field === 'reasoning_effort' &&
        'enable_thinking' in merged
      ) {
        delete merged['enable_thinking'];
        return ['enable_thinking'];
      }
      return [];
    }

    if (merged['thinking_budget'] === undefined) {
      return [];
    }
    delete merged['reasoning_effort'];
    return ['reasoning_effort'];
  }

  private warnConflictingKnobDrop(
    model: string | undefined,
    reasoningEffort: unknown,
    dropped: string[],
  ): void {
    if (dropped.length === 0) {
      return;
    }
    if (!this.conflictingKnobDropWarned) {
      this.conflictingKnobDropWarned = true;
      debugLogger.warn('DashScope: dropped conflicting thinking knobs', {
        model: this.resolveWireModel(model),
        reasoningEffort,
        dropped,
      });
    }
  }

  private conflictingKnobDropWarned = false;

  buildMetadata(userPromptId: string): DashScopeRequestMetadata {
    const channel = this.cliConfig.getChannel?.();

    return {
      metadata: {
        sessionId: this.cliConfig.getSessionId?.(),
        promptId: userPromptId,
        ...(channel ? { channel } : {}),
      },
    };
  }

  override getDefaultGenerationConfig(): GenerateContentConfig {
    return {};
  }

  /**
   * Add cache control flag to specified message(s) for DashScope providers
   */
  private addDashScopeCacheControl(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    cacheControl: 'system_only' | 'all',
  ): {
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools?: ChatCompletionToolWithCache[];
  } {
    const messages = request.messages;

    const systemIndex = messages.findIndex((msg) => msg.role === 'system');
    const lastIndex = messages.length - 1;

    const updatedMessages =
      messages.length === 0
        ? messages
        : messages.map((message, index) => {
            const shouldAddCacheControl = Boolean(
              (index === systemIndex && systemIndex !== -1) ||
                (index === lastIndex && cacheControl === 'all'),
            );

            if (
              !shouldAddCacheControl ||
              !('content' in message) ||
              message.content === null ||
              message.content === undefined
            ) {
              return message;
            }

            return {
              ...message,
              content: this.addCacheControlToContent(message.content),
            } as OpenAI.Chat.ChatCompletionMessageParam;
          });

    const updatedTools =
      cacheControl === 'all' && request.tools?.length
        ? this.addCacheControlToTools(request.tools)
        : (request.tools as ChatCompletionToolWithCache[] | undefined);

    return {
      messages: updatedMessages,
      tools: updatedTools,
    };
  }

  private addCacheControlToTools(
    tools: OpenAI.Chat.ChatCompletionTool[],
  ): ChatCompletionToolWithCache[] {
    if (tools.length === 0) {
      return tools as ChatCompletionToolWithCache[];
    }

    const updatedTools = [...tools] as ChatCompletionToolWithCache[];
    const lastToolIndex = tools.length - 1;
    updatedTools[lastToolIndex] = {
      ...updatedTools[lastToolIndex],
      cache_control: { type: 'ephemeral' },
    };

    return updatedTools;
  }

  /**
   * Add cache control to message content, handling both string and array formats
   */
  private addCacheControlToContent(
    content: NonNullable<OpenAI.Chat.ChatCompletionMessageParam['content']>,
  ): ChatCompletionContentPartWithCache[] {
    // Convert content to array format if it's a string
    const contentArray = this.normalizeContentToArray(content);

    // Add cache control to the last text item or create one if needed
    return this.addCacheControlToContentArray(contentArray);
  }

  /**
   * Normalize content to array format
   */
  private normalizeContentToArray(
    content: NonNullable<OpenAI.Chat.ChatCompletionMessageParam['content']>,
  ): ChatCompletionContentPartWithCache[] {
    if (typeof content === 'string') {
      return [
        {
          type: 'text',
          text: content,
        } as ChatCompletionContentPartTextWithCache,
      ];
    }
    return [...content] as ChatCompletionContentPartWithCache[];
  }

  /**
   * Add cache control to the content array
   */
  private addCacheControlToContentArray(
    contentArray: ChatCompletionContentPartWithCache[],
  ): ChatCompletionContentPartWithCache[] {
    if (contentArray.length === 0) {
      return contentArray;
    }

    // Add cache_control to the last text item
    const lastItem = contentArray[contentArray.length - 1];
    contentArray[contentArray.length - 1] = {
      ...lastItem,
      cache_control: { type: 'ephemeral' },
    } as ChatCompletionContentPartTextWithCache;

    return contentArray;
  }

  /**
   * True for glm-* models (e.g. glm-4.5, glm-5.2). Uses the same `^glm-` prefix
   * convention as the GLM matchers in tokenLimits.ts, keeping model detection
   * consistent across the codebase.
   */
  private isGlmModel(model: string | undefined): boolean {
    return !!model && model.toLowerCase().startsWith('glm-');
  }

  /**
   * Whether the request is in "function-calling mode" — it declares `tools`, or
   * its history already contains a tool result / assistant tool_call. glm needs
   * one of these present to parse structured content-part arrays.
   */
  private hasFunctionCallingContext(
    request: OpenAI.Chat.ChatCompletionCreateParams,
  ): boolean {
    if (request.tools && request.tools.length > 0) {
      return true;
    }
    return request.messages.some((message) => {
      if (message.role === 'tool') {
        return true;
      }
      if (message.role === 'assistant') {
        const toolCalls = (message as { tool_calls?: unknown[] }).tool_calls;
        return Array.isArray(toolCalls) && toolCalls.length > 0;
      }
      return false;
    });
  }

  /**
   * Collapse text-only content arrays back to a plain string, leaving
   * media-bearing parts (image/audio/...) as arrays. Used for glm tool-less
   * requests, where the array form would otherwise be dropped server-side.
   * Multiple text parts are joined with a blank line, matching the DeepSeek
   * provider's flattening (separate parts read as separate blocks).
   * Only called on the flatten branch, which skips cache control, so no part
   * here carries a `cache_control` marker.
   */
  private flattenTextContent(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (!('content' in message) || !Array.isArray(message.content)) {
        return message;
      }
      const parts = message.content as Array<{ type?: string; text?: string }>;
      if (parts.length === 0) {
        return message;
      }
      const isTextOnly = parts.every((part) => part && part.type === 'text');
      if (!isTextOnly) {
        return message;
      }
      const text = parts.map((part) => part.text ?? '').join('\n\n');
      return {
        ...message,
        content: text,
      } as OpenAI.Chat.ChatCompletionMessageParam;
    });
  }

  /**
   * Vision-capable model patterns.
   * Supports exact matches and prefix patterns for easy extension.
   */
  private static readonly VISION_MODEL_EXACT_MATCHES = new Set(['coder-model']);

  private static readonly VISION_MODEL_PREFIX_PATTERNS = [
    'qwen-vl', // qwen-vl-max, qwen-vl-max-latest, etc.
    'qwen3-vl-plus', // qwen3-vl-plus variants
    'qwen3.5-plus', // qwen3.5-plus (has built-in vision capabilities)
    'qwen3.6-plus', // qwen3.6-plus (multimodal)
    'qwen3.7-plus', // qwen3.7-plus (multimodal)
  ];

  private isVisionModel(model: string | undefined): boolean {
    if (!model) {
      return false;
    }

    const normalized = model.toLowerCase();

    // Check exact matches
    if (
      DashScopeOpenAICompatibleProvider.VISION_MODEL_EXACT_MATCHES.has(
        normalized,
      )
    ) {
      return true;
    }

    // Check prefix patterns
    for (const prefix of DashScopeOpenAICompatibleProvider.VISION_MODEL_PREFIX_PATTERNS) {
      if (normalized.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if cache control should be disabled based on configuration.
   *
   * @returns true if cache control should be enabled, false otherwise
   */
  private shouldEnableCacheControl(): boolean {
    // Cache control is enabled by default (when enableCacheControl is undefined or true).
    return (
      this.cliConfig.getContentGeneratorConfig()?.enableCacheControl !== false
    );
  }
}
