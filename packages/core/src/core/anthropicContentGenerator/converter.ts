/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Candidate,
  CallableTool,
  Content,
  ContentListUnion,
  ContentUnion,
  FunctionResponse,
  GenerateContentParameters,
  Part,
  PartUnion,
  Tool,
  ToolListUnion,
} from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import { buildAnthropicUsageMetadata } from './usage.js';
import type Anthropic from '@anthropic-ai/sdk';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import {
  convertSchema,
  type SchemaComplianceMode,
} from '../../utils/schemaConverter.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { normalizeMcpToolName } from '../../utils/tool-name-utils.js';

type AnthropicMessageParam = Anthropic.MessageParam;
// `scope: 'global'` is sent under the `prompt-caching-scope-2026-01-05` beta
// to extend prompt caching across sessions (rather than the default
// per-session ephemeral scope). The Anthropic SDK types we depend on still
// model `cache_control` as `{ type: 'ephemeral' }` only, so we widen the
// shape here for the fields where we actually attach it (tool params and
// the system text block).
//
// `ttl` is the Anthropic spec's extended-cache-tier field
// (`ttl?: '5m' | '1h'`). Anthropic's current docs describe the 1h tier as
// GA with no beta requirement; `extended-cache-ttl-2025-04-11` is sent
// defensively for older Anthropic-compatible backends that may still gate
// the field on it (see `hasExtendedCacheTtlOnWire` in
// anthropicContentGenerator.ts). Omitting `ttl` means the spec default
// (5m). It composes freely with `scope`: the two are independent and
// Anthropic accepts both on the same cache_control entry.
type AnthropicCacheControl = {
  type: 'ephemeral';
  scope?: 'global';
  ttl?: '5m' | '1h';
};
type AnthropicToolParam = Anthropic.Tool & {
  cache_control?: AnthropicCacheControl;
};
type AnthropicTextBlockParam = Anthropic.TextBlockParam & {
  cache_control?: AnthropicCacheControl;
};
type AnthropicContentBlockParam = Anthropic.ContentBlockParam;

const debugLogger = createDebugLogger('AnthropicConverter');

/**
 * Internal token for "how long should a cache anchor live?", resolved from
 * `ContentGeneratorConfig.cacheRetention` (settings.json:
 * `model.generationConfig.cacheRetention`), threaded into the converter
 * per-call alongside `enableCacheControl`/`useGlobalCacheScope`.
 *
 * `'ephemeral'` (default) omits `ttl` on the wire — spec default is 5m.
 * `'1h'` requests the extended cache tier (`ttl: '1h'`) unconditionally --
 * live verification against the Anthropic Messages API found every
 * currently-active model (Haiku 4.5 through Opus 4.8 and Sonnet 5) accepts
 * it, so there is no known model-specific allowlist to gate on. If a future
 * model rejects it, the 400 from Anthropic surfaces directly to the caller
 * rather than being silently masked by an incomplete allowlist.
 */
export type CacheRetention = 'ephemeral' | '1h';

/**
 * Per-anchor override of {@link CacheRetention}. Keys are the three cache
 * anchors this converter places `cache_control` on — the system text
 * block, the last tool definition, and the trailing user message (a
 * single anchor; this converter marks only one trailing user message with
 * cache_control, not a sliding multi-turn window). Missing keys inherit
 * the top-level retention.
 *
 * These render on the wire in a fixed order — `tool` -> `system` ->
 * `user.last` — and Anthropic requires cache entries with a longer TTL to
 * appear before shorter ones. Resolution (see `resolveCacheRetention`)
 * normalizes for this automatically: setting one anchor to `'1h'`
 * promotes every anchor before it on the wire to `'1h'` as well, so any
 * combination of overrides here produces a legal request body.
 */
export type CacheRetentionByBlock = Partial<
  Record<'system' | 'tool' | 'user.last', CacheRetention>
>;

export interface ConvertGeminiRequestToAnthropicOptions {
  /**
   * On every assistant turn, fill in `signature: ''` on any `thinking` block
   * that lacks the required `signature` field. Preserves the original
   * `thinking` text. Common case: cross-provider history where non-Anthropic
   * generators (OpenAI / Gemini / agent-runtime) only set `thought: true`,
   * or `redacted_thinking` blocks that lost their `data` field through the
   * Gemini-Part round trip.
   */
  normalizeAssistantThinkingSignature?: boolean;
  /**
   * Remove assistant thinking blocks whose opaque signature is missing or
   * empty. Completed turns can safely omit thinking during replay. The active
   * tool loop fails instead because Claude requires all of its thinking blocks
   * to be passed back complete and unmodified.
   */
  dropUnsignedAssistantThinking?: boolean;
  /**
   * On assistant turns containing `tool_use` but lacking any thinking block,
   * prepend a synthetic empty thinking block. Required by DeepSeek's
   * anthropic-compatible API when thinking mode is enabled — without this,
   * follow-up requests fail with HTTP 400 ("The content[].thinking in the
   * thinking mode must be passed back to the API.").
   *
   * Pair with `normalizeAssistantThinkingSignature` so that any
   * signature-less `thinking` block already present is normalized (filled
   * with `signature: ''`) before this pass runs. After normalization the
   * block has a valid `signature` and is treated as already-satisfying, so
   * no synthetic block is prepended and the original thinking text is
   * preserved on the wire.
   *
   * Must be gated on the same per-request condition that emits the
   * top-level `thinking` config so disabled-thinking requests don't ship
   * stray thinking blocks. https://github.com/QwenLM/qwen-code/issues/3786
   */
  injectThinkingOnToolUseTurns?: boolean;
  /**
   * Strip thinking and redacted_thinking blocks from assistant messages.
   * Used to keep DeepSeek requests consistent when thinking mode is off but
   * session history still carries `thought: true` parts (e.g. side-queries
   * spawned with `thinkingConfig.includeThoughts: false`).
   */
  stripAssistantThinking?: boolean;
  /**
   * Strip a trailing assistant message that would otherwise be sent as an
   * "assistant-turn prefill" (a request whose final message has
   * `role: 'assistant'`). Anthropic Opus/Sonnet 4.6+ (and every 5.x
   * family — Fable 5, Mythos 5, …) reject prefill outright:
   *
   *   "This model does not support assistant message prefill. The
   *    conversation must end with a user message."
   *
   * Per Anthropic's own migration guidance this is a model-generation
   * change, not a backend quirk — it 400s identically on the native API,
   * Vertex AI, and Bedrock for every 4.6+ model.
   *
   * A trailing assistant message reaches the converter when Gemini history
   * ends on a model turn with no follow-up (e.g. context-window trimming
   * drops the next user turn, or a subagent's transcript is replayed
   * mid-turn). Two cases are handled:
   *   - The trailing assistant message is empty/whitespace-only (a
   *     leftover prefill artifact with no real content) — drop it.
   *   - The trailing assistant message carries real content (text,
   *     tool_use, thinking) — keep it in history but append a synthetic
   *     user turn so the request satisfies "must end with a user message"
   *     without discarding anything the model already said.
   *
   * Only meaningful when the active model requires adaptive thinking
   * (Claude 4.6+); older models accept prefill on every backend, so this
   * should be gated on `modelSupportsAdaptiveThinking()` in the caller.
   */
  stripTrailingAssistantPrefill?: boolean;
  /**
   * Per-call override for `enableCacheControl`. Falls back to the value
   * captured at construction. The generator passes the live
   * `contentGeneratorConfig.enableCacheControl` here so a hot
   * `Config.setModel()` flip is reflected on the next request — otherwise
   * the converter's body-side `cache_control` and the generator's
   * per-request `prompt-caching-scope-2026-01-05` beta header (which reads
   * the live config directly) can disagree.
   */
  enableCacheControl?: boolean;
  /**
   * When `true`, emit `cache_control: { type: 'ephemeral', scope: 'global' }`
   * on the system text and last tool entry so prefixes cache across
   * sessions; when `false` (or omitted), emit the SDK-standard per-session
   * shape `{ type: 'ephemeral' }`. Must be a strict subset of
   * `enableCacheControl` (no scope without a cache_control entry to
   * attach it to) and should mirror the generator's
   * `prompt-caching-scope-2026-01-05` beta-header gate — both ship
   * together or neither, so anthropic-compatible backends without
   * cross-session caching support don't see an unrecognized scope field.
   */
  useGlobalCacheScope?: boolean;
  /**
   * The cross-session-stable prefix of the system prompt (everything the
   * client assembles before appending volatile tails like git status or
   * session-start context). When it exactly matches the beginning of the
   * request's system text and a suffix follows, the system prompt is split
   * into two text blocks with one cache breakpoint each, making the stable
   * prefix independently cacheable. No match (subagent prompts, stale
   * prefix) falls back to the single-block layout — fail-open, never worse
   * than before. Only meaningful when `enableCacheControl` is on.
   */
  staticSystemPrefix?: string;
  /**
   * Default Anthropic `cache_control` retention for every cache anchor
   * (system text, last tool, trailing user message) unless overridden
   * per-anchor by {@link cacheRetentionByBlock}. `'ephemeral'` (default)
   * omits `ttl` on the wire (spec default is 5m); `'1h'` requests the
   * extended cache tier. See {@link CacheRetention}.
   */
  cacheRetention?: CacheRetention;
  /**
   * Per-anchor override of {@link cacheRetention}. See
   * {@link CacheRetentionByBlock}.
   */
  cacheRetentionByBlock?: CacheRetentionByBlock;
}

