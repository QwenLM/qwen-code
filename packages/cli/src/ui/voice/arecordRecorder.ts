/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  RecordedVoiceAudio,
  VoiceRecorder,
  VoiceRecorderStartOptions,
} from '../hooks/useVoiceInput.js';

// arecord has no built-in silence trigger, so silenceDetection is ignored —
// recording runs until stop(). On WSL/headless Linux the binary exists but
// open() fails because there is no ALSA card; we probe by spawning and racing
// a short timer: still alive after the grace window => the device opened.
const DEVICE_OPEN_GRACE_MS = 200;

function toArecordError(error: Error): Error {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    return new Error(
      'arecord is not installed or not on PATH. Install alsa-utils and try again.',
    );
  }
  return error;
}

class ArecordRecorder implements VoiceRecorder {
  private child: ChildProcess | null = null;
  private tmpDir: string | null = null;
  private filePath: string | null = null;
  private closeResult: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private closePromise: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> | null = null;

  private async cleanup(): Promise<void> {
    const tmpDir = this.tmpDir;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    this.child = null;
    this.tmpDir = null;
    this.filePath = null;
    this.closeResult = null;
    this.closePromise = null;
  }

  async start(_options: VoiceRecorderStartOptions = {}): Promise<void> {
    this.tmpDir = await mkdtemp(path.join(tmpdir(), 'qwen-voice-'));
    this.filePath = path.join(this.tmpDir, 'recording.wav');
    const child = spawn('arecord', [
      '-q',
      '-f',
      'S16_LE',
      '-r',
      '16000',
      '-c',
      '1',
      '-t',
      'wav',
      this.filePath,
    ]);
    this.child = child;

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    this.closePromise = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.closeResult = { code, signal };
        resolve(this.closeResult);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const grace = setTimeout(() => {
          // Process is still alive after the grace window: it opened the device.
          settled = true;
          resolve();
        }, DEVICE_OPEN_GRACE_MS);

        child.once('error', (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(grace);
          reject(toArecordError(error));
        });
        child.once('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(grace);
          const detail = stderr.trim();
          reject(
            new Error(
              `arecord could not open an audio device (exit code ${code ?? 'unknown'})${
                detail ? `: ${detail}` : ''
              }.`,
            ),
          );
        });
      });
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<RecordedVoiceAudio> {
    if (!this.child || !this.tmpDir || !this.filePath) {
      throw new Error('Voice recorder was not started.');
    }
    const child = this.child;
    const filePath = this.filePath;
    const closePromise = this.closePromise;

    try {
      if (!this.closeResult) {
        child.kill('SIGINT');
      }

      const closeResult =
        this.closeResult ?? (closePromise ? await closePromise : null);
      if (
        closeResult &&
        closeResult.code !== 0 &&
        closeResult.signal !== 'SIGINT'
      ) {
        throw new Error(
          `Voice recorder failed with exit code ${closeResult.code ?? 'unknown'}.`,
        );
      }

      const data = await readFile(filePath);
      if (data.byteLength === 0) {
        throw new Error('Voice recorder produced empty audio.');
      }

      return {
        data,
        mimeType: 'audio/wav',
      };
    } finally {
      await this.cleanup();
    }
  }
}

export function createArecordRecorder(): VoiceRecorder {
  return new ArecordRecorder();
}
