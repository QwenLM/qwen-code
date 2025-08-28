/**
 * QwenVerse - The Metaverse of Code
 * Synergistic combination of all QwenTools: 3D visualization, music, storytelling, VR collaboration, and generative art
 */

import { BaseTool, ToolResult } from '@qwen-code/qwen-code-core';
import { Schema } from '@google/genai';
import { QwenVizTool } from '../qwenviz/tool.js';
import { QwenMusicTool } from '../qwenmusic/tool.js';
import { QwenDreamTool } from '../qwendream/tool.js';
import { QwenSpaceTool } from '../qwenspace/tool.js';
import { QwenArtTool } from '../qwenart/tool.js';
import { MetaverseOrchestrator } from './orchestrator.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface QwenVerseParams {
  action: 'create' | 'enter' | 'host' | 'export' | 'server';
  projectPath?: string;
  verseName?: string;
  features?: string[];
  maxUsers?: number;
  environment?: 'code-city' | 'data-forest' | 'algorithm-space' | 'function-cathedral' | 'custom';
  port?: number;
  realTime?: boolean;
  immersive?: boolean;
  collaborative?: boolean;
}

const QWENVERSE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'enter', 'host', 'export', 'server'],
      description: 'Action: create metaverse, enter existing, host session, export world, or start server'
    },
    projectPath: {
      type: 'string',
      description: 'Path to the project directory to transform into a metaverse (defaults to current directory)'
    },
    verseName: {
      type: 'string',
      description: 'Name for the metaverse world (defaults to project name)'
    },
    features: {
      type: 'array',
      items: { type: 'string' },
      description: 'Metaverse features: 3d-viz, music, stories, vr-collab, art, all (default: all)'
    },
    maxUsers: {
      type: 'number',
      description: 'Maximum concurrent users in the metaverse (default: 20)'
    },
    environment: {
      type: 'string',
      enum: ['code-city', 'data-forest', 'algorithm-space', 'function-cathedral', 'custom'],
      description: 'Metaverse environment theme (default: code-city)'
    },
    port: {
      type: 'number',
      description: 'Port for the metaverse server (default: 3006)'
    },
    realTime: {
      type: 'boolean',
      description: 'Enable real-time synchronization across all features (default: true)'
    },
    immersive: {
      type: 'boolean',
      description: 'Enable full immersive VR/AR experience (default: true)'
    },
    collaborative: {
      type: 'boolean',
      description: 'Enable multi-user collaboration features (default: true)'
    }
  },
  required: ['action']
};

export class QwenVerseTool extends BaseTool<QwenVerseParams, ToolResult> {
  private vizTool: QwenVizTool;
  private musicTool: QwenMusicTool;
  private dreamTool: QwenDreamTool;
  private spaceTool: QwenSpaceTool;
  private artTool: QwenArtTool;
  private orchestrator: MetaverseOrchestrator;

  constructor() {
    super(
      'qwenverse',
      'QwenVerse - Code Metaverse',
      'Create immersive metaverse experiences combining 3D visualization, music, storytelling, VR collaboration, and generative art',
      QWENVERSE_SCHEMA,
      true,
      true
    );
    
    this.vizTool = new QwenVizTool();
    this.musicTool = new QwenMusicTool();
    this.dreamTool = new QwenDreamTool();
    this.spaceTool = new QwenSpaceTool();
    this.artTool = new QwenArtTool();
    this.orchestrator = new MetaverseOrchestrator();
  }

  validateToolParams(params: QwenVerseParams): string | null {
    if (!params.action) {
      return 'Action is required';
    }

    if (params.maxUsers && (params.maxUsers < 1 || params.maxUsers > 100)) {
      return 'Max users must be between 1 and 100';
    }

    if (params.port && (params.port < 1024 || params.port > 65535)) {
      return 'Port must be between 1024 and 65535';
    }

    return null;
  }

  getDescription(params: QwenVerseParams): string {
    switch (params.action) {
      case 'create':
        return `Creating ${params.environment || 'code-city'} metaverse from ${params.projectPath || 'current directory'}`;
      case 'enter':
        return `Entering metaverse ${params.verseName || 'default'}`;
      case 'host':
        return `Hosting metaverse session for ${params.maxUsers || 20} users`;
      case 'export':
        return 'Exporting metaverse world data and assets';
      case 'server':
        return `Starting QwenVerse metaverse server on port ${params.port || 3006}`;
      default:
        return 'QwenVerse metaverse operations';
    }
  }