export class AnthropicContentConverter {
  private schemaCompliance: SchemaComplianceMode;
  private enableCacheControl: boolean;
  /**
   * Per-request tool ID sanitization state (see {@link resolveToolUseId}).
   * The converter instance is long-lived across requests (constructed once
   * per generator), so this state is reset at the top of every
   * `convertGeminiRequestToAnthropic` call rather than at construction.
   */
  private readonly toolIdMap = new Map<string, string>();
  private readonly usedToolIds = new Set<string>();
  private generatedToolIdCounter = 0;

  constructor(
    _model: string,
    schemaCompliance: SchemaComplianceMode = 'auto',
    enableCacheControl: boolean = true,
  ) {
    this.schemaCompliance = schemaCompliance;
    this.enableCacheControl = enableCacheControl;
  }

  convertGeminiRequestToAnthropic(
    request: GenerateContentParameters,
    options: ConvertGeminiRequestToAnthropicOptions = {},
  ): {
    system?: AnthropicTextBlockParam[] | string;
    messages: AnthropicMessageParam[];
  } {
    this.resetToolIdState();
    let messages: AnthropicMessageParam[] = [];

    const systemText = this.extractTextFromContentUnion(
      request.config?.systemInstruction,
    );

    this.processContents(request.contents, messages);

    if (options.stripAssistantThinking) {
      this.stripThinkingFromAssistantMessages(messages);
    }
    // Normalization runs before injection so non-compliant blocks are seen
    // as already-present (and not duplicated) by the injection pass.
    if (options.normalizeAssistantThinkingSignature) {
      this.fillMissingThinkingSignatures(messages);
    }
    if (options.injectThinkingOnToolUseTurns) {
      this.injectEmptyThinkingOnToolUseTurns(messages);
    }

    // Merge consecutive assistant messages and clean orphaned tool calls.
    // When the Gemini history has consecutive model turns (e.g. from
    // streaming chunk-level recording, max_tokens recovery, or adaptive
    // thinking splits), processContent emits one Anthropic message per
    // Content. The Anthropic API requires that tool_use blocks be
    // immediately followed by tool_result blocks in the next message —
    // consecutive assistant messages break this pairing and cause HTTP 400
    // "tool_use ids were found without tool_result blocks immediately
    // after". Mirrors the same functions in the OpenAI converter.
    messages = mergeConsecutiveAssistantMessages(messages);
    messages = cleanOrphanedToolCalls(messages);
    messages = mergeConsecutiveAssistantMessages(messages);
    // Must run BEFORE dropEmptyTextThinkingBlocks: dropUnsignedThinking...
    // throws when an unsigned thinking block belongs to a turn that's part
    // of an unbroken, still-active tool_use/tool_result chain reaching the
    // end of history -- a real proxy bug that should fail loudly rather
    // than silently continue. An empty-text thinking block with no
    // signature is unsigned by this same definition; if the empty-text
    // guard ran first it would delete the block outright before this
    // check ever saw it, silently swallowing exactly the proxy bug this
    // throw exists to surface (the same pass-ordering hazard raised
    // against the removed PATCH-B heuristic, which retyped instead of
    // deleted but had the identical effect of hiding the block from this
    // check).
    if (options.dropUnsignedAssistantThinking) {
      messages = this.dropUnsignedThinkingFromAssistantMessages(messages);
    }
    // Defense-in-depth against an empty-text thinking block surviving into
    // a non-latest turn (see dropEmptyTextThinkingBlocks's doc) -- e.g. one
    // that DOES carry a signature, so dropUnsignedThinkingFromAssistant...
    // above leaves it alone. Skipped for DeepSeek's injectThinkingOnToolUseTurns
    // path: DeepSeek's synthetic thinking placeholder (injected above) is
    // deliberately `{type:'thinking', thinking:'', signature:''}` on every
    // tool-use turn, and DeepSeek doesn't validate a signature the way
    // Anthropic does, so this guard would strip the very placeholder
    // DeepSeek needs.
    if (!options.injectThinkingOnToolUseTurns) {
      messages = dropEmptyTextThinkingBlocks(messages);
    }
    if (options.stripAssistantThinking) {
      this.stripThinkingFromAssistantMessages(messages);
    }
    messages = mergeConsecutiveUserMessages(messages);
    if (options.stripTrailingAssistantPrefill) {
      this.stripTrailingAssistantPrefill(messages);
    }

    // Add cache_control to enable prompt caching (if enabled). Prefer the
    // per-call override when the caller (typically the generator) passes
    // one — that path latches the live config value alongside the
    // per-request beta-header decision so the two stay in sync after
    // `Config.setModel()` mutates `enableCacheControl` mid-session.
    // `useGlobalCacheScope` is independent of (and a strict subset of)
    // `enableCacheControl`: it only controls whether the emitted
    // cache_control carries `scope: 'global'`, not whether the
    // cache_control itself is emitted.
    const enableCacheControl =
      options.enableCacheControl ?? this.enableCacheControl;
    const useGlobalCacheScope = options.useGlobalCacheScope ?? false;
    const cacheRetention = options.cacheRetention ?? 'ephemeral';
    const cacheRetentionByBlock = options.cacheRetentionByBlock ?? {};
    const system = enableCacheControl
      ? this.buildSystemWithCacheControl(
          systemText,
          useGlobalCacheScope,
          options.staticSystemPrefix,
          this.resolveCacheRetention(
            'system',
            cacheRetention,
            cacheRetentionByBlock,
          ),
        )
      : systemText;
    if (enableCacheControl) {
      this.addCacheControlToMessages(
        messages,
        this.resolveCacheRetention(
          'user.last',
          cacheRetention,
          cacheRetentionByBlock,
        ),
      );
    }

    return {
      system,
      messages,
    };
  }

