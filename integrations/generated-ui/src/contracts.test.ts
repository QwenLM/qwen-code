/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createShowResult,
  documentSchema,
  hashDocument,
  MAX_RESULT_BYTES,
  MAX_RESULT_CHARS,
  META_KEY,
  parseToolResult,
  serializeDocument,
  showInputSchema,
  type ShowInput,
} from './contracts.js';

const input: ShowInput = {
  title: 'Capacity simulation',
  summary: 'Adjust the assumed arrival rate to compare estimated capacity.',
  html: '<label>Rate <input id="rate" type="range" value="20"></label><p id="answer"></p>',
  css: 'label { display: block; }',
  javascript: 'ui.text("answer", String(Number(ui.input("rate").value) * 2));',
};

describe('immutable generated view contract', () => {
  it('keeps source only in the complete private snapshot', () => {
    const result = createShowResult(input);
    const document = parseToolResult(result);
    expect(document).toEqual({
      schemaVersion: 1,
      documentId: hashDocument(input),
      ...input,
    });
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      documentId: document.documentId,
      title: input.title,
      summary: input.summary,
    });
    expect(result.content).toEqual([
      { type: 'text', text: `${input.title}\n${input.summary}` },
    ]);
    const text = result.content[0];
    if (text.type !== 'text') throw new Error('Expected a text summary.');
    expect(text.text.charCodeAt(input.title.length)).toBe(10);
    expect(text.text).not.toContain(String.raw`\n`);
    expect(JSON.stringify(result.structuredContent)).not.toContain(input.html);
    expect(JSON.stringify(result.content)).not.toContain(input.javascript);
    expect(result._meta).toEqual({ [META_KEY]: document });
  });

  it('hashes explicit canonical fields consistently with Node SHA-256', () => {
    const reordered = {
      javascript: input.javascript,
      css: input.css,
      html: input.html,
      summary: input.summary,
      title: input.title,
    };
    const expected = JSON.stringify({ schemaVersion: 1, ...input });
    expect(serializeDocument(reordered)).toBe(expected);
    expect(hashDocument(reordered)).toBe(
      `g1_${createHash('sha256').update(expected).digest('hex')}`,
    );
    expect(createShowResult(reordered)).toEqual(createShowResult(input));
  });

  it('keeps terminal control characters out of the readable fallback', () => {
    const candidate = {
      ...input,
      title: 'Title\u001b[2J',
      summary: 'Line one\r\nLine two\tvalue\u0007',
    };
    const result = createShowResult(candidate);
    const text = result.content[0];
    if (text.type !== 'text') throw new Error('Expected a text summary.');
    expect(text.text).toBe('Title[2J\nLine one\nLine two\tvalue');
    expect(parseToolResult(result)).toMatchObject({
      ...candidate,
      title: 'Title[2J',
      summary: 'Line one\nLine two\tvalue',
    });
  });

  it('keeps invisible formatting characters out of every public channel', () => {
    const result = createShowResult({
      ...input,
      title: 'Rate\u202edeliah',
      summary: 'Line\u2028one\u200bvalue',
    });
    const text = result.content[0];
    if (text.type !== 'text') throw new Error('Expected a text summary.');
    expect(text.text).toBe('Ratedeliah\nLineonevalue');
    expect(JSON.stringify(result.structuredContent)).not.toMatch(
      /[\p{Cf}\p{Zl}\p{Zp}]/u,
    );
    const document = parseToolResult(result);
    expect(document.title).toBe('Ratedeliah');
    expect(document.summary).toBe('Lineonevalue');
  });

  it('preserves text and emoji joiners while binding the normalized public fields', () => {
    const candidate = {
      ...input,
      title: '中文👩‍💻\u202eTitle\u200b',
      summary: 'A\u200cB\r\nLine\tvalue\u0007\u0085\u00ad\ufeff\u2028\u2029',
    };
    const normalized = {
      ...candidate,
      title: '中文👩‍💻Title',
      summary: 'A\u200cB\nLine\tvalue',
    };
    const result = createShowResult(candidate);
    const document = parseToolResult(result);
    expect(document).toMatchObject(normalized);
    expect(document.documentId).toBe(hashDocument(normalized));
    expect(result.structuredContent).toMatchObject({
      title: normalized.title,
      summary: normalized.summary,
      documentId: document.documentId,
    });
    expect(result.content).toEqual([
      { type: 'text', text: `${normalized.title}\n${normalized.summary}` },
    ]);
    expect(candidate.title).toContain('\u202e');
  });

  it.each(['title', 'summary'] as const)(
    'rejects a %s containing only whitespace, joiners or removed controls',
    (field) => {
      for (const value of [
        '\u202e\u0007',
        ' \t\n',
        '\u200c',
        '\u200d\u200c',
        ' \t\u200d\n\u200c ',
      ]) {
        expect(() => createShowResult({ ...input, [field]: value })).toThrow(
          'Invalid generated view document.',
        );
      }
    },
  );

  it.each(['title', 'summary'] as const)(
    'rejects a stored snapshot with an unswept %s and matching readable text',
    (field) => {
      const raw = { ...input, [field]: 'Unsafe\u202evalue' };
      const readable = { ...raw, [field]: 'Unsafevalue' };
      const document = {
        schemaVersion: 1 as const,
        documentId: hashDocument(raw),
        ...raw,
      };
      const forged = {
        content: [
          {
            type: 'text' as const,
            text: `${readable.title}\n${readable.summary}`,
          },
        ],
        structuredContent: {
          schemaVersion: 1 as const,
          documentId: document.documentId,
          title: raw.title,
          summary: raw.summary,
        },
        _meta: { [META_KEY]: document },
      };
      expect(() => parseToolResult(forged)).toThrow('identity');
    },
  );

  it.each(['title', 'summary'] as const)(
    'rejects a changed public %s independently of the other public fields',
    (field) => {
      const result = createShowResult(input);
      result.structuredContent![field] = 'Other';
      expect(() => parseToolResult(result)).toThrow('identity');
    },
  );

  it.each(['title', 'summary'] as const)(
    'rejects a matching saved snapshot whose %s has no readable text',
    (field) => {
      for (const value of [' ', '\u200c\u200d']) {
        const result = createShowResult(input);
        const raw = { ...input, [field]: value };
        const document = {
          ...parseToolResult(result),
          ...raw,
          documentId: hashDocument(raw),
        };
        result._meta![META_KEY] = document;
        result.structuredContent = {
          schemaVersion: 1,
          documentId: document.documentId,
          title: raw.title,
          summary: raw.summary,
        };
        result.content = [
          { type: 'text', text: `${raw.title}\n${raw.summary}` },
        ];
        expect(() => parseToolResult(result)).toThrow();
      }
    },
  );

  it.each(['title', 'summary', 'html', 'css', 'javascript'] as const)(
    'binds %s to the snapshot identity',
    (field) => {
      const result = createShowResult(input);
      const document = parseToolResult(result);
      result._meta![META_KEY] = {
        ...document,
        [field]: `${document[field]} changed`,
      };
      expect(() => parseToolResult(result)).toThrow('identity');
      expect(
        hashDocument({ ...input, [field]: `${input[field]} changed` }),
      ).not.toBe(document.documentId);
    },
  );

  it('does not share or mutate snapshots across calls or caller objects', () => {
    const candidate = { ...input };
    const first = createShowResult(candidate);
    const original = JSON.stringify(first);
    candidate.html = '<p>Second document</p>';
    const second = createShowResult(candidate);
    expect(JSON.stringify(first)).toBe(original);
    expect(parseToolResult(first).documentId).not.toBe(
      parseToolResult(second).documentId,
    );
    const parsed = parseToolResult(first);
    parsed.html = '<p>Changed reader copy</p>';
    expect(JSON.stringify(first)).toBe(original);
  });

  it.each([
    { ...input, unknown: true },
    { ...input, title: '' },
    { ...input, title: 'x'.repeat(121) },
    { ...input, summary: '' },
    { ...input, summary: 'x'.repeat(2001) },
    { ...input, html: '' },
    { ...input, html: 'x'.repeat(12_001) },
    { ...input, css: 'x'.repeat(6001) },
    { ...input, javascript: 'x'.repeat(12_001) },
    { ...input, html: 123 },
  ])('rejects invalid fields without truncation', (candidate) => {
    expect(showInputSchema.safeParse(candidate).success).toBe(false);
    expect(() => createShowResult(candidate)).toThrow(
      'Invalid generated view document.',
    );
  });

  it('accepts the exact serialized ASCII budget and rejects one more byte', () => {
    const candidate = {
      ...input,
      html: 'h'.repeat(12_000),
      css: 'c'.repeat(6000),
      javascript: '',
    };
    const remaining =
      MAX_RESULT_CHARS - JSON.stringify(createShowResult(candidate)).length;
    candidate.javascript = 'j'.repeat(remaining);
    const result = createShowResult(candidate);
    expect(JSON.stringify(result).length).toBe(MAX_RESULT_CHARS);
    expect(Buffer.byteLength(JSON.stringify(result))).toBe(MAX_RESULT_BYTES);
    expect(parseToolResult(result).javascript).toBe(candidate.javascript);
    expect(() =>
      createShowResult({
        ...candidate,
        javascript: `${candidate.javascript}j`,
      }),
    ).toThrow('budget');
  });

  it('counts UTF-8 bytes and JSON escaping in the complete result', () => {
    const unicode = { ...input, html: '<p>中文 😀</p>' };
    expect(parseToolResult(createShowResult(unicode))).toMatchObject(unicode);
    const tooManyBytes = { ...input, html: '界'.repeat(8000) };
    expect(showInputSchema.safeParse(tooManyBytes).success).toBe(true);
    expect(() => createShowResult(tooManyBytes)).toThrow('budget');
    const tooMuchEscaping = { ...input, html: '\u0001'.repeat(8000) };
    expect(showInputSchema.safeParse(tooMuchEscaping).success).toBe(true);
    expect(() => createShowResult(tooMuchEscaping)).toThrow('budget');
  });

  it('validates the whole received result before consuming its snapshot', () => {
    const result = createShowResult(input);
    const oversized = {
      ...result,
      content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_CHARS) }],
    };
    expect(() => parseToolResult(oversized)).toThrow('budget');
    const oversizedBytes = {
      ...result,
      content: [{ type: 'text', text: '界'.repeat(8000) }],
    };
    expect(JSON.stringify(oversizedBytes).length).toBeLessThan(
      MAX_RESULT_CHARS,
    );
    expect(() => parseToolResult(oversizedBytes)).toThrow('budget');
  });

  it('rejects unsupported snapshots, error results and metadata substitutions', () => {
    const result = createShowResult(input);
    const document = parseToolResult(result);
    const invalid = [
      { ...result, isError: true },
      { ...result, _meta: undefined },
      { ...result, _meta: {} },
      { ...result, _meta: { [META_KEY]: { ...document, schemaVersion: 2 } } },
      { ...result, _meta: { [META_KEY]: { ...document, extra: true } } },
      { ...result, _meta: { [META_KEY]: document, extra: true } },
      { ...result, extra: true },
      { ...result, structuredContent: document },
      { ...result, content: [{ type: 'text', text: 'Another summary' }] },
      {
        ...result,
        structuredContent: {
          ...result.structuredContent,
          documentId: `g1_${'0'.repeat(64)}`,
        },
      },
      { content: [{ type: 'text', text: JSON.stringify(document) }] },
      { structuredContent: document },
      { toolArguments: input },
      null,
      undefined,
    ];
    for (const value of invalid) {
      expect(() => parseToolResult(value)).toThrow();
    }
    expect(documentSchema.safeParse({ ...document, extra: true }).success).toBe(
      false,
    );
  });

  it('rejects non-serializable data with a bounded error', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => parseToolResult(circular)).toThrow(
      'Invalid generated view result.',
    );
  });

  it.each(['../README.md', '../skills/generated-ui/SKILL.md'])(
    'accepts every complete documented tool argument in %s',
    (path) => {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
      expect(examples).toHaveLength(2);
      for (const [, json] of examples) {
        const example: unknown = JSON.parse(json);
        expect(parseToolResult(createShowResult(example))).toMatchObject(
          showInputSchema.parse(example),
        );
      }
    },
  );
});
