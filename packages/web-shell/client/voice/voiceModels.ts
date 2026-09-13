/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** A voice-transcription model option for the `/model --voice` picker. */
export interface VoiceModelOption {
  /** Raw model id (no auth suffix) — what gets persisted as `voiceModel`. */
  id: string;
  label?: string;
  authType?: string;
  baseUrl?: string;
  contextWindow?: number;
  modalities?: { audio?: boolean };
}

/**
 * Mirror of the CLI's `resolveVoiceTransport` id patterns (voice-model.ts): true
 * for ids the daemon has an ASR transport for. Kept in sync by hand because the
 * Web Shell can't import the CLI's voice modules.
 */
export function isVoiceModelId(id: string): boolean {
  const s = id.toLowerCase();
  return (
    /^qwen3-asr-flash-realtime(?:-|$)/.test(s) ||
    /^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(s) ||
    /^(fun-asr|paraformer).*realtime(?:-|$)/.test(s)
  );
}
