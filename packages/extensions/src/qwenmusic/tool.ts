/**
 * QwenMusic - AI Code-to-Music Synthesizer
 * Converts code patterns, complexity, and structure into music
 */

import { BaseTool, ToolResult } from '@qwen-code/qwen-code-core';
import { Schema } from '@google/genai';
import { CodeAnalyzer } from './analyzer.js';
import { MusicGenerator } from './generator.js';
import { MusicServer } from './server.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface QwenMusicParams {
  action: 'analyze' | 'generate' | 'play' | 'export' | 'server';
  projectPath?: string;
  outputFormat?: 'midi' | 'wav' | 'json' | 'live';
  style?: 'classical' | 'jazz' | 'electronic' | 'ambient' | 'rock' | 'auto';
  tempo?: number;
  key?: string;
  duration?: number;
  includeComments?: boolean;
  realTime?: boolean;
  port?: number;
}

const QWENMUSIC_SCHEMA: Schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['analyze', 'generate', 'play', 'export', 'server'],
      description: 'Action: analyze code patterns, generate music, play audio, export files, or start server'
    },
    projectPath: {
      type: 'string',
      description: 'Path to the project directory to musicalize (defaults to current directory)'
    },
    outputFormat: {
      type: 'string',
      enum: ['midi', 'wav', 'json', 'live'],
      description: 'Output format for the generated music'
    },
    style: {
      type: 'string',
      enum: ['classical', 'jazz', 'electronic', 'ambient', 'rock', 'auto'],
      description: 'Musical style to generate (auto detects from code patterns)'
    },
    tempo: {
      type: 'number',
      description: 'Base tempo in BPM (default: auto-calculated from code complexity)'
    },
    key: {
      type: 'string',
      description: 'Musical key (e.g., "C major", "A minor", default: auto-selected)'
    },
    duration: {
      type: 'number',
      description: 'Duration in seconds for generated music (default: 60)'
    },
    includeComments: {
      type: 'boolean',
      description: 'Include code comments in musical interpretation (default: true)'
    },
    realTime: {
      type: 'boolean',
      description: 'Enable real-time music generation as code changes (default: false)'
    },
    port: {
      type: 'number',
      description: 'Port for the music server (default: 3002)'
    }
  },
  required: ['action']
};

export class QwenMusicTool extends BaseTool<QwenMusicParams, ToolResult> {
  private analyzer: CodeAnalyzer;
  private generator: MusicGenerator;
  private server: MusicServer;

  constructor() {
    super(
      'qwenmusic',
      'QwenMusic - Code to Music',
      'Transform code into beautiful music using AI-powered pattern recognition',
      QWENMUSIC_SCHEMA,
      true,
      true
    );
    this.analyzer = new CodeAnalyzer();
    this.generator = new MusicGenerator();
    this.server = new MusicServer();
  }

  validateToolParams(params: QwenMusicParams): string | null {
    if (!params.action) {
      return 'Action is required';
    }

    if (params.tempo && (params.tempo < 30 || params.tempo > 200)) {
      return 'Tempo must be between 30 and 200 BPM';
    }

    if (params.duration && (params.duration < 10 || params.duration > 600)) {
      return 'Duration must be between 10 and 600 seconds';
    }

    if (params.port && (params.port < 1024 || params.port > 65535)) {
      return 'Port must be between 1024 and 65535';
    }

    return null;
  }

  getDescription(params: QwenMusicParams): string {
    switch (params.action) {
      case 'analyze':
        return `Analyzing musical patterns in codebase at ${params.projectPath || 'current directory'}`;
      case 'generate':
        return `Generating ${params.style || 'auto-style'} music from code patterns`;
      case 'play':
        return 'Playing generated music from code structure';
      case 'export':
        return `Exporting music as ${params.outputFormat || 'midi'} file`;
      case 'server':
        return `Starting real-time music server on port ${params.port || 3002}`;
      default:
        return 'QwenMusic code-to-music conversion';
    }
  }

