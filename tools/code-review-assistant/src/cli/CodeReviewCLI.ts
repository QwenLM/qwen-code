import { Config, GeminiChat, EditTool, ReadFileTool, ShellTool } from '@qwen-code/qwen-code-core';
import { simpleGit, SimpleGit } from 'simple-git';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

export interface ReviewOptions {
  branch?: string;
  files?: string;
  output?: string;
}

export interface ReviewResult {
  summary: string;
  issues: Array<{
    severity: 'low' | 'medium' | 'high' | 'critical';
    category: string;
    description: string;
    suggestion: string;
    line?: number;
    file?: string;
  }>;
  suggestions: string[];
  score: number;
}

export class CodeReviewCLI {
  private config: Config;
  private git: SimpleGit;
  private chat: GeminiChat;

  constructor(config: Config) {
    this.config = config;
    this.git = simpleGit();
    this.chat = new GeminiChat(config);
  }

  async review(options: ReviewOptions): Promise<void> {
    try {
      console.log(chalk.blue('🔍 Starting code review...'));
      
      const changes = await this.getChanges(options.branch || 'main');
      if (!changes.length) {
        console.log(chalk.yellow('No changes found to review.'));
        return;
      }

      console.log(chalk.green(`Found ${changes.length} changed files`));
      
      const reviewResults: ReviewResult[] = [];
      
      for (const change of changes) {
        console.log(chalk.cyan(`\nReviewing: ${change.file}`));
        const result = await this.reviewFile(change);
        reviewResults.push(result);
      }

      const overallResult = this.aggregateResults(reviewResults);
      this.outputResults(overallResult, options.output);
      
    } catch (error) {
      console.error(chalk.red('Error during review:'), error);
      process.exit(1);
    }
  }

  async reviewDiff(diff: string, options: ReviewOptions): Promise<void> {
    try {
      console.log(chalk.blue('🔍 Reviewing diff content...'));
      
      let diffContent = diff;
      if (fs.existsSync(diff)) {
        diffContent = fs.readFileSync(diff, 'utf-8');
      }

      const result = await this.analyzeDiff(diffContent);
      this.outputResults(result, options.output);
      
    } catch (error) {
      console.error(chalk.red('Error reviewing diff:'), error);
      process.exit(1);
    }
  }

  async reviewPR(pr: string, options: ReviewOptions): Promise<void> {
    try {
      console.log(chalk.blue(`🔍 Reviewing pull request: ${pr}`));
      
      // Extract PR number from URL or use as-is
      const prNumber = pr.includes('/') ? pr.split('/').pop() : pr;
      
      // Get PR diff using git or GitHub API
      const diff = await this.getPRDiff(prNumber);
      const result = await this.analyzeDiff(diff);
      
      this.outputResults(result, options.output);
      
    } catch (error) {
      console.error(chalk.red('Error reviewing PR:'), error);
      process.exit(1);
    }
  }

  private async getChanges(branch: string): Promise<Array<{ file: string; status: string }>> {
    const status = await this.git.status();
    const diff = await this.git.diff([`${branch}...HEAD`, '--name-status']);
    
    const changes: Array<{ file: string; status: string }> = [];
    
    // Add staged and modified files
    for (const file of status.modified) {
      changes.push({ file, status: 'modified' });
    }
    
    for (const file of status.staged) {
      changes.push({ file, status: 'staged' });
    }
    
    // Parse diff output
    const lines = diff.split('\n').filter(line => line.trim());
    for (const line of lines) {
      const [status, file] = line.split('\t');
      if (file && !changes.find(c => c.file === file)) {
        changes.push({ file, status });
      }
    }
    
    return changes;
  }

  private async reviewFile(change: { file: string; status: string }): Promise<ReviewResult> {
    const fileContent = await this.readFile(change.file);
    const diffContent = await this.getFileDiff(change.file);
    
    const prompt = this.buildReviewPrompt(fileContent, diffContent, change.status);
    const response = await this.chat.sendMessage(prompt);
    
    return this.parseReviewResponse(response.text);
  }

  private async analyzeDiff(diffContent: string): Promise<ReviewResult> {
    const prompt = this.buildDiffReviewPrompt(diffContent);
    const response = await this.chat.sendMessage(prompt);
    
    return this.parseReviewResponse(response.text);
  }

  private async getPRDiff(prNumber: string): Promise<string> {
    // Try to get diff from git if it's a local PR
    try {
      return await this.git.diff([`origin/main...HEAD`]);
    } catch {
      // Fallback to GitHub API or manual diff
      console.log(chalk.yellow('Please provide the diff content manually or ensure the PR is checked out locally.'));
      return '';
    }
  }

