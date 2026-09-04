/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PR-G — Adapter conformance framework.
 *
 * Lets any daemon-ui adapter (TUI / web / IDE / channel / mobile) validate
 * that it projects a fixed corpus of daemon SSE event streams to the same
 * semantic shape. Catches drift early — when adapter authors implement
 * `reduce` + `render` themselves, this framework asserts the result matches
 * the SDK's reference projection.
 *
 * ## Adapter contract
 *
 * Implement `DaemonUiAdapterUnderTest`:
 *
 *   - `reduce(events)`: take a list of normalized UI events and produce
 *     adapter-specific state (any shape).
 *   - `renderToText(state)`: collapse that state to a plain-text string
 *     for semantic comparison. **Format-agnostic** — assertion is on text
 *     content, not on HTML / ANSI / markdown specifics.
 *
 * Adapters are free to use richer outputs (HTML, ANSI, JSX) — the test
 * framework only checks that the *semantic content* matches the reference.
 *
 * ## Usage (in adapter test file)
 *
 * ```ts
 * import { runAdapterConformanceSuite } from '@qwen-code/sdk/daemon';
 * import { reduceForTui, renderTuiState } from './my-tui-adapter';
 *
 * const result = runAdapterConformanceSuite({
 *   reduce: reduceForTui,
 *   renderToText: renderTuiState,
 * });
 * expect(result.failed).toEqual([]);
 * ```
 *
 * Or run a single fixture:
 *
 * ```ts
 * const fx = DAEMON_UI_CONFORMANCE_FIXTURES.find((f) => f.name === 'simple-chat');
 * const out = adapter.renderToText(adapter.reduce(fx.events));
 * for (const phrase of fx.expectedContains) expect(out).toContain(phrase);
 * for (const phrase of fx.expectedAbsent ?? []) expect(out).not.toContain(phrase);
 * ```
 */

import type { DaemonUiEvent } from './types.js';
import { normalizeDaemonEvent } from './normalizer.js';

export interface DaemonUiAdapterUnderTest {
  /**
   * Reduce a sequence of normalized UI events into adapter-specific state.
   * The state shape is opaque to the framework — only `renderToText` is
   * inspected.
   */
  reduce(events: readonly DaemonUiEvent[]): unknown;
  /**
   * Project the reduced state to a single plain-text string for semantic
   * comparison. **Implementation choices**:
   *
   * - Strip ANSI / HTML / markdown delimiters so assertions are
   *   format-agnostic
   * - Concatenate blocks with reasonable separators (e.g., `\n\n`)
   * - Include tool titles, status, permission outcomes, error text
   * - Skip debug / status blocks if your renderer hides them
   */
  renderToText(state: unknown): string;
}

/**
 * One fixture: a recorded sequence of daemon envelopes paired with the
 * semantic content any conforming adapter must surface (and optionally
 * content it MUST NOT surface, for forward-compat guard fixtures).
 */
export interface DaemonUiConformanceFixture {
  /** Human-readable name for test output. */
  name: string;
  /**
   * One-line description — what scenario the fixture exercises.
   */
  description: string;
  /**
   * Raw daemon envelopes. These get fed through `normalizeDaemonEvent` to
   * produce the `DaemonUiEvent[]` passed to the adapter's `reduce`.
   */
  envelopes: ReadonlyArray<{
    id?: number;
    v: 1;
    type: string;
    data: unknown;
    originatorClientId?: string;
    _meta?: Record<string, unknown>;
  }>;
  /**
   * Substrings the rendered output MUST contain. Each is asserted
   * independently; partial matches are OK. Use these for content-level
   * assertions ("transcript shows 'hello world'", "tool block shows
   * 'completed'").
   */
  expectedContains: readonly string[];
  /**
   * Substrings the rendered output MUST NOT contain. Use for guard
   * fixtures: "secret token must not leak", "raw event data must not
   * be dumped on malformed payload".
   */
  expectedAbsent?: readonly string[];
  /**
   * Optional normalization options forwarded to `normalizeDaemonEvent`.
   */
  normalizeOptions?: {
    clientId?: string;
    suppressOwnUserEcho?: boolean;
    includeRawEvent?: boolean;
  };
}

export interface ConformanceFailure {
  fixture: string;
  missingPhrases: readonly string[];
  leakedPhrases: readonly string[];
  /** Truncated rendered output for diagnosis. */
  renderedExcerpt: string;
}

export interface ConformanceSuiteResult {
  passed: number;
  failed: ConformanceFailure[];
  total: number;
}

export interface RunConformanceOptions {
  /** Specific fixtures to run; omitted = all. */
  only?: readonly string[];
  /** Skip these fixture names. */
  skip?: readonly string[];
}

