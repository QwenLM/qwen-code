import { describe, it, expect } from 'vitest';
import { buildCardContent, extractTitle, splitChunks } from './markdown.js';

interface CardElement {
  tag: string;
  content?: string;
  value?: Record<string, unknown>;
  elements?: CardElement[];
}

interface CardStructure {
  schema: string;
  header?: { title: { content: string }; template: string };
  body: { elements: CardElement[] };
}

describe('Feishu markdown utilities', () => {
  describe('buildCardContent', () => {
    it('returns a valid card structure', () => {
      const card = buildCardContent('Hello world') as unknown as CardStructure;
      expect(card.schema).toBe('2.0');
      expect(card.body.elements).toBeDefined();
      expect(card.body.elements[0]!.tag).toBe('markdown');
      expect(card.body.elements[0]!.content).toBe('Hello world');
    });

    it('adds streaming indicator when isStreaming is true', () => {
      const card = buildCardContent('text', {
        isStreaming: true,
      }) as unknown as CardStructure;
      expect(card.body.elements[0]!.content).toContain('生成中...');
    });

    it('adds stop button when showStopButton is true', () => {
      const card = buildCardContent('text', {
        showStopButton: true,
      }) as unknown as CardStructure;
      const button = card.body.elements.find((e) => e.tag === 'button');
      expect(button).toBeDefined();
      expect(button!.value).toEqual({ action: 'stop' });
    });

    it('sets header with title', () => {
      const card = buildCardContent('text', {
        title: 'My Title',
      }) as unknown as CardStructure;
      expect(card.header!.title.content).toBe('My Title');
      expect(card.header!.template).toBe('green');
    });

    it('sets blue header when streaming', () => {
      const card = buildCardContent('text', {
        title: 'Title',
        isStreaming: true,
      }) as unknown as CardStructure;
      expect(card.header!.template).toBe('blue');
      expect(card.header!.title.content).toBe('Title ...');
    });

    it('uses collapsible panel for long content when enabled', () => {
      const longText = 'a'.repeat(600);
      const card = buildCardContent(longText, {
        collapsible: true,
        collapsibleThreshold: 500,
      }) as unknown as CardStructure;
      const panel = card.body.elements.find(
        (e) => e.tag === 'collapsible_panel',
      );
      expect(panel).toBeDefined();
    });

    it('does not use collapsible for short content', () => {
      const card = buildCardContent('short', {
        collapsible: true,
        collapsibleThreshold: 500,
      }) as unknown as CardStructure;
      const panel = card.body.elements.find(
        (e) => e.tag === 'collapsible_panel',
      );
      expect(panel).toBeUndefined();
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

    it('returns default for empty text', () => {
      expect(extractTitle('')).toBe('Qwen Code');
      expect(extractTitle('###')).toBe('Qwen Code');
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
      const text = line.repeat(50); // 5050 chars > 4000
      const chunks = splitChunks(text);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(4100);
      });
    });

    it('closes and reopens code fences across boundaries', () => {
      const longCode = '```\n' + 'x\n'.repeat(2500) + '```';
      const chunks = splitChunks(longCode);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]).toContain('```');
      if (chunks.length > 1) {
        expect(chunks[1]!.trimStart().startsWith('```')).toBe(true);
      }
    });

    it('hard-splits a single line exceeding CHUNK_LIMIT', () => {
      const longLine = 'a'.repeat(5000);
      const chunks = splitChunks(longLine);
      expect(chunks.length).toBe(2);
      expect(chunks[0]!.length).toBe(4000);
      expect(chunks[1]!.length).toBe(1000);
    });
  });

  describe('buildCardContent table splitting', () => {
    it('splits table and following content into separate elements', () => {
      const md = [
        'Before table',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        'After table',
      ].join('\n');
      const card = buildCardContent(md) as unknown as CardStructure;
      const mdElements = card.body.elements.filter((e) => e.tag === 'markdown');
      expect(mdElements.length).toBeGreaterThanOrEqual(3);
    });

    it('keeps content without tables in one element', () => {
      const md = 'Hello\nWorld\nNo tables here';
      const card = buildCardContent(md) as unknown as CardStructure;
      const mdElements = card.body.elements.filter((e) => e.tag === 'markdown');
      expect(mdElements.length).toBe(1);
    });

    it('does not split tables inside code fences', () => {
      const md = ['```', '| A | B |', '| --- | --- |', '| 1 | 2 |', '```'].join(
        '\n',
      );
      const card = buildCardContent(md) as unknown as CardStructure;
      const mdElements = card.body.elements.filter((e) => e.tag === 'markdown');
      expect(mdElements.length).toBe(1);
    });
  });
});
