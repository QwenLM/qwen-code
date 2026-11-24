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
import { promptIdContext } from '../utils/promptIdContext.js';
import {
  sessionIdContext,
  registerSessionProjectDir,
  unregisterSessionProjectDir,
  registerSessionModel,
  unregisterSessionModel,
} from '../utils/sessionIdContext.js';
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
  // Cleared before and restored after each test. A test run started from
  // inside a qwen session inherits these: the CLI exports QWEN_CODE_CLI and
  // QWEN_CODE_PROJECT_DIR to every shell it spawns, and Config claims
  // QWEN_CODE_MODEL (and its provider-qualified twin, QWEN_CODE_MODEL_IDENTITY)
  // into process.env. The exact-equality `.toEqual()` assertions below would
  // then fail on a variable the test never set — reproduced for
  // QWEN_CODE_PROJECT_DIR: exactly the two exact-match tests fail. Restoring
  // also cleans up after the per-session tests, which assign
  // QWEN_CODE_PROJECT_DIR and used to leak it into every later test.
  const isolatedKeys = [
    'QWEN_CODE_SESSION_ID',
    'QWEN_CODE_CLI',
    'QWEN_CODE_PROJECT_DIR',
    'QWEN_CODE_MODEL',
    'QWEN_CODE_MODEL_IDENTITY',
  ];
  const originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of isolatedKeys) {
      originals[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of isolatedKeys) {
      if (originals[key] !== undefined) {
        process.env[key] = originals[key];
      } else {
        delete process.env[key];
      }
    }
  });

  const SHEBANG_JS = '#!/usr/bin/env node\nconsole.log("hi");\n';
  const BUNDLE_JS = '"use strict";\nconsole.log("bundle");\n';

  /**
   * Points QWEN_CODE_CLI at a fresh temp dir itself (no `file`) or at `file`
   * written inside it, runs `check` with that path, then removes the dir.
   */
  function withCliEntry(
    prefix: string,
    file: { name: string; body: string; mode?: number } | undefined,
    check: (entry: string) => void,
  ): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try {
      let entry = dir;
      if (file) {
        entry = join(dir, file.name);
        const { mode } = file;
        writeFileSync(
          entry,
          file.body,
          mode === undefined ? undefined : { mode },
        );
      }
      process.env['QWEN_CODE_CLI'] = entry;
      check(entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** QWEN_CODE_CLI as a child sees it, composed the way spawn sites do. */
  const childCli = () =>
    ({ ...process.env, ...getShellContextEnvVars() })['QWEN_CODE_CLI'];

  const inSession = (sessionId: string) =>
    sessionIdContext.run(sessionId, () => getShellContextEnvVars());

  it('passes the running CLI down, so a subprocess does not resolve `qwen` off PATH', () => {
    // A skill that shells out to `qwen …` would otherwise reach whatever the machine
    // has installed. Dogfooded: a dev-daemon session ran `qwen review agent-prompt
    // --role 0`, PATH found a v0.19.10 whose agent-prompt predates --role, and the
    // review died on "Missing required argument: chunk".
    withCliEntry(
      'cli-entry-',
      { name: 'cli-entry.js', body: SHEBANG_JS, mode: 0o755 },
      (entry) => {
        expect(getShellContextEnvVars()['QWEN_CODE_CLI']).toBe(entry);
      },
    );
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
    withCliEntry('cli-nosb-', { name: 'cli.js', body: BUNDLE_JS }, () => {
      const vars = getShellContextEnvVars();
      expect(vars['QWEN_CODE_CLI']).toBe('');
      // The contract, one spread up — the channel the omission bug lived in:
      expect({ ...process.env, ...vars }['QWEN_CODE_CLI']).toBe('');
    });
  });

  it('an unreadable entry is filtered through the same spread-safe channel', () => {
    // The catch branch (`shebangless = true` on read failure) must not leak the
    // inherited value either — a deleted or permission-blocked path is exactly
    // as unusable as a shebang-less one.
    process.env['QWEN_CODE_CLI'] = '/no/such/dir/cli.js';
    expect(childCli()).toBe('');
  });

  it('an EXECUTABLE shebang-less .js is filtered by the header check itself', () => {
    // The other shebang-less test writes a 0644 file, which the X_OK check
    // rejects before the header is ever read — leaving the shebang-reading
    // branch untested for its primary real-world target: a desktop vendored
    // dist/cli.js that IS executable and still has no shebang. A regression in
    // the header read (wrong byte count, offset, or comparison) would have
    // passed every test.
    withCliEntry(
      'cli-exec-nosb-',
      { name: 'cli.js', body: BUNDLE_JS, mode: 0o755 },
      () => expect(childCli()).toBe(''),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'a shebang-bearing script with no execute bit is filtered too — EACCES is not an entry',
    () => {
      // The header check alone passes a 0644 script, and the shell then dies on
      // EACCES instead of falling back. Execute permission is part of "the shell
      // can exec this".
      withCliEntry(
        'cli-noexec-',
        { name: 'entry.js', body: SHEBANG_JS, mode: 0o644 },
        () => expect(childCli()).toBe(''),
      );
    },
  );

  it('a shebang-bearing entry still passes through the spread intact', () => {
    withCliEntry(
      'cli-sb-',
      { name: 'entry.js', body: SHEBANG_JS, mode: 0o755 },
      (entry) => expect(childCli()).toBe(entry),
    );
  });

  it('a DIRECTORY entry is filtered — search permission is not executability', () => {
    // `node <pkg-dir>` makes argv[1] the directory itself, and a directory
    // passes an X_OK probe. An extension allowlist answered "usable" for it
    // and every `"${QWEN_CODE_CLI:-qwen}"` died on exit 126; only the
    // regular-file check can refuse this shape.
    withCliEntry('cli-dir-', undefined, () => expect(childCli()).toBe(''));
  });

  it('an executable script extension without a shebang is filtered beyond the .js family', () => {
    // The tsx dev launch hands argv[1] as the source `.ts`. Even executable,
    // a shebang-less script is exec'd by the kernel as a SHELL script — the
    // same reason the vendored `.js` bundle is filtered. The gate reads the
    // header for every known script extension, not an enumerated subset.
    withCliEntry(
      'cli-ts-',
      { name: 'index.ts', body: 'export {};\n', mode: 0o755 },
      () => expect(childCli()).toBe(''),
    );
  });

  it('a native-binary shape — executable, no extension, no shebang — passes', () => {
    // The gate demands positive evidence, not a shebang universally: a native
    // binary has none and must not be filtered. Extensionless-and-executable
    // is that shape's stand-in here.
    withCliEntry(
      'cli-bin-',
      { name: 'qwen', body: '\x7fELF-not-really\n', mode: 0o755 },
      (entry) => expect(childCli()).toBe(entry),
    );
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
    expect(getShellContextEnvVars()).toEqual({
      QWEN_CODE_AGENT_ID: '',
      QWEN_CODE_PROMPT_ID: '',
      // Blanked, not omitted — see the identity describe block below.
      QWEN_CODE_MODEL_IDENTITY: '',
    });
  });

  it('returns QWEN_CODE_SESSION_ID when set in process.env', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'test-session-123';
    expect(getShellContextEnvVars()['QWEN_CODE_SESSION_ID']).toBe(
      'test-session-123',
    );
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
      QWEN_CODE_MODEL_IDENTITY: '',
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

      const a = inSession('sess-A');
      const b = inSession('sess-B');

      expect(a['QWEN_CODE_PROJECT_DIR']).toBe('/proj/A');
      expect(b['QWEN_CODE_PROJECT_DIR']).toBe('/proj/B'); // NOT A's
    });

    it('drops a session entry on unregister — no daemon leak', () => {
      registerSessionProjectDir('sess-X', '/proj/X');
      expect(inSession('sess-X')['QWEN_CODE_PROJECT_DIR']).toBe('/proj/X');
      unregisterSessionProjectDir('sess-X');
      delete process.env['QWEN_CODE_PROJECT_DIR'];
      expect(inSession('sess-X')['QWEN_CODE_PROJECT_DIR']).toBeUndefined();
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
      const env = inSession('current-session');
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
      const envAfterDelay = (sessionId: string) =>
        sessionIdContext.run(sessionId, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return getShellContextEnvVars();
        });

      const [envSeenByA, envSeenByB] = await Promise.all([
        envAfterDelay('session-A'),
        envAfterDelay('session-B'),
      ]);

      expect(envSeenByA['QWEN_CODE_SESSION_ID']).toBe('session-A');
      expect(envSeenByB['QWEN_CODE_SESSION_ID']).toBe('session-B');
    });
  });

  describe('active model id (QWEN_CODE_MODEL)', () => {
    it('passes the active model down from the Config-claimed slot', () => {
      // A subprocess that must report which model ran (the /review compose
      // step) has no other authoritative source — settings files miss /model
      // switches and describe the wrong home under QWEN_HOME isolation.
      process.env['QWEN_CODE_MODEL'] = 'qwen3-coder-plus';
      expect(getShellContextEnvVars()['QWEN_CODE_MODEL']).toBe(
        'qwen3-coder-plus',
      );
    });

    it('omits the key when no Config has claimed the slot', () => {
      // Same rule as the session ID: nothing in process.env means the
      // spawn-site spread has nothing stale to leak, so absence is correct.
      expect('QWEN_CODE_MODEL' in getShellContextEnvVars()).toBe(false);
    });

    it('reflects a republished slot after a model switch', () => {
      // publishModelEnv in config.ts rewrites the slot on set/switchModel and
      // refreshAuth; spawn-time reads must see the CURRENT value, not one
      // captured earlier.
      process.env['QWEN_CODE_MODEL'] = 'model-before-switch';
      getShellContextEnvVars();
      process.env['QWEN_CODE_MODEL'] = 'model-after-switch';
      expect(getShellContextEnvVars()['QWEN_CODE_MODEL']).toBe(
        'model-after-switch',
      );
    });
  });

  describe('provider-qualified identity (QWEN_CODE_MODEL_IDENTITY)', () => {
    it('passes the qualified identity down beside the bare model', () => {
      process.env['QWEN_CODE_MODEL'] = 'qwen3-coder-plus';
      process.env['QWEN_CODE_MODEL_IDENTITY'] = 'qwen3-coder-plus@1a2b3c4d';
      const env = getShellContextEnvVars();
      expect(env['QWEN_CODE_MODEL']).toBe('qwen3-coder-plus');
      expect(env['QWEN_CODE_MODEL_IDENTITY']).toBe('qwen3-coder-plus@1a2b3c4d');
    });

    it('hands each session ITS identity, blanking rather than omitting', () => {
      // Daemon mode. The point is not what the returned record contains but
      // what the CHILD ends up with: every spawn site composes
      // `{...process.env, ...getShellContextEnvVars()}`, so an omitted key
      // leaves the parent's stale global riding the spread — the first cut of
      // this test asserted on the raw record and passed while the leak was
      // live. Compose it the way the spawn sites do.
      registerSessionModel('sess-A', 'model-A', 'model-A@aaaaaaaa');
      registerSessionModel('sess-B', 'model-B', 'model-B@bbbbbbbb');
      process.env['QWEN_CODE_MODEL'] = 'model-A'; // the first to boot
      process.env['QWEN_CODE_MODEL_IDENTITY'] = 'model-A@aaaaaaaa';

      const child = (sid: string) => ({ ...process.env, ...inSession(sid) });
      expect(child('sess-B')['QWEN_CODE_MODEL_IDENTITY']).toBe(
        'model-B@bbbbbbbb',
      );
      expect(child('sess-A')['QWEN_CODE_MODEL_IDENTITY']).toBe(
        'model-A@aaaaaaaa',
      );

      // A session with no identity of its own must not inherit A's either —
      // and the global describes a DIFFERENT model, so it is dropped, not
      // passed down as a qualification of the wrong one.
      registerSessionModel('sess-C', 'model-C');
      expect(child('sess-C')['QWEN_CODE_MODEL']).toBe('model-C');
      expect(child('sess-C')['QWEN_CODE_MODEL_IDENTITY']).toBe('');

      for (const s of ['sess-A', 'sess-B', 'sess-C']) {
        unregisterSessionModel(s);
      }
    });

    it('drops the identity with the session on unregister', () => {
      registerSessionModel('sess-X', 'model-X', 'model-X@abcdabcd');
      expect(inSession('sess-X')['QWEN_CODE_MODEL_IDENTITY']).toBe(
        'model-X@abcdabcd',
      );
      unregisterSessionModel('sess-X');
      expect(inSession('sess-X')['QWEN_CODE_MODEL_IDENTITY']).toBe('');
    });

    it('matches on the whole model id, `@` in the name included', () => {
      // Split-on-first-`@` would compare `vendor` against `vendor@2026-01`
      // and withhold a correct identity; the suffix is what is anchored.
      process.env['QWEN_CODE_MODEL'] = 'vendor@2026-01';
      process.env['QWEN_CODE_MODEL_IDENTITY'] = 'vendor@2026-01@0f0f0f0f';
      expect(getShellContextEnvVars()['QWEN_CODE_MODEL_IDENTITY']).toBe(
        'vendor@2026-01@0f0f0f0f',
      );
    });

    it('drops \u2014 does not mis-qualify \u2014 a model NAMED like a qualified one', () => {
      // `foo@1a2b3c4d` is a legal model id, and the suffix rule cannot tell it
      // from `foo` qualified by a digest. The head then reads as `foo`, which
      // is not this session's model, so the identity is dropped. That costs
      // the qualification and nothing else: the subprocess falls back to the
      // bare id, which is coarser and true. Mis-qualifying would be the
      // failure; being coarse is the fail-safe direction.
      process.env['QWEN_CODE_MODEL'] = 'foo@1a2b3c4d';
      process.env['QWEN_CODE_MODEL_IDENTITY'] = 'foo@1a2b3c4d';
      const env = getShellContextEnvVars();
      expect(env['QWEN_CODE_MODEL']).toBe('foo@1a2b3c4d');
      expect(env['QWEN_CODE_MODEL_IDENTITY']).toBe('');
    });

    it('blanks the key when nothing published one', () => {
      // `''`, not absent: the spawn-site spread would otherwise leak an
      // inherited value from a parent qwen-code process. `roundModelIdFrom`
      // reads an empty identity as unpublished and falls back to the bare id.
      process.env['QWEN_CODE_MODEL'] = 'qwen3-coder-plus';
      expect(getShellContextEnvVars()['QWEN_CODE_MODEL_IDENTITY']).toBe('');
    });
  });

  describe('model is per-session, not per-process', () => {
    it('hands each session its own active model', () => {
      // One daemon process, two sessions, two /model selections. A single
      // process-global slot holds whichever booted first — and every later
      // session would then stamp a model that never ran the review, the exact
      // bug this PR opens with, relocated to the consumer.
      registerSessionModel('sess-A', 'model-A');
      registerSessionModel('sess-B', 'model-B');
      process.env['QWEN_CODE_MODEL'] = 'model-A'; // the first to boot

      const a = inSession('sess-A');
      const b = inSession('sess-B');

      expect(a['QWEN_CODE_MODEL']).toBe('model-A');
      expect(b['QWEN_CODE_MODEL']).toBe('model-B'); // NOT A's
    });

    it('drops a session entry on unregister — no daemon leak', () => {
      registerSessionModel('sess-X', 'model-X');
      expect(inSession('sess-X')['QWEN_CODE_MODEL']).toBe('model-X');
      unregisterSessionModel('sess-X');
      delete process.env['QWEN_CODE_MODEL'];
      expect(inSession('sess-X')['QWEN_CODE_MODEL']).toBeUndefined();
    });

    it('falls back to the global slot for the single-session CLI', () => {
      process.env['QWEN_CODE_MODEL'] = 'model-only';
      expect(getShellContextEnvVars()['QWEN_CODE_MODEL']).toBe('model-only');
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
