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
import type Anthropic from '@anthropic-ai/sdk';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import {
  convertSchema,
  type SchemaComplianceMode,
} from '../../utils/schemaConverter.js';

type AnthropicMessageParam = Anthropic.MessageParam;
// `scope: 'global'` is sent under the `prompt-caching-scope-2026-01-05` beta
// to extend prompt caching across sessions (rather than the default
// per-session ephemeral scope). The Anthropic SDK types we depend on still
// model `cache_control` as `{ type: 'ephemeral' }` only, so we widen the
// shape here for the fields where we actually attach it (tool params and
// the system text block).
type AnthropicCacheControl = { type: 'ephemeral'; scope?: 'global' };
type AnthropicToolParam = Anthropic.Tool & {
  cache_control?: AnthropicCacheControl;
};
type AnthropicTextBlockParam = Anthropic.TextBlockParam & {
  cache_control?: AnthropicCacheControl;
};
type AnthropicContentBlockParam = Anthropic.ContentBlockParam;

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
}

export class AnthropicContentConverter {
  private model: string;
  private schemaCompliance: SchemaComplianceMode;
  private enableCacheControl: boolean;

  constructor(
    model: string,
    schemaCompliance: SchemaComplianceMode = 'auto',
    enableCacheControl: boolean = true,
  ) {
    this.model = model;
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
    const messages: AnthropicMessageParam[] = [];

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
    const system = enableCacheControl
      ? this.buildSystemWithCacheControl(systemText, useGlobalCacheScope)
      : systemText;
    if (enableCacheControl) {
      this.addCacheControlToMessages(messages);
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
      tools[lastToolIndex] = {
        ...tools[lastToolIndex],
        cache_control: useGlobalCacheScope
          ? { type: 'ephemeral', scope: 'global' }
          : { type: 'ephemeral' },
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
    geminiResponse.modelVersion = response.model || this.model;
    geminiResponse.promptFeedback = { safetyRatings: [] };

    if (response.usage) {
      const promptTokens = response.usage.input_tokens || 0;
      const completionTokens = response.usage.output_tokens || 0;
      geminiResponse.usageMetadata = {
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens,
        totalTokenCount: promptTokens + completionTokens,
      };
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
    let toolCallIndex = 0;

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
            id: part.functionCall.id || `tool_${toolCallIndex}`,
            name: part.functionCall.name || '',
            input: (part.functionCall.args as Record<string, unknown>) || {},
          });
          toolCallIndex += 1;
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
      tool_use_id: response.id || '',
      content,
    };
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
   * Build system content blocks with cache_control.
   * Anthropic prompt caching requires cache_control on system content.
   * When `useGlobalCacheScope` is set, attach `scope: 'global'` so the
   * system prefix participates in cross-session caching under the
   * `prompt-caching-scope-2026-01-05` beta. Otherwise emit the standard
   * per-session shape so non-Anthropic baseURLs aren't sent a scope
   * extension they may not recognize.
   */
  private buildSystemWithCacheControl(
    systemText: string,
    useGlobalCacheScope: boolean,
  ): AnthropicTextBlockParam[] | string {
    if (!systemText) {
      return systemText;
    }

    return [
      {
        type: 'text',
        text: systemText,
        cache_control: useGlobalCacheScope
          ? { type: 'ephemeral', scope: 'global' }
          : { type: 'ephemeral' },
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
   * Add cache_control to the last user message's content.
   * This enables prompt caching for the conversation context.
   *
   * Deliberately emits the per-session `{ type: 'ephemeral' }` shape only —
   * no `scope: 'global'`. The last user message changes every turn (it's
   * the live prompt and any tool_result blocks from the immediately prior
   * round), so cross-session reuse here has effectively zero hit rate and
   * paying the global-scope overhead would just churn cache. System text
   * and tool prefixes (which DO repeat across sessions) carry
   * `scope: 'global'` instead.
   */
  private addCacheControlToMessages(messages: Anthropic.MessageParam[]): void {
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
