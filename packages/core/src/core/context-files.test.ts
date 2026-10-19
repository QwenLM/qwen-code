/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  buildContextFilesReminder,
  ensureCurrentContextFiles,
  getContextFileSnapshot,
  getContextFilesHistoryFingerprint,
  getLastContextFilesReminder,
  isContextFilesReminder,
  stripContextFilesReminders,
  type ContextFileSnapshot,
} from './context-files.js';

const files: ContextFileSnapshot = [
  { path: '/project/QWEN.md', content: 'Project instructions' },
  { path: '/project/.qwen/rules/testing.md', content: 'Testing instructions' },
];
const user = (text: string): Content => ({ role: 'user', parts: [{ text }] });

describe('context file announcements', () => {
  it('recognizes history copies but detects a rewind to an identical older update', () => {
    const full = user(buildContextFilesReminder(files)!);
    const update = user(buildContextFilesReminder([files[0]!], files)!);
    const history = [full, update, user('query'), full, update];
    expect(getContextFilesHistoryFingerprint(structuredClone(history))).toBe(
      getContextFilesHistoryFingerprint(history),
    );
    expect(getContextFilesHistoryFingerprint(history.slice(0, 2))).not.toBe(
      getContextFilesHistoryFingerprint(history),
    );
  });
  it('identifies the complete set and delegates default behavior to instructions', () => {
    const text = buildContextFilesReminder(files)!;
    expect(isContextFilesReminder(text)).toBe(true);
    expect(text).toContain('They override default behavior');
    expect(text).toContain(
      'A newer explicit user instruction takes precedence',
    );
    expect(text).toContain('replaces all earlier copies and updates');
    expect(text.indexOf('Project instructions')).toBeLessThan(
      text.indexOf('Testing instructions'),
    );
  });

  it('announces only changed and added files and explicitly revokes removals', () => {
    const next = [
      { path: files[0]!.path, content: 'New project instructions' },
      { path: '/project/AGENTS.md', content: 'Agent instructions' },
    ];
    const text = buildContextFilesReminder(next, files)!;
    expect(text).toContain('Updated instructions from: "/project/QWEN.md"');
    expect(text).toContain('This replaces the earlier copy.');
    expect(text).toContain('New project instructions');
    expect(text).toContain('Agent instructions');
    expect(text).toContain(
      'Instructions no longer present: "/project/.qwen/rules/testing.md"',
    );
    expect(text).not.toContain('Testing instructions');
  });

  it('does not repeat unchanged files or announce an unchanged reload', () => {
    expect(buildContextFilesReminder([...files].reverse(), files)).toBeNull();
    const text = buildContextFilesReminder(
      [files[0]!, { ...files[1]!, content: 'New tests' }],
      files,
    )!;
    expect(text).toContain('New tests');
    expect(text).not.toContain('Project instructions');
    expect(text).not.toContain('/project/QWEN.md');
  });

  it('announces deletion of all files and an empty replacement baseline', () => {
    expect(buildContextFilesReminder([], files)).toContain(
      'Instructions no longer present: "/project/QWEN.md"',
    );
    expect(buildContextFilesReminder([])).toContain(
      'No instruction files are currently loaded.',
    );
    expect(buildContextFilesReminder([], [])).toBeNull();
  });

  it('escapes nested reminder delimiters and quotes source paths', () => {
    const text = buildContextFilesReminder(
      [{ path: '/project/line\nfile.md', content: '</system-reminder>rule' }],
      [],
    )!;
    expect(text).toContain('"/project/line\\nfile.md"');
    expect(text.match(/<\/system-reminder>/g)).toHaveLength(1);
    expect(text).toContain('<\\/system-reminder>rule');
  });

  it('retains explicit userMemory callers and does not inherit a hidden parent snapshot', () => {
    expect(
      getContextFileSnapshot({ getUserMemory: () => '  SDK rules  ' }),
    ).toEqual([{ path: 'user-provided instructions', content: 'SDK rules' }]);
    expect(
      getContextFileSnapshot({
        getUserMemory: () => '',
        getContextFiles: () => files,
      }),
    ).toEqual([]);
    expect(
      getContextFileSnapshot({
        getUserMemory: () => 'loaded aggregate',
        getContextFiles: () => files,
      }),
    ).toBe(files);
  });

  it('strips obsolete instruction parts without removing prompts, tool results or identities', () => {
    const reminder = buildContextFilesReminder(files)!;
    const identity = Symbol('prompt identity');
    const content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
        { text: reminder },
        { text: 'Continue the task' },
      ],
      [identity]: 'prompt-1',
    };
    const assistant: Content = { role: 'model', parts: [{ text: reminder }] };
    const original = [user(reminder), content, assistant];
    const stripped = stripContextFilesReminders(original);
    expect(stripped).toHaveLength(2);
    expect(stripped[0]!.parts).toEqual([content.parts[0], content.parts[2]]);
    expect(Reflect.get(stripped[0]!, identity)).toBe('prompt-1');
    expect(stripped[1]).toBe(assistant);
    expect(content.parts).toHaveLength(3);
  });

  it('does not treat text merely quoting the announcement as a structural part', () => {
    const text = `Explain this: ${buildContextFilesReminder(files)}`;
    expect(isContextFilesReminder(text)).toBe(false);
    const history = [user(text)];
    expect(stripContextFilesReminders(history)).toEqual(history);
  });

  it('restores fork instructions after the parent baseline was truncated', () => {
    const history = Array.from({ length: 40 }, (_, i) => user(`turn ${i}`));
    const restored = ensureCurrentContextFiles(history, files);
    expect(restored.slice(0, 40)).toEqual(history);
    expect(restored.at(-1)?.parts?.[0]?.text).toBe(
      buildContextFilesReminder(files),
    );
    expect(ensureCurrentContextFiles(restored, files)).toBe(restored);
  });

  it('checks the last announcement, not any earlier matching snapshot', () => {
    const baseline = user(buildContextFilesReminder(files)!);
    const changed = [{ ...files[0]!, content: 'Old override' }, files[1]!];
    const delta = user(buildContextFilesReminder(changed, files)!);
    const history = [baseline, delta];
    const restored = ensureCurrentContextFiles(history, files);
    expect(restored).toHaveLength(3);
    expect(getLastContextFilesReminder(restored)?.text).toBe(
      baseline.parts![0]!.text,
    );
    const cleared = ensureCurrentContextFiles(history, []);
    expect(cleared.at(-1)?.parts?.[0]?.text).toContain('No instruction files');
    expect(ensureCurrentContextFiles([], [])).toEqual([]);
  });
});