  async convertGeminiToolsToAnthropic(
    geminiTools: ToolListUnion,
    options: {
      enableCacheControl?: boolean;
      useGlobalCacheScope?: boolean;
      cacheRetention?: CacheRetention;
      cacheRetentionByBlock?: CacheRetentionByBlock;
    } = {},
  ): Promise<AnthropicToolParam[]> {
    const tools: AnthropicToolParam[] = [];

    for (const tool of geminiTools) {
      let actualTool: Tool;

      if ('tool' in tool) {
        actualTool = await (tool as CallableTool).tool();
      } else {
        actualTool = tool as Tool;
      }

      if (!actualTool.functionDeclarations) {
        continue;
      }

      for (const func of actualTool.functionDeclarations) {
        // Skip functions without name or description (required by Anthropic API)
        if (!func.name || !func.description) continue;

        let inputSchema: Record<string, unknown> | undefined;
        if (func.parametersJsonSchema) {
          inputSchema = {
            ...(func.parametersJsonSchema as Record<string, unknown>),
          };
        } else if (func.parameters) {
          inputSchema = func.parameters as Record<string, unknown>;
        }

        if (!inputSchema) {
          inputSchema = { type: 'object', properties: {} };
        }

        inputSchema = convertSchema(inputSchema, this.schemaCompliance);
        if (typeof inputSchema['type'] !== 'string') {
          inputSchema['type'] = 'object';
        }

        tools.push({
          name: func.name,
          description: func.description,
          input_schema: inputSchema as Anthropic.Tool.InputSchema,
        });
      }
    }

    // Add cache_control to the last tool for prompt caching (if enabled).
    // When `useGlobalCacheScope` is set, attach `scope: 'global'` so
    // identical tool prefixes are cached across sessions — tools tend to
    // be the largest, slowest-changing prefix (often 5K+ tokens), so
    // cross-session reuse is where most of the hit-rate improvement under
    // `prompt-caching-scope-2026-01-05` shows up. Non-Anthropic baseURLs
    // ship the standard per-session shape so they don't see a scope
    // extension they may not recognize.
    // Per-call overrides mirror the request-shape gates in
    // `convertGeminiRequestToAnthropic` so a qwen-oauth-style hot flip of
    // `enableCacheControl` (the only field `Config.handleModelChange()`
    // mutates in place without recreating the generator) doesn't leave
    // the tool body and the beta header out of sync. `baseUrl` isn't
    // hot-mutated — non-qwen-oauth providers recreate the generator on
    // refresh — but the same per-call plumbing covers it for free.
    const enableCacheControl =
      options.enableCacheControl ?? this.enableCacheControl;
    const useGlobalCacheScope = options.useGlobalCacheScope ?? false;
    if (enableCacheControl && tools.length > 0) {
      const lastToolIndex = tools.length - 1;
      const resolvedRetention = this.resolveCacheRetention(
        'tool',
        options.cacheRetention ?? 'ephemeral',
        options.cacheRetentionByBlock ?? {},
      );
      tools[lastToolIndex] = {
        ...tools[lastToolIndex],
        cache_control: {
          type: 'ephemeral',
          ...(useGlobalCacheScope ? { scope: 'global' as const } : {}),
          ...(resolvedRetention === '1h' ? { ttl: '1h' as const } : {}),
        },
      };
    }

    return tools;
  }

  convertAnthropicResponseToGemini(
    response: Anthropic.Message,
  ): GenerateContentResponse {
    const geminiResponse = new GenerateContentResponse();
    const parts: Part[] = [];

    for (const block of response.content || []) {
      const blockType = String((block as { type?: string })['type'] || '');
      if (blockType === 'text') {
        const text =
          typeof (block as { text?: string }).text === 'string'
            ? (block as { text?: string }).text
            : '';
        if (text) {
          parts.push({ text });
        }
      } else if (blockType === 'tool_use') {
        const toolUse = block as {
          id?: string;
          name?: string;
          input?: unknown;
        };
        parts.push({
          functionCall: {
            id: typeof toolUse.id === 'string' ? toolUse.id : undefined,
            name: typeof toolUse.name === 'string' ? toolUse.name : undefined,
            args: this.safeInputToArgs(toolUse.input),
          },
        });
      } else if (blockType === 'thinking') {
        const thinking =
          typeof (block as { thinking?: string }).thinking === 'string'
            ? (block as { thinking?: string }).thinking
            : '';
        const signature =
          typeof (block as { signature?: string }).signature === 'string'
            ? (block as { signature?: string }).signature
            : '';
        if (thinking || signature) {
          const thoughtPart: Part = {
            text: thinking,
            thought: true,
            thoughtSignature: signature,
          };
          parts.push(thoughtPart);
        }
      } else if (blockType === 'redacted_thinking') {
        parts.push({ text: '', thought: true });
      }
    }

    const candidate: Candidate = {
      content: {
        parts,
        role: 'model' as const,
      },
      index: 0,
      safetyRatings: [],
    };

    const finishReason = this.mapAnthropicFinishReasonToGemini(
      response.stop_reason,
    );
    if (finishReason) {
      candidate.finishReason = finishReason;
    }

    geminiResponse.candidates = [candidate];
    geminiResponse.responseId = response.id;
    geminiResponse.createTime = Date.now().toString();
    geminiResponse.modelVersion = response.model || undefined;
    geminiResponse.promptFeedback = { safetyRatings: [] };

    if (response.usage) {
      geminiResponse.usageMetadata = buildAnthropicUsageMetadata({
        inputTokens: response.usage.input_tokens || 0,
        cacheReadTokens: response.usage.cache_read_input_tokens || 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens || 0,
        outputTokens: response.usage.output_tokens || 0,
        cacheReadTokensReported:
          typeof response.usage.cache_read_input_tokens === 'number',
        cacheCreationTokensReported:
          typeof response.usage.cache_creation_input_tokens === 'number',
      });
    }

    return geminiResponse;
  }

  private processContents(
    contents: ContentListUnion,
    messages: AnthropicMessageParam[],
  ): void {
    if (Array.isArray(contents)) {
      for (const content of contents) {
        this.processContent(content, messages);
      }
    } else if (contents) {
      this.processContent(contents, messages);
    }
  }