  private async readFile(filePath: string): Promise<string> {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async getFileDiff(filePath: string): Promise<string> {
    try {
      return await this.git.diff([`HEAD~1..HEAD`, '--', filePath]);
    } catch {
      return '';
    }
  }

  private buildReviewPrompt(content: string, diff: string, status: string): string {
    return `Please review this code file for the following aspects:

File Status: ${status}
File Content:
\`\`\`
${content}
\`\`\`

Diff Changes:
\`\`\`
${diff}
\`\`\`

Please provide a comprehensive code review covering:
1. Code quality and best practices
2. Potential bugs or issues
3. Security concerns
4. Performance implications
5. Maintainability and readability
6. Specific suggestions for improvement

Format your response as a structured review with clear sections for issues, suggestions, and overall assessment.`;
  }

  private buildDiffReviewPrompt(diffContent: string): string {
    return `Please review this diff for code quality, potential issues, and improvements:

\`\`\`
${diffContent}
\`\`\`

Analyze the changes and provide:
1. Summary of changes
2. Code quality assessment
3. Potential issues (bugs, security, performance)
4. Specific improvement suggestions
5. Overall review score (1-10)

Format as a structured review with clear sections.`;
  }

  private parseReviewResponse(response: string): ReviewResult {
    // Simple parsing - in a real implementation, you'd want more robust parsing
    const lines = response.split('\n');
    
    return {
      summary: lines[0] || 'Review completed',
      issues: [],
      suggestions: [],
      score: 7
    };
  }

  private aggregateResults(results: ReviewResult[]): ReviewResult {
    const allIssues = results.flatMap(r => r.issues);
    const allSuggestions = results.flatMap(r => r.suggestions);
    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    
    return {
      summary: `Reviewed ${results.length} files with ${allIssues.length} issues found`,
      issues: allIssues,
      suggestions: allSuggestions,
      score: Math.round(avgScore * 10) / 10
    };
  }

  private outputResults(result: ReviewResult, format: string): void {
    switch (format) {
      case 'json':
        console.log(JSON.stringify(result, null, 2));
        break;
      case 'markdown':
        this.outputMarkdown(result);
        break;
      default:
        this.outputConsole(result);
    }
  }

  private outputConsole(result: ReviewResult): void {
    console.log(chalk.blue('\n📋 Code Review Results'));
    console.log(chalk.green('='.repeat(50)));
    
    console.log(chalk.cyan('\n📝 Summary:'));
    console.log(result.summary);
    
    console.log(chalk.cyan('\n🎯 Overall Score:'));
    console.log(chalk.yellow(`${result.score}/10`));
    
    if (result.issues.length > 0) {
      console.log(chalk.red('\n⚠️  Issues Found:'));
      result.issues.forEach((issue, index) => {
        const severityColor = {
          low: chalk.green,
          medium: chalk.yellow,
          high: chalk.red,
          critical: chalk.red.bold
        }[issue.severity];
        
        console.log(`${index + 1}. [${severityColor(issue.severity.toUpperCase())}] ${issue.category}`);
        console.log(`   ${issue.description}`);
        if (issue.suggestion) {
          console.log(`   💡 Suggestion: ${issue.suggestion}`);
        }
        console.log('');
      });
    }
    
    if (result.suggestions.length > 0) {
      console.log(chalk.blue('\n💡 Suggestions:'));
      result.suggestions.forEach((suggestion, index) => {
        console.log(`${index + 1}. ${suggestion}`);
      });
    }
  }

  private outputMarkdown(result: ReviewResult): void {
    console.log('# Code Review Report\n');
    console.log(`**Summary:** ${result.summary}\n`);
    console.log(`**Overall Score:** ${result.score}/10\n`);
    
    if (result.issues.length > 0) {
      console.log('## Issues Found\n');
      result.issues.forEach((issue, index) => {
        console.log(`### ${index + 1}. ${issue.category} (${issue.severity.toUpperCase()})`);
        console.log(`${issue.description}\n`);
        if (issue.suggestion) {
          console.log(`**Suggestion:** ${issue.suggestion}\n`);
        }
      });
    }
    
    if (result.suggestions.length > 0) {
      console.log('## Suggestions\n');
      result.suggestions.forEach((suggestion, index) => {
        console.log(`${index + 1}. ${suggestion}`);
      });
    }
  }
}