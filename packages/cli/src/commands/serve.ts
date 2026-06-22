/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
// Type-only imports — no runtime cost. The serve module pulls in express +
// body-parser + qs + the daemon transport stack; static-importing it from
// here would tax every `qwen` invocation (interactive, mcp, channel, etc.)
// with ~50ms of cold ESM resolution. The runtime import is deferred to the
// handler below so it only loads when the user actually runs `qwen serve`.
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { DEFAULT_RING_SIZE } from '../serve/event-bus.js';
import {
  ApprovalMode,
  MCP_BUDGET_WARN_FRACTION,
  openBrowserSecurely,
  parsePositiveIntegerEnv,
  shouldLaunchBrowser,
} from '@qwen-code/qwen-code-core';
import { loadSettings } from '../config/settings.js';
import { HEADLESS_YOLO_NO_SANDBOX_WARNING } from '../utils/headlessSafetyWarnings.js';

/**
 * Pause the current async function indefinitely. Used after the daemon
 * listener is up so yargs `parse()` never resolves — if it did, the
 * top-level CLI would fall through to the interactive (TUI) entry point
 * in `gemini.tsx`. SIGINT / SIGTERM in `runQwenServe` is the sole exit
 * route.
 */
function blockForever(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * Open the Web Shell in a browser once the daemon is listening. Extracted from
 * the `serve` handler so it is unit-testable. Best-effort:
 *  - gated on `--open`, the UI actually being mounted (`webShellMounted`), and
 *    `shouldLaunchBrowser()` (false in CI / SSH / headless);
 *  - wildcard bind hosts (`0.0.0.0` / `[::]`) are rewritten to loopback so the
 *    URL is client-addressable;
 *  - the token rides in the URL fragment (`#token=`), which is never sent to
 *    the server, and the daemon's already-resolved (trimmed) token is used so
 *    it matches what the server authenticates against;
 *  - any launch failure is logged, never thrown, so it can't take down the
 *    already-listening daemon.
 *
 * Exported for tests.
 */
export async function maybeOpenWebShellBrowser(
  handle: { url: string; webShellMounted: boolean; resolvedToken?: string },
  open: boolean,
): Promise<void> {
  if (!open || !handle.webShellMounted || !shouldLaunchBrowser()) return;
  try {
    const target = new URL(handle.url);
    // Node's URL returns the IPv6 wildcard as `[::]` (bracketed), never `::`.
    if (target.hostname === '0.0.0.0' || target.hostname === '[::]') {
      target.hostname = '127.0.0.1';
    }
    if (handle.resolvedToken) {
      target.hash = `token=${encodeURIComponent(handle.resolvedToken)}`;
      writeStderrLine(
        'qwen serve: --open passes the token in the browser launch command ' +
          '(visible via `ps` / /proc); on a multi-user host open the URL manually instead.',
      );
    }
    await openBrowserSecurely(target.toString());
  } catch (browserErr) {
    writeStderrLine(
      `qwen serve: failed to open browser: ${browserErr instanceof Error ? browserErr.message : String(browserErr)}`,
    );
  }
}

interface ServeArgs {
  port: number;
  hostname: string;
  token?: string;
  'max-sessions': number;
  'max-pending-prompts-per-session': number;
  'max-connections': number;
  'event-ring-size': number;
  workspace?: string;
  'require-auth': boolean;
  'enable-session-shell': boolean;
  web: boolean;
  open: boolean;
  // Read from the kebab-case key only — the camelCase mirror that yargs
  // synthesizes is convenient for handlers but type-confusing here. The
  // handler reads `argv['http-bridge']` directly.
  'http-bridge': boolean;
  'mcp-client-budget'?: number;
  'mcp-budget-mode'?: 'enforce' | 'warn' | 'off';
  'allow-origin'?: string[];
  'allow-private-auth-base-url': boolean;
  'prompt-deadline-ms'?: number;
  'writer-idle-timeout-ms'?: number;
  'channel-idle-timeout-ms'?: number;
  'session-reap-interval-ms'?: number;
  'session-idle-timeout-ms'?: number;
  'permission-response-timeout-ms'?: number;
  'rate-limit'?: boolean;
  'rate-limit-prompt'?: number;
  'rate-limit-mutation'?: number;
  'rate-limit-read'?: number;
  'rate-limit-window-ms'?: number;
}

export const serveCommand: CommandModule<unknown, ServeArgs> = {
  command: 'serve',
  describe:
    'Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        default: 4170,
        description:
          'TCP port to bind (use 0 for an OS-assigned ephemeral port)',
      })
      .option('hostname', {
        type: 'string',
        default: '127.0.0.1',
        description:
          'Interface to bind. Loopback (127.0.0.1, localhost, ::1, [::1]) is auth-free; anything else requires a token.',
      })
      .option('token', {
        type: 'string',
        description:
          'Bearer token required on every request. Falls back to the QWEN_SERVER_TOKEN env var.',
      })
      .option('max-sessions', {
        type: 'number',
        default: 20,
        description:
          'Cap on concurrent live sessions. New spawn requests beyond this return 503; ' +
          'attach to existing sessions still works. Set to 0 to disable.',
      })
      .option('max-pending-prompts-per-session', {
        type: 'number',
        default: 5,
        description:
          'Per-session cap on accepted prompts waiting or running. ' +
          'New prompts beyond this return 503. Set to 0 to disable.',
      })
      .option('workspace', {
        type: 'string',
        description:
          'Absolute workspace path this daemon binds to. ' +
          'POST /session requests with a mismatched cwd return 400 workspace_mismatch. ' +
          'Defaults to process.cwd() when omitted. ' +
          'For multi-workspace deployments, run one `qwen serve` per workspace ' +
          'on separate ports (or behind an external orchestrator).',
      })
      .option('max-connections', {
        type: 'number',
        default: 256,
        description:
          'Listener-level TCP connection cap (server.maxConnections). Bounds raw ' +
          'sockets — slow/phantom SSE clients get rejected at accept time once full. ' +
          'Set to 0 to disable.',
      })
      .option('require-auth', {
        type: 'boolean',
        default: false,
        description:
          'Refuse to start without a bearer token, even on loopback. ' +
          'Hardens the loopback developer default for shared dev hosts / CI ' +
          'runners / multi-tenant workstations where any local user can hit ' +
          '127.0.0.1. Requires --token or QWEN_SERVER_TOKEN. /health also ' +
          'requires Authorization when enabled (no loopback exemption — ' +
          'k8s/Compose probes must pass the bearer too).',
      })
      .option('enable-session-shell', {
        type: 'boolean',
        default: false,
        description:
          'Enable direct POST /session/:id/shell execution. Requires a bearer token and a session-bound client id on each call.',
      })
      .option('web', {
        type: 'boolean',
        default: true,
        description:
          'Serve the Web Shell UI at the daemon root path. Use --no-web for an API-only daemon.',
      })
      .option('open', {
        type: 'boolean',
        default: false,
        description:
          'Open the Web Shell in a browser once the daemon is listening. With a token configured, the launch URL (token included) is handed to the browser launcher and is visible in the process list, so prefer opening the URL manually on multi-user hosts. No-op with --no-web, when the UI assets are absent, or in headless/CI/SSH environments.',
      })
      .option('event-ring-size', {
        type: 'number',
        // Single source of truth — `DEFAULT_RING_SIZE` is also what
        // the bridge falls back to when the
        // option is undefined. Importing here keeps a future bump in
        // one place rather than drifting between CLI and bus.
        default: DEFAULT_RING_SIZE,
        description:
          'Per-session SSE replay ring depth. Sets the ' +
          'replay backlog available to `GET /session/:id/events` reconnects ' +
          'that send a `Last-Event-ID: N` header. Larger = more reconnect ' +
          'headroom at the cost of a few hundred KB extra RAM per session. ' +
          'Must be a positive finite integer.',
      })
      .option('http-bridge', {
        type: 'boolean',
        default: true,
        description:
          'Stage 1 mode: one `qwen --acp` child per daemon (the daemon binds to ' +
          'one workspace at boot, multiplexing N sessions onto that child via ' +
          "the agent's native `newSession()`). Stage 2 native in-process mode " +
          'is not yet implemented; this flag will become opt-in then.',
      })
      .option('mcp-client-budget', {
        type: 'number',
        description:
          'Cap on live MCP clients spawned inside the ACP child for the bound ' +
          'workspace. Positive integer. Combine with ' +
          '--mcp-budget-mode to control behavior at the cap. When unset, ' +
          'mode defaults to off (no accounting-driven enforcement, but ' +
          'GET /workspace/mcp still reports `clientCount`). Distinct from ' +
          'claude-code MCP_SERVER_CONNECTION_BATCH_SIZE which gates startup ' +
          'concurrency, not the total client count.',
      })
      .option('mcp-budget-mode', {
        choices: ['enforce', 'warn', 'off'] as const,
        description:
          'How --mcp-client-budget is enforced. ' +
          '`warn` (default when budget set): no refusal, snapshot surfaces ' +
          'warning at >=75% of budget. `enforce`: connects past the cap are ' +
          'refused (`disabledReason: "budget"`, deterministic by mcpServers ' +
          'declaration order). `off`: pure observability. Boot rejects ' +
          '`enforce` without a budget.',
      })
      .option('allow-origin', {
        type: 'string',
        array: true,
        description: 'Cross-origin allowlist for browser webui clients.',
      })
      .option('allow-private-auth-base-url', {
        type: 'boolean',
        default: false,
        description:
          'Allow /workspace/auth/provider to install localhost/private-network baseUrl values. ' +
          'Use only for local development with trusted clients.',
      })
      .option('prompt-deadline-ms', {
        type: 'number',
        description:
          'Server-side wallclock cap on POST /session/:id/prompt (ms). ' +
          'Falls back to QWEN_SERVE_PROMPT_DEADLINE_MS. Positive integer.',
      })
      .option('writer-idle-timeout-ms', {
        type: 'number',
        description:
          'Per-SSE-connection idle deadline (ms). ' +
          'Falls back to QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS. Positive integer.',
      })
      .option('channel-idle-timeout-ms', {
        type: 'number',
        description:
          'Milliseconds to keep ACP child alive after last session closes. ' +
          '0 or unset = immediate kill (default).',
      })
      .option('session-reap-interval-ms', {
        type: 'number',
        description:
          'Session reaper scan interval (ms). 0 = disabled. Default: 60000.',
      })
      .option('session-idle-timeout-ms', {
        type: 'number',
        description:
          'Idle timeout before a disconnected session is reaped (ms). ' +
          '0 = disabled. Default: 1800000 (30 min).',
      })
      .option('permission-response-timeout-ms', {
        type: 'number',
        description:
          'Wall-clock timeout for a single human permission / ' +
          'ask_user_question response in daemon (ACP) mode (ms). ' +
          '0 = disabled (wait forever). Default: 300000 (5 min).',
      })
      .option('rate-limit', {
        type: 'boolean',
        description:
          'Enable per-tier HTTP rate limiting. Tiers: prompt (10/min), ' +
          'mutation (30/min), read (120/min). Health, heartbeat, SSE, ' +
          'and /acp are exempt.',
      })
      .option('rate-limit-prompt', {
        type: 'number',
        description:
          'Max prompt requests per window per client (default 10). ' +
          'Requires --rate-limit.',
      })
      .option('rate-limit-mutation', {
        type: 'number',
        description:
          'Max mutation requests per window per client (default 30). ' +
          'Requires --rate-limit.',
      })
      .option('rate-limit-read', {
        type: 'number',
        description:
          'Max read requests per window per client (default 120). ' +
          'Requires --rate-limit.',
      })
      .option('rate-limit-window-ms', {
        type: 'number',
        description:
          'Rate limit window duration in ms (default 60000). ' +
          'Requires --rate-limit.',
      }) as unknown as Argv<ServeArgs>,
  handler: async (argv) => {
    if (!argv['http-bridge']) {
      writeStderrLine(
        'qwen serve: --no-http-bridge (native mode) is not yet implemented; ' +
          'falling back to http-bridge.',
      );
    }
    if (argv.token) {
      // `--token` is visible to any local user via `/proc/<pid>/cmdline`
      // (Linux default; only suppressed under `hidepid=2`). Steer
      // operators toward the env-var path which uses
      // `/proc/<pid>/environ` (owner-only).
      writeStderrLine(
        'qwen serve: --token is visible in the process command line; ' +
          'prefer the QWEN_SERVER_TOKEN env var for any non-trivial ' +
          'deployment.',
      );
    }
    // Validate budget + mode combination at boot, before we
    // lazy-load the serve module. Yargs already constrains `choices`
    // for mcp-budget-mode, so we only have to police the budget value
    // and the `enforce` ⇒ budget invariant.
    const mcpClientBudget = argv['mcp-client-budget'];
    const mcpBudgetMode = argv['mcp-budget-mode'];
    if (mcpClientBudget !== undefined) {
      if (
        !Number.isFinite(mcpClientBudget) ||
        !Number.isInteger(mcpClientBudget) ||
        mcpClientBudget <= 0
      ) {
        writeStderrLine(
          'qwen serve: --mcp-client-budget must be a positive integer.',
        );
        process.exit(1);
      }
    }
    if (mcpBudgetMode === 'enforce' && mcpClientBudget === undefined) {
      writeStderrLine(
        'qwen serve: --mcp-budget-mode=enforce requires --mcp-client-budget=N.',
      );
      process.exit(1);
    }
    const resolvedMcpMode: 'enforce' | 'warn' | 'off' =
      mcpBudgetMode ?? (mcpClientBudget !== undefined ? 'warn' : 'off');
    const maxPendingPromptsPerSession = argv['max-pending-prompts-per-session'];
    if (
      maxPendingPromptsPerSession !== Number.POSITIVE_INFINITY &&
      (!Number.isFinite(maxPendingPromptsPerSession) ||
        !Number.isInteger(maxPendingPromptsPerSession) ||
        maxPendingPromptsPerSession < 0)
    ) {
      writeStderrLine(
        'qwen serve: --max-pending-prompts-per-session must be a non-negative integer (0 / Infinity = unlimited).',
      );
      process.exit(1);
    }
    if (mcpClientBudget !== undefined) {
      // Mirror the `--require-auth` breadcrumb: surface the active
      // policy in stderr (journald / docker logs) so operators don't
      // have to parse /capabilities or /workspace/mcp to confirm it.
      writeStderrLine(
        `qwen serve: --mcp-client-budget=${mcpClientBudget} mode=${resolvedMcpMode}` +
          (resolvedMcpMode === 'enforce'
            ? ' (servers past the cap will be refused at discovery)'
            : resolvedMcpMode === 'warn'
              ? ` (warnings at >=${Math.ceil(mcpClientBudget * MCP_BUDGET_WARN_FRACTION)}, no refusal)`
              : ''),
      );
    }

    // Emit the headless-YOLO safety warning at daemon startup if
    // settings.json statically configures yolo + no sandbox. We can't
    // use `getHeadlessYoloSafetyWarning(config)` here because the daemon
    // hasn't constructed a `Config` yet — sessions get their own — so
    // we re-derive the predicate from the same settings.json the
    // sessions will load. Per-session override (the ACP client flipping
    // approval mode mid-session) is out of scope here; this warns about
    // a deployment that's wide-open at boot. Suppress with
    // QWEN_CODE_SUPPRESS_YOLO_WARNING=1.
    try {
      const loaded = loadSettings(argv.workspace ?? process.cwd());
      const merged = loaded.merged;
      const approvalMode = merged.tools?.approvalMode;
      const sandbox = merged.tools?.sandbox;
      const sandboxEnv = process.env['SANDBOX'];
      const suppress = process.env['QWEN_CODE_SUPPRESS_YOLO_WARNING'];
      const suppressed = suppress === '1' || suppress === 'true';
      if (
        approvalMode === ApprovalMode.YOLO &&
        !sandbox &&
        !sandboxEnv &&
        !suppressed
      ) {
        writeStderrLine(HEADLESS_YOLO_NO_SANDBOX_WARNING);
      }
    } catch {
      // Settings load can fail (corrupt JSON, etc.); don't block
      // daemon startup just to emit a warning — the existing settings
      // path will report the same error to the user via Session.
    }

    // Rate limit resolution: --rate-limit / --no-rate-limit override env var.
    // With no default, argv['rate-limit'] is undefined when neither flag is passed.
    const rateLimit =
      argv['rate-limit'] ??
      (process.env['QWEN_SERVE_RATE_LIMIT'] === '1' ||
        process.env['QWEN_SERVE_RATE_LIMIT'] === 'true');
    let rateLimitPrompt: number | undefined;
    let rateLimitMutation: number | undefined;
    let rateLimitRead: number | undefined;
    let rateLimitWindowMs: number | undefined;
    if (rateLimit) {
      const envInt = (key: string): number | undefined => {
        const raw = process.env[key];
        if (raw === undefined || raw === '') return undefined;
        return parsePositiveIntegerEnv(raw, Number.NaN);
      };
      rateLimitPrompt =
        argv['rate-limit-prompt'] ?? envInt('QWEN_SERVE_RATE_LIMIT_PROMPT');
      rateLimitMutation =
        argv['rate-limit-mutation'] ?? envInt('QWEN_SERVE_RATE_LIMIT_MUTATION');
      rateLimitRead =
        argv['rate-limit-read'] ?? envInt('QWEN_SERVE_RATE_LIMIT_READ');
      rateLimitWindowMs =
        argv['rate-limit-window-ms'] ??
        envInt('QWEN_SERVE_RATE_LIMIT_WINDOW_MS');

      for (const [name, value] of [
        ['--rate-limit-prompt', rateLimitPrompt],
        ['--rate-limit-mutation', rateLimitMutation],
        ['--rate-limit-read', rateLimitRead],
      ] as const) {
        if (
          value !== undefined &&
          (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
        ) {
          writeStderrLine(`qwen serve: ${name} must be a positive integer.`);
          process.exit(1);
        }
      }
      if (
        rateLimitWindowMs !== undefined &&
        (!Number.isFinite(rateLimitWindowMs) ||
          !Number.isInteger(rateLimitWindowMs) ||
          rateLimitWindowMs < 1000)
      ) {
        writeStderrLine(
          'qwen serve: --rate-limit-window-ms must be an integer >= 1000.',
        );
        process.exit(1);
      }
    }

    // Lazy-load the serve module so non-serve invocations don't pay for
    // express + body-parser + qs in their startup path.
    const { runQwenServe } = await import('../serve/index.js');
    try {
      const handle = await runQwenServe({
        port: argv.port,
        hostname: argv.hostname,
        token: argv.token,
        mode: 'http-bridge',
        maxSessions: argv['max-sessions'],
        maxPendingPromptsPerSession,
        maxConnections: argv['max-connections'],
        eventRingSize: argv['event-ring-size'],
        workspace: argv.workspace,
        requireAuth: argv['require-auth'],
        enableSessionShell: argv['enable-session-shell'],
        serveWebShell: argv.web,
        allowPrivateAuthBaseUrl: argv['allow-private-auth-base-url'],
        mcpClientBudget,
        mcpBudgetMode: resolvedMcpMode,
        ...(argv['allow-origin'] && argv['allow-origin'].length > 0
          ? { allowOrigins: argv['allow-origin'] }
          : {}),
        ...(argv['prompt-deadline-ms'] !== undefined
          ? { promptDeadlineMs: argv['prompt-deadline-ms'] }
          : {}),
        ...(argv['writer-idle-timeout-ms'] !== undefined
          ? { writerIdleTimeoutMs: argv['writer-idle-timeout-ms'] }
          : {}),
        ...(argv['channel-idle-timeout-ms'] !== undefined
          ? { channelIdleTimeoutMs: argv['channel-idle-timeout-ms'] }
          : {}),
        ...(argv['session-reap-interval-ms'] !== undefined
          ? { sessionReapIntervalMs: argv['session-reap-interval-ms'] }
          : {}),
        ...(argv['session-idle-timeout-ms'] !== undefined
          ? { sessionIdleTimeoutMs: argv['session-idle-timeout-ms'] }
          : {}),
        ...(argv['permission-response-timeout-ms'] !== undefined
          ? {
              permissionResponseTimeoutMs:
                argv['permission-response-timeout-ms'],
            }
          : {}),
        ...(rateLimit ? { rateLimit: true } : {}),
        ...(rateLimitPrompt !== undefined ? { rateLimitPrompt } : {}),
        ...(rateLimitMutation !== undefined ? { rateLimitMutation } : {}),
        ...(rateLimitRead !== undefined ? { rateLimitRead } : {}),
        ...(rateLimitWindowMs !== undefined ? { rateLimitWindowMs } : {}),
      });
      // Open the Web Shell in a browser once the listener is up (best-effort;
      // never throws — see maybeOpenWebShellBrowser).
      await maybeOpenWebShellBrowser(handle, argv.open);
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    await blockForever();
  },
};
