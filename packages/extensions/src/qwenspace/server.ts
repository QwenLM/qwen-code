/**
 * VR Collaboration Server for QwenSpace
 * Provides multi-user VR collaboration platform
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import * as path from 'path';
import { VRCodeAnalyzer } from './analyzer.js';
import { VREnvironmentGenerator } from './generator.js';

export class VRCollaborationServer {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer | null = null;
  private analyzer: VRCodeAnalyzer;
  private generator: VREnvironmentGenerator;
  private isRunning = false;
  private rooms: Map<string, any> = new Map();
  private users: Map<string, any> = new Map();

  constructor() {
    this.app = express();
    this.analyzer = new VRCodeAnalyzer();
    this.generator = new VREnvironmentGenerator();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Serve static files
    this.app.use('/static', express.static(path.join(__dirname, '../web-assets')));
    
    // API routes
    this.app.get('/api/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        rooms: this.rooms.size, 
        users: this.users.size,
        timestamp: new Date().toISOString() 
      });
    });

    this.app.get('/api/rooms', (req, res) => {
      const roomList = Array.from(this.rooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        environment: room.environment,
        userCount: room.users?.length || 0,
        maxUsers: room.maxUsers,
        isPublic: room.isPublic
      }));
      res.json(roomList);
    });

    this.app.get('/api/room/:roomId', (req, res) => {
      const room = this.rooms.get(req.params.roomId);
      if (room) {
        res.json(room);
      } else {
        res.status(404).json({ error: 'Room not found' });
      }
    });

    // Main page
    this.app.get('/', (req, res) => {
      res.send(this.getMainPage());
    });

    // VR room interface
    this.app.get('/room/:roomId', (req, res) => {
      const roomId = req.params.roomId;
      const vrMode = req.query.mode as string || 'desktop';
      res.send(this.getVRRoomPage(roomId, vrMode));
    });

    // Room lobby
    this.app.get('/lobby', (req, res) => {
      res.send(this.getLobbyPage());
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
        console.log(`🥽 QwenSpace VR server started at ${url}`);
        resolve(url);
      });

      this.server.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  async createRoom(config: any): Promise<string> {
    const roomId = `room-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`;
    
    const room = {
      id: roomId,
      name: `${config.environment} Collaboration Room`,
      environment: config.environment || 'office',
      maxUsers: config.maxUsers || 8,
      users: [],
      features: config.features || ['code-editing', 'voice-chat'],
      voiceChat: config.voiceChat ?? true,
      screenShare: config.screenShare ?? true,
      createdAt: new Date().toISOString(),
      isPublic: true
    };
    
    this.rooms.set(roomId, room);
    console.log(`🏗️ Created VR room: ${roomId}`);
    
    return roomId;
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
          this.rooms.clear();
          this.users.clear();
          console.log('🛑 QwenSpace VR server stopped');
          resolve();
        }
      });
    });
  }

  private setupWebSocketHandlers(projectPath: string): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws, req) => {
      const userId = this.generateUserId();
      const userAgent = req.headers['user-agent'] || '';
      const isVRCapable = this.detectVRCapability(userAgent);
      
      console.log(`🥽 New VR client connected: ${userId} (VR: ${isVRCapable})`);
      
      const user = {
        id: userId,
        ws,
        roomId: null,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        isVRCapable,
        avatar: this.generateAvatar()
      };
      
      this.users.set(userId, user);

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          await this.handleUserMessage(userId, data);
        } catch (error) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: error instanceof Error ? error.message : 'Unknown error' 
          }));
        }
      });

      ws.on('close', () => {
        this.handleUserDisconnect(userId);
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'welcome',
        userId,
        isVRCapable,
        avatar: user.avatar
      }));
    });
  }

  private async handleUserMessage(userId: string, data: any): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;

    switch (data.type) {
      case 'join_room':
        await this.handleJoinRoom(userId, data.roomId);
        break;
        
      case 'leave_room':
        await this.handleLeaveRoom(userId);
        break;
        
      case 'update_position':
        await this.handlePositionUpdate(userId, data.position, data.rotation);
        break;
        
      case 'voice_data':
        await this.handleVoiceData(userId, data.audioData);
        break;
        
      case 'code_edit':
        await this.handleCodeEdit(userId, data.file, data.changes);
        break;
        
      case 'whiteboard_draw':
        await this.handleWhiteboardDraw(userId, data.whiteboardId, data.drawData);
        break;
        
      case 'screen_share':
        await this.handleScreenShare(userId, data.screenData);
        break;
        
      case 'chat_message':
        await this.handleChatMessage(userId, data.message);
        break;
        
      default:
        user.ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
  }

  private async handleJoinRoom(userId: string, roomId: string): Promise<void> {
    const user = this.users.get(userId);
    const room = this.rooms.get(roomId);
    
    if (!user || !room) {
      user?.ws.send(JSON.stringify({ type: 'error', message: 'User or room not found' }));
      return;
    }
    
    if (room.users.length >= room.maxUsers) {
      user.ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
      return;
    }
    
    // Remove user from previous room
    if (user.roomId) {
      await this.handleLeaveRoom(userId);
    }
    
    // Add user to room
    user.roomId = roomId;
    room.users.push(userId);
    
    // Send room data to user
    user.ws.send(JSON.stringify({
      type: 'room_joined',
      room: room,
      users: room.users.map((uid: string) => {
        const u = this.users.get(uid);
        return u ? {
          id: uid,
          position: u.position,
          rotation: u.rotation,
          avatar: u.avatar
        } : null;
      }).filter(Boolean)
    }));
    
    // Notify other users in room
    this.broadcastToRoom(roomId, {
      type: 'user_joined',
      user: {
        id: userId,
        position: user.position,
        rotation: user.rotation,
        avatar: user.avatar
      }
    }, [userId]);
    
    console.log(`👤 User ${userId} joined room ${roomId}`);
  }

  private async handleLeaveRoom(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;
    
    const room = this.rooms.get(user.roomId);
    if (room) {
      room.users = room.users.filter((uid: string) => uid !== userId);
      
      // Notify other users
      this.broadcastToRoom(user.roomId, {
        type: 'user_left',
        userId
      }, [userId]);
    }
    
    user.roomId = null;
    console.log(`👤 User ${userId} left room`);
  }

  private async handlePositionUpdate(userId: string, position: number[], rotation: number[]): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;
    
    user.position = position;
    user.rotation = rotation;
    
    // Broadcast position to other users in room
    this.broadcastToRoom(user.roomId, {
      type: 'user_moved',
      userId,
      position,
      rotation
    }, [userId]);
  }

  private async handleVoiceData(userId: string, audioData: any): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;
    
    const room = this.rooms.get(user.roomId);
    if (!room || !room.voiceChat) return;
    
    // Broadcast voice data with spatial audio information
    this.broadcastToRoom(user.roomId, {
      type: 'voice_data',
      userId,
      audioData,
      position: user.position
    }, [userId]);
  }

  private async handleCodeEdit(userId: string, file: string, changes: any): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;
    
    // Broadcast code changes to room
    this.broadcastToRoom(user.roomId, {
      type: 'code_updated',
      userId,
      file,
      changes,
      timestamp: Date.now()
    }, [userId]);
  }

  private async handleWhiteboardDraw(userId: string, whiteboardId: string, drawData: any): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;
    
    // Broadcast whiteboard updates
    this.broadcastToRoom(user.roomId, {
      type: 'whiteboard_updated',
      userId,
      whiteboardId,
      drawData,
      timestamp: Date.now()
    }, [userId]);
  }

  private async handleScreenShare(userId: string, screenData: any): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;
    
    const room = this.rooms.get(user.roomId);
    if (!room || !room.screenShare) return;
    
    // Broadcast screen share data
    this.broadcastToRoom(user.roomId, {
      type: 'screen_shared',
      userId,
      screenData
    }, [userId]);
  }

  private async handleChatMessage(userId: string, message: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;
    
    // Broadcast chat message
    this.broadcastToRoom(user.roomId, {
      type: 'chat_message',
      userId,
      message,
      timestamp: Date.now()
    });
  }

  private handleUserDisconnect(userId: string): void {
    const user = this.users.get(userId);
    if (user) {
      if (user.roomId) {
        this.handleLeaveRoom(userId);
      }
      this.users.delete(userId);
    }
    console.log(`👤 User ${userId} disconnected`);
  }

  private broadcastToRoom(roomId: string, message: any, exclude: string[] = []): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    room.users.forEach((userId: string) => {
      if (exclude.includes(userId)) return;
      
      const user = this.users.get(userId);
      if (user && user.ws.readyState === 1) {
        user.ws.send(JSON.stringify(message));
      }
    });
  }

  private generateUserId(): string {
    return `user-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`;
  }

  private detectVRCapability(userAgent: string): boolean {
    const vrIndicators = ['oculus', 'vive', 'cardboard', 'daydream', 'xr', 'webxr'];
    return vrIndicators.some(indicator => userAgent.toLowerCase().includes(indicator));
  }

  private generateAvatar(): any {
    const avatars = ['🤖', '👨‍💻', '👩‍💻', '🧑‍🚀', '👨‍🔬', '👩‍🔬', '🧙‍♂️', '🧙‍♀️'];
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#FDCB6E'];
    
    return {
      emoji: avatars[Math.floor(Math.random() * avatars.length)],
      color: colors[Math.floor(Math.random() * colors.length)],
      name: `Dev${Math.floor(Math.random() * 1000)}`
    };
  }

  private getMainPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenSpace - VR Code Collaboration</title>
    <style>
        body { 
            font-family: 'Arial', sans-serif; 
            margin: 0; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 50px; }
        .header h1 { 
            font-size: 4em; 
            margin: 0; 
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .rooms-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 20px; 
            margin-bottom: 40px;
        }
        .room-card {
            background: rgba(255,255,255,0.1);
            padding: 25px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
        }
        .join-btn {
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 25px;
            cursor: pointer;
            font-weight: bold;
            margin-top: 15px;
        }
        .create-room {
            text-align: center;
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🥽 QwenSpace</h1>
            <p>Virtual Reality Code Collaboration Platform</p>
        </div>
        
        <div class="create-room">
            <h2>🏗️ Create New VR Room</h2>
            <p>Start a new virtual collaboration session</p>
            <button class="join-btn" onclick="createRoom()">Create Room</button>
        </div>
        
        <h2>🏢 Available Rooms</h2>
        <div class="rooms-grid" id="rooms-list">
            <div class="room-card">
                <h3>🏢 Office Demo Room</h3>
                <p>Professional environment for team meetings</p>
                <p>👥 0/8 users | 🎯 Features: Voice, Code, Whiteboard</p>
                <button class="join-btn" onclick="joinRoom('demo-office')">Join Room</button>
            </div>
        </div>
    </div>
    
    <script>
        function createRoom() {
            // In a real implementation, this would open a room creation dialog
            const roomId = 'room-' + Date.now().toString(36);
            window.location.href = '/room/' + roomId + '?mode=desktop';
        }
        
        function joinRoom(roomId) {
            window.location.href = '/room/' + roomId + '?mode=desktop';
        }
        
        // Load room list
        fetch('/api/rooms')
            .then(r => r.json())
            .then(rooms => {
                // Update rooms list
                console.log('Available rooms:', rooms);
            });
    </script>
</body>
</html>`;
  }

  private getVRRoomPage(roomId: string, vrMode: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenSpace VR Room - ${roomId}</title>
    <script src="https://aframe.io/releases/1.4.0/aframe.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/donmccurdy/aframe-extras@v6.1.1/dist/aframe-extras.min.js"></script>
    <script src="https://unpkg.com/networked-aframe/dist/networked-aframe.min.js"></script>
</head>
<body>
    <a-scene 
        networked-scene="
            room: ${roomId};
            debug: true;
            adapter: websocket;
            serverURL: ws://localhost:${this.server?.address()?.port || 3004};
        "
        vr-mode-ui="enabled: true"
        embedded>
        
        <!-- Assets -->
        <a-assets>
            <!-- Avatar templates -->
            <template id="avatar-template">
                <a-entity class="avatar">
                    <a-sphere color="blue" radius="0.2" position="0 1.6 0"></a-sphere>
                    <a-text value="User" position="0 2 0" align="center" color="white"></a-text>
                </a-entity>
            </template>
        </a-assets>
        
        <!-- Environment -->
        <a-sky color="#667eea"></a-sky>
        <a-plane position="0 0 0" rotation="-90 0 0" width="50" height="50" color="#764ba2"></a-plane>
        
        <!-- Room elements will be dynamically generated -->
        <a-entity id="room-content"></a-entity>
        
        <!-- User rig -->
        <a-entity id="rig" 
                  networked="template:#avatar-template;attachTemplateToLocal:false;"
                  position="0 1.6 3">
            <a-camera look-controls wasd-controls></a-camera>
            <a-entity id="left-hand" hand-controls="hand: left"></a-entity>
            <a-entity id="right-hand" hand-controls="hand: right"></a-entity>
        </a-entity>
        
    </a-scene>
    
    <script>
        console.log('QwenSpace VR Room: ${roomId}');
        console.log('VR Mode: ${vrMode}');
        
        // Initialize VR room
        document.addEventListener('DOMContentLoaded', () => {
            // Setup room-specific functionality
            console.log('VR room initialized');
        });
    </script>
</body>
</html>`;
  }

  private getLobbyPage(): string {
    return `Lobby page HTML would go here...`;
  }
}