/**
 * Three.js Visualization Server for QwenViz
 * Provides real-time 3D code visualization with WebSocket support
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import * as path from 'path';
import { CodebaseAnalyzer } from './analyzer.js';

export class ThreeJSVisualizationServer {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer | null = null;
  private analyzer: CodebaseAnalyzer;
  private isRunning = false;

  constructor() {
    this.app = express();
    this.analyzer = new CodebaseAnalyzer();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Serve static files
    this.app.use('/static', express.static(path.join(__dirname, '../web-assets')));
    
    // API routes
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    this.app.get('/api/analyze/:projectPath(*)', async (req, res) => {
      try {
        const projectPath = req.params.projectPath || process.cwd();
        const analysis = await this.analyzer.analyze(projectPath, {
          depth: parseInt(req.query.depth as string) || 5,
          includeTests: req.query.includeTests !== 'false',
          includeDocs: req.query.includeDocs !== 'false'
        });
        res.json(analysis);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Analysis failed' });
      }
    });

    // Main visualization page
    this.app.get('/', (req, res) => {
      res.send(this.getMainPage());
    });

    // 3D Visualization page
    this.app.get('/viz', (req, res) => {
      res.send(this.get3DVisualizationPage());
    });

    // VR Visualization page
    this.app.get('/vr', (req, res) => {
      res.send(this.getVRVisualizationPage());
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
        console.log(`🚀 QwenViz server started at ${url}`);
        resolve(url);
      });

      this.server.on('error', (error: Error) => {
        reject(error);
      });
    });
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
          console.log('🛑 QwenViz server stopped');
          resolve();
        }
      });
    });
  }

  private setupWebSocketHandlers(projectPath: string): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws) => {
      console.log('📡 New WebSocket connection');

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          switch (data.type) {
            case 'analyze':
              const analysis = await this.analyzer.analyze(projectPath, data.options || {});
              ws.send(JSON.stringify({ type: 'analysis', data: analysis }));
              break;
              
            case 'get_file':
              // TODO: Implement file content retrieval
              ws.send(JSON.stringify({ type: 'file_content', data: { path: data.path, content: 'File content...' } }));
              break;
              
            default:
              ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' }));
        }
      });

      ws.on('close', () => {
        console.log('📡 WebSocket connection closed');
      });
    });
  }

  private getMainPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenViz - 3D Code Visualization Server</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 50px; }
        .header h1 { font-size: 3em; margin: 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
        .header p { font-size: 1.2em; opacity: 0.9; }
        .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; margin-bottom: 50px; }
        .feature-card { 
            background: rgba(255,255,255,0.1); 
            padding: 30px; 
            border-radius: 15px; 
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
        }
        .feature-card h3 { margin-top: 0; font-size: 1.5em; }
        .feature-card a { 
            display: inline-block; 
            background: rgba(255,255,255,0.2); 
            color: white; 
            text-decoration: none; 
            padding: 10px 20px; 
            border-radius: 5px; 
            margin-top: 15px;
            transition: background 0.3s;
        }
        .feature-card a:hover { background: rgba(255,255,255,0.3); }
        .controls { text-align: center; margin-top: 30px; }
        .controls button { 
            background: #ff6b6b; 
            color: white; 
            border: none; 
            padding: 15px 30px; 
            font-size: 1.1em; 
            border-radius: 5px; 
            cursor: pointer; 
            margin: 0 10px;
            transition: background 0.3s;
        }
        .controls button:hover { background: #ff5252; }
        .status { 
            position: fixed; 
            top: 20px; 
            right: 20px; 
            background: rgba(0,0,0,0.7); 
            padding: 10px 20px; 
            border-radius: 5px; 
        }
    </style>
</head>
<body>
    <div class="status">
        🟢 Server Active
    </div>
    
    <div class="container">
        <div class="header">
            <h1>🎨 QwenViz</h1>
            <p>3D Code Visualization & Navigation Platform</p>
        </div>
        
        <div class="features">
            <div class="feature-card">
                <h3>🌐 3D Codebase Explorer</h3>
                <p>Navigate your codebase in immersive 3D space. Files become nodes, dependencies become connections, and complexity is visualized through color and size.</p>
                <a href="/viz">Launch 3D Explorer</a>
            </div>
            
            <div class="feature-card">
                <h3>🥽 VR Code Environment</h3>
                <p>Experience your code in virtual reality. Walk through your architecture, manipulate components in 3D space, and collaborate with your team in VR.</p>
                <a href="/vr">Enter VR Mode</a>
            </div>
            
            <div class="feature-card">
                <h3>📊 Dependency Visualization</h3>
                <p>See how your modules connect and depend on each other. Identify circular dependencies, coupling issues, and architectural patterns.</p>
                <a href="/viz?view=dependencies">View Dependencies</a>
            </div>
            
            <div class="feature-card">
                <h3>🕰️ Git History Layers</h3>
                <p>Travel through time and see how your codebase evolved. Each commit becomes a layer in 3D space, showing the growth and changes over time.</p>
                <a href="/viz?view=history">Time Travel</a>
            </div>
            
            <div class="feature-card">
                <h3>🔥 Complexity Heatmaps</h3>
                <p>Identify hot spots in your code. Complex functions glow red, simple ones stay cool blue. Find areas that need refactoring at a glance.</p>
                <a href="/viz?view=complexity">Show Heatmap</a>
            </div>
            
            <div class="feature-card">
                <h3>🌊 Real-time Updates</h3>
                <p>Watch your codebase change in real-time as you edit files. The 3D visualization updates automatically to reflect your changes.</p>
                <a href="/viz?mode=live">Live Mode</a>
            </div>
        </div>
        
        <div class="controls">
            <button onclick="analyzeCodebase()">🔍 Analyze Current Project</button>
            <button onclick="openFullscreen()">🖥️ Fullscreen Mode</button>
            <button onclick="exportVisualization()">💾 Export Visualization</button>
        </div>
    </div>
    
    <script>
        function analyzeCodebase() {
            window.open('/api/analyze/' + encodeURIComponent(window.location.pathname), '_blank');
        }
        
        function openFullscreen() {
            window.open('/viz', '_blank');
        }
        
        function exportVisualization() {
            alert('Export functionality coming soon!');
        }
    </script>
</body>
</html>`;
  }

  private get3DVisualizationPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenViz - 3D Code Explorer</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
    <style>
        body { 
            margin: 0; 
            overflow: hidden; 
            background: radial-gradient(circle, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            font-family: 'Courier New', monospace; 
        }
        #info { 
            position: absolute; 
            top: 20px; 
            left: 20px; 
            color: white; 
            z-index: 100; 
            background: rgba(0,0,0,0.7); 
            padding: 20px; 
            border-radius: 10px;
            backdrop-filter: blur(10px);
        }
        #controls { 
            position: absolute; 
            bottom: 20px; 
            left: 20px; 
            color: white; 
            z-index: 100; 
            background: rgba(0,0,0,0.7); 
            padding: 15px; 
            border-radius: 10px;
        }
        #sidebar {
            position: absolute;
            top: 20px;
            right: 20px;
            width: 300px;
            height: calc(100vh - 40px);
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 20px;
            border-radius: 10px;
            overflow-y: auto;
            backdrop-filter: blur(10px);
        }
        .file-node { cursor: pointer; padding: 5px; border-radius: 3px; }
        .file-node:hover { background: rgba(255,255,255,0.1); }
        canvas { display: block; }
        .loading { 
            position: absolute; 
            top: 50%; 
            left: 50%; 
            transform: translate(-50%, -50%); 
            color: white; 
            font-size: 1.5em;
        }
    </style>
</head>
<body>
    <div id="loading" class="loading">🔍 Loading codebase visualization...</div>
    
    <div id="info" style="display: none;">
        <h3>🎨 QwenViz - 3D Code Explorer</h3>
        <div id="stats">
            <p>Files: <span id="file-count">0</span></p>
            <p>Dependencies: <span id="dep-count">0</span></p>
            <p>Complexity: <span id="complexity">0</span></p>
        </div>
    </div>
    
    <div id="controls" style="display: none;">
        <h4>Controls</h4>
        <p>🖱️ Mouse: Rotate & Zoom</p>
        <p>⌨️ WASD: Navigate</p>
        <p>🖱️ Click: Select file</p>
        <p>🔍 Scroll: Zoom in/out</p>
        <p>📱 Space: Reset view</p>
    </div>
    
    <div id="sidebar" style="display: none;">
        <h3>📁 File Explorer</h3>
        <div id="file-list"></div>
        
        <h3>🔗 Selected File</h3>
        <div id="file-details">
            <p>Click on a file to see details</p>
        </div>
        
        <h3>🎛️ View Options</h3>
        <div>
            <label><input type="checkbox" id="show-deps" checked> Show Dependencies</label><br>
            <label><input type="checkbox" id="show-complexity" checked> Complexity Colors</label><br>
            <label><input type="checkbox" id="show-labels"> Show Labels</label><br>
            <label><input type="checkbox" id="animate"> Animate Nodes</label>
        </div>
    </div>
    
    <script>
        // WebSocket connection for real-time updates
        const ws = new WebSocket(\`ws://\${window.location.host}\`);
        
        // Three.js setup
        let scene, camera, renderer, controls;
        let fileNodes = new THREE.Group();
        let dependencyLines = new THREE.Group();
        let analysisData = null;
        let selectedFile = null;
        
        init();
        
        function init() {
            // Scene setup
            scene = new THREE.Scene();
            scene.fog = new THREE.FogExp2(0x1a1a2e, 0.01);
            
            camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
            camera.position.set(20, 20, 20);
            
            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.setClearColor(0x1a1a2e);
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            document.body.appendChild(renderer.domElement);
            
            // Controls
            controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            
            // Lighting
            const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
            scene.add(ambientLight);
            
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
            directionalLight.position.set(50, 50, 50);
            directionalLight.castShadow = true;
            directionalLight.shadow.mapSize.width = 2048;
            directionalLight.shadow.mapSize.height = 2048;
            scene.add(directionalLight);
            
            const pointLight = new THREE.PointLight(0x00ffff, 0.5, 100);
            pointLight.position.set(0, 20, 0);
            scene.add(pointLight);
            
            // Add groups to scene
            scene.add(fileNodes);
            scene.add(dependencyLines);
            
            // Load analysis
            loadAnalysis();
            
            // Setup event listeners
            setupEventListeners();
            
            // Start render loop
            animate();
        }
        
        function loadAnalysis() {
            // Request analysis via WebSocket
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: 'analyze',
                    options: {
                        depth: 5,
                        includeTests: true,
                        includeDocs: true
                    }
                }));
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                if (message.type === 'analysis') {
                    analysisData = message.data;
                    createVisualization();
                }
            };
        }
        
        function createVisualization() {
            if (!analysisData) return;
            
            document.getElementById('loading').style.display = 'none';
            document.getElementById('info').style.display = 'block';
            document.getElementById('controls').style.display = 'block';
            document.getElementById('sidebar').style.display = 'block';
            
            updateStats();
            createFileNodes();
            createDependencyLines();
            updateFileList();
        }
        
        function updateStats() {
            document.getElementById('file-count').textContent = analysisData.files.length;
            document.getElementById('dep-count').textContent = analysisData.dependencies.length;
            document.getElementById('complexity').textContent = analysisData.complexity.cyclomatic.toFixed(2);
        }
        
        function createFileNodes() {
            // Clear existing nodes
            while(fileNodes.children.length > 0) {
                fileNodes.remove(fileNodes.children[0]);
            }
            
            analysisData.files.forEach((file, index) => {
                const geometry = new THREE.BoxGeometry(
                    Math.max(0.5, Math.min(3, file.lines / 50)),
                    Math.max(0.5, Math.min(3, file.size / 1000)),
                    Math.max(0.5, Math.min(3, (file.complexity || 1) / 5))
                );
                
                const material = new THREE.MeshLambertMaterial({
                    color: getFileColor(file.extension, file.complexity),
                    transparent: true,
                    opacity: 0.8
                });
                
                const mesh = new THREE.Mesh(geometry, material);
                
                // Position files in 3D space based on directory structure and relationships
                const pos = calculateNodePosition(file, index);
                mesh.position.set(pos.x, pos.y, pos.z);
                
                // Add subtle rotation for visual interest
                mesh.rotation.x = Math.random() * 0.2;
                mesh.rotation.y = Math.random() * 0.2;
                mesh.rotation.z = Math.random() * 0.2;
                
                mesh.userData = { file, type: 'file' };
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                
                fileNodes.add(mesh);
            });
        }
        
        function createDependencyLines() {
            // Clear existing lines
            while(dependencyLines.children.length > 0) {
                dependencyLines.remove(dependencyLines.children[0]);
            }
            
            if (!document.getElementById('show-deps').checked) return;
            
            analysisData.dependencies.forEach(dep => {
                const fromFile = analysisData.files.find(f => f.path === dep.from);
                const toFile = analysisData.files.find(f => f.path === dep.to);
                
                if (fromFile && toFile) {
                    const fromIndex = analysisData.files.indexOf(fromFile);
                    const toIndex = analysisData.files.indexOf(toFile);
                    
                    const fromPos = calculateNodePosition(fromFile, fromIndex);
                    const toPos = calculateNodePosition(toFile, toIndex);
                    
                    const curve = new THREE.QuadraticBezierCurve3(
                        new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z),
                        new THREE.Vector3(
                            (fromPos.x + toPos.x) / 2,
                            Math.max(fromPos.y, toPos.y) + 5,
                            (fromPos.z + toPos.z) / 2
                        ),
                        new THREE.Vector3(toPos.x, toPos.y, toPos.z)
                    );
                    
                    const geometry = new THREE.TubeGeometry(curve, 20, 0.1, 8, false);
                    const material = new THREE.MeshBasicMaterial({
                        color: 0x00ff88,
                        transparent: true,
                        opacity: 0.6
                    });
                    
                    const mesh = new THREE.Mesh(geometry, material);
                    dependencyLines.add(mesh);
                }
            });
        }
        
        function calculateNodePosition(file, index) {
            // Create a more organic 3D layout based on file structure
            const pathParts = file.path.split('/');
            const depth = pathParts.length;
            
            // Use a spiral pattern with depth-based layers
            const angle = (index * 0.5) % (Math.PI * 2);
            const radius = 5 + (depth * 3);
            
            return {
                x: Math.cos(angle) * radius + (Math.random() - 0.5) * 2,
                y: (depth - 2) * 4 + (Math.random() - 0.5) * 2,
                z: Math.sin(angle) * radius + (Math.random() - 0.5) * 2
            };
        }
        
        function getFileColor(extension, complexity) {
            const baseColors = {
                '.js': 0xffff00,   // Yellow
                '.ts': 0x0088ff,   // Blue  
                '.py': 0x00ff00,   // Green
                '.java': 0xff4400, // Orange
                '.cpp': 0xff0044,  // Red
                '.css': 0x8800ff,  // Purple
                '.html': 0xff8800, // Orange
                '.json': 0x888888, // Gray
                '.md': 0x00ffff,   // Cyan
            };
            
            let baseColor = baseColors[extension] || 0xffffff;
            
            if (document.getElementById('show-complexity')?.checked && complexity) {
                // Modify color based on complexity
                const complexityFactor = Math.min(complexity / 20, 1);
                const red = (baseColor >> 16) & 0xff;
                const green = (baseColor >> 8) & 0xff;
                const blue = baseColor & 0xff;
                
                // Increase red component for higher complexity
                const newRed = Math.min(255, red + (complexityFactor * 100));
                baseColor = (newRed << 16) | (green << 8) | blue;
            }
            
            return baseColor;
        }
        
        function updateFileList() {
            const fileList = document.getElementById('file-list');
            fileList.innerHTML = '';
            
            analysisData.files.slice(0, 20).forEach(file => {
                const div = document.createElement('div');
                div.className = 'file-node';
                div.textContent = file.name;
                div.onclick = () => selectFile(file);
                fileList.appendChild(div);
            });
            
            if (analysisData.files.length > 20) {
                const more = document.createElement('div');
                more.textContent = \`... and \${analysisData.files.length - 20} more files\`;
                more.style.opacity = '0.7';
                fileList.appendChild(more);
            }
        }
        
        function selectFile(file) {
            selectedFile = file;
            
            // Highlight selected file in 3D scene
            fileNodes.children.forEach(node => {
                if (node.userData.file === file) {
                    node.material.emissive = new THREE.Color(0x444444);
                } else {
                    node.material.emissive = new THREE.Color(0x000000);
                }
            });
            
            // Update sidebar details
            const details = document.getElementById('file-details');
            details.innerHTML = \`
                <h4>\${file.name}</h4>
                <p><strong>Path:</strong> \${file.path}</p>
                <p><strong>Size:</strong> \${file.size} bytes</p>
                <p><strong>Lines:</strong> \${file.lines}</p>
                <p><strong>Extension:</strong> \${file.extension}</p>
                <p><strong>Complexity:</strong> \${file.complexity || 'N/A'}</p>
                <p><strong>Dependencies:</strong> \${file.dependencies.length}</p>
                \${file.dependencies.length > 0 ? 
                    '<p><strong>Imports:</strong><br>' + file.dependencies.slice(0, 5).join('<br>') + 
                    (file.dependencies.length > 5 ? '<br>...' : '') + '</p>' : ''
                }
            \`;
        }
        
        function setupEventListeners() {
            // Keyboard controls
            const keys = {};
            document.addEventListener('keydown', (e) => {
                keys[e.key.toLowerCase()] = true;
                
                if (e.key === ' ') {
                    e.preventDefault();
                    // Reset camera view
                    camera.position.set(20, 20, 20);
                    controls.reset();
                }
            });
            
            document.addEventListener('keyup', (e) => {
                keys[e.key.toLowerCase()] = false;
            });
            
            function updateMovement() {
                const speed = 0.5;
                if (keys['w']) camera.position.z -= speed;
                if (keys['s']) camera.position.z += speed;
                if (keys['a']) camera.position.x -= speed;
                if (keys['d']) camera.position.x += speed;
            }
            
            // Mouse interactions
            const raycaster = new THREE.Raycaster();
            const mouse = new THREE.Vector2();
            
            renderer.domElement.addEventListener('click', (event) => {
                mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
                mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
                
                raycaster.setFromCamera(mouse, camera);
                const intersects = raycaster.intersectObjects(fileNodes.children);
                
                if (intersects.length > 0) {
                    const selectedObject = intersects[0].object;
                    if (selectedObject.userData.file) {
                        selectFile(selectedObject.userData.file);
                    }
                }
            });
            
            // View option controls
            document.getElementById('show-deps').addEventListener('change', createDependencyLines);
            document.getElementById('show-complexity').addEventListener('change', createFileNodes);
            document.getElementById('animate').addEventListener('change', (e) => {
                // Animation toggle handled in render loop
            });
            
            // Update movement in render loop
            setInterval(updateMovement, 16);
        }
        
        function animate() {
            requestAnimationFrame(animate);
            
            controls.update();
            
            // Animate nodes if enabled
            if (document.getElementById('animate')?.checked) {
                fileNodes.children.forEach((node, index) => {
                    node.rotation.y += 0.01;
                    node.position.y += Math.sin(Date.now() * 0.001 + index) * 0.01;
                });
            }
            
            renderer.render(scene, camera);
        }
        
        // Handle window resize
        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    </script>
</body>
</html>`;
  }

  private getVRVisualizationPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenViz - VR Code Environment</title>
    <script src="https://aframe.io/releases/1.4.0/aframe.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/donmccurdy/aframe-extras@v6.1.1/dist/aframe-extras.min.js"></script>
    <style>
        body { margin: 0; }
        #info { 
            position: absolute; 
            top: 20px; 
            left: 20px; 
            color: white; 
            z-index: 100; 
            background: rgba(0,0,0,0.8); 
            padding: 20px; 
            border-radius: 10px;
            font-family: Arial, sans-serif;
        }
    </style>
</head>
<body>
    <div id="info">
        <h3>🥽 QwenViz VR - Code in Virtual Reality</h3>
        <p>Put on your VR headset or use mouse controls to navigate</p>
        <p>Controllers: Point and click to select files</p>
        <p>Teleport: Point at ground and trigger to move</p>
    </div>
    
    <a-scene 
        vr-mode-ui="enabled: true" 
        embedded 
        style="height: 100vh; width: 100vw;"
        background="color: #1a1a2e"
        fog="type: exponential; color: #1a1a2e; density: 0.01">
        
        <!-- Assets -->
        <a-assets>
            <a-mixin id="file-node" 
                     geometry="primitive: box; width: 1; height: 1; depth: 1"
                     material="color: #ff6b6b; metalness: 0.5; roughness: 0.2"
                     animation__mouseenter="property: scale; to: 1.2 1.2 1.2; startEvents: mouseenter; dur: 200"
                     animation__mouseleave="property: scale; to: 1 1 1; startEvents: mouseleave; dur: 200">
            </a-mixin>
        </a-assets>
        
        <!-- Lighting -->
        <a-light type="ambient" color="#404040" intensity="0.6"></a-light>
        <a-light type="directional" color="#ffffff" intensity="0.8" position="5 10 5"></a-light>
        <a-light type="point" color="#00ffff" intensity="0.5" position="0 5 0"></a-light>
        
        <!-- Environment -->
        <a-plane position="0 0 0" rotation="-90 0 0" width="50" height="50" color="#2a2a4e" 
                 material="metalness: 0.8; roughness: 0.2"></a-plane>
        
        <!-- Grid floor -->
        <a-entity id="grid-floor">
            <!-- Grid lines will be generated by JavaScript -->
        </a-entity>
        
        <!-- File nodes container -->
        <a-entity id="file-nodes">
            <!-- File nodes will be generated by JavaScript -->
        </a-entity>
        
        <!-- Dependency connections -->
        <a-entity id="dependency-lines">
            <!-- Lines will be generated by JavaScript -->
        </a-entity>
        
        <!-- User interface panels -->
        <a-plane id="info-panel" 
                 position="-3 2 -2" 
                 rotation="0 30 0" 
                 width="2" 
                 height="1.5" 
                 color="#000000" 
                 opacity="0.8"
                 text="value: QwenViz VR\\nFiles: Loading...\\nDependencies: Loading...; 
                       color: white; 
                       align: center; 
                       width: 8">
        </a-plane>
        
        <!-- VR Camera and controllers -->
        <a-entity id="rig" 
                  position="0 1.6 3"
                  movement-controls="constrainToNavMesh: false; speed: 0.3">
            
            <a-camera id="camera" 
                      wasd-controls="acceleration: 20"
                      look-controls="pointerLockEnabled: true">
                
                <!-- Cursor for non-VR interaction -->
                <a-cursor id="cursor"
                          animation__click="property: scale; startEvents: click; from: 0.1 0.1 0.1; to: 1 1 1; dur: 150"
                          animation__fusing="property: scale; startEvents: fusing; from: 1 1 1; to: 0.1 0.1 0.1; dur: 1500"
                          geometry="primitive: ring; radiusInner: 0.02; radiusOuter: 0.03"
                          material="color: white; shader: flat"
                          raycaster="objects: [data-clickable]">
                </a-cursor>
                
            </a-camera>
            
            <!-- VR Controllers -->
            <a-entity id="left-hand" 
                      hand-controls="hand: left; handModelStyle: lowPoly; color: #15ACCF"
                      teleport-controls="button: trigger; collisionEntities: [data-teleport]; 
                                       curveHitColor: #15ACCF; curveMissColor: #ff0000; 
                                       hitCylinderColor: #15ACCF; hitCylinderRadius: 0.5"
                      laser-controls="hand: left"
                      raycaster="objects: [data-clickable]; lineColor: #15ACCF; lineOpacity: 0.5">
            </a-entity>
            
            <a-entity id="right-hand" 
                      hand-controls="hand: right; handModelStyle: lowPoly; color: #15ACCF"
                      teleport-controls="button: trigger; collisionEntities: [data-teleport]; 
                                       curveHitColor: #15ACCF; curveMissColor: #ff0000; 
                                       hitCylinderColor: #15ACCF; hitCylinderRadius: 0.5"
                      laser-controls="hand: right"
                      raycaster="objects: [data-clickable]; lineColor: #15ACCF; lineOpacity: 0.5">
            </a-entity>
            
        </a-entity>
        
    </a-scene>
    
    <script>
        // VR Scene controller
        class VRCodeVisualization {
            constructor() {
                this.scene = document.querySelector('a-scene');
                this.fileNodesContainer = document.querySelector('#file-nodes');
                this.dependencyLinesContainer = document.querySelector('#dependency-lines');
                this.infoPanel = document.querySelector('#info-panel');
                this.analysisData = null;
                
                this.init();
            }
            
            async init() {
                // Wait for A-Frame to load
                this.scene.addEventListener('loaded', () => {
                    this.createGridFloor();
                    this.loadAnalysis();
                });
            }
            
            createGridFloor() {
                const gridContainer = document.querySelector('#grid-floor');
                const gridSize = 50;
                const gridSpacing = 2;
                
                for (let x = -gridSize; x <= gridSize; x += gridSpacing) {
                    const line = document.createElement('a-entity');
                    line.setAttribute('geometry', {
                        primitive: 'cylinder',
                        radius: 0.01,
                        height: gridSize * 2
                    });
                    line.setAttribute('material', {
                        color: '#444466',
                        opacity: 0.3
                    });
                    line.setAttribute('position', \`\${x} 0.01 0\`);
                    line.setAttribute('rotation', '0 0 90');
                    line.setAttribute('data-teleport', '');
                    gridContainer.appendChild(line);
                }
                
                for (let z = -gridSize; z <= gridSize; z += gridSpacing) {
                    const line = document.createElement('a-entity');
                    line.setAttribute('geometry', {
                        primitive: 'cylinder',
                        radius: 0.01,
                        height: gridSize * 2
                    });
                    line.setAttribute('material', {
                        color: '#444466',
                        opacity: 0.3
                    });
                    line.setAttribute('position', \`0 0.01 \${z}\`);
                    line.setAttribute('rotation', '90 0 0');
                    line.setAttribute('data-teleport', '');
                    gridContainer.appendChild(line);
                }
            }
            
            async loadAnalysis() {
                try {
                    // Connect to WebSocket for real-time data
                    const ws = new WebSocket(\`ws://\${window.location.host}\`);
                    
                    ws.onopen = () => {
                        ws.send(JSON.stringify({
                            type: 'analyze',
                            options: {
                                depth: 4,
                                includeTests: true,
                                includeDocs: false
                            }
                        }));
                    };
                    
                    ws.onmessage = (event) => {
                        const message = JSON.parse(event.data);
                        if (message.type === 'analysis') {
                            this.analysisData = message.data;
                            this.createVRVisualization();
                        }
                    };
                    
                } catch (error) {
                    console.error('Failed to load analysis:', error);
                    this.createDemoVisualization();
                }
            }
            
            createVRVisualization() {
                if (!this.analysisData) return;
                
                this.updateInfoPanel();
                this.createFileNodes();
                this.createDependencyConnections();
            }
            
            updateInfoPanel() {
                this.infoPanel.setAttribute('text', {
                    value: \`QwenViz VR\\n\\nFiles: \${this.analysisData.files.length}\\nDependencies: \${this.analysisData.dependencies.length}\\nComplexity: \${this.analysisData.complexity.cyclomatic.toFixed(2)}\\n\\nPoint and click to explore!\`,
                    color: 'white',
                    align: 'center',
                    width: 8
                });
            }
            
            createFileNodes() {
                this.analysisData.files.forEach((file, index) => {
                    const node = document.createElement('a-entity');
                    
                    // Calculate position in 3D space
                    const pos = this.calculateVRPosition(file, index);
                    
                    // Size based on file properties
                    const width = Math.max(0.3, Math.min(2, file.lines / 100));
                    const height = Math.max(0.3, Math.min(2, file.size / 2000));
                    const depth = Math.max(0.3, Math.min(2, (file.complexity || 1) / 10));
                    
                    node.setAttribute('geometry', {
                        primitive: 'box',
                        width: width,
                        height: height,
                        depth: depth
                    });
                    
                    node.setAttribute('material', {
                        color: this.getVRFileColor(file.extension),
                        metalness: 0.3,
                        roughness: 0.4
                    });
                    
                    node.setAttribute('position', \`\${pos.x} \${pos.y} \${pos.z}\`);
                    
                    // Add rotation for visual interest
                    node.setAttribute('rotation', \`\${Math.random() * 20} \${Math.random() * 20} \${Math.random() * 20}\`);
                    
                    // Make it interactive
                    node.setAttribute('data-clickable', '');
                    node.setAttribute('class', 'file-node');
                    
                    // Add hover and click animations
                    node.setAttribute('animation__mouseenter', {
                        property: 'scale',
                        to: '1.2 1.2 1.2',
                        startEvents: 'mouseenter',
                        dur: 200
                    });
                    
                    node.setAttribute('animation__mouseleave', {
                        property: 'scale',
                        to: '1 1 1',
                        startEvents: 'mouseleave',
                        dur: 200
                    });
                    
                    // Add file information as text above the node
                    const label = document.createElement('a-text');
                    label.setAttribute('value', file.name);
                    label.setAttribute('position', '0 2 0');
                    label.setAttribute('align', 'center');
                    label.setAttribute('color', 'white');
                    label.setAttribute('scale', '0.5 0.5 0.5');
                    label.setAttribute('look-at', '#camera');
                    node.appendChild(label);
                    
                    // Store file data
                    node.fileData = file;
                    
                    // Add click handler
                    node.addEventListener('click', () => {
                        this.selectFileInVR(file, node);
                    });
                    
                    this.fileNodesContainer.appendChild(node);
                });
            }
            
            calculateVRPosition(file, index) {
                // Create an organic 3D layout for VR
                const pathDepth = file.path.split('/').length;
                
                // Use a spiral tower pattern
                const angle = (index * 1.2) % (Math.PI * 2);
                const radius = 3 + (pathDepth * 1.5);
                const height = (index * 0.3) % 10 + 1;
                
                return {
                    x: Math.cos(angle) * radius,
                    y: height,
                    z: Math.sin(angle) * radius
                };
            }
            
            getVRFileColor(extension) {
                const colors = {
                    '.js': '#FFD700',   // Gold
                    '.ts': '#4A90E2',   // Blue
                    '.py': '#4CAF50',   // Green
                    '.java': '#FF5722', // Deep Orange
                    '.cpp': '#F44336',  // Red
                    '.css': '#9C27B0',  // Purple
                    '.html': '#FF9800', // Orange
                    '.json': '#9E9E9E', // Gray
                    '.md': '#00BCD4',   // Cyan
                };
                return colors[extension] || '#FFFFFF';
            }
            
            createDependencyConnections() {
                this.analysisData.dependencies.forEach((dep, index) => {
                    if (index > 50) return; // Limit for VR performance
                    
                    const fromFile = this.analysisData.files.find(f => f.path === dep.from);
                    const toFile = this.analysisData.files.find(f => f.path === dep.to);
                    
                    if (fromFile && toFile) {
                        const fromIndex = this.analysisData.files.indexOf(fromFile);
                        const toIndex = this.analysisData.files.indexOf(toFile);
                        
                        const fromPos = this.calculateVRPosition(fromFile, fromIndex);
                        const toPos = this.calculateVRPosition(toFile, toIndex);
                        
                        // Create a curved connection line
                        const midPoint = {
                            x: (fromPos.x + toPos.x) / 2,
                            y: Math.max(fromPos.y, toPos.y) + 2,
                            z: (fromPos.z + toPos.z) / 2
                        };
                        
                        // Create line segments for the curve
                        this.createCurvedLine(fromPos, midPoint, toPos);
                    }
                });
            }
            
            createCurvedLine(from, mid, to) {
                // Create two line segments to approximate a curve
                const line1 = document.createElement('a-entity');
                line1.setAttribute('geometry', {
                    primitive: 'cylinder',
                    radius: 0.02,
                    height: this.distance(from, mid)
                });
                line1.setAttribute('material', {
                    color: '#00FF88',
                    opacity: 0.6
                });
                
                // Position and rotate the first line segment
                const midPoint1 = {
                    x: (from.x + mid.x) / 2,
                    y: (from.y + mid.y) / 2,
                    z: (from.z + mid.z) / 2
                };
                line1.setAttribute('position', \`\${midPoint1.x} \${midPoint1.y} \${midPoint1.z}\`);
                line1.setAttribute('look-at', \`\${mid.x} \${mid.y} \${mid.z}\`);
                
                // Create second line segment
                const line2 = document.createElement('a-entity');
                line2.setAttribute('geometry', {
                    primitive: 'cylinder',
                    radius: 0.02,
                    height: this.distance(mid, to)
                });
                line2.setAttribute('material', {
                    color: '#00FF88',
                    opacity: 0.6
                });
                
                const midPoint2 = {
                    x: (mid.x + to.x) / 2,
                    y: (mid.y + to.y) / 2,
                    z: (mid.z + to.z) / 2
                };
                line2.setAttribute('position', \`\${midPoint2.x} \${midPoint2.y} \${midPoint2.z}\`);
                line2.setAttribute('look-at', \`\${to.x} \${to.y} \${to.z}\`);
                
                this.dependencyLinesContainer.appendChild(line1);
                this.dependencyLinesContainer.appendChild(line2);
            }
            
            distance(pos1, pos2) {
                return Math.sqrt(
                    Math.pow(pos2.x - pos1.x, 2) +
                    Math.pow(pos2.y - pos1.y, 2) +
                    Math.pow(pos2.z - pos1.z, 2)
                );
            }
            
            selectFileInVR(file, node) {
                // Highlight selected file
                this.fileNodesContainer.querySelectorAll('.file-node').forEach(n => {
                    n.setAttribute('material', 'emissive', '#000000');
                });
                
                node.setAttribute('material', 'emissive', '#333333');
                
                // Update info panel with file details
                const details = \`Selected File:\\n\${file.name}\\n\\nSize: \${file.size} bytes\\nLines: \${file.lines}\\nComplexity: \${file.complexity || 'N/A'}\\nDependencies: \${file.dependencies.length}\`;
                
                this.infoPanel.setAttribute('text', {
                    value: details,
                    color: 'white',
                    align: 'center',
                    width: 8
                });
                
                console.log('Selected file in VR:', file);
            }
            
            createDemoVisualization() {
                // Create a demo visualization if analysis fails
                console.log('Creating demo VR visualization...');
                
                for (let i = 0; i < 20; i++) {
                    const node = document.createElement('a-entity');
                    
                    node.setAttribute('geometry', {
                        primitive: 'box',
                        width: 0.5 + Math.random(),
                        height: 0.5 + Math.random(),
                        depth: 0.5 + Math.random()
                    });
                    
                    node.setAttribute('material', {
                        color: \`hsl(\${Math.random() * 360}, 70%, 60%)\`,
                        metalness: 0.3,
                        roughness: 0.4
                    });
                    
                    const angle = (i / 20) * Math.PI * 2;
                    const radius = 3 + Math.random() * 3;
                    const height = 1 + Math.random() * 5;
                    
                    node.setAttribute('position', \`\${Math.cos(angle) * radius} \${height} \${Math.sin(angle) * radius}\`);
                    node.setAttribute('data-clickable', '');
                    
                    this.fileNodesContainer.appendChild(node);
                }
                
                this.infoPanel.setAttribute('text', {
                    value: 'QwenViz VR Demo\\n\\nExploring demo codebase\\nPut on VR headset for best experience!',
                    color: 'white',
                    align: 'center',
                    width: 8
                });
            }
        }
        
        // Initialize VR visualization
        const vrViz = new VRCodeVisualization();
    </script>
</body>
</html>`;
  }
}