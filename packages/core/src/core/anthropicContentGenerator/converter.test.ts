/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CallableTool,
  Content,
  ContentListUnion,
  ContentUnion,
  Part,
  Tool,
} from '@google/genai';
import { FinishReason } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';

// Mock schema conversion so we can force edge-cases (e.g. missing `type`).
vi.mock('../../utils/schemaConverter.js', () => ({
  convertSchema: vi.fn((schema: unknown) => schema),
}));

import { convertSchema } from '../../utils/schemaConverter.js';
import {
  AnthropicContentConverter,
  type ConvertLlmRequestToAnthropicOptions as Opts,
} from './converter.js';
import { getGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../../test-utils/model-fixtures.js';

// Gemini-side input builders.
/** A thought part; `thoughtSignature` only when `sig` is given ('' included). */
const thought = (text: string, sig?: string): Part => ({
  text,
  thought: true,
  ...(sig !== undefined ? { thoughtSignature: sig } : {}),
});
/** A no-arg functionCall part. */
const call = (id: string, name = 'tool') => fnCall(name, {}, id);
/** A functionResponse part carrying `{ output }`. */
const reply = (id: string, output = 'ok', name = 'tool') =>
  fnResponse(name, { output }, id);
/** A user turn holding one `reply`. */
const answer = (id: string, output?: string, name?: string) =>
  content('user', reply(id, output, name));
const inline = (mimeType: string, data: string): Part => ({
  inlineData: { mimeType, data },
});
/** A `Read` functionResponse carrying one media part. */
const readResponse = (id: string, output: string, media: Part): Part => ({
  functionResponse: { id, name: 'Read', response: { output }, parts: [media] },
});
/** One Tool holding the given function declarations. */
const toolsOf = (...functionDeclarations: object[]) =>
  [{ functionDeclarations }] as Tool[];
const weatherSchema = () => ({
  type: 'object',
  properties: { location: { type: 'string' } },
  required: ['location'],
});
const weather = (parametersJsonSchema?: object) => ({
  name: 'get_weather',
  description: 'Get weather',
  ...(parametersJsonSchema ? { parametersJsonSchema } : {}),
});

// Anthropic-side expected shapes.
const EPH = { type: 'ephemeral' };
const GLOBAL = { type: 'ephemeral', scope: 'global' };
const HOUR = { type: 'ephemeral', ttl: '1h' };
const txt = (text: string, cache_control?: object) => ({
  type: 'text',
  text,
  ...(cache_control ? { cache_control } : {}),
});
const think = (thinking: string, signature?: string) => ({
  type: 'thinking',
  thinking,
  ...(signature !== undefined ? { signature } : {}),
});
const toolUse = (id: string, name = 'tool', input: object = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolResult = (id: string, body: unknown, cache_control?: object) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: body,
  ...(cache_control ? { cache_control } : {}),
});
const b64 = (type: string, media_type: string, data: string) => ({
  type,
  source: { type: 'base64', media_type, data },
});
const byUrl = (type: string, url: string) => ({
  type,
  source: { type: 'url', url },
});
const user = (...blocks: object[]) => ({ role: 'user', content: blocks });
const assistant = (...blocks: object[]) => ({
  role: 'assistant',
  content: blocks,
});

type Block = {
  type: string;
  id?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  tool_use_id?: string;
  content?: unknown;
};
type Msg = { role: string; content: unknown };
const blocksOf = (m: Msg | undefined) => m?.content as Block[];
const types = (blocks: Block[]) => blocks.map((b) => b.type);
const assistants = <M extends Msg>(messages: M[]) =>
  messages.filter((m) => m.role === 'assistant');

