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
      ).rejects.toThrow(/ownership record exceeds the read bound/);

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
      ).rejects.toThrow(/ownership record exceeds the read bound/);
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