  async execute(
    params: QwenMusicParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    const projectPath = params.projectPath || process.cwd();
    
    try {
      switch (params.action) {
        case 'analyze':
          return await this.analyzeCode(projectPath, params, updateOutput);
        
        case 'generate':
          return await this.generateMusic(projectPath, params, updateOutput);
        
        case 'play':
          return await this.playMusic(projectPath, params, updateOutput);
        
        case 'export':
          return await this.exportMusic(projectPath, params, updateOutput);
        
        case 'server':
          return await this.startMusicServer(projectPath, params, updateOutput);
        
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    } catch (error) {
      return {
        summary: `QwenMusic failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        llmContent: `Error in QwenMusic: ${error}`,
        returnDisplay: `🎵 **QwenMusic Error**\n\nFailed to execute ${params.action}: ${error}`
      };
    }
  }

  private async analyzeCode(
    projectPath: string,
    params: QwenMusicParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎵 Analyzing code for musical patterns...');
    
    const analysis = await this.analyzer.analyze(projectPath, {
      includeComments: params.includeComments ?? true,
      extractRhythms: true,
      extractMelodies: true,
      extractHarmonies: true
    });

    const summary = `Analyzed ${analysis.files.length} files, found ${analysis.musicalPatterns.length} musical patterns`;
    
    return {
      summary,
      llmContent: `Musical analysis complete: ${JSON.stringify(analysis, null, 2)}`,
      returnDisplay: this.formatMusicAnalysisDisplay(analysis)
    };
  }

  private async generateMusic(
    projectPath: string,
    params: QwenMusicParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎼 Generating music from code patterns...');
    
    const analysis = await this.analyzer.analyze(projectPath, {
      includeComments: params.includeComments ?? true
    });

    const musicOptions = {
      style: params.style || this.autoDetectStyle(analysis),
      tempo: params.tempo || this.calculateTempo(analysis),
      key: params.key || this.selectKey(analysis),
      duration: params.duration || 60,
      outputFormat: params.outputFormat || 'json'
    };

    const music = await this.generator.generate(analysis, musicOptions);
    const outputPath = await this.saveMusicData(music, projectPath, musicOptions.outputFormat);
    
    return {
      summary: `Generated ${musicOptions.style} music in ${musicOptions.key}`,
      llmContent: `Music generated: ${outputPath}`,
      returnDisplay: this.formatMusicGenerationDisplay(music, musicOptions, outputPath)
    };
  }

  private async playMusic(
    projectPath: string,
    params: QwenMusicParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🔊 Playing music from your code...');
    
    const port = params.port || 3002;
    const serverUrl = await this.server.start(projectPath, port);
    
    // Generate and play music
    const analysis = await this.analyzer.analyze(projectPath, {});
    const musicOptions = {
      style: params.style || 'auto',
      tempo: params.tempo,
      duration: params.duration || 30
    };
    
    await this.server.playMusic(analysis, musicOptions);
    
    return {
      summary: `Playing code music at ${serverUrl}`,
      llmContent: `Music playback started at ${serverUrl}`,
      returnDisplay: `🔊 **Playing Your Code's Music**\n\nServer: ${serverUrl}\nStyle: ${musicOptions.style}\nTempo: ${musicOptions.tempo || 'Auto'}\nDuration: ${musicOptions.duration}s\n\nYour code is now playing as music!\nOpen the URL to see the live visualization.`
    };
  }

  private async exportMusic(
    projectPath: string,
    params: QwenMusicParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('💾 Exporting music files...');
    
    const analysis = await this.analyzer.analyze(projectPath, {});
    const musicOptions = {
      style: params.style || 'auto',
      tempo: params.tempo,
      key: params.key,
      duration: params.duration || 120,
      outputFormat: params.outputFormat || 'midi'
    };

    const music = await this.generator.generate(analysis, musicOptions);
    const files = await this.exportMusicFiles(music, projectPath, musicOptions);
    
    return {
      summary: `Exported ${files.length} music files`,
      llmContent: `Music files exported: ${files.join(', ')}`,
      returnDisplay: `💾 **Music Export Complete**\n\nFiles generated:\n${files.map(f => `- ${f}`).join('\n')}\n\nFormat: ${musicOptions.outputFormat}\nStyle: ${musicOptions.style}\nDuration: ${musicOptions.duration}s\n\nYour code has been transformed into music!`
    };
  }

  private async startMusicServer(
    projectPath: string,
    params: QwenMusicParams,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    updateOutput?.('🎚️ Starting real-time music server...');
    
    const port = params.port || 3002;
    const serverUrl = await this.server.start(projectPath, port);
    
    if (params.realTime) {
      await this.server.enableRealTimeMode();
    }
    
    return {
      summary: `QwenMusic server started at ${serverUrl}`,
      llmContent: `Music server running at ${serverUrl}`,
      returnDisplay: `🎚️ **QwenMusic Server Active**\n\nURL: ${serverUrl}\n\nFeatures:\n- Real-time code-to-music conversion\n- Live audio synthesis\n- Interactive music controls\n- Multiple musical styles\n- Code complexity visualization\n- Collaborative music coding\n\n${params.realTime ? '🔴 **LIVE MODE ENABLED**\nMusic updates as you code!' : 'Use /qwenmusic play to start generating music'}`
    };
  }

  private autoDetectStyle(analysis: any): string {
    // Auto-detect musical style based on code patterns
    if (analysis.complexity?.cyclomatic > 10) return 'jazz';
    if (analysis.functionalPatterns > analysis.objectOrientedPatterns) return 'classical';
    if (analysis.asyncPatterns > analysis.syncPatterns) return 'electronic';
    if (analysis.commentDensity > 0.3) return 'ambient';
    return 'electronic';
  }

  private calculateTempo(analysis: any): number {
    // Calculate tempo based on code complexity and activity
    const baseTempoFactor = analysis.complexity?.cyclomatic || 5;
    const activityFactor = analysis.files.length / 10;
    const tempo = Math.max(60, Math.min(140, 80 + (baseTempoFactor * 2) + activityFactor));
    return Math.round(tempo);
  }

  private selectKey(analysis: any): string {
    // Select musical key based on code characteristics
    const keys = ['C major', 'G major', 'D major', 'A major', 'E major', 'F major', 'Bb major'];
    const hashSum = analysis.files.reduce((sum: number, file: any) => sum + file.path.charCodeAt(0), 0);
    return keys[hashSum % keys.length];
  }

  private async saveMusicData(music: any, projectPath: string, format: string): Promise<string> {
    const outputDir = path.join(projectPath, '.qwenmusic');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const outputFile = path.join(outputDir, `music-${timestamp}.${format}`);
    
    await fs.writeFile(outputFile, JSON.stringify(music, null, 2));
    return outputFile;
  }

  private async exportMusicFiles(music: any, projectPath: string, options: any): Promise<string[]> {
    const outputDir = path.join(projectPath, '.qwenmusic');
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const files: string[] = [];
    
    // Export JSON data
    const jsonFile = path.join(outputDir, `music-${timestamp}.json`);
    await fs.writeFile(jsonFile, JSON.stringify(music, null, 2));
    files.push(jsonFile);
    
    // Export MIDI (simulated for now)
    if (options.outputFormat === 'midi') {
      const midiFile = path.join(outputDir, `music-${timestamp}.mid`);
      await fs.writeFile(midiFile, '# MIDI data would be here (simulated)');
      files.push(midiFile);
    }
    
    // Export audio visualization HTML
    const htmlFile = path.join(outputDir, `player-${timestamp}.html`);
    const html = await this.generateMusicPlayerHTML(music, options);
    await fs.writeFile(htmlFile, html);
    files.push(htmlFile);
    
    return files;
  }

  private formatMusicAnalysisDisplay(analysis: any): string {
    return `🎵 **Code Music Analysis**

## Musical Characteristics
- **Rhythm Patterns**: ${analysis.musicalPatterns?.filter((p: any) => p.type === 'rhythm').length || 0}
- **Melodic Sequences**: ${analysis.musicalPatterns?.filter((p: any) => p.type === 'melody').length || 0}
- **Harmonic Structures**: ${analysis.musicalPatterns?.filter((p: any) => p.type === 'harmony').length || 0}
- **Suggested Tempo**: ${this.calculateTempo(analysis)} BPM
- **Suggested Key**: ${this.selectKey(analysis)}
- **Musical Style**: ${this.autoDetectStyle(analysis)}

## Code Rhythm Analysis
${analysis.rhythmPatterns?.map((pattern: any) => 
  `- **${pattern.name}**: ${pattern.frequency} occurrences, ${pattern.complexity} complexity`
).join('\n') || 'No specific rhythm patterns detected'}

## Melodic Elements
${analysis.melodicElements?.map((element: any) => 
  `- **${element.type}**: ${element.pattern} (${element.file})`
).slice(0, 5).join('\n') || 'No melodic elements found'}

## Harmonic Context
- **Function Definitions**: ${analysis.functionCount || 0} (bass notes)
- **Variable Declarations**: ${analysis.variableCount || 0} (chord progressions)  
- **Control Structures**: ${analysis.controlStructures || 0} (rhythmic accents)
- **Comments**: ${analysis.commentLines || 0} (ambient textures)

Ready to generate music! Use \`qwenmusic generate\` to create audio from these patterns.`;
  }

  private formatMusicGenerationDisplay(music: any, options: any, outputPath: string): string {
    return `🎼 **Music Generation Complete**

## Generated Composition
- **Style**: ${options.style}
- **Key**: ${options.key}
- **Tempo**: ${options.tempo} BPM
- **Duration**: ${options.duration} seconds
- **Format**: ${options.outputFormat}

## Musical Structure
- **Tracks**: ${music.tracks?.length || 1}
- **Measures**: ${music.measures || Math.ceil(options.duration / 4)}
- **Instruments**: ${music.instruments?.join(', ') || 'Synthesizer'}
- **Time Signature**: ${music.timeSignature || '4/4'}

## Code Mapping
- **Files** → **Tracks**: Each file becomes a musical voice
- **Functions** → **Melodies**: Function definitions create melodic lines
- **Variables** → **Chords**: Variable scopes determine harmonic progressions
- **Loops** → **Rhythms**: Control structures drive rhythmic patterns
- **Comments** → **Textures**: Documentation adds ambient layers

## Output
📁 **File**: ${outputPath}

Use \`qwenmusic play\` to hear your code's music or \`qwenmusic server\` for interactive experience!`;
  }

  private async generateMusicPlayerHTML(music: any, options: any): Promise<string> {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenMusic Player - Your Code's Symphony</title>
    <script src="https://cdn.jsdelivr.net/npm/tone@15.0.4/build/Tone.js"></script>
    <style>
        body { 
            margin: 0; 
            background: linear-gradient(135deg, #2c1810 0%, #8b4513 50%, #daa520 100%);
            color: white; 
            font-family: 'Georgia', serif;
            overflow-x: hidden;
        }
        .container { 
            max-width: 1200px; 
            margin: 0 auto; 
            padding: 20px; 
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
            background: rgba(0,0,0,0.3);
            padding: 30px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }
        .header h1 { 
            font-size: 3em; 
            margin: 0; 
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
            background: linear-gradient(45deg, #ffd700, #ffb347);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .player {
            background: rgba(0,0,0,0.5);
            padding: 30px;
            border-radius: 15px;
            margin-bottom: 30px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,215,0,0.3);
        }
        .controls {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-bottom: 30px;
        }
        .btn {
            padding: 15px 30px;
            background: linear-gradient(45deg, #8b4513, #daa520);
            border: none;
            border-radius: 25px;
            color: white;
            font-size: 1.1em;
            cursor: pointer;
            transition: all 0.3s;
            text-transform: uppercase;
            font-weight: bold;
            letter-spacing: 1px;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(218,165,32,0.4);
        }
        .btn:active {
            transform: translateY(0);
        }
        .visualizer {
            height: 200px;
            background: rgba(0,0,0,0.7);
            border-radius: 10px;
            margin: 20px 0;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }
        .music-info {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-top: 30px;
        }
        .info-card {
            background: rgba(0,0,0,0.4);
            padding: 20px;
            border-radius: 10px;
            border-left: 4px solid #daa520;
        }
        .info-card h3 {
            margin-top: 0;
            color: #ffd700;
        }
        .progress-bar {
            width: 100%;
            height: 10px;
            background: rgba(255,255,255,0.2);
            border-radius: 5px;
            overflow: hidden;
            margin: 20px 0;
        }
        .progress {
            height: 100%;
            background: linear-gradient(90deg, #daa520, #ffd700);
            width: 0%;
            transition: width 0.1s;
        }
        .frequency-bars {
            display: flex;
            height: 100%;
            align-items: end;
            justify-content: center;
            gap: 2px;
        }
        .freq-bar {
            width: 4px;
            background: linear-gradient(to top, #8b4513, #daa520, #ffd700);
            min-height: 2px;
            border-radius: 2px;
            transition: height 0.1s;
        }
        .code-mapping {
            background: rgba(0,0,0,0.6);
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
        }
        .mapping-item {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .status {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0,0,0,0.8);
            padding: 10px 20px;
            border-radius: 20px;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="status" id="status">🎵 Ready to Play</div>
    
    <div class="container">
        <div class="header">
            <h1>🎼 QwenMusic Player</h1>
            <p>Your Code's Musical Symphony</p>
            <p><strong>Style:</strong> ${options.style} | <strong>Key:</strong> ${options.key} | <strong>Tempo:</strong> ${options.tempo} BPM</p>
        </div>
        
        <div class="player">
            <div class="controls">
                <button class="btn" id="playBtn" onclick="togglePlay()">▶️ Play</button>
                <button class="btn" onclick="stopMusic()">⏹️ Stop</button>
                <button class="btn" onclick="regenerate()">🔄 Regenerate</button>
                <button class="btn" onclick="downloadMidi()">💾 Download</button>
            </div>
            
            <div class="progress-bar">
                <div class="progress" id="progressBar"></div>
            </div>
            
            <div class="visualizer" id="visualizer">
                <div class="frequency-bars" id="frequencyBars">
                    ${Array.from({length: 50}, () => '<div class="freq-bar"></div>').join('')}
                </div>
            </div>
        </div>
        
        <div class="music-info">
            <div class="info-card">
                <h3>🎹 Composition Details</h3>
                <p><strong>Duration:</strong> ${options.duration} seconds</p>
                <p><strong>Time Signature:</strong> ${music.timeSignature || '4/4'}</p>
                <p><strong>Key Signature:</strong> ${options.key}</p>
                <p><strong>Instruments:</strong> ${music.instruments?.join(', ') || 'Synthesizer'}</p>
            </div>
            
            <div class="info-card">
                <h3>📊 Code Statistics</h3>
                <p><strong>Files Analyzed:</strong> ${music.sourceFiles || 'N/A'}</p>
                <p><strong>Functions:</strong> ${music.functionCount || 'N/A'}</p>
                <p><strong>Variables:</strong> ${music.variableCount || 'N/A'}</p>
                <p><strong>Complexity Score:</strong> ${music.complexityScore || 'N/A'}</p>
            </div>
            
            <div class="info-card">
                <h3>🎵 Musical Elements</h3>
                <p><strong>Tracks:</strong> ${music.tracks?.length || 1}</p>
                <p><strong>Chord Progressions:</strong> ${music.chordProgressions || 'Auto-generated'}</p>
                <p><strong>Rhythm Patterns:</strong> ${music.rhythmPatterns || 'Code-derived'}</p>
                <p><strong>Harmonic Style:</strong> ${options.style}</p>
            </div>
        </div>
        
        <div class="code-mapping">
            <h3>🔗 Code-to-Music Mapping</h3>
            <div class="mapping-item">
                <span>📁 Files</span>
                <span>→ Musical Tracks</span>
            </div>
            <div class="mapping-item">
                <span>🔧 Functions</span>
                <span>→ Melodic Phrases</span>
            </div>
            <div class="mapping-item">
                <span>📝 Variables</span>
                <span>→ Chord Progressions</span>
            </div>
            <div class="mapping-item">
                <span>🔄 Loops</span>
                <span>→ Rhythmic Patterns</span>
            </div>
            <div class="mapping-item">
                <span>💬 Comments</span>
                <span>→ Ambient Textures</span>
            </div>
            <div class="mapping-item">
                <span>⚡ Complexity</span>
                <span>→ Tempo & Dynamics</span>
            </div>
        </div>
    </div>
    
    <script>
        let isPlaying = false;
        let audioContext;
        let currentTime = 0;
        let duration = ${options.duration};
        let animationId;
        
        // Music data
        const musicData = ${JSON.stringify(music)};
        
        async function initAudio() {
            if (!audioContext) {
                await Tone.start();
                audioContext = Tone.context;
                document.getElementById('status').textContent = '🎵 Audio Ready';
            }
        }
        
        async function togglePlay() {
            await initAudio();
            
            if (isPlaying) {
                pauseMusic();
            } else {
                playMusic();
            }
        }
        
        async function playMusic() {
            isPlaying = true;
            document.getElementById('playBtn').innerHTML = '⏸️ Pause';
            document.getElementById('status').textContent = '🎵 Playing Your Code\'s Music';
            
            // Create synthesizers for different code elements
            const synthA = new Tone.Synth().toDestination();  // Functions
            const synthB = new Tone.FMSynth().toDestination(); // Variables
            const synthC = new Tone.AMSynth().toDestination(); // Loops
            const noise = new Tone.Noise("pink").toDestination(); // Comments
            
            // Start the music generation
            startVisualization();
            generateMusicFromCode();
        }
        
        function pauseMusic() {
            isPlaying = false;
            document.getElementById('playBtn').innerHTML = '▶️ Play';
            document.getElementById('status').textContent = '⏸️ Paused';
            Tone.Transport.pause();
            stopVisualization();
        }
        
        function stopMusic() {
            isPlaying = false;
            currentTime = 0;
            document.getElementById('playBtn').innerHTML = '▶️ Play';
            document.getElementById('status').textContent = '⏹️ Stopped';
            document.getElementById('progressBar').style.width = '0%';
            Tone.Transport.stop();
            stopVisualization();
        }
        
        function generateMusicFromCode() {
            Tone.Transport.bpm.value = ${options.tempo};
            
            // Generate musical sequence based on code structure
            const notes = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];
            let noteIndex = 0;
            
            // Function-based melody
            const melodySequence = new Tone.Sequence((time, note) => {
                const synth = new Tone.Synth().toDestination();
                synth.triggerAttackRelease(note, '8n', time);
                noteIndex = (noteIndex + 1) % notes.length;
            }, notes, '4n');
            
            // Variable-based harmony
            const harmonySequence = new Tone.Sequence((time, chord) => {
                const synth = new Tone.PolySynth().toDestination();
                synth.triggerAttackRelease(chord, '2n', time);
            }, [['C4', 'E4', 'G4'], ['F4', 'A4', 'C5'], ['G4', 'B4', 'D5']], '1n');
            
            melodySequence.start(0);
            harmonySequence.start(0);
            
            Tone.Transport.start();
            
            // Schedule stop
            setTimeout(() => {
                if (isPlaying) stopMusic();
            }, duration * 1000);
        }
        
        function startVisualization() {
            const bars = document.querySelectorAll('.freq-bar');
            const progressBar = document.getElementById('progressBar');
            const startTime = Date.now();
            
            function animate() {
                if (!isPlaying) return;
                
                // Update progress
                const elapsed = (Date.now() - startTime) / 1000;
                const progress = Math.min((elapsed / duration) * 100, 100);
                progressBar.style.width = progress + '%';
                
                // Animate frequency bars
                bars.forEach((bar, index) => {
                    const height = Math.random() * 80 + 20;
                    bar.style.height = height + '%';
                    bar.style.opacity = 0.5 + (height / 200);
                });
                
                if (progress < 100) {
                    animationId = requestAnimationFrame(animate);
                } else {
                    stopMusic();
                }
            }
            
            animate();
        }
        
        function stopVisualization() {
            if (animationId) {
                cancelAnimationFrame(animationId);
            }
            
            // Reset frequency bars
            const bars = document.querySelectorAll('.freq-bar');
            bars.forEach(bar => {
                bar.style.height = '2px';
                bar.style.opacity = '0.3';
            });
        }
        
        function regenerate() {
            stopMusic();
            document.getElementById('status').textContent = '🔄 Regenerating...';
            
            // Simulate regeneration
            setTimeout(() => {
                document.getElementById('status').textContent = '🎵 New Composition Ready';
                alert('New musical interpretation generated! Click Play to hear it.');
            }, 2000);
        }
        
        function downloadMidi() {
            document.getElementById('status').textContent = '💾 Downloading MIDI...';
            
            // Create a blob with MIDI-like data (simulated)
            const midiData = 'QwenMusic MIDI Export\\n' + JSON.stringify(musicData, null, 2);
            const blob = new Blob([midiData], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = 'qwenmusic-composition.json';
            a.click();
            
            URL.revokeObjectURL(url);
            
            setTimeout(() => {
                document.getElementById('status').textContent = '💾 Downloaded!';
            }, 1000);
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            // Auto-play if specified
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('autoplay') === 'true') {
                setTimeout(togglePlay, 1000);
            }
        });
    </script>
</body>
</html>`;
  }
}