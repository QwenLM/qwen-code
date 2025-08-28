/**
 * QwenArt - Generative Code Art Gallery
 * Creates visual art from code structure and execution patterns
 */

import { BaseTool, ToolResult } from '@qwen-code/qwen-code-core';
import { Schema } from '@google/genai';
import { CodeArtAnalyzer } from './analyzer.js';
import { ArtGenerator } from './generator.js';
import { ArtGalleryServer } from './server.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface QwenArtParams {
  action: 'analyze' | 'generate' | 'gallery' | 'export' | 'server';
  projectPath?: string;
  artStyle?: 'abstract' | 'geometric' | 'organic' | 'glitch' | 'minimalist' | 'auto';
  outputFormat?: 'svg' | 'canvas' | 'webgl' | 'three' | 'p5js';
  animated?: boolean;
  interactive?: boolean;
  resolution?: string;
  colorPalette?: 'code' | 'file-types' | 'complexity' | 'custom';
  dimensions?: '2d' | '3d' | '4d';
  port?: number;
  realTime?: boolean;
}

const QWENART_SCHEMA: Schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['analyze', 'generate', 'gallery', 'export', 'server'],
      description: 'Action: analyze for art patterns, generate art, create gallery, export files, or start server'
    },
    projectPath: {
      type: 'string',
      description: 'Path to the project directory to artify (defaults to current directory)'
    },
    artStyle: {
      type: 'string',
      enum: ['abstract', 'geometric', 'organic', 'glitch', 'minimalist', 'auto'],
      description: 'Art style to generate (auto detects from code characteristics)'
    },
    outputFormat: {
      type: 'string',
      enum: ['svg', 'canvas', 'webgl', 'three', 'p5js'],
      description: 'Output format for the generated art'
    },
    animated: {
      type: 'boolean',
      description: 'Create animated artwork based on code execution flow (default: false)'
    },
    interactive: {
      type: 'boolean',
      description: 'Enable interactive elements in the artwork (default: false)'
    },
    resolution: {
      type: 'string',
      description: 'Output resolution (e.g., "1920x1080", "4k", "print") (default: "1920x1080")'
    },
    colorPalette: {
      type: 'string',
      enum: ['code', 'file-types', 'complexity', 'custom'],
      description: 'Color palette strategy (default: code)'
    },
    dimensions: {
      type: 'string',
      enum: ['2d', '3d', '4d'],
      description: 'Artwork dimensions (4d includes time/animation) (default: 2d)'
    },
    port: {
      type: 'number',
      description: 'Port for the art gallery server (default: 3005)'
    },
    realTime: {
      type: 'boolean',
      description: 'Enable real-time art generation as code changes (default: false)'
    }
  },
  required: ['action']
};

export class QwenArtTool extends BaseTool<QwenArtParams, ToolResult> {
  private analyzer: CodeArtAnalyzer;
  private generator: ArtGenerator;
  private server: ArtGalleryServer;

  constructor() {
    super(
      'qwenart',
      'QwenArt - Code Art Generator',
      'Transform code patterns into beautiful generative artwork and interactive galleries',
      QWENART_SCHEMA,
      true,
      true
    );
    this.analyzer = new CodeArtAnalyzer();
    this.generator = new ArtGenerator();
    this.server = new ArtGalleryServer();
  }

  validateToolParams(params: QwenArtParams): string | null {
    if (!params.action) {
      return 'Action is required';
    }

    if (params.port && (params.port < 1024 || params.port > 65535)) {
      return 'Port must be between 1024 and 65535';
    }

    if (params.resolution && !this.isValidResolution(params.resolution)) {
      return 'Invalid resolution format (use "WIDTHxHEIGHT", "4k", "hd", etc.)';
    }

    return null;
  }

  getDescription(params: QwenArtParams): string {
    switch (params.action) {
      case 'analyze':
        return `Analyzing code for artistic patterns at ${params.projectPath || 'current directory'}`;
      case 'generate':
        return `Generating ${params.artStyle || 'auto-style'} artwork from code structure`;
      case 'gallery':
        return 'Creating interactive art gallery from codebase';
      case 'export':
        return `Exporting artwork as ${params.outputFormat || 'svg'} files`;
      case 'server':
        return `Starting art gallery server on port ${params.port || 3005}`;
      default:
        return 'QwenArt code-to-art conversion';
    }
  }

