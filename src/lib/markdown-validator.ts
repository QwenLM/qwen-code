/**
 * Markdown Block Validator
 * Prevents code blocks from breaking and text leaking into code
 */

export interface MarkdownBlock {
  type: 'code' | 'text';
  content: string;
  language?: string;
  lineNumber: number;
}

export class MarkdownValidationError extends Error {
  constructor(
    message: string,
    public readonly lineNumber: number,
    public readonly block: MarkdownBlock
  ) {
    super(message);
    this.name = 'MarkdownValidationError';
  }
}

/**
 * Validates that markdown code blocks are properly formatted
 */
export function validateMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];
  let inCodeBlock = false;
  let currentBlock = '';
  let currentLanguage: string | undefined;
  let blockStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const backtickMatch = line.match(/^(```+)(\w*)$/);

    if (backtickMatch) {
      const backticks = backtickMatch[1];
      const language = backtickMatch[2] || undefined;

      if (!inCodeBlock) {
        // Starting code block
        if (currentBlock.trim()) {
          blocks.push({
            type: 'text',
            content: currentBlock,
            lineNumber: blockStartLine,
          });
        }
        inCodeBlock = true;
        currentBlock = '';
        currentLanguage = language;
        blockStartLine = i;
      } else {
        // Ending code block - check if backticks match
        if (backticks.length >= 3) {
          blocks.push({
            type: 'code',
            content: currentBlock,
            language: currentLanguage,
            lineNumber: blockStartLine,
          });
          inCodeBlock = false;
          currentBlock = '';
          currentLanguage = undefined;
        }
      }
    } else {
      currentBlock += line + '\n';
    }
  }

  // Check for unclosed code block
  if (inCodeBlock) {
    throw new MarkdownValidationError(
      `Unclosed code block starting at line ${blockStartLine + 1}`,
      blockStartLine,
      {
        type: 'code',
        content: currentBlock,
        language: currentLanguage,
        lineNumber: blockStartLine,
      }
    );
  }

  // Add remaining text
  if (currentBlock.trim()) {
    blocks.push({
      type: 'text',
      content: currentBlock,
      lineNumber: blockStartLine,
    });
  }

  return blocks;
}

/**
 * Auto-fixes common markdown formatting issues
 */
export function fixMarkdownIssues(content: string): string {
  const lines = content.split('\n');
  const fixed: string[] = [];
  let inCodeBlock = false;
  let backtickCount = 3; // Default

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect code block start
    const startMatch = line.match(/^(```+)(\w*)$/);
    if (startMatch && !inCodeBlock) {
      backtickCount = startMatch[1].length;
      inCodeBlock = true;
      fixed.push(line);
      continue;
    }

    // Detect code block end
    const endMatch = line.match(/^(```+)$/);
    if (endMatch && inCodeBlock) {
      // Ensure closing backticks match opening
      fixed.push('`'.repeat(backtickCount));
      inCodeBlock = false;
      continue;
    }

    // Inside code block - preserve as-is
    if (inCodeBlock) {
      fixed.push(line);
      continue;
    }

    // Outside code block - fix common issues
    
    // Ensure language specifier is lowercase
    const langMatch = line.match(/^```(\w+)$/);
    if (langMatch) {
      const lang = langMatch[1].toLowerCase();
      fixed.push(`\`\`\`${lang}`);
      continue;
    }

    // Normal text line
    fixed.push(line);
  }

  // Auto-close unclosed code block
  if (inCodeBlock) {
    fixed.push('`'.repeat(backtickCount));
  }

  return fixed.join('\n');
}

/**
 * Safe markdown generator that prevents block breaking
 */
export class SafeMarkdownGenerator {
  private blocks: string[] = [];
  private currentBlock: string = '';
  private inCodeBlock: boolean = false;

  addText(text: string): this {
    if (this.inCodeBlock) {
      throw new Error('Cannot add text while in code block. Close code block first.');
    }
    this.currentBlock += text + '\n\n';
    return this;
  }

  startCodeBlock(language: string = ''): this {
    if (this.inCodeBlock) {
      throw new Error('Already in code block. Close previous block first.');
    }
    this.blocks.push(this.currentBlock.trim());
    this.currentBlock = '```' + language + '\n';
    this.inCodeBlock = true;
    return this;
  }

  addCodeLine(line: string): this {
    if (!this.inCodeBlock) {
      throw new Error('Not in code block. Call startCodeBlock first.');
    }
    this.currentBlock += line + '\n';
    return this;
  }

  endCodeBlock(): this {
    if (!this.inCodeBlock) {
      throw new Error('Not in code block.');
    }
    this.currentBlock += '```';
    this.blocks.push(this.currentBlock);
    this.currentBlock = '';
    this.inCodeBlock = false;
    return this;
  }

  toString(): string {
    if (this.inCodeBlock) {
      this.endCodeBlock();
    }
    if (this.currentBlock.trim()) {
      this.blocks.push(this.currentBlock.trim());
    }
    return this.blocks.filter(b => b).join('\n\n');
  }

  validate(): boolean {
    try {
      validateMarkdownBlocks(this.toString());
      return true;
    } catch {
      return false;
    }
  }
}

export default {
  validateMarkdownBlocks,
  fixMarkdownIssues,
  SafeMarkdownGenerator,
  MarkdownValidationError,
};