  async execute(
    params: QwenVerseParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    const projectPath = params.projectPath || process.cwd();
    
    try {
      switch (params.action) {
        case 'create':
          return await this.createMetaverse(projectPath, params, updateOutput);
        
        case 'enter':
          return await this.enterMetaverse(params, updateOutput);
        
        case 'host':
          return await this.hostMetaverse(projectPath, params, updateOutput);
        
        case 'export':
          return await this.exportMetaverse(projectPath, params, updateOutput);
        
        case 'server':
          return await this.startMetaverseServer(projectPath, params, updateOutput);
        
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    } catch (error) {
      return {
        summary: `QwenVerse failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        llmContent: `Error in QwenVerse: ${error}`,
        returnDisplay: `🌌 **QwenVerse Error**\n\nFailed to execute ${params.action}: ${error}`
      };
    }
  }

  private async createMetaverse(
    projectPath: string,
    params: QwenVerseParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🌌 Creating your code metaverse...');
    
    const features = params.features || ['3d-viz', 'music', 'stories', 'vr-collab', 'art'];
    const verseName = params.verseName || path.basename(projectPath);
    
    // Orchestrate all tools to create the metaverse
    const metaverse = await this.orchestrator.createMetaverse(projectPath, {
      name: verseName,
      environment: params.environment || 'code-city',
      features,
      maxUsers: params.maxUsers || 20,
      realTime: params.realTime ?? true,
      immersive: params.immersive ?? true,
      collaborative: params.collaborative ?? true
    });

    const summary = `Created metaverse "${verseName}" with ${features.length} integrated features`;
    
    return {
      summary,
      llmContent: `Metaverse created: ${JSON.stringify(metaverse, null, 2)}`,
      returnDisplay: this.formatMetaverseCreationDisplay(metaverse, features)
    };
  }

  private async enterMetaverse(
    params: QwenVerseParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🚀 Entering the code metaverse...');
    
    const port = params.port || 3006;
    const serverUrl = await this.orchestrator.startServer(port);
    const entryUrl = `${serverUrl}/verse/${params.verseName || 'default'}`;
    
    return {
      summary: `Entered metaverse at ${entryUrl}`,
      llmContent: `Metaverse entry: ${entryUrl}`,
      returnDisplay: `🚀 **Entering QwenVerse**\n\nURL: ${entryUrl}\n\n**Experience Features:**\n- 🎨 3D code visualization with immersive navigation\n- 🎵 Dynamic music that responds to your code changes\n- 📚 Interactive stories told through your codebase\n- 🥽 VR collaboration spaces for team coding\n- 🖼️ Generative art galleries showcasing code beauty\n\n**Controls:**\n- VR: Hand controllers or gaze-based interaction\n- Desktop: Mouse + WASD + spacebar\n- Mobile: Touch gestures\n\nWelcome to the future of code exploration!`
    };
  }

  private async hostMetaverse(
    projectPath: string,
    params: QwenVerseParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎯 Hosting metaverse session...');
    
    const port = params.port || 3006;
    const session = await this.orchestrator.hostSession(projectPath, {
      maxUsers: params.maxUsers || 20,
      environment: params.environment || 'code-city',
      features: params.features || ['all'],
      collaborative: params.collaborative ?? true,
      port
    });

    return {
      summary: `Hosting metaverse session ${session.id}`,
      llmContent: `Session hosted: ${session.url}`,
      returnDisplay: `🎯 **QwenVerse Session Active**\n\nSession ID: ${session.id}\nURL: ${session.url}\nMax Users: ${session.maxUsers}\nEnvironment: ${session.environment}\n\n**Integrated Experiences:**\n- 🎨 **3D Visualization**: Navigate code in 3D space\n- 🎵 **Dynamic Music**: Your code plays as symphony\n- 📚 **Live Stories**: Code narratives unfold in real-time\n- 🥽 **VR Collaboration**: Team coding in virtual reality\n- 🖼️ **Art Generation**: Code becomes visual masterpieces\n\n**Session Features:**\n- Real-time synchronization across all tools\n- Multi-user collaboration and communication\n- Persistent world state and user progress\n- Cross-platform compatibility (VR/AR/Desktop/Mobile)\n\nShare the URL with your team for the ultimate collaborative coding experience!`
    };
  }

  private async exportMetaverse(
    projectPath: string,
    params: QwenVerseParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('💾 Exporting metaverse world...');
    
    const exportData = await this.orchestrator.exportWorld(projectPath, {
      includeAssets: true,
      includeStates: true,
      includeUserData: false,
      format: 'complete'
    });

    const files = await this.saveExportData(exportData, projectPath);
    
    return {
      summary: `Exported metaverse to ${files.length} files`,
      llmContent: `Export complete: ${files.join(', ')}`,
      returnDisplay: `💾 **Metaverse Export Complete**\n\nFiles generated:\n${files.map(f => `- ${f}`).join('\n')}\n\n**Export Contents:**\n- 3D visualization scenes and models\n- Generated music tracks and compositions\n- Interactive story data and narratives\n- VR environment configurations\n- Generative artwork and galleries\n- World state and configuration files\n\nYour code metaverse is now portable and shareable!`
    };
  }

  private async startMetaverseServer(
    projectPath: string,
    params: QwenVerseParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🌐 Starting QwenVerse metaverse server...');
    
    const port = params.port || 3006;
    const serverUrl = await this.orchestrator.startServer(port);
    
    if (params.realTime) {
      await this.orchestrator.enableRealTimeSync();
    }
    
    return {
      summary: `QwenVerse server started at ${serverUrl}`,
      llmContent: `Metaverse server running at ${serverUrl}`,
      returnDisplay: `🌐 **QwenVerse Metaverse Server Active**\n\nURL: ${serverUrl}\n\n**🌌 Welcome to the Ultimate Code Metaverse! 🌌**\n\n**Integrated Worlds:**\n- 🏙️ **Code City**: Urban landscape of your codebase\n- 🌲 **Data Forest**: Organic data structure exploration\n- 🚀 **Algorithm Space**: Futuristic computation environment\n- ⛪ **Function Cathedral**: Sacred spaces of clean code\n\n**Synergistic Features:**\n- 🎨 **3D + Music**: Navigate 3D code while hearing its melody\n- 📚 **Stories + VR**: Experience code narratives in virtual reality\n- 🖼️ **Art + Collaboration**: Create art together in shared spaces\n- 🎵 **Music + Stories**: Soundtracks dynamically adapt to narratives\n- 🥽 **VR + 3D + Art**: Immersive artistic code exploration\n\n**Advanced Capabilities:**\n- Real-time synchronization: ${params.realTime ? 'Enabled' : 'Available'}\n- Multi-user collaboration: Up to ${params.maxUsers || 20} simultaneous users\n- Cross-platform support: VR, AR, Desktop, Mobile\n- Persistent worlds: Save and restore metaverse states\n- Live code integration: Changes reflect across all experiences\n\n**The Future of Code is Here - Where Development Becomes an Art, a Story, a Symphony, and a Shared Adventure!**`
    };
  }

  private formatMetaverseCreationDisplay(metaverse: any, features: string[]): string {
    return `🌌 **QwenVerse Metaverse Created**

## Metaverse: "${metaverse.name}"
- **Environment**: ${metaverse.environment}
- **Dimensions**: Infinite (bounded by code complexity)
- **Max Users**: ${metaverse.maxUsers}
- **Features**: ${features.length} integrated experiences

## Integrated Experiences Created
${features.includes('3d-viz') || features.includes('all') ? '✅ **QwenViz**: 3D code visualization with immersive navigation' : ''}
${features.includes('music') || features.includes('all') ? '✅ **QwenMusic**: Dynamic musical soundscapes from code patterns' : ''}
${features.includes('stories') || features.includes('all') ? '✅ **QwenDream**: Interactive narratives and character development' : ''}
${features.includes('vr-collab') || features.includes('all') ? '✅ **QwenSpace**: VR collaboration environments and tools' : ''}
${features.includes('art') || features.includes('all') ? '✅ **QwenArt**: Generative art galleries and visual experiences' : ''}

## Synergistic Elements
- **Music + 3D**: Navigate code structures while hearing their melodies
- **Stories + VR**: Experience code narratives in immersive virtual reality  
- **Art + Collaboration**: Create and share artistic interpretations together
- **All + Real-time**: Every change ripples across all experiences instantly

## World Statistics
- **Code Landmarks**: ${metaverse.landmarks || 'Generated from project structure'}
- **Musical Zones**: ${metaverse.musicZones || 'Adaptive soundscapes'}
- **Story Chapters**: ${metaverse.storyChapters || 'Narrative sequences'}
- **Art Galleries**: ${metaverse.artGalleries || 'Generative exhibitions'}
- **Collaboration Spaces**: ${metaverse.collabSpaces || 'VR meeting areas'}

Your metaverse is ready! Use \`qwenverse enter\` to begin the ultimate code exploration experience.`;
  }

  private async saveExportData(exportData: any, projectPath: string): Promise<string[]> {
    const outputDir = path.join(projectPath, '.qwenverse');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const files: string[] = [];
    
    // Save main metaverse data
    const mainFile = path.join(outputDir, `metaverse-${timestamp}.json`);
    await fs.writeFile(mainFile, JSON.stringify(exportData, null, 2));
    files.push(mainFile);
    
    // Save individual component exports
    if (exportData.viz) {
      const vizFile = path.join(outputDir, `viz-export-${timestamp}.json`);
      await fs.writeFile(vizFile, JSON.stringify(exportData.viz, null, 2));
      files.push(vizFile);
    }
    
    if (exportData.music) {
      const musicFile = path.join(outputDir, `music-export-${timestamp}.json`);
      await fs.writeFile(musicFile, JSON.stringify(exportData.music, null, 2));
      files.push(musicFile);
    }
    
    // Generate metaverse viewer HTML
    const viewerFile = path.join(outputDir, `metaverse-viewer-${timestamp}.html`);
    const viewerHtml = await this.generateMetaverseViewer(exportData);
    await fs.writeFile(viewerFile, viewerHtml);
    files.push(viewerFile);
    
    return files;
  }

  private async generateMetaverseViewer(exportData: any): Promise<string> {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenVerse - Code Metaverse</title>
    <script src="https://aframe.io/releases/1.4.0/aframe.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <style>
        body { margin: 0; font-family: Arial, sans-serif; }
        #ui-overlay {
            position: fixed;
            top: 20px;
            left: 20px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 20px;
            border-radius: 10px;
            z-index: 1000;
            max-width: 300px;
        }
        .feature-btn {
            background: #4ecdc4;
            border: none;
            color: white;
            padding: 10px 15px;
            margin: 5px;
            border-radius: 5px;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <div id="ui-overlay">
        <h2>🌌 QwenVerse</h2>
        <p>Welcome to your code metaverse!</p>
        <div>
            <button class="feature-btn" onclick="activateViz()">🎨 3D Viz</button>
            <button class="feature-btn" onclick="activateMusic()">🎵 Music</button>
            <button class="feature-btn" onclick="activateStory()">📚 Story</button>
            <button class="feature-btn" onclick="activateArt()">🖼️ Art</button>
        </div>
        <p><small>Use VR headset for full immersion</small></p>
    </div>
    
    <a-scene vr-mode-ui="enabled: true" embedded style="height: 100vh;">
        <a-sky color="#1a1a2e"></a-sky>
        <a-plane position="0 0 0" rotation="-90 0 0" width="100" height="100" color="#16213e"></a-plane>
        
        <!-- Metaverse content will be dynamically loaded -->
        <a-entity id="metaverse-content"></a-entity>
        
        <a-camera position="0 1.6 3" wasd-controls look-controls>
            <a-cursor color="white"></a-cursor>
        </a-camera>
    </a-scene>
    
    <script>
        const metaverseData = ${JSON.stringify(exportData)};
        
        function activateViz() {
            console.log('Activating 3D visualization...');
            // Load 3D visualization
        }
        
        function activateMusic() {
            console.log('Activating music...');
            // Start music playback
        }
        
        function activateStory() {
            console.log('Activating story mode...');
            // Load interactive story
        }
        
        function activateArt() {
            console.log('Activating art gallery...');
            // Show art gallery
        }
        
        console.log('QwenVerse metaverse loaded:', metaverseData);
    </script>
</body>
</html>`;
  }
}