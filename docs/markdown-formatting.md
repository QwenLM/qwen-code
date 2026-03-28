# Markdown Formatting Guide

## Problem

AI responses sometimes break markdown formatting:
- Text leaks into code blocks
- Code blocks don't close properly
- Multiple blocks get mixed up

## Solution

Use the markdown validator to prevent these issues.

### Validation

    import { validateMarkdownBlocks } from './lib/markdown-validator';

    try {
      validateMarkdownBlocks(response);
      console.log('Markdown is valid!');
    } catch (error) {
      console.error('Markdown error:', error.message);
    }

### Auto-fix

    import { fixMarkdownIssues } from './lib/markdown-validator';

    const broken = '```typescript\ncode';
    const fixed = fixMarkdownIssues(broken);
    // Result: "```typescript\ncode\n```"

### Safe Generation

    import { SafeMarkdownGenerator } from './lib/markdown-validator';

    const md = new SafeMarkdownGenerator()
      .addText('Introduction')
      .startCodeBlock('typescript')
      .addCodeLine('const x = 1;')
      .endCodeBlock()
      .addText('Conclusion')
      .toString();

This prevents:
- Adding text while in code block
- Unclosed code blocks
- Invalid markdown structure

## Best Practices

1. Always close code blocks: ``` at end
2. Use consistent backtick count (3 or more)
3. Specify language: ```typescript not just ```
4. Separate blocks with blank lines
5. Validate before sending response
