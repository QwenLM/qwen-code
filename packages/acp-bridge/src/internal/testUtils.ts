/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @internal
 *
 * Shared bridge test fixtures used by `bridge.test.ts` (acp-bridge
 * package) and `daemonStatusProvider.test.ts` (cli package). Extracted
 * so both suites can exercise the same
 * `FakeAgent` / `makeChannel` / `makeBridge` helpers without
 * cross-package duplication.
 *
 * Cross-package resolution uses two channels because TypeScript's
 * `nodenext` moduleResolution will not fall back to tsconfig `paths`
 * once a package's `exports` rejects a subpath. So:
 *
 *   1. `package.json` lists `./internal/testUtils` in `exports` so
 *      TypeScript can resolve types at compile time (and the cli's
 *      vitest run can resolve it at runtime even without an alias).
 *   2. `packages/cli/vitest.config.ts` adds a `resolve.alias` for
 *      the same specifier that points at `src/` instead of `dist/`,
 *      so the cli test reads source directly — editing
 *      `testUtils.ts` doesn't require rebuilding acp-bridge.
 *
 * External consumers of `@qwen-code/acp-bridge` should NOT depend on
 * these helpers — the `internal/` directory matches the neighboring
 * `internal/stderrLine.ts` convention; the `@internal` JSDoc tag is
 * an additional package-private signal (stderrLine.ts uses prose
 * rather than the tag, but the intent is the same). The compiled
 * file is excluded from npm publish via the package's `.npmignore`,
 * so external consumers can't `import` it even though the source
 * remains in the build for in-repo cli vitest resolution.
 */

import * as path from 'node:path';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import { createAcpSessionBridge } from '../bridge.js';
import type { BridgeOptions } from '../bridgeOptions.js';
import type { AcpSessionBridge } from '../bridgeTypes.js';
import type { AcpChannel } from '../channel.js';

// Workspace fixtures must round-trip through `path.resolve` so the
// expected values match what the bridge canonicalizes internally on
// every platform — a literal `/work/a` resolves to `D:\work\a` on
// Windows and the assertion drifts. Same for the FakeAgent's
// `sess:<cwd>` synthetic id, since the cwd it sees is the post-resolve
// value the bridge passes through `connection.newSession`.
export const WS_A = path.resolve(path.sep, 'work', 'a');
export const WS_B = path.resolve(path.sep, 'work', 'b');
export const SESS_A = `sess:${WS_A}`;

/**
 * Convenience wrapper: `createAcpSessionBridge` requires `boundWorkspace`
 * (per #3803 §02 — 1 daemon = 1 workspace). Tests that only ever talk
 * to `WS_A` would otherwise repeat `boundWorkspace: WS_A` everywhere;
 * this helper defaults it. Tests that need a different bind path (e.g.
 * the mismatch test) pass `boundWorkspace` explicitly.
 *
 * Unlike the pre-split cli-side helper, this version does NOT default
 * `statusProvider` — that's a daemon-host-specific seam and
 * the acp-bridge tests exercise the no-provider fallback paths. The
 * cli-side `daemonStatusProvider.test.ts` defines its own wrapper that
 * wires `createDaemonStatusProvider()` for the 4 daemon-host
 * integration tests.
 */
export function makeBridge(
  opts: Partial<BridgeOptions> = {},
): AcpSessionBridge {
  return createAcpSessionBridge({
    boundWorkspace: WS_A,
    ...opts,
  });
}

export interface FakeAgentOpts {
  /** What the fake agent returns from `newSession`. */
  sessionIdPrefix?: string;
  /** Inject a per-call delay before responding to `initialize`. */
  initializeDelayMs?: number;
  /** Force `initialize` to throw. */
  initializeThrows?: Error;
  /**
   * Custom prompt handler. Default returns `end_turn` synchronously. Useful
   * for test cases that want to observe prompt ordering.
   */
  promptImpl?: (
    p: PromptRequest,
    self: FakeAgent,
  ) => Promise<PromptResponse> | PromptResponse;
  cancelImpl?: (p: CancelNotification, self: FakeAgent) => Promise<void> | void;
  /**
   * Custom `newSession` handler. Default returns a synthesized id (see
   * `newSession` below). Used by tests that need to exercise the
   * doSpawn newSession-failure path (e.g. throwing to cover the
   * `isDying`-mark-then-kill cleanup).
   */
  newSessionImpl?: (
    p: NewSessionRequest,
    self: FakeAgent,
  ) => Promise<NewSessionResponse> | NewSessionResponse;
  loadSessionImpl?: (
    p: LoadSessionRequest,
    self: FakeAgent,
  ) => Promise<LoadSessionResponse> | LoadSessionResponse;
  resumeSessionImpl?: (
    p: ResumeSessionRequest,
    self: FakeAgent,
  ) => Promise<ResumeSessionResponse> | ResumeSessionResponse;
  extMethodImpl?: (
    method: string,
    params: Record<string, unknown>,
    self: FakeAgent,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export class FakeAgent implements Agent {
  newSessionCalls: NewSessionRequest[] = [];
  loadSessionCalls: LoadSessionRequest[] = [];
  resumeSessionCalls: ResumeSessionRequest[] = [];
  promptCalls: PromptRequest[] = [];
  cancelCalls: CancelNotification[] = [];
  extMethodCalls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  constructor(private readonly opts: FakeAgentOpts = {}) {}

  async initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    if (this.opts.initializeThrows) throw this.opts.initializeThrows;
    if (this.opts.initializeDelayMs) {
      await new Promise((r) => setTimeout(r, this.opts.initializeDelayMs));
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'fake-agent', version: '0' },
      authMethods: [],
      agentCapabilities: {},
    };
  }

