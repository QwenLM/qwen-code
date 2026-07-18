/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getShellContextEnvVars } from './shellContextEnv.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { promptIdContext } from './promptIdContext.js';
import {
  sessionIdContext,
  registerSessionProjectDir,
  unregisterSessionProjectDir,
} from './sessionIdContext.js';
import { Storage } from '../config/storage.js';
import {
  isShellTracePropagationEnabled,
  getTraceContext,
  formatTraceparent,
} from '../telemetry/trace-context.js';

vi.mock('../telemetry/trace-context.js', () => ({
  isShellTracePropagationEnabled: vi.fn().mockReturnValue(false),
  getTraceContext: vi.fn().mockReturnValue(null),
  formatTraceparent: vi.fn().mockReturnValue('00-aaaa-bbbb-01'),
}));

describe('getShellContextEnvVars', () => {
  let originalSessionId: string | undefined;
  // Isolated for the same reason as the session id, and it matters more now: the
  // CLI exports QWEN_CODE_CLI to every shell it spawns, so a `npm test` run started
  // from inside a qwen session inherits it — and the exact-equality assertion below
  // would fail on a variable the test never set.
  let originalCli: string | undefined;
  // And QWEN_CODE_PROJECT_DIR, for the same reason again — the CLI exports it
  // too, and the `.toEqual()` exact matches below fail on the inherited key.
  // Reproduced: with it set, exactly the two exact-match tests fail. Restoring it
  // here also cleans up after the per-session tests below, which assign it and
  // used to leak the assignment into every later test in the file.
  let originalProjectDir: string | undefined;

  beforeEach(() => {
    originalSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    originalCli = process.env['QWEN_CODE_CLI'];
    delete process.env['QWEN_CODE_CLI'];
    originalProjectDir = process.env['QWEN_CODE_PROJECT_DIR'];
    delete process.env['QWEN_CODE_PROJECT_DIR'];
  });

  afterEach(() => {
    if (originalSessionId !== undefined) {
      process.env['QWEN_CODE_SESSION_ID'] = originalSessionId;
    } else {
      delete process.env['QWEN_CODE_SESSION_ID'];
    }
    if (originalCli !== undefined) {
      process.env['QWEN_CODE_CLI'] = originalCli;
    } else {
      delete process.env['QWEN_CODE_CLI'];
    }
    if (originalProjectDir !== undefined) {
      process.env['QWEN_CODE_PROJECT_DIR'] = originalProjectDir;
    } else {
      delete process.env['QWEN_CODE_PROJECT_DIR'];
    }
  });

  it('passes the running CLI down, so a subprocess does not resolve `qwen` off PATH', () => {
    // A skill that shells out to `qwen …` would otherwise reach whatever the machine
    // has installed. Dogfooded: a dev-daemon session ran `qwen review agent-prompt
    // --role 0`, PATH found a v0.19.10 whose agent-prompt predates --role, and the
    // review died on "Missing required argument: chunk".
    const dir = mkdtempSync(join(tmpdir(), 'cli-entry-'));
    try {
      const entry = join(dir, 'cli-entry.js');
      writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("hi");\n', {
        mode: 0o755,
      });
      process.env['QWEN_CODE_CLI'] = entry;
      expect(getShellContextEnvVars()['QWEN_CODE_CLI']).toBe(entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites a shebang-less .js with an EMPTY string — omission would leak it through the spread', () => {
    // The variable predates this mechanism with a second meaning: the desktop
    // app's scripts set it to a vendored `dist/cli.js` — a module path meant for
    // `node <path>`, with no shebang. `"${QWEN_CODE_CLI:-qwen}"` executing that
    // runs a JS bundle as a shell script (exit 126). Filtering must WRITE `''`:
    // every spawn site composes the child env as `{...process.env, ...vars}`,
    // so a key merely omitted from the returned record arrives anyway, inherited
    // through the spread — reproduced: exit 126 on exactly the hosts the filter
    // was written for. The `:-` expansion falls back to `qwen` on empty.
    const dir = mkdtempSync(join(tmpdir(), 'cli-nosb-'));
    try {
      const bundle = join(dir, 'cli.js');
      writeFileSync(bundle, '"use strict";\nconsole.log("bundle");\n');
      process.env['QWEN_CODE_CLI'] = bundle;

      const vars = getShellContextEnvVars();
      expect(vars['QWEN_CODE_CLI']).toBe('');
      // The contract, one spread up — the channel the omission bug lived in:
      const childEnv = { ...process.env, ...vars };
      expect(childEnv['QWEN_CODE_CLI']).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable entry is filtered through the same spread-safe channel', () => {
    // The catch branch (`shebangless = true` on read failure) must not leak the
    // inherited value either — a deleted or permission-blocked path is exactly
    // as unusable as a shebang-less one.
    process.env['QWEN_CODE_CLI'] = '/no/such/dir/cli.js';
    const childEnv = { ...process.env, ...getShellContextEnvVars() };
    expect(childEnv['QWEN_CODE_CLI']).toBe('');
  });

  it('an EXECUTABLE shebang-less .js is filtered by the header check itself', () => {
    // The other shebang-less test writes a 0644 file, which the X_OK check
    // rejects before the header is ever read — leaving the shebang-reading
    // branch untested for its primary real-world target: a desktop vendored
    // dist/cli.js that IS executable and still has no shebang. A regression in
    // the header read (wrong byte count, offset, or comparison) would have
    // passed every test.
    const dir = mkdtempSync(join(tmpdir(), 'cli-exec-nosb-'));
    try {
      const bundle = join(dir, 'cli.js');
      writeFileSync(bundle, '"use strict";\nconsole.log("bundle");\n', {
        mode: 0o755,
      });
      process.env['QWEN_CODE_CLI'] = bundle;
      const childEnv = { ...process.env, ...getShellContextEnvVars() };
      expect(childEnv['QWEN_CODE_CLI']).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shebang-bearing script with no execute bit is filtered too — EACCES is not an entry', () => {
    // The header check alone passes a 0644 script, and the shell then dies on
    // EACCES instead of falling back. Execute permission is part of "the shell
    // can exec this".
    const dir = mkdtempSync(join(tmpdir(), 'cli-noexec-'));
    try {
      const entry = join(dir, 'entry.js');
      writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("hi");\n', {
        mode: 0o644,
      });
      process.env['QWEN_CODE_CLI'] = entry;
      const childEnv = { ...process.env, ...getShellContextEnvVars() };
      expect(childEnv['QWEN_CODE_CLI']).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shebang-bearing entry still passes through the spread intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-sb-'));
    try {
      const entry = join(dir, 'entry.js');
      writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("hi");\n', {
        mode: 0o755,
      });
      process.env['QWEN_CODE_CLI'] = entry;
      const childEnv = { ...process.env, ...getShellContextEnvVars() };
      expect(childEnv['QWEN_CODE_CLI']).toBe(entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits QWEN_CODE_CLI when the host does not export one', () => {
    // Nothing to override: when the process env has no value, the spread at the
    // spawn sites has nothing to leak either, so absence is correct here. (NOT
    // because an empty string would shadow the fallback — the consumer is the
    // colon form `${QWEN_CODE_CLI:-qwen}`, which falls back on unset AND empty.
    // That mistaken comment is what produced the filter-by-omission bug below.)
    expect('QWEN_CODE_CLI' in getShellContextEnvVars()).toBe(false);
  });

  it('returns empty strings for agent/prompt when no context is available', () => {
    const env = getShellContextEnvVars();
    expect(env).toEqual({
      QWEN_CODE_AGENT_ID: '',
      QWEN_CODE_PROMPT_ID: '',
    });
  });

  it('returns QWEN_CODE_SESSION_ID when set in process.env', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'test-session-123';
    const env = getShellContextEnvVars();
    expect(env['QWEN_CODE_SESSION_ID']).toBe('test-session-123');
  });

  it('returns QWEN_CODE_AGENT_ID when called within agent context', async () => {
    const env = await runWithAgentContext('my-agent-42', async () =>
      getShellContextEnvVars(),
    );
    expect(env['QWEN_CODE_AGENT_ID']).toBe('my-agent-42');
  });

  it('returns QWEN_CODE_PROMPT_ID when called within prompt context', () => {
    const env = promptIdContext.run('prompt-abc', () =>
      getShellContextEnvVars(),
    );
    expect(env['QWEN_CODE_PROMPT_ID']).toBe('prompt-abc');
  });

  it('returns all vars when all contexts are active', async () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'sess-uuid';
    const env = await runWithAgentContext('agent-xyz', async () =>
      promptIdContext.run('prompt-456', () => getShellContextEnvVars()),
    );
    expect(env).toEqual({
      QWEN_CODE_SESSION_ID: 'sess-uuid',
      QWEN_CODE_AGENT_ID: 'agent-xyz',
      QWEN_CODE_PROMPT_ID: 'prompt-456',
    });
  });

  describe('project dir is per-session, not per-process', () => {
    it('hands each session its own project dir', () => {
      // One daemon process, two sessions, two workspaces. A single process-global
      // slot holds whichever booted first — and every later session would then
      // hand its subprocesses another session's directory, where it would look
      // for that session's transcripts and find none (or worse, find theirs).
      registerSessionProjectDir('sess-A', '/proj/A');
      registerSessionProjectDir('sess-B', '/proj/B');
      process.env['QWEN_CODE_PROJECT_DIR'] = '/proj/A'; // the first to boot

      const a = sessionIdContext.run('sess-A', () => getShellContextEnvVars());
      const b = sessionIdContext.run('sess-B', () => getShellContextEnvVars());

      expect(a['QWEN_CODE_PROJECT_DIR']).toBe('/proj/A');
      expect(b['QWEN_CODE_PROJECT_DIR']).toBe('/proj/B'); // NOT A's
    });

    it('drops a session entry on unregister — no daemon leak', () => {
      registerSessionProjectDir('sess-X', '/proj/X');
      expect(
        sessionIdContext.run('sess-X', () => getShellContextEnvVars())[
          'QWEN_CODE_PROJECT_DIR'
        ],
      ).toBe('/proj/X');
      unregisterSessionProjectDir('sess-X');
      delete process.env['QWEN_CODE_PROJECT_DIR'];
      expect(
        sessionIdContext.run('sess-X', () => getShellContextEnvVars())[
          'QWEN_CODE_PROJECT_DIR'
        ],
      ).toBeUndefined();
    });

    it('keeps another Config registration when one owner unregisters', () => {
      registerSessionProjectDir('sess-shared', '/proj/live', 'live-owner');
      registerSessionProjectDir(
        'sess-shared',
        '/proj/contender',
        'contender-owner',
      );

      unregisterSessionProjectDir('sess-shared', 'contender-owner');

      expect(
        sessionIdContext.run('sess-shared', () => getShellContextEnvVars())[
          'QWEN_CODE_PROJECT_DIR'
        ],
      ).toBe('/proj/live');
      unregisterSessionProjectDir('sess-shared', 'live-owner');
    });

    it('uses the most recently refreshed owner registration', () => {
      registerSessionProjectDir('sess-refresh', '/proj/live', 'live-owner');
      registerSessionProjectDir(
        'sess-refresh',
        '/proj/preview',
        'preview-owner',
      );
      registerSessionProjectDir(
        'sess-refresh',
        '/proj/live-moved',
        'live-owner',
      );

      expect(
        sessionIdContext.run('sess-refresh', () => getShellContextEnvVars())[
          'QWEN_CODE_PROJECT_DIR'
        ],
      ).toBe('/proj/live-moved');

      unregisterSessionProjectDir('sess-refresh');
    });

    it('isolates the same session id across runtime output directories', () => {
      registerSessionProjectDir(
        'sess-shared-runtime',
        '/runtime-a/project',
        'runtime-a-owner',
        '/runtime-a',
      );
      registerSessionProjectDir(
        'sess-shared-runtime',
        '/runtime-b/project',
        'runtime-b-owner',
        '/runtime-b',
      );

      const fromA = Storage.runWithRuntimeBaseDir('/runtime-a', undefined, () =>
        sessionIdContext.run('sess-shared-runtime', () =>
          getShellContextEnvVars(),
        ),
      );
      const fromB = Storage.runWithRuntimeBaseDir('/runtime-b', undefined, () =>
        sessionIdContext.run('sess-shared-runtime', () =>
          getShellContextEnvVars(),
        ),
      );

      expect(fromA['QWEN_CODE_PROJECT_DIR']).toBe('/runtime-a/project');
      expect(fromB['QWEN_CODE_PROJECT_DIR']).toBe('/runtime-b/project');
      unregisterSessionProjectDir('sess-shared-runtime');
    });

    it('falls back to the env var for the single-session CLI', () => {
      process.env['QWEN_CODE_PROJECT_DIR'] = '/proj/only';
      expect(getShellContextEnvVars()['QWEN_CODE_PROJECT_DIR']).toBe(
        '/proj/only',
      );
    });
  });

  describe('session ID from AsyncLocalStorage (daemon multi-session)', () => {
    it('prefers sessionIdContext over process.env', () => {
      // Daemon mode: process.env holds the FIRST session's ID forever
      // (constructor guard `sessionEnvClaimed` in config.ts), so a later
      // session must win via its own async context.
      process.env['QWEN_CODE_SESSION_ID'] = 'stale-first-session';
      const env = sessionIdContext.run('current-session', () =>
        getShellContextEnvVars(),
      );
      expect(env['QWEN_CODE_SESSION_ID']).toBe('current-session');
    });

    it('falls back to process.env outside any session context (single-session CLI)', () => {
      process.env['QWEN_CODE_SESSION_ID'] = 'cli-session';
      const env = getShellContextEnvVars();
      expect(env['QWEN_CODE_SESSION_ID']).toBe('cli-session');
    });

    it('isolates concurrent sessions in the same process', async () => {
      // Regression: two daemon sessions interleaving must each see their
      // own ID at spawn time, even though process.env is a single slot.
      process.env['QWEN_CODE_SESSION_ID'] = 'stale-first-session';
      let envSeenByA: Record<string, string> = {};
      let envSeenByB: Record<string, string> = {};

      await Promise.all([
        sessionIdContext.run('session-A', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          envSeenByA = getShellContextEnvVars();
        }),
        sessionIdContext.run('session-B', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          envSeenByB = getShellContextEnvVars();
        }),
      ]);

      expect(envSeenByA['QWEN_CODE_SESSION_ID']).toBe('session-A');
      expect(envSeenByB['QWEN_CODE_SESSION_ID']).toBe('session-B');
    });
  });

  it('sets empty string for agent/prompt to override inherited env', () => {
    // Simulates a nested qwen-code process where parent injected these
    const env = getShellContextEnvVars();
    expect(env['QWEN_CODE_AGENT_ID']).toBe('');
    expect(env['QWEN_CODE_PROMPT_ID']).toBe('');
    // Empty strings will overwrite any stale inherited values in process.env
  });

  describe('TRACEPARENT injection', () => {
    afterEach(() => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(false);
      vi.mocked(getTraceContext).mockReturnValue(null);
    });

    it('does not inject TRACEPARENT when propagation is disabled', () => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(false);
      const env = getShellContextEnvVars();
      expect(env['TRACEPARENT']).toBeUndefined();
    });

    it('injects TRACEPARENT when propagation is enabled and context exists', () => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(true);
      vi.mocked(getTraceContext).mockReturnValue({
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanId: 'bbbbbbbbbbbbbbbb',
        traceFlags: 1,
      });
      vi.mocked(formatTraceparent).mockReturnValue(
        '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      );

      const env = getShellContextEnvVars();
      expect(env['TRACEPARENT']).toBe(
        '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      );
      expect(env['TRACESTATE']).toBe('');
    });

    it('clears TRACEPARENT and TRACESTATE when propagation is enabled but no context', () => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(true);
      vi.mocked(getTraceContext).mockReturnValue(null);

      const env = getShellContextEnvVars();
      expect(env['TRACEPARENT']).toBe('');
      expect(env['TRACESTATE']).toBe('');
    });
  });
});