  private processContent(
    content: ContentUnion | PartUnion,
    messages: AnthropicMessageParam[],
  ): void {
    if (typeof content === 'string') {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: content }],
      });
      return;
    }

    if (!this.isContentObject(content)) return;
    const parts = content.parts || [];
    const role = content.role === 'model' ? 'assistant' : 'user';
    const contentBlocks: AnthropicContentBlockParam[] = [];

    for (const part of parts) {
      if (typeof part === 'string') {
        contentBlocks.push({ type: 'text', text: part });
        continue;
      }

      if ('text' in part && 'thought' in part && part.thought) {
        if (role === 'assistant') {
          const thinkingBlock: unknown = {
            type: 'thinking',
            thinking: part.text || '',
          };
          if (
            'thoughtSignature' in part &&
            typeof part.thoughtSignature === 'string'
          ) {
            (thinkingBlock as { signature?: string }).signature =
              part.thoughtSignature;
          }
          contentBlocks.push(thinkingBlock as AnthropicContentBlockParam);
        }
      }

      if ('text' in part && part.text && !('thought' in part && part.thought)) {
        contentBlocks.push({ type: 'text', text: part.text });
      }

      const mediaBlock = this.createMediaBlockFromPart(part);
      if (mediaBlock) {
        contentBlocks.push(mediaBlock);
      }

      if ('functionCall' in part && part.functionCall) {
        if (role === 'assistant') {
          contentBlocks.push({
            type: 'tool_use',
            id: this.resolveToolUseId(part.functionCall.id),
            name: normalizeMcpToolName(part.functionCall.name || ''),
            input: (part.functionCall.args as Record<string, unknown>) || {},
          });
        }
      }

      if (part.functionResponse) {
        const toolResultBlock = this.createToolResultBlock(
          part.functionResponse,
        );
        if (toolResultBlock && role === 'user') {
          contentBlocks.push(toolResultBlock);
        }
      }
    }

    if (contentBlocks.length > 0) {
      // Anthropic requires tool_result to be the first content in a user
      // message replying to a tool_use -- it doesn't scan past a leading
      // non-tool_result block to find the result later in the same
      // message. The source Gemini parts can arrive in any order (e.g. a
      // text part preceding the functionResponse part within the same
      // Content), so move tool_result blocks to the front of a user
      // message whenever any are present. A stable sort preserves the
      // relative order of multiple tool_result blocks against each other.
      if (
        role === 'user' &&
        contentBlocks.some((b) => b.type === 'tool_result')
      ) {
        contentBlocks.sort((a, b) => {
          if (a.type === 'tool_result' && b.type !== 'tool_result') return -1;
          if (a.type !== 'tool_result' && b.type === 'tool_result') return 1;
          return 0;
        });
      }
      messages.push({ role, content: contentBlocks });
    }
  }

  private createToolResultBlock(
    response: FunctionResponse,
  ): Anthropic.ToolResultBlockParam | null {
    const textContent = this.extractFunctionResponseContent(response.response);

    type ToolResultContent = Anthropic.ToolResultBlockParam['content'];
    const partBlocks: AnthropicContentBlockParam[] = [];

    for (const part of response.parts || []) {
      const block = this.createMediaBlockFromPart(part);
      if (block) {
        partBlocks.push(block);
      }
    }

    let content: ToolResultContent;
    if (partBlocks.length > 0) {
      const blocks: AnthropicContentBlockParam[] = [];
      if (textContent) {
        blocks.push({ type: 'text', text: textContent });
      }
      blocks.push(...partBlocks);
      content = blocks as unknown as ToolResultContent;
    } else {
      content = textContent;
    }

    return {
      type: 'tool_result',
      tool_use_id: this.resolveToolUseId(response.id),
      content,
      ...(response.response &&
      Object.prototype.hasOwnProperty.call(response.response, 'error')
        ? { is_error: true }
        : {}),
    };
  }

  private resetToolIdState(): void {
    this.toolIdMap.clear();
    this.usedToolIds.clear();
    this.generatedToolIdCounter = 0;
  }

  /**
   * Resolve a `functionCall.id` / `functionResponse.id` into a wire-safe
   * `tool_use.id` / `tool_result.tool_use_id`. Anthropic validates both
   * fields against `^[a-zA-Z0-9_-]+$` server-side (HTTP 400 otherwise) and
   * rejects the empty string the same way, since `+` requires at least one
   * character. The Gemini lingua-franca's `id` field has no such
   * constraint -- it can carry another provider's ID scheme, a
   * composite/namespaced ID, or be entirely absent.
   *
   * The same source ID always resolves to the same wire ID within a
   * request (memoized in `toolIdMap`), so a `tool_use`/`tool_result` pair
   * that shares a source ID still links up correctly after sanitization.
   * State is scoped to a single `convertGeminiRequestToAnthropic` call
   * (reset via {@link resetToolIdState}), since the converter instance
   * itself is long-lived across requests.
   */
  private resolveToolUseId(rawId?: string): string {
    const sourceId = typeof rawId === 'string' ? rawId.trim() : '';
    const existingId = sourceId ? this.toolIdMap.get(sourceId) : undefined;
    if (existingId) {
      return existingId;
    }

    const baseId = sourceId
      ? this.sanitizeToolUseId(sourceId)
      : this.nextGeneratedToolId();
    const uniqueId = this.makeUniqueToolUseId(baseId);

    if (sourceId) {
      this.toolIdMap.set(sourceId, uniqueId);
    }

    return uniqueId;
  }

  private sanitizeToolUseId(id: string): string {
    const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned || this.nextGeneratedToolId();
  }

  private nextGeneratedToolId(): string {
    const id = `tool_${this.generatedToolIdCounter}`;
    this.generatedToolIdCounter += 1;
    return id;
  }

  private makeUniqueToolUseId(baseId: string): string {
    if (!this.usedToolIds.has(baseId)) {
      this.usedToolIds.add(baseId);
      return baseId;
    }

    let suffix = 1;
    let candidate = `${baseId}_${suffix}`;
    while (this.usedToolIds.has(candidate)) {
      suffix += 1;
      candidate = `${baseId}_${suffix}`;
    }

    this.usedToolIds.add(candidate);
    return candidate;
  }

  private createMediaBlockFromPart(
    part: Part,
  ): AnthropicContentBlockParam | null {
    if (part.inlineData?.mimeType && part.inlineData?.data) {
      if (this.isSupportedAnthropicImageMimeType(part.inlineData.mimeType)) {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.inlineData.mimeType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: part.inlineData.data,
          },
        };
      }

      if (part.inlineData.mimeType === 'application/pdf') {
        return {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: part.inlineData.data,
          },
        };
      }

      const displayName = part.inlineData.displayName
        ? ` (${part.inlineData.displayName})`
        : '';
      return {
        type: 'text',
        text: `Unsupported inline media type: ${part.inlineData.mimeType}${displayName}.`,
      };
    }

    if (part.fileData?.mimeType && part.fileData?.fileUri) {
      const displayName = part.fileData.displayName
        ? ` (${part.fileData.displayName})`
        : '';
      const fileUri = part.fileData.fileUri;

      if (this.isSupportedAnthropicImageMimeType(part.fileData.mimeType)) {
        return {
          type: 'image',
          source: {
            type: 'url',
            url: fileUri,
          },
        } as unknown as AnthropicContentBlockParam;
      }

      if (part.fileData.mimeType === 'application/pdf') {
        return {
          type: 'document',
          source: {
            type: 'url',
            url: fileUri,
          },
        } as unknown as AnthropicContentBlockParam;
      }

      return {
        type: 'text',
        text: `Unsupported file media type: ${part.fileData.mimeType}${displayName}.`,
      };
    }

    return null;
  }

  private isSupportedAnthropicImageMimeType(
    mimeType: string,
  ): mimeType is 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
    return (
      mimeType === 'image/jpeg' ||
      mimeType === 'image/png' ||
      mimeType === 'image/gif' ||
      mimeType === 'image/webp'
    );
  }

  private extractTextFromContentUnion(contentUnion: unknown): string {
    if (typeof contentUnion === 'string') {
      return contentUnion;
    }

    if (Array.isArray(contentUnion)) {
      return contentUnion
        .map((item) => this.extractTextFromContentUnion(item))
        .filter(Boolean)
        .join('\n');
    }

    if (typeof contentUnion === 'object' && contentUnion !== null) {
      if ('parts' in contentUnion) {
        const content = contentUnion as Content;
        return (
          content.parts
            ?.map((part: Part) => {
              if (typeof part === 'string') return part;
              if ('text' in part) return part.text || '';
              return '';
            })
            .filter(Boolean)
            .join('\n') || ''
        );
      }
    }

    return '';
  }

  private extractFunctionResponseContent(response: unknown): string {
    if (response === null || response === undefined) {
      return '';
    }

    if (typeof response === 'string') {
      return response;
    }

    if (typeof response === 'object') {
      const responseObject = response as Record<string, unknown>;
      const output = responseObject['output'];
      if (typeof output === 'string') {
        return output;
      }

      const error = responseObject['error'];
      if (typeof error === 'string') {
        return error;
      }
    }

    try {
      const serialized = JSON.stringify(response);
      return serialized ?? String(response);
    } catch {
      return String(response);
    }
  }

  private safeInputToArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object') {
      return input as Record<string, unknown>;
    }
    if (typeof input === 'string') {
      return safeJsonParse(input, {});
    }
    return {};
  }

  mapAnthropicFinishReasonToGemini(
    reason?: string | null,
  ): FinishReason | undefined {
    if (!reason) return undefined;
    const mapping: Record<string, FinishReason> = {
      end_turn: FinishReason.STOP,
      stop_sequence: FinishReason.STOP,
      tool_use: FinishReason.STOP,
      max_tokens: FinishReason.MAX_TOKENS,
      content_filter: FinishReason.SAFETY,
    };
    return mapping[reason] || FinishReason.FINISH_REASON_UNSPECIFIED;
  }

  private isContentObject(
    content: unknown,
  ): content is { role: string; parts: Part[] } {
    return (
      typeof content === 'object' &&
      content !== null &&
      'role' in content &&
      'parts' in content &&
      Array.isArray((content as Record<string, unknown>)['parts'])
    );
  }

  /**
   * Resolve the effective {@link CacheRetention} for one cache anchor,
   * normalized so retention is monotonically non-increasing in wire order.
   *
   * Render order is `tools` -> `system` -> `messages`, so this converter's
   * three anchors sit on the wire in exactly that order: `tool` -> `system`
   * -> `user.last`. Anthropic requires "cache entries with longer TTL must
   * appear before shorter TTLs" — an anchor at the spec's 5-minute default
   * (no `ttl`) is a short-TTL entry for this rule's purposes, so a raw
   * per-anchor override like `cacheRetentionByBlock: { system: '1h' }`
   * would otherwise leave the (still 5m-default) `tool` anchor ahead of a
   * 1h `system` anchor on the wire — an ordering violation Anthropic 400s
   * on.
   *
   * Resolving with a scan instead of a straight per-anchor lookup avoids
   * that: `anchor` resolves to `'1h'` if `anchor` itself OR any anchor
   * later on the wire resolves to `'1h'`. That makes every
   * `cacheRetentionByBlock` configuration legal — anchors before a `'1h'`
   * anchor are promoted to `'1h'` too — without adding a new error surface
   * or rejecting any input. `{ tool: '1h' }` alone is unaffected (nothing
   * follows it that needs promoting); `{ system: '1h' }` alone now also
   * promotes `tool` to `'1h'`, which is exactly the "cache my big system
   * prompt for an hour" usage the per-anchor override exists for.
   */
  private resolveCacheRetention(
    anchor: 'system' | 'tool' | 'user.last',
    cacheRetention: CacheRetention,
    cacheRetentionByBlock: CacheRetentionByBlock,
  ): CacheRetention {
    const wireOrder: ReadonlyArray<'tool' | 'system' | 'user.last'> = [
      'tool',
      'system',
      'user.last',
    ];
    const anchorIndex = wireOrder.indexOf(anchor);
    for (let i = wireOrder.length - 1; i >= anchorIndex; i--) {
      if ((cacheRetentionByBlock[wireOrder[i]] ?? cacheRetention) === '1h') {
        return '1h';
      }
    }
    return 'ephemeral';
  }

  /**
   * Build system content blocks with cache_control.
   * Anthropic prompt caching requires cache_control on system content.
   * When `useGlobalCacheScope` is set, attach `scope: 'global'` so the
   * system prefix participates in cross-session caching under the
   * `prompt-caching-scope-2026-01-05` beta. Otherwise emit the standard
   * per-session shape so non-Anthropic baseURLs aren't sent a scope
   * extension they may not recognize.
   *
   * When `staticSystemPrefix` matches the beginning of the system text and
   * a suffix follows (git status, session-start context — the volatile
   * tails the client appends after the stable prompt), the text is split
   * into two blocks carrying one breakpoint each:
   *   1. the stable prefix — scoped per `useGlobalCacheScope`, so new
   *      sessions reuse it even though their suffix differs;
   *   2. the end of the full system prompt — always the per-session
   *      `{ type: 'ephemeral' }` shape. The suffix varies across sessions,
   *      so a global-scope entry here would churn cache for zero hits
   *      (same reasoning as `addCacheControlToMessages`). Within a session
   *      it still caches the suffix, and when the suffix changes mid-session
   *      (/cd refreshes git status, session-start context lands) the prefix
   *      breakpoint keeps the big block from re-billing.
   * The split only shapes the outgoing request; stored history and
   * non-Anthropic transports keep seeing a single system string.
   */
  private buildSystemWithCacheControl(
    systemText: string,
    useGlobalCacheScope: boolean,
    staticSystemPrefix?: string,
    cacheRetention: CacheRetention = 'ephemeral',
  ): AnthropicTextBlockParam[] | string {
    if (!systemText) {
      return systemText;
    }

    const scopedCacheControl: AnthropicCacheControl = {
      type: 'ephemeral',
      ...(useGlobalCacheScope ? { scope: 'global' as const } : {}),
      ...(cacheRetention === '1h' ? { ttl: '1h' as const } : {}),
    };

    if (
      staticSystemPrefix &&
      systemText.length > staticSystemPrefix.length &&
      systemText.startsWith(staticSystemPrefix)
    ) {
      return [
        {
          type: 'text',
          text: staticSystemPrefix,
          cache_control: scopedCacheControl,
        },
        {
          type: 'text',
          text: systemText.slice(staticSystemPrefix.length),
          // Deliberately never carries `scope: 'global'` (see class doc
          // above — the suffix varies per session, cross-session reuse
          // has ~zero hit rate). `cacheRetention` still applies: the
          // suffix is cached within a session, and a caller that asked
          // for the 1h tier benefits from it surviving longer gaps
          // between turns even on this volatile block.
          cache_control: {
            type: 'ephemeral',
            ...(cacheRetention === '1h' ? { ttl: '1h' as const } : {}),
          },
        },
      ];
    }

    return [
      {
        type: 'text',
        text: systemText,
        cache_control: scopedCacheControl,
      },
    ];
  }

  /**
   * Remove thinking and redacted_thinking blocks from assistant messages.
   * Used by DeepSeek when thinking mode is off but session history still
   * has `thought: true` parts — keeps the request body in sync with the
   * absent top-level `thinking` config.
   *
   * If stripping would leave an assistant message with no content blocks
   * (a thinking-only turn, e.g. one cut off by max_tokens before any text
   * or tool_use was emitted), we keep the original blocks. An empty
   * `content: []` is rejected by the Anthropic API, and dropping the
   * message would break the required user/assistant alternation. DeepSeek
   * empirically tolerates the residual `thinking-block + no-thinking-config`
   * shape (verified against api.deepseek.com/anthropic), so leaving it as
   * an unaltered passthrough is the safer fallback.
   */
  private stripThinkingFromAssistantMessages(
    messages: AnthropicMessageParam[],
  ): void {
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (!Array.isArray(message.content)) continue;

      const filtered = message.content.filter((block) => {
        const t = (block as { type?: string }).type;
        return t !== 'thinking' && t !== 'redacted_thinking';
      });
      if (filtered.length === 0) continue;
      if (filtered.length !== message.content.length) {
        message.content = filtered;
      }
    }
  }

  /**
   * Fill in `signature: ''` on every assistant `thinking` block that lacks
   * a `signature` field. Preserves the original thinking text. Common cases:
   *
   * - Cross-provider history where the upstream generator (OpenAI / Gemini /
   *   agent-runtime) only set `thought: true` without a signature.
   * - `redacted_thinking` blocks whose `data` field didn't survive the
   *   round-trip through Gemini Part format.
   *
   * DeepSeek empirically accepts empty signatures, so this keeps the wire
   * shape spec-compliant without discarding any preserved thinking text.
   */
  private fillMissingThinkingSignatures(
    messages: AnthropicMessageParam[],
  ): void {
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (!Array.isArray(message.content)) continue;

      let modified = false;
      const normalized = message.content.map((block) => {
        const b = block as { type?: string; signature?: unknown };
        if (b.type === 'thinking' && typeof b.signature !== 'string') {
          modified = true;
          return {
            ...(block as object),
            signature: '',
          } as unknown as AnthropicContentBlockParam;
        }
        return block;
      });
      if (modified) {
        message.content = normalized;
      }
    }
  }

  private dropUnsignedThinkingFromAssistantMessages(
    messages: AnthropicMessageParam[],
  ): AnthropicMessageParam[] {
    const cleaned: AnthropicMessageParam[] = [];
    const isUnsignedThinking = (block: AnthropicContentBlockParam) => {
      const value = block as { type?: string; signature?: unknown };
      return (
        value.type === 'thinking' &&
        (typeof value.signature !== 'string' || value.signature.length === 0)
      );
    };
    const hasBlockType = (
      message: AnthropicMessageParam,
      type: 'tool_use' | 'tool_result',
    ) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block) => (block as { type?: string }).type === type,
      );
    const activeToolUseTurns = new Set<number>();
    let cursor = messages.length - 1;
    while (cursor >= 0) {
      let hasToolResult = false;
      while (cursor >= 0 && messages[cursor]?.role === 'user') {
        hasToolResult ||= hasBlockType(messages[cursor], 'tool_result');
        cursor--;
      }
      const assistant = messages[cursor];
      if (
        !hasToolResult ||
        !assistant ||
        assistant.role !== 'assistant' ||
        !hasBlockType(assistant, 'tool_use')
      ) {
        break;
      }
      activeToolUseTurns.add(cursor);
      cursor--;
    }

    for (const [index, message] of messages.entries()) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        cleaned.push(message);
        continue;
      }

      if (!message.content.some(isUnsignedThinking)) {
        cleaned.push(message);
        continue;
      }

      if (activeToolUseTurns.has(index)) {
        throw new Error(
          'Anthropic-compatible proxy omitted the thinking signature for a ' +
            'tool-use turn that is still in progress. Configure the proxy to ' +
            'preserve thinking signatures, or start a new session with ' +
            'reasoning disabled.',
        );
      }

      const filtered = message.content.filter(
        (block) => !isUnsignedThinking(block),
      );
      if (filtered.length > 0) {
        cleaned.push({ ...message, content: filtered });
      }
    }

    return cleaned;
  }

  /**
   * DeepSeek's anthropic-compatible API rejects follow-up requests when an
   * assistant turn carrying `tool_use` omits a thinking block while thinking
   * mode is on, returning HTTP 400 ("The content[].thinking in the thinking
   * mode must be passed back to the API."). The model can legitimately
   * return a tool round without thinking content, so prepend a synthetic
   * empty thinking block when one is missing.
   *
   * Live verification against api.deepseek.com/anthropic confirmed the
   * trigger is specific to tool_use turns — plain-text assistant turns
   * without thinking are accepted unchanged. We mirror that boundary here
   * to avoid bloating replay history with synthetic blocks for turns the
   * API already accepts.
   *
   * Should be paired with `fillMissingThinkingSignatures` running first
   * so that signature-less `thinking` blocks become compliant in place
   * (preserving their original text), and this pass then sees them as
   * already-satisfying. https://github.com/QwenLM/qwen-code/issues/3786
   */
  private injectEmptyThinkingOnToolUseTurns(
    messages: AnthropicMessageParam[],
  ): void {
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (!Array.isArray(message.content)) continue;

      const blocks = message.content;

      const hasToolUse = blocks.some(
        (block) => (block as { type?: string }).type === 'tool_use',
      );
      if (!hasToolUse) continue;

      const hasThinking = blocks.some((block) => {
        const t = (block as { type?: string }).type;
        return t === 'thinking' || t === 'redacted_thinking';
      });
      if (hasThinking) continue;

      // DeepSeek currently accepts an empty `signature` for synthetic
      // thinking blocks. The `signature` field is an opaque token in the
      // Anthropic spec, so this is a workaround — if DeepSeek tightens
      // validation in the future, we may need to switch to
      // `redacted_thinking` or another approach.
      const emptyThinking = {
        type: 'thinking',
        thinking: '',
        signature: '',
      } as unknown as AnthropicContentBlockParam;
      message.content = [emptyThinking, ...blocks];
    }
  }

  /**
   * Strip a trailing empty-content assistant message, or append a
   * synthetic user turn to satisfy Anthropic's "must end with a user
   * message" requirement (Opus/Sonnet 4.6+, every 5.x family) when the
   * conversation would otherwise end on a non-empty assistant message.
   * See {@link ConvertGeminiRequestToAnthropicOptions.stripTrailingAssistantPrefill}.
   */
  private stripTrailingAssistantPrefill(
    messages: AnthropicMessageParam[],
  ): void {
    // Phase 1: drop genuinely empty trailing assistant messages (no real
    // content — a leftover prefill artifact from history trimming/replay).
    while (messages.length > 0) {
      const last = messages[messages.length - 1]!;
      if (last.role !== 'assistant') return;
      if (!this.isEmptyAssistantMessage(last)) break;
      messages.pop();
    }

    // Phase 2: a real-content assistant message is still trailing — keep
    // it in history (it may carry tool_use/thinking the model needs to see
    // again) and append a synthetic user turn instead of dropping it.
    if (
      messages.length > 0 &&
      messages[messages.length - 1]!.role === 'assistant'
    ) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Continue.' }],
      });
    }
  }

  private isEmptyAssistantMessage(message: AnthropicMessageParam): boolean {
    const content = message.content;
    if (!content) return true;
    if (typeof content === 'string') return content.trim().length === 0;
    if (!Array.isArray(content) || content.length === 0) return true;

    for (const block of content) {
      const type = (block as { type?: string }).type;
      if (type === 'text') {
        const text = (block as { text?: string }).text;
        if (typeof text === 'string' && text.trim().length > 0) return false;
      } else {
        // Any non-text block (tool_use, thinking, etc.) is real content.
        return false;
      }
    }
    return true;
  }

  /**
   * Add cache_control to the last user message's content.
   * This enables prompt caching for the conversation context.
   *
   * Deliberately emits the per-session `{ type: 'ephemeral' }` shape only —
   * no `scope: 'global'`. The last user message changes every turn (it's
   * the live prompt and any tool_result blocks from the immediately prior
   * round), so cross-session reuse here has effectively zero hit rate and
   * paying the global-scope overhead would just churn cache. The static
   * system prefix and tool prefixes (which DO repeat across sessions) carry
   * `scope: 'global'` instead.
   */
  private addCacheControlToMessages(
    messages: Anthropic.MessageParam[],
    cacheRetention: CacheRetention = 'ephemeral',
  ): void {
    // Find the last user message to add cache_control. The Anthropic docs
    // (https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
    // explicitly list both `text` and `tool_result` blocks as cacheable in
    // `messages.content`. In agentic loops the last user message after
    // turn 1 is typically a tool_result-only message, so accepting both
    // types keeps the per-turn breakpoint moving forward as the
    // conversation grows (otherwise the cacheable region collapses back
    // to system+tools and turn-over-turn history never gets cached).
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        const content = Array.isArray(msg.content)
          ? msg.content
          : [{ type: 'text' as const, text: msg.content }];

        if (content.length > 0) {
          const lastContent = content[content.length - 1];
          if (typeof lastContent === 'object' && 'type' in lastContent) {
            const type = lastContent.type;
            // Empty text blocks cannot be cached (per Anthropic docs).
            const isEmptyText =
              type === 'text' &&
              (!('text' in lastContent) || !lastContent.text);
            if ((type === 'text' || type === 'tool_result') && !isEmptyText) {
              lastContent.cache_control = {
                type: 'ephemeral',
                ...(cacheRetention === '1h' ? { ttl: '1h' as const } : {}),
              };
            }
          }
          msg.content = content;
        }
        break;
      }
    }
  }
}