describe('AnthropicContentConverter', () => {
  let converter: AnthropicContentConverter;

  beforeEach(() => {
    vi.clearAllMocks();
    converter = new AnthropicContentConverter('test-model', 'auto');
  });

  /** Convert `contents` for the test model; `sys` becomes the systemInstruction. */
  const convert = (
    contents: ContentListUnion,
    opts?: Opts,
    sys?: ContentUnion,
    c = converter,
  ) =>
    c.convertLlmRequestToAnthropic(
      {
        model: 'models/test',
        contents,
        ...(sys !== undefined ? { config: { systemInstruction: sys } } : {}),
      },
      opts,
    );
  /** The `system` of a 'hi' request carrying `sys`. */
  const systemOf = (sys: ContentUnion, opts?: Opts, c = converter) =>
    convert('hi', opts, sys, c).system;
  const noCacheConverter = () =>
    new AnthropicContentConverter('test-model', 'auto', false);

  describe('convertLlmRequestToAnthropic', () => {
    it('extracts systemInstruction text from string', () => {
      expect(systemOf('sys')).toEqual([txt('sys', EPH)]);
    });

    it('extracts systemInstruction text from parts and joins with newlines', () => {
      const sys = { role: 'system', parts: [{ text: 'a' }, { text: 'b' }] };
      expect(systemOf(sys as unknown as Content)).toEqual([txt('a\nb', EPH)]);
    });

    it('emits scope:"global" on the system text when useGlobalCacheScope is set', () => {
      // Anthropic-native + caching enabled → the generator passes
      // `useGlobalCacheScope: true` and the system prefix joins cross-session
      // caching under the `prompt-caching-scope-2026-01-05` beta. Other
      // backends pass false (or omit) and get the per-session shape above.
      expect(systemOf('sys', { useGlobalCacheScope: true })).toEqual([
        txt('sys', GLOBAL),
      ]);
    });

    describe('staticSystemPrefix split', () => {
      const staticPrefix = 'core prompt + memory';
      const volatileSuffix = '\n\n# Git Status\nbranch: main';
      const fullSystem = staticPrefix + volatileSuffix;
      const split = {
        useGlobalCacheScope: true,
        staticSystemPrefix: staticPrefix,
      };

      it('splits the system prompt at the static prefix boundary, scoping only the prefix', () => {
        expect(systemOf(fullSystem, split)).toEqual([
          txt(staticPrefix, GLOBAL),
          // The volatile tail (git status, session-start context) always
          // carries the per-session shape — it differs across sessions,
          // so a global entry here would churn cache for zero hits.
          txt(volatileSuffix, EPH),
        ]);
      });

      it('splits without scope when useGlobalCacheScope is off', () => {
        expect(
          systemOf(fullSystem, { staticSystemPrefix: staticPrefix }),
        ).toEqual([txt(staticPrefix, EPH), txt(volatileSuffix, EPH)]);
      });

      it('falls back to a single block when the prefix does not match (subagent prompt)', () => {
        expect(systemOf('a different subagent prompt', split)).toEqual([
          txt('a different subagent prompt', GLOBAL),
        ]);
      });

      it('falls back to a single block when there is no suffix beyond the prefix', () => {
        // Not a git repo → the system prompt IS the static prefix. A split
        // would leave an empty second block, which Anthropic rejects.
        expect(systemOf(staticPrefix, split)).toEqual([
          txt(staticPrefix, GLOBAL),
        ]);
      });
    });

    it('converts a plain string content into a user message', () => {
      expect(convert('Hello').messages).toEqual([user(txt('Hello', EPH))]);
    });

    it('converts user content parts into a user message with text blocks', () => {
      const { messages } = convert([
        content('user', { text: 'Hello' }, { text: 'World' }),
      ]);
      expect(messages).toEqual([user(txt('Hello'), txt('World', EPH))]);
    });

    it('preserves ordered multi-part startup reminder user content', () => {
      const [a, b] = [
        '<system-reminder>\ndeferred tools',
        '<system-reminder>\nstartup context',
      ];
      const { messages } = convert([content('user', { text: a }, { text: b })]);
      expect(messages).toEqual([user(txt(a), txt(b, EPH))]);
    });

    it('converts assistant thought parts into Anthropic thinking blocks', () => {
      const { messages } = convert([
        content('model', thought('internal', 'sig'), { text: 'visible' }),
      ]);
      expect(messages).toEqual([
        assistant(think('internal', 'sig'), txt('visible')),
      ]);
    });

    it('converts functionCall parts from model role into tool_use blocks', () => {
      const { messages } = convert([
        content(
          'model',
          { text: 'preface' },
          fnCall('tool_name', { a: 1 }, 'call-1'),
        ),
        answer('call-1', 'ok', 'tool_name'),
      ]);
      expect(messages[0]).toEqual(
        assistant(txt('preface'), toolUse('call-1', 'tool_name', { a: 1 })),
      );
    });

    it('normalizes legacy dotted MCP names before sending history', () => {
      const name = 'mcp__zybio__database.query_uniprot';
      const { messages } = convert([
        content('model', fnCall(name, { query: 'P12345' }, 'call-legacy-mcp')),
        answer('call-legacy-mcp', 'ok', name),
      ]);
      const first = messages[0];
      const block = Array.isArray(first?.content)
        ? first.content.find((b) => b.type === 'tool_use')
        : undefined;

      expect(block?.type).toBe('tool_use');
      if (block?.type === 'tool_use') {
        expect(block.name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
        expect(block.name).not.toContain('.');
      }
    });

    it.each([
      [
        'converts functionResponse parts into user tool_result messages',
        'tool_name',
        { output: 'ok' },
        toolResult('call-1', 'ok', EPH),
      ],
      [
        'extracts function response error field when present',
        'tool_name',
        { error: 'boom' },
        { ...toolResult('call-1', 'boom', EPH), is_error: true },
      ],
      // An empty response still yields a tool_result (empty string content):
      // Anthropic expects every tool use to have a corresponding result.
      [
        'creates tool result with empty content for empty function responses',
        'read_file',
        { output: '' },
        toolResult('call-1', '', EPH),
      ],
    ])('%s', (_title, name, response, expected) => {
      const { messages } = convert([
        content('model', fnCall(name, {}, 'call-1')),
        content('user', fnResponse(name, response, 'call-1')),
      ]);
      expect(messages[1]).toEqual(user(expected));
    });

    /** Convert a Read call answered with `output` plus one media part. */
    const readWithMedia = (output: string, media: Part) =>
      convert([
        content('model', fnCall('Read', {}, 'call-1')),
        content('user', readResponse('call-1', output, media)),
      ]).messages;
    const antUrl =
      'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg';
    const pdfUrl =
      'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf';

    it.each([
      [
        'converts function response with inlineData image parts into tool_result with images',
        'Image content',
        inline('image/png', 'base64encodeddata'),
        b64('image', 'image/png', 'base64encodeddata'),
      ],
      [
        'converts inlineData with PDF into document block',
        'PDF content',
        inline('application/pdf', 'pdfbase64data'),
        b64('document', 'application/pdf', 'pdfbase64data'),
      ],
      [
        'converts fileData with image into image url block',
        'Image content',
        { fileData: { mimeType: 'image/jpeg', fileUri: antUrl } },
        byUrl('image', antUrl),
      ],
      [
        'converts fileData with PDF into document url block',
        'PDF content',
        { fileData: { mimeType: 'application/pdf', fileUri: pdfUrl } },
        byUrl('document', pdfUrl),
      ],
    ])('%s', (_title, output, media, block) => {
      expect(readWithMedia(output, media)[1]).toEqual(
        user(toolResult('call-1', [txt(output), block], EPH)),
      );
    });

    type TextResult = {
      type: string;
      content: Array<{ type: string; text?: string }>;
    };

    it.each(['audio/mpeg', 'image/bmp'])(
      'renders unsupported %s inlineData as a text block',
      (mimeType) => {
        const messages = readWithMedia(
          'Unsupported content',
          inline(mimeType, 'base64encodeddata'),
        );

        expect(messages).toHaveLength(2);
        expect(messages[1]?.role).toBe('user');

        const tr = messages[1]?.content?.[0] as TextResult;
        expect(tr.type).toBe('tool_result');
        expect(Array.isArray(tr.content)).toBe(true);
        expect(tr.content[0]).toEqual(txt('Unsupported content'));
        expect(tr.content[1]?.type).toBe('text');
        expect(tr.content[1]?.text).toContain('Unsupported inline media type');
        expect(tr.content[1]?.text).toContain(mimeType);
      },
    );

    it('renders unsupported fileData as a text block', () => {
      const messages = readWithMedia('File content', {
        fileData: {
          mimeType: 'application/zip',
          fileUri: 'https://example.com/archive.zip',
          displayName: 'archive.zip',
        },
      });

      const tr = messages[1]?.content?.[0] as TextResult;
      expect(tr.type).toBe('tool_result');
      expect(tr.content[0]).toEqual(txt('File content'));
      expect(tr.content[1]?.type).toBe('text');
      expect(tr.content[1]?.text).toContain('Unsupported file media type');
      expect(tr.content[1]?.text).toContain('application/zip');
      expect(tr.content[1]?.text).toContain('archive.zip');
    });

    it('associates each image with its preceding functionResponse', () => {
      const { messages } = convert([
        content(
          'model',
          fnCall('Read', {}, 'call-1'),
          fnCall('Read', {}, 'call-2'),
        ),
        content(
          'user',
          // Tool 1 with image 1, tool 2 with image 2.
          readResponse('call-1', 'File 1', inline('image/png', 'image1data')),
          readResponse('call-2', 'File 2', inline('image/jpeg', 'image2data')),
        ),
      ]);

      // Multiple tool_result blocks are emitted in order
      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual(
        user(
          toolResult('call-1', [
            txt('File 1'),
            b64('image', 'image/png', 'image1data'),
          ]),
          toolResult(
            'call-2',
            [txt('File 2'), b64('image', 'image/jpeg', 'image2data')],
            EPH,
          ),
        ),
      );
    });

    it('merges consecutive assistant messages into one', () => {
      const { messages } = convert([
        userText('Hi'),
        modelText('Hello!'),
        content('model', call('t1')),
        answer('t1'),
      ]);

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(txt('Hello!'), toolUse('t1')),
        user(toolResult('t1', 'ok', EPH)),
      ]);
    });

    it('merges consecutive assistant messages by straight concatenation, preserving chronological order across the merge', () => {
      // Interleaved-thinking-2025-05-14 is always on whenever `thinking` is
      // set (see buildPerRequestHeaders), so hoisting every thinking block
      // ahead of both messages' other content is wrong: it would move "text
      // A" after "thought B", which it chronologically precedes. Straight
      // concatenation of each side's ordered blocks keeps true order.
      const { messages } = convert([
        userText('Hi'),
        content('model', thought('thought A', 'sigA'), { text: 'text A' }),
        content('model', thought('thought B', 'sigB'), call('t1')),
        answer('t1'),
      ]);

      expect(messages[1]?.role).toBe('assistant');
      const blocks = blocksOf(messages[1]);
      expect(blocks[0]?.type).toBe('thinking');
      expect(blocks[1]?.type).toBe('text');
      expect(blocks[2]?.type).toBe('thinking');
      expect(blocks[3]?.type).toBe('tool_use');
    });

    /** User 'Hi', a text-only turn, then a thinking + tool_use turn and its result. */
    const textThenThinkingTool = () => [
      userText('Hi'),
      modelText('no thinking here'),
      content('model', thought('thought B', 'sigB'), call('t1')),
      answer('t1'),
    ];

    it('adaptive/default mode preserves chronological order when the first merged message has no leading thinking block', () => {
      // Adaptive-thinking models don't require the final assistant turn to
      // begin with thinking, so straight chronological concatenation is
      // correct and sufficient: no reordering should occur.
      const blocks = blocksOf(convert(textThenThinkingTool()).messages[1]);
      expect(blocks[0]?.type).toBe('text');
      expect(blocks[1]?.type).toBe('thinking');
      expect(blocks[2]?.type).toBe('tool_use');
    });

    const ELT = { ensureLeadingAssistantThinking: true };
    /** Blocks of messages[1] under ensureLeadingAssistantThinking. */
    const leading = (...contents: Content[]) =>
      blocksOf(convert(contents, ELT).messages[1]);
    /** Blocks of the first assistant message under ensureLeadingAssistantThinking. */
    const firstAssistant = (...contents: Content[]) =>
      blocksOf(assistants(convert(contents, ELT).messages)[0]);

    it('ensureLeadingAssistantThinking relocates the first thinking run to the front of the latest assistant message', () => {
      // Anthropic's manual-mode extended thinking requires the FINAL
      // assistant turn of a thinking-enabled request to begin with a
      // thinking block. This is the minimal reorder that satisfies it
      // without reintroducing the hoist-every-thinking-block behavior this
      // generator moved away from.
      const blocks = leading(...textThenThinkingTool());
      expect(blocks[0]?.type).toBe('thinking');
      expect(blocks[1]?.type).toBe('text');
      expect(blocks[2]?.type).toBe('tool_use');
      // The relocated block itself is untouched -- same text/signature.
      expect(blocks[0]?.thinking).toBe('thought B');
      expect(blocks[0]?.signature).toBe('sigB');
    });

    it('ensureLeadingAssistantThinking moves only the first thinking run when the assistant turn has multiple thinking/tool_use pairs', () => {
      // Guards "only the first thinking run moves": a mutation that hoists
      // every thinking block (`blocks.filter(isThinking)`, the exact
      // corruption this option was added to avoid) gives the same result as
      // the single-run test above and would pass without this multi-run case.
      const blocks = leading(
        userText('Hi'),
        modelText('text A'),
        content('model', thought('thinking 1', 'sig1'), call('t1')),
        content('model', thought('thinking 2', 'sig2'), call('t2')),
      );
      expect(types(blocks)).toEqual([
        'thinking',
        'text',
        'tool_use',
        'thinking',
        'tool_use',
      ]);
      expect(blocks[0]?.thinking).toBe('thinking 1');
      expect(blocks[1]?.text).toBe('text A');
      expect(blocks[2]?.id).toBe('t1');
      // The second thinking run stays exactly where it was chronologically.
      expect(blocks[3]?.thinking).toBe('thinking 2');
      expect(blocks[4]?.id).toBe('t2');
    });

    it('ensureLeadingAssistantThinking normalizes EVERY tool_use-bearing assistant message, not only the last', () => {
      // Every other case collapses all model turns into one assistant
      // message, so "which messages get normalized" is untested there: a
      // mutation that stops at the first (or last) assistant message would
      // pass them all while leaving a sibling turn text-leading. That is the
      // #3786 rejection reported against a PRIOR assistant turn, and it makes
      // a turn's serialization depend on its position in history, breaking
      // the prompt-cache prefix every request (see the position-independence
      // test below).
      const { messages } = convert(
        [
          userText('Hi'),
          modelText('text A'),
          content('model', thought('thinking 1', 'sig1'), call('t1')),
          answer('t1'),
          modelText('text B'),
          content('model', thought('thinking 2', 'sig2'), call('t2')),
        ],
        ELT,
      );

      const assistantMessages = assistants(messages);
      expect(assistantMessages).toHaveLength(2);
      expect(types(blocksOf(assistantMessages[0]))).toEqual([
        'thinking',
        'text',
        'tool_use',
      ]);
      expect(types(blocksOf(assistantMessages[1]))).toEqual([
        'thinking',
        'text',
        'tool_use',
      ]);
    });

    it('ensureLeadingAssistantThinking relocates a first thinking run that starts AFTER a tool_use block', () => {
      // Every other fixture puts the first thinking run ahead of the first
      // tool_use, so a run starting after one is pinned in neither direction.
      // The shape is reachable from this pass's documented source: a
      // truncated turn ending in a functionCall whose recovery continuation
      // opens with thought + functionCall. The scan is a bare
      // findIndex(isThinking) with no tool_use-position condition, so it
      // relocates; pinning that stops a future "skip when runStart is after
      // the first tool_use" refinement from silently shipping the
      // text-leading tool_use shape #3786 rejects.
      const blocks = firstAssistant(
        userText('Hi'),
        content('model', { text: 'text A' }, call('t1')),
        content('model', thought('thinking E2', 's2'), call('t2')),
        content('user', reply('t1'), reply('t2')),
      );
      expect(types(blocks)).toEqual([
        'thinking',
        'text',
        'tool_use',
        'tool_use',
      ]);
    });

    it('ensureLeadingAssistantThinking leaves an assistant message with no tool_use in chronological order', () => {
      // The wire only enforces leading thinking on tool_use turns (this
      // option's documented scope, and the boundary
      // injectEmptyThinkingOnToolUseTurns was live-verified against).
      // Dropping the tool_use gate would reorder plain-text replay turns for
      // no protocol reason, moving blocks the previous latest-only
      // implementation also never touched once a later turn existed.
      const blocks = firstAssistant(
        userText('Hi'),
        content(
          'model',
          { text: 'plain answer' },
          thought('thought A', 'sigA'),
        ),
        userText('and again'),
        content('model', thought('thought B', 'sigB'), call('t1')),
        answer('t1'),
      );
      expect(types(blocks)).toEqual(['text', 'thinking']);
    });

    it('ensureLeadingAssistantThinking serializes a turn identically whether or not a later turn follows it (prompt-cache prefix stability)', () => {
      // Normalizing only the latest assistant message made a turn's wire
      // shape depend on its position: [thinking, text, tool_use] on the
      // request where it was current, [text, thinking, tool_use] on every
      // request after. cache_control's breakpoint sits on the last user
      // message, so that rewrites the cached prefix and forces a full
      // re-read every turn. Pin byte-identical output in both positions.
      const firstTurn = [
        userText('Hi'),
        content(
          'model',
          { text: 'text A' },
          thought('thinking 1', 'sig1'),
          call('t1'),
        ),
        answer('t1'),
      ];

      const whenLatest = firstAssistant(...firstTurn);
      const whenPrior = firstAssistant(
        ...firstTurn,
        content('model', thought('thinking 2', 'sig2'), call('t2')),
        answer('t2'),
      );

      expect(whenPrior).toEqual(whenLatest);
    });

    it('ensureLeadingAssistantThinking relocates a multi-block first thinking run as a single unit', () => {
      // Every other case has a one-block first thinking run, so the
      // run-extension loop's contract ("only the first thinking run moves,
      // as a unit") is untested there: a mutation that stops extending after
      // one block (e.g. `runEnd = runStart + 1`) would pass them all while
      // splitting a multi-block first run apart.
      const blocks = leading(
        userText('Hi'),
        modelText('text A'),
        content('model', thought('thinking X', 'sigX')),
        content('model', thought('thinking Y', 'sigY'), call('t1')),
      );
      expect(types(blocks)).toEqual([
        'thinking',
        'thinking',
        'text',
        'tool_use',
      ]);
      // The run moves as a unit, preserving its own internal order.
      expect(blocks[0]?.thinking).toBe('thinking X');
      expect(blocks[1]?.thinking).toBe('thinking Y');
      expect(blocks[2]?.text).toBe('text A');
    });

    it('ensureLeadingAssistantThinking leaves a tool_use turn with no thinking block untouched', () => {
      // Every other case has at least one thinking block, so the
      // `runStart === -1` guard (nothing fabricated when the message has no
      // thinking block) is otherwise unpinned. Reachable in production:
      // dropUnsignedThinkingFromAssistantMessages strips every unsigned
      // thinking block from a completed mid-history tool_use turn, and a
      // model may return a tool round with no thinking. Deleting the guard
      // runs the run-extension loop from -1 and reads blocks[-1].type ->
      // TypeError.
      const blocks = leading(
        userText('Hi'),
        content('model', { text: 'no thinking here' }, call('t1')),
        answer('t1'),
      );
      // Nothing fabricated, nothing reordered: chronological order stands.
      expect(types(blocks)).toEqual(['text', 'tool_use']);
    });

    it('ensureLeadingAssistantThinking relocates a first thinking run that ends at the final block', () => {
      // Every other case ends the first thinking run before the end of the
      // content array, so the run-extension loop's `runEnd < blocks.length`
      // bound is otherwise unpinned. This PR manufactures the trailing-run
      // shape: a single STOP stream [text, functionCall, signed episode] now
      // persists in stream order, and the recovery-coalescing keep path
      // merges into [text..., functionCall, signed episode]. Deleting the
      // bound extends runEnd past the array and reads
      // blocks[blocks.length].type -> TypeError.
      const blocks = firstAssistant(
        userText('Hi'),
        content('model', { text: 'text A' }, call('t1')),
        content('model', thought('episode', 'sE')),
        answer('t1'),
      );
      // The trailing thinking run is relocated to the front as a unit.
      expect(types(blocks)).toEqual(['thinking', 'text', 'tool_use']);
    });

    it('cleans orphaned tool_use blocks without matching tool_result', () => {
      // A genuine orphan needs a subsequent message that was scanned and
      // found lacking a matching tool_result -- not merely no subsequent
      // message at all (see the "trailing tool_use" test below).
      const { messages } = convert([
        userText('Hi'),
        content('model', { text: 'Let me help' }, call('orphan')),
        userText('never mind'),
      ]);

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(txt('Let me help')),
        user(txt('never mind', EPH)),
      ]);
    });

    it('does not strip a trailing tool_use that has no subsequent message yet (unresolved, not orphaned)', () => {
      // History ending on a pending tool_use is no evidence of an orphan: the
      // tool may still be running, or this conversion may not be sending the
      // completed turn (token counting, a resumed/replayed session snapshot,
      // ...). Regression test for this shape having its tool_use silently
      // deleted.
      const { messages } = convert([
        userText('What is the weather in Paris?'),
        content(
          'model',
          { text: 'Let me check the weather.' },
          fnCall('get_weather', { city: 'Paris' }, 'toolu_pending'),
        ),
      ]);

      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toEqual([
        txt('Let me check the weather.'),
        toolUse('toolu_pending', 'get_weather', { city: 'Paris' }),
      ]);
    });

    it('cascade-strips a signed thinking block when its sibling tool_use is orphaned in the same pass', () => {
      // A thinking signature covers the turn's full sibling content. Once a
      // sibling tool_use is stripped as an orphan the signature no longer
      // matches and replay 400s ("thinking blocks in the latest assistant
      // message cannot be modified"), so the thinking block must go too.
      const { messages } = convert([
        userText('Hi'),
        content(
          'model',
          thought('reasoning', 'sig'),
          { text: 'Let me help' },
          call('orphan'),
        ),
        userText('never mind'),
      ]);

      const assistantMsg = messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toEqual([txt('Let me help')]);
    });

    it('does not cascade-strip thinking when a sibling tool_use survives alongside an orphaned one', () => {
      // Partial orphan: turn = [thinking, tool_use A, tool_use B] and only
      // A's result comes back, so B is stripped but A survives. The thinking
      // must stay: manual mode still needs "final turn begins with thinking
      // when a tool_use is present", and cascading would trade one 400 for
      // another.
      const { messages } = convert([
        userText('Hi'),
        content('model', thought('reasoning', 'sig'), call('a'), call('b')),
        answer('a'),
      ]);

      const assistantMsg = messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      const blocks = blocksOf(assistantMsg);
      expect(blocks[0]?.type).toBe('thinking');
      expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
      expect(blocks).toHaveLength(2);
    });

    it('drops the whole message and merges surrounding user turns when a cascade empties out the turn entirely', () => {
      // Bot-review coverage gap: the other cascade test keeps a `text` block,
      // so `finalBlocks` is never empty and cleanOrphanedToolCalls' `else`
      // drop branch never runs. Here the turn is only a signed thinking part
      // and an orphaned tool_use; the cascade strips both, so the whole
      // assistant message must be dropped and the surrounding user messages
      // merged.
      const { messages } = convert([
        userText('before'),
        content('model', thought('reasoning', 'sig'), call('orphan')),
        userText('after'),
      ]);

      expect(messages.some((m) => m.role === 'assistant')).toBe(false);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.content).toEqual([txt('before'), txt('after', EPH)]);
    });

    it('cleans orphaned tool_result blocks without matching tool_use', () => {
      const { messages } = convert([
        userText('Hi'),
        modelText('Hello'),
        content('user', { text: 'extra' }, reply('orphan')),
      ]);

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(txt('Hello')),
        user(txt('extra', EPH)),
      ]);
    });

    it('drops a duplicate tool_result sharing a tool_use_id within one message', () => {
      // Anthropic rejects two tool_result blocks for one tool_use_id ("each
      // `tool_use` block must have a single result" -- HTTP 400), which
      // happens when a tool call's result is recorded twice in history.
      const { messages } = convert([
        userText('Hi'),
        content('model', call('dup')),
        content('user', reply('dup', 'first'), reply('dup', 'second')),
      ]);

      expect(messages).toHaveLength(3);
      const toolResults = blocksOf(messages[2]!).filter(
        (b) => b.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toMatchObject({
        tool_use_id: 'dup',
        content: 'first',
      });
    });

    it('drops a duplicate tool_result for one id while keeping a different id in the same message', () => {
      const { messages } = convert([
        userText('Hi'),
        content('model', call('dup'), call('other')),
        content(
          'user',
          reply('dup', 'first'),
          reply('dup', 'second'),
          reply('other', 'other-result'),
        ),
      ]);

      const toolResults = blocksOf(messages[2]).filter(
        (b) => b.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(2);
      expect(toolResults.map((b) => [b.tool_use_id, b.content])).toEqual([
        ['dup', 'first'],
        ['other', 'other-result'],
      ]);
    });

    describe('tool_use id sanitization', () => {
      // Anthropic validates tool_use.id / tool_result.tool_use_id against
      // ^[a-zA-Z0-9_-]+$ server-side (HTTP 400 otherwise); Gemini's
      // functionCall.id / functionResponse.id has no such constraint.
      // Verified live: an id with characters outside that set, or an empty
      // tool_use_id, both 400 with "String should match pattern
      // '^[a-zA-Z0-9_-]+$'".
      const findBlock = (m: Msg | undefined, type: string) =>
        blocksOf(m).find((b) => b.type === type);

      it('sanitizes a tool_use id containing characters outside [a-zA-Z0-9_-]', () => {
        const rawId = 'call:abc.def/ghi?jkl';
        const { messages } = convert([
          userText('Hi'),
          content('model', fnCall('tool', { a: 1 }, rawId)),
          answer(rawId),
        ]);

        const use = findBlock(messages[1], 'tool_use');
        const result = findBlock(messages[2], 'tool_result');
        expect(use?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(use?.id).not.toBe(rawId);
        // The sanitized id links the pair back up.
        expect(result?.tool_use_id).toBe(use?.id);
      });

      it('generates a non-empty fallback id when functionCall.id is missing (not an empty string)', () => {
        const { messages } = convert([
          userText('Hi'),
          content('model', fnCall('tool', {})),
        ]);

        const use = findBlock(messages[1], 'tool_use');
        expect(use?.id).toBeTruthy();
        expect(use?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      });

      // No standalone "functionResponse.id missing" test: a tool_result with
      // no id can't be linked to any tool_use, so it is always a genuine
      // orphan that cleanOrphanedToolCalls removes regardless of this fix.
      // tool_result.tool_use_id uses the same
      // resolveToolUseId/nextGeneratedToolId path as the tool_use tests above,
      // so the never-empty-string guarantee is already covered.

      it('does not collide fallback ids generated for two different missing-id tool calls in the same request', () => {
        const { messages } = convert([
          userText('Hi'),
          content('model', fnCall('tool_a', {}), fnCall('tool_b', {})),
        ]);

        const ids = blocksOf(messages[1])
          .filter((b) => b.type === 'tool_use')
          .map((b) => b.id);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
      });

      it('resolves the same source id to the same sanitized id across tool_use and tool_result in different messages', () => {
        const rawId = 'weird/id:1';
        const { messages } = convert([
          userText('Hi'),
          content('model', call(rawId)),
          answer(rawId),
        ]);

        const toolUseId = findBlock(messages[1], 'tool_use')?.id;
        const toolResultId = findBlock(messages[2], 'tool_result')?.tool_use_id;
        expect(toolUseId).toBeDefined();
        expect(toolUseId).toBe(toolResultId);
      });
    });

    it('keeps tool results split across consecutive user messages', () => {
      const { messages } = convert([
        userText('Hi'),
        content('model', call('x'), call('y')),
        answer('x', 'first'),
        answer('y', 'second'),
      ]);

      expect(
        blocksOf(messages[1]).filter((block) => block.type === 'tool_use'),
      ).toHaveLength(2);
      expect(messages[2]).toEqual(
        user(toolResult('x', 'first'), toolResult('y', 'second', EPH)),
      );
    });

    it('drops a duplicate tool_result for the same id across two consecutive user messages', () => {
      // cleanOrphanedToolCalls dedupes tool_result blocks only within one
      // message; mergeConsecutiveUserMessages runs afterward and can combine
      // two separate user messages that each carried an (individually valid)
      // tool_result for the same tool_use_id. Without a second dedup at the
      // merge site, the merged message resurfaces the "two tool_result
      // blocks for one tool_use_id" shape Anthropic rejects.
      const { messages } = convert([
        userText('Hi'),
        content('model', call('dup')),
        answer('dup', 'first'),
        content('user', reply('dup', 'second'), { text: 'a follow-up note' }),
      ]);

      // Full merged content, not just the filtered tool_result blocks --
      // confirms the non-tool_result sibling from the second message
      // survives the merge and still sorts after the (deduped) results.
      expect(messages).toHaveLength(3);
      expect(messages[2]).toEqual(
        user(toolResult('dup', 'first'), txt('a follow-up note', EPH)),
      );
    });

    it('drops duplicate tool_result blocks across three consecutive user messages', () => {
      // Pins that the merge-site dedup accumulates across the whole
      // `combined` array on every iteration, not just pairwise between the
      // two most recently merged messages: of three separate user turns each
      // answering the same tool_use_id, only the first survives.
      const { messages } = convert([
        userText('Hi'),
        content('model', call('dup3')),
        answer('dup3', 'first'),
        answer('dup3', 'second'),
        answer('dup3', 'third'),
      ]);

      expect(messages).toHaveLength(3);
      expect(messages[2]).toEqual(user(toolResult('dup3', 'first', EPH)));
    });

    it('merges users when dropping an orphan-only assistant turn', () => {
      const { messages } = convert([
        userText('before'),
        content('model', call('orphan')),
        userText('after'),
      ]);

      expect(messages).toEqual([user(txt('before'), txt('after', EPH))]);
    });

    it('keeps tool results before text when merging consecutive users', () => {
      const { messages } = convert([
        userText('Hi'),
        content('model', call('t1')),
        userText('preface'),
        answer('t1'),
      ]);

      expect(messages[2]).toEqual(
        user(toolResult('t1', 'ok'), txt('preface', EPH)),
      );
    });

    it('reorders a tool_result ahead of other content in the same message rather than dropping it', () => {
      // Anthropic requires tool_result first in a user message replying to a
      // tool_use. A text part before the functionResponse in the same Gemini
      // Content used to trip cleanOrphanedToolCalls' own "seenNonToolResult"
      // gate as if the tool_result never showed up, silently discarding both
      // it AND its paired tool_use instead of fixing the order. Blocks are
      // now reordered before that gate runs, so the pair survives.
      const { messages } = convert([
        userText('Hi'),
        content('model', call('t1')),
        content('user', { text: 'preface' }, reply('t1', 'late')),
      ]);

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(toolUse('t1')),
        user(toolResult('t1', 'late'), txt('preface', EPH)),
      ]);
    });

    it('preserves relative order among multiple tool_result blocks when reordering ahead of text', () => {
      const { messages } = convert([
        userText('Hi'),
        content('model', call('t1'), call('t2')),
        content(
          'user',
          { text: 'preface' },
          reply('t1', 'first'),
          reply('t2', 'second'),
        ),
      ]);

      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.content).toEqual([
        toolResult('t1', 'first'),
        toolResult('t2', 'second'),
        txt('preface', EPH),
      ]);
    });

    it('deduplicates tool_use blocks by id during merge', () => {
      const { messages } = convert([
        userText('Hi'),
        content('model', call('dup')),
        content('model', call('dup')),
        answer('dup'),
      ]);

      const toolUseBlocks = blocksOf(messages[1]).filter(
        (b) => b.type === 'tool_use',
      );
      expect(toolUseBlocks).toHaveLength(1);
    });
  });

  describe('unsigned proxy thinking history', () => {
    const dropUnsigned = { dropUnsignedAssistantThinking: true };
    const dropUnsignedNoCache = { ...dropUnsigned, enableCacheControl: false };
    const expectProxyThrow = (...contents: Content[]) =>
      expect(() => convert(contents, dropUnsigned)).toThrow(
        'proxy omitted the thinking signature',
      );

    it('drops unsigned thinking while preserving visible content and signed blocks', () => {
      const { messages } = convert(
        [
          userText('First'),
          content(
            'model',
            thought('unsigned'),
            thought('empty signature', ''),
            thought('signed', 'real-signature'),
            { text: 'Visible answer' },
          ),
          userText('Second'),
        ],
        dropUnsignedNoCache,
      );

      expect(messages[1]).toEqual(
        assistant(think('signed', 'real-signature'), txt('Visible answer')),
      );
    });

    it('drops a thinking-only turn and merges the surrounding user turns', () => {
      const { messages } = convert(
        [
          userText('First'),
          content('model', thought('unsigned')),
          userText('Second'),
        ],
        dropUnsignedNoCache,
      );

      expect(messages).toEqual([user(txt('First'), txt('Second'))]);
    });

    it('fails locally when an unsigned thinking block belongs to a tool-use turn', () => {
      expectProxyThrow(
        userText('Run tool'),
        content('model', thought('unsigned'), call('t1')),
        answer('t1'),
      );
    });

    it('fails locally, rather than silently dropping the block, when an EMPTY-text unsigned thinking block belongs to a non-latest step of an active tool-use loop', () => {
      // Pipeline-ordering guard: dropEmptyTextThinkingBlocks must run AFTER
      // this check. An empty-text thinking block with no signature is
      // unsigned by this active-loop check's definition; if the empty-text
      // guard ran first it would delete the block unseen, swallowing exactly
      // the proxy bug this throw surfaces (the same pass-ordering hazard
      // found against the removed PATCH-B heuristic).
      //
      // Needs a two-step loop: a single assistant turn is always "the
      // latest", which dropEmptyTextThinkingBlocks exempts regardless of
      // ordering, so a one-step fixture can't tell the orderings apart.
      // Step 1's empty-text thinking must be on a NON-latest turn still in
      // the unbroken tool_use/tool_result chain reaching the end of history.
      expectProxyThrow(
        userText('Run tool'),
        content('model', thought(''), call('t1')),
        answer('t1'),
        content('model', thought('signed reasoning', 'sig'), call('t2')),
        answer('t2'),
      );
    });

    it('drops unsigned thinking from a completed tool-use turn', () => {
      const { messages } = convert(
        [
          userText('Run tool'),
          content('model', thought('unsigned'), call('t1')),
          answer('t1'),
          modelText('Finished'),
          userText('Next'),
        ],
        dropUnsigned,
      );

      expect(messages[1]).toEqual(assistant(toolUse('t1')));
    });

    it('fails when an earlier step in the active tool loop has unsigned thinking', () => {
      expectProxyThrow(
        userText('Run tools'),
        content('model', thought('unsigned'), call('t1', 'first')),
        answer('t1', 'one', 'first'),
        content(
          'model',
          thought('signed', 'real-signature'),
          call('t2', 'second'),
        ),
        answer('t2', 'two', 'second'),
      );
    });
  });

  describe('dropEmptyTextThinkingBlocks', () => {
    it('leaves a signed, non-empty thinking block on a non-latest turn untouched', () => {
      // A broader cross-turn heuristic (detect "this turn's tool_use went
      // stale in an earlier trim" and downgrade its thinking to text) was
      // removed after review: it couldn't tell that state from "this turn
      // was always thinking-only", and live verification showed it rewriting
      // turns that were never invalid. Only an empty-text thinking block is
      // unconditionally invalid regardless of tool_use presence; a
      // populated, signed thinking block is left exactly as-is.
      const { messages } = convert([
        userText('Hi'),
        content('model', thought('stale reasoning', 'sig')),
        userText('anything else?'),
        modelText('Sure, here you go.'),
      ]);

      const olderAssistant = messages[1];
      expect(olderAssistant.role).toBe('assistant');
      expect(olderAssistant.content).toEqual([think('stale reasoning', 'sig')]);
    });

    it('drops an empty redacted_thinking-derived turn entirely (defensive, no plaintext fallback)', () => {
      // convertAnthropicResponseToLlm represents redacted_thinking as
      // `{ text: '', thought: true }` (its opaque `data` doesn't survive the
      // Gemini-Part round trip -- see that method's doc). Round-tripped back
      // through processContent it becomes an empty-text `thinking` block,
      // which this defensive guard drops, taking the whole message with it
      // since nothing else survives.
      const { messages } = convert([
        userText('Hi'),
        content('model', thought('')),
        userText('anything else?'),
        modelText('Sure, here you go.'),
      ]);

      const assistantMessages = assistants(messages);
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toEqual([txt('Sure, here you go.')]);
    });

    it('leaves the latest assistant turn untouched even with empty-text thinking', () => {
      // The latestAssistantIdx short-circuit fires before the empty-text
      // filter runs, so this must hold regardless of content. The block is
      // actually empty-text (matching the title) so this fails if the
      // exemption is ever narrowed to "non-empty-text latest turns only".
      const { messages } = convert([
        userText('Hi'),
        content('model', thought('', 'sig')),
      ]);

      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toEqual([think('', 'sig')]);
    });
  });

  // https://github.com/QwenLM/qwen-code/issues/3786 — DeepSeek's
  // anthropic-compatible API rejects requests in thinking mode when a prior
  // assistant turn carrying `tool_use` omits a thinking block. Plain-text
  // assistant turns without thinking are accepted unchanged, so the converter
  // injects an empty thinking block only on tool-use turns when the caller
  // opts in.
  describe('DeepSeek thinking-mode normalization, injection, and stripping', () => {
    // The two options paired together replicate the DeepSeek "thinking on"
    // behavior wired in AnthropicContentGenerator.buildRequest.
    const enableThinking = {
      normalizeAssistantThinkingSignature: true,
      injectThinkingOnToolUseTurns: true,
    };
    const strip = { stripAssistantThinking: true };
    /** messages[1] (the assistant turn) of `contents` converted under `opts`. */
    const secondOf = (opts: Opts | undefined, ...contents: Content[]) =>
      convert(contents, opts).messages[1];

    it('does not inject on plain-text assistant turns (DeepSeek tolerates them)', () => {
      // Verified against api.deepseek.com/anthropic: plain-text assistant
      // turns without thinking are accepted. Avoid bloating replay history
      // with synthetic blocks the API does not require.
      expect(
        secondOf(enableThinking, userText('Hi'), modelText('Hello!')),
      ).toEqual(assistant(txt('Hello!')));
    });

    it('injects an empty thinking block on tool-calling assistant turns missing one', () => {
      expect(
        secondOf(
          enableThinking,
          userText('List files'),
          content('model', fnCall('glob', { pattern: '**/*.md' }, 'call-1')),
          answer('call-1', 'ok', 'glob'),
        ),
      ).toEqual(
        assistant(
          think('', ''),
          toolUse('call-1', 'glob', { pattern: '**/*.md' }),
        ),
      );
    });

    it('preserves existing thinking blocks on tool-use assistant turns', () => {
      expect(
        secondOf(
          enableThinking,
          userText('Run tool'),
          content('model', thought('Let me think', 'sig'), call('t1')),
          answer('t1'),
        ),
      ).toEqual(assistant(think('Let me think', 'sig'), toolUse('t1')));
    });

    it('does not modify user messages', () => {
      const { messages } = convert([userText('Hi')], enableThinking);
      expect(messages).toEqual([user(txt('Hi', EPH))]);
    });

    it('does nothing when option is disabled (default)', () => {
      expect(secondOf(undefined, userText('Hi'), modelText('Hello!'))).toEqual(
        assistant(txt('Hello!')),
      );
    });

    it('injects thinking blocks on every tool-using assistant turn in a multi-turn history', () => {
      const { messages } = convert(
        [
          userText('Q1'),
          content('model', call('t1')),
          answer('t1'),
          content('model', call('t2')),
          answer('t2'),
        ],
        enableThinking,
      );

      expect(messages[1]).toMatchObject({ role: 'assistant' });
      expect(messages[3]).toMatchObject({ role: 'assistant' });
      expect(blocksOf(messages[1])[0]).toEqual(think('', ''));
      expect(blocksOf(messages[3])[0]).toEqual(think('', ''));
    });

    it('preserves thinking-only assistant turns rather than emit empty content (Anthropic rejects content: [])', () => {
      // A thinking/redacted_thinking-only turn occurs when a previous round
      // hit max_tokens before any text or tool_use. Stripping it would leave
      // `content: []`, which the Anthropic API rejects, and dropping the
      // message would break user/assistant alternation, so the original
      // blocks stay — DeepSeek empirically tolerates the residual mismatch.
      expect(
        secondOf(
          strip,
          userText('Hi'),
          content('model', thought('pondering', 'sig')),
          userText('Continue'),
        ),
      ).toEqual(assistant(think('pondering', 'sig')));
    });

    it('strips thinking blocks from assistant turns when stripAssistantThinking is set', () => {
      // suggestionGenerator / forkedAgent path: history has real thought
      // parts but the side-query disables thinking, so the converter must
      // drop those blocks to match the absent top-level `thinking` config.
      // Both assistant turns lose their thinking blocks, and the two
      // consecutive model turns merge into one assistant message.
      expect(
        secondOf(
          strip,
          userText('Hi'),
          content('model', thought('reasoning', 'sig'), { text: 'Hello!' }),
          content('model', thought('more reasoning'), call('t1')),
          answer('t1'),
        ),
      ).toEqual(assistant(txt('Hello!'), toolUse('t1')));
    });

    it('strips thinking after consecutive assistant turns are merged', () => {
      expect(
        secondOf(
          strip,
          userText('Hi'),
          content('model', thought('preserved before merge', 'sig')),
          content('model', call('t1')),
          answer('t1'),
        ),
      ).toEqual(assistant(toolUse('t1')));
    });

    it('strips redacted_thinking blocks too when stripAssistantThinking is set', () => {
      // The strip path must cover both `thinking` and `redacted_thinking`.
      // processContent doesn't synthesize redacted_thinking from Gemini parts,
      // so reach into the private helper directly with a constructed message.
      const messages = [
        assistant(
          { type: 'redacted_thinking', data: 'opaque' },
          txt('Hello!'),
          think('reasoning', 'sig'),
        ),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (converter as any).stripThinkingFromAssistantMessages(messages);

      expect(messages[0].content).toEqual([txt('Hello!')]);
    });

    it('treats a redacted_thinking block as already-satisfying (no synthetic injection)', () => {
      // redacted_thinking has no `signature` field by spec — its `data` is
      // the opaque token — unlike a non-compliant `thinking` block missing
      // its required signature, so the injector must leave redacted turns
      // alone. processContent doesn't synthesize redacted_thinking from
      // Gemini parts, so reach into the private helper directly.
      const redacted = { type: 'redacted_thinking', data: 'opaque' };
      const messages = [assistant(redacted, toolUse('t1'))];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (converter as any).injectEmptyThinkingOnToolUseTurns(messages);

      expect(messages[0].content).toEqual([
        { type: 'redacted_thinking', data: 'opaque' },
        toolUse('t1'),
      ]);
    });

    it('normalizes a non-compliant thinking block (no signature field) on a tool-use turn', () => {
      // A part `{ text: '', thought: true }` (e.g. a `redacted_thinking`
      // response that lost its `data` through the Gemini Part round trip)
      // converts to a thinking block with no `signature` field. The cleanup
      // adds an empty signature in place; the normalized block then
      // satisfies the requirement, so Step 2 prepends no synthetic.
      expect(
        secondOf(
          enableThinking,
          userText('Run tool'),
          content('model', thought(''), call('t1')),
          answer('t1'),
        ),
      ).toEqual(assistant(think('', ''), toolUse('t1')));
    });

    it('preserves an existing compliant thinking block on a tool-use turn', () => {
      // A thinking block with a real `signature` field is fully compliant —
      // the injector must not duplicate it.
      expect(
        secondOf(
          enableThinking,
          userText('Run tool'),
          content('model', thought('real thinking', 'real-sig'), call('t1')),
          answer('t1'),
        ),
      ).toEqual(assistant(think('real thinking', 'real-sig'), toolUse('t1')));
    });

    it('normalizes non-compliant thinking blocks (adds empty signature) on plain-text turns', () => {
      // A part `{ thought: true, text: '...' }` (the normal shape from
      // OpenAI/Gemini/agent-runtime when users switch providers mid-session,
      // or a `redacted_thinking` round-tripped through Gemini-Part) converts
      // to `{ type: 'thinking', thinking: '...' }` without signature. The
      // cleanup adds an empty signature in place for spec compliance,
      // keeping the thinking text. No synthetic on a plain-text (no
      // tool_use) turn.
      expect(
        secondOf(
          enableThinking,
          userText('Hi'),
          content('model', thought('cross-provider thoughts'), {
            text: 'Hello!',
          }),
        ),
      ).toEqual(assistant(think('cross-provider thoughts', ''), txt('Hello!')));
    });

    it('injects on mixed text+tool_use assistant turns missing thinking', () => {
      // Common shape: model says something, then calls a tool. With no
      // thinking, this is still a tool-use turn that needs the synthetic.
      expect(
        secondOf(
          enableThinking,
          userText('Look this up'),
          content('model', { text: 'Let me check that' }, call('t1', 'lookup')),
          answer('t1', 'ok', 'lookup'),
        ),
      ).toEqual(
        assistant(
          think('', ''),
          txt('Let me check that'),
          toolUse('t1', 'lookup'),
        ),
      );
    });
  });

  describe('assistant-turn prefill stripping', () => {
    const prefill = {
      stripTrailingAssistantPrefill: true,
      enableCacheControl: false,
    };

    it('drops a trailing empty assistant message when stripTrailingAssistantPrefill is set', () => {
      // Whitespace-only, not empty: processContent emits a text block only
      // for truthy part.text, so an empty string never reaches this pass
      // (a vacuous fixture). isEmptyAssistantMessage's `.trim()` check is
      // what this test exercises.
      const { messages } = convert([userText('Hi'), modelText('   ')], prefill);

      expect(messages).toEqual([user(txt('Hi'))]);
    });

    it('appends a synthetic user turn when a trailing assistant message has real content', () => {
      const { messages } = convert(
        [userText('Hi'), modelText('Sure, here you go.')],
        prefill,
      );

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(txt('Sure, here you go.')),
        user(txt('Continue.')),
      ]);
    });

    it('leaves a trailing user message untouched when stripTrailingAssistantPrefill is set', () => {
      const { messages } = convert(
        [userText('Hi'), modelText('Hello!'), userText('How are you?')],
        prefill,
      );

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(txt('Hello!')),
        user(txt('How are you?')),
      ]);
    });

    it('does not strip a trailing assistant message when the option is unset', () => {
      const { messages } = convert(
        [userText('Hi'), modelText('Sure, here you go.')],
        { enableCacheControl: false },
      );

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(txt('Sure, here you go.')),
      ]);
    });

    it('keeps a trailing thinking-only assistant message and appends a synthetic user turn', () => {
      // A thinking block is real content (not text/whitespace-only), so it is
      // kept rather than dropped as an "empty prefill" — unlike an unanswered
      // tool_use, the earlier merge/clean passes never treat thinking blocks
      // as orphans.
      const { messages } = convert(
        [
          userText('Hi'),
          content('model', thought('pondering the answer', 'sig')),
        ],
        prefill,
      );

      expect(messages).toEqual([
        user(txt('Hi')),
        assistant(think('pondering the answer', 'sig')),
        user(txt('Continue.')),
      ]);
    });

    it('runs before dropEmptyTextThinkingBlocks so a promoted "new latest" turn keeps its empty-text signed thinking block', () => {
      // Pipeline-ordering regression: dropEmptyTextThinkingBlocks computes
      // "the latest assistant message" once and exempts only that index from
      // empty-text stripping. If stripTrailingAssistantPrefill popped an empty
      // trailing assistant turn (a leftover prefill artifact) AFTER that, the
      // turn it promotes to "new latest" -- carrying its own empty-text SIGNED
      // thinking block plus a tool_use -- would already have lost that block
      // under the stale "non-latest" premise, violating manual mode's
      // leading-thinking requirement. stripTrailingAssistantPrefill must run
      // first so dropEmptyTextThinkingBlocks sees the array's final shape.
      const { messages } = convert(
        [
          userText('Hi'),
          content('model', thought('', 'sig1'), call('t1')),
          answer('t1'),
          // Whitespace-only trailing turn -- a leftover prefill artifact
          // that stripTrailingAssistantPrefill should pop entirely.
          modelText('   '),
        ],
        prefill,
      );

      const assistantMessages = assistants(messages);
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]?.content).toEqual([
        think('', 'sig1'),
        toolUse('t1'),
      ]);
    });
  });

  describe('convertLlmToolsToAnthropic', () => {
    it('converts Tool.functionDeclarations to Anthropic tools and runs schema conversion', async () => {
      const result = await converter.convertLlmToolsToAnthropic(
        toolsOf(weather(weatherSchema())),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ...weather(),
        input_schema: weatherSchema(),
        cache_control: EPH,
      });

      expect(vi.mocked(convertSchema)).toHaveBeenCalledTimes(1);
    });

    it('emits scope:"global" on the last tool when useGlobalCacheScope is set', async () => {
      // Mirror of the system-block scope test: cross-session caching for
      // tools (the largest, slowest-changing prefix) only fires for
      // Anthropic-native baseURLs. The generator latches the predicate
      // once per request and forwards the same value here.
      const result = await converter.convertLlmToolsToAnthropic(
        toolsOf(weather()),
        { useGlobalCacheScope: true },
      );

      expect(result[0].cache_control).toEqual(GLOBAL);
    });

    it('resolves CallableTool.tool() and converts its functionDeclarations', async () => {
      const callable = [
        {
          tool: async () =>
            ({
              functionDeclarations: [
                {
                  name: 'dynamic_tool',
                  description: 'resolved tool',
                  parametersJsonSchema: { type: 'object', properties: {} },
                },
              ],
            }) as unknown as Tool,
        },
      ] as CallableTool[];

      const result = await converter.convertLlmToolsToAnthropic(callable);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('dynamic_tool');
    });

    it('defaults missing parameters to an empty object schema', async () => {
      const result = await converter.convertLlmToolsToAnthropic(
        toolsOf({ name: 'no_params', description: 'no params' }),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'no_params',
        description: 'no params',
        input_schema: { type: 'object', properties: {} },
        cache_control: EPH,
      });
    });

    it('forces input_schema.type to "object" when schema conversion yields no type', async () => {
      vi.mocked(convertSchema).mockImplementationOnce(() => ({
        properties: {},
      }));
      const result = await converter.convertLlmToolsToAnthropic(
        toolsOf({
          name: 'edge',
          description: 'edge',
          parametersJsonSchema: { type: 'object', properties: {} },
        }),
      );
      expect(result[0]?.input_schema?.type).toBe('object');
    });

    it('skips functions without name or description', async () => {
      const result = await converter.convertLlmToolsToAnthropic(
        toolsOf(
          { name: 'valid_tool', description: 'A valid tool' },
          { name: 'missing_description' },
          { description: 'Missing name' },
          // neither name nor description
          { parametersJsonSchema: { type: 'object' } },
        ),
      );

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid_tool');
    });

    it('skips functions with empty name or description', async () => {
      const result = await converter.convertLlmToolsToAnthropic(
        toolsOf(
          { name: 'valid_tool', description: 'A valid tool' },
          { name: '', description: 'Empty name' },
          { name: 'empty_description', description: '' },
        ),
      );

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid_tool');
    });
  });

  describe('convertAnthropicResponseToLlm', () => {
    const respond = (fields: object) =>
      converter.convertAnthropicResponseToLlm({
        id: 'msg-1',
        model: 'claude-test',
        stop_reason: 'end_turn',
        ...fields,
      } as unknown as Anthropic.Message);

    it('converts text, tool_use, thinking, and redacted_thinking blocks', () => {
      const response = respond({
        content: [
          { type: 'thinking', thinking: 'thought', signature: 'sig' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'tool', input: { x: 1 } },
          { type: 'redacted_thinking' },
        ],
        usage: { input_tokens: 3, output_tokens: 5 },
      });

      expect(response.responseId).toBe('msg-1');
      expect(response.modelVersion).toBe('claude-test');
      expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(response.usageMetadata).toEqual({
        promptTokenCount: 3,
        candidatesTokenCount: 5,
        totalTokenCount: 8,
        cachedContentTokenCount: 0,
      });
      expect(getGenAiUsageProvenance(response.usageMetadata)).toEqual({
        cachedInputTokensReported: false,
        cacheCreationInputTokens: undefined,
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      expect(parts).toEqual([
        thought('thought', 'sig'),
        { text: 'hello' },
        fnCall('tool', { x: 1 }, 't1'),
        thought(''),
      ]);
    });

    it('handles tool_use input that is a JSON string', () => {
      const response = respond({
        stop_reason: null,
        content: [
          { type: 'tool_use', id: 't1', name: 'tool', input: '{"x":1}' },
        ],
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      expect(parts).toEqual([fnCall('tool', { x: 1 }, 't1')]);
    });

    it('forwards cache_read_input_tokens and cache_creation_input_tokens through to usageMetadata', () => {
      // A real mid-conversation Anthropic response carries all three prompt
      // buckets at once: `input_tokens` (non-cached tail),
      // `cache_read_input_tokens` (warm prefix served from cache) and
      // `cache_creation_input_tokens` (new region being written). Both cache
      // fields must reach the normalizer to be summed; dropping either
      // undercounts the Footer reading by that bucket's size.
      const response = respond({
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 2_500,
          cache_read_input_tokens: 32_088,
          cache_creation_input_tokens: 8_700,
          output_tokens: 400,
        },
      });

      expect(response.usageMetadata).toEqual({
        promptTokenCount: 43_288,
        candidatesTokenCount: 400,
        totalTokenCount: 43_688,
        cachedContentTokenCount: 32_088,
      });
      expect(getGenAiUsageProvenance(response.usageMetadata)).toEqual({
        cachedInputTokensReported: true,
        cacheCreationInputTokens: 8_700,
      });
    });

    it('does not substitute the request model when the provider omits its model', () => {
      const response = respond({
        id: 'msg-no-model',
        model: '',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      expect(response.modelVersion).toBeUndefined();
    });
  });

  describe('mapAnthropicFinishReasonToLlm', () => {
    const map = (reason: string | null) =>
      converter.mapAnthropicFinishReasonToLlm(reason);

    it('maps known reasons', () => {
      expect(map('end_turn')).toBe(FinishReason.STOP);
      expect(map('max_tokens')).toBe(FinishReason.MAX_TOKENS);
      expect(map('content_filter')).toBe(FinishReason.SAFETY);
    });

    it('maps refusal into the content-filter family (#9026)', () => {
      // A refusal stop_reason is a provider safety decision. It must map to
      // SAFETY so llmChat's quiet post-tool-result acceptance gate keeps it
      // fatal; falling through to FINISH_REASON_UNSPECIFIED would let an
      // armed attempt accept the refusal as a quiet "(empty content)"
      // completion.
      expect(map('refusal')).toBe(FinishReason.SAFETY);
    });

    it('returns undefined for null/empty', () => {
      expect(map(null)).toBeUndefined();
      expect(map('')).toBeUndefined();
    });
  });

  describe('enableCacheControl', () => {
    it('does not add cache_control to system when disabled', () => {
      expect(systemOf('sys', undefined, noCacheConverter())).toBe('sys');
    });

    it('does not add cache_control to messages when disabled', () => {
      const { messages } = convert(
        'Hello',
        undefined,
        undefined,
        noCacheConverter(),
      );
      expect(messages).toEqual([user(txt('Hello'))]);
    });

    it('marks the last user message with cache_control when its last block is tool_result', () => {
      // Regression: in agentic loops the last user message is usually a
      // tool_result, not text. An earlier guard required a text last block,
      // which silently dropped the per-turn cache breakpoint from turn 2 on
      // and collapsed the cacheable region back to system+tools. Anthropic
      // docs list tool_result as a cacheable block type in messages.content.
      const { messages } = convert([
        userText('do the thing'),
        content('model', call('c1', 't')),
        answer('c1', 'done', 't'),
      ]);

      const lastUser = messages[messages.length - 1];
      expect(lastUser.role).toBe('user');
      const blocks = Array.isArray(lastUser.content) ? lastUser.content : [];
      const lastBlock = blocks[blocks.length - 1] as {
        type: string;
        cache_control?: { type: string };
      };
      expect(lastBlock.type).toBe('tool_result');
      expect(lastBlock.cache_control).toEqual(EPH);
    });

    it('does not add cache_control to tools when disabled', async () => {
      const result = await noCacheConverter().convertLlmToolsToAnthropic(
        toolsOf(weather(weatherSchema())),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ...weather(),
        input_schema: weatherSchema(),
      });
      expect(result[0]).not.toHaveProperty('cache_control');
    });

    describe('per-call options override constructor default', () => {
      // The generator latches `contentGeneratorConfig.enableCacheControl`
      // per request and forwards the live value to the converter, so a
      // `Config.setModel()` flip is reflected without rebuilding the
      // converter. These tests pin the override at the converter level too.
      const tools = toolsOf(weather());

      it('overrides constructor false → true for system + messages + tools', async () => {
        const c = noCacheConverter();
        const opts = { enableCacheControl: true, useGlobalCacheScope: true };
        const { system, messages } = convert('Hello', opts, 'sys', c);

        expect(system).toEqual([txt('sys', GLOBAL)]);
        // Last user-text block gets per-session cache_control (no scope).
        expect(messages).toEqual([user(txt('Hello', EPH))]);

        const result = await c.convertLlmToolsToAnthropic(tools, opts);
        expect(result[0].cache_control).toEqual(GLOBAL);
      });

      it('overrides constructor true → false (cache fully off)', async () => {
        // Default ctor: enableCacheControl true. Per-call override flips to
        // false, mirroring a runtime `setModel()` that switches into a
        // cache-disabled provider config.
        const c = new AnthropicContentConverter('test-model', 'auto', true);
        const opts = { enableCacheControl: false };
        const { system, messages } = convert('Hello', opts, 'sys', c);

        expect(system).toBe('sys');
        expect(messages).toEqual([user(txt('Hello'))]);

        const result = await c.convertLlmToolsToAnthropic(tools, opts);
        expect(result[0]).not.toHaveProperty('cache_control');
      });

      it('honors useGlobalCacheScope independently of enableCacheControl source', async () => {
        // Cache on (per-call), scope off (per-call default): the emitted
        // shape is per-session even though cache_control IS attached —
        // non-Anthropic baseURL behavior in one call.
        const { system } = convert(
          'Hello',
          {
            enableCacheControl: true /* useGlobalCacheScope omitted → false */,
          },
          'sys',
        );
        expect(system).toEqual([txt('sys', EPH)]);

        const result = await converter.convertLlmToolsToAnthropic(tools, {
          enableCacheControl: true,
        });
        expect(result[0].cache_control).toEqual(EPH);
      });
    });

    describe('cacheRetention', () => {
      // The unset (ephemeral, no ttl) system shape is pinned by 'extracts
      // systemInstruction text from string' above.

      /** Convert a 'hi'/'sys' request and one tool under the same options. */
      const convertBoth = async (opts: Opts) => {
        const { system, messages } = convert('hi', opts, 'sys');
        const last = messages[messages.length - 1].content;
        const tools = await converter.convertLlmToolsToAnthropic(
          toolsOf(weather()),
          opts,
        );
        return {
          system,
          lastBlock: Array.isArray(last) ? last[last.length - 1] : undefined,
          tool: tools[0],
        };
      };

      it("sets ttl:'1h' on system, last tool, and trailing user message when cacheRetention is '1h'", async () => {
        const { system, lastBlock, tool } = await convertBoth({
          cacheRetention: '1h',
        });
        expect(system).toEqual([txt('sys', HOUR)]);
        expect(lastBlock).toEqual(txt('hi', HOUR));
        expect(tool?.cache_control).toEqual(HOUR);
      });

      it('composes ttl with scope:"global" on the same cache_control entry', () => {
        expect(
          systemOf('sys', { cacheRetention: '1h', useGlobalCacheScope: true }),
        ).toEqual([txt('sys', { ...GLOBAL, ttl: '1h' })]);
      });

      it('honors a per-anchor cacheRetentionByBlock override, promoting the earlier tool anchor to keep wire order legal', async () => {
        // Anthropic requires longer-TTL cache entries before shorter ones on
        // the wire (tools -> system -> messages), so { system: '1h' } alone
        // would leave a 5m-default tool anchor ahead of a 1h system anchor.
        // resolveCacheRetention promotes every anchor before a '1h' one, so
        // the tool anchor here also resolves to '1h'.
        const { system, tool } = await convertBoth({
          cacheRetention: 'ephemeral',
          cacheRetentionByBlock: { system: '1h' },
        });
        expect(system).toEqual([txt('sys', HOUR)]);
        expect(tool?.cache_control).toEqual(HOUR);
      });

      it("does not promote anchors after the overridden one -- { tool: '1h' } alone leaves system/user.last at the default", async () => {
        // tool -> system -> user.last is already longest-to-shortest, so
        // nothing needs promoting; this override shape was always legal,
        // even before the ordering fix.
        const { system, lastBlock, tool } = await convertBoth({
          cacheRetention: 'ephemeral',
          cacheRetentionByBlock: { tool: '1h' },
        });
        expect(system).toEqual([txt('sys', EPH)]);
        expect(lastBlock).toEqual(txt('hi', EPH));
        expect(tool?.cache_control).toEqual(HOUR);
      });

      it("promotes both tool and system when only 'user.last' is overridden to '1h'", async () => {
        // { 'user.last': '1h' } alone would leave both the tool and system
        // anchors at the 5m default ahead of a 1h trailing user message --
        // also an ordering violation, and one the reviewer's case analysis
        // called out explicitly (case E).
        const { system, lastBlock, tool } = await convertBoth({
          cacheRetention: 'ephemeral',
          cacheRetentionByBlock: { 'user.last': '1h' },
        });
        expect(system).toEqual([txt('sys', HOUR)]);
        expect(lastBlock).toEqual(txt('hi', HOUR));
        expect(tool?.cache_control).toEqual(HOUR);
      });

      it('carries ttl on both halves of a split system prompt (staticSystemPrefix)', () => {
        expect(
          systemOf('stable prefixvolatile suffix', {
            cacheRetention: '1h',
            staticSystemPrefix: 'stable prefix',
          }),
        ).toEqual([txt('stable prefix', HOUR), txt('volatile suffix', HOUR)]);
      });
    });
  });

  // https://github.com/QwenLM/qwen-code/issues/9453
  //
  // The OpenAI Responses generator stashes an opaque reasoning-replay payload
  // in the shared `Part.thoughtSignature` field (responses-converter.ts:
  // `encodeReasoningSignature({ id, encrypted_content })`). That payload is
  // only meaningful to the Responses API; after a provider switch it must not
  // reach the Anthropic wire as a native `thinking.signature`, while the
  // visible reasoning summary is kept.
  describe('cross-provider reasoning replay metadata', () => {
    const responsesReplaySignature = JSON.stringify({
      id: 'rs_68c6c0c9ff5c8191a29b2e78c1a40c83',
      encrypted_content: 'gAAAAABvcmVhc29uaW5nLXJlcGxheS1wYXlsb2Fk',
    });
    // A native Anthropic signature is an opaque token: it never starts with
    // '{' and never parses as the Responses replay payload shape.
    const anthropicNativeSignature =
      'EqQBCgIYAhIkAc6dE9c2eN8aBf1c5d7e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6E=';
    const noCache = { enableCacheControl: false };
    const dropUnsigned = { dropUnsignedAssistantThinking: true };
    /** A summary thought signed with `sig`. */
    const summary = (sig: string) => thought('Reasoning summary', sig);
    /** First / summary + answer / Second, converted under `opts`. */
    const replay = (sig: string, opts: Opts) =>
      convert(
        [
          userText('First'),
          content('model', summary(sig), { text: 'Visible answer' }),
          userText('Second'),
        ],
        opts,
      ).messages;

    it('forwards a native Anthropic thinking signature unchanged', () => {
      expect(replay(anthropicNativeSignature, noCache)[1]).toEqual(
        assistant(
          think('Reasoning summary', anthropicNativeSignature),
          txt('Visible answer'),
        ),
      );
    });

    it('does not forward a Responses replay payload as a native signature', () => {
      // The foreign replay payload must not be attached as a native
      // `signature`: the thinking block is emitted unsigned (no `signature`
      // key), leaving the summary text intact for the downstream
      // strip/normalize passes to decide its fate.
      expect(replay(responsesReplaySignature, noCache)[1]).toEqual(
        assistant(think('Reasoning summary'), txt('Visible answer')),
      );
    });

    it('strips the foreign replay payload under stripAssistantThinking', () => {
      // The hidden reasoning must not leak as visible assistant prose: under
      // stripAssistantThinking the unsigned thinking block is removed, and no
      // demoted `'Reasoning summary'` text block is emitted.
      expect(
        replay(responsesReplaySignature, {
          stripAssistantThinking: true,
          ...noCache,
        })[1],
      ).toEqual(assistant(txt('Visible answer')));
    });

    it('does not throw on an active tool-use turn when dropping the replay payload', () => {
      const { messages } = convert(
        [
          userText('First'),
          content(
            'model',
            summary(responsesReplaySignature),
            fnCall('tool_name', {}, 'call-1'),
          ),
          answer('call-1', 'ok', 'tool_name'),
        ],
        dropUnsigned,
      );

      // Must not throw "proxy omitted the thinking signature": the replay
      // payload is dropped rather than emitted as an unsigned thinking block,
      // so dropUnsignedThinkingFromAssistantMessages never sees one on this
      // active tool-use turn. The demoted summary survives as plain text and
      // the tool_use block is untouched.
      const first = messages.find((m) => m.role === 'assistant');
      expect(first?.content).toEqual([
        txt('Reasoning summary'),
        toolUse('call-1', 'tool_name'),
      ]);
    });

    it('never forwards a signature-only replay payload as a native signature', () => {
      // flushThoughtEpisode always sets `text` ('' for a signature-only
      // episode), so the shape reaching this converter is an empty-text
      // thought part, not a part with no `text` key.
      const assistantOf = (isLatestTurn: boolean, opts: Opts) =>
        convert(
          [
            userText('First'),
            content('model', thought('', responsesReplaySignature), {
              text: 'Visible answer',
            }),
            ...(isLatestTurn
              ? []
              : [userText('Second'), modelText('Later answer')]),
          ],
          opts,
        ).messages.find((m) => m.role === 'assistant')?.content;

      // Latest and non-latest positions, under both the production proxy
      // option set (dropUnsignedAssistantThinking) and the bare one; the
      // replay payload must never surface as a native signature in any.
      //
      // dropUnsigned: the payload is dropped and no thinking block emitted.
      // With empty (signature-only) text there is nothing to demote, so the
      // exact content is just the visible answer (no empty-text block leaks).
      expect(assistantOf(false, dropUnsigned)).toEqual([txt('Visible answer')]);
      expect(assistantOf(true, dropUnsigned)).toEqual([txt('Visible answer')]);
      // Bare, NON-latest turn: dropEmptyTextThinkingBlocks deletes the
      // empty-text thinking block, leaving only the visible answer. Only a
      // genuine second (later) model turn reaches this; with a single model
      // turn the block would survive.
      expect(assistantOf(false, noCache)).toEqual([txt('Visible answer')]);
      // Bare, LATEST turn: the empty-text block is kept (latest-turn
      // signatures must replay byte-exact, so dropEmptyTextThinkingBlocks
      // leaves it) but unsigned (no `signature` key), so the foreign payload
      // still never reaches the wire.
      expect(assistantOf(true, noCache)).toEqual([
        think(''),
        txt('Visible answer'),
      ]);
    });

    it('demotes a non-empty replay summary to plain text instead of dropping it', () => {
      // The empty-text signature-only case above cannot tell "demoted to
      // text" apart from "dropped entirely", because with no text there is
      // nothing to preserve. A non-empty summary pins the demote path: under
      // dropUnsignedAssistantThinking the thinking block is dropped AND the
      // visible summary survives as a plain-text block.
      const { messages } = convert(
        [
          userText('First'),
          content('model', summary(responsesReplaySignature), {
            text: 'Visible answer',
          }),
        ],
        dropUnsigned,
      );

      expect(messages[1]).toEqual(
        assistant(txt('Reasoning summary'), txt('Visible answer')),
      );
    });
  });
});
