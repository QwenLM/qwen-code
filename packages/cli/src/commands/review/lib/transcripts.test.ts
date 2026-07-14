/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The defensive branches of the transcript reader, in isolation. They exist
// because the files come off disk while agents may still be writing them — a
// partial last line, an empty file materialised before the first record, a file
// that is not a transcript at all — and the reader must degrade to "this is not
// evidence" rather than throw and take the whole coverage check down.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTranscripts,
  wasGivenTheDiff,
  transcriptDir,
  TranscriptsUnavailableError,
  type AgentRecord,
} from './transcripts.js';

let dir: string;
let ENV: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
  ENV = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S1' };
  mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, contents: string): void {
  writeFileSync(join(dir, 'subagents', 'S1', name), contents);
}

describe('transcriptDir — resolved from the environment only', () => {
  it('throws when the CLI exported neither key', () => {
    expect(() => transcriptDir({})).toThrow(TranscriptsUnavailableError);
  });

  it('throws when only one key is present', () => {
    expect(() => transcriptDir({ QWEN_CODE_SESSION_ID: 'S1' })).toThrow(
      TranscriptsUnavailableError,
    );
    expect(() => transcriptDir({ QWEN_CODE_PROJECT_DIR: '/p' })).toThrow(
      TranscriptsUnavailableError,
    );
  });
});

describe('readTranscripts — defensive parsing', () => {
  it('throws TranscriptsUnavailableError when the session dir is absent', () => {
    // Not a verdict about the agents — an infrastructure fact.
    expect(() =>
      readTranscripts(undefined, {
        QWEN_CODE_PROJECT_DIR: join(dir, 'gone'),
        QWEN_CODE_SESSION_ID: 'S1',
      }),
    ).toThrow(TranscriptsUnavailableError);
  });

  it('skips a non-.jsonl file', () => {
    file('notes.txt', 'not a transcript');
    expect(readTranscripts(undefined, ENV)).toEqual([]);
  });

  it('skips an empty transcript file', () => {
    file('agent-empty.jsonl', '');
    expect(readTranscripts(undefined, ENV)).toEqual([]);
  });

  it('skips a transcript whose records carry no agentId', () => {
    // A file of well-formed JSON that is not an agent transcript.
    file('agent-x.jsonl', JSON.stringify({ hello: 'world' }) + '\n');
    expect(readTranscripts(undefined, ENV)).toEqual([]);
  });

  it('tolerates a malformed final line — an agent still writing', () => {
    // The harness flushes per record; a reader can catch a half-written last
    // line. The complete records before it must still parse.
    const good = {
      agentId: 'a1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    file(
      'agent-a1.jsonl',
      JSON.stringify({
        ...good,
        type: 'user',
        message: { role: 'user', parts: [{ text: 'chunk 1 of 1' }] },
      }) +
        '\n' +
        '{"type":"assistant","message":{"parts":[{"text":"partial', // truncated
    );
    const recs = readTranscripts(undefined, ENV);
    expect(recs).toHaveLength(1);
    expect(recs[0].agentId).toBe('a1');
    expect(recs[0].launchPrompt).toBe('chunk 1 of 1');
  });

  it('counts only successful tool calls', () => {
    const b = { agentId: 'a1', agentName: 'general-purpose', sessionId: 'S1' };
    const call = {
      ...b,
      type: 'assistant',
      message: {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: {} } }],
      },
    };
    file(
      'agent-a1.jsonl',
      [
        JSON.stringify({
          ...b,
          type: 'user',
          message: { role: 'user', parts: [{ text: 'chunk 1 of 1' }] },
        }),
        JSON.stringify(call),
        JSON.stringify({
          ...b,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { error: 'denied' }, // a FAILED call
                },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    const [rec] = readTranscripts(undefined, ENV);
    expect(rec.successfulToolCalls).toBe(0);
  });
});

describe('wasGivenTheDiff', () => {
  const rec = (launchPrompt: string): AgentRecord => ({
    agentId: 'a',
    agentName: 'general-purpose',
    launchPrompt,
    successfulToolCalls: 0,
    finalText: '',
    mtimeMs: 0,
  });

  it('is true only when the prompt names the diff path', () => {
    expect(
      wasGivenTheDiff(rec('read_file(file_path="/d.txt")'), '/d.txt'),
    ).toBe(true);
  });

  it('is false for a prompt that names only source files', () => {
    expect(
      wasGivenTheDiff(rec('read_file(file_path="/src/pay.ts")'), '/d.txt'),
    ).toBe(false);
  });

  it('is false for an empty prompt', () => {
    expect(wasGivenTheDiff(rec(''), '/d.txt')).toBe(false);
  });
});
