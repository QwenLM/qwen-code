/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface HierarchicalMemory {
  global?: string;
  plugin?: string;
  project?: string;
  local?: string;
  jit?: string;
}

/**
 * Flattens hierarchical memory into a single string for display or legacy use.
 */
export function flattenMemory(memory?: string | HierarchicalMemory): string {
  if (!memory) return '';
  if (typeof memory === 'string') return memory;

  const sections: Array<{ name: string; content: string }> = [];
  if (memory.global?.trim()) {
    sections.push({ name: 'Global', content: memory.global.trim() });
  }
  const pluginMemory = memory.plugin;
  if (pluginMemory?.trim()) {
    sections.push({ name: 'Plugin', content: pluginMemory.trim() });
  }
  if (memory.project?.trim()) {
    sections.push({ name: 'Project', content: memory.project.trim() });
  }
  if (memory.local?.trim()) {
    sections.push({ name: 'Local', content: memory.local.trim() });
  }
  if (memory.jit?.trim()) {
    sections.push({ name: 'JIT (Dynamic)', content: memory.jit.trim() });
  }

  if (sections.length === 0) return '';

  return sections.map((s) => `--- ${s.name} ---\n${s.content}`).join('\n\n');
}
