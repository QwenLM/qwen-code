/**
 * QwenDream - AI-Powered Code Story Generator
 * Transforms technical documentation and code into interactive narratives
 */

import { BaseTool, ToolResult } from '@qwen-code/qwen-code-core';
import { Schema } from '@google/genai';
import { CodeStoryAnalyzer } from './analyzer.js';
import { StoryGenerator } from './generator.js';
import { InteractiveStoryServer } from './server.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface QwenDreamParams {
  action: 'analyze' | 'generate' | 'play' | 'export' | 'server';
  projectPath?: string;
  storyType?: 'adventure' | 'mystery' | 'sci-fi' | 'fantasy' | 'documentary' | 'auto';
  outputFormat?: 'html' | 'interactive' | 'game' | 'vn' | 'json';
  includeCode?: boolean;
  characterize?: boolean;
  interactiveMode?: boolean;
  voiceNarration?: boolean;
  visualNovel?: boolean;
  port?: number;
  duration?: number;
}

const QWENDREAM_SCHEMA: Schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['analyze', 'generate', 'play', 'export', 'server'],
      description: 'Action: analyze for story elements, generate narrative, play interactive story, export files, or start story server'
    },
    projectPath: {
      type: 'string',
      description: 'Path to the project directory to narrativize (defaults to current directory)'
    },
    storyType: {
      type: 'string',
      enum: ['adventure', 'mystery', 'sci-fi', 'fantasy', 'documentary', 'auto'],
      description: 'Type of story to generate (auto detects from code content)'
    },
    outputFormat: {
      type: 'string',
      enum: ['html', 'interactive', 'game', 'vn', 'json'],
      description: 'Output format: HTML story, interactive experience, game, visual novel, or JSON data'
    },
    includeCode: {
      type: 'boolean',
      description: 'Include actual code snippets in the narrative (default: true)'
    },
    characterize: {
      type: 'boolean',
      description: 'Create character profiles from functions and classes (default: true)'
    },
    interactiveMode: {
      type: 'boolean',
      description: 'Enable interactive story choices and branching paths (default: false)'
    },
    voiceNarration: {
      type: 'boolean',
      description: 'Enable text-to-speech narration (default: false)'
    },
    visualNovel: {
      type: 'boolean',
      description: 'Create visual novel style presentation (default: false)'
    },
    port: {
      type: 'number',
      description: 'Port for the story server (default: 3003)'
    },
    duration: {
      type: 'number',
      description: 'Target story duration in minutes (default: 15)'
    }
  },
  required: ['action']
};

export class QwenDreamTool extends BaseTool<QwenDreamParams, ToolResult> {
  private analyzer: CodeStoryAnalyzer;
  private generator: StoryGenerator;
  private server: InteractiveStoryServer;

  constructor() {
    super(
      'qwendream',
      'QwenDream - Code Story Generator',
      'Transform code and documentation into engaging interactive narratives',
      QWENDREAM_SCHEMA,
      true,
      true
    );
    this.analyzer = new CodeStoryAnalyzer();
    this.generator = new StoryGenerator();
    this.server = new InteractiveStoryServer();
  }

  validateToolParams(params: QwenDreamParams): string | null {
    if (!params.action) {
      return 'Action is required';
    }

    if (params.port && (params.port < 1024 || params.port > 65535)) {
      return 'Port must be between 1024 and 65535';
    }

    if (params.duration && (params.duration < 5 || params.duration > 120)) {
      return 'Duration must be between 5 and 120 minutes';
    }

    return null;
  }

  getDescription(params: QwenDreamParams): string {
    switch (params.action) {
      case 'analyze':
        return `Analyzing code for narrative elements at ${params.projectPath || 'current directory'}`;
      case 'generate':
        return `Generating ${params.storyType || 'auto-style'} story from codebase`;
      case 'play':
        return 'Starting interactive story experience';
      case 'export':
        return `Exporting story as ${params.outputFormat || 'html'} files`;
      case 'server':
        return `Starting interactive story server on port ${params.port || 3003}`;
      default:
        return 'QwenDream code-to-story conversion';
    }
  }