  async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(p);
    if (this.opts.newSessionImpl) {
      return this.opts.newSessionImpl(p, this);
    }
    const prefix = this.opts.sessionIdPrefix ?? 'sess';
    // Stage 1.5 multi-session: one FakeAgent can host multiple
    // sessions (same as the real ACP agent), so each newSession call
    // returns a fresh id. Suffix by call-count so tests that issue
    // multiple newSession on the same channel get distinct ids.
    const count = this.newSessionCalls.length;
    const suffix = count === 1 ? '' : `#${count}`;
    return { sessionId: `${prefix}:${p.cwd}${suffix}` };
  }

  async loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.loadSessionCalls.push(p);
    if (this.opts.loadSessionImpl) {
      return this.opts.loadSessionImpl(p, this);
    }
    return {};
  }
  async unstable_resumeSession(
    p: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    this.resumeSessionCalls.push(p);
    if (this.opts.resumeSessionImpl) {
      return this.opts.resumeSessionImpl(p, this);
    }
    return {};
  }
  async authenticate(_p: AuthenticateRequest): Promise<AuthenticateResponse> {
    throw new Error('not implemented in test fake');
  }
  async prompt(p: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(p);
    if (this.opts.promptImpl) {
      return this.opts.promptImpl(p, this);
    }
    return { stopReason: 'end_turn' };
  }
  async cancel(p: CancelNotification): Promise<void> {
    this.cancelCalls.push(p);
    if (this.opts.cancelImpl) {
      await this.opts.cancelImpl(p, this);
    }
  }
  async setSessionMode(
    _p: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    throw new Error('not implemented in test fake');
  }
  async setSessionConfigOption(
    _p: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    throw new Error('not implemented in test fake');
  }
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.extMethodCalls.push({ method, params });
    if (this.opts.extMethodImpl) {
      return this.opts.extMethodImpl(method, params, this);
    }
    return {};
  }
}

export interface ChannelHandle {
  channel: AcpChannel;
  agent: FakeAgent;
  killed: boolean;
  /**
   * Resolve `channel.exited` without going through `kill()`. Optionally
   * supply exit info so the bridge's `session_died` event carries the
   * same `exitCode` / `signalCode` it would in a real crash (BX9_P).
   */
  crash: (info?: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }) => void;
}

/**
 * Create a paired in-memory NDJSON channel: bridge sees `clientChannel`,
 * fake agent sees `agentStream`. Each `TransformStream` carries one
 * direction.
 *
 * Not migrated to `createInMemoryChannel()` (used by the other
 * `createInMemoryChannel` sites in `bridge.test.ts`): `kill()` below
 * needs the underlying `ab` / `ba` writables to simulate
 * child-process termination, which the bare helper deliberately does
 * not expose. See `inMemoryChannel.ts` JSDoc for the rationale.
 */
export function makeChannel(opts: FakeAgentOpts = {}): ChannelHandle {
  const ab = new TransformStream<Uint8Array, Uint8Array>();
  const ba = new TransformStream<Uint8Array, Uint8Array>();
  const clientStream = ndJsonStream(ab.writable, ba.readable);
  const agentStream = ndJsonStream(ba.writable, ab.readable);
  let resolveExited:
    | ((info?: {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      }) => void)
    | undefined;
  const exited = new Promise<
    { exitCode: number | null; signalCode: NodeJS.Signals | null } | undefined
  >((res) => {
    resolveExited = res;
  });
  const handle: ChannelHandle = {
    channel: undefined as unknown as AcpChannel,
    agent: new FakeAgent(opts),
    killed: false,
    /** Test hook: simulate an unexpected child crash. */
    crash: (info?: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    }) => resolveExited!(info),
  };
  // Spin up the fake agent on the agent side.
  new AgentSideConnection(() => handle.agent, agentStream);
  handle.channel = {
    stream: clientStream,
    exited,
    kill: async () => {
      handle.killed = true;
      try {
        await ab.writable.close();
      } catch {
        /* ignore */
      }
      try {
        await ba.writable.close();
      } catch {
        /* ignore */
      }
      resolveExited!();
    },
    killSync: () => {
      // Test fake: just mark killed; the async streams will close
      // naturally on test cleanup. Mirrors the real spawn factory's
      // SIGKILL semantics (fire-and-forget).
      handle.killed = true;
      resolveExited!();
    },
  };
  return handle;
}
