/**
 * Code Mood Analyzer
 * Gives your code a personality check with AI-powered insights
 */

import { readdir, stat, readFile } from 'fs/promises';
import { join, extname, relative } from 'path';

export type MoodState = 'ecstatic' | 'happy' | 'content' | 'neutral' | 'concerned' | 'stressed' | 'overwhelmed';
export type Personality = 'witty' | 'zen' | 'coach' | 'scientist' | 'friend';

export interface MoodConfig {
  personality?: Personality;
  enableHumor?: boolean;
  trackHistory?: boolean;
  weights?: {
    quality?: number;
    tests?: number;
    complexity?: number;
    documentation?: number;
    bugs?: number;
    performance?: number;
    dependencies?: number;
  };
}

export interface MoodAnalysis {
  score: number;
  state: MoodState;
  emoji: string;
  message: string;
  breakdown: {
    quality: number;
    tests: number;
    complexity: number;
    documentation: number;
    bugs: number;
    performance: number;
    dependencies: number;
  };
  positives: string[];
  concerns: string[];
  suggestions: string[];
  wisdom: string;
  trend?: {
    previous: number;
    change: number;
    direction: 'up' | 'down' | 'stable';
  };
}

export interface CodeMetrics {
  totalFiles: number;
  totalLines: number;
  avgComplexity: number;
  testCoverage: number;
  documentedFunctions: number;
  totalFunctions: number;
  todoCount: number;
  longFunctions: number;
  dependencies: number;
}

const MOOD_EMOJIS: Record<MoodState, string> = {
  ecstatic: '😄✨',
  happy: '😊',
  content: '🙂',
  neutral: '😐',
  concerned: '😟',
  stressed: '😰',
  overwhelmed: '😱'
};

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

export class CodeMoodAnalyzer {
  private config: Required<MoodConfig>;

  constructor(config: MoodConfig = {}) {
    this.config = {
      personality: config.personality || 'witty',
      enableHumor: config.enableHumor ?? true,
      trackHistory: config.trackHistory ?? true,
      weights: {
        quality: 25,
        tests: 20,
        complexity: 15,
        documentation: 15,
        bugs: 10,
        performance: 10,
        dependencies: 5,
        ...config.weights
      }
    };
  }

  /**
   * Analyze code mood for a given path
   */
  async analyze(rootPath: string): Promise<MoodAnalysis> {
    const metrics = await this.collectMetrics(rootPath);
    const breakdown = this.calculateBreakdown(metrics);
    const score = this.calculateScore(breakdown);
    const state = this.determineState(score);
    const emoji = MOOD_EMOJIS[state];

    return {
      score,
      state,
      emoji,
      message: this.generateMessage(state, score),
      breakdown,
      positives: this.identifyPositives(breakdown, metrics),
      concerns: this.identifyConcerns(breakdown, metrics),
      suggestions: this.generateSuggestions(breakdown, metrics),
      wisdom: this.generateWisdom(state, this.config.personality)
    };
  }

  /**
   * Collect code metrics from directory
   */
  private async collectMetrics(rootPath: string): Promise<CodeMetrics> {
    const metrics: CodeMetrics = {
      totalFiles: 0,
      totalLines: 0,
      avgComplexity: 0,
      testCoverage: 0,
      documentedFunctions: 0,
      totalFunctions: 0,
      todoCount: 0,
      longFunctions: 0,
      dependencies: 0
    };

    await this.walkDirectory(rootPath, async (filePath) => {
      const ext = extname(filePath);
      if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return;

      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        metrics.totalFiles++;
        metrics.totalLines += lines.length;

        // Count TODOs
        metrics.todoCount += (content.match(/TODO|FIXME|XXX/g) || []).length;

        // Count functions
        const functionMatches = content.match(/function\s+\w+|const\s+\w+\s*=\s*\(.*?\)\s*=>/g) || [];
        metrics.totalFunctions += functionMatches.length;

        // Check for JSDoc comments
        const docMatches = content.match(/\/\*\*[\s\S]*?\*\//g) || [];
        metrics.documentedFunctions += docMatches.length;

        // Estimate complexity (simplified)
        const complexityIndicators = (content.match(/if|else|for|while|case|catch|\?\.|&&|\|\|/g) || []).length;
        metrics.avgComplexity += complexityIndicators;

        // Check for long functions (simplified - check for functions with > 50 lines)
        const functionBlocks = content.split(/function\s+\w+|const\s+\w+\s*=\s*\(.*?\)\s*=>/);
        metrics.longFunctions += functionBlocks.filter(block => block.split('\n').length > 50).length;

      } catch (err) {
        // Skip files we can't read
      }
    });

    // Calculate averages
    if (metrics.totalFiles > 0) {
      metrics.avgComplexity = metrics.avgComplexity / metrics.totalFiles;
    }

    // Estimate test coverage (check for test files)
    const testFileRatio = await this.calculateTestFileRatio(rootPath);
    metrics.testCoverage = testFileRatio * 100;

    // Count dependencies
    try {
      const packageJsonPath = join(rootPath, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };
      metrics.dependencies = Object.keys(deps).length;
    } catch {
      metrics.dependencies = 0;
    }

    return metrics;
  }

