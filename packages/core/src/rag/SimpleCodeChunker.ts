/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
}

export class SimpleCodeChunker {
  constructor(private chunkSize: number) {}

  chunk(content: string): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = content.split('\n');
    let currentChunk = '';
    let startLine = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (currentChunk.length + line.length > this.chunkSize) {
        chunks.push({
          content: currentChunk,
          startLine,
          endLine: i,
        });
        currentChunk = '';
        startLine = i + 1;
      }
      currentChunk += line + '\n';
    }

    if (currentChunk) {
      chunks.push({
        content: currentChunk,
        startLine,
        endLine: lines.length,
      });
    }

    return chunks;
  }
}
