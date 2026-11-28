/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as jsonl from '../utils/jsonl-utils.js';
import { appendLegacySessionTranscriptLine } from './legacy-session-transcript-writer.js';
import { readManagedExecutionEvidenceSync } from '../utils/sessionStorageUtils.js';
import { readSessionTranscriptSnapshot } from './session-transcript-reader.js';
import { assertSessionExecutionEngine } from './session-execution-engine.js';

// Permissions are an OS-level property, so these cases drive the recorder
// against a real temporary directory instead of the mocked fs the rest of the
// suite uses. They cover the ways a transcript can come into existence — fresh
// creation, appending to a file an earlier version left world-readable,
// recreation after mid-session deletion — plus the races around the tail probe
// and the ownership checks before an existing file is tightened.
//
// Skipped on Windows: Node's Windows filesystem reports 0666 for any writable
// regular file regardless of the mode used to create it, so POSIX mode
// assertions there are meaningless.
describe.skipIf(process.platform === 'win32')(
  'ChatRecordingService transcript permissions',
  () => {
    const sessionId = 'permission-probe-session';
    let projectDir: string;
    let transcriptPath: string;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chat-perms-'));
      transcriptPath = path.join(projectDir, 'chats', `${sessionId}.jsonl`);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    const modeOf = (filePath: string) => fs.statSync(filePath).mode & 0o777;

    const MANAGED_OWNER_LINE = `${JSON.stringify({
      type: 'system',
      subtype: 'session_execution_engine',
      systemPayload: { version: 1, engine: 'managed' },
    })}\n`;

    it('creates the transcript with owner-only permissions', async () => {
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'first',
      });

      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('tightens a world-readable transcript left by an earlier version', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, '', { flag: 'wx', mode: 0o644 });

      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'existing',
      });

      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('preserves an existing owner-read-only mode when group access is removed', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, '', { flag: 'wx', mode: 0o444 });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'first',
      }).catch(() => undefined);
      // The owner mode is never expanded to make an otherwise unwritable file
      // writable; POSIX mode tightening can only remove group/other bits.
      expect(modeOf(transcriptPath)).toBe(0o444);
    });

    it('does not touch a Managed transcript that a lease still owns', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, MANAGED_OWNER_LINE, {
        flag: 'wx',
        mode: 0o644,
      });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'must not append',
        }),
      ).rejects.toThrow(/belongs to managed/);

      expect(modeOf(transcriptPath)).toBe(0o644);
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(MANAGED_OWNER_LINE);
    });

    it('refuses a symlink transcript without modifying its target', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const target = path.join(projectDir, 'outside.jsonl');
      const original = `${JSON.stringify({ private: 'sentinel' })}\n`;
      fs.writeFileSync(target, original, { mode: 0o644 });
      fs.symlinkSync(target, transcriptPath);

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          private: 'must not leak',
        }),
      ).rejects.toThrow();

      expect(fs.readFileSync(target, 'utf8')).toBe(original);
      expect(modeOf(target)).toBe(0o644);
    });

    it('refuses a symlink installed after the transcript fd is opened', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const originalPath = `${transcriptPath}.original`;
      const sentinel = path.join(projectDir, 'race-target.jsonl');
      const originalBytes = `${JSON.stringify({ keep: 'original' })}\n`;
      fs.writeFileSync(transcriptPath, '', { mode: 0o600 });
      fs.writeFileSync(sentinel, originalBytes, { mode: 0o600 });
      const realLstatSync = fs.lstatSync.bind(fs);
      let lstatCalls = 0;
      vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
        const result = realLstatSync(...args);
        if (args[0] === transcriptPath && ++lstatCalls === 2) {
          fs.renameSync(transcriptPath, originalPath);
          fs.symlinkSync(sentinel, transcriptPath);
          return realLstatSync(transcriptPath, args[1] as { bigint: true });
        }
        return result;
      });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          private: 'must not leak',
        }),
      ).rejects.toMatchObject({ name: 'SessionWriterUnavailableError' });

      expect(fs.readFileSync(sentinel, 'utf8')).toBe(originalBytes);
      expect(fs.readFileSync(originalPath, 'utf8')).toBe('');
      expect(fs.lstatSync(transcriptPath).isSymbolicLink()).toBe(true);
    });

    it('refuses a hard-linked transcript without changing its inode, bytes or mode', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const target = path.join(projectDir, 'linked.jsonl');
      const original = '{"message":"sentinel"}\n';
      fs.writeFileSync(target, original, { mode: 0o644 });
      fs.linkSync(target, transcriptPath);
      const inode = fs.statSync(target).ino;
      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'no',
        }),
      ).rejects.toMatchObject({ name: 'SessionWriterUnavailableError' });
      expect(fs.statSync(transcriptPath).ino).toBe(inode);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
      expect(modeOf(target)).toBe(0o644);
    });

    it('refuses a replacement inode installed after open', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const displaced = `${transcriptPath}.original`;
      const original = '{"message":"original"}\n';
      const replacement = '{"message":"replacement"}\n';
      fs.writeFileSync(transcriptPath, original, { mode: 0o600 });
      const realLstatSync = fs.lstatSync.bind(fs);
      let calls = 0;
      vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
        if (args[0] === transcriptPath && ++calls === 2) {
          fs.renameSync(transcriptPath, displaced);
          fs.writeFileSync(transcriptPath, replacement, { mode: 0o644 });
        }
        return realLstatSync(...args);
      });
      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'no',
        }),
      ).rejects.toMatchObject({ name: 'SessionWriterUnavailableError' });
      expect(fs.readFileSync(displaced, 'utf8')).toBe(original);
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(replacement);
      expect(modeOf(transcriptPath)).toBe(0o644);
    });

    it('refuses conflicting Legacy and Managed ownership records', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'system',
          subtype: 'session_execution_engine',
          systemPayload: { version: 1, engine: 'legacy' },
        })}\n${MANAGED_OWNER_LINE}`,
        { mode: 0o600 },
      );
      const original = fs.readFileSync(transcriptPath, 'utf8');

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'must not append',
        }),
      ).rejects.toMatchObject({ name: 'SessionExecutionEngineError' });

      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
    });

    it('refuses an owner record whose version cannot be verified', async () => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const original = `${JSON.stringify({
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 2, engine: 'legacy' },
      })}\n`;
      fs.writeFileSync(transcriptPath, original, { mode: 0o600 });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'must not append',
        }),
      ).rejects.toThrow(/ownership could not be verified/);

      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
    });

    it('appends repeatedly after a torn user message mentioning the owner marker', async () => {
      const torn =
        '{"uuid":"user-1","type":"user","message":{"role":"user","parts":[{"text":"Discuss session_execution_engine';
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, torn, { mode: 0o644 });
      const records = [
        { type: 'assistant', message: 'one' },
        { type: 'user', message: 'two' },
      ];

      for (const record of records) {
        await appendLegacySessionTranscriptLine(
          transcriptPath,
          sessionId,
          record,
        );
      }

      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${torn}\n${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it.each([false, true])(
      'continues after a marker-bearing torn user message ending in qqqys (newline: %s)',
      async (newline) => {
        const torn =
          '{"uuid":"user-1","type":"user","message":{"role":"user","parts":[{"text":"Discuss session_execution_engine qqqys';
        const original = `${torn}${newline ? '\n' : ''}`;
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
        for (const message of ['one', 'two']) {
          await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
            message,
          });
        }
        expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
          `${torn}\n{"message":"one"}\n{"message":"two"}\n`,
        );
        expect(modeOf(transcriptPath)).toBe(0o600);
      },
    );

    it('continues appending after a torn user message ending in qqqys', async () => {
      const torn =
        '{"type":"user","message":{"role":"user","parts":[{"text":"qqqys';
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, torn, { mode: 0o600 });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${torn}\n{"message":"next"}\n`,
      );
    });

    it('reports incomplete ownership on resume after appending to a torn message', async () => {
      const base = {
        uuid: 'record-1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: projectDir,
        version: 'test',
      };
      const owner = JSON.stringify({
        ...base,
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'legacy' },
      });
      const torn = JSON.stringify({
        ...base,
        uuid: 'user-1',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'session_execution_engine and more' }],
        },
      }).split(' and more')[0];
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${owner}\n${torn}`, { mode: 0o600 });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        ...base,
        uuid: 'user-2',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'next' }] },
      });
      const snapshot = await readSessionTranscriptSnapshot(
        transcriptPath,
        sessionId,
      );
      expect(snapshot?.sourceReadComplete).toBe(false);
      expect(snapshot?.executionEngine).toMatchObject({
        status: 'unavailable',
        reason: 'incomplete transcript',
      });
      expect(() =>
        assertSessionExecutionEngine(
          snapshot?.executionEngine,
          sessionId,
          'legacy',
        ),
      ).toThrow(/incomplete transcript/);
    });

    it.each([
      '{"type":"system","subtype":"session_execution_engine","systemPayload":{"version":1,"engine":"managed',
      MANAGED_OWNER_LINE.trimEnd(),
      '{"type":"system","subtype":"session\\u005fexecution\\u005fengine","systemPayload":',
      '{"type":"system","subtype":"session_execution_engine","systemPayload":{}',
      `${JSON.stringify({ type: 'user', message: 'hello' })}${MANAGED_OWNER_LINE.trimEnd()}`,
      '{"type":"user","message":"hello","subtype":"session_execution_engine","subtype":"other"}',
      '{"type":"user","message":"hello","sub\\u0074ype":"session\\u005fexecution_engine","type":"system","systemPayload":{"version":1,"engine":"managed"}}',
      '{"type":"user","message":"hello","subtype":"session_execution_engine"',
      '{"type":"system","subtype":"session_execution_engine","systemPayload":{"version":1,"engine":"managed","engine":"legacy"}}',
      '{"type":"system","subtype":"session_execution_engine","subtype":"session_execution_engine","systemPayload":{"version":1,"engine":"legacy"}}',
      '{"type":"system","subtype":"managed_session_header_v1","systemPayload":',
      '{"type":"user","message":{"role":"user","parts":[{"text":"session_execution_engine"}]},"subtype":"session_execution_engine","systemPayload":',
      '{"type":"user","systemPayload":{"engine":"managed","engine":"legacy"},"message":{"role":"user","parts":[{"text":"session_execution_engine',
      `{"type":"user","message":{"role":"user","parts":[{"text":"session_execution_engine"}]}}{broken`,
      '{"type":"user","extra":garbage,"message":{"role":"user","parts":[{"text":"session_execution_engine qqqys',
      '{"type":"user","subtype":"other","subtype":"session_execution_engine","message":{"role":"user","parts":[{"text":"qqqys',
      '{"systemPayload":{"engine":"managed","version":1},"subtype":"session_execution_engine","type":"system"}',
      `${MANAGED_OWNER_LINE.trimEnd()}${JSON.stringify({ type: 'user', message: 'qqqys' })}`,
    ])(
      'refuses owner evidence without modifying bytes or mode: %s',
      async (original) => {
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        fs.writeFileSync(transcriptPath, original, { mode: 0o644 });

        await expect(
          appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
            message: 'no',
          }),
        ).rejects.toMatchObject({ name: 'SessionExecutionEngineError' });
        expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
        expect(modeOf(transcriptPath)).toBe(0o644);
      },
    );

    it('continues after a torn user message containing an escaped marker', async () => {
      const original =
        '{"type":"user","message":{"role":"user","parts":[{"text":"session\\u005fexecution_engine qqqys';
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      for (const message of ['one', 'two']) {
        await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message,
        });
      }
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${original}\n{"message":"one"}\n{"message":"two"}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('permits complete glued ordinary records that mention the marker', async () => {
      const original = `${JSON.stringify({ type: 'user', message: 'session_execution_engine' })}${JSON.stringify({ type: 'user', message: 'hello' })}\n`;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${original}{"message":"next"}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('permits a valid legacy owner glued to an ordinary record', async () => {
      const original = `${JSON.stringify({ type: 'user', message: 'hello' })}${JSON.stringify({ type: 'system', subtype: 'session_execution_engine', systemPayload: { version: 1, engine: 'legacy' } })}`;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${original}\n{"message":"next"}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('allows a valid legacy owner with the same field names in different objects', async () => {
      const original = JSON.stringify({
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'legacy' },
        version: 'test',
      });
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${original}\n{"message":"next"}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('keeps appending after an oversized first record that merely names the owner marker', async () => {
      const oversized = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          parts: [
            {
              text: `session_execution_engine and a literal \\u005f escape ${'y'.repeat(1100 * 1024)}`,
            },
          ],
        },
      });
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${oversized}\n`, { mode: 0o600 });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          type: 'assistant',
          message: { role: 'assistant', parts: [{ text: 'next' }] },
        }),
      ).resolves.toBeUndefined();

      const lines = fs
        .readFileSync(transcriptPath, 'utf8')
        .trimEnd()
        .split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    });

    it.each([
      (padding: string) =>
        `{"type":"user","message":"${padding}","subtype":"session_execution_engine","systemPayload":{"version":1,"engine":"managed"}}`,
      (padding: string) =>
        `{"type":"user","message":"${padding}"}${MANAGED_OWNER_LINE.trimEnd()}`,
      (padding: string) =>
        `{"type":"user","message":"${padding}","subtype":"other","subtype":"session_execution_engine","systemPayload":{"version":1,"engine":"managed"}}`,
    ])('refuses owner evidence after an oversized prefix', async (makeLine) => {
      const original = makeLine('x'.repeat(1100 * 1024));
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'no',
        }),
      ).rejects.toMatchObject({ name: 'SessionExecutionEngineError' });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
      expect(modeOf(transcriptPath)).toBe(0o644);
    });

    it('continues appending after writing a record larger than 8 MiB', async () => {
      const record = {
        type: 'user',
        message: {
          role: 'user',
          parts: [
            { text: `session_execution_engine ${'x'.repeat(8 * 1024 * 1024)}` },
          ],
        },
      };
      await appendLegacySessionTranscriptLine(
        transcriptPath,
        sessionId,
        record,
      );
      const original = `${JSON.stringify(record)}\n`;
      expect(Buffer.byteLength(original)).toBeGreaterThan(8 * 1024 * 1024);
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'again',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${original}{"message":"next"}\n{"message":"again"}\n`,
      );
    });

    it('refuses a record beyond the verification bound before writing it', async () => {
      const record = {
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'x'.repeat(32 * 1024 * 1024) }],
        },
      };
      // Persisting the record would leave a line no later append can verify,
      // so the writer refuses it before it reaches the file: the failure lands
      // on the record that caused it instead of on a later, unrelated append.
      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, record),
      ).rejects.toThrow(/verification bound/);
      expect(fs.existsSync(transcriptPath)).toBe(false);
      // Records the writer can verify still go through.
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        '{"message":"next"}\n',
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('keeps appending after a user record missing only its final brace', async () => {
      const owner = JSON.stringify({
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'legacy' },
      });
      const torn = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'session_execution_engine here' }],
        },
      }).slice(0, -1);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${owner}\n${torn}`, { mode: 0o600 });

      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'first',
      });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'second',
      });

      const lines = fs
        .readFileSync(transcriptPath, 'utf8')
        .trimEnd()
        .split('\n');
      expect(lines).toHaveLength(4);
      // The torn record keeps its bytes; a newline separates it from the
      // records written after it, all of which parse.
      expect(lines[1]).toBe(torn);
      for (const line of [lines[0], lines[2], lines[3]]) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('keeps appending after a record torn right after its type value', async () => {
      const owner = JSON.stringify({
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'legacy' },
      });
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${owner}\n{"type":"user"`, {
        mode: 0o600,
      });

      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });

      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${owner}\n{"type":"user"\n{"message":"next"}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('refuses a torn owner record that is missing only its final brace', async () => {
      const owner = JSON.stringify({
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'legacy' },
      });
      const tornOwner = owner.slice(0, -1);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${owner}\n${tornOwner}`, {
        mode: 0o600,
      });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'no',
        }),
      ).rejects.toMatchObject({ name: 'SessionExecutionEngineError' });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${owner}\n${tornOwner}`,
      );
    });

    it('permits a valid legacy owner glued ahead of an ordinary record', async () => {
      const original = `${JSON.stringify({
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'legacy' },
      })}${JSON.stringify({ type: 'user', message: 'hello' })}`;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${original}\n{"message":"next"}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('refuses a managed owner glued ahead of an ordinary record', async () => {
      const original = `${MANAGED_OWNER_LINE.trimEnd()}${JSON.stringify({
        type: 'user',
        message: 'hello',
      })}`;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'no',
        }),
      ).rejects.toMatchObject({ name: 'SessionExecutionEngineError' });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
      expect(modeOf(transcriptPath)).toBe(0o644);
    });

    it('reads a bounded amount per append on a large transcript', async () => {
      const owner = JSON.stringify({
        type: 'system',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'legacy' },
      });
      const record = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'y'.repeat(16 * 1024 - 160) }],
        },
      });
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(
        transcriptPath,
        `${owner}\n${Array.from({ length: 256 }, () => record).join('\n')}\n`,
        { mode: 0o600 },
      );
      expect(fs.statSync(transcriptPath).size).toBeGreaterThan(2 * 1024 * 1024);

      const realReadSync = fs.readSync.bind(fs);
      let bytesRead = 0;
      const spy = vi.spyOn(fs, 'readSync').mockImplementation(((
        ...args: Parameters<typeof fs.readSync>
      ) => {
        const count = realReadSync(...args);
        bytesRead += args[3] as number;
        return count;
      }) as typeof fs.readSync);
      try {
        await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'small',
        });
      } finally {
        spy.mockRestore();
      }

      // The head window plus one boundary chunk — never the transcript's
      // remaining bytes, which is what made every append scale with size.
      expect(bytesRead).toBeGreaterThan(0);
      expect(bytesRead).toBeLessThan(512 * 1024);
      expect(
        fs
          .readFileSync(transcriptPath, 'utf8')
          .endsWith('{"message":"small"}\n'),
      ).toBe(true);
    });

    it('holds writer invariants over generated transcripts (property fuzz)', async () => {
      // Deterministic seeded fuzz over the ownership classifier and writer:
      // random mixes of records, markers, escapes, gluing, tearing (including
      // mid-string EOF) and junk, asserted against the contract rather than
      // the implementation —
      //   soundness: positive Managed evidence always refuses, bytes unchanged;
      //   liveness:  a transcript with no ownership marker anywhere always
      //              accepts, exactly like the merge-base writer did;
      //   both:      a refusal never mutates bytes, an acceptance appends the
      //              record verbatim as its own parseable line, leaves no
      //              positive Managed evidence behind, and a second append
      //              succeeds on the result.
      const mulberry32 = (seed: number) => {
        let a = seed >>> 0;
        return () => {
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };
      const MARKERS = ['session_execution_engine', 'managed_session_header_v1'];
      const hasMarker = (content: string) =>
        MARKERS.some((m) => content.includes(m)) || content.includes('\\u');
      const escapeMarker = (line: string) =>
        line
          .replace(
            /session_execution_engine/g,
            'session\\u005fexecution\\u005fengine',
          )
          .replace(
            /managed_session_header_v1/g,
            'managed\\u005fsession\\u005fheader\\u005fv1',
          );
      const texts = [
        'ok',
        'session_execution_engine',
        'managed_session_header_v1',
        'a "quoted" marker: session_execution_engine',
        'backslash tail \\',
        '中文 é multiline',
        '{"looks":"like json"}',
      ];
      const recordBuilders = [
        () =>
          JSON.stringify({
            type: 'user',
            message: { role: 'user', parts: [{ text: 'ok' }] },
          }),
        () =>
          JSON.stringify({
            type: 'user',
            subtype: 'goal_runtime',
            message: { role: 'user', parts: [{ text: 'ok' }] },
          }),
        () =>
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', parts: [{ text: 'reply' }] },
          }),
        () =>
          JSON.stringify({
            type: 'system',
            subtype: 'session_execution_engine',
            systemPayload: { version: 1, engine: 'legacy' },
          }),
        () =>
          JSON.stringify({
            type: 'system',
            subtype: 'session_execution_engine',
            systemPayload: { version: 2, engine: 'legacy' },
          }),
        () =>
          JSON.stringify({
            type: 'system',
            subtype: 'session_execution_engine',
            systemPayload: { version: 1, engine: 'managed' },
          }),
        () =>
          JSON.stringify({
            type: 'system',
            subtype: 'managed_session_header_v1',
          }),
        () =>
          JSON.stringify({
            type: 'system',
            subtype: 'other',
            text: 'session_execution_engine',
          }),
        () => '{}',
        () => '[not an object',
        () => 'null',
      ];

      const buildTranscript = (rng: () => number) => {
        const lineCount = 1 + Math.floor(rng() * 4);
        const parts: string[] = [];
        let glued = false;
        for (let i = 0; i < lineCount; i++) {
          let piece =
            recordBuilders[Math.floor(rng() * recordBuilders.length)]();
          if (rng() < 0.3) piece = escapeMarker(piece);
          if (rng() < 0.5) {
            // splice marker text into a message body
            const text = texts[Math.floor(rng() * texts.length)];
            piece = piece.replace(
              /"text":"ok"/,
              `"text":"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
            );
          }
          if (rng() < 0.35 && parts.length > 0) {
            // tear the previous line at a random position (not its first byte)
            const idx = parts.length - 1;
            const cut =
              1 + Math.floor(rng() * Math.max(1, parts[idx].length - 1));
            parts[idx] = parts[idx].slice(0, cut);
          }
          parts.push(piece);
          glued = rng() < 0.35 && i < lineCount - 1;
        }
        const separator = glued ? '' : '\n';
        return parts.join('\n') + separator;
      };

      const ITERATIONS = 300;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      let soundnessChecked = 0;
      let livenessChecked = 0;
      let discretionary = 0;
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const rng = mulberry32(0xc0ffee + iteration * 7919);
        const content = buildTranscript(rng);
        fs.writeFileSync(transcriptPath, content, { mode: 0o600 });
        const before = fs.readFileSync(transcriptPath, 'utf8');
        const evidenceBefore = readManagedExecutionEvidenceSync(transcriptPath);
        let refused = false;
        try {
          await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
            message: 'probe',
          });
        } catch {
          refused = true;
        }
        const after = fs.readFileSync(transcriptPath, 'utf8');

        if (evidenceBefore === true) {
          soundnessChecked++;
          expect(
            refused,
            `managed evidence must refuse [${iteration}]: ${JSON.stringify(content)}`,
          ).toBe(true);
        } else if (!hasMarker(before)) {
          livenessChecked++;
          expect(
            refused,
            `marker-less transcript must accept [${iteration}]: ${JSON.stringify(content)}`,
          ).toBe(false);
        } else {
          discretionary++;
        }

        if (refused) {
          expect(
            after,
            `refusal must not mutate bytes [${iteration}]: ${JSON.stringify(content)}`,
          ).toBe(before);
        } else {
          const appended = `${before}${before.endsWith('\n') ? '' : '\n'}{"message":"probe"}\n`;
          expect(
            after,
            `acceptance must append verbatim [${iteration}]: ${JSON.stringify({ before, content })}`,
          ).toBe(appended);
          expect(readManagedExecutionEvidenceSync(transcriptPath)).toBe(false);
          await expect(
            appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
              message: 'probe2',
            }),
          ).resolves.toBeUndefined();
        }
      }
      expect(soundnessChecked).toBeGreaterThan(0);
      expect(livenessChecked).toBeGreaterThan(0);
      expect(soundnessChecked + livenessChecked + discretionary).toBe(
        ITERATIONS,
      );
    });

    it('accepts an exactly bounded UTF-8 record and continues appending', async () => {
      const limit = 8 * 1024 * 1024;
      const empty = JSON.stringify({ type: 'user', message: '' });
      const textBytes = limit - Buffer.byteLength(empty);
      const record = {
        type: 'user',
        message: `${'é'.repeat(Math.floor(textBytes / 2))}${'x'.repeat(textBytes % 2)}`,
      };
      expect(Buffer.byteLength(JSON.stringify(record))).toBe(limit);
      await appendLegacySessionTranscriptLine(
        transcriptPath,
        sessionId,
        record,
      );
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'next',
      });
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
        `${JSON.stringify(record)}\n{"message":"next"}\n`,
      );
      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it.each([false, true])(
      'enforces the exact byte boundary at EOF (newline: %s)',
      async (newline) => {
        const limit = 32 * 1024 * 1024;
        const prefix = '{"message":"';
        const suffix = '"}';
        const makeLine = (size: number) =>
          `${prefix}${'x'.repeat(size - prefix.length - suffix.length)}${suffix}`;
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        for (const size of [limit, limit + 1]) {
          const original = `${makeLine(size)}${newline ? '\n' : ''}`;
          fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
          fs.chmodSync(transcriptPath, 0o644);
          const append = appendLegacySessionTranscriptLine(
            transcriptPath,
            sessionId,
            { message: 'next' },
          );
          if (size === limit) {
            await expect(append).resolves.toBeUndefined();
            expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(
              `${makeLine(size)}\n{"message":"next"}\n`,
            );
            expect(modeOf(transcriptPath)).toBe(0o600);
          } else {
            await expect(append).rejects.toThrow(/line exceeds the read bound/);
            expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
            expect(modeOf(transcriptPath)).toBe(0o644);
          }
        }
      },
    );

    it('refuses a first line beyond the inspection bound rather than trusting its prefix', async () => {
      const original = `{"type":"user","message":"${'x'.repeat(32 * 1024 * 1024)}"}\n`;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'no',
        }),
      ).rejects.toThrow(/line exceeds the read bound/);
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
      expect(modeOf(transcriptPath)).toBe(0o644);
    });

    it.each([false, true])(
      'rejects reordered, escaped and glued owner evidence after 8 MiB (newline: %s)',
      async (newline) => {
        const padding = 'x'.repeat(8 * 1024 * 1024);
        const owners = [
          `{"padding":"${padding}","systemPayload":{"engine":"managed","version":1},"subtype":"session_execution_engine","type":"system"}`,
          `{"padding":"${padding}","type":"system","sub\\u0074ype":"session\\u005fexecution_engine","systemPayload":{"version":1,"engine":"managed"}}`,
          `{"padding":"${padding}","type":"system","subtype":"session_execution_engine","subtype":"other","systemPayload":{"version":1,"engine":"managed"}}`,
          `{"type":"user","message":"${padding}"}${MANAGED_OWNER_LINE.trimEnd()}`,
        ];
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        for (const owner of owners) {
          const original = `${owner}${newline ? '\n' : ''}`;
          fs.writeFileSync(transcriptPath, original, { mode: 0o644 });
          fs.chmodSync(transcriptPath, 0o644);
          await expect(
            appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
              message: 'no',
            }),
          ).rejects.toMatchObject({ name: 'SessionExecutionEngineError' });
          expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
          expect(modeOf(transcriptPath)).toBe(0o644);
        }
      },
    );

    it('does not treat nested JSON in an oversized message as ownership evidence', async () => {
      const embedded = JSON.stringify({
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'managed' },
      });
      const oversized = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: `${embedded} ${'z'.repeat(1100 * 1024)}` }],
        },
      });
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${oversized}\n`, { mode: 0o600 });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          type: 'assistant',
          message: { role: 'assistant', parts: [{ text: 'next' }] },
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses an oversized first record whose shape cannot be decided', async () => {
      // Not a shape this writer produces (its records lead with `type` within
      // the first few hundred bytes), so the classification cannot rule out an
      // ownership record: fail closed instead of appending to a transcript of
      // unknown ownership.
      const undecidable = `{"text":"${'x'.repeat(1100 * 1024)}`;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${undecidable}\n`, { mode: 0o600 });
      const original = fs.readFileSync(transcriptPath, 'utf8');

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'must not append',
        }),
      ).rejects.toThrow(/ownership could not be verified/);

      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
    });

    it('still refuses an oversized first record that is an ownership record', async () => {
      const oversizedOwner = JSON.stringify({
        uuid: 'owner-record',
        parentUuid: null,
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'system',
        provenance: 'system',
        cwd: projectDir,
        version: 'test',
        gitBranch: null,
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'managed' },
        padding: 'p'.repeat(1100 * 1024),
      });
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${oversizedOwner}\n`, { mode: 0o600 });
      const original = fs.readFileSync(transcriptPath, 'utf8');

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'must not append',
        }),
      ).rejects.toThrow(/ownership could not be verified|belongs to managed/);

      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(original);
    });

    it('still refuses an oversized ownership record whose subtype is JSON-escaped', async () => {
      const oversizedOwner = JSON.stringify({
        uuid: 'owner-record',
        parentUuid: null,
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'system',
        provenance: 'system',
        cwd: projectDir,
        version: 'test',
        gitBranch: null,
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'managed' },
        padding: 'p'.repeat(1100 * 1024),
      }).replace(
        '"subtype":"session_execution_engine"',
        '"subtype":"session\\u005fexecution\\u005fengine"',
      );
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${oversizedOwner}\n`, { mode: 0o600 });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'must not append',
        }),
      ).rejects.toThrow(/ownership could not be verified|belongs to managed/);
    });

    it('refuses a directory at the transcript path', async () => {
      fs.mkdirSync(transcriptPath, { recursive: true });

      await expect(
        appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
          message: 'must not write',
        }),
      ).rejects.toThrow();

      expect(fs.statSync(transcriptPath).isDirectory()).toBe(true);
    });

    it.runIf(process.platform !== 'win32')(
      'refuses a FIFO at the transcript path without blocking',
      async () => {
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        execFileSync('mkfifo', [transcriptPath]);
        const writeSpy = vi.spyOn(fs, 'writeSync');
        await expect(
          appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
            message: 'must not write',
          }),
        ).rejects.toMatchObject({ name: 'SessionWriterUnavailableError' });
        expect(writeSpy).not.toHaveBeenCalled();
        expect(fs.lstatSync(transcriptPath).isFIFO()).toBe(true);
      },
    );

    it('recreates a transcript deleted mid-session with owner-only permissions', async () => {
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'first',
      });
      expect(modeOf(transcriptPath)).toBe(0o600);

      fs.rmSync(transcriptPath);
      await appendLegacySessionTranscriptLine(transcriptPath, sessionId, {
        message: 'second',
      });

      expect(modeOf(transcriptPath)).toBe(0o600);
    });

    it('keeps appending to the pinned file descriptor if the path is unlinked', async () => {
      const probed = path.join(projectDir, 'chats', 'probe-race.jsonl');
      fs.mkdirSync(path.dirname(probed), { recursive: true });
      fs.writeFileSync(probed, `${JSON.stringify({ seed: true })}\n`, {
        mode: 0o600,
      });
      let openedFd: number | undefined;
      const realOpenSync = fs.openSync.bind(fs);
      const realCloseSync = fs.closeSync.bind(fs);
      vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
        const fd = realOpenSync(...args);
        if (args[0] === probed) openedFd = fd;
        return fd;
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        if (fd === openedFd) fs.rmSync(probed, { force: true });
        return realCloseSync(fd);
      });

      await appendLegacySessionTranscriptLine(probed, sessionId, {
        after: 'probe',
      });

      expect(fs.existsSync(probed)).toBe(false);
      const entries = fs.readdirSync(path.dirname(probed));
      expect(entries).toHaveLength(0);
    });

    it('recreates owner-only when sync JSONL writer loses the path after the tail probe', () => {
      // Keep the generic JSONL writer coverage: it protects the unrelated
      // writeLineSync path from regressing while transcript appends use their
      // own descriptor-bound writer.
      // Mirror the async race above for writeLineSync: delete the path when
      // the read-only tail descriptor closes, before appendFileSync opens it.
      const probed = path.join(projectDir, 'chats', 'sync-probe-race.jsonl');
      fs.mkdirSync(path.dirname(probed), { recursive: true });
      // Start world-readable so the test also fails if the probe hook is
      // missed and the existing file is merely appended to in place.
      fs.writeFileSync(probed, `${JSON.stringify({ seed: true })}\n`, {
        mode: 0o644,
      });

      const realOpenSync = fs.openSync.bind(fs);
      const realCloseSync = fs.closeSync.bind(fs);
      let probeFd: number | undefined;
      let sawProbeClose = false;
      vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
        const fd = realOpenSync(...args);
        const flags = args[1];
        if (
          args[0] === probed &&
          typeof flags === 'number' &&
          (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
        ) {
          probeFd = fd;
        }
        return fd;
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        if (fd === probeFd) {
          probeFd = undefined;
          sawProbeClose = true;
          fs.rmSync(probed, { force: true });
        }
        return realCloseSync(fd);
      });

      jsonl.writeLineSync(probed, { after: 'sync probe' });

      expect(sawProbeClose).toBe(true);
      expect(modeOf(probed)).toBe(0o600);
    });
  },
);
