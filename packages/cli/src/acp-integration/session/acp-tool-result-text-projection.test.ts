/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET,
  ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER,
  projectAcpToolResultUpdate,
} from './acp-tool-result-text-projection.js';

function textBlock(text: string) {
  return { type: 'content', content: { type: 'text', text } } as const;
}

function toolUpdate(
  content: unknown,
  rawOutput?: unknown,
  meta: Record<string, unknown> = { toolName: 'read_file' },
): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content,
    ...(rawOutput === undefined ? {} : { rawOutput }),
    _meta: meta,
  } as unknown as SessionUpdate;
}

function asRecord(update: SessionUpdate): Record<string, unknown> {
  return update as unknown as Record<string, unknown>;
}

function contentTexts(update: SessionUpdate): string[] {
  return (
    asRecord(update)['content'] as Array<{
      content: { text: string };
    }>
  ).map((block) => block.content.text);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('ACP tool-result text projection', () => {
  it.each([65_535, 65_536, 65_537])(
    'enforces the rawOutput boundary at %i JSON bytes',
    (targetBytes) => {
      const rawOutput = 'r'.repeat(targetBytes - 2);
      const update = toolUpdate([], rawOutput);
      const projected = projectAcpToolResultUpdate(update);
      const projectedRaw = asRecord(projected)['rawOutput'];

      expect(jsonBytes(projectedRaw)).toBeLessThanOrEqual(
        ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET,
      );
      expect(projected === update).toBe(targetBytes <= 65_536);
    },
  );

  it.each([65_535, 65_536, 65_537])(
    'enforces the content boundary at %i JSON bytes',
    (targetBytes) => {
      const content = [textBlock('c'.repeat(targetBytes - 56))];
      expect(jsonBytes(content)).toBe(targetBytes);
      const update = toolUpdate(content);
      const projected = projectAcpToolResultUpdate(update);

      expect(jsonBytes(asRecord(projected)['content'])).toBeLessThanOrEqual(
        ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET,
      );
      expect(projected === update).toBe(targetBytes <= 65_536);
    },
  );

  it('keeps an approximately 20/80 head and tail preview', () => {
    const source =
      `HEAD-${'h'.repeat(200_000)}` + `-${'t'.repeat(200_000)}-TAIL`;
    const projected = projectAcpToolResultUpdate(toolUpdate([], source));
    const rawOutput = asRecord(projected)['rawOutput'] as string;

    expect(rawOutput).toContain(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER);
    expect(rawOutput.startsWith('HEAD-')).toBe(true);
    expect(rawOutput.endsWith('-TAIL')).toBe(true);
    const [head, tail] = rawOutput.split(
      ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER,
    );
    expect(tail.length).toBeGreaterThan(head.length * 3.9);
    expect(tail.length).toBeLessThan(head.length * 4.1);
  });

  it('never splits valid surrogate pairs at preview boundaries', () => {
    const source = `head-${'😀'.repeat(100_000)}-tail`;
    const projected = projectAcpToolResultUpdate(toolUpdate([], source));
    const rawOutput = asRecord(projected)['rawOutput'] as string;

    expect(rawOutput).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
    expect(rawOutput).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    expect(jsonBytes(rawOutput)).toBeLessThanOrEqual(65_536);
  });

  it('shares a deterministic budget across multiple text blocks', () => {
    const content = [
      textBlock(`first-${'a'.repeat(300_000)}-first-tail`),
      textBlock(`second-${'b'.repeat(300_000)}-second-tail`),
    ];
    const projected = projectAcpToolResultUpdate(toolUpdate(content));
    const texts = contentTexts(projected);

    expect(jsonBytes(asRecord(projected)['content'])).toBeLessThanOrEqual(
      65_536,
    );
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER);
    expect(texts[1]).toContain(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER);
    expect(texts[0].startsWith('first-')).toBe(true);
    expect(texts[0].endsWith('-first-tail')).toBe(true);
    expect(texts[1].startsWith('second-')).toBe(true);
    expect(texts[1].endsWith('-second-tail')).toBe(true);
    expect(Math.abs(texts[0].length - texts[1].length)).toBeLessThanOrEqual(1);
  });

  it('keeps small blocks complete while distributing the remaining budget', () => {
    const content = [
      textBlock('small'),
      textBlock('x'.repeat(200_000)),
      textBlock('y'.repeat(200_000)),
    ];
    const projected = projectAcpToolResultUpdate(toolUpdate(content));
    const texts = contentTexts(projected);

    expect(texts[0]).toBe('small');
    expect(texts[1]).toContain(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER);
    expect(texts[2]).toContain(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER);
    expect(jsonBytes(asRecord(projected)['content'])).toBe(65_536);
  });

  it('saturates the budget after smaller blocks reach their capacity', () => {
    const content = [
      textBlock('a'.repeat(10_000)),
      textBlock('b'.repeat(50_000)),
      textBlock('c'.repeat(200_000)),
    ];
    const projected = projectAcpToolResultUpdate(toolUpdate(content));
    const texts = contentTexts(projected);

    expect(texts[0]).toBe(content[0].content.text);
    expect(texts[1]).toContain(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER);
    expect(texts[2]).toContain(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER);
    expect(jsonBytes(asRecord(projected)['content'])).toBe(65_536);
  });

  it('bounds pathological many-block content without collapsing it', () => {
    const content = Array.from({ length: 600 }, (_, index) =>
      textBlock(`${index}:${'x'.repeat(40_000)}`),
    );
    const projected = projectAcpToolResultUpdate(toolUpdate(content));
    const texts = contentTexts(projected);

    expect(texts).toHaveLength(content.length);
    expect(
      texts.every((text) =>
        text.includes(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER),
      ),
    ).toBe(true);
    expect(jsonBytes(asRecord(projected)['content'])).toBe(65_536);
  });

  it('collapses content when the empty structure cannot fit', () => {
    const content = Array.from({ length: 1_192 }, () => textBlock(''));
    const projected = projectAcpToolResultUpdate(toolUpdate(content));

    expect(contentTexts(projected)).toEqual([
      ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER,
    ]);
  });

  it('keeps content at exactly the block-count maximum', () => {
    const content = Array.from({ length: 1_191 }, () => textBlock(''));
    const update = toolUpdate(content);

    expect(projectAcpToolResultUpdate(update)).toBe(update);
    expect(contentTexts(update)).toHaveLength(1_191);
  });

  it('collapses content when the minimum marker set cannot fit', () => {
    const content = Array.from({ length: 1_000 }, () =>
      textBlock('x'.repeat(100)),
    );
    const projected = projectAcpToolResultUpdate(toolUpdate(content));

    expect(contentTexts(projected)).toEqual([
      ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER,
    ]);
  });

  it('reuses the stricter content preview when content and rawOutput match', () => {
    const source = `head-${'x'.repeat(499_999)}-tail`;
    const update = toolUpdate([textBlock(source)], source);
    const projected = projectAcpToolResultUpdate(update);
    const projectedText = contentTexts(projected)[0];

    expect(asRecord(projected)['rawOutput']).toBe(projectedText);
    expect(jsonBytes(asRecord(projected)['content'])).toBeLessThanOrEqual(
      65_536,
    );
    expect(jsonBytes(asRecord(projected)['rawOutput'])).toBeLessThanOrEqual(
      65_536,
    );
  });

  it('projects eligible fields independently', () => {
    const longRaw = 'r'.repeat(100_000);
    const mixedContent = [
      textBlock('text'),
      { type: 'diff', path: 'file.ts', oldText: '', newText: 'new' },
    ];
    const structuredRaw = { value: 'r'.repeat(100_000) };
    const longContent = [textBlock('c'.repeat(100_000))];

    const rawProjected = projectAcpToolResultUpdate(
      toolUpdate(mixedContent, longRaw),
    );
    expect(asRecord(rawProjected)['content']).toBe(mixedContent);
    expect(jsonBytes(asRecord(rawProjected)['rawOutput'])).toBeLessThanOrEqual(
      65_536,
    );

    const contentProjected = projectAcpToolResultUpdate(
      toolUpdate(longContent, structuredRaw),
    );
    expect(asRecord(contentProjected)['rawOutput']).toBe(structuredRaw);
    expect(
      jsonBytes(asRecord(contentProjected)['content']),
    ).toBeLessThanOrEqual(65_536);
  });

  it('exempts content blocks with extra fields', () => {
    const content = [
      {
        ...textBlock('x'.repeat(100_000)),
        annotations: { audience: ['assistant'] },
      },
    ];
    const update = toolUpdate(content);

    expect(projectAcpToolResultUpdate(update)).toBe(update);
  });

  it('exempts content blocks whose inner text carries extra fields', () => {
    const content = [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'x'.repeat(100_000),
          annotations: { audience: ['assistant'] },
        },
      },
    ];
    const update = toolUpdate(content);

    expect(projectAcpToolResultUpdate(update)).toBe(update);
  });

  it.each([
    [
      'diff',
      {
        type: 'diff',
        path: 'file.ts',
        oldText: '',
        newText: 'x'.repeat(100_000),
      },
    ],
    [
      'terminal',
      {
        type: 'terminal',
        terminalId: 'terminal-1',
        output: 'x'.repeat(100_000),
      },
    ],
    [
      'media',
      { type: 'image', data: 'x'.repeat(100_000), mimeType: 'image/png' },
    ],
  ])('exempts oversized %s content', (_name, block) => {
    const content = [block];
    const update = toolUpdate(content);

    expect(projectAcpToolResultUpdate(update)).toBe(update);
    expect(asRecord(update)['content']).toBe(content);
  });

  it('exempts oversized A2UI tool updates as a whole', () => {
    const text = `[${' '.repeat(100_000)}]`;
    const update = toolUpdate([textBlock(text)], text, {
      toolName: 'mcp__ui__present_ui',
      serverId: 'a2ui-ui',
    });

    expect(projectAcpToolResultUpdate(update)).toBe(update);
  });

  it('exempts A2UI updates identified only by serverId', () => {
    const text = `[${' '.repeat(100_000)}]`;
    const update = toolUpdate([textBlock(text)], text, {
      toolName: 'present_quality_report',
      serverId: 'dq-A2UI',
    });

    expect(projectAcpToolResultUpdate(update)).toBe(update);
  });

  it('exempts legacy A2UI updates identified only by toolName', () => {
    const text = `[${' '.repeat(100_000)}]`;
    const update = toolUpdate([textBlock(text)], text, {
      toolName: 'mcp__ui__present_ui',
    });

    expect(projectAcpToolResultUpdate(update)).toBe(update);
  });

  it('is immutable and idempotent', () => {
    const source = 'x'.repeat(100_000);
    const content = [textBlock(source)];
    const update = toolUpdate(content, source);
    const projected = projectAcpToolResultUpdate(update);

    expect(asRecord(update)['content']).toBe(content);
    expect(content[0].content.text).toBe(source);
    expect(projectAcpToolResultUpdate(projected)).toBe(projected);
  });

  it('shares unchanged blocks and metadata when one block is projected', () => {
    const smallBlock = textBlock('small');
    const largeBlock = textBlock('x'.repeat(100_000));
    const meta = { toolName: 'read_file', nested: { stable: true } };
    const update = toolUpdate([smallBlock, largeBlock], undefined, meta);
    const projected = projectAcpToolResultUpdate(update);
    const blocks = asRecord(projected)['content'] as unknown[];

    expect(projected).not.toBe(update);
    expect(blocks[0]).toBe(smallBlock);
    expect(blocks[1]).not.toBe(largeBlock);
    expect(asRecord(projected)['_meta']).toBe(meta);
  });

  it('leaves unrelated and small updates unchanged by reference', () => {
    const small = toolUpdate([textBlock('ok')], 'ok');
    const message = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'x'.repeat(100_000) },
    } as SessionUpdate;

    expect(projectAcpToolResultUpdate(small)).toBe(small);
    expect(projectAcpToolResultUpdate(message)).toBe(message);
  });

  it('bounds active tool-call updates before completion', () => {
    const update = toolUpdate([], 'x'.repeat(100_000));
    asRecord(update)['status'] = 'in_progress';
    const projected = projectAcpToolResultUpdate(update);

    expect(jsonBytes(asRecord(projected)['rawOutput'])).toBeLessThanOrEqual(
      65_536,
    );
  });

  it.each([
    ['499,999-byte ASCII', 'a'.repeat(499_999)],
    ['500,001-code-unit CJK', '汉'.repeat(500_001)],
  ])('bounds the %s baseline fixture', (_name, source) => {
    const projected = projectAcpToolResultUpdate(
      toolUpdate([textBlock(source)], source),
    );
    expect(jsonBytes(asRecord(projected)['content'])).toBeLessThanOrEqual(
      65_536,
    );
    expect(jsonBytes(asRecord(projected)['rawOutput'])).toBeLessThanOrEqual(
      65_536,
    );
  });

  it('keeps an ordinary projected JSON-RPC frame below 256 KiB', () => {
    const source = 'x'.repeat(499_999);
    const update = projectAcpToolResultUpdate(
      toolUpdate([textBlock(source)], source),
    );
    const frame = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update },
    };
    const encoded = JSON.stringify(frame);

    expect(() => JSON.parse(encoded)).not.toThrow();
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(256 * 1024);
  });
});
