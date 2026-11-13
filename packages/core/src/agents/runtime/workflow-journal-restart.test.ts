/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowJournal } from './workflow-journal.js';

const sourceUrl = new URL('./workflow-journal.ts', import.meta.url).href;

describe('WorkflowJournal interrupted replacement', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-journal-restart-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(['before', 'after'] as const)(
    'loads a complete journal after the writer is killed %s rename',
    async (stage) => {
      const journalPath = path.join(dir, 'journal.jsonl');
      const records = [
        { type: 'launched', version: 1 },
        { type: 'result', key: 'a', agentId: '1', result: 'prefix' },
        { type: 'started', key: 'b', agentId: '2' },
        { type: 'result', key: 'b', agentId: '2', result: 'old suffix' },
      ];
      await fs.writeFile(
        journalPath,
        records.map((record) => JSON.stringify(record) + '\n').join(''),
      );
      const script = `
        import { promises as fs } from 'node:fs';
        import { WorkflowJournal } from ${JSON.stringify(sourceUrl)};
        process.on('message', () => {});
        const rename = fs.rename.bind(fs);
        fs.rename = async (...args) => {
          if (${JSON.stringify(stage)} === 'after') await rename(...args);
          process.send(${JSON.stringify(stage)});
          await new Promise(() => {});
        };
        await new WorkflowJournal(${JSON.stringify(journalPath)}, ${JSON.stringify(dir)})
          .retainReplayPrefix(new Set(['a']));
      `;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = once(child, 'exit');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Writer did not reach ${stage}: ${stderr}`)),
            10_000,
          );
          child.once('error', reject);
          child.once('exit', (code, signal) => {
            reject(
              new Error(`Writer exited early (${code}/${signal}): ${stderr}`),
            );
          });
          child.once('message', (message) => {
            if (message === stage) resolve();
            else reject(new Error(`Unexpected writer message: ${message}`));
          });
        });
        clearTimeout(timeout);
        child.kill('SIGKILL');
        const [code, signal] = await exited;
        expect(code).toBeNull();
        expect(signal).toBe('SIGKILL');

        const loaded = await new WorkflowJournal(journalPath, dir).load();
        expect(loaded.kind).toBe('loaded');
        if (loaded.kind !== 'loaded')
          throw new Error('Journal was not readable');
        expect(loaded.replay.results.get('a')?.result).toBe('prefix');
        expect(loaded.replay.results.has('b')).toBe(stage === 'before');
        expect(loaded.replay.started.get('b')).toHaveLength(1);
        const retained = (await fs.readFile(journalPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(retained).toEqual(
          stage === 'before'
            ? records
            : records.filter(
                (record) => record.type !== 'result' || record.key === 'a',
              ),
        );
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
  );
});
