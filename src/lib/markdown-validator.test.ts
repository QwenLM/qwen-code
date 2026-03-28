import {
  validateMarkdownBlocks,
  fixMarkdownIssues,
  SafeMarkdownGenerator,
  MarkdownValidationError,
} from './markdown-validator';

describe('Markdown Validator', () => {
  describe('validateMarkdownBlocks', () => {
    it('should parse simple text', () => {
      const blocks = validateMarkdownBlocks('Hello world');
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
    });

    it('should parse code block', () => {
      const blocks = validateMarkdownBlocks('```typescript\nconst x = 1;\n```');
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('code');
      expect(blocks[0].language).toBe('typescript');
    });

    it('should parse mixed content', () => {
      const content = `
Hello world

\`\`\`typescript
const x = 1;
\`\`\`

More text
      `.trim();
      
      const blocks = validateMarkdownBlocks(content);
      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('code');
      expect(blocks[2].type).toBe('text');
    });

    it('should throw on unclosed code block', () => {
      expect(() => {
        validateMarkdownBlocks('```typescript\nconst x = 1;');
      }).toThrow(MarkdownValidationError);
    });

    it('should handle multiple code blocks', () => {
      const content = `
\`\`\`ts
code1
\`\`\`

\`\`\`js
code2
\`\`\`
      `.trim();
      
      const blocks = validateMarkdownBlocks(content);
      expect(blocks.filter(b => b.type === 'code')).toHaveLength(2);
    });
  });

  describe('fixMarkdownIssues', () => {
    it('should auto-close unclosed code block', () => {
      const broken = '```typescript\nconst x = 1;';
      const fixed = fixMarkdownIssues(broken);
      expect(fixed).toContain('```');
      expect(fixed.endsWith('```')).toBe(true);
    });

    it('should normalize language to lowercase', () => {
      const broken = '```TypeScript\ncode\n```';
      const fixed = fixMarkdownIssues(broken);
      expect(fixed).toContain('```typescript');
    });

    it('should preserve valid markdown', () => {
      const valid = `
Hello

\`\`\`ts
code
\`\`\`

World
      `.trim();
      
      const fixed = fixMarkdownIssues(valid);
      expect(fixed).toBe(valid);
    });
  });

  describe('SafeMarkdownGenerator', () => {
    it('should generate valid markdown', () => {
      const md = new SafeMarkdownGenerator()
        .addText('Hello')
        .startCodeBlock('typescript')
        .addCodeLine('const x = 1;')
        .endCodeBlock()
        .addText('World')
        .toString();

      expect(() => validateMarkdownBlocks(md)).not.toThrow();
      expect(md).toContain('```typescript');
      expect(md).toContain('const x = 1;');
    });

    it('should prevent text in code block', () => {
      const md = new SafeMarkdownGenerator()
        .startCodeBlock('ts')
        .addCodeLine('code');
      
      expect(() => md.addText('text')).toThrow();
    });

    it('should validate output', () => {
      const md = new SafeMarkdownGenerator()
        .addText('Intro')
        .startCodeBlock('js')
        .addCodeLine('console.log(1)')
        .endCodeBlock();

      expect(md.validate()).toBe(true);
    });
  });
});