  async execute(
    params: QwenDreamParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    const projectPath = params.projectPath || process.cwd();
    
    try {
      switch (params.action) {
        case 'analyze':
          return await this.analyzeForStory(projectPath, params, updateOutput);
        
        case 'generate':
          return await this.generateStory(projectPath, params, updateOutput);
        
        case 'play':
          return await this.playInteractiveStory(projectPath, params, updateOutput);
        
        case 'export':
          return await this.exportStory(projectPath, params, updateOutput);
        
        case 'server':
          return await this.startStoryServer(projectPath, params, updateOutput);
        
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    } catch (error) {
      return {
        summary: `QwenDream failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        llmContent: `Error in QwenDream: ${error}`,
        returnDisplay: `📚 **QwenDream Error**\n\nFailed to execute ${params.action}: ${error}`
      };
    }
  }

  private async analyzeForStory(
    projectPath: string,
    params: QwenDreamParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('📚 Analyzing code for story elements...');
    
    const analysis = await this.analyzer.analyze(projectPath, {
      includeCode: params.includeCode ?? true,
      characterize: params.characterize ?? true,
      extractThemes: true,
      extractConflicts: true,
      extractJourney: true
    });

    const summary = `Found ${analysis.characters.length} characters, ${analysis.plotPoints.length} plot points, ${analysis.themes.length} themes`;
    
    return {
      summary,
      llmContent: `Story analysis complete: ${JSON.stringify(analysis, null, 2)}`,
      returnDisplay: this.formatStoryAnalysisDisplay(analysis)
    };
  }

  private async generateStory(
    projectPath: string,
    params: QwenDreamParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('✍️ Generating narrative from code...');
    
    const analysis = await this.analyzer.analyze(projectPath, {
      includeCode: params.includeCode ?? true,
      characterize: params.characterize ?? true
    });

    const storyOptions = {
      type: params.storyType || this.autoDetectStoryType(analysis),
      format: params.outputFormat || 'html',
      duration: params.duration || 15,
      interactive: params.interactiveMode || false,
      visualNovel: params.visualNovel || false,
      includeCode: params.includeCode ?? true
    };

    const story = await this.generator.generate(analysis, storyOptions);
    const outputPath = await this.saveStoryData(story, projectPath, storyOptions.format);
    
    return {
      summary: `Generated ${storyOptions.type} story: "${story.title}"`,
      llmContent: `Story generated: ${outputPath}`,
      returnDisplay: this.formatStoryGenerationDisplay(story, storyOptions, outputPath)
    };
  }

  private async playInteractiveStory(
    projectPath: string,
    params: QwenDreamParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎮 Starting interactive story experience...');
    
    const port = params.port || 3003;
    const serverUrl = await this.server.start(projectPath, port);
    
    // Generate and play story
    const analysis = await this.analyzer.analyze(projectPath, {});
    const storyOptions = {
      type: params.storyType || 'adventure',
      interactive: true,
      visualNovel: params.visualNovel || false,
      voiceNarration: params.voiceNarration || false
    };
    
    await this.server.loadStory(analysis, storyOptions);
    
    return {
      summary: `Interactive story started at ${serverUrl}`,
      llmContent: `Story experience running at ${serverUrl}`,
      returnDisplay: `🎮 **Interactive Story Started**\n\nServer: ${serverUrl}\nType: ${storyOptions.type}\nMode: ${params.visualNovel ? 'Visual Novel' : 'Interactive Fiction'}\n\nYour codebase has become an interactive story!\nMake choices that affect the narrative outcome.`
    };
  }

  private async exportStory(
    projectPath: string,
    params: QwenDreamParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('💾 Exporting story files...');
    
    const analysis = await this.analyzer.analyze(projectPath, {});
    const storyOptions = {
      type: params.storyType || 'auto',
      format: params.outputFormat || 'html',
      duration: params.duration || 15,
      interactive: params.interactiveMode || false,
      visualNovel: params.visualNovel || false,
      includeCode: params.includeCode ?? true
    };

    const story = await this.generator.generate(analysis, storyOptions);
    const files = await this.exportStoryFiles(story, projectPath, storyOptions);
    
    return {
      summary: `Exported ${files.length} story files`,
      llmContent: `Story files exported: ${files.join(', ')}`,
      returnDisplay: `💾 **Story Export Complete**\n\nFiles generated:\n${files.map(f => `- ${f}`).join('\n')}\n\nFormat: ${storyOptions.format}\nType: ${storyOptions.type}\nDuration: ~${storyOptions.duration} minutes\n\nYour code has been transformed into an engaging narrative!`
    };
  }

  private async startStoryServer(
    projectPath: string,
    params: QwenDreamParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('📖 Starting interactive story server...');
    
    const port = params.port || 3003;
    const serverUrl = await this.server.start(projectPath, port);
    
    return {
      summary: `QwenDream server started at ${serverUrl}`,
      llmContent: `Story server running at ${serverUrl}`,
      returnDisplay: `📖 **QwenDream Server Active**\n\nURL: ${serverUrl}\n\nFeatures:\n- Interactive story experiences\n- Visual novel mode\n- Branching narratives\n- Character development\n- Code integration\n- Voice narration\n- Multiplayer story creation\n\nTransform any codebase into an engaging story experience!`
    };
  }

  private autoDetectStoryType(analysis: any): string {
    // Auto-detect story type based on code characteristics
    if (analysis.techKeywords?.includes('AI') || analysis.techKeywords?.includes('algorithm')) return 'sci-fi';
    if (analysis.complexity?.cyclomatic > 15) return 'mystery';
    if (analysis.adventureElements > 5) return 'adventure';
    if (analysis.magicKeywords?.length > 0) return 'fantasy';
    return 'documentary';
  }

  private async saveStoryData(story: any, projectPath: string, format: string): Promise<string> {
    const outputDir = path.join(projectPath, '.qwendream');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const extension = format === 'json' ? 'json' : 'html';
    const outputFile = path.join(outputDir, `story-${timestamp}.${extension}`);
    
    if (format === 'json') {
      await fs.writeFile(outputFile, JSON.stringify(story, null, 2));
    } else {
      const html = await this.generateStoryHTML(story, format);
      await fs.writeFile(outputFile, html);
    }
    
    return outputFile;
  }

  private async exportStoryFiles(story: any, projectPath: string, options: any): Promise<string[]> {
    const outputDir = path.join(projectPath, '.qwendream');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const files: string[] = [];
    
    // Export story data
    const jsonFile = path.join(outputDir, `story-${timestamp}.json`);
    await fs.writeFile(jsonFile, JSON.stringify(story, null, 2));
    files.push(jsonFile);
    
    // Export HTML version
    const htmlFile = path.join(outputDir, `story-${timestamp}.html`);
    const html = await this.generateStoryHTML(story, options.format);
    await fs.writeFile(htmlFile, html);
    files.push(htmlFile);
    
    // Export interactive version if requested
    if (options.interactive || options.visualNovel) {
      const interactiveFile = path.join(outputDir, `interactive-${timestamp}.html`);
      const interactiveHtml = await this.generateInteractiveHTML(story, options);
      await fs.writeFile(interactiveFile, interactiveHtml);
      files.push(interactiveFile);
    }
    
    return files;
  }

  private formatStoryAnalysisDisplay(analysis: any): string {
    return `📚 **Code Story Analysis**

## Narrative Elements
- **Characters**: ${analysis.characters?.length || 0} (functions, classes, modules)
- **Plot Points**: ${analysis.plotPoints?.length || 0} (key code events)
- **Themes**: ${analysis.themes?.length || 0} (code patterns and concepts)
- **Conflicts**: ${analysis.conflicts?.length || 0} (bugs, TODOs, complexity)
- **Story Arc**: ${analysis.storyArc || 'Discovery and Resolution'}

## Character Profiles
${analysis.characters?.slice(0, 5).map((char: any) => 
  `- **${char.name}** (${char.type}): ${char.role} - ${char.description}`
).join('\n') || 'No characters identified'}

## Main Themes
${analysis.themes?.map((theme: any) => 
  `- **${theme.name}**: ${theme.description} (${theme.frequency} occurrences)`
).join('\n') || 'No themes detected'}

## Story Conflicts
${analysis.conflicts?.map((conflict: any) => 
  `- **${conflict.type}**: ${conflict.description} (${conflict.file})`
).join('\n') || 'No conflicts found'}

## Suggested Story Type
**${this.autoDetectStoryType(analysis)}** - based on code characteristics

Ready to generate story! Use \`qwendream generate\` to create your code narrative.`;
  }

  private formatStoryGenerationDisplay(story: any, options: any, outputPath: string): string {
    return `✍️ **Story Generation Complete**

## Generated Story
- **Title**: "${story.title}"
- **Type**: ${options.type}
- **Format**: ${options.format}
- **Chapters**: ${story.chapters?.length || 1}
- **Characters**: ${story.characters?.length || 0}
- **Duration**: ~${options.duration} minutes

## Story Structure
- **Opening**: ${story.opening?.title || 'Code Discovery'}
- **Rising Action**: ${story.plotPoints?.length || 0} key events
- **Climax**: ${story.climax?.title || 'The Great Debug'}
- **Resolution**: ${story.resolution?.title || 'Code Harmony'}

## Character Cast
${story.characters?.slice(0, 5).map((char: any) => 
  `- **${char.name}**: ${char.role} (based on ${char.codeOrigin})`
).join('\n') || 'Ensemble cast of code elements'}

## Technical Integration
- **Code Snippets**: ${story.codeSnippets?.length || 0} integrated
- **Interactive Elements**: ${options.interactive ? 'Yes' : 'No'}
- **Visual Novel Style**: ${options.visualNovel ? 'Yes' : 'No'}
- **Branching Paths**: ${story.choices?.length || 0}

## Output
📁 **File**: ${outputPath}

Use \`qwendream play\` to experience the interactive story or \`qwendream server\` for full experience!`;
  }

  private async generateStoryHTML(story: any, format: string): Promise<string> {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${story.title} - QwenDream Story</title>
    <style>
        body { 
            font-family: 'Georgia', serif; 
            line-height: 1.6; 
            max-width: 800px; 
            margin: 0 auto; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
        }
        .story-container {
            background: rgba(0,0,0,0.7);
            padding: 40px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
            box-shadow: 0 20px 40px rgba(0,0,0,0.3);
        }
        .story-header {
            text-align: center;
            border-bottom: 2px solid rgba(255,255,255,0.3);
            padding-bottom: 30px;
            margin-bottom: 30px;
        }
        .story-title {
            font-size: 2.5em;
            margin: 0;
            background: linear-gradient(45deg, #ffd700, #ff8c00);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .story-subtitle {
            font-size: 1.2em;
            opacity: 0.8;
            margin-top: 10px;
        }
        .chapter {
            margin-bottom: 40px;
            padding: 30px;
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            border-left: 4px solid #ffd700;
        }
        .chapter-title {
            font-size: 1.5em;
            color: #ffd700;
            margin-bottom: 20px;
            border-bottom: 1px solid rgba(255,215,0,0.3);
            padding-bottom: 10px;
        }
        .chapter-content {
            font-size: 1.1em;
            text-align: justify;
        }
        .character-intro {
            background: rgba(255,215,0,0.1);
            border: 1px solid rgba(255,215,0,0.3);
            padding: 15px;
            margin: 20px 0;
            border-radius: 8px;
        }
        .character-name {
            font-weight: bold;
            color: #ffd700;
        }
        .code-snippet {
            background: rgba(0,0,0,0.5);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 5px;
            padding: 15px;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
            margin: 20px 0;
            overflow-x: auto;
        }
        .code-snippet pre {
            margin: 0;
            color: #00ff00;
        }
        .story-meta {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 30px;
            font-size: 0.9em;
        }
        .navigation {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0,0,0,0.8);
            padding: 15px;
            border-radius: 10px;
            max-width: 200px;
        }
        .nav-item {
            display: block;
            color: #ffd700;
            text-decoration: none;
            padding: 5px 0;
            border-bottom: 1px solid rgba(255,215,0,0.2);
        }
        .nav-item:hover {
            color: white;
        }
    </style>
</head>
<body>
    <div class="navigation">
        <h4 style="margin-top: 0; color: #ffd700;">Story Navigation</h4>
        ${story.chapters?.map((chapter: any, index: number) => 
            `<a href="#chapter-${index}" class="nav-item">Chapter ${index + 1}: ${chapter.title}</a>`
        ).join('') || '<span>Single story</span>'}
    </div>

    <div class="story-container">
        <div class="story-header">
            <h1 class="story-title">${story.title}</h1>
            <p class="story-subtitle">${story.subtitle || 'A Code Adventure'}</p>
        </div>

        <div class="story-meta">
            <strong>Story Type:</strong> ${story.type}<br>
            <strong>Generated from:</strong> ${story.projectName || 'Codebase'}<br>
            <strong>Characters:</strong> ${story.characters?.length || 0}<br>
            <strong>Reading Time:</strong> ~${story.estimatedDuration || 15} minutes
        </div>

        ${story.characters?.length > 0 ? `
        <div class="chapter">
            <h2 class="chapter-title">🎭 Cast of Characters</h2>
            <div class="chapter-content">
                ${story.characters.map((char: any) => `
                    <div class="character-intro">
                        <span class="character-name">${char.name}</span> (${char.type}) - ${char.description}
                        ${char.codeSnippet ? `<div class="code-snippet"><pre>${char.codeSnippet}</pre></div>` : ''}
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}

        ${story.chapters?.map((chapter: any, index: number) => `
            <div class="chapter" id="chapter-${index}">
                <h2 class="chapter-title">Chapter ${index + 1}: ${chapter.title}</h2>
                <div class="chapter-content">
                    ${chapter.content}
                    ${chapter.codeSnippets?.map((snippet: any) => `
                        <div class="code-snippet">
                            <pre>${snippet.code}</pre>
                            <em>${snippet.context}</em>
                        </div>
                    `).join('') || ''}
                </div>
            </div>
        `).join('') || `
            <div class="chapter">
                <h2 class="chapter-title">The Code Chronicles</h2>
                <div class="chapter-content">
                    ${story.content || 'Once upon a time, in a digital realm filled with functions and variables, there lived a codebase that yearned to tell its story...'}
                </div>
            </div>
        `}

        <div class="chapter">
            <h2 class="chapter-title">📖 The End</h2>
            <div class="chapter-content">
                <p>And so concludes the tale of <strong>${story.projectName || 'this codebase'}</strong>, where every function had a purpose, every variable held meaning, and every line of code contributed to a greater narrative.</p>
                
                <p style="text-align: center; margin-top: 30px; font-style: italic; opacity: 0.8;">
                    Generated by QwenDream - Where Code Becomes Story
                </p>
            </div>
        </div>
    </div>

    <script>
        // Smooth scrolling for navigation
        document.querySelectorAll('.nav-item').forEach(link => {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                const target = document.querySelector(this.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth' });
                }
            });
        });

        // Reading progress indicator
        let progress = 0;
        window.addEventListener('scroll', () => {
            const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
            progress = (window.scrollY / scrollHeight) * 100;
            
            // Update progress in title
            document.title = \`\${Math.round(progress)}% - ${story.title}\`;
        });
    </script>
</body>
</html>`;
  }

  private async generateInteractiveHTML(story: any, options: any): Promise<string> {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${story.title} - Interactive Story</title>
    <style>
        body { 
            margin: 0; 
            background: #000; 
            color: white; 
            font-family: 'Georgia', serif; 
            overflow: hidden;
        }
        .story-game {
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .story-header {
            background: linear-gradient(90deg, #667eea, #764ba2);
            padding: 20px;
            text-align: center;
        }
        .story-content {
            flex: 1;
            display: grid;
            grid-template-columns: 1fr 300px;
            gap: 20px;
            padding: 20px;
            overflow: hidden;
        }
        .main-story {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 30px;
            overflow-y: auto;
        }
        .story-sidebar {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        .character-panel, .inventory-panel, .stats-panel {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 20px;
        }
        .choice-container {
            background: rgba(255,255,255,0.1);
            border-radius: 10px;
            padding: 20px;
            margin-top: 20px;
        }
        .choice-button {
            display: block;
            width: 100%;
            padding: 15px;
            margin: 10px 0;
            background: linear-gradient(45deg, #667eea, #764ba2);
            border: none;
            border-radius: 8px;
            color: white;
            font-size: 1em;
            cursor: pointer;
            transition: all 0.3s;
        }
        .choice-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
        .code-block {
            background: rgba(0,0,0,0.7);
            border: 1px solid #333;
            border-radius: 5px;
            padding: 15px;
            font-family: 'Courier New', monospace;
            margin: 15px 0;
            position: relative;
        }
        .code-block::before {
            content: '< code >';
            position: absolute;
            top: -10px;
            left: 10px;
            background: #000;
            padding: 0 10px;
            font-size: 0.8em;
            color: #667eea;
        }
        .typing-text {
            border-right: 2px solid white;
            animation: blink 1s infinite;
        }
        @keyframes blink {
            0%, 50% { border-color: transparent; }
            51%, 100% { border-color: white; }
        }
        .character-card {
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 15px;
            margin: 10px 0;
            border-left: 4px solid #667eea;
        }
        .progress-bar {
            background: rgba(255,255,255,0.2);
            height: 8px;
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            background: linear-gradient(90deg, #667eea, #764ba2);
            height: 100%;
            transition: width 0.3s;
        }
    </style>
</head>
<body>
    <div class="story-game">
        <div class="story-header">
            <h1>${story.title}</h1>
            <p>Interactive Code Adventure</p>
        </div>
        
        <div class="story-content">
            <div class="main-story">
                <div id="story-text">
                    <h2>Welcome to the Code Realm</h2>
                    <p class="typing-text" id="main-text">Once upon a time, in a digital universe where algorithms reign supreme and data flows like rivers of light, there existed a codebase unlike any other...</p>
                    
                    <div class="code-block">
                        <pre id="story-code">function beginAdventure() {
    console.log("Welcome, brave developer!");
    return "Your journey starts here...";
}</pre>
                    </div>
                </div>
                
                <div class="choice-container" id="choices" style="display: none;">
                    <h3>What do you choose?</h3>
                    <button class="choice-button" onclick="makeChoice(1)">🔍 Investigate the mysterious function</button>
                    <button class="choice-button" onclick="makeChoice(2)">🚀 Explore the data structures</button>
                    <button class="choice-button" onclick="makeChoice(3)">🛠️ Debug the ancient code</button>
                </div>
            </div>
            
            <div class="story-sidebar">
                <div class="character-panel">
                    <h3>🎭 Active Characters</h3>
                    <div id="character-list">
                        ${story.characters?.slice(0, 3).map((char: any) => `
                            <div class="character-card">
                                <strong>${char.name}</strong><br>
                                <small>${char.role}</small>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${Math.random() * 100}%"></div>
                                </div>
                            </div>
                        `).join('') || `
                            <div class="character-card">
                                <strong>MainFunction</strong><br>
                                <small>The Protagonist</small>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: 75%"></div>
                                </div>
                            </div>
                        `}
                    </div>
                </div>
                
                <div class="inventory-panel">
                    <h3>🎒 Code Arsenal</h3>
                    <div id="inventory">
                        <div>📝 Variables: <span id="var-count">5</span></div>
                        <div>🔧 Functions: <span id="func-count">12</span></div>
                        <div>🧩 Objects: <span id="obj-count">3</span></div>
                        <div>⚡ APIs: <span id="api-count">2</span></div>
                    </div>
                </div>
                
                <div class="stats-panel">
                    <h3>📊 Adventure Stats</h3>
                    <div>
                        <div>Code Health: <span id="health">100%</span></div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="health-bar" style="width: 100%"></div>
                        </div>
                        <div>Complexity: <span id="complexity">Medium</span></div>
                        <div>Progress: <span id="progress">15%</span></div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="progress-bar" style="width: 15%"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentScene = 0;
        let gameState = {
            health: 100,
            complexity: 'Medium',
            progress: 15,
            variables: 5,
            functions: 12,
            objects: 3,
            apis: 2
        };
        
        const storyData = ${JSON.stringify(story)};
        
        const scenes = [
            {
                text: "You find yourself standing before a massive repository, its directories stretching endlessly in all directions. The main branch glows with an ethereal light, beckoning you forward.",
                code: \`function exploreRepository() {
    const mysteries = findHiddenSecrets();
    return mysteries.length > 0 ? "adventure awaits" : "all is peaceful";
}\`,
                choices: [
                    { text: "🌟 Follow the main branch", effect: { progress: 10 } },
                    { text: "🌿 Explore side branches", effect: { complexity: 'High' } },
                    { text: "🔍 Search for hidden files", effect: { variables: 2 } }
                ]
            },
            {
                text: "As you venture deeper into the codebase, you encounter a series of complex algorithms. They seem to be guarding something important...",
                code: \`class GuardianAlgorithm {
    constructor(secret) {
        this.protectedData = secret;
        this.accessGranted = false;
    }
    
    challenge(solution) {
        return solution === this.protectedData ? this.unlock() : this.deny();
    }
}\`,
                choices: [
                    { text: "💻 Attempt to solve the algorithm", effect: { health: -20, functions: 3 } },
                    { text: "🤝 Try to negotiate", effect: { complexity: 'Low' } },
                    { text: "🔓 Look for alternative access", effect: { apis: 1 } }
                ]
            },
            {
                text: "Victory! You've successfully navigated the treacherous code paths and discovered the heart of the system. A beautiful, elegantly crafted core module awaits...",
                code: \`export default class CoreSystem {
    constructor() {
        this.harmony = true;
        this.performance = "optimal";
        this.bugs = [];
    }
    
    celebrate() {
        return "🎉 Adventure Complete! 🎉";
    }
}\`,
                choices: [
                    { text: "🎉 Celebrate your victory!", effect: { progress: 100 } },
                    { text: "📚 Document your journey", effect: { progress: 100 } },
                    { text: "🔄 Start a new adventure", effect: { progress: 0 } }
                ]
            }
        ];
        
        function typeText(element, text, speed = 50) {
            element.textContent = '';
            element.classList.add('typing-text');
            let i = 0;
            
            function type() {
                if (i < text.length) {
                    element.textContent += text.charAt(i);
                    i++;
                    setTimeout(type, speed);
                } else {
                    element.classList.remove('typing-text');
                    showChoices();
                }
            }
            
            type();
        }
        
        function updateCode(code) {
            document.getElementById('story-code').textContent = code;
        }
        
        function showChoices() {
            setTimeout(() => {
                document.getElementById('choices').style.display = 'block';
                updateChoices();
            }, 1000);
        }
        
        function updateChoices() {
            const choicesDiv = document.getElementById('choices');
            const scene = scenes[currentScene];
            
            choicesDiv.innerHTML = '<h3>What do you choose?</h3>';
            
            scene.choices.forEach((choice, index) => {
                const button = document.createElement('button');
                button.className = 'choice-button';
                button.textContent = choice.text;
                button.onclick = () => makeChoice(index);
                choicesDiv.appendChild(button);
            });
        }
        
        function makeChoice(choiceIndex) {
            const scene = scenes[currentScene];
            const choice = scene.choices[choiceIndex];
            
            // Apply choice effects
            Object.keys(choice.effect).forEach(key => {
                if (typeof choice.effect[key] === 'number') {
                    gameState[key] += choice.effect[key];
                } else {
                    gameState[key] = choice.effect[key];
                }
            });
            
            updateGameUI();
            
            // Move to next scene
            currentScene++;
            if (currentScene < scenes.length) {
                setTimeout(() => {
                    nextScene();
                }, 1000);
            } else {
                endGame();
            }
        }
        
        function nextScene() {
            document.getElementById('choices').style.display = 'none';
            
            const scene = scenes[currentScene];
            const textElement = document.getElementById('main-text');
            
            updateCode(scene.code);
            typeText(textElement, scene.text);
        }
        
        function updateGameUI() {
            document.getElementById('health').textContent = Math.max(0, gameState.health) + '%';
            document.getElementById('health-bar').style.width = Math.max(0, gameState.health) + '%';
            document.getElementById('complexity').textContent = gameState.complexity;
            document.getElementById('progress').textContent = Math.min(100, gameState.progress) + '%';
            document.getElementById('progress-bar').style.width = Math.min(100, gameState.progress) + '%';
            document.getElementById('var-count').textContent = gameState.variables;
            document.getElementById('func-count').textContent = gameState.functions;
            document.getElementById('obj-count').textContent = gameState.objects;
            document.getElementById('api-count').textContent = gameState.apis;
        }
        
        function endGame() {
            const textElement = document.getElementById('main-text');
            const endText = gameState.progress >= 100 ? 
                "Congratulations! You have successfully completed your code adventure. The repository is now harmonious, and you've gained valuable insights into its inner workings." :
                "Your journey ends here, but every ending is a new beginning. The codebase awaits your return when you're ready for another adventure.";
            
            typeText(textElement, endText);
            
            document.getElementById('choices').innerHTML = \`
                <h3>Adventure Complete!</h3>
                <button class="choice-button" onclick="location.reload()">🔄 Start New Adventure</button>
                <button class="choice-button" onclick="window.close()">📖 Return to Story</button>
            \`;
            document.getElementById('choices').style.display = 'block';
        }
        
        // Initialize the game
        setTimeout(() => {
            nextScene();
            updateGameUI();
        }, 2000);
    </script>
</body>
</html>`;
  }
}