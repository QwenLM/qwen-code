/**
 * QwenViz - 3D Code Visualization & Navigation Tool
 * Uses three.js to create 3D representations of codebases
 */

import { BaseTool, ToolResult } from '@qwen-code/qwen-code-core';
import { Schema } from '@google/genai';
import { CodebaseAnalyzer } from './analyzer.js';
import { ThreeJSVisualizationServer } from './server.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface QwenVizParams {
  action: 'analyze' | 'visualize' | 'navigate' | 'server';
  projectPath?: string;
  outputFormat?: 'json' | 'html' | 'server';
  port?: number;
  depth?: number;
  includeTests?: boolean;
  includeDocs?: boolean;
}

const QWENVIZ_SCHEMA: Schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['analyze', 'visualize', 'navigate', 'server'],
      description: 'Action to perform: analyze codebase structure, create visualization, enable navigation, or start server'
    },
    projectPath: {
      type: 'string',
      description: 'Path to the project directory to visualize (defaults to current directory)'
    },
    outputFormat: {
      type: 'string',
      enum: ['json', 'html', 'server'],
      description: 'Output format for the visualization'
    },
    port: {
      type: 'number',
      description: 'Port for the visualization server (default: 3001)'
    },
    depth: {
      type: 'number',
      description: 'Maximum directory depth to analyze (default: 5)'
    },
    includeTests: {
      type: 'boolean',
      description: 'Include test files in visualization (default: true)'
    },
    includeDocs: {
      type: 'boolean',
      description: 'Include documentation files in visualization (default: true)'
    }
  },
  required: ['action']
};

export class QwenVizTool extends BaseTool<QwenVizParams, ToolResult> {
  private analyzer: CodebaseAnalyzer;
  private server: ThreeJSVisualizationServer;

  constructor() {
    super(
      'qwenviz',
      'QwenViz - 3D Code Visualizer',
      'Create interactive 3D visualizations of codebases using three.js',
      QWENVIZ_SCHEMA,
      true,
      true
    );
    this.analyzer = new CodebaseAnalyzer();
    this.server = new ThreeJSVisualizationServer();
  }

  validateToolParams(params: QwenVizParams): string | null {
    if (!params.action) {
      return 'Action is required';
    }

    if (params.port && (params.port < 1024 || params.port > 65535)) {
      return 'Port must be between 1024 and 65535';
    }

    if (params.depth && params.depth < 1) {
      return 'Depth must be at least 1';
    }

    return null;
  }

  getDescription(params: QwenVizParams): string {
    switch (params.action) {
      case 'analyze':
        return `Analyzing codebase structure at ${params.projectPath || 'current directory'}`;
      case 'visualize':
        return `Creating 3D visualization in ${params.outputFormat || 'html'} format`;
      case 'navigate':
        return 'Enabling 3D navigation interface for codebase exploration';
      case 'server':
        return `Starting 3D visualization server on port ${params.port || 3001}`;
      default:
        return 'QwenViz 3D code visualization';
    }
  }

