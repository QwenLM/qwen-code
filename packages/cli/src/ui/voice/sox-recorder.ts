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
} from '../hooks/use-voice-input.js';

// SoX `silence` effect: stop after 2.0s below 3% amplitude (matches CC).
const SILENCE_EFFECT_ARGS = ['silence', '1', '0.1', '3%', '1', '2.0', '3%'];
const MAX_STDERR_LENGTH = 4096;

function toSoxError(error: Error): Error {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    return new Error(
      'SoX is not installed or not on PATH. Install SoX and try again.',
    );
  }
  return error;
}

function formatSoxExitError(code: number | null, stderr: string): Error {
  const detail = stderr.trim();
  return new Error(
    `Voice recorder failed with exit code ${code ?? 'unknown'}${
      detail ? `: ${detail}` : ''
    }.`,
  );
}

class SoxRecorder implements VoiceRecorder {
  private child: ChildProcess | null = null;
  private tmpDir: string | null = null;
  private filePath: string | null = null;
  private spawnError: Error | null = null;
  private stopRequested = false;
  private onAutoStop: (() => void) | null = null;
  private closeResult: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private stderr = '';
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
    this.spawnError = null;
    this.stopRequested = false;
    this.onAutoStop = null;
    this.closeResult = null;
    this.closePromise = null;
    this.stderr = '';
  }

  async start(options: VoiceRecorderStartOptions = {}): Promise<void> {
    this.stopRequested = false;
    this.onAutoStop = options.onAutoStop ?? null;
    this.tmpDir = await mkdtemp(path.join(tmpdir(), 'qwen-voice-'));
    this.filePath = path.join(this.tmpDir, 'recording.wav');
    this.child = spawn('sox', [
      '-d',
      '-r',
      '16000',
      '-c',
      '1',
      '-b',
      '16',
      this.filePath,
      ...(options.silenceDetection ? SILENCE_EFFECT_ARGS : []),
    ]);
    const child = this.child;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderr.length < MAX_STDERR_LENGTH) {
        this.stderr = (this.stderr + chunk.toString()).slice(
          0,
          MAX_STDERR_LENGTH,
        );
      }
    });
    this.closePromise = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.closeResult = { code, signal };
        // SoX exited on its own with a clean status while we were still
        // recording => the silence effect fired. Notify the hook to finalize.
        if (!this.stopRequested && code === 0 && this.onAutoStop) {
          this.onAutoStop();
        }
        resolve(this.closeResult);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', (error: Error) => {
          this.spawnError = toSoxError(error);
          reject(this.spawnError);
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
    this.stopRequested = true;
    const child = this.child;
    const filePath = this.filePath;
    const closePromise = this.closePromise;

    try {
      if (this.spawnError) {
        throw this.spawnError;
      }

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
        throw formatSoxExitError(closeResult.code, this.stderr);
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

export function createSoxRecorder(): VoiceRecorder {
  return new SoxRecorder();
}
