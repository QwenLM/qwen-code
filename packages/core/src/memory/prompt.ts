/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const MANAGED_AUTO_MEMORY_HEADER = '## Managed Auto-Memory';
const MAX_MANAGED_AUTO_MEMORY_CHARS = 12_000;

function truncateManagedAutoMemoryIndex(indexContent: string): string {
  const trimmed = indexContent.trim();
  if (trimmed.length <= MAX_MANAGED_AUTO_MEMORY_CHARS) {
    return trimmed;
  }

  const truncated = trimmed.slice(0, MAX_MANAGED_AUTO_MEMORY_CHARS).trimEnd();
  return `${truncated}\n\n> NOTE: Managed auto-memory index truncated for prompt budget.`;
}

export function buildManagedAutoMemoryPrompt(indexContent?: string | null): string {
  const trimmed = indexContent?.trim();
  if (!trimmed) {
    return '';
  }

  return [
    MANAGED_AUTO_MEMORY_HEADER,
    '',
    'Use this as durable project memory when relevant. The detailed topic files remain on disk; this block is the loaded index.',
    '',
    truncateManagedAutoMemoryIndex(trimmed),
  ].join('\n');
}

export function appendManagedAutoMemoryToUserMemory(
  userMemory: string,
  indexContent?: string | null,
): string {
  const managedPrompt = buildManagedAutoMemoryPrompt(indexContent);
  const trimmedUserMemory = userMemory.trim();

  if (!managedPrompt) {
    return userMemory;
  }
  if (!trimmedUserMemory) {
    return managedPrompt;
  }

  return `${trimmedUserMemory}\n\n---\n\n${managedPrompt}`;
}

export {
  MANAGED_AUTO_MEMORY_HEADER,
  MAX_MANAGED_AUTO_MEMORY_CHARS,
};