  /**
   * Walk directory recursively
   */
  private async walkDirectory(
    dirPath: string,
    callback: (filePath: string) => Promise<void>
  ): Promise<void> {
    const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

    try {
      const entries = await readdir(dirPath);

      for (const entry of entries) {
        if (ignored.has(entry)) continue;

        const fullPath = join(dirPath, entry);
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          await this.walkDirectory(fullPath, callback);
        } else if (stats.isFile()) {
          await callback(fullPath);
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }

  /**
   * Calculate test file ratio
   */
  private async calculateTestFileRatio(rootPath: string): Promise<number> {
    let totalFiles = 0;
    let testFiles = 0;

    await this.walkDirectory(rootPath, async (filePath) => {
      const ext = extname(filePath);
      if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return;

      totalFiles++;
      if (filePath.includes('.test.') || filePath.includes('.spec.')) {
        testFiles++;
      }
    });

    return totalFiles > 0 ? testFiles / totalFiles : 0;
  }

  /**
   * Calculate breakdown scores
   */
  private calculateBreakdown(metrics: CodeMetrics): MoodAnalysis['breakdown'] {
    return {
      quality: this.scoreQuality(metrics),
      tests: this.scoreTests(metrics),
      complexity: this.scoreComplexity(metrics),
      documentation: this.scoreDocumentation(metrics),
      bugs: this.scoreBugs(metrics),
      performance: this.scorePerformance(metrics),
      dependencies: this.scoreDependencies(metrics)
    };
  }

  /**
   * Score quality (0-100)
   */
  private scoreQuality(metrics: CodeMetrics): number {
    // Simple heuristic: fewer TODOs and long functions = better quality
    const todoScore = Math.max(0, 100 - (metrics.todoCount * 5));
    const lengthScore = Math.max(0, 100 - (metrics.longFunctions * 10));
    return Math.min(100, (todoScore + lengthScore) / 2);
  }

  /**
   * Score tests (0-100)
   */
  private scoreTests(metrics: CodeMetrics): number {
    return Math.min(100, metrics.testCoverage);
  }

  /**
   * Score complexity (0-100) - lower complexity is better
   */
  private scoreComplexity(metrics: CodeMetrics): number {
    // Good: avg complexity < 5, Bad: > 15
    const complexity = metrics.avgComplexity;
    if (complexity <= 5) return 100;
    if (complexity >= 15) return 40;
    return Math.max(40, 100 - ((complexity - 5) * 6));
  }

  /**
   * Score documentation (0-100)
   */
  private scoreDocumentation(metrics: CodeMetrics): number {
    if (metrics.totalFunctions === 0) return 100;
    const ratio = metrics.documentedFunctions / metrics.totalFunctions;
    return Math.min(100, ratio * 120); // Boost to reward documentation
  }

  /**
   * Score bugs (0-100) - placeholder for now
   */
  private scoreBugs(metrics: CodeMetrics): number {
    // In a real implementation, this would analyze error patterns, bug reports, etc.
    return 85 + Math.random() * 10; // Random for demo
  }

  /**
   * Score performance (0-100) - placeholder for now
   */
  private scorePerformance(metrics: CodeMetrics): number {
    // In a real implementation, this would analyze execution time, memory usage, etc.
    return 80 + Math.random() * 15; // Random for demo
  }

  /**
   * Score dependencies (0-100)
   */
  private scoreDependencies(metrics: CodeMetrics): number {
    // Fewer dependencies = better score
    // Good: < 20, Bad: > 100
    const deps = metrics.dependencies;
    if (deps <= 20) return 100;
    if (deps >= 100) return 50;
    return Math.max(50, 100 - ((deps - 20) * 0.625));
  }

  /**
   * Calculate overall score
   */
  private calculateScore(breakdown: MoodAnalysis['breakdown']): number {
    const weights = this.config.weights;
    const score =
      (breakdown.quality * weights.quality! +
        breakdown.tests * weights.tests! +
        breakdown.complexity * weights.complexity! +
        breakdown.documentation * weights.documentation! +
        breakdown.bugs * weights.bugs! +
        breakdown.performance * weights.performance! +
        breakdown.dependencies * weights.dependencies!) /
      100;

    return Math.round(Math.min(100, Math.max(0, score)));
  }

  /**
   * Determine mood state from score
   */
  private determineState(score: number): MoodState {
    if (score >= 90) return 'ecstatic';
    if (score >= 75) return 'happy';
    if (score >= 60) return 'content';
    if (score >= 40) return 'neutral';
    if (score >= 25) return 'concerned';
    if (score >= 10) return 'stressed';
    return 'overwhelmed';
  }

  /**
   * Generate mood message
   */
  private generateMessage(state: MoodState, score: number): string {
    const messages: Record<MoodState, string> = {
      ecstatic: `Perfect! Your code is living its best life! (${score}/100)`,
      happy: `Great! Your code is feeling pretty good today! (${score}/100)`,
      content: `Solid! Your code is in a good place with room for improvement. (${score}/100)`,
      neutral: `Okay. Your code needs some attention. (${score}/100)`,
      concerned: `Hmm. Your code is feeling a bit worried. Time for some TLC! (${score}/100)`,
      stressed: `Uh oh. Your code is struggling. Refactoring recommended! (${score}/100)`,
      overwhelmed: `Emergency! Your code needs immediate intervention! (${score}/100)`
    };

    return messages[state];
  }

  /**
   * Identify positive aspects
   */
  private identifyPositives(breakdown: MoodAnalysis['breakdown'], metrics: CodeMetrics): string[] {
    const positives: string[] = [];

    if (breakdown.complexity >= 80) {
      positives.push(`✓ Low cyclomatic complexity (avg: ${metrics.avgComplexity.toFixed(1)})`);
    }
    if (breakdown.tests >= 75) {
      positives.push(`✓ Good test coverage (${metrics.testCoverage.toFixed(0)}%)`);
    }
    if (breakdown.quality >= 80) {
      positives.push('✓ Clean code structure');
    }
    if (breakdown.documentation >= 70) {
      positives.push('✓ Well-documented functions');
    }
    if (breakdown.bugs >= 85) {
      positives.push('✓ Very few bugs detected');
    }

    if (positives.length === 0) {
      positives.push('✓ Your code exists! That\'s something!');
    }

    return positives;
  }

  /**
   * Identify concerns
   */
  private identifyConcerns(breakdown: MoodAnalysis['breakdown'], metrics: CodeMetrics): string[] {
    const concerns: string[] = [];

    if (breakdown.tests < 70) {
      concerns.push(`✗ Test coverage below 70% (currently ${metrics.testCoverage.toFixed(0)}%)`);
    }
    if (breakdown.documentation < 60) {
      concerns.push(`✗ Missing documentation in ${metrics.totalFunctions - metrics.documentedFunctions} functions`);
    }
    if (metrics.todoCount > 10) {
      concerns.push(`✗ ${metrics.todoCount} TODO comments need attention`);
    }
    if (metrics.longFunctions > 0) {
      concerns.push(`✗ ${metrics.longFunctions} functions exceed 50 lines`);
    }
    if (breakdown.complexity < 60) {
      concerns.push('✗ High complexity in some areas');
    }

    return concerns;
  }

  /**
   * Generate suggestions
   */
  private generateSuggestions(breakdown: MoodAnalysis['breakdown'], metrics: CodeMetrics): string[] {
    const suggestions: string[] = [];

    if (breakdown.tests < 70) {
      suggestions.push('Add more unit tests to increase coverage above 75%');
    }
    if (breakdown.documentation < 60) {
      suggestions.push('Document public APIs with JSDoc comments');
    }
    if (metrics.longFunctions > 0) {
      suggestions.push('Refactor functions over 50 lines into smaller units');
    }
    if (metrics.todoCount > 10) {
      suggestions.push('Resolve old TODOs or convert them to issues');
    }
    if (breakdown.complexity < 60) {
      suggestions.push('Simplify complex functions using the Single Responsibility Principle');
    }

    return suggestions.slice(0, 5); // Top 5 suggestions
  }

  /**
   * Generate AI wisdom based on personality
   */
  private generateWisdom(state: MoodState, personality: Personality): string {
    const wisdom: Record<Personality, Record<MoodState, string>> = {
      witty: {
        ecstatic: '"Your code is so clean, Marie Kondo would be proud! Keep sparking joy! ✨"',
        happy: '"Your code is like a well-organized desk with a few papers out of place. Almost there! 📝"',
        content: '"Your code is doing okay - like a B+ student. Time to reach for that A! 📚"',
        neutral: '"Your code is at a crossroads. Choose the path of refactoring, young padawan! 🛤️"',
        concerned: '"Houston, we have a problem. But hey, every great refactor starts with recognition! 🚀"',
        stressed: '"Your code needs a spa day! Time for some serious pampering and care. 💆"',
        overwhelmed: '"Even Rome wasn\'t refactored in a day. Start with small wins! 🏛️"'
      },
      zen: {
        ecstatic: '"The code flows like water, effortless and pure. You have achieved harmony. 🌊"',
        happy: '"Good code, like a garden, needs constant tending. You are on the path. 🌱"',
        content: '"Balance is near, but perfection is a journey, not a destination. Continue mindfully. 🧘"',
        neutral: '"In chaos, there is opportunity. Embrace the challenge before you. ⚖️"',
        concerned: '"When the code is troubled, look inward for clarity. Refactoring brings peace. 🕉️"',
        stressed: '"Even the mightiest oak was once a seed. Begin with one small change. 🌳"',
        overwhelmed: '"Breathe. Each line of code is a chance for renewal. Start fresh. 🌅"'
      },
      coach: {
        ecstatic: '"AMAZING! You\'re crushing it! This is championship-level code! 🏆"',
        happy: '"Great work, team! You\'re in the zone! Just a few more reps to perfection! 💪"',
        content: '"Solid effort! You\'re making progress! Keep pushing forward! 🎯"',
        neutral: '"Alright, time to dig deep! You\'ve got what it takes! Let\'s go! 📈"',
        concerned: '"This is where champions are made! Time to step up your game! 🥊"',
        stressed: '"No giving up! Every setback is a setup for a comeback! You got this! 🔥"',
        overwhelmed: '"Remember why you started! Break it down, tackle it piece by piece! 💯"'
      },
      scientist: {
        ecstatic: '"Hypothesis confirmed: Code quality metrics indicate optimal performance. 🔬"',
        happy: '"Analysis suggests positive trajectory. Minor optimizations recommended. 📊"',
        content: '"Data indicates moderate health. Further investigation advised. 📈"',
        neutral: '"Metrics show neutral state. Intervention suggested to prevent degradation. ⚗️"',
        concerned: '"Warning: Quality metrics declining. Immediate action recommended. ⚠️"',
        stressed: '"Critical state detected. Systematic refactoring protocol required. 🧪"',
        overwhelmed: '"Emergency protocols activated. Recommend complete architectural review. 🚨"'
      },
      friend: {
        ecstatic: '"Dude, your code is FIRE! 🔥 Seriously impressive stuff!"',
        happy: '"Hey, looking pretty good! Just a few tweaks and you\'re golden! ✨"',
        content: '"Not bad, friend! With a bit more work, this could be really great! 👍"',
        neutral: '"Okay, let\'s be real - this needs some work. But I believe in you! 💙"',
        concerned: '"Alright buddy, we need to talk about your code... Let me help! 🤝"',
        stressed: '"Whoa, this is rough. But don\'t worry - we\'ll fix this together! 👊"',
        overwhelmed: '"Okay, deep breath. We\'ve all been here. Let\'s tackle this step by step! 🫂"'
      }
    };

    return wisdom[personality][state];
  }

  /**
   * Format and display mood analysis
   */
  formatAnalysis(analysis: MoodAnalysis): string {
    let output = '';

    // Title
    output += `${COLORS.cyan}${COLORS.bright}🎭 Code Mood Analysis${COLORS.reset}\n`;
    output += '═'.repeat(60) + '\n\n';

    // Overall mood
    output += `${COLORS.bright}Overall Mood:${COLORS.reset} ${analysis.emoji} ${this.capitalize(analysis.state)} `;
    output += `${COLORS.dim}(Score: ${analysis.score}/100)${COLORS.reset}\n\n`;
    output += `${analysis.message}\n\n`;

    // Breakdown
    output += `${COLORS.bright}Mood Breakdown:${COLORS.reset}\n`;
    output += this.formatMetric('💚 Code Quality', analysis.breakdown.quality);
    output += this.formatMetric('🧪 Test Coverage', analysis.breakdown.tests);
    output += this.formatMetric('🔧 Complexity', analysis.breakdown.complexity);
    output += this.formatMetric('📝 Documentation', analysis.breakdown.documentation);
    output += this.formatMetric('🐛 Bug Density', analysis.breakdown.bugs);
    output += this.formatMetric('🚀 Performance', analysis.breakdown.performance);
    output += this.formatMetric('📦 Dependencies', analysis.breakdown.dependencies);
    output += '\n';

    // Positives
    if (analysis.positives.length > 0) {
      output += `${COLORS.green}${COLORS.bright}What\'s Making Me Happy:${COLORS.reset}\n`;
      analysis.positives.forEach(p => {
        output += `  ${COLORS.green}${p}${COLORS.reset}\n`;
      });
      output += '\n';
    }

    // Concerns
    if (analysis.concerns.length > 0) {
      output += `${COLORS.yellow}${COLORS.bright}What\'s Bothering Me:${COLORS.reset}\n`;
      analysis.concerns.forEach(c => {
        output += `  ${COLORS.yellow}${c}${COLORS.reset}\n`;
      });
      output += '\n';
    }

    // AI Wisdom
    output += `${COLORS.magenta}${COLORS.bright}AI Wisdom:${COLORS.reset}\n`;
    output += `  ${analysis.wisdom}\n\n`;

    // Suggestions
    if (analysis.suggestions.length > 0) {
      output += `${COLORS.cyan}${COLORS.bright}Suggested Actions:${COLORS.reset}\n`;
      analysis.suggestions.forEach((s, i) => {
        output += `  ${i + 1}. ${s}\n`;
      });
      output += '\n';
    }

    output += '═'.repeat(60) + '\n';
    output += `${COLORS.dim}Keep coding with ❤️  Run 'qwen-code mood --suggest' for more tips.${COLORS.reset}\n`;

    return output;
  }

  /**
   * Format metric bar
   */
  private formatMetric(label: string, value: number): string {
    const barLength = 10;
    const filled = Math.round((value / 100) * barLength);
    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

    const color = value >= 75 ? COLORS.green : value >= 50 ? COLORS.yellow : COLORS.red;

    return `  ${label.padEnd(20)} ${color}${bar}${COLORS.reset} ${value}%\n`;
  }

  /**
   * Capitalize first letter
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// CLI interface
export async function main(args: string[]): Promise<void> {
  const analyzer = new CodeMoodAnalyzer({
    personality: 'witty',
    enableHumor: true
  });

  const path = args[0] || '.';

  console.log('\n🎭 Analyzing your code\'s mood...\n');

  const analysis = await analyzer.analyze(path);
  console.log(analyzer.formatAnalysis(analysis));
}

export default CodeMoodAnalyzer;
