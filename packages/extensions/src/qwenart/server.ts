/**
 * Art Gallery Server for QwenArt
 * Hosts interactive art galleries
 */

import express from 'express';
import { createServer } from 'http';

export class ArtGalleryServer {
  private app: express.Application;
  private server: any;
  private isRunning = false;
  private artworks: any[] = [];

  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.get('/', (req, res) => {
      res.send('<h1>🎨 QwenArt Gallery</h1><p>Interactive code art gallery</p>');
    });

    this.app.get('/api/artworks', (req, res) => {
      res.json(this.artworks);
    });
  }

  async start(projectPath: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.app);
      this.server.listen(port, () => {
        this.isRunning = true;
        const url = `http://localhost:${port}`;
        resolve(url);
      });
      this.server.on('error', reject);
    });
  }

  async loadArtworks(artworks: any[]): Promise<void> {
    this.artworks = artworks;
  }

  async enableRealTimeMode(): Promise<void> {
    console.log('🔴 Real-time art mode enabled');
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.isRunning = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}