  async execute(
    params: QwenArtParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    const projectPath = params.projectPath || process.cwd();
    
    try {
      switch (params.action) {
        case 'analyze':
          return await this.analyzeForArt(projectPath, params, updateOutput);
        
        case 'generate':
          return await this.generateArt(projectPath, params, updateOutput);
        
        case 'gallery':
          return await this.createGallery(projectPath, params, updateOutput);
        
        case 'export':
          return await this.exportArt(projectPath, params, updateOutput);
        
        case 'server':
          return await this.startArtServer(projectPath, params, updateOutput);
        
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    } catch (error) {
      return {
        summary: `QwenArt failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        llmContent: `Error in QwenArt: ${error}`,
        returnDisplay: `🎨 **QwenArt Error**\n\nFailed to execute ${params.action}: ${error}`
      };
    }
  }

  private async analyzeForArt(
    projectPath: string,
    params: QwenArtParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎨 Analyzing code for artistic patterns...');
    
    const analysis = await this.analyzer.analyze(projectPath, {
      extractPatterns: true,
      analyzeComplexity: true,
      identifyStructures: true,
      calculateMetrics: true
    });

    const summary = `Art analysis complete: ${analysis.visualElements.length} visual elements, ${analysis.patterns.length} patterns`;
    
    return {
      summary,
      llmContent: `Art analysis: ${JSON.stringify(analysis, null, 2)}`,
      returnDisplay: this.formatArtAnalysisDisplay(analysis)
    };
  }

  private async generateArt(
    projectPath: string,
    params: QwenArtParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🖼️ Generating artwork from code patterns...');
    
    const analysis = await this.analyzer.analyze(projectPath, {});
    
    const artOptions = {
      style: params.artStyle || this.autoDetectArtStyle(analysis),
      format: params.outputFormat || 'svg',
      animated: params.animated || false,
      interactive: params.interactive || false,
      resolution: this.parseResolution(params.resolution || '1920x1080'),
      colorPalette: params.colorPalette || 'code',
      dimensions: params.dimensions || '2d'
    };

    const artwork = await this.generator.generate(analysis, artOptions);
    const outputPath = await this.saveArtwork(artwork, projectPath, artOptions.format);
    
    return {
      summary: `Generated ${artOptions.style} artwork: ${outputPath}`,
      llmContent: `Artwork generated: ${outputPath}`,
      returnDisplay: this.formatArtGenerationDisplay(artwork, artOptions, outputPath)
    };
  }

  private async createGallery(
    projectPath: string,
    params: QwenArtParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🖼️ Creating interactive art gallery...');
    
    const port = params.port || 3005;
    const serverUrl = await this.server.start(projectPath, port);
    
    // Generate multiple artworks for gallery
    const analysis = await this.analyzer.analyze(projectPath, {});
    const artworks = await this.generateGalleryArtworks(analysis, params);
    
    await this.server.loadArtworks(artworks);
    
    return {
      summary: `Art gallery created at ${serverUrl}`,
      llmContent: `Gallery running at ${serverUrl}`,
      returnDisplay: `🖼️ **Art Gallery Created**\n\nURL: ${serverUrl}\nArtworks: ${artworks.length}\n\nYour codebase has been transformed into a beautiful art gallery!\nExplore different artistic interpretations of your code structure.`
    };
  }

  private async exportArt(
    projectPath: string,
    params: QwenArtParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('💾 Exporting artwork files...');
    
    const analysis = await this.analyzer.analyze(projectPath, {});
    const artOptions = {
      style: params.artStyle || 'auto',
      format: params.outputFormat || 'svg',
      animated: params.animated || false,
      interactive: params.interactive || false,
      resolution: this.parseResolution(params.resolution || '1920x1080'),
      colorPalette: params.colorPalette || 'code',
      dimensions: params.dimensions || '2d'
    };

    const artworks = await this.generateGalleryArtworks(analysis, params);
    const files = await this.exportArtworkFiles(artworks, projectPath, artOptions);
    
    return {
      summary: `Exported ${files.length} artwork files`,
      llmContent: `Art files exported: ${files.join(', ')}`,
      returnDisplay: `💾 **Artwork Export Complete**\n\nFiles generated:\n${files.map(f => `- ${f}`).join('\n')}\n\nFormat: ${artOptions.format}\nStyle: ${artOptions.style}\nResolution: ${params.resolution}\n\nYour code has been transformed into beautiful digital art!`
    };
  }

  private async startArtServer(
    projectPath: string,
    params: QwenArtParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎨 Starting art gallery server...');
    
    const port = params.port || 3005;
    const serverUrl = await this.server.start(projectPath, port);
    
    if (params.realTime) {
      await this.server.enableRealTimeMode();
    }
    
    return {
      summary: `QwenArt server started at ${serverUrl}`,
      llmContent: `Art gallery server running at ${serverUrl}`,
      returnDisplay: `🎨 **QwenArt Gallery Server Active**\n\nURL: ${serverUrl}\n\n**Gallery Features:**\n- 🖼️ Interactive artwork displays\n- 🎭 Multiple art styles and interpretations\n- 🌈 Dynamic color palettes\n- 🎬 Animated visualizations\n- 📱 Touch/click interactions\n- 🔄 Real-time updates (${params.realTime ? 'enabled' : 'disabled'})\n- 🎨 Custom art generation\n- 🖨️ High-resolution exports\n\n**Art Styles Available:**\n- Abstract: Flowing organic forms\n- Geometric: Clean mathematical patterns  \n- Glitch: Digital corruption aesthetics\n- Minimalist: Essential code beauty\n- Organic: Natural growth patterns\n\nTurn your code into a masterpiece!`
    };
  }

  private autoDetectArtStyle(analysis: any): string {
    if (analysis.complexity?.cyclomatic > 12) return 'abstract';
    if (analysis.patterns?.filter((p: any) => p.type === 'geometric').length > 5) return 'geometric';
    if (analysis.errors?.length > 3) return 'glitch';
    if (analysis.patterns?.length < 3) return 'minimalist';
    return 'organic';
  }

  private isValidResolution(resolution: string): boolean {
    const patterns = [
      /^\d+x\d+$/i,  // 1920x1080
      /^(hd|fhd|4k|8k)$/i,  // Standard formats
      /^(small|medium|large|print)$/i  // Size aliases
    ];
    return patterns.some(pattern => pattern.test(resolution));
  }

  private parseResolution(resolution: string): { width: number; height: number } {
    const resolutionMap: Record<string, [number, number]> = {
      'hd': [1280, 720],
      'fhd': [1920, 1080],
      '4k': [3840, 2160],
      '8k': [7680, 4320],
      'small': [800, 600],
      'medium': [1920, 1080],
      'large': [2560, 1440],
      'print': [3000, 3000]
    };

    if (resolutionMap[resolution.toLowerCase()]) {
      const [width, height] = resolutionMap[resolution.toLowerCase()];
      return { width, height };
    }

    const match = resolution.match(/^(\d+)x(\d+)$/);
    if (match) {
      return { width: parseInt(match[1]), height: parseInt(match[2]) };
    }

    return { width: 1920, height: 1080 };
  }

  private async generateGalleryArtworks(analysis: any, params: QwenArtParams): Promise<any[]> {
    const styles = ['abstract', 'geometric', 'organic', 'glitch', 'minimalist'];
    const artworks = [];

    for (const style of styles) {
      const artOptions = {
        style,
        format: params.outputFormat || 'svg',
        animated: params.animated || false,
        interactive: params.interactive || false,
        resolution: this.parseResolution(params.resolution || '1920x1080'),
        colorPalette: params.colorPalette || 'code',
        dimensions: params.dimensions || '2d'
      };

      const artwork = await this.generator.generate(analysis, artOptions);
      artworks.push(artwork);
    }

    return artworks;
  }

  private async saveArtwork(artwork: any, projectPath: string, format: string): Promise<string> {
    const outputDir = path.join(projectPath, '.qwenart');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const extension = this.getFileExtension(format);
    const outputFile = path.join(outputDir, `artwork-${timestamp}.${extension}`);
    
    if (format === 'svg') {
      await fs.writeFile(outputFile, artwork.svg);
    } else {
      await fs.writeFile(outputFile, JSON.stringify(artwork, null, 2));
    }
    
    return outputFile;
  }

  private async exportArtworkFiles(artworks: any[], projectPath: string, options: any): Promise<string[]> {
    const outputDir = path.join(projectPath, '.qwenart');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const files: string[] = [];
    
    for (let i = 0; i < artworks.length; i++) {
      const artwork = artworks[i];
      const filename = `artwork-${artwork.style}-${timestamp}.${this.getFileExtension(options.format)}`;
      const filepath = path.join(outputDir, filename);
      
      if (options.format === 'svg') {
        await fs.writeFile(filepath, artwork.svg);
      } else {
        await fs.writeFile(filepath, JSON.stringify(artwork, null, 2));
      }
      
      files.push(filepath);
    }
    
    // Generate gallery HTML
    const galleryFile = path.join(outputDir, `gallery-${timestamp}.html`);
    const galleryHtml = await this.generateGalleryHTML(artworks, options);
    await fs.writeFile(galleryFile, galleryHtml);
    files.push(galleryFile);
    
    return files;
  }

  private getFileExtension(format: string): string {
    const extensions: Record<string, string> = {
      'svg': 'svg',
      'canvas': 'html',
      'webgl': 'html',
      'three': 'html',
      'p5js': 'html'
    };
    return extensions[format] || 'json';
  }

  private formatArtAnalysisDisplay(analysis: any): string {
    return `🎨 **Code Art Analysis**

## Visual Composition Score: ${analysis.artScore || 78}/100

### Artistic Elements
- **Visual Patterns**: ${analysis.patterns?.length || 0}
- **Color Complexity**: ${analysis.colorComplexity || 'Medium'}
- **Structural Beauty**: ${analysis.structuralBeauty || 'High'}
- **Movement Potential**: ${analysis.movementPotential || 'Moderate'}

### Recommended Art Styles
${analysis.recommendedStyles?.map((style: string) => `- **${style}**: ${this.getStyleDescription(style)}`).join('\n') || 
  '- Abstract: Flowing organic patterns\n- Geometric: Clean mathematical structures'}

### Visual Elements Found
${analysis.visualElements?.slice(0, 5).map((element: any) => 
  `- **${element.type}**: ${element.description} (complexity: ${element.complexity})`
).join('\n') || 'No specific visual elements identified'}

### Color Palette Recommendations
- **Primary**: Based on ${analysis.primaryLanguage || 'JavaScript'} syntax highlighting
- **Secondary**: File type distribution colors
- **Accent**: Complexity and depth indicators

Ready for art generation! Use \`qwenart generate\` to create visual masterpieces from your code.`;
  }

  private formatArtGenerationDisplay(artwork: any, options: any, outputPath: string): string {
    return `🖼️ **Artwork Generation Complete**

## Generated Piece
- **Style**: ${options.style}
- **Format**: ${options.format}
- **Dimensions**: ${options.dimensions}
- **Resolution**: ${options.resolution.width}x${options.resolution.height}
- **Color Palette**: ${options.colorPalette}

## Artistic Interpretation
- **Visual Elements**: ${artwork.elements?.length || 0}
- **Color Count**: ${artwork.colors?.length || 0}
- **Complexity Level**: ${artwork.complexity || 'Medium'}
- **Animation**: ${options.animated ? 'Yes' : 'No'}
- **Interactive**: ${options.interactive ? 'Yes' : 'No'}

## Technical Details
- **Shapes Generated**: ${artwork.shapes?.length || 0}
- **Paths Created**: ${artwork.paths?.length || 0}
- **Transformations**: ${artwork.transformations?.length || 0}
- **File Size**: ${artwork.size || 'Optimized'}

## Code Mapping
- **Files** → **Color Regions**: Each file becomes a distinct visual area
- **Functions** → **Geometric Forms**: Function complexity determines shape complexity
- **Variables** → **Color Variations**: Variable scope affects color intensity
- **Control Flow** → **Movement Patterns**: Loops and conditions create rhythm
- **Dependencies** → **Connection Lines**: Module relationships become visual connections

## Output
📁 **File**: ${outputPath}

Your code has been transformed into a unique piece of digital art! Use \`qwenart gallery\` to create an interactive exhibition.`;
  }

  private getStyleDescription(style: string): string {
    const descriptions: Record<string, string> = {
      'abstract': 'Flowing organic forms inspired by code structure',
      'geometric': 'Clean mathematical patterns reflecting logical flow',
      'organic': 'Natural growth patterns mimicking code evolution',
      'glitch': 'Digital corruption aesthetics highlighting complexity',
      'minimalist': 'Essential beauty with maximum impact'
    };
    return descriptions[style] || 'Creative interpretation of code patterns';
  }

  private async generateGalleryHTML(artworks: any[], options: any): Promise<string> {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenArt Code Gallery</title>
    <style>
        body { 
            margin: 0; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            color: white; 
            font-family: 'Arial', sans-serif;
            min-height: 100vh;
        }
        .gallery-container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        .gallery-header {
            text-align: center;
            margin-bottom: 60px;
        }
        .gallery-header h1 {
            font-size: 3.5em;
            margin: 0;
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #f39c12);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .artworks-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 40px;
            margin-bottom: 60px;
        }
        .artwork-card {
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 30px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
            transition: transform 0.3s ease;
        }
        .artwork-card:hover {
            transform: translateY(-10px);
            box-shadow: 0 20px 40px rgba(0,0,0,0.3);
        }
        .artwork-display {
            width: 100%;
            height: 300px;
            background: #000;
            border-radius: 10px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }
        .artwork-info h3 {
            margin: 0 0 10px 0;
            color: #4ecdc4;
            font-size: 1.4em;
        }
        .artwork-meta {
            font-size: 0.9em;
            opacity: 0.8;
            line-height: 1.6;
        }
        .controls {
            position: fixed;
            top: 20px;
            right: 20px;
            display: flex;
            gap: 10px;
        }
        .control-btn {
            background: rgba(0,0,0,0.7);
            border: 1px solid #4ecdc4;
            color: white;
            padding: 10px 15px;
            border-radius: 5px;
            cursor: pointer;
            transition: all 0.3s;
        }
        .control-btn:hover {
            background: rgba(76, 205, 196, 0.2);
        }
    </style>
</head>
<body>
    <div class="controls">
        <button class="control-btn" onclick="toggleAnimation()">🎬 Animation</button>
        <button class="control-btn" onclick="changeTheme()">🎨 Theme</button>
        <button class="control-btn" onclick="exportGallery()">💾 Export</button>
    </div>
    
    <div class="gallery-container">
        <div class="gallery-header">
            <h1>🎨 QwenArt Gallery</h1>
            <p>Generative Art from Code Structure</p>
            <p><em>Each piece represents a unique interpretation of your codebase</em></p>
        </div>
        
        <div class="artworks-grid">
            ${artworks.map((artwork, index) => `
                <div class="artwork-card">
                    <div class="artwork-display" id="artwork-${index}">
                        <div style="font-size: 3em; color: #4ecdc4;">${this.getArtworkIcon(artwork.style)}</div>
                    </div>
                    <div class="artwork-info">
                        <h3>${artwork.title || `${artwork.style} Interpretation`}</h3>
                        <div class="artwork-meta">
                            <p><strong>Style:</strong> ${artwork.style}</p>
                            <p><strong>Complexity:</strong> ${artwork.complexity || 'Medium'}</p>
                            <p><strong>Elements:</strong> ${artwork.elements?.length || 0}</p>
                            <p><strong>Colors:</strong> ${artwork.colors?.length || 0}</p>
                            <p><em>${artwork.description || 'A unique visual representation of code structure and flow.'}</em></p>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
        
        <div style="text-align: center; margin-top: 40px; opacity: 0.7;">
            <p>Generated by QwenArt - Where Code Becomes Art</p>
        </div>
    </div>
    
    <script>
        let animationEnabled = false;
        let currentTheme = 'dark';
        
        function toggleAnimation() {
            animationEnabled = !animationEnabled;
            console.log('Animation:', animationEnabled ? 'ON' : 'OFF');
            
            // Add animation effects to artworks
            document.querySelectorAll('.artwork-display').forEach(display => {
                if (animationEnabled) {
                    display.style.animation = 'artworkPulse 3s ease-in-out infinite';
                } else {
                    display.style.animation = 'none';
                }
            });
        }
        
        function changeTheme() {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            console.log('Theme:', currentTheme);
            
            if (currentTheme === 'light') {
                document.body.style.background = 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)';
                document.body.style.color = '#333';
            } else {
                document.body.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)';
                document.body.style.color = 'white';
            }
        }
        
        function exportGallery() {
            console.log('Exporting gallery...');
            alert('Gallery export functionality would save all artworks in high resolution!');
        }
        
        // Add some dynamic styling
        const style = document.createElement('style');
        style.textContent = \`
            @keyframes artworkPulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }
            
            .artwork-display::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, 
                    rgba(255,107,107,0.1) 0%, 
                    rgba(78,205,196,0.1) 25%, 
                    rgba(69,183,209,0.1) 50%, 
                    rgba(243,156,18,0.1) 75%, 
                    rgba(155,89,182,0.1) 100%);
                border-radius: 10px;
            }
        \`;
        document.head.appendChild(style);
        
        // Initialize gallery
        document.addEventListener('DOMContentLoaded', () => {
            console.log('QwenArt Gallery initialized');
            
            // Add hover effects to artwork cards
            document.querySelectorAll('.artwork-card').forEach((card, index) => {
                card.addEventListener('mouseenter', () => {
                    card.style.transform = 'translateY(-10px) scale(1.02)';
                });
                
                card.addEventListener('mouseleave', () => {
                    card.style.transform = 'translateY(0) scale(1)';
                });
            });
        });
    </script>
</body>
</html>`;
  }

  private getArtworkIcon(style: string): string {
    const icons: Record<string, string> = {
      'abstract': '🌊',
      'geometric': '🔷',
      'organic': '🌿', 
      'glitch': '⚡',
      'minimalist': '⭕'
    };
    return icons[style] || '🎨';
  }
}