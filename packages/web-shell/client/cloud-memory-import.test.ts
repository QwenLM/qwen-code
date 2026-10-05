import { describe, expect, it } from 'vitest';
import { parseCloudMemoryImport } from './cloud-memory-import';

describe('cloud memory import', () => {
  it('keeps only user and assistant text from JSONL transcripts', () => {
    const input = [
      JSON.stringify({ role: 'user', content: 'Use pnpm' }),
      JSON.stringify({ role: 'tool', content: 'ignored' }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood' }],
      }),
    ].join('\n');

    expect(parseCloudMemoryImport('chat.jsonl', input)).toEqual([
      'user: Use pnpm\n\nassistant: Understood',
    ]);
  });

  it('accepts Markdown as an extraction segment', () => {
    expect(parseCloudMemoryImport('notes.md', '# Preferences')).toEqual([
      '# Preferences',
    ]);
  });
});
