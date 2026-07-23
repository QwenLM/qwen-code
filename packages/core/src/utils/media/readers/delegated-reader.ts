/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import type {
  MediaReadContext,
  MediaReader,
  MediaReadParams,
  MediaReadResult,
  ReaderBackendSpec,
} from '../reader-registry.js';
import { MediaReadError } from '../reader-registry.js';
import type { CostEstimate, MediaProbe, Modality } from '../types.js';

/**
 * P3 · Delegated reader executor (generic).
 *
 * One executor serves every delegated backend (OCR / ASR / dense-caption /
 * watcher). It does not know what any of them are — it only dispatches per the
 * `ReaderBackendSpec` and returns structured notes. Swapping the model behind a
 * delegated reader is editing the spec (`model` / `ref`), never this file
 * (信念三). Adding a new understanding method is adding a spec, not a core class.
 *
 * v1 dispatches `via: 'command'` (e.g. a local `whisper`/OCR CLI). `subagent`
 * and `mcp` dispatch integrate with runtime systems wired elsewhere; until then
 * they fail closed with a remedy rather than pretending to run.
 */

const DELEGATED_TIMEOUT_MS = 120_000;

function substituteTemplate(
  ref: string,
  probe: MediaProbe,
  spec: ReaderBackendSpec,
): string[] {
  return ref
    .trim()
    .split(/\s+/)
    .map((tok) =>
      tok
        .replaceAll('{path}', probe.path)
        .replaceAll('{model}', spec.model ?? ''),
    )
    .filter((tok) => tok.length > 0);
}

function runCommand(argv: string[], signal: AbortSignal): Promise<string> {
  const [cmd, ...args] = argv;
  return new Promise<string>((resolve, reject) => {
    execFile(
      cmd,
      args,
      { signal, timeout: DELEGATED_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString().trim() || err.message));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

class DelegatedReader implements MediaReader {
  readonly id: string;
  readonly kind = 'delegated' as const;
  readonly modalities: Modality[];

  constructor(private readonly spec: ReaderBackendSpec) {
    this.id = spec.id;
    this.modalities = spec.modalities ?? ['image', 'audio', 'video'];
  }

  isAvailable(): boolean {
    // A delegated backend is always a candidate; whether its dispatch works is
    // determined at read() time (fail-closed with remedy on failure).
    return true;
  }

  estimateCost(probe: MediaProbe): CostEstimate {
    const units = probe.durationSec ?? 1;
    return {
      tokens: Math.ceil(units),
      note: `delegated (${this.spec.via}:${this.spec.model ?? this.spec.ref})`,
    };
  }

  async read(
    probe: MediaProbe,
    _params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<MediaReadResult> {
    if (this.spec.via !== 'command') {
      throw new MediaReadError(
        'no-capability',
        `Delegated reader "${this.id}" uses via:"${this.spec.via}", which is not wired in this build.`,
        'Declare this reader with via:"command" (a local CLI backend), or use the native reader if the model supports the modality.',
      );
    }
    const argv = substituteTemplate(this.spec.ref, probe, this.spec);
    if (argv.length === 0) {
      throw new MediaReadError(
        'no-capability',
        `Delegated reader "${this.id}" has an empty command template.`,
        'Fix the reader `ref` in the media config to a runnable command, e.g. "whisper --model {model} {path}".',
      );
    }
    let note: string;
    try {
      note = await runCommand(argv, ctx.signal);
    } catch (err) {
      throw new MediaReadError(
        'no-capability',
        `Delegated reader "${this.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
        `Ensure "${argv[0]}" is installed and on PATH, or switch to a different reader for ${probe.modality}.`,
      );
    }
    return {
      content: [
        {
          text: `<delegated_note reader="${this.id}" modality="${probe.modality}">\n${note.trim()}\n</delegated_note>`,
        },
      ],
      scope: `delegated understanding via ${this.id}`,
      precision: `derived note from ${this.spec.model ?? this.spec.ref} (not raw bytes)`,
      cost: this.estimateCost(probe),
      readMore:
        'This is a derived note. For raw fidelity, read the media natively (if supported) or a specific range/region.',
    };
  }
}

export function createDelegatedReader(spec: ReaderBackendSpec): MediaReader {
  return new DelegatedReader(spec);
}
