/**
 * QwenCode Creative Extensions
 * Main entry point for all 5+1 creative tools
 */

export { QwenVizTool } from './qwenviz/tool.js';
export { QwenMusicTool } from './qwenmusic/tool.js';
export { QwenDreamTool } from './qwendream/tool.js';
export { QwenSpaceTool } from './qwenspace/tool.js';
export { QwenArtTool } from './qwenart/tool.js';
export { QwenVerseTool } from './qwenverse/tool.js';

// Export analyzers
export { CodebaseAnalyzer } from './qwenviz/analyzer.js';
export { CodeAnalyzer } from './qwenmusic/analyzer.js';
export { CodeStoryAnalyzer } from './qwendream/analyzer.js';
export { VRCodeAnalyzer } from './qwenspace/analyzer.js';
export { CodeArtAnalyzer } from './qwenart/analyzer.js';

// Export generators
export { MusicGenerator } from './qwenmusic/generator.js';
export { StoryGenerator } from './qwendream/generator.js';
export { VREnvironmentGenerator } from './qwenspace/generator.js';
export { ArtGenerator } from './qwenart/generator.js';

// Export servers
export { ThreeJSVisualizationServer } from './qwenviz/server.js';
export { MusicServer } from './qwenmusic/server.js';
export { InteractiveStoryServer } from './qwendream/server.js';
export { VRCollaborationServer } from './qwenspace/server.js';
export { ArtGalleryServer } from './qwenart/server.js';

// Main extensions registry
export const CREATIVE_EXTENSIONS = {
  qwenviz: QwenVizTool,
  qwenmusic: QwenMusicTool,
  qwendream: QwenDreamTool,
  qwenspace: QwenSpaceTool,
  qwenart: QwenArtTool,
  qwenverse: QwenVerseTool
};

/**
 * Get all creative extension tools
 */
export function getAllCreativeTools() {
  return Object.entries(CREATIVE_EXTENSIONS).map(([name, ToolClass]) => ({
    name,
    tool: new ToolClass(),
    description: getToolDescription(name)
  }));
}

/**
 * Get tool description
 */
function getToolDescription(toolName: string): string {
  const descriptions = {
    qwenviz: '🎨 3D Code Visualization & Navigation - Navigate codebases in immersive 3D with three.js',
    qwenmusic: '🎵 AI Code-to-Music Synthesizer - Transform code patterns into beautiful music',
    qwendream: '📚 AI-Powered Code Story Generator - Create interactive narratives from code',
    qwenspace: '🥽 Virtual Reality Code Collaboration - Multi-user VR coding environments',
    qwenart: '🖼️ Generative Code Art Gallery - Transform code into visual masterpieces',
    qwenverse: '🌌 The Metaverse of Code - Unified experience combining all creative tools'
  };
  return descriptions[toolName as keyof typeof descriptions] || 'Creative code tool';
}

/**
 * Initialize all creative extensions
 */
export async function initializeCreativeExtensions() {
  console.log('🌟 Initializing QwenCode Creative Extensions...');
  
  const tools = getAllCreativeTools();
  console.log(`✅ Loaded ${tools.length} creative tools:`);
  
  tools.forEach(({ name, description }) => {
    console.log(`  - ${name}: ${description}`);
  });
  
  return tools;
}

// Export types
export interface CreativeToolConfig {
  enabled: boolean;
  port?: number;
  realTime?: boolean;
  collaborative?: boolean;
}

export interface ExtensionsConfig {
  qwenviz?: CreativeToolConfig;
  qwenmusic?: CreativeToolConfig;
  qwendream?: CreativeToolConfig;
  qwenspace?: CreativeToolConfig;
  qwenart?: CreativeToolConfig;
  qwenverse?: CreativeToolConfig;
}

export const DEFAULT_EXTENSIONS_CONFIG: ExtensionsConfig = {
  qwenviz: { enabled: true, port: 3001, realTime: true },
  qwenmusic: { enabled: true, port: 3002, realTime: true },
  qwendream: { enabled: true, port: 3003, collaborative: true },
  qwenspace: { enabled: true, port: 3004, collaborative: true },
  qwenart: { enabled: true, port: 3005, realTime: true },
  qwenverse: { enabled: true, port: 3006, realTime: true, collaborative: true }
};