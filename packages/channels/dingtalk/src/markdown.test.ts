import { describe, it, expect } from 'vitest';
import {
  splitChunks,
  extractTitle,
  normalizeDingTalkMarkdown,
} from './markdown.js';

describe('DingTalk markdown utilities', () => {
  describe('splitChunks', () => {
    it('returns single chunk for short text', () => {
      expect(splitChunks('short text')).toEqual(['short text']);
    });

    it('returns single chunk for empty text', () => {
      expect(splitChunks('')).toEqual(['']);
    });

    it('splits long text into chunks', () => {
      const line = 'a'.repeat(100) + '\n';
      const text = line.repeat(50); // 5050 chars > 3800
      const chunks = splitChunks(text);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('splits a single long line', () => {
      const text = 'a'.repeat(5000);
      const chunks = splitChunks(text);
      expect(chunks.length).toBe(2);
      expect(chunks.join('')).toBe(text);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('preserves surrounding newlines when splitting a long line', () => {
      const text = ['before', 'b'.repeat(5000), 'after'].join('\n');
      const chunks = splitChunks(text);
      expect(chunks.length).toBe(2);
      expect(chunks.join('')).toBe(text);
    });

    it('preserves the newline when the chunk boundary falls before a long line', () => {
      const text = 'a'.repeat(3799) + '\n' + 'b'.repeat(5000);
      const chunks = splitChunks(text);
      expect(chunks.join('')).toBe(text);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('does not add fences for long plain text with inline backticks', () => {
      const text = 'before ``` inline ``` ' + 'x'.repeat(5000);
      const chunks = splitChunks(text);
      expect(chunks.join('')).toBe(text);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('closes and reopens code fences across boundaries', () => {
      const longCode = '```\n' + 'x\n'.repeat(2000) + '```';
      const chunks = splitChunks(longCode);
      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should end with closing fence
      expect(chunks[0]).toContain('```');
      // Second chunk should start with opening fence
      if (chunks.length > 1) {
        expect(chunks[1]!.trimStart().startsWith('```')).toBe(true);
      }
    });

    it('reopens code fences without inserting a blank line', () => {
      const longCode = '```\n' + 'x\n'.repeat(2000) + '```';
      const chunks = splitChunks(longCode);
      expect(chunks.length).toBeGreaterThan(1);
      // The reopened fence must be followed by the code, not a blank line.
      // A blank line here renders as spurious leading whitespace in the
      // continued code block.
      expect(chunks[1]!.startsWith('```\n\n')).toBe(false);
      expect(chunks[1]!.startsWith('```\nx')).toBe(true);
    });

    it('splits a long code line while preserving fences', () => {
      const longCode = '```\n' + 'x'.repeat(5000) + '\n```';
      const chunks = splitChunks(longCode);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]!.endsWith('\n```')).toBe(true);
      expect(chunks[1]!.startsWith('```\nx')).toBe(true);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('accounts for closing fence overhead when splitting code chunks', () => {
      const longCode = '```\n' + 'x'.repeat(3793) + '\n```';
      const chunks = splitChunks(longCode);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('keeps chunks within limit when a long code line ends with a fence', () => {
      const longCode = '```\n' + 'x'.repeat(5000) + '```';
      const chunks = splitChunks(longCode);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('keeps room for closing fences after a long opening fence line', () => {
      const longCode = '```' + 'x'.repeat(3797) + '\ny\n```';
      const chunks = splitChunks(longCode);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]!.endsWith('\n```')).toBe(true);
      expect(chunks[1]!.startsWith('```\n')).toBe(true);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });

    it('does not split an opening fence delimiter across chunks', () => {
      const longCode =
        'a'.repeat(3794) + '\n```' + 'x'.repeat(100) + '\ny\n```';
      const chunks = splitChunks(longCode);
      expect(chunks.join('')).toBe(longCode);
      expect(chunks[0]!.endsWith('\n`')).toBe(false);
      expect(chunks[1]!.startsWith('\n```')).toBe(true);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3800);
      });
    });
  });

  describe('extractTitle', () => {
    it('extracts title from first line', () => {
      expect(extractTitle('Hello World\nmore text')).toBe('Hello World');
    });

    it('strips markdown heading markers', () => {
      expect(extractTitle('## My Title\ncontent')).toBe('My Title');
    });

    it('strips bold/list markers', () => {
      expect(extractTitle('* Item one')).toBe('Item one');
      expect(extractTitle('> Quote text')).toBe('Quote text');
    });

    it('truncates to 20 chars', () => {
      expect(
        extractTitle('This is a very long title that should be truncated')
          .length,
      ).toBeLessThanOrEqual(20);
    });

    it('returns Reply for empty text', () => {
      expect(extractTitle('')).toBe('Reply');
      expect(extractTitle('###')).toBe('Reply');
    });
  });

  describe('normalizeDingTalkMarkdown', () => {
    it('preserves markdown tables while splitting into chunks', () => {
      const input = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
      const result = normalizeDingTalkMarkdown(input);
      expect(result).toEqual([input]);
    });

    it('passes through plain text', () => {
      const result = normalizeDingTalkMarkdown('simple text');
      expect(result).toEqual(['simple text']);
    });
  });
});
