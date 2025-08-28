/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { RAGService } from '../rag/RAGService.js';

export class FileWatcherService {
  private ragService: RAGService;
  private watchedFiles: Set<string> = new Set();
  private fileWatchers: Map<string, fs.FSWatcher> = new Map();

  constructor() {
    const milvusAddress = 'localhost:19530'; // Default address
    this.ragService = new RAGService(milvusAddress);
  }

  async initialize(): Promise<void> {
    await this.ragService.initialize();
  }

  /**
   * Watch a file for changes and update the RAG system when it changes
   */
  watchFile(filePath: string): void {
    // Normalize the file path
    const normalizedPath = path.resolve(filePath);
    
    // If we're already watching this file, do nothing
    if (this.watchedFiles.has(normalizedPath)) {
      return;
    }
    
    try {
      // Create a watcher for the file
      const watcher = fs.watch(normalizedPath, async (eventType: string) => {
        if (eventType === 'change') {
          try {
            // Read the updated file content
            const content = fs.readFileSync(normalizedPath, 'utf8');
            
            // Update the RAG system with the new content
            await this.ragService.addOrUpdateCode(normalizedPath, content);
          } catch (error) {
            console.error(`Error updating RAG system for file ${normalizedPath}:`, error);
          }
        }
      });
      
      // Store the watcher
      this.fileWatchers.set(normalizedPath, watcher);
      this.watchedFiles.add(normalizedPath);
    } catch (error) {
      console.error(`Error watching file ${normalizedPath}:`, error);
    }
  }

  /**
   * Stop watching a file
   */
  unwatchFile(filePath: string): void {
    const normalizedPath = path.resolve(filePath);
    
    // Get the watcher for this file
    const watcher = this.fileWatchers.get(normalizedPath);
    if (watcher) {
      // Close the watcher
      watcher.close();
      
      // Remove from our tracking
      this.fileWatchers.delete(normalizedPath);
      this.watchedFiles.delete(normalizedPath);
    }
  }

  /**
   * Watch all files in a directory recursively
   */
  watchDirectory(dirPath: string): void {
    const normalizedPath = path.resolve(dirPath);
    
    try {
      // Read all files in the directory
      const files = fs.readdirSync(normalizedPath);
      
      for (const file of files) {
        const filePath = path.join(normalizedPath, file);
        
        try {
          const stats = fs.statSync(filePath);
          
          if (stats.isFile()) {
            // Watch the file
            this.watchFile(filePath);
          } else if (stats.isDirectory()) {
            // Recursively watch subdirectories
            this.watchDirectory(filePath);
          }
        } catch (error) {
          console.error(`Error accessing file ${filePath}:`, error);
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${normalizedPath}:`, error);
    }
  }

  /**
   * Stop watching all files
   */
  close(): void {
    // Close all watchers
    for (const [filePath, watcher] of this.fileWatchers.entries()) {
      try {
        watcher.close();
        this.watchedFiles.delete(filePath);
      } catch (error) {
        console.error(`Error closing watcher for file ${filePath}:`, error);
      }
    }
    
    // Clear the maps
    this.fileWatchers.clear();
    
    // Close the RAG service
    this.ragService.close().catch(error => {
      console.error('Error closing RAG service:', error);
    });
  }
}