  async execute(
    params: QwenVizParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    const projectPath = params.projectPath || process.cwd();
    
    try {
      switch (params.action) {
        case 'analyze':
          return await this.analyzeCodebase(projectPath, params, updateOutput);
        
        case 'visualize':
          return await this.createVisualization(projectPath, params, updateOutput);
        
        case 'navigate':
          return await this.enableNavigation(projectPath, params, updateOutput);
        
        case 'server':
          return await this.startServer(projectPath, params, updateOutput);
        
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    } catch (error) {
      return {
        summary: `QwenViz failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        llmContent: `Error in QwenViz: ${error}`,
        returnDisplay: `❌ **QwenViz Error**\n\nFailed to execute ${params.action}: ${error}`
      };
    }
  }

  private async analyzeCodebase(
    projectPath: string,
    params: QwenVizParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🔍 Analyzing codebase structure...');
    
    const analysis = await this.analyzer.analyze(projectPath, {
      depth: params.depth || 5,
      includeTests: params.includeTests ?? true,
      includeDocs: params.includeDocs ?? true
    });

    const summary = `Analyzed ${analysis.files.length} files in ${analysis.directories.length} directories`;
    
    return {
      summary,
      llmContent: `Codebase analysis complete: ${JSON.stringify(analysis, null, 2)}`,
      returnDisplay: this.formatAnalysisDisplay(analysis)
    };
  }

  private async createVisualization(
    projectPath: string,
    params: QwenVizParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎨 Creating 3D visualization...');
    
    const analysis = await this.analyzer.analyze(projectPath, {
      depth: params.depth || 5,
      includeTests: params.includeTests ?? true,
      includeDocs: params.includeDocs ?? true
    });

    const format = params.outputFormat || 'html';
    const outputPath = await this.generateVisualization(analysis, format, projectPath);
    
    return {
      summary: `Created 3D visualization at ${outputPath}`,
      llmContent: `3D visualization generated: ${outputPath}`,
      returnDisplay: `🎨 **3D Visualization Created**\n\nOutput: ${outputPath}\nFormat: ${format}\nFiles: ${analysis.files.length}\nDependencies: ${analysis.dependencies.length}`
    };
  }

  private async enableNavigation(
    projectPath: string,
    params: QwenVizParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🧭 Enabling 3D navigation...');
    
    const port = params.port || 3001;
    const serverUrl = await this.server.start(projectPath, port);
    
    return {
      summary: `3D navigation server started at ${serverUrl}`,
      llmContent: `Navigation server running at ${serverUrl}`,
      returnDisplay: `🧭 **3D Navigation Enabled**\n\nServer: ${serverUrl}\nControls:\n- Mouse: Rotate view\n- WASD: Move through code\n- Click: Select files/functions\n- Space: Jump to definition\n\nOpen in browser to explore your codebase in 3D!`
    };
  }

  private async startServer(
    projectPath: string,
    params: QwenVizParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🚀 Starting visualization server...');
    
    const port = params.port || 3001;
    const serverUrl = await this.server.start(projectPath, port);
    
    return {
      summary: `QwenViz server started at ${serverUrl}`,
      llmContent: `Visualization server running at ${serverUrl}`,
      returnDisplay: `🚀 **QwenViz Server Running**\n\nURL: ${serverUrl}\nFeatures:\n- Real-time 3D code visualization\n- Interactive dependency graphs\n- Git history layers\n- Code complexity heatmaps\n- File relationship networks\n\nServer will remain active until manually stopped.`
    };
  }

  private formatAnalysisDisplay(analysis: any): string {
    return `📊 **Codebase Analysis Results**

## Structure Overview
- **Files**: ${analysis.files.length}
- **Directories**: ${analysis.directories.length}
- **Dependencies**: ${analysis.dependencies.length}
- **Total LOC**: ${analysis.totalLines || 'N/A'}

## File Types
${Object.entries(analysis.fileTypes || {})
  .map(([ext, count]) => `- **${ext}**: ${count}`)
  .join('\n')}

## Complexity Metrics
- **Cyclomatic Complexity**: ${analysis.complexity?.cyclomatic || 'N/A'}
- **Coupling**: ${analysis.complexity?.coupling || 'N/A'}
- **Cohesion**: ${analysis.complexity?.cohesion || 'N/A'}

## Dependencies Graph
${analysis.dependencies.slice(0, 10).map((dep: any) => 
  `- ${dep.from} → ${dep.to} (${dep.type})`
).join('\n')}
${analysis.dependencies.length > 10 ? `\n... and ${analysis.dependencies.length - 10} more` : ''}

Ready for 3D visualization! Use \`qwenviz visualize\` to create interactive experience.`;
  }

  private async generateVisualization(analysis: any, format: string, projectPath: string): Promise<string> {
    const outputDir = path.join(projectPath, '.qwenviz');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const outputFile = path.join(outputDir, `visualization-${timestamp}.${format === 'json' ? 'json' : 'html'}`);
    
    if (format === 'json') {
      await fs.writeFile(outputFile, JSON.stringify(analysis, null, 2));
    } else {
      const html = await this.generateHTML(analysis);
      await fs.writeFile(outputFile, html);
    }
    
    return outputFile;
  }

  private async generateHTML(analysis: any): Promise<string> {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenViz - 3D Code Visualization</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <style>
        body { margin: 0; overflow: hidden; background: #000; font-family: Arial, sans-serif; }
        #info { position: absolute; top: 10px; left: 10px; color: white; z-index: 100; }
        #controls { position: absolute; bottom: 10px; left: 10px; color: white; z-index: 100; }
        canvas { display: block; }
    </style>
</head>
<body>
    <div id="info">
        <h3>QwenViz - 3D Code Visualization</h3>
        <p>Files: ${analysis.files.length} | Dependencies: ${analysis.dependencies.length}</p>
    </div>
    <div id="controls">
        <p>Controls: Mouse to rotate | WASD to move | Click to select</p>
    </div>
    
    <script>
        // Three.js 3D Visualization
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer();
        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);

        // Add lights
        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(1, 1, 1);
        scene.add(directionalLight);

        // Codebase data
        const analysisData = ${JSON.stringify(analysis)};
        
        // Create 3D nodes for files
        const fileNodes = new THREE.Group();
        analysisData.files.forEach((file, index) => {
            const geometry = new THREE.BoxGeometry(1, 1, 1);
            const material = new THREE.MeshLambertMaterial({ 
                color: getFileColor(file.extension),
                transparent: true,
                opacity: 0.8
            });
            const cube = new THREE.Mesh(geometry, material);
            
            // Position files in 3D space based on directory structure
            const x = (index % 10) * 2 - 10;
            const y = Math.floor(index / 100) * 2;
            const z = Math.floor((index % 100) / 10) * 2 - 10;
            cube.position.set(x, y, z);
            
            cube.userData = { file, type: 'file' };
            fileNodes.add(cube);
        });
        scene.add(fileNodes);

        // Create dependency connections
        const dependencyLines = new THREE.Group();
        analysisData.dependencies.forEach(dep => {
            const fromFile = analysisData.files.find(f => f.path === dep.from);
            const toFile = analysisData.files.find(f => f.path === dep.to);
            
            if (fromFile && toFile) {
                const fromIndex = analysisData.files.indexOf(fromFile);
                const toIndex = analysisData.files.indexOf(toFile);
                
                const fromPos = new THREE.Vector3(
                    (fromIndex % 10) * 2 - 10,
                    Math.floor(fromIndex / 100) * 2,
                    Math.floor((fromIndex % 100) / 10) * 2 - 10
                );
                const toPos = new THREE.Vector3(
                    (toIndex % 10) * 2 - 10,
                    Math.floor(toIndex / 100) * 2,
                    Math.floor((toIndex % 100) / 10) * 2 - 10
                );
                
                const geometry = new THREE.BufferGeometry().setFromPoints([fromPos, toPos]);
                const material = new THREE.LineBasicMaterial({ color: 0x00ff00, opacity: 0.5, transparent: true });
                const line = new THREE.Line(geometry, material);
                dependencyLines.add(line);
            }
        });
        scene.add(dependencyLines);

        function getFileColor(extension) {
            const colors = {
                '.js': 0xffff00,   // Yellow
                '.ts': 0x0088ff,   // Blue
                '.py': 0x00ff00,   // Green
                '.java': 0xff4400, // Orange
                '.cpp': 0xff0044,  // Red
                '.css': 0x8800ff,  // Purple
                '.html': 0xff8800, // Orange
                '.json': 0x888888, // Gray
            };
            return colors[extension] || 0xffffff;
        }

        // Camera controls
        camera.position.set(0, 10, 20);
        camera.lookAt(0, 0, 0);

        // Mouse controls
        let isMouseDown = false;
        let mouseX = 0, mouseY = 0;

        document.addEventListener('mousedown', (e) => { isMouseDown = true; mouseX = e.clientX; mouseY = e.clientY; });
        document.addEventListener('mouseup', () => isMouseDown = false);
        document.addEventListener('mousemove', (e) => {
            if (isMouseDown) {
                const deltaX = e.clientX - mouseX;
                const deltaY = e.clientY - mouseY;
                camera.position.x += deltaX * 0.01;
                camera.position.y -= deltaY * 0.01;
                mouseX = e.clientX;
                mouseY = e.clientY;
            }
        });

        // Keyboard controls
        const keys = {};
        document.addEventListener('keydown', (e) => keys[e.key.toLowerCase()] = true);
        document.addEventListener('keyup', (e) => keys[e.key.toLowerCase()] = false);

        function updateMovement() {
            const speed = 0.5;
            if (keys['w']) camera.position.z -= speed;
            if (keys['s']) camera.position.z += speed;
            if (keys['a']) camera.position.x -= speed;
            if (keys['d']) camera.position.x += speed;
        }

        // Render loop
        function animate() {
            requestAnimationFrame(animate);
            updateMovement();
            
            // Rotate file nodes for visual effect
            fileNodes.rotation.y += 0.005;
            
            renderer.render(scene, camera);
        }

        // Handle window resize
        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });

        animate();
    </script>
</body>
</html>`;
  }
}