/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Content, Part } from '@google/genai';
import { getResponseText } from '../../partUtils.js';
import { getMediaProfile } from '../../../core/media/provider-media-profiles.js';
import { getMaxInlineMediaBytes } from '../../../core/inlineMediaLimit.js';
import { extractKeyframes } from '../keyframe-extractor.js';
import { transformImage } from '../ffmpeg-tools.js';
import { effortBudget } from '../media-effort.js';
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
 * Three dispatch kinds are wired:
 *  - `command`  — run a local CLI (whisper/OCR) that prints notes to stdout.
 *  - `subagent` — a one-shot multimodal understanding call: the media is turned
 *                 into model-ingestible parts (image/keyframes/audio) and a
 *                 dedicated (often vision) model describes it per `intent`.
 *  - `mcp`      — route to a discovered MCP tool by name, passing the file path.
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

/** Turn a media file into parts a multimodal model can ingest for understanding. */
async function toUnderstandingParts(
  probe: MediaProbe,
  params: MediaReadParams,
  ctx: MediaReadContext,
): Promise<Part[]> {
  const budget = effortBudget(params.effort);
  if (probe.modality === 'image') {
    const cap = getMediaProfile(ctx.config).imageMaxLongEdge;
    const t = await transformImage(probe, {
      ...(params.region ? { region: params.region } : {}),
      maxLongEdge: cap,
      signal: ctx.signal,
    });
    return [
      {
        inlineData: { data: t.buffer.toString('base64'), mimeType: t.mimeType },
      },
    ];
  }
  if (probe.modality === 'video') {
    const frames = await extractKeyframes(probe, {
      ...(params.range ? { range: params.range } : {}),
      maxFrames: budget.maxFrames,
      longEdge: budget.frameLongEdge,
      signal: ctx.signal,
    });
    return frames.parts;
  }
  // audio: inline the bytes when they fit; the delegate model must support audio.
  const bytes = await fs.readFile(probe.path);
  if (bytes.length > getMaxInlineMediaBytes()) {
    throw new MediaReadError(
      'over-budget',
      `Audio file ${probe.path} is too large to hand to the understanding model inline.`,
      'Request a specific range, or extract a transcript via media_extract with an ASR backend.',
    );
  }
  return [
    {
      inlineData: {
        data: bytes.toString('base64'),
        mimeType: probe.mimeType,
      },
    },
  ];
}

function textFromToolContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : ((p as Part)?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    return String((content as Part).text ?? '');
  }
  return '';
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
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<MediaReadResult> {
    let note: string;
    switch (this.spec.via) {
      case 'command':
        note = await this.runCommandBackend(probe, ctx);
        break;
      case 'subagent':
        note = await this.runSubagentBackend(probe, params, ctx);
        break;
      case 'mcp':
        note = await this.runMcpBackend(probe, params, ctx);
        break;
      default:
        throw new MediaReadError(
          'no-capability',
          `Delegated reader "${this.id}" uses an unknown via:"${this.spec.via}".`,
          'Use via:"command", "subagent", or "mcp".',
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

  private async runCommandBackend(
    probe: MediaProbe,
    ctx: MediaReadContext,
  ): Promise<string> {
    const argv = substituteTemplate(this.spec.ref, probe, this.spec);
    if (argv.length === 0) {
      throw new MediaReadError(
        'no-capability',
        `Delegated reader "${this.id}" has an empty command template.`,
        'Fix the reader `ref` in the media config to a runnable command, e.g. "whisper --model {model} {path}".',
      );
    }
    try {
      return await runCommand(argv, ctx.signal);
    } catch (err) {
      throw new MediaReadError(
        'no-capability',
        `Delegated reader "${this.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
        `Ensure "${argv[0]}" is installed and on PATH, or switch to a different reader for ${probe.modality}.`,
      );
    }
  }

  private async runSubagentBackend(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<string> {
    const model = this.spec.model?.trim() || ctx.config.getModel();
    let parts: Part[];
    try {
      parts = await toUnderstandingParts(probe, params, ctx);
    } catch (err) {
      if (err instanceof MediaReadError) throw err;
      throw new MediaReadError(
        'no-capability',
        `Delegated reader "${this.id}" could not prepare ${probe.modality} input: ${err instanceof Error ? err.message : String(err)}`,
        'Ensure ffmpeg is installed for video/image transforms.',
      );
    }
    const intent =
      params.intent?.trim() ||
      'Describe this media factually and in detail. Note any on-screen or spoken text. Only describe what is actually present.';
    const contents: Content[] = [
      { role: 'user', parts: [...parts, { text: intent }] },
    ];
    try {
      const resp = await ctx.config
        .getGeminiClient()
        .generateContent(
          contents,
          {},
          ctx.signal,
          model,
          `media-delegated-${this.id}-${probe.hash.slice(0, 8)}`,
        );
      return getResponseText(resp)?.trim() || '(no description returned)';
    } catch (err) {
      throw new MediaReadError(
        'no-capability',
        `Delegated subagent reader "${this.id}" (model ${model}) failed: ${err instanceof Error ? err.message : String(err)}`,
        `Configure a working understanding model on this reader's \`model\`, or use a model that supports ${probe.modality} input.`,
      );
    }
  }

  private async runMcpBackend(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<string> {
    const tool = ctx.config.getToolRegistry().getTool(this.spec.ref);
    if (!tool) {
      throw new MediaReadError(
        'no-capability',
        `Delegated reader "${this.id}" references MCP tool "${this.spec.ref}", which is not registered.`,
        'Check the MCP server is configured and the tool name in the reader `ref` is correct.',
      );
    }
    const args: Record<string, unknown> = {
      file_path: probe.path,
      path: probe.path,
    };
    if (params.intent) args['prompt'] = params.intent;
    try {
      const invocation = tool.build(args);
      const res = await invocation.execute(ctx.signal);
      const text = textFromToolContent(res.llmContent);
      return text.trim() || '(MCP tool returned no text)';
    } catch (err) {
      throw new MediaReadError(
        'no-capability',
        `Delegated MCP reader "${this.id}" (tool ${this.spec.ref}) failed: ${err instanceof Error ? err.message : String(err)}`,
        'Verify the MCP tool accepts a file path argument and is reachable.',
      );
    }
  }
}

export function createDelegatedReader(spec: ReaderBackendSpec): MediaReader {
  return new DelegatedReader(spec);
}