/**
 * Merge consecutive assistant messages into a single message.
 *
 * When the Gemini history has consecutive model turns (e.g. from streaming
 * chunk-level recording, max_tokens recovery, or adaptive thinking splits),
 * processContent emits one Anthropic message per Content. The Anthropic API
 * requires that tool_use blocks be immediately followed by tool_result
 * blocks in the next message — consecutive assistant messages break this
 * pairing and cause HTTP 400 "tool_use ids were found without tool_result
 * blocks immediately after".
 *
 * Thinking blocks must come first in Anthropic's content array, so merged
 * blocks are reordered: all thinking blocks (from both messages) precede
 * non-thinking blocks (text, tool_use, etc.).
 *
 * Mirrors the same-name function in the OpenAI converter.
 */
function mergeConsecutiveAssistantMessages(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  const merged: AnthropicMessageParam[] = [];

  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      merged.length > 0 &&
      Array.isArray(message.content)
    ) {
      const lastMessage = merged[merged.length - 1]!;
      if (
        lastMessage.role === 'assistant' &&
        Array.isArray(lastMessage.content)
      ) {
        const lastBlocks = lastMessage.content as AnthropicContentBlockParam[];
        const currentBlocks = message.content as AnthropicContentBlockParam[];

        const isThinking = (b: AnthropicContentBlockParam): boolean => {
          const t = (b as { type?: string }).type;
          return t === 'thinking' || t === 'redacted_thinking';
        };

        const seenToolUseIds = new Set<string>();
        const combined: AnthropicContentBlockParam[] = [
          ...lastBlocks.filter(isThinking),
          ...currentBlocks.filter(isThinking),
          ...lastBlocks.filter((b) => !isThinking(b)),
          ...currentBlocks.filter((b) => !isThinking(b)),
        ].filter((b) => {
          const t = (b as { type?: string }).type;
          if (t === 'tool_use') {
            const id = (b as { id?: string }).id;
            if (id) {
              if (seenToolUseIds.has(id)) return false;
              seenToolUseIds.add(id);
            }
          }
          return true;
        });

        lastMessage.content = combined;
        continue;
      }
    }
    merged.push(message);
  }

  return merged;
}

