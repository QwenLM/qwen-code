/**
 * Code Story Analyzer for QwenDream
 * Extracts narrative elements, characters, and plot points from code
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

export interface StoryAnalysisOptions {
  includeCode?: boolean;
  characterize?: boolean;
  extractThemes?: boolean;
  extractConflicts?: boolean;
  extractJourney?: boolean;
}

export interface Character {
  name: string;
  type: 'function' | 'class' | 'module' | 'variable' | 'api';
  role: string;
  description: string;
  codeOrigin: string;
  file: string;
  personality?: string;
  relationships?: string[];
  codeSnippet?: string;
}

export interface PlotPoint {
  title: string;
  description: string;
  type: 'setup' | 'conflict' | 'climax' | 'resolution';
  codeContext: string;
  file: string;
  line: number;
  importance: number;
}

export interface Theme {
  name: string;
  description: string;
  frequency: number;
  examples: string[];
  codePatterns: string[];
}

export interface Conflict {
  type: 'bug' | 'todo' | 'complexity' | 'dependency' | 'performance';
  description: string;
  severity: 'low' | 'medium' | 'high';
  file: string;
  line?: number;
  context: string;
}

export interface StoryAnalysis {
  projectPath: string;
  projectName: string;
  characters: Character[];
  plotPoints: PlotPoint[];
  themes: Theme[];
  conflicts: Conflict[];
  storyArc: string;
  tone: string;
  techKeywords: string[];
  magicKeywords: string[];
  adventureElements: number;
  complexity: {
    cyclomatic: number;
    narrative: number;
  };
  files: string[];
  totalLines: number;
  documentationRatio: number;
}

export class CodeStoryAnalyzer {
  private readonly STORY_KEYWORDS = {
    adventure: ['explore', 'discover', 'journey', 'quest', 'adventure', 'navigate', 'traverse'],
    mystery: ['hidden', 'secret', 'unknown', 'mystery', 'investigate', 'find', 'search', 'solve'],
    scifi: ['AI', 'algorithm', 'neural', 'machine', 'artificial', 'quantum', 'cyber', 'digital'],
    fantasy: ['magic', 'spell', 'wizard', 'enchant', 'mystical', 'arcane', 'potion', 'charm'],
    conflict: ['error', 'exception', 'bug', 'fail', 'problem', 'issue', 'conflict', 'crisis'],
    resolution: ['fix', 'solve', 'complete', 'success', 'achieve', 'accomplish', 'finish']
  };

  async analyze(projectPath: string, options: StoryAnalysisOptions = {}): Promise<StoryAnalysis> {
    console.log('📚 Analyzing code for story elements...');

    const files = await this.findSourceFiles(projectPath);
    const projectName = path.basename(projectPath);
    
    const characters: Character[] = [];
    const plotPoints: PlotPoint[] = [];
    const themes: Theme[] = [];
    const conflicts: Conflict[] = [];
    const techKeywords: string[] = [];
    const magicKeywords: string[] = [];
    
    let totalLines = 0;
    let documentationLines = 0;
    let adventureElements = 0;

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const relativePath = path.relative(projectPath, filePath);
        const lines = content.split('\n');
        totalLines += lines.length;

        // Extract documentation
        documentationLines += this.countDocumentationLines(content);

        // Extract characters (functions, classes, modules)
        if (options.characterize !== false) {
          characters.push(...this.extractCharacters(content, relativePath));
        }

        // Extract plot points (key code events)
        plotPoints.push(...this.extractPlotPoints(content, relativePath));

        // Extract themes
        if (options.extractThemes !== false) {
          themes.push(...this.extractThemes(content, relativePath));
        }

        // Extract conflicts
        if (options.extractConflicts !== false) {
          conflicts.push(...this.extractConflicts(content, relativePath));
        }

        // Count story elements
        adventureElements += this.countAdventureElements(content);
        techKeywords.push(...this.extractTechKeywords(content));
        magicKeywords.push(...this.extractMagicKeywords(content));

      } catch (error) {
        console.warn(`Failed to analyze ${filePath}:`, error);
      }
    }

    const documentationRatio = totalLines > 0 ? documentationLines / totalLines : 0;
    const storyArc = this.determineStoryArc(plotPoints, conflicts);
    const tone = this.determineTone(themes, conflicts, techKeywords);

    return {
      projectPath,
      projectName,
      characters: this.deduplicateCharacters(characters),
      plotPoints: this.sortPlotPoints(plotPoints),
      themes: this.consolidateThemes(themes),
      conflicts: this.prioritizeConflicts(conflicts),
      storyArc,
      tone,
      techKeywords: [...new Set(techKeywords)],
      magicKeywords: [...new Set(magicKeywords)],
      adventureElements,
      complexity: {
        cyclomatic: this.calculateCyclomaticComplexity(files),
        narrative: this.calculateNarrativeComplexity(characters, plotPoints, themes)
      },
      files,
      totalLines,
      documentationRatio
    };
  }

  private async findSourceFiles(projectPath: string): Promise<string[]> {
    const patterns = [
      '**/*.{js,ts,jsx,tsx,py,java,cpp,c,cs,php,rb,go,rs,kt,swift}',
      '**/*.md',
      '**/*.txt',
      '**/README*'
    ];
    
    const allFiles: string[] = [];
    
    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: projectPath,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        nodir: true,
        absolute: true
      });
      allFiles.push(...files);
    }
    
    return [...new Set(allFiles)];
  }

  private extractCharacters(content: string, filePath: string): Character[] {
    const characters: Character[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Extract function characters
      const functionMatch = line.match(/(?:function\s+|def\s+|const\s+|let\s+|var\s+)(\w+)/);
      if (functionMatch) {
        characters.push({
          name: functionMatch[1],
          type: 'function',
          role: this.determineFunctionRole(functionMatch[1], line),
          description: this.generateCharacterDescription(functionMatch[1], 'function'),
          codeOrigin: line.trim(),
          file: filePath,
          personality: this.inferPersonality(functionMatch[1], line),
          codeSnippet: this.extractCodeSnippet(lines, index)
        });
      }

      // Extract class characters
      const classMatch = line.match(/class\s+(\w+)/);
      if (classMatch) {
        characters.push({
          name: classMatch[1],
          type: 'class',
          role: this.determineClassRole(classMatch[1], line),
          description: this.generateCharacterDescription(classMatch[1], 'class'),
          codeOrigin: line.trim(),
          file: filePath,
          personality: this.inferPersonality(classMatch[1], line),
          codeSnippet: this.extractCodeSnippet(lines, index, 5)
        });
      }

      // Extract important variables as characters
      const varMatch = line.match(/(?:const|let|var)\s+([A-Z]\w+)/);
      if (varMatch) {
        characters.push({
          name: varMatch[1],
          type: 'variable',
          role: 'Supporting Character',
          description: this.generateCharacterDescription(varMatch[1], 'variable'),
          codeOrigin: line.trim(),
          file: filePath,
          codeSnippet: line.trim()
        });
      }
    });

    return characters;
  }

  private extractPlotPoints(content: string, filePath: string): PlotPoint[] {
    const plotPoints: PlotPoint[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Main function/entry point as setup
      if (line.includes('main(') || line.includes('function main') || line.includes('export default')) {
        plotPoints.push({
          title: 'The Beginning',
          description: 'Our story begins with the main entry point',
          type: 'setup',
          codeContext: line.trim(),
          file: filePath,
          line: index + 1,
          importance: 10
        });
      }

      // Error handling as conflict
      if (line.includes('try') || line.includes('catch') || line.includes('except')) {
        plotPoints.push({
          title: 'The Challenge',
          description: 'A potential problem arises that must be handled',
          type: 'conflict',
          codeContext: line.trim(),
          file: filePath,
          line: index + 1,
          importance: 8
        });
      }

      // Return statements as resolution
      if (line.includes('return') && !line.includes('//')) {
        plotPoints.push({
          title: 'The Resolution',
          description: 'A solution is provided',
          type: 'resolution',
          codeContext: line.trim(),
          file: filePath,
          line: index + 1,
          importance: 6
        });
      }

      // Complex algorithms as climax
      if (line.includes('algorithm') || line.includes('sort') || line.includes('search')) {
        plotPoints.push({
          title: 'The Great Challenge',
          description: 'A complex algorithm presents the ultimate test',
          type: 'climax',
          codeContext: line.trim(),
          file: filePath,
          line: index + 1,
          importance: 9
        });
      }
    });

    return plotPoints;
  }

  private extractThemes(content: string, filePath: string): Theme[] {
    const themes: Theme[] = [];
    const themePatterns = {
      'Growth and Learning': ['learn', 'grow', 'improve', 'evolve', 'develop', 'progress'],
      'Problem Solving': ['solve', 'fix', 'resolve', 'debug', 'optimize', 'improve'],
      'Collaboration': ['share', 'collaborate', 'team', 'together', 'merge', 'sync'],
      'Innovation': ['create', 'innovate', 'new', 'novel', 'creative', 'invent'],
      'Persistence': ['retry', 'persist', 'continue', 'keep', 'maintain', 'endure'],
      'Transformation': ['transform', 'convert', 'change', 'modify', 'adapt', 'evolve']
    };

    Object.entries(themePatterns).forEach(([themeName, keywords]) => {
      const frequency = keywords.reduce((count, keyword) => {
        const regex = new RegExp(`\\b${keyword}\\w*`, 'gi');
        const matches = content.match(regex);
        return count + (matches ? matches.length : 0);
      }, 0);

      if (frequency > 0) {
        themes.push({
          name: themeName,
          description: this.generateThemeDescription(themeName),
          frequency,
          examples: this.findThemeExamples(content, keywords),
          codePatterns: keywords
        });
      }
    });

    return themes;
  }

  private extractConflicts(content: string, filePath: string): Conflict[] {
    const conflicts: Conflict[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // TODO comments as conflicts
      if (line.includes('TODO') || line.includes('FIXME') || line.includes('XXX')) {
        conflicts.push({
          type: 'todo',
          description: line.trim(),
          severity: line.includes('FIXME') ? 'high' : 'medium',
          file: filePath,
          line: index + 1,
          context: line.trim()
        });
      }

      // Bug-related comments
      if (line.includes('bug') || line.includes('error') || line.includes('broken')) {
        conflicts.push({
          type: 'bug',
          description: 'Potential bug identified in comments',
          severity: 'high',
          file: filePath,
          line: index + 1,
          context: line.trim()
        });
      }

      // Complex code as complexity conflict
      if (this.isComplexLine(line)) {
        conflicts.push({
          type: 'complexity',
          description: 'High complexity code that may need refactoring',
          severity: 'medium',
          file: filePath,
          line: index + 1,
          context: line.trim()
        });
      }
    });

    return conflicts;
  }

  private countDocumentationLines(content: string): number {
    const lines = content.split('\n');
    return lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || 
             trimmed.startsWith('#') || 
             trimmed.startsWith('/*') || 
             trimmed.startsWith('*') ||
             trimmed.startsWith('"""') ||
             trimmed.startsWith("'''");
    }).length;
  }

  private countAdventureElements(content: string): number {
    let count = 0;
    Object.values(this.STORY_KEYWORDS).forEach(keywords => {
      keywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\w*`, 'gi');
        const matches = content.match(regex);
        count += matches ? matches.length : 0;
      });
    });
    return count;
  }

  private extractTechKeywords(content: string): string[] {
    const techKeywords = ['AI', 'API', 'algorithm', 'database', 'server', 'client', 'network', 'machine learning', 'neural', 'quantum'];
    const found: string[] = [];
    
    techKeywords.forEach(keyword => {
      if (content.toLowerCase().includes(keyword.toLowerCase())) {
        found.push(keyword);
      }
    });
    
    return found;
  }

  private extractMagicKeywords(content: string): string[] {
    const magicKeywords = ['magic', 'spell', 'wizard', 'enchant', 'mystical', 'transform', 'potion'];
    const found: string[] = [];
    
    magicKeywords.forEach(keyword => {
      if (content.toLowerCase().includes(keyword.toLowerCase())) {
        found.push(keyword);
      }
    });
    
    return found;
  }

  private determineFunctionRole(name: string, line: string): string {
    if (name.toLowerCase().includes('main')) return 'The Protagonist';
    if (name.toLowerCase().includes('init')) return 'The Creator';
    if (name.toLowerCase().includes('handle') || name.toLowerCase().includes('process')) return 'The Problem Solver';
    if (name.toLowerCase().includes('get') || name.toLowerCase().includes('fetch')) return 'The Gatherer';
    if (name.toLowerCase().includes('validate') || name.toLowerCase().includes('check')) return 'The Guardian';
    if (name.toLowerCase().includes('transform') || name.toLowerCase().includes('convert')) return 'The Transformer';
    return 'Supporting Character';
  }

  private determineClassRole(name: string, line: string): string {
    if (name.toLowerCase().includes('manager') || name.toLowerCase().includes('service')) return 'The Leader';
    if (name.toLowerCase().includes('controller') || name.toLowerCase().includes('handler')) return 'The Controller';
    if (name.toLowerCase().includes('model') || name.toLowerCase().includes('data')) return 'The Keeper of Knowledge';
    if (name.toLowerCase().includes('view') || name.toLowerCase().includes('component')) return 'The Presenter';
    if (name.toLowerCase().includes('util') || name.toLowerCase().includes('helper')) return 'The Wise Helper';
    return 'Noble Entity';
  }

  private generateCharacterDescription(name: string, type: string): string {
    const descriptions = {
      function: [
        `${name} is a reliable function who always delivers results when called upon.`,
        `Known for their efficiency, ${name} handles complex tasks with grace.`,
        `${name} is the go-to function when precision and accuracy are needed.`
      ],
      class: [
        `${name} is a sophisticated class with many capabilities and responsibilities.`,
        `As a guardian of data and behavior, ${name} maintains order in the code realm.`,
        `${name} represents a complex entity with multiple facets and deep knowledge.`
      ],
      variable: [
        `${name} is a constant companion, always holding important information.`,
        `Reliable and unchanging, ${name} provides stability to the codebase.`,
        `${name} serves as a beacon of consistency in an ever-changing digital world.`
      ]
    };

    const options = descriptions[type as keyof typeof descriptions] || descriptions.function;
    return options[Math.floor(Math.random() * options.length)];
  }

  private inferPersonality(name: string, line: string): string {
    if (name.toLowerCase().includes('async') || line.includes('async')) return 'Patient and Methodical';
    if (name.toLowerCase().includes('quick') || name.toLowerCase().includes('fast')) return 'Energetic and Swift';
    if (name.toLowerCase().includes('safe') || name.toLowerCase().includes('secure')) return 'Cautious and Protective';
    if (name.toLowerCase().includes('smart') || name.toLowerCase().includes('intelligent')) return 'Wise and Thoughtful';
    return 'Dependable and Steady';
  }

  private extractCodeSnippet(lines: string[], startIndex: number, contextLines: number = 3): string {
    const start = Math.max(0, startIndex - 1);
    const end = Math.min(lines.length, startIndex + contextLines);
    return lines.slice(start, end).join('\n');
  }

  private generateThemeDescription(themeName: string): string {
    const descriptions = {
      'Growth and Learning': 'The journey of continuous improvement and knowledge acquisition',
      'Problem Solving': 'The heroic quest to overcome obstacles and find solutions',
      'Collaboration': 'The power of working together toward common goals',
      'Innovation': 'The spark of creativity that drives new discoveries',
      'Persistence': 'The determination to continue despite challenges',
      'Transformation': 'The magical process of change and evolution'
    };
    return descriptions[themeName as keyof typeof descriptions] || 'A recurring theme in the codebase';
  }

  private findThemeExamples(content: string, keywords: string[]): string[] {
    const examples: string[] = [];
    const lines = content.split('\n');
    
    lines.forEach(line => {
      keywords.forEach(keyword => {
        if (line.toLowerCase().includes(keyword.toLowerCase()) && examples.length < 3) {
          examples.push(line.trim());
        }
      });
    });
    
    return [...new Set(examples)];
  }

  private isComplexLine(line: string): boolean {
    const complexityIndicators = [
      /\{\s*\{.*\}\s*\}/, // Nested objects
      /\[\s*\[.*\]\s*\]/, // Nested arrays
      /\w+\.\w+\.\w+\.\w+/, // Deep property access
      /\?\s*:.*\?\s*:/, // Nested ternary
      /&&.*\|\|.*&&/, // Complex boolean logic
    ];
    
    return complexityIndicators.some(pattern => pattern.test(line));
  }

  private deduplicateCharacters(characters: Character[]): Character[] {
    const seen = new Set<string>();
    return characters.filter(char => {
      const key = `${char.name}-${char.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private sortPlotPoints(plotPoints: PlotPoint[]): PlotPoint[] {
    const typeOrder = { 'setup': 1, 'conflict': 2, 'climax': 3, 'resolution': 4 };
    return plotPoints.sort((a, b) => {
      const typeComparison = typeOrder[a.type] - typeOrder[b.type];
      if (typeComparison !== 0) return typeComparison;
      return b.importance - a.importance;
    });
  }

  private consolidateThemes(themes: Theme[]): Theme[] {
    const consolidated = new Map<string, Theme>();
    
    themes.forEach(theme => {
      if (consolidated.has(theme.name)) {
        const existing = consolidated.get(theme.name)!;
        existing.frequency += theme.frequency;
        existing.examples.push(...theme.examples);
      } else {
        consolidated.set(theme.name, theme);
      }
    });
    
    return Array.from(consolidated.values())
      .sort((a, b) => b.frequency - a.frequency);
  }

  private prioritizeConflicts(conflicts: Conflict[]): Conflict[] {
    const severityOrder = { 'high': 3, 'medium': 2, 'low': 1 };
    return conflicts.sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]);
  }

  private determineStoryArc(plotPoints: PlotPoint[], conflicts: Conflict[]): string {
    if (conflicts.length > plotPoints.length) return 'Overcoming Adversity';
    if (plotPoints.filter(p => p.type === 'climax').length > 2) return 'Epic Adventure';
    if (plotPoints.filter(p => p.type === 'resolution').length > plotPoints.filter(p => p.type === 'conflict').length) {
      return 'Journey to Success';
    }
    return 'Discovery and Growth';
  }

  private determineTone(themes: Theme[], conflicts: Conflict[], techKeywords: string[]): string {
    if (techKeywords.includes('AI') || techKeywords.includes('quantum')) return 'Futuristic and Technical';
    if (conflicts.length > themes.length) return 'Dramatic and Challenging';
    if (themes.some(t => t.name.includes('Collaboration'))) return 'Collaborative and Hopeful';
    if (themes.some(t => t.name.includes('Innovation'))) return 'Creative and Inspiring';
    return 'Thoughtful and Methodical';
  }

  private calculateCyclomaticComplexity(files: string[]): number {
    // Simplified complexity calculation
    return Math.min(10, files.length / 10);
  }

  private calculateNarrativeComplexity(characters: Character[], plotPoints: PlotPoint[], themes: Theme[]): number {
    const characterScore = Math.min(characters.length / 5, 3);
    const plotScore = Math.min(plotPoints.length / 10, 3);
    const themeScore = Math.min(themes.length / 3, 3);
    return Math.round((characterScore + plotScore + themeScore) * 10) / 10;
  }
}