/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.ogg', '.wav']);

export function workspaceFileExtension(workspacePath?: string): string {
  const name = (workspacePath ?? '').split(/[/\\]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function pathExtension(workspacePath?: string): string {
  return workspaceFileExtension((workspacePath ?? '').split(/[?#]/, 1)[0]);
}

export function normalizeArtifactMimeType(mimeType?: string): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function isAudioArtifact(
  workspacePath?: string,
  mimeType?: string,
): boolean {
  return (
    AUDIO_EXTENSIONS.has(pathExtension(workspacePath)) ||
    normalizeArtifactMimeType(mimeType).startsWith('audio/')
  );
}