/**
 * Builds a first-wins predicate for deduplicating tool_result blocks by
 * tool_use_id. Anthropic rejects a message with more than one tool_result
 * for the same tool_use_id ("each `tool_use` block must have a single
 * result" -- HTTP 400); a duplicate can happen when a tool call's result is
 * recorded twice in history (a retried conversion pass, or a history source
 * that double-appends a function response). In the cases observed so far
 * the duplicate blocks are byte-identical, so first-wins vs. last-wins is
 * indistinguishable in practice -- first-wins is chosen only because it
 * requires no lookahead. id-less blocks always pass through unfiltered,
 * preserving prior behavior for blocks Anthropic doesn't validate this way.
 *
 * Two independent call sites need this: `cleanOrphanedToolCalls` (the
 * common case, a duplicate within one message) and
 * `mergeConsecutiveUserMessages` (a duplicate that only becomes
 * co-located after two originally-separate messages are combined).
 */
function makeToolResultDeduper(): (id: string | undefined) => boolean {
  const seen = new Set<string>();
  return (id) => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

/**
 * Remove tool_use blocks that have no matching tool_result in the
 * immediately following user message, and remove tool_result blocks that
 * have no matching tool_use in the immediately preceding assistant message.
 * Also cascade-strips `thinking`/`redacted_thinking` blocks from an
 * assistant turn whenever a `tool_use` is removed from that same turn by
 * this pass AND no other `tool_use` survives in it -- the signature on
 * those blocks was computed over content that included the now-removed
 * `tool_use`, so replaying it produces Anthropic 400 "thinking blocks in
 * the latest assistant message cannot be modified". The model regenerates
 * thinking on its next turn regardless. Scoped to "no surviving tool_use"
 * rather than "any tool_use removed": a turn with `[thinking, tool_use A,
 * tool_use B]` where only B is a genuine orphan still sends A on the wire,
 * and per Anthropic's manual-mode extended-thinking contract the final
 * assistant turn of a thinking-enabled request must begin with a thinking
 * block when any `tool_use` remains in it -- stripping the thinking here
 * would trade one 400 for another.
 *
 * A `tool_use` in the very last message (no message follows it at all) is
 * never condemned as orphaned here -- "no result yet" isn't the same as
 * "no result ever": the tool may simply not have finished executing yet,
 * or this conversion may not be building the completed turn to send to
 * Anthropic at all (token counting, a resumed/replayed session snapshot,
 * a retry issued before tool execution completes, ...). Only a `tool_use`
 * whose subsequent message was actually scanned and found lacking a
 * matching `tool_result` is a genuine orphan.
 *
 * Empty messages produced by the cleanup are dropped entirely. A subsequent
 * mergeConsecutiveAssistantMessages call fixes alternation issues created
 * by a dropped assistant message sandwiched between two other assistant
 * messages; mergeConsecutiveUserMessages (later in the pipeline) does the
 * same when the sandwiching messages are user turns instead.
 *
 * Mirrors the same-name function in the OpenAI converter.
 */
function cleanOrphanedToolCalls(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  const validToolUseBlocks = new WeakSet<object>();
  const validToolResultBlocks = new WeakSet<object>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }

    const blocks = message.content as AnthropicContentBlockParam[];
    const toolUseBlocks = new Map<string, AnthropicContentBlockParam>();
    for (const block of blocks) {
      if ((block as { type?: string }).type === 'tool_use') {
        const id = (block as { id?: string }).id;
        if (id && !toolUseBlocks.has(id)) toolUseBlocks.set(id, block);
      }
    }
    if (toolUseBlocks.size === 0) continue;

    // No message follows this assistant turn at all -- these tool_use
    // blocks are unresolved (the tool hasn't finished executing yet, or
    // this conversion isn't building the completed turn for Anthropic at
    // all, e.g. a token-count pass or a mid-tool-call snapshot), not
    // orphaned. Protect them from the filter below. A genuine orphan
    // requires a subsequent message that was actually scanned and found
    // to lack a matching tool_result -- "history ends here" is not that.
    if (i === messages.length - 1) {
      for (const block of toolUseBlocks.values()) {
        validToolUseBlocks.add(block as object);
      }
      continue;
    }

    for (let j = i + 1; j < messages.length; j++) {
      const nextMessage = messages[j];
      if (
        !nextMessage ||
        nextMessage.role !== 'user' ||
        !Array.isArray(nextMessage.content)
      ) {
        break;
      }

      let seenNonToolResult = false;
      for (const block of nextMessage.content as AnthropicContentBlockParam[]) {
        if ((block as { type?: string }).type === 'tool_result') {
          const id = (block as { tool_use_id?: string }).tool_use_id;
          const toolUseBlock = id ? toolUseBlocks.get(id) : undefined;
          if (!seenNonToolResult && toolUseBlock) {
            validToolUseBlocks.add(toolUseBlock as object);
            validToolResultBlocks.add(block as object);
          }
        } else {
          seenNonToolResult = true;
        }
      }
    }
  }

  const cleaned: AnthropicMessageParam[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      cleaned.push(message);
      continue;
    }

    const blocks = message.content as AnthropicContentBlockParam[];
    const hasToolUse = blocks.some(
      (b) => (b as { type?: string }).type === 'tool_use',
    );
    const hasToolResult = blocks.some(
      (b) => (b as { type?: string }).type === 'tool_result',
    );

    if (!hasToolUse && !hasToolResult) {
      cleaned.push(message);
      continue;
    }

    let toolUseRemoved = false;
    const keepToolResult = makeToolResultDeduper();

    const filtered = blocks.filter((b) => {
      const t = (b as { type?: string }).type;
      if (t === 'tool_use') {
        const id = (b as { id?: string }).id;
        const keep = !id || validToolUseBlocks.has(b as object);
        if (!keep) toolUseRemoved = true;
        return keep;
      }
      if (t === 'tool_result') {
        const id = (b as { tool_use_id?: string }).tool_use_id;
        if (!id) return true;
        if (!validToolResultBlocks.has(b as object)) return false;
        return keepToolResult(id);
      }
      return true;
    });

    // A tool_use was stripped from this turn and none survives -- any
    // thinking/redacted_thinking sibling in the same turn is now
    // untrustworthy (see function doc). If a tool_use survives, the
    // thinking sibling is left in place: it's still needed to satisfy
    // Anthropic's manual-mode "final turn must begin with thinking when a
    // tool_use is present" rule, and only cascading on total removal keeps
    // this narrower than a blanket "any removal" rule. tool_use/thinking
    // only ever co-occur on assistant messages, but the role check is
    // defensive.
    const survivingToolUse = filtered.some(
      (b) => (b as { type?: string }).type === 'tool_use',
    );
    const finalBlocks =
      toolUseRemoved && !survivingToolUse && message.role === 'assistant'
        ? filtered.filter((b) => {
            const t = (b as { type?: string }).type;
            return t !== 'thinking' && t !== 'redacted_thinking';
          })
        : filtered;

    if (finalBlocks.length > 0) {
      cleaned.push({ ...message, content: finalBlocks });
    } else {
      debugLogger.debug(
        'cleanOrphanedToolCalls: dropping message with only orphaned tool blocks',
      );
    }
  }

  return cleaned;
}

