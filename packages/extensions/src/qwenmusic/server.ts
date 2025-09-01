/**
 * Music Server for QwenMusic
 * Real-time music generation and playback server
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import * as path from 'path';
import { CodeAnalyzer } from './analyzer.js';
import { MusicGenerator } from './generator.js';

export class MusicServer {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer | null = null;
  private analyzer: CodeAnalyzer;
  private generator: MusicGenerator;
  private isRunning = false;
  private realTimeMode = false;

  constructor() {
    this.app = express();
    this.analyzer = new CodeAnalyzer();
    this.generator = new MusicGenerator();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Serve static files
    this.app.use('/static', express.static(path.join(__dirname, '../web-assets')));
    
    // API routes
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'healthy', realTimeMode: this.realTimeMode, timestamp: new Date().toISOString() });
    });

    this.app.get('/api/analyze/:projectPath(*)', async (req, res) => {
      try {
        const projectPath = req.params.projectPath || process.cwd();
        const analysis = await this.analyzer.analyze(projectPath, {
          includeComments: req.query.includeComments !== 'false',
          extractRhythms: true,
          extractMelodies: true,
          extractHarmonies: true
        });
        res.json(analysis);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Analysis failed' });
      }
    });

    this.app.get('/api/generate/:projectPath(*)', async (req, res) => {
      try {
        const projectPath = req.params.projectPath || process.cwd();
        const analysis = await this.analyzer.analyze(projectPath);
        
        const options = {
          style: req.query.style as string || 'auto',
          tempo: req.query.tempo ? parseInt(req.query.tempo as string) : undefined,
          key: req.query.key as string || 'C major',
          duration: req.query.duration ? parseInt(req.query.duration as string) : 60,
          outputFormat: req.query.format as string || 'json'
        };

        const music = await this.generator.generate(analysis, options);
        res.json(music);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Generation failed' });
      }
    });

    // Main page
    this.app.get('/', (req, res) => {
      res.send(this.getMainPage());
    });

    // Live music studio
    this.app.get('/studio', (req, res) => {
      res.send(this.getStudioPage());
    });

    // Real-time music player
    this.app.get('/live', (req, res) => {
      res.send(this.getLivePage());
    });
  }

  async start(projectPath: string, port: number): Promise<string> {
    if (this.isRunning) {
      throw new Error('Server is already running');
    }

    return new Promise((resolve, reject) => {
      this.server = createServer(this.app);
      
      // Setup WebSocket server
      this.wss = new WebSocketServer({ server: this.server });
      this.setupWebSocketHandlers(projectPath);

      this.server.listen(port, () => {
        this.isRunning = true;
        const url = `http://localhost:${port}`;
        console.log(`🎚️ QwenMusic server started at ${url}`);
        resolve(url);
      });

      this.server.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  async playMusic(analysis: any, options: any): Promise<void> {
    // Generate music and start playback
    const music = await this.generator.generate(analysis, {
      style: options.style || 'auto',
      tempo: options.tempo,
      key: options.key,
      duration: options.duration || 30,
      outputFormat: 'json'
    });

    // Broadcast music to all connected clients
    if (this.wss) {
      const message = JSON.stringify({
        type: 'music_generated',
        data: music
      });

      this.wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(message);
        }
      });
    }
  }

  async enableRealTimeMode(): Promise<void> {
    this.realTimeMode = true;
    console.log('🔴 Real-time music mode enabled');
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isRunning || !this.server) {
        resolve();
        return;
      }

      this.wss?.close();
      this.server.close((error: Error) => {
        if (error) {
          reject(error);
        } else {
          this.isRunning = false;
          this.realTimeMode = false;
          console.log('🛑 QwenMusic server stopped');
          resolve();
        }
      });
    });
  }

  private setupWebSocketHandlers(projectPath: string): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws) => {
      console.log('🎵 New music client connected');

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          switch (data.type) {
            case 'analyze':
              const analysis = await this.analyzer.analyze(projectPath, data.options || {});
              ws.send(JSON.stringify({ type: 'analysis', data: analysis }));
              break;
              
            case 'generate_music':
              const music = await this.generator.generate(data.analysis, data.options);
              ws.send(JSON.stringify({ type: 'music', data: music }));
              break;
              
            case 'start_realtime':
              this.realTimeMode = true;
              ws.send(JSON.stringify({ type: 'realtime_started' }));
              break;
              
            case 'file_changed':
              if (this.realTimeMode) {
                // Re-analyze and generate new music
                const newAnalysis = await this.analyzer.analyze(projectPath);
                const newMusic = await this.generator.generate(newAnalysis, data.options || {});
                
                // Broadcast to all clients
                this.wss?.clients.forEach(client => {
                  if (client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'music_update', data: newMusic }));
                  }
                });
              }
              break;
              
            default:
              ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' }));
        }
      });

      ws.on('close', () => {
        console.log('🎵 Music client disconnected');
      });
    });
  }

  private getMainPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenMusic - Code to Music Server</title>
    <style>
        body { 
            font-family: 'Arial', sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            color: white;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 50px; }
        .header h1 { 
            font-size: 3.5em; 
            margin: 0; 
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #feca57);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; margin-bottom: 50px; }
        .feature-card { 
            background: rgba(255,255,255,0.1); 
            padding: 30px; 
            border-radius: 15px; 
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
            transition: transform 0.3s;
        }
        .feature-card:hover { transform: translateY(-5px); }
        .feature-card h3 { margin-top: 0; font-size: 1.5em; color: #4ecdc4; }
        .feature-card a { 
            display: inline-block; 
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4); 
            color: white; 
            text-decoration: none; 
            padding: 12px 25px; 
            border-radius: 25px; 
            margin-top: 15px;
            transition: all 0.3s;
            font-weight: bold;
        }
        .feature-card a:hover { 
            transform: scale(1.05);
            box-shadow: 0 5px 15px rgba(76, 205, 196, 0.4);
        }
        .status { 
            position: fixed; 
            top: 20px; 
            right: 20px; 
            background: rgba(0,0,0,0.8); 
            padding: 15px 25px; 
            border-radius: 25px; 
            border: 2px solid #4ecdc4;
        }
        .music-viz {
            height: 100px;
            background: rgba(0,0,0,0.3);
            border-radius: 10px;
            margin: 20px 0;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            position: relative;
        }
        .music-bars {
            display: flex;
            height: 80%;
            align-items: end;
            gap: 2px;
        }
        .music-bar {
            width: 3px;
            background: linear-gradient(to top, #ff6b6b, #4ecdc4);
            border-radius: 1px;
            animation: musicPulse 0.5s ease-in-out infinite alternate;
        }
        @keyframes musicPulse {
            from { height: 10%; opacity: 0.3; }
            to { height: 90%; opacity: 1; }
        }
    </style>
</head>
<body>
    <div class="status">
        🎵 Server Active ${this.realTimeMode ? '| 🔴 Live Mode' : ''}
    </div>
    
    <div class="container">
        <div class="header">
            <h1>🎵 QwenMusic</h1>
            <p>Transform Your Code into Beautiful Music</p>
            <div class="music-viz">
                <div class="music-bars">
                    ${Array.from({length: 20}, (_, i) => 
                        `<div class="music-bar" style="animation-delay: ${i * 0.1}s; height: ${20 + Math.random() * 60}%"></div>`
                    ).join('')}
                </div>
            </div>
        </div>
        
        <div class="features">
            <div class="feature-card">
                <h3>🎹 Music Studio</h3>
                <p>Interactive studio for creating music from your code. Real-time editing, multiple instruments, and style controls.</p>
                <a href="/studio">Open Studio</a>
            </div>
            
            <div class="feature-card">
                <h3>🔴 Live Mode</h3>
                <p>Watch your music evolve in real-time as you code. Every edit creates new musical patterns and harmonies.</p>
                <a href="/live">Go Live</a>
            </div>
            
            <div class="feature-card">
                <h3>🎼 Code Compositions</h3>
                <p>Gallery of musical compositions generated from famous codebases. Explore the sound of different programming styles.</p>
                <a href="/gallery">Browse Gallery</a>
            </div>
            
            <div class="feature-card">
                <h3>🎵 Style Explorer</h3>
                <p>Experiment with different musical styles: Classical, Jazz, Electronic, Ambient, and Rock. Each style interprets code differently.</p>
                <a href="/styles">Explore Styles</a>
            </div>
            
            <div class="feature-card">
                <h3>🎚️ Mix & Master</h3>
                <p>Professional mixing console for your code music. Adjust levels, effects, and create the perfect soundtrack for development.</p>
                <a href="/mixer">Open Mixer</a>
            </div>
            
            <div class="feature-card">
                <h3>🎯 Code Karaoke</h3>
                <p>Sing along to your code! Watch musical notation scroll by as your functions play their melodies.</p>
                <a href="/karaoke">Start Karaoke</a>
            </div>
        </div>
    </div>
    
    <script>
        // Add some interactive music visualization
        setInterval(() => {
            const bars = document.querySelectorAll('.music-bar');
            bars.forEach(bar => {
                const height = 20 + Math.random() * 70;
                bar.style.height = height + '%';
            });
        }, 500);
    </script>
</body>
</html>`;
  }

  private getStudioPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenMusic Studio</title>
    <script src="https://cdn.jsdelivr.net/npm/tone@15.0.4/build/Tone.js"></script>
    <style>
        body { 
            margin: 0; 
            background: #1a1a1a; 
            color: white; 
            font-family: 'Courier New', monospace; 
            overflow-x: hidden;
        }
        .studio-container {
            display: grid;
            grid-template-areas: 
                "header header header"
                "code mixer player"
                "controls controls controls";
            grid-template-rows: auto 1fr auto;
            grid-template-columns: 1fr 1fr 1fr;
            height: 100vh;
            gap: 10px;
            padding: 10px;
        }
        .header { 
            grid-area: header; 
            text-align: center; 
            background: rgba(255,255,255,0.1); 
            padding: 20px; 
            border-radius: 10px;
        }
        .code-section { 
            grid-area: code; 
            background: rgba(255,255,255,0.05); 
            padding: 20px; 
            border-radius: 10px;
            overflow-y: auto;
        }
        .mixer-section { 
            grid-area: mixer; 
            background: rgba(255,255,255,0.05); 
            padding: 20px; 
            border-radius: 10px;
        }
        .player-section { 
            grid-area: player; 
            background: rgba(255,255,255,0.05); 
            padding: 20px; 
            border-radius: 10px;
        }
        .controls { 
            grid-area: controls; 
            background: rgba(255,255,255,0.1); 
            padding: 20px; 
            border-radius: 10px;
            display: flex;
            justify-content: center;
            gap: 20px;
        }
        .btn {
            padding: 15px 30px;
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4);
            border: none;
            border-radius: 25px;
            color: white;
            font-size: 1em;
            cursor: pointer;
            transition: all 0.3s;
            text-transform: uppercase;
            font-weight: bold;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(76, 205, 196, 0.4);
        }
        .track {
            background: rgba(255,255,255,0.1);
            margin: 10px 0;
            padding: 15px;
            border-radius: 5px;
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .track-name { flex: 1; font-weight: bold; }
        .track-controls { display: flex; gap: 10px; align-items: center; }
        .slider {
            -webkit-appearance: none;
            width: 100px;
            height: 5px;
            border-radius: 5px;
            background: #333;
            outline: none;
        }
        .slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: #4ecdc4;
            cursor: pointer;
        }
        .visualizer {
            height: 150px;
            background: rgba(0,0,0,0.5);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 20px 0;
            position: relative;
            overflow: hidden;
        }
        .code-line {
            padding: 5px 0;
            border-left: 3px solid transparent;
            transition: all 0.3s;
        }
        .code-line.playing {
            border-left-color: #4ecdc4;
            background: rgba(76, 205, 196, 0.1);
        }
        .style-selector {
            display: flex;
            gap: 10px;
            margin: 20px 0;
            flex-wrap: wrap;
        }
        .style-btn {
            padding: 10px 20px;
            background: rgba(255,255,255,0.1);
            border: 2px solid transparent;
            border-radius: 20px;
            color: white;
            cursor: pointer;
            transition: all 0.3s;
        }
        .style-btn.active {
            border-color: #4ecdc4;
            background: rgba(76, 205, 196, 0.2);
        }
    </style>
</head>
<body>
    <div class="studio-container">
        <div class="header">
            <h1>🎹 QwenMusic Studio</h1>
            <p>Create beautiful music from your code</p>
        </div>
        
        <div class="code-section">
            <h3>📝 Code Analysis</h3>
            <div id="code-display">
                <div class="code-line">function generateMusic() {</div>
                <div class="code-line">  const tempo = calculateTempo();</div>
                <div class="code-line">  const scale = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];</div>
                <div class="code-line">  return createMelody(tempo, scale);</div>
                <div class="code-line">}</div>
            </div>
            
            <h4>Musical Mapping</h4>
            <div style="font-size: 0.9em; opacity: 0.8;">
                <p>📁 Functions → Melodic phrases</p>
                <p>📝 Variables → Chord progressions</p>
                <p>🔄 Loops → Rhythmic patterns</p>
                <p>💬 Comments → Ambient textures</p>
            </div>
        </div>
        
        <div class="mixer-section">
            <h3>🎚️ Mix Console</h3>
            
            <div class="track">
                <span class="track-name">🎹 Melody</span>
                <div class="track-controls">
                    <input type="range" class="slider" min="0" max="100" value="80" id="melody-volume">
                    <input type="range" class="slider" min="-50" max="50" value="0" id="melody-pan">
                    <button onclick="toggleTrack('melody')">🔇</button>
                </div>
            </div>
            
            <div class="track">
                <span class="track-name">🎸 Harmony</span>
                <div class="track-controls">
                    <input type="range" class="slider" min="0" max="100" value="60" id="harmony-volume">
                    <input type="range" class="slider" min="-50" max="50" value="-20" id="harmony-pan">
                    <button onclick="toggleTrack('harmony')">🔇</button>
                </div>
            </div>
            
            <div class="track">
                <span class="track-name">🥁 Rhythm</span>
                <div class="track-controls">
                    <input type="range" class="slider" min="0" max="100" value="70" id="rhythm-volume">
                    <input type="range" class="slider" min="-50" max="50" value="0" id="rhythm-pan">
                    <button onclick="toggleTrack('rhythm')">🔇</button>
                </div>
            </div>
            
            <div class="track">
                <span class="track-name">🎻 Bass</span>
                <div class="track-controls">
                    <input type="range" class="slider" min="0" max="100" value="75" id="bass-volume">
                    <input type="range" class="slider" min="-50" max="50" value="20" id="bass-pan">
                    <button onclick="toggleTrack('bass')">🔇</button>
                </div>
            </div>
        </div>
        
        <div class="player-section">
            <h3>🎵 Music Player</h3>
            
            <div class="style-selector">
                <div class="style-btn active" onclick="selectStyle('electronic')">🎹 Electronic</div>
                <div class="style-btn" onclick="selectStyle('classical')">🎼 Classical</div>
                <div class="style-btn" onclick="selectStyle('jazz')">🎷 Jazz</div>
                <div class="style-btn" onclick="selectStyle('ambient')">🌊 Ambient</div>
                <div class="style-btn" onclick="selectStyle('rock')">🎸 Rock</div>
            </div>
            
            <div class="visualizer" id="visualizer">
                <canvas id="waveform" width="400" height="150"></canvas>
            </div>
            
            <div style="text-align: center; margin-top: 20px;">
                <div style="background: rgba(255,255,255,0.1); padding: 10px; border-radius: 5px; margin-bottom: 15px;">
                    <div style="display: flex; justify-content: space-between;">
                        <span>Tempo: <span id="tempo-display">120</span> BPM</span>
                        <span>Key: <span id="key-display">C Major</span></span>
                        <span>Time: <span id="time-display">0:00</span></span>
                    </div>
                </div>
                <input type="range" min="0" max="100" value="0" id="progress-slider" style="width: 100%; margin-bottom: 15px;">
            </div>
        </div>
        
        <div class="controls">
            <button class="btn" onclick="analyzeCode()">🔍 Analyze</button>
            <button class="btn" onclick="generateMusic()">🎼 Generate</button>
            <button class="btn" onclick="playMusic()" id="playBtn">▶️ Play</button>
            <button class="btn" onclick="stopMusic()">⏹️ Stop</button>
            <button class="btn" onclick="recordMusic()">⏺️ Record</button>
            <button class="btn" onclick="exportMusic()">💾 Export</button>
        </div>
    </div>
    
    <script>
        let isPlaying = false;
        let currentStyle = 'electronic';
        let musicData = null;
        let ws = null;
        
        // Connect to WebSocket
        function connectWebSocket() {
            ws = new WebSocket(\`ws://\${window.location.host}\`);
            
            ws.onopen = () => {
                console.log('Connected to QwenMusic server');
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                handleServerMessage(message);
            };
        }
        
        function handleServerMessage(message) {
            switch (message.type) {
                case 'analysis':
                    displayCodeAnalysis(message.data);
                    break;
                case 'music':
                    musicData = message.data;
                    updateMusicInfo(musicData);
                    break;
                case 'music_update':
                    if (isPlaying) {
                        musicData = message.data;
                        updateMusicVisualization();
                    }
                    break;
            }
        }
        
        async function analyzeCode() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'analyze',
                    options: {
                        includeComments: true,
                        extractRhythms: true,
                        extractMelodies: true,
                        extractHarmonies: true
                    }
                }));
            }
        }
        
        async function generateMusic() {
            const options = {
                style: currentStyle,
                tempo: parseInt(document.getElementById('tempo-display').textContent),
                key: document.getElementById('key-display').textContent,
                duration: 60,
                outputFormat: 'json'
            };
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'generate_music',
                    analysis: {}, // This would be the actual analysis data
                    options: options
                }));
            }
        }
        
        async function playMusic() {
            if (!isPlaying) {
                await Tone.start();
                isPlaying = true;
                document.getElementById('playBtn').textContent = '⏸️ Pause';
                startMusicPlayback();
            } else {
                isPlaying = false;
                document.getElementById('playBtn').textContent = '▶️ Play';
                Tone.Transport.pause();
            }
        }
        
        function stopMusic() {
            isPlaying = false;
            document.getElementById('playBtn').textContent = '▶️ Play';
            Tone.Transport.stop();
            document.getElementById('progress-slider').value = 0;
            document.getElementById('time-display').textContent = '0:00';
        }
        
        function startMusicPlayback() {
            // Simulate music playback with visualization
            const canvas = document.getElementById('waveform');
            const ctx = canvas.getContext('2d');
            
            function animate() {
                if (!isPlaying) return;
                
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.strokeStyle = '#4ecdc4';
                ctx.lineWidth = 2;
                ctx.beginPath();
                
                for (let x = 0; x < canvas.width; x++) {
                    const y = canvas.height / 2 + Math.sin(x * 0.02 + Date.now() * 0.005) * 30 * Math.random();
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                
                ctx.stroke();
                
                // Highlight playing code lines
                const codeLines = document.querySelectorAll('.code-line');
                const currentLine = Math.floor(Date.now() / 1000) % codeLines.length;
                codeLines.forEach((line, index) => {
                    if (index === currentLine) {
                        line.classList.add('playing');
                    } else {
                        line.classList.remove('playing');
                    }
                });
                
                requestAnimationFrame(animate);
            }
            
            animate();
        }
        
        function selectStyle(style) {
            currentStyle = style;
            document.querySelectorAll('.style-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            // Update tempo and key based on style
            const styleSettings = {
                electronic: { tempo: 128, key: 'C Major' },
                classical: { tempo: 72, key: 'G Major' },
                jazz: { tempo: 120, key: 'F Major' },
                ambient: { tempo: 60, key: 'A Minor' },
                rock: { tempo: 140, key: 'E Major' }
            };
            
            const settings = styleSettings[style];
            document.getElementById('tempo-display').textContent = settings.tempo;
            document.getElementById('key-display').textContent = settings.key;
        }
        
        function toggleTrack(track) {
            // Toggle track mute/unmute
            console.log(\`Toggling \${track} track\`);
        }
        
        function recordMusic() {
            alert('Recording started! Your code music is being captured.');
        }
        
        function exportMusic() {
            if (musicData) {
                const blob = new Blob([JSON.stringify(musicData, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'qwenmusic-composition.json';
                a.click();
                URL.revokeObjectURL(url);
            } else {
                alert('Please generate music first!');
            }
        }
        
        function displayCodeAnalysis(analysis) {
            console.log('Code analysis received:', analysis);
            // Update code display with actual analysis data
        }
        
        function updateMusicInfo(music) {
            if (music.metadata) {
                document.getElementById('tempo-display').textContent = music.metadata.tempo;
                document.getElementById('key-display').textContent = music.metadata.key;
            }
        }
        
        function updateMusicVisualization() {
            // Update real-time visualization
            console.log('Updating music visualization...');
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            connectWebSocket();
        });
    </script>
</body>
</html>`;
  }

  private getLivePage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenMusic Live - Real-time Code Music</title>
    <script src="https://cdn.jsdelivr.net/npm/tone@15.0.4/build/Tone.js"></script>
    <style>
        body { 
            margin: 0; 
            background: #000; 
            color: white; 
            font-family: 'Courier New', monospace; 
            overflow: hidden;
        }
        .live-container {
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .live-header {
            background: linear-gradient(90deg, #ff0000, #ff6b6b);
            padding: 15px;
            text-align: center;
            font-size: 1.2em;
            font-weight: bold;
        }
        .live-content {
            flex: 1;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            padding: 20px;
        }
        .code-monitor {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 20px;
            overflow-y: auto;
        }
        .music-visualizer {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 20px;
            display: flex;
            flex-direction: column;
        }
        .spectrum {
            flex: 1;
            position: relative;
            background: rgba(0,0,0,0.5);
            border-radius: 10px;
            overflow: hidden;
            display: flex;
            align-items: end;
            justify-content: center;
            gap: 2px;
            padding: 20px;
        }
        .freq-bar {
            width: 8px;
            background: linear-gradient(to top, #ff0000, #ff6b6b, #ffff00, #00ff00, #00ffff);
            border-radius: 4px;
            min-height: 4px;
            transition: height 0.1s;
        }
        .live-status {
            position: fixed;
            top: 20px;
            right: 20px;
            background: #ff0000;
            padding: 10px 20px;
            border-radius: 20px;
            font-weight: bold;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        .music-controls {
            background: rgba(255,255,255,0.1);
            padding: 15px;
            border-radius: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 20px;
        }
        .code-change {
            background: rgba(0,255,0,0.1);
            border-left: 4px solid #00ff00;
            padding: 10px;
            margin: 5px 0;
            border-radius: 5px;
            animation: newChange 0.5s ease-out;
        }
        @keyframes newChange {
            from { background: rgba(0,255,0,0.3); }
            to { background: rgba(0,255,0,0.1); }
        }
        .musical-event {
            position: absolute;
            background: rgba(255,255,255,0.8);
            color: black;
            padding: 5px 10px;
            border-radius: 15px;
            font-size: 0.8em;
            animation: floatUp 2s ease-out forwards;
            pointer-events: none;
        }
        @keyframes floatUp {
            from { transform: translateY(0); opacity: 1; }
            to { transform: translateY(-100px); opacity: 0; }
        }
    </style>
</head>
<body>
    <div class="live-container">
        <div class="live-header">
            🔴 LIVE: Real-time Code Music Generation
        </div>
        
        <div class="live-status">
            🔴 LIVE
        </div>
        
        <div class="live-content">
            <div class="code-monitor">
                <h3>📝 Code Changes Monitor</h3>
                <div id="code-changes">
                    <div class="code-change">
                        <strong>function.js:15</strong> - New function added → Melody phrase created
                    </div>
                    <div class="code-change">
                        <strong>style.css:42</strong> - Variable declaration → Chord progression
                    </div>
                    <div class="code-change">
                        <strong>app.js:88</strong> - Loop structure → Rhythmic pattern
                    </div>
                </div>
                
                <h4>🎵 Active Musical Elements</h4>
                <div style="font-size: 0.9em; opacity: 0.8;">
                    <p>🎹 <span id="melody-count">5</span> active melodies</p>
                    <p>🎸 <span id="harmony-count">3</span> chord progressions</p>
                    <p>🥁 <span id="rhythm-count">2</span> rhythm patterns</p>
                    <p>🎻 <span id="bass-count">1</span> bass line</p>
                </div>
            </div>
            
            <div class="music-visualizer">
                <h3>🎵 Live Music Spectrum</h3>
                <div class="spectrum" id="spectrum">
                    ${Array.from({length: 30}, () => '<div class="freq-bar"></div>').join('')}
                </div>
                
                <div class="music-controls">
                    <div>
                        <strong>Tempo:</strong> <span id="live-tempo">120</span> BPM
                    </div>
                    <div>
                        <strong>Key:</strong> <span id="live-key">C Major</span>
                    </div>
                    <div>
                        <strong>Style:</strong> <span id="live-style">Electronic</span>
                    </div>
                    <div>
                        <strong>Complexity:</strong> <span id="live-complexity">7.2</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let ws = null;
        let isLive = false;
        let musicElements = {
            melody: 5,
            harmony: 3,
            rhythm: 2,
            bass: 1
        };
        
        function connectWebSocket() {
            ws = new WebSocket(\`ws://\${window.location.host}\`);
            
            ws.onopen = () => {
                console.log('Connected to live music server');
                startLiveMode();
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                handleLiveMessage(message);
            };
            
            ws.onclose = () => {
                console.log('Disconnected from live music server');
                setTimeout(connectWebSocket, 5000); // Reconnect after 5 seconds
            };
        }
        
        function startLiveMode() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'start_realtime'
                }));
                isLive = true;
                startVisualization();
            }
        }
        
        function handleLiveMessage(message) {
            switch (message.type) {
                case 'realtime_started':
                    console.log('Real-time mode activated');
                    break;
                case 'music_update':
                    updateLiveMusicVisuals(message.data);
                    simulateCodeChange();
                    break;
                case 'file_change':
                    addCodeChange(message.data);
                    createMusicalEvent(message.data);
                    break;
            }
        }
        
        function updateLiveMusicVisuals(musicData) {
            if (musicData.metadata) {
                document.getElementById('live-tempo').textContent = musicData.metadata.tempo;
                document.getElementById('live-key').textContent = musicData.metadata.key;
                document.getElementById('live-style').textContent = musicData.metadata.style;
                document.getElementById('live-complexity').textContent = (Math.random() * 10).toFixed(1);
            }
            
            // Update musical element counts
            if (musicData.tracks) {
                musicElements.melody = musicData.tracks.filter(t => t.name.includes('Melody')).length;
                musicElements.harmony = musicData.tracks.filter(t => t.name.includes('Harmony')).length;
                musicElements.rhythm = musicData.tracks.filter(t => t.name.includes('Rhythm')).length;
                musicElements.bass = musicData.tracks.filter(t => t.name.includes('Bass')).length;
                
                document.getElementById('melody-count').textContent = musicElements.melody;
                document.getElementById('harmony-count').textContent = musicElements.harmony;
                document.getElementById('rhythm-count').textContent = musicElements.rhythm;
                document.getElementById('bass-count').textContent = musicElements.bass;
            }
        }
        
        function simulateCodeChange() {
            // Simulate code changes for demo
            const changeTypes = [
                { file: 'components/Header.js', line: Math.floor(Math.random() * 100), type: 'function', musical: 'Melody phrase' },
                { file: 'styles/main.css', line: Math.floor(Math.random() * 200), type: 'variable', musical: 'Chord progression' },
                { file: 'utils/helpers.js', line: Math.floor(Math.random() * 150), type: 'loop', musical: 'Rhythmic pattern' },
                { file: 'api/routes.js', line: Math.floor(Math.random() * 80), type: 'class', musical: 'Harmonic structure' }
            ];
            
            const change = changeTypes[Math.floor(Math.random() * changeTypes.length)];
            addCodeChange(change);
            createMusicalEvent(change);
        }
        
        function addCodeChange(change) {
            const changesContainer = document.getElementById('code-changes');
            const changeElement = document.createElement('div');
            changeElement.className = 'code-change';
            changeElement.innerHTML = \`
                <strong>\${change.file}:\${change.line}</strong> - \${change.type} added → \${change.musical}
            \`;
            
            changesContainer.insertBefore(changeElement, changesContainer.firstChild);
            
            // Keep only the last 10 changes
            while (changesContainer.children.length > 10) {
                changesContainer.removeChild(changesContainer.lastChild);
            }
        }
        
        function createMusicalEvent(change) {
            const spectrum = document.getElementById('spectrum');
            const event = document.createElement('div');
            event.className = 'musical-event';
            event.textContent = \`♪ \${change.musical}\`;
            event.style.left = Math.random() * 80 + 10 + '%';
            event.style.bottom = '20px';
            
            spectrum.appendChild(event);
            
            setTimeout(() => {
                if (event.parentNode) {
                    event.parentNode.removeChild(event);
                }
            }, 2000);
        }
        
        function startVisualization() {
            const bars = document.querySelectorAll('.freq-bar');
            
            function animate() {
                bars.forEach((bar, index) => {
                    const intensity = Math.random() * 100;
                    bar.style.height = intensity + '%';
                    
                    // Color based on intensity
                    if (intensity > 70) {
                        bar.style.background = 'linear-gradient(to top, #ff0000, #ff6b6b)';
                    } else if (intensity > 40) {
                        bar.style.background = 'linear-gradient(to top, #ffff00, #ff6b6b)';
                    } else {
                        bar.style.background = 'linear-gradient(to top, #00ff00, #00ffff)';
                    }
                });
                
                requestAnimationFrame(animate);
            }
            
            animate();
            
            // Simulate live updates
            setInterval(() => {
                if (isLive && Math.random() > 0.7) {
                    simulateCodeChange();
                }
            }, 3000);
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            connectWebSocket();
        });
    </script>
</body>
</html>`;
  }
}