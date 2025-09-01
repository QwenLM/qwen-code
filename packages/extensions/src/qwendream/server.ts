/**
 * Interactive Story Server for QwenDream
 * Provides web interface for interactive storytelling experiences
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import * as path from 'path';
import { CodeStoryAnalyzer } from './analyzer.js';
import { StoryGenerator } from './generator.js';

export class InteractiveStoryServer {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer | null = null;
  private analyzer: CodeStoryAnalyzer;
  private generator: StoryGenerator;
  private isRunning = false;
  private currentStory: any = null;

  constructor() {
    this.app = express();
    this.analyzer = new CodeStoryAnalyzer();
    this.generator = new StoryGenerator();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Serve static files
    this.app.use('/static', express.static(path.join(__dirname, '../web-assets')));
    
    // API routes
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'healthy', hasStory: !!this.currentStory, timestamp: new Date().toISOString() });
    });

    this.app.get('/api/analyze/:projectPath(*)', async (req, res) => {
      try {
        const projectPath = req.params.projectPath || process.cwd();
        const analysis = await this.analyzer.analyze(projectPath, {
          includeCode: req.query.includeCode !== 'false',
          characterize: req.query.characterize !== 'false',
          extractThemes: true,
          extractConflicts: true,
          extractJourney: true
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
          type: req.query.type as string || 'adventure',
          format: req.query.format as string || 'interactive',
          duration: req.query.duration ? parseInt(req.query.duration as string) : 15,
          interactive: req.query.interactive === 'true',
          visualNovel: req.query.visualNovel === 'true',
          includeCode: req.query.includeCode !== 'false'
        };

        const story = await this.generator.generate(analysis, options);
        this.currentStory = story;
        res.json(story);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Generation failed' });
      }
    });

    // Main page
    this.app.get('/', (req, res) => {
      res.send(this.getMainPage());
    });

    // Interactive story player
    this.app.get('/story', (req, res) => {
      res.send(this.getStoryPage());
    });

    // Visual novel mode
    this.app.get('/novel', (req, res) => {
      res.send(this.getVisualNovelPage());
    });

    // Story gallery
    this.app.get('/gallery', (req, res) => {
      res.send(this.getGalleryPage());
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
        console.log(`📖 QwenDream server started at ${url}`);
        resolve(url);
      });

      this.server.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  async loadStory(analysis: any, options: any): Promise<void> {
    this.currentStory = await this.generator.generate(analysis, options);
    
    // Broadcast story to all connected clients
    if (this.wss) {
      const message = JSON.stringify({
        type: 'story_loaded',
        data: this.currentStory
      });

      this.wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(message);
        }
      });
    }
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
          this.currentStory = null;
          console.log('🛑 QwenDream server stopped');
          resolve();
        }
      });
    });
  }

  private setupWebSocketHandlers(projectPath: string): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws) => {
      console.log('📚 New story client connected');

      // Send current story if available
      if (this.currentStory) {
        ws.send(JSON.stringify({
          type: 'story_loaded',
          data: this.currentStory
        }));
      }

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          switch (data.type) {
            case 'analyze':
              const analysis = await this.analyzer.analyze(projectPath, data.options || {});
              ws.send(JSON.stringify({ type: 'analysis', data: analysis }));
              break;
              
            case 'generate_story':
              const story = await this.generator.generate(data.analysis, data.options);
              this.currentStory = story;
              
              // Broadcast to all clients
              this.wss?.clients.forEach(client => {
                if (client.readyState === 1) {
                  client.send(JSON.stringify({ type: 'story_generated', data: story }));
                }
              });
              break;
              
            case 'make_choice':
              if (this.currentStory && this.currentStory.choices) {
                const choice = this.currentStory.choices.find((c: any) => c.id === data.choiceId);
                if (choice) {
                  ws.send(JSON.stringify({ 
                    type: 'choice_result', 
                    data: { 
                      choice, 
                      consequence: choice.consequence,
                      nextScene: choice.nextScene
                    }
                  }));
                }
              }
              break;
              
            case 'get_chapter':
              if (this.currentStory && this.currentStory.chapters) {
                const chapter = this.currentStory.chapters[data.chapterIndex];
                if (chapter) {
                  ws.send(JSON.stringify({ type: 'chapter_data', data: chapter }));
                }
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
        console.log('📚 Story client disconnected');
      });
    });
  }

  private getMainPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QwenDream - Code Story Generator</title>
</head>
<body>
    <h1>QwenDream Story Server</h1>
    <p>Interactive story generation from code</p>
</body>
</html>`;
  }

  private getStoryPage(): string {
    return `Interactive story page HTML would go here...`;
  }

  private getVisualNovelPage(): string {
    return `Visual novel page HTML would go here...`;
  }

  private getGalleryPage(): string {
    return `Gallery page HTML would go here...`;
  }
}