/**
 * Drops any `thinking` block with empty text from a non-latest assistant
 * turn (dropping the whole message if that empties it out). An Anthropic
 * `thinking` block's signature is computed over its own text content; a
 * block with no text at all cannot represent valid signed reasoning
 * regardless of whether a signature is present. This arises when a
 * `redacted_thinking` block -- whose opaque `data` doesn't survive the
 * Gemini-`Part` round trip, see
 * {@link AnthropicContentConverter.convertAnthropicResponseToGemini} --
 * is replayed back through history construction as an empty-text
 * `thinking` block.
 *
 * Scoped to non-latest assistant turns, matching Anthropic's contract that
 * the latest assistant turn's signatures must replay byte-exact.
 *
 * This was originally one guard inside a larger `pruneUntrustworthyThinking`
 * pass that also tried to detect and downgrade a non-latest, thinking-only
 * turn whose `tool_use` had gone stale in an earlier trim (a cross-turn
 * complement to {@link cleanOrphanedToolCalls}'s same-turn cascade). That
 * broader heuristic was removed after review: it could not distinguish "this
 * turn's tool_use was removed by an earlier trim" from "this turn was
 * always thinking-only" (both are structurally identical by the time it
 * ran), it ran before the passes that already handle unsigned thinking
 * correctly (reordering caused them to stop recognizing thinking it had
 * already re-typed as text), its DeepSeek exclusion only covered one of
 * DeepSeek's two thinking modes, and live A/B verification against a real
 * session showed it re-typing a thinking-only turn on the very next
 * request just because a newer assistant turn had been appended --
 * invalidating a cache breakpoint and adding token cost for content that
 * was never actually invalid. Investigation into this codebase's actual
 * compaction (`chatCompressionService` is full-history, not a partial
 * trim that could strand a `tool_use`) and orphan-repair
 * (`repairOrphanedToolUseTurns` already synthesizes an error
 * `tool_result` for a genuine cross-turn orphan before it would reach this
 * pass) did not reproduce the state the broader heuristic existed to
 * clean up. This guard is the one part of that pass that is unconditionally
 * correct regardless of that heuristic's premise, so it's kept on its own.
 */
