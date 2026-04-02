import { describe, it, expect } from 'vitest';
import {
  convertTables,
  splitChunks,
  extractTitle,
  normalizeDingTalkMarkdown,
} from './markdown.js';

describe('DingTalk markdown utilities', () => {
  describe('convertTables', () => {
    it('converts a simple markdown table to pipe-separated text', () => {
      const input = [
        '| Name | Age |',
        '| --- | --- |',
        '| Alice | 30 |',
        '| Bob | 25 |',
      ].join('\n');
      const result = convertTables(input);
      expect(result).toContain('Name | Age');
      expect(result).toContain('Alice | 30');
      expect(result).not.toContain('---');
    });

    it('preserves non-table content', () => {
      const input = 'Hello world\n\nSome text';
      expect(convertTables(input)).toBe(input);
    });

    it('does not convert tables inside code fences', () => {
      const input = [
        '```',
        '| Name | Age |',
        '| --- | --- |',
        '| Alice | 30 |',
        '```',
      ].join('\n');
      const result = convertTables(input);
      expect(result).toBe(input);
    });

    it('handles table with surrounding text', () => {
      const input = [
        'Before',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        'After',
      ].join('\n');
      const result = convertTables(input);
      expect(result).toContain('Before');
      expect(result).toContain('After');
      expect(result).toContain('A | B');
    });

    it('handles table with alignment colons in separator', () => {
      const input = [
        '| Left | Center | Right |',
        '| :--- | :---: | ---: |',
        '| a | b | c |',
      ].join('\n');
      const result = convertTables(input);
      expect(result).not.toContain(':---');
    });
  });

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
        expect(chunk.length).toBeLessThanOrEqual(3900); // allow small overhead
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
    it('converts tables and splits into chunks', () => {
      const input = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
      const result = normalizeDingTalkMarkdown(input);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0]).not.toContain('---');
    });

    it('passes through plain text', () => {
      const result = normalizeDingTalkMarkdown('simple text');
      expect(result).toEqual(['simple text']);
    });
  });
});