/**
 * Run the built-in fixture corpus against an adapter and return per-fixture
 * pass/fail. **Does not throw** — caller asserts on `result.failed`.
 */
export function runAdapterConformanceSuite(
  adapter: DaemonUiAdapterUnderTest,
  opts: RunConformanceOptions = {},
): ConformanceSuiteResult {
  const fixtures = filterFixtures(DAEMON_UI_CONFORMANCE_FIXTURES, opts);
  const failed: ConformanceFailure[] = [];
  let passed = 0;
  for (const fx of fixtures) {
    // Wrap adapter calls in try/catch so an
    // adapter throw is reported as a fixture failure (with the error
    // captured in `renderedExcerpt`) instead of aborting the whole
    // suite. JSDoc promises "does not throw"; without the wrapper the
    // promise was broken by adapter authors writing buggy reducers.
    let rendered: string;
    try {
      const events = fx.envelopes.flatMap((env) =>
        normalizeDaemonEvent(env as never, fx.normalizeOptions ?? {}),
      );
      const state = adapter.reduce(events);
      rendered = adapter.renderToText(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({
        fixture: fx.name,
        missingPhrases: fx.expectedContains,
        leakedPhrases: [],
        renderedExcerpt: `[adapter threw: ${msg.slice(0, 360)}]`,
      });
      continue;
    }
    const missing = fx.expectedContains.filter(
      (phrase) => !rendered.includes(phrase),
    );
    const leaked = (fx.expectedAbsent ?? []).filter((phrase) =>
      rendered.includes(phrase),
    );
    if (missing.length === 0 && leaked.length === 0) {
      passed += 1;
    } else {
      failed.push({
        fixture: fx.name,
        missingPhrases: missing,
        leakedPhrases: leaked,
        renderedExcerpt:
          rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered,
      });
    }
  }
  return { passed, failed, total: fixtures.length };
}

function filterFixtures(
  fixtures: readonly DaemonUiConformanceFixture[],
  opts: RunConformanceOptions,
): readonly DaemonUiConformanceFixture[] {
  let out = fixtures;
  if (opts.only && opts.only.length > 0) {
    const set = new Set(opts.only);
    out = out.filter((fx) => set.has(fx.name));
  }
  if (opts.skip && opts.skip.length > 0) {
    const set = new Set(opts.skip);
    out = out.filter((fx) => !set.has(fx.name));
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Fixture corpus — embedded in source for portability (browser-safe; no fs).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Built-in conformance fixtures. Adapter authors run these against their
 * `reduce` + `renderToText` to catch projection drift before it reaches
 * users.
 *
 * Categorized:
 * - **chat**: basic user/assistant/thought flow
 * - **tool**: tool call lifecycle with preview projection
 * - **permission**: permission request + resolution
 * - **mcp**: MCP-specific events (budget warning, restart)
 * - **auth**: device-flow lifecycle
 * - **multimodal-text-only**: forward-compat hint — multimodal not yet
 *   wired (see TODO)
 * - **trim**: long-session block trim behavior
 * - **redaction**: malformed payloads must not leak raw fields
 */
export const DAEMON_UI_CONFORMANCE_FIXTURES: readonly DaemonUiConformanceFixture[] =
  [
    {
      name: 'simple-chat',
      description:
        'User says hello, assistant streams a two-chunk response, marks done.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'hello world' },
            },
          },
        },
        {
          id: 2,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hi ' },
            },
          },
        },
        {
          id: 3,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'there' },
            },
          },
        },
      ],
      expectedContains: ['hello world', 'hi there'],
    },
    {
      name: 'tool-call-lifecycle',
      description:
        'Tool runs, completes; preview surfaces command, status shows completed.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't1',
              title: 'Run npm test',
              status: 'running',
              rawInput: { command: 'npm test', cwd: '/work' },
            },
          },
        },
        {
          id: 2,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 't1',
              status: 'completed',
              rawOutput: 'all tests pass',
            },
          },
        },
      ],
      expectedContains: ['Run npm test', 'npm test', 'completed'],
    },
    {
      name: 'file-edit-diff',
      description:
        'File edit tool produces file_diff preview surfaceable as unified diff.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'edit-1',
              title: 'Edit auth.ts',
              status: 'completed',
              rawInput: {
                path: '/work/auth.ts',
                oldText: 'function login() { /* TODO */ }',
                newText: 'function login() { return token; }',
              },
            },
          },
        },
      ],
      expectedContains: ['/work/auth.ts', 'return token'],
    },
    {
      name: 'mcp-invocation',
      description:
        'MCP tool call surfaces serverId + toolName via heuristic naming.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'mcp-1',
              title: 'Create issue',
              status: 'completed',
              name: 'mcp__github__create_issue',
              rawInput: { repo: 'qwen-code', title: 'Bug' },
            },
          },
        },
      ],
      expectedContains: ['github', 'create_issue'],
    },
    {
      name: 'permission-lifecycle',
      description:
        'Permission requested, then resolved with `selected:allow` outcome.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'perm-1',
            sessionId: 'sess-1',
            toolCall: { name: 'Bash', command: 'rm -rf /tmp/cache' },
            options: [
              { optionId: 'allow', label: 'Allow once' },
              { optionId: 'deny', label: 'Deny' },
            ],
          },
        },
        {
          id: 2,
          v: 1,
          type: 'permission_resolved',
          data: {
            requestId: 'perm-1',
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
        },
      ],
      expectedContains: ['Allow once', 'selected:allow'],
    },
    {
      name: 'mcp-budget-warning',
      description:
        'MCP budget warning event surfaces threshold + counts (PR-A coverage).',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'mcp_budget_warning',
          data: {
            liveCount: 6,
            reservedCount: 2,
            budget: 8,
            thresholdRatio: 0.75,
            mode: 'warn',
          },
        },
      ],
      // No expectedContains — depending on adapter, this event may surface
      // as a status banner or be hidden. The contract is: the adapter MUST
      // observe the event (lastEventId advances) but can choose its
      // rendering. Fixture exists to verify the adapter does not throw.
      expectedContains: [],
    },
    {
      name: 'cancellation-propagates',
      description:
        'Cancelled assistant turn marks in-flight tool blocks as cancelled.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'long-task',
              title: 'Long task',
              status: 'running',
            },
          },
        },
      ],
      // Stream the assistant.done(cancelled) via a synthetic envelope:
      // since this is a derived UI event not a daemon event, the conformance
      // suite uses an out-of-band marker — adapters must propagate from
      // any 'assistant.done' event with reason=cancelled. (Fixture limited
      // by daemon envelope shape; see real integration tests for full
      // cancellation flow.)
      expectedContains: ['Long task'],
    },
    {
      name: 'malformed-payload-redaction',
      description:
        'Known event type with malformed payload falls back to debug. Even with `includeRawEvent: true` a conforming adapter must not dump the raw payload into rendered text. Uses a non-sensitive field name so SDK normalizer redaction (which auto-cleans `token`/`secret`/`apiKey`/etc.) does NOT pre-empt the test — the conformance framework itself catches the leak.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'mcp_budget_warning',
          data: { notes: 'must-not-leak-malformed-payload', random: 'junk' },
        },
      ],
      normalizeOptions: { includeRawEvent: true },
      expectedContains: [],
      expectedAbsent: ['must-not-leak-malformed-payload'],
    },
    {
      name: 'auth-device-flow-success',
      description:
        'OAuth device-flow lifecycle (started → authorized) renders provider + status.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'auth_device_flow_started',
          data: {
            deviceFlowId: 'df-1',
            providerId: 'qwen',
            expiresAt: 1_900_000_000_000,
          },
        },
        {
          id: 2,
          v: 1,
          type: 'auth_device_flow_authorized',
          data: {
            deviceFlowId: 'df-1',
            providerId: 'qwen',
            accountAlias: 'alice',
          },
        },
      ],
      expectedContains: [],
    },
    {
      name: 'available-commands-typed-event',
      description:
        'available_commands_update upgraded from status text to typed event (PR-A); not a status block.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                { name: 'memory' },
                { name: 'mcp' },
                { name: 'agents' },
              ],
            },
          },
        },
      ],
      expectedContains: [],
      expectedAbsent: ['Available commands updated'],
    },
    {
      name: 'subagent-nesting',
      description:
        'PR-K: tool calls invoked inside a sub-agent delegation carry parentToolCallId + subagentType via tool_call._meta. The parent Task tool call lands first, then a grep tool call from inside the sub-agent. Adapters must render both blocks without throwing; nested-aware adapters should be able to identify the sub-agent child via parentToolCallId. Order-resilient: the child arrives after the parent.',
      envelopes: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'task-1',
              title: 'Delegate to code-reviewer',
              status: 'running',
              name: 'Task',
              rawInput: {
                subagent_type: 'code-reviewer',
                prompt: 'review the diff',
              },
            },
          },
        },
        {
          id: 2,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'grep-1',
              title: 'grep -r TODO src/',
              status: 'completed',
              rawInput: { pattern: 'TODO', path: 'src/' },
              _meta: {
                parentToolCallId: 'task-1',
                subagentType: 'code-reviewer',
              },
            },
          },
        },
      ],
      // Phrases chosen to be markdown-safe: backslash escaping of `-` in
      // titles means we cannot rely on substrings containing hyphens.
      // Sub-agent type token appears in backticks (unescaped). `TODO` is
      // a clean substring from the child's rawInput.
      expectedContains: ['code-reviewer', 'review the diff', 'TODO'],
    },
  ];