function dropEmptyTextThinkingBlocks(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  let latestAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      latestAssistantIdx = i;
      break;
    }
  }

  const out: AnthropicMessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    if (i === latestAssistantIdx) {
      out.push(msg);
      continue;
    }

    const blocks = msg.content as AnthropicContentBlockParam[];
    const filtered = blocks.filter((raw) => {
      const bType = (raw as { type?: string }).type;
      const bThinkingRaw = (raw as { thinking?: unknown }).thinking;
      const bThinking =
        typeof bThinkingRaw === 'string' ? bThinkingRaw : undefined;
      return !(
        bType === 'thinking' &&
        (bThinking === undefined || bThinking.length === 0)
      );
    });

    if (filtered.length === 0) continue;
    out.push({ role: msg.role, content: filtered });
  }
  return out;
}

function mergeConsecutiveUserMessages(
  messages: AnthropicMessageParam[],
): AnthropicMessageParam[] {
  const merged: AnthropicMessageParam[] = [];

  for (const message of messages) {
    const lastMessage = merged[merged.length - 1];
    if (
      message.role === 'user' &&
      lastMessage?.role === 'user' &&
      Array.isArray(message.content) &&
      Array.isArray(lastMessage.content)
    ) {
      const combined = [
        ...(lastMessage.content as AnthropicContentBlockParam[]),
        ...(message.content as AnthropicContentBlockParam[]),
      ];
      // Two originally-separate user messages can each carry a valid
      // tool_result for the same tool_use_id (cleanOrphanedToolCalls only
      // dedupes within a single message, before this merge combines
      // several into one). Re-apply the same first-wins dedup here so a
      // cross-message duplicate can't survive the merge and reach the
      // wire as two tool_result blocks for one tool_use_id.
      const keepToolResult = makeToolResultDeduper();
      const toolResults = combined.filter((b) => {
        if ((b as { type?: string }).type !== 'tool_result') return false;
        const id = (b as { tool_use_id?: string }).tool_use_id;
        return keepToolResult(id);
      });
      lastMessage.content = [
        ...toolResults,
        ...combined.filter(
          (b) => (b as { type?: string }).type !== 'tool_result',
        ),
      ];
      continue;
    }
    merged.push(message);
  }

  return merged;
}
